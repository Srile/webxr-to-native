#pragma once
// The capture ring between a microphone's callback thread and the audio render threads (WP-25): one writer (the
// capture callback), any number of readers (each MediaStreamAudioSourceNode keeps its own LiveCursor), no locks,
// no allocation after construction. The writer only ever advances a 64-bit count; a reader takes what lies
// between its cursor and that count. Readers keep a bounded lag behind the writer, far under the capacity, so
// the samples they read are never the ones being overwritten:
//   - the first read (and the first after an underrun or a disabled track) starts `target` samples behind the
//     newest: one capture burst, one quantum, and kTargetLag of jitter margin (an output callback may render
//     several quanta at once, a capture callback delivers 10 ms or more at once);
//   - a reader more than kMaxLag behind (its context suspended, the node not pulled) drops the oldest samples
//     and starts again at `target` behind: latency stays bounded, as a browser's does;
//   - not enough samples for a quantum (the capture stalled): silence until `target` samples past where it stopped
//     have arrived, then on from there (nothing replayed, nothing skipped).
// The capture rate may differ from the context's: linear interpolation between neighbouring samples.
#include <atomic>
#include <cstdint>
#include <cstring>
#include "audio/graph.h"

namespace host {
namespace audio {

class CaptureRing {
 public:
  static constexpr uint32_t kCapacity = 1u << 16;  // samples: 1.37 s at 48 kHz
  static constexpr double kTargetLag = 0.02, kMaxLag = 0.1;  // seconds

  CaptureRing() : buf_(new float[kCapacity]()) {}
  ~CaptureRing() { delete[] buf_; }
  CaptureRing(const CaptureRing&) = delete; CaptureRing& operator=(const CaptureRing&) = delete;

  // Writer (capture thread): the stream's rate, before its first write and whenever it changes.
  void setRate(double hz) { rate_.store(hz, std::memory_order_release); }
  double rate() const { return rate_.load(std::memory_order_acquire); }
  void write(const float* x, uint32_t n) {
    if (n > kCapacity / 2) { x += n - kCapacity / 2; n = kCapacity / 2; }
    const uint64_t w = written_.load(std::memory_order_relaxed);
    for (uint32_t i = 0; i < n; i++) buf_[(w + i) & (kCapacity - 1)] = x[i];
    burst_.store(n, std::memory_order_relaxed);
    written_.store(w + n, std::memory_order_release);
  }
  void writeSilence(uint32_t n) {  // a gap the capture reports (PulseAudio's holes)
    if (n > kCapacity / 2) n = kCapacity / 2;
    const uint64_t w = written_.load(std::memory_order_relaxed);
    for (uint32_t i = 0; i < n; i++) buf_[(w + i) & (kCapacity - 1)] = 0;
    burst_.store(n, std::memory_order_relaxed);
    written_.store(w + n, std::memory_order_release);
  }
  uint64_t written() const { return written_.load(std::memory_order_acquire); }
  uint32_t underruns() const { return underruns_.load(std::memory_order_relaxed); }
  uint32_t overruns() const { return overruns_.load(std::memory_order_relaxed); }

  // Reader (a render thread): n samples at outRate into out; false = silence this quantum (out untouched).
  bool read(LiveCursor& c, float* out, int n, double outRate) {
    const uint64_t w = written();
    const double inRate = rate();
    if (inRate <= 0 || outRate <= 0) { c.primed = false; return false; }
    const double step = inRate / outRate;
    const uint64_t span = (uint64_t)(step * n) + 2;  // input samples one quantum interpolates over
    const uint64_t target = (uint64_t)(inRate * kTargetLag) + burst_.load(std::memory_order_relaxed) + span;
    const uint64_t most = target + (uint64_t)(inRate * kMaxLag);
    if (!c.primed && c.waiting && c.pos <= w && w - c.pos <= most) {  // after an underrun: on from where it was
      if (w - c.pos < target) return false;
      c.primed = true; c.waiting = false;
    } else if (!c.primed) {  // a first read (or the track enabled again): the newest samples, `target` behind
      if (w < target) return false;
      c.pos = w - target; c.frac = 0; c.primed = true; c.waiting = false;
    } else if (c.pos > w || w - c.pos > most) {  // fell behind: drop the oldest
      overruns_.fetch_add(1, std::memory_order_relaxed);
      c.pos = w >= target ? w - target : 0; c.frac = 0;
    }
    if (w - c.pos < (uint64_t)(c.frac + step * (n - 1)) + 2) {  // the capture has not kept up: silence until it has
      underruns_.fetch_add(1, std::memory_order_relaxed); c.primed = false; c.waiting = true; return false;
    }
    uint64_t p = c.pos; double f = c.frac;
    constexpr uint64_t mask = kCapacity - 1;
    if (step == 1.0 && f == 0.0) {
      for (int i = 0; i < n; i++) out[i] = buf_[(p + (uint64_t)i) & mask];
      p += (uint64_t)n;
    } else {
      for (int i = 0; i < n; i++) {
        const float s0 = buf_[p & mask], s1 = buf_[(p + 1) & mask];
        out[i] = s0 + (float)f * (s1 - s0);
        f += step; const uint64_t adv = (uint64_t)f; p += adv; f -= (double)adv;
      }
    }
    c.pos = p; c.frac = f;
    return true;
  }

 private:
  float* buf_;
  std::atomic<uint64_t> written_{0};
  std::atomic<double> rate_{0};
  std::atomic<uint32_t> burst_{0}, underruns_{0}, overruns_{0};
};

}  // namespace audio
}  // namespace host
