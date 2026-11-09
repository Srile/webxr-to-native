#pragma once
// The few V8 API spots that moved between the Quest's V8 10.0 (npm v8-android-jit) and the experimental
// Mac host's Homebrew V8 (15.x, host/mac/). Everything else compiles unchanged against both.
#include <v8.h>
#include <v8-version.h>

namespace host {
// Context::GetIsolate is gone in V8 14: the isolate is the current one (the host thread keeps its isolate
// entered for life, Engine::create; every worker thread enters its own).
inline v8::Isolate* isolateOf(v8::Local<v8::Context> ctx) {
#if V8_MAJOR_VERSION >= 14
  (void)ctx; return v8::Isolate::GetCurrent();
#else
  return ctx->GetIsolate();
#endif
}

// v8::External carries a type tag from V8 14 (one tag for everything the host hands JS).
inline v8::Local<v8::External> newExternal(v8::Isolate* iso, void* p) {
#if V8_MAJOR_VERSION >= 14
  return v8::External::New(iso, p, v8::kExternalPointerTypeTagDefault);
#else
  return v8::External::New(iso, p);
#endif
}
inline void* externalValue(v8::Local<v8::Value> v) {
#if V8_MAJOR_VERSION >= 14
  return v.As<v8::External>()->Value(v8::kExternalPointerTypeTagDefault);
#else
  return v.As<v8::External>()->Value();
#endif
}

// The minor collector's GC type (a young-generation mark phase beside the scavenger) was renamed in V8 12.
#if V8_MAJOR_VERSION >= 12
constexpr v8::GCType kGCTypeMinor = v8::kGCTypeMinorMarkSweep;
#else
constexpr v8::GCType kGCTypeMinor = v8::kGCTypeMinorMarkCompact;
#endif
}  // namespace host

// ScriptOrigin's leading Isolate* went away in V8 12 (10.0 has both forms; the isolate-less one is deprecated).
#if V8_MAJOR_VERSION >= 12
#define HOST_SCRIPT_ORIGIN(iso, ...) v8::ScriptOrigin(__VA_ARGS__)
#else
#define HOST_SCRIPT_ORIGIN(iso, ...) v8::ScriptOrigin(iso, __VA_ARGS__)
#endif
