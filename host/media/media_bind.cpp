// __native.media (WP-25): microphone capture for runtime/src/media (navigator.mediaDevices, MediaStream,
// MediaStreamTrack) and the audio binding's MediaStreamAudioSourceNode. Built only with HOST_MICROPHONE
// (host.json media.microphone, host/microphone.cmake); a build without it has none of this file.
//   platform                          'android' | 'mac' | 'linux' | 'none'
//   permission() → 'granted' | 'denied' | 'prompt'
//   request(cb(state))                asks where the platform asks (Android's runtime-permission dialog, macOS's
//                                     TCC prompt); cb on the loop with the state after it
//   devices() → [{ deviceId, groupId, label }]   the default input
//   capabilities() → { echoCancellation: [bool], noiseSuppression: [bool], autoGainControl: [bool] }
//   open({ echoCancellation, noiseSuppression, autoGainControl }) → { id, label, deviceId, groupId, sampleRate,
//       echoCancellation, noiseSuppression, autoGainControl, preset } | 'NotReadableError: ...' (a string)
//   stop(id)        the track ends (the device closes with the last live one); release(id) forgets it too
//   setEnabled(id, on)
//   onEvent(cb(kind, id))             'ended' id (device lost) | 'devicechange'
//   stats() → { live, opens, sampleRate, written, underruns, overruns, preset }
#include "js/natives.h"
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include "core/log.h"
#include "core/loop.h"
#include "js/bind.h"
#include "js/engine.h"
#include "media/mic.h"
#ifdef __ANDROID__
#include "android/jni_env.h"
#include "android/permissions.h"
#include "xr/openxr_device.h"
#endif

namespace host {

#if defined(__APPLE__)
namespace media { int macMicAuthorization(); void macMicRequest(std::function<void(bool)> done); }  // mic_permission_mac.mm
#endif

namespace {
using Args = v8::FunctionCallbackInfo<v8::Value>;
using media::Mic;
HostServices* g_svc = nullptr;
v8::Global<v8::Function> g_onEvent;
std::vector<v8::Global<v8::Function>> g_waiters;  // request() callbacks while a request is in flight
bool g_requesting = false;

#if defined(__ANDROID__)
constexpr const char* kPlatform = "android";
#elif defined(__APPLE__)
constexpr const char* kPlatform = "mac";
#elif defined(__linux__)
constexpr const char* kPlatform = "linux";
#else
constexpr const char* kPlatform = "none";
#endif

#ifdef __ANDROID__
// RECORD_AUDIO is a runtime permission: asked for when the page first calls getUserMedia (not at launch), through
// Activity.requestPermissions. The dialog's answer never reaches a NativeActivity, so the request is watched from
// a loop timer: granted as soon as checkSelfPermission says so; denied once the dialog has come and gone (the
// activity's window lost and regained focus, or the XR session left FOCUSED and came back) without the grant.
// Android answers at once, with no dialog, for a permission the person denied for good (asked before, and no
// rationale to show): that is denied without waiting.
constexpr const char* kRecordAudio = "android.permission.RECORD_AUDIO";
bool deniedThisRun = false;
std::string askedMarker() { return g_svc->filesDir + "/.mic-permission-asked"; }
bool askedBefore() { struct stat st; return stat(askedMarker().c_str(), &st) == 0; }
bool activityBool(const char* method, const char* sig, const char* arg = nullptr) {
  if (!g_svc->javaVm || !g_svc->activity) return false;
  JniEnv e(g_svc->javaVm); if (!e.env) return false;
  jobject act = (jobject)g_svc->activity; jclass cls = e.env->GetObjectClass(act);
  jmethodID m = e.env->GetMethodID(cls, method, sig); jboolean r = JNI_FALSE;
  if (!m) e.env->ExceptionClear();
  else if (arg) { jstring s = e.env->NewStringUTF(arg); r = e.env->CallBooleanMethod(act, m, s); e.env->DeleteLocalRef(s); }
  else r = e.env->CallBooleanMethod(act, m);
  if (e.env->ExceptionCheck()) { e.env->ExceptionClear(); r = JNI_FALSE; }
  e.env->DeleteLocalRef(cls);
  return r == JNI_TRUE;
}
bool granted() { return hasPermission(g_svc->javaVm, g_svc->activity, kRecordAudio); }
bool windowFocused() { return activityBool("hasWindowFocus", "()Z"); }
bool xrFocused() { return g_svc->xr && g_svc->xr->state() == XR_SESSION_STATE_FOCUSED; }
const char* permissionState() {
  if (granted()) return "granted";
  if (deniedThisRun || (askedBefore() && !activityBool("shouldShowRequestPermissionRationale", "(Ljava/lang/String;)Z", kRecordAudio))) return "denied";
  return "prompt";
}
struct Watch { double t0 = 0, backAt = 0; bool focus0 = false, xr0 = false, away = false; uint32_t timer = 0; } g_watch;
#elif defined(__APPLE__)
const char* permissionState() { const int s = media::macMicAuthorization(); return s == 3 ? "granted" : s == 0 ? "prompt" : "denied"; }  // AVAuthorizationStatus
#else
const char* permissionState() { return "granted"; }  // PulseAudio has no permission of its own
#endif

void settle(bool ok) {
  g_requesting = false;
  HOST_LOGI("mic: permission %s", ok ? "granted" : "denied");
  std::vector<v8::Global<v8::Function>> waiters; waiters.swap(g_waiters);
  g_svc->engine->run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
    for (auto& w : waiters) { v8::Local<v8::Value> argv[1] = {bind::str(iso, ok ? "granted" : "denied")}; (void)w.Get(iso)->Call(ctx, ctx->Global(), 1, argv); }
    iso->PerformMicrotaskCheckpoint();
  });
}

void startRequest() {
#ifdef __ANDROID__
  if (granted()) { settle(true); return; }
  if (askedBefore() && !activityBool("shouldShowRequestPermissionRationale", "(Ljava/lang/String;)Z", kRecordAudio)) {
    HOST_LOGW("mic: RECORD_AUDIO was denied for good; the system shows no dialog (allow it in the app's settings)");
    deniedThisRun = true; settle(false); return;
  }
  requestPermission(g_svc->javaVm, g_svc->activity, kRecordAudio);
  if (FILE* f = fopen(askedMarker().c_str(), "w")) fclose(f);
  g_watch = Watch{}; g_watch.t0 = g_svc->loop->now(); g_watch.focus0 = windowFocused(); g_watch.xr0 = xrFocused();
  HOST_LOGI("mic: asked for RECORD_AUDIO (window focus %d, XR focused %d)", g_watch.focus0, g_watch.xr0);
  g_watch.timer = g_svc->loop->setTimer(100, true, [] {
    const double now = g_svc->loop->now();
    bool done = false, ok = false;
    if (granted()) { done = ok = true; }
    else {
      const bool away = (g_watch.focus0 && !windowFocused()) || (g_watch.xr0 && !xrFocused());
      if (away) { if (!g_watch.away) HOST_LOGI("mic: permission dialog up (the page lost focus)"); g_watch.away = true; g_watch.backAt = 0; }
      else if (g_watch.away) { if (g_watch.backAt == 0) g_watch.backAt = now; else if (now - g_watch.backAt >= 400) { done = true; ok = granted(); } }
      if (!g_watch.away && now - g_watch.t0 > 10000) { HOST_LOGW("mic: no permission dialog appeared in 10 s"); done = true; }
    }
    if (!done) return;
    g_svc->loop->clearTimer(g_watch.timer); g_watch.timer = 0;
    if (!ok) deniedThisRun = true;
    settle(ok);
  });
#elif defined(__APPLE__)
  if (media::macMicAuthorization() != 0) { settle(media::macMicAuthorization() == 3); return; }
  HOST_LOGI("mic: asking macOS for the microphone (the prompt names the app that started this process)");
  Loop* loop = g_svc->loop;
  media::macMicRequest([loop](bool ok) { loop->post([ok] { settle(ok); }); });
#else
  settle(true);
#endif
}

void permission(const Args& a) { a.GetReturnValue().Set(bind::str(a.GetIsolate(), permissionState())); }
void request(const Args& a) {
  if (a.Length() < 1 || !a[0]->IsFunction()) { bind::throwType(a.GetIsolate(), "request(cb)"); return; }
  g_waiters.emplace_back(a.GetIsolate(), a[0].As<v8::Function>());
  if (g_requesting) return;
  g_requesting = true;
  g_svc->loop->post([] { startRequest(); });  // never synchronously: the page's promise settles from the loop
}

std::string groupId(const std::string& label) {
  uint32_t h = 2166136261u; for (unsigned char c : label) { h ^= c; h *= 16777619u; }
  char b[16]; snprintf(b, sizeof b, "%08x", h); return b;
}
void devices(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso);
  if (strcmp(kPlatform, "none") != 0) {
    const std::string label = Mic::get().live() ? Mic::get().label() : Mic::get().defaultLabel();
    v8::Local<v8::Object> d = v8::Object::New(iso);
    bind::setStr(ctx, d, "deviceId", "default"); bind::setStr(ctx, d, "groupId", groupId(label)); bind::setStr(ctx, d, "label", label);
    arr->Set(ctx, 0, d).Check();
  }
  a.GetReturnValue().Set(arr);
}
void capabilities(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  const bool android = strcmp(kPlatform, "android") == 0;  // the input presets turn the platform's processing on and off
  for (const char* k : {"echoCancellation", "noiseSuppression", "autoGainControl"}) {
    v8::Local<v8::Array> v = v8::Array::New(iso);
    if (android) { v->Set(ctx, 0, v8::True(iso)).Check(); v->Set(ctx, 1, v8::False(iso)).Check(); } else v->Set(ctx, 0, v8::False(iso)).Check();
    bind::set(ctx, o, k, v);
  }
  a.GetReturnValue().Set(o);
}
bool boolOpt(v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, bool d) {
  v8::Local<v8::Value> v; if (!o->Get(ctx, bind::str(isolateOf(ctx), k)).ToLocal(&v) || v->IsUndefined()) return d;
  return v->BooleanValue(isolateOf(ctx));
}
void open(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  media::Processing want;
  if (a.Length() > 0 && a[0]->IsObject()) {
    v8::Local<v8::Object> o = a[0].As<v8::Object>();
    want.echoCancellation = boolOpt(ctx, o, "echoCancellation", true);
    want.noiseSuppression = boolOpt(ctx, o, "noiseSuppression", true);
    want.autoGainControl = boolOpt(ctx, o, "autoGainControl", true);
  }
  if (strcmp(permissionState(), "granted") != 0) { a.GetReturnValue().Set(bind::str(iso, "NotAllowedError: the microphone permission is not granted")); return; }
  std::string err; Mic& m = Mic::get();
  const uint32_t id = m.open(want, &err);
  if (!id) { HOST_LOGW("mic: %s", err.c_str()); a.GetReturnValue().Set(bind::str(iso, err)); return; }
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "id", id); bind::setStr(ctx, o, "label", m.label()); bind::setStr(ctx, o, "deviceId", "default"); bind::setStr(ctx, o, "groupId", groupId(m.label()));
  bind::setNum(ctx, o, "sampleRate", m.rate()); bind::setStr(ctx, o, "preset", m.preset());
  bind::setBool(ctx, o, "echoCancellation", m.processing().echoCancellation); bind::setBool(ctx, o, "noiseSuppression", m.processing().noiseSuppression);
  bind::setBool(ctx, o, "autoGainControl", m.processing().autoGainControl);
  a.GetReturnValue().Set(o);
}
void stop(const Args& a) { Mic::get().stop(bind::u32(a, 0)); }
void release(const Args& a) { Mic::get().release(bind::u32(a, 0)); }
void setEnabled(const Args& a) { a.GetReturnValue().Set(Mic::get().setEnabled(bind::u32(a, 0), bind::boolean(a, 1))); }
void onEvent(const Args& a) { if (a.Length() > 0 && a[0]->IsFunction()) g_onEvent.Reset(a.GetIsolate(), a[0].As<v8::Function>()); else g_onEvent.Reset(); }
void stats(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); Mic& m = Mic::get();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "live", m.live()); bind::setNum(ctx, o, "opens", m.opens()); bind::setNum(ctx, o, "sampleRate", m.live() ? m.rate() : 0);
  bind::setNum(ctx, o, "written", (double)m.ring().written()); bind::setNum(ctx, o, "underruns", m.ring().underruns()); bind::setNum(ctx, o, "overruns", m.ring().overruns());
  bind::setStr(ctx, o, "preset", m.live() ? m.preset() : "");
  a.GetReturnValue().Set(o);
}
audio::LiveInput* trackInput(uint32_t id) { return Mic::get().input(id); }
}  // namespace

void installMedia(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  g_svc = &svc;
  const double tone = svc.config ? svc.config->at("debug").n("micTone", 0) : 0;
  Mic::get().init(svc.loop, tone);
  if (tone > 0) HOST_LOGW("mic: debug.micTone: the capture delivers a %.0f Hz tone, not the microphone", tone);
  Mic::get().onEvent = [](const char* kind, uint32_t id) {
    if (g_onEvent.IsEmpty()) return;
    g_svc->engine->run([&](v8::Isolate* iso, v8::Local<v8::Context> c) {
      v8::Local<v8::Value> argv[2] = {bind::str(iso, kind), v8::Number::New(iso, id)};
      (void)g_onEvent.Get(iso)->Call(c, c->Global(), 2, argv);
    });
  };
  setAudioLiveInputs(&trackInput);  // __native.audio.setInput (installAudio runs after this)
  v8::Local<v8::Object> o = bind::obj(ctx, native, "media");
  bind::setStr(ctx, o, "platform", kPlatform);
  bind::fn(ctx, o, "permission", permission); bind::fn(ctx, o, "request", request); bind::fn(ctx, o, "devices", devices);
  bind::fn(ctx, o, "capabilities", capabilities); bind::fn(ctx, o, "open", open); bind::fn(ctx, o, "stop", stop); bind::fn(ctx, o, "release", release);
  bind::fn(ctx, o, "setEnabled", setEnabled); bind::fn(ctx, o, "onEvent", onEvent); bind::fn(ctx, o, "stats", stats);
  HOST_LOGI("media: microphone capture (%s), permission %s", kPlatform, permissionState());
}

}  // namespace host
