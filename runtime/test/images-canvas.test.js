import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFakePng, encodeFake, freshGlobal, pattern, px } from './images-support.test.js'

test('__hostCreateCanvas makes a 300x150 HTMLCanvasElement whose size setters reallocate', () => {
  const g = freshGlobal()
  const c = g.__hostCreateCanvas()
  assert.ok(c instanceof g.HTMLCanvasElement)
  assert.equal(c.width, 300); assert.equal(c.height, 150); assert.equal(c.__rgba.length, 300 * 150 * 4)
  assert.equal(c.tagName, 'CANVAS'); assert.equal(c.clientWidth, 300); assert.equal(c.getBoundingClientRect().height, 150)
  const ctx = c.getContext('2d')
  assert.ok(ctx instanceof g.CanvasRenderingContext2D); assert.equal(ctx.canvas, c)
  assert.equal(c.getContext('2d'), ctx)
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 300, 150)
  assert.equal(c.__rgba[0], 255)
  c.width = 4; c.height = 2
  assert.equal(c.__rgba.length, 32); assert.equal(c.__rgba[0], 0)   // cleared
  assert.equal(ctx.fillStyle, '#000000')                            // and the 2D state reset
  c.setAttribute('width', '7'); assert.equal(c.width, 7); assert.equal(c.getAttribute('width'), '7')
  c.width = -3; assert.equal(c.width, 300)                           // invalid → the default
  c.width = 'NaN'; assert.equal(c.width, 300)
  c.setAttribute('data-engine', 'three.js r181'); assert.equal(c.getAttribute('data-engine'), 'three.js r181')
  c.style.display = 'block'; c.classList.add('x'); assert.ok(c.classList.contains('x'))
  assert.equal(c.style.removeProperty('display'), 'block'); assert.ok(!c.style.display)
  let fired = 0; c.addEventListener('webglcontextlost', () => fired++); c.dispatchEvent(g.Event ? new g.Event('webglcontextlost') : { type: 'webglcontextlost' }); assert.equal(fired, 1)
  assert.equal(c.getContext('bitmaprenderer'), null)
})

test('fillRect / clearRect with solid colours, alpha and blending', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(4, 4)
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 4, 4)
  assert.deepEqual(px(c.__rgba, 4, 3, 3), [255, 255, 255, 255])
  ctx.fillStyle = 'rgb(10, 20, 30)'; ctx.fillRect(1, 1, 2, 2)
  assert.deepEqual(px(c.__rgba, 4, 1, 1), [10, 20, 30, 255]); assert.deepEqual(px(c.__rgba, 4, 0, 0), [255, 255, 255, 255]); assert.deepEqual(px(c.__rgba, 4, 3, 1), [255, 255, 255, 255])
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; ctx.fillRect(0, 0, 1, 1)
  assert.deepEqual(px(c.__rgba, 4, 0, 0), [127, 127, 127, 255])
  ctx.fillStyle = '#0f0'; ctx.globalAlpha = 0.5; ctx.fillRect(3, 3, 1, 1)
  assert.deepEqual(px(c.__rgba, 4, 3, 3), [128, 255, 128, 255])
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, 4, 1)
  assert.deepEqual(px(c.__rgba, 4, 0, 0), [0, 0, 0, 0]); assert.deepEqual(px(c.__rgba, 4, 3, 0), [0, 0, 0, 0]); assert.deepEqual(px(c.__rgba, 4, 1, 1), [10, 20, 30, 255])
  // source-over onto a cleared pixel
  ctx.fillStyle = 'rgba(255, 0, 0, 0.25)'; ctx.fillRect(0, 0, 1, 1)
  assert.deepEqual(px(c.__rgba, 4, 0, 0), [255, 0, 0, 64])
  // the colour grammar: hex with alpha, space syntax, named, transparent
  ctx.fillStyle = '#11223380'; assert.equal(ctx.fillStyle, '#11223380'); assert.deepEqual(ctx.__fillRgba, [17, 34, 51, 128])
  ctx.fillStyle = 'rgb(1 2 3 / 50%)'; assert.deepEqual(ctx.__fillRgba, [1, 2, 3, 128])
  ctx.fillStyle = 'transparent'; ctx.fillRect(1, 1, 1, 1); assert.deepEqual(px(c.__rgba, 4, 1, 1), [10, 20, 30, 255])
  ctx.fillStyle = 'not-a-colour'; assert.equal(ctx.fillStyle, 'transparent'); assert.equal(g.warnings.length, 1)
  ctx.fillStyle = 'not-a-colour'; assert.equal(g.warnings.length, 1)  // warned once
  // negative sizes and clipping
  ctx.fillStyle = 'blue'; ctx.fillRect(4, 4, -1, -1); assert.deepEqual(px(c.__rgba, 4, 3, 3), [0, 0, 255, 255])
  ctx.fillRect(-10, -10, 100, 100); assert.deepEqual(px(c.__rgba, 4, 0, 0), [0, 0, 255, 255])
  ctx.fillRect(10, 10, 5, 5)  // off-canvas: no throw
})

test('putImageData / getImageData / createImageData round trip, with clipping and dirty rects', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(4, 3)
  const ctx = c.getContext('2d')
  const src = pattern(4, 3)
  const data = new g.ImageData(new Uint8ClampedArray(src), 4, 3)
  ctx.putImageData(data, 0, 0)
  assert.deepEqual([...c.__rgba], [...src])
  const back = ctx.getImageData(0, 0, 4, 3)
  assert.ok(back instanceof g.ImageData); assert.deepEqual([...back.data], [...src])
  assert.notEqual(back.data.buffer, c.__rgba.buffer)
  // a window, partly outside: transparent black there
  const win = ctx.getImageData(3, 2, 2, 2)
  assert.deepEqual(px(win.data, 2, 0, 0), px(src, 4, 3, 2)); assert.deepEqual(px(win.data, 2, 1, 1), [0, 0, 0, 0])
  // negative sizes normalise
  const neg = ctx.getImageData(2, 1, -2, -1)
  assert.deepEqual(px(neg.data, 2, 0, 0), px(src, 4, 0, 0))
  assert.throws(() => ctx.getImageData(0, 0, 0, 1), /IndexSizeError|empty/)
  // putImageData offset off the edge clips; globalAlpha does not apply
  ctx.globalAlpha = 0.1
  const two = new g.ImageData(new Uint8ClampedArray(pattern(2, 2)), 2, 2)
  ctx.putImageData(two, 3, 2)
  assert.deepEqual(px(c.__rgba, 4, 3, 2), [0, 0, 200, 255]); assert.deepEqual(px(c.__rgba, 4, 2, 2), px(src, 4, 2, 2))
  ctx.putImageData(two, -1, -1)
  assert.deepEqual(px(c.__rgba, 4, 0, 0), px(pattern(2, 2), 2, 1, 1))
  // dirty rect
  ctx.putImageData(data, 0, 0)
  ctx.putImageData(two, 0, 0, 1, 1, 1, 1)
  assert.deepEqual(px(c.__rgba, 4, 1, 1), px(pattern(2, 2), 2, 1, 1)); assert.deepEqual(px(c.__rgba, 4, 0, 0), px(src, 4, 0, 0))
  // a plain object shaped like ImageData (a structured clone from a worker) is accepted
  ctx.putImageData({ data: new Uint8ClampedArray([9, 8, 7, 6]), width: 1, height: 1 }, 2, 0)
  assert.deepEqual(px(c.__rgba, 4, 2, 0), [9, 8, 7, 6])
  assert.throws(() => ctx.putImageData({}, 0, 0), TypeError)
  const made = ctx.createImageData(2, 3); assert.equal(made.width, 2); assert.equal(made.height, 3)
  const copy = ctx.createImageData(made); assert.equal(copy.height, 3)
})

test('drawImage from bitmaps, canvases and images: nearest-neighbour scaling, 3/5/9 argument forms', async () => {
  const g = freshGlobal()
  const src = pattern(2, 2)
  const bmp = await g.createImageBitmap(new g.ImageData(new Uint8ClampedArray(src), 2, 2))
  const c = new g.OffscreenCanvas(4, 4)
  const ctx = c.getContext('2d')
  ctx.drawImage(bmp, 0, 0, 4, 4)  // 2x upscale, each source pixel a 2x2 block
  assert.deepEqual(px(c.__rgba, 4, 0, 0), px(src, 2, 0, 0)); assert.deepEqual(px(c.__rgba, 4, 1, 1), px(src, 2, 0, 0))
  assert.deepEqual(px(c.__rgba, 4, 2, 0), px(src, 2, 1, 0)); assert.deepEqual(px(c.__rgba, 4, 3, 3), px(src, 2, 1, 1))
  // 3-arg form at an offset
  ctx.clearRect(0, 0, 4, 4)
  ctx.drawImage(bmp, 1, 2)
  assert.deepEqual(px(c.__rgba, 4, 1, 2), px(src, 2, 0, 0)); assert.deepEqual(px(c.__rgba, 4, 2, 3), px(src, 2, 1, 1)); assert.deepEqual(px(c.__rgba, 4, 0, 0), [0, 0, 0, 0])
  // 9-arg form: one source pixel stretched over the canvas
  ctx.drawImage(bmp, 1, 0, 1, 1, 0, 0, 4, 4)
  assert.deepEqual(px(c.__rgba, 4, 0, 0), px(src, 2, 1, 0)); assert.deepEqual(px(c.__rgba, 4, 3, 3), px(src, 2, 1, 0))
  // downscale (three's resize path): 4x4 → 2x2 picks the pixel under each centre
  const big = new g.OffscreenCanvas(4, 4); big.getContext('2d').putImageData(new g.ImageData(new Uint8ClampedArray(pattern(4, 4)), 4, 4), 0, 0)
  const small = new g.OffscreenCanvas(2, 2); small.getContext('2d').drawImage(big, 0, 0, 2, 2)
  assert.deepEqual(px(small.__rgba, 2, 0, 0), px(pattern(4, 4), 4, 1, 1)); assert.deepEqual(px(small.__rgba, 2, 1, 1), px(pattern(4, 4), 4, 3, 3))
  // a negative destination width mirrors
  const mir = new g.OffscreenCanvas(2, 1); mir.getContext('2d').drawImage(bmp, 0, 0, 2, 1, 2, 0, -2, 1)
  assert.deepEqual(px(mir.__rgba, 2, 0, 0), px(src, 2, 1, 0))
  // alpha blends: a half-transparent draw over white
  const over = new g.OffscreenCanvas(1, 1); const octx = over.getContext('2d')
  octx.fillStyle = 'white'; octx.fillRect(0, 0, 1, 1); octx.globalAlpha = 0.5
  const black = await g.createImageBitmap(new g.ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1))
  octx.drawImage(black, 0, 0)
  assert.deepEqual(px(over.__rgba, 1, 0, 0), [128, 128, 128, 255])
  // Image elements: not loaded → no-op, loaded → drawn; a closed bitmap throws
  const gi = freshGlobal({ fetch: async () => ({ ok: true, arrayBuffer: async () => encodeFake(1, 1, new Uint8Array([5, 6, 7, 255])).buffer }) })
  const img = new gi.Image()
  const ic = new gi.OffscreenCanvas(1, 1); const ictx = ic.getContext('2d')
  ictx.drawImage(img, 0, 0); assert.deepEqual(px(ic.__rgba, 1, 0, 0), [0, 0, 0, 0])
  img.src = 'https://app.local/p.png'; await img.decode()
  ictx.drawImage(img, 0, 0); assert.deepEqual(px(ic.__rgba, 1, 0, 0), [5, 6, 7, 255])
  bmp.close()
  assert.throws(() => ctx.drawImage(bmp, 0, 0), /InvalidStateError|closed/)
  assert.throws(() => ctx.drawImage({}, 0, 0), TypeError)
  assert.throws(() => ctx.drawImage(black, 0, 0, 1, 1, 1, 1), TypeError)
})

test('text, state stack and transforms', () => {
  const g = freshGlobal()
  const ctx = new g.OffscreenCanvas(4, 4).getContext('2d')
  assert.equal(ctx.font, '10px sans-serif')
  ctx.font = 'bold 20px Bungee'; assert.equal(ctx.font, 'bold 20px Bungee')
  const m = ctx.measureText('abcd')
  assert.equal(m.width, 0.6 * 20 * 4); assert.equal(m.actualBoundingBoxAscent, 16)
  ctx.measureText('x'); assert.equal(g.warnings.filter(w => /measureText/.test(w)).length, 1)
  ctx.fillText('hello', 0, 0); ctx.fillText('again', 0, 0)
  assert.equal(g.warnings.filter(w => /fillText/.test(w)).length, 1)
  ctx.fillStyle = 'red'; ctx.globalAlpha = 0.5; ctx.save()
  ctx.fillStyle = 'blue'; ctx.globalAlpha = 1; ctx.translate(1, 1); ctx.scale(2, 2)
  ctx.fillRect(0, 0, 1, 1)  // lands at device (1,1)-(3,3)
  assert.deepEqual(px(ctx.canvas.__rgba, 4, 1, 1), [0, 0, 255, 255]); assert.deepEqual(px(ctx.canvas.__rgba, 4, 2, 2), [0, 0, 255, 255]); assert.deepEqual(px(ctx.canvas.__rgba, 4, 0, 0), [0, 0, 0, 0]); assert.deepEqual(px(ctx.canvas.__rgba, 4, 3, 3), [0, 0, 0, 0])
  ctx.restore()
  assert.equal(ctx.fillStyle, 'red'); assert.equal(ctx.globalAlpha, 0.5); assert.deepEqual(ctx.getTransform().isIdentity, true)
  ctx.restore()  // an empty stack is harmless
  ctx.globalAlpha = 7; assert.equal(ctx.globalAlpha, 0.5)  // out of range → ignored
  ctx.beginPath(); ctx.rect(0, 0, 1, 1); ctx.fill(); ctx.stroke(); ctx.clip()  // no throw
  assert.ok(ctx.getContextAttributes().alpha)
})

test('toBlob yields a PNG Blob asynchronously; toDataURL a base64 data URL', async () => {
  const g = freshGlobal()
  const c = g.__hostCreateCanvas(); c.width = 2; c.height = 1
  const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  c.getContext('2d').putImageData(new g.ImageData(new Uint8ClampedArray(src), 2, 1), 0, 0)
  let sync = true
  const blob = await new Promise(resolve => { c.toBlob(b => { assert.equal(sync, false); resolve(b) }, 'image/png'); sync = false })
  assert.ok(blob instanceof Blob); assert.equal(blob.type, 'image/png')
  const png = decodeFakePng(await blob.arrayBuffer())
  assert.equal(png.width, 2); assert.equal(png.height, 1); assert.deepEqual([...png.rgba], [...src])
  assert.equal(g.__native.img.calls.encodePng, 1)
  // another type is still PNG (warned once)
  const jpg = await new Promise(r => c.toBlob(r, 'image/jpeg'))
  assert.equal(jpg.type, 'image/png'); assert.equal(g.warnings.filter(w => /image\/jpeg/.test(w)).length, 1)
  const url = c.toDataURL()
  assert.match(url, /^data:image\/png;base64,/)
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  assert.deepEqual([...decodeFakePng(bytes).rgba], [...src])
  // an empty canvas gives null / 'data:,'
  const empty = new g.OffscreenCanvas(0, 0)
  assert.equal(await new Promise(r => empty.toBlob(r)), null); assert.equal(empty.toDataURL(), 'data:,')
  assert.throws(() => c.toBlob('nope'), TypeError)
  // a Blob stub on the global is used when given
  class FakeBlob { constructor(parts, opts) { this.parts = parts; this.type = opts.type } }
  const g2 = freshGlobal({ Blob: FakeBlob })
  const c2 = new g2.OffscreenCanvas(1, 1)
  const b2 = await c2.convertToBlob({ type: 'image/png' })
  assert.ok(b2 instanceof FakeBlob); assert.ok(b2.parts[0] instanceof Uint8Array)
})

test('OffscreenCanvas.transferToImageBitmap hands over the pixels and starts a fresh buffer', () => {
  const g = freshGlobal()
  const off = new g.OffscreenCanvas(2, 2)
  assert.throws(() => off.transferToImageBitmap(), /InvalidStateError|no context/)
  const ctx = off.getContext('2d')
  ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 2, 2)
  const buf = off.__rgba
  const bmp = off.transferToImageBitmap()
  assert.ok(bmp instanceof g.ImageBitmap); assert.equal(bmp.width, 2); assert.equal(bmp.height, 2)
  assert.equal(bmp.__rgba, buf); assert.deepEqual(px(bmp.__rgba, 2, 1, 1), [0x12, 0x34, 0x56, 255])
  assert.notEqual(off.__rgba, buf); assert.deepEqual(px(off.__rgba, 2, 0, 0), [0, 0, 0, 0])
  // three's probe: new OffscreenCanvas(1, 1).getContext('2d') !== null
  assert.notEqual(new g.OffscreenCanvas(1, 1).getContext('2d'), null)
  assert.throws(() => new g.OffscreenCanvas(1), TypeError)
})

test('getContext(webgl2|webgl) hands the first canvas the host GL context and later canvases secondary ones', () => {
  const made = []
  const g = freshGlobal({ __hostCreateWebGLContext: (canvas, attrs, type) => { made.push([canvas, attrs, type]); return { fake: true, __hostCanvasResized(w, h) { made.push(['resize', w, h]) } } } })
  const a = g.__hostCreateCanvas()
  const attrs = { alpha: true, antialias: false }
  const gl = a.getContext('webgl2', attrs)
  assert.ok(gl.fake); assert.equal(made.length, 1); assert.equal(made[0][0], a); assert.equal(made[0][1], attrs); assert.equal(made[0][2], 'webgl2')
  assert.equal(a.getContext('webgl2'), gl)        // same object again
  assert.equal(a.getContext('webgl'), gl)
  assert.equal(a.getContext('2d'), null)          // a GL canvas has no 2D context
  assert.equal(a.__rgba, null)                    // the drawing buffer is the GPU's
  a.width = 1024; assert.deepEqual(made[1], ['resize', 1024, 150])
  // A second GL canvas gets a context of its own from the factory (a SECONDARY one over the same GL,
  // see webgl/switch.js); its pixels come from the context's readback, so it can feed texImage2D.
  const b = g.__hostCreateCanvas()
  const gl2 = b.getContext('webgl2'); assert.ok(gl2.fake); assert.equal(made.length, 3); assert.equal(made[2][0], b)
  gl2.__readback = () => new Uint8Array(4); assert.equal(b.__rgba.length, 4)
  const c = g.__hostCreateCanvas()
  assert.notEqual(c.getContext('2d'), null)
  assert.equal(c.getContext('webgl2'), null)      // a 2D canvas never gets GL
  // without the factory (WP-04 absent) GL is simply null, as on a machine without WebGL
  const bare = freshGlobal()
  assert.equal(bare.__hostCreateCanvas().getContext('webgl2'), null)
  assert.equal(bare.__hostCreateCanvas().getContext('webgl2', {}), null)
})

test('gradients, path fills and filters: the toon matcap recipe', () => {
  const g = freshGlobal()
  const c = g.__hostCreateCanvas(); c.width = 64; c.height = 64
  const ctx = c.getContext('2d')
  const lin = ctx.createLinearGradient(0, 0, 64, 0); lin.addColorStop(0, '#000000'); lin.addColorStop(1, '#ffffff')
  ctx.fillStyle = lin; ctx.fillRect(0, 0, 64, 64)
  assert.ok(c.__rgba[0] < 16, 'left edge dark'); assert.ok(c.__rgba[(63) * 4] > 240, 'right edge light')
  const mid = c.__rgba[(10 * 64 + 32) * 4]; assert.ok(mid > 110 && mid < 145, `middle grey (${mid})`)
  // A radial glow with an alpha-0 outer stop fades to nothing past its radius.
  const rad = ctx.createRadialGradient(32, 32, 0, 32, 32, 16); rad.addColorStop(0, 'rgba(255, 0, 0, 1)'); rad.addColorStop(1, 'rgba(255, 0, 0, 0)')
  ctx.fillStyle = rad; ctx.fillRect(0, 0, 64, 64)
  assert.ok(c.__rgba[(32 * 64 + 32) * 4] > 240 && c.__rgba[(32 * 64 + 32) * 4 + 1] < 20, "centre is red")
  assert.ok(c.__rgba[(2 * 64 + 2) * 4 + 1] < 20, 'the corner kept the base ramp (dark)')
  // Path fill: a circle, nonzero winding.
  ctx.fillStyle = '#00ff00'; ctx.beginPath(); ctx.arc(16, 48, 8, 0, Math.PI * 2); ctx.fill()
  assert.equal(c.__rgba[(48 * 64 + 16) * 4 + 1], 255); assert.ok(c.__rgba[(48 * 64 + 40) * 4] > 100 && c.__rgba[(48 * 64 + 16) * 4] === 0, 'outside the circle the ramp is untouched, inside it is pure green')
  // Filters on drawImage: contrast pushes a mid grey apart, brightness lifts.
  const src = g.__hostCreateCanvas(); src.width = 2; src.height = 1; const sc = src.getContext('2d'); sc.fillStyle = '#404040'; sc.fillRect(0, 0, 1, 1); sc.fillStyle = '#c0c0c0'; sc.fillRect(1, 0, 1, 1)
  const dst = g.__hostCreateCanvas(); dst.width = 2; dst.height = 1; const dc = dst.getContext('2d'); dc.filter = 'saturate(1.18) contrast(1.14) brightness(1.03)'; dc.drawImage(src, 0, 0)
  assert.ok(dst.__rgba[0] < 0x40, 'dark got darker'); assert.ok(dst.__rgba[4] > 0xc0, 'light got lighter')
  dc.filter = 'none'; dc.drawImage(src, 0, 0); assert.equal(dst.__rgba[0], 0x40)
})

test('drawImage reads a secondary WebGL canvas once (one readback per draw)', () => {
  let reads = 0
  const g = freshGlobal({ __hostCreateWebGLContext: () => ({ __readback() { reads++; return new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) } }) })
  g.__hostCreateCanvas().getContext('webgl2')                 // the primary
  const sec = g.__hostCreateCanvas(); sec.width = 2; sec.height = 1; sec.getContext('webgl2')
  const c = new g.OffscreenCanvas(2, 1); const ctx = c.getContext('2d')
  ctx.drawImage(sec, 0, 0)
  assert.equal(reads, 1)
  assert.deepEqual([...c.__rgba], [1, 2, 3, 255, 4, 5, 6, 255])
  ctx.filter = 'invert(1)'; ctx.drawImage(sec, 0, 0, 2, 1)
  assert.equal(reads, 2)
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [254, 253, 252, 255])
})

test('drawImage filters round and clamp like a Uint8ClampedArray, per sampled pixel, without touching the source', async () => {
  const g = freshGlobal()
  const data = new Uint8ClampedArray([64, 64, 64, 253, 200, 100, 0, 255])
  const bmp = await g.createImageBitmap(new g.ImageData(new Uint8ClampedArray(data), 2, 1))
  const c = new g.OffscreenCanvas(2, 1); const ctx = c.getContext('2d')
  ctx.filter = 'opacity(0.5)'; ctx.drawImage(bmp, 0, 0)
  assert.equal(c.__rgba[3], 126)                                // 126.5 → 126: round half to even, not Math.round
  assert.equal(c.__rgba[7], 128)                                // 127.5 → 128
  ctx.clearRect(0, 0, 2, 1)
  ctx.filter = 'contrast(2) brightness(2)'; ctx.drawImage(bmp, 0, 0)
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [0, 0, 0, 253])         // (64-128)*2+128 = 0, then *2
  assert.deepEqual(px(c.__rgba, 2, 1, 0), [255, 144, 0, 255])     // 272 clamps; (100-128)*2+128 = 72 → 144; -128 clamps to 0
  assert.deepEqual([...bmp.__rgba], [...data])                  // the source is untouched
  // only the sampled source rect is drawn (the 9-argument form), filter or not
  ctx.clearRect(0, 0, 2, 1); ctx.filter = 'grayscale(100%) blur(1px)'
  ctx.drawImage(bmp, 1, 0, 1, 1, 0, 0, 1, 1)
  const l = Math.round(0.2126 * 200 + 0.7152 * 100 + 0.0722 * 0)
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [l, l, l, 255]); assert.deepEqual(px(c.__rgba, 2, 1, 0), [0, 0, 0, 0])
  assert.equal(g.warnings.filter(w => /blur/.test(w)).length, 1)
})

test('path fill: many edges, nonzero vs evenodd, translucent spans blend exactly', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(8, 8); const ctx = c.getContext('2d')
  // two overlapping squares wound the same way: nonzero fills the overlap, evenodd leaves it
  const squares = () => { ctx.beginPath(); ctx.rect(0, 0, 6, 6); ctx.rect(2, 2, 6, 6) }
  ctx.fillStyle = '#ff0000'; squares(); ctx.fill()
  assert.deepEqual(px(c.__rgba, 8, 3, 3), [255, 0, 0, 255]); assert.deepEqual(px(c.__rgba, 8, 7, 0), [0, 0, 0, 0])
  ctx.clearRect(0, 0, 8, 8); squares(); ctx.fill('evenodd')
  assert.deepEqual(px(c.__rgba, 8, 3, 3), [0, 0, 0, 0]); assert.deepEqual(px(c.__rgba, 8, 1, 1), [255, 0, 0, 255]); assert.deepEqual(px(c.__rgba, 8, 7, 7), [255, 0, 0, 255])
  // a translucent path fill blends exactly like a translucent fillRect over the same pixels
  const d = new g.OffscreenCanvas(8, 8); const dctx = d.getContext('2d')
  for (const k of [ctx, dctx]) { k.fillStyle = '#336699'; k.fillRect(0, 0, 8, 8); k.fillStyle = 'rgba(200, 10, 30, 0.37)'; k.globalAlpha = 0.8 }
  ctx.beginPath(); ctx.rect(1, 2, 5, 4); ctx.fill(); dctx.fillRect(1, 2, 5, 4)
  assert.deepEqual([...c.__rgba], [...d.__rgba])
  // a 2000-vertex polygon (grows the shared edge scratch) still fills its interior
  const big = new g.OffscreenCanvas(64, 64); const bctx = big.getContext('2d'); bctx.fillStyle = '#00f'
  bctx.beginPath(); for (let i = 0; i < 2000; i++) { const t = i / 2000 * Math.PI * 2; bctx.lineTo(32 + 30 * Math.cos(t), 32 + 30 * Math.sin(t)) } bctx.fill()
  assert.deepEqual(px(big.__rgba, 64, 32, 32), [0, 0, 255, 255]); assert.deepEqual(px(big.__rgba, 64, 1, 1), [0, 0, 0, 0])
  // and a small path afterwards is not polluted by the bigger one's leftovers
  ctx.clearRect(0, 0, 8, 8); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(4, 0); ctx.lineTo(0, 4); ctx.fill()
  assert.deepEqual(px(c.__rgba, 8, 0, 0), [255, 255, 255, 255]); assert.deepEqual(px(c.__rgba, 8, 3, 3), [0, 0, 0, 0])
})

test('fillStyle colours are parsed once and shared; save/restore records are reused', () => {
  const g = freshGlobal()
  const a = new g.OffscreenCanvas(2, 2).getContext('2d'), b = new g.OffscreenCanvas(2, 2).getContext('2d')
  a.fillStyle = 'rgba(1, 2, 3, 0.5)'; b.fillStyle = 'rgba(1, 2, 3, 0.5)'
  assert.equal(a.__fillRgba, b.__fillRgba); assert.ok(Object.isFrozen(a.__fillRgba)); assert.deepEqual(a.__fillRgba, [1, 2, 3, 128])
  a.fillStyle = 'nope'; a.fillStyle = 'nope'; assert.equal(a.fillStyle, 'rgba(1, 2, 3, 0.5)'); assert.equal(g.warnings.length, 1)
  for (let i = 0; i < 300; i++) a.fillStyle = `rgb(${i % 256}, 0, 0)`   // past the cache bound: still correct
  assert.deepEqual(a.__fillRgba, [43, 0, 0, 255])
  // nested save/restore, then a second round reuses the same records
  a.fillStyle = 'red'; a.save(); a.fillStyle = 'lime'; a.translate(1, 0); a.save(); a.fillStyle = 'blue'
  a.restore(); assert.equal(a.fillStyle, 'lime'); assert.equal(a.getTransform().e, 1)
  a.restore(); assert.equal(a.fillStyle, 'red'); assert.equal(a.getTransform().e, 0)
  a.restore(); assert.equal(a.fillStyle, 'red')
  const rec = a.__stack[0]; a.save(); assert.equal(a.__stack[0], rec); a.fillStyle = 'blue'; a.restore(); assert.equal(a.fillStyle, 'red')
  a.save(); a.canvas.width = 2; a.restore(); assert.equal(a.fillStyle, '#000000')   // a resize drops the stack
})

test('a secondary WebGL canvas reads back bottom-up: drawImage, toDataURL and createImageBitmap all see it upright', async () => {
  // GL row 0 (the bottom of the picture) is red, row 1 (the top) blue; the context hands out one reused buffer.
  const rb = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255])
  let reads = 0
  const g = freshGlobal({ __hostCreateWebGLContext: () => ({ __readback() { reads++; return rb } }) })
  g.__hostCreateCanvas().getContext('webgl2')
  const sec = g.__hostCreateCanvas(); sec.width = 2; sec.height = 2; sec.getContext('webgl2')
  assert.equal(sec.__rgbaBottomUp, true)
  const c = new g.OffscreenCanvas(2, 2); const ctx = c.getContext('2d')
  ctx.drawImage(sec, 0, 0)
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [0, 0, 255, 255], 'top is blue'); assert.deepEqual(px(c.__rgba, 2, 1, 1), [255, 0, 0, 255], 'bottom is red')
  ctx.clearRect(0, 0, 2, 2); ctx.drawImage(sec, 0, 1, 2, 1, 0, 0, 2, 1)   // the source's bottom row only
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [255, 0, 0, 255]); assert.deepEqual(px(c.__rgba, 2, 0, 1), [0, 0, 0, 0])
  ctx.filter = 'invert(1)'; ctx.drawImage(sec, 0, 0)
  assert.deepEqual(px(c.__rgba, 2, 0, 0), [255, 255, 0, 255], 'filtered and upright')
  const png = decodeFakePng(Buffer.from(sec.toDataURL().slice('data:image/png;base64,'.length), 'base64'))
  assert.deepEqual(px(png.rgba, 2, 0, 0), [0, 0, 255, 255]); assert.deepEqual(px(png.rgba, 2, 0, 1), [255, 0, 0, 255])
  rb.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255])  // toDataURL flipped the scratch in place: refill it
  const before = reads
  const bmpP = g.createImageBitmap(sec)
  assert.equal(reads, before + 1, 'one readback')
  rb.fill(7)   // the context reuses its buffer before the promise settles
  const bmp = await bmpP
  assert.deepEqual(px(bmp.__rgba, 2, 0, 0), [0, 0, 255, 255]); assert.deepEqual(px(bmp.__rgba, 2, 1, 1), [255, 0, 0, 255])
})

test('canvas 2d: Path2D from SVG path data fills and strokes', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(4, 4)
  const ctx = c.getContext('2d')
  const box = new g.Path2D('M 0 0 L 4 0 L 4 4 L 0 4 Z')
  ctx.fillStyle = '#ff0000'
  ctx.fill(box)
  assert.deepEqual(px(c.__rgba, 4, 1, 1), [255, 0, 0, 255])
  const hole = new g.Path2D('M 0 0 L 4 0 L 4 4 L 0 4 Z M 1 1 L 1 3 L 3 3 L 3 1 Z')
  c.width = 4
  ctx.fillStyle = '#00ff00'
  ctx.fill(hole, 'evenodd')
  assert.deepEqual(px(c.__rgba, 4, 0, 0), [0, 255, 0, 255])
  assert.deepEqual(px(c.__rgba, 4, 2, 2), [0, 0, 0, 0])
  const curve = new g.Path2D('M 0 2 C 0 0 4 0 4 2 L 4 4 L 0 4 Z')
  c.width = 4
  ctx.fillStyle = '#0000ff'
  ctx.fill(curve)
  assert.equal(px(c.__rgba, 4, 2, 3)[2], 255)
})

test('canvas 2d: Path2D reads the S, Q and T curve commands (and draws what follows them)', () => {
  const g = freshGlobal()
  const raster = (d) => {
    const c = new g.OffscreenCanvas(16, 16), ctx = c.getContext('2d')
    ctx.fillStyle = '#ffffff'; ctx.fill(new g.Path2D(d))
    return Array.from(c.__rgba)
  }
  // Each shorthand draws what its spelled-out form does: S reflects the previous cubic's second
  // control point, T the previous quadratic's control point, and a quadratic is a cubic at 2/3.
  assert.deepEqual(raster('M 0 8 C 2 0 6 0 8 8 S 14 16 16 8 V 16 H 0 Z'), raster('M 0 8 C 2 0 6 0 8 8 C 10 16 14 16 16 8 V 16 H 0 Z'))
  assert.deepEqual(raster('M 0 8 q 4 -8 8 0 t 8 0 V 16 H 0 Z'), raster('M 0 8 Q 4 0 8 8 Q 12 16 16 8 V 16 H 0 Z'))
  assert.deepEqual(raster('M 0 8 Q 6 2 12 8 V 16 H 0 Z'), raster('M 0 8 C 4 4 8 4 12 8 V 16 H 0 Z'))
  // With no curve just before it, S's first control point is the current point.
  assert.deepEqual(raster('M 0 8 L 2 8 S 10 0 16 8 V 16 H 0 Z'), raster('M 0 8 L 2 8 C 2 8 10 0 16 8 V 16 H 0 Z'))
  // Commands after a quadratic still draw: a square well to its right.
  const after = raster('M 0 0 q 1 0 1 1 Z M 10 10 h 4 v 4 h -4 Z')
  assert.equal(after[(12 * 16 + 12) * 4 + 3], 255)
})

test('an HTMLCanvasElement is an HTMLElement; an OffscreenCanvas is not', () => {
  class EventTarget { constructor() {} addEventListener() {} removeEventListener() {} dispatchEvent() { return true } }
  class HTMLElement extends EventTarget { constructor(tag) { super(); this.tabIndex = 7; this._tag = tag } }
  const g = freshGlobal({ EventTarget, Event: class { constructor(type) { this.type = type } }, HTMLElement })
  const c = g.__hostCreateCanvas()
  assert.ok(c instanceof g.HTMLElement)
  assert.ok(c instanceof g.HTMLCanvasElement)
  assert.equal(c.tabIndex, -1)
  assert.equal(new g.OffscreenCanvas(2, 2) instanceof g.HTMLElement, false)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 1, 1)
  assert.equal(c.__rgba[0], 255)
})

test('clip keeps a clearRect inside the dirty region; restore drops it', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(8, 8), ctx = c.getContext('2d')
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 8)
  ctx.save()
  ctx.beginPath(); ctx.rect(1, 1, 2, 2); ctx.rect(5, 5, 2, 2); ctx.clip()
  ctx.clearRect(0, 0, 8, 8)   // the whole canvas, but only the two clipped rects go
  assert.deepEqual(px(c.__rgba, 8, 0, 0), [255, 0, 0, 255])
  assert.deepEqual(px(c.__rgba, 8, 1, 1), [0, 0, 0, 0])
  assert.deepEqual(px(c.__rgba, 8, 3, 3), [255, 0, 0, 255])
  assert.deepEqual(px(c.__rgba, 8, 6, 6), [0, 0, 0, 0])
  ctx.restore()
  ctx.clearRect(0, 0, 1, 1)
  assert.deepEqual(px(c.__rgba, 8, 0, 0), [0, 0, 0, 0], 'restore brought back the unclipped canvas')
})

test('a curved clip keeps the corner outside it', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(20, 20), ctx = c.getContext('2d')
  ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 20, 20)
  ctx.beginPath()
  ctx.moveTo(8, 0); ctx.lineTo(20, 0); ctx.lineTo(20, 20); ctx.lineTo(0, 20); ctx.lineTo(0, 8)
  ctx.quadraticCurveTo(0, 0, 8, 0)
  ctx.clip()
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 20, 20)
  assert.deepEqual(px(c.__rgba, 20, 0, 0), [0, 255, 0, 255])
  assert.deepEqual(px(c.__rgba, 20, 10, 10), [0, 0, 255, 255])
})

test('destination-out fades to transparent and copy replaces with the source, transparency included', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(8, 4), ctx = c.getContext('2d')
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 4)
  const grad = ctx.createLinearGradient(0, 0, 8, 0)
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = grad; ctx.fillRect(0, 0, 8, 4)
  const left = px(c.__rgba, 8, 0, 1), right = px(c.__rgba, 8, 7, 1)
  assert.ok(left[3] < 40, 'the opaque end of the mask punches the pixel out')
  assert.equal(left[1], 0, 'what remains is the red underneath, not the white mask')
  assert.ok(right[3] > 200 && right[0] === 255 && right[1] === 0)
  const blank = new g.OffscreenCanvas(2, 2)
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(blank, 4, 0)
  assert.deepEqual(px(c.__rgba, 8, 4, 0), [0, 0, 0, 0], 'copy of a transparent image clears, where source-over would leave the old pixel')
  assert.equal(px(c.__rgba, 8, 7, 1)[0], 255)
})

test('a clip limits fills to what it shows: paths outside it are skipped, paths across it keep their edge', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(40, 40), ctx = c.getContext('2d')
  ctx.beginPath(); ctx.rect(10, 10, 10, 10); ctx.clip()
  ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fill()   // outside the clip
  assert.deepEqual(px(c.__rgba, 40, 32, 32), [0, 0, 0, 0])
  ctx.fillStyle = '#00ff00'; ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2); ctx.fill()   // across it
  assert.deepEqual(px(c.__rgba, 40, 15, 15), [0, 255, 0, 255])
  assert.deepEqual(px(c.__rgba, 40, 25, 25), [0, 0, 0, 0], 'still clipped')
})

test('a linear gradient fill matches its stops pixel by pixel (the table and the stepped span)', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(256, 2), ctx = c.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, 256, 0)
  grad.addColorStop(0, '#000000'); grad.addColorStop(1, '#ffffff')
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 2)
  for (const x of [0, 64, 128, 200, 255]) assert.ok(Math.abs(px(c.__rgba, 256, x, 1)[0] - (x + 0.5)) <= 1, `x ${x}: ${px(c.__rgba, 256, x, 1)[0]}`)
  // Scaled, the same ramp in device pixels.
  const d = new g.OffscreenCanvas(256, 2), dtx = d.getContext('2d')
  dtx.scale(2, 1); const half = dtx.createLinearGradient(0, 0, 128, 0)
  half.addColorStop(0, '#000000'); half.addColorStop(1, '#ffffff')
  dtx.fillStyle = half; dtx.fillRect(0, 0, 128, 2)
  for (const x of [10, 128, 250]) assert.ok(Math.abs(px(d.__rgba, 256, x, 0)[0] - px(c.__rgba, 256, x, 0)[0]) <= 1, `scaled x ${x}`)
})

test('destination-over draws under what is there: a panel ground behind its text', () => {
  const g = freshGlobal()
  const c = new g.OffscreenCanvas(8, 4), ctx = c.getContext('2d')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 4, 4)            // the "text", left half
  ctx.globalCompositeOperation = 'destination-over'
  assert.equal(ctx.globalCompositeOperation, 'destination-over')
  ctx.fillStyle = 'rgba(0,0,255,0.5)'; ctx.fillRect(0, 0, 8, 4)  // the ground, everywhere
  assert.deepEqual(px(c.__rgba, 8, 1, 1), [255, 255, 255, 255], 'opaque content stays on top')
  assert.deepEqual(px(c.__rgba, 8, 6, 1), [0, 0, 255, 128], 'empty pixels take the ground')
  ctx.beginPath(); ctx.arc(6, 2, 2, 0, Math.PI * 2); ctx.fillStyle = '#ff0000'; ctx.fill()
  // Blue at alpha 128/255 over red: a near-even mix, now opaque.
  assert.deepEqual(px(c.__rgba, 8, 6, 2), [127, 0, 128, 255], 'a path under a half-transparent pixel stays behind it')
})

test('canvas 2d: stroke draws a line of lineWidth, round caps, the stroke colour', async () => {
  const { makeCanvas } = await import('../src/images/canvas2d.js')
  const g = { document: null }; const { HTMLCanvasElement } = makeCanvas(g, { EventTargetBase: class {}, ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h } }, ImageBitmap: class {}, newBitmap: () => null, warnOnce: () => {}, defer: (f) => f() })
  const c = new HTMLCanvasElement(); c.width = 40; c.height = 20
  const ctx = c.getContext('2d'); ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 6; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(10, 10); ctx.lineTo(30, 10); ctx.stroke()
  const px = (x, y) => Array.from(c.__rgba.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4))
  assert.deepEqual(px(20, 10), [255, 0, 0, 255]); assert.deepEqual(px(20, 8), [255, 0, 0, 255]); assert.deepEqual(px(20, 4), [0, 0, 0, 0])
  assert.deepEqual(px(8, 10), [255, 0, 0, 255])   // the round cap past the start
  assert.deepEqual(px(35, 10), [0, 0, 0, 0])
})

async function canvas2d(w, h) {
  const { makeCanvas } = await import('../src/images/canvas2d.js')
  const g = { document: null }; const { HTMLCanvasElement } = makeCanvas(g, { EventTargetBase: class {}, ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h } }, ImageBitmap: class {}, newBitmap: () => null, warnOnce: () => {}, defer: (f) => f() })
  const c = new HTMLCanvasElement(); c.width = w; c.height = h
  const at = (x, y) => c.__rgba[(y * w + x) * 4 + 3]
  return { c, ctx: c.getContext('2d'), at }
}

test('canvas 2d: setLineDash leaves gaps along a stroke (dashed outlines)', async () => {
  const { ctx, at } = await canvas2d(60, 10)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2
  ctx.setLineDash([10, 5]); assert.deepEqual(ctx.getLineDash(), [10, 5])
  ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(60, 5); ctx.stroke()
  assert.equal(at(5, 5), 255); assert.equal(at(12, 5), 0); assert.equal(at(17, 5), 255); assert.equal(at(27, 5), 0)
  // An odd list repeats; a bad one is ignored; save/restore keep it.
  ctx.setLineDash([4]); assert.deepEqual(ctx.getLineDash(), [4, 4])
  ctx.setLineDash([3, -1]); assert.deepEqual(ctx.getLineDash(), [4, 4])
  ctx.save(); ctx.setLineDash([]); ctx.restore(); assert.deepEqual(ctx.getLineDash(), [4, 4])
  // The offset shifts the pattern along.
  const b = await canvas2d(60, 10)
  b.ctx.strokeStyle = '#fff'; b.ctx.lineWidth = 2; b.ctx.setLineDash([10, 5]); b.ctx.lineDashOffset = 5
  b.ctx.beginPath(); b.ctx.moveTo(0, 5); b.ctx.lineTo(60, 5); b.ctx.stroke()
  assert.equal(at(7, 5), 255); assert.equal(b.at(7, 5), 0); assert.equal(b.at(2, 5), 255)
})

test('canvas 2d: roundRect rounds its corners (one radius or a list), arcTo rounds a corner', async () => {
  const { ctx, at } = await canvas2d(40, 40)
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(0, 0, 40, 40, 12); ctx.fill()
  assert.equal(at(0, 0), 0); assert.equal(at(39, 39), 0); assert.equal(at(20, 20), 255); assert.equal(at(20, 0), 255); assert.equal(at(1, 20), 255)
  const b = await canvas2d(40, 40)
  b.ctx.fillStyle = '#fff'; b.ctx.beginPath(); b.ctx.roundRect(0, 0, 40, 40, [12, 0]); b.ctx.fill()
  assert.equal(b.at(0, 0), 0); assert.equal(b.at(39, 0), 255); assert.equal(b.at(39, 39), 0); assert.equal(b.at(0, 39), 255)
  assert.throws(() => b.ctx.roundRect(0, 0, 4, 4, -1), RangeError)
  const a = await canvas2d(40, 40)
  a.ctx.fillStyle = '#fff'; a.ctx.beginPath(); a.ctx.moveTo(0, 0); a.ctx.arcTo(40, 0, 40, 40, 16); a.ctx.lineTo(40, 40); a.ctx.lineTo(0, 40); a.ctx.closePath(); a.ctx.fill()
  assert.equal(a.at(39, 0), 0); assert.equal(a.at(20, 1), 255); assert.equal(a.at(38, 20), 255)
})

test('canvas 2d: fills are anti-aliased at their edges, and a rectangle on whole pixels stays exact', async () => {
  const { ctx, c } = await canvas2d(40, 40)
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(20, 20, 12.3, 0, Math.PI * 2); ctx.fill()
  const alphas = new Set()
  for (let i = 3; i < c.__rgba.length; i += 4) alphas.add(c.__rgba[i])
  assert.ok([...alphas].some(a => a > 0 && a < 255), 'partly covered edge pixels')
  const b = await canvas2d(10, 10)
  b.ctx.fillStyle = '#fff'; b.ctx.fillRect(2, 2, 5, 5); b.ctx.beginPath(); b.ctx.rect(2, 2, 5, 5); b.ctx.fill()
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) assert.equal(b.at(x, y), x >= 2 && x < 7 && y >= 2 && y < 7 ? 255 : 0)
  // Half a pixel in: half covered.
  const h = await canvas2d(10, 4)
  h.ctx.fillStyle = '#fff'; h.ctx.beginPath(); h.ctx.rect(2.5, 0, 4, 4); h.ctx.fill()
  assert.ok(Math.abs(h.at(2, 1) - 128) <= 2); assert.equal(h.at(3, 1), 255); assert.ok(Math.abs(h.at(6, 1) - 128) <= 2)
})

test('canvas 2d: rotate, transform and setTransform turn paths and rects (labels laid out around a dial, a quarter turn each)', async () => {
  const { ctx, at } = await canvas2d(40, 40)
  ctx.fillStyle = '#fff'
  // A bar along +x from the centre, turned a quarter: it now runs along +y.
  ctx.save(); ctx.translate(20, 20); ctx.rotate(Math.PI / 2); ctx.fillRect(0, -2, 15, 4); ctx.restore()
  assert.equal(at(20, 30), 255); assert.equal(at(30, 20), 0)
  assert.deepEqual(Object.values(ctx.getTransform()).slice(0, 6), [1, 0, 0, 1, 0, 0])
  // An eighth turn about the centre: a diagonal, so the corner-ward pixel is lit and the axis one is not.
  const d = await canvas2d(40, 40)
  d.ctx.fillStyle = '#fff'; d.ctx.translate(20, 20); d.ctx.rotate(Math.PI / 4); d.ctx.beginPath(); d.ctx.rect(0, -1.5, 16, 3); d.ctx.fill()
  assert.equal(d.at(28, 28), 255); assert.equal(d.at(34, 20), 0)
  const m = d.ctx.getTransform()
  assert.ok(Math.abs(m.a - Math.SQRT1_2) < 1e-9 && Math.abs(m.b - Math.SQRT1_2) < 1e-9 && Math.abs(m.c + Math.SQRT1_2) < 1e-9 && m.e === 20)
  // setTransform keeps the rotation it is given; transform multiplies onto the current matrix.
  d.ctx.setTransform(0, 1, -1, 0, 5, 6); assert.deepEqual([d.ctx.getTransform().b, d.ctx.getTransform().c], [1, -1])
  d.ctx.resetTransform(); d.ctx.transform(2, 0, 0, 2, 1, 1); d.ctx.transform(1, 0, 0, 1, 3, 0)
  assert.deepEqual([d.ctx.getTransform().a, d.ctx.getTransform().e], [2, 7])
})
