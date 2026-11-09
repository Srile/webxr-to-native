#pragma once
// GC placement for the main isolate: garbage collection belongs right after the
// frame submit (xrEndFrame), never inside the frame or just before the
// compositor commit.
//
//  - Young generation sized above the worst per-frame allocation
//    (ResourceConstraints on the main isolate only; workers keep V8's default).
//  - afterSubmit(): a forced scavenge when new space is fuller than
//    `minorFraction`, so the next frame starts with room to spare and never
//    hits the allocation-failure scavenge mid-frame. The only V8 10.0 API that
//    runs a scavenge on demand is RequestGarbageCollectionForTesting(kMinor),
//    which CHECKs --expose-gc; the flag is set as --expose-gc-as=<private name>
//    and the global is deleted again (Engine::create).
//  - idleUntil(deadline): the slack until the next xrWaitFrame wake goes to
//    Isolate::IdleNotificationDeadline (incremental marking steps and the
//    mark-compact finalisation) and v8::platform::RunIdleTasks (the platform
//    is created with IdleTaskSupport::kEnabled).
//  - GC prologue/epilogue callbacks count pauses per type and per phase
//    (pre-submit = between xrWaitFrame's return and xrEndFrame's return); no
//    allocation in them.
#include <cstdint>
#include <string>
#include <v8.h>

namespace host {

struct Json;

struct GcConfig {
  bool enabled = true;         // host.json gc.enabled: false = V8 defaults, counters only
  int semiSpaceMB = 16;        // gc.semiSpaceMB: young generation = 3 × this (two semi-spaces + new large-object space)
  double minorFraction = 0.25; // gc.minorAfterSubmit: scavenge after submit when new space is fuller than this (0 = every frame, <0 off)
  bool idle = true;            // gc.idle: hand the post-submit slack to V8
  double idleMarginMs = 2.0;   // gc.idleMarginMs: stop this long before the predicted xrWaitFrame wake
  std::string flags;           // gc.flags: extra V8 flags, appended last (they win)
  static GcConfig fromJson(const Json& gc);
};

class GcScheduler {
 public:
  static constexpr char kGcGlobal[] = "__wxhGc";
  // V8 flags for V8::SetFlagsFromString (before V8::Initialize).
  static std::string v8Flags(const GcConfig& c);
  // Young generation constraints for the main isolate's CreateParams.
  static void constrain(const GcConfig& c, v8::ResourceConstraints& rc);

  void attach(v8::Isolate* iso, const GcConfig& c);
  void detach();
  // The pre-submit window: open from xrWaitFrame's return to xrEndFrame's return.
  void setInFrame(bool on) { inFrame_ = on; }
  void afterSubmit();
  // steadyDeadlineMs on std::chrono::steady_clock (ms); returns ms handed to V8.
  double idleUntil(double steadyDeadlineMs);
  // "gc pre 0 post 3 (sc 3 mc 0 im 0) max pre 0.00 post 0.81 ms forced 2 idle 4.1 ms" since the last call; resets.
  std::string statsLine();
  int preSubmitPauses() const;  // since the last statsLine()
  long totalPre() const { return totalPre_; }   // since attach (bridge stats)
  long totalPost() const { return totalPost_; }

  static double steadyMs();

 private:
  enum Kind { kScavenge = 0, kMarkCompact, kIncremental, kWeak, kKinds };
  static int kindOf(v8::GCType t);
  static void prologue(v8::Isolate* iso, v8::GCType type, v8::GCCallbackFlags flags, void* data);
  static void epilogue(v8::Isolate* iso, v8::GCType type, v8::GCCallbackFlags flags, void* data);

  v8::Isolate* iso_ = nullptr;
  GcConfig cfg_;
  bool canForce_ = false;
  int newSpaceIndex_ = -1;
  bool inFrame_ = false;
  // nesting stack of open pauses (mark-compact runs weak callbacks inside its own pause)
  static constexpr int kDepth = 8;
  double startMs_[kDepth] = {}; uint8_t startPhase_[kDepth] = {}; int depth_ = 0;
  // [phase 0 post / 1 pre][kind]
  int count_[2][kKinds] = {}; double maxMs_[2] = {0, 0}; double totalMs_[2] = {0, 0};
  int forced_ = 0; double idleMs_ = 0;
  long totalPre_ = 0, totalPost_ = 0;
};

}  // namespace host
