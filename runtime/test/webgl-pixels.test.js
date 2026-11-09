import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { fakeGL, last } from './webgl-fake-gl.js'
import { install } from '../src/webgl/index.js'
import { GL } from '../src/webgl/constants.gen.js'
import { rewriteDrawId } from '../src/webgl/shader-rewrite.js'
import { bytesPerPixel } from '../src/webgl/pixels.js'

function host() {
  const gl = fakeGL()
  const g = { __native: fakeNative({ gl }), console: { warn() {} } }
  install(g)
  const ctx = g.__hostCreateWebGLContext({ width: 8, height: 8 }, {})
  return { g, gl, ctx }
}
// 2 × 2 RGBA8: row 0 = red, green; row 1 = blue, half-alpha white.
const RGBA_2x2 = () => new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128])

test('a typed-array upload with no flags is handed over by reference, with its element offset', () => {
  const { gl, ctx } = host()
  const px = RGBA_2x2()
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 2, 2, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
  const c = last(gl, 'texImage2D')
  assert.equal(c[9], px, 'same object, no copy'); assert.equal(c[10], 0)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 1, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, px, 4)
  assert.equal(last(gl, 'texImage2D')[10], 4, 'srcOffset is passed through in elements')
})

test('UNPACK_FLIP_Y_WEBGL flips rows of a typed-array upload on the CPU, never touching the source', () => {
  const { gl, ctx } = host()
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true)
  const px = RGBA_2x2(), orig = RGBA_2x2()
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 2, 2, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
  const c = last(gl, 'texImage2D')
  assert.notEqual(c[9], px)
  assert.deepEqual(Array.from(c[9]), [0, 0, 255, 255, 255, 255, 255, 128, 255, 0, 0, 255, 0, 255, 0, 255])
  assert.deepEqual(Array.from(px), Array.from(orig), 'the caller\'s array is untouched')
  assert.equal(c[10], 0)
  // A Float32 RGBA 1x2 flips by its own row size.
  const f = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA32F, 1, 2, 0, ctx.RGBA, ctx.FLOAT, f)
  const d = last(gl, 'texImage2D')[9]
  assert.deepEqual(Array.from(new Float32Array(d.buffer, d.byteOffset, 8)), [5, 6, 7, 8, 1, 2, 3, 4])
  // texSubImage2D too, with srcOffset folded in.
  const big = new Uint8Array(4 + 16); big.set(RGBA_2x2(), 4)
  ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, 2, 2, ctx.RGBA, ctx.UNSIGNED_BYTE, big, 4)
  const s = last(gl, 'texSubImage2D')
  assert.deepEqual(Array.from(s[9]).slice(0, 4), [0, 0, 255, 255]); assert.equal(s[10], 0)
  // UNPACK_ALIGNMENT pads RGB rows.
  ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 4)
  const rgb = new Uint8Array([1, 2, 3, 0, /* row 1 */ 4, 5, 6, 0])  // 1 px wide RGB, 4-aligned rows
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, 1, 2, 0, ctx.RGB, ctx.UNSIGNED_BYTE, rgb)
  assert.deepEqual(Array.from(last(gl, 'texImage2D')[9]), [4, 5, 6, 0, 1, 2, 3, 0])
})

test('UNPACK_PREMULTIPLY_ALPHA_WEBGL premultiplies RGBA8 only', () => {
  const { gl, ctx } = host()
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  const px = RGBA_2x2()
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 2, 2, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
  const out = Array.from(last(gl, 'texImage2D')[9])
  assert.deepEqual(out.slice(12), [128, 128, 128, 128])
  assert.deepEqual(out.slice(0, 12), Array.from(px).slice(0, 12))
  const f = new Float32Array(8)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA32F, 1, 2, 0, ctx.RGBA, ctx.FLOAT, f)
  assert.equal(last(gl, 'texImage2D')[9], f, 'a float upload is not premultiplied (and not copied)')
})

test('image sources: width/height from the source, flip and premultiply applied, formats converted', () => {
  const { gl, ctx } = host()
  const img = { width: 2, height: 2, __rgba: RGBA_2x2() }
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  let c = last(gl, 'texImage2D')
  assert.deepEqual(c.slice(1, 9), [GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE])
  assert.equal(c[9], img.__rgba, 'straight RGBA8 with nothing to apply goes by reference')
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.SRGB8_ALPHA8, 2, 2, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  c = last(gl, 'texImage2D')
  assert.equal(c[3], GL.SRGB8_ALPHA8)
  assert.deepEqual(Array.from(c[9]).slice(0, 8), [0, 0, 255, 255, 255, 255, 255, 128])
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false)
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(Array.from(last(gl, 'texImage2D')[9]).slice(12), [128, 128, 128, 128])
  const pre = { width: 2, height: 2, __rgba: RGBA_2x2(), __premultiplied: true }
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, pre)
  assert.equal(last(gl, 'texImage2D')[9], pre.__rgba, 'an already premultiplied bitmap is not premultiplied twice')
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  // RGB drops alpha, rows padded to UNPACK_ALIGNMENT 4 (2 px × 3 = 6 → 8).
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, ctx.RGB, ctx.UNSIGNED_BYTE, img)
  c = last(gl, 'texImage2D')
  assert.equal(c[7], GL.RGB)
  const rgb = Array.from(c[9])
  assert.equal(rgb.length, 16)
  assert.deepEqual(rgb.slice(0, 6), [255, 0, 0, 0, 255, 0]); assert.deepEqual(rgb.slice(8, 14), [0, 0, 255, 255, 255, 255])
  ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 1)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE_ALPHA, ctx.LUMINANCE_ALPHA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(Array.from(last(gl, 'texImage2D')[9]), [255, 255, 0, 255, 0, 255, 255, 128])
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.ALPHA, ctx.ALPHA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(Array.from(last(gl, 'texImage2D')[9]), [255, 255, 255, 128])
  // 9-arg form with an image source keeps the caller's size; 7-arg texSubImage2D takes the source's.
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 2, 2, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(last(gl, 'texImage2D').slice(4, 6), [2, 2])
  ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 3, 5, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(last(gl, 'texSubImage2D').slice(1, 9), [GL.TEXTURE_2D, 0, 3, 5, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE])
  // A float type asked of an 8-bit image is uploaded as RGBA8 (warned once), an ImageData-shaped `data` is accepted, a closed bitmap throws.
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA16F, ctx.RGBA, ctx.HALF_FLOAT, img)
  assert.deepEqual(last(gl, 'texImage2D').slice(7, 9), [GL.RGBA, GL.UNSIGNED_BYTE])
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, { width: 1, height: 1, data: new Uint8ClampedArray([9, 8, 7, 6]) })
  assert.deepEqual(Array.from(last(gl, 'texImage2D')[9]), [9, 8, 7, 6])
  assert.throws(() => ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, { width: 1, height: 1, __rgba: null, data: null }), TypeError)
  // texImage3D with an image source passes the converted pixels and the caller's depth.
  ctx.texImage3D(ctx.TEXTURE_2D_ARRAY, 0, ctx.RGBA, 2, 2, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  assert.deepEqual(last(gl, 'texImage3D').slice(1, 10), [GL.TEXTURE_2D_ARRAY, 0, GL.RGBA, 2, 2, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE])
})

test('bytesPerPixel covers the WebGL2 format/type table', () => {
  assert.equal(bytesPerPixel(GL.RGBA, GL.UNSIGNED_BYTE), 4)
  assert.equal(bytesPerPixel(GL.RGB, GL.UNSIGNED_BYTE), 3)
  assert.equal(bytesPerPixel(GL.RGBA, GL.FLOAT), 16)
  assert.equal(bytesPerPixel(GL.RGBA, GL.HALF_FLOAT), 8)
  assert.equal(bytesPerPixel(GL.RGB, GL.UNSIGNED_SHORT_5_6_5), 2)
  assert.equal(bytesPerPixel(GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV), 4)
  assert.equal(bytesPerPixel(GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8), 4)
  assert.equal(bytesPerPixel(GL.RED_INTEGER, GL.UNSIGNED_SHORT), 2)
  assert.equal(bytesPerPixel(0x1234, GL.UNSIGNED_BYTE), 0)
})

test('rewriteDrawId: placement after #version / #extension, no-op without gl_DrawID', () => {
  const r0 = rewriteDrawId('#version 300 es\nvoid main(){}')
  assert.equal(r0.usesDrawId, false); assert.equal(r0.source, '#version 300 es\nvoid main(){}')
  const r1 = rewriteDrawId('#version 300 es\n#extension GL_OES_foo : enable\nvoid main(){ int i = gl_DrawID; }')
  assert.equal(r1.usesDrawId, true)
  assert.equal(r1.source, '#version 300 es\n#extension GL_OES_foo : enable\nuniform highp int webgl_gl_DrawID;\nvoid main(){ int i = webgl_gl_DrawID; }')
  const r2 = rewriteDrawId('void main(){ int i = gl_DrawID; }')
  assert.equal(r2.source.split('\n')[0], 'uniform highp int webgl_gl_DrawID;', 'no directives: declared first')
  const r3 = rewriteDrawId('#version 300 es\n#extension GL_ANGLE_multi_draw : require\nvoid main(){}')
  assert.equal(r3.usesDrawId, false)
  assert.equal(r3.source, '#version 300 es\n#define webgl_ANGLE_multi_draw 1\nvoid main(){}', 'the ANGLE line becomes the macro ANGLE would define, even when gl_DrawID is unused')
})
