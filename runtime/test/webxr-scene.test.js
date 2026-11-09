// webxr-scene.test.js — immersive-ar: passthrough blend, the scene sets
// (XRPlane / XRMesh), the passthroughFullyObscured hint, room capture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, flush, F } from './webxr-fake.test.js'
import { S } from '../src/webxr/record.js'

const AR_CAPS = { passthrough: true, scene: true, capture: true, hands: true }
const AR_INIT = { optionalFeatures: ['local-floor', 'bounded-floor', 'layers', 'hand-tracking', 'plane-detection', 'mesh-detection'] }

function arHarness(caps = AR_CAPS) {
  const h = harness({}, { capsResult: caps })
  h.ar = (init = AR_INIT) => h.g.navigator.xr.requestSession('immersive-ar', init)
  return h
}

function setPose(poses, slot, pos, quat = [0, 0, 0, 1]) {
  const b = slot * S.STRIDE
  poses[b + S.VALID] = 1
  poses.set(pos, b + S.POS); poses.set(quat, b + S.QUAT)
}

const PLANE = { slot: 0, id: 'p-1', kind: 1, label: 'floor', changed: 1, polygon: new Float32Array([-1, -2, 1, -2, 1, 2, -1, 2]) }
const MESH = { slot: 1, id: 'm-1', kind: 2, label: 'global mesh', changed: 1, vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }

test('immersive-ar is offered only where the system has passthrough; the scene features only with scene understanding', async () => {
  const vr = harness()
  assert.equal(await vr.g.navigator.xr.isSessionSupported('immersive-ar'), false)
  await assert.rejects(vr.g.navigator.xr.requestSession('immersive-ar'), { name: 'NotSupportedError' })
  const pt = arHarness({ passthrough: true, scene: false, capture: false, hands: true })
  assert.equal(await pt.g.navigator.xr.isSessionSupported('immersive-ar'), true)
  const s1 = await pt.ar()
  assert.equal(s1.environmentBlendMode, 'alpha-blend')
  assert.ok(!s1.enabledFeatures.includes('plane-detection'))
  await assert.rejects(pt.ar({ requiredFeatures: ['mesh-detection'] }).catch((e) => { throw e }), { name: 'InvalidStateError' })  // a second session: s1 is live
  await s1.end()
  await assert.rejects(pt.g.navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['mesh-detection'] }), { name: 'NotSupportedError' })
  const h = arHarness()
  const s = await h.ar()
  assert.deepEqual([...s.enabledFeatures].sort(), ['bounded-floor', 'hand-tracking', 'layers', 'local', 'local-floor', 'mesh-detection', 'plane-detection', 'viewer'])
  // VR sessions never see the scene features
  await s.end()
  const v = await h.g.navigator.xr.requestSession('immersive-vr', AR_INIT)
  assert.equal(v.environmentBlendMode, 'opaque')
  assert.ok(!v.enabledFeatures.includes('plane-detection'))
})

test('an AR session begins the swapchain with passthrough and scene; unpremultiplied follows the GL context', async () => {
  const h = arHarness()
  const s = await h.ar()
  new h.g.XRWebGLBinding(s, { getContextAttributes: () => ({ premultipliedAlpha: true }) }).createProjectionLayer({ textureType: 'texture-array' })
  assert.deepEqual(h.xr.begun, { arraySize: 2, scale: 1, format: 0x8058, passthrough: 1, scene: 1 })
  await s.end()
  const s2 = await h.ar()
  new h.g.XRWebGLLayer(s2, { getContextAttributes: () => ({ premultipliedAlpha: false }), createFramebuffer: () => ({}) })
  assert.equal(h.xr.begun.passthrough, 1)
  assert.equal(h.xr.begun.unpremultiplied, 1)
  await s2.end()
  // a VR session asks for neither
  const v = await h.g.navigator.xr.requestSession('immersive-vr', AR_INIT)
  new h.g.XRWebGLBinding(v, {}).createProjectionLayer({ textureType: 'texture-array' })
  assert.deepEqual(h.xr.begun, { arraySize: 2, scale: 1, format: 0x8058 })
})

test('detectedPlanes / detectedMeshes follow the native list by generation, keep identity, and pose through the record', async () => {
  const h = arHarness()
  const s = await h.ar()
  const ref = await s.requestReferenceSpace('local-floor')
  let sizes = null
  s.requestAnimationFrame((t, f) => { sizes = [f.detectedPlanes.size, f.detectedMeshes.size] })
  h.tick()
  assert.deepEqual(sizes, [0, 0])

  h.xr.entities = [PLANE, MESH]
  setPose(h.xr.poses, 0, [1, 0, -2])
  setPose(h.xr.poses, 1, [0, 1, 0], [0, 0.70710678, 0, 0.70710678])
  h.frame[F.SCENE_GEN] = 1
  let plane, mesh
  s.requestAnimationFrame((t, f) => {
    assert.equal(f.detectedPlanes.size, 1); assert.equal(f.detectedMeshes.size, 1)
    plane = [...f.detectedPlanes][0]; mesh = [...f.detectedMeshes][0]
    assert.ok(plane instanceof h.g.XRPlane); assert.ok(mesh instanceof h.g.XRMesh)
    assert.equal(plane.semanticLabel, 'floor'); assert.equal(plane.orientation, 'horizontal')
    assert.equal(plane.polygon.length, 4)
    assert.equal(plane.polygon[0].x, -1); assert.equal(plane.polygon[0].y, 0); assert.equal(plane.polygon[0].z, -2)
    assert.equal(plane.lastChangedTime, t)
    assert.equal(mesh.semanticLabel, 'global mesh'); assert.equal(mesh.vertices.length, 9); assert.equal(mesh.indices.length, 3)
    const pp = f.getPose(plane.planeSpace, ref)
    assert.ok(pp); assert.equal(pp.transform.position.x, 1); assert.equal(pp.transform.position.z, -2)
    const mp = f.getPose(mesh.meshSpace, ref)
    assert.ok(mp); assert.equal(mp.transform.position.y, 1)
    assert.ok(Math.abs(mp.transform.orientation.y - 0.70710678) < 1e-6)
  })
  h.tick()
  assert.ok(plane && mesh)

  // same generation → nothing refetched; the objects stay the same; a pose that goes invalid keeps the last one
  h.xr.poses[0 * S.STRIDE + S.VALID] = 0
  s.requestAnimationFrame((t, f) => {
    assert.equal([...f.detectedPlanes][0], plane); assert.equal([...f.detectedMeshes][0], mesh)
    assert.equal(f.getPose(plane.planeSpace, ref).transform.position.x, 1)  // not locatable this frame: the last pose
  })
  h.tick()

  // the mesh changes (new geometry, same id): same object, new vertices, new lastChangedTime
  h.xr.entities = [PLANE, { ...MESH, changed: 2, vertices: new Float32Array(18), indices: new Uint32Array(6), label: 'global mesh' }]
  h.frame[F.SCENE_GEN] = 2
  h.frame[F.TIME] = 2000
  s.requestAnimationFrame((t, f) => {
    const m = [...f.detectedMeshes][0]
    assert.equal(m, mesh); assert.equal(m.vertices.length, 18); assert.equal(m.lastChangedTime, 2000)
    assert.equal([...f.detectedPlanes][0].lastChangedTime, 1000)
  })
  h.tick()

  // the plane disappears from the list
  h.xr.entities = [{ ...MESH, slot: 0, changed: 2, vertices: new Float32Array(18), indices: new Uint32Array(6) }]
  setPose(h.xr.poses, 0, [5, 5, 5])
  h.frame[F.SCENE_GEN] = 3
  s.requestAnimationFrame((t, f) => {
    assert.equal(f.detectedPlanes.size, 0); assert.equal(f.detectedMeshes.size, 1)
    assert.equal([...f.detectedMeshes][0], mesh)
    assert.equal(f.getPose(mesh.meshSpace, ref).transform.position.x, 5)  // the slot moved with it
  })
  h.tick()
  await s.end()
  // a new session starts from an empty scene and fetches the list again
  const s2 = await h.ar()
  let after = null
  s2.requestAnimationFrame((t, f) => { after = [f.detectedPlanes.size, f.detectedMeshes.size] })
  h.tick()
  assert.deepEqual(after, [0, 1])
})

test('plane orientation falls back to the pose when the label says nothing', async () => {
  const h = arHarness()
  const s = await h.ar()
  h.xr.entities = [{ ...PLANE, label: 'other' }]
  setPose(h.xr.poses, 0, [0, 1, 0], [0.70710678, 0, 0, 0.70710678])  // +Y turned onto -Z: a vertical surface
  h.frame[F.SCENE_GEN] = 1
  let o
  s.requestAnimationFrame((t, f) => { o = [...f.detectedPlanes][0].orientation })
  h.tick()
  assert.equal(o, 'vertical')
})

test('passthroughFullyObscured reaches native once per change and reads back from the render state', async () => {
  const h = arHarness()
  const s = await h.ar()
  assert.equal(s.renderState.passthroughFullyObscured, undefined)
  s.updateRenderState({ passthroughFullyObscured: true })
  h.tick()
  assert.equal(s.renderState.passthroughFullyObscured, true)
  assert.deepEqual(h.xr.passthroughShown, [false])
  h.tick()
  assert.deepEqual(h.xr.passthroughShown, [false])
  s.updateRenderState({ depthNear: 0.2 })
  h.tick()
  assert.equal(s.renderState.passthroughFullyObscured, true)  // carried over like the other fields
  s.updateRenderState({ passthroughFullyObscured: false })
  h.tick()
  assert.deepEqual(h.xr.passthroughShown, [false, true])
  await s.end()
  // VR sessions never touch it
  const v = await h.g.navigator.xr.requestSession('immersive-vr', AR_INIT)
  v.updateRenderState({ passthroughFullyObscured: true })
  h.tick()
  assert.deepEqual(h.xr.passthroughShown, [false, true])
})

test('initiateRoomCapture resolves on the native scenecapture event, rejects where capture is unavailable', async () => {
  const h = arHarness()
  const s = await h.ar()
  let done = false
  const p = s.initiateRoomCapture().then(() => { done = true })
  await flush()
  assert.equal(h.xr.captures, 1); assert.equal(done, false)
  h.event('scenecapture', 1)
  await p
  assert.equal(done, true)
  await s.end()
  const h2 = arHarness({ passthrough: true, scene: true, capture: false, hands: true })
  const s2 = await h2.ar()
  await assert.rejects(s2.initiateRoomCapture(), { name: 'NotSupportedError' })
  await s2.end()
  const v = await h2.g.navigator.xr.requestSession('immersive-vr')
  await assert.rejects(v.initiateRoomCapture(), { name: 'NotSupportedError' })
})
