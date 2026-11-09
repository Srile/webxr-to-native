// input.js — the native input record (record.js `I`) written into IWER's host input (iwer HOST-INPUT.md): one
// XRHostInputState per hand, created by IWER once and rewritten here before every XR frame. IWER derives the
// XRInputSources, gamepads, hand joints, inputsourceschange and select/squeeze events from it. Nothing is
// allocated: fields are copied number by number.
import { XRHostInputMode } from 'iwer/lib/host.js'
import { I } from './record.js'

// The browser's Touch trigger and grip thresholds, with hysteresis: IWER takes `pressed` as the host says, and a
// Touch trigger has a value and a touch, no click.
const SELECT_ON = 0.7
const SELECT_OFF = 0.6
const BUTTONS = 10  // HOST_INPUT_BUTTONS

function pose7(out, rec, at) { for (let i = 0; i < 7; i++) out[i] = rec[at + i] }

export class InputBridge {
  constructor(hostInput) {
    this.states = [hostInput.left, hostInput.right]
    this.held = [[false, false], [false, false]]  // per hand: trigger, squeeze pressed (the hysteresis)
  }

  write(rec) {
    for (let h = 0; h < 2; h++) this.side(this.states[h], rec, h)
    // The gaze (vision: a pinch at the gaze, the ray from the eye through the looked-at point). IWER's host input
    // has controllers and hands only, so a gaze pinch reaches the page as the right hand's tracked-pointer
    // controller with no grip, while that hand shows nothing else.
    const gz = I.GAZE
    const st = this.states[1]
    if (st.mode === XRHostInputMode.None && rec[gz + I.GAZE_ACTIVE] > 0.5) {
      st.mode = XRHostInputMode.Controller
      pose7(st.targetRay, rec, gz + I.GAZE_POS)
      st.targetRayValid = rec[gz + I.GAZE_VALID] > 0.5
      st.gripValid = false
      st.palmValid = false
      st.buttonValues.fill(0); st.buttonPressed.fill(0); st.buttonTouched.fill(0); st.axes.fill(0)
      const pressed = rec[gz + I.GAZE_PRESSED] > 0.5
      st.buttonValues[0] = rec[gz + I.GAZE_VALUE]
      st.buttonPressed[0] = pressed ? 1 : 0
      st.buttonTouched[0] = pressed || rec[gz + I.GAZE_VALUE] > 0 ? 1 : 0
    }
  }

  side(st, rec, h) {
    const b = h * I.STRIDE
    const held = this.held[h]
    if (rec[b + I.ACTIVE] > 0.5) {
      st.mode = XRHostInputMode.Controller
      pose7(st.grip, rec, b + I.GRIP_POS)
      st.gripValid = rec[b + I.GRIP_VALID] > 0.5
      pose7(st.targetRay, rec, b + I.AIM_POS)
      st.targetRayValid = rec[b + I.AIM_VALID] > 0.5
      st.palmValid = false
      const values = st.buttonValues, pressed = st.buttonPressed, touched = st.buttonTouched
      for (let i = 0; i < I.BTN_COUNT; i++) {
        const v = rec[b + I.BTN_VALUE + i]
        let p = rec[b + I.BTN_PRESSED + i] > 0.5
        if (i < 2) { p = p || v >= (held[i] ? SELECT_OFF : SELECT_ON); held[i] = p }
        values[i] = v
        pressed[i] = p ? 1 : 0
        touched[i] = p || rec[b + I.BTN_TOUCHED + i] > 0.5 ? 1 : 0
      }
      for (let i = I.BTN_COUNT; i < BUTTONS; i++) { values[i] = 0; pressed[i] = 0; touched[i] = 0 }
      const ax = st.axes
      ax[0] = 0; ax[1] = 0
      ax[2] = rec[b + I.AXES + 2]
      ax[3] = rec[b + I.AXES + 3]
      return
    }
    held[0] = false; held[1] = false
    if (rec[b + I.HAND_TRACKED] > 0.5) {
      st.mode = XRHostInputMode.Hand
      // a tracked hand's grip is its palm in the record already; the palm joint (OpenXR joint 0) stands in when not
      pose7(st.grip, rec, b + I.GRIP_POS)
      st.gripValid = rec[b + I.GRIP_VALID] > 0.5
      pose7(st.targetRay, rec, b + I.AIM_POS)
      st.targetRayValid = rec[b + I.AIM_VALID] > 0.5
      const palm = b + I.JOINTS
      pose7(st.palm, rec, palm + I.J_POS)
      st.palmValid = rec[palm + I.J_VALID] > 0.5
      // The hand gamepad, Quest Browser's layout: 0 the index pinch (select), 4 the menu gesture (left hand's palm
      // pinch). The record's middle/ring/little pinches (slots 1..3) have no place there.
      const values = st.buttonValues, pressed = st.buttonPressed, touched = st.buttonTouched
      for (let i = 0; i < BUTTONS; i++) { values[i] = 0; pressed[i] = 0; touched[i] = 0 }
      const pinching = rec[b + I.PINCHING] > 0.5
      values[0] = rec[b + I.PINCH_STRENGTH]
      pressed[0] = pinching ? 1 : 0
      touched[0] = pinching || values[0] > 0 ? 1 : 0
      const menu = rec[b + I.BTN_PRESSED + 4] > 0.5
      values[4] = rec[b + I.BTN_VALUE + 4]
      pressed[4] = menu ? 1 : 0
      touched[4] = menu || rec[b + I.BTN_TOUCHED + 4] > 0.5 ? 1 : 0
      // WebXR joint j is OpenXR joint j + 1 (OpenXR puts the palm first); 8 floats each: pos, quat, radius
      const joints = st.joints, valid = st.jointValid
      for (let j = 0; j < 25; j++) {
        const o = b + I.JOINTS + (j + 1) * I.JOINT_STRIDE
        const d = j * 8
        for (let k = 0; k < 8; k++) joints[d + k] = rec[o + k]
        valid[j] = rec[o + I.J_VALID] > 0.5 ? 1 : 0
      }
      return
    }
    st.mode = XRHostInputMode.None
  }

  reset() { this.held[0][0] = this.held[0][1] = this.held[1][0] = this.held[1][1] = false }
}
