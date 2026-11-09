#pragma once
// The emulated headset (emu_xr.cpp) shared by every host without a real one: mac/, win/, ios/, linux/. It reads the
// wearer's controls through the hooks below, which each platform implements once (emu/glfw_input.cpp for the
// GLFW windows of mac, win and linux, ios/touch_input.mm for a phone or tablet). The desktop map (GLFW):
//
//   right-drag      look around            W A S D / Q E   walk / down, up (Shift: faster)
//   mouse           aim the mouse hand     left click      its trigger
//   F               its squeeze            Z / X           A / B (X / Y on the left hand)
//   arrow keys      its thumbstick         C               thumbstick click
//   G / H           the other hand's trigger / squeeze
//   Esc or M        menu button (left controller)
//   Tab             swap which hand the mouse drives        R   recenter
//   V               show one eye / both eyes                O   system menu (session VISIBLE, not FOCUSED)
#include <functional>

namespace host {
struct Json;
namespace emu {

// One frame of the wearer's input. Held state is what is down now; the toggles are true on the frame they fire.
struct Controls {
  float lookYaw = 0, lookPitch = 0;       // head turn since the last frame, radians (+yaw left, +pitch up)
  float walk[3] = {0, 0, 0};              // right, up, forward in [-1, 1], about the head's yaw
  bool fast = false;                      // walk 3x
  bool hasAim = false; float aimX = 0.5f, aimY = 0.5f;  // where the aimed hand points: the window, 0..1 from top left
  // The aimed hand (the mouse's on a desktop).
  bool trigger = false, squeeze = false, stickClick = false, a = false, b = false; float stick[2] = {0, 0};  // stick +y is down
  // The other hand, and the left controller's menu button.
  bool otherTrigger = false, otherSqueeze = false, menu = false;
  bool swapHand = false, toggleStereo = false, toggleSystemMenu = false, recenter = false;
};

// Platform hooks (one implementation per host).
void readControls(Controls& c);   // the input since the previous call (once per emulated frame)
float displayRate();              // the display's refresh rate (Hz); the emulated headset runs at it
// The window as the page sees it outside XR: its size in CSS pixels (points) and the device pixel ratio (framebuffer
// pixels per point). A size of 0 means the framebuffer's divided by the ratio.
void viewport(float& cssW, float& cssH, float& dpr);
bool closeRequested();            // the window is closing: the session ends
void requestClose();              // the page asked to exit (XRSession.end on a Quest app's exit path)

// The host's (not the platform's): drawn over the presented eye(s) before each swap, the window's size given
// (emu/splash.cpp while the page loads).
void setPresentOverlay(std::function<void(int w, int h)> draw);
// The app's host.json, before the device is created (its xr section: vision/vision_xr.mm reads xr.predictPose).
void setConfig(const Json* cfg);
// The platform ended the XR session from outside the page (vision: the person left the immersive space): the
// host sends the page its session's end. Weak default (host_emu.cpp): never.
bool sessionEndRequested();
// The person asked to enter XR from outside the page (vision: the window's enter button): the host accepts the
// session the page has on offer. Weak default: never.
bool enterRequested();

}  // namespace emu
}  // namespace host
