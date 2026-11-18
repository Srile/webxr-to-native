// Canvas 2D as a canvas-texture UI uses it: the full transform (rotated icons, text, pictures), CSS colours, rounded
// rects and joins, dashes, composite operators (tints), shadows, antialiased edges, and SVG pictures normalised for
// the host's rasteriser and re-rastered at the size they are drawn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/images/index.js'
import { parseColor } from '../src/images/pixels.js'
import { normalizeSvgText } from '../src/images/svg.js'
import { fakeNative } from './fake-native.js'
import { fakeImg, freshGlobal, px } from './images-support.test.js'

const canvas = (g, w, h) => { const c = new g.OffscreenCanvas(w, h); return [c, c.getContext('2d')] }
const at = (c, x, y) => px(c.__rgba, c.width, x, y)
const RED = [255, 0, 0, 255], NONE = [0, 0, 0, 0]

test('parseColor reads every CSS named colour, hsl(), hwb() and the space syntax', () => {
  assert.deepEqual(parseColor('gold'), [255, 215, 0, 255])
  assert.deepEqual(parseColor('DarkGoldenRod'), [184, 134, 11, 255])
  assert.deepEqual(parseColor('rebeccapurple'), [102, 51, 153, 255])
  assert.deepEqual(parseColor('hsl(120, 100%, 25%)'), [0, 128, 0, 255])
  assert.deepEqual(parseColor('hsl(0deg 100% 50% / 50%)'), [255, 0, 0, 128])
  assert.deepEqual(parseColor('hsla(240, 100%, 50%, 0.5)'), [0, 0, 255, 128])
  assert.deepEqual(parseColor('hwb(0 0% 0%)'), [255, 0, 0, 255])
  assert.deepEqual(parseColor('rgb(255 215 0 / 100%)'), [255, 215, 0, 255])
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0])
  assert.equal(parseColor('notacolour'), null); assert.equal(parseColor('#12'), null)
  const c = parseColor('gold'); c[0] = 1; assert.deepEqual(parseColor('gold'), [255, 215, 0, 255])   // a fresh array each time
})

test('fillStyle and strokeStyle take named colours; an unreadable one keeps the previous', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 4, 4)
  ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 4, 4)
  assert.deepEqual(at(c, 1, 1), [255, 215, 0, 255])
  ctx.strokeStyle = 'red'; ctx.strokeStyle = 'no-such-colour'
  assert.equal(ctx.strokeStyle, 'red')
  ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(4, 2); ctx.stroke()
  assert.deepEqual(at(c, 2, 2), RED)
})

test('rotate turns rects, paths and getTransform; quarter turns stay exact', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 8, 8)
  ctx.fillStyle = '#f00'
  ctx.translate(4, 4); ctx.rotate(Math.PI / 2)
  ctx.fillRect(0, -1, 4, 1)   // along +x in user space: down the canvas, in the column right of the centre
  for (let y = 4; y < 8; y++) assert.deepEqual(at(c, 4, y), RED, `row ${y}`)
  assert.deepEqual(at(c, 5, 4), NONE); assert.deepEqual(at(c, 3, 4), NONE); assert.deepEqual(at(c, 4, 3), NONE)
  const t = ctx.getTransform()
  assert.deepEqual([t.a, t.b, t.c, t.d, t.e, t.f], [0, 1, -1, 0, 4, 4])
  ctx.rotate(Math.PI / 2)     // half a turn in all
  ctx.beginPath(); ctx.rect(1, 1, 2, 2); ctx.fillStyle = '#00f'; ctx.fill()
  assert.deepEqual(at(c, 2, 2), [0, 0, 255, 255]); assert.deepEqual(at(c, 1, 1), [0, 0, 255, 255]); assert.deepEqual(at(c, 0, 0), NONE)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  assert.equal(ctx.getTransform().isIdentity ?? true, true)
})

test('transform, setTransform with a matrix and save / restore carry the whole matrix', () => {
  const g = freshGlobal(), [, ctx] = canvas(g, 4, 4)
  ctx.save()
  ctx.transform(0, 1, -1, 0, 3, 0); ctx.translate(1, 2)
  let t = ctx.getTransform()
  assert.deepEqual([t.a, t.b, t.c, t.d, t.e, t.f], [0, 1, -1, 0, 1, 1])
  ctx.setTransform({ a: 2, b: 0, c: 0, d: 3, e: 5, f: 6 })
  t = ctx.getTransform(); assert.deepEqual([t.a, t.d, t.e, t.f], [2, 3, 5, 6])
  ctx.lineCap = 'round'; ctx.setLineDash([2, 1]); ctx.shadowBlur = 4
  ctx.restore()
  t = ctx.getTransform(); assert.deepEqual([t.a, t.b, t.c, t.d, t.e, t.f], [1, 0, 0, 1, 0, 0])
  assert.equal(ctx.lineCap, 'butt'); assert.deepEqual(ctx.getLineDash(), []); assert.equal(ctx.shadowBlur, 0)
})

test('drawImage under a quarter turn moves every pixel to its turned place', () => {
  const g = freshGlobal(), [src, sctx] = canvas(g, 2, 1)
  sctx.fillStyle = '#f00'; sctx.fillRect(0, 0, 1, 1); sctx.fillStyle = '#00f'; sctx.fillRect(1, 0, 1, 1)
  const [c, ctx] = canvas(g, 4, 4)
  ctx.translate(2, 1); ctx.rotate(Math.PI / 2)
  ctx.drawImage(src, 0, 0)    // red then blue along +x: down the canvas from (1, 1)
  assert.deepEqual(at(c, 1, 1), RED); assert.deepEqual(at(c, 1, 2), [0, 0, 255, 255])
  assert.deepEqual(at(c, 2, 1), NONE); assert.deepEqual(at(c, 1, 0), NONE); assert.deepEqual(at(c, 1, 3), NONE)
  // 45 degrees: the picture's centre still lands on the centre.
  const [d, dctx] = canvas(g, 16, 16)
  const [big, bctx] = canvas(g, 8, 8); bctx.fillStyle = '#0f0'; bctx.fillRect(0, 0, 8, 8)
  dctx.translate(8, 8); dctx.rotate(Math.PI / 4); dctx.drawImage(big, -4, -4)
  assert.deepEqual(at(d, 8, 8), [0, 255, 0, 255]); assert.deepEqual(at(d, 8, 3), [0, 255, 0, 255])
  assert.deepEqual(at(d, 4, 4), NONE)   // the unturned corner is outside the diamond
})

test('roundRect, arcTo and closePath build the path a browser builds', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 20, 20)
  ctx.fillStyle = '#f00'
  ctx.beginPath(); ctx.roundRect(0, 0, 20, 20, 8); ctx.fill()
  assert.deepEqual(at(c, 10, 10), RED); assert.deepEqual(at(c, 10, 0), RED); assert.deepEqual(at(c, 0, 10), RED)
  assert.deepEqual(at(c, 0, 0), NONE); assert.deepEqual(at(c, 19, 19), NONE)
  assert.throws(() => ctx.roundRect(0, 0, 4, 4, [1, 2, 3, 4, 5]), RangeError)
  c.width = 20
  ctx.fillStyle = '#f00'
  ctx.beginPath(); ctx.roundRect(0, 0, 20, 20, [8, 0, 0, 0]); ctx.fill()
  assert.deepEqual(at(c, 0, 0), NONE); assert.deepEqual(at(c, 19, 0), RED); assert.deepEqual(at(c, 19, 19), RED)
  c.width = 20
  ctx.fillStyle = '#f00'
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arcTo(20, 0, 20, 20, 10); ctx.lineTo(20, 20); ctx.lineTo(0, 20); ctx.closePath(); ctx.fill()
  assert.deepEqual(at(c, 19, 0), NONE); assert.deepEqual(at(c, 16, 5), RED); assert.deepEqual(at(c, 5, 5), RED)
  // After closePath the next line starts from the subpath's first point.
  c.width = 20
  ctx.strokeStyle = '#f00'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(2, 10); ctx.lineTo(2, 12); ctx.closePath(); ctx.lineTo(18, 10); ctx.stroke()
  assert.deepEqual(at(c, 10, 10), RED)
})

test('strokes: miter corners are square, dashes leave gaps, a gradient strokes', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 24, 24)
  ctx.strokeStyle = '#f00'; ctx.lineWidth = 4
  ctx.strokeRect(4, 4, 16, 16)
  assert.deepEqual(at(c, 2, 2), RED, 'the outer corner of a miter join'); assert.deepEqual(at(c, 21, 21), RED)
  assert.deepEqual(at(c, 12, 12), NONE); assert.deepEqual(at(c, 1, 1), NONE)
  c.width = 24
  ctx.strokeStyle = '#f00'; ctx.lineWidth = 4; ctx.lineJoin = 'bevel'
  ctx.strokeRect(4, 4, 16, 16)
  assert.deepEqual(at(c, 2, 2), NONE, 'a bevel cuts the corner')
  c.width = 24
  ctx.strokeStyle = '#f00'; ctx.lineWidth = 2; ctx.setLineDash([4, 4])
  ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(24, 12); ctx.stroke()
  assert.deepEqual(at(c, 1, 12), RED); assert.deepEqual(at(c, 5, 12), NONE); assert.deepEqual(at(c, 9, 12), RED); assert.deepEqual(at(c, 13, 12), NONE)
  ctx.setLineDash([3]); assert.deepEqual(ctx.getLineDash(), [3, 3])
  ctx.setLineDash([1, -1]); assert.deepEqual(ctx.getLineDash(), [3, 3])   // a negative entry: ignored
  c.width = 24
  const grad = ctx.createLinearGradient(0, 0, 24, 0); grad.addColorStop(0, 'red'); grad.addColorStop(1, 'blue')
  ctx.strokeStyle = grad; ctx.lineWidth = 4
  ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(24, 12); ctx.stroke()
  assert.ok(at(c, 1, 12)[0] > 200 && at(c, 22, 12)[2] > 200)
})

test('path edges are antialiased: a pixel half inside gets half the alpha', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 4, 4)
  ctx.fillStyle = '#f00'
  ctx.beginPath(); ctx.rect(0.5, 0, 2, 4); ctx.fill()
  assert.deepEqual(at(c, 1, 1), RED)
  assert.ok(Math.abs(at(c, 0, 1)[3] - 128) <= 1 && Math.abs(at(c, 2, 1)[3] - 128) <= 1)
  assert.deepEqual(at(c, 3, 1), NONE)
  c.width = 4
  ctx.fillStyle = '#f00'
  ctx.beginPath(); ctx.rect(0, 0.25, 4, 2); ctx.fill()
  assert.ok(Math.abs(at(c, 1, 0)[3] - 191) <= 1 && Math.abs(at(c, 1, 2)[3] - 64) <= 1)
})

test('composite operators: source-in tints a picture, the others follow Porter-Duff', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 4, 4)
  const icon = () => { c.width = 4; ctx.fillStyle = '#000'; ctx.fillRect(1, 1, 2, 2) }
  icon(); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 4, 4)
  assert.equal(ctx.globalCompositeOperation, 'source-in')
  assert.deepEqual(at(c, 1, 1), [255, 215, 0, 255]); assert.deepEqual(at(c, 0, 0), NONE)
  icon(); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 1, 1), [255, 215, 0, 255]); assert.deepEqual(at(c, 2, 2), NONE, 'what the source does not cover is cleared')
  icon(); ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 1, 1), [255, 215, 0, 255]); assert.deepEqual(at(c, 2, 2), [0, 0, 0, 255]); assert.deepEqual(at(c, 0, 0), NONE)
  icon(); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 4, 4)
  assert.deepEqual(at(c, 1, 1), [0, 0, 0, 255]); assert.deepEqual(at(c, 0, 0), [255, 215, 0, 255])
  icon(); ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 1, 1), [0, 0, 0, 255]); assert.deepEqual(at(c, 2, 2), NONE)
  icon(); ctx.globalCompositeOperation = 'source-out'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 0, 0), [255, 215, 0, 255]); assert.deepEqual(at(c, 1, 1), NONE); assert.deepEqual(at(c, 2, 2), NONE)
  icon(); ctx.globalCompositeOperation = 'xor'; ctx.fillStyle = 'gold'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 0, 0), [255, 215, 0, 255]); assert.deepEqual(at(c, 1, 1), NONE); assert.deepEqual(at(c, 2, 2), [0, 0, 0, 255])
  c.width = 4; ctx.fillStyle = 'rgb(200, 100, 50)'; ctx.fillRect(0, 0, 4, 4)
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgb(128, 128, 128)'; ctx.fillRect(0, 0, 2, 2)
  assert.deepEqual(at(c, 0, 0), [100, 50, 25, 255]); assert.deepEqual(at(c, 3, 3), [200, 100, 50, 255])
  ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgb(100, 100, 100)'; ctx.fillRect(2, 2, 2, 2)
  assert.deepEqual(at(c, 3, 3), [255, 200, 150, 255])
  ctx.globalCompositeOperation = 'no-such-mode'; assert.equal(ctx.globalCompositeOperation, 'lighter')
  // A clip bounds what source-in clears.
  icon(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1, 1)
  ctx.save(); ctx.beginPath(); ctx.rect(1, 1, 3, 3); ctx.clip()
  ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = 'gold'; ctx.fillRect(1, 1, 1, 1); ctx.restore()
  assert.deepEqual(at(c, 1, 1), [255, 215, 0, 255]); assert.deepEqual(at(c, 2, 2), NONE); assert.deepEqual(at(c, 0, 0), [0, 0, 0, 255])
})

test('a shadow is drawn under the shape, offset and blurred, in the shadow colour', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 16, 16)
  ctx.shadowColor = 'rgba(0, 0, 255, 1)'; ctx.shadowOffsetY = 4
  ctx.fillStyle = '#f00'; ctx.fillRect(4, 2, 8, 4)
  assert.deepEqual(at(c, 8, 3), RED); assert.deepEqual(at(c, 8, 8), [0, 0, 255, 255]); assert.deepEqual(at(c, 8, 12), NONE)
  c.width = 16
  ctx.shadowColor = 'black'; ctx.shadowBlur = 4
  ctx.fillStyle = '#f00'; ctx.fillRect(6, 6, 4, 4)
  assert.deepEqual(at(c, 7, 7), RED)
  const near = at(c, 5, 7), far = at(c, 3, 7)
  assert.ok(near[3] > far[3] && far[3] > 0 && near[0] === 0, `the blur fades out: ${near} then ${far}`)
  assert.deepEqual(at(c, 0, 0), NONE)
  ctx.shadowColor = 'transparent'; ctx.fillRect(0, 12, 2, 2)
  assert.deepEqual(at(c, 0, 14), NONE)
})

test('Path2D builds like the context and reads S, Q, T and packed arc flags', () => {
  const g = freshGlobal(), [c, ctx] = canvas(g, 12, 12)
  const p = new g.Path2D(); p.roundRect(0, 0, 12, 12, 5)
  ctx.fillStyle = '#f00'; ctx.fill(p)
  assert.deepEqual(at(c, 6, 6), RED); assert.deepEqual(at(c, 0, 0), NONE)
  const q = new g.Path2D(); q.moveTo(1, 1); q.lineTo(3, 1); q.lineTo(3, 3); q.closePath()
  const both = new g.Path2D(p); both.addPath(q, { a: 1, b: 0, c: 0, d: 1, e: 2, f: 2 })
  assert.equal(both.__path.length, 2); assert.equal(both.__path[1].closed, true); assert.deepEqual(both.__path[1][0], [3, 3])
  // A quarter turn applies to a Path2D as it does to the context's own path.
  c.width = 12
  ctx.translate(12, 0); ctx.rotate(Math.PI / 2)
  ctx.fillStyle = '#f00'; ctx.fill(new g.Path2D('M0 0 H4 V2 H0 Z'))
  assert.deepEqual(at(c, 11, 3), RED); assert.deepEqual(at(c, 10, 3), RED); assert.deepEqual(at(c, 9, 3), NONE); assert.deepEqual(at(c, 11, 4), NONE)
  const smooth = new g.Path2D('M0 0 C0 4 4 4 4 0 S8 -4 8 0 Q10 4 12 0 T16 0')
  const last = smooth.__path[0][smooth.__path[0].length - 1]
  assert.deepEqual(last, [16, 0]); assert.ok(smooth.__path[0].some(pt => pt[1] < -2), 'S mirrors the last control point')
  assert.ok(smooth.__path[0].some(pt => pt[0] > 12 && pt[1] < -0.5), 'T mirrors the last quadratic control point')
  const arcs = new g.Path2D('M8 11V7a4 4 0 018 0v4')   // "018" is large-arc 0, sweep 1, then 8
  const pts = arcs.__path[0]
  assert.deepEqual(pts[pts.length - 1], [16, 11]); assert.ok(pts.some(pt => Math.abs(pt[0] - 12) < 0.5 && Math.abs(pt[1] - 3) < 0.2), 'the arc tops out at (12, 3)')
  assert.equal(ctx.isPointInPath(new g.Path2D('M0 0 H4 V4 H0 Z'), 11, 2), true)
})

test('isPointInPath follows the winding rule in device space', () => {
  const g = freshGlobal(), [, ctx] = canvas(g, 8, 8)
  ctx.beginPath(); ctx.rect(0, 0, 8, 8); ctx.rect(2, 2, 4, 4)
  assert.equal(ctx.isPointInPath(1, 1), true); assert.equal(ctx.isPointInPath(4, 4), true)
  assert.equal(ctx.isPointInPath(4, 4, 'evenodd'), false); assert.equal(ctx.isPointInPath(9, 4), false)
})

test('normalizeSvgText rewrites CSS, use, colours and sizes into what the rasteriser reads', () => {
  const attrs = (out, tag) => Object.fromEntries([...new RegExp(`<${tag}((?:\\s+[\\w:-]+="[^"]*")*)`).exec(out)[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
  // A class rule, an element rule, an id rule and the style attribute, in cascade order.
  let out = normalizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>path{fill:gold;stroke:red} .a{stroke:darkgoldenrod;stroke-width:1.5} #p{fill:rgb(0 0 255)}</style><path id="p" class="a" d="M0 0h4" style="stroke-width: 2px"/></svg>')
  let a = attrs(out, 'path')
  assert.equal(a.fill, '#0000ff'); assert.equal(a.stroke, '#b8860b'); assert.equal(a['stroke-width'], '2px'); assert.equal(a.style, undefined)
  assert.ok(!out.includes('<style'))
  a = attrs(out, 'svg'); assert.equal(a.width, '150'); assert.equal(a.height, '150')   // the viewBox fitted into 300 x 150
  // A style sheet after the shapes, in CDATA, with a descendant selector.
  out = normalizeSvgText('<svg viewBox="0 0 48 12" xmlns="http://www.w3.org/2000/svg"><g class="icon"><rect width="4" height="4"/></g><style><![CDATA[ .icon rect { fill: #FFD700 !important } ]]></style></svg>')
  assert.equal(attrs(out, 'rect').fill, '#ffd700')
  a = attrs(out, 'svg'); assert.equal(a.width, '300'); assert.equal(a.height, '75')
  // currentColor, alpha folded into the opacity, an unreadable colour dropped.
  out = normalizeSvgText('<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><g color="gold" fill="currentColor" stroke="rgba(0, 0, 0, 0.5)"><path d="M0 0"/><circle r="2" fill="nonsense" fill-opacity="0.5"/></g></svg>')
  a = attrs(out, 'g'); assert.equal(a.fill, '#ffd700'); assert.equal(a.stroke, '#000000'); assert.equal(a['stroke-opacity'], '0.502')   // alpha is 8 bits: 128 / 255
  a = attrs(out, 'circle'); assert.equal(a.fill, undefined); assert.equal(a['fill-opacity'], '0.5')
  a = attrs(out, 'svg'); assert.equal(a.width, '24'); assert.equal(a.height, '24')
  // <use> of a path and of a symbol; the symbol itself is not drawn.
  out = normalizeSvgText('<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="p" d="M0 0h4"/></defs><symbol id="s" viewBox="0 0 12 12"><rect width="12" height="12"/></symbol><use href="#p" x="2" y="3" fill="gold"/><use xlink:href="#s" width="24" height="24"/></svg>')
  assert.ok(!out.includes('<use') && !out.includes('<symbol'))
  assert.match(out, /<g fill="#ffd700" transform="translate\(2 3\)"><path d="M0 0h4"\/><\/g>/)
  assert.match(out, /<g transform="translate\(0 0\) scale\(2\)"><g><rect width="12" height="12"\/><\/g><\/g>/)
  // Bounding-box gradient fractions become percentages; user-space ones stay; href becomes xlink:href.
  out = normalizeSvgText('<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,0,0,.5)"/></linearGradient><linearGradient id="b" gradientUnits="userSpaceOnUse" x2="24"/><linearGradient id="c" href="#b" x1="2"/><path fill="url(\'#a\')" d="M0 0"/></svg>')
  assert.match(out, /id="a" x1="0%" y1="0%" x2="0%" y2="100%"/); assert.match(out, /stop-color="#ff0000" stop-opacity="0.502"/)
  assert.match(out, /gradientUnits="userSpaceOnUse" x2="24"/); assert.match(out, /id="c" x1="2" xlink:href="#b"/); assert.match(out, /fill="url\(#a\)"/)
  // A CSS transform with units, turned about transform-origin.
  out = normalizeSvgText('<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="transform: rotate(90deg) translateX(2px); transform-origin: center"/></svg>')
  assert.equal(attrs(out, 'path').transform, 'translate(12 12) rotate(90) translate(2 0) translate(-12 -12)')
  assert.equal(normalizeSvgText('<html></html>'), null)
})

test('an SVG image is decoded normalised and redrawn from a raster made for the size it lands at', async () => {
  const img = fakeImg()
  const seen = { decoded: null, rasters: [] }
  const solid = (w, h, r) => { const p = new Uint8Array(w * h * 4); for (let i = 0; i < p.length; i += 4) { p[i] = r; p[i + 3] = 255 } return p }
  img.decode = (bytes, cb) => { seen.decoded = new TextDecoder().decode(bytes); cb(4, 4, solid(4, 4, 10).buffer, null) }
  img.svgRaster = (bytes, scale, out) => { seen.rasters.push(scale); const w = Math.ceil(4 * scale), h = Math.ceil(4 * scale); out[0] = w; out[1] = h; return solid(w, h, 100 + w).buffer }
  const g = { __native: fakeNative({ img }), console: { warn() {} } }
  install(g)
  const im = new g.Image()
  await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = () => reject(im.__lastError); im.src = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><style>rect{fill:gold}</style><rect width="4" height="4"/></svg>') })
  assert.match(seen.decoded, /<rect width="4" height="4" fill="#ffd700"\/>/)
  assert.equal(im.naturalWidth, 4)
  const c = new g.OffscreenCanvas(16, 16), ctx = c.getContext('2d')
  ctx.drawImage(im, 0, 0)                       // natural size: the decoded pixels
  assert.equal(at(c, 1, 1)[0], 10); assert.deepEqual(seen.rasters, [])
  ctx.drawImage(im, 8, 0, 8, 8)                 // twice the size: a raster at 2x
  assert.deepEqual(seen.rasters, [2]); assert.equal(at(c, 9, 1)[0], 108); assert.equal(at(c, 15, 7)[0], 108)
  ctx.drawImage(im, 8, 8, 8, 8)                 // again: from the cache
  assert.deepEqual(seen.rasters, [2])
  ctx.save(); ctx.scale(0.5, 0.5); ctx.drawImage(im, 0, 16); ctx.restore()   // the transform's scale counts
  assert.deepEqual(seen.rasters, [2, 0.5]); assert.equal(at(c, 0, 8)[0], 102)
  ctx.save(); ctx.translate(4, 16); ctx.rotate(-Math.PI / 2); ctx.drawImage(im, 0, 0, 8, 8); ctx.restore()   // turned, at 2x
  assert.deepEqual(seen.rasters, [2, 0.5]); assert.equal(at(c, 5, 15)[0], 108)
})
