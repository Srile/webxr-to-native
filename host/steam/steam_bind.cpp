// __native.steam: Steamworks for a game whose host.json names its Steam app (steam.appId) and ships the Steamworks
// SDK's Android library (steam.lib, packed as libsteam_api.so). On the Steam Frame, Lepton mounts the Steam client's
// own Android libraries (libsteamclient.so) and points Steam3Master at the host's Steam client, so the flat API works
// as on a desktop. The library is opened at runtime (dlopen) and its callbacks run by manual dispatch on the host
// loop, so a game without it builds and runs as before.
//
//   init(appId) -> { ok, error, steamId, name, language, owned }
//   authTicket(identity, cb(hex | null))                    GetAuthTicketForWebApi
//   friends() -> [[steamId, name, state, playingThisApp]]   immediate friends; state: EPersonaState
//   createLobby(type, max, cb(lobbyId | null)), joinLobby(id, cb(ok)), leaveLobby(id)
//   setLobbyData(id, key, value) -> bool, getLobbyData(id, key) -> string, inviteToLobby(lobby, friend) -> bool
//   setRichPresence(key, value | null)
//   onJoinRequested(cb(lobbyId | null, connect | null))     an invitation accepted, or "Join Game"
// SteamIDs and lobby ids travel as decimal strings (they pass 2^53).
#include "js/natives.h"
#include "core/log.h"
#include "core/loop.h"
#include "js/bind.h"
#include "js/engine.h"
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>
#if defined(__ANDROID__) || defined(__linux__)
#include <dlfcn.h>
#define HOST_STEAM_DLOPEN 1
#endif

namespace host {
namespace {
#ifdef HOST_STEAM_DLOPEN
HostServices* g_svc = nullptr;
v8::Isolate* g_iso = nullptr;
v8::Global<v8::Context> g_ctx;
void* g_lib = nullptr;
bool g_ok = false;
int32_t g_pipe = 0;
uint32_t g_appId = 0;
void *g_user = nullptr, *g_friends = nullptr, *g_mm = nullptr, *g_apps = nullptr;

// The flat API (steam_api_flat.h), as this host calls it.
struct CallbackMsg { int32_t user; int32_t callback; uint8_t* param; int32_t size; };
using InitFlatFn = int (*)(char*);
using VoidFn = void (*)();
using PipeFn = int32_t (*)();
using RunFrameFn = void (*)(int32_t);
using NextFn = bool (*)(int32_t, CallbackMsg*);
using FreeFn = void (*)(int32_t);
using CallResultFn = bool (*)(int32_t, uint64_t, void*, int, int, bool*);
using IfaceFn = void* (*)();
using U64Fn = uint64_t (*)(void*);
using StrFn = const char* (*)(void*);
using BoolFn = bool (*)(void*);
using TicketFn = uint32_t (*)(void*, const char*);
using CancelFn = void (*)(void*, uint32_t);
using CountFn = int (*)(void*, int);
using ByIndexFn = uint64_t (*)(void*, int, int);
using NameOfFn = const char* (*)(void*, uint64_t);
using StateOfFn = int (*)(void*, uint64_t);
using PlayedFn = bool (*)(void*, uint64_t, void*);
using PresenceFn = bool (*)(void*, const char*, const char*);
using CreateLobbyFn = uint64_t (*)(void*, int, int);
using JoinLobbyFn = uint64_t (*)(void*, uint64_t);
using LeaveLobbyFn = void (*)(void*, uint64_t);
using SetDataFn = bool (*)(void*, uint64_t, const char*, const char*);
using GetDataFn = const char* (*)(void*, uint64_t, const char*);
using InviteFn = bool (*)(void*, uint64_t, uint64_t);
struct Api {
  RunFrameFn runFrame; NextFn next; FreeFn free; CallResultFn callResult;
  U64Fn steamId; TicketFn ticket; CancelFn cancel; StrFn persona; StrFn language; BoolFn subscribed; U64Fn owner;
  CountFn count; ByIndexFn byIndex; NameOfFn nameOf; StateOfFn stateOf; PlayedFn played; PresenceFn presence;
  CreateLobbyFn createLobby; JoinLobbyFn joinLobby; LeaveLobbyFn leaveLobby; SetDataFn setData; GetDataFn getData; InviteFn invite;
} api{};
template <class F> F sym(const char* name) { return reinterpret_cast<F>(dlsym(g_lib, name)); }
// The first of an interface's accessors this SDK has (newer first).
void* iface(std::initializer_list<const char*> names) {
  for (const char* n : names) if (auto f = sym<IfaceFn>(n)) return f();
  return nullptr;
}

// Callbacks and call results, by number (k_iSteam*Callbacks + n) and layout (VALVE_CALLBACK_PACK_SMALL: 4-byte
// packing on Linux and Android).
constexpr int kCallCompleted = 703, kTicket = 168, kLobbyCreated = 513, kLobbyEnter = 504, kLobbyJoinRequested = 333, kPresenceJoinRequested = 337;
std::unordered_map<uint64_t, std::pair<int, v8::Global<v8::Function>>> g_calls;  // SteamAPICall_t -> (expected callback, cb)
std::unordered_map<uint32_t, v8::Global<v8::Function>> g_tickets;               // HAuthTicket -> cb
v8::Global<v8::Function> g_onJoin;

std::string id(uint64_t v) { return std::to_string(v); }
const char* safe(const char* s) { return s ? s : ""; }
uint64_t idArg(const v8::FunctionCallbackInfo<v8::Value>& a, int i) {
  v8::Isolate* iso = a.GetIsolate();
  if (a.Length() <= i) return 0;
  if (a[i]->IsBigInt()) return a[i].As<v8::BigInt>()->Uint64Value();
  if (a[i]->IsString()) return strtoull(Engine::toStdString(iso, a[i]).c_str(), nullptr, 10);
  return (uint64_t)bind::num(a, i);
}
uint64_t read64(const uint8_t* p) { uint64_t v; memcpy(&v, p, 8); return v; }
int32_t read32(const uint8_t* p) { int32_t v; memcpy(&v, p, 4); return v; }

void call(v8::Global<v8::Function>& fn, std::vector<v8::Local<v8::Value>> argv) {
  if (fn.IsEmpty()) return;
  v8::Isolate* iso = g_iso; v8::Local<v8::Context> ctx = g_ctx.Get(iso);
  v8::TryCatch tc(iso);
  (void)fn.Get(iso)->Call(ctx, ctx->Global(), (int)argv.size(), argv.data());
  if (tc.HasCaught()) g_svc->engine->reportException(tc);
}

// One dispatch pass: the events are copied out (the SDK's buffer lives until FreeLastCallback), then delivered.
struct Event { int kind; uint64_t handle; std::vector<uint8_t> data; bool failed; };
void pump() {
  if (!g_ok) return;
  api.runFrame(g_pipe);
  std::vector<Event> events;
  CallbackMsg msg{};
  while (api.next(g_pipe, &msg)) {
    const uint8_t* p = msg.param;
    if (msg.callback == kCallCompleted && msg.size >= 16) {
      const uint64_t h = read64(p); const int expected = read32(p + 8); const uint32_t size = (uint32_t)read32(p + 12);
      Event e{expected, h, std::vector<uint8_t>(size), false};
      bool failed = false;
      if (!api.callResult(g_pipe, h, e.data.data(), (int)size, expected, &failed) || failed) e.failed = true;
      events.push_back(std::move(e));
    } else if (msg.callback == kTicket || msg.callback == kLobbyJoinRequested || msg.callback == kPresenceJoinRequested) {
      events.push_back(Event{msg.callback, 0, std::vector<uint8_t>(p, p + msg.size), false});
    }
    api.free(g_pipe);
  }
  if (events.empty()) return;
  v8::Isolate* iso = g_iso; v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = g_ctx.Get(iso); v8::Context::Scope cs(ctx);
  for (Event& e : events) {
    const uint8_t* p = e.data.data(); const size_t n = e.data.size();
    if (e.kind == kTicket && n >= 12) {
      const uint32_t h = (uint32_t)read32(p); const int result = read32(p + 4); const int size = read32(p + 8);
      auto it = g_tickets.find(h); if (it == g_tickets.end()) continue;
      v8::Global<v8::Function> cb = std::move(it->second); g_tickets.erase(it);
      if (result != 1 || size <= 0 || (size_t)(12 + size) > n) { call(cb, {v8::Null(iso)}); continue; }
      static const char* hex = "0123456789abcdef"; std::string s; s.reserve(size * 2);
      for (int i = 0; i < size; i++) { s += hex[p[12 + i] >> 4]; s += hex[p[12 + i] & 15]; }
      call(cb, {bind::str(iso, s)});
      // Tickets stay valid until cancelled: cancel each a few minutes after the server checked it.
      g_svc->loop->setTimer(5 * 60 * 1000, false, [h] { if (g_ok) api.cancel(g_user, h); });
    } else if (e.kind == kLobbyJoinRequested && n >= 16) {
      call(g_onJoin, {bind::str(iso, id(read64(p))), v8::Null(iso)});
    } else if (e.kind == kPresenceJoinRequested && n >= 8) {
      std::string connect(reinterpret_cast<const char*>(p + 8), strnlen(reinterpret_cast<const char*>(p + 8), std::min<size_t>(256, n - 8)));
      call(g_onJoin, {v8::Null(iso), bind::str(iso, connect)});
    } else {
      auto it = g_calls.find(e.handle); if (it == g_calls.end()) continue;
      v8::Global<v8::Function> cb = std::move(it->second.second); g_calls.erase(it);
      if (e.kind == kLobbyCreated) {
        // LobbyCreated_t { EResult; uint64 lobby } at 4-byte packing: the id at 4 (at 8 where the struct has 16 bytes).
        const bool ok = !e.failed && n >= 12 && read32(p) == 1;
        const uint64_t lobby = ok ? read64(p + (n >= 16 ? 8 : 4)) : 0;
        call(cb, {lobby ? (v8::Local<v8::Value>)bind::str(iso, id(lobby)) : (v8::Local<v8::Value>)v8::Null(iso)});
      } else if (e.kind == kLobbyEnter) {
        // LobbyEnter_t { uint64 lobby; uint32 permissions; bool locked; uint32 response }: 1 = success.
        const bool ok = !e.failed && n >= 20 && read32(p + 16) == 1;
        call(cb, {v8::Boolean::New(iso, ok)});
      } else call(cb, {v8::Null(iso)});
    }
  }
  iso->PerformMicrotaskCheckpoint();
}

void init(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> out = v8::Object::New(iso);
  auto fail = [&](const std::string& why) { bind::setBool(ctx, out, "ok", false); bind::setStr(ctx, out, "error", why); HOST_LOGW("steam: %s", why.c_str()); a.GetReturnValue().Set(out); };
  if (!g_ok) {
    g_appId = (uint32_t)bind::num(a, 0);
    // Steam sets these for a game it launches (the same app); a development install (adb) gets the one asked for.
    if (g_appId) { const std::string s = std::to_string(g_appId); setenv("SteamAppId", s.c_str(), 1); setenv("SteamGameId", s.c_str(), 1); }
    if (!g_lib && !(g_lib = dlopen("libsteam_api.so", RTLD_NOW | RTLD_LOCAL))) { const char* e = dlerror(); return fail(std::string("no libsteam_api.so: ") + (e ? e : "?")); }
    auto initFlat = sym<InitFlatFn>("SteamAPI_InitFlat");
    auto dispatchInit = sym<VoidFn>("SteamAPI_ManualDispatch_Init");
    auto pipe = sym<PipeFn>("SteamAPI_GetHSteamPipe");
    api = Api{sym<RunFrameFn>("SteamAPI_ManualDispatch_RunFrame"), sym<NextFn>("SteamAPI_ManualDispatch_GetNextCallback"), sym<FreeFn>("SteamAPI_ManualDispatch_FreeLastCallback"),
              sym<CallResultFn>("SteamAPI_ManualDispatch_GetAPICallResult"),
              sym<U64Fn>("SteamAPI_ISteamUser_GetSteamID"), sym<TicketFn>("SteamAPI_ISteamUser_GetAuthTicketForWebApi"), sym<CancelFn>("SteamAPI_ISteamUser_CancelAuthTicket"),
              sym<StrFn>("SteamAPI_ISteamFriends_GetPersonaName"), sym<StrFn>("SteamAPI_ISteamApps_GetCurrentGameLanguage"), sym<BoolFn>("SteamAPI_ISteamApps_BIsSubscribed"), sym<U64Fn>("SteamAPI_ISteamApps_GetAppOwner"),
              sym<CountFn>("SteamAPI_ISteamFriends_GetFriendCount"), sym<ByIndexFn>("SteamAPI_ISteamFriends_GetFriendByIndex"), sym<NameOfFn>("SteamAPI_ISteamFriends_GetFriendPersonaName"),
              sym<StateOfFn>("SteamAPI_ISteamFriends_GetFriendPersonaState"), sym<PlayedFn>("SteamAPI_ISteamFriends_GetFriendGamePlayed"), sym<PresenceFn>("SteamAPI_ISteamFriends_SetRichPresence"),
              sym<CreateLobbyFn>("SteamAPI_ISteamMatchmaking_CreateLobby"), sym<JoinLobbyFn>("SteamAPI_ISteamMatchmaking_JoinLobby"), sym<LeaveLobbyFn>("SteamAPI_ISteamMatchmaking_LeaveLobby"),
              sym<SetDataFn>("SteamAPI_ISteamMatchmaking_SetLobbyData"), sym<GetDataFn>("SteamAPI_ISteamMatchmaking_GetLobbyData"), sym<InviteFn>("SteamAPI_ISteamMatchmaking_InviteUserToLobby")};
    if (!initFlat || !dispatchInit || !pipe || !api.runFrame || !api.next || !api.free || !api.callResult || !api.steamId || !api.ticket || !api.count || !api.createLobby || !api.invite)
      return fail("libsteam_api.so lacks the flat API this host calls");
    char err[1024] = {0};
    const int r = initFlat(err);
    if (r != 0) return fail(std::string("SteamAPI_InitFlat ") + std::to_string(r) + ": " + err);
    dispatchInit();
    g_pipe = pipe();
    g_user = iface({"SteamAPI_SteamUser_v023", "SteamAPI_SteamUser_v022", "SteamAPI_SteamUser_v021"});
    g_friends = iface({"SteamAPI_SteamFriends_v018", "SteamAPI_SteamFriends_v017"});
    g_mm = iface({"SteamAPI_SteamMatchmaking_v009"});
    g_apps = iface({"SteamAPI_SteamApps_v009", "SteamAPI_SteamApps_v008"});
    if (!g_user || !g_friends || !g_mm || !g_apps) return fail("Steamworks interfaces missing");
    g_ok = true;
    g_svc->loop->setTimer(50, true, [] { pump(); });
    HOST_LOGI("steam: connected (app %u, steamclient through %s)", g_appId, getenv("Steam3Master") ? getenv("Steam3Master") : "?");
  }
  const uint64_t self = api.steamId(g_user);
  bind::setBool(ctx, out, "ok", true);
  bind::setStr(ctx, out, "steamId", id(self));
  bind::setStr(ctx, out, "name", api.persona ? safe(api.persona(g_friends)) : "");
  bind::setStr(ctx, out, "language", api.language ? safe(api.language(g_apps)) : "");
  // Owned by this account, not borrowed through Family Sharing.
  bind::setBool(ctx, out, "owned", api.subscribed && api.subscribed(g_apps) && (!api.owner || api.owner(g_apps) == self));
  a.GetReturnValue().Set(out);
}
#define STEAM_OR_FAIL if (!g_ok) { a.GetReturnValue().SetNull(); return; }
void authTicket(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (!g_ok || !a[1]->IsFunction()) { if (a[1]->IsFunction()) (void)a[1].As<v8::Function>()->Call(iso->GetCurrentContext(), v8::Undefined(iso), 1, std::vector<v8::Local<v8::Value>>{v8::Null(iso)}.data()); return; }
  const uint32_t h = api.ticket(g_user, bind::string(a, 0).c_str());
  g_tickets[h].Reset(iso, a[1].As<v8::Function>());
}
void friends(const v8::FunctionCallbackInfo<v8::Value>& a) {
  STEAM_OR_FAIL
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  const int n = std::min(api.count(g_friends, 4 /* k_EFriendFlagImmediate */), 500);
  v8::Local<v8::Array> out = v8::Array::New(iso, n);
  uint8_t info[32];
  for (int i = 0; i < n; i++) {
    const uint64_t f = api.byIndex(g_friends, i, 4);
    memset(info, 0, sizeof info);
    // FriendGameInfo_t starts with the game's id, whose low 24 bits are the app's.
    const bool playing = api.played && api.played(g_friends, f, info) && (uint32_t)(read64(info) & 0xFFFFFF) == g_appId;
    v8::Local<v8::Array> row = v8::Array::New(iso, 4);
    row->Set(ctx, 0, bind::str(iso, id(f))).Check();
    row->Set(ctx, 1, bind::str(iso, api.nameOf ? safe(api.nameOf(g_friends, f)) : "")).Check();
    row->Set(ctx, 2, v8::Number::New(iso, api.stateOf ? api.stateOf(g_friends, f) : 0)).Check();
    row->Set(ctx, 3, v8::Boolean::New(iso, playing)).Check();
    out->Set(ctx, (uint32_t)i, row).Check();
  }
  a.GetReturnValue().Set(out);
}
void pendingCall(const v8::FunctionCallbackInfo<v8::Value>& a, uint64_t handle, int kind, int cbIndex) {
  v8::Isolate* iso = a.GetIsolate();
  if (!a[cbIndex]->IsFunction()) return;
  if (!handle) { (void)a[cbIndex].As<v8::Function>()->Call(iso->GetCurrentContext(), v8::Undefined(iso), 1, std::vector<v8::Local<v8::Value>>{v8::Null(iso)}.data()); return; }
  auto& slot = g_calls[handle]; slot.first = kind; slot.second.Reset(iso, a[cbIndex].As<v8::Function>());
}
void createLobby(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL pendingCall(a, api.createLobby(g_mm, bind::i32(a, 0), bind::i32(a, 1)), kLobbyCreated, 2); }
void joinLobby(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL pendingCall(a, api.joinLobby ? api.joinLobby(g_mm, idArg(a, 0)) : 0, kLobbyEnter, 1); }
void leaveLobby(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL if (api.leaveLobby) api.leaveLobby(g_mm, idArg(a, 0)); }
void setLobbyData(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL a.GetReturnValue().Set(api.setData && api.setData(g_mm, idArg(a, 0), bind::string(a, 1).c_str(), bind::string(a, 2).c_str())); }
void getLobbyData(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL const char* v = api.getData ? api.getData(g_mm, idArg(a, 0), bind::string(a, 1).c_str()) : ""; a.GetReturnValue().Set(bind::str(a.GetIsolate(), v ? v : "")); }
void inviteToLobby(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL a.GetReturnValue().Set(api.invite(g_mm, idArg(a, 0), idArg(a, 1))); }
void setRichPresence(const v8::FunctionCallbackInfo<v8::Value>& a) { STEAM_OR_FAIL if (api.presence) api.presence(g_friends, bind::string(a, 0).c_str(), a[1]->IsString() ? bind::string(a, 1).c_str() : nullptr); }
void onJoinRequested(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_onJoin.Reset(a.GetIsolate(), a[0].As<v8::Function>()); else g_onJoin.Reset(); }
#endif
}  // namespace

// host.json steam.appId: the module is there (the library is opened by init); otherwise __native.steam is absent.
void installSteam(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
#ifdef HOST_STEAM_DLOPEN
  if (!svc.config || svc.config->at("steam").n("appId", 0) <= 0) return;
  g_svc = &svc; g_iso = isolateOf(ctx); g_ctx.Reset(g_iso, ctx);
  v8::Local<v8::Object> s = bind::obj(ctx, native, "steam");
  bind::fn(ctx, s, "init", init); bind::fn(ctx, s, "authTicket", authTicket); bind::fn(ctx, s, "friends", friends);
  bind::fn(ctx, s, "createLobby", createLobby); bind::fn(ctx, s, "joinLobby", joinLobby); bind::fn(ctx, s, "leaveLobby", leaveLobby);
  bind::fn(ctx, s, "setLobbyData", setLobbyData); bind::fn(ctx, s, "getLobbyData", getLobbyData); bind::fn(ctx, s, "inviteToLobby", inviteToLobby);
  bind::fn(ctx, s, "setRichPresence", setRichPresence); bind::fn(ctx, s, "onJoinRequested", onJoinRequested);
  bind::setNum(ctx, s, "appId", svc.config->at("steam").n("appId", 0));
#else
  (void)ctx; (void)native; (void)svc;
#endif
}

}  // namespace host
