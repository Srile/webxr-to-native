#pragma once
// Touch controllers (xr-standard layout), hand tracking (25 WebXR joints), haptics.
#include <openxr/openxr.h>
#include <cstdint>

namespace host {

struct XrPoseF { float pos[3]; float quat[4]; bool valid; };
// WebXR xr-standard gamepad: buttons 0 trigger, 1 squeeze, 2 touchpad(absent), 3 thumbstick, 4 A/X, 5 B/Y, 6 thumbrest(extra), 7 menu(extra)
struct XrHandState {
  bool active = false;               // a controller is tracked for this hand
  bool handTracked = false;          // hand joints are tracked (controller down)
  XrPoseF grip, aim;
  float buttonValue[8] = {0}; uint8_t buttonPressed[8] = {0}; uint8_t buttonTouched[8] = {0};
  float axes[4] = {0, 0, 0, 0};
  // 26 OpenXR joints (PALM first); pos xyz + quat xyzw + radius, in the base space
  float joints[26][8]; uint8_t jointValid[26] = {0};
  bool pinching = false; float pinchStrength = 0;
};
struct XrInputState {
  XrHandState hand[2]; /* 0 left, 1 right */
  // The gaze, a transient-pointer input source (vision: a pinch at the gaze; the ray from the eye through the
  // looked-at point, pressed for the pinch). Listed by the page while active.
  XrPoseF gaze{}; bool gazeActive = false, gazePressed = false; float gazeValue = 0;
};

class XrInput {
 public:
  bool create(XrInstance inst, XrSession sess, bool handTracking, bool handAim);
  void destroy();
  bool attach();  // after session creation: attach the action set
  void sync(XrSession sess, XrSpace base, XrTime time, XrInputState& out);
  void vibrate(int hand, float amplitude, float seconds, float hz);
  bool handTracking() const { return handTracking_; }
  XrSpace* gripSpaces() { return gripSpace_; }

 private:
  XrInstance inst_ = XR_NULL_HANDLE; XrSession sess_ = XR_NULL_HANDLE;
  XrActionSet set_ = XR_NULL_HANDLE;
  XrPath handPath_[2];
  XrAction aGrip_, aAim_, aTrigger_, aTriggerTouch_, aSqueeze_, aStick_, aStickClick_, aStickTouch_, aPrimary_, aPrimaryTouch_, aSecondary_, aSecondaryTouch_, aMenu_, aThumbrest_, aHaptic_;
  XrSpace gripSpace_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE}, aimSpace_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE};
  bool handTracking_ = false, handAim_ = false;
  XrHandTrackerEXT tracker_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE};
  PFN_xrCreateHandTrackerEXT pfnCreateTracker_ = nullptr;
  PFN_xrDestroyHandTrackerEXT pfnDestroyTracker_ = nullptr;
  PFN_xrLocateHandJointsEXT pfnLocateJoints_ = nullptr;
  int aimDbg_ = 0;
};

}  // namespace host
