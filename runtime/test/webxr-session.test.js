import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, ALL_FEATURES, flush, makeFrame, F } from './webxr-fake.test.js'

test('isSessionSupported: immersive-vr only, and only when native says so', async () => {
  const h = harness()
  assert.equal(await h.g.navigator.xr.isSessionSupported('immersive-vr'), true)
  assert.equal(await h.g.navigator.xr.isSessionSupported('immersive-ar'), false)
  assert.equal(await h.g.navigator.xr.isSessionSupported('inline'), false)
  const h2 = harness({}, { supported: () => false })
  assert.equal(await h2.g.navigator.xr.isSessionSupported('immersive-vr'), false)
  await assert.rejects(h2.g.navigator.xr.requestSession('immersive-vr'), { name: 'NotSupportedError' })
})

test('requestSession waits until the headset session is running, then opens on the state event', async () => {
  let presenting = false
  const h = harness({}, { state: () => ({ running: presenting, visible: false, focused: false, rate: 72 }) })  // IDLE, then READY

  let session = null
  const pending = h.g.navigator.xr.requestSession('immersive-vr', ALL_FEATURES).then((s) => { session = s })
  await flush()
  assert.equal(session, null)
  await assert.rejects(h.g.navigator.xr.requestSession('immersive-vr'), { name: 'InvalidStateError' })
  presenting = true
  h.event('state', 0, 0)  // READY: not visible yet, but the native session has begun
  await pending
  assert.ok(session)
  assert.ok(session.enabledFeatures.includes('local-floor'))
  assert.equal(session.visibilityState, 'hidden')
})

test('a session opened while the runtime is READY starts hidden: no rAF callbacks until the state event says visible', async () => {
  let visible = false
  const h = harness({}, { state: () => ({ running: true, visible, focused: visible, rate: 72 }) })
  const s = await h.session()
  assert.equal(s.visibilityState, 'hidden')
  const seen = []
  s.addEventListener('visibilitychange', () => seen.push(s.visibilityState))
  s.requestAnimationFrame(() => seen.push('frame'))
  h.tick()
  assert.deepEqual(seen, [], 'frames before VISIBLE are not handed to the page')
  visible = true
  h.event('state', 1, 1)  // FOCUSED
  assert.deepEqual(seen, ['visible'])
  h.tick()
  assert.deepEqual(seen, ['visible', 'frame'])
  // opened once the runtime is already focused: visible from the start, as a browser's session is
  await s.end()
  const s2 = await h.session()
  assert.equal(s2.visibilityState, 'visible')
})


test('requestSession rejects unsupported modes and required features, drops unsupported optional ones', async () => {
  const h = harness()
  await assert.rejects(h.g.navigator.xr.requestSession('immersive-ar'), { name: 'NotSupportedError' })
  await assert.rejects(h.g.navigator.xr.requestSession('inline'), { name: 'NotSupportedError' })
  await assert.rejects(h.g.navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['hit-test'] }), { name: 'NotSupportedError' })
  await assert.rejects(h.g.navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor', 'depth-sensing'] }), { name: 'NotSupportedError' })
  const s = await h.g.navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['bounded-floor', 'layers', 'hand-tracking', 'anchors', 'plane-detection', 'mesh-detection', 'depth-sensing', 'hit-test', 'dom-overlay'],
  })
  assert.ok(s instanceof h.g.XRSession)
  assert.deepEqual([...s.enabledFeatures].sort(), ['bounded-floor', 'hand-tracking', 'layers', 'local', 'local-floor', 'viewer'])
  assert.equal(s.environmentBlendMode, 'opaque')
  assert.equal(s.interactionMode, 'world-space')
  assert.equal(s.visibilityState, 'visible')
  assert.equal(s.isSystemKeyboardSupported, false)
  assert.equal(s.renderState.depthNear, 0.1)
  assert.equal(s.renderState.depthFar, 1000)
  assert.equal(s.renderState.baseLayer, null)
  assert.deepEqual([...s.renderState.layers], [])
  assert.equal(s.renderState.inlineVerticalFieldOfView, null)
  // a second immersive session while one is live is refused
  await assert.rejects(h.g.navigator.xr.requestSession('immersive-vr'), { name: 'InvalidStateError' })
})

test('offerSession stays pending unless config.xr.autoEnter', async () => {
  const h = harness({ autoEnter: false })
  let settled = false
  h.g.navigator.xr.offerSession('immersive-vr', ALL_FEATURES).then(() => { settled = true }, () => { settled = true })
  await flush(); await flush()
  assert.equal(settled, false)
  const h2 = harness({ autoEnter: true })
  const s = await h2.g.navigator.xr.offerSession('immersive-vr', ALL_FEATURES)
  assert.ok(s instanceof h2.g.XRSession)
})

test('requestReferenceSpace: the four kinds, unbounded refused, bounded-floor carries the stage rect', async () => {
  const h = harness()
  const s = await h.session()
  for (const t of ['viewer', 'local', 'local-floor']) assert.ok((await s.requestReferenceSpace(t)) instanceof h.g.XRReferenceSpace)
  const b = await s.requestReferenceSpace('bounded-floor')
  assert.ok(b instanceof h.g.XRBoundedReferenceSpace)
  assert.deepEqual(b.boundsGeometry, [])  // no swapchain yet: stage unknown
  new h.g.XRWebGLBinding(s, {}).createProjectionLayer({ textureType: 'texture-array' })
  assert.equal(b.boundsGeometry.length, 4)
  // the stage rect's corners, clockwise seen from above
  assert.deepEqual(b.boundsGeometry.map((p) => [p.x, p.y, p.z]), [[1, 0, 1.5], [-1, 0, 1.5], [-1, 0, -1.5], [1, 0, -1.5]])
  await assert.rejects(s.requestReferenceSpace('unbounded'), { name: 'NotSupportedError' })
  const s2h = harness()
  const s2 = await s2h.session({ optionalFeatures: [] })
  await assert.rejects(s2.requestReferenceSpace('local-floor'), { name: 'NotSupportedError' })
  assert.ok(await s2.requestReferenceSpace('local'))
})

test('frame loop: rAF callbacks run with (time, XRFrame), window hook after, pending render state applied first', async () => {
  const h = harness()
  const s = await h.session()
  const seen = []
  h.g.__hostRunWindowFrame = (t) => seen.push(['window', t])
  const handle = s.requestAnimationFrame((t, f) => {
    seen.push(['xr', t, f instanceof h.g.XRFrame, f.session === s, f.predictedDisplayTime, s.renderState.depthNear])
    s.requestAnimationFrame(() => seen.push(['next']))  // re-request inside runs NEXT frame, not this one
  })
  assert.ok(handle > 0)
  const cancelled = s.requestAnimationFrame(() => seen.push(['cancelled']))
  s.cancelAnimationFrame(cancelled)
  s.updateRenderState({ depthNear: 0.05, depthFar: 500 })
  assert.equal(s.renderState.depthNear, 0.1)  // not yet
  h.frame[F.TIME] = 1234
  h.tick()
  assert.deepEqual(seen, [['xr', 1234, true, true, 1234, 0.05], ['window', 1234]])
  assert.equal(s.renderState.depthFar, 500)
  h.tick()
  assert.deepEqual(seen[2], ['next'])
  assert.equal(seen.length, 4)
})

test('a throwing rAF callback is logged and does not stop the frame', async () => {
  const h = harness()
  const logs = []
  h.native.log = (l, t) => logs.push([l, t])
  const s = await h.session()
  let ran = false
  s.requestAnimationFrame(() => { throw new Error('boom') })
  s.requestAnimationFrame(() => { ran = true })
  h.tick()
  assert.equal(ran, true)
  assert.ok(logs.some(([l, t]) => l === 3 && /boom/.test(t)))
})

test('end() reverts state: native end, end event, flat frames resumed, a new session allowed', async () => {
  const h = harness()
  let resumed = 0
  h.g.__hostResumeFlatFrames = () => resumed++
  const s = await h.session()
  const ended = []
  s.addEventListener('end', (e) => ended.push(e.session === s && e instanceof h.g.XRSessionEvent))
  s.onend = (e) => ended.push('onend')
  new h.g.XRWebGLBinding(s, {}).createProjectionLayer({ textureType: 'texture-array' })
  assert.ok(h.xr.begun)
  s.requestAnimationFrame(() => {})
  await s.end()
  assert.equal(h.xr.ended, 1)
  assert.deepEqual(ended, [true, 'onend'])
  assert.equal(resumed, 1)
  assert.equal(s.requestAnimationFrame(() => {}), 0)
  assert.throws(() => s.updateRenderState({ depthNear: 1 }), { name: 'InvalidStateError' })
  await assert.rejects(s.end(), { name: 'InvalidStateError' })
  await assert.rejects(s.requestReferenceSpace('local'))
  assert.equal(s.inputSources.length, 0)
  // frames arriving after the end are ignored
  let ran = false
  h.g.__hostRunWindowFrame = () => { ran = true }
  h.tick()
  assert.equal(ran, false)
  const s2 = await h.session()
  assert.ok(s2 instanceof h.g.XRSession)
})

test('end() inside a frame callback finishes the frame first and lands on a posted task', async () => {
  const h = harness()
  const s = await h.session()
  const order = []
  s.addEventListener('end', () => order.push('end-event'))
  let p
  s.requestAnimationFrame(() => { p = s.end(); order.push('cb1') })
  s.requestAnimationFrame(() => order.push('cb2'))
  h.g.__hostRunWindowFrame = () => order.push('window')
  h.tick()
  assert.deepEqual(order, ['cb1', 'cb2', 'window'])
  assert.equal(h.xr.ended, 0)
  await p
  assert.equal(h.xr.ended, 1)
  assert.deepEqual(order, ['cb1', 'cb2', 'window', 'end-event'])
})

test('native end event ends the session without calling native end again', async () => {
  const h = harness()
  const s = await h.session()
  let ended = 0
  s.addEventListener('end', () => ended++)
  h.event('end')
  assert.equal(ended, 1)
  assert.equal(h.xr.ended, 0)
  assert.equal(h.ctx.session, null)
})

test('visibility: state events map to visibilityState and pause the XR rAF, not the window hook', async () => {
  const h = harness()
  const s = await h.session()
  const vis = []
  s.addEventListener('visibilitychange', () => vis.push(s.visibilityState))
  h.event('state', 1, 0)
  h.event('state', 1, 0)  // no change, no event
  h.event('state', 0, 0)
  h.event('state', 1, 1)
  assert.deepEqual(vis, ['visible-blurred', 'hidden', 'visible'])
  h.event('state', 0, 0)
  let xrRan = 0, winRan = 0
  s.requestAnimationFrame(() => xrRan++)
  h.g.__hostRunWindowFrame = () => winRan++
  h.tick()
  assert.equal(xrRan, 0); assert.equal(winRan, 1)
  h.event('state', 1, 1)
  h.tick()
  assert.equal(xrRan, 1); assert.equal(winRan, 2)
})

test('refresh rate: supportedFrameRates after begin, updateTargetFrameRate resolves on the rate event', async () => {
  const h = harness({ preferredRate: 90, foveation: 0.5 })
  const s = await h.session()
  assert.equal(s.supportedFrameRates.length, 0)
  assert.equal(s.frameRate ?? null, null)
  new h.g.XRWebGLBinding(s, {}).createProjectionLayer({ textureType: 'texture-array' })
  assert.equal(h.xr.begun.preferredRate, 90)
  assert.equal(h.xr.begun.foveation, 0.5)
  assert.ok(s.supportedFrameRates instanceof Float32Array)
  assert.deepEqual([...s.supportedFrameRates], [72, 80, 90, 120])
  assert.equal(s.frameRate, 72)
  await assert.rejects(s.updateTargetFrameRate(144), { name: 'InvalidStateError' })
  await s.updateTargetFrameRate(72)  // already there
  assert.deepEqual(h.xr.rateRequests, [])
  const changes = []
  s.addEventListener('frameratechange', () => changes.push(s.frameRate))
  let done = false
  const p = s.updateTargetFrameRate(90).then(() => { done = true })
  assert.deepEqual(h.xr.rateRequests, [90])
  await flush()
  assert.equal(done, false)
  h.event('rate', 90)
  await p
  assert.deepEqual(changes, [90])
  assert.equal(s.frameRate, 90)
  // the record's rate column is a second source of truth
  const f = makeFrame({ rate: 120 })
  h.tick(f)
  assert.equal(s.frameRate, 120)
  assert.deepEqual(changes, [90, 120])
})

test('reset: a native reset event fires on every live reference space', async () => {
  const h = harness()
  const s = await h.session()
  const a = await s.requestReferenceSpace('local-floor')
  const b = a.getOffsetReferenceSpace(new h.g.XRRigidTransform({ x: 1 }))
  const got = []
  a.addEventListener('reset', (e) => got.push(['a', e.referenceSpace === a, e instanceof h.g.XRReferenceSpaceEvent]))
  b.onreset = (e) => got.push(['b', e.referenceSpace === b])
  h.event('reset')
  assert.deepEqual(got, [['a', true, true], ['b', true]])
})

test('every XR class is on the global and DOMPointReadOnly is provided when missing', () => {
  const h = harness()
  for (const n of ['XRSystem', 'XRSession', 'XRFrame', 'XRReferenceSpace', 'XRBoundedReferenceSpace', 'XRRigidTransform', 'XRView', 'XRViewerPose', 'XRInputSource', 'XRHand', 'XRJointSpace', 'XRJointPose', 'XRWebGLLayer', 'XRWebGLBinding', 'XRProjectionLayer', 'XRInputSourceEvent', 'XRInputSourcesChangeEvent', 'XRSessionEvent', 'XRReferenceSpaceEvent']) {
    assert.equal(typeof h.g[n], 'function', n)
  }
  assert.ok('createProjectionLayer' in h.g.XRWebGLBinding.prototype)
  assert.equal(typeof h.g.DOMPointReadOnly, 'function')
  const p = new h.g.DOMPointReadOnly(1, 2, 3)
  assert.deepEqual([p.x, p.y, p.z, p.w], [1, 2, 3, 1])
})
