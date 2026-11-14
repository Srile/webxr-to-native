#pragma once
// The host thread's run loop: cross-thread task posting, timers, a monotonic
// clock. The browser's "main thread" scheduler without the DOM. One instance,
// owned by Host; everything JS-visible runs through it.
#include <cstdint>
#include <functional>
#include <mutex>
#include <vector>

namespace host {

using Task = std::function<void()>;

class Loop {
 public:
  Loop();
  // Monotonic milliseconds since loop creation, with sub-ms fraction (performance.now source).
  double now() const;
  // Thread-safe. Runs on the loop thread during the next drain.
  void post(Task t);
  // Loop-thread only.
  uint32_t setTimer(double delayMs, bool repeat, Task t);
  void clearTimer(uint32_t id);
  // Runs every due task and timer once. Returns ms until the next timer (or -1 if none).
  double runOnce();
  // ms until the nearest timer fires, -1 if none.
  double nextDeadline() const;
  bool hasPendingTasks();
  size_t timerCount() const { return timers_.size(); }
  // Loop-thread only. Drops every posted task and timer unrun. A host shutting down calls it before the JS engine
  // goes: a page's pending callbacks hold handles into the engine, and releasing them after it is gone crashes.
  void clear();

 private:
  struct Timer { uint32_t id; double due; double period; bool repeat; Task fn; bool dead; };
  double start_;
  std::mutex mu_;
  std::vector<Task> posted_;
  std::vector<Timer> timers_;
  uint32_t nextId_ = 1;
};

}  // namespace host
