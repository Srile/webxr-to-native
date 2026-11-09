import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
// Install the prelude's core pieces onto a sandbox object (not node's global).
import { install as installCore, installPageElements } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
function sandbox(over) { const g = Object.create(null); g.__native = fakeNative(over); g.Promise = Promise; g.WebAssembly = Object.create(globalThis.WebAssembly); g.crypto = { getRandomValues: (a) => globalThis.crypto.getRandomValues(a), randomUUID: () => globalThis.crypto.randomUUID() }; installCore(g); installFetch(g); installPageElements(g); return g }
test('window/document basics', () => { const g = sandbox({ config: { web: { origin: 'https://app.local', entry: 'assets/index.js', elements: [{ tag: 'div', id: 'scene-container', class: '', parent: null }, { tag: 'div', id: 'loading', class: 'a b', parent: null }, { tag: 'div', id: 'loading-fill', class: '', parent: 'loading' }] } } }); assert.equal(g.window, g); assert.equal(g.location.origin, 'https://app.local'); assert.equal(g.document.getElementById('loading-fill').parentNode.id, 'loading'); assert.ok(g.document.getElementById('loading').classList.contains('b')); const c = g.document.getElementById('scene-container'); assert.equal(c.clientWidth, 1280); assert.ok(g.document.body.contains(c)); const l = g.document.getElementById('loading'); l.style.display = 'none'; assert.equal(l.style.display, 'none'); l.classList.add('gone'); assert.ok(l.classList.contains('gone')); l.remove(); assert.equal(l.parentNode, null); assert.equal(g.document.getElementById('loading'), null) })
test('timers and rAF through __native.loop', async () => { const g = sandbox(); const order = []; g.setTimeout(() => order.push('t'), 1); g.requestAnimationFrame(t => order.push('raf:' + typeof t)); g.__hostRunWindowFrame(16); await new Promise(r => setTimeout(r, 10)); assert.deepEqual(order, ['raf:number', 't']) })
test('events on window', () => { const g = sandbox(); let got = 0; g.addEventListener('resize', () => got++); g.__hostSetViewport(100, 50); assert.equal(got, 1); assert.equal(g.innerWidth, 100) })
test('localStorage proxy', () => { const g = sandbox(); g.localStorage.setItem('a', '1'); g.localStorage.b = 2; assert.equal(g.localStorage.getItem('b'), '2'); assert.equal(g.localStorage.length, 2); assert.equal(g.localStorage.a, '1'); g.localStorage.removeItem('a'); assert.equal(g.localStorage.getItem('a'), null) })
test('fetch same-origin asset via __native.assets', async () => { const g = sandbox({ assets: { read: (p) => p === 'data.json' ? new TextEncoder().encode('{"x":1}').buffer : null, readText: () => null, exists: () => true, mime: () => 'application/json' } }); const r = await g.fetch('/data.json'); assert.equal(r.ok, true); assert.equal(r.headers.get('content-type'), 'application/json'); assert.deepEqual(await r.json(), { x: 1 }); const miss = await g.fetch('https://app.local/nope.bin'); assert.equal(miss.status, 404) })
test('fetch cross-origin via __native.net', async () => { const g = sandbox({ net: { fetch: (m, u, h, b, cb) => cb(201, 'Created', [['content-type', 'text/plain']], new TextEncoder().encode('hi').buffer, null) } }); const r = await g.fetch('https://api.example.com/x', { method: 'POST', body: 'payload', headers: { 'X-A': '1' } }); assert.equal(r.status, 201); assert.equal(await r.text(), 'hi'); assert.equal(r.type, 'cors') })
test('blob urls round trip', async () => { const g = sandbox(); const b = new g.Blob(['abc', new Uint8Array([100])], { type: 'text/plain' }); assert.equal(b.size, 4); const u = g.URL.createObjectURL(b); assert.ok(u.startsWith('blob:https://app.local/')); const r = await g.fetch(u); assert.equal(await r.text(), 'abcd'); g.URL.revokeObjectURL(u); await assert.rejects(g.fetch(u)) })
test('TextDecoder streaming + Headers + Response.json', async () => { const g = sandbox(); const d = new g.TextDecoder(); const bytes = new g.TextEncoder().encode('héllo€'); assert.equal(d.decode(bytes.subarray(0, 2), { stream: true }) + d.decode(bytes.subarray(2)), 'héllo€'); const h = new g.Headers({ 'Content-Type': 'a' }); h.append('content-type', 'b'); assert.equal(h.get('CONTENT-TYPE'), 'a, b'); const r = g.Response.json({ a: 1 }); assert.deepEqual(await r.json(), { a: 1 }) })
test('XMLHttpRequest arraybuffer', async () => { const g = sandbox({ assets: { read: (p) => new Uint8Array([1, 2, 3]).buffer, readText: () => null, exists: () => true, mime: () => 'application/octet-stream' } }); const x = new g.XMLHttpRequest(); x.open('GET', '/x.bin'); x.responseType = 'arraybuffer'; const done = new Promise(r => x.onload = r); x.send(); await done; assert.equal(x.status, 200); assert.equal(x.response.byteLength, 3) })
test('wasm instantiateStreaming over our Response', async () => { const g = sandbox(); const wasm = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]); const r = new g.Response(wasm, { headers: { 'content-type': 'application/wasm' } }); const { instance } = await g.WebAssembly.instantiateStreaming(Promise.resolve(r)); assert.equal(instance.exports.add(2, 3), 5) })
test('structuredClone + atob/btoa + AbortController', () => { const g = sandbox(); assert.deepEqual(g.structuredClone({ a: [1, { b: 2 }] }), { a: [1, { b: 2 }] }); assert.equal(g.btoa('hi'), 'aGk='); assert.equal(g.atob('aGk='), 'hi'); const c = new g.AbortController(); let fired = 0; c.signal.addEventListener('abort', () => fired++); c.abort(); assert.equal(fired, 1); assert.equal(c.signal.aborted, true) })
test('streams: pipeThrough a TransformStream into a WritableStream sink, in order, then close; a failing sink rejects', async () => {
  const g = sandbox(); const got = []; let closed = false, started = false
  class Src { start(c) { c.enqueue(new Uint8Array([1])); c.enqueue(new Uint8Array([2, 3])); c.close() } }  // a class source, as Wonderland's ArrayBufferSource
  const t = new g.TransformStream({ transform(chunk, c) { c.enqueue(chunk.length) }, flush(c) { c.enqueue(-1) } })
  await new g.ReadableStream(new Src()).pipeThrough(t).pipeTo(new g.WritableStream({ start() { started = true }, write(n) { got.push(n) }, close() { closed = true } }))
  assert.deepEqual(got, [1, 2, -1]); assert.ok(started && closed)
  const res = new g.Response(new Uint8Array([7, 8])); const parts = []
  await res.body.pipeTo(new g.WritableStream({ write(c) { parts.push(c) } })); assert.deepEqual([...parts[0]], [7, 8])
  await assert.rejects(new g.ReadableStream({ start(c) { c.enqueue(1); c.close() } }).pipeTo(new g.WritableStream({ write() { throw new Error('sink') } })), /sink/)
})
test('page elements: the whole tree from pack.mjs (parent indices, attributes); selectors with descendant and child combinators', () => {
  const g = sandbox({ config: { web: { origin: 'https://app.local', entry: 'a.js', elements: [
    { tag: 'div', id: 'modal', class: 'm', parent: -1 }, { tag: 'div', id: 'box', parent: 0 }, { tag: 'input', parent: 1, attrs: { type: 'text', 'data-k': 'v' } },
    { tag: 'button', parent: 1 }, { tag: 'p', class: 'note', parent: 0 }, { tag: 'canvas', id: 'c', parent: -1 }] } } })
  const d = g.document
  assert.equal(d.querySelector('#box input').getAttribute('type'), 'text')
  assert.equal(d.getElementById('modal').querySelector('#box button').localName, 'button')
  assert.equal(d.querySelector('#modal > p.note').className, 'note')
  assert.equal(d.querySelector('#modal > input'), null)  // a grandchild, not a child
  assert.equal(d.querySelector('div [data-k=v]').localName, 'input')
  assert.equal(d.querySelectorAll('div, p').length, 3)
  assert.equal(d.querySelector('p:not(.other)').localName, 'p')
  assert.ok(d.getElementById('box').closest('.m'))
  assert.equal(d.querySelector('div::before'), null, 'an unsupported selector matches nothing, without throwing')
  assert.equal(d.querySelector('#box input'), d.querySelector('#box input'), 'a cached parse gives the same answer')
})
test('pointer lock: requestPointerLock resolves, sets pointerLockElement, fires pointerlockchange, asks native; exitPointerLock releases; query results are NodeLists', async () => {
  const calls = []; const g = sandbox({ input: { pointerLock: (on) => { calls.push(on); return true } } }); const d = g.document
  const el = d.createElement('div'); d.body.appendChild(el); let changes = 0; d.addEventListener('pointerlockchange', () => changes++)
  await el.requestPointerLock(); assert.equal(d.pointerLockElement, el); await el.requestPointerLock()
  d.exitPointerLock(); assert.equal(d.pointerLockElement, null); d.exitPointerLock()
  assert.deepEqual(calls, [true, false]); assert.equal(changes, 2)
  const all = d.querySelectorAll('div'); assert.ok(all instanceof g.NodeList && Array.isArray(all) && all.item(0) === el)
})
