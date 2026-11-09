#pragma once
// Page input outside XR (WP-20): the platform's pointers, wheel and keys queued here as fixed records and drained
// by the runtime once per flat frame (runtime/src/dom-lite/input.js turns them into DOM events), the touch
// controls' gamepad state, and the window facts the page reads (viewport, visibility). Pushing is thread-safe
// (iOS and Android deliver input on the thread that runs the loop, GLFW too, but nothing here relies on that).
#include <v8.h>

namespace host {
struct HostServices;
namespace dom {

enum Type { kDown = 1, kMove = 2, kUp = 3, kCancel = 4, kWheel = 5, kKeyDown = 6, kKeyUp = 7, kLeave = 8 };
enum PointerType { kMouse = 0, kTouch = 1, kPen = 2 };
enum Mods { kShift = 1, kCtrl = 2, kAlt = 4, kMeta = 8, kRepeat = 16 };

// x, y in CSS pixels from the window's top left. buttons: the DOM bitmask held after the event; button: the one that
// changed (0 primary, 1 middle, 2 secondary). A move for an id replaces the queued move before it.
void pointer(Type type, int id, double x, double y, int buttons, int button, PointerType ptype, float pressure, int mods);
void wheel(double x, double y, double dx, double dy, int mods);
// `code`: the DOM code name ("KeyA", "ArrowUp"); unknown names are dropped.
void key(bool down, const char* code, int mods);
int codeIndex(const char* code);  // its index in the table JS reads (__native.input.codes); 0: none

// The touch controls' gamepad (gl/touch_controls.h writes it each frame): standard mapping, 4 axes, 17 buttons.
struct Pad { bool connected = false; double timestamp = 0; float axes[4] = {}; float buttons[17] = {}; };
void setPad(const Pad& p);
// Off while an XR session renders (the window hosts' input drives the emulated controllers then): pushes are dropped
// and the queue emptied, so the page never gets a burst of stale input when it comes back to the flat page.
void setAccepting(bool on);
// Pointer lock (requestPointerLock): a window host captures its cursor and the page reads the motion as movementX/Y.
// Set by the host that can (the GLFW windows); without one the page's lock is only its own state. JS thread.
void setPointerLockHandler(void (*lock)(bool on));

// __native.input on the page's __native.
void install(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native);
// The window as the page sees it: CSS size, device pixel ratio, framebuffer pixels, screen rotation in degrees, and
// the safe-area insets in CSS pixels (top, right, bottom, left; null: none). Calls the runtime only on a change.
void setViewport(v8::Isolate* iso, v8::Local<v8::Context> ctx, double cssW, double cssH, double dpr, int fbW, int fbH, int angle, const float insets[4] = nullptr);
void setHidden(v8::Isolate* iso, v8::Local<v8::Context> ctx, bool hidden);

}  // namespace dom
}  // namespace host
