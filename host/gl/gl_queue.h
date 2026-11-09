#pragma once
// The GL thread (host.json gl.thread): the EGL context is current on a thread of its own, and the host thread —
// the page's JS — only records GL commands into a ring the GL thread drains. A browser does the same with its GPU
// process: the page pays for serialising a call, the driver's per-draw work runs elsewhere, in parallel with the
// page's next JS. Without it every glDraw* / glUniform* pays the driver's validation on the JS thread, and past a
// few hundred draws a frame that is the difference between holding the frame rate and missing it.
//
// The ring is one ArrayBuffer shared with JS (runtime/src/webgl/queue.gen.js writes the hot commands straight into
// it, with no native call at all). Single producer: the host thread (JS encoders and native code on that thread);
// single consumer: the GL thread. Words, 32 bits each:
//   ctrl[W]     producer's published write position (what the consumer may read up to)
//   ctrl[LIMIT] producer's cached end of the free run it knows about (producer-only)
//   ctrl[PW]    producer's write position including what it has not published yet (producer-only): the JS
//               encoders write with plain stores and publish (W = PW, a seq-cst store) at a draw or every 1024
//               words; native code on the producer thread starts after PW and publishes it with its own command
//   ctrl[R]     consumer's read position (published per batch; the producer reads it only when it runs out)
//   ctrl[SLEEP] 1 while the consumer is parked on a futex on ctrl[W]: the producer wakes it after a commit
// The data starts at word kBase. A command is an opcode word and its arguments; one that does not fit before the
// end is preceded by a WRAP word and starts again at 0. Opcodes below kFirstGenerated are the queue's own (WRAP,
// SYNC, hand-written ops registered by webgl_bind.cpp); the rest are generated from webgl_table.py
// (gl_queue.gen.inc, queue.gen.js), one per WebGL call.
//
// Anything that must see GL state (a getter, a native that reads the result of a call) runs on the GL thread
// through sync(): queued behind everything recorded so far, the calling thread waits for it. With the queue off
// (or on the GL thread itself) sync(f) is f(), so code written against it runs the same either way.
#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace host {
class Egl;

namespace glq {

enum : uint32_t { kW = 0, kLimit = 1, kPW = 2, kR = 16, kSleep = 32, kBase = 64 };
enum Op : uint32_t {
  kOpInvalid = 0, kOpWrap = 1, kOpSync = 2,
  kFirstHand = 8,           // registerOp() ids: kFirstHand .. kFirstGenerated - 1
  kFirstGenerated = 64,
};

// Started by the host after EGL init when host.json gl.thread is on: the host thread releases the context and the
// GL thread makes it current (pbuffer). false: the queue stays off and everything runs inline, as before.
bool start(Egl& egl, size_t ringBytes);
// The same with the context's bind/unbind as callbacks (tests: no EGL at all).
bool start(bool (*bind)(void*), void (*unbind)(void*), void* ctx, size_t ringBytes);
void stop();
inline std::atomic<bool> g_active{false};
inline thread_local bool t_onGL = false;
inline bool active() { return g_active.load(std::memory_order_relaxed); }
inline bool onGLThread() { return t_onGL; }
int threadId();  // the GL thread's kernel tid (0 before it runs)

// The ring as raw memory (ctrl words then data) and its capacity in data words. JS gets an ArrayBuffer over it.
uint32_t* memory();
size_t memoryBytes();
uint32_t capacity();

// Producer side (host thread only). reserve(n) returns the ring position for an n-word command (waiting for room,
// writing a WRAP when the command does not fit before the end); the caller writes ring[kBase + pos ...] and commits.
uint32_t reserve(uint32_t words);
void commit(uint32_t end);   // publishes ctrl[W] = end and wakes the consumer if it is parked
void wake();                 // futex wake (JS calls it through __native.gl.glqWake when it sees ctrl[SLEEP])
inline uint32_t* data() { return memory() + kBase; }
template <class T> inline uint32_t word(T v) {
  if constexpr (std::is_same_v<T, float>) return std::bit_cast<uint32_t>(v);
  else return (uint32_t)v;
}
// put(op, a...): one scalar command, every argument one 32-bit word (floats by bit pattern).
template <class... A> inline void put(uint32_t op, A... a) {
  constexpr uint32_t n = 1 + sizeof...(A);
  uint32_t pos = reserve(n); uint32_t* p = data() + pos; *p++ = op;
  ((*p++ = word(a)), ...);
  commit(pos + n);
}

// Hand-written ops: the handler gets the command (cmd[0] is the opcode) and returns its length in words.
using Handler = uint32_t (*)(const uint32_t* cmd);
void registerOp(uint32_t op, Handler h);

// Runs fn(ctx) on the GL thread after everything already queued; returns once it has run.
void runSync(void (*fn)(void*), void* ctx, const char* what);
template <class F> inline auto sync(const char* what, F&& f) -> decltype(f()) {
  if (!active() || t_onGL) return f();
  using R = decltype(f());
  if constexpr (std::is_void_v<R>) {
    runSync([](void* p) { (*(std::remove_reference_t<F>*)p)(); }, (void*)&f, what);
  } else {
    R r{}; auto g = [&] { r = f(); };
    runSync([](void* p) { (*(decltype(g)*)p)(); }, (void*)&g, what);
    return r;
  }
}
template <class F> inline auto sync(F&& f) -> decltype(f()) { return sync("host", static_cast<F&&>(f)); }
// Waits until the GL thread has executed everything queued so far.
void finish();

// Per-frame counters for the stats line: commands' words recorded, sync calls, the GL thread's busy time.
struct Stats { uint64_t words = 0, syncs = 0, busyUs = 0, waitUs = 0, wraps = 0, fullWaits = 0; };
Stats takeStats();
// The most frequent sync callers since the last call ("glGetIntegerv 412, getParameter 30"), for the log.
const char* topSyncs();

}  // namespace glq
}  // namespace host

// GLQ_SYNC(expr): a GL expression (a call, its result) evaluated on the GL thread in order with the queue.
#define GLQ_SYNC(expr) ::host::glq::sync(#expr, [&]() { return expr; })
