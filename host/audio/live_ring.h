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
// A network voice's ring (adaptive) also has a target that moves (JitterTarget, below): each reader drifts toward
// it, but only on quiet quanta, so speech is never stretched or cut: below the target it holds back a quantum of
// near silence (plays silence, takes nothing), above it by more than kSlack it skips one.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include "audio/graph.h"

namespace host {
namespace audio {

class CaptureRing {
 public:
  static constexpr uint32_t kCapacity = 1u << 16;  // samples: 1.37 s at 48 kHz
  static constexpr double kTargetLag = 0.02, kMaxLag = 0.1;  // seconds (a microphone's)

  // targetLag / maxLag: a network stream's arrive in bursts (rtc/rtc_bind.cpp gives a remote voice more margin).
  explicit CaptureRing(double targetLag = kTargetLag, double maxLag = kMaxLag, bool adaptive = false)
      : buf_(new float[kCapacity]()), targetLag_(targetLag), maxLag_(maxLag), adaptive_(adaptive) {}
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
  // The jitter margin (seconds) readers keep: any thread; an adaptive ring's readers move to it in quiet quanta.
  void setTargetLag(double s) { targetLag_.store(s, std::memory_order_relaxed); }
  double targetLag() const { return targetLag_.load(std::memory_order_relaxed); }
  static constexpr double kSlack = 0.02;    // seconds over the target an adaptive reader allows before trimming
  static constexpr float kQuiet = 0.01f;    // a quantum's peak below this is quiet enough to hold back or skip
  uint32_t underruns() const { return underruns_.load(std::memory_order_relaxed); }
  uint32_t overruns() const { return overruns_.load(std::memory_order_relaxed); }

  // Reader (a render thread): n samples at outRate into out; false = silence this quantum (out untouched).
  bool read(LiveCursor& c, float* out, int n, double outRate) {
    const uint64_t w = written();
    const double inRate = rate();
    if (inRate <= 0 || outRate <= 0) { c.primed = false; return false; }
    const double step = inRate / outRate;
    const uint64_t span = (uint64_t)(step * n) + 2;  // input samples one quantum interpolates over
    const uint64_t target = (uint64_t)(inRate * targetLag()) + burst_.load(std::memory_order_relaxed) + span;
    const uint64_t most = target + (uint64_t)(inRate * maxLag_);
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
    if (adaptive_) {
      const uint64_t lag = w - c.pos, slack = (uint64_t)(inRate * kSlack);
      if (lag + slack / 2 < target) {
        if (quiet(c.pos, span)) return false;  // under the target: this quiet quantum waits (the lag grows)
      } else if (lag > target + slack + span && quiet(c.pos, 2 * span)) {
        c.pos += span;  // over it: a quiet quantum skipped, landing in quiet too (no jump into speech)
      }
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
  bool quiet(uint64_t from, uint64_t count) const {
    float peak = 0;
    for (uint64_t i = 0; i < count; i++) peak = std::max(peak, std::fabs(buf_[(from + i) & (kCapacity - 1)]));
    return peak < kQuiet;
  }

  float* buf_;
  std::atomic<double> targetLag_;
  const double maxLag_;
  const bool adaptive_;
  std::atomic<uint64_t> written_{0};
  std::atomic<double> rate_{0};
  std::atomic<uint32_t> burst_{0}, underruns_{0}, overruns_{0};
};

// The jitter margin a network voice's ring keeps (rtc/rtc_bind.cpp feeds it each RTP packet as it arrives; the
// ring's readers move to its target): enough for the arrival jitter seen lately, NetEq-like but simple. A packet's
// delay is its arrival time less its place on the stream's own clock (the RTP timestamp, so concealed losses and a
// sender's silent stretches don't count); its jitter is that delay above the lowest seen lately (which rises 2 ms a
// second, following a path that got slower). The target is the peak jitter, decaying with a 10 s half-life, plus a
// margin, between minLag (the fixed margin it replaces: a steady link keeps it) and maxLag. An underrun the readers report (the ring's count rose) raises the peak at once:
// the jitter that caused it was more than the margin covered. Writer thread only.
class JitterTarget {
 public:
  JitterTarget(double minLag = 0.06, double maxLag = 0.24, double margin = 0.02, double halfLife = 10)
      : minLag_(minLag), maxLag_(maxLag), margin_(margin), halfLife_(halfLife), target_(minLag) {}

  // A packet with RTP timestamp `ts` (a `clockRate` clock) arriving at `now` seconds; `underruns`: the ring's count.
  // Returns the target lag in seconds.
  double arrived(double now, uint32_t ts, double clockRate, uint32_t underruns) {
    if (!started_ || now - last_ > 1.0) {  // the first packet, or a stream back after a pause: a new baseline
      started_ = true; ext_ = 0; base_ = now; lastTs_ = ts; last_ = now; underruns_ = underruns;
      return target_;
    }
    ext_ += (int32_t)(ts - lastTs_); lastTs_ = ts;
    const double dt = now - last_, delay = now - (double)ext_ / clockRate;
    last_ = now;
    base_ = std::min(delay, base_ + dt * kBaseRise);
    jitter_ = delay - base_;
    peak_ = std::max(jitter_, peak_ * std::exp2(-dt / halfLife_));
    if (underruns != underruns_) { peak_ = std::max(peak_, target_ - margin_ + kUnderrunStep); underruns_ = underruns; }
    target_ = std::clamp(peak_ + margin_, minLag_, maxLag_);
    return target_;
  }
  double target() const { return target_; }
  double jitter() const { return jitter_; }  // the last packet's, seconds

  static constexpr double kBaseRise = 0.002;      // s/s
  static constexpr double kUnderrunStep = 0.02;   // s

 private:
  const double minLag_, maxLag_, margin_, halfLife_;
  bool started_ = false;
  int64_t ext_ = 0; uint32_t lastTs_ = 0, underruns_ = 0;
  double base_ = 0, last_ = 0, peak_ = 0, jitter_ = 0, target_;
};

}  // namespace audio
}  // namespace host
