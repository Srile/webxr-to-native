import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mat4Perspective, mat4FromRotationTranslation, mat4Invert, mat4Multiply, mat4GetRotation, mat4Identity } from '../src/webxr/math.js'

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('projection matrix from an asymmetric fov matches the OpenXR formula (column-major)', () => {
  const l = -0.9, r = 0.7, u = 0.8, d = -1.0, n = 0.1, f = 1000
  const tl = Math.tan(l), tr = Math.tan(r), tu = Math.tan(u), td = Math.tan(d)
  const out = mat4Perspective(new Float32Array(16), l, r, u, d, n, f)
  assert.ok(out instanceof Float32Array)
  near(out[0], 2 / (tr - tl))
  near(out[5], 2 / (tu - td))
  near(out[8], (tr + tl) / (tr - tl))
  near(out[9], (tu + td) / (tu - td))
  near(out[10], -(f + n) / (f - n))
  near(out[11], -1)
  near(out[14], -2 * f * n / (f - n))
  for (const i of [1, 2, 3, 4, 6, 7, 12, 13, 15]) assert.equal(out[i], 0)
  // asymmetry shows: the off-centre terms are not zero
  assert.ok(Math.abs(out[8]) > 1e-3 && Math.abs(out[9]) > 1e-3)
  // and the near plane comes back out (three's setProjectionFromUnion reads it this way)
  near(out[14] / (out[10] - 1), n, 1e-4)
  near(out[14] / (out[10] + 1), f, 1e-1)
})

test('mat4: rotation+translation, multiply and invert round trip', () => {
  const s = Math.SQRT1_2
  const m = mat4FromRotationTranslation(new Float32Array(16), 0, s, 0, s, 1, 2, 3)
  // 90° about +y: x → -z
  near(m[0], 0); near(m[2], -1); near(m[8], 1); near(m[10], 0)
  near(m[12], 1); near(m[13], 2); near(m[14], 3)
  const inv = new Float32Array(16)
  assert.ok(mat4Invert(inv, m))
  const id = mat4Multiply(new Float32Array(16), inv, m)
  const I = mat4Identity(new Float32Array(16))
  for (let i = 0; i < 16; i++) near(id[i], I[i])
  const q = mat4GetRotation(new Float32Array(4), m)
  near(q[0], 0); near(q[1], s); near(q[2], 0); near(q[3], s)
})

test('mat4Invert reports singular matrices', () => {
  assert.equal(mat4Invert(new Float32Array(16), new Float32Array(16)), false)
})
