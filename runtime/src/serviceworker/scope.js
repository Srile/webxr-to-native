// The ServiceWorkerGlobalScope (WP-27) over the worker prelude: what a service worker's script sees as `self`.
// The page runs the registry (serviceworker/index.js has the message protocol); this side dispatches the events
// (install, activate with waitUntil; fetch with respondWith; message) and turns the page's answers into
// self.registration, self.serviceWorker, self.clients and skipWaiting. io: the worker prelude's internals
// (workers/worker-global.js): native (its __native, with init.serviceWorker from the spawn), target, hostMessage,
// portsFor. Requests the service worker makes itself go to the assets or the network, never back to it.
export function installScope(g, io) {
  const n = io.native, init = n.init?.serviceWorker
  if (!init) return
  const { Event, EventTarget, DOMException } = g
  const target = io.target
  target._window = g  // dom-lite's dispatch: listeners run with this = self, and self.on<type> handlers are called
  const post = (msg, buffers) => n.postMessage(msg, buffers ?? [])
  // A transferred port of a channel made here: its peer, which stays, is what the page's port talks to from now on.
  const portId = (p) => { const peer = p._peer; if (!peer) return p._id; p._peer = null; peer._peer = null; return peer._id }
  const transferOf = (opts) => { const list = Array.isArray(opts) ? opts : opts?.transfer ?? []; return { buffers: list.filter((t) => t instanceof ArrayBuffer), ports: list.filter((t) => t instanceof g.MessagePort).map(portId) } }
  const illegal = (t) => { if (t !== INTERNAL) throw new TypeError('Illegal constructor') }

  // ---------------------------------------------------------------------------------------------- events
  class ExtendableEvent extends Event {
    constructor(type, init = {}) { super(type, init); this[EXT] = { dispatching: false, pending: 0, promises: [] } }
    waitUntil(p) {
      const s = this[EXT]
      if (!this.isTrusted) throw new DOMException('Failed to execute \'waitUntil\' on \'ExtendableEvent\': The event is not trusted.', 'InvalidStateError')
      if (!s.dispatching && s.pending === 0) throw new DOMException('Failed to execute \'waitUntil\' on \'ExtendableEvent\': The event handler is already finished.', 'InvalidStateError')
      const q = Promise.resolve(p); s.pending++; s.promises.push(q)
      const done = () => { queueMicrotask(() => { s.pending-- }) }; q.then(done, done)
    }
  }
  class InstallEvent extends ExtendableEvent {}
  class ExtendableMessageEvent extends ExtendableEvent {
    constructor(type, init = {}) { super(type, init); this.data = init.data ?? null; this.origin = init.origin ?? ''; this.lastEventId = init.lastEventId ?? ''; this.source = init.source ?? null; this.ports = init.ports ?? [] }
  }
  class FetchEvent extends ExtendableEvent {
    constructor(type, init = {}) {
      super(type, init); if (!(init.request instanceof g.Request)) throw new TypeError('Failed to construct \'FetchEvent\': required member request is undefined.')
      this.request = init.request; this.clientId = init.clientId ?? ''; this.resultingClientId = init.resultingClientId ?? ''; this.replacesClientId = init.replacesClientId ?? ''
      this.preloadResponse = init.preloadResponse ?? Promise.resolve(undefined); this.handled = init.handled ?? Promise.resolve(undefined); this[RESPOND] = null
    }
    respondWith(r) {
      const s = this[EXT]
      if (!this.isTrusted || !s.dispatching) throw new DOMException('Failed to execute \'respondWith\' on \'FetchEvent\': The event handler is already finished.', 'InvalidStateError')
      if (this[RESPOND]) throw new DOMException('Failed to execute \'respondWith\' on \'FetchEvent\': The event has already been responded to.', 'InvalidStateError')
      const p = Promise.resolve(r); this[RESPOND] = p; this.waitUntil(p); this.stopImmediatePropagation()
    }
  }
  function fire(ev) {
    ev.isTrusted = true; ev.target = g; const s = ev[EXT]; if (s) s.dispatching = true
    try { target.dispatchEvent(ev) } finally { if (s) s.dispatching = false }
    return ev
  }
  // After dispatch: every lifetime promise, including ones added while others were pending.
  async function settle(ev) {
    const s = ev[EXT]; let failed = false, error
    for (let i = 0; i < s.promises.length; i++) { try { await s.promises[i] } catch (e) { if (!failed) { failed = true; error = e } } }
    return { ok: !failed, error: failed ? String(error?.message ?? error) : null }
  }

  // ---------------------------------------------------------------------------------------------- calls to the page
  let callSeq = 0; const calls = new Map()
  const call = (op, args) => new Promise((resolve, reject) => { const id = ++callSeq; calls.set(id, { resolve, reject }); post({ __sw: 'call', id, op, args }) })

  // ---------------------------------------------------------------------------------------------- objects
  const workers = new Map()  // version id -> ServiceWorker
  class ServiceWorker extends EventTarget {
    constructor(t, s) { illegal(t); super(); this._id = s.id; this._state = s.state; this.scriptURL = s.scriptURL; this.onstatechange = null; this.onerror = null }
    get state() { return this._state }
    postMessage(data) { call('relay', { to: this._id, data }) }
  }
  const workerObj = (s) => { if (!s) return null; let w = workers.get(s.id); if (!w) workers.set(s.id, w = new ServiceWorker(INTERNAL, s)); else if (w._state !== s.state) { w._state = s.state; w.dispatchEvent(new Event('statechange')) } return w }
  class NavigationPreloadManager {
    enable() { return Promise.resolve() } disable() { return Promise.resolve() } setHeaderValue() { return Promise.resolve() }
    getState() { return Promise.resolve({ enabled: false, headerValue: 'true' }) }
  }
  class ServiceWorkerRegistration extends EventTarget {
    constructor(t) { illegal(t); super(); this.scope = init.scope; this.updateViaCache = 'imports'; this.installing = null; this.waiting = null; this.active = null; this.navigationPreload = new NavigationPreloadManager(); this.onupdatefound = null }
    update() { return call('update').then(() => this) }
    unregister() { return call('unregister') }
    showNotification() { return Promise.reject(new TypeError('No notification permission has been granted for this origin.')) }
    getNotifications() { return Promise.resolve([]) }
  }
  const registration = new ServiceWorkerRegistration(INTERNAL)
  function applyState(s) {
    const was = registration.installing
    registration.updateViaCache = s.updateViaCache
    registration.installing = workerObj(s.installing); registration.waiting = workerObj(s.waiting); registration.active = workerObj(s.active)
    if (registration.installing && registration.installing !== was && started) registration.dispatchEvent(new Event('updatefound'))
  }
  class Client {
    constructor(t, s) { illegal(t); this.id = s.id; this.url = s.url; this.type = s.type; this.frameType = s.frameType; this.lifecycleState = 'active' }
    postMessage(data, opts) { const t = transferOf(opts); post({ __sw: 'post', client: this.id, data, ports: t.ports }, t.buffers) }
  }
  class WindowClient extends Client {
    constructor(t, s) { super(t, s); this.visibilityState = s.visibilityState; this.focused = s.focused; this.ancestorOrigins = [] }
    focus() { return Promise.reject(new DOMException('Failed to execute \'focus\' on \'WindowClient\': Not allowed to focus a window.', 'InvalidAccessError')) }
    navigate() { return Promise.reject(new DOMException('Failed to execute \'navigate\' on \'WindowClient\': webxr-host has one page and does not navigate it.', 'NotSupportedError')) }
  }
  const clientObj = (s) => s ? (s.type === 'window' ? new WindowClient(INTERNAL, s) : new Client(INTERNAL, s)) : undefined
  class Clients {
    constructor(t) { illegal(t) }
    get(id) { return call('client', { id: String(id) }).then(clientObj) }
    matchAll(opts = {}) { return call('clients', { type: opts.type ?? 'window', includeUncontrolled: !!opts.includeUncontrolled }).then((l) => l.map(clientObj)) }
    openWindow() { return Promise.reject(new DOMException('Failed to execute \'openWindow\' on \'Clients\': webxr-host has one page and opens no other.', 'NotSupportedError')) }
    claim() { return call('claim').then(() => undefined) }
  }

  // ---------------------------------------------------------------------------------------------- the page's messages
  let started = false
  const handles = () => ['install', 'activate', 'fetch', 'message', 'messageerror'].filter((t) => (target._listeners?.get(t)?.length ?? 0) > 0 || typeof g['on' + t] === 'function')
  n.onMessage((m) => {
    if (!m || m.__sw === undefined) return io.hostMessage(m)  // MessagePort traffic (ports handed over in messages)
    switch (m.__sw) {
      case 'hello': started = true; post({ __sw: 'evaluated', handles: handles() }); break
      case 'state': applyState(m.registration); break
      case 'reply': { const c = calls.get(m.id); if (!c) break; calls.delete(m.id); if (m.ok) c.resolve(m.value); else c.reject(m.error.name === 'TypeError' ? new TypeError(m.error.message) : new DOMException(m.error.message, m.error.name)); break }
      case 'event': lifecycle(m); break
      case 'fetch': onFetch(m); break
      case 'message': fire(new ExtendableMessageEvent('message', { data: m.data, origin: init.origin, source: m.source ? workerObj(m.source) : clientObj(m.client), ports: io.portsFor(m.ports) })); break
    }
  })
  async function lifecycle(m) {
    const ev = fire(m.type === 'install' ? new InstallEvent('install') : new ExtendableEvent(m.type))
    const r = await settle(ev)
    post({ __sw: 'event-done', id: m.id, ok: r.ok, error: r.error })
  }
  function onFetch(m) {
    const q = m.request; let request
    try {
      request = new g.Request(q.url, { method: q.method, headers: q.headers, body: q.body, mode: q.mode, credentials: q.credentials, cache: q.cache, redirect: q.redirect, integrity: q.integrity, keepalive: q.keepalive })
      request.destination = q.destination; request.referrer = q.referrer
    } catch (e) { post({ __sw: 'fetch-done', id: m.id, kind: 'error', error: String(e?.message ?? e) }); return }
    let handledOk, handledFail; const handled = new Promise((a, b) => { handledOk = a; handledFail = b }); handled.catch(() => {})
    const ev = fire(new FetchEvent('fetch', { request, clientId: m.client, handled }))
    const p = ev[RESPOND]
    if (!p) { post({ __sw: 'fetch-done', id: m.id, kind: 'fallback' }); handledFail(new DOMException('The fetch was not handled.', 'NetworkError')); return }
    p.then(async (res) => {
      if (!(res instanceof g.Response)) throw new TypeError('an object that was not a Response was passed to respondWith()')
      if (res.type === 'error') throw new TypeError('a network error response (Response.error()) was passed to respondWith()')
      if (res.bodyUsed) throw new TypeError('a Response whose body was already used was passed to respondWith()')
      // The body crosses as a buffer of its own, transferred: the page does not copy it again.
      const body = res._body == null && !res._stream ? null : (await res.arrayBuffer()).slice(0)
      post({ __sw: 'fetch-done', id: m.id, kind: 'response', response: { status: res.status, statusText: res.statusText, headers: [...res.headers], url: res.url, type: res.type, redirected: res.redirected, body } }, body ? [body] : [])
      handledOk()
    }).catch((e) => { post({ __sw: 'fetch-done', id: m.id, kind: 'error', error: String(e?.message ?? e) }); handledFail(e) })
  }

  // ---------------------------------------------------------------------------------------------- the global
  const scope = (name) => class { static [Symbol.hasInstance](o) { return o === g } static get name() { return name } }
  const ServiceWorkerGlobalScope = scope('ServiceWorkerGlobalScope')
  delete g.postMessage; delete g.close; delete g.DedicatedWorkerGlobalScope  // a service worker has neither (nor is it a dedicated worker)
  const u = new g.URL(init.scriptURL)
  g.location = { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, toString: () => u.href }
  if (init.type === 'module') g.importScripts = () => { throw new TypeError('Failed to execute \'importScripts\' on \'WorkerGlobalScope\': Module scripts don\'t support importScripts().') }
  Object.assign(g, {
    ServiceWorkerGlobalScope, WorkerGlobalScope: scope('WorkerGlobalScope'), ExtendableEvent, InstallEvent, ExtendableMessageEvent, FetchEvent,
    ServiceWorker, ServiceWorkerRegistration, NavigationPreloadManager, Client, WindowClient, Clients,
    registration, clients: new Clients(INTERNAL), serviceWorker: workerObj(init), isSecureContext: true, origin: init.origin,
    skipWaiting: () => call('skipWaiting').then(() => undefined),
    oninstall: null, onactivate: null, onfetch: null, onmessage: null, onmessageerror: null,
  })
  applyState(init.registration)
}
const INTERNAL = Symbol('internal'), EXT = Symbol('extendable'), RESPOND = Symbol('respondWith')
