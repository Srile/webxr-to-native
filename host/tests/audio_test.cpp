// WP-08 DSP tests: graphs rendered offline on the Mac, asserted against the
// Web Audio spec's formulas computed independently here.
#include "audio/analyser.h"
#include "audio/decode.h"
#include "audio/live_ring.h"
#include "audio/offline.h"
#include "audio/webm.h"
#ifdef HOST_HAS_OPUS
#include <opus.h>
#include "audio/voice_in.h"
#endif
#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

using namespace host::audio;
static const double PI = 3.14159265358979323846;
static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

static double rms(const float* d, uint32_t from, uint32_t to) { double s = 0; for (uint32_t i = from; i < to; i++) s += (double)d[i] * d[i]; return std::sqrt(s / (to - from)); }
static double db(double v) { return 20 * std::log10(v); }
static uint32_t constantBuffer(OfflineContext& c, float v, uint32_t len = 1024) {
  AudioBufferData* b = AudioBufferData::create(1, len, c.sampleRate()); for (uint32_t i = 0; i < len; i++) b->ch(0)[i] = v;
  uint32_t src = c.createNode(Kind::BufferSource); c.setBuffer(src, b); b->unref(); c.setProp(src, P_Loop, 1); return src;
}
static void countMsgs(ContextBase& c, int* ended, int* freed) {
  c.drain([&](const Msg& m) { if (m.type == Msg::Ended) (*ended)++; else if (m.type == Msg::Freed) (*freed)++; });
}

// 1. A 1 kHz sine through a 500 Hz lowpass (Q = 0 dB) drops by the spec's |H(e^jw)|.
static void testLowpass() {
  const double R = 48000, f0 = 500, fin = 1000, Q = 0;
  OfflineContext c(1, (uint32_t)R, R);
  uint32_t osc = c.createNode(Kind::Oscillator), bq = c.createNode(Kind::Biquad);
  c.setParam(osc, 0, (float)fin); c.setProp(bq, P_Type, F_Lowpass); c.setParam(bq, 0, (float)f0); c.setParam(bq, 2, (float)Q);
  c.connect(osc, bq); c.connect(bq, 0); c.start(osc, 0, 0, 0);
  AudioBufferData* out = c.renderNow();
  double measured = db(rms(out->ch(0), (uint32_t)(R * 0.5), (uint32_t)R) * std::sqrt(2.0));
  // Spec §1.9: lowpass with aQdB = sin(w0) / (2 * 10^(Q/20)).
  double w0 = 2 * PI * f0 / R, a = std::sin(w0) / (2 * std::pow(10.0, Q / 20)), cw = std::cos(w0);
  double b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2, a0 = 1 + a, a1 = -2 * cw, a2 = 1 - a;
  double w = 2 * PI * fin / R;
  double nr = b0 + b1 * std::cos(w) + b2 * std::cos(2 * w), ni = -(b1 * std::sin(w) + b2 * std::sin(2 * w));
  double dr = a0 + a1 * std::cos(w) + a2 * std::cos(2 * w), di = -(a1 * std::sin(w) + a2 * std::sin(2 * w));
  double expected = db(std::sqrt((nr * nr + ni * ni) / (dr * dr + di * di)));
  CHECK(std::fabs(measured - expected) < 0.15, "lowpass: measured %.3f dB, expected %.3f dB", measured, expected);
  CHECK(expected < -10 && expected > -14, "lowpass expectation sanity %.2f", expected);
  printf("lowpass 1 kHz through 500 Hz: %.2f dB (spec %.2f dB)\n", measured, expected);
  out->unref();
}

// 2. Gain automation: every method, against the spec curves, within 1e-3.
static void testAutomation() {
  const double R = 48000; const uint32_t N = (uint32_t)R;
  OfflineContext c(1, N, R);
  uint32_t src = constantBuffer(c, 1.0f), g = c.createNode(Kind::Gain);
  c.connect(src, g); c.connect(g, 0); c.start(src, 0, 0, 0);
  c.schedule(g, 0, EvType::SetValue, 0.2f, 0.1, 0);
  c.schedule(g, 0, EvType::LinearRamp, 1.0f, 0.3, 0);
  c.schedule(g, 0, EvType::ExpRamp, 0.1f, 0.5, 0);
  c.schedule(g, 0, EvType::SetTarget, 0.8f, 0.6, 0.05f);
  c.cancelHold(g, 0, 0.75);
  c.schedule(g, 0, EvType::LinearRamp, 0.0f, 0.9, 0);
  AudioBufferData* out = c.renderNow();
  double maxErr = 0; int worst = -1;
  const double vHold = 0.8 + (0.1 - 0.8) * std::exp(-(0.75 - 0.6) / 0.05);
  for (uint32_t i = 0; i < N; i++) {
    double t = i / R, e;
    if (t < 0.1) e = 1.0;
    else if (t < 0.3) e = 0.2 + (1.0 - 0.2) * (t - 0.1) / 0.2;
    else if (t < 0.5) e = 1.0 * std::pow(0.1 / 1.0, (t - 0.3) / 0.2);
    else if (t < 0.6) e = 0.1;
    else if (t < 0.75) e = 0.8 + (0.1 - 0.8) * std::exp(-(t - 0.6) / 0.05);
    else if (t < 0.9) e = vHold + (0.0 - vHold) * (t - 0.75) / 0.15;
    else e = 0.0;
    double err = std::fabs(out->ch(0)[i] - e); if (err > maxErr) { maxErr = err; worst = (int)i; }
  }
  CHECK(maxErr < 1e-3, "automation: max error %.5f at sample %d (t=%.4f)", maxErr, worst, worst / R);
  printf("automation curves: max error %.2e\n", maxErr);
  out->unref();
  // cancelScheduledValues drops everything at or after its time.
  OfflineContext c2(1, 4800, R);
  uint32_t s2 = constantBuffer(c2, 1.0f), g2 = c2.createNode(Kind::Gain);
  c2.connect(s2, g2); c2.connect(g2, 0); c2.start(s2, 0, 0, 0);
  c2.schedule(g2, 0, EvType::SetValue, 0.5f, 0.01, 0); c2.schedule(g2, 0, EvType::SetValue, 0.1f, 0.05, 0); c2.cancel(g2, 0, 0.05);
  AudioBufferData* o2 = c2.renderNow();
  CHECK(std::fabs(o2->ch(0)[4000] - 0.5f) < 1e-6, "cancelScheduledValues: %.4f", o2->ch(0)[4000]);
  o2->unref();
}

// 3. BufferSource: loop points, playbackRate resampling, buffer at another rate, ended.
static void testBufferSource() {
  const double R = 48000;
  { // loop + rate 2 over a 100-sample ramp
    OfflineContext c(1, 1000, R);
    AudioBufferData* b = AudioBufferData::create(1, 100, R); for (int i = 0; i < 100; i++) b->ch(0)[i] = (float)i;
    uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b); b->unref(); c.setProp(s, P_Loop, 1); c.setParam(s, 0, 2.0f);
    c.connect(s, 0); c.start(s, 0, 0, 0);
    AudioBufferData* o = c.renderNow(); bool ok = true;
    for (int i = 0; i < 1000; i++) if (std::fabs(o->ch(0)[i] - (float)((2 * i) % 100)) > 1e-4) { ok = false; break; }
    CHECK(ok, "loop at rate 2");
    o->unref();
  }
  { // rate 0.5: linear interpolation between neighbours; loopStart/loopEnd window
    OfflineContext c(1, 400, R);
    AudioBufferData* b = AudioBufferData::create(1, 100, R); for (int i = 0; i < 100; i++) b->ch(0)[i] = (float)i;
    uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b); b->unref(); c.setProp(s, P_Loop, 1);
    c.setProp(s, P_LoopStart, 20.0 / R); c.setProp(s, P_LoopEnd, 60.0 / R); c.setParam(s, 0, 0.5f);
    c.connect(s, 0); c.start(s, 0, 20.0 / R, 0);
    AudioBufferData* o = c.renderNow(); bool ok = true;
    // At the seam the interpolation runs toward loopStart (the sample the wrap lands on), as Chrome's does.
    for (int i = 0; i < 400; i++) { double p = 20 + 0.5 * i; while (p >= 60) p -= 40; double want = p < 59 ? p : 59 + (p - 59) * (20 - 59); if (std::fabs(o->ch(0)[i] - want) > 1e-3) { ok = false; fprintf(stderr, "i=%d got %f want %f\n", i, o->ch(0)[i], want); break; } }
    CHECK(ok, "loop window + rate 0.5 interpolation");
    o->unref();
  }
  { // a 24 kHz buffer in a 48 kHz context plays at half step; a one-shot ends and reports it
    OfflineContext c(1, 4096, R);
    AudioBufferData* b = AudioBufferData::create(1, 100, 24000); for (int i = 0; i < 100; i++) b->ch(0)[i] = (float)i;
    uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b); b->unref();
    c.connect(s, 0); c.start(s, 128.0 / R, 0, 0);
    AudioBufferData* o = c.renderNow();
    CHECK(o->ch(0)[127] == 0 && std::fabs(o->ch(0)[128 + 10] - 5.0f) < 1e-4 && std::fabs(o->ch(0)[128 + 11] - 5.5f) < 1e-4, "buffer rate conversion: %f %f", o->ch(0)[138], o->ch(0)[139]);
    CHECK(o->ch(0)[128 + 200] == 0 && o->ch(0)[4000] == 0, "one-shot silent after its end");
    int ended = 0, freed = 0; countMsgs(c, &ended, &freed);
    CHECK(ended == 1, "ended once, got %d", ended);
    o->unref();
  }
  { // stop() on a source with no buffer: no crash, ended exactly once; stop(when) cuts a loop
    OfflineContext c(1, 2048, R);
    uint32_t s = c.createNode(Kind::BufferSource); c.connect(s, 0); c.start(s, 0, 0, 0); c.stop(s, 0.01);
    uint32_t s2 = constantBuffer(c, 1.0f); c.connect(s2, 0); c.start(s2, 0, 0, 0); c.stop(s2, 1000.0 / R);
    AudioBufferData* o = c.renderNow();
    CHECK(std::fabs(o->ch(0)[999] - 1.0f) < 1e-6 && o->ch(0)[1000] == 0, "stop(when) at the sample: %f %f", o->ch(0)[999], o->ch(0)[1000]);
    int ended = 0, freed = 0; countMsgs(c, &ended, &freed);
    CHECK(ended == 2, "two ended, got %d", ended);
    o->unref();
  }
  { // a stereo source into a mono destination is (L + R) / 2; mono into stereo copies
    OfflineContext c(1, 256, R);
    AudioBufferData* b = AudioBufferData::create(2, 256, R); for (int i = 0; i < 256; i++) { b->ch(0)[i] = 0.2f; b->ch(1)[i] = 0.6f; }
    uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b); b->unref(); c.connect(s, 0); c.start(s, 0, 0, 0);
    AudioBufferData* o = c.renderNow(); CHECK(std::fabs(o->ch(0)[100] - 0.4f) < 1e-6, "downmix %f", o->ch(0)[100]); o->unref();
    OfflineContext c2(2, 256, R);
    uint32_t m = constantBuffer(c2, 0.3f); c2.connect(m, 0); c2.start(m, 0, 0, 0);
    AudioBufferData* o2 = c2.renderNow(); CHECK(std::fabs(o2->ch(0)[10] - 0.3f) < 1e-6 && std::fabs(o2->ch(1)[10] - 0.3f) < 1e-6, "upmix"); o2->unref();
  }
}

// 4. Panner: equalpower azimuth gains and the distance models against the listener.
static void testPanner() {
  const double R = 48000;
  { // source hard right at distance 3, inverse rolloff 1: L = 0, R = 1/3
    OfflineContext c(2, 512, R);
    uint32_t s = constantBuffer(c, 1.0f), p = c.createNode(Kind::Panner);
    c.setParam(p, 0, 3); c.setProp(p, P_RefDistance, 1); c.setProp(p, P_RolloffFactor, 1); c.setProp(p, P_DistanceModel, D_Inverse);
    c.connect(s, p); c.connect(p, 0); c.start(s, 0, 0, 0);
    AudioBufferData* o = c.renderNow();
    CHECK(std::fabs(o->ch(0)[300]) < 1e-5 && std::fabs(o->ch(1)[300] - 1.0f / 3) < 1e-5, "panner right: L %f R %f", o->ch(0)[300], o->ch(1)[300]);
    o->unref();
  }
  { // source ahead at distance 3, linear model (ref 1, max 5): 0.5 split equally: both cos(45°) * 0.5
    OfflineContext c(2, 512, R);
    uint32_t s = constantBuffer(c, 1.0f), p = c.createNode(Kind::Panner);
    c.setParam(p, 2, -3); c.setProp(p, P_RefDistance, 1); c.setProp(p, P_RolloffFactor, 1); c.setProp(p, P_MaxDistance, 5); c.setProp(p, P_DistanceModel, D_Linear);
    c.connect(s, p); c.connect(p, 0); c.start(s, 0, 0, 0);
    AudioBufferData* o = c.renderNow(); float e = 0.5f * (float)std::cos(PI / 4);
    CHECK(std::fabs(o->ch(0)[300] - e) < 1e-5 && std::fabs(o->ch(1)[300] - e) < 1e-5, "panner ahead linear: L %f R %f want %f", o->ch(0)[300], o->ch(1)[300], e);
    o->unref();
  }
  { // listener turned to face +x: a source at +x is now ahead; exponential model at d = 2, rolloff 2 → 1/4
    OfflineContext c(2, 512, R);
    uint32_t s = constantBuffer(c, 1.0f), p = c.createNode(Kind::Panner);
    c.setParam(LISTENER_SLOT, 3, 1); c.setParam(LISTENER_SLOT, 5, 0);  // forward = +x
    c.setParam(p, 0, 2); c.setProp(p, P_RefDistance, 1); c.setProp(p, P_RolloffFactor, 2); c.setProp(p, P_DistanceModel, D_Exponential);
    c.connect(s, p); c.connect(p, 0); c.start(s, 0, 0, 0);
    AudioBufferData* o = c.renderNow(); float e = 0.25f * (float)std::cos(PI / 4);
    CHECK(std::fabs(o->ch(0)[300] - e) < 1e-5 && std::fabs(o->ch(1)[300] - e) < 1e-5, "panner listener fwd +x: L %f R %f want %f", o->ch(0)[300], o->ch(1)[300], e);
    // and the listener moved past it (forward +x → right is +z): the source is behind and to the right, R > L
    c.setParam(LISTENER_SLOT, 0, 4); c.setParam(LISTENER_SLOT, 2, -1);
    o->unref(); c.renderQuantum(); c.renderQuantum();
    CHECK(c.graph().destOut(1)[64] > c.graph().destOut(0)[64] && c.graph().destOut(0)[64] > 0, "panner behind-right favours R: L %f R %f", c.graph().destOut(0)[64], c.graph().destOut(1)[64]);
  }
}

// 5. Compressor: a burst 6 dB over the threshold is reduced; reduction reads back.
static void testCompressor() {
  const double R = 48000; const uint32_t N = (uint32_t)R;
  OfflineContext c(1, N, R);
  AudioBufferData* b = AudioBufferData::create(1, N, R);
  float quiet = (float)std::pow(10, -30.0 / 20), loud = (float)std::pow(10, -12.0 / 20);  // threshold −18, knee 12 → −12 dB sits at the knee's top
  for (uint32_t i = 0; i < N; i++) b->ch(0)[i] = i < N / 2 ? quiet : loud;
  uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b); b->unref();
  uint32_t comp = c.createNode(Kind::Compressor);
  c.setParam(comp, 0, -18); c.setParam(comp, 1, 12); c.setParam(comp, 2, 6); c.setParam(comp, 3, 0.002f); c.setParam(comp, 4, 0.12f);
  c.connect(s, comp); c.connect(comp, 0); c.start(s, 0, 0, 0);
  // Render by hand so the reduction can be read mid-burst.
  for (uint32_t f = 0; f < N; f += QUANTUM) {
    c.renderQuantum();
    if (f == QUANTUM * 100) CHECK(std::fabs(c.reduction(comp)) < 0.05, "reduction during quiet: %f", c.reduction(comp));
    if (f == N / 2 + QUANTUM * 150) CHECK(std::fabs(c.reduction(comp) - (-5.0f)) < 0.3, "reduction during burst: %f (want −5 dB)", c.reduction(comp));
  }
  // Output levels: input step 18 dB, output step 18 − 5 = 13 dB (the makeup gain is common).
  OfflineContext c2(1, N, R);
  AudioBufferData* b2 = AudioBufferData::create(1, N, R); memcpy(b2->ch(0), b->ch(0), N * sizeof(float));
  uint32_t s2 = c2.createNode(Kind::BufferSource); c2.setBuffer(s2, b2); b2->unref();
  uint32_t comp2 = c2.createNode(Kind::Compressor);
  c2.setParam(comp2, 0, -18); c2.setParam(comp2, 1, 12); c2.setParam(comp2, 2, 6); c2.setParam(comp2, 3, 0.002f); c2.setParam(comp2, 4, 0.12f);
  c2.connect(s2, comp2); c2.connect(comp2, 0); c2.start(s2, 0, 0, 0);
  AudioBufferData* o = c2.renderNow();
  double q = db(rms(o->ch(0), N / 4, N / 2 - 100)), l = db(rms(o->ch(0), N / 2 + N / 4, N));
  CHECK(std::fabs((l - q) - 13.0) < 0.5, "compressor step: quiet %.2f dB loud %.2f dB (step %.2f, want 13)", q, l, l - q);
  double makeup = db(std::pow(1.0 / std::pow(10, -15.0 / 20), 0.6));
  CHECK(std::fabs(q - (-30 + makeup)) < 0.5, "makeup gain: quiet out %.2f, want %.2f", q, -30 + makeup);
  printf("compressor: quiet %.2f dB, burst %.2f dB (step %.2f dB, makeup %.2f dB)\n", q, l, l - q, makeup);
  o->unref();
}

// 6. Oscillator waveforms (not band-limited; RMS and start phase per the spec's shapes).
static void testOscillator() {
  const double R = 48000;
  const struct { int wave; double rmsWant; } W[] = {{W_Sine, 1 / std::sqrt(2.0)}, {W_Square, 1.0}, {W_Sawtooth, 1 / std::sqrt(3.0)}, {W_Triangle, 1 / std::sqrt(3.0)}};
  for (auto& w : W) {
    OfflineContext c(1, 48000, R);
    uint32_t o = c.createNode(Kind::Oscillator); c.setProp(o, P_Type, w.wave); c.setParam(o, 0, 100); c.connect(o, 0); c.start(o, 0, 0, 0);
    AudioBufferData* out = c.renderNow();
    double r = rms(out->ch(0), 0, 48000);
    CHECK(std::fabs(r - w.rmsWant) < 0.02, "oscillator %d rms %.4f want %.4f", w.wave, r, w.rmsWant);
    if (w.wave == W_Sine) CHECK(std::fabs(out->ch(0)[120] - std::sin(2 * PI * 100 * 120 / R)) < 1e-4, "sine phase");
    out->unref();
  }
  // frequency a-rate exponential ramp: the chirp's zero crossings move
  OfflineContext c(1, 4800, R);
  uint32_t o = c.createNode(Kind::Oscillator); c.schedule(o, 0, EvType::SetValue, 200, 0, 0); c.schedule(o, 0, EvType::ExpRamp, 2000, 0.1, 0);
  c.connect(o, 0); c.start(o, 0, 0, 0); c.stop(o, 0.1);
  AudioBufferData* out = c.renderNow(); int zc = 0; for (int i = 1; i < 4800; i++) if ((out->ch(0)[i - 1] < 0) != (out->ch(0)[i] < 0)) zc++;
  // ∫f dt over an exponential sweep 200→2000 over 0.1 s = (2000−200)/ln(10) · 0.1 ≈ 78.2 cycles → ~156 crossings
  CHECK(zc > 150 && zc < 162, "chirp zero crossings %d", zc);
  int ended = 0, freed = 0; countMsgs(c, &ended, &freed); CHECK(ended == 1, "oscillator stop → ended");
  out->unref();
}

// 7. Node lifetime: released nodes are freed when they can no longer sound.
static void testLifetime() {
  const double R = 48000;
  OfflineContext c(1, 4096, R);
  AudioBufferData* b = AudioBufferData::create(1, 500, R);  // the test keeps its own reference
  uint32_t s = c.createNode(Kind::BufferSource); c.setBuffer(s, b);
  uint32_t g = c.createNode(Kind::Gain), g2 = c.createNode(Kind::Gain);
  c.connect(s, g); c.connect(g, g2); c.connect(g2, 0); c.start(s, 0, 0, 0);
  c.releaseNode(s); c.releaseNode(g);  // JS dropped both wrappers; g2 stays held
  c.renderQuantum();
  int ended = 0, freed = 0; countMsgs(c, &ended, &freed);
  CHECK(freed == 0, "nothing freed while the source plays (got %d)", freed);
  for (int i = 0; i < 5; i++) c.renderQuantum();
  countMsgs(c, &ended, &freed);
  CHECK(ended == 1 && freed == 2, "source ended → source and its released gain freed (ended %d freed %d)", ended, freed);
  CHECK(c.liveSlots() == 1, "one live slot (g2), got %u", c.liveSlots());
  CHECK(b->refs.load() == 1, "buffer back to its one owner ref, got %d", b->refs.load());
  uint32_t again = c.createNode(Kind::Gain); CHECK(again == s || again == g, "slot reused (%u)", again);
  // a never-started source released → freed at once; g2 released with no inputs → freed
  uint32_t idle = c.createNode(Kind::BufferSource); c.connect(idle, g2); c.releaseNode(idle); c.releaseNode(g2);
  countMsgs(c, &ended, &freed); CHECK(freed == 4, "idle source + emptied gain freed (freed %d)", freed);
  CHECK(c.kindOf(again) == Kind::Gain && c.kindOf(idle) == Kind::None && c.kindOf(0) == Kind::Destination, "the host thread's kinds: made %d, freed %d", (int)c.kindOf(again), (int)c.kindOf(idle));
  b->unref();
}

// 8. decode: a synthesized WAV, resampled; an ogg from the game's assets if present.
static void testDecode() {
  std::vector<uint8_t> w; auto put32 = [&](uint32_t v) { for (int i = 0; i < 4; i++) w.push_back((v >> (8 * i)) & 255); }; auto put16 = [&](uint16_t v) { w.push_back(v & 255); w.push_back(v >> 8); };
  const int n = 1000; w.insert(w.end(), {'R', 'I', 'F', 'F'}); put32(36 + n * 4); w.insert(w.end(), {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '}); put32(16);
  put16(1); put16(2); put32(22050); put32(22050 * 4); put16(4); put16(16); w.insert(w.end(), {'d', 'a', 't', 'a'}); put32(n * 4);
  for (int i = 0; i < n; i++) { put16((uint16_t)(int16_t)(16384)); put16((uint16_t)(int16_t)(-8192)); }
  std::string err; AudioBufferData* b = decodeAudio(w.data(), w.size(), 44100, &err);
  CHECK(b && err.empty(), "wav decode: %s", err.c_str());
  if (b) {
    CHECK(b->channels == 2 && b->sampleRate == 44100 && b->length == 2000, "wav: ch %d rate %.0f len %u", b->channels, b->sampleRate, b->length);
    CHECK(std::fabs(b->ch(0)[500] - 0.5f) < 1e-4 && std::fabs(b->ch(1)[500] + 0.25f) < 1e-4, "wav samples %f %f", b->ch(0)[500], b->ch(1)[500]);
    b->unref();
  }
  AudioBufferData* bad = decodeAudio(w.data(), 20, 0, &err); CHECK(!bad && !err.empty(), "truncated wav rejected");
  // An Ogg Vorbis file to decode (any game's sound effect): AUDIO_TEST_OGG, else the check is skipped.
  const char* oggPath = getenv("AUDIO_TEST_OGG");
  if (!oggPath) { printf("(AUDIO_TEST_OGG not set; ogg decode skipped)\n"); return; }
  std::ifstream f(oggPath, std::ios::binary); err.clear();
  if (f) {
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    AudioBufferData* o = decodeAudio(bytes.data(), bytes.size(), 48000, &err);
    CHECK(o && err.empty(), "ogg decode: %s", err.c_str());
    if (o) { CHECK(o->length > 100 && o->sampleRate == 48000, "ogg: len %u", o->length); double r = rms(o->ch(0), 0, o->length); CHECK(r > 0.001 && r < 1, "ogg rms %f", r); printf("ogg %s: %d ch, %u frames at 48 kHz, rms %.3f\n", oggPath, o->channels, o->length, r); o->unref(); }
  } else printf("(ogg fixture %s not found; skipped)\n", oggPath);
}

// 9. WebM, Ogg Opus and MP3. Opus: a stereo tone encoded here with libopus and muxed by hand the ways muxers write WebM (a
// video track before the audio one, Segment and Clusters of unknown size as MediaRecorder writes them, plain,
// Xiph- and EBML-laced SimpleBlocks, a BlockGroup with DiscardPadding, a Void and trailing Cues to skip); it must
// decode to exactly the samples encoded (pre-skip and padding trimmed), each channel the tone it was given.
// Vorbis: host/tests/data/vorbis-tone.webm (ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.25"
// -af volume=0.5 -c:a libvorbis -q:a 0: lavfi's sine is 1/8 full scale, so peak 1/16), and any game's .webm in AUDIO_TEST_WEBM (paths separated by ':').
struct Ebml {
  std::vector<uint8_t> b;
  void id(uint32_t v) { int n = v > 0xFFFFFF ? 4 : v > 0xFFFF ? 3 : v > 0xFF ? 2 : 1; for (int i = n - 1; i >= 0; i--) b.push_back((uint8_t)(v >> 8 * i)); }
  void size(uint64_t n) { b.push_back(0x01); for (int i = 6; i >= 0; i--) b.push_back((uint8_t)(n >> 8 * i)); }  // always 8 bytes long
  void unknownSize() { b.push_back(0x01); for (int i = 0; i < 7; i++) b.push_back(0xFF); }
  void bytes(uint32_t i, const void* d, size_t n) { id(i); size(n); b.insert(b.end(), (const uint8_t*)d, (const uint8_t*)d + n); }
  void uint(uint32_t i, uint64_t v) { uint8_t d[8]; for (int k = 0; k < 8; k++) d[k] = (uint8_t)(v >> 8 * (7 - k)); bytes(i, d, 8); }
  void sint(uint32_t i, int64_t v) { uint((i), (uint64_t)v); }
  void flt(uint32_t i, double v) { uint64_t u; memcpy(&u, &v, 8); uint(i, u); }
  void str(uint32_t i, const char* s) { bytes(i, s, strlen(s)); }
  void master(uint32_t i, const Ebml& c) { bytes(i, c.b.data(), c.b.size()); }
};
// A Block body: track, timestamp, flags, then the frames, laced as `lacing` says (0 none, 1 Xiph, 2 fixed, 3 EBML).
static std::vector<uint8_t> blockBody(int track, const std::vector<std::vector<uint8_t>>& frames, int lacing) {
  std::vector<uint8_t> b = {(uint8_t)(0x80 | track), 0, 0, (uint8_t)(0x80 | lacing << 1)};
  if (lacing) {
    b.push_back((uint8_t)(frames.size() - 1));
    for (size_t i = 0; i + 1 < frames.size(); i++) {
      size_t n = frames[i].size();
      if (lacing == 1) { while (n >= 255) { b.push_back(255); n -= 255; } b.push_back((uint8_t)n); }
      else if (lacing == 3) {  // 2-byte vints: the first size unsigned, then signed differences
        int64_t v = i == 0 ? (int64_t)n : (int64_t)n - (int64_t)frames[i - 1].size() + 8191;
        b.push_back((uint8_t)(0x40 | v >> 8)); b.push_back((uint8_t)v);
      }
    }
  }
  for (auto& f : frames) b.insert(b.end(), f.begin(), f.end());
  return b;
}

// Ogg pages of at most `maxSeg` lacing values (so packets span pages), granule positions per RFC 7845: the samples
// (pre-skip included) up to the last packet that ends on the page, the last page's the stream's end. CRCs left 0.
static std::vector<uint8_t> oggPages(const std::vector<std::vector<uint8_t>>& packets, const std::vector<int64_t>& endGranule, int maxSeg) {
  std::vector<uint8_t> out; uint32_t seq = 0;
  std::vector<uint8_t> lace, body; bool cont = false; int64_t granule = -1;  // cont: the page being filled starts inside a packet
  auto flush = [&](bool last) {
    uint8_t flags = (cont ? 1 : 0) | (seq == 0 ? 2 : 0) | (last ? 4 : 0);
    const uint8_t head[6] = {'O', 'g', 'g', 'S', 0, flags}; out.insert(out.end(), head, head + 6);
    for (int i = 0; i < 8; i++) out.push_back((uint8_t)((uint64_t)granule >> 8 * i));
    for (int i = 0; i < 4; i++) out.push_back(i == 0 ? 7 : 0);          // serial 7
    for (int i = 0; i < 4; i++) out.push_back((uint8_t)(seq >> 8 * i));
    for (int i = 0; i < 4; i++) out.push_back(0);                       // CRC (not checked)
    out.push_back((uint8_t)lace.size()); out.insert(out.end(), lace.begin(), lace.end()); out.insert(out.end(), body.begin(), body.end());
    lace.clear(); body.clear(); granule = -1; cont = false; seq++;
  };
  for (size_t k = 0; k < packets.size(); k++) {
    const auto& pk = packets[k]; size_t off = 0; bool inside = false;
    for (;;) {
      if ((int)lace.size() == maxSeg) { flush(false); cont = inside; }
      size_t n = std::min<size_t>(pk.size() - off, 255);
      lace.push_back((uint8_t)n); body.insert(body.end(), pk.begin() + off, pk.begin() + off + n); off += n; inside = true;
      if (n < 255) break;
    }
    granule = endGranule[k];
    if (k < 2) flush(false);  // OpusHead alone on the first page, OpusTags on the second
  }
  flush(true);
  return out;
}

static void testWebm() {
  std::string err;
#ifdef HOST_HAS_OPUS
  {
    const int R = 48000, N = 48000, F = 960;  // 1 s, 20 ms frames
    int e = 0; OpusEncoder* enc = opus_encoder_create(R, 2, OPUS_APPLICATION_AUDIO, &e);
    CHECK(enc, "opus_encoder_create %d", e);
    if (!enc) return;
    opus_encoder_ctl(enc, OPUS_SET_BITRATE(128000));
    opus_int32 lookahead = 0; opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(&lookahead));
    int frames = (N + lookahead + F - 1) / F;
    std::vector<float> in((size_t)frames * F * 2, 0.f);
    auto tone = [&](int c, int i) { return 0.5 * std::sin(2 * PI * (c ? 660 : 440) * i / R); };
    for (int i = 0; i < N; i++) for (int c = 0; c < 2; c++) in[(size_t)i * 2 + c] = (float)tone(c, i);
    std::vector<std::vector<uint8_t>> pk;
    for (int f = 0; f < frames; f++) {
      uint8_t buf[4000]; int n = opus_encode_float(enc, in.data() + (size_t)f * F * 2, F, buf, sizeof buf);
      CHECK(n > 0, "opus_encode_float %d", n); pk.emplace_back(buf, buf + (n > 0 ? n : 0));
    }
    opus_encoder_destroy(enc);
    int pad = frames * F - lookahead - N;                     // the last packet's samples past the end
    int64_t padNs = std::llround(pad * 1e9 / R);
    uint8_t head[19] = {'O', 'p', 'u', 's', 'H', 'e', 'a', 'd', 1, 2, (uint8_t)lookahead, (uint8_t)(lookahead >> 8), 0x80, 0xBB, 0, 0, 0, 0, 0};

    Ebml file, hdr; hdr.str(0x4282, "webm"); file.master(0x1A45DFA3, hdr);
    file.id(0x18538067); file.unknownSize();                  // Segment
    file.bytes(0xEC, "\0\0\0\0", 4);                          // Void
    Ebml tracks, video, audio, aud;
    video.uint(0xD7, 1); video.uint(0x83, 1); video.str(0x86, "V_VP9");
    audio.uint(0xD7, 2); audio.uint(0x83, 2); audio.str(0x86, "A_OPUS"); audio.uint(0x56AA, std::llround(lookahead * 1e9 / R));
    audio.bytes(0x63A2, head, sizeof head); aud.flt(0xB5, 48000); aud.uint(0x9F, 2); audio.master(0xE1, aud);
    tracks.master(0xAE, video); tracks.master(0xAE, audio); file.master(0x1654AE6B, tracks);
    size_t i = 0;
    for (int cluster = 0; cluster < 2; cluster++) {
      file.id(0x1F43B675); file.unknownSize(); file.uint(0xE7, 0);  // Cluster, Timestamp
      auto video0 = blockBody(1, {{1, 2, 3, 4, 5}}, 0); file.bytes(0xA3, video0.data(), video0.size());
      size_t end = cluster == 0 ? pk.size() / 2 : pk.size() - 1;
      while (i < end) {
        int lacing = i % 7 == 3 ? 1 : i % 7 == 5 ? 3 : 0;      // now and then three frames in one laced block
        size_t take = lacing && i + 3 <= end ? 3 : 1; if (take == 1) lacing = 0;
        auto body = blockBody(2, std::vector<std::vector<uint8_t>>(pk.begin() + i, pk.begin() + i + take), lacing);
        file.bytes(0xA3, body.data(), body.size()); i += take;
      }
    }
    Ebml group; auto last = blockBody(2, {pk.back()}, 0); group.bytes(0xA1, last.data(), last.size()); group.sint(0x75A2, padNs);
    file.master(0xA0, group);
    Ebml cues; cues.uint(0xBB, 0); file.master(0x1C53BB6B, cues);

    WebmAudio w; CHECK(demuxWebm(file.b.data(), file.b.size(), &w, &err), "webm demux: %s", err.c_str());
    CHECK(w.codec == "A_OPUS" && w.channels == 2 && w.rate == 48000 && w.packets.size() == pk.size(), "webm demux: %s, %d ch, %.0f Hz, %zu of %zu packets", w.codec.c_str(), w.channels, w.rate, w.packets.size(), pk.size());
    bool same = w.packets.size() == pk.size();
    for (size_t k = 0; same && k < pk.size(); k++) same = w.packets[k].len == pk[k].size() && !memcmp(w.packets[k].data, pk[k].data(), pk[k].size());
    CHECK(same, "webm demux: the packets as muxed (laced ones too)");
    AudioBufferData* b = decodeAudio(file.b.data(), file.b.size(), 48000, &err);
    CHECK(b && err.empty(), "webm opus decode: %s", err.c_str());
    if (b) {
      CHECK(b->channels == 2 && b->sampleRate == 48000 && b->length == (uint32_t)N, "webm opus: %d ch, %.0f Hz, %u frames (want %d)", b->channels, b->sampleRate, b->length, N);
      for (int c = 0; c < 2 && b->length == (uint32_t)N; c++) {
        double num = 0, den = 0, ref = 0;  // correlation against the tone that channel was given, past the codec's settling
        for (int k = 2000; k < N - 2000; k++) { double t = tone(c, k); num += b->ch(c)[k] * t; den += (double)b->ch(c)[k] * b->ch(c)[k]; ref += t * t; }
        double corr = num / std::sqrt(den * ref);
        CHECK(corr > 0.99, "webm opus channel %d: correlation with its %d Hz tone %.4f", c, c ? 660 : 440, corr);
      }
      // The same packets as Ogg Opus, pages of 3 lacing values (each packet over two pages): the same samples.
      std::vector<std::vector<uint8_t>> ogg = {std::vector<uint8_t>(head, head + sizeof head), {'O', 'p', 'u', 's', 'T', 'a', 'g', 's', 0, 0, 0, 0, 0, 0, 0, 0}};
      std::vector<int64_t> gran = {0, 0};
      for (size_t k = 0; k < pk.size(); k++) { ogg.push_back(pk[k]); gran.push_back(k + 1 == pk.size() ? lookahead + N : (int64_t)(k + 1) * F); }
      auto oggBytes = oggPages(ogg, gran, 3);
      err.clear(); AudioBufferData* o = decodeAudio(oggBytes.data(), oggBytes.size(), 48000, &err);
      CHECK(o && err.empty(), "ogg opus decode: %s", err.c_str());
      if (o) {
        CHECK(o->channels == 2 && o->length == (uint32_t)N, "ogg opus: %d ch, %u frames (want %d)", o->channels, o->length, N);
        bool same = o->length == b->length;
        for (int c = 0; same && c < 2; c++) same = !memcmp(o->ch(c), b->ch(c), b->length * sizeof(float));
        CHECK(same, "ogg opus decodes to the webm decode's samples");
        o->unref();
      }
      b->unref();
    }
    AudioBufferData* r = decodeAudio(file.b.data(), file.b.size(), 44100, &err);
    CHECK(r && r->length == 44100 && r->sampleRate == 44100, "webm opus resampled to 44.1 kHz: %u frames", r ? r->length : 0);
    if (r) r->unref();
    // A file cut off in its last cluster decodes what came before it; one without an audio track is refused.
    AudioBufferData* cut = decodeAudio(file.b.data(), file.b.size() - 40, 48000, &err);
    CHECK(cut && cut->length < (uint32_t)N && cut->length > (uint32_t)N / 2, "truncated webm: %u frames", cut ? cut->length : 0);
    if (cut) cut->unref();
    Ebml novid; novid.master(0x1A45DFA3, hdr); Ebml t2; t2.master(0xAE, video); novid.id(0x18538067); novid.unknownSize(); novid.master(0x1654AE6B, t2);
    AudioBufferData* none = decodeAudio(novid.b.data(), novid.b.size(), 48000, &err);
    CHECK(!none && err.find("audio track") != std::string::npos, "webm without audio refused: %s", err.c_str());
  }
#else
  printf("(built without libopus; webm opus decode skipped)\n");
#endif
  {
    std::string dir = __FILE__; dir = dir.substr(0, dir.find_last_of('/') + 1);
    std::ifstream f(dir + "data/vorbis-tone.webm", std::ios::binary);
    CHECK(f.good(), "host/tests/data/vorbis-tone.webm not found");
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    err.clear(); AudioBufferData* b = bytes.empty() ? nullptr : decodeAudio(bytes.data(), bytes.size(), 48000, &err);
    CHECK(b && err.empty(), "webm vorbis decode: %s", err.c_str());
    if (b) {
      // ffmpeg decodes the file to 12864 frames (no DiscardPadding: the last packet whole), the tone's 12000 first.
      CHECK(b->channels == 1 && b->length == 12864, "webm vorbis: %d ch, %u frames (ffmpeg: 12864)", b->channels, b->length);
      double r = rms(b->ch(0), 1000, 11000);
      CHECK(std::fabs(r - 0.0625 / std::sqrt(2.0)) < 0.002, "webm vorbis tone rms %.4f (want %.4f)", r, 0.0625 / std::sqrt(2.0));
      int zc = 0; for (uint32_t k = 1; k < 12000; k++) zc += (b->ch(0)[k - 1] < 0) != (b->ch(0)[k] < 0);
      CHECK(std::abs(zc - 220) <= 2, "webm vorbis: %d zero crossings in 0.25 s (440 Hz: 220)", zc);
      b->unref();
    }
  }
  // ffmpeg's Ogg Opus (stereo 440/660 Hz, peak 0.5) and LAME MP3 (440 Hz, peak 0.5) of 12000 frames at 48 kHz: the
  // last granule position and the LAME tag's delay/padding must give that length exactly, as ffmpeg decodes them.
  //   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.25" -f lavfi -i "sine=frequency=660:..."
  //     -filter_complex "[0][1]amerge=inputs=2,volume=4" -c:a libopus -b:a 96k opus-tone.opus
  //   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.25" -af volume=4 -c:a libmp3lame -b:a 64k mp3-tone.mp3
  const struct { const char* file; int channels; } fixtures[] = {{"opus-tone.opus", 2}, {"mp3-tone.mp3", 1}};
  for (const auto& fx : fixtures) {
    std::string dir = __FILE__; dir = dir.substr(0, dir.find_last_of('/') + 1);
    std::ifstream f(dir + "data/" + fx.file, std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    err.clear(); AudioBufferData* b = bytes.empty() ? nullptr : decodeAudio(bytes.data(), bytes.size(), 48000, &err);
    CHECK(b && err.empty(), "%s decode: %s", fx.file, err.c_str());
    if (!b) continue;
    CHECK(b->channels == fx.channels && b->length == 12000 && b->sampleRate == 48000, "%s: %d ch, %u frames (ffmpeg: 12000)", fx.file, b->channels, b->length);
    for (int c = 0; c < b->channels && b->length >= 12000; c++) {
      double r = rms(b->ch(c), 1000, 11000);
      int zc = 0; for (uint32_t k = 1000; k < 11000; k++) zc += (b->ch(c)[k - 1] < 0) != (b->ch(c)[k] < 0);
      int want = (c ? 660 : 440) * 2 * 10000 / 48000;
      CHECK(std::fabs(r - 0.5 / std::sqrt(2.0)) < 0.02 && std::abs(zc - want) <= 2, "%s channel %d: rms %.4f, %d zero crossings (want %d)", fx.file, c, r, zc, want);
    }
    printf("%s: %d ch, %u frames\n", fx.file, b->channels, b->length);
    b->unref();
  }
  // Not MPEG audio: an ADTS AAC header (layer bits 00) is refused, not scanned for MP3 frames.
  const uint8_t adts[16] = {0xFF, 0xF1, 0x50, 0x80, 0x02, 0x1F, 0xFC};
  err.clear(); AudioBufferData* aac = decodeAudio(adts, sizeof adts, 48000, &err);
  CHECK(!aac && err == "unsupported audio container", "adts aac refused: %s", err.c_str());

  const char* list = getenv("AUDIO_TEST_WEBM");
  if (!list) { printf("(AUDIO_TEST_WEBM not set; game webm files skipped)\n"); return; }
  for (std::string rest = list; !rest.empty();) {
    size_t c = rest.find(':'); std::string path = rest.substr(0, c); rest = c == std::string::npos ? "" : rest.substr(c + 1);
    std::ifstream f(path, std::ios::binary); if (!f) { printf("(webm %s not found)\n", path.c_str()); continue; }
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    err.clear(); AudioBufferData* o = decodeAudio(bytes.data(), bytes.size(), 48000, &err);
    CHECK(o && err.empty(), "webm %s: %s", path.c_str(), err.c_str());
    if (o) { printf("webm %s: %d ch, %u frames at 48 kHz, rms %.3f\n", path.c_str(), o->channels, o->length, rms(o->ch(0), 0, o->length)); o->unref(); }
  }
}

// 10. AnalyserNode (WP-25): pulled with nothing downstream, its input passed through, the most recent fftSize
// samples, the spec's frequency data (a Blackman-windowed 1/N DFT: an amplitude-1 sine on a bin centre reads
// 0.5 * 0.42 = 0.21, -13.56 dB), smoothing over time, one computation per render quantum, the byte forms.
static void testAnalyser() {
  const double R = 48000; const uint32_t N = 2048, Q = QUANTUM;
  OfflineContext c(1, 48000, R);
  uint32_t o = c.createNode(Kind::Oscillator); c.setParam(o, 0, 1500); c.start(o, 0, 0, 0);  // 1500 Hz: bin 64 of 2048 at 48 kHz
  uint32_t an = c.createNode(Kind::Analyser);
  AnalyserState* st = AnalyserState::create(N); c.setExt(an, st);
  CHECK(!AnalyserState::create(48) && !AnalyserState::create(16) && !AnalyserState::create(65536) && AnalyserState::create(32)->fftSize() == 32, "fftSize validation");
  c.connect(o, an);  // to nothing: a meter
  for (int i = 0; i < 40; i++) c.renderQuantum();
  std::vector<float> td(N); st->timeDomain(td.data(), N);
  double maxErr = 0; for (uint32_t i = 0; i < N; i++) maxErr = std::max(maxErr, std::fabs(td[i] - std::sin(2 * PI * 1500 * (40 * Q - N + i) / R)));
  CHECK(maxErr < 1e-4, "analyser time domain: max error %g", maxErr);
  CHECK(c.graph().destOut(0)[5] == 0, "analyser connected to nothing: the destination stays silent");
  std::vector<float> fd(N / 2); st->frequency(fd.data(), N / 2, 0.0);
  uint32_t peak = 0; for (uint32_t k = 1; k < N / 2; k++) if (fd[k] > fd[peak]) peak = k;
  CHECK(peak == 64 && std::fabs(fd[64] - db(0.21)) < 0.05, "analyser peak bin %u at %.2f dB (want 64 at %.2f)", peak, fd[peak], db(0.21));
  CHECK(fd[300] < -100, "analyser far from the tone: %.1f dB", fd[300]);
  std::vector<uint8_t> fb(N / 2); st->frequencyBytes(fb.data(), N / 2, 0.0, -100, -30);
  CHECK(fb[64] == 255 && fb[300] == 0, "analyser bytes: peak %d, far %d", fb[64], fb[300]);
  st->frequencyBytes(fb.data(), N / 2, 0.0, -20, -10);
  CHECK(fb[64] == (uint8_t)std::floor(255.0 / 10 * (fd[64] + 20)), "analyser bytes scaled between min and max: %d", fb[64]);
  std::vector<uint8_t> tb(N); st->timeDomainBytes(tb.data(), N);
  CHECK(tb[0] == (uint8_t)std::min(255.0, std::floor(128.0 * (1.0 + (double)td[0]))), "analyser time-domain bytes %d", tb[0]);
  // Smoothing over time, per the spec: 0.5 * previous + 0.5 * now. A fresh state starts from 0.
  AnalyserState* sm = AnalyserState::create(N); uint32_t an2 = c.createNode(Kind::Analyser); c.setExt(an2, sm); c.connect(o, an2);
  for (int i = 0; i < 20; i++) c.renderQuantum();
  sm->frequency(fd.data(), N / 2, 0.5); const float first = fd[64];
  sm->frequency(fd.data(), N / 2, 0.5);
  CHECK(fd[64] == first, "no new render quantum: the same frequency data (%.3f %.3f)", first, fd[64]);
  c.renderQuantum(); sm->frequency(fd.data(), N / 2, 0.5);
  CHECK(std::fabs(first - db(0.105)) < 0.05 && std::fabs(fd[64] - db(0.1575)) < 0.05, "smoothing: %.2f then %.2f dB (want %.2f, %.2f)", first, fd[64], db(0.105), db(0.1575));
  // Its input disconnected, it records silence.
  c.disconnect(o, an); for (int i = 0; i < 20; i++) c.renderQuantum(); st->timeDomain(td.data(), N);
  CHECK(td[N - 1] == 0 && td[0] == 0, "analyser without input records silence");
  // Passes its input through.
  uint32_t an3 = c.createNode(Kind::Analyser); c.connect(o, an3); c.connect(an3, 0); c.renderQuantum();
  CHECK(std::fabs(c.graph().destOut(0)[10] - std::sin(2 * PI * 1500 * (81 * Q + 10) / R)) < 1e-4, "analyser passes its input through: %f", c.graph().destOut(0)[10]);
  st->unref(); sm->unref();
}

// 11. Capture (WP-25): the ring between a microphone callback and the render threads, and the
// MediaStreamAudioSourceNode over it. A 441 Hz tone captured at 44.1 kHz in 10 ms bursts plays at 48 kHz as 441 Hz;
// silence before the ring is primed, on an underrun, while the track is disabled; the oldest samples dropped when
// a reader falls far behind; two readers see the same samples; the node goes once released and its track ended.
struct TestTrack : LiveInput {
  CaptureRing* ring; bool on = true, alive = true;
  bool read(LiveCursor& c, float* out, int n, double rate) override { if (!on || !alive) { c.primed = c.waiting = false; return false; } return ring->read(c, out, n, rate); }
  bool live() const override { return alive; }
};
static void testCapture() {
  const double R = 48000, CR = 44100;
  CaptureRing ring; ring.setRate(CR);
  TestTrack* tr = new TestTrack(); tr->ring = &ring;
  OfflineContext c(1, 1, R);
  uint32_t src = c.createNode(Kind::MediaStream); c.setExt(src, tr); c.connect(src, 0);
  uint32_t gx = c.createNode(Kind::Gain);
  CHECK(!c.graph().connect(gx, src) && !c.graph().connect(src, src), "nothing connects into a media stream source");
  uint64_t produced = 0; float burst[441];
  auto capture = [&](double untilS) {  // the microphone: 441 samples every 10 ms of the context's time
    while ((double)produced / CR < untilS) { for (int i = 0; i < 441; i++) burst[i] = 0.5f * (float)std::sin(2 * PI * 441 * (double)(produced + i) / CR); ring.write(burst, 441); produced += 441; }
  };
  std::vector<float> out;
  auto render = [&](int quanta, bool feed) {
    for (int q = 0; q < quanta; q++) { if (feed) capture(c.currentTime() + 0.01); c.renderQuantum(); const float* d = c.graph().destOut(0); out.insert(out.end(), d, d + QUANTUM); }
  };
  render(1, false);
  CHECK(rms(out.data(), 0, QUANTUM) == 0, "nothing captured yet: silence");
  out.clear(); render(400, true);  // ~1.07 s
  uint32_t first = 0; while (first < out.size() && out[first] == 0) first++;
  CHECK(first < 48000 * 0.05, "primed within 50 ms (first sample at %u)", first);
  int zc = 0; const uint32_t a = first + 2000, b = (uint32_t)out.size();
  for (uint32_t i = a + 1; i < b; i++) zc += (out[i - 1] < 0) != (out[i] < 0);
  const double want = 2 * 441.0 * (b - a) / R;
  CHECK(std::fabs(zc - want) <= 2, "resampled 44.1 -> 48 kHz: %d zero crossings (want %.1f)", zc, want);
  CHECK(std::fabs(rms(out.data(), a, b) - 0.5 / std::sqrt(2.0)) < 0.01, "resampled level %.4f", rms(out.data(), a, b));
  double step = 0; for (uint32_t i = a + 1; i < b; i++) step = std::max(step, (double)std::fabs(out[i] - out[i - 1]));
  CHECK(step < 0.5 * 2 * PI * 441 / R * 1.1, "no discontinuity (largest step %.4f)", step);
  CHECK(ring.underruns() == 0 && ring.overruns() == 0, "steady capture: %u underruns, %u overruns", ring.underruns(), ring.overruns());
  // The capture stalls: what is buffered plays out, then silence (an underrun), then it primes again.
  out.clear(); render(30, false);
  CHECK(out.back() == 0 && ring.underruns() == 1, "stalled capture: silence, %u underrun(s)", ring.underruns());
  out.clear(); render(40, true);
  CHECK(rms(out.data(), (uint32_t)out.size() - 1000, (uint32_t)out.size()) > 0.3, "capture back: sound again");
  // Disabled: silence at once; enabled: sound again.
  tr->on = false; out.clear(); render(2, true); CHECK(rms(out.data(), 0, (uint32_t)out.size()) == 0, "disabled track: silence");
  tr->on = true; out.clear(); render(20, true); CHECK(rms(out.data(), (uint32_t)out.size() - 500, (uint32_t)out.size()) > 0.3, "enabled again: sound");
  // A reader that falls behind (its context suspended) drops the oldest samples instead of lagging.
  capture(c.currentTime() + 0.5); out.clear(); render(1, false);
  CHECK(ring.overruns() == 1, "fell 0.5 s behind: the oldest dropped (%u overruns)", ring.overruns());
  // Two readers of one ring, primed at the same moment, read the same samples.
  LiveCursor c1, c2; float x1[QUANTUM], x2[QUANTUM];
  bool r1 = ring.read(c1, x1, QUANTUM, R), r2 = ring.read(c2, x2, QUANTUM, R);
  CHECK(r1 && r2 && memcmp(x1, x2, sizeof x1) == 0, "two readers: the same samples");
  // Same rate: samples copied exactly.
  CaptureRing same; same.setRate(R); float in[480]; for (int k = 0; k < 20; k++) { for (int i = 0; i < 480; i++) in[i] = (float)(k * 480 + i); same.write(in, 480); }
  LiveCursor c3; float y[QUANTUM]; CHECK(same.read(c3, y, QUANTUM, R) && y[1] == y[0] + 1 && y[127] == y[0] + 127, "same rate: exact copy (%f %f)", y[0], y[127]);
  // Lifetime: released while live stays (the graph holds the track); ended -> freed, the track's reference back.
  c.releaseNode(src); c.renderQuantum(); int ended = 0, freed = 0; countMsgs(c, &ended, &freed);
  CHECK(freed == 0 && tr->refs.load() == 2, "released, track live: kept (freed %d, refs %d)", freed, tr->refs.load());
  tr->alive = false; c.renderQuantum(); countMsgs(c, &ended, &freed);
  CHECK(freed == 1 && tr->refs.load() == 1, "track ended: node freed, reference returned (freed %d, refs %d)", freed, tr->refs.load());
  // A wrong-kind state is refused (released back), never cast.
  uint32_t g1 = c.createNode(Kind::Gain); tr->ref(); c.graph().setExt(g1, tr); countMsgs(c, &ended, &freed);
  CHECK(tr->refs.load() == 1, "setExt on a gain node refused (refs %d)", tr->refs.load());
  tr->unref();
}

// A network voice's jitter margin (JitterTarget) and its adaptive ring, against arrival patterns of a Wi-Fi link.
struct VoiceSim { uint32_t underruns = 0, jumps = 0; double lagMax = 0, lagEnd = 0; };
// 20 ms Opus-sized packets of a speech-like signal (300 ms of 440 Hz, 200 ms silent; phase-continuous, so any
// skipped or missing sample mid-tone shows as a jump), delivered in order 5-15 ms late, and every `every` packets a
// stall of stall(i) seconds for the i-th (what follows queues behind it). The reader renders 128-sample quanta.
template <class Stall>
static VoiceSim simulateVoice(bool adaptive, Stall stall, int every, double seconds, double measureFrom) {
  const double R = 48000; const int N = 128, F = 960;
  CaptureRing ring(0.06, 0.25, adaptive); ring.setRate(R);
  JitterTarget jitter;
  auto signal = [&](uint64_t i) { return (i % 24000) < 14400 ? 0.3f * (float)std::sin(2 * PI * 440 * (double)i / R) : 0.0f; };
  uint32_t lcg = 12345; auto noise = [&] { lcg = lcg * 1664525u + 1013904223u; return (double)(lcg >> 8) / (1 << 24); };
  std::vector<double> arrival; double prev = 0;
  for (int k = 0; (k + 1) * 0.02 < seconds + 1; k++) {
    const double a = (k + 1) * 0.02 + 0.005 + 0.01 * noise() + (k % every == every - 1 ? stall(k / every, (k + 1) * 0.02) : 0);
    prev = std::max(prev, a); arrival.push_back(prev);
  }
  VoiceSim r; LiveCursor c; float out[N], pkt[F]; size_t next = 0; float last = 0; bool lastValid = false;
  for (double t = 0; t < seconds; t += N / R) {
    while (next < arrival.size() && arrival[next] <= t) {
      for (int i = 0; i < F; i++) pkt[i] = signal(next * F + i);
      ring.write(pkt, F);
      const double target = jitter.arrived(arrival[next], (uint32_t)(next * F), R, ring.underruns());
      if (adaptive) ring.setTargetLag(target);
      next++;
    }
    const uint32_t u0 = ring.underruns();
    const bool got = ring.read(c, out, N, R);
    if (t < measureFrom) { lastValid = false; continue; }
    if (ring.underruns() != u0) r.underruns++;
    r.lagEnd = (double)(ring.written() - c.pos) / R;
    r.lagMax = std::max(r.lagMax, r.lagEnd);
    for (int i = 0; i < N; i++) {
      const float x = got ? out[i] : 0.0f;
      if (lastValid && std::fabs(x - last) > 0.3f * 2 * PI * 440 / R * 1.2) r.jumps++;
      last = x; lastValid = true;
    }
  }
  return r;
}

static void testJitter() {
  const double R = 48000;
  { // Steady arrivals: the margin stays at the fixed one it replaces (60 ms).
    JitterTarget j; double t = 1;
    for (int k = 0; k < 500; k++) j.arrived(t + k * 0.02 + 0.002 * (k % 3), (uint32_t)(k * 960), R, 0);
    CHECK(std::fabs(j.target() - 0.06) < 0.001, "steady arrivals: margin %.1f ms", j.target() * 1000);
  }
  { // A 100 ms stall every 2 s: the margin covers it (stall + 20 ms), and decays once the stalls stop.
    JitterTarget j; double t = 1, behind = 0; uint32_t ts = 0;
    for (int k = 0; k < 500; k++, ts += 960) { double a = t + k * 0.02 + (k % 100 == 99 ? 0.1 : 0); behind = std::max(behind, a); j.arrived(behind, ts, R, 0); }
    CHECK(j.target() > 0.11 && j.target() < 0.13, "100 ms stalls: margin %.1f ms", j.target() * 1000);
    for (int k = 500; k < 2500; k++, ts += 960) j.arrived(t + k * 0.02, ts, R, 0);
    CHECK(j.target() < 0.07, "40 s steady after: margin back to %.1f ms", j.target() * 1000);
    // A sender's 3 s silence (timestamps jump with it): no jitter seen.
    const double resume = t + 2500 * 0.02 + 3;
    j.arrived(resume, ts + 3 * 48000, R, 0); j.arrived(resume + 0.02, ts + 3 * 48000 + 960, R, 0);
    CHECK(j.target() < 0.07, "a paused sender: margin %.1f ms", j.target() * 1000);
    // An underrun the readers saw raises it by 20 ms at once.
    const double was = j.target(); j.arrived(resume + 0.04, ts + 3 * 48000 + 1920, R, 1);
    CHECK(j.target() >= was + 0.019, "an underrun: margin %.1f -> %.1f ms", was * 1000, j.target() * 1000);
    for (int k = 0; k < 50; k++) j.arrived(resume + 0.06 + k * 0.02 + (k == 25 ? 0.5 : 0), ts + 3 * 48000 + (uint32_t)(3 + k) * 960, R, 1);
    CHECK(j.target() <= 0.24 + 1e-9, "capped: %.1f ms", j.target() * 1000);
  }
  // A steady link: the adaptive ring plays like the fixed one (nothing held back or skipped mid-tone).
  const auto none = [](int, double) { return 0.0; };
  VoiceSim steady = simulateVoice(true, none, 1000000, 20, 2);
  CHECK(steady.underruns == 0 && steady.jumps == 0, "steady link: %u underruns, %u jumps", steady.underruns, steady.jumps);
  // A link getting worse (a stall each second, 15 ms longer each time, from 60 ms): the fixed margin drops out at
  // every new longest stall (it only grows by re-priming after one); the adaptive margin is the last stall + 20 ms.
  const auto worse = [](int i, double) { return std::min(0.06 + 0.015 * i, 0.2); };
  VoiceSim fixedW = simulateVoice(false, worse, 50, 14, 1), adaptW = simulateVoice(true, worse, 50, 14, 1);
  printf("worsening stalls: fixed margin %u underruns, %u jumps; adaptive %u underruns, %u jumps, lag up to %.0f ms\n",
         fixedW.underruns, fixedW.jumps, adaptW.underruns, adaptW.jumps, adaptW.lagMax * 1000);
  CHECK(fixedW.underruns >= 4, "fixed margin, worsening stalls: %u underruns", fixedW.underruns);
  CHECK(adaptW.underruns <= 1 && adaptW.jumps <= fixedW.jumps / 4, "adaptive margin, worsening stalls: %u underruns, %u jumps", adaptW.underruns, adaptW.jumps);
  // A 100 ms stall every 500 ms (a weak Wi-Fi link): once learnt, the adaptive margin plays through, lag bounded.
  const auto stall100 = [](int, double) { return 0.1; };
  VoiceSim adapt = simulateVoice(true, stall100, 25, 40, 10);
  CHECK(adapt.underruns == 0 && adapt.jumps == 0 && adapt.lagMax < 0.3, "adaptive, 100 ms stalls: %u underruns, %u jumps, lag up to %.0f ms", adapt.underruns, adapt.jumps, adapt.lagMax * 1000);
  // 150 ms stalls stop at 20 s: the adaptive lag comes back down in the silent stretches (to its margin, within
  // kSlack), without a jump; the fixed margin keeps the lag its last stall left it.
  const auto until20 = [](int, double at) { return at < 20 ? 0.15 : 0.0; };
  VoiceSim fixedC = simulateVoice(false, until20, 25, 80, 10), calm = simulateVoice(true, until20, 25, 80, 10);
  printf("stalls stop at 20 s: lag at 80 s fixed %.0f ms, adaptive %.0f ms (%u underruns, %u jumps)\n", fixedC.lagEnd * 1000, calm.lagEnd * 1000, calm.underruns, calm.jumps);
  CHECK(calm.underruns == 0 && calm.jumps == 0 && calm.lagEnd < 0.11 && calm.lagEnd + 0.05 < fixedC.lagEnd,
        "after the stalls: adaptive lag %.0f ms (fixed %.0f), %u underruns, %u jumps", calm.lagEnd * 1000, fixedC.lagEnd * 1000, calm.underruns, calm.jumps);
}

#ifdef HOST_HAS_OPUS
// OpusVoiceIn: a lost packet comes back from the next one's in-band FEC; longer gaps are concealed; late ones dropped.
struct PcmSink { std::vector<float> pcm; void write(const float* x, uint32_t n) { pcm.insert(pcm.end(), x, x + n); } };
static void testVoiceIn() {
  int e = 0; OpusEncoder* enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &e);
  opus_encoder_ctl(enc, OPUS_SET_BITRATE(32000)); opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(1)); opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(20));
  opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
  // A voice-like signal: a 180 Hz fundamental with harmonics, its pitch and level moving.
  std::vector<std::vector<unsigned char>> packets; float frame[960]; unsigned char buf[1500];
  for (int k = 0; k < 100; k++) {
    for (int i = 0; i < 960; i++) {
      const double t = (k * 960 + i) / 48000.0, f = 180 + 40 * std::sin(2 * PI * 0.7 * t);
      double x = 0; for (int h = 1; h <= 6; h++) x += std::sin(2 * PI * f * h * t + h) / h;
      frame[i] = (float)(0.15 * x * (0.6 + 0.4 * std::sin(2 * PI * 1.3 * t)));
    }
    const int len = opus_encode_float(enc, frame, 960, buf, sizeof buf);
    packets.emplace_back(buf, buf + std::max(len, 0));
  }
  opus_encoder_destroy(enc);
  auto run = [&](auto drop, bool fec) {
    OpusDecoder* dec = opus_decoder_create(48000, 1, &e); PcmSink sink; OpusVoiceIn in(dec);
    float pcm[960];
    for (int k = 0; k < (int)packets.size(); k++) {
      if (drop(k)) continue;
      if (fec) in.packet((uint16_t)(60000 + k), packets[k].data(), (int)packets[k].size(), sink);  // wraps past 65535
      else {  // the old way: every missing frame concealed
        while ((int)sink.pcm.size() < k * 960) { opus_decode_float(dec, nullptr, 0, pcm, 960, 0); sink.write(pcm, 960); }
        const int n = opus_decode_float(dec, packets[k].data(), (int)packets[k].size(), pcm, 960, 0); sink.write(pcm, n);
      }
    }
    opus_decoder_destroy(dec);
    return std::make_pair(sink.pcm, std::array<uint32_t, 3>{in.recovered, in.concealed, in.late});
  };
  const auto all = run([](int) { return false; }, true).first;
  CHECK(all.size() == 100 * 960, "every packet decoded: %zu samples", all.size());
  const auto every7 = [](int k) { return k % 7 == 3; };
  const auto [withFec, counts] = run(every7, true);
  const auto plcOnly = run(every7, false).first;
  CHECK(withFec.size() == all.size() && plcOnly.size() == all.size(), "losses filled to length: %zu, %zu", withFec.size(), plcOnly.size());
  CHECK(counts[0] == 14 && counts[1] == 0 && counts[2] == 0, "single losses recovered: %u recovered, %u concealed, %u late", counts[0], counts[1], counts[2]);
  double errFec = 0, errPlc = 0, ref = 0;
  for (int k = 3; k < 100; k += 7) for (int i = k * 960; i < (k + 1) * 960; i++) {
    errFec += (withFec[i] - all[i]) * (withFec[i] - all[i]); errPlc += (plcOnly[i] - all[i]) * (plcOnly[i] - all[i]); ref += all[i] * all[i];
  }
  printf("lost frames: FEC error %.1f dB, concealment error %.1f dB (below the signal)\n", db(std::sqrt(errFec / ref)), db(std::sqrt(errPlc / ref)));
  CHECK(errFec < errPlc * 0.5, "FEC closer than concealment: %.4f vs %.4f", errFec / ref, errPlc / ref);
  // A gap of three: the last from FEC, two concealed. A late packet: dropped.
  const auto [gap3, c3] = run([](int k) { return k >= 10 && k < 13; }, true);
  CHECK(c3[0] == 1 && c3[1] == 2 && gap3.size() == all.size(), "a gap of three: %u recovered, %u concealed", c3[0], c3[1]);
  OpusDecoder* dec = opus_decoder_create(48000, 1, &e); PcmSink sink; OpusVoiceIn in(dec);
  in.packet(5, packets[0].data(), (int)packets[0].size(), sink); in.packet(6, packets[1].data(), (int)packets[1].size(), sink);
  CHECK(!in.packet(5, packets[0].data(), (int)packets[0].size(), sink) && in.late == 1 && sink.pcm.size() == 2 * 960, "a late packet dropped");
  opus_decoder_destroy(dec);
  // By RTP timestamp (packetAt, what the rtc binding has): the same recovery, a late frame dropped, and a sender's
  // silent stretch (a gap of a second or more) not filled.
  {
    OpusDecoder* d2 = opus_decoder_create(48000, 1, &e); PcmSink s2; OpusVoiceIn in2(d2);
    const uint32_t t0 = 0xFFFFF000u;  // wraps past 2^32
    for (int k = 0; k < 100; k++) if (!every7(k)) in2.packetAt(t0 + (uint32_t)k * 960, packets[k].data(), (int)packets[k].size(), s2);
    CHECK(s2.pcm.size() == all.size() && in2.recovered == 14 && in2.concealed == 0, "by timestamp: %zu samples, %u recovered, %u concealed", s2.pcm.size(), in2.recovered, in2.concealed);
    CHECK(!in2.packetAt(t0 + 50 * 960, packets[50].data(), (int)packets[50].size(), s2) && in2.late == 1, "by timestamp: a late frame dropped");
    const size_t before = s2.pcm.size(); const uint32_t was = in2.recovered + in2.concealed;
    in2.packetAt(t0 + 100 * 960 + 3 * 48000, packets[0].data(), (int)packets[0].size(), s2);
    CHECK(s2.pcm.size() == before + 960 && in2.recovered + in2.concealed == was, "by timestamp: a silent stretch is not filled");
    opus_decoder_destroy(d2);
  }
}
#endif

int main() {
  testLowpass(); testAutomation(); testBufferSource(); testPanner(); testCompressor(); testOscillator(); testLifetime(); testDecode(); testWebm(); testAnalyser(); testCapture(); testJitter();
#ifdef HOST_HAS_OPUS
  testVoiceIn();
#endif
  if (failures) { fprintf(stderr, "audio_test: %d failure(s)\n", failures); return 1; }
  puts("audio_test ok"); return 0;
}
