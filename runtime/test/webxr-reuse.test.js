// No per-frame allocation on the XR path: XRFrames ping-pong, pose objects are pooled per (space, base) in two
// slots by frame parity, transforms are rewritten in place. A pose from frame N stays intact through frame N+1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, setView, setController, setHand, jointOffset } from './webxr-fake.test.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { fakeNative } from './fake-native.js'

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

async function frames(h, s, count, fn) {
  const out = []
  for (let i = 0; i < count; i++) {
    s.requestAnimationFrame((t, f) => { out.push(fn(f, i)) })
    h.tick()
  }
  return out
}

test('XRFrame: two pooled frames alternate; a stale frame is inactive until it comes round again', async () => {
  const h = harness()
  const s = await h.session()
  const seen = await frames(h, s, 4, (f) => f)
  assert.notEqual(seen[0], seen[1], 'consecutive frames are different objects')
  assert.equal(seen[0], seen[2]); assert.equal(seen[1], seen[3])
  const floor = await s.requestReferenceSpace('local-floor')
  assert.throws(() => seen[3].getViewerPose(floor), /InvalidStateError|outside the callback/)
})

test('getViewerPose: same object within a frame, the other slot next frame, values follow the record', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const poses = []
  for (let i = 0; i < 3; i++) {
    setView(h.frame, 0, [-0.03, 1 + i, 0]); setView(h.frame, 1, [0.03, 1 + i, 0])
    s.requestAnimationFrame((t, f) => {
      const a = f.getViewerPose(floor), b = f.getViewerPose(floor)
      assert.equal(a, b, 'asked twice in one frame: the same pose')
      assert.equal(a.views.length, 2)
      poses.push({ pose: a, y: a.transform.position.y, view0: a.views[0], m: a.transform.matrix, inv: a.transform.inverse })
    })
    h.tick()
    // frame N's pose is still frame N's values after frame N+1 ran
    if (i >= 1) near(poses[i - 1].pose.transform.matrix[13], 1 + (i - 1))
  }
  assert.notEqual(poses[0].pose, poses[1].pose)
  assert.equal(poses[0].pose, poses[2].pose, 'frame N+2 reuses frame N\'s pose')
  assert.equal(poses[0].view0, poses[2].view0); assert.equal(poses[0].m, poses[2].m)
  near(poses[0].y, 1); near(poses[1].y, 2)
  // the reused transform's position / inverse refreshed, and the objects kept
  near(poses[2].pose.transform.position.y, 3)
  assert.equal(poses[2].pose.transform.inverse, poses[0].inv)
  near(poses[2].pose.transform.inverse.position.y, -3)
  near(poses[2].pose.views[0].transform.position.y, 3)
  near(poses[2].pose.views[1].transform.position.x, 0.03)
})

test('getPose / getJointPose: pooled per (space, base), refreshed in place, null when untracked', async () => {
  const h = harness()
  const s = await h.session()
  const floor = await s.requestReferenceSpace('local-floor')
  const local = await s.requestReferenceSpace('local')
  setController(h.input, 1, { grip: [0.2, 1.0, -0.3] })
  setHand(h.input, 0, { grip: [-0.2, 1.1, -0.3] })
  const got = []
  for (let i = 0; i < 3; i++) {
    h.input[1 * 288 + 3 + 1] = 1 + i  // right grip y
    s.requestAnimationFrame((t, f) => {
      const right = s.inputSources.find((x) => x.handedness === 'right')
      const left = s.inputSources.find((x) => x.handedness === 'left')
      const p = f.getPose(right.gripSpace, floor)
      assert.equal(f.getPose(right.gripSpace, floor), p)
      assert.notEqual(f.getPose(right.gripSpace, local), p, 'another base is another pool')
      const wrist = left.hand.get('wrist')
      const jp = f.getJointPose(wrist, floor)
      assert.ok(jp instanceof h.g.XRJointPose)
      assert.equal(f.getJointPose(wrist, floor), jp)
      assert.notEqual(f.getPose(wrist, floor), jp, 'getPose and getJointPose pool separately')
      got.push({ p, y: p.transform.position.y, jp, r: jp.radius })
    })
    h.tick()
  }
  assert.notEqual(got[0].p, got[1].p); assert.equal(got[0].p, got[2].p)
  assert.equal(got[0].jp, got[2].jp)
  near(got[0].y, 1); near(got[1].y, 2); near(got[2].y, 3); near(got[2].p.transform.position.y, 3)
  near(got[2].r, 0.01)
  // an untracked joint answers null and leaves the pool alone (not the wrist: a hand without a tracked wrist is not listed)
  h.input[jointOffset(0, 9) + 8] = 0
  const nul = await frames(h, s, 1, (f) => f.getJointPose(s.inputSources.find((x) => x.handedness === 'left').hand.get('index-finger-tip'), floor))
  assert.equal(nul[0], null)
})

test('window rAF: queues are swapped, not reallocated; callbacks added during a frame run next frame', () => {
  const g = Object.create(null); g.__native = fakeNative(); g.Promise = Promise; installCore(g)
  const order = []
  g.requestAnimationFrame((t) => { order.push('a' + t); g.requestAnimationFrame((t2) => order.push('b' + t2)) })
  const cancelled = g.requestAnimationFrame(() => order.push('never'))
  g.cancelAnimationFrame(cancelled)
  g.__hostRunWindowFrame(1)
  g.__hostRunWindowFrame(2)
  g.__hostRunWindowFrame(3)
  assert.deepEqual(order, ['a1', 'b2'])
})
