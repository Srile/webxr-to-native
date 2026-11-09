#include <chrono>
#include "xr/openxr_device.h"
#include "core/log.h"
#include "gl/egl.h"
#ifdef __ANDROID__
#include <android_native_app_glue.h>
#endif
#include <cmath>
#include <cstring>
#include <algorithm>

namespace host {

const char* xrResultName(XrInstance inst, XrResult r) {
  static char buf[XR_MAX_RESULT_STRING_SIZE];
  if (inst && XR_SUCCEEDED(xrResultToString(inst, r, buf))) return buf;
  snprintf(buf, sizeof buf, "XrResult(%d)", (int)r); return buf;
}
#define XR_CHECK(expr, what) do { XrResult _r = (expr); if (XR_FAILED(_r)) { HOST_LOGE("%s failed: %s", what, xrResultName(instance_, _r)); return false; } } while (0)

bool OpenXrDevice::createInstance(android_app* app) {
  app_ = app;
#ifdef __ANDROID__
  PFN_xrInitializeLoaderKHR initLoader = nullptr;
  xrGetInstanceProcAddr(XR_NULL_HANDLE, "xrInitializeLoaderKHR", (PFN_xrVoidFunction*)&initLoader);
  if (initLoader) {
    XrLoaderInitInfoAndroidKHR li{XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR};
    li.applicationVM = app->activity->vm; li.applicationContext = app->activity->clazz;
    initLoader((const XrLoaderInitInfoBaseHeaderKHR*)&li);
  }
#endif
  uint32_t n = 0;
  if (XR_FAILED(xrEnumerateInstanceExtensionProperties(nullptr, 0, &n, nullptr))) { HOST_LOGE("no OpenXR runtime (xrEnumerateInstanceExtensionProperties failed)"); return false; }
  std::vector<XrExtensionProperties> props(n, {XR_TYPE_EXTENSION_PROPERTIES});
  xrEnumerateInstanceExtensionProperties(nullptr, n, &n, props.data());
  auto has = [&](const char* name) { for (auto& p : props) if (!strcmp(p.extensionName, name)) return true; return false; };
#ifdef __ANDROID__
  std::vector<const char*> exts = { XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME, XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME };
#else
  // Desktop (the Linux host on Monado / WiVRn, WP-18b): the host's EGL context through XR_MNDX_egl_enable, the only
  // EGL binding a desktop runtime offers. The graphics requirements still come from a KHR enable extension (the
  // runtime refuses a session before they are asked): the GLES one where listed, else desktop GL's.
  std::vector<const char*> exts = { XR_MNDX_EGL_ENABLE_EXTENSION_NAME };
  glReqExt_ = has(XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME) ? XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME : has("XR_KHR_opengl_enable") ? "XR_KHR_opengl_enable" : nullptr;  // by name: its macro needs XR_USE_GRAPHICS_API_OPENGL (desktop GL headers)
  if (glReqExt_) exts.push_back(glReqExt_);
  { std::string all; for (auto& p : props) { all += all.empty() ? "" : " "; all += p.extensionName; } HOST_LOGI("OpenXR runtime extensions: %s", all.c_str()); }
#endif
  for (auto* e : exts) if (!has(e)) { HOST_LOGE("required OpenXR extension missing: %s", e); return false; }
  auto opt = [&](const char* name, bool& flag) { flag = has(name); if (flag) exts.push_back(name); HOST_LOGI("ext %s: %s", name, flag ? "yes" : "no"); };
  opt(XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME, extRefresh_);
#ifdef __ANDROID__
  opt(XR_KHR_ANDROID_THREAD_SETTINGS_EXTENSION_NAME, extThread_);
#endif
  opt(XR_FB_FOVEATION_EXTENSION_NAME, extFoveation_);
  bool fovCfg = false; opt(XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME, fovCfg);
  opt(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME, extSwapUpdate_);
  opt(XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME, extPerf_);
  opt(XR_EXT_HAND_TRACKING_EXTENSION_NAME, extHand_);
  opt(XR_FB_HAND_TRACKING_AIM_EXTENSION_NAME, extHandAim_);
  opt(XR_FB_COLOR_SPACE_EXTENSION_NAME, extColorSpace_);
  if (!fovCfg || !extSwapUpdate_) extFoveation_ = false;  // xrUpdateSwapchainFB (the only way to hand a swapchain a profile) lives in XR_FB_swapchain_update_state
  // immersive-ar: passthrough under the eye buffer, the room's anchors as planes and meshes, the system's room setup.
  opt(XR_FB_PASSTHROUGH_EXTENSION_NAME, sceneExt_.passthrough);
  opt(XR_FB_SPATIAL_ENTITY_EXTENSION_NAME, sceneExt_.spatialEntity);
  opt(XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME, sceneExt_.query);
  opt(XR_FB_SPATIAL_ENTITY_CONTAINER_EXTENSION_NAME, sceneExt_.container);
  opt(XR_FB_SPATIAL_ENTITY_STORAGE_EXTENSION_NAME, sceneExt_.storage);  // the LOCAL-storage query filter belongs to this extension
  opt(XR_FB_SCENE_EXTENSION_NAME, sceneExt_.scene);
  opt(XR_FB_SCENE_CAPTURE_EXTENSION_NAME, sceneExt_.sceneCapture);
  opt(XR_META_SPATIAL_ENTITY_MESH_EXTENSION_NAME, sceneExt_.meshMeta);

  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO};
#ifdef __ANDROID__
  XrInstanceCreateInfoAndroidKHR android{XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR};
  android.applicationVM = app->activity->vm; android.applicationActivity = app->activity->clazz;
  ci.next = &android;
#endif
  strncpy(ci.applicationInfo.applicationName, "webxr-host", XR_MAX_APPLICATION_NAME_SIZE - 1);
  ci.applicationInfo.applicationVersion = 1;
  strncpy(ci.applicationInfo.engineName, "webxr-host", XR_MAX_ENGINE_NAME_SIZE - 1);
  ci.applicationInfo.engineVersion = 1;
  ci.applicationInfo.apiVersion = XR_API_VERSION_1_0;
  ci.enabledExtensionCount = (uint32_t)exts.size(); ci.enabledExtensionNames = exts.data();
  XrResult r = xrCreateInstance(&ci, &instance_);
  if (XR_FAILED(r)) { HOST_LOGE("xrCreateInstance failed: %d", (int)r); return false; }
  XrInstanceProperties ip{XR_TYPE_INSTANCE_PROPERTIES}; xrGetInstanceProperties(instance_, &ip);
  HOST_LOGI("OpenXR runtime: %s %u.%u.%u", ip.runtimeName, XR_VERSION_MAJOR(ip.runtimeVersion), XR_VERSION_MINOR(ip.runtimeVersion), XR_VERSION_PATCH(ip.runtimeVersion));

  XrSystemGetInfo sgi{XR_TYPE_SYSTEM_GET_INFO}; sgi.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  XR_CHECK(xrGetSystem(instance_, &sgi, &system_), "xrGetSystem");
  XrSystemHandTrackingPropertiesEXT handProps{XR_TYPE_SYSTEM_HAND_TRACKING_PROPERTIES_EXT};
  XrSystemPassthroughProperties2FB ptProps{XR_TYPE_SYSTEM_PASSTHROUGH_PROPERTIES2_FB};
  XrSystemPassthroughPropertiesFB ptProps1{XR_TYPE_SYSTEM_PASSTHROUGH_PROPERTIES_FB};  // the pre-v3 shape, which some runtimes fill instead
  XrSystemProperties sp{XR_TYPE_SYSTEM_PROPERTIES};
  ptProps.next = &ptProps1;
  handProps.next = sceneExt_.passthrough ? (void*)&ptProps : nullptr;
  sp.next = extHand_ ? (void*)&handProps : (sceneExt_.passthrough ? (void*)&ptProps : nullptr);
  XR_CHECK(xrGetSystemProperties(instance_, system_, &sp), "xrGetSystemProperties");
  systemName_ = sp.systemName;
  if (extHand_ && !handProps.supportsHandTracking) extHand_ = false;
  scene_.setSystemPassthrough(sceneExt_.passthrough && ((ptProps.capabilities & XR_PASSTHROUGH_CAPABILITY_BIT_FB) || ptProps1.supportsPassthrough));
  if (sceneExt_.passthrough) HOST_LOGI("passthrough system props: capabilities 0x%llx, supportsPassthrough %d", (unsigned long long)ptProps.capabilities, (int)ptProps1.supportsPassthrough);
  HOST_LOGI("passthrough: %s, scene: %s, scene capture: %s, mesh: %s", (sceneExt_.passthrough && ((ptProps.capabilities & XR_PASSTHROUGH_CAPABILITY_BIT_FB) || ptProps1.supportsPassthrough)) ? "yes" : "no", (sceneExt_.spatialEntity && sceneExt_.query && sceneExt_.scene) ? "yes" : "no", sceneExt_.sceneCapture ? "yes" : "no", sceneExt_.meshMeta ? "yes" : "no");
  HOST_LOGI("system: %s, max swapchain %ux%u, hands %d", sp.systemName, sp.graphicsProperties.maxSwapchainImageWidth, sp.graphicsProperties.maxSwapchainImageHeight, extHand_);

  uint32_t vc = 0;
  XR_CHECK(xrEnumerateViewConfigurationViews(instance_, system_, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &vc, nullptr), "xrEnumerateViewConfigurationViews");
  if (vc != 2) { HOST_LOGE("expected 2 views, got %u", vc); return false; }
  viewConfigs_[0] = viewConfigs_[1] = {XR_TYPE_VIEW_CONFIGURATION_VIEW};
  XR_CHECK(xrEnumerateViewConfigurationViews(instance_, system_, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 2, &vc, viewConfigs_), "xrEnumerateViewConfigurationViews");
  recW_ = viewConfigs_[0].recommendedImageRectWidth; recH_ = viewConfigs_[0].recommendedImageRectHeight;
  HOST_LOGI("recommended eye buffer %dx%d (max %ux%u), samples %u", recW_, recH_, viewConfigs_[0].maxImageRectWidth, viewConfigs_[0].maxImageRectHeight, viewConfigs_[0].recommendedSwapchainSampleCount);

  if (extThread_) xrGetInstanceProcAddr(instance_, "xrSetAndroidApplicationThreadKHR", &pfnSetThread_);
  if (extRefresh_) {
    xrGetInstanceProcAddr(instance_, "xrEnumerateDisplayRefreshRatesFB", (PFN_xrVoidFunction*)&pfnEnumRates_);
    xrGetInstanceProcAddr(instance_, "xrGetDisplayRefreshRateFB", (PFN_xrVoidFunction*)&pfnGetRate_);
    xrGetInstanceProcAddr(instance_, "xrRequestDisplayRefreshRateFB", (PFN_xrVoidFunction*)&pfnReqRate_);
  }
  if (extFoveation_) {
    xrGetInstanceProcAddr(instance_, "xrCreateFoveationProfileFB", (PFN_xrVoidFunction*)&pfnCreateFov_);
    xrGetInstanceProcAddr(instance_, "xrDestroyFoveationProfileFB", (PFN_xrVoidFunction*)&pfnDestroyFov_);
    xrGetInstanceProcAddr(instance_, "xrUpdateSwapchainFB", (PFN_xrVoidFunction*)&pfnUpdateSwapchain_);
    if (!foveationSupported()) { HOST_LOGW("foveation extensions listed but entry points missing; foveation off"); extFoveation_ = false; }
  }
  if (extPerf_) xrGetInstanceProcAddr(instance_, "xrPerfSettingsSetPerformanceLevelEXT", (PFN_xrVoidFunction*)&pfnPerfLevel_);
  return true;
}

bool OpenXrDevice::createSession(Egl& egl) {
#ifdef __ANDROID__
  PFN_xrGetOpenGLESGraphicsRequirementsKHR getReq = nullptr;
  xrGetInstanceProcAddr(instance_, "xrGetOpenGLESGraphicsRequirementsKHR", (PFN_xrVoidFunction*)&getReq);
  XrGraphicsRequirementsOpenGLESKHR req{XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR};
  if (getReq) { getReq(instance_, system_, &req); HOST_LOGI("GLES required %u.%u .. %u.%u", XR_VERSION_MAJOR(req.minApiVersionSupported), XR_VERSION_MINOR(req.minApiVersionSupported), XR_VERSION_MAJOR(req.maxApiVersionSupported), XR_VERSION_MINOR(req.maxApiVersionSupported)); }

  XrGraphicsBindingOpenGLESAndroidKHR gb{XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR};
  gb.display = egl.display(); gb.config = egl.config(); gb.context = egl.context();
#else
  // The requirements call the runtime insists on (the structures of the GL and GLES variants share one layout).
  if (glReqExt_) {
    const bool es = !strcmp(glReqExt_, XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME);
    PFN_xrVoidFunction getReq = nullptr;
    xrGetInstanceProcAddr(instance_, es ? "xrGetOpenGLESGraphicsRequirementsKHR" : "xrGetOpenGLGraphicsRequirementsKHR", &getReq);
    XrGraphicsRequirementsOpenGLESKHR req{es ? XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR : XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_KHR};
    if (getReq) { ((PFN_xrGetOpenGLESGraphicsRequirementsKHR)getReq)(instance_, system_, &req);
      HOST_LOGI("%s required %u.%u .. %u.%u", es ? "GLES" : "GL", XR_VERSION_MAJOR(req.minApiVersionSupported), XR_VERSION_MINOR(req.minApiVersionSupported), XR_VERSION_MAJOR(req.maxApiVersionSupported), XR_VERSION_MINOR(req.maxApiVersionSupported)); }
  }
  XrGraphicsBindingEGLMNDX gb{XR_TYPE_GRAPHICS_BINDING_EGL_MNDX};
  gb.getProcAddress = reinterpret_cast<PFN_xrEglGetProcAddressMNDX>(eglGetProcAddress); gb.display = egl.display(); gb.config = egl.config(); gb.context = egl.context();
#endif
  XrSessionCreateInfo sci{XR_TYPE_SESSION_CREATE_INFO}; sci.next = &gb; sci.systemId = system_;
  XR_CHECK(xrCreateSession(instance_, &sci, &session_), "xrCreateSession");

  uint32_t nsp = 0; xrEnumerateReferenceSpaces(session_, 0, &nsp, nullptr);
  std::vector<XrReferenceSpaceType> spaces(nsp); xrEnumerateReferenceSpaces(session_, nsp, &nsp, spaces.data());
  auto hasSpace = [&](XrReferenceSpaceType t) { return std::find(spaces.begin(), spaces.end(), t) != spaces.end(); };
  XrReferenceSpaceCreateInfo rs{XR_TYPE_REFERENCE_SPACE_CREATE_INFO}; rs.poseInReferenceSpace.orientation.w = 1;
  rs.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL; XR_CHECK(xrCreateReferenceSpace(session_, &rs, &localSpace_), "local space");
  rs.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW; XR_CHECK(xrCreateReferenceSpace(session_, &rs, &viewSpace_), "view space");
  if (hasSpace(XR_REFERENCE_SPACE_TYPE_STAGE)) { rs.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_STAGE; XR_CHECK(xrCreateReferenceSpace(session_, &rs, &stageSpace_), "stage space"); updateBounds(); }
  HOST_LOGI("reference spaces: local, view%s", stageSpace_ ? ", stage" : "");

  if (extColorSpace_) {
    PFN_xrSetColorSpaceFB setCs = nullptr; xrGetInstanceProcAddr(instance_, "xrSetColorSpaceFB", (PFN_xrVoidFunction*)&setCs);
    if (setCs) { XrResult r = setCs(session_, XR_COLOR_SPACE_REC709_FB); HOST_LOGI("color space REC709: %s", xrResultName(instance_, r)); }
  }
  enumerateRefreshRates();
  scene_.init(instance_, session_, sceneExt_);
  if (!input_.create(instance_, session_, extHand_, extHandAim_)) HOST_LOGW("input setup failed; continuing without controllers");
  return true;
}

void OpenXrDevice::updateBounds() {
  XrExtent2Df ext{};
  if (stageSpace_ && XR_SUCCEEDED(xrGetReferenceSpaceBoundsRect(session_, XR_REFERENCE_SPACE_TYPE_STAGE, &ext))) { boundsW_ = ext.width; boundsD_ = ext.height; HOST_LOGI("stage bounds %.2f x %.2f m", boundsW_, boundsD_); }
  else boundsW_ = boundsD_ = 0;
}

void OpenXrDevice::enumerateRefreshRates() {
  rates_.clear(); rate_ = 0;
  if (!extRefresh_ || !pfnEnumRates_) return;
  uint32_t n = 0; pfnEnumRates_(session_, 0, &n, nullptr); rates_.resize(n); pfnEnumRates_(session_, n, &n, rates_.data());
  pfnGetRate_(session_, &rate_);
  std::string s; for (float r : rates_) { char b[16]; snprintf(b, sizeof b, "%.0f ", r); s += b; }
  HOST_LOGI("refresh rates: [%s] current %.0f", s.c_str(), rate_);
}

bool OpenXrDevice::requestRefreshRate(float hz) {
  if (!extRefresh_ || !pfnReqRate_) return false;
  XrResult r = pfnReqRate_(session_, hz);
  HOST_LOGI("request refresh %.0f Hz: %s", hz, xrResultName(instance_, r));
  return XR_SUCCEEDED(r);
}

// WebXR fixedFoveation 0..1 onto XR_FB_foveation's four levels: nearest of 0, 1/3, 2/3, 1 (the example levels
// the WebXR spec and MDN give for "none, low, medium, maximum", which is what the Quest Browser maps to).
static XrFoveationLevelFB foveationLevelFor(float v) {
  int i = (int)(v * 3.0f + 0.5f); if (i < 0) i = 0; if (i > 3) i = 3;
  return (XrFoveationLevelFB)i;  // NONE 0, LOW 1, MEDIUM 2, HIGH 3
}
static const char* foveationName(int l) { static const char* n[] = {"NONE", "LOW", "MEDIUM", "HIGH"}; return l >= 0 && l < 4 ? n[l] : "unset"; }

bool OpenXrDevice::setFoveation(float level01) {
  if (!(level01 >= 0)) level01 = 0; if (level01 > 1) level01 = 1;
  fovWanted_ = level01;
  if (swapchain_ == XR_NULL_HANDLE) return foveationSupported();  // applied by createSwapchain before the first frame
  return applyFoveation();
}

// Hands the current swapchain a profile for fovWanted_. The profile is destroyed right after xrUpdateSwapchainFB:
// the spec lets it go once applied ("does not affect the foveation parameters of the swapchain"), so nothing leaks
// per call. On Quest's GLES runtime this ends up as QCOM_texture_foveated parameters on every swapchain image;
// no XrSwapchainCreateInfoFoveationFB flag is needed (its two flags are for Vulkan FDM and GLES scaled-bin opt-in).
bool OpenXrDevice::applyFoveation() {
  if (fovWanted_ < 0 || swapchain_ == XR_NULL_HANDLE) return false;
  if (!foveationSupported()) { HOST_LOGW("foveation swapchain #%u: %.2f wanted, XR_FB_foveation unavailable", swapchainSerial_, fovWanted_); return false; }
  XrFoveationLevelFB lvl = foveationLevelFor(fovWanted_);
  if ((int)lvl == fovApplied_ && fovDynamic_ == fovAppliedDynamic_) return true;
  XrFoveationLevelProfileCreateInfoFB lp{XR_TYPE_FOVEATION_LEVEL_PROFILE_CREATE_INFO_FB};
  lp.level = lvl; lp.verticalOffset = 0;  // degrees; Quest's own default, and WebXR has no way to ask for another
  lp.dynamic = fovDynamic_ ? XR_FOVEATION_DYNAMIC_LEVEL_ENABLED_FB : XR_FOVEATION_DYNAMIC_DISABLED_FB;
  XrFoveationProfileCreateInfoFB pc{XR_TYPE_FOVEATION_PROFILE_CREATE_INFO_FB}; pc.next = &lp;
  XrFoveationProfileFB profile = XR_NULL_HANDLE;
  XrResult r = pfnCreateFov_(session_, &pc, &profile);
  if (XR_SUCCEEDED(r)) {
    XrSwapchainStateFoveationFB st{XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB}; st.profile = profile;
    r = pfnUpdateSwapchain_(swapchain_, (XrSwapchainStateBaseHeaderFB*)&st);
    pfnDestroyFov_(profile);
  }
  HOST_LOGI("foveation swapchain #%u: %.2f -> %s%s offset 0: %s", swapchainSerial_, fovWanted_, foveationName(lvl), fovDynamic_ ? " dynamic" : "", xrResultName(instance_, r));
  if (XR_FAILED(r)) return false;
  fovApplied_ = (int)lvl; fovAppliedDynamic_ = fovDynamic_;
  return true;
}

static const char* perfLevelName(int l) {
  switch (l) { case XR_PERF_SETTINGS_LEVEL_POWER_SAVINGS_EXT: return "PS"; case XR_PERF_SETTINGS_LEVEL_SUSTAINED_LOW_EXT: return "SL";
    case XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT: return "SH"; case XR_PERF_SETTINGS_LEVEL_BOOST_EXT: return "BOOST"; default: return "-"; }
}

// Sets CPU and GPU to start (or BOOST while boosted), each capped by the last thermal notification for its domain.
void OpenXrDevice::applyPerfLevels() {
  if (!perfCfg_.enabled || !pfnPerfLevel_ || session_ == XR_NULL_HANDLE) return;
  for (int d = 0; d < 2; ++d) {
    int want = perfBoost_ ? (int)XR_PERF_SETTINGS_LEVEL_BOOST_EXT : perfCfg_.startLevel;
    if (want > perfCap_[d]) want = perfCap_[d];
    if (want == perfLevel_[d]) continue;
    XrPerfSettingsDomainEXT dom = d == 0 ? XR_PERF_SETTINGS_DOMAIN_CPU_EXT : XR_PERF_SETTINGS_DOMAIN_GPU_EXT;
    XrResult r = pfnPerfLevel_(session_, dom, (XrPerfSettingsLevelEXT)want);
    HOST_LOGI("perf %s %s -> %s: %s", d == 0 ? "cpu" : "gpu", perfLevelName(perfLevel_[d]), perfLevelName(want), xrResultName(instance_, r));
    if (XR_SUCCEEDED(r)) perfLevel_[d] = want;
  }
}

// Per frame, no allocation: a frame whose predicted display time moved by more than 1.5 periods missed at least one
// vsync. Over each window: bad (misses >= ratio) -> BOOST; stableWindows good ones in a row -> back to start.
void OpenXrDevice::perfFrame(XrTime predicted, XrDuration period) {
  if (state_ != XR_SESSION_STATE_FOCUSED && state_ != XR_SESSION_STATE_VISIBLE) { perfLastPredicted_ = 0; return; }  // system UI up: not our misses
  if (perfLastPredicted_ != 0 && period > 0 && predicted - perfLastPredicted_ > period + period / 2) { perfWinMisses_++; perfMissesStat_++; }
  perfLastPredicted_ = predicted;
  if (!perfCfg_.adaptive || !pfnPerfLevel_ || !perfCfg_.enabled) return;
  if (++perfWinFrames_ < perfCfg_.window) return;
  int threshold = (int)(perfCfg_.missRatio * perfCfg_.window); if (threshold < 1) threshold = 1;
  if (perfWinMisses_ >= threshold) {
    perfStable_ = 0;
    if (!perfBoost_) { HOST_LOGI("perf: %d/%d frames missed, boosting", perfWinMisses_, perfWinFrames_); perfBoost_ = true; applyPerfLevels(); }
  } else if (perfBoost_ && ++perfStable_ >= perfCfg_.stableWindows) {
    HOST_LOGI("perf: %d stable windows, back to %s", perfStable_, perfLevelName(perfCfg_.startLevel)); perfBoost_ = false; perfStable_ = 0; applyPerfLevels();
  }
  perfWinFrames_ = 0; perfWinMisses_ = 0;
}

std::string OpenXrDevice::perfLine() {
  char b[96];
  snprintf(b, sizeof b, "fov %s perf cpu %s gpu %s miss %d", foveationName(fovApplied_), perfLevelName(perfLevel_[0]), perfLevelName(perfLevel_[1]), perfMissesStat_);
  perfMissesStat_ = 0; return b;
}

bool OpenXrDevice::createSwapchain(const SwapchainDesc& d) {
  destroySwapchain();
  if (rates_.empty()) enumerateRefreshRates();  // a session created with the headset off lists none; ask again now
  // Re-read the recommended view size now: queried while the headset is off (a launch from the
  // desk) the runtime answers 1920x1080, and the eye buffer must follow what it says at session time.
  { uint32_t vc = 2; XrViewConfigurationView v[2] = {{XR_TYPE_VIEW_CONFIGURATION_VIEW}, {XR_TYPE_VIEW_CONFIGURATION_VIEW}};
    if (XR_SUCCEEDED(xrEnumerateViewConfigurationViews(instance_, system_, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 2, &vc, v)) && vc >= 1 && v[0].recommendedImageRectWidth > 0) {
      if ((int)v[0].recommendedImageRectWidth != recW_ || (int)v[0].recommendedImageRectHeight != recH_) HOST_LOGI("recommended eye buffer now %ux%u (was %dx%d)", v[0].recommendedImageRectWidth, v[0].recommendedImageRectHeight, recW_, recH_);
      recW_ = v[0].recommendedImageRectWidth; recH_ = v[0].recommendedImageRectHeight; viewConfigs_[0] = v[0]; viewConfigs_[1] = v[1]; } }
  uint32_t nf = 0; xrEnumerateSwapchainFormats(session_, 0, &nf, nullptr);
  std::vector<int64_t> fmts(nf); xrEnumerateSwapchainFormats(session_, nf, &nf, fmts.data());
  int64_t fmt = d.glFormat;
  if (std::find(fmts.begin(), fmts.end(), fmt) == fmts.end()) { HOST_LOGW("swapchain format 0x%llx unsupported; using 0x%llx", (long long)fmt, (long long)fmts[0]); fmt = fmts[0]; }
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_SAMPLED_BIT;
  ci.format = fmt; ci.sampleCount = std::max(1, d.samples);
  ci.width = d.width > 0 ? d.width : (uint32_t)(recW_ * (d.scale > 0 ? d.scale : 1.0)); ci.height = d.height > 0 ? d.height : (uint32_t)(recH_ * (d.scale > 0 ? d.scale : 1.0));
  ci.faceCount = 1; ci.arraySize = std::max(1, d.arraySize); ci.mipCount = 1;
  if (ci.arraySize == 1) ci.width *= 2;  // side-by-side
  XR_CHECK(xrCreateSwapchain(session_, &ci, &swapchain_), "xrCreateSwapchain");
  swapchainSerial_++; fovApplied_ = -1;
  uint32_t ni = 0; xrEnumerateSwapchainImages(swapchain_, 0, &ni, nullptr);
  std::vector<XrSwapchainImageOpenGLESKHR> imgs(ni, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
  XR_CHECK(xrEnumerateSwapchainImages(swapchain_, ni, &ni, (XrSwapchainImageBaseHeader*)imgs.data()), "xrEnumerateSwapchainImages");
  scImages_.clear(); for (auto& i : imgs) scImages_.push_back(i.image);
  scW_ = ci.width; scH_ = ci.height; scArray_ = ci.arraySize; scFormat_ = fmt;
  HOST_LOGI("swapchain #%u %ux%u x%u fmt 0x%llx, %u images", swapchainSerial_, ci.width, ci.height, ci.arraySize, (long long)fmt, ni);
  // A new swapchain starts unfoveated: hand it the remembered level now, before its first frame.
  if (fovWanted_ >= 0) applyFoveation();
  else HOST_LOGI("foveation swapchain #%u: NONE (not set)%s", swapchainSerial_, foveationSupported() ? "" : ", XR_FB_foveation unavailable");
  unpremultiplied_ = d.unpremultiplied;
  blendAlpha_ = d.passthrough && scene_.startPassthrough();
  if (d.passthrough && !blendAlpha_) HOST_LOGW("passthrough asked for but unavailable; compositing opaque");
  if (d.scene) scene_.startScene();
  return true;
}

void OpenXrDevice::destroySwapchain() {
  if (swapchain_) { xrDestroySwapchain(swapchain_); swapchain_ = XR_NULL_HANDLE; scImages_.clear(); }
  fovApplied_ = -1;
  if (blendAlpha_) scene_.stopPassthrough(); blendAlpha_ = false;
  if (scene_.sceneActive()) scene_.stopScene();
}

#ifdef __ANDROID__
bool OpenXrDevice::declareThread(XrAndroidThreadTypeKHR type, uint32_t tid) {
  if (!pfnSetThread_ || !session_) return false;
  XrResult r = ((PFN_xrSetAndroidApplicationThreadKHR)pfnSetThread_)(session_, type, tid);
  if (XR_FAILED(r)) { HOST_LOGW("xrSetAndroidApplicationThreadKHR(%d, %u): %s", (int)type, tid, xrResultName(instance_, r)); return false; }
  return true;
}
#endif

bool OpenXrDevice::beginSession() {
  XrSessionBeginInfo bi{XR_TYPE_SESSION_BEGIN_INFO}; bi.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
  XR_CHECK(xrBeginSession(session_, &bi), "xrBeginSession");
  running_ = true; input_.attach(); HOST_LOGI("session begun");
  perfLastPredicted_ = 0; perfWinFrames_ = perfWinMisses_ = perfStable_ = 0;
  if (!extPerf_) HOST_LOGI("perf: XR_EXT_performance_settings unavailable");
  else if (!perfCfg_.enabled) HOST_LOGI("perf: levels left to the runtime (host.json xr.perf.enabled false)");
  else { HOST_LOGI("perf: start %s, adaptive %d (window %d frames, miss ratio %.2f, %d stable windows)", perfLevelName(perfCfg_.startLevel), perfCfg_.adaptive, perfCfg_.window, perfCfg_.missRatio, perfCfg_.stableWindows); perfLevel_[0] = perfLevel_[1] = -1; applyPerfLevels(); }
  return true;
}
bool OpenXrDevice::endSession() { XR_CHECK(xrEndSession(session_), "xrEndSession"); running_ = false; HOST_LOGI("session ended"); return true; }
void OpenXrDevice::requestExit() { if (session_ && running_) xrRequestExitSession(session_); exitRequested_ = true; }

bool OpenXrDevice::pollEvents() {
  XrEventDataBuffer ev{XR_TYPE_EVENT_DATA_BUFFER};
  while (xrPollEvent(instance_, &ev) == XR_SUCCESS) {
    switch (ev.type) {
      case XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED: {
        auto* e = (XrEventDataSessionStateChanged*)&ev; state_ = e->state;
        static const char* names[] = {"UNKNOWN", "IDLE", "READY", "SYNCHRONIZED", "VISIBLE", "FOCUSED", "STOPPING", "LOSS_PENDING", "EXITING"};
        HOST_LOGI("session state %s", (int)state_ < 9 ? names[(int)state_] : "?");
        if (state_ == XR_SESSION_STATE_READY) beginSession();
        else if (state_ == XR_SESSION_STATE_STOPPING) endSession();
        else if (state_ == XR_SESSION_STATE_EXITING || state_ == XR_SESSION_STATE_LOSS_PENDING) return false;
        break; }
      case XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING: HOST_LOGE("instance loss pending"); return false;
      case XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING: refChanged_ = true; updateBounds(); break;
      case XR_TYPE_EVENT_DATA_DISPLAY_REFRESH_RATE_CHANGED_FB: { auto* e = (XrEventDataDisplayRefreshRateChangedFB*)&ev; rate_ = e->toDisplayRefreshRate; rateChanged_ = true; HOST_LOGI("refresh rate %.0f -> %.0f", e->fromDisplayRefreshRate, e->toDisplayRefreshRate); break; }
      case XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED: HOST_LOGI("interaction profile changed"); break;
      case XR_TYPE_EVENT_DATA_PERF_SETTINGS_EXT: {
        auto* e = (XrEventDataPerfSettingsEXT*)&ev;
        static const char* sub[] = {"?", "compositing", "rendering", "thermal"};
        auto notif = [](int l) { return l == XR_PERF_SETTINGS_NOTIF_LEVEL_NORMAL_EXT ? "normal" : l == XR_PERF_SETTINGS_NOTIF_LEVEL_WARNING_EXT ? "warning" : l == XR_PERF_SETTINGS_NOTIF_LEVEL_IMPAIRED_EXT ? "impaired" : "?"; };
        int d = e->domain == XR_PERF_SETTINGS_DOMAIN_GPU_EXT ? 1 : 0;
        HOST_LOGW("perf event: %s %s %s -> %s", d ? "gpu" : "cpu", (int)e->subDomain >= 1 && (int)e->subDomain <= 3 ? sub[e->subDomain] : "?", notif(e->fromLevel), notif(e->toLevel));
        if (e->subDomain == XR_PERF_SETTINGS_SUB_DOMAIN_THERMAL_EXT) {
          // Thermal: no BOOST once warned; SUSTAINED_LOW once impaired (the runtime is throttling anyway); lifted on normal.
          perfCap_[d] = e->toLevel == XR_PERF_SETTINGS_NOTIF_LEVEL_IMPAIRED_EXT ? XR_PERF_SETTINGS_LEVEL_SUSTAINED_LOW_EXT : e->toLevel == XR_PERF_SETTINGS_NOTIF_LEVEL_WARNING_EXT ? XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT : XR_PERF_SETTINGS_LEVEL_BOOST_EXT;
          applyPerfLevels();
        }
        break; }
      default: scene_.handleEvent(ev); break;
    }
    ev = {XR_TYPE_EVENT_DATA_BUFFER};
  }
  return true;
}

bool OpenXrDevice::waitFrame() {
  if (!running_) return false;
  XrFrameWaitInfo wi{XR_TYPE_FRAME_WAIT_INFO}; frameState_ = {XR_TYPE_FRAME_STATE};
  auto nowMs = [] { return (double)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count() / 1000.0; };
  double tA = nowMs();
  if (XR_FAILED(xrWaitFrame(session_, &wi, &frameState_))) return false;
  // A runtime without XR_FB_display_refresh_rate (a desktop runtime may lack it) still has a display period: the
  // rate is that, announced to the page like a refresh change when it first becomes known or moves.
  if (!extRefresh_ && frameState_.predictedDisplayPeriod > 0) {
    const float hz = (float)(1e9 / (double)frameState_.predictedDisplayPeriod);
    if (std::fabs(hz - rate_) > 0.5f) { rate_ = hz; rates_ = {hz}; rateChanged_ = true; HOST_LOGI("display period %.2f ms: %.1f Hz", frameState_.predictedDisplayPeriod / 1e6, hz); }
  }
  double tB = nowMs(); prof_[0] += tB - tA; wakeMs_ = tB;
  return true;
}

bool OpenXrDevice::beginFrame(XrFrameInfo& out, double loopNowMs) { return waitFrame() && beginWaited(out, loopNowMs); }

bool OpenXrDevice::beginWaited(XrFrameInfo& out, double loopNowMs) {
  if (!running_) return false;
  if (!beginOnly()) return false;
  locateWaited(out, loopNowMs);
  acquire(out);
  return true;
}

static double xrNowMs() { return (double)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count() / 1000.0; }

bool OpenXrDevice::beginOnly() {
  if (!running_) return false;
  const double tB = xrNowMs();
  XrFrameBeginInfo bi{XR_TYPE_FRAME_BEGIN_INFO};
  if (XR_FAILED(xrBeginFrame(session_, &bi))) return false;
  prof_[1] += xrNowMs() - tB;
  return true;
}

void OpenXrDevice::locateWaited(XrFrameInfo& out, double loopNowMs) {
  const double tC = xrNowMs();
  perfFrame(frameState_.predictedDisplayTime, frameState_.predictedDisplayPeriod);
  out.displayTime = frameState_.predictedDisplayTime; out.shouldRender = frameState_.shouldRender;
  // Map the predicted time onto the loop clock: now + (predicted - now_xr). xrConvertTime is an extension; approximate with the period.
  out.displayTimeMs = loopNowMs + frameState_.predictedDisplayPeriod / 1e6;
  XrSpace base = baseSpace();
  XrViewLocateInfo li{XR_TYPE_VIEW_LOCATE_INFO}; li.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO; li.displayTime = out.displayTime; li.space = base;
  XrViewState vs{XR_TYPE_VIEW_STATE}; XrView views[2] = {{XR_TYPE_VIEW}, {XR_TYPE_VIEW}}; uint32_t nv = 0;
  xrLocateViews(session_, &li, &vs, 2, &nv, views);
  out.viewCount = nv;
  for (uint32_t i = 0; i < nv; ++i) {
    auto& v = out.views[i]; const auto& p = views[i].pose;
    v.pos[0] = p.position.x; v.pos[1] = p.position.y; v.pos[2] = p.position.z;
    v.quat[0] = p.orientation.x; v.quat[1] = p.orientation.y; v.quat[2] = p.orientation.z; v.quat[3] = p.orientation.w;
    v.fovL = views[i].fov.angleLeft; v.fovR = views[i].fov.angleRight; v.fovU = views[i].fov.angleUp; v.fovD = views[i].fov.angleDown;
    out.viewPose[i] = p; out.viewFov[i] = views[i].fov;
  }
  if (stageSpace_) {
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION}; xrLocateSpace(localSpace_, stageSpace_, out.displayTime, &loc);
    out.localInBasePos[0] = loc.pose.position.x; out.localInBasePos[1] = loc.pose.position.y; out.localInBasePos[2] = loc.pose.position.z;
    out.localInBaseQuat[0] = loc.pose.orientation.x; out.localInBaseQuat[1] = loc.pose.orientation.y; out.localInBaseQuat[2] = loc.pose.orientation.z; out.localInBaseQuat[3] = loc.pose.orientation.w;
  }
  if (scene_.sceneActive()) scene_.locate(base, out.displayTime);
  out.sceneGeneration = scene_.generation();
  const double tD = xrNowMs(); prof_[2] += tD - tC;
  input_.sync(session_, base, out.displayTime, out.input);
  prof_[3] += xrNowMs() - tD;
  out.width = scW_; out.height = scH_; out.arraySize = scArray_;
}

void OpenXrDevice::acquire(XrFrameInfo& out) {
  const double tE = xrNowMs();
  out.colorTexture = 0; out.width = scW_; out.height = scH_; out.arraySize = scArray_;
  if (out.shouldRender && swapchain_) {
    XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
    if (XR_SUCCEEDED(xrAcquireSwapchainImage(swapchain_, &ai, &out.imageIndex))) {
      XrSwapchainImageWaitInfo wi2{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO}; wi2.timeout = XR_INFINITE_DURATION;
      if (XR_SUCCEEDED(xrWaitSwapchainImage(swapchain_, &wi2))) out.colorTexture = scImages_[out.imageIndex];
      else { xrReleaseSwapchainImage(swapchain_, nullptr); }
      prof_[4] += xrNowMs() - tE; profN_++;
    }
  }
}

std::string OpenXrDevice::profileLine() {
  char b[160]; int n = profN_ > 0 ? profN_ : 1;
  snprintf(b, sizeof b, "waitFrame %.2f begin %.2f views %.2f input %.2f acquire %.2f", prof_[0] / n, prof_[1] / n, prof_[2] / n, prof_[3] / n, prof_[4] / n);
  for (double& v : prof_) v = 0; profN_ = 0; return b;
}

void OpenXrDevice::endFrame(const XrFrameInfo& f, bool submit) {
  if (!running_) return;
  if (f.colorTexture) { XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO}; xrReleaseSwapchainImage(swapchain_, &ri); }
  XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};
  const XrCompositionLayerBaseHeader* layers[2] = {(XrCompositionLayerBaseHeader*)&layer, nullptr};
  // Quest composites passthrough as a LAYER (the runtime offers only OPAQUE as a blend mode): it goes under the
  // projection layer, whose texels are then blended by their alpha — what the browser does for immersive-ar.
  XrFrameEndInfo ei{XR_TYPE_FRAME_END_INFO}; ei.displayTime = f.displayTime; ei.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
  if (submit && f.colorTexture && f.shouldRender) {
    for (uint32_t i = 0; i < 2; ++i) {
      projViews_[i] = {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}; projViews_[i].pose = f.viewPose[i]; projViews_[i].fov = f.viewFov[i];
      projViews_[i].subImage.swapchain = swapchain_;
      projViews_[i].subImage.imageArrayIndex = scArray_ > 1 ? i : 0;
      int eyeW = scArray_ > 1 ? scW_ : scW_ / 2;
      projViews_[i].subImage.imageRect.offset = {scArray_ > 1 ? 0 : (int)i * eyeW, 0};
      projViews_[i].subImage.imageRect.extent = {eyeW, scH_};
    }
    layer.space = baseSpace(); layer.viewCount = 2; layer.views = projViews_; layer.layerFlags = 0;
    ei.layerCount = 1; ei.layers = layers;
    const XrCompositionLayerBaseHeader* pt = blendAlpha_ ? scene_.passthroughLayer() : nullptr;
    if (pt) {
      layers[0] = pt; layers[1] = (XrCompositionLayerBaseHeader*)&layer; ei.layerCount = 2;
      layer.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT | (unpremultiplied_ ? XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT : 0);
    }
  }
  XrResult r = xrEndFrame(session_, &ei);
  if (XR_FAILED(r)) HOST_LOGW("xrEndFrame: %s", xrResultName(instance_, r));
}

void OpenXrDevice::destroy() {
  input_.destroy();
  scene_.destroy();
  destroySwapchain();
  if (localSpace_) xrDestroySpace(localSpace_); if (stageSpace_) xrDestroySpace(stageSpace_); if (viewSpace_) xrDestroySpace(viewSpace_);
  localSpace_ = stageSpace_ = viewSpace_ = XR_NULL_HANDLE;
  if (session_) xrDestroySession(session_); session_ = XR_NULL_HANDLE;
  if (instance_) xrDestroyInstance(instance_); instance_ = XR_NULL_HANDLE;
}

}  // namespace host
