import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFake, freshGlobal, pattern } from './images-support.test.js'

const tick = () => new Promise(r => setImmediate(r))

function fetchStub(table, log = []) {
  return async (url) => {
    log.push(url)
    const hit = table[url]
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, arrayBuffer: async () => hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) }
  }
}

test('Image src fetches, decodes and fires load through onload and addEventListener', async () => {
  const src = pattern(3, 2)
  const log = []
  const g = freshGlobal({ fetch: fetchStub({ 'https://app.local/textures/a.png': encodeFake(3, 2, src) }, log), location: { href: 'https://app.local/index.html' } })
  const img = new g.Image()
  assert.ok(img instanceof g.HTMLImageElement); assert.ok(img instanceof g.Image)
  assert.equal(img.complete, true); assert.equal(img.src, ''); assert.equal(img.naturalWidth, 0); assert.equal(img.__rgba, null)
  const events = []
  img.addEventListener('load', function (ev) { events.push(['listener', ev.type, this === img, ev.target === img]) })
  img.onload = function (ev) { events.push(['onload', ev.type, this === img]) }
  img.onerror = () => events.push(['onerror'])
  img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'
  img.src = 'textures/a.png'  // relative to the document, like three's ImageLoader hands it over
  assert.equal(img.src, 'https://app.local/textures/a.png')
  assert.equal(img.complete, false)
  await img.decode()
  assert.equal(img.complete, true)
  assert.equal(img.naturalWidth, 3); assert.equal(img.naturalHeight, 2)
  assert.equal(img.width, 3); assert.equal(img.height, 2)
  assert.equal(img.currentSrc, 'https://app.local/textures/a.png')
  assert.ok(img.__rgba instanceof Uint8Array); assert.deepEqual([...img.__rgba], [...src])
  assert.deepEqual(log, ['https://app.local/textures/a.png'])
  assert.deepEqual(events, [['listener', 'load', true, true], ['onload', 'load', true]])
  assert.equal(img.crossOrigin, 'anonymous')
  // the handler attribute can be replaced and removed
  img.onload = null
  assert.equal(img.onload, null)
})

test('Image error paths: HTTP failure and undecodable bytes fire error, decode() rejects', async () => {
  const g = freshGlobal({ fetch: fetchStub({ 'https://app.local/junk.png': new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]) }) })
  const a = new g.Image()
  const got = []
  a.addEventListener('error', ev => got.push(ev.type))
  a.onerror = () => got.push('onerror')
  a.onload = () => got.push('load?!')
  a.src = 'https://app.local/missing.png'
  await assert.rejects(a.decode(), /EncodingError|cannot be decoded/)
  assert.equal(a.complete, true); assert.equal(a.naturalWidth, 0); assert.equal(a.__rgba, null)
  assert.deepEqual(got, ['error', 'onerror'])
  const b = new g.Image()
  const p = new Promise(r => b.addEventListener('error', () => r('error')))
  b.src = 'https://app.local/junk.png'
  assert.equal(await p, 'error')
  await assert.rejects(b.decode(), /EncodingError/)
  // decode() on an image with no src rejects too
  await assert.rejects(new g.Image().decode(), /EncodingError/)
})

test('a later src supersedes an earlier load', async () => {
  const slowBytes = encodeFake(1, 1, new Uint8Array([1, 1, 1, 255]))
  const fastBytes = encodeFake(2, 1, new Uint8Array([2, 2, 2, 255, 3, 3, 3, 255]))
  let releaseSlow
  const g = freshGlobal({ fetch: async (url) => url.endsWith('slow.png')
    ? new Promise(r => { releaseSlow = () => r({ ok: true, arrayBuffer: async () => slowBytes.buffer }) })
    : { ok: true, arrayBuffer: async () => fastBytes.buffer } })
  const img = new g.Image()
  let loads = 0
  img.onload = () => loads++
  img.src = 'https://app.local/slow.png'
  img.src = 'https://app.local/fast.png'
  await img.decode()
  releaseSlow(); await tick(); await tick(); await tick()
  assert.equal(loads, 1); assert.equal(img.naturalWidth, 2); assert.equal(img.src, 'https://app.local/fast.png')
})

test('data: URLs decode without fetch; width/height attributes; setAttribute', async () => {
  const g = freshGlobal()  // no fetch on this global at all
  const src = pattern(2, 2)
  const b64 = Buffer.from(encodeFake(2, 2, src)).toString('base64')
  const img = new g.Image(10, 20)
  assert.equal(img.width, 10); assert.equal(img.height, 20)
  const loaded = new Promise(r => { img.onload = r })
  img.setAttribute('src', 'data:image/png;base64,' + b64)
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,' + b64)
  await loaded
  assert.equal(img.naturalWidth, 2); assert.equal(img.width, 10)  // an authored size wins over the natural one
  assert.deepEqual([...img.__rgba], [...src])
  img.removeAttribute('width'); assert.equal(img.width, 2)
  assert.equal(img.tagName, 'IMG'); assert.equal(img.nodeType, 1)
  img.setAttribute('alt', 'x'); assert.equal(img.getAttribute('alt'), 'x'); assert.equal(img.hasAttribute('alt'), true)
  // an empty src empties the element without an event
  let fired = 0; img.addEventListener('error', () => fired++)
  img.src = ''
  await tick()
  assert.equal(img.complete, true); assert.equal(img.__rgba, null); assert.equal(fired, 0)
  // __hostCreateImage is what dom-lite's createElement('img') calls
  assert.ok(g.__hostCreateImage() instanceof g.HTMLImageElement)
})

test('with a global EventTarget/Event the element rides them', async () => {
  const src = pattern(1, 1)
  const g = freshGlobal({ EventTarget, Event, fetch: fetchStub({ 'https://app.local/a.png': encodeFake(1, 1, src) }) })
  const img = new g.Image()
  assert.ok(img instanceof EventTarget)
  const seen = []
  img.addEventListener('load', function (ev) { seen.push([ev instanceof Event, ev.target === img, this === img]) })
  img.onload = () => seen.push('onload')
  img.src = 'https://app.local/a.png'
  await img.decode()
  await tick()
  assert.deepEqual(seen, [[true, true, true], 'onload'])
  // three's ImageLoader removes its listeners after the load
  const fn = () => seen.push('again')
  img.addEventListener('load', fn); img.removeEventListener('load', fn)
  img.src = 'https://app.local/a.png'
  await img.decode(); await tick()
  assert.equal(seen.length, 4); assert.ok(!seen.includes('again'))  // the first listener and onload fire again, the removed one does not
})

test('an HTMLImageElement is an HTMLElement with an IMG tag, and VideoFrame exists for instanceof', () => {
  class Element {}
  class HTMLElement extends Element {}
  const g = freshGlobal({ EventTarget, Event, HTMLElement })
  const img = new g.Image()
  assert.ok(img instanceof g.HTMLElement)
  assert.ok(img instanceof Element)
  assert.equal(img.tagName, 'IMG')
  assert.equal(img.namespaceURI, 'http://www.w3.org/1999/xhtml')
  assert.equal(img.id, '')
  img.id = 'icon'
  assert.equal(img.id, 'icon')
  assert.equal(typeof g.VideoFrame, 'function')
  assert.equal(img instanceof g.VideoFrame, false)
})
