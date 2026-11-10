// AnalyserNode's analysis (see analyser.h), as the Web Audio spec defines it (§1.8.6, "FFT Windowing and
// smoothing over time"): the last fftSize samples, a Blackman window (alpha 0.16), X[k] = 1/N sum x[n] w[n]
// e^(-2 pi i k n / N) by an in-place radix-2 FFT, smoothed |X[k]| = tau * previous + (1 - tau) * |X[k]|
// (NaN or infinite: 0), in dB 20 log10 (0: -Infinity); bytes floor(255 / (max - min) * (dB - min)) and
// floor(128 * (1 + x)), clamped to 0..255. Host thread only, except push() (analyser.h, render thread).
#include "audio/analyser.h"
#include <cmath>
#include <cstring>

namespace host {
namespace audio {

namespace {
constexpr double PI = 3.14159265358979323846;
inline uint8_t clampByte(double v) { return v <= 0 ? 0 : v >= 255 ? 255 : (uint8_t)v; }
}

AnalyserState* AnalyserState::create(uint32_t fftSize) {
  if (fftSize < 32 || fftSize > 32768 || (fftSize & (fftSize - 1))) return nullptr;
  return new AnalyserState(fftSize);
}

AnalyserState::AnalyserState(uint32_t n) : Shared(Kind::Analyser), n_(n) {
  uint32_t size = 1; while (size < n + QUANTUM) size <<= 1;  // the writer's next quantum never lands in the newest n
  mask_ = size - 1;
  hist_ = new float[size](); win_ = new float[n]; re_ = new float[n]; im_ = new float[n];
  cosT_ = new float[n / 2]; sinT_ = new float[n / 2]; rev_ = new uint32_t[n]; smooth_ = new float[n / 2]();
  const double a = 0.16, a0 = 0.5 * (1 - a), a1 = 0.5, a2 = 0.5 * a;
  for (uint32_t i = 0; i < n; i++) win_[i] = (float)(a0 - a1 * std::cos(2 * PI * i / n) + a2 * std::cos(4 * PI * i / n));
  for (uint32_t k = 0; k < n / 2; k++) { cosT_[k] = (float)std::cos(2 * PI * k / n); sinT_[k] = (float)std::sin(2 * PI * k / n); }
  uint32_t bits = 0; while ((1u << bits) < n) bits++;
  for (uint32_t i = 0; i < n; i++) { uint32_t r = 0; for (uint32_t b = 0; b < bits; b++) if (i & (1u << b)) r |= 1u << (bits - 1 - b); rev_[i] = r; }
}

AnalyserState::~AnalyserState() {
  delete[] hist_; delete[] win_; delete[] re_; delete[] im_; delete[] cosT_; delete[] sinT_; delete[] rev_; delete[] smooth_;
}

void AnalyserState::latest(float* out) {
  const uint64_t w = written(), start = w - n_;  // before n_ samples exist this wraps onto the ring's unwritten zeros
  for (uint32_t i = 0; i < n_; i++) out[i] = hist_[(start + i) & mask_];
}

void AnalyserState::compute(double smoothing) {
  const uint32_t n = n_;
  latest(re_);
  for (uint32_t i = 0; i < n; i++) { re_[i] *= win_[i]; im_[i] = 0; }
  for (uint32_t i = 0; i < n; i++) { const uint32_t j = rev_[i]; if (i < j) { float t = re_[i]; re_[i] = re_[j]; re_[j] = t; } }
  for (uint32_t len = 2; len <= n; len <<= 1) {
    const uint32_t half = len >> 1, step = n / len;
    for (uint32_t i = 0; i < n; i += len) for (uint32_t j = 0; j < half; j++) {
      const float wr = cosT_[j * step], wi = -sinT_[j * step];
      const uint32_t p = i + j, q = p + half;
      const float vr = re_[q] * wr - im_[q] * wi, vi = re_[q] * wi + im_[q] * wr;
      re_[q] = re_[p] - vr; im_[q] = im_[p] - vi; re_[p] += vr; im_[p] += vi;
    }
  }
  const double scale = 1.0 / n, tau = smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing;
  for (uint32_t k = 0; k < n / 2; k++) {
    const double m = std::sqrt((double)re_[k] * re_[k] + (double)im_[k] * im_[k]) * scale;
    double s = tau * smooth_[k] + (1 - tau) * m;
    if (!std::isfinite(s)) s = 0;
    smooth_[k] = (float)s;
  }
}

void AnalyserState::timeDomain(float* out, uint32_t count) {
  const uint64_t w = written(), start = w - n_; if (count > n_) count = n_;
  for (uint32_t i = 0; i < count; i++) out[i] = hist_[(start + i) & mask_];
}
void AnalyserState::timeDomainBytes(uint8_t* out, uint32_t count) {
  const uint64_t w = written(), start = w - n_; if (count > n_) count = n_;
  for (uint32_t i = 0; i < count; i++) out[i] = clampByte(std::floor(128.0 * (1.0 + hist_[(start + i) & mask_])));
}
void AnalyserState::frequency(float* out, uint32_t count, double smoothing) {
  const uint64_t w = written(); if (w != computedAt_) { compute(smoothing); computedAt_ = w; }
  if (count > n_ / 2) count = n_ / 2;
  for (uint32_t k = 0; k < count; k++) out[k] = smooth_[k] > 0 ? (float)(20.0 * std::log10((double)smooth_[k])) : -INFINITY;
}
void AnalyserState::frequencyBytes(uint8_t* out, uint32_t count, double smoothing, double minDb, double maxDb) {
  const uint64_t w = written(); if (w != computedAt_) { compute(smoothing); computedAt_ = w; }
  if (count > n_ / 2) count = n_ / 2;
  const double range = maxDb - minDb, k255 = range > 0 ? 255.0 / range : 0;
  for (uint32_t k = 0; k < count; k++) {
    if (!(smooth_[k] > 0)) { out[k] = 0; continue; }
    out[k] = clampByte(std::floor(k255 * (20.0 * std::log10((double)smooth_[k]) - minDb)));
  }
}

}  // namespace audio
}  // namespace host
