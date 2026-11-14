#include "app/host.h"
#include "core/log.h"
#include "js/console.h"
#include "xr/xr_frame_bridge.h"
#include "android/permissions.h"
#include "android/display.h"
#include "audio/device.h"
#include "gl/touch_controls.h"
#include "gl/pack_guard.h"
#include "gl/gl_queue.h"
#include "gl/webgl_bind.h"
#include "js/dom_input.h"
#include "js/intl.h"
#include <android/configuration.h>
#include <android/input.h>
#include <android/keycodes.h>
#include <android/window.h>
#include <android/choreographer.h>
#include <android/looper.h>
#include <dlfcn.h>
#include <sys/system_properties.h>
#include <ctime>
#include <android_native_app_glue.h>
#include <android/asset_manager.h>
#include <android/native_window.h>
#include <chrono>
#include <thread>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace host {

static const char* kScenePermission = "com.oculus.permission.USE_SCENE";

#ifdef HOST_V8_INTL
// Intl (host.json js.intl, WP-24): ICU's defaults from the system's locale (the activity's configuration: the user's
// first language, or the app's own on Android 13+) and time zone (persist.sys.timezone, the property bionic's
// localtime reads; an app has no TZ), before the isolate exists (js/intl.h).
static void startIntl(AConfiguration* config) {
  char lang[3] = {}, country[3] = {};
  if (config) { AConfiguration_getLanguage(config, lang); AConfiguration_getCountry(config, country); }
  std::string tag = lang; if (!tag.empty() && country[0]) tag += std::string("-") + country;
  char zone[PROP_VALUE_MAX] = {}; __system_property_get("persist.sys.timezone", zone);
  intl::init(tag, zone);
}
#endif

// Pipelined XR frames (gl.pipeline): the GL thread's half of a frame, recorded as two commands around the page's.
// The frame it begins and ends lives here (GL thread only); the host thread has moved on to the next one by then.
static Host* g_pipeHost = nullptr;
static XrFrameInfo g_glFrame;
static bool g_glBegun = false;
enum : uint32_t { kOpXrBegin = 40, kOpXrEnd = 41 };
struct PipeEnd { XrTime displayTime; uint32_t shouldRender; uint32_t pad; XrPosef pose[2]; XrFovf fov[2]; };
constexpr uint32_t kPipeEndWords = (uint32_t)((sizeof(PipeEnd) + 3) / 4);

Host::Host(android_app* app) : app_(app) {}
Host::~Host() {
  if (inspector_) inspector_->stop();
  if (jsUp_) { store_.flush(); shutdownWorkers(); http_.shutdown(); store_.flush(); gc_.detach(); loop_.clear(); modules_.reset(); engine_.destroy(); Engine::shutdownPlatform(); }  // the saves first: nothing after may hold them up; the page's pending timers and tasks before the engine (they hold its handles)
  if (clearUp_) clear_.shutdown();
  glq::stop();  // the context back on this thread for the teardown below
  if (xrInstance_) xr_.destroy();
  if (eglUp_) egl_.shutdown();
  display_.shutdown();  // detaches this thread from the JVM (it ends after this)
}

bool Host::start() {
  assets_.init(assetMgr_ ? assetMgr_ : app_->activity->assetManager);
  std::string text; std::string err;
  config_ = assets_.read("host.json", text) ? Json::parse(text, &err) : Json();
  if (!err.empty()) HOST_LOGE("host.json: %s", err.c_str());
  mode_ = config_.s("mode", config_.get("web") ? "js" : "native-clear");
  phone_ = config_.at("android").s("formFactor", "quest") == "phone";
  frameRate_ = std::clamp((float)config_.at("android").n("frameRate", 60), 30.f, 240.f);
  if (phone_) { display_.init(app_->activity->vm, app_->activity->clazz); requestVsync(); }
  if (phone_) { const int32_t d = AConfiguration_getDensity(app_->config); dpr_ = d > 0 && d != ACONFIGURATION_DENSITY_ANY ? d / 160.f : 1.f; ANativeActivity_setWindowFlags(app_->activity, AWINDOW_FLAG_KEEP_SCREEN_ON | AWINDOW_FLAG_FULLSCREEN, 0); }
  HOST_LOGI("webxr-host starting, mode=%s%s", mode_.c_str(), phone_ ? ", phone" : "");
  if (!egl_.init()) return false; eglUp_ = true;
  if (mode_ == "native-clear") return startNativeClear();
  if (mode_ == "panel-clear") { if (!clear_.init()) return false; clearUp_ = true; return true; }
  return startJs();
}

bool Host::startXrInstance() {
  if (xrInstance_) return true;
  xr_.setRenderModels(config_.at("xr").bo("renderModels", false));
  if (!xr_.createInstance(app_)) return false;
  { const Json& x = config_.at("xr"); const Json& p = x.at("perf"); PerfConfig pc;
    std::string lvl = p.s("start", "sustained_high");
    pc.startLevel = lvl == "boost" ? XR_PERF_SETTINGS_LEVEL_BOOST_EXT : lvl == "sustained_low" ? XR_PERF_SETTINGS_LEVEL_SUSTAINED_LOW_EXT : lvl == "power_savings" ? XR_PERF_SETTINGS_LEVEL_POWER_SAVINGS_EXT : XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT;
    pc.enabled = p.bo("enabled", true); pc.adaptive = p.bo("adaptive", true);
    pc.window = std::max(10, (int)p.n("window", 90)); pc.missRatio = (float)p.n("missRatio", 0.05); pc.stableWindows = std::max(1, (int)p.n("stableWindows", 5));
    xr_.setPerfConfig(pc);
    xr_.setFoveationDynamic(x.bo("foveationDynamic", false));
    invalidateAcquire_ = x.bo("invalidate", true);
    xr_.setPreferLocalFloor(x.s("baseSpace", "stage") == "local-floor"); }
  if (!glq::sync("createSession", [&] { return xr_.createSession(egl_); })) return false;
  xrInstance_ = true; xrSession_ = true;
  // The frame's threads, for the runtime's scheduler (XR_KHR_android_thread_settings; host.json xr.threadHints,
  // debug.webxr.threadhints 0|1 over it): this thread runs the page (APPLICATION_MAIN; RENDERER_MAIN as well
  // when it also does the GL), the GL thread renders.
  { bool hints = config_.at("xr").bo("threadHints", false);
    char v[PROP_VALUE_MAX] = {}; if (__system_property_get("debug.webxr.threadhints", v) > 0 && (v[0] == '0' || v[0] == '1')) hints = v[0] == '1';
    if (hints) {
      const uint32_t self = (uint32_t)gettid();
      for (int i = 0; i < 100 && glq::active() && !glq::threadId(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
      const bool a = xr_.declareThread(glq::active() ? XR_ANDROID_THREAD_TYPE_APPLICATION_MAIN_KHR : XR_ANDROID_THREAD_TYPE_RENDERER_MAIN_KHR, self);
      const bool b = glq::active() && xr_.declareThread(XR_ANDROID_THREAD_TYPE_RENDERER_MAIN_KHR, (uint32_t)glq::threadId());
      HOST_LOGI("thread hints: host %u %s%s", self, a ? "declared" : "not declared", glq::active() ? (b ? ", gl thread declared" : ", gl thread not declared") : "");
    } }
  svc_.systemName = xr_.systemName();
  return true;
}

bool Host::startNativeClear() {
  if (!clear_.init()) return false; clearUp_ = true;
  if (!startXrInstance()) return false;
  SwapchainDesc d; d.arraySize = (int)config_.at("xr").n("arraySize", 2);
  if (!xr_.createSwapchain(d)) return false;
  xrActive_ = true;
  double rate = config_.at("xr").n("preferredRate", 0); if (rate > 0) xr_.requestRefreshRate((float)rate);
  double fov = config_.at("xr").n("foveation", -1); if (fov >= 0) xr_.setFoveation((float)fov);
  return true;
}

bool Host::startJs() {
  std::string snapshot; assets_.read("snapshot_blob.bin", snapshot);
  gcCfg_ = GcConfig::fromJson(config_.at("gc"));
  // The GL thread (gl/gl_queue.h, host.json gl.thread): from here on the context is current there, and everything
  // below that touches GL or the swapchains runs through glq::sync (inline when the thread is off).
  // A/B without repacking: `adb shell setprop debug.webxr.glthread 1` (or 0) overrides host.json (tools/bench.mjs).
  bool glThread = config_.at("gl").bo("thread", true);  // on by default on Quest (WP-23); the phone keeps one thread
  { char v[PROP_VALUE_MAX] = {}; if (__system_property_get("debug.webxr.glthread", v) > 0 && (v[0] == '0' || v[0] == '1')) { glThread = v[0] == '1'; HOST_LOGI("gl thread %s (debug.webxr.glthread)", glThread ? "on" : "off"); } }
  if (!phone_ && glThread) {
    const size_t ring = (size_t)std::max(1.0, config_.at("gl").n("threadRingMB", 8)) << 20;
    if (!glq::start(egl_, ring)) HOST_LOGW("gl thread: could not start; GL runs on the host thread");
  }
  if (glq::active()) {
    pipeline_ = config_.at("gl").bo("pipeline", false);
    char v[PROP_VALUE_MAX] = {}; if (__system_property_get("debug.webxr.glpipeline", v) > 0 && (v[0] == '0' || v[0] == '1')) pipeline_ = v[0] == '1';
    g_pipeHost = this;
    glq::registerOp(kOpXrBegin, &Host::opXrBegin); glq::registerOp(kOpXrEnd, &Host::opXrEnd);
    // The headset off (STOPPING): the session ends from the host thread while the GL thread may still be in the last
    // frame's xrEndFrame (pipelined: queued, not waited for). OpenXR wants the two serialised, so drain first.
    xr_.beforeSessionEnd = [] { glq::finish(); };
    HOST_LOGI("xr frames %s", pipeline_ ? "pipelined: the page records frame N+1 while the GL thread submits frame N" : "synchronous with the GL thread");
  }
#ifdef HOST_V8_INTL
  startIntl(app_->config);
#endif
  if (!Engine::initPlatform(std::move(snapshot), GcScheduler::v8Flags(gcCfg_))) return false;
  { v8::ResourceConstraints rc; GcScheduler::constrain(gcCfg_, rc); if (!engine_.create(gcCfg_.enabled ? &rc : nullptr)) return false; }
  jsUp_ = true;
  gc_.attach(engine_.isolate(), gcCfg_);
  // The XR instance is created at boot so navigator.xr can answer isSessionSupported honestly, and the session
  // exists before the first requestSession (Meta's runtime wants the session early for FOCUSED state).
  if (phone_) HOST_LOGI("phone: no OpenXR; the page runs flat (%.2f CSS px per pixel)", 1 / dpr_);
  else if (!startXrInstance()) HOST_LOGW("OpenXR unavailable; running flat");
  svc_.loop = &loop_; svc_.assets = &assets_; svc_.http = &http_; svc_.store = &store_; svc_.egl = &egl_; svc_.xr = xrInstance_ ? &xr_ : nullptr;
  svc_.engine = &engine_; svc_.host = this; svc_.config = &config_;
  svc_.filesDir = app_->activity->internalDataPath ? app_->activity->internalDataPath : "/data/local/tmp";
  svc_.packageName = config_.at("app").s("package", "webxr-host");
  if (phone_) { svc_.formFactor = "phone"; svc_.pageInput = true; svc_.flatScaled = true; touch::configure(config_, assets_, /*touchScreen=*/true); }
  svc_.javaVm = app_->activity->vm; svc_.activity = app_->activity->clazz;
  svc_.xrBegin = [this](const Json& o, Json& out) { return xrBegin(o, out); };
  svc_.xrEnd = [this] { xrEnd(); };
  svc_.requestExit = [this] { if (phone_) exit_ = true; else if (app_) ANativeActivity_finish(app_->activity); };  // a phone's host thread ends, then finishes the activity
  std::vector<std::string> allow; for (auto& a : config_.at("network").at("allow").arr) if (a.type == Json::String) allow.push_back(a.str);
  http_.init(app_->activity->vm, &loop_, allow);
  store_.init(svc_.filesDir + "/localStorage.json");
  std::string origin = config_.at("web").s("origin", "https://app.local");
  modules_.init(&engine_, &svc_, origin);
  if (!glq::active()) egl_.makeCurrent();
  bool ok = engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
    installConsole(ctx, [this](int level, const std::string& m) { bridgeLog(m); if (inspector_) inspector_->consoleMessage(level, m); });
    v8::Local<v8::Object> native = installNativeCore(ctx, svc_);
#ifdef HOST_HAS_MICROPHONE
    installMedia(ctx, native, svc_);  // host.json media.microphone (WP-25); before installAudio, which binds its tracks
#endif
    installWebGL(ctx, native, svc_); installImages(ctx, native, svc_); installAudio(ctx, native, svc_); installXr(ctx, native, svc_); installWorkers(ctx, native, svc_); installPlatform(ctx, native, svc_); installRtc(ctx, native, svc_); installSteam(ctx, native, svc_);
#ifdef HOST_V8_INTL
    intl::install(ctx, native);
#endif
#ifdef HOST_HAS_STORAGE
    installStorage(ctx, native, svc_);  // host.json storage.indexedDB / storage.cache (WP-26)
#endif
  });
  if (!ok) return false;
  bridge_.engine = &engine_;
  bridge_.pump = [this] { loop_.runOnce(); engine_.pump(); if (xrInstance_) xr_.pollEvents(); if (xrInstance_ && xrActive_ && xr_.sessionRunning()) xrTick(); };
  bridge_.stats = [this] { char b[512]; snprintf(b, sizeof b, "{\"fps\":%.1f,\"jsMs\":%.2f,\"rate\":%.0f,\"xr\":%s,\"state\":%d,\"timers\":%zu,\"heapMB\":%.1f,\"foveation\":%d,\"perfCpu\":%d,\"perfGpu\":%d,\"gcPre\":%ld,\"gcPost\":%ld,\"glThread\":%s,\"glBusyMs\":%.2f}", fpsNow_, jsAvg_, xrInstance_ ? xr_.refreshRate() : 0.0, (xrInstance_ && xrActive_) ? "true" : "false", xrInstance_ ? (int)xr_.state() : 0, loop_.timerCount(), heapMB(), xrInstance_ ? xr_.foveationLevel() : -1, xrInstance_ ? xr_.perfLevel(XR_PERF_SETTINGS_DOMAIN_CPU_EXT) : -1, xrInstance_ ? xr_.perfLevel(XR_PERF_SETTINGS_DOMAIN_GPU_EXT) : -1, gc_.totalPre(), gc_.totalPost(), glq::active() ? "true" : "false", glBusy_); return std::string(b); };
  bridge_.shot = [this](int eye, std::function<void(const std::string&)> reply) { shots_.push_back({eye, std::move(reply)}); };
  if (config_.at("debug").bo("inspector", true)) { inspector_ = std::make_unique<Inspector>(engine_, loop_); inspector_->bridge = [this](const std::string& req, std::function<void(const std::string&)> reply) { bridgeHandle(bridge_, req, std::move(reply)); }; inspector_->start((int)config_.at("debug").n("port", 9229), config_.at("app").s("name", "webxr-host")); }
  std::string prelude;
  if (!assets_.read("host-runtime.js", prelude)) { HOST_LOGE("assets/host-runtime.js missing (run npm run build:runtime)"); return false; }
  HOST_LOGI("prelude %zu bytes; entry %s", prelude.size(), config_.at("web").s("entry", "?").c_str());
  if (!engine_.runScript(prelude, "host-runtime.js")) return false;
  engine_.pump();
  return true;
}

bool Host::xrBegin(const Json& opts, Json& out) {
  if (!xrInstance_) return false;
  SwapchainDesc d; d.arraySize = (int)opts.n("arraySize", 2); double scale = opts.n("scale", 1.0); d.glFormat = (int64_t)opts.n("format", 0x8058);
  d.scale = scale;  // sized from the recommended eye buffer re-read at creation
  d.passthrough = opts.n("passthrough", 0) > 0.5; d.unpremultiplied = opts.n("unpremultiplied", 0) > 0.5; d.scene = opts.n("scene", 0) > 0.5;
  // An XRWebGLLayer (one side-by-side 2D image) the page writes sRGB-encoded bytes into: the Quest compositor shows a 2D
  // RGBA8 swapchain as linear, washed out (a projection layer's texture array it shows as sRGB), so such a layer gets
  // an sRGB one and the runtime turns GL's conversion on write off while the page draws into it (webxr/layers.js).
  if (opts.n("srgbLayer", 0) > 0.5 && d.arraySize == 1) d.glFormat = 0x8C43;  // GL_SRGB8_ALPHA8
  // host.json xr.srgbSwapchain: an sRGB swapchain with alpha, drawn through RGBA8 views (SwapchainDesc::srgbView).
  if (config_.at("xr").bo("srgbSwapchain", false)) { d.glFormat = 0x8C43; d.srgbView = true; }
  // Scene data is behind a runtime permission (Horizon OS v60+). The dialog's answer never reaches native code:
  // xrTick re-checks on the next FOCUSED and queries again.
  if (d.scene && !hasPermission(svc_.javaVm, svc_.activity, kScenePermission)) { scenePermissionAsked_ = true; requestPermission(svc_.javaVm, svc_.activity, kScenePermission); }
  if (!glq::sync("createSwapchain", [&] { return xr_.createSwapchain(d); })) return false;
  xrActive_ = true;
  double rate = opts.n("preferredRate", config_.at("xr").n("preferredRate", 0)); if (rate > 0) xr_.requestRefreshRate((float)rate);
  double fov = opts.n("foveation", config_.at("xr").n("foveation", -1)); if (fov >= 0) glq::sync("setFoveation", [&] { xr_.setFoveation((float)fov); });
  out.type = Json::Object;
  auto num = [&](const char* k, double v) { Json j; j.type = Json::Number; j.num = v; out.obj[k] = j; };
  auto flag = [&](const char* k, bool v) { Json j; j.type = Json::Bool; j.b = v; out.obj[k] = j; };
  int w = xr_.swapchainWidth(); if (d.arraySize == 1) w /= 2;
  num("width", d.arraySize == 1 ? xr_.swapchainWidth() : w); num("height", xr_.swapchainHeight()); num("arraySize", xr_.swapchainArraySize()); num("rate", xr_.refreshRate()); num("viewCount", xr_.viewCount()); num("depthTexture", xr_.swapchainDepthTexture()); num("format", (double)xr_.swapchainFormat());
  Json rates; rates.type = Json::Array; for (float r : xr_.refreshRates()) { Json j; j.type = Json::Number; j.num = r; rates.arr.push_back(j); } out.obj["rates"] = rates;
  float bw = 0, bd = 0; bool hasB = xr_.stageBounds(bw, bd); flag("hasStage", xr_.hasStage()); num("stageWidth", hasB ? bw : 0); num("stageDepth", hasB ? bd : 0); flag("hands", xr_.hasHandTracking());
  HOST_LOGI("xr begin: %dx%d x%d", xr_.swapchainWidth(), xr_.swapchainHeight(), xr_.swapchainArraySize());
  HOST_LOGI("invalidation: acquired colour at frame start %s; XRWebGLLayer depth at frame end %s (host.json xr.invalidate)", invalidateAcquire_ ? "on" : "off", invalidateAcquire_ ? "on" : "off");
  return true;
}

void Host::xrEnd() { xrActive_ = false; xrSeenVisible_ = false; glq::sync("destroySwapchain", [&] { xr_.destroySwapchain(); }); xr_.resetFoveation(); scenePermissionAsked_ = false; HOST_LOGI("xr end (swapchain dropped; session kept)"); }

void Host::onWindow(ANativeWindow* win) {
  window_ = win; if (mode_ != "native-clear" && eglUp_) { glq::sync("bindWindow", [&] { egl_.bindWindow(win); }); }
  // A phone's display may run at 90 or 120 Hz: ask it for the page's rate (the system may switch the display), and
  // pace the swaps to whatever it runs at (flatTick), so frames come evenly instead of alternating 8 and 16 ms.
  if (phone_ && win) {
    using SetFrameRate = int32_t (*)(ANativeWindow*, float, int8_t);  // API 30; minSdk is 29, so looked up
    static const auto setFrameRate = (SetFrameRate)dlsym(RTLD_DEFAULT, "ANativeWindow_setFrameRate");
    if (setFrameRate) setFrameRate(win, frameRate_, ANATIVEWINDOW_FRAME_RATE_COMPATIBILITY_DEFAULT);
    insetW_ = 0;  // re-read the display at once
  }
}
void Host::onWindowLost() { window_ = nullptr; if (eglUp_) glq::sync("unbindWindow", [&] { egl_.unbindWindow(); }); }
void Host::requestVsync() {
  if (vsyncPosted_) return;
  if (AChoreographer* c = AChoreographer_getInstance()) { AChoreographer_postFrameCallback64(c, onVsync, this); vsyncPosted_ = true; }
}
// One vsync: the period is measured from the callbacks themselves (a late loop sees several periods in one gap,
// counted as such), and the next callback is asked for only while the app is in front.
void Host::onVsync(int64_t frameTimeNanos, void* self) {
  auto* h = (Host*)self; const int64_t prev = h->vsyncNs_;
  h->vsyncNs_ = frameTimeNanos; h->vsyncPosted_ = false;
  if (prev && frameTimeNanos > prev) {
    const int64_t d = frameTimeNanos - prev;
    if (!h->vsyncPeriodNs_) h->vsyncPeriodNs_ = d;
    else { const double n = std::max(1.0, std::round((double)d / (double)h->vsyncPeriodNs_)); h->vsyncPeriodNs_ += ((int64_t)((double)d / n) - h->vsyncPeriodNs_) / 8; }
  }
  if (h->shown_) h->requestVsync();
}
void Host::onResume() { resumed_ = true; }
void Host::onPause() { resumed_ = false; if (jsUp_) store_.flush(); if (phone_) touch::cancelAll(); }

// The phone's touches: a finger on one of the touch controls drives them, every other one is a pointer for the page;
// positions in CSS pixels. The back key is Escape (games pause on it) and does not close the app. readInput copies
// what is needed (any thread); applyInput runs on the host thread.
bool Host::readInput(const AInputEvent* e, InputEvent& r) {
  r.type = InputEvent::kNone; r.count = 0;
  if (AInputEvent_getType(e) == AINPUT_EVENT_TYPE_KEY) {
    if (AKeyEvent_getKeyCode(e) != AKEYCODE_BACK) return false;
    const int32_t a = AKeyEvent_getAction(e);
    if (a == AKEY_EVENT_ACTION_DOWN || a == AKEY_EVENT_ACTION_UP) { r.type = InputEvent::kBack; r.down = a == AKEY_EVENT_ACTION_DOWN; r.repeat = AKeyEvent_getRepeatCount(e) > 0; }
    return true;
  }
  if (AInputEvent_getType(e) != AINPUT_EVENT_TYPE_MOTION) return false;
  const int32_t action = AMotionEvent_getAction(e), kind = action & AMOTION_EVENT_ACTION_MASK;
  const size_t idx = (size_t)((action & AMOTION_EVENT_ACTION_POINTER_INDEX_MASK) >> AMOTION_EVENT_ACTION_POINTER_INDEX_SHIFT);
  const size_t n = AMotionEvent_getPointerCount(e);
  auto put = [&](size_t i) {
    if (r.count == sizeof r.p / sizeof r.p[0]) return;
    auto& p = r.p[r.count++];
    p.id = AMotionEvent_getPointerId(e, i); p.tool = AMotionEvent_getToolType(e, i);
    p.x = AMotionEvent_getX(e, i); p.y = AMotionEvent_getY(e, i); p.pressure = AMotionEvent_getPressure(e, i);
  };
  switch (kind) {
    case AMOTION_EVENT_ACTION_DOWN: case AMOTION_EVENT_ACTION_POINTER_DOWN: r.phase = dom::kDown; put(idx); break;
    case AMOTION_EVENT_ACTION_UP: case AMOTION_EVENT_ACTION_POINTER_UP: r.phase = dom::kUp; put(idx); break;
    case AMOTION_EVENT_ACTION_MOVE: r.phase = dom::kMove; for (size_t i = 0; i < n; ++i) put(i); break;
    case AMOTION_EVENT_ACTION_CANCEL: r.phase = dom::kCancel; for (size_t i = 0; i < n; ++i) put(i); break;
    default: return false;
  }
  r.type = InputEvent::kPointer;
  return true;
}
void Host::applyInput(const InputEvent& r) {
  if (!phone_ || !jsUp_) return;
  if (r.type == InputEvent::kBack) { dom::key(r.down, "Escape", r.repeat ? dom::kRepeat : 0); return; }
  if (r.type != InputEvent::kPointer) return;
  const dom::Type t = (dom::Type)r.phase; const bool pressed = t == dom::kDown || t == dom::kMove;
  for (unsigned i = 0; i < r.count; ++i) {
    const auto& p = r.p[i]; const float x = p.x / dpr_, y = p.y / dpr_;
    const dom::PointerType pt = p.tool == AMOTION_EVENT_TOOL_TYPE_MOUSE ? dom::kMouse : p.tool == AMOTION_EVENT_TOOL_TYPE_STYLUS ? dom::kPen : dom::kTouch;
    const int pid = p.id + 2;  // 1 is the mouse's id in the page, as on the desktop hosts
    if (t == dom::kDown) { if (touch::down(pid, x, y)) continue; }
    else if (t == dom::kMove) { if (touch::move(pid, x, y)) continue; }
    else if (touch::up(pid)) continue;
    dom::pointer(t, pid, x, y, pressed ? 1 : 0, 0, pt, pressed ? p.pressure : 0.f, 0);
  }
}
bool Host::onInput(const AInputEvent* e) {
  if (!phone_ || !jsUp_) return false;
  InputEvent r; if (!readInput(e, r)) return false;
  applyInput(r); return true;
}

// A phone's next activity (the last one was recreated): its display, density and window flags; the window and the
// resume follow as commands. Between activities the host runs hidden, as a background tab.
void Host::attach(android_app* app) {
  app_ = app; svc_.activity = app->activity->clazz;
  if (!phone_) return;
  display_.init(app->activity->vm, app->activity->clazz);
  const int32_t d = AConfiguration_getDensity(app->config); dpr_ = d > 0 && d != ACONFIGURATION_DENSITY_ANY ? d / 160.f : 1.f;
  ANativeActivity_setWindowFlags(app->activity, AWINDOW_FLAG_KEEP_SCREEN_ON | AWINDOW_FLAG_FULLSCREEN, 0);
  insetW_ = 0;
  HOST_LOGI("activity attached to the running host; the page carries on");
}
void Host::detach() { app_ = nullptr; svc_.activity = nullptr; HOST_LOGI("activity detached; the host runs on hidden"); }
void Host::onLowMemory() { if (jsUp_) engine_.isolate()->LowMemoryNotification(); }

double Host::heapMB() { if (!jsUp_) return 0; v8::HeapStatistics hs; engine_.isolate()->GetHeapStatistics(&hs); return hs.used_heap_size() / 1048576.0; }

void Host::captureShots(const XrFrameInfo* f) {
  if (shots_.empty()) return;
  std::vector<ShotReq> reqs; reqs.swap(shots_);
  for (auto& r : reqs) {
    int w = 0, h = 0; std::vector<unsigned char> rgba;
    glq::sync("shot", [&] {
    PackGuard pack;  // the page may leave a pack buffer bound (gl/pack_guard.h)
    GLuint fbo = 0; glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
    if (f && f->colorTexture) {
      w = f->arraySize > 1 ? f->width : f->width / 2; h = f->height;
      if (f->arraySize > 1) glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f->colorTexture, 0, r.eye); else glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f->colorTexture, 0);
      rgba.resize((size_t)w * h * 4); glReadPixels(f->arraySize > 1 ? 0 : r.eye * w, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    } else if (window_ && egl_.windowWidth() > 0) { glBindFramebuffer(GL_READ_FRAMEBUFFER, 0); w = egl_.windowWidth(); h = egl_.windowHeight(); rgba.resize((size_t)w * h * 4); glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data()); }
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0); glDeleteFramebuffers(1, &fbo);
    });
    if (w == 0) r.reply("{\"error\":\"nothing rendered\"}"); else r.reply(bridgeEncodeShot(w, h, rgba));
  }
}

void Host::stats(const XrFrameInfo* f) {
  const double now = loop_.now(); if (statT_ == 0) statT_ = now; frames_++;
  if (now - statT_ >= 2000) {
    fpsNow_ = frames_ * 1000.0 / (now - statT_); jsAvg_ = jsMs_ / frames_;
    if (f) HOST_LOGI("xr %.1f fps  rate %.0f  state %d  tex %u  %dx%dx%d  wait %.2f  js %.2f  end %.2f ms/frame  timers %zu  [%s]  %s  [%s]", frames_ * 1000.0 / (now - statT_), xr_.refreshRate(), (int)xr_.state(), f->colorTexture, f->width, f->height, f->arraySize, waitMs_ / frames_, jsMs_ / frames_, endMs_ / frames_, loop_.timerCount(), xr_.profileLine().c_str(), xr_.perfLine().c_str(), gc_.statsLine().c_str());
    else HOST_LOGI("flat %.1f fps  js %.2f ms/frame  timers %zu  [%s]", frames_ * 1000.0 / (now - statT_), jsMs_ / frames_, loop_.timerCount(), gc_.statsLine().c_str());
    if (glq::active()) {
      const glq::Stats q = glq::takeStats(); const double n = frames_;
      glBusy_ = q.busyUs / 1000.0 / n;
      HOST_LOGI("gl thread: busy %.2f ms/frame  %.0f words/frame  %.1f syncs/frame (%s)  wraps %llu  full %llu", glBusy_, q.words / n, q.syncs / n, glq::topSyncs(), (unsigned long long)q.wraps, (unsigned long long)q.fullWaits);
    }
    frames_ = 0; statT_ = now; jsMs_ = 0; waitMs_ = 0; endMs_ = 0;
  }
}

uint32_t Host::opXrBegin(const uint32_t* c) {  // [op, shouldRender]
  Host* h = g_pipeHost;
  g_glFrame.shouldRender = c[1] != 0;
  g_glBegun = h->xr_.beginOnly();
  g_glFrame.colorTexture = 0;
  if (g_glBegun) {
    h->xr_.acquire(g_glFrame);
    if (g_glFrame.colorTexture) { wgl::xrImageAcquired(g_glFrame.colorTexture); if (h->invalidateAcquire_) h->invalidateAcquired(g_glFrame); }
  }
  return 2;
}
uint32_t Host::opXrEnd(const uint32_t* c) {  // [op, PipeEnd]
  Host* h = g_pipeHost;
  PipeEnd e; memcpy(&e, c + 1, sizeof e);
  if (g_glBegun) {
    g_glFrame.displayTime = e.displayTime;
    for (int i = 0; i < 2; ++i) { g_glFrame.viewPose[i] = e.pose[i]; g_glFrame.viewFov[i] = e.fov[i]; }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    h->xr_.endFrame(g_glFrame, g_glFrame.shouldRender);
  }
  g_glBegun = false;
  return 1 + kPipeEndWords;
}

// One pipelined XR frame on the host thread: wait, locate, the page's JS, then the GL thread's begin / end queued
// around it. Nothing here waits for the GL thread (xrWaitFrame does: it returns once the previous frame has begun),
// so the page's next frame overlaps the GL thread finishing this one.
void Host::xrTickPipelined() {
  XrFrameInfo f;
  const double tw = loop_.now();
  if (!xr_.waitFrame()) return;
  double t0 = loop_.now(); waitMs_ += t0 - tw;
  xr_.locateWaited(f, tw);
  f.colorTexture = f.shouldRender && xr_.swapchainWidth() > 0 ? wgl::kXrImage : 0; f.imageIndex = 0;
  glq::put(kOpXrBegin, f.shouldRender ? 1u : 0u);
  gc_.setInFrame(true);
  if (jsUp_) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchFrame(iso, ctx, f, xr_.baseIsFloor()); });
  const double t1 = loop_.now(); jsMs_ += t1 - t0;
  if (f.shouldRender && !shots_.empty()) captureShots(&g_glFrame);  // a sync: reads the GL thread's frame once it has run
  PipeEnd e{}; e.displayTime = f.displayTime; e.shouldRender = f.shouldRender;
  for (int i = 0; i < 2; ++i) { e.pose[i] = f.viewPose[i]; e.fov[i] = f.viewFov[i]; }
  const uint32_t pos = glq::reserve(1 + kPipeEndWords); uint32_t* d = glq::data() + pos;
  d[0] = kOpXrEnd; memcpy(d + 1, &e, sizeof e); glq::commit(pos + 1 + kPipeEndWords);
  gc_.setInFrame(false);
  if (jsUp_) gc_.afterSubmit();
  endMs_ += loop_.now() - t1;
  stats(&f);
}

void Host::publishXrState() {
  if (!xrInstance_ || xr_.state() == lastState_) return;
  lastState_ = xr_.state();
  // A refresh-rate request made before the session is FOCUSED can be dropped by the runtime: ask again on focus.
  if (lastState_ == XR_SESSION_STATE_FOCUSED) { double want = config_.at("xr").n("preferredRate", 0); if (want > 0 && std::abs(xr_.refreshRate() - want) > 0.5) xr_.requestRefreshRate((float)want); }
  // Back from the permission dialog (or the room setup flow): ask for the room again once the permission is there.
  if (lastState_ == XR_SESSION_STATE_FOCUSED && xr_.scene().sceneActive() && (scenePermissionAsked_ || xr_.scene().queryFailedPermission() || xr_.scene().entities().empty())) {
    if (hasPermission(svc_.javaVm, svc_.activity, kScenePermission)) { scenePermissionAsked_ = false; xr_.scene().requery(); }
  }
  if (!jsUp_) return;
  // The page's requestSession is waiting on this event to enter VR. It has to arrive while the loop is still
  // flat: xrTick is what would have sent it, and xrTick does not run until that requestSession has created the
  // swapchain. Sending it only from there left the headset on its loading screen.
  bool vis = lastState_ == XR_SESSION_STATE_VISIBLE || lastState_ == XR_SESSION_STATE_FOCUSED;
  engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "state", vis, lastState_ == XR_SESSION_STATE_FOCUSED); });
}

void Host::xrTick() {
  if (jsUp_ && xr_.refreshRateChanged()) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "rate", xr_.refreshRate(), 0); });
  if (jsUp_ && xr_.referenceSpaceChanged()) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "reset", 0, 0); });
  { bool ok = false; if (jsUp_ && xr_.scene().captureFinished(ok)) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "scenecapture", ok ? 1 : 0, 0); }); }
  if (pipeline_) { xrTickPipelined(); return; }
  XrFrameInfo f;
  const double tw = loop_.now();
  if (!xr_.waitFrame()) return;
  const bool begun = glq::sync("beginFrame", [&] {
    if (!xr_.beginWaited(f, tw)) return false;
    if (invalidateAcquire_ && f.colorTexture) invalidateAcquired(f);
    return true;
  });
  if (!begun) return;
  double t0 = loop_.now(); waitMs_ += t0 - tw;
  gc_.setInFrame(true);  // pre-submit window: a GC pause from here to xrEndFrame's return delays the frame
  if (mode_ == "native-clear") { if (f.shouldRender) clear_.drawXr(f); }
  else if (jsUp_) {
    engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchFrame(iso, ctx, f, xr_.baseIsFloor()); });
  }
  const double t1 = loop_.now(); jsMs_ += t1 - t0;
  if (f.shouldRender) captureShots(&f);
  // With the GL thread on, this waits for the frame's commands to run, then submits (end = the GL tail).
  glq::sync("endFrame", [&] { if (jsUp_) glBindFramebuffer(GL_FRAMEBUFFER, 0); xr_.endFrame(f, f.shouldRender); });
  const double t2 = loop_.now();
  gc_.setInFrame(false);
  if (jsUp_) gc_.afterSubmit();  // the next frame starts with an emptied young generation when it was filling up
  const double t3 = loop_.now();
  endMs_ += t3 - t1;
  // Diagnostics (__native.gl.debugSlowOps): a frame that took longer than the threshold, start to start, in parts:
  // the event loop's other work since the last frame, xrWaitFrame + begin, the page's frame, the submit, the GC.
  if (const uint64_t slow = glq::slowLogUs(); slow && lastFrameStart_ > 0 && (tw - lastFrameStart_) * 1000 >= (double)slow)
    HOST_LOGW("xr frame %.1f ms since the last: between %.1f, wait %.1f, js %.1f, end %.1f, gc %.1f ms", tw - lastFrameStart_, tw - lastFrameEnd_, t0 - tw, t1 - t0, t2 - t1, t3 - t2);
  lastFrameStart_ = tw; lastFrameEnd_ = t3;
  stats(&f);
}

// Marks the acquired image's previous contents undefined so the first pass that renders into it skips the tile
// load (GMEM restore) on Adreno. Safe because nothing reads last frame's pixels: WebXR gives the page a cleared
// (or undefined) framebuffer every frame, three clears each XR frame, and the colour is only ever written before
// release. Uses a host-owned FBO and restores the draw binding, so the JS-side GL state cache stays truthful.
void Host::invalidateAcquired(const XrFrameInfo& f) {
  static const GLenum kColor[1] = {GL_COLOR_ATTACHMENT0};
  if (invFbo_ == 0) glGenFramebuffers(1, &invFbo_);
  GLint prev = 0; glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prev);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, invFbo_);
  if (f.arraySize > 1) {
    for (int l = 0; l < f.arraySize; ++l) { glFramebufferTextureLayer(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f.colorTexture, 0, l); glInvalidateFramebuffer(GL_DRAW_FRAMEBUFFER, 1, kColor); }
    glFramebufferTextureLayer(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 0, 0, 0);
  } else {
    glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f.colorTexture, 0); glInvalidateFramebuffer(GL_DRAW_FRAMEBUFFER, 1, kColor);
    glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  }
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev);
}

void Host::flatTick() {
  // ~60 Hz flat frame pacing when XR is not rendering. A phone paces on the swap (vsync) instead, and runs no frames
  // while it is in the background: the page is told it is hidden and its rAF stops, as in a browser tab.
  double now = loop_.now();
  if (phone_ && jsUp_) {
    const bool shown = resumed_ && window_ && egl_.windowWidth() > 0;
    if (shown != shown_) {  // the background: the page hidden, its audio output stopped (its graph keeps its state)
      shown_ = shown;
      engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { dom::setHidden(iso, ctx, !shown); });
      if (shown) { audio::RealtimeContext::resumeOutput(); requestVsync(); } else audio::RealtimeContext::pauseOutput();
    }
    // Every n-th vsync, n the largest whole number that keeps the page at or above its rate: 60 Hz and 90 Hz every
    // refresh, 120 Hz every second (60), 144 Hz every second (72). Android ignores swap intervals above 1, so the
    // swap alone would run at the display's rate; a fixed time gate would drop 90 Hz to 45.
    if (!shown || !vsyncNs_ || !vsyncPeriodNs_) return;
    const int every = std::max(1, (int)std::floor(1e9 / (double)vsyncPeriodNs_ / frameRate_ + 0.1));
    if (frameVsyncNs_ && vsyncNs_ - frameVsyncNs_ < every * vsyncPeriodNs_ - vsyncPeriodNs_ / 2) return;
    frameVsyncNs_ = vsyncNs_;
    lastFlat_ = now;
    glq::sync("makeCurrent", [&] { egl_.makeCurrentPreferred(); });
    const int fbW = egl_.windowWidth(), fbH = egl_.windowHeight(); const float cssW = std::round(fbW / dpr_), cssH = std::round(fbH / dpr_);  // whole CSS pixels, as a browser reports them
    // Where the cutout is (the window draws under it): read when the size or the rotation changes. The rotation is
    // checked about once a second (one cached JNI int call): turning the phone round (landscape to reverse
    // landscape) moves the cutout without changing the size.
    const bool resized = fbW != insetW_ || fbH != insetH_;
    const int rot = resized || ++insetFrames_ % 60 == 0 ? display_.rotationDegrees() : rotation_;
    if (resized || rot != rotation_) {
      rotation_ = rot; insetW_ = fbW; insetH_ = fbH;
      int px[4]; display_.cutoutInsets(px);
      for (int i = 0; i < 4; ++i) insets_[i] = std::round(px[i] / dpr_);
      const float hz = display_.refreshRate();
      if (std::fabs(hz - displayHz_) > 0.5f) displayHz_ = hz;
      HOST_LOGI("window %dx%d, rotation %d, display %.0f Hz, safe-area insets %.0f %.0f %.0f %.0f (CSS px, top right bottom left)", fbW, fbH, rotation_, displayHz_, insets_[0], insets_[1], insets_[2], insets_[3]);
    }
    touch::layout(cssW, cssH, dpr_, insets_);
    engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { dom::setViewport(iso, ctx, cssW, cssH, dpr_, fbW, fbH, rotation_, insets_); nativeFlatFrame(iso, ctx, now); });
    touch::frame(now, true, fbW, fbH);
    jsMs_ += loop_.now() - now;  // before the swap, which waits for a free buffer (vsync) and is not the page's time
    captureShots(nullptr); glq::sync("swap", [&] { egl_.swap(); });
    stats(nullptr);
    return;
  }
  if (hidden_) return;  // the Quest with the headset off: no frames, as a hidden tab gets none
  if (now - lastFlat_ >= 16.0) {
    lastFlat_ = now; double t0 = now;
    if (jsUp_) { glq::sync("makeCurrent", [&] { egl_.makeCurrentPreferred(); }); engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { nativeFlatFrame(iso, ctx, now); }); captureShots(nullptr); if (window_ && egl_.windowWidth() > 0) glq::sync("swap", [&] { egl_.swap(); }); }
    else if (clearUp_ && window_ && egl_.windowWidth() > 0) { clear_.drawPanel(egl_.windowWidth(), egl_.windowHeight(), now / 1000.0); egl_.swap(); }
    jsMs_ += loop_.now() - t0; stats(nullptr);
  }
}

// The Quest's page visibility, as a browser's: hidden while the headset is off. An immersive session counts as shown
// while VISIBLE or FOCUSED (the system menu over it is FOCUSED → VISIBLE, visible-blurred: still shown), and only
// once it has been: a session starts in SYNCHRONIZED until the first frames are submitted, which must not flash
// the page hidden. Without a session (a flat app on Quest) Android's resumed state decides. Hidden: the document's
// visibilitychange fires, the audio output stops (the graph keeps its state and resumes where it was), the flat
// frames stop and the loop idles; the XR session's own visibilitychange comes from its state events (xrTick). The
// phone build does the same from its window and lifecycle (flatTick); the Vision Pro host from its scene phase.
void Host::updateVisibility() {
  bool shown = resumed_;
  if (xrInstance_ && xrActive_) {
    const XrSessionState st = xr_.state();
    const bool visible = xr_.sessionRunning() && (st == XR_SESSION_STATE_VISIBLE || st == XR_SESSION_STATE_FOCUSED);
    if (visible) xrSeenVisible_ = true;
    shown = visible || !xrSeenVisible_;
  }
  if (shown == !hidden_) return;
  hidden_ = !shown;
  engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { dom::setHidden(iso, ctx, hidden_); });
  if (hidden_) audio::RealtimeContext::pauseOutput(); else audio::RealtimeContext::resumeOutput();
  HOST_LOGI("page %s (session %s): audio output %s", hidden_ ? "hidden" : "shown", xrActive_ ? "active" : "none", hidden_ ? "paused" : "resumed");
}

bool Host::tick() {
  if (exit_) return false;
  if (xrInstance_) { if (!xr_.pollEvents()) { HOST_LOGI("xr session over"); return false; } publishXrState(); }
  const bool xrRendering = xrInstance_ && xrActive_ && xr_.sessionRunning();
  if (!phone_ && jsUp_) updateVisibility();
  if (xrRendering) xrTick();
  else flatTick();
  if (jsUp_) { engine_.pump(); audioTick(svc_); platformTick(svc_); store_.tick(loop_.now()); }
  double next = loop_.runOnce();
  if (jsUp_) engine_.pump();
  // The rest of this frame's slack (until the predicted next xrWaitFrame wake, minus a margin) goes to V8's idle GC.
  if (jsUp_) {
    if (xrRendering) gc_.idleUntil(xr_.lastWakeMs() + xr_.framePeriodMs());
    else gc_.idleUntil(GcScheduler::steadyMs() + (lastFlat_ + 16.0 - loop_.now()));
  }
  // A phone waits on its looper until the next vsync is due (the callback comes through it), or a command arrives,
  // or, hidden, up to 50 ms (timers still run, as a background browser tab's do).
  if (!xrRendering) {
    double most = 4.0;
    if (!phone_ && hidden_) most = 50.0;  // the headset off: timers still run, nothing is drawn
    if (phone_ && jsUp_) {
      if (!shown_) most = 50.0;
      else if (vsyncNs_ && vsyncPeriodNs_) { timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); const int64_t nowNs = (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec; most = std::clamp((double)(vsyncNs_ + vsyncPeriodNs_ - nowNs) / 1e6, 0.0, 4.0); }
      else most = 1.0;
    }
    double wait = next < 0 ? most : std::min(next, most);
    if (pollLooper_) ALooper_pollOnce((int)std::ceil(wait), nullptr, nullptr, nullptr);  // returns early on a vsync or a command
    else std::this_thread::sleep_for(std::chrono::microseconds((int)(wait * 1000)));
  }
  return true;
}

}  // namespace host
