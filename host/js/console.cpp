#include "js/console.h"
#include "core/log.h"
#include "js/bind.h"
#include <map>
#include <chrono>
namespace host { std::string Engine_toString(v8::Isolate* iso, v8::Local<v8::Value> v); }

namespace host {
namespace {
std::function<void(int, const std::string&)> g_sink;
std::map<std::string, double> g_timers;
int g_group = 0;

std::string fmtArgs(const v8::FunctionCallbackInfo<v8::Value>& a, int from = 0) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); std::string out;
  for (int i = from; i < a.Length(); ++i) {
    if (i > from) out += ' ';
    v8::Local<v8::Value> v = a[i];
    if (v->IsString() || v->IsNumber() || v->IsBoolean() || v->IsNullOrUndefined() || v->IsSymbol()) out += bind::string(a, i);
    else if (v->IsNativeError() || (v->IsObject() && v.As<v8::Object>()->Has(ctx, bind::str(iso, "stack")).FromMaybe(false))) {
      v8::Local<v8::Value> st; if (v.As<v8::Object>()->Get(ctx, bind::str(iso, "stack")).ToLocal(&st) && st->IsString()) out += Engine_toString(iso, st); else out += bind::string(a, i);
    } else if (v->IsFunction()) { out += "[Function " + Engine_toString(iso, v.As<v8::Function>()->GetName()) + "]"; }
    else {
      v8::Local<v8::String> json; v8::TryCatch tc(iso);
      if (v8::JSON::Stringify(ctx, v).ToLocal(&json) && !json.IsEmpty()) { std::string s = Engine_toString(iso, json); if (s.size() > 2000) s = s.substr(0, 2000) + "…"; out += s; }
      else out += bind::string(a, i);
    }
  }
  return out;
}
void emit(int level, const std::string& msg) {
  std::string pad(g_group * 2, ' ');
  JS_LOG(level, "%s%s", pad.c_str(), msg.c_str());
  if (g_sink) g_sink(level, msg);
}
void logAt(const v8::FunctionCallbackInfo<v8::Value>& a, int level) { emit(level, fmtArgs(a)); }
}  // namespace

std::string Engine_toString(v8::Isolate* iso, v8::Local<v8::Value> v) { v8::String::Utf8Value s(iso, v); return s.length() ? std::string(*s, s.length()) : std::string(); }

void installConsole(v8::Local<v8::Context> ctx, std::function<void(int, const std::string&)> sink) {
  g_sink = std::move(sink);
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> c = v8::Object::New(iso);
  bind::fn(ctx, c, "log", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); });
  bind::fn(ctx, c, "info", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); });
  bind::fn(ctx, c, "debug", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_DEBUG); });
  bind::fn(ctx, c, "trace", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_DEBUG); });
  bind::fn(ctx, c, "warn", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_WARN); });
  bind::fn(ctx, c, "error", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_ERROR); });
  bind::fn(ctx, c, "assert", [](const v8::FunctionCallbackInfo<v8::Value>& a) { if (!bind::boolean(a, 0)) emit(ANDROID_LOG_ERROR, "Assertion failed: " + fmtArgs(a, 1)); });
  bind::fn(ctx, c, "table", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); });
  bind::fn(ctx, c, "dir", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); });
  bind::fn(ctx, c, "group", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); g_group++; });
  bind::fn(ctx, c, "groupCollapsed", [](const v8::FunctionCallbackInfo<v8::Value>& a) { logAt(a, ANDROID_LOG_INFO); g_group++; });
  bind::fn(ctx, c, "groupEnd", [](const v8::FunctionCallbackInfo<v8::Value>&) { if (g_group > 0) g_group--; });
  bind::fn(ctx, c, "count", [](const v8::FunctionCallbackInfo<v8::Value>& a) { static std::map<std::string, int> n; std::string k = a.Length() ? bind::string(a, 0) : "default"; emit(ANDROID_LOG_INFO, k + ": " + std::to_string(++n[k])); });
  bind::fn(ctx, c, "time", [](const v8::FunctionCallbackInfo<v8::Value>& a) { g_timers[a.Length() ? bind::string(a, 0) : "default"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); });
  auto timeEnd = [](const v8::FunctionCallbackInfo<v8::Value>& a) { std::string k = a.Length() ? bind::string(a, 0) : "default"; auto it = g_timers.find(k); if (it == g_timers.end()) return; double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count() - it->second; char b[64]; snprintf(b, sizeof b, ": %.3f ms", ms); emit(ANDROID_LOG_INFO, k + b); };
  bind::fn(ctx, c, "timeEnd", timeEnd); bind::fn(ctx, c, "timeLog", timeEnd);
  ctx->Global()->Set(ctx, bind::str(iso, "console"), c).Check();
}

}  // namespace host
