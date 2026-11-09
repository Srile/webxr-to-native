// iOS host entry (experimental): a full-screen HostView whose layer the host renders into, and the host
// loop. The app bundle (tools/ios.mjs) carries the staged assets in assets/; localStorage and host.log live
// in Library/Application Support. The loop runs on the main thread, as the desktop hosts' does: it pumps
// the run loop for touches, then ticks the host; the swap waits for the display's refresh (ios/egl_eagl.mm).
// While the app is not active nothing is drawn (iOS ends an app that uses the GPU in the background).
// visionOS runs the same file as a window app (WP-17's flat spike): its Info.plist (ios/Info-vision.plist.in)
// names a scene manifest, so the window comes from HostSceneDelegate instead of the app delegate.
#import <UIKit/UIKit.h>
#include <TargetConditionals.h>
#import <AVFoundation/AVFoundation.h>
#include <cstdio>
#include <string>
#include <unistd.h>
#include <thread>
#include <atomic>
#include <pthread.h>
#include "emu/host_emu.h"
#include "audio/device.h"
#import "ios/host_view.h"
#include "core/log.h"

namespace { bool g_active = true; }

@interface HostViewController : UIViewController
@end
@implementation HostViewController
#if TARGET_OS_VISION
- (void)loadView { self.view = [[HostView alloc] initWithFrame:CGRectZero]; }  // sized to the window scene by UIKit
#else
- (void)loadView { self.view = [[HostView alloc] initWithFrame:UIScreen.mainScreen.bounds]; }
#endif
- (BOOL)prefersStatusBarHidden { return YES; }
- (BOOL)prefersHomeIndicatorAutoHidden { return YES; }
- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures { return UIRectEdgeAll; }
@end

@interface HostAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow* window;
- (void)runHost;
@end

// The app's audio session (the remote I/O units in audio/device.cpp play through it), and its interruptions: after
// a call, Siri or an alarm the session and every output unit stay stopped until started again. onResume runs on
// the main queue; the host thread is where the units are restarted (resumeAfterInterruption).
static void setupAudioSession(void (^onResume)(void)) {
  [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryAmbient error:nil];  // respects the silent switch, mixes with other audio
  [AVAudioSession.sharedInstance setActive:YES error:nil];
  [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionInterruptionNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* n) {
    if ([n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] != AVAudioSessionInterruptionTypeEnded) return;
    [AVAudioSession.sharedInstance setActive:YES error:nil];
    onResume();
  }];
}

@implementation HostAppDelegate
- (BOOL)application:(UIApplication*)app didFinishLaunchingWithOptions:(NSDictionary*)opts {
  const bool scenes = NSBundle.mainBundle.infoDictionary[@"UIApplicationSceneManifest"] != nil;  // visionOS: HostSceneDelegate makes the window
  if (!scenes) {
#if TARGET_OS_VISION
    self.window = [[UIWindow alloc] initWithFrame:CGRectZero];  // not reached: the visionOS plist names a scene manifest
#else
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
#endif
    self.window.rootViewController = [HostViewController new];
    self.window.backgroundColor = UIColor.blackColor;
    [self.window makeKeyAndVisible];
  }
  setupAudioSession(^{ host::audio::RealtimeContext::resumeAfterInterruption(); });  // the loop runs on this thread here
  // Out of launch first (a launch that does not return is ended by the watchdog); a run-loop timer, not the
  // main queue, so the loop's own run-loop pumping still drains the main queue for UIKit.
  if (!scenes) [self performSelector:@selector(runHost) withObject:nil afterDelay:0];
  return YES;
}
- (void)applicationWillResignActive:(UIApplication*)app { g_active = false; }
- (void)applicationDidBecomeActive:(UIApplication*)app { g_active = true; }

- (void)runHost {
  NSFileManager* fm = NSFileManager.defaultManager;
  std::string assets = std::string(NSBundle.mainBundle.resourcePath.UTF8String) + "/assets";
  std::string files = [fm URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject.path.UTF8String;
  [fm createDirectoryAtPath:[NSString stringWithUTF8String:files.c_str()] withIntermediateDirectories:YES attributes:nil error:nil];
  if (!isatty(STDERR_FILENO)) freopen((files + "/host.log").c_str(), "w", stderr);  // simctl launch --console keeps the terminal
  setvbuf(stderr, nullptr, _IOLBF, 0);
  UIView* view = self.window.rootViewController.view;
  [view layoutIfNeeded];
  int code = 0;
  {
    host::Host app(assets, files);
    if (!app.start((__bridge void*)view.layer)) { HOST_LOGE("host start failed"); code = 1; }
    else {
      for (;;) {
        @autoreleasepool {
          while (CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, TRUE) == kCFRunLoopRunHandledSource) {}
          if (!g_active) { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, TRUE); continue; }
          if (!app.tick()) break;
        }
      }
    }
  }
  // The page ended the app (or the host failed). As on the desktop: no static destructors (emu/host_emu.cpp).
  fflush(nullptr); _exit(code);
}
@end

// The scene-based shell (visionOS): one window scene, the same view and loop.
@interface HostSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow* window;
@end
@implementation HostSceneDelegate
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)opts {
  if (![scene isKindOfClass:[UIWindowScene class]]) return;
  HostAppDelegate* app = (HostAppDelegate*)UIApplication.sharedApplication.delegate;
  if (app.window) { HOST_LOGW("a second window scene: ignored"); return; }
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene*)scene];
  self.window.rootViewController = [HostViewController new];
  self.window.backgroundColor = UIColor.blackColor;
  [self.window makeKeyAndVisible];
  app.window = self.window;
  [app performSelector:@selector(runHost) withObject:nil afterDelay:0];
}
- (void)sceneWillResignActive:(UIScene*)scene { g_active = false; }
- (void)sceneDidBecomeActive:(UIScene*)scene { g_active = true; }
@end

#ifdef HOST_VISION_IMMERSIVE
// The SwiftUI shell (vision/App.swift) owns the app; it hands the window's HostView over once it is up and
// the loop runs here on the main thread, as the UIKit shell's does.
extern "C" void hostVisionSetActive(bool active) { g_active = active; }
static std::atomic<void*> g_rebindLayer{nullptr};   // a reopened window's layer, for the host thread to bind
static std::atomic<bool> g_audioResume{false};     // an audio interruption ended (main queue), for the host thread to act on
extern "C" void hostVisionStart(UIView* view) {
  static bool started = false;
  if (started) {  // the window reopened after an XR session (vision/App.swift): its new layer replaces the old surface
    [view layoutIfNeeded];
    void* prev = g_rebindLayer.exchange((__bridge_retained void*)view.layer);
    if (prev) CFRelease(prev);
    return;
  }
  started = true;
  setupAudioSession(^{ g_audioResume = true; });  // HostAppDelegate is not this app's delegate: the SwiftUI shell is
  NSFileManager* fm = NSFileManager.defaultManager;
  std::string assets = std::string(NSBundle.mainBundle.resourcePath.UTF8String) + "/assets";
  std::string files = [fm URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject.path.UTF8String;
  [fm createDirectoryAtPath:[NSString stringWithUTF8String:files.c_str()] withIntermediateDirectories:YES attributes:nil error:nil];
  if (!isatty(STDERR_FILENO)) freopen((files + "/host.log").c_str(), "w", stderr);
  setvbuf(stderr, nullptr, _IOLBF, 0);
  [view layoutIfNeeded];
  // The loop on its own thread (the Quest host's shape): the main thread stays SwiftUI's, which opens the
  // immersive space and delivers the window's touches meanwhile. GL, V8 and the compositor frames all live here.
  void* layer = (__bridge_retained void*)view.layer;
  std::thread([assets, files, layer] {
    pthread_setname_np("webxr-host");
    int code = 0;
    {
      host::Host app(assets, files);
      if (!app.start(layer)) { HOST_LOGE("host start failed"); code = 1; }
      else {
        for (;;) {
          @autoreleasepool {
            if (!g_active) { usleep(100000); continue; }
            if (void* l = g_rebindLayer.exchange(nullptr)) app.rebindWindow(l);
            if (g_audioResume.exchange(false)) host::audio::RealtimeContext::resumeAfterInterruption();
            if (!app.tick()) break;
          }
        }
      }
    }
    fflush(nullptr); _exit(code);
  }).detach();
}
#else
int main(int argc, char** argv) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass([HostAppDelegate class])); }
}
#endif
