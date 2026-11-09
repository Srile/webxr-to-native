// The GL thread's ring as the JS encoders write it (runtime/src/webgl/queue.gen.js, host/gl/gl_queue.h): a model
// of the native side (reserve with wrap, the consumer's read position) drains it and checks every word.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUED, OPS, setQueue, FB, fbReset } from '../src/webgl/queue.gen.js'

const W = 0, LIMIT = 1, PW = 2, R = 16, SLEEP = 32, BASE = 64

// A ring of `cap` data words with a native stand-in: glqReserve is gl_queue.cpp's reserve(), and when the ring is
// full it drains (the GL thread catching up), recording every command it reads.
function ring(cap) {
  const buf = new ArrayBuffer((BASE + cap) * 4)
  const I = new Int32Array(buf), F = new Float32Array(buf)
  I[LIMIT] = cap - 1
  const read = [], fallbacks = []
  let wakes = 0
  // The GL thread catching up after the producer's next publication (a native command publishes PW as W).
  const drain = () => {
    Atomics.store(I, W, I[PW])
    let r = I[R]
    while (r !== I[W]) {
      const op = I[BASE + r]
      if (op === 1) { r = 0; continue }  // WRAP
      const len = cmdLength(I, BASE + r)
      read.push(Array.from(I.subarray(BASE + r, BASE + r + len)))
      r += len
    }
    I[R] = r
  }
  const native = new Proxy({
    glqReserve(n) {
      let w = I[PW]
      for (let spins = 0; spins < 3; spins++) {
        const r = I[R]
        if (r <= w) {
          if (w + n <= cap - 1) { I[LIMIT] = cap - 1; return w }
          if (r > n) { I[BASE + w] = 1; I[LIMIT] = r - 1; return 0 }
        } else if (w + n <= r - 1) { I[LIMIT] = r - 1; return w }
        drain()
      }
      throw new Error('ring stuck')
    },
    glqWake() { wakes++ },
  }, { get: (t, k) => k in t ? t[k] : (...a) => { fallbacks.push([k, ...a]) } })
  setQueue(buf, native)
  return { I, F, read, fallbacks, drain, wakes: () => wakes }
}
// Lengths of the commands the tests write (the C++ decoder knows them all).
function cmdLength(I, o) {
  const op = I[o]
  if (op === OPS.uniformMatrix4fv) return 4 + I[o + 3] * 16
  if (op === OPS.uniform4fv) return 3 + I[o + 2] * 4
  if (op === OPS.uniform3iv) return 3 + I[o + 2] * 3
  if (op === OPS.drawElements) return 5
  if (op === OPS.uniform4f) return 6
  if (op === OPS.clearBufferfv) return 7
  return 3  // bindBuffer, bindFramebuffer, ...
}

test('scalar commands: enums, names, floats and offsets land word for word', () => {
  const q = ring(1024)
  QUEUED.bindBuffer(0x8892, 7)
  QUEUED.uniform4f(3, 0.5, -1, 2.25, 1e-3)
  QUEUED.drawElements(4, 36, 0x1403, 128)
  q.drain()
  assert.deepEqual(q.read[0], [OPS.bindBuffer, 0x8892, 7])
  const f = new Float32Array(new Int32Array(q.read[1]).buffer)
  assert.equal(q.read[1][0], OPS.uniform4f); assert.equal(q.read[1][1], 3)
  assert.deepEqual(Array.from(f.subarray(2)), [0.5, -1, 2.25, Math.fround(1e-3)])
  assert.deepEqual(q.read[2], [OPS.drawElements, 4, 36, 0x1403, 128])
  assert.equal(q.fallbacks.length, 0)
})

test('an enum past 2^31 keeps its bits (GL reads the word unsigned)', () => {
  const q = ring(64)
  QUEUED.bindBuffer(0xFFFFFFFF, 0x80000001)
  q.drain()
  assert.equal(q.read[0][1] >>> 0, 0xFFFFFFFF); assert.equal(q.read[0][2] >>> 0, 0x80000001)
})

test('typed-array uniforms copy the [srcOffset, srcOffset + srcLength) window; bad lengths go to the native', () => {
  const q = ring(1024)
  const m = new Float32Array(40).map((_, i) => i)
  QUEUED.uniformMatrix4fv(5, false, m, 4, 32)          // two matrices from element 4
  QUEUED.uniform4fv(2, new Float32Array([1, 2, 3, 4]), 0, 0)
  QUEUED.uniform4fv(2, new Float32Array([1, 2, 3]), 0, 0)  // not whole vec4s: INVALID_VALUE is the native's to raise
  QUEUED.uniformMatrix4fv(5, true, new Float32Array(16), 8, 16)  // out of range
  QUEUED.drawElements(4, 3, 0x1403, -4)                // negative offset: the native raises it
  q.drain()
  const [mat, vec] = q.read
  assert.deepEqual(mat.slice(0, 4), [OPS.uniformMatrix4fv, 5, 0, 2])
  assert.deepEqual(Array.from(new Float32Array(new Int32Array(mat.slice(4)).buffer)), Array.from(m.subarray(4, 36)))
  assert.deepEqual(Array.from(new Float32Array(new Int32Array(vec.slice(3)).buffer)), [1, 2, 3, 4])
  assert.deepEqual(q.fallbacks.map((c) => c[0]), ['uniform4fv', 'uniformMatrix4fv', 'drawElements'])
})

test('integer uniform arrays copy as integers, Uint32 bits included', () => {
  const q = ring(256)
  QUEUED.uniform3iv(1, new Int32Array([-1, 2, -3]), 0, 0)
  q.drain()
  assert.deepEqual(q.read[0], [OPS.uniform3iv, 1, 1, -1, 2, -3])
})

test('clearBufferfv pads to four values and reads from srcOffset', () => {
  const q = ring(64)
  QUEUED.clearBufferfv(0x1801 /* DEPTH */, 0, new Float32Array([9, 0.75]), 1)
  q.drain()
  assert.deepEqual(Array.from(new Float32Array(new Int32Array(q.read[0].slice(3)).buffer)), [0.75, 0, 0, 0])
})

test('thousands of commands through a small ring: wraps keep order and content', () => {
  const q = ring(97)  // odd size: commands straddle the end at shifting positions
  const want = []
  for (let i = 0; i < 3000; i++) {
    if (i % 3 === 0) { QUEUED.bindBuffer(0x8892, i); want.push([OPS.bindBuffer, 0x8892, i]) }
    else if (i % 3 === 1) { QUEUED.drawElements(4, i, 0x1405, i * 4); want.push([OPS.drawElements, 4, i, 0x1405, i * 4]) }
    else { const d = new Float32Array(16).fill(i); QUEUED.uniformMatrix4fv(i, false, d, 0, 0); want.push([OPS.uniformMatrix4fv, i, 0, 1, ...new Int32Array(d.buffer)]) }
  }
  q.drain()
  assert.equal(q.read.length, want.length)
  for (let i = 0; i < want.length; i++) assert.deepEqual(q.read[i], want[i], 'command ' + i)
})

test('state commands are published with the next draw; the consumer is woken only when parked', () => {
  const q = ring(256)
  QUEUED.bindBuffer(1, 2)
  assert.equal(q.I[W], 0, 'a bind alone is not published')
  assert.equal(q.I[PW], 3)
  QUEUED.drawElements(4, 3, 0x1403, 0)
  assert.equal(q.I[W], 8, 'the draw publishes everything before it')
  assert.equal(q.wakes(), 0)
  q.I[SLEEP] = 1
  QUEUED.bindBuffer(1, 3); assert.equal(q.wakes(), 0)
  QUEUED.drawArrays(4, 0, 3); assert.equal(q.wakes(), 1)
})

test('a long run of state commands is published every 1024 words without a draw', () => {
  const q = ring(4096)
  for (let i = 0; i < 400; i++) QUEUED.bindBuffer(0x8892, i)  // 1200 words
  assert.ok(q.I[W] > 1024 && q.I[W] <= q.I[PW])
})

test('framebuffer bindings are tracked as they are recorded', () => {
  ring(64); fbReset()
  QUEUED.bindFramebuffer(0x8D40, 5); assert.deepEqual(Array.from(FB), [5, 5])
  QUEUED.bindFramebuffer(0x8CA8, 6); assert.deepEqual(Array.from(FB), [5, 6])
  QUEUED.bindFramebuffer(0x8CA9, 0); assert.deepEqual(Array.from(FB), [0, 6])
  fbReset(); assert.deepEqual(Array.from(FB), [0, 0])
})
