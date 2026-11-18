#pragma once
// The host: reads assets/host.json, owns loop/EGL/XR/V8 and the mode controller.
// Modes: "js" (the real thing: boot host-runtime.js + the web entry; XR when
// the page asks), "native-clear" (WP-01 XR smoke test), "panel-clear".
#include <memory>
#include <string>
#include "core/json.h"
#include "core/loop.h"
#include "gl/egl.h"
#include "xr/openxr_device.h"
#include "app/native_clear.h"
#include "android/display.h"
#include "js/engine.h"
#include "js/gc.h"
#include "js/inspector.h"
#include "js/modules.h"
#include "js/natives.h"
#include "js/bridge.h"
#include <functional>
#include <vector>

struct android_app;
struct ANativeWindow;
struct AInputEvent;
struct AAssetManager;

namespace host {

class Host {
 public:
  explicit Host(android_app* app);
  ~Host();
  bool start();
  void onWindow(ANativeWindow* win);
  void onWindowLost();
  void onResume(); void onPause(); void onLowMemory();
  bool onInput(const AInputEvent* e);  // the phone build's touches and keys (WP-20); false: not handled
  // The phone's host thread (android/phone_host.h): input copied on the activity's thread and applied on this one,
  // a recreated activity taken over by the running host, the asset manager of the process, and the wait between
  // frames on this thread's looper (it wakes for vsyncs and for the activity's commands).
  struct InputEvent {
    enum Type : uint8_t { kNone, kBack, kPointer } type = kNone; uint8_t phase = 0; bool down = false, repeat = false;
    uint8_t count = 0; struct P { int32_t id, tool; float x, y, pressure; } p[10];
  };
  static bool readInput(const AInputEvent* e, InputEvent& out);  // false: not one the host takes
  void applyInput(const InputEvent& in);
  void attach(android_app* app);
  void detach();
  void useAssetManager(AAssetManager* am) { assetMgr_ = am; }
  void ownLooper() { pollLooper_ = true; }
  bool tick();   // one loop iteration; false = exit
  const Json& config() const { return config_; }

 private:
  bool startXrInstance();
  bool startNativeClear();
  bool startJs();
  bool xrBegin(const Json& opts, Json& out);
  void xrEnd();
  void xrTick();
  void publishXrState();  // session-state changes reach JS while still flat; xrTick cannot, it starts only after the page's swapchain
  void flatTick();
  void updateVisibility();  // the Quest: the page hidden and its audio stopped while the headset is off (WP-07c)
  void stats(const XrFrameInfo* f);

  android_app* app_;  // the current activity; null between a phone's activities
  AAssetManager* assetMgr_ = nullptr; bool pollLooper_ = false, exit_ = false;
  Json config_;
  std::string mode_;
  Loop loop_;
  Egl egl_;
  OpenXrDevice xr_;
  NativeClear clear_;
  Assets assets_; Http http_; LocalStorage store_;
  GcScheduler gc_; GcConfig gcCfg_;  // GC right after the frame submit (js/gc.h)
  Engine engine_; std::unique_ptr<Inspector> inspector_; Modules modules_;
  HostServices svc_;
  Bridge bridge_;
  struct ShotReq { int eye; std::function<void(const std::string&)> reply; }; std::vector<ShotReq> shots_;
  void captureShots(const XrFrameInfo* f);
  double heapMB();
  bool pipeline_ = false;  // gl.pipeline: XR frames recorded one ahead of the GL thread (xrTickPipelined)
  void xrTickPipelined();
  static uint32_t opXrBegin(const uint32_t* c);
  static uint32_t opXrEnd(const uint32_t* c);
  double fpsNow_ = 0, jsAvg_ = 0, glBusy_ = 0; unsigned glCallsFrame_ = 0;
  bool eglUp_ = false, xrInstance_ = false, xrSession_ = false, xrActive_ = false, resumed_ = false, clearUp_ = false, jsUp_ = false;
  ANativeWindow* window_ = nullptr;
  double statT_ = 0; int frames_ = 0; double lastFlat_ = 0; double jsMs_ = 0, waitMs_ = 0, endMs_ = 0;
  double lastFrameStart_ = 0, lastFrameEnd_ = 0;  // the slow-frame diagnostic's
  XrSessionState lastState_ = XR_SESSION_STATE_UNKNOWN;
  bool scenePermissionAsked_ = false;
  // The Quest's page visibility (updateVisibility): hidden_ once the immersive session has been seen VISIBLE/FOCUSED
  // (xrSeenVisible_, per XR session) and left it, or while a flat app is paused.
  bool hidden_ = false, xrSeenVisible_ = false;
  bool phone_ = false, shown_ = true; float dpr_ = 1; float insets_[4] = {0, 0, 0, 0}; int insetW_ = 0, insetH_ = 0, insetFrames_ = 0;
  // The phone's page rate (host.json android.frameRate) and its pacing: Choreographer's vsync callback (on this, the
  // looper thread) records each vsync and measures the period; a frame starts every n-th vsync, n the most that
  // still gives the page at least its rate (flatTick). While hidden the callback is not re-posted.
  float frameRate_ = 60, displayHz_ = 0; int rotation_ = 0; int64_t vsyncNs_ = 0, frameVsyncNs_ = 0, vsyncPeriodNs_ = 0;
  bool vsyncPosted_ = false;
  void requestVsync();
  static void onVsync(int64_t frameTimeNanos, void* self);
  Display display_;  // rotation, refresh rate, cutout (android/display.h)  // host.json android.formFactor "phone": no OpenXR, page input, touch controls
  // Tile-GPU hint: the acquired swapchain image's old contents are never needed (the browser clears/discards them too).
  void invalidateAcquired(const XrFrameInfo& f);
  bool invalidateAcquire_ = true; unsigned invFbo_ = 0;
};

}  // namespace host
