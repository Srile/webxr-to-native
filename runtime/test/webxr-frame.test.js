import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, makeFrame, setView, setLocal, F } from './webxr-fake.test.js'

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const nearArr = (a, b, eps = 1e-5) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) near(a[i], b[i], eps) }

// Runs one frame and hands the XRFrame to `fn` inside the rAF callback.
async function inFrame(h, s, fn) {
  let out
  s.requestAnimationFrame((t, f) => { out = fn(f, t) })
  h.tick()
  return out
}

test('getViewerPose: local-floor is the base space, local is base ∘ localInBase⁻¹, viewer is the head', async () => {
  const h = harness()
  const s = await h.session()
  setLocal(h.frame, [0, 1.2, 0.5])
  const floor = await s.requestReferenceSpace('local-floor')
  const local = await s.requestReferenceSpace('local')
  const viewer = await s.requestReferenceSpace('viewer')
  await inFrame(h, s, (f) => {
    const pf = f.getViewerPose(floor)
    assert.ok(pf instanceof h.g.XRViewerPose)
    assert.equal(pf.emulatedPosition, false)
    // local-floor: LOCAL's position and heading dropped to the floor (WebXR; Quest Browser), so the head at base
    // (0, 1.6, 0) with LOCAL at (0, 1.2, 0.5) is 0.5 m in front of local-floor's origin
    nearArr([pf.transform.position.x, pf.transform.position.y, pf.transform.position.z], [0, 1.6, -0.5])
    nearArr([pf.transform.orientation.x, pf.transform.orientation.y, pf.transform.orientation.z, pf.transform.orientation.w], [0, 0, 0, 1])
    assert.equal(pf.views.length, 2)
    assert.deepEqual(pf.views.map((v) => v.eye), ['left', 'right'])
    near(pf.views[0].transform.position.x, -0.032); near(pf.views[1].transform.position.x, 0.032)
    const pl = f.getViewerPose(local)
    nearArr([pl.transform.position.x, pl.transform.position.y, pl.transform.position.z], [0, 0.4, -0.5])
    near(pl.views[0].transform.position.y, 0.4)
    const pv = f.getViewerPose(viewer)
    nearArr([pv.transform.position.x, pv.transform.position.y, pv.transform.position.z], [0, 0, 0])
    near(pv.views[0].transform.position.x, -0.032); near(pv.views[1].transform.position.x, 0.032)
  })
})

test('getOffsetReferenceSpace: translation and rotation offsets', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const shifted = floor.getOffsetReferenceSpace(new h.g.XRRigidTransform({ x: 1, y: 0, z: 0 }))
  assert.ok(shifted instanceof h.g.XRReferenceSpace)
  const sq = Math.SQRT1_2
  const turned = floor.getOffsetReferenceSpace(new h.g.XRRigidTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: sq, z: 0, w: sq }))
  // head at (0, 0, -1) looking straight ahead
  setView(h.frame, 0, [0, 0, -1]); setView(h.frame, 1, [0, 0, -1])
  await inFrame(h, s, (f) => {
    const a = f.getViewerPose(shifted)
    nearArr([a.transform.position.x, a.transform.position.y, a.transform.position.z], [-1, 0, -1])
    const b = f.getViewerPose(turned)
    nearArr([b.transform.position.x, b.transform.position.y, b.transform.position.z], [1, 0, 0])
    const q = b.transform.orientation
    nearArr([q.x, q.y, q.z, q.w], [0, -sq, 0, sq])
    // the inverse transform undoes it
    const inv = b.transform.inverse
    near(inv.position.x, 0); near(inv.position.z, 1, 1e-5)  // −(R⁻¹ p) for p = (1, 0, 0), R = rotY(−90°)
    assert.equal(inv.inverse, b.transform)
  })
  const bounded = await s.requestReferenceSpace('bounded-floor')
  assert.ok(bounded.getOffsetReferenceSpace(new h.g.XRRigidTransform()) instanceof h.g.XRBoundedReferenceSpace)
})

test('view transform.matrix equals the pose matrix; projectionMatrix comes from the fov and render state', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const sq = Math.SQRT1_2
  setView(h.frame, 0, [-0.032, 1.6, 0], [0, sq, 0, sq], [-0.9, 0.7, 0.8, -1.0])
  setView(h.frame, 1, [0.032, 1.6, 0], [0, sq, 0, sq], [-0.7, 0.9, 0.8, -1.0])
  s.updateRenderState({ depthNear: 0.2, depthFar: 50 })
  await inFrame(h, s, (f) => {
    const pose = f.getViewerPose(floor)
    const v0 = pose.views[0]
    const m = v0.transform.matrix
    assert.ok(m instanceof Float32Array); assert.equal(m.length, 16)
    // the rigid transform rebuilt from position+orientation is the same matrix
    const rebuilt = new h.g.XRRigidTransform(v0.transform.position, v0.transform.orientation).matrix
    nearArr(m, rebuilt, 1e-5)
    near(m[12], -0.032); near(m[13], 1.6); near(m[14], 0)
    // the matrix IS the pose (not its inverse): the +x axis column is rotated 90° about y → -z
    near(m[0], 0, 1e-5); near(m[2], -1, 1e-5)
    const p0 = v0.projectionMatrix, p1 = pose.views[1].projectionMatrix
    assert.ok(p0 instanceof Float32Array)
    const tl = Math.tan(-0.9), tr = Math.tan(0.7), tu = Math.tan(0.8), td = Math.tan(-1.0)
    near(p0[0], 2 / (tr - tl)); near(p0[8], (tr + tl) / (tr - tl)); near(p0[9], (tu + td) / (tu - td))
    near(p0[10], -(50 + 0.2) / (50 - 0.2)); near(p0[14], -2 * 50 * 0.2 / (50 - 0.2))
    // the right eye's own (mirrored) fov
    near(p1[8], (Math.tan(0.9) + Math.tan(-0.7)) / (Math.tan(0.9) - Math.tan(-0.7)))
    assert.equal(v0.recommendedViewportScale, null)
    v0.requestViewportScale(0.5)  // no-op
  })
})

test('getPose between arbitrary spaces, and frames go inactive after their callbacks', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const viewer = await s.requestReferenceSpace('viewer')
  let stale
  await inFrame(h, s, (f) => {
    stale = f
    const p = f.getPose(viewer, floor)
    assert.ok(p instanceof h.g.XRPose)
    near(p.transform.position.y, 1.6)
    const back = f.getPose(floor, viewer)
    near(back.transform.position.y, -1.6)
    assert.equal(p.linearVelocity, undefined)
    assert.equal(f.detectedPlanes.size, 0)  // no plane-detection: an empty set (three tests it for truthiness)
    assert.equal(f.trackedAnchors.size, 0)
  })
  assert.throws(() => stale.getViewerPose(floor), { name: 'InvalidStateError' })
  assert.throws(() => stale.getPose(viewer, floor), { name: 'InvalidStateError' })
  await assert.rejects(stale.createAnchor(), { name: 'InvalidStateError' })  // an inactive frame
})

test('a one-view frame yields a single "none" view', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const f = makeFrame({ viewCount: 1 })
  setView(f, 0, [0, 1.5, 0])
  s.requestAnimationFrame((t, fr) => {
    const p = fr.getViewerPose(floor)
    assert.equal(p.views.length, 1)
    assert.equal(p.views[0].eye, 'none')
    near(p.transform.position.y, 1.5)
  })
  h.tick(f)
})

