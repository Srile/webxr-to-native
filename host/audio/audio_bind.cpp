// __native.audio (WP-08): node handles over the C++ graph. The JS classes are
// runtime/src/webaudio/index.js, which documents this surface at its top.
// Handles: (contextIndex << 20) | slot; slot 0xFFFFF is the context's listener;
// handle 0 is never valid. Buffers are small integer ids over refcounted PCM.
#include <memory>
#include <unordered_map>
#include <vector>
#include "audio/analyser.h"
#include "audio/context.h"
#include "audio/decode.h"
#include "audio/device.h"
#include "audio/offline.h"
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/natives.h"

namespace host {
namespace {

using namespace audio;
constexpr uint32_t SLOT_BITS = 20, SLOT_MASK = (1u << SLOT_BITS) - 1, LISTENER_SLOT_JS = SLOT_MASK;

struct CtxRec { std::unique_ptr<ContextBase> ctx; OfflineContext* offline = nullptr; RealtimeContext* rt = nullptr; };

struct AudioBinding {
  HostServices* svc = nullptr;
  uint32_t maxNodes = 512; double preferredRate = 0;
  std::vector<std::unique_ptr<CtxRec>> ctxs;  // index 0 unused
  std::unordered_map<uint32_t, AudioBufferData*> buffers; uint32_t nextBuffer = 1;
  std::unordered_map<uint32_t, v8::Global<v8::Function>> ended;
  std::unordered_map<uint32_t, AnalyserState*> analysers;  // node handle -> the host's reference (the graph holds its own)
  LiveInput* (*liveInput)(uint32_t trackId) = nullptr;     // the media module's tracks (WP-25), when it is built
  DecodeWorker decoder;
  void dropAnalyser(uint32_t h) { auto it = analysers.find(h); if (it != analysers.end()) { it->second->unref(); analysers.erase(it); } }

  ContextBase* ctxOf(uint32_t handle, uint32_t* slot) {
    uint32_t ci = handle >> SLOT_BITS, s = handle & SLOT_MASK;
    if (ci == 0 || ci >= ctxs.size() || !ctxs[ci]) return nullptr;
    if (slot) *slot = s == LISTENER_SLOT_JS ? LISTENER_SLOT : s;
    return ctxs[ci]->ctx.get();
  }
  CtxRec* rec(uint32_t id) { return id < ctxs.size() ? ctxs[id].get() : nullptr; }
  static uint32_t handle(uint32_t ci, uint32_t slot) { return (ci << SLOT_BITS) | (slot == LISTENER_SLOT ? LISTENER_SLOT_JS : slot); }
  // The host thread's record (ContextBase::kindOf), not the graph's node: a realtime context's render thread has not
  // made a node created just now yet, so the page's first settings on it (a param's value, an analyser's size) would be lost.
  Kind kindOf(ContextBase* c, uint32_t slot) { return c->kindOf(slot); }
  uint32_t addBuffer(AudioBufferData* b) { uint32_t id = nextBuffer++; buffers[id] = b; return id; }
  // Runs f on the host thread inside the engine's scopes.
  void post(std::function<void(v8::Isolate*, v8::Local<v8::Context>)> f) {
    if (!svc || !svc->loop || !svc->engine) return;
    Engine* eng = svc->engine;
    svc->loop->post([eng, f]() { eng->run(f); });
  }
};
AudioBinding* g = nullptr;

using Args = v8::FunctionCallbackInfo<v8::Value>;
inline uint32_t H(const Args& a, int i) { return bind::u32(a, i); }
bool paramOf(const Args& a, int nodeArg, int nameArg, ContextBase** c, uint32_t* slot, int* idx) {
  *c = g->ctxOf(H(a, nodeArg), slot); if (!*c) return false;
  std::string name = bind::string(a, nameArg);
  *idx = paramIndex(g->kindOf(*c, *slot), name.c_str());
  return *idx >= 0;
}

void createContext(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  bool offline = bind::boolean(a, 0); int channels = bind::i32(a, 1, 2); uint32_t length = bind::u32(a, 2); double rate = bind::num(a, 3, 0);
  auto r = std::make_unique<CtxRec>();
  if (offline) {
    if (rate <= 0) rate = 48000;
    r->offline = new OfflineContext(channels, length, rate, g->maxNodes); r->ctx.reset(r->offline);
  } else {
    r->rt = RealtimeContext::create(g->maxNodes, rate > 0 ? rate : g->preferredRate); r->ctx.reset(r->rt);
  }
  uint32_t id = (uint32_t)g->ctxs.size(); g->ctxs.push_back(std::move(r));
  CtxRec* rec = g->ctxs[id].get();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "id", id); bind::setNum(ctx, o, "sampleRate", rec->ctx->sampleRate());
  bind::setNum(ctx, o, "destination", AudioBinding::handle(id, 0)); bind::setNum(ctx, o, "listener", AudioBinding::handle(id, LISTENER_SLOT));
  bind::setBool(ctx, o, "running", rec->ctx->running()); bind::setBool(ctx, o, "device", rec->rt ? rec->rt->hasDevice() : false);
  a.GetReturnValue().Set(o);
}
void closeContext(const Args& a) {
  uint32_t id = H(a, 0); CtxRec* r = g->rec(id); if (!r) return;
  if (r->rt) r->rt->close();
  // Final drain releases every buffer the graph still holds; ended callbacks for this context are dropped.
  for (auto it = g->ended.begin(); it != g->ended.end();) { if ((it->first >> SLOT_BITS) == id) it = g->ended.erase(it); else ++it; }
  for (auto it = g->analysers.begin(); it != g->analysers.end();) { if ((it->first >> SLOT_BITS) == id) { it->second->unref(); it = g->analysers.erase(it); } else ++it; }
  g->ctxs[id].reset();
}
void contextTime(const Args& a) { CtxRec* r = g->rec(H(a, 0)); a.GetReturnValue().Set(r ? r->ctx->currentTime() : 0.0); }
void resume(const Args& a) { CtxRec* r = g->rec(H(a, 0)); a.GetReturnValue().Set(r ? r->ctx->resume() : false); }
void suspend(const Args& a) { CtxRec* r = g->rec(H(a, 0)); a.GetReturnValue().Set(r ? r->ctx->suspend() : false); }

void createNode(const Args& a) {
  uint32_t id = H(a, 0); CtxRec* r = g->rec(id);
  std::string kind = bind::string(a, 1); Kind k = kindFromString(kind.c_str());
  if (!r || k == Kind::None || k == Kind::Destination || k == Kind::Listener) { a.GetReturnValue().Set(0); return; }
  uint32_t slot = r->ctx->createNode(k);
  a.GetReturnValue().Set(slot == NONE ? 0u : AudioBinding::handle(id, slot));
}
void releaseNode(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (!c || slot == 0 || slot == LISTENER_SLOT) return;
  g->ended.erase(H(a, 0)); g->dropAnalyser(H(a, 0)); c->releaseNode(slot);
}
void connect(const Args& a) {
  uint32_t from, to; ContextBase* c = g->ctxOf(H(a, 0), &from); ContextBase* d = g->ctxOf(H(a, 2), &to);
  if (!c || c != d || from == LISTENER_SLOT || to == LISTENER_SLOT) { a.GetReturnValue().Set(false); return; }
  a.GetReturnValue().Set(c->connect(from, to));
}
void connectParam(const Args& a) {
  uint32_t from, to; int idx; ContextBase* c = g->ctxOf(H(a, 0), &from); ContextBase* d;
  if (!c || !paramOf(a, 2, 3, &d, &to, &idx) || c != d || from == LISTENER_SLOT || to == LISTENER_SLOT) { a.GetReturnValue().Set(false); return; }
  a.GetReturnValue().Set(c->connectParam(from, to, idx));
}
void disconnect(const Args& a) {
  uint32_t from, to = NONE; ContextBase* c = g->ctxOf(H(a, 0), &from); if (!c) return;
  if (H(a, 2) != 0) { ContextBase* d = g->ctxOf(H(a, 2), &to); if (d != c) return; }
  c->disconnect(from, to);
}
void disconnectParam(const Args& a) {
  uint32_t from, to; ContextBase* c = g->ctxOf(H(a, 0), &from); if (!c) return;
  ContextBase* d = g->ctxOf(H(a, 2), &to); if (d != c) return;
  int idx = -1; if (a.Length() > 3 && a[3]->IsString()) { std::string n = bind::string(a, 3); idx = paramIndex(g->kindOf(c, to), n.c_str()); if (idx < 0) return; }
  c->disconnectParam(from, to, idx);
}
void setProp(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (!c || slot == LISTENER_SLOT) { a.GetReturnValue().Set(false); return; }
  std::string name = bind::string(a, 1); int p = propIndex(name.c_str()); if (p < 0) { a.GetReturnValue().Set(false); return; }
  double v;
  if (a.Length() > 2 && a[2]->IsString()) { std::string s = bind::string(a, 2); int e = enumValue((Prop)p, s.c_str()); if (e < 0) { a.GetReturnValue().Set(false); return; } v = e; }
  else if (a.Length() > 2 && a[2]->IsBoolean()) v = bind::boolean(a, 2) ? 1 : 0;
  else v = bind::num(a, 2);
  c->setProp(slot, (Prop)p, v); a.GetReturnValue().Set(true);
}
void getProp(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (!c) { a.GetReturnValue().Set(0.0); return; }
  std::string name = bind::string(a, 1);
  if (name == "reduction") { a.GetReturnValue().Set((double)c->reduction(slot)); return; }
  a.GetReturnValue().Set(0.0);
}
void setParam(const Args& a) {
  ContextBase* c; uint32_t slot; int idx; if (!paramOf(a, 0, 1, &c, &slot, &idx)) { a.GetReturnValue().Set(false); return; }
  c->setParam(slot, idx, bind::num(a, 2)); a.GetReturnValue().Set(true);
}
void paramValue(const Args& a) {
  ContextBase* c; uint32_t slot; int idx; if (!paramOf(a, 0, 1, &c, &slot, &idx)) { a.GetReturnValue().Set(0.0); return; }
  a.GetReturnValue().Set((double)c->paramValue(slot, idx));
}
void scheduleParam(const Args& a) {
  ContextBase* c; uint32_t slot; int idx; if (!paramOf(a, 0, 1, &c, &slot, &idx)) { a.GetReturnValue().Set(false); return; }
  int op = bind::i32(a, 2); if (op < 0 || op > 3) { a.GetReturnValue().Set(false); return; }
  c->schedule(slot, idx, (EvType)op, bind::num(a, 3), bind::num(a, 4), bind::num(a, 5)); a.GetReturnValue().Set(true);
}
void cancelScheduled(const Args& a) { ContextBase* c; uint32_t slot; int idx; if (paramOf(a, 0, 1, &c, &slot, &idx)) c->cancel(slot, idx, bind::num(a, 2)); }
void cancelAndHold(const Args& a) { ContextBase* c; uint32_t slot; int idx; if (paramOf(a, 0, 1, &c, &slot, &idx)) c->cancelHold(slot, idx, bind::num(a, 2)); }
void start(const Args& a) { uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (c) c->start(slot, bind::num(a, 1), bind::num(a, 2), bind::num(a, 3)); }
void stop(const Args& a) { uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (c) c->stop(slot, bind::num(a, 1)); }
void onEnded(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (!c) return;
  if (a.Length() > 1 && a[1]->IsFunction()) g->ended[H(a, 0)].Reset(a.GetIsolate(), a[1].As<v8::Function>()); else g->ended.erase(H(a, 0));
}
void setBuffer(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot); if (!c) { a.GetReturnValue().Set(false); return; }
  uint32_t id = H(a, 1); AudioBufferData* b = nullptr;
  if (id) { auto it = g->buffers.find(id); if (it == g->buffers.end()) { a.GetReturnValue().Set(false); return; } b = it->second; }
  c->setBuffer(slot, b); a.GetReturnValue().Set(true);
}

// AnalyserNode (WP-25). analyserSize(node, fftSize): a new history and FFT of that size (fftSize validated by the
// caller: a power of two in 32..32768), the old one released; the graph gets its own reference.
void analyserSize(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot);
  if (!c || g->kindOf(c, slot) != Kind::Analyser) { a.GetReturnValue().Set(false); return; }
  AnalyserState* st = AnalyserState::create(bind::u32(a, 1));
  if (!st) { a.GetReturnValue().Set(false); return; }
  g->dropAnalyser(H(a, 0)); g->analysers[H(a, 0)] = st; c->setExt(slot, st);
  a.GetReturnValue().Set(true);
}
// analyserTime(node, Float32Array|Uint8Array): the latest fftSize samples into the array (its own memory, no copy).
void analyserTime(const Args& a) {
  auto it = g->analysers.find(H(a, 0)); if (it == g->analysers.end() || a.Length() < 2) return;
  bind::Bytes b = bind::bytes(a[1]); if (!b.ok) return;
  if (a[1]->IsFloat32Array()) it->second->timeDomain((float*)b.data, (uint32_t)(b.len / 4));
  else if (a[1]->IsUint8Array()) it->second->timeDomainBytes(b.data, (uint32_t)b.len);
}
// analyserFrequency(node, Float32Array|Uint8Array, smoothing, minDb, maxDb): the frequency data in dB, or as bytes.
void analyserFrequency(const Args& a) {
  auto it = g->analysers.find(H(a, 0)); if (it == g->analysers.end() || a.Length() < 2) return;
  bind::Bytes b = bind::bytes(a[1]); if (!b.ok) return;
  const double smoothing = bind::num(a, 2, 0.8), minDb = bind::num(a, 3, -100), maxDb = bind::num(a, 4, -30);
  if (a[1]->IsFloat32Array()) it->second->frequency((float*)b.data, (uint32_t)(b.len / 4), smoothing);
  else if (a[1]->IsUint8Array()) it->second->frequencyBytes(b.data, (uint32_t)b.len, smoothing, minDb, maxDb);
}
// setInput(node, trackId) → bool: a MediaStreamAudioSourceNode reads that capture track (WP-25; false without one).
void setInput(const Args& a) {
  uint32_t slot; ContextBase* c = g->ctxOf(H(a, 0), &slot);
  if (!c || !c->realtime() || !g->liveInput || g->kindOf(c, slot) != Kind::MediaStream) { a.GetReturnValue().Set(false); return; }
  LiveInput* in = g->liveInput(bind::u32(a, 1));
  if (!in) { a.GetReturnValue().Set(false); return; }
  c->setExt(slot, in); in->unref();  // setExt took the graph's reference; this one was the resolver's
  a.GetReturnValue().Set(true);
}

void createBuffer(const Args& a) {
  int ch = bind::i32(a, 0, 1); uint32_t len = bind::u32(a, 1); double rate = bind::num(a, 2, 48000);
  if (ch < 1 || ch > 32 || rate <= 0) { bind::throwError(a.GetIsolate(), "createBuffer: bad arguments"); return; }
  a.GetReturnValue().Set(g->addBuffer(AudioBufferData::create(ch, len, rate)));
}
void bufferInfo(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto it = g->buffers.find(H(a, 0)); if (it == g->buffers.end()) { a.GetReturnValue().SetNull(); return; }
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "channels", it->second->channels); bind::setNum(ctx, o, "length", it->second->length); bind::setNum(ctx, o, "sampleRate", it->second->sampleRate);
  a.GetReturnValue().Set(o);
}
// A Float32Array ALIASING the native channel: the backing store holds a reference, dropped when V8 frees it.
void channelData(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  auto it = g->buffers.find(H(a, 0)); int ch = bind::i32(a, 1);
  if (it == g->buffers.end() || ch < 0 || ch >= it->second->channels) { bind::throwError(iso, "channelData: no such buffer/channel"); return; }
  AudioBufferData* b = it->second;
  if (b->length == 0) { a.GetReturnValue().Set(v8::Float32Array::New(v8::ArrayBuffer::New(iso, 0), 0, 0)); return; }
  b->ref();
  std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(
      b->ch(ch), (size_t)b->length * sizeof(float), [](void*, size_t, void* d) { ((AudioBufferData*)d)->unref(); }, b);
  v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(iso, std::move(store));
  a.GetReturnValue().Set(v8::Float32Array::New(ab, 0, b->length));
}
void releaseBuffer(const Args& a) {
  auto it = g->buffers.find(H(a, 0)); if (it == g->buffers.end()) return;
  it->second->unref(); g->buffers.erase(it);
}
void detach(const Args& a) {
  if (a.Length() < 1 || !a[0]->IsArrayBuffer()) { a.GetReturnValue().Set(false); return; }
  v8::Local<v8::ArrayBuffer> ab = a[0].As<v8::ArrayBuffer>();
  if (!ab->IsDetachable()) { a.GetReturnValue().Set(false); return; }
  ab->Detach(); a.GetReturnValue().Set(true);
}
// decodeAudio(bytes, targetRate, cb(bufferId|0, channels, length, sampleRate, err|null)): the bytes are copied here,
// decoded on the worker, and the callback posted to the host loop with the buffer already resident.
void decodeAudio(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  bind::Bytes b = bind::bytes(a[0]);
  if (!b.ok || a.Length() < 3 || !a[2]->IsFunction()) { bind::throwType(iso, "decodeAudio(bytes, rate, cb)"); return; }
  double rate = bind::num(a, 1, 0);
  std::vector<uint8_t> copy(b.data, b.data + b.len);
  auto cb = std::make_shared<v8::Global<v8::Function>>(iso, a[2].As<v8::Function>());
  g->decoder.submit(std::move(copy), rate, [cb](AudioBufferData* buf, std::string err) {
    g->post([cb, buf, err](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      v8::Local<v8::Value> argv[5];
      if (buf) {
        uint32_t id = g->addBuffer(buf);
        argv[0] = v8::Number::New(iso, id); argv[1] = v8::Number::New(iso, buf->channels); argv[2] = v8::Number::New(iso, buf->length);
        argv[3] = v8::Number::New(iso, buf->sampleRate); argv[4] = v8::Null(iso);
      } else {
        argv[0] = v8::Number::New(iso, 0); argv[1] = argv[2] = argv[3] = v8::Number::New(iso, 0); argv[4] = bind::str(iso, err);
      }
      v8::Local<v8::Function> f = cb->Get(iso);
      (void)f->Call(ctx, ctx->Global(), 5, argv);
    });
  });
}
// offlineRender(ctx, cb(bufferId|0, channels, length, sampleRate)): renders on a thread, posts the callback.
void offlineRender(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  CtxRec* r = g->rec(H(a, 0));
  if (!r || !r->offline || a.Length() < 2 || !a[1]->IsFunction()) { bind::throwError(iso, "offlineRender: not an offline context"); return; }
  auto cb = std::make_shared<v8::Global<v8::Function>>(iso, a[1].As<v8::Function>());
  bool ok = r->offline->startRendering([cb](AudioBufferData* buf) {
    g->post([cb, buf](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      uint32_t id = g->addBuffer(buf);
      v8::Local<v8::Value> argv[4] = {v8::Number::New(iso, id), v8::Number::New(iso, buf->channels), v8::Number::New(iso, buf->length), v8::Number::New(iso, buf->sampleRate)};
      (void)cb->Get(iso)->Call(ctx, ctx->Global(), 4, argv);
    });
  });
  a.GetReturnValue().Set(ok);
}
void stats(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  size_t live = 0; for (auto& c : g->ctxs) if (c) live++;
  bind::setNum(ctx, o, "contexts", (double)live); bind::setNum(ctx, o, "buffers", (double)g->buffers.size());
  bind::setNum(ctx, o, "endedCallbacks", (double)g->ended.size()); bind::setNum(ctx, o, "maxNodes", g->maxNodes);
  CtxRec* r = g->rec(H(a, 0));
  if (r) { bind::setNum(ctx, o, "liveNodes", r->ctx->liveSlots()); bind::setNum(ctx, o, "droppedMsgs", r->ctx->graph().droppedMsgs()); if (r->rt) bind::setNum(ctx, o, "droppedCommands", r->rt->droppedCommands()); }
  a.GetReturnValue().Set(o);
}

}  // namespace

void setAudioLiveInputs(audio::LiveInput* (*resolve)(uint32_t trackId)) { if (!g) g = new AudioBinding(); g->liveInput = resolve; }

void installAudio(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  if (!g) g = new AudioBinding();
  g->svc = &svc;
#ifdef V8_ENABLE_SANDBOX
  // V8's sandbox (the Windows prebuilt): an ArrayBuffer may only alias memory inside it, which V8's allocator hands out.
  AudioBufferData::allocSamples = [](size_t n) { return Engine::sharedAllocator()->AllocateUninitialized(n); };
  AudioBufferData::freeSamples = [](void* p, size_t n) { Engine::sharedAllocator()->Free(p, n); };
#endif
  if (svc.config) { const Json& au = svc.config->at("audio"); g->maxNodes = (uint32_t)au.n("maxNodes", 512); g->preferredRate = au.n("sampleRate", 0); }
  if (g->maxNodes < 16) g->maxNodes = 16;
  if (g->ctxs.empty()) g->ctxs.emplace_back();  // index 0 unused
  v8::Local<v8::Object> o = bind::obj(ctx, native, "audio");
  bind::fn(ctx, o, "createContext", createContext); bind::fn(ctx, o, "closeContext", closeContext);
  bind::fn(ctx, o, "contextTime", contextTime); bind::fn(ctx, o, "resume", resume); bind::fn(ctx, o, "suspend", suspend);
  bind::fn(ctx, o, "createNode", createNode); bind::fn(ctx, o, "releaseNode", releaseNode);
  bind::fn(ctx, o, "connect", connect); bind::fn(ctx, o, "connectParam", connectParam);
  bind::fn(ctx, o, "disconnect", disconnect); bind::fn(ctx, o, "disconnectParam", disconnectParam);
  bind::fn(ctx, o, "setProp", setProp); bind::fn(ctx, o, "getProp", getProp);
  bind::fn(ctx, o, "setParam", setParam); bind::fn(ctx, o, "paramValue", paramValue);
  bind::fn(ctx, o, "scheduleParam", scheduleParam); bind::fn(ctx, o, "cancelScheduled", cancelScheduled); bind::fn(ctx, o, "cancelAndHold", cancelAndHold);
  bind::fn(ctx, o, "start", start); bind::fn(ctx, o, "stop", stop); bind::fn(ctx, o, "onEnded", onEnded); bind::fn(ctx, o, "setBuffer", setBuffer);
  bind::fn(ctx, o, "createBuffer", createBuffer); bind::fn(ctx, o, "bufferInfo", bufferInfo); bind::fn(ctx, o, "channelData", channelData);
  bind::fn(ctx, o, "releaseBuffer", releaseBuffer); bind::fn(ctx, o, "detach", detach);
  bind::fn(ctx, o, "decodeAudio", decodeAudio); bind::fn(ctx, o, "offlineRender", offlineRender); bind::fn(ctx, o, "stats", stats);
  bind::fn(ctx, o, "analyserSize", analyserSize); bind::fn(ctx, o, "analyserTime", analyserTime); bind::fn(ctx, o, "analyserFrequency", analyserFrequency);
  if (g->liveInput) bind::fn(ctx, o, "setInput", setInput);
  bind::setStr(ctx, o, "codecs", decodableCodecs());
}

// Host thread, every loop iteration: device housekeeping and the graphs' messages (ended callbacks).
void audioTick(HostServices& svc) {
  if (!g || !svc.engine) return;
  bool anyEnded = false;
  for (uint32_t ci = 1; ci < g->ctxs.size(); ci++) {
    CtxRec* r = g->ctxs[ci].get(); if (!r) continue;
    r->ctx->tick();
    if (r->ctx->graph().msgs().size() == 0) continue;
    std::vector<uint32_t> fired;
    r->ctx->drain([&](const Msg& m) {
      uint32_t h = AudioBinding::handle(ci, m.slot);
      if (m.type == Msg::Ended) { if (g->ended.count(h)) fired.push_back(h); }
      else if (m.type == Msg::Freed) g->ended.erase(h);
    });
    if (fired.empty()) continue;
    anyEnded = true;
    svc.engine->run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      for (uint32_t h : fired) {
        auto it = g->ended.find(h); if (it == g->ended.end()) continue;
        v8::Local<v8::Function> f = it->second.Get(iso); g->ended.erase(it);
        v8::Local<v8::Value> argv[1] = {v8::Number::New(iso, h)};
        (void)f->Call(ctx, ctx->Global(), 1, argv);
      }
    });
  }
  (void)anyEnded;
}

}  // namespace host
