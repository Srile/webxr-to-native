// Worker / MessageChannel / MessagePort on the host side (`__native.worker`; host/js/worker.cpp).
// Messages cross isolates as ValueSerializer buffers; MessagePorts travel by id and
// are re-created on the far side (comlink transfers a port into the worker).
export function install(g) {
  const n = g.__native; const W = n.worker
  if (!W?.spawn) return
  const workers = new Map()
  let portSeq = 1; const ports = new Map()   // local MessagePorts by id (host side)
  // host.json debug.workers: every message crossing the worker boundary, summarised (bring-up aid).
  const dbg = n.config?.debug?.workers ? (dir, wid, msg) => { let s; try { s = JSON.stringify(msg, (k, v) => v instanceof ArrayBuffer ? `[ArrayBuffer ${v.byteLength}]` : ArrayBuffer.isView(v) ? `[${v.constructor.name} ${v.length}]` : v) } catch (e) { s = '<unserialisable ' + e.message + '>' } n.log(1, `worker ${wid} ${dir} ${s.length > 300 ? s.slice(0, 300) + '…' : s}`) } : null

  class MessagePort extends g.EventTarget {
    constructor(id) { super(); this._id = id ?? portSeq++; this._peer = null; this._remote = null; this._queue = []; this._started = false; this.onmessage = null; this.onmessageerror = null; ports.set(this._id, this) }
    _deliver(data, transferredPorts = []) { const ev = new g.MessageEvent('message', { data, ports: transferredPorts }); if (!this._started && !this.onmessage) { this._queue.push(ev); return } this.dispatchEvent(ev) }
    start() { this._started = true; const q = this._queue; this._queue = []; for (const ev of q) this.dispatchEvent(ev) }
    set onmessage(f) { this._onmessage = f; if (f) this.start() } get onmessage() { return this._onmessage ?? null }
    postMessage(data, transfer) { const t = normalizeTransfer(transfer)
      if (this._remote) { this._remote.worker._send({ __port: this._remote.id, data, ports: t.ports.map(p => p._exportTo(this._remote.worker)) }, t.buffers); return }
      if (this._peer) { const peer = this._peer; g.setTimeout(() => peer._deliver(data, t.ports), 0) } }
    close() { this._peer = null; this._remote = null; ports.delete(this._id) }
    _exportTo(worker) { // hand this port to a worker: messages from the worker to this id arrive here; our sends go to the worker
      this._remote = { worker, id: this._id }; worker._ports.set(this._id, this); return this._id }
  }
  class MessageChannel { constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._peer = this.port2; this.port2._peer = this.port1 } }
  function normalizeTransfer(transfer) { const buffers = [], ps = []; for (const t of transfer ?? []) { if (t instanceof ArrayBuffer) buffers.push(t); else if (t instanceof MessagePort) ps.push(t) } return { buffers, ports: ps } }
  function replacePortsForSend(data, ps) { return data }

  class Worker extends g.EventTarget {
    constructor(url, opts = {}) {
      super(); this.onmessage = null; this.onerror = null; this.onmessageerror = null; this._ports = new Map()
      const href = new g.URL(String(url), g.location.href).href; const isModule = opts.type === 'module'
      let src
      if (href.startsWith('blob:')) { const b = g.__hostLookupObjectURL(href); if (!b) throw new g.DOMException(`Worker: unknown blob ${href}`, 'NetworkError'); src = new g.TextDecoder().decode(b._bytes()) }
      else if (href.startsWith('data:')) { const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(href); src = m[1] ? g.atob(m[2]) : decodeURIComponent(m[2]) }
      else { const origin = g.location.origin; if (!href.startsWith(origin + '/')) throw new g.DOMException('Worker: cross-origin script', 'SecurityError'); src = n.assets.readText(href.slice(origin.length + 1).split(/[?#]/)[0]); if (src == null) throw new g.DOMException(`Worker: ${href} not found`, 'NetworkError') }
      this._id = W.spawn(src, href, isModule); workers.set(this._id, this)
    }
    _send(data, buffers) { if (dbg) dbg('<-', this._id, data); W.post(this._id, data, buffers) }
    postMessage(data, transfer) { const t = normalizeTransfer(Array.isArray(transfer) ? transfer : transfer?.transfer); const portIds = t.ports.map(p => p._exportTo(this)); this._send({ __msg: 1, data, ports: portIds }, t.buffers) }
    terminate() { W.terminate(this._id); workers.delete(this._id) }
    _onNative(msg) {
      if (dbg) dbg('->', this._id, msg)
      const ps = (msg.ports ?? []).map(id => { let p = this._ports.get(id); if (!p) { p = new MessagePort(id); p._remote = { worker: this, id }; this._ports.set(id, p) } return p })
      if (msg.__port !== undefined) { const p = this._ports.get(msg.__port); if (p) p._deliver(msg.data, ps); return }
      this.dispatchEvent(new g.MessageEvent('message', { data: msg.data, ports: ps }))
    }
  }
  W.onMessage((id, msg) => { const w = workers.get(id); if (w) w._onNative(msg) })
  W.onError((id, message) => { const w = workers.get(id); if (w) w.dispatchEvent(new g.ErrorEvent('error', { message })) })
  class SharedWorker { constructor() { throw new g.DOMException('SharedWorker unsupported', 'NotSupportedError') } }
  Object.assign(g, { Worker, MessageChannel, MessagePort, SharedWorker })
}
