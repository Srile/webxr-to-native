import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, setController, setHand, clearHand, I, jointOffset } from './webxr-fake.test.js'
import { JOINT_NAMES } from '../src/webxr/record.js'

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

async function session(h, init) {
  const s = await h.session(init)
  const changes = [], events = []
  s.addEventListener('inputsourceschange', (e) => changes.push({
    cls: e instanceof h.g.XRInputSourcesChangeEvent, session: e.session === s,
    added: e.added.map((x) => x.handedness + ':' + (x.hand ? 'hand' : 'ctrl')),
    removed: e.removed.map((x) => x.handedness + ':' + (x.hand ? 'hand' : 'ctrl')),
  }))
  for (const t of ['selectstart', 'selectend', 'select', 'squeezestart', 'squeezeend', 'squeeze']) {
    s.addEventListener(t, (e) => events.push(t + ':' + e.inputSource.handedness + (e instanceof h.g.XRInputSourceEvent && e.frame instanceof h.g.XRFrame ? '' : '!')))
  }
  return { s, changes, events }
}

test('input sources: controllers appear once tracked, switch to hands, and back', async () => {
  const h = harness()
  const { s, changes } = await session(h)
  assert.equal(s.inputSources.length, 0)
  h.tick()
  assert.equal(changes.length, 0)
  setController(h.input, 0); setController(h.input, 1)
  h.tick()
  assert.deepEqual(changes, [{ cls: true, session: true, added: ['left:ctrl', 'right:ctrl'], removed: [] }])
  assert.equal(s.inputSources.length, 2)
  assert.equal(s.trackedSources, s.inputSources)
  assert.ok(s.inputSources instanceof h.g.XRInputSourceArray)
  const left = s.inputSources[0]
  assert.ok(left instanceof h.g.XRInputSource)
  assert.equal(left.handedness, 'left')
  assert.equal(left.targetRayMode, 'tracked-pointer')
  assert.deepEqual([...left.profiles], ['oculus-touch-v3', 'oculus-touch-v2', 'oculus-touch', 'generic-trigger-squeeze-thumbstick'])
  assert.equal(left.hand ?? null, null)
  assert.ok(left.gripSpace instanceof h.g.XRSpace && left.targetRaySpace instanceof h.g.XRSpace)
  assert.notEqual(left.gripSpace, left.targetRaySpace)
  assert.equal(left.gamepad.connected, true)
  // same frame again: no change, same objects
  h.tick()
  assert.equal(changes.length, 1)
  assert.equal(s.inputSources[0], left)
  // left controller down, left hand up
  clearHand(h.input, 0); setHand(h.input, 0)
  h.tick()
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[1].removed, ['left:ctrl']); assert.deepEqual(changes[1].added, ['left:hand'])
  assert.equal(left.gamepad.connected, false)
  const lh = s.inputSources[0]
  assert.equal(lh.handedness, 'left')
  assert.ok(lh.hand instanceof h.g.XRHand)
  assert.deepEqual([...lh.profiles], ['oculus-hand', 'generic-hand', 'generic-hand-select', 'generic-trigger'])  // Quest Browser's
  assert.equal(s.inputSources[1].handedness, 'right')
  // controller back: the SAME controller source object returns
  setController(h.input, 0)
  h.tick()
  assert.deepEqual(changes[2].removed, ['left:hand']); assert.deepEqual(changes[2].added, ['left:ctrl'])
  assert.equal(s.inputSources[0], left)
  // both gone
  clearHand(h.input, 0); clearHand(h.input, 1)
  h.tick()
  assert.deepEqual(changes[3].removed, ['left:ctrl', 'right:ctrl'])
  assert.equal(s.inputSources.length, 0)
})

test('hands never appear without the hand-tracking feature', async () => {
  const h = harness()
  const { s, changes } = await session(h, { optionalFeatures: ['local-floor'] })
  setHand(h.input, 0); setHand(h.input, 1)
  h.tick()
  assert.equal(changes.length, 0)
  assert.equal(s.inputSources.length, 0)
})

test('gamepad: xr-standard layout, button objects mutated in place, axes live', async () => {
  const h = harness()
  const { s } = await session(h)
  setController(h.input, 1, { values: [0.3, 0, 0, 0, 1], pressed: [0, 0, 0, 0, 1], touched: [1, 0, 0, 1], axes: [0.5, -0.25] })
  h.frame[0] = 777
  h.tick()
  const gp = s.inputSources[0].gamepad
  assert.equal(gp.mapping, 'xr-standard')
  assert.equal(gp.id, '')  // WebXR Gamepads Module: an XR gamepad's id is empty
  assert.equal(gp.index, -1)
  assert.equal(gp.timestamp, 777)
  assert.equal(gp.buttons.length, 7)  // the right Touch controller as Quest Browser lays it out: the menu is the left's (7)
  assert.equal(gp.axes.length, 4)
  const buttons = gp.buttons, axes = gp.axes, b0 = buttons[0], b4 = buttons[4]
  near(b0.value, 0.3); assert.equal(b0.pressed, false); assert.equal(b0.touched, true)
  assert.equal(b4.pressed, true); assert.equal(b4.touched, true); assert.equal(b4.value, 1)
  assert.equal(buttons[3].touched, true)
  assert.deepEqual([...axes], [0, 0, 0.5, -0.25])
  setController(h.input, 1, { values: [0.9], pressed: [1], axes: [0, 1] })
  h.tick()
  assert.equal(gp.buttons, buttons); assert.equal(gp.buttons[0], b0); assert.equal(gp.buttons[4], b4); assert.equal(gp.axes, axes)
  near(b0.value, 0.9); assert.equal(b0.pressed, true); assert.equal(b4.pressed, false)
  assert.deepEqual([...axes], [0, 0, 0, 1])
  assert.equal(gp.hapticActuators.length, 1)
  assert.equal(gp.hapticActuators[0].type, 'vibration')
  const ok = await gp.hapticActuators[0].pulse(0.8, 20)
  assert.equal(ok, true)
  assert.deepEqual(h.xr.vibrations, [[1, 0.8, 0.02, 0]])
})

test('select events at the trigger threshold, with hysteresis; squeeze from the grip', async () => {
  const h = harness()
  const { events } = await session(h)
  setController(h.input, 0, { values: [0.5] })
  h.tick()
  assert.deepEqual(events, [])
  setController(h.input, 0, { values: [0.75] })
  h.tick()
  assert.deepEqual(events, ['selectstart:left'])
  setController(h.input, 0, { values: [0.65] })  // above the release threshold: still selecting
  h.tick()
  assert.deepEqual(events, ['selectstart:left'])
  setController(h.input, 0, { values: [0.1] })
  h.tick()
  assert.deepEqual(events, ['selectstart:left', 'select:left', 'selectend:left'])  // WebXR: select, then selectend
  // the native pressed flag alone also selects
  setController(h.input, 0, { values: [0.2], pressed: [1] })
  h.tick()
  setController(h.input, 0, { values: [0, 0.9], pressed: [0, 1] })
  h.tick()
  assert.deepEqual(events.slice(3), ['selectstart:left', 'select:left', 'selectend:left', 'squeezestart:left'])
  // a source removed mid-squeeze gets its squeezeend before it goes
  clearHand(h.input, 0)
  h.tick()
  assert.deepEqual(events.slice(7), ['squeezeend:left'])
})

test('hands: 25 joints in spec order, pinch selects, fillPoses writes 25×16 floats', async () => {
  const h = harness()
  const { s, events } = await session(h)
  setHand(h.input, 1, { grip: [0.3, 1.0, -0.4] })
  const floor = await s.requestReferenceSpace('local-floor')
  h.tick()
  const src = s.inputSources[0]
  const hand = src.hand
  assert.equal(hand.size, 25)
  assert.deepEqual([...hand.keys()], [...JOINT_NAMES])
  assert.equal(hand.get('wrist').jointName, 'wrist')
  assert.equal(hand.get('index-finger-tip').jointName, 'index-finger-tip')
  assert.ok(hand.get('thumb-tip') instanceof h.g.XRJointSpace)
  let n = 0
  hand.forEach((j, name) => { assert.equal(j.jointName, name); n++ })
  assert.equal(n, 25)
  assert.equal([...hand.values()].length, 25)
  assert.equal([...hand].length, 25)
  const joints = [...hand.values()]
  const out = new Float32Array(25 * 16)
  s.requestAnimationFrame((t, f) => {
    assert.equal(f.fillPoses(joints, floor, out), true)
    // joint i (WebXR) is OpenXR joint i+1 at x = grip.x + 0.01 * (i + 1)
    for (let i = 0; i < 25; i++) {
      near(out[i * 16 + 12], 0.3 + 0.01 * (i + 1)); near(out[i * 16 + 13], 1.0); near(out[i * 16 + 15], 1)
    }
    assert.equal(f.fillPoses(hand.values(), floor, out), true)  // an iterable works too
    const jp = f.getJointPose(hand.get('thumb-tip'), floor)
    assert.ok(jp instanceof h.g.XRJointPose)
    near(jp.radius, 0.01)
    near(jp.transform.position.x, 0.3 + 0.01 * 5)
    // a joint as the base: index tip relative to thumb tip (IWSDK's pinch measure)
    const rel = f.getPose(hand.get('index-finger-tip'), hand.get('thumb-tip'))
    near(rel.transform.position.x, 0.05)
    const radii = new Float32Array(25)
    assert.equal(f.fillJointRadii(joints, radii), true)
    near(radii[24], 0.01)
    assert.throws(() => f.fillPoses(joints, floor, new Float32Array(10)))  // too short (IWER: a DOMException; WebXR says TypeError)
    // the controller's grip pose comes through getPose as well
    const grip = f.getPose(src.gripSpace, floor)
    near(grip.transform.position.x, 0.3)
  })
  h.tick()
  // one untracked joint → false, that joint's slot NaN, the rest written
  setHand(h.input, 1, { grip: [0.3, 1.0, -0.4], invalidJoint: 3 })
  out.fill(-1)
  s.requestAnimationFrame((t, f) => {
    assert.equal(f.fillPoses(joints, floor, out), false)
    assert.ok(Number.isNaN(out[3 * 16 + 12]))
    near(out[4 * 16 + 12], 0.3 + 0.05)
    assert.equal(f.getJointPose(joints[3], floor), null)
    const radii = new Float32Array(25)
    assert.equal(f.fillJointRadii(joints, radii), false)
    assert.ok(Number.isNaN(radii[3]))
  })
  h.tick()
  // pinch → select
  assert.deepEqual(events, [])
  setHand(h.input, 1, { pinching: 1, pinchStrength: 1 })
  h.tick()
  assert.deepEqual(events, ['selectstart:right'])
  assert.equal(src.gamepad.buttons[0].pressed, true)
  assert.equal(src.gamepad.mapping, 'xr-standard')  // the hand gamepad as Quest Browser lays it out
  setHand(h.input, 1, { pinching: 0, pinchStrength: 0.2 })
  h.tick()
  assert.deepEqual(events, ['selectstart:right', 'select:right', 'selectend:right'])
  near(src.gamepad.buttons[0].value, 0.2)
})

test('getPose returns null for a source whose pose is invalid', async () => {
  const h = harness()
  const { s } = await session(h)
  setController(h.input, 0)
  h.input[0 * I.STRIDE + I.GRIP_VALID] = 0
  const floor = await s.requestReferenceSpace('local-floor')
  s.requestAnimationFrame((t, f) => {
    const src = s.inputSources[0]
    assert.equal(f.getPose(src.gripSpace, floor), null)
    assert.ok(f.getPose(src.targetRaySpace, floor) !== null)
  })
  h.tick()
  assert.equal(jointOffset(1, 0), I.STRIDE + I.JOINTS + I.JOINT_STRIDE)
})

test('session end disconnects the gamepads and empties the list', async () => {
  const h = harness()
  const { s } = await session(h)
  setController(h.input, 0); setController(h.input, 1)
  h.tick()
  const gp = s.inputSources[0].gamepad
  await s.end()
  assert.equal(gp.connected, false)
  assert.equal(s.inputSources.length, 0)
})

test('hand gamepad: five buttons — index pinch selects, the menu gesture sits at 4, the grip is the palm', async () => {
  const h = harness()
  const { s } = await session(h)
  const selects = []
  s.addEventListener('selectstart', (e) => selects.push('start:' + e.inputSource.handedness))
  s.addEventListener('select', (e) => selects.push('select:' + e.inputSource.handedness))
  clearHand(h.input, 0); clearHand(h.input, 1)
  setHand(h.input, 0, { pinches: [0.2, 0.9, 0, 0], menu: 1 })
  h.tick()
  const lh = s.inputSources[0]
  assert.ok(lh.hand)
  const gp = lh.gamepad
  assert.equal(gp.buttons.length, 10)  // Quest Browser's hand layout: pinch, three empty, menu, five microgestures
  assert.equal(gp.mapping, 'xr-standard')
  const buttons = gp.buttons
  near(buttons[0].value, 0); assert.equal(buttons[0].pressed, false)  // button 0 is the record's own pinch fields
  near(buttons[1].value, 0); assert.equal(buttons[1].pressed, false)  // the middle pinch has no slot in Quest Browser's layout
  assert.equal(buttons[2].pressed, false); assert.equal(buttons[2].touched, false)
  assert.equal(buttons[4].pressed, true); assert.equal(buttons[4].value, 1)  // the game's HAND_MENU_BUTTON
  assert.deepEqual(selects, [])
  // the index pinch closes: select fires off button 0, the menu lets go
  setHand(h.input, 0, { pinching: 1, pinchStrength: 1, pinches: [1, 0, 0, 0], menu: 0 })
  h.tick()
  assert.equal(gp.buttons, buttons)
  assert.equal(buttons[0].pressed, true); near(buttons[0].value, 1)
  assert.equal(buttons[4].pressed, false)
  assert.deepEqual(selects, ['start:left'])
  setHand(h.input, 0, { pinching: 0, pinchStrength: 0 })
  h.tick()
  assert.deepEqual(selects, ['start:left', 'select:left'])
  // gripSpace poses: the record's grip (native fills it from the palm joint)
  const ref = await s.requestReferenceSpace('local-floor')
  let gripPos = null
  await new Promise((resolve) => { s.requestAnimationFrame((t, f) => { const p = f.getPose(lh.gripSpace, ref); gripPos = p ? [p.transform.position.x, p.transform.position.y, p.transform.position.z] : null; resolve() }); h.tick() })
  assert.ok(gripPos !== null)
  near(gripPos[0], -0.2)
})
