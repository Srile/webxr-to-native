// __native.xr (record layouts: runtime/src/webxr/record.js). Fills the frame/input records from XrFrameInfo and
// calls the prelude's onFrame between xrBeginFrame and xrEndFrame.
#include "gl/gl_queue.h"
#include "js/natives.h"
#include "js/bind.h"
#include "js/engine.h"
#include "core/log.h"
#include "xr/openxr_device.h"
#include "xr/xr_frame_bridge.h"
#include <cstring>

namespace host {
namespace {
HostServices* g_svc = nullptr;
v8::Global<v8::Function> g_onFrame, g_onEvent;
v8::Global<v8::Float64Array> g_frame; v8::Global<v8::Float32Array> g_input;
double* g_framePtr = nullptr; float* g_inputPtr = nullptr;
constexpr int FRAME_LEN = 40, HAND_STRIDE = 288, GAZE_LEN = 16, INPUT_LEN = 2 * HAND_STRIDE + GAZE_LEN;  // record.js I.*

void ensureRecords(v8::Isolate* iso) {
  if (!g_frame.IsEmpty()) return;
  auto fb = v8::ArrayBuffer::New(iso, FRAME_LEN * 8); g_framePtr = (double*)fb->GetBackingStore()->Data(); g_frame.Reset(iso, v8::Float64Array::New(fb, 0, FRAME_LEN));
  auto ib = v8::ArrayBuffer::New(iso, INPUT_LEN * 4); g_inputPtr = (float*)ib->GetBackingStore()->Data(); g_input.Reset(iso, v8::Float32Array::New(ib, 0, INPUT_LEN));
  memset(g_framePtr, 0, FRAME_LEN * 8); memset(g_inputPtr, 0, INPUT_LEN * 4);
}

void xrSupported(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->xr != nullptr); }
void xrBegin(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  Json opts; opts.type = Json::Object;
  if (a.Length() && a[0]->IsObject()) { auto o = a[0].As<v8::Object>(); for (const char* k : {"arraySize", "scale", "preferredRate", "foveation", "format", "passthrough", "scene", "unpremultiplied", "srgbLayer"}) { v8::Local<v8::Value> v; if (o->Get(ctx, bind::str(iso, k)).ToLocal(&v) && v->IsNumber()) { Json n; n.type = Json::Number; n.num = v.As<v8::Number>()->Value(); opts.obj[k] = n; } } }
  Json out; if (!g_svc->xrBegin || !g_svc->xrBegin(opts, out)) { a.GetReturnValue().SetNull(); return; }
  v8::Local<v8::Object> r = v8::Object::New(iso);
  for (auto& kv : out.obj) { if (kv.second.type == Json::Number) bind::setNum(ctx, r, kv.first.c_str(), kv.second.num); else if (kv.second.type == Json::Bool) bind::setBool(ctx, r, kv.first.c_str(), kv.second.b);
    else if (kv.second.type == Json::Array) { v8::Local<v8::Array> arr = v8::Array::New(iso, (int)kv.second.arr.size()); for (size_t i = 0; i < kv.second.arr.size(); ++i) arr->Set(ctx, (uint32_t)i, v8::Number::New(iso, kv.second.arr[i].num)).Check(); bind::set(ctx, r, kv.first.c_str(), arr); } }
  a.GetReturnValue().Set(r);
}
void xrEnd(const v8::FunctionCallbackInfo<v8::Value>&) { if (g_svc->xrEnd) g_svc->xrEnd(); }
void xrOnFrame(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_onFrame.Reset(a.GetIsolate(), a[0].As<v8::Function>()); else g_onFrame.Reset(); }
void xrOnEvent(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_onEvent.Reset(a.GetIsolate(), a[0].As<v8::Function>()); else g_onEvent.Reset(); }
void xrSetDepthRange(const v8::FunctionCallbackInfo<v8::Value>& a) { if (g_svc->xr) g_svc->xr->setDepthRange((float)bind::num(a, 0), (float)bind::num(a, 1)); }
void xrRequestRate(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->xr && g_svc->xr->requestRefreshRate((float)bind::num(a, 0))); }
void xrSetFoveation(const v8::FunctionCallbackInfo<v8::Value>& a) { const float v = (float)bind::num(a, 0); a.GetReturnValue().Set(g_svc->xr && glq::sync("setFoveation", [&] { return g_svc->xr->setFoveation(v); })); }
void xrVibrate(const v8::FunctionCallbackInfo<v8::Value>& a) { if (g_svc->xr) g_svc->xr->input().vibrate(bind::i32(a, 0), (float)bind::num(a, 1, 1), (float)bind::num(a, 2, 0.05), (float)bind::num(a, 3, 0)); }
// What the system offers beyond the projection layer (the page's isSessionSupported('immersive-ar') and feature list).
void xrCaps(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); v8::Local<v8::Object> o = v8::Object::New(iso);
  OpenXrDevice* xr = g_svc->xr;
  bind::setBool(ctx, o, "passthrough", xr && xr->passthroughSupported()); bind::setBool(ctx, o, "scene", xr && xr->sceneSupported());
  bind::setBool(ctx, o, "capture", xr && xr->scene().captureSupported()); bind::setBool(ctx, o, "hands", xr && xr->hasHandTracking());
  a.GetReturnValue().Set(o);
}
void xrSetPassthrough(const v8::FunctionCallbackInfo<v8::Value>& a) { if (g_svc->xr) g_svc->xr->scene().setPassthroughVisible(bind::boolean(a, 0, true)); }
void xrRequestSceneCapture(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->xr && g_svc->xr->scene().requestCapture()); }
void xrSceneRefresh(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->xr && g_svc->xr->scene().requery()); }
// The pose record every listed entity is located into each frame: Float32Array over the device's own buffer (no copy).
v8::Global<v8::Float32Array> g_scenePoses;
void xrScenePoses(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (!g_svc->xr) { a.GetReturnValue().SetNull(); return; }
  if (g_scenePoses.IsEmpty()) {
    const float* rec = g_svc->xr->scene().poseRecord(); size_t bytes = (size_t)XrScene::kMaxEntities * XrScene::kPoseStride * sizeof(float);
#ifdef V8_ENABLE_SANDBOX
    // V8's sandbox (the Windows prebuilt) cannot alias the device's record; only the emulated headset, which has no scene, runs there.
    (void)rec; auto store = v8::ArrayBuffer::NewBackingStore(iso, bytes);
#else
    auto store = v8::ArrayBuffer::NewBackingStore((void*)rec, bytes, [](void*, size_t, void*) {}, nullptr);
#endif
    auto ab = v8::ArrayBuffer::New(iso, std::move(store));
    g_scenePoses.Reset(iso, v8::Float32Array::New(ab, 0, (size_t)XrScene::kMaxEntities * XrScene::kPoseStride));
  }
  a.GetReturnValue().Set(g_scenePoses.Get(iso));
}
// The entity list: [{ slot, id, kind: 1 plane | 2 mesh, label, changed, polygon?: Float32Array (x, z pairs), vertices?: Float32Array, indices?: Uint32Array }]
template <class T, class Arr> v8::Local<v8::Value> typedCopy(v8::Isolate* iso, const std::vector<T>& v, Arr (*make)(v8::Local<v8::ArrayBuffer>, size_t, size_t)) {
  auto ab = v8::ArrayBuffer::New(iso, v.size() * sizeof(T)); if (!v.empty()) memcpy(ab->GetBackingStore()->Data(), v.data(), v.size() * sizeof(T));
  return make(ab, 0, v.size());
}
void xrSceneEntities(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso);
  if (!g_svc->xr) { a.GetReturnValue().Set(arr); return; }
  uint32_t n = 0;
  for (const SceneEntity& e : g_svc->xr->scene().entities()) {
    if (e.slot < 0) continue;
    v8::Local<v8::Object> o = v8::Object::New(iso);
    bind::setNum(ctx, o, "slot", e.slot); bind::setStr(ctx, o, "id", e.id); bind::setNum(ctx, o, "kind", e.kind); bind::setStr(ctx, o, "label", e.label); bind::setNum(ctx, o, "changed", e.changed);
    if (e.kind == 1) bind::set(ctx, o, "polygon", typedCopy<float, v8::Local<v8::Float32Array>>(iso, e.polygon, v8::Float32Array::New));
    else { bind::set(ctx, o, "vertices", typedCopy<float, v8::Local<v8::Float32Array>>(iso, e.vertices, v8::Float32Array::New)); bind::set(ctx, o, "indices", typedCopy<uint32_t, v8::Local<v8::Uint32Array>>(iso, e.indices, v8::Uint32Array::New)); }
    arr->Set(ctx, n++, o).Check();
  }
  a.GetReturnValue().Set(arr);
}
// The runtime's controller models (xr/xr_render_models.h): [{ slot, id, hand: 0 left | 1 right | -1, glb: ArrayBuffer,
// nodes: [animatable node names] }], read again when the pose record's generation changes.
void xrRenderModels(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso);
  if (!g_svc->xr) { a.GetReturnValue().Set(arr); return; }
  const auto& models = g_svc->xr->renderModels().models();
  for (size_t i = 0; i < models.size(); ++i) {
    const RenderModelEntry& e = models[i];
    v8::Local<v8::Object> o = v8::Object::New(iso);
    bind::setNum(ctx, o, "slot", (double)i); bind::setNum(ctx, o, "hand", e.hand); bind::setStr(ctx, o, "id", std::to_string(e.id));
    auto ab = v8::ArrayBuffer::New(iso, e.glb.size()); if (!e.glb.empty()) memcpy(ab->GetBackingStore()->Data(), e.glb.data(), e.glb.size());
    bind::set(ctx, o, "glb", ab);
    v8::Local<v8::Array> names = v8::Array::New(iso, (int)e.nodes.size());
    for (size_t n = 0; n < e.nodes.size(); ++n) names->Set(ctx, (uint32_t)n, bind::str(iso, e.nodes[n].c_str())).Check();
    bind::set(ctx, o, "nodes", names);
    arr->Set(ctx, (uint32_t)i, o).Check();
  }
  a.GetReturnValue().Set(arr);
}
// Their pose record, rewritten every frame: Float32Array over the device's own buffer (no copy).
v8::Global<v8::Float32Array> g_renderModelPoses;
void xrRenderModelPoses(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (!g_svc->xr || !g_svc->xr->renderModels().enabled()) { a.GetReturnValue().SetNull(); return; }
  constexpr size_t len = XrRenderModels::kHeader + XrRenderModels::kMaxModels * XrRenderModels::kStride;
  if (g_renderModelPoses.IsEmpty()) {
#ifdef V8_ENABLE_SANDBOX
    auto store = v8::ArrayBuffer::NewBackingStore(iso, len * sizeof(float));  // the sandboxed (Windows) build has no runtime models
#else
    auto store = v8::ArrayBuffer::NewBackingStore((void*)g_svc->xr->renderModels().poseRecord(), len * sizeof(float), [](void*, size_t, void*) {}, nullptr);
#endif
    g_renderModelPoses.Reset(iso, v8::Float32Array::New(v8::ArrayBuffer::New(iso, std::move(store)), 0, len));
  }
  a.GetReturnValue().Set(g_renderModelPoses.Get(iso));
}
void xrState(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); v8::Local<v8::Object> o = v8::Object::New(iso);
  bool running = g_svc->xr && g_svc->xr->sessionRunning(); XrSessionState st = g_svc->xr ? g_svc->xr->state() : XR_SESSION_STATE_UNKNOWN;
  bind::setBool(ctx, o, "running", running); bind::setBool(ctx, o, "visible", st == XR_SESSION_STATE_VISIBLE || st == XR_SESSION_STATE_FOCUSED); bind::setBool(ctx, o, "focused", st == XR_SESSION_STATE_FOCUSED);
  bind::setNum(ctx, o, "rate", g_svc->xr ? g_svc->xr->refreshRate() : 0); a.GetReturnValue().Set(o);
}
}  // namespace

void installXr(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  g_svc = &svc; ensureRecords(isolateOf(ctx));
  v8::Local<v8::Object> xr = bind::obj(ctx, native, "xr");
  bind::fn(ctx, xr, "supported", xrSupported); bind::fn(ctx, xr, "begin", xrBegin); bind::fn(ctx, xr, "end", xrEnd); bind::fn(ctx, xr, "setDepthRange", xrSetDepthRange);
  bind::fn(ctx, xr, "onFrame", xrOnFrame); bind::fn(ctx, xr, "onEvent", xrOnEvent); bind::fn(ctx, xr, "requestRefreshRate", xrRequestRate);
  bind::fn(ctx, xr, "setFoveation", xrSetFoveation); bind::fn(ctx, xr, "vibrate", xrVibrate); bind::fn(ctx, xr, "state", xrState);
  bind::fn(ctx, xr, "caps", xrCaps); bind::fn(ctx, xr, "setPassthrough", xrSetPassthrough); bind::fn(ctx, xr, "requestSceneCapture", xrRequestSceneCapture);
  bind::fn(ctx, xr, "sceneRefresh", xrSceneRefresh); bind::fn(ctx, xr, "scenePoses", xrScenePoses); bind::fn(ctx, xr, "sceneEntities", xrSceneEntities);
  bind::fn(ctx, xr, "renderModels", xrRenderModels); bind::fn(ctx, xr, "renderModelPoses", xrRenderModelPoses);
}

bool xrHasFrameCallback() { return !g_onFrame.IsEmpty(); }

void xrDispatchFrame(v8::Isolate* iso, v8::Local<v8::Context> ctx, const XrFrameInfo& f, bool baseIsStage) {
  if (g_onFrame.IsEmpty()) return;
  double* r = g_framePtr;
  r[0] = f.displayTimeMs; r[1] = f.shouldRender ? 1 : 0; r[2] = f.viewCount; r[3] = f.colorTexture; r[4] = f.width; r[5] = f.height; r[6] = f.arraySize; r[7] = f.imageIndex;
  for (int v = 0; v < 2; ++v) { const auto& vw = f.views[v]; double* o = r + 8 + v * 11; for (int i = 0; i < 3; ++i) o[i] = vw.pos[i]; for (int i = 0; i < 4; ++i) o[3 + i] = vw.quat[i]; o[7] = vw.fovL; o[8] = vw.fovR; o[9] = vw.fovU; o[10] = vw.fovD; }
  for (int i = 0; i < 3; ++i) r[30 + i] = f.localInBasePos[i]; for (int i = 0; i < 4; ++i) r[33 + i] = f.localInBaseQuat[i];
  r[37] = g_svc->xr ? g_svc->xr->refreshRate() : 0; r[38] = baseIsStage ? 1 : 0; r[39] = f.sceneGeneration;
  for (int h = 0; h < 2; ++h) {
    const XrHandState& hs = f.input.hand[h]; float* o = g_inputPtr + h * HAND_STRIDE;
    o[0] = hs.active; o[1] = hs.handTracked; o[2] = hs.grip.valid; for (int i = 0; i < 3; ++i) o[3 + i] = hs.grip.pos[i]; for (int i = 0; i < 4; ++i) o[6 + i] = hs.grip.quat[i];
    o[10] = hs.aim.valid; for (int i = 0; i < 3; ++i) o[11 + i] = hs.aim.pos[i]; for (int i = 0; i < 4; ++i) o[14 + i] = hs.aim.quat[i];
    for (int i = 0; i < 8; ++i) { o[18 + i] = hs.buttonValue[i]; o[26 + i] = hs.buttonPressed[i]; o[34 + i] = hs.buttonTouched[i]; }
    for (int i = 0; i < 4; ++i) o[42 + i] = hs.axes[i]; o[46] = hs.pinching; o[47] = hs.pinchStrength;
    for (int j = 0; j < 26; ++j) { float* jo = o + 48 + j * 9; for (int i = 0; i < 8; ++i) jo[i] = hs.joints[j][i]; jo[8] = hs.jointValid[j]; }
  }
  { float* o = g_inputPtr + 2 * HAND_STRIDE; const XrInputState& in = f.input;   // the gaze (record.js I.GAZE_*)
    o[0] = in.gazeActive; o[1] = in.gaze.valid; for (int i = 0; i < 3; ++i) o[2 + i] = in.gaze.pos[i]; for (int i = 0; i < 4; ++i) o[5 + i] = in.gaze.quat[i];
    o[9] = in.gazePressed; o[10] = in.gazeValue; }
  v8::HandleScope hs(iso); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
  v8::Local<v8::Value> argv[2] = {g_frame.Get(iso), g_input.Get(iso)};
  (void)g_onFrame.Get(iso)->Call(ctx, ctx->Global(), 2, argv);
  if (tc.HasCaught()) g_svc->engine->reportException(tc);
  iso->PerformMicrotaskCheckpoint();
}

void xrDispatchEvent(v8::Isolate* iso, v8::Local<v8::Context> ctx, const char* type, double a, double b) {
  if (g_onEvent.IsEmpty()) return;
  v8::HandleScope hs(iso); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
  v8::Local<v8::Value> argv[3] = {bind::str(iso, type), v8::Number::New(iso, a), v8::Number::New(iso, b)};
  (void)g_onEvent.Get(iso)->Call(ctx, ctx->Global(), 3, argv);
  if (tc.HasCaught()) g_svc->engine->reportException(tc);
  iso->PerformMicrotaskCheckpoint();
}

}  // namespace host
