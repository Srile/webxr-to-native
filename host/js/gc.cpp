#include "js/gc.h"
#include "js/engine.h"
#include "js/v8compat.h"
#include "core/json.h"
#include "core/log.h"
#include <libplatform/libplatform.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>

namespace host {

GcConfig GcConfig::fromJson(const Json& gc) {
  GcConfig c;
  c.enabled = gc.bo("enabled", c.enabled);
  c.semiSpaceMB = std::max(1, std::min(64, (int)gc.n("semiSpaceMB", c.semiSpaceMB)));
  c.minorFraction = gc.n("minorAfterSubmit", c.minorFraction);
  c.idle = gc.bo("idle", c.idle);
  c.idleMarginMs = std::max(0.0, gc.n("idleMarginMs", c.idleMarginMs));
  c.flags = gc.s("flags", "");
  return c;
}

std::string GcScheduler::v8Flags(const GcConfig& c) {
  std::string f;
  // RequestGarbageCollectionForTesting CHECKs FLAG_expose_gc; the private name keeps `gc` off the page's global.
  if (c.enabled && c.minorFraction >= 0) { f += "--expose-gc --expose-gc-as="; f += kGcGlobal; }
  if (!c.flags.empty()) { if (!f.empty()) f += ' '; f += c.flags; }
  return f;
}

void GcScheduler::constrain(const GcConfig& c, v8::ResourceConstraints& rc) {
  if (!c.enabled) return;
  // Fixed size (initial = max): no growth heuristics, the whole young generation is there from the first frame.
  // Process-wide --min/max-semi-space-size would commit the same for every worker isolate; constraints are per isolate.
  const size_t young = (size_t)c.semiSpaceMB * 3 * 1024 * 1024;
  rc.set_max_young_generation_size_in_bytes(young);
  rc.set_initial_young_generation_size_in_bytes(young);
}

double GcScheduler::steadyMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void GcScheduler::attach(v8::Isolate* iso, const GcConfig& c) {
  iso_ = iso; cfg_ = c;
  canForce_ = c.enabled && c.minorFraction >= 0;
  const size_t n = iso->NumberOfHeapSpaces();
  for (size_t i = 0; i < n; ++i) { v8::HeapSpaceStatistics s; if (iso->GetHeapSpaceStatistics(&s, i) && s.space_name() && !strcmp(s.space_name(), "new_space")) { newSpaceIndex_ = (int)i; break; } }
  iso->AddGCPrologueCallback(&GcScheduler::prologue, this, v8::kGCTypeAll);
  iso->AddGCEpilogueCallback(&GcScheduler::epilogue, this, v8::kGCTypeAll);
  v8::HeapSpaceStatistics s; size_t cap = 0; if (newSpaceIndex_ >= 0 && iso->GetHeapSpaceStatistics(&s, newSpaceIndex_)) cap = s.space_used_size() + s.space_available_size();
  HOST_LOGI("gc: %s, semi-space %d MB (new space %.1f MB), scavenge after submit %s%.2f, idle %s (margin %.1f ms)%s%s",
            c.enabled ? "post-submit" : "V8 defaults", c.semiSpaceMB, cap / 1048576.0, canForce_ ? "above " : "off ", canForce_ ? c.minorFraction : 0.0,
            c.idle ? "on" : "off", c.idleMarginMs, c.flags.empty() ? "" : ", flags ", c.flags.c_str());
}

void GcScheduler::detach() {
  if (!iso_) return;
  iso_->RemoveGCPrologueCallback(&GcScheduler::prologue, this);
  iso_->RemoveGCEpilogueCallback(&GcScheduler::epilogue, this);
  iso_ = nullptr;
}

void GcScheduler::afterSubmit() {
  if (!iso_ || !canForce_ || newSpaceIndex_ < 0) return;
  v8::HeapSpaceStatistics s;
  if (!iso_->GetHeapSpaceStatistics(&s, newSpaceIndex_)) return;
  const double cap = (double)(s.space_used_size() + s.space_available_size());
  if (cap <= 0 || s.space_used_size() == 0 || s.space_used_size() < cfg_.minorFraction * cap) return;
  forced_++;
  iso_->RequestGarbageCollectionForTesting(v8::Isolate::kMinorGarbageCollection);
}

double GcScheduler::idleUntil(double steadyDeadlineMs) {
  if (!iso_ || !cfg_.enabled || !cfg_.idle) return 0;
  const double t0 = steadyMs();
  const double slack = steadyDeadlineMs - cfg_.idleMarginMs - t0;
  if (slack < 0.5) return 0;
  v8::Platform* p = Engine::platform();
  // V8's deadline is on the platform's clock (seconds), not steady_clock: convert through the remaining time.
#if V8_MAJOR_VERSION < 12  // gone later: the platform's idle tasks are the whole of it
  iso_->IdleNotificationDeadline(p->MonotonicallyIncreasingTime() + slack / 1000.0);
#endif
  const double left = steadyDeadlineMs - cfg_.idleMarginMs - steadyMs();
  if (left > 0.5) v8::platform::RunIdleTasks(p, iso_, left / 1000.0);
  const double used = steadyMs() - t0; idleMs_ += used; return used;
}

int GcScheduler::kindOf(v8::GCType t) {
  if (t & (v8::kGCTypeScavenge | kGCTypeMinor)) return kScavenge;
  if (t & v8::kGCTypeMarkSweepCompact) return kMarkCompact;
  if (t & v8::kGCTypeIncrementalMarking) return kIncremental;
  return kWeak;
}

void GcScheduler::prologue(v8::Isolate*, v8::GCType type, v8::GCCallbackFlags, void* data) {
  auto* g = static_cast<GcScheduler*>(data);
  const int d = g->depth_++;
  if (d >= kDepth) return;
  g->startMs_[d] = steadyMs(); g->startPhase_[d] = g->inFrame_ ? 1 : 0;
  g->count_[g->startPhase_[d]][kindOf(type)]++;
  if (d == 0) { if (g->inFrame_) g->totalPre_++; else g->totalPost_++; }
}

void GcScheduler::epilogue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
  auto* g = static_cast<GcScheduler*>(data);
  if (g->depth_ == 0) return;
  const int d = --g->depth_;
  if (d >= kDepth) return;
  const double ms = steadyMs() - g->startMs_[d]; const int ph = g->startPhase_[d];
  if (d == 0) g->totalMs_[ph] += ms;  // outermost pause only: nested weak-callback phases are inside it
  if (ms > g->maxMs_[ph]) g->maxMs_[ph] = ms;
}

int GcScheduler::preSubmitPauses() const { int n = 0; for (int k = 0; k < kKinds; ++k) n += count_[1][k]; return n; }

std::string GcScheduler::statsLine() {
  int post = 0; for (int k = 0; k < kKinds; ++k) post += count_[0][k];
  const int pre = preSubmitPauses();
  char b[256];
  snprintf(b, sizeof b, "gc pre %d (sc %d mc %d im %d wk %d, max %.2f ms) post %d (sc %d mc %d im %d wk %d, max %.2f ms, %.1f ms) forced %d idle %.1f ms",
           pre, count_[1][kScavenge], count_[1][kMarkCompact], count_[1][kIncremental], count_[1][kWeak], maxMs_[1],
           post, count_[0][kScavenge], count_[0][kMarkCompact], count_[0][kIncremental], count_[0][kWeak], maxMs_[0], totalMs_[0], forced_, idleMs_);
  for (auto& row : count_) for (int& v : row) v = 0;
  maxMs_[0] = maxMs_[1] = 0; totalMs_[0] = totalMs_[1] = 0; forced_ = 0; idleMs_ = 0;
  return b;
}

}  // namespace host
