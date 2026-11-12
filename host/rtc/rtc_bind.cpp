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
#ifdef HOST_HAS_WEBRTC_MEDIA
#include <opus.h>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <thread>
#include "audio/graph.h"
#include "audio/live_ring.h"
#include "audio/voice_in.h"
#include <memory>
#include <random>
#endif
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
void closeXcvsOf(int pcId);  // its audio tracks end with the connection

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
    // Every audio m-line has its track made by the page before its description is applied (audioAdd); one made
    // by the remote side alone would carry nothing here.
    pc->onTrack([id](std::shared_ptr<rtc::Track> t) { HOST_LOGW("rtc: #%d remote m-line %s has no local transceiver; its media is ignored", id, t->mid().c_str()); });
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
// The signalling state now, as a browser's changes within setLocalDescription/setRemoteDescription (the
// pc-signaling event arrives a loop turn later; a page deciding offer or answer must not wait for it).
void pcSignaling(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW a.GetReturnValue().Set(bind::str(a.GetIsolate(), kSignaling[(int)p->signalingState()])); }
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
  closeXcvsOf(bind::i32(a, 0));
  guarded(a, [&] { keep->close(); });
}
#ifdef HOST_HAS_WEBRTC_MEDIA
// ---- audio tracks ----
// One audio m-line (an RTCRtpTransceiver's native side): an Opus track that sends what its source capture track
// (the microphone) hears and plays what the peer sends through a remote track, a LiveInput that
// MediaStreamAudioSourceNode reads like a microphone's (id kRemoteTrackBase + n).
//   audioAdd(pc, mid, payloadType) -> [xid, remoteTrackId]   before the offer that carries it, or before the remote
//                                     offer whose m-line it answers (same mid): sendrecv, Opus only
//   audioSource(xid, captureTrackId)  what it sends (0: nothing)
//   audioBitrate(xid, bps)            the encoder's target (RTCRtpSender.setParameters maxBitrate)
//   audioStats(xid) -> [packetsIn, framesOut, open]
//   audioRemoteEnabled(remoteTrackId, on)  the remote track plays or is silent (MediaStreamTrack.enabled)
//   audioClose(xid)                   the remote track ends; nothing more is sent
// Sending runs on one thread of its own, every 20 ms: 960 samples from each source's ring, one Opus frame each.
// Receiving decodes on libdatachannel's thread into the remote track's ring: lost packets recovered from in-band FEC
// or concealed (audio/voice_in.h), behind a jitter margin that follows the network (audio/live_ring.h JitterTarget).
class RemoteAudio : public audio::LiveInput {
 public:
  // A ring with a jitter margin that follows the network (audio::JitterTarget: 60-240 ms, readers drift to it in
  // quiet stretches), at most 250 ms more before the oldest is dropped.
  explicit RemoteAudio(uint32_t id) : id_(id), ring_(jitter_.target(), 0.25, true) {
    int e = 0; dec_ = opus_decoder_create(48000, 1, &e); ring_.setRate(48000);
    if (dec_) voice_ = std::make_unique<audio::OpusVoiceIn>(dec_);
  }
  ~RemoteAudio() override { if (dec_) opus_decoder_destroy(dec_); }
  std::atomic<bool> ended{false}, enabled{true};  // enabled: the page's MediaStreamTrack.enabled (a muted player)
  std::atomic<uint64_t> packets{0};
  bool read(audio::LiveCursor& c, float* out, int n, double rate) override {
    if (!enabled.load(std::memory_order_relaxed) || ended.load(std::memory_order_relaxed)) { c.primed = c.waiting = false; return false; }
    return ring_.read(c, out, n, rate);
  }
  bool live() const override { return !ended.load(std::memory_order_relaxed); }
  // One Opus packet (an RTP payload) with its RTP timestamp, on libdatachannel's thread. Late or repeated packets
  // are dropped; a gap's last frame comes back from this packet's in-band FEC copy, the ones before it from the
  // decoder's concealment (audio::OpusVoiceIn), so the ring keeps time with the sender. Each arrival sets the ring's
  // jitter margin, and every 5 s a line says how the voice arrived.
  void packet(const std::byte* data, size_t size, uint32_t ts) {
    if (!voice_ || ended.load(std::memory_order_relaxed)) return;
    std::lock_guard<std::mutex> lk(mu_);
    const double now = std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    ring_.setTargetLag(jitter_.arrived(now, ts, 48000, ring_.underruns()));
    if (last_ > 0) gapMax_ = std::max(gapMax_, now - last_);
    last_ = now; window_++; packets.fetch_add(1, std::memory_order_relaxed);
    audio::OpusVoiceIn& v = *voice_;
    if (now - logged_ >= 5) {
      const uint32_t under = ring_.underruns(), over = ring_.overruns();
      if (logged_ > 0)
        HOST_LOGI("rtc audio in %u: %u packets, %u recovered, %u concealed, %u late; largest gap %.0f ms; jitter margin %.0f ms; %u underruns, %u overruns",
                  id_ - kRemoteTrackBase, window_, v.recovered, v.concealed, v.late, gapMax_ * 1000, jitter_.target() * 1000, under - underruns_, over - overruns_);
      window_ = 0; v.recovered = v.concealed = v.late = 0; gapMax_ = 0; logged_ = now; underruns_ = under; overruns_ = over;
    }
    v.packetAt(ts, (const unsigned char*)data, (int)size, ring_);
  }
 private:
  const uint32_t id_;
  OpusDecoder* dec_ = nullptr; std::unique_ptr<audio::OpusVoiceIn> voice_;
  audio::JitterTarget jitter_; audio::CaptureRing ring_; std::mutex mu_;
  uint32_t window_ = 0, underruns_ = 0, overruns_ = 0; double gapMax_ = 0, last_ = 0, logged_ = 0;
};
struct AudioXcv {
  int pc = 0; uint32_t ssrc = 0;
  std::shared_ptr<rtc::Track> track;
  RemoteAudio* remote = nullptr; uint32_t remoteId = 0;  // one reference, released on the host thread
  // Sending, under g_sendMu (the sender thread reads them):
  audio::LiveInput* input = nullptr; audio::LiveCursor cursor; OpusEncoder* enc = nullptr;
  int bitrate = 32000, applied = 0; uint32_t ts = 0; uint64_t sent = 0; bool closed = false;
};
std::unordered_map<int, std::shared_ptr<AudioXcv>> g_xcv;                  // host thread
std::unordered_map<uint32_t, RemoteAudio*> g_remote;                       // host thread: remote track id -> input
uint32_t g_nextRemote = kRemoteTrackBase + 1;
std::mutex g_sendMu; std::vector<std::shared_ptr<AudioXcv>> g_sending;   // the sender thread's list
std::atomic<bool> g_senderRun{false};

void retire(audio::LiveInput* in) {  // the last reference of a capture input goes on the host thread
  if (!in) return;
  g_svc->loop->post([in] { in->unref(); });
}
void senderLoop() {
  float pcm[960]; unsigned char pkt[1500];
  auto next = std::chrono::steady_clock::now();
  while (g_senderRun.load(std::memory_order_relaxed)) {
    next += std::chrono::milliseconds(20);
    {
      std::lock_guard<std::mutex> lk(g_sendMu);
      for (auto& x : g_sending) {
        if (x->closed || !x->track || !x->enc) continue;
        if (x->applied != x->bitrate) { opus_encoder_ctl(x->enc, OPUS_SET_BITRATE(x->bitrate)); x->applied = x->bitrate; }
        const uint32_t ts = x->ts; x->ts += 960;  // the stream's clock runs on, sending or not
        if (!x->input) continue;  // nothing to send without a source (the peer hears nothing, as in a browser), nothing encoded
        if (!x->input->read(x->cursor, pcm, 960, 48000.0)) memset(pcm, 0, sizeof pcm);  // a muted source: silence
        const int n = opus_encode_float(x->enc, pcm, 960, pkt, sizeof pkt);
        if (n <= 0) continue;
        try { if (x->track->isOpen()) { x->track->sendFrame((const std::byte*)pkt, (size_t)n, rtc::FrameInfo(ts)); x->sent++; } }
        catch (const std::exception& e) { HOST_LOGW("rtc: audio send failed: %s", e.what()); }
      }
    }
    std::this_thread::sleep_until(next);
    const auto now = std::chrono::steady_clock::now();
    if (now - next > std::chrono::milliseconds(200)) next = now;  // a long stall: no burst of catch-up frames
  }
}
void ensureSender() {
  if (g_senderRun.exchange(true)) return;
  std::thread(senderLoop).detach();  // lives as long as the process (a sleeping 20 ms tick when nothing is sent)
}
audio::LiveInput* remoteInput(uint32_t id) {  // the media binding's resolver for remote ids, host thread
  auto it = g_remote.find(id); if (it == g_remote.end() || it->second->ended) return nullptr;
  it->second->ref(); return it->second;
}
void closeXcv(const std::shared_ptr<AudioXcv>& x) {
  audio::LiveInput* old = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_sendMu);
    if (x->closed) return;
    x->closed = true; old = x->input; x->input = nullptr;
    g_sending.erase(std::remove(g_sending.begin(), g_sending.end(), x), g_sending.end());
    if (x->enc) { opus_encoder_destroy(x->enc); x->enc = nullptr; }
  }
  retire(old);
  if (x->remote) { x->remote->ended = true; g_remote.erase(x->remoteId); RemoteAudio* r = x->remote; x->remote = nullptr; g_svc->loop->post([r] { r->unref(); }); }
  x->track.reset();
}
std::shared_ptr<AudioXcv> xcv(const v8::FunctionCallbackInfo<v8::Value>& a) { auto it = g_xcv.find(bind::i32(a, 0)); return it == g_xcv.end() ? nullptr : it->second; }
void audioAdd(const v8::FunctionCallbackInfo<v8::Value>& a) {
  PC_OR_THROW
  const int pcId = bind::i32(a, 0); const std::string mid = bind::string(a, 1); const int pt = (int)bind::num(a, 2, 111);
  guarded(a, [&] {
    auto x = std::make_shared<AudioXcv>(); x->pc = pcId;
    // Random per launch and per device: std::rand() unseeded gave every headset the same sequence, so two of them
    // in a call sent on one SSRC.
    { static std::mt19937 rng{std::random_device{}()}; do x->ssrc = (uint32_t)rng(); while (x->ssrc == 0); }
    const std::string stream = "webxr-host-" + std::to_string(pcId), trackId = "audio-" + mid;
    rtc::Description::Audio media(mid, rtc::Description::Direction::SendRecv);
    media.addOpusCodec(pt);
    media.addSSRC(x->ssrc, std::string("webxr-host"), stream, trackId);
    x->track = p->addTrack(media);
    auto cfg = std::make_shared<rtc::RtpPacketizationConfig>(x->ssrc, "webxr-host", (uint8_t)pt, rtc::OpusRtpPacketizer::DefaultClockRate);
    auto packetizer = std::make_shared<rtc::OpusRtpPacketizer>(cfg);
    packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(cfg));
    packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
    packetizer->addToChain(std::make_shared<rtc::OpusRtpDepacketizer>());  // what arrives: RTP -> Opus frames
    // Receiver reports for what arrives (answering each sender report): the sender learns the loss it causes, and a
    // browser's Opus encoder only puts in-band FEC in its packets once loss is reported. Last in the chain, so it
    // sees the RTP before the depacketizer (incoming runs from the chain's end); it keeps the RTCP to itself.
    packetizer->addToChain(std::make_shared<rtc::RtcpReceivingSession>());
    x->track->setMediaHandler(packetizer);
    x->remoteId = g_nextRemote++; x->remote = new RemoteAudio(x->remoteId); g_remote[x->remoteId] = x->remote;
    RemoteAudio* r = x->remote; r->ref();  // the frame callback's own reference, dropped with the track
    std::shared_ptr<void> hold(nullptr, [r](void*) { g_svc->loop->post([r] { r->unref(); }); });
    x->track->onFrame([r, hold, pt](rtc::binary data, rtc::FrameInfo info) {
      if (info.payloadType && info.payloadType != pt) return;  // comfort noise, DTMF: not Opus
      r->packet(data.data(), data.size(), info.timestamp);
    });
    int e = 0; x->enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &e);
    if (x->enc) { opus_encoder_ctl(x->enc, OPUS_SET_INBAND_FEC(1)); opus_encoder_ctl(x->enc, OPUS_SET_PACKET_LOSS_PERC(10)); }
    const int xid = g_nextId++; g_xcv[xid] = x;
    { std::lock_guard<std::mutex> lk(g_sendMu); g_sending.push_back(x); }
    ensureSender();
    v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
    v8::Local<v8::Array> out = v8::Array::New(iso, 2);
    out->Set(ctx, 0, v8::Number::New(iso, xid)).Check(); out->Set(ctx, 1, v8::Number::New(iso, x->remoteId)).Check();
    a.GetReturnValue().Set(out);
  });
}
void audioSource(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto x = xcv(a); if (!x) return;
  audio::LiveInput* in = captureInput(bind::u32(a, 1)), *old = nullptr;
  { std::lock_guard<std::mutex> lk(g_sendMu); if (x->closed) { old = in; } else { old = x->input; x->input = in; x->cursor = audio::LiveCursor{}; } }
  retire(old);
}
void audioBitrate(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto x = xcv(a); if (!x) return;
  std::lock_guard<std::mutex> lk(g_sendMu); x->bitrate = std::clamp((int)bind::num(a, 1, 32000), 6000, 128000);
}
void audioStats(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto x = xcv(a); if (!x) { a.GetReturnValue().SetNull(); return; }
  uint64_t sent; { std::lock_guard<std::mutex> lk(g_sendMu); sent = x->sent; }
  v8::Local<v8::Array> out = v8::Array::New(iso, 3);
  out->Set(ctx, 0, v8::Number::New(iso, x->remote ? (double)x->remote->packets.load() : 0)).Check();
  out->Set(ctx, 1, v8::Number::New(iso, (double)sent)).Check();
  out->Set(ctx, 2, v8::Boolean::New(iso, x->track && x->track->isOpen())).Check();
  a.GetReturnValue().Set(out);
}
// audioRemoteEnabled(remoteTrackId, on): the receiver's MediaStreamTrack.enabled; off, its readers get silence.
void audioRemoteEnabled(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto it = g_remote.find(bind::u32(a, 0)); if (it != g_remote.end()) it->second->enabled.store(a[1]->BooleanValue(a.GetIsolate()), std::memory_order_relaxed);
}
void audioClose(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto it = g_xcv.find(bind::i32(a, 0)); if (it == g_xcv.end()) return;
  auto x = it->second; g_xcv.erase(it); closeXcv(x);
}
void closeXcvsOf(int pcId) {
  for (auto it = g_xcv.begin(); it != g_xcv.end();) { if (it->second->pc == pcId) { closeXcv(it->second); it = g_xcv.erase(it); } else ++it; }
}
#else
void closeXcvsOf(int) {}
#endif

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
  bind::fn(ctx, r, "pcSignaling", pcSignaling); bind::fn(ctx, r, "pcLocal", pcLocal); bind::fn(ctx, r, "pcRemote", pcRemote); bind::fn(ctx, r, "pcCreateDataChannel", pcCreateDataChannel); bind::fn(ctx, r, "pcClose", pcClose);
#ifdef HOST_HAS_WEBRTC_MEDIA
  bind::fn(ctx, r, "audioAdd", audioAdd); bind::fn(ctx, r, "audioSource", audioSource); bind::fn(ctx, r, "audioBitrate", audioBitrate);
  bind::fn(ctx, r, "audioStats", audioStats); bind::fn(ctx, r, "audioClose", audioClose); bind::fn(ctx, r, "audioRemoteEnabled", audioRemoteEnabled);
  setRtcLiveInputs(&remoteInput);
  HOST_LOGI("rtc: audio tracks (Opus over SRTP)");
#endif
  bind::fn(ctx, r, "dcSend", dcSend); bind::fn(ctx, r, "dcClose", dcClose); bind::fn(ctx, r, "dcBuffered", dcBuffered); bind::fn(ctx, r, "dcLowThreshold", dcLowThreshold); bind::fn(ctx, r, "dcInfo", dcInfo);
  HOST_LOGI("rtc: WebSocket and WebRTC data channels (libdatachannel %s)", RTC_VERSION);
}

}  // namespace host
#else
namespace host { void installRtc(v8::Local<v8::Context>, v8::Local<v8::Object>, HostServices&) {} }
#endif
