// emu.h's hooks for the desktop hosts (mac/, win/, linux/): the GLFW window's mouse and keyboard, as emu.h maps them
// for the emulated headset, and (through GLFW's callbacks) as page input outside XR (js/dom_input.h): the mouse as a
// pointer, the wheel, keys by their DOM code. The touch controls, when host.json asks for them on a desktop, take the
// left button as a finger.
#include "emu/emu.h"
#include "emu/glfw_input.h"
#include "gl/touch_controls.h"
#include "js/dom_input.h"
#include <GLFW/glfw3.h>
#include <cstdio>

namespace host {
namespace emu {
namespace {
GLFWwindow* g_window = nullptr;
bool g_prevKey[GLFW_KEY_LAST + 1] = {};
double g_lastX = 0, g_lastY = 0; bool g_looking = false;

bool held(int key) { return g_window && glfwGetKey(g_window, key) == GLFW_PRESS; }
bool edge(int key) {  // pressed this frame
  bool down = held(key), was = g_prevKey[key]; g_prevKey[key] = down; return down && !was;
}
float axis(int plus, int minus) { return (held(plus) ? 1.f : 0.f) - (held(minus) ? 1.f : 0.f); }

// ---- page input (callbacks) ----
int g_buttons = 0; bool g_mouseOnControl = false;
int domMods(int m) { return (m & GLFW_MOD_SHIFT ? dom::kShift : 0) | (m & GLFW_MOD_CONTROL ? dom::kCtrl : 0) | (m & GLFW_MOD_ALT ? dom::kAlt : 0) | (m & GLFW_MOD_SUPER ? dom::kMeta : 0); }
int liveMods() {
  return (held(GLFW_KEY_LEFT_SHIFT) || held(GLFW_KEY_RIGHT_SHIFT) ? dom::kShift : 0) | (held(GLFW_KEY_LEFT_CONTROL) || held(GLFW_KEY_RIGHT_CONTROL) ? dom::kCtrl : 0) |
         (held(GLFW_KEY_LEFT_ALT) || held(GLFW_KEY_RIGHT_ALT) ? dom::kAlt : 0) | (held(GLFW_KEY_LEFT_SUPER) || held(GLFW_KEY_RIGHT_SUPER) ? dom::kMeta : 0);
}
void onCursor(GLFWwindow*, double x, double y) {
  if (g_mouseOnControl) { touch::move(0, (float)x, (float)y); return; }
  dom::pointer(dom::kMove, 1, x, y, g_buttons, -1, dom::kMouse, g_buttons ? 0.5f : 0.f, liveMods());
}
void onButton(GLFWwindow* w, int b, int action, int mods) {
  double x = 0, y = 0; glfwGetCursorPos(w, &x, &y);
  if (b == GLFW_MOUSE_BUTTON_LEFT && action == GLFW_PRESS && touch::down(0, (float)x, (float)y)) { g_mouseOnControl = true; return; }
  if (b == GLFW_MOUSE_BUTTON_LEFT && action == GLFW_RELEASE && g_mouseOnControl) { touch::up(0); g_mouseOnControl = false; return; }
  const int button = b == GLFW_MOUSE_BUTTON_LEFT ? 0 : b == GLFW_MOUSE_BUTTON_RIGHT ? 2 : b == GLFW_MOUSE_BUTTON_MIDDLE ? 1 : b;
  const int bit = button == 0 ? 1 : button == 2 ? 2 : button == 1 ? 4 : 0;
  g_buttons = action == GLFW_PRESS ? (g_buttons | bit) : (g_buttons & ~bit);
  dom::pointer(action == GLFW_PRESS ? dom::kDown : dom::kUp, 1, x, y, g_buttons, button, dom::kMouse, g_buttons ? 0.5f : 0.f, domMods(mods));
}
void onScroll(GLFWwindow* w, double dx, double dy) {
  double x = 0, y = 0; glfwGetCursorPos(w, &x, &y);
  dom::wheel(x, y, -dx * 40, -dy * 40, liveMods());  // a wheel notch is about 40 CSS pixels in Chrome on macOS; GLFW's +y is up
}
void onEnter(GLFWwindow* w, int entered) {
  if (entered) return;
  double x = 0, y = 0; glfwGetCursorPos(w, &x, &y);
  dom::pointer(dom::kLeave, 1, x, y, g_buttons, -1, dom::kMouse, 0, 0);
}
const char* codeOf(int k) {
  static char buf[16];
  if (k >= GLFW_KEY_A && k <= GLFW_KEY_Z) { snprintf(buf, sizeof buf, "Key%c", 'A' + (k - GLFW_KEY_A)); return buf; }
  if (k >= GLFW_KEY_0 && k <= GLFW_KEY_9) { snprintf(buf, sizeof buf, "Digit%d", k - GLFW_KEY_0); return buf; }
  if (k >= GLFW_KEY_F1 && k <= GLFW_KEY_F12) { snprintf(buf, sizeof buf, "F%d", 1 + k - GLFW_KEY_F1); return buf; }
  if (k >= GLFW_KEY_KP_0 && k <= GLFW_KEY_KP_9) { snprintf(buf, sizeof buf, "Numpad%d", k - GLFW_KEY_KP_0); return buf; }
  switch (k) {
    case GLFW_KEY_LEFT: return "ArrowLeft"; case GLFW_KEY_RIGHT: return "ArrowRight"; case GLFW_KEY_UP: return "ArrowUp"; case GLFW_KEY_DOWN: return "ArrowDown";
    case GLFW_KEY_SPACE: return "Space"; case GLFW_KEY_ENTER: return "Enter"; case GLFW_KEY_KP_ENTER: return "NumpadEnter"; case GLFW_KEY_ESCAPE: return "Escape";
    case GLFW_KEY_BACKSPACE: return "Backspace"; case GLFW_KEY_TAB: return "Tab";
    case GLFW_KEY_LEFT_SHIFT: return "ShiftLeft"; case GLFW_KEY_RIGHT_SHIFT: return "ShiftRight"; case GLFW_KEY_LEFT_CONTROL: return "ControlLeft"; case GLFW_KEY_RIGHT_CONTROL: return "ControlRight";
    case GLFW_KEY_LEFT_ALT: return "AltLeft"; case GLFW_KEY_RIGHT_ALT: return "AltRight"; case GLFW_KEY_LEFT_SUPER: return "MetaLeft"; case GLFW_KEY_RIGHT_SUPER: return "MetaRight";
    case GLFW_KEY_MINUS: return "Minus"; case GLFW_KEY_EQUAL: return "Equal"; case GLFW_KEY_LEFT_BRACKET: return "BracketLeft"; case GLFW_KEY_RIGHT_BRACKET: return "BracketRight";
    case GLFW_KEY_BACKSLASH: return "Backslash"; case GLFW_KEY_SEMICOLON: return "Semicolon"; case GLFW_KEY_APOSTROPHE: return "Quote"; case GLFW_KEY_GRAVE_ACCENT: return "Backquote";
    case GLFW_KEY_COMMA: return "Comma"; case GLFW_KEY_PERIOD: return "Period"; case GLFW_KEY_SLASH: return "Slash"; case GLFW_KEY_CAPS_LOCK: return "CapsLock";
    case GLFW_KEY_DELETE: return "Delete"; case GLFW_KEY_INSERT: return "Insert"; case GLFW_KEY_HOME: return "Home"; case GLFW_KEY_END: return "End";
    case GLFW_KEY_PAGE_UP: return "PageUp"; case GLFW_KEY_PAGE_DOWN: return "PageDown";
    default: return nullptr;
  }
}
void onKey(GLFWwindow*, int k, int, int action, int mods) {
  const char* code = codeOf(k); if (!code) return;
  dom::key(action != GLFW_RELEASE, code, domMods(mods) | (action == GLFW_REPEAT ? dom::kRepeat : 0));
}
}  // namespace

// The page's pointer lock: the cursor hidden and held in the window, its motion unbounded (GLFW's virtual position,
// so movementX/Y keep coming at the edges), raw where the platform has it (no pointer acceleration, as Chrome's).
void pointerLock(bool on) {
  if (!g_window) return;
  glfwSetInputMode(g_window, GLFW_CURSOR, on ? GLFW_CURSOR_DISABLED : GLFW_CURSOR_NORMAL);
  if (glfwRawMouseMotionSupported()) glfwSetInputMode(g_window, GLFW_RAW_MOUSE_MOTION, on ? GLFW_TRUE : GLFW_FALSE);
}

void setWindow(GLFWwindow* w) {
  g_window = w; dom::setPointerLockHandler(pointerLock);
  glfwSetCursorPosCallback(w, onCursor); glfwSetMouseButtonCallback(w, onButton); glfwSetScrollCallback(w, onScroll);
  glfwSetCursorEnterCallback(w, onEnter); glfwSetKeyCallback(w, onKey);
}

void viewport(float& cssW, float& cssH, float& dpr) {
  int ww = 0, wh = 0, fw = 0, fh = 0;
  if (g_window) { glfwGetWindowSize(g_window, &ww, &wh); glfwGetFramebufferSize(g_window, &fw, &fh); }
  cssW = (float)(ww > 0 ? ww : 1); cssH = (float)(wh > 0 ? wh : 1); dpr = ww > 0 && fw > 0 ? (float)fw / ww : 1.f;
}

void readControls(Controls& c) {
  c = Controls{};
  if (!g_window) return;
  c.swapHand = edge(GLFW_KEY_TAB); c.toggleStereo = edge(GLFW_KEY_V); c.toggleSystemMenu = edge(GLFW_KEY_O); c.recenter = edge(GLFW_KEY_R);
  double cx = 0, cy = 0; int ww = 1, wh = 1;
  glfwGetCursorPos(g_window, &cx, &cy); glfwGetWindowSize(g_window, &ww, &wh);
  const bool rmb = glfwGetMouseButton(g_window, GLFW_MOUSE_BUTTON_RIGHT) == GLFW_PRESS;
  if (rmb && g_looking) { c.lookYaw = -(float)(cx - g_lastX) * 0.005f; c.lookPitch = -(float)(cy - g_lastY) * 0.005f; }
  g_looking = rmb; g_lastX = cx; g_lastY = cy;
  c.walk[0] = axis(GLFW_KEY_D, GLFW_KEY_A); c.walk[1] = axis(GLFW_KEY_E, GLFW_KEY_Q); c.walk[2] = axis(GLFW_KEY_W, GLFW_KEY_S);
  c.fast = held(GLFW_KEY_LEFT_SHIFT);
  c.hasAim = true; c.aimX = (float)(cx / (ww > 0 ? ww : 1)); c.aimY = (float)(cy / (wh > 0 ? wh : 1));
  c.trigger = glfwGetMouseButton(g_window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS;
  c.squeeze = held(GLFW_KEY_F); c.stickClick = held(GLFW_KEY_C); c.a = held(GLFW_KEY_Z); c.b = held(GLFW_KEY_X);
  c.stick[0] = axis(GLFW_KEY_RIGHT, GLFW_KEY_LEFT); c.stick[1] = axis(GLFW_KEY_DOWN, GLFW_KEY_UP);
  c.otherTrigger = held(GLFW_KEY_G); c.otherSqueeze = held(GLFW_KEY_H);
  c.menu = held(GLFW_KEY_ESCAPE) || held(GLFW_KEY_M);
}

float displayRate() {
  GLFWmonitor* mon = glfwGetPrimaryMonitor(); const GLFWvidmode* mode = mon ? glfwGetVideoMode(mon) : nullptr;
  return mode && mode->refreshRate > 0 ? (float)mode->refreshRate : 60.f;
}
bool closeRequested() { return g_window && glfwWindowShouldClose(g_window); }
void requestClose() { if (g_window) glfwSetWindowShouldClose(g_window, GLFW_TRUE); }

}  // namespace emu
}  // namespace host
