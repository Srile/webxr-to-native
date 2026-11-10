// The WORKER prelude (bundled to assets/host-worker.js): self/postMessage/onmessage,
// timers, fetch (assets + http via the host pool), TextDecoder, console (native),
// importScripts, location, navigator — and no DOM, GL, XR or audio.
import { install as installFetch } from '../fetch/index.js'
import { install as installWasm } from '../wasm/index.js'
import * as ev from '../dom-lite/events.js'
import { atob, btoa } from '../fetch/base64.js'
import { DOMException, installAbort } from '../dom-lite/globals.js'
import { lookupObjectURL } from '../fetch/index.js'
import { makeImageData } from '../images/image_data.js'
import { install as installIntl } from '../intl/index.js'
import { install as installStorage } from '../storage/index.js'
const g = globalThis; const n = g.__native
// A minimal shim of the loop/assets/net/store/log/config/info surface the shared fetch module expects.
g.__native = { loop: { now: n.now, setTimer: n.setTimer, clearTimer: n.clearTimer, postTask: (cb) => n.setTimer(0, false, cb), onFrame() {}, exit: n.close }, assets: { read: n.assetRead, readText: (p) => { const b = n.assetRead(p); return b == null ? null : new TextDecoder().decode(new Uint8Array(b)) }, exists: (p) => n.assetRead(p) != null, mime: n.assetMime }, net: { fetch: n.fetch }, store: null, storage: n.storage, clone: (v) => v, log: n.log, config: { web: { origin: n.origin } }, info: { userAgent: n.userAgent }, _raw: n }
Object.assign(g, ev)
g.self = g; g.window = undefined
g.location = { href: n.url, origin: n.origin, protocol: n.origin.split(':')[0] + ':', host: n.origin.replace(/^https?:\/\//, ''), hostname: n.origin.replace(/^https?:\/\//, '').split(':')[0], pathname: '/', search: '', hash: '', toString: () => n.url }
g.__hostBaseURL = /^(blob|data):/.test(n.url) ? n.origin + '/' : n.url
g.navigator = { userAgent: n.userAgent, hardwareConcurrency: 4, language: 'en-US', languages: ['en-US'], onLine: true, platform: 'Linux aarch64' }
installIntl(g, n.intl)  // the system's locale (host.json js.intl on Android; intl/index.js)
const wrap = (cb, args) => typeof cb === 'function' ? (args.length ? () => cb(...args) : cb) : () => {}
g.setTimeout = (cb, ms = 0, ...a) => n.setTimer(Math.max(0, +ms || 0), false, wrap(cb, a)); g.clearTimeout = (id) => { if (id) n.clearTimer(id) }
g.setInterval = (cb, ms = 0, ...a) => n.setTimer(Math.max(1, +ms || 0), true, wrap(cb, a)); g.clearInterval = g.clearTimeout
g.queueMicrotask = (cb) => Promise.resolve().then(cb)
g.performance = { now: () => n.now(), timeOrigin: Date.now() - n.now(), mark() {}, measure() {}, getEntriesByName: () => [], getEntriesByType: () => [] }
g.structuredClone = (v) => JSON.parse(JSON.stringify(v))
g.crypto = g.crypto ?? { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a }, randomUUID: () => Math.random().toString(16).slice(2) }
g.atob = atob; g.btoa = btoa; g.DOMException = DOMException; installAbort(g)
installWasm(g, n)  // before fetch, as in the page
installFetch(g)
g.ImageData = makeImageData(g)  // the MSDF worker posts its atlas back as one
installStorage(g)  // IndexedDB + Cache API, as in the page (only with __native.storage: host.json storage)
// importScripts: same-origin assets, blob: URLs minted in this worker (three-mesh-bvh / troika rehydrate their module source that way) and data: URLs.
const scriptSource = (href) => {
  if (href.startsWith('blob:')) { const b = lookupObjectURL(href); return b ? new g.TextDecoder().decode(b._bytes()) : null }
  if (href.startsWith('data:')) { const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(href); return m ? (m[1] ? atob(m[2]) : decodeURIComponent(m[2])) : null }
  return href.startsWith(n.origin + '/') ? g.__native.assets.readText(href.slice(n.origin.length + 1).split(/[?#]/)[0]) : null
}
g.importScripts = (...urls) => { for (const u of urls) { const href = new g.URL(String(u), g.__hostBaseURL).href; const src = scriptSource(href); if (src == null) throw new Error(`importScripts: ${href} not found`); (0, eval)(src) } }
// Messaging. The host wraps payloads as {__msg,data,ports} or {__port,id,data,ports}.
const target = new ev.EventTarget(); const ports = new Map(); let portSeq = 1e6
class MessagePort extends ev.EventTarget {
  constructor(id) { super(); this._id = id ?? portSeq++; this._queue = []; this._started = false; this._onmessage = null; ports.set(this._id, this); this._peer = null }
  set onmessage(f) { this._onmessage = f; if (f) this.start() } get onmessage() { return this._onmessage }
  start() { this._started = true; const q = this._queue; this._queue = []; for (const e of q) this.dispatchEvent(e) }
  _deliver(data, ps = []) { const e = new ev.MessageEvent('message', { data, ports: ps }); if (!this._started && !this._onmessage) { this._queue.push(e); return } this.dispatchEvent(e) }
  postMessage(data, transfer) { const bufs = (transfer ?? []).filter(t => t instanceof ArrayBuffer); const ps = (transfer ?? []).filter(t => t instanceof MessagePort).map(p => p._id); if (this._peer) { const peer = this._peer; g.setTimeout(() => peer._deliver(data, []), 0); return } n.postMessage({ __port: this._id, data, ports: ps }, bufs) }
  close() { ports.delete(this._id) }
}
class MessageChannel { constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._peer = this.port2; this.port2._peer = this.port1 } }
g.MessagePort = MessagePort; g.MessageChannel = MessageChannel
g.addEventListener = (...a) => target.addEventListener(...a); g.removeEventListener = (...a) => target.removeEventListener(...a); g.dispatchEvent = (e) => target.dispatchEvent(e)
g.postMessage = (data, transfer) => { const list = Array.isArray(transfer) ? transfer : transfer?.transfer ?? []; const bufs = list.filter(t => t instanceof ArrayBuffer); const ps = list.filter(t => t instanceof MessagePort).map(p => p._id); n.postMessage({ __msg: 1, data, ports: ps }, bufs) }
g.close = () => n.close()
const portsFor = (ids) => (ids ?? []).map(id => ports.get(id) ?? new MessagePort(id))
function hostMessage(msg) {
  const ps = portsFor(msg.ports)
  if (msg.__port !== undefined) { const p = ports.get(msg.__port) ?? new MessagePort(msg.__port); p._deliver(msg.data, ps); return }
  const e = new ev.MessageEvent('message', { data: msg.data, ports: ps }); target.dispatchEvent(e); if (typeof g.onmessage === 'function') g.onmessage(e)
}
n.onMessage(hostMessage)
g.onmessage = null; g.onerror = null
g.WorkerGlobalScope = Object; g.DedicatedWorkerGlobalScope = Object
// What a worker flavour bundled on top of this prelude takes over (the service worker scope, runtime/src/serviceworker):
// the raw natives, the global's event target, this prelude's message handling and its MessagePorts by id.
export const internals = { native: n, target, hostMessage, portsFor, MessagePort }
