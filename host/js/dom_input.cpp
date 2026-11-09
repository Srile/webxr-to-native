#include "js/dom_input.h"
#include "js/bind.h"
#include "core/log.h"
#include "gl/touch_controls.h"
#include <cstring>
#include <mutex>

namespace host {
namespace dom {
namespace {

// The DOM `code` names the runtime can be told about, in the order JS indexes them (__native.input.codes).
const char* const kCodes[] = {
  "Unidentified",
  "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyM",
  "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter", "Escape", "Backspace", "Tab",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash",
  "CapsLock", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9", "NumpadEnter",
};
constexpr int kCodeCount = sizeof(kCodes) / sizeof(kCodes[0]);

constexpr int kStride = 12, kCap = 512;  // as runtime/src/dom-lite/input.js reads them
struct Rec { double v[kStride]; };
std::mutex g_mu;
Rec g_q[kCap]; int g_n = 0;
Pad g_pad;
double g_vp[10] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1}; int g_hidden = -1; bool g_accept = true;

void push(const Rec& r) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!g_accept) return;
  // A move replaces the move queued just before it for the same pointer: the page sees where it is, once a frame.
  if (r.v[0] == kMove && g_n > 0 && g_q[g_n - 1].v[0] == kMove && g_q[g_n - 1].v[1] == r.v[1]) { g_q[g_n - 1] = r; return; }
  if (g_n == kCap) return;  // a stalled page drops the newest input rather than growing
  g_q[g_n++] = r;
}

void inputRead(const v8::FunctionCallbackInfo<v8::Value>& a) {
  bind::Bytes b = a.Length() > 0 ? bind::bytes(a[0]) : bind::Bytes{};
  if (!b.ok || b.elem != sizeof(double)) { a.GetReturnValue().Set(0); return; }
  std::lock_guard<std::mutex> lock(g_mu);
  const int fit = (int)(b.len / sizeof(Rec)), n = g_n < fit ? g_n : fit;
  memcpy(b.data, g_q, n * sizeof(Rec));
  if (n < g_n) memmove(g_q, g_q + n, (g_n - n) * sizeof(Rec));
  g_n -= n;
  a.GetReturnValue().Set(n);
}

void inputPad(const v8::FunctionCallbackInfo<v8::Value>& a) {
  bind::Bytes b = a.Length() > 0 ? bind::bytes(a[0]) : bind::Bytes{};
  if (!b.ok || b.elem != sizeof(float) || b.len < 23 * sizeof(float)) { a.GetReturnValue().Set(false); return; }
  float* f = (float*)b.data;
  std::lock_guard<std::mutex> lock(g_mu);
  f[0] = g_pad.connected ? 1.f : 0.f; f[1] = (float)g_pad.timestamp;
  memcpy(f + 2, g_pad.axes, sizeof g_pad.axes); memcpy(f + 6, g_pad.buttons, sizeof g_pad.buttons);
  a.GetReturnValue().Set(g_pad.connected);
}

// controlsShown(bool): the page shows the touch controls or not (host.json touchControls.showWhen, the runtime's
// check of the page's own touch UI); they fade in and out (gl/touch_controls.h).
void inputControlsShown(const v8::FunctionCallbackInfo<v8::Value>& a) { touch::setWanted(bind::boolean(a, 0)); }
// stickFinger(id, x, y): a touch the page's joystick zone took (runtime input.js): the host draws its stick's knob.
void (*g_pointerLock)(bool) = nullptr;
void inputPointerLock(const v8::FunctionCallbackInfo<v8::Value>& a) { if (g_pointerLock) g_pointerLock(bind::boolean(a, 0)); a.GetReturnValue().Set(g_pointerLock != nullptr); }
void inputStickFinger(const v8::FunctionCallbackInfo<v8::Value>& a) { touch::stickFinger(bind::i32(a, 0), (float)bind::num(a, 1), (float)bind::num(a, 2)); }

// False when the runtime has not defined it yet (before the prelude ran): the caller tries again next frame.
bool callGlobal(v8::Isolate* iso, v8::Local<v8::Context> ctx, const char* name, int argc, v8::Local<v8::Value>* argv) {
  v8::HandleScope hs(iso); v8::Context::Scope cs(ctx); v8::TryCatch tc(iso);
  v8::Local<v8::Value> f;
  if (!ctx->Global()->Get(ctx, bind::str(iso, name)).ToLocal(&f) || !f->IsFunction()) return false;
  (void)f.As<v8::Function>()->Call(ctx, ctx->Global(), argc, argv);
  if (tc.HasCaught()) { v8::String::Utf8Value m(iso, tc.Exception()); HOST_LOGW("%s threw: %s", name, *m ? *m : "?"); }
  iso->PerformMicrotaskCheckpoint();
  return true;
}

}  // namespace

int codeIndex(const char* code) {
  if (!code) return 0;
  for (int i = 1; i < kCodeCount; ++i) if (!strcmp(kCodes[i], code)) return i;
  return 0;
}

void pointer(Type type, int id, double x, double y, int buttons, int button, PointerType ptype, float pressure, int mods) {
  push(Rec{{(double)type, (double)id, x, y, (double)buttons, (double)button, (double)ptype, (double)pressure, (double)mods, 0, 0, 0}});
}
void wheel(double x, double y, double dx, double dy, int mods) { push(Rec{{(double)kWheel, 0, x, y, 0, 0, 0, 0, (double)mods, 0, dx, dy}}); }
void key(bool down, const char* code, int mods) {
  const int c = codeIndex(code); if (!c) return;
  push(Rec{{(double)(down ? kKeyDown : kKeyUp), 0, 0, 0, 0, 0, 0, 0, (double)mods, (double)c, 0, 0}});
}
void setPad(const Pad& p) { std::lock_guard<std::mutex> lock(g_mu); g_pad = p; }
void setPointerLockHandler(void (*lock)(bool)) { g_pointerLock = lock; }
void setAccepting(bool on) { std::lock_guard<std::mutex> lock(g_mu); if (g_accept == on) return; g_accept = on; if (!on) g_n = 0; }

void install(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> in = bind::obj(ctx, native, "input");
  bind::fn(ctx, in, "read", inputRead); bind::fn(ctx, in, "pad", inputPad); bind::fn(ctx, in, "controlsShown", inputControlsShown); bind::fn(ctx, in, "stickFinger", inputStickFinger); bind::fn(ctx, in, "pointerLock", inputPointerLock);
  v8::Local<v8::Array> codes = v8::Array::New(iso, kCodeCount);
  for (int i = 0; i < kCodeCount; ++i) codes->Set(ctx, i, bind::str(iso, kCodes[i])).Check();
  bind::set(ctx, in, "codes", codes);
}

void setViewport(v8::Isolate* iso, v8::Local<v8::Context> ctx, double cssW, double cssH, double dpr, int fbW, int fbH, int angle, const float insets[4]) {
  const double v[10] = {cssW, cssH, dpr, (double)fbW, (double)fbH, (double)angle, insets ? insets[0] : 0., insets ? insets[1] : 0., insets ? insets[2] : 0., insets ? insets[3] : 0.};
  if (!memcmp(v, g_vp, sizeof v)) return;
  memcpy(g_vp, v, sizeof v);
  v8::HandleScope hs(iso);
  v8::Local<v8::Value> argv[10]; for (int i = 0; i < 10; ++i) argv[i] = v8::Number::New(iso, v[i]);
  if (!callGlobal(iso, ctx, "__hostSetViewport", 10, argv)) g_vp[0] = -1;
}

void setHidden(v8::Isolate* iso, v8::Local<v8::Context> ctx, bool hidden) {
  if (g_hidden == (int)hidden) return;
  g_hidden = hidden;
  v8::HandleScope hs(iso);
  v8::Local<v8::Value> argv[1] = {v8::Boolean::New(iso, hidden)};
  if (!callGlobal(iso, ctx, "__hostSetHidden", 1, argv)) g_hidden = -1;
}

}  // namespace dom
}  // namespace host
