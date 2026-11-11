// __native.rtc (WP-21): WebSocket and WebRTC data channels through libdatachannel, for a game whose host.json asks
// for them (network.webrtc; CMake HOST_WEBRTC). runtime/src/rtc builds the browser classes on it: WebSocket,
// RTCPeerConnection, RTCDataChannel. Objects live here by id; libdatachannel calls back on its own threads, so
// every callback is posted to the host loop and delivered in order to the one JS dispatcher (onEvent):
//   ws-open id | ws-message id data | ws-close id | ws-error id text
//   pc-description id type sdp | pc-candidate id candidate mid | pc-state id s | pc-ice id s | pc-gathering id s
//   pc-signaling id s | pc-datachannel pcId dcId
//   dc-open id | dc-message id data | dc-close id | dc-error id text | dc-low id
// Messages arrive as a string or an ArrayBuffer. A build without WebRTC installs nothing.
// With the microphone as well (HOST_RTC_AUDIO: host.json media.microphone + network.webrtc), audio m-lines carry
// Opus both ways (AudioLink below): pcAddAudio, audioSetSource, audioSetDirection, and pcSetRemote answering the
// audio lines a remote offer brought.
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
#ifdef HOST_RTC_AUDIO
#include "media/mic.h"
#include <opus.h>
#include <chrono>
#include <mutex>
#include <random>
#include <strings.h>
#include <thread>
#endif

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

#ifdef HOST_RTC_AUDIO
// ---- audio: Opus over RTP ----
// One AudioLink per audio m-line (the page's transceiver). Sending: its sender's track (a microphone track,
// audioSetSource) is read every 20 ms on the audio-send thread, Opus-encoded (48 kHz mono, voice, in-band FEC) and
// packetized (libdatachannel's Opus packetizer, sender reports, receiver reports for what arrives). Receiving: each
// RTP packet is decoded on libdatachannel's thread straight into the link's RemoteTrack (media/mic.h), which the
// page reads as the receiver's MediaStreamTrack (an <audio srcObject>, a MediaStreamAudioSourceNode). A gap in the
// sequence is concealed (up to 5 frames); late packets are dropped.
constexpr int kFrame = 960;  // 20 ms at 48 kHz
struct AudioLink {
  int id = 0, pcId = 0; std::string mid;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::RtpPacketizationConfig> rtp;
  std::mutex mu;                          // source, encoder, cursor and clock: the JS thread against the send thread
  audio::LiveInput* source = nullptr;     // the sender's track, with a reference
  audio::LiveCursor cursor; uint32_t frames = 0;
  OpusEncoder* enc = nullptr;
  OpusDecoder* dec = nullptr; int lastSeq = -1;  // libdatachannel's receive thread
  media::RemoteTrack* remote = nullptr;   // the receiver's track (one reference held here)
  uint32_t remoteId = 0;
  ~AudioLink() {
    if (enc) opus_encoder_destroy(enc);
    if (dec) opus_decoder_destroy(dec);
    if (source) source->unref();
    if (remote) { remote->ended.store(true); remote->unref(); }
  }
};
std::mutex g_linksMu;
std::unordered_map<int, std::shared_ptr<AudioLink>> g_links;
std::vector<std::shared_ptr<AudioLink>> g_newLinks;  // made by onTrack, handed to the page by pcSetRemote

uint32_t randomSsrc() { static std::mt19937 r{std::random_device{}()}; uint32_t v; do v = r(); while (v == 0); return v; }
bool isOpus(const rtc::Description::Media& d, int pt) { const auto* m = d.rtpMap(pt); return m && !strcasecmp(m->format.c_str(), "opus"); }
int opusPayloadType(const rtc::Description::Media& d) { for (int pt : d.payloadTypes()) if (isOpus(d, pt)) return pt; return 111; }
rtc::Description::Direction directionOf(const std::string& s) {
  using D = rtc::Description::Direction;
  return s == "sendonly" ? D::SendOnly : s == "recvonly" ? D::RecvOnly : s == "inactive" ? D::Inactive : D::SendRecv;
}

void receive(AudioLink& l, const rtc::binary& b) {
  const size_t n = b.size(); const uint8_t* p = (const uint8_t*)b.data();
  if (n < 12 || (p[0] >> 6) != 2 || (p[1] >= 192 && p[1] <= 223)) return;  // not RTP version 2, or RTCP (rtcp-mux)
  if ((p[1] & 0x7F) != l.rtp->payloadType) return;
  size_t off = 12 + 4 * (size_t)(p[0] & 0x0F);
  if (p[0] & 0x10) { if (off + 4 > n) return; off += 4 + 4 * (size_t)((p[off + 2] << 8) | p[off + 3]); }
  size_t end = n; if (p[0] & 0x20) { if (p[n - 1] > n) return; end -= p[n - 1]; }
  if (off >= end) return;
  const uint16_t seq = (uint16_t)((p[2] << 8) | p[3]);
  float pcm[5760];
  if (l.lastSeq >= 0) {
    const int16_t ahead = (int16_t)(uint16_t)(seq - (uint16_t)(l.lastSeq + 1));
    if (ahead < 0) return;
    for (int i = 0; i < std::min<int>(ahead, 5); ++i) { const int k = opus_decode_float(l.dec, nullptr, 0, pcm, kFrame, 0); if (k > 0) l.remote->ring.write(pcm, (uint32_t)k); }
  }
  l.lastSeq = seq;
  const int k = opus_decode_float(l.dec, p + off, (opus_int32)(end - off), pcm, 5760, 0);
  if (k > 0) l.remote->ring.write(pcm, (uint32_t)k);
}

// The send clock: every 20 ms each link with a sender track encodes what that track captured. RTP time runs on
// while a link has a sender (muted or not), so the receiver sees the gaps as the time they were.
void sendLoop() {
  std::vector<std::shared_ptr<AudioLink>> links; float pcm[kFrame]; unsigned char packet[1500];
  auto next = std::chrono::steady_clock::now();
  for (;;) {
    next += std::chrono::milliseconds(20);
    std::this_thread::sleep_until(next);
    if (std::chrono::steady_clock::now() - next > std::chrono::milliseconds(200)) next = std::chrono::steady_clock::now();
    { std::lock_guard<std::mutex> g(g_linksMu); links.clear(); for (auto& kv : g_links) links.push_back(kv.second); }
    for (auto& l : links) {
      std::lock_guard<std::mutex> g(l->mu);
      if (!l->source || !l->enc) continue;
      l->frames++;
      if (!l->track->isOpen() || !l->source->read(l->cursor, pcm, kFrame, 48000)) continue;
      const int len = opus_encode_float(l->enc, pcm, kFrame, packet, (opus_int32)sizeof packet);
      if (len <= 0) continue;
      try { l->track->sendFrame((const rtc::byte*)packet, (size_t)len, rtc::FrameInfo(l->rtp->startTimestamp + l->frames * (uint32_t)kFrame)); }
      catch (const std::exception& e) { HOST_LOGW("rtc audio: send: %s", e.what()); }
    }
    links.clear();
  }
}

std::shared_ptr<AudioLink> makeLink(int pcId, const std::shared_ptr<rtc::Track>& track, uint32_t ssrc) {
  static std::once_flag started;
  std::call_once(started, [] { std::thread(sendLoop).detach(); });
  auto l = std::make_shared<AudioLink>();
  l->id = g_nextId++; l->pcId = pcId; l->track = track; l->mid = track->mid();
  l->rtp = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, "webxr-host", (uint8_t)opusPayloadType(track->description()), rtc::OpusRtpPacketizer::DefaultClockRate);
  auto chain = std::make_shared<rtc::OpusRtpPacketizer>(l->rtp);
  chain->addToChain(std::make_shared<rtc::RtcpSrReporter>(l->rtp));
  chain->addToChain(std::make_shared<rtc::RtcpReceivingSession>());
  track->setMediaHandler(chain);
  int e = 0;
  if ((l->enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &e))) {
    opus_encoder_ctl(l->enc, OPUS_SET_BITRATE(32000)); opus_encoder_ctl(l->enc, OPUS_SET_INBAND_FEC(1)); opus_encoder_ctl(l->enc, OPUS_SET_PACKET_LOSS_PERC(5));
  }
  l->dec = opus_decoder_create(48000, 1, &e);
  l->remote = new media::RemoteTrack();
  std::weak_ptr<AudioLink> weak = l;
  track->onMessage([weak](rtc::binary b) { if (auto x = weak.lock()) receive(*x, b); }, nullptr);
  return l;
}
// [linkId, remoteTrackId, mid] for the page's transceiver; the remote track is registered here (the JS thread).
v8::Local<v8::Array> linkInfo(v8::Isolate* iso, AudioLink& l) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!l.remoteId) l.remoteId = media::Mic::get().addRemote(l.remote);
  v8::Local<v8::Array> o = v8::Array::New(iso, 3);
  o->Set(ctx, 0, v8::Number::New(iso, l.id)).Check(); o->Set(ctx, 1, v8::Number::New(iso, l.remoteId)).Check(); o->Set(ctx, 2, bind::str(iso, l.mid)).Check();
  return o;
}
// A remote offer's audio line: answered with Opus only, and our SSRC for what we send back. Runs inside
// setRemoteDescription (libdatachannel lets the description change here, before the answer is made).
void onRemoteTrack(int pcId, std::shared_ptr<rtc::Track> t) {
  auto d = t->description();
  if (d.type() != "audio") return;
  for (int pt : d.payloadTypes()) if (!isOpus(d, pt)) d.removeRtpMap(pt);
  // The offer's own stream and track ids come along in the reciprocated section; ours replace them (Chrome refuses
  // an answer whose m-section names two track ids).
  for (const std::string& attr : d.attributes()) if (attr.rfind("msid:", 0) == 0 || attr.rfind("ssrc", 0) == 0) d.removeAttribute(attr);
  const uint32_t ssrc = randomSsrc();
  d.addSSRC(ssrc, std::string("webxr-host"), std::string("webxr-host"), "audio-" + t->mid());
  t->setDescription(std::move(d));
  auto l = makeLink(pcId, t, ssrc);
  std::lock_guard<std::mutex> g(g_linksMu); g_links[l->id] = l; g_newLinks.push_back(l);
}
std::shared_ptr<AudioLink> link(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::lock_guard<std::mutex> g(g_linksMu); auto it = g_links.find(bind::i32(a, 0)); return it == g_links.end() ? nullptr : it->second;
}
// audioSetSource(link, trackId | 0): what the sender sends (a microphone track), or nothing.
void audioSetSource(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto l = link(a); if (!l) return;
  audio::LiveInput* in = bind::u32(a, 1) ? media::Mic::get().input(bind::u32(a, 1)) : nullptr;
  std::lock_guard<std::mutex> g(l->mu);
  if (l->source) l->source->unref();
  l->source = in; l->cursor = audio::LiveCursor{};
}
// audioSetDirection(link, 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'): for the next description.
void audioSetDirection(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto l = link(a); if (!l) return;
  guarded(a, [&] { auto d = l->track->description(); d.setDirection(directionOf(bind::string(a, 1))); l->track->setDescription(std::move(d)); });
}
void closeLinks(int pcId) {
  std::lock_guard<std::mutex> g(g_linksMu);
  for (auto it = g_links.begin(); it != g_links.end();) {
    if (it->second->pcId != pcId) { ++it; continue; }
    if (it->second->remote) it->second->remote->ended.store(true);
    it = g_links.erase(it);
  }
}
#endif

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
#ifdef HOST_RTC_AUDIO
    pc->onTrack([id](std::shared_ptr<rtc::Track> t) { onRemoteTrack(id, std::move(t)); });
#endif
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
// pcSetRemote(id, sdp, type) -> the audio lines the description brought ([[linkId, remoteTrackId, mid], ...]).
void pcSetRemote(const v8::FunctionCallbackInfo<v8::Value>& a) {
  PC_OR_THROW
  guarded(a, [&] {
    p->setRemoteDescription(rtc::Description(bind::string(a, 1), bind::string(a, 2)));
#ifdef HOST_RTC_AUDIO
    v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
    const int pcId = bind::i32(a, 0);
    std::vector<std::shared_ptr<AudioLink>> fresh, mine;
    {
      std::lock_guard<std::mutex> g(g_linksMu);
      for (auto it = g_newLinks.begin(); it != g_newLinks.end();) { if ((*it)->pcId == pcId) { fresh.push_back(*it); it = g_newLinks.erase(it); } else ++it; }
      for (auto& kv : g_links) if (kv.second->pcId == pcId) mine.push_back(kv.second);
    }
    // The payload type the remote side chose for Opus, for what we send on each line.
    if (auto rd = p->remoteDescription()) for (int i = 0; i < rd->mediaCount(); ++i) {
      auto m = rd->media(i); if (!std::holds_alternative<rtc::Description::Media*>(m)) continue;
      auto* media = std::get<rtc::Description::Media*>(m);
      for (auto& l : mine) if (l->mid == media->mid()) { std::lock_guard<std::mutex> g(l->mu); l->rtp->payloadType = (uint8_t)opusPayloadType(*media); }
    }
    v8::Local<v8::Array> out = v8::Array::New(iso, (int)fresh.size());
    for (size_t i = 0; i < fresh.size(); ++i) out->Set(ctx, (uint32_t)i, linkInfo(iso, *fresh[i])).Check();
    a.GetReturnValue().Set(out);
#endif
  });
}
#ifdef HOST_RTC_AUDIO
// pcAddAudio(id, direction) -> [linkId, remoteTrackId, mid]: the page's addTransceiver('audio'), offered as Opus.
void pcAddAudio(const v8::FunctionCallbackInfo<v8::Value>& a) {
  PC_OR_THROW
  guarded(a, [&] {
    const int pcId = bind::i32(a, 0);
    int n = 0; { std::lock_guard<std::mutex> g(g_linksMu); for (auto& kv : g_links) if (kv.second->pcId == pcId) ++n; }
    const std::string mid = "audio" + (n ? std::to_string(n) : std::string());
    rtc::Description::Audio media(mid, directionOf(bind::string(a, 1)));
    media.addOpusCodec(111);
    const uint32_t ssrc = randomSsrc();
    media.addSSRC(ssrc, std::string("webxr-host"), std::string("webxr-host"), "audio-" + mid);
    auto l = makeLink(pcId, p->addTrack(media), ssrc);
    { std::lock_guard<std::mutex> g(g_linksMu); g_links[l->id] = l; }
    a.GetReturnValue().Set(linkInfo(a.GetIsolate(), *l));
  });
}
#endif
void pcAddCandidate(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW guarded(a, [&] { p->addRemoteCandidate(rtc::Candidate(bind::string(a, 1), bind::string(a, 2))); }); }
void describe(const v8::FunctionCallbackInfo<v8::Value>& a, const std::optional<rtc::Description>& d) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!d) { a.GetReturnValue().SetNull(); return; }
  v8::Local<v8::Array> out = v8::Array::New(iso, 2); out->Set(ctx, 0, bind::str(iso, d->typeString())).Check(); out->Set(ctx, 1, bind::str(iso, std::string(*d))).Check();
  a.GetReturnValue().Set(out);
}
void pcLocal(const v8::FunctionCallbackInfo<v8::Value>& a) { PC_OR_THROW describe(a, p->localDescription()); }
// The signaling state as it is now (the pc-signaling events trail it: they are posted to the loop).
void pcSignaling(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* p = pc(a); a.GetReturnValue().Set(bind::str(a.GetIsolate(), p ? kSignaling[(int)p->signalingState()] : "closed")); }
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
#ifdef HOST_RTC_AUDIO
  closeLinks(bind::i32(a, 0));
#endif
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
  bind::fn(ctx, r, "pcLocal", pcLocal); bind::fn(ctx, r, "pcRemote", pcRemote); bind::fn(ctx, r, "pcSignaling", pcSignaling); bind::fn(ctx, r, "pcCreateDataChannel", pcCreateDataChannel); bind::fn(ctx, r, "pcClose", pcClose);
  bind::fn(ctx, r, "dcSend", dcSend); bind::fn(ctx, r, "dcClose", dcClose); bind::fn(ctx, r, "dcBuffered", dcBuffered); bind::fn(ctx, r, "dcLowThreshold", dcLowThreshold); bind::fn(ctx, r, "dcInfo", dcInfo);
#ifdef HOST_RTC_AUDIO
  bind::fn(ctx, r, "pcAddAudio", pcAddAudio); bind::fn(ctx, r, "audioSetSource", audioSetSource); bind::fn(ctx, r, "audioSetDirection", audioSetDirection);
  HOST_LOGI("rtc: WebSocket, WebRTC data channels and Opus audio (libdatachannel %s)", RTC_VERSION);
#else
  HOST_LOGI("rtc: WebSocket and WebRTC data channels (libdatachannel %s)", RTC_VERSION);
#endif
}

}  // namespace host
#else
namespace host { void installRtc(v8::Local<v8::Context>, v8::Local<v8::Object>, HostServices&) {} }
#endif
