import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFake, freshGlobal, pattern, px } from './images-support.test.js'

test('ImageData constructors and validation', () => {
  const g = freshGlobal()
  const a = new g.ImageData(4, 3)
  assert.equal(a.width, 4); assert.equal(a.height, 3); assert.equal(a.data.length, 48); assert.equal(a.colorSpace, 'srgb')
  assert.ok(a.data instanceof Uint8ClampedArray)
  const data = new Uint8ClampedArray(2 * 5 * 4); data[0] = 9
  const b = new g.ImageData(data, 2)
  assert.equal(b.height, 5); assert.equal(b.data, data)
  const c = new g.ImageData(data, 2, 5)
  assert.equal(c.width, 2)
  // a Uint8Array is wrapped over the same memory (the MSDF worker's texture)
  const u8 = new Uint8Array(16); u8[4] = 7
  const d = new g.ImageData(u8, 2, 2)
  assert.ok(d.data instanceof Uint8ClampedArray); assert.equal(d.data[4], 7); assert.equal(d.data.buffer, u8.buffer)
  // the pixel-source view aliases the data
  assert.ok(d.__rgba instanceof Uint8Array); d.data[1] = 42; assert.equal(d.__rgba[1], 42)
  assert.throws(() => new g.ImageData(0, 3), /IndexSizeError|zero/)
  assert.throws(() => new g.ImageData(2, 0), /IndexSizeError|zero/)
  assert.throws(() => new g.ImageData(data, 3), /IndexSizeError|multiple/)
  assert.throws(() => new g.ImageData(data, 2, 4), /IndexSizeError|match/)
  assert.throws(() => new g.ImageData(new Uint8ClampedArray(6), 1), /InvalidStateError|multiple of 4/)
  assert.throws(() => new g.ImageData([1, 2, 3, 4], 1), TypeError)
  assert.throws(() => new g.ImageData(4), TypeError)
  // own enumerable fields survive a structured clone as a plain object (the worker path)
  const clone = structuredClone(c)
  assert.equal(clone.width, 2); assert.equal(clone.height, 5); assert.equal(clone.data.length, 40)
  assert.equal(Object.prototype.toString.call(a), '[object ImageData]')
})

test('createImageBitmap from a Blob decodes through __native.img', async () => {
  const g = freshGlobal()
  const src = pattern(3, 2)
  const blob = new Blob([encodeFake(3, 2, src)], { type: 'image/png' })
  const bmp = await g.createImageBitmap(blob)
  assert.ok(bmp instanceof g.ImageBitmap)
  assert.equal(bmp.width, 3); assert.equal(bmp.height, 2)
  assert.ok(bmp.__rgba instanceof Uint8Array); assert.equal(bmp.__rgba.length, 24)
  assert.deepEqual([...bmp.__rgba], [...src])  // rows stay top-down: no flip in the decoder
  assert.equal(bmp.__premultiplied, false)
  assert.equal(g.__native.img.calls.decode, 1)
  bmp.close()
  assert.equal(bmp.width, 0); assert.equal(bmp.height, 0); assert.equal(bmp.__rgba, null)
  assert.throws(() => new g.ImageBitmap(), TypeError)
})

test('createImageBitmap from a Blob works with an asynchronous decoder too', async () => {
  const g = freshGlobal({}, { async: true })
  const bmp = await g.createImageBitmap(new Blob([encodeFake(2, 2, pattern(2, 2))]))
  assert.equal(bmp.width, 2)
})

test('imageOrientation flipY flips rows at creation', async () => {
  const g = freshGlobal()
  const src = pattern(2, 3)
  const blob = new Blob([encodeFake(2, 3, src)])
  const bmp = await g.createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  assert.deepEqual(px(bmp.__rgba, 2, 0, 0), px(src, 2, 0, 2))  // the top row is the source's bottom row
  assert.deepEqual(px(bmp.__rgba, 2, 1, 2), px(src, 2, 1, 0))
  assert.equal(bmp.__premultiplied, false)
  // alpha stays straight under 'none'
  assert.equal(bmp.__rgba[3], 255 - 2)
  const plain = await g.createImageBitmap(blob, { imageOrientation: 'none' })
  assert.deepEqual([...plain.__rgba], [...src])
  const fromImage = await g.createImageBitmap(blob, { imageOrientation: 'from-image' })
  assert.deepEqual([...fromImage.__rgba], [...src])
  await assert.rejects(g.createImageBitmap(blob, { imageOrientation: 'sideways' }), TypeError)
})

test('premultiplyAlpha premultiplies at creation and marks the bitmap', async () => {
  const g = freshGlobal()
  const rgba = new Uint8Array([200, 100, 50, 128, 255, 255, 255, 0, 10, 20, 30, 255, 100, 100, 100, 64])
  const data = new g.ImageData(new Uint8ClampedArray(rgba), 2, 2)
  const pm = await g.createImageBitmap(data, { premultiplyAlpha: 'premultiply' })
  assert.equal(pm.__premultiplied, true)
  assert.deepEqual(px(pm.__rgba, 2, 0, 0), [100, 50, 25, 128])
  assert.deepEqual(px(pm.__rgba, 2, 1, 0), [0, 0, 0, 0])
  assert.deepEqual(px(pm.__rgba, 2, 0, 1), [10, 20, 30, 255])
  assert.deepEqual(px(pm.__rgba, 2, 1, 1), [25, 25, 25, 64])
  // the source ImageData is untouched
  assert.equal(data.data[0], 200)
  // 'default' and 'none' leave straight alpha
  const def = await g.createImageBitmap(data, { premultiplyAlpha: 'default' })
  assert.equal(def.__premultiplied, false); assert.equal(def.__rgba[0], 200)
  // premultiplying an already premultiplied bitmap does not double it
  const again = await g.createImageBitmap(pm, { premultiplyAlpha: 'premultiply' })
  assert.deepEqual(px(again.__rgba, 2, 0, 0), [100, 50, 25, 128])
  // flipY + premultiply together: three's GLTF options with KHR_texture_transform
  const both = await g.createImageBitmap(data, { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply' })
  assert.deepEqual(px(both.__rgba, 2, 0, 0), [10, 20, 30, 255])
  assert.deepEqual(px(both.__rgba, 2, 1, 1), [0, 0, 0, 0])
})

test('createImageBitmap copies from ImageBitmap, ImageData and canvases, with crop and resize', async () => {
  const g = freshGlobal()
  const src = pattern(4, 4)
  const data = new g.ImageData(new Uint8ClampedArray(src), 4, 4)
  const whole = await g.createImageBitmap(data)
  assert.notEqual(whole.__rgba.buffer, data.data.buffer)  // never aliases its source
  assert.deepEqual([...whole.__rgba], [...src])
  const cropped = await g.createImageBitmap(whole, 1, 2, 2, 2)
  assert.equal(cropped.width, 2); assert.equal(cropped.height, 2)
  assert.deepEqual(px(cropped.__rgba, 2, 0, 0), px(src, 4, 1, 2))
  assert.deepEqual(px(cropped.__rgba, 2, 1, 1), px(src, 4, 2, 3))
  // a crop reaching outside the source is transparent black there
  const edge = await g.createImageBitmap(whole, 3, 3, 2, 2, {})
  assert.deepEqual(px(edge.__rgba, 2, 0, 0), px(src, 4, 3, 3))
  assert.deepEqual(px(edge.__rgba, 2, 1, 1), [0, 0, 0, 0])
  await assert.rejects(g.createImageBitmap(whole, 0, 0, 0, 2), RangeError)
  // resize goes through __native.img.resize unless pixelated
  const small = await g.createImageBitmap(whole, { resizeWidth: 2, resizeHeight: 2 })
  assert.equal(small.width, 2); assert.equal(small.height, 2); assert.equal(g.__native.img.calls.resize, 1)
  const byWidth = await g.createImageBitmap(whole, { resizeWidth: 8, resizeQuality: 'pixelated' })
  assert.equal(byWidth.width, 8); assert.equal(byWidth.height, 8); assert.equal(g.__native.img.calls.resize, 1)
  assert.deepEqual(px(byWidth.__rgba, 8, 7, 7), px(src, 4, 3, 3))
  // canvas sources
  const canvas = g.__hostCreateCanvas(); canvas.width = 2; canvas.height = 2
  canvas.getContext('2d').putImageData(new g.ImageData(new Uint8ClampedArray(pattern(2, 2)), 2, 2), 0, 0)
  const fromCanvas = await g.createImageBitmap(canvas)
  assert.deepEqual([...fromCanvas.__rgba], [...pattern(2, 2)])
  const off = new g.OffscreenCanvas(2, 1)
  const fromOff = await g.createImageBitmap(off)
  assert.equal(fromOff.width, 2); assert.deepEqual([...fromOff.__rgba], [0, 0, 0, 0, 0, 0, 0, 0])
  // a closed bitmap, a bad blob and junk all reject
  whole.close()
  await assert.rejects(g.createImageBitmap(whole), /InvalidStateError|closed/)
  await assert.rejects(g.createImageBitmap(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])), /could not be decoded/)
  await assert.rejects(g.createImageBitmap(42), TypeError)
  await assert.rejects(g.createImageBitmap(null), TypeError)
})

test('createImageBitmap from a loaded Image element, and not from an unloaded one', async () => {
  const src = pattern(2, 2)
  const g = freshGlobal({ fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => encodeFake(2, 2, src).buffer }) })
  const img = new g.Image()
  await assert.rejects(g.createImageBitmap(img), /InvalidStateError|not loaded|no readable/)
  img.src = 'https://app.local/a.png'
  await img.decode()
  const bmp = await g.createImageBitmap(img, { imageOrientation: 'flipY' })
  assert.deepEqual(px(bmp.__rgba, 2, 0, 0), px(src, 2, 0, 1))
})
