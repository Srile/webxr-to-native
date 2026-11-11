// render-models.js: the runtime's controller models as XRFrame.getRenderModel(inputSource).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installRenderModels } from '../src/webxr/render-models.js'

const HEADER = 4, STRIDE = 8 + 64 * 8

function setup() {
  const g = { XRFrame: class XRFrame {} }
  const record = new Float32Array(HEADER + 4 * STRIDE)
  let list = []
  let calls = 0
  const nx = { renderModelPoses: () => record, renderModels: () => { calls++; return list } }
  installRenderModels(g, nx, () => {})
  return { frame: new g.XRFrame(), record, setList(l) { list = l }, calls: () => calls }
}

test('getRenderModel: each hand gets its model, with this frame\'s pose and node states', () => {
  const { frame, record, setList, calls } = setup()
  const left = { handedness: 'left' }, right = { handedness: 'right' }
  assert.equal(frame.getRenderModel(left), null)
  setList([{ slot: 0, id: '7', hand: 1, glb: new ArrayBuffer(4), nodes: ['trigger', 'thumbstick'] }, { slot: 1, id: '8', hand: 0, glb: new ArrayBuffer(4), nodes: [] }])
  record[0] = 1; record[1] = 2
  const r = HEADER
  record.set([1, .01, -.02, .03, 0, 0, 0, 1], r)
  record.set([1, 0, 0, .005, 0, 0, 0, 1], r + 8)
  const model = frame.getRenderModel(right)
  assert.equal(model.id, '7')
  assert.deepEqual(model.nodes, ['trigger', 'thumbstick'])
  assert.equal(model.tracked, true)
  assert.ok(Math.abs(model.pose[1] - -.02) < 1e-6)
  assert.equal(model.nodeStates.length, 16)
  assert.ok(Math.abs(model.nodeStates[3] - .005) < 1e-6)
  assert.equal(frame.getRenderModel(left).id, '8')
  assert.equal(frame.getRenderModel(left).tracked, false)
  // A tracked hand holds no controller.
  assert.equal(frame.getRenderModel({ handedness: 'right', hand: new Map() }), null)
  // The list is read once per generation, and a kept model stays the same object.
  const before = calls()
  frame.getRenderModel(right)
  assert.equal(calls(), before)
  setList([{ slot: 0, id: '7', hand: 1, glb: new ArrayBuffer(4), nodes: ['trigger', 'thumbstick'] }])
  record[0] = 2
  assert.equal(frame.getRenderModel(right), model)
  assert.equal(frame.getRenderModel(left), null)
})

test('getRenderModel is absent when the host has no models', () => {
  const g = { XRFrame: class XRFrame {} }
  installRenderModels(g, { renderModelPoses: () => null, renderModels: () => [] }, () => {})
  assert.equal(typeof g.XRFrame.prototype.getRenderModel, 'undefined')
})
