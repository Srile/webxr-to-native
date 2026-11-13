#include "core/loop.h"
#include <algorithm>
#include <chrono>

namespace host {

static double monoMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

Loop::Loop() : start_(monoMs()) {}
double Loop::now() const { return monoMs() - start_; }

void Loop::post(Task t) { std::lock_guard<std::mutex> g(mu_); posted_.push_back(std::move(t)); }

bool Loop::hasPendingTasks() { std::lock_guard<std::mutex> g(mu_); return !posted_.empty(); }

uint32_t Loop::setTimer(double delayMs, bool repeat, Task t) {
  if (delayMs < 0) delayMs = 0;
  uint32_t id = nextId_++;
  timers_.push_back({id, now() + delayMs, delayMs, repeat, std::move(t), false});
  return id;
}

void Loop::clear() {
  std::vector<Task> posted;
  { std::lock_guard<std::mutex> lock(mu_); posted.swap(posted_); }
  std::vector<Timer> timers; timers.swap(timers_);
}  // both go here, outside the lock: a task's destructor may post

void Loop::clearTimer(uint32_t id) {
  for (auto& t : timers_) if (t.id == id) t.dead = true;
}

double Loop::nextDeadline() const {
  double best = -1;
  const double n = now();
  for (auto& t : timers_) if (!t.dead) { double d = std::max(0.0, t.due - n); if (best < 0 || d < best) best = d; }
  return best;
}

double Loop::runOnce() {
  // Run this pass's tasks off a LOCAL vector: a task that pumps the loop again (the bridge awaiting a
  // promise) re-enters runOnce, and iterating a member that the nested call swaps re-ran the same task
  // recursively (459 workers spawned by one eval, then a stack overflow).
  std::vector<Task> run; { std::lock_guard<std::mutex> g(mu_); run.swap(posted_); }
  for (auto& t : run) t();
  // Timers: snapshot the due ones so a callback that adds timers does not run them this pass.
  const double n = now();
  std::vector<uint32_t> due;
  for (auto& t : timers_) if (!t.dead && t.due <= n) due.push_back(t.id);
  // Fire in due order (browser semantics: earliest first).
  std::sort(due.begin(), due.end(), [&](uint32_t a, uint32_t b) {
    double da = 0, db = 0; for (auto& t : timers_) { if (t.id == a) da = t.due; if (t.id == b) db = t.due; } return da < db; });
  for (uint32_t id : due) {
    size_t i = 0; for (; i < timers_.size(); ++i) if (timers_[i].id == id) break;
    if (i == timers_.size() || timers_[i].dead) continue;
    Task fn = timers_[i].fn;  // copy: the callback may clear or reallocate timers_
    if (timers_[i].repeat) timers_[i].due = std::max(n, timers_[i].due) + std::max(1.0, timers_[i].period);
    else timers_[i].dead = true;
    fn();
  }
  timers_.erase(std::remove_if(timers_.begin(), timers_.end(), [](const Timer& t) { return t.dead; }), timers_.end());
  return nextDeadline();
}

}  // namespace host
