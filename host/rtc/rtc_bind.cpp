// __native.rtc (WP-21): WebSocket and WebRTC data channels through libdatachannel, for a game whose host.json asks
// for them (network.webrtc; CMake HOST_WEBRTC). runtime/src/rtc builds the browser classes on it: WebSocket,
// RTCPeerConnection, RTCDataChannel. Objects live here by id; libdatachannel calls back on its own threads, so
// every callback is posted to the host loop and delivered in order to the one JS dispatcher (onEvent):
//   ws-open id | ws-message id data | ws-close id | ws-error id text
//   pc-description id type sdp | pc-candidate id candidate mid | pc-state id s | pc-ice id s | pc-gathering id s
//   pc-signaling id s | pc-datachannel pcId dcId
//   dc-open id | dc-message id data | dc-close id | dc-error id text | dc-low id
// Messages arrive as a string or an ArrayBuffer. A build without WebRTC installs nothing.
#include "js/natives.h"
#ifdef HOST_HAS_WEBRTC
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/v8compat.h"
#include "net/http.h"
#include <rtc/rtc.hpp>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <unordered_map>

namespace host {
namespace {
HostServices* g_svc = nullptr;
v8::Isolate* g_iso = nullptr;
v8::Global<v8::Function> g_onEvent; v8::Global<v8::Context> g_ctx;
std::atomic<int> g_nextId{1};
std::unordered_map<int, std::shared_ptr<rtc::WebSocket>> g_ws;
std::unordered_map<int, std::shared_ptr<rtc::PeerConnection>> g_pc;
std::unordered_map<int, std::shared_ptr<rtc::DataChannel>> g_dc;

// One event to JS, on the loop thread. Arguments are plain values, made into V8 values there.
struct Arg { enum { Num, Str, Bin } kind = Num; double n = 0; std::string s; };
Arg num(double n) { Arg a; a.n = n; return a; }
Arg str(std::string s) { Arg a; a.kind = Arg::Str; a.s = std::move(s); return a; }
Arg msg(rtc::message_variant m) {
  Arg a;
  if (auto* t = std::get_if<std::string>(&m)) { a.kind = Arg::Str; a.s = std::move(*t); }
  else { auto& b = std::get<rtc::binary>(m); a.kind = Arg::Bin; a.s.assign((const char*)b.data(), b.size()); }
  return a;
}
void emit(const char* kind, int id, std::vector<Arg> args = {}) {
  g_svc->loop->post([kind, id, args = std::move(args)]() mutable {
    if (g_onEvent.IsEmpty()) return;
    v8::Isolate* iso = g_iso; v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = g_ctx.Get(iso); v8::Context::Scope cs(ctx);
    std::vector<v8::Local<v8::Value>> argv{bind::str(iso, kind), v8::Number::New(iso, id)};
    for (auto& a : args) {
      if (a.kind == Arg::Num) argv.push_back(v8::Number::New(iso, a.n));
      else if (a.kind == Arg::Str) argv.push_back(bind::str(iso, a.s));
      else { auto store = v8::ArrayBuffer::NewBackingStore(iso, a.s.size()); if (!a.s.empty()) memcpy(store->Data(), a.s.data(), a.s.size()); argv.push_back(v8::ArrayBuffer::New(iso, std::move(store))); }
    }
    v8::TryCatch tc(iso);
    (void)g_onEvent.Get(iso)->Call(ctx, ctx->Global(), (int)argv.size(), argv.data());
    if (tc.HasCaught()) g_svc->engine->reportException(tc);
    iso->PerformMicrotaskCheckpoint();
  });
}
// The page's call failed in libdatachannel (a bad SDP, a closed channel): a JS Error with its message.
template <class F> void guarded(const v8::FunctionCallbackInfo<v8::Value>& a, F f) {
  try { f(); } catch (const std::exception& e) { bind::throwError(a.GetIsolate(), std::string("rtc: ") + e.what()); }
}
bool sendTo(rtc::Channel& ch, v8::Local<v8::Value> v, v8::Isolate* iso) {
  if (v->IsString()) return ch.send(Engine::toStdString(iso, v));
  bind::Bytes b = bind::bytes(v); if (!b.ok) return false;
  return ch.send((const std::byte*)b.data, b.len);
}

// ---- WebSocket ----
void wsOpen(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  rtc::WebSocketConfiguration cfg;
  if (a.Length() > 1 && a[1]->IsArray()) { auto arr = a[1].As<v8::Array>(); for (uint32_t i = 0; i < arr->Length(); ++i) { v8::Local<v8::Value> p; if (arr->Get(ctx, i).ToLocal(&p) && p->IsString()) cfg.protocols.push_back(Engine::toStdString(iso, p)); } }
  const int id = g_nextId++;
  // host.json network.allow, as for fetch: a wss:// URL is allowed when its https:// form is (ws://, http://).
  std::string url = bind::string(a, 0), asHttp = url;
  if (asHttp.compare(0, 6, "wss://") == 0) asHttp = "https://" + asHttp.substr(6); else if (asHttp.compare(0, 5, "ws://") == 0) asHttp = "http://" + asHttp.substr(5);
  if (!g_svc->http->allowed(url) && !g_svc->http->allowed(asHttp)) {
    HOST_LOGW("WebSocket %s blocked by network.allow", url.c_str());
    emit("ws-error", id, {str("blocked by network.allow")}); emit("ws-close", id);
    a.GetReturnValue().Set(id); return;
  }
  guarded(a, [&] {
    auto ws = std::make_shared<rtc::WebSocket>(cfg);
    ws->onOpen([id] { emit("ws-open", id); });
    ws->onMessage([id](rtc::message_variant m) { emit("ws-message", id, {msg(std::move(m))}); });
    ws->onError([id](std::string e) { emit("ws-error", id, {str(std::move(e))}); });
    ws->onClosed([id] { emit("ws-close", id); g_svc->loop->post([id] { g_ws.erase(id); }); });
    g_ws[id] = ws;
    ws->open(url);
    a.GetReturnValue().Set(id);
  });
}
rtc::WebSocket* ws(const v8::FunctionCallbackInfo<v8::Value>& a) { auto it = g_ws.find(bind::i32(a, 0)); return it == g_ws.end() ? nullptr : it->second.get(); }
void wsSend(const v8::FunctionCallbackInfo<v8::Value>& a) { guarded(a, [&] { auto* w = ws(a); a.GetReturnValue().Set(w && w->isOpen() && sendTo(*w, a[1], a.GetIsolate())); }); }
void wsClose(const v8::FunctionCallbackInfo<v8::Value>& a) { guarded(a, [&] { if (auto* w = ws(a)) w->close(); }); }
void wsBuffered(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* w = ws(a); a.GetReturnValue().Set((double)(w ? w->bufferedAmount() : 0)); }

// ---- data channels ----
void watch(int id, const std::shared_ptr<rtc::DataChannel>& dc) {
  dc->onOpen([id] { emit("dc-open", id); });
  dc->onMessage([id](rtc::message_variant m) { emit("dc-message", id, {msg(std::move(m))}); });
  dc->onError([id](std::string e) { emit("dc-error", id, {str(std::move(e))}); });
  dc->onBufferedAmountLow([id] { emit("dc-low", id); });
  dc->onClosed([id] { emit("dc-close", id); g_svc->loop->post([id] { g_dc.erase(id); }); });
}
rtc::DataChannel* dc(const v8::FunctionCallbackInfo<v8::Value>& a) { auto it = g_dc.find(bind::i32(a, 0)); return it == g_dc.end() ? nullptr : it->second.get(); }
void dcSend(const v8::FunctionCallbackInfo<v8::Value>& a) { guarded(a, [&] { auto* d = dc(a); a.GetReturnValue().Set(d && d->isOpen() && sendTo(*d, a[1], a.GetIsolate())); }); }
void dcClose(const v8::FunctionCallbackInfo<v8::Value>& a) { guarded(a, [&] { if (auto* d = dc(a)) d->close(); }); }
void dcBuffered(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* d = dc(a); a.GetReturnValue().Set((double)(d ? d->bufferedAmount() : 0)); }
void dcLowThreshold(const v8::FunctionCallbackInfo<v8::Value>& a) { if (auto* d = dc(a)) d->setBufferedAmountLowThreshold((size_t)std::max(0.0, bind::num(a, 1))); }
// [label, protocol, stream id (-1: not yet), ordered, maxRetransmits (-1), maxPacketLifeTime ms (-1)]
void dcInfo(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto* d = dc(a); if (!d) { a.GetReturnValue().SetNull(); return; }
  const rtc::Reliability r = d->reliability(); const auto sid = d->id();
  v8::Local<v8::Array> out = v8::Array::New(iso, 6);
  out->Set(ctx, 0, bind::str(iso, d->label())).Check(); out->Set(ctx, 1, bind::str(iso, d->protocol())).Check();
  out->Set(ctx, 2, v8::Number::New(iso, sid ? *sid : -1)).Check(); out->Set(ctx, 3, v8::Boolean::New(iso, !r.unordered)).Check();
  out->Set(ctx, 4, v8::Number::New(iso, r.maxRetransmits ? (double)*r.maxRetransmits : -1)).Check();
  out->Set(ctx, 5, v8::Number::New(iso, r.maxPacketLifeTime ? (double)r.maxPacketLifeTime->count() : -1)).Check();
  a.GetReturnValue().Set(out);
}

// ---- peer connections ----
const char* const kState[] = {"new", "connecting", "connected", "disconnected", "failed", "closed"};
const char* const kIce[] = {"new", "checking", "connected", "completed", "failed", "disconnected", "closed"};
const char* const kGathering[] = {"new", "gathering", "complete"};
const char* const kSignaling[] = {"stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer"};
std::string urlEncode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF"; std::string o;
  for (unsigned char c : s) { if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c; else { o += '%'; o += hex[c >> 4]; o += hex[c & 15]; } }
  return o;
}
// pcCreate([{ urls: [...], username, credential }], relayOnly) -> id. A browser URL carries no credentials; they go
// into libdatachannel's form, turn:user:pass@host:port?transport=...
void pcCreate(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  rtc::Configuration cfg; cfg.disableAutoNegotiation = true;  // the page negotiates, as in a browser
  if (bind::boolean(a, 1)) cfg.iceTransportPolicy = rtc::TransportPolicy::Relay;
  auto get = [&](v8::Local<v8::Object> o, const char* k) { v8::Local<v8::Value> v; return o->Get(ctx, bind::str(iso, k)).ToLocal(&v) && v->IsString() ? Engine::toStdString(iso, v) : std::string(); };
  if (a.Length() > 0 && a[0]->IsArray()) {
    auto servers = a[0].As<v8::Array>();
    for (uint32_t i = 0; i < servers->Length(); ++i) {
      v8::Local<v8::Value> sv; if (!servers->Get(ctx, i).ToLocal(&sv) || !sv->IsObject()) continue;
      auto so = sv.As<v8::Object>(); const std::string user = get(so, "username"), pass = get(so, "credential");
      v8::Local<v8::Value> urls; if (!so->Get(ctx, bind::str(iso, "urls")).ToLocal(&urls) || !urls->IsArray()) continue;
      auto ua = urls.As<v8::Array>();
      for (uint32_t j = 0; j < ua->Length(); ++j) {
        v8::Local<v8::Value> u; if (!ua->Get(ctx, j).ToLocal(&u) || !u->IsString()) continue;
        std::string url = Engine::toStdString(iso, u); const size_t colon = url.find(':');
        if (colon != std::string::npos && !user.empty() && url.compare(0, 4, "turn") == 0) url = url.substr(0, colon + 1) + urlEncode(user) + ":" + urlEncode(pass) + "@" + url.substr(colon + 1);
        try { cfg.iceServers.emplace_back(url); } catch (const std::exception& e) { HOST_LOGW("rtc: ICE server %s skipped: %s", Engine::toStdString(iso, u).c_str(), e.what()); }
      }
    }
  }
  const int id = g_nextId++;
  guarded(a, [&] {
    auto pc = std::make_shared<rtc::PeerConnection>(cfg);
    pc->onLocalDescription([id](rtc::Description d) { emit("pc-description", id, {str(d.typeString()), str(std::string(d))}); });
    pc->onLocalCandidate([id](rtc::Candidate c) { emit("pc-candidate", id, {str(c.candidate()), str(c.mid())}); });
    pc->onStateChange([id](rtc::PeerConnection::State s) { emit("pc-state", id, {str(kState[(int)s])}); });
    pc->onIceStateChange([id](rtc::PeerConnection::IceState s) { emit("pc-ice", id, {str(kIce[(int)s])}); });
    pc->onGatheringStateChange([id](rtc::PeerConnection::GatheringState s) { emit("pc-gathering", id, {str(kGathering[(int)s])}); });
    pc->onSignalingStateChange([id](rtc::PeerConnection::SignalingState s) { emit("pc-signaling", id, {str(kSignaling[(int)s])}); });
    pc->onDataChannel([id](std::shared_ptr<rtc::DataChannel> d) {
      const int did = g_nextId++; watch(did, d);  // callbacks first: nothing the peer sends is missed
      g_svc->loop->post([did, d] { g_dc[did] = d; });
      emit("pc-datachannel", id, {num(did)});
    });
    g_pc[id] = pc;
    a.GetReturnValue().Set(id);
  });
}
rtc::PeerConnection* pc(const v8::FunctionCallbackInfo<v8::Value>& a) { auto it = g_pc.find(bind::i32(a, 0)); return it == g_pc.end() ? nullptr : it->second.get(); }
#define PC_OR_THROW auto* p = pc(a); if (!p) { bind::throwError(a.GetIsolate(), "rtc: the connection is closed"); return; }
void pcCreateOffer(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW guarded(a, [&] { a.GetReturnValue().Set(bind::str(a.GetIsolate(), std::string(p->createOffer()))); }); }
void pcCreateAnswer(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW guarded(a, [&] { a.GetReturnValue().Set(bind::str(a.GetIsolate(), std::string(p->createAnswer()))); }); }
rtc::Description::Type typeOf(const std::string& t) { return t == "offer" ? rtc::Description::Type::Offer : t == "answer" ? rtc::Description::Type::Answer : t == "pranswer" ? rtc::Description::Type::Pranswer : t == "rollback" ? rtc::Description::Type::Rollback : rtc::Description::Type::Unspec; }
// pcSetLocal(id, type) -> true when libdatachannel made a new local description (a pc-description event follows),
// false when it made none (a rollback, an offer it ignores in have-local-offer): the page's promise settles then.
void pcSetLocal(const v8::FunctionCallbackInfo<v8::Value>& a) {
  PC_OR_THROW
  guarded(a, [&] {
    const auto before = p->localDescription(); const std::string was = before ? std::string(*before) + before->typeString() : std::string();
    p->setLocalDescription(typeOf(bind::string(a, 1)));
    const auto after = p->localDescription(); const std::string now = after ? std::string(*after) + after->typeString() : std::string();
    a.GetReturnValue().Set(after.has_value() && now != was);
  });
}
void pcSetRemote(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW guarded(a, [&] { p->setRemoteDescription(rtc::Description(bind::string(a, 1), bind::string(a, 2))); }); }
void pcAddCandidate(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW guarded(a, [&] { p->addRemoteCandidate(rtc::Candidate(bind::string(a, 1), bind::string(a, 2))); }); }
void describe(const v8::FunctionCallbackInfo<v8::Value>& a, const std::optional<rtc::Description>& d) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!d) { a.GetReturnValue().SetNull(); return; }
  v8::Local<v8::Array> out = v8::Array::New(iso, 2); out->Set(ctx, 0, bind::str(iso, d->typeString())).Check(); out->Set(ctx, 1, bind::str(iso, std::string(*d))).Check();
  a.GetReturnValue().Set(out);
}
void pcLocal(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW describe(a, p->localDescription()); }
void pcRemote(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW describe(a, p->remoteDescription()); }
// pcCreateDataChannel(pc, label, ordered, maxRetransmits, maxPacketLifeTime, negotiated, id, protocol) -> dcId
void pcCreateDataChannel(const v8::FunctionCallbackInfo<v8::Value>& a) {
  PC_OR_THROW
  rtc::DataChannelInit init; init.reliability.unordered = !bind::boolean(a, 2, true);
  const double rx = bind::num(a, 3, -1), life = bind::num(a, 4, -1), sid = bind::num(a, 6, -1);
  if (rx >= 0) init.reliability.maxRetransmits = (unsigned)rx;
  if (life >= 0) init.reliability.maxPacketLifeTime = std::chrono::milliseconds((long long)life);
  init.negotiated = bind::boolean(a, 5); if (sid >= 0) init.id = (uint16_t)sid; init.protocol = bind::string(a, 7);
  guarded(a, [&] {
    auto d = p->createDataChannel(bind::string(a, 1), init);
    const int did = g_nextId++; watch(did, d); g_dc[did] = d;
    a.GetReturnValue().Set(did);
  });
}
void pcClose(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto it = g_pc.find(bind::i32(a, 0)); if (it == g_pc.end()) return;
  auto keep = it->second; g_pc.erase(it);
  guarded(a, [&] { keep->close(); });
}
void onEvent(const v8::FunctionCallbackInfo<v8::Value>& a) {
  if (!a[0]->IsFunction()) return;
  g_onEvent.Reset(a.GetIsolate(), a[0].As<v8::Function>()); g_ctx.Reset(a.GetIsolate(), a.GetIsolate()->GetCurrentContext());
}

// Where the system's CA certificates are, for verifying wss servers (the libdatachannel patch reads RTC_CA_PATH).
const char* caPath() {
  struct stat st;
#if defined(__ANDROID__)
  for (const char* p : {"/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"}) if (stat(p, &st) == 0) return p;
#elif defined(__APPLE__)
  if (stat("/etc/ssl/cert.pem", &st) == 0) return "/etc/ssl/cert.pem";
#else
  for (const char* p : {"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"}) if (stat(p, &st) == 0) return p;
#endif
  return nullptr;
}
}  // namespace

void installRtc(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  g_svc = &svc; g_iso = isolateOf(ctx);
  static bool once = false;
  if (!once) {
    once = true;
    if (const char* p = caPath()) setenv("RTC_CA_PATH", p, 1); else HOST_LOGW("rtc: no CA certificates found; wss servers are not verified");
    rtc::InitLogger(rtc::LogLevel::Warning, [](rtc::LogLevel level, std::string m) { if (level <= rtc::LogLevel::Error) HOST_LOGE("rtc: %s", m.c_str()); else HOST_LOGW("rtc: %s", m.c_str()); });
  }
  v8::Local<v8::Object> r = bind::obj(ctx, native, "rtc");
  bind::fn(ctx, r, "onEvent", onEvent);
  bind::fn(ctx, r, "wsOpen", wsOpen); bind::fn(ctx, r, "wsSend", wsSend); bind::fn(ctx, r, "wsClose", wsClose); bind::fn(ctx, r, "wsBuffered", wsBuffered);
  bind::fn(ctx, r, "pcCreate", pcCreate); bind::fn(ctx, r, "pcCreateOffer", pcCreateOffer); bind::fn(ctx, r, "pcCreateAnswer", pcCreateAnswer);
  bind::fn(ctx, r, "pcSetLocal", pcSetLocal); bind::fn(ctx, r, "pcSetRemote", pcSetRemote); bind::fn(ctx, r, "pcAddCandidate", pcAddCandidate);
  bind::fn(ctx, r, "pcLocal", pcLocal); bind::fn(ctx, r, "pcRemote", pcRemote); bind::fn(ctx, r, "pcCreateDataChannel", pcCreateDataChannel); bind::fn(ctx, r, "pcClose", pcClose);
  bind::fn(ctx, r, "dcSend", dcSend); bind::fn(ctx, r, "dcClose", dcClose); bind::fn(ctx, r, "dcBuffered", dcBuffered); bind::fn(ctx, r, "dcLowThreshold", dcLowThreshold); bind::fn(ctx, r, "dcInfo", dcInfo);
  HOST_LOGI("rtc: WebSocket and WebRTC data channels (libdatachannel %s)", RTC_VERSION);
}

}  // namespace host
#else
namespace host { void installRtc(v8::Local<v8::Context>, v8::Local<v8::Object>, HostServices&) {} }
#endif
