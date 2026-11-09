// The display's refresh from a CADisplayLink on the main run loop. waitVsync() runs that run loop until the next
// one instead of blocking: touches are handled while it waits, and the main thread is seen as idle (accessibility,
// XCUITest, which waited minutes for a thread blocked on a semaphore). The emulated headset's frame loop is paced
// by it, where xrWaitFrame would pace it on a headset.
// The immersive vision host runs its loop on its own thread (vision/App.swift keeps the main thread for SwiftUI):
// there waitVsync() waits on the tick instead of running the main run loop.
#include "ios/vsync.h"
#import <QuartzCore/QuartzCore.h>
#include <condition_variable>
#include <mutex>

namespace { bool g_tick = false; CADisplayLink* g_link = nil; std::mutex g_mu; std::condition_variable g_cv; }

@interface HostVsync : NSObject
- (void)tick:(CADisplayLink*)link;
@end
@implementation HostVsync
- (void)tick:(CADisplayLink*)link { { std::lock_guard<std::mutex> l(g_mu); g_tick = true; } g_cv.notify_all(); }
@end

namespace host {
namespace ios {
void startVsync() {
  if (g_link) return;
  auto start = ^{
    if (g_link) return;
    g_link = [CADisplayLink displayLinkWithTarget:[HostVsync new] selector:@selector(tick:)];
    g_link.preferredFramesPerSecond = 60;  // ProMotion's 120 would double every frame's work for two eye views
    [g_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  };
  if (NSThread.isMainThread) start(); else dispatch_sync(dispatch_get_main_queue(), start);
}
void waitVsync() {
  // The refresh after this call (a tick already past is the one this frame was late for), at most ~3 frames away:
  // a paused display link (app inactive) must not hang the loop.
  if (!NSThread.isMainThread) {
    std::unique_lock<std::mutex> l(g_mu); g_tick = false;
    g_cv.wait_for(l, std::chrono::milliseconds(50), [] { return g_tick; });
    return;
  }
  { std::lock_guard<std::mutex> l(g_mu); g_tick = false; }
  const CFTimeInterval deadline = CACurrentMediaTime() + 0.05;
  for (;;) { { std::lock_guard<std::mutex> l(g_mu); if (g_tick) break; } const CFTimeInterval left = deadline - CACurrentMediaTime(); if (left <= 0) break; CFRunLoopRunInMode(kCFRunLoopDefaultMode, left, true); }
}
}  // namespace ios
}  // namespace host
