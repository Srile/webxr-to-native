#include "xr/xr_input.h"
#include "core/log.h"
#include <cstring>
#include <vector>

namespace host {

static XrPath path(XrInstance inst, const char* s) { XrPath p = XR_NULL_PATH; xrStringToPath(inst, s, &p); return p; }

bool XrInput::create(XrInstance inst, XrSession sess, bool handTracking, bool handAim) {
  inst_ = inst; sess_ = sess; handTracking_ = handTracking; handAim_ = handAim && handTracking;
  XrActionSetCreateInfo si{XR_TYPE_ACTION_SET_CREATE_INFO};
  strcpy(si.actionSetName, "gameplay"); strcpy(si.localizedActionSetName, "Gameplay"); si.priority = 0;
  if (XR_FAILED(xrCreateActionSet(inst, &si, &set_))) { HOST_LOGE("xrCreateActionSet failed"); return false; }
  handPath_[0] = path(inst, "/user/hand/left"); handPath_[1] = path(inst, "/user/hand/right");
  auto mk = [&](const char* name, XrActionType type, XrAction& out) {
    XrActionCreateInfo ai{XR_TYPE_ACTION_CREATE_INFO}; ai.actionType = type; strcpy(ai.actionName, name); strcpy(ai.localizedActionName, name);
    ai.countSubactionPaths = 2; ai.subactionPaths = handPath_;
    if (XR_FAILED(xrCreateAction(set_, &ai, &out))) { HOST_LOGE("xrCreateAction %s failed", name); out = XR_NULL_HANDLE; }
  };
  mk("grip_pose", XR_ACTION_TYPE_POSE_INPUT, aGrip_); mk("aim_pose", XR_ACTION_TYPE_POSE_INPUT, aAim_);
  mk("trigger", XR_ACTION_TYPE_FLOAT_INPUT, aTrigger_); mk("trigger_touch", XR_ACTION_TYPE_BOOLEAN_INPUT, aTriggerTouch_);
  mk("squeeze", XR_ACTION_TYPE_FLOAT_INPUT, aSqueeze_);
  mk("thumbstick", XR_ACTION_TYPE_VECTOR2F_INPUT, aStick_); mk("thumbstick_click", XR_ACTION_TYPE_BOOLEAN_INPUT, aStickClick_); mk("thumbstick_touch", XR_ACTION_TYPE_BOOLEAN_INPUT, aStickTouch_);
  mk("primary", XR_ACTION_TYPE_BOOLEAN_INPUT, aPrimary_); mk("primary_touch", XR_ACTION_TYPE_BOOLEAN_INPUT, aPrimaryTouch_);
  mk("secondary", XR_ACTION_TYPE_BOOLEAN_INPUT, aSecondary_); mk("secondary_touch", XR_ACTION_TYPE_BOOLEAN_INPUT, aSecondaryTouch_);
  mk("menu", XR_ACTION_TYPE_BOOLEAN_INPUT, aMenu_); mk("thumbrest", XR_ACTION_TYPE_BOOLEAN_INPUT, aThumbrest_);
  mk("haptic", XR_ACTION_TYPE_VIBRATION_OUTPUT, aHaptic_);

  // Touch controller profile (Quest 2/3/Pro all accept it). A/B on the right, X/Y on the left map to primary/secondary.
  std::vector<XrActionSuggestedBinding> b;
  auto bind = [&](XrAction a, const char* p) { if (a) b.push_back({a, path(inst, p)}); };
  for (int h = 0; h < 2; ++h) {
    const char* side = h == 0 ? "left" : "right"; char buf[128];
    auto P = [&](const char* comp) { snprintf(buf, sizeof buf, "/user/hand/%s/input/%s", side, comp); return buf; };
    bind(aGrip_, P("grip/pose")); bind(aAim_, P("aim/pose"));
    bind(aTrigger_, P("trigger/value")); bind(aTriggerTouch_, P("trigger/touch")); bind(aSqueeze_, P("squeeze/value"));
    bind(aStick_, P("thumbstick")); bind(aStickClick_, P("thumbstick/click")); bind(aStickTouch_, P("thumbstick/touch"));
    bind(aThumbrest_, P("thumbrest/touch"));
    if (h == 0) { bind(aPrimary_, P("x/click")); bind(aPrimaryTouch_, P("x/touch")); bind(aSecondary_, P("y/click")); bind(aSecondaryTouch_, P("y/touch")); bind(aMenu_, P("menu/click")); }
    else { bind(aPrimary_, P("a/click")); bind(aPrimaryTouch_, P("a/touch")); bind(aSecondary_, P("b/click")); bind(aSecondaryTouch_, P("b/touch")); }
    snprintf(buf, sizeof buf, "/user/hand/%s/output/haptic", side); bind(aHaptic_, buf);
  }
  XrInteractionProfileSuggestedBinding sb{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};
  sb.interactionProfile = path(inst, "/interaction_profiles/oculus/touch_controller");
  sb.countSuggestedBindings = (uint32_t)b.size(); sb.suggestedBindings = b.data();
  XrResult r = xrSuggestInteractionProfileBindings(inst, &sb);
  if (XR_FAILED(r)) HOST_LOGW("suggest touch_controller bindings failed %d", (int)r);
#ifndef __ANDROID__
  // Desktop runtimes (linux/: Monado's simulated controllers, any device without a Touch mapping) also get the
  // Khronos simple controller: select is the trigger (the runtime turns the click into 0/1), menu the menu button.
  // The runtime picks the profile that matches the device; WiVRn's Quest controllers still take the Touch one.
  b.clear();
  for (int h = 0; h < 2; ++h) {
    const char* side = h == 0 ? "left" : "right"; char buf[128];
    auto P = [&](const char* comp) { snprintf(buf, sizeof buf, "/user/hand/%s/input/%s", side, comp); return buf; };
    bind(aGrip_, P("grip/pose")); bind(aAim_, P("aim/pose")); bind(aTrigger_, P("select/click")); bind(aMenu_, P("menu/click"));
    snprintf(buf, sizeof buf, "/user/hand/%s/output/haptic", side); bind(aHaptic_, buf);
  }
  sb.interactionProfile = path(inst, "/interaction_profiles/khr/simple_controller");
  sb.countSuggestedBindings = (uint32_t)b.size(); sb.suggestedBindings = b.data();
  if (XR_FAILED(r = xrSuggestInteractionProfileBindings(inst, &sb))) HOST_LOGW("suggest simple_controller bindings failed %d", (int)r);
#endif

  for (int h = 0; h < 2; ++h) {
    XrActionSpaceCreateInfo asi{XR_TYPE_ACTION_SPACE_CREATE_INFO}; asi.poseInActionSpace.orientation.w = 1; asi.subactionPath = handPath_[h];
    asi.action = aGrip_; xrCreateActionSpace(sess, &asi, &gripSpace_[h]);
    asi.action = aAim_; xrCreateActionSpace(sess, &asi, &aimSpace_[h]);
  }
  if (handTracking_) {
    xrGetInstanceProcAddr(inst, "xrCreateHandTrackerEXT", (PFN_xrVoidFunction*)&pfnCreateTracker_);
    xrGetInstanceProcAddr(inst, "xrDestroyHandTrackerEXT", (PFN_xrVoidFunction*)&pfnDestroyTracker_);
    xrGetInstanceProcAddr(inst, "xrLocateHandJointsEXT", (PFN_xrVoidFunction*)&pfnLocateJoints_);
    for (int h = 0; h < 2; ++h) {
      XrHandTrackerCreateInfoEXT hc{XR_TYPE_HAND_TRACKER_CREATE_INFO_EXT}; hc.hand = h == 0 ? XR_HAND_LEFT_EXT : XR_HAND_RIGHT_EXT; hc.handJointSet = XR_HAND_JOINT_SET_DEFAULT_EXT;
      if (XR_FAILED(pfnCreateTracker_(sess, &hc, &tracker_[h]))) { HOST_LOGW("hand tracker %d failed", h); tracker_[h] = XR_NULL_HANDLE; }
    }
  }
  return true;
}

bool XrInput::attach() {
  XrSessionActionSetsAttachInfo ai{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO}; ai.countActionSets = 1; ai.actionSets = &set_;
  XrResult r = xrAttachSessionActionSets(sess_, &ai);
  if (XR_FAILED(r) && r != XR_ERROR_ACTIONSETS_ALREADY_ATTACHED) { HOST_LOGE("xrAttachSessionActionSets %d", (int)r); return false; }
  return true;
}

static void readPose(XrSpace space, XrSpace base, XrTime t, XrPoseF& out) {
  XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION}; out.valid = false;
  if (!space || XR_FAILED(xrLocateSpace(space, base, t, &loc))) return;
  const XrSpaceLocationFlags need = XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
  if ((loc.locationFlags & need) != need) return;
  out.valid = true; out.pos[0] = loc.pose.position.x; out.pos[1] = loc.pose.position.y; out.pos[2] = loc.pose.position.z;
  out.quat[0] = loc.pose.orientation.x; out.quat[1] = loc.pose.orientation.y; out.quat[2] = loc.pose.orientation.z; out.quat[3] = loc.pose.orientation.w;
}

void XrInput::sync(XrSession sess, XrSpace base, XrTime time, XrInputState& out) {
  XrActiveActionSet active{set_, XR_NULL_PATH};
  XrActionsSyncInfo si{XR_TYPE_ACTIONS_SYNC_INFO}; si.countActiveActionSets = 1; si.activeActionSets = &active;
  if (XR_FAILED(xrSyncActions(sess, &si))) return;
  for (int h = 0; h < 2; ++h) {
    XrHandState& hs = out.hand[h];
    auto f = [&](XrAction a) { XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO}; gi.action = a; gi.subactionPath = handPath_[h]; XrActionStateFloat s{XR_TYPE_ACTION_STATE_FLOAT}; xrGetActionStateFloat(sess, &gi, &s); return s; };
    auto bo = [&](XrAction a) { XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO}; gi.action = a; gi.subactionPath = handPath_[h]; XrActionStateBoolean s{XR_TYPE_ACTION_STATE_BOOLEAN}; xrGetActionStateBoolean(sess, &gi, &s); return s; };
    XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO}; gi.action = aGrip_; gi.subactionPath = handPath_[h];
    XrActionStatePose ps{XR_TYPE_ACTION_STATE_POSE}; xrGetActionStatePose(sess, &gi, &ps);
    hs.active = ps.isActive;
    readPose(gripSpace_[h], base, time, hs.grip); readPose(aimSpace_[h], base, time, hs.aim);
    if (!hs.active) { hs.grip.valid = false; hs.aim.valid = false; }  // a sleeping controller's action spaces still locate (stale); the hand's aim must come from XR_FB_hand_tracking_aim below
    auto trig = f(aTrigger_), sq = f(aSqueeze_);
    hs.buttonValue[0] = trig.currentState; hs.buttonPressed[0] = trig.currentState > 0.7f; hs.buttonTouched[0] = bo(aTriggerTouch_).currentState || trig.currentState > 0;
    hs.buttonValue[1] = sq.currentState; hs.buttonPressed[1] = sq.currentState > 0.7f; hs.buttonTouched[1] = sq.currentState > 0;
    hs.buttonValue[2] = 0; hs.buttonPressed[2] = 0; hs.buttonTouched[2] = 0;
    auto sc = bo(aStickClick_), st = bo(aStickTouch_); hs.buttonPressed[3] = sc.currentState; hs.buttonTouched[3] = st.currentState || sc.currentState; hs.buttonValue[3] = sc.currentState ? 1.f : 0.f;
    auto pr = bo(aPrimary_), prt = bo(aPrimaryTouch_); hs.buttonPressed[4] = pr.currentState; hs.buttonTouched[4] = prt.currentState || pr.currentState; hs.buttonValue[4] = pr.currentState ? 1.f : 0.f;
    auto se = bo(aSecondary_), set = bo(aSecondaryTouch_); hs.buttonPressed[5] = se.currentState; hs.buttonTouched[5] = set.currentState || se.currentState; hs.buttonValue[5] = se.currentState ? 1.f : 0.f;
    auto tr = bo(aThumbrest_); hs.buttonPressed[6] = 0; hs.buttonTouched[6] = tr.currentState; hs.buttonValue[6] = 0;
    auto me = bo(aMenu_); hs.buttonPressed[7] = me.currentState; hs.buttonTouched[7] = me.currentState; hs.buttonValue[7] = me.currentState ? 1.f : 0.f;
    XrActionStateGetInfo g2{XR_TYPE_ACTION_STATE_GET_INFO}; g2.action = aStick_; g2.subactionPath = handPath_[h];
    XrActionStateVector2f v{XR_TYPE_ACTION_STATE_VECTOR2F}; xrGetActionStateVector2f(sess, &g2, &v);
    hs.axes[0] = 0; hs.axes[1] = 0; hs.axes[2] = v.currentState.x; hs.axes[3] = -v.currentState.y;  // WebXR: +y is down/back on the stick axis
    hs.handTracked = false; hs.pinching = false; hs.pinchStrength = 0;
    if (tracker_[h] && pfnLocateJoints_) {
      XrHandJointsLocateInfoEXT li{XR_TYPE_HAND_JOINTS_LOCATE_INFO_EXT}; li.baseSpace = base; li.time = time;
      XrHandJointLocationEXT jl[XR_HAND_JOINT_COUNT_EXT];
      XrHandTrackingAimStateFB aim{XR_TYPE_HAND_TRACKING_AIM_STATE_FB};
      XrHandJointLocationsEXT locs{XR_TYPE_HAND_JOINT_LOCATIONS_EXT}; locs.jointCount = XR_HAND_JOINT_COUNT_EXT; locs.jointLocations = jl; if (handAim_) locs.next = &aim;
      if (XR_SUCCEEDED(pfnLocateJoints_(tracker_[h], &li, &locs)) && locs.isActive && (jl[XR_HAND_JOINT_WRIST_EXT].locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT)) {
        hs.handTracked = true;  // isActive alone is not enough: with hand tracking off in Settings the runtime answers active with every joint at the origin
        for (int j = 0; j < XR_HAND_JOINT_COUNT_EXT; ++j) {
          const bool ok = (jl[j].locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) && (jl[j].locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT);
          hs.jointValid[j] = ok; float* o = hs.joints[j];
          o[0] = jl[j].pose.position.x; o[1] = jl[j].pose.position.y; o[2] = jl[j].pose.position.z;
          o[3] = jl[j].pose.orientation.x; o[4] = jl[j].pose.orientation.y; o[5] = jl[j].pose.orientation.z; o[6] = jl[j].pose.orientation.w; o[7] = jl[j].radius;
        }
        if (h == 0 && (++aimDbg_ % 180) == 0) HOST_LOGD("hand0 aim status 0x%x pose %.2f %.2f %.2f / %.2f %.2f %.2f %.2f  wrist %.2f %.2f %.2f", (unsigned)aim.status, aim.aimPose.position.x, aim.aimPose.position.y, aim.aimPose.position.z, aim.aimPose.orientation.x, aim.aimPose.orientation.y, aim.aimPose.orientation.z, aim.aimPose.orientation.w, jl[XR_HAND_JOINT_WRIST_EXT].pose.position.x, jl[XR_HAND_JOINT_WRIST_EXT].pose.position.y, jl[XR_HAND_JOINT_WRIST_EXT].pose.position.z);
        if (handAim_ && (aim.status & XR_HAND_TRACKING_AIM_VALID_BIT_FB)) {
          hs.pinching = aim.status & XR_HAND_TRACKING_AIM_INDEX_PINCHING_BIT_FB; hs.pinchStrength = aim.pinchStrengthIndex;
          if (!hs.aim.valid) { hs.aim.valid = true; hs.aim.pos[0] = aim.aimPose.position.x; hs.aim.pos[1] = aim.aimPose.position.y; hs.aim.pos[2] = aim.aimPose.position.z; hs.aim.quat[0] = aim.aimPose.orientation.x; hs.aim.quat[1] = aim.aimPose.orientation.y; hs.aim.quat[2] = aim.aimPose.orientation.z; hs.aim.quat[3] = aim.aimPose.orientation.w; }
          if (!hs.active) {
            // The hand's gamepad (the Quest Browser's layout, which the game reads by raw index): 0..3 the four
            // finger pinches (value = strength), 4 the MENU gesture — the left hand's palm pinch, which the runtime
            // reports as MENU_PRESSED instead of handing it to the system like the right hand's.
            const float str[4] = {aim.pinchStrengthIndex, aim.pinchStrengthMiddle, aim.pinchStrengthRing, aim.pinchStrengthLittle};
            const XrHandTrackingAimFlagsFB bits[4] = {XR_HAND_TRACKING_AIM_INDEX_PINCHING_BIT_FB, XR_HAND_TRACKING_AIM_MIDDLE_PINCHING_BIT_FB, XR_HAND_TRACKING_AIM_RING_PINCHING_BIT_FB, XR_HAND_TRACKING_AIM_LITTLE_PINCHING_BIT_FB};
            for (int i = 0; i < 4; ++i) { hs.buttonValue[i] = str[i]; hs.buttonPressed[i] = (aim.status & bits[i]) ? 1 : 0; hs.buttonTouched[i] = hs.buttonPressed[i] || str[i] > 0; }
            const bool menu = (aim.status & XR_HAND_TRACKING_AIM_MENU_PRESSED_BIT_FB) != 0;
            hs.buttonValue[4] = menu ? 1.f : 0.f; hs.buttonPressed[4] = menu; hs.buttonTouched[4] = menu;
          }
        } else {
          // Fallback pinch: index tip to thumb tip under 1.5 cm.
          const float* a = hs.joints[XR_HAND_JOINT_INDEX_TIP_EXT]; const float* t = hs.joints[XR_HAND_JOINT_THUMB_TIP_EXT];
          float dx = a[0] - t[0], dy = a[1] - t[1], dz = a[2] - t[2]; float d = dx * dx + dy * dy + dz * dz;
          hs.pinching = d < 0.015f * 0.015f; hs.pinchStrength = hs.pinching ? 1.f : 0.f;
          if (!hs.active) { hs.buttonValue[0] = hs.pinchStrength; hs.buttonPressed[0] = hs.pinching; hs.buttonTouched[0] = hs.pinching; }
        }
        if (!hs.active && !hs.grip.valid && hs.jointValid[XR_HAND_JOINT_PALM_EXT]) {
          // A tracked hand's gripSpace (the browser gives hands one): the PALM joint. IWSDK parks the belt and the
          // item hand's touch point on it, and without it those stay wherever the last controller left them.
          const float* pj = hs.joints[XR_HAND_JOINT_PALM_EXT];
          hs.grip.valid = true; hs.grip.pos[0] = pj[0]; hs.grip.pos[1] = pj[1]; hs.grip.pos[2] = pj[2];
          hs.grip.quat[0] = pj[3]; hs.grip.quat[1] = pj[4]; hs.grip.quat[2] = pj[5]; hs.grip.quat[3] = pj[6];
        }
      } else memset(hs.jointValid, 0, sizeof hs.jointValid);
    }
  }
}

void XrInput::vibrate(int hand, float amplitude, float seconds, float hz) {
  if (!aHaptic_ || hand < 0 || hand > 1) return;
  XrHapticVibration v{XR_TYPE_HAPTIC_VIBRATION}; v.amplitude = amplitude; v.duration = (XrDuration)(seconds * 1e9); v.frequency = hz > 0 ? hz : XR_FREQUENCY_UNSPECIFIED;
  XrHapticActionInfo hi{XR_TYPE_HAPTIC_ACTION_INFO}; hi.action = aHaptic_; hi.subactionPath = handPath_[hand];
  xrApplyHapticFeedback(sess_, &hi, (XrHapticBaseHeader*)&v);
}

void XrInput::destroy() {
  for (int h = 0; h < 2; ++h) { if (tracker_[h] && pfnDestroyTracker_) pfnDestroyTracker_(tracker_[h]); if (gripSpace_[h]) xrDestroySpace(gripSpace_[h]); if (aimSpace_[h]) xrDestroySpace(aimSpace_[h]); tracker_[h] = XR_NULL_HANDLE; gripSpace_[h] = aimSpace_[h] = XR_NULL_HANDLE; }
  if (set_) xrDestroyActionSet(set_); set_ = XR_NULL_HANDLE;
}

}  // namespace host
