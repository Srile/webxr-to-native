// WP-27: service workers against fakes. The page side (serviceworker/index.js) runs on a sandbox global as the page
// prelude does; each spawned version runs scope.js on a sandbox of its own with a user script, and messages cross
// with structuredClone and a setImmediate hop, as through host/js/worker.cpp's queues.
import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installWorkers } from '../src/workers/index.js'
import { install as installServiceWorker } from '../src/serviceworker/index.js'
import { installScope } from '../src/serviceworker/scope.js'
import * as ev from '../src/dom-lite/events.js'
import { DOMException, installAbort } from '../src/dom-lite/globals.js'

const O = 'https://app.local'
const SW_HOOK = Symbol.for('webxr-host.serviceworker')
const enc = (s) => new TextEncoder().encode(s).buffer
const mime = (p) => p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : p.endsWith('.png') ? 'image/png' : 'text/plain'
const until = async (f, what = 'condition') => { for (let i = 0; i < 400; i++) { if (f()) return; await new Promise((r) => setImmediate(r)) } throw new Error(`timed out waiting for ${what}`) }
const once = (t, type) => new Promise((r) => t.addEventListener(type, r, { once: true }))

// The service worker every test registers: counts what it sees, answers /synthetic/*, passes /pass.json to its own
// fetch, rejects /reject, leaves everything else (no respondWith), claims on activate, echoes messages.
const SW = `
const seen = []
self.addEventListener('install', (e) => { e.waitUntil(new Promise((r) => setTimeout(r, 1))) })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url); seen.push((e.request.destination || 'fetch') + ' ' + u.pathname + ' ' + e.request.method + ' ' + e.request.mode)
  if (u.pathname.startsWith('/synthetic/')) e.respondWith(new self.Response('sw:' + u.pathname, { headers: { 'x-sw': '1' } }))
  else if (u.pathname === '/pass.json') e.respondWith(self.fetch(e.request))
  else if (u.pathname === '/echo') e.respondWith(e.request.text().then((t) => new self.Response('got ' + t)))
  else if (u.pathname === '/reject') e.respondWith(Promise.reject(new Error('nope')))
  else if (u.pathname === '/moved') e.respondWith(self.Response.redirect('/synthetic/target', 302))
})
self.addEventListener('message', async (e) => {
  const d = e.data
  if (d === 'seen') e.source.postMessage({ seen })
  else if (d === 'clients') { const all = await self.clients.matchAll(); const one = await self.clients.get(e.source.id); let open = ''; try { await self.clients.openWindow('/x') } catch (x) { open = x.name } let focus = ''; try { await all[0].focus() } catch (x) { focus = x.name }
    e.source.postMessage({ n: all.length, type: all[0]?.type, frame: all[0]?.frameType, url: all[0]?.url, same: one?.id === e.source.id, open, focus, isClient: e.source instanceof self.WindowClient }) }
  else if (d === 'port') e.ports[0].postMessage('pong')
  else if (d === 'state') e.source.postMessage({ state: self.serviceWorker.state, active: self.registration.active?.state, scope: self.registration.scope, scope2: self instanceof self.ServiceWorkerGlobalScope, post: typeof self.postMessage })
  else e.source.postMessage({ echo: d, origin: e.origin })
})
`

// One "launch": a page sandbox with its __native, sharing `disk` (the registry file) and `assets` across launches.
function launch({ disk = { text: null }, assets = {}, on = true } = {}) {
  const threads = new Map(); let nextId = 1, hostCb = null, errCb = null; const stats = { spawned: 0, toSW: [] }
  const read = (p) => assets[p] == null ? null : enc(assets[p])
  const assetNative = { read, readText: (p) => assets[p] ?? null, exists: (p) => assets[p] != null, mime }
  const hop = (f) => setImmediate(f)
  const startThread = (id, src, url, opts) => {
    if (!opts?.init) return { w: null, deliver() {} }  // a plain Worker
    const w = Object.create(null); w.Promise = Promise
    w.__native = fakeNative({ assets: assetNative, config: { web: { origin: O } } })
    Object.assign(w, ev); w.DOMException = DOMException; installAbort(w); installFetch(w)
    w.setTimeout = (f, ms) => setTimeout(f, ms); w.queueMicrotask = queueMicrotask
    const target = new ev.EventTarget()
    w.addEventListener = (...a) => target.addEventListener(...a); w.removeEventListener = (...a) => target.removeEventListener(...a); w.dispatchEvent = (e) => target.dispatchEvent(e)
    w.MessagePort = class MessagePort {}; w.postMessage = () => {}; w.close = () => {}; w.onmessage = null
    let handler = null
    const raw = { init: structuredClone(opts.init), postMessage: (m, bufs) => { const c = structuredClone(m, { transfer: bufs }); hop(() => hostCb(id, c)) }, onMessage: (f) => { handler = f } }
    const portsFor = (ids) => ids.map((pid) => ({ postMessage: (d) => raw.postMessage({ __port: pid, data: d, ports: [] }) }))
    installScope(w, { native: raw, target, hostMessage: () => {}, portsFor })
    try { new Function('self', src)(w) } catch (e) { hop(() => errCb(id, String(e))) }
    return { w, deliver: (m) => handler(m) }
  }
  const native = fakeNative({
    config: { web: { origin: O, entry: 'assets/index.js', ...(on ? { serviceWorker: true } : {}) } },
    assets: assetNative,
    worker: {
      spawn: (src, url, isModule, opts) => { const id = nextId++; stats.spawned++; threads.set(id, startThread(id, src, url, opts)); return id },
      post: (id, m, bufs) => { const t = threads.get(id); if (!t) return; stats.toSW.push(m.__sw); const c = structuredClone(m, { transfer: bufs }); hop(() => threads.get(id) && t.deliver(c)) },
      terminate: (id) => { threads.delete(id) }, onMessage: (f) => { hostCb = f }, onError: (f) => { errCb = f },
      ...(on ? { registry: { load: () => disk.text, save: (t) => { disk.text = t; return true } } } : {}),
    },
  })
  const g = Object.create(null); g.__native = native; g.Promise = Promise
  installCore(g); installFetch(g); const workers = installWorkers(g)
  const baseFetch = g.fetch
  const start = on ? installServiceWorker(g, { workers }) : undefined
  return { g, disk, assets, threads, stats, baseFetch, start }
}
const ASSETS = () => ({ 'sw.js': SW, 'pass.json': '{"real":true}', 'plain.txt': 'plain', 'sub/other.js': SW })
const reply = (g, data) => { const got = new Promise((r) => g.navigator.serviceWorker.addEventListener('message', (e) => r(e), { once: true })); g.navigator.serviceWorker.controller.postMessage(data); return got }
async function firstRun(opts) {
  const L = launch({ assets: ASSETS(), ...opts }); const sw = L.g.navigator.serviceWorker; sw.startMessages()
  const changed = once(sw, 'controllerchange')
  const reg = await sw.register('/sw.js')
  await changed; await until(() => reg.active?.state === 'activated', 'activated')
  return { ...L, sw, reg }
}

test('off: no navigator.serviceWorker, no ServiceWorker globals, fetch untouched', () => {
  const { g, baseFetch } = launch({ on: false, assets: ASSETS() })
  assert.equal(typeof g.navigator.serviceWorker, 'undefined'); assert.equal('serviceWorker' in g.navigator, false)
  for (const k of ['ServiceWorker', 'ServiceWorkerRegistration', 'ServiceWorkerContainer', 'NavigationPreloadManager']) assert.equal(k in g, false, k)
  assert.equal(g.fetch, baseFetch); assert.equal(g[SW_HOOK], undefined)
})

test('register: install, activate, clients.claim makes it the controller; ready; scope; the same object on re-register', async () => {
  const L = launch({ assets: ASSETS() }); const sw = L.g.navigator.serviceWorker
  assert.equal(sw.controller, null)
  const states = []; let found = 0
  const changed = once(sw, 'controllerchange')
  const reg = await sw.register('/sw.js')
  assert.equal(reg.scope, O + '/'); assert.equal(reg.updateViaCache, 'imports'); assert.ok(reg instanceof L.g.ServiceWorkerRegistration)
  assert.equal(reg.installing.state, 'installing'); assert.equal(reg.installing.scriptURL, O + '/sw.js')
  reg.addEventListener('updatefound', () => found++); reg.installing.addEventListener('statechange', (e) => states.push(e.target.state))
  assert.equal(await sw.ready, reg)
  await changed; assert.equal(sw.controller, reg.active)
  await until(() => reg.active.state === 'activated', 'activated')
  assert.deepEqual(states, ['installed', 'activating', 'activated']); assert.equal(found, 1)
  assert.equal(await sw.register('./sw.js'), reg); assert.equal(await sw.getRegistration(), reg); assert.deepEqual(await sw.getRegistrations(), [reg])
  assert.throws(() => new L.g.ServiceWorker(), TypeError)
  const saved = JSON.parse(L.disk.text); assert.equal(saved.registrations[0].scope, O + '/'); assert.equal(saved.registrations[0].active.scriptURL, O + '/sw.js'); assert.equal(saved.registrations[0].active.source, SW)
})

test('fetch events: synthetic, passthrough, fallback, request body, rejected respondWith, redirect, XHR, image and script destinations, blob: not intercepted', async () => {
  const { g, sw } = await firstRun()
  const a = await g.fetch('/synthetic/hello'); assert.equal(await a.text(), 'sw:/synthetic/hello'); assert.equal(a.headers.get('x-sw'), '1'); assert.equal(a.url, O + '/synthetic/hello'); assert.equal(a.status, 200)
  assert.deepEqual(await (await g.fetch('/pass.json')).json(), { real: true })
  assert.equal(await (await g.fetch('/plain.txt')).text(), 'plain')
  assert.equal(await (await g.fetch('/echo', { method: 'POST', body: 'payload' })).text(), 'got payload')
  await assert.rejects(g.fetch('/reject'), TypeError)
  const moved = await g.fetch('/moved'); assert.equal(await moved.text(), 'sw:/synthetic/target'); assert.equal(moved.redirected, true)
  const x = new g.XMLHttpRequest(); x.open('GET', '/synthetic/xhr'); const loaded = once(x, 'load'); x.send(); await loaded; assert.equal(x.responseText, 'sw:/synthetic/xhr')
  assert.equal(g[SW_HOOK].controlled(O + '/a.png'), true); assert.equal(g[SW_HOOK].controlled('blob:' + O + '/x'), false)
  assert.equal(await (await g[SW_HOOK].load(O + '/synthetic/img.png', 'image')).text(), 'sw:/synthetic/img.png')
  await g[SW_HOOK].load('/synthetic/s.js', 'script')  // relative: resolved against the page
  const b = g.URL.createObjectURL(new g.Blob(['blob!'])); assert.equal(await (await g.fetch(b)).text(), 'blob!')
  const { data } = await reply(g, 'seen')
  assert.deepEqual(data.seen, ['fetch /synthetic/hello GET cors', 'fetch /pass.json GET cors', 'fetch /plain.txt GET cors', 'fetch /echo POST cors', 'fetch /reject GET cors', 'fetch /moved GET cors', 'fetch /synthetic/target GET cors', 'fetch /synthetic/xhr GET cors', 'image /synthetic/img.png GET no-cors', 'script /synthetic/s.js GET no-cors'])
})

test('messages both ways: the SW sees the page as its WindowClient; clients.matchAll/get; openWindow and focus reject', async () => {
  const { g } = await firstRun()
  const e = await reply(g, { hi: 1 }); assert.deepEqual(e.data, { echo: { hi: 1 }, origin: O }); assert.equal(e.source, g.navigator.serviceWorker.controller); assert.equal(e.origin, O)
  const c = (await reply(g, 'clients')).data
  assert.deepEqual(c, { n: 1, type: 'window', frame: 'top-level', url: O + '/', same: true, open: 'NotSupportedError', focus: 'InvalidAccessError', isClient: true })
  const s = (await reply(g, 'state')).data
  const ch = new g.MessageChannel(); const pong = new Promise((r) => { ch.port1.onmessage = (e) => r(e.data) })
  g.navigator.serviceWorker.controller.postMessage('port', [ch.port2]); assert.equal(await pong, 'pong', 'a MessageChannel reply reaches the port the page kept')
  assert.deepEqual(s, { state: 'activated', active: 'activated', scope: O + '/', scope2: true, post: 'undefined' })
})

test('a client message waits until the queue is enabled (startMessages or onmessage)', async () => {
  const L = launch({ assets: ASSETS() }); const sw = L.g.navigator.serviceWorker
  const changed = once(sw, 'controllerchange'); await sw.register('/sw.js'); await changed
  let got = null; sw.addEventListener('message', (e) => { got = e.data })
  sw.controller.postMessage('x'); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  assert.equal(got, null); sw.onmessage = () => {}; await until(() => got !== null, 'queued message'); assert.deepEqual(got, { echo: 'x', origin: O })
})

test('persisted: the next launch is controlled from the start, before any register(); register() returns that registration', async () => {
  const first = await firstRun()
  const L = launch({ disk: first.disk, assets: first.assets }); const sw = L.g.navigator.serviceWorker; assert.equal(L.start, undefined)
  assert.ok(sw.controller, 'controller at start'); assert.equal(sw.controller.state, 'activated'); assert.equal(sw.controller.scriptURL, O + '/sw.js')
  assert.equal(await (await L.g.fetch('/synthetic/again')).text(), 'sw:/synthetic/again')
  const reg = await sw.register('/sw.js'); assert.equal(await sw.ready, reg); assert.equal(reg.active, sw.controller); assert.equal(reg.installing, null)
  await reg.update(); assert.equal(reg.installing, null)
  assert.equal(L.stats.spawned, 1)
})

test('update: changed bytes install a version that waits while the page is controlled, and takes over at the next launch', async () => {
  const first = await firstRun()
  first.assets['sw.js'] = SW + '\n// v2'
  const reg = await first.reg.update(); assert.equal(reg, first.reg)
  await until(() => reg.waiting?.state === 'installed', 'waiting'); assert.equal(first.sw.controller, reg.active); assert.notEqual(reg.waiting, reg.active)
  assert.ok(JSON.parse(first.disk.text).registrations[0].waiting)
  const L = launch({ disk: first.disk, assets: first.assets }); const sw = L.g.navigator.serviceWorker
  assert.ok(sw.controller); const r2 = await sw.ready; assert.equal(r2.waiting, null); assert.match(r2.active.scriptURL, /sw\.js$/)
  assert.ok(L.start instanceof Promise, 'the entry waits for the activation'); await L.start
  await until(() => sw.controller.state === 'activated', 'promoted version activated')
  const saved = JSON.parse(L.disk.text).registrations[0]; assert.equal(saved.waiting, null); assert.match(saved.active.source, /\/\/ v2$/)
})

test('skipWaiting: a new version activates at once and the page changes controller', async () => {
  const first = await firstRun()
  first.assets['sw.js'] = SW + "\nself.addEventListener('install', () => self.skipWaiting())"
  const old = first.sw.controller; const changed = once(first.sw, 'controllerchange')
  await first.reg.update(); await changed
  assert.notEqual(first.sw.controller, old); assert.equal(old.state, 'redundant')
  await until(() => first.sw.controller.state === 'activated', 'activated'); assert.equal(first.reg.waiting, null)
})

test('a rejected install or a throwing script makes the version redundant and the empty registration goes', async () => {
  const L = launch({ assets: { ...ASSETS(), 'bad.js': "self.addEventListener('install', (e) => e.waitUntil(Promise.reject(new Error('no'))))", 'throws.js': 'throw new Error("boom")' } })
  const sw = L.g.navigator.serviceWorker
  const reg = await sw.register('/bad.js'); const w = reg.installing
  await until(() => w.state === 'redundant', 'redundant'); assert.equal(reg.installing, null); assert.equal(await sw.getRegistration(), undefined)
  const reg2 = await sw.register('/throws.js'); const w2 = reg2.installing
  await until(() => w2.state === 'redundant', 'redundant after a throw'); assert.equal(L.disk.text, null)
})

test('register: default scope is the script directory, max scope, origins, types', async () => {
  const L = launch({ assets: ASSETS() }); const sw = L.g.navigator.serviceWorker
  await assert.rejects(sw.register('/sub/other.js', { scope: '/' }), (e) => e.name === 'SecurityError' && /max scope/.test(e.message))
  await assert.rejects(sw.register('https://evil.example/sw.js'), (e) => e.name === 'SecurityError')
  await assert.rejects(sw.register('/sw.js', { type: 'wasm' }), TypeError)
  await assert.rejects(sw.register('/missing.js'), TypeError)
  await assert.rejects(sw.register('/plain.txt'), (e) => e.name === 'SecurityError' && /MIME/.test(e.message))
  const sub = await sw.register('/sub/other.js'); assert.equal(sub.scope, O + '/sub/')
  assert.equal(await sw.getRegistration('/sub/page'), sub); assert.equal(await sw.getRegistration('/'), undefined)
})

test('unregister: true then false; the controller stays for this launch; the next launch is uncontrolled; re-register works', async () => {
  const first = await firstRun()
  const sub = await first.sw.register('/sub/other.js'); await until(() => sub.active?.state === 'activated', 'sub active')
  assert.equal((await first.sw.getRegistrations()).length, 2)
  assert.equal(await sub.unregister(), true); assert.equal(await sub.unregister(), false); assert.equal(sub.active, null, 'an unused registration is cleared')
  assert.equal(await first.reg.unregister(), true); assert.ok(first.sw.controller, 'still controlled'); assert.equal(await first.sw.getRegistration(), undefined)
  const again = await first.sw.register('/sw.js'); assert.notEqual(again, first.reg)
  await until(() => again.active?.state === 'activated', 'again active'); assert.equal(first.sw.controller, again.active, 'its activate claimed the page')
  await again.unregister()
  const L = launch({ disk: first.disk, assets: first.assets }); assert.equal(L.g.navigator.serviceWorker.controller, null)
  assert.equal(L.stats.spawned, 0)
})

test('a service worker without a fetch listener is never asked; a Worker script loads through one that has', async () => {
  const L = launch({ assets: { 'quiet.js': "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))", 'w.js': 'postMessage(1)', 'sw.js': SW } })
  const sw = L.g.navigator.serviceWorker; const changed = once(sw, 'controllerchange')
  const reg = await sw.register('/quiet.js'); await changed; await until(() => reg.active.state === 'activated', 'activated')
  const before = L.stats.toSW.length; assert.equal(await (await L.g.fetch('/w.js')).text(), 'postMessage(1)'); assert.equal(L.g[SW_HOOK].controlled(O + '/w.js'), false)
  assert.equal(L.stats.toSW.slice(before).includes('fetch'), false)
  assert.equal(JSON.parse(L.disk.text).registrations[0].active.handlesFetch, false)

  const M = await firstRun(); const spawned = []; const W = M.g.__native.worker, spawn = W.spawn; W.spawn = (src, url, mod, opts) => { spawned.push({ src, url }); return spawn(src, url, mod, opts) }
  M.assets['synthetic/worker.js'] = 'never read'
  const wk = new M.g.Worker('/synthetic/worker.js'); wk.postMessage('early')
  await until(() => spawned.length === 1, 'worker spawned'); assert.equal(spawned[0].src, 'sw:/synthetic/worker.js'); assert.equal(spawned[0].url, O + '/synthetic/worker.js')
  const { data } = await reply(M.g, 'seen'); assert.ok(data.seen.includes('worker /synthetic/worker.js GET same-origin'))
})

test('ExtendableEvent: waitUntil outside dispatch throws InvalidStateError; respondWith only during dispatch, once', async () => {
  const L = launch({ assets: ASSETS() }); await L.g.navigator.serviceWorker.register('/sw.js'); await until(() => L.threads.size === 1, 'thread')
  const w = [...L.threads.values()][0].w
  const e = new w.ExtendableEvent('x'); assert.throws(() => e.waitUntil(Promise.resolve()), (x) => x.name === 'InvalidStateError')
  const f = new w.FetchEvent('fetch', { request: new w.Request(O + '/a') }); assert.throws(() => f.respondWith(new w.Response('')), (x) => x.name === 'InvalidStateError')
  assert.equal(await f.preloadResponse, undefined); assert.throws(() => new w.FetchEvent('fetch', {}), TypeError)
  assert.ok(w instanceof w.ServiceWorkerGlobalScope); assert.equal('DedicatedWorkerGlobalScope' in w, false)
})

test('an activate handler that unregisters (a kill-switch worker) does not wait behind its own job', async () => {
  const L = launch({ assets: { 'kill.js': "self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister().then((ok) => { self.result = ok })))" } })
  const sw = L.g.navigator.serviceWorker; const reg = await sw.register('/kill.js'); const w = reg.installing
  await until(() => [...L.threads.values()][0]?.w.result === true, 'unregister from activate')
  assert.equal(await sw.getRegistration(), undefined); await until(() => w.state === 'redundant', 'cleared'); assert.equal(JSON.parse(L.disk.text).registrations.length, 0)
})
