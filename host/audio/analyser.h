#pragma once
// AnalyserNode's state (WP-25): the render thread appends its mono input to a history ring; the host thread reads
// the most recent fftSize samples from it and analyses them as the Web Audio spec says (§1.8.6): a Blackman
// window, a forward FFT scaled by 1/N, the magnitudes smoothed over time (smoothingTimeConstant), in dB for the
// frequency data. Everything is sized when fftSize is set (create(), host thread); push() only writes.
// Not gated by WP-25's microphone switch: a plain graph node (music visualisers use it too).
#include <atomic>
#include <cstdint>
#include "audio/graph.h"

namespace host {
namespace audio {

class AnalyserState : public Shared {
 public:
  // fftSize: a power of two in [32, 32768] (the caller validates); nullptr otherwise.
  static AnalyserState* create(uint32_t fftSize);
  ~AnalyserState() override;
  uint32_t fftSize() const { return n_; }

  // Render thread: n samples (n <= QUANTUM) appended to the history.
  void push(const float* x, int n) {
    const uint64_t w = written_.load(std::memory_order_relaxed);
    for (int i = 0; i < n; i++) hist_[(w + (uint64_t)i) & mask_] = x[i];
    written_.store(w + (uint64_t)n, std::memory_order_release);
  }
  void pushSilence(int n) {
    const uint64_t w = written_.load(std::memory_order_relaxed);
    for (int i = 0; i < n; i++) hist_[(w + (uint64_t)i) & mask_] = 0;
    written_.store(w + (uint64_t)n, std::memory_order_release);
  }
  uint64_t written() const { return written_.load(std::memory_order_acquire); }

  // Host thread. Time domain: the most recent min(count, fftSize) samples, oldest first; as floats, or as bytes
  // (128 * (1 + x), clamped). Frequency: min(count, fftSize / 2) bins in dB, or as bytes scaled between minDb
  // and maxDb. The frequency data is computed again only when the history has moved since the last time (the
  // spec: two calls in one render quantum see the same data); smoothing applies at that computation.
  void timeDomain(float* out, uint32_t count);
  void timeDomainBytes(uint8_t* out, uint32_t count);
  void frequency(float* out, uint32_t count, double smoothing);
  void frequencyBytes(uint8_t* out, uint32_t count, double smoothing, double minDb, double maxDb);

 private:
  explicit AnalyserState(uint32_t n);
  void latest(float* out);  // the last n_ samples, oldest first
  void compute(double smoothing);
  uint32_t n_, mask_;
  float* hist_ = nullptr;                  // the history ring (render writes, host reads): >= n_ + one quantum
  std::atomic<uint64_t> written_{0};
  // host thread only
  float* win_ = nullptr; float* re_ = nullptr; float* im_ = nullptr; float* cosT_ = nullptr; float* sinT_ = nullptr;
  uint32_t* rev_ = nullptr; float* smooth_ = nullptr;  // smooth_: |X| smoothed, n_ / 2 bins
  uint64_t computedAt_ = ~0ull;
};

}  // namespace audio
}  // namespace host
