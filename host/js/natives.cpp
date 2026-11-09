#include "js/natives.h"
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/dom_input.h"
#include <v8-value-serializer.h>
#include <memory>

namespace host {
namespace {
HostServices* g_svc = nullptr;
v8::Global<v8::Function> g_flatFrame;

// A persistent callback kept alive for a timer or task.
struct Cb { v8::Global<v8::Function> fn; v8::Global<v8::Context> ctx; };
void callFn(v8::Isolate* iso, Cb* cb, int argc, v8::Local<v8::Value>* argv) {
  v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = cb->ctx.Get(iso); v8::Context::Scope cs(ctx);
  v8::TryCatch tc(iso); v8::Local<v8::Function> f = cb->fn.Get(iso);
  (void)f->Call(ctx, ctx->Global(), argc, argv);
  if (tc.HasCaught()) g_svc->engine->reportException(tc);
  iso->PerformMicrotaskCheckpoint();
}
std::shared_ptr<Cb> keep(v8::Isolate* iso, v8::Local<v8::Function> f) { auto c = std::make_shared<Cb>(); c->fn.Reset(iso, f); c->ctx.Reset(iso, iso->GetCurrentContext()); return c; }

v8::Local<v8::ArrayBuffer> toArrayBuffer(v8::Isolate* iso, const std::string& s) {
  auto store = v8::ArrayBuffer::NewBackingStore(iso, s.size()); if (s.size()) memcpy(store->Data(), s.data(), s.size());
  return v8::ArrayBuffer::New(iso, std::move(store));
}

// ---- loop ----
void loopNow(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->loop->now()); }
void loopSetTimer(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); if (a.Length() < 3 || !a[2]->IsFunction()) return bind::throwType(iso, "setTimer(ms, repeat, fn)");
  auto cb = keep(iso, a[2].As<v8::Function>()); uint32_t id = g_svc->loop->setTimer(bind::num(a, 0), bind::boolean(a, 1), [iso, cb] { callFn(iso, cb.get(), 0, nullptr); });
  a.GetReturnValue().Set(id);
}
void loopClearTimer(const v8::FunctionCallbackInfo<v8::Value>& a) { g_svc->loop->clearTimer(bind::u32(a, 0)); }
void loopPostTask(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); if (!a[0]->IsFunction()) return bind::throwType(iso, "postTask(fn)");
  auto cb = keep(iso, a[0].As<v8::Function>()); g_svc->loop->post([iso, cb] { callFn(iso, cb.get(), 0, nullptr); });
}
void loopOnFrame(const v8::FunctionCallbackInfo<v8::Value>& a) { if (a[0]->IsFunction()) g_flatFrame.Reset(a.GetIsolate(), a[0].As<v8::Function>()); else g_flatFrame.Reset(); }
void loopExit(const v8::FunctionCallbackInfo<v8::Value>&) { if (g_svc->requestExit) g_svc->requestExit(); }

// ---- assets ----
std::string wwwPath(const std::string& p) { std::string s = p; while (!s.empty() && s[0] == '/') s.erase(0, 1); return "www/" + s; }
void assetsRead(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::string data; if (!g_svc->assets->read(wwwPath(bind::string(a, 0)), data)) { a.GetReturnValue().SetNull(); return; }
  a.GetReturnValue().Set(toArrayBuffer(a.GetIsolate(), data));
}
void assetsReadText(const v8::FunctionCallbackInfo<v8::Value>& a) {
  std::string data; if (!g_svc->assets->read(wwwPath(bind::string(a, 0)), data)) { a.GetReturnValue().SetNull(); return; }
  a.GetReturnValue().Set(bind::str(a.GetIsolate(), data));
}
void assetsExists(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->assets->exists(wwwPath(bind::string(a, 0)))); }
void assetsMime(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(bind::str(a.GetIsolate(), Assets::mime(bind::string(a, 0)))); }

// ---- net ----
void netFetch(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (a.Length() < 5 || !a[4]->IsFunction()) return bind::throwType(iso, "fetch(method, url, headers, body, cb)");
  HttpRequest req; req.method = bind::string(a, 0); req.url = bind::string(a, 1);
  if (a[2]->IsArray()) { auto arr = a[2].As<v8::Array>(); for (uint32_t i = 0; i < arr->Length(); ++i) { v8::Local<v8::Value> kv; if (!arr->Get(ctx, i).ToLocal(&kv) || !kv->IsArray()) continue; auto p = kv.As<v8::Array>(); v8::Local<v8::Value> k, v; if (p->Get(ctx, 0).ToLocal(&k) && p->Get(ctx, 1).ToLocal(&v)) req.headers.push_back({Engine::toStdString(iso, k), Engine::toStdString(iso, v)}); } }
  if (a[3]->IsString()) req.body = Engine::toStdString(iso, a[3]); else { bind::Bytes b = bind::bytes(a[3]); if (b.ok) req.body.assign((const char*)b.data, b.len); }
  auto cb = keep(iso, a[4].As<v8::Function>());
  g_svc->http->request(std::move(req), [iso, cb](HttpResponse r) {
    v8::HandleScope hs(iso); v8::Local<v8::Context> c = cb->ctx.Get(iso); v8::Context::Scope cs(c);
    v8::Local<v8::Array> hdrs = v8::Array::New(iso, (int)r.headers.size());
    for (size_t i = 0; i < r.headers.size(); ++i) { v8::Local<v8::Array> p = v8::Array::New(iso, 2); p->Set(c, 0, bind::str(iso, r.headers[i].first)).Check(); p->Set(c, 1, bind::str(iso, r.headers[i].second)).Check(); hdrs->Set(c, (uint32_t)i, p).Check(); }
    v8::Local<v8::Value> argv[5] = { v8::Number::New(iso, r.status), bind::str(iso, r.statusText), hdrs, toArrayBuffer(iso, r.body), r.error.empty() ? v8::Local<v8::Value>(v8::Null(iso)) : v8::Local<v8::Value>(bind::str(iso, r.error)) };
    callFn(iso, cb.get(), 5, argv);
  });
}

// ---- store ----
void storeGet(const v8::FunctionCallbackInfo<v8::Value>& a) { std::string v; if (g_svc->store->get(bind::string(a, 0), v)) a.GetReturnValue().Set(bind::str(a.GetIsolate(), v)); else a.GetReturnValue().SetNull(); }
void storeSet(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(g_svc->store->set(bind::string(a, 0), bind::string(a, 1))); }
void storeRemove(const v8::FunctionCallbackInfo<v8::Value>& a) { g_svc->store->remove(bind::string(a, 0)); }
void storeClear(const v8::FunctionCallbackInfo<v8::Value>&) { g_svc->store->clear(); }
void storeLength(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set((uint32_t)g_svc->store->size()); }
void storeKey(const v8::FunctionCallbackInfo<v8::Value>& a) { uint32_t i = bind::u32(a, 0); if (i >= g_svc->store->size()) { a.GetReturnValue().SetNull(); return; } a.GetReturnValue().Set(bind::str(a.GetIsolate(), g_svc->store->key(i))); }

// ---- clone ----
struct CloneDelegate : public v8::ValueSerializer::Delegate {
  v8::Isolate* iso; explicit CloneDelegate(v8::Isolate* i) : iso(i) {}
  void ThrowDataCloneError(v8::Local<v8::String> message) override {
    v8::Local<v8::Context> ctx = iso->GetCurrentContext();
    v8::Local<v8::Object> err = v8::Exception::Error(message).As<v8::Object>();
    err->Set(ctx, bind::str(iso, "name"), bind::str(iso, "DataCloneError")).Check();
    iso->ThrowException(err);
  }
};
void nativeClone(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  CloneDelegate d(iso); v8::ValueSerializer ser(iso, &d); ser.WriteHeader();
  bool ok = false; if (!ser.WriteValue(ctx, a[0]).To(&ok) || !ok) return;
  std::pair<uint8_t*, size_t> buf = ser.Release();
  v8::ValueDeserializer de(iso, buf.first, buf.second); bool hdr = false;
  if (de.ReadHeader(ctx).To(&hdr) && hdr) { v8::Local<v8::Value> out; if (de.ReadValue(ctx).ToLocal(&out)) a.GetReturnValue().Set(out); }
  free(buf.first);
}
void nativeLog(const v8::FunctionCallbackInfo<v8::Value>& a) {
  int level = bind::i32(a, 0); std::string s = bind::string(a, 1);
  JS_LOG(level >= 3 ? ANDROID_LOG_ERROR : level == 2 ? ANDROID_LOG_WARN : level == 1 ? ANDROID_LOG_INFO : ANDROID_LOG_DEBUG, "%s", s.c_str());
}

v8::Local<v8::Value> jsonToV8(v8::Isolate* iso, v8::Local<v8::Context> ctx, const Json& j) {
  switch (j.type) {
    case Json::Null: return v8::Null(iso); case Json::Bool: return v8::Boolean::New(iso, j.b); case Json::Number: return v8::Number::New(iso, j.num);
    case Json::String: return bind::str(iso, j.str);
    case Json::Array: { v8::Local<v8::Array> a = v8::Array::New(iso, (int)j.arr.size()); for (size_t i = 0; i < j.arr.size(); ++i) a->Set(ctx, (uint32_t)i, jsonToV8(iso, ctx, j.arr[i])).Check(); return a; }
    case Json::Object: { v8::Local<v8::Object> o = v8::Object::New(iso); for (auto& kv : j.obj) o->Set(ctx, bind::str(iso, kv.first), jsonToV8(iso, ctx, kv.second)).Check(); return o; }
  }
  return v8::Undefined(iso);
}
}  // namespace

v8::Local<v8::Object> installNativeCore(v8::Local<v8::Context> ctx, HostServices& svc) {
  g_svc = &svc; v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> n = v8::Object::New(iso);
  v8::Local<v8::Object> loop = bind::obj(ctx, n, "loop");
  bind::fn(ctx, loop, "now", loopNow); bind::fn(ctx, loop, "setTimer", loopSetTimer); bind::fn(ctx, loop, "clearTimer", loopClearTimer);
  bind::fn(ctx, loop, "postTask", loopPostTask); bind::fn(ctx, loop, "onFrame", loopOnFrame); bind::fn(ctx, loop, "exit", loopExit);
  v8::Local<v8::Object> assets = bind::obj(ctx, n, "assets");
  bind::fn(ctx, assets, "read", assetsRead); bind::fn(ctx, assets, "readText", assetsReadText); bind::fn(ctx, assets, "exists", assetsExists); bind::fn(ctx, assets, "mime", assetsMime);
  v8::Local<v8::Object> net = bind::obj(ctx, n, "net"); bind::fn(ctx, net, "fetch", netFetch);
  v8::Local<v8::Object> store = bind::obj(ctx, n, "store");
  bind::fn(ctx, store, "get", storeGet); bind::fn(ctx, store, "set", storeSet); bind::fn(ctx, store, "remove", storeRemove); bind::fn(ctx, store, "clear", storeClear); bind::fn(ctx, store, "length", storeLength); bind::fn(ctx, store, "key", storeKey);
  bind::fn(ctx, n, "clone", nativeClone); bind::fn(ctx, n, "log", nativeLog);
  bind::set(ctx, n, "config", jsonToV8(iso, ctx, *svc.config));
  v8::Local<v8::Object> info = bind::obj(ctx, n, "info");
  bind::setStr(ctx, info, "version", "0.1.0"); bind::setStr(ctx, info, "systemName", svc.systemName); bind::setStr(ctx, info, "package", svc.packageName); bind::setStr(ctx, info, "filesDir", svc.filesDir);
  // A phone passes for Chrome on Android (the reduced user agent Chrome sends); everything else for Quest Browser.
  bind::setStr(ctx, info, "userAgent", svc.formFactor == "phone"
    ? "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 webxr-host/0.1"
    : "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 VR Safari/537.36 OculusBrowser/40.0 webxr-host/0.1");
  bind::setStr(ctx, info, "formFactor", svc.formFactor); bind::setBool(ctx, info, "flatScaled", svc.flatScaled);
  if (svc.pageInput) dom::install(ctx, n);
  bind::setStr(ctx, info, "v8", v8::V8::GetVersion());
  ctx->Global()->Set(ctx, bind::str(iso, "__native"), n).Check();
  return n;
}

void nativeFlatFrame(v8::Isolate* iso, v8::Local<v8::Context> ctx, double timeMs) {
  if (g_flatFrame.IsEmpty()) return;
  v8::HandleScope hs(iso); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
  v8::Local<v8::Value> argv[1] = {v8::Number::New(iso, timeMs)};
  (void)g_flatFrame.Get(iso)->Call(ctx, ctx->Global(), 1, argv);
  if (tc.HasCaught()) g_svc->engine->reportException(tc);
  iso->PerformMicrotaskCheckpoint();
}

}  // namespace host
