// The emulated-headset hosts' Host (mac/, win/, ios/): app/host.cpp without the activity, the permissions and
// the OpenXR runtime. Kept beside it rather than folded into it so the Quest path stays exactly what it was.
#include "emu/host_emu.h"
#include "core/fs.h"
#include "core/log.h"
#include "emu/emu.h"
#include "gl/touch_controls.h"
#include "gl/pack_guard.h"
#include "js/dom_input.h"
#include "js/console.h"
#include "xr/xr_frame_bridge.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>
#include <filesystem>

namespace host {

#ifdef HOST_XR_OPENXR
constexpr bool kEmulated = false;  // linux/ webxrhost-linux-xr: the system's OpenXR runtime
#else
constexpr bool kEmulated = true;
#endif

// Quitting stops what runs beside the JS thread and saves; V8 itself is left standing. Handles outlive the
// isolate here (Modules' module map, the bindings' file-scope v8::Global records) and releasing one into a
// disposed isolate crashed every quit (GlobalHandles::NodeSpace::Release). Each platform's main ends the process
// without static destructors (_exit), so nothing runs after this that could touch them; the OS takes the heap,
// the GL objects and the audio device.
Host::~Host() {
  if (inspector_) inspector_->stop();
  if (jsUp_) { store_.flush(); shutdownWorkers(); http_.shutdown(); store_.flush(); gc_.detach(); }  // the saves first: nothing after may hold them up
}

bool Host::start(void* nativeWindow) {
  assets_.init(assetsDir_);
  std::string text, err;
  config_ = assets_.read("host.json", text) ? Json::parse(text, &err) : Json();
  if (!err.empty()) HOST_LOGE("host.json: %s", err.c_str());
  if (!config_.get("web")) { HOST_LOGE("%s/host.json has no web section (stage it with pack.mjs --stage)", assetsDir_.c_str()); return false; }
  HOST_LOGI("webxr-host (%s, %s) starting: %s", HOST_PLATFORM_NAME, kEmulated ? "emulated headset" : "OpenXR runtime", assetsDir_.c_str());
  if (!egl_.init()) return false; eglUp_ = true;
  if (!egl_.bindWindow((ANativeWindow*)nativeWindow)) return false;
  // The splash goes up before the JS boot, which holds the thread for seconds on a jitless V8.
  if (splash_.load(assets_, "vr_splash.png")) {
    splash_.draw(egl_.windowWidth(), egl_.windowHeight()); egl_.swap();
    emu::setPresentOverlay([this](int w, int h) { splash_.draw(w, h); });
  }
  return startJs();
}

bool Host::startJs() {
  // No snapshot: the Android blob belongs to the APK's V8 10.0; each platform's V8 carries its own built in.
  // ICU data (Intl, localeCompare, toLocale*String need it): where the platform says (icuData), else a packaged
  // app's icudtl.dat next to its assets, else the V8 install's (HOST_V8_ICU_DATA); a V8 with the data linked in
  // (iOS) needs none.
  { std::error_code ec; std::string bundled = assetsDir_ + "/../icudtl.dat"; std::string icu = icuData;
    if (!icu.empty()) {}
    else if (std::filesystem::exists(fsPath(bundled), ec)) icu = bundled;
#ifdef HOST_V8_ICU_DATA
    else icu = HOST_V8_ICU_DATA;
#endif
    if (!v8::V8::InitializeICU(icu.empty() ? nullptr : icu.c_str())) HOST_LOGW("ICU data not loaded from %s: Intl will throw", icu.empty() ? "(built in)" : icu.c_str()); }
  gcCfg_ = GcConfig::fromJson(config_.at("gc"));
  std::string flags = GcScheduler::v8Flags(gcCfg_);
#ifdef HOST_V8_FLAGS
  flags = flags.empty() ? std::string(HOST_V8_FLAGS) : std::string(HOST_V8_FLAGS) + " " + flags;  // the platform's own (iOS: --jitless)
#endif
  if (!Engine::initPlatform(std::string(), flags)) return false;
  { v8::ResourceConstraints rc; GcScheduler::constrain(gcCfg_, rc); if (!engine_.create(gcCfg_.enabled ? &rc : nullptr)) return false; }
  jsUp_ = true;
  gc_.attach(engine_.isolate(), gcCfg_);
  emu::setConfig(&config_);
  xrUp_ = xr_.createInstance(nullptr) && xr_.createSession(egl_);
  svc_.loop = &loop_; svc_.assets = &assets_; svc_.http = &http_; svc_.store = &store_; svc_.egl = &egl_; svc_.xr = xrUp_ ? &xr_ : nullptr;
  svc_.engine = &engine_; svc_.host = this; svc_.config = &config_;
  svc_.filesDir = filesDir_; svc_.systemName = xr_.systemName();
  // Bytecode from the last launch: a jitless V8 (iOS) spends seconds parsing and compiling the page otherwise.
  if (config_.at("debug").bo("codeCache", true)) { codeCache_.init(filesDir_ + "/code-cache"); svc_.codeCache = &codeCache_; }
  svc_.packageName = config_.at("app").s("package", "webxr-host");
  svc_.pageInput = true; svc_.flatScaled = true;  // the flat page gets the window's pointer and keys, its canvas scaled into the window
  touch::configure(config_, assets_, /*touchScreen=*/false);  // a window host shows them only when host.json says desktop
  svc_.xrBegin = [this](const Json& o, Json& out) { return xrBegin(o, out); };
  svc_.xrEnd = [this] { xrEnd(); };
  svc_.requestExit = [this] { exit_ = true; };
  std::vector<std::string> allow; for (auto& a : config_.at("network").at("allow").arr) if (a.type == Json::String) allow.push_back(a.str);
  http_.init(nullptr, &loop_, allow);
  store_.init(filesDir_ + "/localStorage.json");
  modules_.init(&engine_, &svc_, config_.at("web").s("origin", "https://app.local"));
  egl_.makeCurrentPreferred();
  bool ok = engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
    installConsole(ctx, [this](int level, const std::string& m) { bridgeLog(m); if (inspector_) inspector_->consoleMessage(level, m); });
    v8::Local<v8::Object> native = installNativeCore(ctx, svc_);
    installWebGL(ctx, native, svc_); installImages(ctx, native, svc_); installAudio(ctx, native, svc_); installXr(ctx, native, svc_); installWorkers(ctx, native, svc_); installPlatform(ctx, native, svc_); installWasmInterp(ctx, native, svc_); installRtc(ctx, native, svc_);
  });
  if (!ok) return false;
  bridge_.engine = &engine_;
  bridge_.pump = [this] { loop_.runOnce(); engine_.pump(); if (xrUp_) xr_.pollEvents(); if (xrUp_ && xrActive_ && xr_.sessionRunning()) xrTick(); };
  bridge_.stats = [this] { char b[256]; snprintf(b, sizeof b, "{\"fps\":%.1f,\"jsMs\":%.2f,\"rate\":%.0f,\"xr\":%s,\"state\":%d,\"timers\":%zu,\"heapMB\":%.1f,\"emulated\":%s}", fpsNow_, jsAvg_, xr_.refreshRate(), xrActive_ ? "true" : "false", (int)xr_.state(), loop_.timerCount(), heapMB(), kEmulated ? "true" : "false"); return std::string(b); };
  bridge_.shot = [this](int eye, std::function<void(const std::string&)> reply) { shots_.push_back({eye, std::move(reply)}); };
  if (config_.at("debug").bo("inspector", true)) { inspector_ = std::make_unique<Inspector>(engine_, loop_); inspector_->bridge = [this](const std::string& req, std::function<void(const std::string&)> reply) { bridgeHandle(bridge_, req, std::move(reply)); }; inspector_->start((int)config_.at("debug").n("port", 9229), config_.at("app").s("name", "webxr-host"), /*loopbackOnly=*/true); }
  std::string prelude;
  if (!assets_.read("host-runtime.js", prelude)) { HOST_LOGE("host-runtime.js missing from %s", assetsDir_.c_str()); return false; }
  HOST_LOGI("prelude %zu bytes; entry %s", prelude.size(), config_.at("web").s("entry", "?").c_str());
  if (!engine_.runScript(prelude, "host-runtime.js", svc_.codeCache)) return false;
  engine_.pump();
  return true;
}

bool Host::xrBegin(const Json& opts, Json& out) {
  if (!xrUp_) return false;
  SwapchainDesc d; d.arraySize = (int)opts.n("arraySize", 2); d.scale = opts.n("scale", 1.0); d.glFormat = (int64_t)opts.n("format", 0x8058);
  d.passthrough = opts.n("passthrough", 0) > 0.5; d.unpremultiplied = opts.n("unpremultiplied", 0) > 0.5; d.scene = opts.n("scene", 0) > 0.5;  // vision: the compositor blends, ARKit lists the room
  if (!xr_.createSwapchain(d)) return false;
  xrActive_ = true;
#ifdef HOST_XR_OPENXR
  // A real runtime (linux/: Monado, WiVRn): the page's rate and foveation requests reach it, as on the Quest.
  { double rate = opts.n("preferredRate", config_.at("xr").n("preferredRate", 0)); if (rate > 0) xr_.requestRefreshRate((float)rate);
    double fov = opts.n("foveation", config_.at("xr").n("foveation", -1)); if (fov >= 0) xr_.setFoveation((float)fov); }
#endif
  out.type = Json::Object;
  auto num = [&](const char* k, double v) { Json j; j.type = Json::Number; j.num = v; out.obj[k] = j; };
  auto flag = [&](const char* k, bool v) { Json j; j.type = Json::Bool; j.b = v; out.obj[k] = j; };
  num("width", xr_.swapchainWidth()); num("height", xr_.swapchainHeight()); num("arraySize", xr_.swapchainArraySize()); num("rate", xr_.refreshRate()); num("viewCount", xr_.viewCount()); num("depthTexture", xr_.swapchainDepthTexture());
  Json rates; rates.type = Json::Array; for (float r : xr_.refreshRates()) { Json j; j.type = Json::Number; j.num = r; rates.arr.push_back(j); } out.obj["rates"] = rates;
#ifdef HOST_XR_OPENXR
  float bw = 0, bd = 0; const bool hasB = xr_.stageBounds(bw, bd);
  flag("hasStage", xr_.hasStage()); num("stageWidth", hasB ? bw : 0); num("stageDepth", hasB ? bd : 0); flag("hands", xr_.hasHandTracking());
  HOST_LOGI("xr begin (openxr: %s): %dx%d x%d", xr_.systemName().c_str(), xr_.swapchainWidth(), xr_.swapchainHeight(), xr_.swapchainArraySize());
#else
  flag("hasStage", xr_.hasStage()); num("stageWidth", 0); num("stageDepth", 0); flag("hands", false);
  HOST_LOGI("xr begin (emulated): %dx%d x%d", xr_.swapchainWidth(), xr_.swapchainHeight(), xr_.swapchainArraySize());
#endif
  return true;
}

void Host::xrEnd() { xrActive_ = false; xr_.destroySwapchain(); HOST_LOGI("xr end (emulated)"); }

void Host::rebindWindow(void* nativeWindow) {
  egl_.unbindWindow();
  if (!egl_.bindWindow((ANativeWindow*)nativeWindow)) { HOST_LOGE("window rebind failed"); return; }
  lastFlat_ = 0;   // a flat frame at once
  HOST_LOGI("window rebound (%dx%d)", egl_.windowWidth(), egl_.windowHeight());
}

double Host::heapMB() { if (!jsUp_) return 0; v8::HeapStatistics hs; engine_.isolate()->GetHeapStatistics(&hs); return hs.used_heap_size() / 1048576.0; }

void Host::captureShots(const XrFrameInfo* f) {
  if (shots_.empty()) return;
  std::vector<ShotReq> reqs; reqs.swap(shots_);
  for (auto& r : reqs) {
    int w = 0, h = 0; std::vector<unsigned char> rgba;
    PackGuard pack;  // the page may leave a pack buffer bound (gl/pack_guard.h)
    GLint prevRead = 0; glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    GLuint fbo = 0; glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
    if (f && f->colorTexture) {
      w = f->arraySize > 1 ? f->width : f->width / 2; h = f->height;
      if (f->arraySize > 1) glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f->colorTexture, 0, r.eye); else glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f->colorTexture, 0);
      rgba.resize((size_t)w * h * 4); glReadPixels(f->arraySize > 1 ? 0 : r.eye * w, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    } else if (egl_.windowWidth() > 0) { glBindFramebuffer(GL_READ_FRAMEBUFFER, 0); w = egl_.windowWidth(); h = egl_.windowHeight(); rgba.resize((size_t)w * h * 4); glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data()); }
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead); glDeleteFramebuffers(1, &fbo);
    if (w == 0) r.reply("{\"error\":\"nothing rendered\"}"); else r.reply(bridgeEncodeShot(w, h, rgba));
  }
}

void Host::stats(const XrFrameInfo* f) {
  const double now = loop_.now(); if (statT_ == 0) statT_ = now; frames_++;
  if (now - statT_ >= 5000) {
    fpsNow_ = frames_ * 1000.0 / (now - statT_); jsAvg_ = jsMs_ / frames_;
    HOST_LOGI("%s %.1f fps  js %.2f ms/frame  timers %zu  heap %.0f MB  [%s]", f ? "xr" : "flat", fpsNow_, jsAvg_, loop_.timerCount(), heapMB(), gc_.statsLine().c_str());
    frames_ = 0; statT_ = now; jsMs_ = 0;
  }
}

#ifndef HOST_VISION_IMMERSIVE
// The hosts whose platform neither ends nor offers sessions (mac, win, ios; the immersive vision host defines both
// in vision/vision_xr.mm). Plain definitions, not weak symbols: cl.exe has none.
bool emu::sessionEndRequested() { return false; }
bool emu::enterRequested() { return false; }
#endif

void Host::xrTick() {
  if (emu::sessionEndRequested()) {
    // The page is told its session ended (it does not call xr.end back for a native end), and the host's XR
    // state goes with it: the loop returns to the flat page until the page asks for a session again.
    HOST_LOGI("xr session ended by the platform");
    engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "end", 0, 0); });
    xrEnd();
    return;
  }
  if (xr_.state() != lastState_) {
    lastState_ = xr_.state();
    bool vis = lastState_ == XR_SESSION_STATE_VISIBLE || lastState_ == XR_SESSION_STATE_FOCUSED;
    engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "state", vis, lastState_ == XR_SESSION_STATE_FOCUSED); });
  }
  if (xr_.referenceSpaceChanged()) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "reset", 0, 0); });
  XrFrameInfo f;
  if (!xr_.beginFrame(f, loop_.now())) return;
  const double t0 = loop_.now();
  gc_.setInFrame(true);
  engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchFrame(iso, ctx, f, xr_.hasStage()); });
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (f.shouldRender) { splash_.sampleEye(f.colorTexture, f.width, f.height, f.arraySize, loop_.now()); captureShots(&f); }
  jsMs_ += loop_.now() - t0;
#ifdef HOST_XR_OPENXR
  if (f.shouldRender) mirrorToWindow(f);  // the left eye into the desktop window, before the image goes back to the runtime
#endif
  xr_.endFrame(f, f.shouldRender);  // emulated: presents and waits for vsync; OpenXR: submits (xrWaitFrame paces)
  // Ten seconds into XR the page has booted and warmed up: its compiled code goes to the cache, once per run.
  if (++xrFrames_ == 600 && svc_.codeCache) { const double t = loop_.now(); engine_.saveCodeCache(); modules_.saveCodeCache(); HOST_LOGI("code cache written in %.0f ms", loop_.now() - t); }
  gc_.setInFrame(false);
  gc_.afterSubmit();
  stats(&f);
}

#ifdef HOST_XR_OPENXR
// The desktop window under a real runtime: the left eye blitted in (letterboxed), swapped without waiting for
// vsync (xrWaitFrame paces the loop, not the monitor). The page's GL state is put back as emu_xr's present does.
void Host::mirrorToWindow(const XrFrameInfo& f) {
  if (!f.colorTexture || egl_.windowWidth() <= 0) return;
  if (!mirrorFbo_) { glGenFramebuffers(1, &mirrorFbo_); eglSwapInterval(egl_.display(), 0); }
  GLint prevRead = 0, prevDraw = 0; glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST); GLfloat cc[4]; glGetFloatv(GL_COLOR_CLEAR_VALUE, cc); GLboolean mask[4]; glGetBooleanv(GL_COLOR_WRITEMASK, mask);
  glDisable(GL_SCISSOR_TEST); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE); glClearColor(0, 0, 0, 1);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); glClear(GL_COLOR_BUFFER_BIT);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, mirrorFbo_);
  if (f.arraySize > 1) glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f.colorTexture, 0, 0);
  else glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f.colorTexture, 0);
  const int W = egl_.windowWidth(), H = egl_.windowHeight(), eyeW = f.arraySize > 1 ? f.width : f.width / 2, eyeH = f.height;
  const float sc = std::min((float)W / eyeW, (float)H / eyeH); const int dw = (int)(eyeW * sc), dh = (int)(eyeH * sc), x0 = (W - dw) / 2, y0 = (H - dh) / 2;
  glBlitFramebuffer(0, 0, eyeW, eyeH, x0, y0, x0 + dw, y0 + dh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  splash_.draw(W, H);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  if (scissor) glEnable(GL_SCISSOR_TEST);
  glClearColor(cc[0], cc[1], cc[2], cc[3]); glColorMask(mask[0], mask[1], mask[2], mask[3]);
  egl_.swap();
}
#endif

void Host::flatTick() {
  if (emu::enterRequested() && jsUp_) engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { xrDispatchEvent(iso, ctx, "offer", 0, 0); });
  double now = loop_.now();
  if (now - lastFlat_ >= 16.0) {
    lastFlat_ = now;
    egl_.makeCurrentPreferred();
    const int fbW = egl_.windowWidth(), fbH = egl_.windowHeight();
    float cssW = 0, cssH = 0, dpr = 1; emu::viewport(cssW, cssH, dpr);
    if (dpr <= 0) dpr = 1;
    if (cssW <= 0 || cssH <= 0) { cssW = std::round(fbW / dpr); cssH = std::round(fbH / dpr); }
    touch::layout(cssW, cssH, dpr);
    engine_.run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) { dom::setViewport(iso, ctx, cssW, cssH, dpr, fbW, fbH, 0); nativeFlatFrame(iso, ctx, now); });
    touch::frame(now, true, fbW, fbH);
    splash_.sampleWindow(egl_.windowWidth(), egl_.windowHeight(), now); splash_.draw(egl_.windowWidth(), egl_.windowHeight());
    captureShots(nullptr); egl_.swap();
    jsMs_ += loop_.now() - now; stats(nullptr);
  }
}

bool Host::tick() {
  if (exit_) return false;
  if (xrUp_ && !xr_.pollEvents()) return false;
  const bool xrRendering = xrUp_ && xrActive_ && xr_.sessionRunning();
  dom::setAccepting(!xrRendering);  // in XR the window's input drives the emulated controllers instead
  if (xrRendering) xrTick(); else flatTick();
  engine_.pump(); audioTick(svc_); platformTick(svc_); store_.tick(loop_.now());
  double next = loop_.runOnce();
  engine_.pump();
  if (xrRendering) gc_.idleUntil(xr_.lastWakeMs() + xr_.framePeriodMs());
  else { gc_.idleUntil(GcScheduler::steadyMs() + (lastFlat_ + 16.0 - loop_.now())); double wait = next < 0 ? 4 : std::min(next, 4.0); std::this_thread::sleep_for(std::chrono::microseconds((int)(wait * 1000))); }
  return !exit_;
}

}  // namespace host
