#pragma once
// The host's own on-screen controls for a page outside XR on a touch screen (WP-20): sticks and buttons from
// host.json `touchControls`, drawn over the page's frame before the swap and handed to the page as one
// standard-mapping gamepad (js/dom_input.h's pad, navigator.getGamepads() in the runtime), from the first touch
// of a control on (a browser exposes a gamepad once it is used). A finger that lands on
// a control belongs to it until it lifts; every other finger goes to the page as a pointer.
//
//   "touchControls": {
//     "desktop": false,          also on the window hosts, driven by the mouse (testing the layout on a Mac)
//     "opacity": 1,              scales every control's alpha
//     "showWhen": ".touch-controls",  shown only while this element of the page is (connected, no ancestor with
//                                display none or visibility hidden): the page's own touch UI says when it is
//                                playing; without it the controls show throughout flat play
//     "controls": [
//       { "type": "stick",  "anchor": "bottom-left",  "x": 32, "y": 32, "size": 150, "axes": [0, 1] },
//       { "type": "button", "anchor": "bottom-right", "x": 24, "y": 32, "size": 96, "button": 7, "icon": "gas.png" }
//     ],
//     "zones": [                 touches the PAGE's own touch UI takes (runtime/src/dom-lite/input.js routes them)
//       { "selector": ".touch-zone-full", "rect": [0, 0.5, 1, 1],
//         "stick": { "anchor": "bottom-left", "x": 32, "y": 32, "size": 140, "knob": 60, "range": 40, "travel": 60 } }
//     ] }
//
// A zone's `stick` is only drawn: the page reads the finger itself (its pointer events). The base sits where the
// page's own (invisible) joystick would; the knob moves `travel` px at full deflection, which is `range` px of finger
// travel from where the finger landed, as a browser shows the page's HTML joystick.
//
// Positions and sizes are CSS pixels; x and y are the gap from the anchor's edges (inside the safe area) to the
// control's. Anchors: top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right. An icon is
// a PNG among the app's assets (www/), drawn inside the control. All of it runs on the thread that owns GL.
#include <string>

namespace host {
struct Json; class Assets;
namespace touch {

// host.json's touchControls; false when there are none (or none for this host: `desktop` false on a window host).
bool configure(const Json& config, const Assets& assets, bool touchScreen);
bool active();
// The page wants them (showWhen's element is visible) or not: they fade in or out over a fifth of a second; a
// faded-out control takes no fingers.
void setWanted(bool wanted);
// A finger the page's joystick zone took, from where it landed (CSS px): the zone stick's knob follows it.
void stickFinger(int id, float x, float y);
// The window in CSS pixels, its device pixel ratio and the safe-area insets (top, right, bottom, left).
void layout(float cssW, float cssH, float dpr, const float insets[4] = nullptr);
// A finger (or the mouse on a desktop) in CSS pixels: true when a control has it, so the page must not.
bool down(int id, float x, float y);
bool move(int id, float x, float y);
bool up(int id);
void cancelAll();
// Once per flat frame: publish the gamepad (shown: the page is flat and in front) and draw into the bound window
// framebuffer, fbW x fbH pixels. Hidden controls release their fingers and report a neutral pad.
void frame(double nowMs, bool shown, int fbW, int fbH);

}  // namespace touch
}  // namespace host
