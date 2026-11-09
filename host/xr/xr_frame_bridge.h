#pragma once
// Host → prelude per-frame dispatch (implemented in js/xr_bind.cpp).
#include <v8.h>
namespace host {
struct XrFrameInfo;
bool xrHasFrameCallback();
void xrDispatchFrame(v8::Isolate* iso, v8::Local<v8::Context> ctx, const XrFrameInfo& f, bool baseIsStage);
void xrDispatchEvent(v8::Isolate* iso, v8::Local<v8::Context> ctx, const char* type, double a, double b);
}
