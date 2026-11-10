// WP-06: Web Workers — one V8 isolate per worker on its own thread, its own
// Loop, messages as ValueSerializer buffers (`__native.worker`; runtime/src/workers/index.js).
#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
#endif
#include "js/natives.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/gc.h"
#include "js/console.h"
#include "js/intl.h"
#include "core/log.h"
#include "core/fs.h"
#include <v8-value-serializer.h>
#include <atomic>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

namespace host {
namespace {
HostServices* g_svc = nullptr;
v8::Global<v8::Function> g_onMessage, g_onError;

struct Msg { std::vector<uint8_t> bytes; std::vector<std::shared_ptr<v8::BackingStore>> transfers; };

// Serialize `v` (with transferables) into a Msg. Shared between host and worker isolates.
bool serialize(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Value> v, v8::Local<v8::Value> transferList, Msg& out) {
  struct D : v8::ValueSerializer::Delegate { v8::Isolate* iso; std::vector<std::shared_ptr<v8::BackingStore>>* stores; std::vector<v8::Local<v8::ArrayBuffer>> tl;
    void ThrowDataCloneError(v8::Local<v8::String> m) override { auto e = v8::Exception::Error(m).As<v8::Object>(); e->Set(iso->GetCurrentContext(), bind::str(iso, "name"), bind::str(iso, "DataCloneError")).Check(); iso->ThrowException(e); }
    v8::Maybe<uint32_t> GetSharedArrayBufferId(v8::Isolate*, v8::Local<v8::SharedArrayBuffer>) override { ThrowDataCloneError(bind::str(iso, "SharedArrayBuffer cannot be transferred")); return v8::Nothing<uint32_t>(); } };
  D d; d.iso = iso; d.stores = &out.transfers;
  v8::ValueSerializer ser(iso, &d); ser.WriteHeader();
  if (transferList->IsArray()) { auto arr = transferList.As<v8::Array>(); for (uint32_t i = 0; i < arr->Length(); ++i) { v8::Local<v8::Value> t; if (arr->Get(ctx, i).ToLocal(&t) && t->IsArrayBuffer()) { auto ab = t.As<v8::ArrayBuffer>(); ser.TransferArrayBuffer((uint32_t)d.tl.size(), ab); d.tl.push_back(ab); } } }
  bool ok = false; if (!ser.WriteValue(ctx, v).To(&ok) || !ok) return false;
  for (auto& ab : d.tl) { out.transfers.push_back(ab->GetBackingStore()); if (ab->IsDetachable()) ab->Detach(); }
  auto pair = ser.Release(); out.bytes.assign(pair.first, pair.first + pair.second); free(pair.first); return true;
}
v8::MaybeLocal<v8::Value> deserialize(v8::Isolate* iso, v8::Local<v8::Context> ctx, Msg& m) {
  v8::ValueDeserializer de(iso, m.bytes.data(), m.bytes.size());
  for (size_t i = 0; i < m.transfers.size(); ++i) de.TransferArrayBuffer((uint32_t)i, v8::ArrayBuffer::New(iso, m.transfers[i]));
  bool hdr = false; if (!de.ReadHeader(ctx).To(&hdr) || !hdr) return {};
  return de.ReadValue(ctx);
}

struct Worker {
  int id; std::string source, url; bool isModule;
  // spawn's options (a worker flavour built on the prelude, WP-27's service worker): the prelude asset that runs
  // before the script (default host-worker.js) and a structured-clone value it finds as __native.init.
  std::string prelude = "host-worker.js"; Msg init; bool hasInit = false;
  std::thread thread; std::atomic<bool> stop{false};
  std::mutex mu; std::vector<Msg> inbox;  // host → worker
  v8::Isolate* iso = nullptr;
  Loop loop;
  void run();
};
std::map<int, std::unique_ptr<Worker>> g_workers; int g_nextId = 1;

// Host-side delivery
void deliverToHost(int id, Msg m) {
  auto shared = std::make_shared<Msg>(std::move(m));
  g_svc->loop->post([id, shared] {
    if (g_onMessage.IsEmpty()) return; v8::Isolate* iso = g_svc->engine->isolate(); v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = g_svc->engine->context(); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
    v8::Local<v8::Value> v; if (!deserialize(iso, ctx, *shared).ToLocal(&v)) { HOST_LOGE("worker %d: deserialize failed", id); return; }
    v8::Local<v8::Value> argv[2] = {v8::Number::New(iso, id), v}; (void)g_onMessage.Get(iso)->Call(ctx, ctx->Global(), 2, argv);
    if (tc.HasCaught()) g_svc->engine->reportException(tc); iso->PerformMicrotaskCheckpoint();
  });
}
void errorToHost(int id, std::string msg) {
  g_svc->loop->post([id, msg] {
    JS_LOG(ANDROID_LOG_ERROR, "worker %d: %s", id, msg.c_str());
    if (g_onError.IsEmpty()) return; v8::Isolate* iso = g_svc->engine->isolate(); v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = g_svc->engine->context(); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
    v8::Local<v8::Value> argv[2] = {v8::Number::New(iso, id), bind::str(iso, msg)}; (void)g_onError.Get(iso)->Call(ctx, ctx->Global(), 2, argv); iso->PerformMicrotaskCheckpoint();
  });
}

// ---- module loading inside a worker: specifiers resolve against the worker's own URL, sources come from assets ----
struct WorkerModules { std::vector<std::pair<std::string, v8::Global<v8::Module>>> mods; std::string origin; };
thread_local WorkerModules* t_mods = nullptr;
std::string resolveUrl(const std::string& spec, const std::string& ref) {
  if (spec.rfind("https://", 0) == 0 || spec.rfind("http://", 0) == 0 || spec.rfind("blob:", 0) == 0) return spec;
  std::string base = ref.substr(0, ref.find_first_of("?#"));
  std::string joined; if (spec[0] == '/') { size_t s = base.find("://"); size_t h = base.find('/', s == std::string::npos ? 0 : s + 3); joined = (h == std::string::npos ? base : base.substr(0, h)) + spec; } else joined = base.substr(0, base.rfind('/') + 1) + spec;
  size_t s = joined.find("://"); size_t ps = joined.find('/', s == std::string::npos ? 0 : s + 3); if (ps == std::string::npos) return joined;
  std::string auth = joined.substr(0, ps), path = joined.substr(ps); std::vector<std::string> segs; size_t i = 1;
  while (i <= path.size()) { size_t j = path.find('/', i); std::string seg = path.substr(i, (j == std::string::npos ? path.size() : j) - i); if (seg == "..") { if (!segs.empty()) segs.pop_back(); } else if (seg != "." && !(seg.empty() && j != std::string::npos)) segs.push_back(seg); if (j == std::string::npos) break; i = j + 1; }
  std::string out = auth; for (auto& g : segs) out += "/" + g; return out;
}
v8::MaybeLocal<v8::Module> workerLoadModule(v8::Isolate* iso, v8::Local<v8::Context> ctx, const std::string& url, const std::string* inlineSource) {
  for (auto& e : t_mods->mods) if (e.first == url) return e.second.Get(iso);
  std::string src;
  if (inlineSource) src = *inlineSource;
  else { std::string p = url; if (p.rfind(t_mods->origin, 0) == 0) p = p.substr(t_mods->origin.size()); p = p.substr(0, p.find_first_of("?#")); while (!p.empty() && p[0] == '/') p.erase(0, 1);
    if (!g_svc->assets->read("www/" + p, src)) { bind::throwError(iso, "worker module not found: " + url); return {}; } }
  v8::ScriptOrigin o = HOST_SCRIPT_ORIGIN(iso, bind::str(iso, url), 0, 0, false, -1, v8::Local<v8::Value>(), false, false, true); v8::ScriptCompiler::Source s(bind::str(iso, src), o); v8::Local<v8::Module> m;
  if (!v8::ScriptCompiler::CompileModule(iso, &s).ToLocal(&m)) return {};
  t_mods->mods.emplace_back(url, v8::Global<v8::Module>(iso, m)); return m;
}
v8::MaybeLocal<v8::Module> workerResolve(v8::Local<v8::Context> ctx, v8::Local<v8::String> spec, v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) {
  v8::Isolate* iso = isolateOf(ctx); std::string ref = t_mods->origin + "/";
  for (auto& e : t_mods->mods) if (e.second.Get(iso) == referrer) { ref = e.first; break; }
  return workerLoadModule(iso, ctx, resolveUrl(Engine::toStdString(iso, spec), ref), nullptr);
}

// ---- worker-global natives (installed in the worker isolate) ----
struct WorkerCtx { Worker* w; v8::Global<v8::Function> onmessage; v8::Global<v8::Context> ctx; };
void wPostMessage(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto* wc = (WorkerCtx*)externalValue(a.Data()); v8::Isolate* iso = a.GetIsolate(); Msg m;
  if (!serialize(iso, iso->GetCurrentContext(), a[0], a.Length() > 1 ? a[1] : v8::Local<v8::Value>(v8::Undefined(iso)), m)) return;
  deliverToHost(wc->w->id, std::move(m));
}
void wOnMessage(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* wc = (WorkerCtx*)externalValue(a.Data()); if (a[0]->IsFunction()) wc->onmessage.Reset(a.GetIsolate(), a[0].As<v8::Function>()); }
void wSetTimer(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto* wc = (WorkerCtx*)externalValue(a.Data()); v8::Isolate* iso = a.GetIsolate(); if (!a[2]->IsFunction()) return bind::throwType(iso, "setTimer(ms, repeat, fn)");
  auto fn = std::make_shared<v8::Global<v8::Function>>(iso, a[2].As<v8::Function>());
  uint32_t id = wc->w->loop.setTimer(bind::num(a, 0), bind::boolean(a, 1), [iso, fn, wc] { v8::HandleScope hs(iso); v8::Local<v8::Context> c = wc->ctx.Get(iso); v8::Context::Scope cs(c); v8::TryCatch tc(iso); (void)fn->Get(iso)->Call(c, c->Global(), 0, nullptr); if (tc.HasCaught() && !tc.HasTerminated()) errorToHost(wc->w->id, Engine::toStdString(iso, tc.Exception())); iso->PerformMicrotaskCheckpoint(); });
  a.GetReturnValue().Set(id);
}
void wClearTimer(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* wc = (WorkerCtx*)externalValue(a.Data()); wc->w->loop.clearTimer(bind::u32(a, 0)); }
void wNow(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->loop->now()); }
void wLog(const v8::FunctionCallbackInfo<v8::Value>& a) { std::string s = bind::string(a, 1); int l = bind::i32(a, 0); JS_LOG(l >= 3 ? ANDROID_LOG_ERROR : l == 2 ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, "[worker] %s", s.c_str()); }
void wAssetRead(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::string p = bind::string(a, 0); while (!p.empty() && p[0] == '/') p.erase(0, 1); std::string data;
  if (!g_svc->assets->read("www/" + p, data)) { a.GetReturnValue().SetNull(); return; }
  auto store = v8::ArrayBuffer::NewBackingStore(a.GetIsolate(), data.size()); memcpy(store->Data(), data.data(), data.size()); a.GetReturnValue().Set(v8::ArrayBuffer::New(a.GetIsolate(), std::move(store)));
}
void wAssetMime(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(bind::str(a.GetIsolate(), Assets::mime(bind::string(a, 0)))); }
void wClose(const v8::FunctionCallbackInfo<v8::Value>& a) { auto* wc = (WorkerCtx*)externalValue(a.Data()); wc->w->stop = true; }
void wFetch(const v8::FunctionCallbackInfo<v8::Value>& a) {
  // Workers fetch over the host http pool; the reply hops back through the worker's loop.
  auto* wc = (WorkerCtx*)externalValue(a.Data()); v8::Isolate* iso = a.GetIsolate(); if (!a[4]->IsFunction()) return bind::throwType(iso, "fetch(method,url,headers,body,cb)");
  HttpRequest req; req.method = bind::string(a, 0); req.url = bind::string(a, 1); if (a[3]->IsString()) req.body = bind::string(a, 3); else { auto b = bind::bytes(a[3]); if (b.ok) req.body.assign((const char*)b.data, b.len); }
  auto fn = std::make_shared<v8::Global<v8::Function>>(iso, a[4].As<v8::Function>()); Worker* w = wc->w;
  g_svc->http->request(std::move(req), [iso, fn, wc, w](HttpResponse r) { auto rr = std::make_shared<HttpResponse>(std::move(r)); w->loop.post([iso, fn, wc, rr] {
    v8::HandleScope hs(iso); v8::Local<v8::Context> c = wc->ctx.Get(iso); v8::Context::Scope cs(c); v8::TryCatch tc(iso);
    auto store = v8::ArrayBuffer::NewBackingStore(iso, rr->body.size()); memcpy(store->Data(), rr->body.data(), rr->body.size());
    v8::Local<v8::Array> hdrs = v8::Array::New(iso, (int)rr->headers.size()); for (size_t i = 0; i < rr->headers.size(); ++i) { auto p = v8::Array::New(iso, 2); p->Set(c, 0, bind::str(iso, rr->headers[i].first)).Check(); p->Set(c, 1, bind::str(iso, rr->headers[i].second)).Check(); hdrs->Set(c, (uint32_t)i, p).Check(); }
    v8::Local<v8::Value> argv[5] = {v8::Number::New(iso, rr->status), bind::str(iso, rr->statusText), hdrs, v8::ArrayBuffer::New(iso, std::move(store)), rr->error.empty() ? v8::Local<v8::Value>(v8::Null(iso)) : v8::Local<v8::Value>(bind::str(iso, rr->error))};
    (void)fn->Get(iso)->Call(c, c->Global(), 5, argv); if (tc.HasCaught()) errorToHost(wc->w->id, Engine::toStdString(iso, tc.Exception())); iso->PerformMicrotaskCheckpoint(); }); });
}

void Worker::run() {
  { char name[16]; snprintf(name, sizeof name, "js-worker-%d", id);
#if defined(_WIN32)
    wchar_t wname[16]; for (int i = 0; i < 16; ++i) wname[i] = (wchar_t)name[i];
    SetThreadDescription(GetCurrentThread(), wname);
#elif defined(__APPLE__)
    pthread_setname_np(name);  // macOS names only the calling thread
#else
    pthread_setname_np(pthread_self(), name);
#endif
  }
  v8::Isolate::CreateParams params; params.array_buffer_allocator = Engine::sharedAllocator();
  iso = v8::Isolate::New(params); iso->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  WorkerCtx wc; wc.w = this;
  WorkerModules mods; mods.origin = g_svc->config->at("web").s("origin", "https://app.local"); while (!mods.origin.empty() && mods.origin.back() == '/') mods.origin.pop_back(); t_mods = &mods;
  {
    v8::Isolate::Scope is(iso); v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = v8::Context::New(iso); v8::Context::Scope cs(ctx); wc.ctx.Reset(iso, ctx);
    (void)ctx->Global()->Delete(ctx, v8::String::NewFromUtf8Literal(iso, GcScheduler::kGcGlobal));  // --expose-gc-as is process-wide (js/gc.h)
    iso->AddMessageListener([](v8::Local<v8::Message> msg, v8::Local<v8::Value>) { v8::Isolate* i = v8::Isolate::GetCurrent(); v8::HandleScope h(i); JS_LOG(ANDROID_LOG_ERROR, "[worker] uncaught %s (%s:%d)", Engine::toStdString(i, msg->Get()).c_str(), Engine::toStdString(i, msg->GetScriptResourceName()).c_str(), msg->GetLineNumber(i->GetCurrentContext()).FromMaybe(0)); });
    installConsole(ctx, nullptr);
    v8::Local<v8::External> ext = newExternal(iso, &wc);
    v8::Local<v8::Object> n = v8::Object::New(iso);
    bind::fn(ctx, n, "postMessage", wPostMessage, ext); bind::fn(ctx, n, "onMessage", wOnMessage, ext); bind::fn(ctx, n, "setTimer", wSetTimer, ext); bind::fn(ctx, n, "clearTimer", wClearTimer, ext);
    bind::fn(ctx, n, "now", wNow); bind::fn(ctx, n, "log", wLog); bind::fn(ctx, n, "assetRead", wAssetRead); bind::fn(ctx, n, "assetMime", wAssetMime); bind::fn(ctx, n, "close", wClose, ext); bind::fn(ctx, n, "fetch", wFetch, ext);
    bind::setStr(ctx, n, "url", url); bind::setStr(ctx, n, "origin", g_svc->config->at("web").s("origin", "https://app.local")); bind::setStr(ctx, n, "userAgent", "webxr-host worker");
    if (hasInit) { v8::Local<v8::Value> v; if (deserialize(iso, ctx, init).ToLocal(&v)) bind::set(ctx, n, "init", v); init = Msg(); }
    installWasmInterp(ctx, n, *g_svc);
#ifdef HOST_V8_INTL
    intl::install(ctx, n);  // the locale navigator.language names (host.json js.intl)
#endif
#ifdef HOST_HAS_STORAGE
    installStorage(ctx, n, *g_svc);  // IndexedDB + Cache API in workers too (WP-26; nothing unless host.json storage asks)
#endif
    ctx->Global()->Set(ctx, bind::str(iso, "__native"), n).Check();
    // The worker prelude (bundled into assets/host-worker.js by runtime/build.mjs, or the flavour spawn named) then the user script.
    std::string preludeSrc; if (!g_svc->assets->read(prelude, preludeSrc)) HOST_LOGW("assets/%s missing", prelude.c_str());
    v8::TryCatch tc(iso);
    auto runClassic = [&](const std::string& src, const std::string& name) { v8::ScriptOrigin o = HOST_SCRIPT_ORIGIN(iso, bind::str(iso, name)); v8::Local<v8::Script> s; if (v8::Script::Compile(ctx, bind::str(iso, src), &o).ToLocal(&s)) (void)s->Run(ctx); };
    if (!preludeSrc.empty()) runClassic(preludeSrc, prelude);
    // Module workers read import.meta.url (Havok locates its wasm beside the worker script).
    iso->SetHostInitializeImportMetaObjectCallback([](v8::Local<v8::Context> ctx, v8::Local<v8::Module> m, v8::Local<v8::Object> meta) {
      v8::Isolate* i = isolateOf(ctx); std::string found = t_mods ? t_mods->origin + "/" : "";
      if (t_mods) for (auto& e : t_mods->mods) if (e.second.Get(i) == m) { found = e.first; break; }
      bind::setStr(ctx, meta, "url", found); bind::set(ctx, meta, "env", v8::Object::New(i));
    });
    if (isModule) {
      v8::Local<v8::Module> m; v8::Local<v8::Value> done;
      if (workerLoadModule(iso, ctx, url, &source).ToLocal(&m) && m->InstantiateModule(ctx, workerResolve).FromMaybe(false) && m->Evaluate(ctx).ToLocal(&done) && done->IsPromise()) {
        // A module's evaluation error rejects the promise Evaluate returns instead of throwing: report it as a classic script's.
        iso->PerformMicrotaskCheckpoint(); auto p = done.As<v8::Promise>();
        if (p->State() == v8::Promise::kRejected) errorToHost(id, Engine::toStdString(iso, p->Result()));
      }
    } else runClassic(source, url);
    if (tc.HasCaught()) errorToHost(id, Engine::toStdString(iso, tc.Exception()));
    iso->PerformMicrotaskCheckpoint();
    while (!stop) {
      std::vector<Msg> in; { std::lock_guard<std::mutex> g(mu); in.swap(inbox); }
      for (auto& m : in) {
        if (wc.onmessage.IsEmpty()) continue; v8::HandleScope h2(iso); v8::TryCatch t2(iso); v8::Local<v8::Value> v;
        if (deserialize(iso, ctx, m).ToLocal(&v)) { v8::Local<v8::Value> argv[1] = {v}; (void)wc.onmessage.Get(iso)->Call(ctx, ctx->Global(), 1, argv); }
        if (t2.HasCaught()) errorToHost(id, Engine::toStdString(iso, t2.Exception())); iso->PerformMicrotaskCheckpoint();
      }
      double next = loop.runOnce(); iso->PerformMicrotaskCheckpoint();
      while (v8::platform::PumpMessageLoop(Engine::platform(), iso, v8::platform::MessageLoopBehavior::kDoNotWait)) {}
      bool more; { std::lock_guard<std::mutex> g(mu); more = !inbox.empty(); }
      if (!more && !stop) { double wait = next < 0 ? 2 : std::min(next, 2.0); std::this_thread::sleep_for(std::chrono::microseconds((int)(wait * 1000))); }
    }
    uninstallWasmInterp();  // its wasm instances and modules (the isolate still up: their handles reset here)
    wc.onmessage.Reset(); wc.ctx.Reset(); mods.mods.clear(); t_mods = nullptr;
  }
  iso->Dispose(); iso = nullptr;
}

// ---- host-side __native.worker ----
constexpr size_t kMaxWorkers = 64;  // each isolate reserves a 4 GB pointer cage; a runaway spawn loop must fail loudly, not abort in Isolate::New
void spawn(const v8::FunctionCallbackInfo<v8::Value>& a) {
  if (g_workers.size() >= kMaxWorkers) { HOST_LOGE("worker spawn refused: %zu live workers", g_workers.size()); return bind::throwType(a.GetIsolate(), "Worker: too many live workers"); }
  auto w = std::make_unique<Worker>(); w->id = g_nextId++; w->source = bind::string(a, 0); w->url = bind::string(a, 1); w->isModule = bind::boolean(a, 2);
  if (a.Length() > 3 && a[3]->IsObject()) {  // spawn(source, url, isModule, {prelude, init})
    v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); auto o = a[3].As<v8::Object>(); v8::Local<v8::Value> v;
    if (o->Get(ctx, bind::str(iso, "prelude")).ToLocal(&v) && v->IsString()) {
      std::string p = Engine::toStdString(iso, v);  // one of the runtime's own bundles at the assets root, nothing else
      if (p.rfind("host-", 0) != 0 || p.size() < 9 || p.compare(p.size() - 3, 3, ".js") != 0 || p.find_first_of("/\\") != std::string::npos) return bind::throwType(iso, "Worker: bad prelude");
      w->prelude = p;
    }
    if (o->Get(ctx, bind::str(iso, "init")).ToLocal(&v) && !v->IsUndefined()) { if (!serialize(iso, ctx, v, v8::Undefined(iso), w->init)) return; w->hasInit = true; }
  }
  Worker* raw = w.get(); raw->thread = std::thread([raw] { raw->run(); });
  int id = w->id; g_workers[id] = std::move(w); a.GetReturnValue().Set(id); HOST_LOGI("worker %d spawned (%s, %zu bytes)", id, raw->url.c_str(), raw->source.size());
}
void post(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto it = g_workers.find(bind::i32(a, 0)); if (it == g_workers.end()) return;
  v8::Isolate* iso = a.GetIsolate(); Msg m; if (!serialize(iso, iso->GetCurrentContext(), a[1], a.Length() > 2 ? a[2] : v8::Local<v8::Value>(v8::Undefined(iso)), m)) return;
  std::lock_guard<std::mutex> g(it->second->mu); it->second->inbox.push_back(std::move(m));
}
void terminate(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto it = g_workers.find(bind::i32(a, 0)); if (it == g_workers.end()) return;
  Worker* w = it->second.get(); w->stop = true; if (w->iso) w->iso->TerminateExecution(); if (w->thread.joinable()) w->thread.join(); g_workers.erase(it);
}
void onMessage(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_onMessage.Reset(a.GetIsolate(), a[0].As<v8::Function>()); }
void onError(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_onError.Reset(a.GetIsolate(), a[0].As<v8::Function>()); }

// ---- __native.worker.registry (WP-27, host.json web.serviceWorker): the service-worker registrations, one small JSON
// file in the app's files dir that the runtime reads at start and rewrites when a registration changes (never per frame).
std::string registryPath() { return g_svc->filesDir + "/service-workers.json"; }
void registryLoad(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::ifstream f(fsPath(registryPath()), std::ios::binary); if (!f) { a.GetReturnValue().SetNull(); return; }
  std::stringstream ss; ss << f.rdbuf(); a.GetReturnValue().Set(bind::str(a.GetIsolate(), ss.str()));
}
void registrySave(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::string text = bind::string(a, 0), path = registryPath(), tmp = path + ".tmp";
  { std::ofstream f(fsPath(tmp), std::ios::binary | std::ios::trunc); f << text; if (!f) { HOST_LOGW("service workers: cannot write %s", tmp.c_str()); a.GetReturnValue().Set(false); return; } }
  std::error_code ec; std::filesystem::rename(fsPath(tmp), fsPath(path), ec);  // replaces the old file atomically
  if (ec) HOST_LOGW("service workers: save failed: %s", ec.message().c_str());
  a.GetReturnValue().Set(!ec);
}
}  // namespace

void shutdownWorkers() {
  for (auto& [id, w] : g_workers) { w->stop = true; if (w->iso) w->iso->TerminateExecution(); }
  for (auto& [id, w] : g_workers) if (w->thread.joinable()) w->thread.join();
  g_workers.clear(); g_onMessage.Reset(); g_onError.Reset();
}

void installWorkers(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  g_svc = &svc; v8::Local<v8::Object> w = bind::obj(ctx, native, "worker");
  bind::fn(ctx, w, "spawn", spawn); bind::fn(ctx, w, "post", post); bind::fn(ctx, w, "terminate", terminate); bind::fn(ctx, w, "onMessage", onMessage); bind::fn(ctx, w, "onError", onError);
  if (svc.config->at("web").bo("serviceWorker", false)) { v8::Local<v8::Object> r = bind::obj(ctx, w, "registry"); bind::fn(ctx, r, "load", registryLoad); bind::fn(ctx, r, "save", registrySave); }
}

}  // namespace host
