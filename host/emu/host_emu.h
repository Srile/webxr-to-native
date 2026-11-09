#pragma once
// The hosts without a headset (experimental: mac/, win/, ios/, linux/): app/host.h's Host for a window instead of an
// activity. Same services, same runtime, same frame loop shape; the headset is emulated (emu_xr.cpp, input
// through emu.h's hooks) and the assets are a directory (staged exactly as pack.mjs stages the APK's). Each
// platform brings only its entry point and window, an Http transport and, where it differs, audio and GL.
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "core/json.h"
#include "core/loop.h"
#include "gl/egl.h"
#include "xr/openxr_device.h"
#include "js/engine.h"
#include "js/gc.h"
#include "js/inspector.h"
#include "js/modules.h"
#include "js/natives.h"
#include "js/bridge.h"
#include "js/code_cache.h"
#include "emu/splash.h"

namespace host {

class Host {
 public:
  Host(std::string assetsDir, std::string filesDir) : assetsDir_(std::move(assetsDir)), filesDir_(std::move(filesDir)) {}
  ~Host();
  // The window's native surface, as Egl::bindWindow takes it: a CAMetalLayer (mac, ANGLE draws through it),
  // an HWND (win, ANGLE), a CAEAGLLayer (ios, ios/egl_eagl.mm), an X11 Window id (linux, the system's EGL).
  bool start(void* nativeWindow);
  bool tick();              // one loop iteration; false = exit
  const Json& config() const { return config_; }
  std::string icuData;  // V8's ICU data file, when the platform knows where it is (win: next to the executable)
  bool exitRequested() const { return exit_; }

 private:
  bool startJs();
  bool xrBegin(const Json& opts, Json& out);
  void xrEnd();
  void xrTick();
  void flatTick();
  void stats(const XrFrameInfo* f);
  void captureShots(const XrFrameInfo* f);
  double heapMB();
#ifdef HOST_XR_OPENXR
  void mirrorToWindow(const XrFrameInfo& f);  // linux/ on a real OpenXR runtime: the left eye into the window
  unsigned mirrorFbo_ = 0;
#endif

  std::string assetsDir_, filesDir_;
  Json config_;
  Loop loop_;
  Egl egl_;
  OpenXrDevice xr_;
  Assets assets_; Http http_; LocalStorage store_;
  GcScheduler gc_; GcConfig gcCfg_;
  Engine engine_; std::unique_ptr<Inspector> inspector_; Modules modules_;
  HostServices svc_;
  CodeCache codeCache_; int xrFrames_ = 0;  // the code caches are written once, some seconds into XR
  Splash splash_;  // app.splash in the window until the page draws (emu/splash.h)
 public:
  // A new window surface for the flat page (visionOS: the window reopened after an XR session is a new one):
  // the old surface is dropped and this one bound. Host thread.
  void rebindWindow(void* nativeWindow);
  Bridge bridge_;
  struct ShotReq { int eye; std::function<void(const std::string&)> reply; }; std::vector<ShotReq> shots_;
  double fpsNow_ = 0, jsAvg_ = 0;
  bool eglUp_ = false, xrUp_ = false, xrActive_ = false, jsUp_ = false, exit_ = false;
  double statT_ = 0; int frames_ = 0; double lastFlat_ = 0; double jsMs_ = 0;
  XrSessionState lastState_ = XR_SESSION_STATE_UNKNOWN;
};

}  // namespace host
