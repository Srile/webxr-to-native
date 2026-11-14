// The GL thread and its command ring (gl_queue.h).
#include "gl/gl_queue.h"
#ifdef __ANDROID__
#include <sys/system_properties.h>
#endif
#include <cstdlib>
#ifndef GLQ_NO_EGL
#include "gl/egl.h"
#endif
#include "core/log.h"
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <thread>
#if defined(_WIN32)
#include <malloc.h>
#endif
#if defined(__linux__) || defined(__ANDROID__)
#include <unistd.h>
#include <linux/futex.h>
#include <sys/syscall.h>
#include <pthread.h>
#endif

namespace host {
namespace glq {
namespace {

uint32_t* g_mem = nullptr;   // ctrl words + data
size_t g_bytes = 0;
uint32_t g_cap = 0;          // data words
std::thread g_thread;
std::atomic<bool> g_stop{false};
bool (*g_bind)(void*) = nullptr; void (*g_unbind)(void*) = nullptr; void* g_ctx = nullptr;
Handler g_hand[kFirstGenerated] = {};
Handler g_generated = nullptr;
std::atomic<int> g_tid{0};

std::atomic<uint32_t>& ctrl(uint32_t i) { return *reinterpret_cast<std::atomic<uint32_t>*>(g_mem + i); }

// Counters: producer-side ones are plain (host thread), consumer-side ones atomic (read from the host thread).
uint64_t p_syncs = 0, p_wraps = 0, p_fullWaits = 0;
std::atomic<uint64_t> c_busyUs{0}, c_waitUs{0}, c_words{0};
struct SyncName { const char* name; uint32_t n; };
SyncName g_names[64];

// Page-aligned ring memory (MSVC has no aligned_alloc).
inline void* allocAligned(size_t bytes) {
#if defined(_WIN32)
  return _aligned_malloc(bytes, 4096);
#else
  return aligned_alloc(4096, bytes);
#endif
}

inline uint64_t nowUs() { return (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

#if defined(__linux__) || defined(__ANDROID__)
inline void futexWait(std::atomic<uint32_t>* a, uint32_t expect) { syscall(SYS_futex, (uint32_t*)a, FUTEX_WAIT_PRIVATE, expect, nullptr, nullptr, 0); }
inline void futexWake(std::atomic<uint32_t>* a) { syscall(SYS_futex, (uint32_t*)a, FUTEX_WAKE_PRIVATE, 1, nullptr, nullptr, 0); }
#else
inline void futexWait(std::atomic<uint32_t>* a, uint32_t expect) { a->wait(expect); }
inline void futexWake(std::atomic<uint32_t>* a) { a->notify_one(); }
#endif
inline void cpuRelax() {
#if defined(__aarch64__)
  __asm__ __volatile__("yield");
#elif defined(__x86_64__)
  __builtin_ia32_pause();
#endif
}

// A sync call parked in the ring: [kOpSync, ptr lo, ptr hi].
struct SyncCall { void (*fn)(void*); void* ctx; const char* name; std::atomic<uint32_t> state{0}; };  // 0 pending, 1 done, 2 waiter parked

// Diagnostics: any one command the GL thread takes longer than this over is logged (0: off). Android:
// `adb shell setprop debug.webxr.glslow <ms>` before launch. Generated opcodes are named in webgl_bind.gen.cpp.
std::atomic<uint64_t> g_slowUs{0};
inline void slowOp(uint32_t op, uint64_t start, const char* name) {
  const uint64_t limit = g_slowUs.load(std::memory_order_relaxed);
  if (!limit) return;
  const uint64_t took = nowUs() - start;
  if (took < limit) return;
  if (name) HOST_LOGW("gl thread: sync %s took %.1f ms", name, took / 1000.0);
  else HOST_LOGW("gl thread: op %u took %.1f ms", op, took / 1000.0);
}

// How long the consumer spins on an empty ring before it parks. Within a frame the page records in bursts with
// short JS gaps between them; parking in every gap would pay a futex wake per burst.
constexpr uint64_t kSpinUs = 300;

void consume() {
  t_onGL = true;
#if defined(__linux__) || defined(__ANDROID__)
  g_tid = (int)syscall(SYS_gettid);
#endif
  if (!g_bind(g_ctx)) HOST_LOGE("gl thread: eglMakeCurrent failed");
#ifdef __ANDROID__
  { char v[PROP_VALUE_MAX] = {}; if (__system_property_get("debug.webxr.glslow", v) > 0 && atoi(v) > 0) { g_slowUs.store((uint64_t)atoi(v) * 1000); HOST_LOGI("gl thread: logging commands over %d ms (debug.webxr.glslow)", atoi(v)); } }
#endif
  HOST_LOGI("gl thread: context current, ring %u KB", (unsigned)(g_bytes / 1024));
  uint32_t* d = g_mem + kBase;
  uint32_t r = ctrl(kR).load(std::memory_order_relaxed);
  for (;;) {
    uint32_t w = ctrl(kW).load(std::memory_order_acquire);
    if (w == r) {
      if (g_stop.load(std::memory_order_relaxed)) break;
      ctrl(kR).store(r, std::memory_order_release);
      const uint64_t t0 = nowUs();
      bool got = false;
      while (nowUs() - t0 < kSpinUs) {
        for (int k = 0; k < 64; ++k) cpuRelax();
        if (ctrl(kW).load(std::memory_order_acquire) != r) { got = true; break; }
      }
      if (!got) {
        ctrl(kSleep).store(1, std::memory_order_seq_cst);
        if (ctrl(kW).load(std::memory_order_seq_cst) == r && !g_stop.load()) futexWait(&ctrl(kW), r);
        ctrl(kSleep).store(0, std::memory_order_relaxed);
      }
      c_waitUs.fetch_add(nowUs() - t0, std::memory_order_relaxed);
      continue;
    }
    const uint64_t t0 = nowUs();
    uint32_t sinceRelease = 0;
    while (r != w) {
      const uint32_t op = d[r];
      const uint64_t opStart = g_slowUs.load(std::memory_order_relaxed) ? nowUs() : 0;
      uint32_t n;
      if (op >= kFirstGenerated) n = g_generated(d + r);
      else if (op == kOpWrap) { r = 0; ctrl(kR).store(r, std::memory_order_release); continue; }
      else if (op == kOpSync) {
        uint64_t p = (uint64_t)d[r + 1] | ((uint64_t)d[r + 2] << 32);
        SyncCall* c = (SyncCall*)(uintptr_t)p;
        r += 3; ctrl(kR).store(r, std::memory_order_release);
        c->fn(c->ctx);
        slowOp(op, opStart, c->name);
        if (c->state.exchange(1, std::memory_order_acq_rel) == 2) futexWake(&c->state);
        continue;
      } else if (op >= kFirstHand && g_hand[op]) n = g_hand[op](d + r);
      else { HOST_LOGE("gl thread: bad opcode %u at %u (w %u); ring dropped", op, r, w); r = w; break; }
      slowOp(op, opStart, nullptr);
      r += n; c_words.fetch_add(n, std::memory_order_relaxed);
      if ((sinceRelease += n) > 1024) { ctrl(kR).store(r, std::memory_order_release); sinceRelease = 0; }
    }
    ctrl(kR).store(r, std::memory_order_release);
    c_busyUs.fetch_add(nowUs() - t0, std::memory_order_relaxed);
  }
  g_unbind(g_ctx);
  t_onGL = false;
}

}  // namespace

#ifndef GLQ_NO_EGL
bool start(Egl& egl, size_t ringBytes) {
  if (!egl.releaseCurrent()) HOST_LOGW("gl queue: could not release the context on the host thread");
  return start([](void* e) { return ((Egl*)e)->makeCurrent(); }, [](void* e) { ((Egl*)e)->releaseCurrent(); }, &egl, ringBytes);
}
#endif

bool start(bool (*bind)(void*), void (*unbind)(void*), void* ctx, size_t ringBytes) {
  if (g_active.load()) return true;
  g_bytes = (ringBytes + 4095) & ~(size_t)4095;
  if (g_bytes < (1u << 20)) g_bytes = 1u << 20;
  g_mem = (uint32_t*)allocAligned(g_bytes);
  if (!g_mem) return false;
  memset(g_mem, 0, kBase * 4);
  g_cap = (uint32_t)(g_bytes / 4 - kBase);
  ctrl(kW).store(0); ctrl(kPW).store(0); ctrl(kR).store(0); ctrl(kSleep).store(0);
  ctrl(kLimit).store(g_cap - 1);
  g_bind = bind; g_unbind = unbind; g_ctx = ctx;
  g_stop = false;
  g_thread = std::thread(consume);
#if defined(__ANDROID__) || defined(__linux__)
  pthread_setname_np(g_thread.native_handle(), "webxr-gl");
#endif
  g_active = true;
  HOST_LOGI("gl queue on: commands recorded on the host thread, executed on the GL thread");
  return true;
}

void stop() {
  if (!g_active.load()) return;
  finish();
  // The consumer leaves when it finds the ring empty with the stop flag set (it re-checks after a wake).
  g_stop = true;
  wake();
  if (g_thread.joinable()) g_thread.join();
  g_active = false;
  g_bind(g_ctx);  // back on the host thread for the teardown
}

int threadId() { return g_tid.load(); }
uint32_t* memory() { return g_mem; }
size_t memoryBytes() { return g_bytes; }
uint32_t capacity() { return g_cap; }

uint32_t reserve(uint32_t n) {
  uint32_t w = ctrl(kPW).load(std::memory_order_relaxed);  // after whatever JS wrote and has not published
  if (w + n <= ctrl(kLimit).load(std::memory_order_relaxed)) return w;
  if (n + 2 >= g_cap) { HOST_LOGE("gl queue: a %u-word command does not fit the ring", n); abort(); }
  // Slow path: recompute the free run from the consumer's position; wrap or wait as needed.
  for (uint32_t spins = 0;; ++spins) {
    const uint32_t r = ctrl(kR).load(std::memory_order_acquire);
    if (r <= w) {                       // same lap: free is [w, cap-1) and [0, r-1)
      if (w + n <= g_cap - 1) { ctrl(kLimit).store(g_cap - 1, std::memory_order_relaxed); return w; }
      if (r > n) {                      // wrap: WRAP at w, the command at 0
        g_mem[kBase + w] = kOpWrap; ++p_wraps;
        ctrl(kLimit).store(r - 1, std::memory_order_relaxed);
        // Publish nothing yet: commit() moves W from w to the command's end, past the WRAP the consumer will follow.
        return 0;
      }
    } else if (w + n <= r - 1) { ctrl(kLimit).store(r - 1, std::memory_order_relaxed); return w; }
    // Full: the consumer is behind. Make sure it is awake and give it time.
    if (spins == 0) { ++p_fullWaits; wake(); }
    if (spins < 64) std::this_thread::yield(); else std::this_thread::sleep_for(std::chrono::microseconds(50));
  }
}

void commit(uint32_t end) {
  ctrl(kPW).store(end, std::memory_order_relaxed);
  ctrl(kW).store(end, std::memory_order_seq_cst);
  if (ctrl(kSleep).load(std::memory_order_seq_cst)) wake();
}

void wake() { futexWake(&ctrl(kW)); }

void registerOp(uint32_t op, Handler h) {
  if (op >= kFirstHand && op < kFirstGenerated) g_hand[op] = h;
  else if (op == kFirstGenerated) g_generated = h;
}

void setSlowLogUs(uint64_t us) { g_slowUs.store(us, std::memory_order_relaxed); }
uint64_t slowLogUs() { return g_slowUs.load(std::memory_order_relaxed); }

void runSync(void (*fn)(void*), void* ctx, const char* what) {
  ++p_syncs;
  for (auto& s : g_names) { if (s.name == what) { ++s.n; break; } if (!s.name) { s.name = what; s.n = 1; break; } }
  SyncCall c; c.fn = fn; c.ctx = ctx; c.name = what;
  const uint64_t p = (uint64_t)(uintptr_t)&c;
  put(kOpSync, (uint32_t)p, (uint32_t)(p >> 32));
  // Spin first: a sync behind a short queue completes in microseconds, a futex round trip costs more than that.
  for (int i = 0; i < 20000; ++i) { if (c.state.load(std::memory_order_acquire) == 1) return; cpuRelax(); }
  uint32_t z = 0;
  if (c.state.compare_exchange_strong(z, 2, std::memory_order_acq_rel)) {
    while (c.state.load(std::memory_order_acquire) != 1) futexWait(&c.state, 2);
  }
}

void finish() { if (active() && !t_onGL) runSync([](void*) {}, nullptr, "finish"); }

Stats takeStats() {
  Stats s; s.words = c_words.exchange(0); s.syncs = p_syncs; s.wraps = p_wraps; s.fullWaits = p_fullWaits;
  s.busyUs = c_busyUs.exchange(0); s.waitUs = c_waitUs.exchange(0);
  p_syncs = p_wraps = p_fullWaits = 0;
  return s;
}

const char* topSyncs() {
  static char buf[512]; buf[0] = 0; size_t o = 0;
  for (int k = 0; k < 6; ++k) {
    int best = -1;
    for (int i = 0; i < 64 && g_names[i].name; ++i) if (g_names[i].n && (best < 0 || g_names[i].n > g_names[best].n)) best = i;
    if (best < 0) break;
    const char* nm = g_names[best].name; const char* paren = strchr(nm, '('); int len = paren ? (int)(paren - nm) : (int)strlen(nm);
    if (len > 40) len = 40;
    o += snprintf(buf + o, sizeof buf - o, "%s%.*s %u", k ? ", " : "", len, nm, g_names[best].n);
    g_names[best].n = 0;
    if (o >= sizeof buf - 64) break;
  }
  for (auto& s : g_names) s.n = 0;
  return buf;
}

}  // namespace glq
}  // namespace host
