// The GL thread's ring under load, without GL (host/gl/gl_queue.h): one producer writing commands of random sizes
// through reserve/commit (the protocol the JS encoders use), one consumer thread checking every word, sync calls
// in between that must see everything before them executed. Run on the Mac (arm64: a weak memory model, as the
// Quest's), with a 1 MB ring so the commands wrap thousands of times.
#include "gl/gl_queue.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <random>

using namespace host;
static uint32_t g_seen = 0;       // consumer: commands checked
static uint64_t g_words = 0;
static bool g_bad = false;
static uint32_t pattern(uint32_t seq, uint32_t i) { return seq * 2654435761u ^ (i * 40503u + 7); }
// [op, seq, n, n payload words]
static uint32_t check(const uint32_t* c) {
  const uint32_t seq = c[1], n = c[2];
  if (seq != g_seen) { fprintf(stderr, "out of order: got %u want %u\n", seq, g_seen); g_bad = true; }
  for (uint32_t i = 0; i < n; ++i) if (c[3 + i] != pattern(seq, i)) { fprintf(stderr, "seq %u word %u: %08x\n", seq, i, c[3 + i]); g_bad = true; break; }
  ++g_seen; g_words += 3 + n;
  return 3 + n;
}

int main() {
  int bound = 0;
  bool ok = glq::start([](void* b) { ++*(int*)b; return true; }, [](void* b) { --*(int*)b; }, &bound, 1u << 20);
  assert(ok && glq::active());
  glq::registerOp(glq::kFirstHand, check);
  std::mt19937 rng(1234);
  const uint32_t total = 2000000; uint32_t syncs = 0;
  for (uint32_t seq = 0; seq < total; ++seq) {
    // Mostly small commands (a draw, a uniform), sometimes a big upload (up to 64 K words: a 256 KB buffer).
    const uint32_t r = rng() % 1000, n = r < 900 ? rng() % 20 : r < 995 ? rng() % 2000 : rng() % 65536;
    const uint32_t pos = glq::reserve(3 + n); uint32_t* d = glq::data() + pos;
    d[0] = glq::kFirstHand; d[1] = seq; d[2] = n;
    for (uint32_t i = 0; i < n; ++i) d[3 + i] = pattern(seq, i);
    glq::commit(pos + 3 + n);
    if (seq % 5000 == 4999) {  // a getter: everything recorded so far must have run before it
      const uint32_t want = seq + 1; uint32_t got = 0;
      glq::sync("test", [&] { got = g_seen; });
      if (got != want) { fprintf(stderr, "sync saw %u commands, %u were recorded\n", got, want); g_bad = true; }
      ++syncs;
    }
  }
  glq::finish();
  const glq::Stats st = glq::takeStats();
  printf("gl_queue_test: %u commands, %llu words, %u syncs, %llu wraps, %llu full waits; consumer saw %u\n", total,
         (unsigned long long)g_words, syncs, (unsigned long long)st.wraps, (unsigned long long)st.fullWaits, g_seen);
  glq::stop();
  if (g_bad || g_seen != total || st.wraps == 0) { puts("gl_queue_test FAILED"); return 1; }
  puts("gl_queue_test ok"); return 0;
}
