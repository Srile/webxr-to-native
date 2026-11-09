#pragma once
// OpenXR instance/session/swapchain/frame loop over the host EGL context.
// Everything JS-visible is derived from XrFrameInfo on the JS side (WP-07a);
// this class knows nothing about WebXR.
#ifdef __ANDROID__
#include <jni.h>
#endif
#include <EGL/egl.h>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
#include "xr/xr_input.h"
#include "xr/xr_scene.h"

struct android_app;

namespace host {

class Egl;

struct XrViewInfo { float pos[3]; float quat[4]; float fovL, fovR, fovU, fovD; };

struct XrFrameInfo {
  XrTime displayTime = 0;
  double displayTimeMs = 0;          // predicted display time as the host loop's ms
  bool shouldRender = false;
  uint32_t viewCount = 0;
  XrViewInfo views[2];               // in the base (floor) space
  float localInBasePos[3] = {0, 0, 0}; float localInBaseQuat[4] = {0, 0, 0, 1}; // LOCAL space located in the base space
  uint32_t colorTexture = 0;         // acquired swapchain image (GL name), valid between beginFrame and endFrame
  uint32_t imageIndex = 0;
  int width = 0, height = 0, arraySize = 1;
  XrInputState input;
  XrPosef viewPose[2] = {}; XrFovf viewFov[2] = {};  // as located, for the projection layer endFrame submits
  uint32_t sceneGeneration = 0;      // bumps when the scene entity list changes (JS refetches it)
};

struct SwapchainDesc { bool passthrough = false; bool unpremultiplied = false; bool scene = false; int64_t glFormat = 0x8058 /*GL_RGBA8: the browser model — the shader writes sRGB-encoded texels, no hardware encode on write*/; int width = 0, height = 0; double scale = 1.0; int arraySize = 2; int samples = 1; };  // width/height 0: recommended × scale, read at creation

// XR_EXT_performance_settings: start level for both domains, and the adaptive step to BOOST when frames miss.
struct PerfConfig {
  bool enabled = true;        // set levels at all (false: leave the runtime's defaults)
  bool adaptive = true;       // escalate to BOOST over a bad window, drop back after stable ones
  int startLevel = XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT;
  int window = 90;            // frames per evaluation window (~1 s at 90 Hz)
  float missRatio = 0.05f;    // a window is bad when missed frames >= ratio x window (at least 1)
  int stableWindows = 5;      // good windows in a row before BOOST is dropped
};

class OpenXrDevice {
 public:
  bool createInstance(android_app* app);
  bool createSession(Egl& egl);
  void destroy();

  // Swapchain for the projection layer. width/height 0 = recommended. Recreates if one exists.
  bool createSwapchain(const SwapchainDesc& d);
  void destroySwapchain();
  int recommendedWidth() const { return recW_; }
  int recommendedHeight() const { return recH_; }
  int swapchainWidth() const { return scW_; }
  int swapchainHeight() const { return scH_; }
  int swapchainArraySize() const { return scArray_; }
  int64_t swapchainFormat() const { return scFormat_; }  // the GL format the swapchain was made with
  int viewCount() const { return viewCount_; }   // views per frame: 2 on a headset, 1 in the Vision Pro simulator
  // The page's render-state depth range (updateRenderState): what its depth buffer encodes. Hosts that hand depth
  // to their compositor (vision) convert with it.
  void setDepthRange(float nearZ, float farZ) { depthNear_ = nearZ; depthFar_ = farZ; }  // not near/far: windows.h defines both away
  // A depth texture of the host's the page's layer attaches instead of its own renderbuffer (0: none), so the
  // host can read the page's depth back (vision: converted into the compositor's).
  uint32_t swapchainDepthTexture() const { return depthTex_; }
  const std::vector<uint32_t>& swapchainImages() const { return scImages_; }

  // Pump events; returns false when the session is gone for good (EXITING/LOSS_PENDING).
  bool pollEvents();
  // Runs on the polling thread right before xrEndSession (STOPPING): the host drains the GL thread here, which may
  // still be submitting the last frame (gl.pipeline), so xrEndFrame and xrEndSession never overlap.
  std::function<void()> beforeSessionEnd;
  bool sessionRunning() const { return running_; }
  bool focused() const { return state_ == XR_SESSION_STATE_FOCUSED; }
  XrSessionState state() const { return state_; }
  bool exitRequested() const { return exitRequested_; }
  void requestExit();

  // Frame loop (host thread only). beginFrame blocks in xrWaitFrame.
  bool beginFrame(XrFrameInfo& out, double loopNowMs);  // = waitFrame() + beginWaited()
  // The two halves, for the GL thread (gl/gl_queue.h): xrWaitFrame needs no GL and runs on the host thread; the
  // rest (xrBeginFrame, views, input, the swapchain acquire) runs where the context is current.
  bool waitFrame();
  bool beginWaited(XrFrameInfo& out, double loopNowMs);  // = beginOnly + locateWaited + acquire
  // Pipelined (gl.pipeline): locateWaited on the host thread right after waitFrame; beginOnly + acquire on the GL
  // thread when the previous frame's commands and submit have run.
  bool beginOnly();
  void locateWaited(XrFrameInfo& out, double loopNowMs);
  void acquire(XrFrameInfo& out);
  void endFrame(const XrFrameInfo& f, bool submit);

  // Spaces and bounds
  bool hasStage() const { return stageSpace_ != XR_NULL_HANDLE; }
  bool stageBounds(float& w, float& d) const { w = boundsW_; d = boundsD_; return boundsW_ > 0; }
  bool referenceSpaceChanged() { bool c = refChanged_; refChanged_ = false; return c; }

  // Extensions
  const std::vector<float>& refreshRates() const { return rates_; }
  std::string profileLine();  // per-phase ms of beginFrame since the last call (bring-up stats)
  // When the last xrWaitFrame returned (steady_clock ms) and the display period (ms): the next wake is
  // predicted at lastWakeMs() + framePeriodMs() (the GC idle deadline, js/gc.h).
  double lastWakeMs() const { return wakeMs_; }
  double framePeriodMs() const { return frameState_.predictedDisplayPeriod / 1e6; }
  float refreshRate() const { return rate_; }
  bool requestRefreshRate(float hz);
  bool refreshRateChanged() { bool c = rateChanged_; rateChanged_ = false; return c; }
  // Fixed foveation (XR_FB_foveation): remembered and applied to the current swapchain and to every one created
  // after it (before its first frame). dynamic = XR_FOVEATION_DYNAMIC_LEVEL_ENABLED_FB (the level becomes a ceiling).
  bool setFoveation(float level01);
  void setFoveationDynamic(bool d) { fovDynamic_ = d; }
  void resetFoveation() { fovWanted_ = -1; }   // a new session starts unfoveated, like a new layer in the browser
  bool foveationSupported() const { return extFoveation_ && pfnCreateFov_ && pfnDestroyFov_ && pfnUpdateSwapchain_; }
  int foveationLevel() const { return fovApplied_; }  // XrFoveationLevelFB applied to the current swapchain, -1 none
  // Performance levels (XR_EXT_performance_settings)
  void setPerfConfig(const PerfConfig& c) { perfCfg_ = c; }
#ifdef __ANDROID__
  // XR_KHR_android_thread_settings: tells the runtime which threads carry the frame (it raises their scheduling
  // priority). false: the extension is absent or the call failed.
  bool declareThread(XrAndroidThreadTypeKHR type, uint32_t tid);
#endif
  int perfLevel(int domain) const { return perfLevel_[domain == XR_PERF_SETTINGS_DOMAIN_GPU_EXT ? 1 : 0]; }  // -1 never set
  std::string perfLine();  // "fov MED perf cpu SH gpu SH miss 3" (bring-up stats; resets the miss count)
  bool hasHandTracking() const { return extHand_; }
  XrInput& input() { return input_; }
  XrScene& scene() { return scene_; }
  bool passthroughSupported() const { return scene_.passthroughSupported(); }
  bool sceneSupported() const { return scene_.sceneSupported(); }
  XrInstance instance() const { return instance_; }
  XrSession session() const { return session_; }
  XrSpace baseSpace() const { return stageSpace_ ? stageSpace_ : localSpace_; }
  std::string systemName() const { return systemName_; }

 private:
  bool beginSession();
  bool endSession();
  void updateBounds();
  void enumerateRefreshRates();
  bool applyFoveation();
  void applyPerfLevels();
  void perfFrame(XrTime predicted, XrDuration period);

  android_app* app_ = nullptr;
  const char* glReqExt_ = nullptr;  // desktop: the KHR enable extension whose graphics requirements the runtime wants asked
  XrInstance instance_ = XR_NULL_HANDLE;
  XrSystemId system_ = XR_NULL_SYSTEM_ID;
  XrSession session_ = XR_NULL_HANDLE;
  XrSpace localSpace_ = XR_NULL_HANDLE, stageSpace_ = XR_NULL_HANDLE, viewSpace_ = XR_NULL_HANDLE;
  XrSwapchain swapchain_ = XR_NULL_HANDLE;
  std::vector<uint32_t> scImages_;
  int scW_ = 0, scH_ = 0, scArray_ = 1, recW_ = 0, recH_ = 0, viewCount_ = 2;
  int64_t scFormat_ = 0;
  float depthNear_ = 0.1f, depthFar_ = 1000.f; uint32_t depthTex_ = 0;
  double prof_[5] = {0, 0, 0, 0, 0}; int profN_ = 0;
  double wakeMs_ = 0;
  XrSessionState state_ = XR_SESSION_STATE_UNKNOWN;
  bool running_ = false, exitRequested_ = false, refChanged_ = false, rateChanged_ = false;
  float boundsW_ = 0, boundsD_ = 0;
  std::vector<float> rates_; float rate_ = 0;
  std::string systemName_;
  XrFrameState frameState_{XR_TYPE_FRAME_STATE};
  XrViewConfigurationView viewConfigs_[2];
  XrCompositionLayerProjectionView projViews_[2];
  bool extThread_ = false; PFN_xrVoidFunction pfnSetThread_ = nullptr;
  bool extRefresh_ = false, extFoveation_ = false, extHand_ = false, extColorSpace_ = false, extHandAim_ = false, extSwapUpdate_ = false;
  PFN_xrEnumerateDisplayRefreshRatesFB pfnEnumRates_ = nullptr;
  PFN_xrGetDisplayRefreshRateFB pfnGetRate_ = nullptr;
  PFN_xrRequestDisplayRefreshRateFB pfnReqRate_ = nullptr;
  PFN_xrCreateFoveationProfileFB pfnCreateFov_ = nullptr;
  PFN_xrDestroyFoveationProfileFB pfnDestroyFov_ = nullptr;
  PFN_xrUpdateSwapchainFB pfnUpdateSwapchain_ = nullptr;
  float fovWanted_ = -1; bool fovDynamic_ = false; int fovApplied_ = -1; bool fovAppliedDynamic_ = false; uint32_t swapchainSerial_ = 0;
  bool extPerf_ = false; PFN_xrPerfSettingsSetPerformanceLevelEXT pfnPerfLevel_ = nullptr; PerfConfig perfCfg_;
  int perfLevel_[2] = {-1, -1}, perfCap_[2] = {XR_PERF_SETTINGS_LEVEL_BOOST_EXT, XR_PERF_SETTINGS_LEVEL_BOOST_EXT};
  bool perfBoost_ = false; int perfWinFrames_ = 0, perfWinMisses_ = 0, perfStable_ = 0, perfMissesStat_ = 0; XrTime perfLastPredicted_ = 0;
  XrInput input_;
  XrScene scene_; SceneExtensions sceneExt_; bool blendAlpha_ = false, unpremultiplied_ = false;
};

const char* xrResultName(XrInstance inst, XrResult r);

}  // namespace host
