// Shared support for the images tests: a fake __native.img over a trivial
// container ('FK' + uint16 w, h + RGBA), a fresh install() target, and the
// sanity test of the fake itself (so `node --test` has something to run here).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/images/index.js'
import { fakeNative } from './fake-native.js'

export function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return new Uint8Array(bytes)
}

// Encodes w × h RGBA pixels as a fake image file.
export function encodeFake(w, h, rgba) {
  const out = new Uint8Array(6 + w * h * 4)
  out[0] = 0x46; out[1] = 0x4b
  out[2] = w & 255; out[3] = w >> 8; out[4] = h & 255; out[5] = h >> 8
  out.set(rgba.subarray(0, w * h * 4), 6)
  return out
}

// A 'PNG' the fake encoder writes: magic + w, h + the pixels. decodeFakePng reads it back.
export function decodeFakePng(bytes) {
  const u = toU8(bytes)
  assert.equal(String.fromCharCode(u[0], u[1], u[2]), 'PNG')
  const w = u[3] | (u[4] << 8), h = u[5] | (u[6] << 8)
  return { width: w, height: h, rgba: u.slice(7, 7 + w * h * 4) }
}

export function fakeImg(opts = {}) {
  const calls = { decode: 0, encodePng: 0, resize: 0 }
  const img = {
    calls,
    decode(bytes, cb) {
      calls.decode++
      const u = toU8(bytes)
      const answer = () => {
        if (u.length < 6 || u[0] !== 0x46 || u[1] !== 0x4b) return cb(0, 0, null, 'not a fake image')
        const w = u[2] | (u[3] << 8), h = u[4] | (u[5] << 8)
        if (u.length < 6 + w * h * 4) return cb(0, 0, null, 'truncated')
        cb(w, h, u.slice(6, 6 + w * h * 4).buffer, null)
      }
      opts.async ? setImmediate(answer) : answer()
    },
    encodePng(w, h, rgba) {
      calls.encodePng++
      const u = toU8(rgba)
      const out = new Uint8Array(7 + w * h * 4)
      out[0] = 80; out[1] = 78; out[2] = 71
      out[3] = w & 255; out[4] = w >> 8; out[5] = h & 255; out[6] = h >> 8
      out.set(u.subarray(0, w * h * 4), 7)
      return out.buffer
    },
    resize(rgba, w, h, nw, nh) {  // nearest, enough to see it was called
      calls.resize++
      const u = toU8(rgba), out = new Uint8Array(nw * nh * 4)
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const sx = Math.floor(x * w / nw), sy = Math.floor(y * h / nh)
        out.set(u.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * nw + x) * 4)
      }
      return out.buffer
    },
  }
  return img
}

// A fresh global with the images module installed. `extra` lands on it first
// (fetch stubs, EventTarget/Event/Blob to exercise the global paths, …).
export function freshGlobal(extra = {}, imgOpts = {}) {
  const img = fakeImg(imgOpts)
  const g = { __native: fakeNative({ img }), console: { warn: (...a) => g.warnings.push(a.join(' ')) }, warnings: [], ...extra }
  install(g)
  return g
}

// A w × h picture whose pixel (x, y) is (x * 10, y * 10, 200, 255 - y) — unique rows and columns.
export function pattern(w, h) {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    rgba[i] = x * 10; rgba[i + 1] = y * 10; rgba[i + 2] = 200; rgba[i + 3] = 255 - y
  }
  return rgba
}

export function px(rgba, w, x, y) { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]] }

test('the fake codec round-trips', () => {
  const src = pattern(3, 2)
  const bytes = encodeFake(3, 2, src)
  const img = fakeImg()
  let got
  img.decode(bytes, (w, h, rgba, err) => { got = { w, h, rgba: new Uint8Array(rgba), err } })
  assert.equal(got.err, null); assert.equal(got.w, 3); assert.equal(got.h, 2)
  assert.deepEqual([...got.rgba], [...src])
  img.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), (w, h, rgba, err) => { got = { w, rgba, err } })
  assert.equal(got.rgba, null); assert.match(got.err, /not a fake/)
  const png = decodeFakePng(img.encodePng(3, 2, src))
  assert.deepEqual([...png.rgba], [...src])
})
