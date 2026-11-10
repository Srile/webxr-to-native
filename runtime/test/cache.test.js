// The Cache API (WP-26, runtime/src/storage/cache.js) against the in-memory fake of __native.storage: CacheStorage,
// put / match / matchAll / keys / delete with ignoreSearch, ignoreMethod, ignoreVary and Vary, the put and addAll
// refusals, add / addAll through the runtime's fetch (same-origin assets), and the entries surviving a restart.
import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { fakeStorage, fakeLoop } from './storage-fake.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installStorage } from '../src/storage/index.js'

const ASSETS = { 'a.txt': 'alpha', 'b.json': '{"b":1}', 'img/p.bin': '\u0001\u0002' }
function sandbox(files = new Map(), opts = {}) {
  const S = fakeStorage({ files, indexedDB: false, ...opts })
  const enc = new TextEncoder()
  const assets = { read: (p) => p in ASSETS ? enc.encode(ASSETS[p]).buffer : null, readText: (p) => ASSETS[p] ?? null, exists: (p) => p in ASSETS, mime: (p) => p.endsWith('.json') ? 'application/json' : 'text/plain' }
  const g = Object.create(null)
  g.__native = fakeNative({ storage: S, loop: fakeLoop(S), assets }); g.Promise = Promise
  installCore(g); installFetch(g); installStorage(g)
  return { g, S, files }
}

test('CacheStorage: open, has, keys in creation order, delete; indexedDB stays off when only storage.cache is on', async () => {
  const { g } = sandbox()
  assert.equal(g.indexedDB, undefined)
  const a = await g.caches.open('v2'); await g.caches.open('v1'); await g.caches.open('v2')
  assert.ok(a instanceof g.Cache)
  assert.deepEqual(await g.caches.keys(), ['v2', 'v1'])
  assert.equal(await g.caches.has('v1'), true); assert.equal(await g.caches.has('nope'), false)
  assert.equal(await g.caches.delete('v1'), true); assert.equal(await g.caches.delete('v1'), false)
  assert.deepEqual(await g.caches.keys(), ['v2'])
})

test('put / match / matchAll / keys / delete, with the query options and Vary', async () => {
  const { g } = sandbox()
  const c = await g.caches.open('c')
  await c.put('https://app.local/x?v=1', new g.Response('one', { headers: { 'content-type': 'text/plain', 'x-a': '1' }, statusText: 'OK' }))
  await c.put(new g.Request('https://app.local/x?v=2'), new g.Response('two'))
  await c.put('/rel#frag', new g.Response(new Uint8Array([1, 2, 3])))
  const r = await c.match('https://app.local/x?v=1')
  assert.equal(await r.text(), 'one'); assert.equal(r.status, 200); assert.equal(r.statusText, 'OK'); assert.equal(r.headers.get('x-a'), '1')
  assert.equal(await c.match('https://app.local/x'), undefined)
  assert.deepEqual(await Promise.all((await c.matchAll('https://app.local/x', { ignoreSearch: true })).map(x => x.text())), ['one', 'two'])
  assert.deepEqual([...new Uint8Array(await (await c.match('https://app.local/rel')).arrayBuffer())], [1, 2, 3])  // the fragment is not part of the key
  assert.equal(await c.match(new g.Request('https://app.local/x?v=1', { method: 'POST' })), undefined)
  assert.ok(await c.match(new g.Request('https://app.local/x?v=1', { method: 'POST' }), { ignoreMethod: true }))
  assert.deepEqual((await c.keys()).map(q => q.url), ['https://app.local/x?v=1', 'https://app.local/x?v=2', 'https://app.local/rel'])
  // a second put of the same request replaces the first, at the end of the order
  await c.put('https://app.local/x?v=1', new g.Response('uno'))
  assert.equal(await (await c.match('https://app.local/x?v=1')).text(), 'uno')
  assert.deepEqual((await c.keys()).map(q => q.url).at(-1), 'https://app.local/x?v=1')
  assert.equal(await c.delete('https://app.local/x', { ignoreSearch: true }), true)
  assert.deepEqual((await c.keys()).map(q => q.url), ['https://app.local/rel'])
  // Vary: the cached request's header must match unless ignoreVary
  await c.put(new g.Request('https://app.local/v', { headers: { 'accept-language': 'de' } }), new g.Response('de', { headers: { vary: 'Accept-Language' } }))
  assert.equal(await c.match(new g.Request('https://app.local/v', { headers: { 'accept-language': 'en' } })), undefined)
  assert.equal(await (await c.match(new g.Request('https://app.local/v', { headers: { 'accept-language': 'de' } }))).text(), 'de')
  assert.ok(await c.match('https://app.local/v', { ignoreVary: true }))
  // caches.match: every cache in creation order, or the one named
  const d = await g.caches.open('d'); await d.put('https://app.local/rel', new g.Response('from d'))
  assert.deepEqual(await (await g.caches.match('https://app.local/rel')).arrayBuffer().then(b => [...new Uint8Array(b)]), [1, 2, 3])
  assert.equal(await (await g.caches.match('https://app.local/rel', { cacheName: 'd' })).text(), 'from d')
  assert.equal(await g.caches.match('https://app.local/rel', { cacheName: 'missing' }), undefined)
})

test('put refuses what the spec refuses: non-GET, 206, Vary *, a used body, non-http URLs', async () => {
  const { g } = sandbox()
  const c = await g.caches.open('c')
  await assert.rejects(c.put(new g.Request('https://app.local/p', { method: 'POST', body: 'x' }), new g.Response('')), TypeError)
  await assert.rejects(c.put('https://app.local/p', new g.Response('', { status: 206 })), TypeError)
  await assert.rejects(c.put('https://app.local/p', new g.Response('', { headers: { vary: '*' } })), TypeError)
  const used = new g.Response('x'); await used.text()
  await assert.rejects(c.put('https://app.local/p', used), TypeError)
  await assert.rejects(c.put('data:text/plain,x', new g.Response('x')), TypeError)
  assert.deepEqual(await c.keys(), [])
})

test('add / addAll fetch through the runtime (same-origin assets), store the responses, refuse a failed one atomically', async () => {
  const { g, files } = sandbox()
  const c = await g.caches.open('assets')
  await c.addAll(['/a.txt', '/b.json'])
  await c.add('/img/p.bin')
  assert.equal(await (await c.match('/a.txt')).text(), 'alpha')
  assert.equal((await c.match('/b.json')).headers.get('content-type'), 'application/json')
  await assert.rejects(c.addAll(['/a.txt', '/missing.txt']), TypeError)
  await assert.rejects(c.addAll(['/a.txt', '/a.txt']), (e) => e.name === 'InvalidStateError')
  assert.equal((await c.keys()).length, 3)
  // the app again
  const { g: g2 } = sandbox(files)
  const c2 = await g2.caches.open('assets')
  assert.deepEqual((await c2.keys()).map(q => q.url), ['https://app.local/a.txt', 'https://app.local/b.json', 'https://app.local/img/p.bin'])
  assert.equal(await (await g2.caches.match('/b.json')).text(), '{"b":1}')
})

test('quota: a body past storage.quotaMB rejects with QuotaExceededError and stores nothing', async () => {
  const { g } = sandbox(new Map(), { quota: 32 * 1024 })
  const c = await g.caches.open('q')
  await assert.rejects(c.put('/big', new g.Response(new Uint8Array(64 * 1024))), (e) => e.name === 'QuotaExceededError')
  assert.deepEqual(await c.keys(), [])
})
