// record.js — the layouts of the two arrays `__native.xr.onFrame(cb(frame,
// input))` hands over every XR frame. FIXED: the C++
// side writes against these numbers. The host owns both arrays and rewrites
// them in place; nothing here copies them.

// Frame record: Float64Array(40).
export const F = Object.freeze({
  TIME: 0,           // displayTime, loop-clock ms
  SHOULD_RENDER: 1,  // 0/1
  VIEW_COUNT: 2,
  COLOR_TEX: 3,      // GL name of the acquired swapchain image
  WIDTH: 4, HEIGHT: 5, ARRAY_SIZE: 6,
  IMAGE_INDEX: 7,
  VIEW0: 8, VIEW1: 19, VIEW_STRIDE: 11,
  // inside a view block
  V_POS: 0, V_QUAT: 3, V_FOV_L: 7, V_FOV_R: 8, V_FOV_U: 9, V_FOV_D: 10,
  LOCAL_POS: 30, LOCAL_QUAT: 33,  // LOCAL space in the base space
  RATE: 37,
  BASE_KIND: 38,     // 1 = stage (floor level), 0 = local
  SCENE_GEN: 39,     // scene entity list generation (changes → refetch __native.xr.sceneEntities())
  LENGTH: 40,
})

// Scene pose record: Float32Array(128 × 8), one block per listed plane / mesh
// (its `slot`), rewritten by native every frame.
export const S = Object.freeze({
  STRIDE: 8, MAX: 128,
  VALID: 0, POS: 1, QUAT: 4,
})

// Input record: Float32Array(2 × 288); hand 0 left, 1 right.
export const I = Object.freeze({
  STRIDE: 288,
  ACTIVE: 0,         // controller tracked
  HAND_TRACKED: 1,   // joints valid
  GRIP_VALID: 2, GRIP_POS: 3, GRIP_QUAT: 6,
  AIM_VALID: 10, AIM_POS: 11, AIM_QUAT: 14,
  BTN_VALUE: 18, BTN_PRESSED: 26, BTN_TOUCHED: 34, BTN_COUNT: 8,
  AXES: 42,          // 0,1 touchpad (always 0); 2,3 thumbstick x, y (WebXR sign)
  PINCHING: 46, PINCH_STRENGTH: 47,
  // After the two hands: the gaze, a transient-pointer input source (vision: a pinch at the gaze, the ray from
  // the eye through the looked-at point, pressed for the pinch).
  GAZE: 576, GAZE_ACTIVE: 0, GAZE_VALID: 1, GAZE_POS: 2, GAZE_QUAT: 5, GAZE_PRESSED: 9, GAZE_VALUE: 10, GAZE_LEN: 16,
  JOINTS: 48, JOINT_STRIDE: 9, JOINT_COUNT: 26,  // OpenXR order, PALM first
  // inside a joint block
  J_POS: 0, J_QUAT: 3, J_RADIUS: 7, J_VALID: 8,
  LENGTH: 576,
})

// xr-standard button order; the record carries the menu button at 7 (the
// Quest Browser's left-controller layout exposes it there too).
export const BUTTON_NAMES = Object.freeze([
  'trigger', 'squeeze', 'touchpad', 'thumbstick', 'a-or-x', 'b-or-y', 'thumbrest', 'menu',
])

// The 25 WebXR joints in spec order. WebXR joint i = OpenXR joint i + 1
// (OpenXR has PALM at 0, which WebXR drops).
export const JOINT_NAMES = Object.freeze([
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
])

export function jointOffset(hand, webxrJoint) {
  return hand * I.STRIDE + I.JOINTS + (webxrJoint + 1) * I.JOINT_STRIDE
}
