// Service workers (WP-27), only with host.json `web.serviceWorker: true` (runtime/src/index.js installs this then;
// otherwise nothing of it exists: no navigator.serviceWorker, no ServiceWorker* globals, every load as before).
//
// The page is the registry, as a browser's service-worker job queue is: register/update/unregister jobs, Install,
// Activate, Try Activate, claim and skipWaiting run here. Each service-worker version is a worker isolate
// (host/js/worker.cpp) whose prelude is assets/host-sw.js (serviceworker/sw-global.js: the worker prelude plus the
// ServiceWorkerGlobalScope of scope.js); page and version talk in messages tagged __sw:
//   page -> SW  {__sw:'hello'}                              -> {__sw:'evaluated', handles: [event types]}
//               {__sw:'event', id, type: install|activate}  -> {__sw:'event-done', id, ok, error}
//               {__sw:'fetch', id, client, request}         -> {__sw:'fetch-done', id, kind: response|fallback|error, response, error}
//               {__sw:'message', data, ports, client|source} (ServiceWorker.postMessage)
//               {__sw:'state', registration}                 (installing/waiting/active snapshots after every change)
//               {__sw:'reply', id, ok, value, error}         (answers to calls)
//   SW -> page  {__sw:'call', id, op, args}  op: clients, client, claim, skipWaiting, update, unregister, relay
//               {__sw:'post', client, data, ports}           (Client.postMessage)
// Registrations (scope, updateViaCache, the active and waiting versions' script URL, type and source) persist in
// filesDir/service-workers.json through __native.worker.registry. At start, the registration whose scope matches the
// page's URL controls the page from the start, as on a browser's reload: its active version starts before the entry
// module runs. A version installed while the page was controlled waits for the next launch (the page is the only
// client and never goes away while the app runs), unless it calls skipWaiting(); at the next start no client exists
// yet, so a waiting version is activated before the page starts.
//
// Loads a controlled page makes go to the active version as FetchEvents: fetch(), XMLHttpRequest (over fetch),
// <img>/Image, <script src> and Worker scripts (SW_HOOK, with their request destinations). Not: the ES module graph,
// which host/js/modules.cpp loads natively, nor blob:/data: URLs (as in a browser). A version that has no fetch
// listener is never asked.
const SW_HOOK = Symbol.for('webxr-host.serviceworker')
const INTERNAL = Symbol('internal'), V = Symbol('version'), REG = Symbol('registration')
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MODES = { image: 'no-cors', script: 'no-cors', worker: 'same-origin' }

export function install(g, { workers } = {}) {
  const n = g.__native
  if (n.config?.web?.serviceWorker !== true) return
  const store = n.worker?.registry
  if (!store || !workers?.spawnRaw) { n.log(2, 'web.serviceWorker: this host has no service-worker registry; navigator.serviceWorker stays absent'); return }
  const { EventTarget, Event, MessageEvent, DOMException } = g
  const origin = g.location.origin
  const dbg = n.config?.debug?.serviceWorker ? (m) => n.log(1, 'sw: ' + m) : null
  const task = (f) => n.loop.postTask(f)
  const err = (name, msg) => name === 'TypeError' ? new TypeError(msg) : new DOMException(msg, name)
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
  const clientId = g.crypto?.randomUUID?.() ?? ('client-' + Math.random().toString(36).slice(2))
  const client = () => ({ id: clientId, url: g.location.href, type: 'window', frameType: 'top-level', visibilityState: g.document?.visibilityState ?? 'visible', focused: g.document?.hasFocus?.() ?? true })
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16).padStart(8, '0') }

  // ------------------------------------------------------------------------------------------ registry state
  const regs = new Map()  // scope -> Reg
  let controller = null    // the Version controlling the page
  let verSeq = 0, regSeq = 0

  class Version {
    constructor(reg, scriptURL, type, source, handles = null) {
      this.id = ++verSeq; this.reg = reg; this.scriptURL = scriptURL; this.type = type; this.source = source; this.hash = hash(source)
      this.state = 'parsed'; this.skip = false; this.thread = null; this.handles = handles; this.evalError = null; this.isEvaluated = false
      this.pending = new Map(); this.seq = 0; this.obj = null
      this.evaluated = new Promise((r) => { this._evaluated = r }); this.activated = new Promise((r) => { this._activated = r })
    }
    snap() { return { id: this.id, scriptURL: this.scriptURL, state: this.state } }
    start() {
      if (this.thread || this.state === 'redundant') return
      const init = { serviceWorker: { ...this.snap(), type: this.type, scope: this.reg.scope, origin, registration: regSnap(this.reg) } }
      this.thread = workers.spawnRaw(this.source, this.scriptURL, this.type === 'module', { prelude: 'host-sw.js', init }, (m) => this.control(m))
      // An error before the evaluated answer is the script's own evaluation failing (worker.cpp posts it first).
      this.thread.addEventListener('error', (e) => { if (!this.isEvaluated && this.evalError === null) this.evalError = e.message || 'error'; n.log(3, `sw ${this.scriptURL}: ${e.message}`) })
      this.thread._send({ __sw: 'hello' })
      dbg?.(`started ${this.scriptURL} #${this.id} (${this.state})`)
    }
    send(msg, buffers) { this.start(); if (this.thread) this.thread._send(msg, buffers) }
    stop() {
      if (this.thread) { this.thread.terminate(); this.thread = null }
      for (const [, p] of this.pending) p.resolve(p.fetch ? { kind: 'fallback' } : { ok: false, error: 'terminated' })
      this.pending.clear(); this._evaluated(); this._activated()  // nothing waits on a stopped version
    }
    request(msg, isFetch) {
      this.start(); if (!this.thread) return Promise.resolve(isFetch ? { kind: 'fallback' } : { ok: false, error: 'redundant' })
      return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject, fetch: isFetch }); this.thread._send({ ...msg, id }) })
    }
    event(type) { return this.request({ __sw: 'event', type }, false) }
    control(m) {
      switch (m.__sw) {
        case 'evaluated': this.isEvaluated = true; this.handles = this.evalError === null && m.handles.includes('fetch'); this._evaluated(); break
        case 'event-done': case 'fetch-done': { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m) } if (!live(this.reg)) tryClear(this.reg); break }
        case 'call': this.call(m); break
        case 'post': container[INTERNAL].deliver(m, this); break
      }
    }
    async call({ id, op, args }) {
      try { const value = await OPS[op](this, args ?? {}); this.send({ __sw: 'reply', id, ok: true, value }) }
      catch (e) { this.send({ __sw: 'reply', id, ok: false, error: { name: e?.name ?? 'Error', message: String(e?.message ?? e) } }) }
    }
  }
  class Reg { constructor(scope, updateViaCache) { this.id = ++regSeq; this.scope = scope; this.updateViaCache = updateViaCache; this.installing = null; this.waiting = null; this.active = null; this.obj = null; this.preload = { enabled: false, headerValue: 'true' } } }
  const newest = (r) => r.installing ?? r.waiting ?? r.active
  const live = (r) => regs.get(r.scope) === r
  const using = (r) => controller !== null && controller.reg === r
  const regSnap = (r) => ({ scope: r.scope, updateViaCache: r.updateViaCache, installing: r.installing?.snap() ?? null, waiting: r.waiting?.snap() ?? null, active: r.active?.snap() ?? null })
  const match = (url) => { let best = null; for (const [scope, r] of regs) if (url.startsWith(scope) && (!best || scope.length > best.scope.length)) best = r; return best }
  const broadcast = (r) => { const s = regSnap(r); for (const v of [r.installing, r.waiting, r.active]) if (v && v.thread) v.thread._send({ __sw: 'state', registration: s }) }
  function setState(v, state) {
    if (v.state === state) return
    v.state = state; dbg?.(`${v.scriptURL} #${v.id} ${state}`)
    const o = v.obj; if (o) task(() => { o._state = state; o.dispatchEvent(new Event('statechange')) })  // the object's state changes in the task, as a browser's does
  }
  function setController(v) {
    const prev = controller; controller = v
    task(() => container.dispatchEvent(new Event('controllerchange')))
    if (prev && prev.reg !== v.reg) { tryActivate(prev.reg); tryClear(prev.reg) }
  }
  function persist() {
    const out = []
    for (const r of regs.values()) {
      const ver = (v) => v && { scriptURL: v.scriptURL, type: v.type, hash: v.hash, handlesFetch: v.handles, source: v.source }
      if (r.active || r.waiting) out.push({ scope: r.scope, updateViaCache: r.updateViaCache, active: ver(r.active), waiting: ver(r.waiting) })
    }
    if (!store.save(JSON.stringify({ version: 1, registrations: out }))) n.log(2, 'sw: saving the registrations failed')
  }

  // ------------------------------------------------------------------------------------------ jobs
  let jobs = Promise.resolve()
  const schedule = (job) => { const p = jobs.then(job); jobs = p.catch((e) => n.log(3, `sw job: ${e?.stack ?? e}`)); return p }
  function fetchScript(url, scope) {
    const fail = (name, why) => err(name, `Failed to register a ServiceWorker for scope ('${scope}') with script ('${url}'): ${why}`)
    if (!url.startsWith(origin + '/')) throw fail('SecurityError', 'The origin of the script does not match the current origin.')
    const path = url.slice(origin.length + 1).split(/[?#]/)[0], src = n.assets.readText(path)
    if (src == null) throw fail('TypeError', 'A bad HTTP response code (404) was received when fetching the script.')
    const mime = n.assets.mime(path)
    if (!/javascript|ecmascript/.test(mime)) throw fail('SecurityError', `The script has an unsupported MIME type ('${mime}').`)
    return src
  }
  // Update (a register with a new script, register of the same one, update(), the start's soft update): the script's
  // bytes against the newest version's; a change installs a new version.
  async function update(r, scriptURL, type, resolve, reject) {
    if (!live(r)) { reject?.(new TypeError('Failed to update a ServiceWorker: the registration was unregistered.')); return }
    const nv = newest(r); let src
    try { src = fetchScript(scriptURL, r.scope) } catch (e) { if (!nv) regs.delete(r.scope); if (reject) reject(e); else n.log(2, `sw update: ${e.message}`); return }
    if (nv && nv.source === src && nv.scriptURL === scriptURL && nv.type === type) { resolve?.(regObj(r)); return }
    await installVersion(r, new Version(r, scriptURL, type, src), resolve)
  }
  async function installVersion(r, v, resolve) {
    r.installing = v; setState(v, 'installing'); v.start(); broadcast(r)
    resolve?.(regObj(r))
    const o = regObj(r); task(() => o.dispatchEvent(new Event('updatefound')))
    await v.evaluated
    let res = v.evalError === null ? await v.event('install') : { ok: false, error: v.evalError }
    if (res.ok && !live(r) && !using(r)) res = { ok: false, error: 'the registration was unregistered' }
    if (!res.ok) {
      n.log(2, `sw: ${v.scriptURL} failed to install: ${res.error}`)
      if (r.installing === v) r.installing = null
      setState(v, 'redundant'); v.stop(); broadcast(r)
      if (!r.waiting && !r.active && live(r)) regs.delete(r.scope)
      return
    }
    if (r.waiting) { const old = r.waiting; setState(old, 'redundant'); old.stop() }
    r.waiting = v; r.installing = null; setState(v, 'installed'); broadcast(r); persist()
    n.log(1, `sw: installed ${v.scriptURL} (scope ${r.scope})`)
    // Not awaited: the job ends with the install, so a call the activate handler makes (unregister, update) is not
    // queued behind it forever. Fetches and the start wait on the version's activation themselves.
    Promise.resolve(tryActivate(r)).catch((e) => n.log(3, `sw activate: ${e?.stack ?? e}`))
  }
  function tryActivate(r) {
    const w = r.waiting; if (!w || r.active?.state === 'activating') return
    if (!r.active || !using(r) || w.skip) return activate(r)
  }
  async function activate(r) {
    const v = r.waiting; if (!v) return
    const old = r.active
    r.active = v; r.waiting = null
    if (old) setState(old, 'redundant')
    setState(v, 'activating'); v.start()
    if (old && controller === old) setController(v)
    if (live(r) && match(g.location.href) === r) readyResolve(regObj(r))
    broadcast(r); persist()
    old?.stop()
    const res = await v.event('activate')
    if (!res.ok) n.log(2, `sw: ${v.scriptURL} activate: ${res.error}`)
    if (v.state !== 'activating') return
    setState(v, 'activated'); broadcast(r); v._activated()
    n.log(1, `sw: activated ${v.scriptURL} (scope ${r.scope})`)
    await tryActivate(r)  // a version that called skipWaiting while this one was activating
  }
  function tryClear(r) {
    if (live(r) || using(r)) return
    for (const v of [r.installing, r.waiting, r.active]) if (v && v.pending.size) return  // again when its events are done (control)
    for (const k of ['installing', 'waiting', 'active']) { const v = r[k]; if (v) { setState(v, 'redundant'); v.stop(); r[k] = null } }
  }

  // ------------------------------------------------------------------------------------------ the SW's calls
  const OPS = {
    clients(v, { type = 'window', includeUncontrolled = false }) { return (type === 'window' || type === 'all') && (includeUncontrolled || controller === v) ? [client()] : [] },
    client(v, { id }) { return id === clientId ? client() : null },
    claim(v) {
      if (v.reg.active !== v || (v.state !== 'activating' && v.state !== 'activated')) throw err('InvalidStateError', 'Only the active worker can claim clients.')
      if (live(v.reg) && match(g.location.href) === v.reg && controller !== v) setController(v)
    },
    skipWaiting(v) { v.skip = true; tryActivate(v.reg) },
    update(v) { const nv = newest(v.reg); if (!nv) throw err('InvalidStateError', 'Failed to update a ServiceWorker: no worker.'); return new Promise((resolve, reject) => schedule(() => update(v.reg, nv.scriptURL, nv.type, resolve, reject))).then(() => undefined) },
    unregister(v) { return new Promise((resolve) => schedule(() => unregister(v.reg, resolve))) },
    relay(v, { to, data }) { for (const r of regs.values()) for (const t of [r.installing, r.waiting, r.active]) if (t && t.id === to) t.send({ __sw: 'message', data, ports: [], source: v.snap() }) },
  }
  function unregister(r, resolve) {
    if (!live(r)) { resolve(false); return }
    regs.delete(r.scope); persist(); resolve(true)
    n.log(1, `sw: unregistered scope ${r.scope}`)
    tryClear(r)
  }

  // ------------------------------------------------------------------------------------------ page objects
  const swObj = (v) => v ? (v.obj ??= new ServiceWorker(INTERNAL, v)) : null
  const regObj = (r) => r.obj ??= new ServiceWorkerRegistration(INTERNAL, r)
  const illegal = (t) => { if (t !== INTERNAL) throw new TypeError('Illegal constructor') }
  const transferOf = (opts) => { const list = Array.isArray(opts) ? opts : opts?.transfer ?? []; return { buffers: list.filter((t) => t instanceof ArrayBuffer), ports: list.filter((t) => t instanceof g.MessagePort) } }
  // A transferred port of a channel made in this page: its entangled peer, which stays here, talks to the service
  // worker from now on (workbox-window's messageSW keeps port1 and transfers port2).
  const exportPort = (p, thread) => {
    const peer = p._peer; if (!peer) return p._exportTo(thread)
    p._peer = null; peer._peer = null; peer._remote = { worker: thread, id: p._id }; thread._ports.set(p._id, peer); return p._id
  }
  class ServiceWorker extends EventTarget {
    constructor(t, v) { illegal(t); super(); this[V] = v; this._state = v.state; this.onstatechange = null; this.onerror = null }
    get scriptURL() { return this[V].scriptURL }
    get state() { return this._state }
    postMessage(data, opts) {
      const v = this[V]; if (v.state === 'redundant') return
      const t = transferOf(opts); v.start(); if (!v.thread) return
      v.send({ __sw: 'message', data, ports: t.ports.map((p) => exportPort(p, v.thread)), client: client() }, t.buffers)
    }
  }
  class NavigationPreloadManager {
    constructor(t, r) { illegal(t); this[REG] = r }
    enable() { this[REG].preload.enabled = true; return Promise.resolve() }
    disable() { this[REG].preload.enabled = false; return Promise.resolve() }
    setHeaderValue(v) { this[REG].preload.headerValue = String(v); return Promise.resolve() }
    getState() { return Promise.resolve({ ...this[REG].preload }) }
  }
  class ServiceWorkerRegistration extends EventTarget {
    constructor(t, r) { illegal(t); super(); this[REG] = r; this.onupdatefound = null; this._preload = new NavigationPreloadManager(INTERNAL, r) }
    get scope() { return this[REG].scope }
    get updateViaCache() { return this[REG].updateViaCache }
    get installing() { return swObj(this[REG].installing) }
    get waiting() { return swObj(this[REG].waiting) }
    get active() { return swObj(this[REG].active) }
    get navigationPreload() { return this._preload }
    update() {
      const r = this[REG], nv = newest(r)
      if (!nv) return Promise.reject(err('InvalidStateError', 'Failed to update a ServiceWorker: the registration has no worker.'))
      return new Promise((resolve, reject) => schedule(() => update(r, nv.scriptURL, nv.type, resolve, reject)))
    }
    unregister() { const r = this[REG]; return new Promise((resolve) => schedule(() => unregister(r, resolve))) }
    showNotification() { return Promise.reject(new TypeError('No notification permission has been granted for this origin.')) }
    getNotifications() { return Promise.resolve([]) }
  }
  let readyResolve; const ready = new Promise((r) => { readyResolve = r })
  class ServiceWorkerContainer extends EventTarget {
    constructor(t) {
      illegal(t); super(); this.oncontrollerchange = null; this.onmessageerror = null; this._onmessage = null
      let enabled = false; const queue = []
      const dispatch = (m, v) => {
        const ports = (m.ports ?? []).map((id) => { let p = v.thread?._ports.get(id); if (!p && v.thread) { p = new g.MessagePort(id); p._remote = { worker: v.thread, id }; v.thread._ports.set(id, p) } return p }).filter(Boolean)
        this.dispatchEvent(new MessageEvent('message', { data: m.data, origin, source: swObj(v), ports }))
      }
      this[INTERNAL] = {
        enable: () => { if (enabled) return; enabled = true; const q = queue.splice(0); for (const [m, v] of q) task(() => dispatch(m, v)) },
        deliver: (m, v) => { if (enabled) task(() => dispatch(m, v)); else queue.push([m, v]) },
      }
    }
    get controller() { return swObj(controller) }
    get ready() { return ready }
    get onmessage() { return this._onmessage }
    set onmessage(f) { this._onmessage = f; this[INTERNAL].enable() }
    startMessages() { this[INTERNAL].enable() }
    register(scriptURL, options = {}) {
      return new Promise((resolve, reject) => {
        let script, scope
        try { script = new g.URL(String(scriptURL), g.location.href) } catch { throw new TypeError(`Failed to register a ServiceWorker: The URL '${scriptURL}' is invalid.`) }
        try { scope = options.scope != null ? new g.URL(String(options.scope), g.location.href) : new g.URL('./', script.href) } catch { throw new TypeError(`Failed to register a ServiceWorker: The scope '${options.scope}' is invalid.`) }
        scope.hash = ''
        const type = options.type ?? 'classic', uvc = options.updateViaCache ?? 'imports'
        if (type !== 'classic' && type !== 'module') throw new TypeError(`Failed to register a ServiceWorker: '${type}' is not a valid WorkerType.`)
        if (!['imports', 'all', 'none'].includes(uvc)) throw new TypeError(`Failed to register a ServiceWorker: '${uvc}' is not a valid ServiceWorkerUpdateViaCache.`)
        for (const [what, u] of [['script', script], ['scope', scope]]) {
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError(`Failed to register a ServiceWorker: The URL protocol of the ${what} ('${u.href}') is not supported.`)
          if (/%2f|%5c/i.test(u.pathname)) throw new TypeError(`Failed to register a ServiceWorker: The ${what} URL ('${u.href}') may not contain an escaped slash.`)
          if (u.origin !== origin) throw err('SecurityError', `Failed to register a ServiceWorker: The origin of the provided ${what} ('${u.origin}') does not match the current origin ('${origin}').`)
        }
        // The max scope is the script's directory (assets carry no Service-Worker-Allowed header).
        const max = script.pathname.slice(0, script.pathname.lastIndexOf('/') + 1)
        if (!scope.pathname.startsWith(max)) throw err('SecurityError', `Failed to register a ServiceWorker for scope ('${scope.href}') with script ('${script.href}'): The path of the provided scope ('${scope.pathname}') is not under the max scope allowed ('${max}'). Adjust the scope, move the Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the scope.`)
        const s = scope.href, u = script.href
        schedule(async () => {
          let r = regs.get(s); const nv = r && newest(r)
          if (r && nv && nv.scriptURL === u && nv.type === type && r.updateViaCache === uvc) { resolve(regObj(r)); return update(r, u, type, null, null) }  // a browser resolves here; the bytes are checked too
          if (!r) { r = new Reg(s, uvc); regs.set(s, r) } else if (r.updateViaCache !== uvc) { r.updateViaCache = uvc; persist() }
          return update(r, u, type, resolve, reject)
        })
      })
    }
    getRegistration(clientURL = '') {
      let u; try { u = new g.URL(String(clientURL), g.location.href) } catch { return Promise.reject(new TypeError('Failed to get a ServiceWorkerRegistration: invalid URL')) }
      if (u.origin !== origin) return Promise.reject(err('SecurityError', 'Failed to get a ServiceWorkerRegistration: The origin of the provided documentURL does not match the current origin.'))
      const r = match(u.href); return Promise.resolve(r ? regObj(r) : undefined)
    }
    getRegistrations() { return Promise.resolve([...regs.values()].map(regObj)) }
  }
  const container = new ServiceWorkerContainer(INTERNAL)
  g.document?.addEventListener?.('DOMContentLoaded', () => container[INTERNAL].enable(), { once: true })  // a parsed document's client message queue

  // ------------------------------------------------------------------------------------------ fetch interception
  const baseFetch = g.fetch
  const controls = (url) => controller !== null && controller.handles !== false && (url.startsWith('https:') || url.startsWith('http:'))
  async function route(input, init, destination, hops = 0) {
    const req = init === undefined && input instanceof g.Request ? input : new g.Request(input, init)
    const v = controller
    if (!v || v.handles === false || !controls(req.url)) return baseFetch(req)
    if (req.signal?.aborted) throw abortError()
    const body = req._body != null || req._stream ? await req._bytes() : null
    const request = { url: req.url, method: req.method, headers: [...req.headers], body: body && body.slice().buffer, mode: MODES[destination] ?? req.mode, credentials: req.credentials, cache: req.cache,
      redirect: req.redirect, referrer: req.referrer, integrity: req.integrity, keepalive: req.keepalive, destination }
    if (v.state === 'activating') await v.activated
    const sent = v.request({ __sw: 'fetch', client: clientId, request }, true)
    const res = await (req.signal ? Promise.race([sent, new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(abortError()), { once: true }))]) : sent)
    dbg?.(`fetch ${destination || 'fetch'} ${req.url}: ${res.kind}${res.response ? ' ' + res.response.status : ''}`)
    if (res.kind === 'fallback') return baseFetch(body ? new g.Request(req.url, { method: req.method, headers: req.headers, body, redirect: req.redirect, signal: req.signal }) : req)
    if (res.kind !== 'response') { n.log(2, `sw: the FetchEvent for "${req.url}" resulted in a network error response: ${res.error}`); throw new TypeError('Failed to fetch') }
    const s = res.response, loc = s.headers.find(([k]) => k === 'location')?.[1]
    if (REDIRECTS.has(s.status) && loc != null && req.redirect !== 'manual') {
      if (req.redirect === 'error' || hops >= 20) throw new TypeError('Failed to fetch: redirect')
      const get = s.status === 303 || ((s.status === 301 || s.status === 302) && req.method === 'POST')
      const next = await route(new g.URL(loc, req.url).href, { method: get ? 'GET' : req.method, headers: req.headers, body: get ? null : body, redirect: req.redirect, signal: req.signal }, destination, hops + 1)
      next.redirected = true; return next
    }
    const out = new g.Response(null, { status: s.status, statusText: s.statusText, headers: s.headers, url: s.url || req.url })
    out._body = s.body ? new Uint8Array(s.body) : null; out.type = s.type || 'basic'; out.redirected = !!s.redirected
    return out
  }
  g.fetch = function fetch(input, init) { return controller === null ? baseFetch(input, init) : route(input, init, '') }
  const abs = (url) => { try { return new g.URL(String(url), g.location.href).href } catch { return String(url) } }
  Object.defineProperty(g, SW_HOOK, { configurable: true, value: {
    controlled: (url) => controller !== null && controls(abs(url)),
    load: (url, destination) => { const u = controller === null ? '' : abs(url); return u && controls(u) ? route(u, undefined, destination) : g.fetch(url) },
  } })

  // ------------------------------------------------------------------------------------------ start
  let saved = null
  try { const t = store.load(); saved = t ? JSON.parse(t) : null } catch (e) { n.log(2, `sw: the saved registrations are unreadable (${e.message}); starting without`) }
  for (const s of saved?.registrations ?? []) {
    if (typeof s.scope !== 'string' || !s.scope.startsWith(origin + '/')) continue
    const r = new Reg(s.scope, s.updateViaCache ?? 'imports')
    const ver = (x, state) => { if (!x || typeof x.source !== 'string') return null; const v = new Version(r, x.scriptURL, x.type ?? 'classic', x.source, typeof x.handlesFetch === 'boolean' ? x.handlesFetch : null); v.state = state; return v }
    r.active = ver(s.active, 'activated'); r.waiting = ver(s.waiting, 'installed')
    if (r.active) r.active._activated()
    if (r.active || r.waiting) regs.set(r.scope, r)
  }
  for (const r of regs.values()) if (r.waiting) activate(r)  // no client yet: a waiting version takes over before the page starts
  const mine = match(g.location.href)
  if (mine?.active) {
    controller = mine.active; mine.active.start(); readyResolve(regObj(mine))
    n.log(1, `sw: ${mine.active.scriptURL} controls ${g.location.href} (scope ${mine.scope})`)
    // A browser checks the controlling registration for an update after each navigation: the same once the page loaded.
    g.addEventListener?.('load', () => { const nv = newest(mine); if (nv && live(mine)) schedule(() => update(mine, nv.scriptURL, nv.type, null, null)) }, { once: true })
  }

  g.navigator.serviceWorker = container
  Object.assign(g, { ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer, NavigationPreloadManager })
  // A browser's navigation waits for its controller to finish activating: the entry module waits for a version that
  // took over at this start (boot.js), at most 5 s.
  if (controller?.state === 'activating') return Promise.race([controller.activated, new Promise((r) => g.setTimeout(r, 5000))])
}
