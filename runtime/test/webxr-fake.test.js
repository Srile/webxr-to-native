// webxr-fake.test.js — the fake __native.xr and record builders the webxr
// tests drive runtime/src/webxr with (extends fake-native.js through its
// `over` argument). Exports helpers; carries one sanity test of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install } from '../src/webxr/index.js'
import { F, I, jointOffset } from '../src/webxr/record.js'

export function fakeXr(over = {}) {
  const xr = {
    supported: () => true,
    begun: null, ended: 0, frameCb: null, eventCb: null, foveation: null, rateRequests: [], vibrations: [],
    beginResult: { width: 1680, height: 1760, rates: [72, 80, 90, 120], rate: 72, hasStage: true, stageWidth: 2, stageDepth: 3, hands: true },
    begin(opts) { xr.begun = { ...opts }; return { ...xr.beginResult, arraySize: opts.arraySize } },
    end() { xr.ended++ },
    onFrame(cb) { xr.frameCb = cb },
    onEvent(cb) { xr.eventCb = cb },
    requestRefreshRate(hz) { xr.rateRequests.push(hz); return true },
    setFoveation(v) { xr.foveation = v; return true },
    vibrate(hand, amp, s, hz) { xr.vibrations.push([hand, amp, s, hz]) },
    state() { return { running: !!xr.begun, visible: true, focused: true, rate: 72 } },
    // immersive-ar (webxr-scene.test.js): a VR-only system by default
    capsResult: { passthrough: false, scene: false, capture: false, hands: true },
    caps() { return { ...xr.capsResult } },
    passthroughShown: [], captures: 0, refreshes: 0, entities: [], poses: new Float32Array(128 * 8),
    setPassthrough(on) { xr.passthroughShown.push(on) },
    requestSceneCapture() { xr.captures++; return !!xr.capsResult.capture },
    sceneRefresh() { xr.refreshes++; return true },
    sceneEntities() { return xr.entities.map((e) => ({ ...e })) },
    scenePoses() { return xr.poses },
    ...over,
  }
  return xr
}

export const IDENTITY_Q = [0, 0, 0, 1]
export const DEFAULT_FOV = [-0.9, 0.7, 0.8, -1.0]  // left, right, up, down (radians)

export function setView(frame, i, pos, quat = IDENTITY_Q, fov = DEFAULT_FOV) {
  const b = F.VIEW0 + i * F.VIEW_STRIDE
  frame[b + F.V_POS] = pos[0]; frame[b + F.V_POS + 1] = pos[1]; frame[b + F.V_POS + 2] = pos[2]
  frame[b + F.V_QUAT] = quat[0]; frame[b + F.V_QUAT + 1] = quat[1]; frame[b + F.V_QUAT + 2] = quat[2]; frame[b + F.V_QUAT + 3] = quat[3]
  frame[b + F.V_FOV_L] = fov[0]; frame[b + F.V_FOV_R] = fov[1]; frame[b + F.V_FOV_U] = fov[2]; frame[b + F.V_FOV_D] = fov[3]
}

export function setLocal(frame, pos, quat = IDENTITY_Q) {
  frame[F.LOCAL_POS] = pos[0]; frame[F.LOCAL_POS + 1] = pos[1]; frame[F.LOCAL_POS + 2] = pos[2]
  frame[F.LOCAL_QUAT] = quat[0]; frame[F.LOCAL_QUAT + 1] = quat[1]; frame[F.LOCAL_QUAT + 2] = quat[2]; frame[F.LOCAL_QUAT + 3] = quat[3]
}

export function makeFrame({ time = 1000, colorTex = 7, viewCount = 2, width = 1680, height = 1760, arraySize = 2, rate = 72 } = {}) {
  const f = new Float64Array(F.LENGTH)
  f[F.TIME] = time; f[F.SHOULD_RENDER] = 1; f[F.VIEW_COUNT] = viewCount; f[F.COLOR_TEX] = colorTex
  f[F.WIDTH] = width; f[F.HEIGHT] = height; f[F.ARRAY_SIZE] = arraySize; f[F.IMAGE_INDEX] = 0
  setView(f, 0, [-0.032, 1.6, 0])
  setView(f, 1, [0.032, 1.6, 0])
  setLocal(f, [0, 0, 0])
  f[F.RATE] = rate; f[F.BASE_KIND] = 1
  return f
}

export function makeInput() { return new Float32Array(I.LENGTH) }

// A controller: active, grip/aim poses valid, buttons/axes as given.
export function setController(input, hand, { active = 1, grip = [0.2 * (hand ? 1 : -1), 1.0, -0.3], aim = grip, values = [], pressed = [], touched = [], axes = [0, 0] } = {}) {
  const b = hand * I.STRIDE
  input[b + I.ACTIVE] = active
  input[b + I.HAND_TRACKED] = 0
  input[b + I.GRIP_VALID] = active; input.set(grip, b + I.GRIP_POS); input.set(IDENTITY_Q, b + I.GRIP_QUAT)
  input[b + I.AIM_VALID] = active; input.set(aim, b + I.AIM_POS); input.set(IDENTITY_Q, b + I.AIM_QUAT)
  for (let i = 0; i < I.BTN_COUNT; i++) {
    input[b + I.BTN_VALUE + i] = values[i] ?? 0
    input[b + I.BTN_PRESSED + i] = pressed[i] ?? 0
    input[b + I.BTN_TOUCHED + i] = touched[i] ?? 0
  }
  input[b + I.AXES] = 0; input[b + I.AXES + 1] = 0; input[b + I.AXES + 2] = axes[0]; input[b + I.AXES + 3] = axes[1]
}

// A tracked hand: 26 OpenXR joints laid along +x from the wrist, radius 0.01.
// `pinches` are the four finger pinch strengths (index, middle, ring, little) native writes to button slots
// 0..3 (pressed over 0.5, like the aim bits), `menu` the left hand's menu gesture in slot 4.
export function setHand(input, hand, { tracked = 1, pinching = 0, pinchStrength = 0, pinches = [pinchStrength, 0, 0, 0], menu = 0, invalidJoint = -1, grip = [0.2 * (hand ? 1 : -1), 1.0, -0.3] } = {}) {
  const b = hand * I.STRIDE
  input[b + I.ACTIVE] = 0
  input[b + I.HAND_TRACKED] = tracked
  input[b + I.GRIP_VALID] = tracked; input.set(grip, b + I.GRIP_POS); input.set(IDENTITY_Q, b + I.GRIP_QUAT)
  input[b + I.AIM_VALID] = tracked; input.set(grip, b + I.AIM_POS); input.set(IDENTITY_Q, b + I.AIM_QUAT)
  input[b + I.PINCHING] = pinching; input[b + I.PINCH_STRENGTH] = pinchStrength
  for (let i = 0; i < I.BTN_COUNT; i++) {
    const v = i < 4 ? (pinches[i] ?? 0) : i === 4 ? (menu ? 1 : 0) : 0
    input[b + I.BTN_VALUE + i] = v; input[b + I.BTN_PRESSED + i] = v > 0.5 ? 1 : 0; input[b + I.BTN_TOUCHED + i] = v > 0 ? 1 : 0
  }
  for (let j = 0; j < I.JOINT_COUNT; j++) {
    const o = b + I.JOINTS + j * I.JOINT_STRIDE
    input[o + I.J_POS] = grip[0] + 0.01 * j; input[o + I.J_POS + 1] = grip[1]; input[o + I.J_POS + 2] = grip[2]
    input.set(IDENTITY_Q, o + I.J_QUAT)
    input[o + I.J_RADIUS] = 0.01
    input[o + I.J_VALID] = tracked && (j - 1) !== invalidJoint ? 1 : 0
  }
}

export function clearHand(input, hand) {
  input.fill(0, hand * I.STRIDE, (hand + 1) * I.STRIDE)
}

export const ALL_FEATURES = { optionalFeatures: ['local-floor', 'bounded-floor', 'layers', 'hand-tracking'] }

// install() against a fresh global object carrying node's EventTarget/Event/DOMException.
export function harness(xrConfig = {}, xrOver = {}) {
  const xr = fakeXr(xrOver)
  const native = fakeNative({ xr, config: { web: { origin: 'https://app.local', entry: 'assets/index.js' }, xr: xrConfig } })
  const g = { __native: native, EventTarget, Event, DOMException, console }
  const { xr: system, ctx } = install(g)
  // An error logged during a frame (an assertion failing inside an rAF callback: the runtime catches and logs those,
  // as a browser reports them) fails the tick. A test that replaces native.log handles its own.
  const errors = []
  native.log = (level, text) => { if (level >= 3) errors.push(text) }
  const h = {
    g, native, xr, system, ctx,
    frame: makeFrame(), input: makeInput(),
    tick(frame = h.frame, input = h.input) {
      errors.length = 0
      xr.frameCb(frame, input)
      if (errors.length) throw new Error('logged during the frame: ' + errors[0])
    },
    event(type, a = 0, b = 0) { xr.eventCb(type, a, b) },
    session: async (init = ALL_FEATURES) => g.navigator.xr.requestSession('immersive-vr', init),
  }
  return h
}

export const flush = () => new Promise((r) => setImmediate(r))

export { F, I, jointOffset }

test('webxr fake: install wires the native frame and event callbacks', () => {
  const h = harness()
  assert.equal(typeof h.xr.frameCb, 'function')
  assert.equal(typeof h.xr.eventCb, 'function')
  assert.ok(h.g.navigator.xr instanceof h.g.XRSystem)
  assert.equal(h.frame.length, F.LENGTH)
  assert.equal(h.input.length, I.LENGTH)
})
