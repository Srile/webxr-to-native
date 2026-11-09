// WP-09: Meta Platform SDK → __native.platform (entitlement, user, leaderboards, achievements).
// Compiled with the real SDK only when third_party/ovr_platform_sdk/Include/OVR_Platform.h exists
// (CMake defines HOST_HAS_OVR_PLATFORM); otherwise installPlatform installs nothing and
// navigator.horizon stays absent, which is the web providers' cue.
#include "js/natives.h"
#include "js/bind.h"
#include "js/engine.h"
#include "core/log.h"
#include <map>
#include <string>

#ifdef HOST_HAS_OVR_PLATFORM
#include <OVR_Platform.h>
#include <android_native_app_glue.h>
#include <jni.h>

namespace host {
namespace {
HostServices* g_svc = nullptr;
bool g_inited = false;
struct Pending { v8::Global<v8::Promise::Resolver> resolver; std::string kind; };
std::map<ovrRequest, Pending> g_pending;

v8::Local<v8::Promise> promiseFor(v8::Isolate* iso, ovrRequest req, const char* kind) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext(); auto r = v8::Promise::Resolver::New(ctx).ToLocalChecked();
  if (req == invalidRequestID) { r->Reject(ctx, v8::Exception::Error(bind::str(iso, std::string(kind) + ": request failed"))).Check(); return r->GetPromise(); }
  Pending p; p.resolver.Reset(iso, r); p.kind = kind; g_pending[req] = std::move(p); return r->GetPromise();
}
void rejectError(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Promise::Resolver> r, ovrMessageHandle m) {
  ovrErrorHandle e = ovr_Message_GetError(m); std::string msg = e ? ovr_Error_GetMessage(e) : "unknown"; int code = e ? ovr_Error_GetCode(e) : 0;
  v8::Local<v8::Object> err = v8::Exception::Error(bind::str(iso, msg)).As<v8::Object>(); bind::setNum(ctx, err, "code", code); r->Reject(ctx, err).Check();
}

void pInit(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); std::string appId = bind::string(a, 0);
  JNIEnv* env = nullptr; g_svc->host ? (void)0 : (void)0;
  JavaVM* vm = (JavaVM*)g_svc->javaVm; jobject activity = (jobject)g_svc->activity;
  vm->GetEnv((void**)&env, JNI_VERSION_1_6);
  ovrRequest req = ovr_PlatformInitializeAndroidAsynchronous(appId.c_str(), activity, env);
  g_inited = req != invalidRequestID; HOST_LOGI("ovr_PlatformInitializeAndroidAsynchronous(%s): %s", appId.c_str(), g_inited ? "ok" : "failed");
  a.GetReturnValue().Set(promiseFor(iso, req, "init"));
}
void pEntitled(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Entitlement_GetIsViewerEntitled(), "entitled")); }
void pUser(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_User_GetLoggedInUser(), "user")); }
// The viewer's age category (Meta's Get Age Category API, mandatory for a Mixed Ages listing): "child" | "teen" | "adult" | "unknown".
void pAge(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_UserAgeCategory_Get(), "age")); }
void pLbWrite(const v8::FunctionCallbackInfo<v8::Value>& a) { std::string name = bind::string(a, 0); long long score = (long long)bind::num(a, 1); bool force = bind::boolean(a, 3, false); std::string extra = bind::string(a, 2);
  a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Leaderboard_WriteEntry(name.c_str(), score, extra.empty() ? nullptr : extra.data(), (unsigned)extra.size(), force), "lbWrite")); }
void pLbRead(const v8::FunctionCallbackInfo<v8::Value>& a) { std::string name = bind::string(a, 0); int limit = bind::i32(a, 1, 10); std::string filter = bind::string(a, 2), start = bind::string(a, 3);
  ovrLeaderboardFilterType f = filter == "friends" ? ovrLeaderboard_FilterFriends : ovrLeaderboard_FilterNone; ovrLeaderboardStartAt s = start == "centered" ? ovrLeaderboard_StartAtCenteredOnViewer : start == "viewer" ? ovrLeaderboard_StartAtCenteredOnViewerOrTop : ovrLeaderboard_StartAtTop;
  a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Leaderboard_GetEntries(name.c_str(), limit, f, s), "lbRead")); }
void pAchUnlock(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Achievements_Unlock(bind::string(a, 0).c_str()), "achUnlock")); }
void pAchAdd(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Achievements_AddCount(bind::string(a, 0).c_str(), (unsigned long long)bind::num(a, 1, 1)), "achAdd")); }
void pAchBits(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Achievements_AddFields(bind::string(a, 0).c_str(), bind::string(a, 1).c_str()), "achBits")); }
void pAchAll(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(promiseFor(a.GetIsolate(), ovr_Achievements_GetAllProgress(), "achAll")); }

void settle(v8::Isolate* iso, v8::Local<v8::Context> ctx, Pending& p, ovrMessageHandle m) {
  v8::Local<v8::Promise::Resolver> r = p.resolver.Get(iso);
  if (ovr_Message_IsError(m)) return rejectError(iso, ctx, r, m);
  const std::string& k = p.kind;
  if (k == "init") { r->Resolve(ctx, v8::Boolean::New(iso, true)).Check(); return; }
  if (k == "entitled") { r->Resolve(ctx, v8::Boolean::New(iso, true)).Check(); return; }
  if (k == "age") { ovrUserAccountAgeCategoryHandle h = ovr_Message_GetUserAccountAgeCategory(m); ovrAccountAgeCategory c = h ? ovr_UserAccountAgeCategory_GetAgeCategory(h) : ovrAccountAgeCategory_Unknown;
    const char* s = c == ovrAccountAgeCategory_Ch ? "child" : c == ovrAccountAgeCategory_Tn ? "teen" : c == ovrAccountAgeCategory_Ad ? "adult" : "unknown"; r->Resolve(ctx, bind::str(iso, s)).Check(); return; }
  if (k == "user") { ovrUserHandle u = ovr_Message_GetUser(m); v8::Local<v8::Object> o = v8::Object::New(iso); bind::setStr(ctx, o, "id", std::to_string(ovr_User_GetID(u))); bind::setStr(ctx, o, "displayName", ovr_User_GetDisplayName(u) ? ovr_User_GetDisplayName(u) : ""); bind::setStr(ctx, o, "oculusId", ovr_User_GetOculusID(u) ? ovr_User_GetOculusID(u) : ""); bind::setStr(ctx, o, "imageUrl", ovr_User_GetImageUrl(u) ? ovr_User_GetImageUrl(u) : ""); r->Resolve(ctx, o).Check(); return; }
  if (k == "lbWrite") { ovrLeaderboardUpdateStatusHandle s = ovr_Message_GetLeaderboardUpdateStatus(m); v8::Local<v8::Object> o = v8::Object::New(iso); bind::setBool(ctx, o, "updated", s ? ovr_LeaderboardUpdateStatus_GetDidUpdate(s) : false); r->Resolve(ctx, o).Check(); return; }
  if (k == "lbRead") { ovrLeaderboardEntryArrayHandle arr = ovr_Message_GetLeaderboardEntryArray(m); size_t n = ovr_LeaderboardEntryArray_GetSize(arr); v8::Local<v8::Array> rows = v8::Array::New(iso, (int)n);
    for (size_t i = 0; i < n; ++i) { ovrLeaderboardEntryHandle e = ovr_LeaderboardEntryArray_GetElement(arr, i); v8::Local<v8::Object> o = v8::Object::New(iso); bind::setNum(ctx, o, "rank", ovr_LeaderboardEntry_GetRank(e)); bind::setNum(ctx, o, "score", (double)ovr_LeaderboardEntry_GetScore(e)); bind::setNum(ctx, o, "timestamp", (double)ovr_LeaderboardEntry_GetTimestamp(e));
      ovrUserHandle u = ovr_LeaderboardEntry_GetUser(e); bind::setStr(ctx, o, "userId", u ? std::to_string(ovr_User_GetID(u)) : ""); bind::setStr(ctx, o, "displayName", u && ovr_User_GetDisplayName(u) ? ovr_User_GetDisplayName(u) : "");
      unsigned ex = ovr_LeaderboardEntry_GetExtraDataLength(e); const void* ed = ovr_LeaderboardEntry_GetExtraData(e); bind::setStr(ctx, o, "extra", ed && ex ? std::string((const char*)ed, ex) : ""); rows->Set(ctx, (uint32_t)i, o).Check(); }
    v8::Local<v8::Object> o = v8::Object::New(iso); bind::set(ctx, o, "entries", rows); bind::setNum(ctx, o, "total", (double)ovr_LeaderboardEntryArray_GetTotalCount(arr)); bind::setBool(ctx, o, "hasNext", ovr_LeaderboardEntryArray_HasNextPage(arr)); r->Resolve(ctx, o).Check(); return; }
  if (k == "achUnlock" || k == "achAdd" || k == "achBits") { ovrAchievementUpdateHandle u = ovr_Message_GetAchievementUpdate(m); v8::Local<v8::Object> o = v8::Object::New(iso); bind::setBool(ctx, o, "justUnlocked", u ? ovr_AchievementUpdate_GetJustUnlocked(u) : false); r->Resolve(ctx, o).Check(); return; }
  if (k == "achAll") { ovrAchievementProgressArrayHandle arr = ovr_Message_GetAchievementProgressArray(m); size_t n = ovr_AchievementProgressArray_GetSize(arr); v8::Local<v8::Array> rows = v8::Array::New(iso, (int)n);
    for (size_t i = 0; i < n; ++i) { ovrAchievementProgressHandle p2 = ovr_AchievementProgressArray_GetElement(arr, i); v8::Local<v8::Object> o = v8::Object::New(iso); bind::setStr(ctx, o, "name", ovr_AchievementProgress_GetName(p2)); bind::setBool(ctx, o, "unlocked", ovr_AchievementProgress_GetIsUnlocked(p2)); bind::setNum(ctx, o, "count", (double)ovr_AchievementProgress_GetCount(p2)); bind::setStr(ctx, o, "bitfield", ovr_AchievementProgress_GetBitfield(p2) ? ovr_AchievementProgress_GetBitfield(p2) : ""); bind::setNum(ctx, o, "unlockTime", (double)ovr_AchievementProgress_GetUnlockTime(p2)); rows->Set(ctx, (uint32_t)i, o).Check(); }
    r->Resolve(ctx, rows).Check(); return; }
  r->Resolve(ctx, v8::Undefined(iso)).Check();
}
}  // namespace

void installPlatform(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  g_svc = &svc; v8::Local<v8::Object> p = bind::obj(ctx, native, "platform");
  bind::fn(ctx, p, "init", pInit); bind::fn(ctx, p, "entitled", pEntitled); bind::fn(ctx, p, "user", pUser); bind::fn(ctx, p, "ageCategory", pAge);
  bind::fn(ctx, p, "lbWrite", pLbWrite); bind::fn(ctx, p, "lbRead", pLbRead);
  bind::fn(ctx, p, "achUnlock", pAchUnlock); bind::fn(ctx, p, "achAdd", pAchAdd); bind::fn(ctx, p, "achBits", pAchBits); bind::fn(ctx, p, "achAll", pAchAll);
  bind::setBool(ctx, p, "available", true);
}

void platformTick(HostServices& svc) {
  if (!g_inited) return;
  for (;;) {
    ovrMessageHandle m = ovr_PopMessage(); if (!m) break;
    ovrRequest req = ovr_Message_GetRequestID(m);
    auto it = g_pending.find(req);
    if (it != g_pending.end()) { v8::Isolate* iso = svc.engine->isolate(); v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = svc.engine->context(); v8::Context::Scope cs(ctx); settle(iso, ctx, it->second, m); g_pending.erase(it); iso->PerformMicrotaskCheckpoint(); }
    ovr_FreeMessage(m);
  }
}
}  // namespace host

#else
namespace host {
void installPlatform(v8::Local<v8::Context>, v8::Local<v8::Object>, HostServices&) { HOST_LOGI("Meta Platform SDK not bundled; navigator.horizon absent"); }
void platformTick(HostServices&) {}
}
#endif
