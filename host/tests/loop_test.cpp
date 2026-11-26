#include "core/loop.h"
#include <cassert>
#include <memory>
#include <cstdio>
#include <thread>
#include <vector>
int main() {
  host::Loop loop; std::vector<int> order;
  loop.post([&] { order.push_back(1); });
  uint32_t rep = loop.setTimer(5, true, [&] { order.push_back(3); });
  loop.setTimer(1, false, [&] { order.push_back(2); loop.clearTimer(rep); });
  std::thread t([&] { loop.post([&] { order.push_back(10); }); }); t.join();
  double deadline = 0; int spins = 0;
  while (loop.timerCount() > 0 && spins++ < 1000) { deadline = loop.runOnce(); if (deadline > 0) std::this_thread::sleep_for(std::chrono::microseconds((int)(deadline * 1000))); }
  assert(order.size() >= 3); assert(order[0] == 1 && order[1] == 10); assert(order[2] == 2);
  for (int v : order) assert(v != 3);  // the repeating timer was cleared before it fired
  // clear() drops every pending task and timer unrun, releasing what they hold (a shutting-down host's JS handles).
  { host::Loop l; auto held = std::make_shared<int>(7); std::weak_ptr<int> w = held; bool ran = false;
    l.post([held, &ran] { ran = true; }); l.setTimer(1000, false, [held, &ran] { ran = true; }); l.setTimer(1, true, [held, &ran] { ran = true; });
    held.reset(); assert(!w.expired());
    l.clear();
    assert(w.expired() && l.timerCount() == 0 && !l.hasPendingTasks());
    l.runOnce(); assert(!ran); }
  puts("loop_test ok"); return 0;
}
