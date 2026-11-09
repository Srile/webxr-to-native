#pragma once
// Small helpers for defining native functions on JS objects and reading args.
#include <string>
#include <v8.h>
#include "js/v8compat.h"

namespace host {
namespace bind {

inline v8::Local<v8::String> str(v8::Isolate* iso, const char* s) { return v8::String::NewFromUtf8(iso, s).ToLocalChecked(); }
inline v8::Local<v8::String> str(v8::Isolate* iso, const std::string& s) { return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, (int)s.size()).ToLocalChecked(); }

inline void fn(v8::Local<v8::Context> ctx, v8::Local<v8::Object> obj, const char* name, v8::FunctionCallback cb, v8::Local<v8::Value> data = {}) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Function> f = v8::Function::New(ctx, cb, data).ToLocalChecked();
  f->SetName(str(iso, name));
  obj->Set(ctx, str(iso, name), f).Check();
}
inline v8::Local<v8::Object> obj(v8::Local<v8::Context> ctx, v8::Local<v8::Object> parent, const char* name) {
  v8::Isolate* iso = isolateOf(ctx); v8::Local<v8::Object> o = v8::Object::New(iso);
  parent->Set(ctx, str(iso, name), o).Check(); return o;
}
inline void set(v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, v8::Local<v8::Value> v) { o->Set(ctx, str(isolateOf(ctx), k), v).Check(); }
inline void setNum(v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, double v) { set(ctx, o, k, v8::Number::New(isolateOf(ctx), v)); }
inline void setStr(v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, const std::string& v) { set(ctx, o, k, str(isolateOf(ctx), v)); }
inline void setBool(v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, bool v) { set(ctx, o, k, v8::Boolean::New(isolateOf(ctx), v)); }

inline void throwType(v8::Isolate* iso, const char* msg) { iso->ThrowException(v8::Exception::TypeError(str(iso, msg))); }
inline void throwError(v8::Isolate* iso, const std::string& msg) { iso->ThrowException(v8::Exception::Error(str(iso, msg))); }

inline double num(const v8::FunctionCallbackInfo<v8::Value>& a, int i, double d = 0) { return i < a.Length() && a[i]->IsNumber() ? a[i].As<v8::Number>()->Value() : d; }
inline int32_t i32(const v8::FunctionCallbackInfo<v8::Value>& a, int i, int32_t d = 0) { return i < a.Length() ? a[i]->Int32Value(a.GetIsolate()->GetCurrentContext()).FromMaybe(d) : d; }
inline uint32_t u32(const v8::FunctionCallbackInfo<v8::Value>& a, int i, uint32_t d = 0) { return i < a.Length() ? a[i]->Uint32Value(a.GetIsolate()->GetCurrentContext()).FromMaybe(d) : d; }
inline bool boolean(const v8::FunctionCallbackInfo<v8::Value>& a, int i, bool d = false) { return i < a.Length() ? a[i]->BooleanValue(a.GetIsolate()) : d; }
inline std::string string(const v8::FunctionCallbackInfo<v8::Value>& a, int i) { if (i >= a.Length() || a[i]->IsNullOrUndefined()) return {}; v8::String::Utf8Value s(a.GetIsolate(), a[i]); return s.length() ? std::string(*s, s.length()) : std::string(); }

// A view over an ArrayBuffer / ArrayBufferView argument: pointer + byte length (+ element size), no copy.
struct Bytes { uint8_t* data = nullptr; size_t len = 0; size_t elem = 1; bool ok = false; };
inline Bytes bytes(v8::Local<v8::Value> v) {
  Bytes b;
  if (v->IsArrayBufferView()) {
    auto view = v.As<v8::ArrayBufferView>(); auto store = view->Buffer()->GetBackingStore();
    b.data = (uint8_t*)store->Data() + view->ByteOffset(); b.len = view->ByteLength(); b.ok = true;
    if (v->IsTypedArray()) { size_t n = v.As<v8::TypedArray>()->Length(); b.elem = n ? b.len / n : 1; }
  } else if (v->IsArrayBuffer()) {
    auto store = v.As<v8::ArrayBuffer>()->GetBackingStore(); b.data = (uint8_t*)store->Data(); b.len = store->ByteLength(); b.ok = true;
  }
  return b;
}

}  // namespace bind
}  // namespace host
