// Canvas 2D text and FontFace over a fake __native.img text engine: every glyph advances 0.5 em, inks a box
// 0.5 em wide from the baseline up 0.7 em, and the face's ascent / descent are 0.8 / 0.2 em.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/images/index.js'
import { fakeNative } from './fake-native.js'
import { fakeImg, px } from './images-support.test.js'

const SYSTEM = 0
function textGlobal({ fetch } = {}) {
  const img = fakeImg()
  const calls = img.calls; calls.fontLoad = []; calls.measure = []; calls.raster = []
  let next = 1
  img.fontSystem = () => SYSTEM
  img.fontLoad = (bytes) => { calls.fontLoad.push(bytes.byteLength); return next++ }
  img.textMeasure = (font, fallback, px, spacing, text, out) => {
    calls.measure.push({ font, fallback, px, spacing, text })
    const n = text.length, adv = 0.5 * px + spacing
    out[0] = n * adv; out[1] = 0; out[2] = n ? (n - 1) * adv + 0.5 * px : 0; out[3] = 0.7 * px; out[4] = 0; out[5] = 0.8 * px; out[6] = 0.2 * px
  }
  img.textRaster = (font, fallback, px, spacing, sx, sy, ox, oy, text, alpha, out) => {
    calls.raster.push({ font, px, spacing, sx, sy, ox, oy, text })
    const w = Math.round(text.length * (0.5 * px + spacing) * sx), h = Math.round(0.7 * px * sy)
    out[0] = w; out[1] = h; out[2] = Math.floor(ox); out[3] = Math.floor(oy) - h
    if (w * h === 0 || alpha.length < w * h) return false
    alpha.fill(255, 0, w * h)
    return true
  }
  const g = { __native: fakeNative({ img }), console: { warn: (...a) => g.warnings.push(a.join(' ')) }, warnings: [], document: {}, fetch }
  install(g)
  return { g, calls }
}
const fontFetch = (log) => async (url) => { log.push(url); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(100) } }

test('FontFace from a url() loads through fetch and the face draws once added to document.fonts', async () => {
  const urls = []
  const { g, calls } = textGlobal({ fetch: fontFetch(urls) })
  const face = new g.FontFace('sui-generis', 'url(assets/fonts/sui-generis.ttf)')
  assert.equal(face.status, 'unloaded')
  g.document.fonts.add(await face.load())
  assert.deepEqual(urls, ['assets/fonts/sui-generis.ttf']); assert.equal(face.status, 'loaded'); assert.deepEqual(calls.fontLoad, [100])
  assert.equal(g.document.fonts.check('12px sui-generis'), true); assert.equal(g.document.fonts.check('12px other'), false)
  const ctx = new g.OffscreenCanvas(8, 8).getContext('2d')
  ctx.font = '12px sui-generis'; ctx.measureText('a')
  ctx.font = '12px "unknown face", sans-serif'; ctx.measureText('a')
  assert.deepEqual(calls.measure.map((c) => [c.font, c.fallback, c.px]), [[1, SYSTEM, 12], [SYSTEM, SYSTEM, 12]])
  g.document.fonts.delete(face)
  ctx.font = '12px sui-generis'; ctx.measureText('a')
  assert.equal(calls.measure.at(-1).font, SYSTEM, 'a face removed from document.fonts no longer draws')
})

test('FontFace from bytes loads at once; weight picks the closer face; pt and em sizes', async () => {
  const { g, calls } = textGlobal()
  const regular = new g.FontFace('Brand', new Uint8Array(40)), bold = new g.FontFace('Brand', new ArrayBuffer(50), { weight: 'bold' })
  await Promise.all([regular.loaded, bold.loaded])
  g.document.fonts.add(regular).add(bold)
  const ctx = new g.OffscreenCanvas(8, 8).getContext('2d')
  ctx.font = 'bold 9pt Brand'; ctx.measureText('a')
  ctx.font = '2em Brand'; ctx.measureText('a')
  assert.deepEqual(calls.measure.map((c) => [c.font, c.px]), [[bold.__id, 12], [regular.__id, 32]])
})

test('measureText: width, ink box and baselines follow textAlign and textBaseline', () => {
  const { g } = textGlobal()
  const ctx = new g.OffscreenCanvas(8, 8).getContext('2d')
  ctx.font = '10px sans-serif'
  let m = ctx.measureText('abcd')
  assert.equal(m.width, 20); assert.equal(m.actualBoundingBoxLeft, 0); assert.equal(m.actualBoundingBoxRight, 20)
  assert.equal(m.actualBoundingBoxAscent, 7); assert.equal(m.fontBoundingBoxAscent, 8); assert.equal(m.fontBoundingBoxDescent, 2); assert.equal(m.alphabeticBaseline, 0)
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  m = ctx.measureText('abcd')
  assert.equal(m.actualBoundingBoxLeft, 10); assert.equal(m.actualBoundingBoxRight, 10)
  assert.equal(m.fontBoundingBoxAscent, 0); assert.equal(m.alphabeticBaseline, -8)
  ctx.letterSpacing = '1px'; assert.equal(ctx.measureText('abcd').width, 24)
  assert.equal(g.warnings.length, 0)
})

test('fillText paints the coverage in the fill colour at the aligned, transformed origin', () => {
  const { g, calls } = textGlobal()
  const c = new g.OffscreenCanvas(40, 20), ctx = c.getContext('2d')
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#ff0000'
  ctx.translate(2, 0); ctx.scale(2, 2)
  ctx.textAlign = 'right'
  ctx.fillText('ab', 10, 8)   // width 10 user px: the pen starts at user x 0, device x 2; baseline device y 16
  const r = calls.raster.at(-1)
  assert.equal(r.ox, 2); assert.equal(r.oy, 16); assert.equal(r.sx, 2); assert.equal(r.sy, 2)
  assert.deepEqual(px(c.__rgba, 40, 2, 15), [255, 0, 0, 255])
  assert.deepEqual(px(c.__rgba, 40, 21, 2), [255, 0, 0, 255])
  assert.deepEqual(px(c.__rgba, 40, 22, 15), [0, 0, 0, 0])
  assert.deepEqual(px(c.__rgba, 40, 2, 16), [0, 0, 0, 0])
  ctx.resetTransform(); ctx.textAlign = 'left'; ctx.globalAlpha = 0.5; ctx.fillStyle = '#0000ff'
  ctx.fillText('a', 30, 19, 2)   // maxWidth 2 of 5: condensed horizontally
  assert.equal(calls.raster.at(-1).sx, 0.4)
  assert.equal(px(c.__rgba, 40, 30, 18)[2], 255); assert.equal(px(c.__rgba, 40, 30, 18)[3], 127)
})

test('fillText grows its coverage scratch for large text and draws nothing for blank text', () => {
  const { g, calls } = textGlobal()
  const c = new g.OffscreenCanvas(4, 4), ctx = c.getContext('2d')
  ctx.font = '400px sans-serif'; ctx.fillStyle = '#00ff00'
  ctx.fillText('wide', 0, 270)   // 800 x 280 > the 64 KB scratch, rows -10 to 269
  assert.equal(calls.raster.length, 2)
  assert.deepEqual(px(c.__rgba, 4, 0, 3), [0, 255, 0, 255])
  calls.raster.length = 0
  ctx.fillText('', 0, 0); assert.equal(calls.raster.length, 0)
})
