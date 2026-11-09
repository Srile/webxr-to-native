// fetch/Response/Request/Headers/Blob/File/XMLHttpRequest/createObjectURL/TextEncoder/TextDecoder/ReadableStream+WritableStream+TransformStream(minimal)
import { URL, URLSearchParams, setObjectURLHooks } from './url.js'
import { Event, ProgressEvent } from '../dom-lite/events.js'

const utf8 = { enc: (s) => encodeUtf8(s), dec: (b) => decodeUtf8(b) }
function encodeUtf8(str) {
  const out = []; for (let i = 0; i < str.length; i++) { let c = str.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { const lo = str.charCodeAt(i + 1); if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i++ } }
    if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)) }
  return new Uint8Array(out)
}
function decodeUtf8(bytes, fatal = false) {
  let s = '', i = 0; const n = bytes.length; const parts = []
  while (i < n) { const b = bytes[i++]; let cp
    if (b < 0x80) cp = b; else if ((b & 0xE0) === 0xC0 && i < n) cp = ((b & 31) << 6) | (bytes[i++] & 63); else if ((b & 0xF0) === 0xE0 && i + 1 < n) { cp = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63); i += 2 } else if ((b & 0xF8) === 0xF0 && i + 2 < n) { cp = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3 } else { if (fatal) throw new TypeError('The encoded data was not valid'); cp = 0xFFFD }
    if (cp > 0xFFFF) { cp -= 0x10000; parts.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)) } else parts.push(cp)
    if (parts.length > 8192) { s += String.fromCharCode.apply(null, parts); parts.length = 0 } }
  return s + String.fromCharCode.apply(null, parts)
}
export class TextEncoder { get encoding() { return 'utf-8' } encode(s = '') { return encodeUtf8(String(s)) } encodeInto(s, dest) { const b = encodeUtf8(String(s)); const n = Math.min(b.length, dest.length); dest.set(b.subarray(0, n)); return { read: s.length, written: n } } }
export class TextDecoder {
  constructor(label = 'utf-8', opts = {}) { this.encoding = String(label).toLowerCase().replace('utf8', 'utf-8'); this.fatal = !!opts.fatal; this.ignoreBOM = !!opts.ignoreBOM; this._pending = null }
  decode(input, opts = {}) {
    let bytes = input == null ? new Uint8Array(0) : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(0)
    if (this._pending) { const m = new Uint8Array(this._pending.length + bytes.length); m.set(this._pending); m.set(bytes, this._pending.length); bytes = m; this._pending = null }
    if (opts.stream) { let cut = bytes.length; for (let k = 1; k <= 3 && k <= bytes.length; k++) { const b = bytes[bytes.length - k]; if ((b & 0xC0) === 0x80) continue; const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1; if (need > k) cut = bytes.length - k; break } if (cut < bytes.length) { this._pending = bytes.slice(cut); bytes = bytes.subarray(0, cut) } }
    if (this.encoding === 'utf-8') { if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) bytes = bytes.subarray(3); return decodeUtf8(bytes, this.fatal) }
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s  // latin1 / ascii
  }
}

let blobSeq = 0; const objectURLs = new Map()
function partBytes(p) { if (p instanceof Blob) return p._bytes(); if (p instanceof ArrayBuffer) return new Uint8Array(p.slice(0)); if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)); return encodeUtf8(String(p)) }
export class Blob {
  constructor(parts = [], opts = {}) { const chunks = Array.from(parts, partBytes); let n = 0; for (const c of chunks) n += c.length; const buf = new Uint8Array(n); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length } this._buf = buf; this.type = String(opts.type ?? '').toLowerCase(); this._id = ++blobSeq }
  get size() { return this._buf.length }
  _bytes() { return this._buf }
  slice(start = 0, end = this.size, type = '') { const n = this.size; let s = start < 0 ? Math.max(n + start, 0) : Math.min(start, n), e = end < 0 ? Math.max(n + end, 0) : Math.min(end, n); const b = new Blob([], { type }); b._buf = this._buf.slice(s, Math.max(s, e)); return b }
  arrayBuffer() { return Promise.resolve(this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength)) }
  bytes() { return Promise.resolve(this._buf.slice()) }
  text() { return Promise.resolve(decodeUtf8(this._buf)) }
  stream() { return new ReadableStream({ start: (c) => { c.enqueue(this._buf.slice()); c.close() } }) }
  get [Symbol.toStringTag]() { return 'Blob' }
}
export class File extends Blob { constructor(parts, name, opts = {}) { super(parts, opts); this.name = String(name); this.lastModified = opts.lastModified ?? Date.now(); this.webkitRelativePath = '' } }
export function createObjectURL(obj) { const u = `blob:${globalThis.location?.origin ?? 'https://app.local'}/${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`; objectURLs.set(u, obj); return u }
export function revokeObjectURL(u) { objectURLs.delete(u) }
export function lookupObjectURL(u) { return objectURLs.get(String(u).split('#')[0]) }

// A minimal ReadableStream: one-shot pull of enqueued chunks; enough for Response.body and WebAssembly.instantiateStreaming.
export class ReadableStream {
  constructor(source = {}) { this._chunks = []; this._closed = false; this._locked = false; this._error = null
    const ctrl = { enqueue: (c) => { this._chunks.push(c); this._wake?.() }, close: () => { this._closed = true; this._wake?.() }, error: (e) => { this._error = e; this._wake?.() }, get desiredSize() { return 1 } }
    this._ctrl = ctrl; this._source = source; Promise.resolve().then(() => source.start?.(ctrl)) }
  get locked() { return this._locked }
  getReader() { if (this._locked) throw new TypeError('locked'); this._locked = true; const self = this
    return { read: async () => { for (;;) { if (self._error) throw self._error; if (self._chunks.length) return { value: self._chunks.shift(), done: false }; if (self._closed) return { value: undefined, done: true }; if (self._source.pull) { await self._source.pull(self._ctrl); continue } await new Promise(r => { self._wake = r }) } },
      releaseLock: () => { self._locked = false }, cancel: async () => { self._closed = true }, get closed() { return Promise.resolve() } } }
  cancel() { this._closed = true; return Promise.resolve() }
  async *[Symbol.asyncIterator]() { const r = this.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return; yield value } }
  tee() { const a = new ReadableStream(), b = new ReadableStream(); (async () => { for await (const c of this) { a._ctrl.enqueue(c); b._ctrl.enqueue(c) } a._ctrl.close(); b._ctrl.close() })(); return [a, b] }
  // Each chunk is written (and awaited) in turn, so the sink paces the read.
  async pipeTo(dest, { preventClose = false, preventAbort = false, preventCancel = false } = {}) {
    const r = this.getReader(), w = dest.getWriter()
    try {
      for (;;) { const { value, done } = await r.read(); if (done) break; await w.write(value) }
      if (!preventClose) await w.close()
    } catch (e) {
      if (!preventAbort) await w.abort(e).catch(() => {})
      if (!preventCancel) this.cancel(e)
      throw e
    } finally { r.releaseLock(); w.releaseLock() }
  }
  pipeThrough(pair, opts) { this.pipeTo(pair.writable, opts).catch(() => {}); return pair.readable }
}

// A minimal WritableStream over an underlying sink (start/write/close/abort): writes run one after another, a failed
// one errors the stream. Enough for pipeTo into a sink object (Wonderland's scene loader streams every scene so).
export class WritableStream {
  constructor(sink = {}) {
    this._sink = sink; this._locked = false; this._state = 'writable'; this._err = undefined
    this._ctrl = { error: (e) => { if (this._state === 'writable') { this._state = 'errored'; this._err = e } } }
    this._queue = Promise.resolve().then(() => sink.start?.(this._ctrl))
    this._queue.catch((e) => this._ctrl.error(e))
  }
  get locked() { return this._locked }
  _run(fn) {
    const p = this._queue.then(() => { if (this._state === 'errored') throw this._err; return fn() })
    this._queue = p.catch((e) => this._ctrl.error(e))
    return p
  }
  _write(chunk) { return this._run(() => this._sink.write?.(chunk, this._ctrl)) }
  _close() { return this._run(async () => { await this._sink.close?.(); this._state = 'closed' }) }
  _abort(reason) { if (this._state !== 'writable') return Promise.resolve(); this._state = 'errored'; this._err = reason; return Promise.resolve(this._sink.abort?.(reason)) }
  getWriter() {
    if (this._locked) throw new TypeError('locked'); this._locked = true; const s = this
    return { write: (c) => s._write(c), close: () => s._close(), abort: (r) => s._abort(r), releaseLock: () => { s._locked = false },
      get ready() { return Promise.resolve() }, get closed() { return s._queue.then(() => { if (s._state === 'errored') throw s._err }) }, get desiredSize() { return s._state === 'writable' ? 1 : 0 } }
  }
  abort(reason) { return this._abort(reason) }
  close() { return this._close() }
}

// A minimal TransformStream over a transformer (start/transform/flush): what is written comes out of readable.
export class TransformStream {
  constructor(t = {}) {
    this.readable = new ReadableStream()
    const out = this.readable._ctrl
    const ctrl = { enqueue: (c) => out.enqueue(c), error: (e) => out.error(e), terminate: () => out.close(), get desiredSize() { return 1 } }
    const started = Promise.resolve().then(() => t.start?.(ctrl))
    this.writable = new WritableStream({
      write: async (chunk) => { await started; if (t.transform) await t.transform(chunk, ctrl); else out.enqueue(chunk) },
      close: async () => { await started; await t.flush?.(ctrl); out.close() },
      abort: (r) => out.error(r),
    })
  }
}
async function streamToBytes(rs) { const parts = []; let n = 0; for await (const c of rs) { const u = c instanceof Uint8Array ? c : new Uint8Array(c); parts.push(u); n += u.length } const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }

export class Headers {
  constructor(init) { this._m = new Map(); if (init instanceof Headers) for (const [k, v] of init) this.append(k, v); else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v); else if (init && typeof init === 'object') for (const k of Object.keys(init)) this.append(k, init[k]) }
  append(k, v) { k = String(k).toLowerCase(); v = String(v).trim(); const cur = this._m.get(k); this._m.set(k, cur === undefined ? v : cur + ', ' + v) }
  set(k, v) { this._m.set(String(k).toLowerCase(), String(v).trim()) }
  get(k) { const v = this._m.get(String(k).toLowerCase()); return v === undefined ? null : v }
  has(k) { return this._m.has(String(k).toLowerCase()) } delete(k) { this._m.delete(String(k).toLowerCase()) }
  forEach(cb, t) { for (const [k, v] of this) cb.call(t, v, k, this) }
  *entries() { yield* [...this._m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1) } keys() { return [...this.entries()].map(e => e[0])[Symbol.iterator]() } values() { return [...this.entries()].map(e => e[1])[Symbol.iterator]() }
  [Symbol.iterator]() { return this.entries() } getSetCookie() { return [] }
}

class Body {
  _initBody(body) {
    this._bodyUsed = false; this._body = null; this._bodyText = null
    if (body == null) return
    if (typeof body === 'string') { this._body = encodeUtf8(body); this._ctype = 'text/plain;charset=UTF-8' }
    else if (body instanceof Blob) { this._body = body._bytes(); this._ctype = body.type || null }
    else if (body instanceof ArrayBuffer) this._body = new Uint8Array(body.slice(0))
    else if (ArrayBuffer.isView(body)) this._body = new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
    else if (body instanceof URLSearchParams) { this._body = encodeUtf8(body.toString()); this._ctype = 'application/x-www-form-urlencoded;charset=UTF-8' }
    else if (body instanceof ReadableStream) this._stream = body
    else if (body instanceof FormData) { const { bytes, type } = body._encode(); this._body = bytes; this._ctype = type }
    else { this._body = encodeUtf8(String(body)) }
  }
  get bodyUsed() { return this._bodyUsed }
  get body() { if (this._stream) return this._stream; if (this._body == null) return null; const b = this._body; return new ReadableStream({ start: (c) => { c.enqueue(b); c.close() } }) }
  async _bytes() { if (this._bodyUsed) throw new TypeError('body used already'); this._bodyUsed = true; if (this._stream) return streamToBytes(this._stream); return this._body ?? new Uint8Array(0) }
  async arrayBuffer() { const b = await this._bytes(); return b.buffer.byteLength === b.byteLength && b.byteOffset === 0 ? b.buffer : b.slice().buffer }
  async bytes() { return (await this._bytes()).slice() }
  async text() { return decodeUtf8(await this._bytes()) }
  async json() { return JSON.parse(await this.text()) }
  async blob() { return new Blob([await this._bytes()], { type: this.headers?.get('content-type') ?? '' }) }
  async formData() { throw new TypeError('formData() not supported') }
}
export class Request extends Body {
  constructor(input, init = {}) { super(); const isReq = input instanceof Request
    this.url = isReq ? input.url : new URL(String(input), baseURL()).href
    this.method = String(init.method ?? (isReq ? input.method : 'GET')).toUpperCase(); this.headers = new Headers(init.headers ?? (isReq ? input.headers : undefined))
    this.mode = init.mode ?? 'cors'; this.credentials = init.credentials ?? 'same-origin'; this.cache = init.cache ?? 'default'; this.redirect = init.redirect ?? 'follow'; this.referrer = 'about:client'; this.integrity = init.integrity ?? ''; this.keepalive = !!init.keepalive; this.signal = init.signal ?? (isReq ? input.signal : null) ?? new AbortController().signal; this.destination = ''
    this._initBody(init.body ?? (isReq ? input._body : null)); if (this._ctype && !this.headers.has('content-type')) this.headers.set('content-type', this._ctype) }
  clone() { return new Request(this, { body: this._body }) }
}
export class Response extends Body {
  constructor(body = null, init = {}) { super(); this.status = init.status ?? 200; this.statusText = init.statusText ?? ''; this.headers = new Headers(init.headers); this.type = init.type ?? 'basic'; this.url = init.url ?? ''; this.redirected = false
    this._initBody(body); if (this._ctype && !this.headers.has('content-type')) this.headers.set('content-type', this._ctype) }
  get ok() { return this.status >= 200 && this.status < 300 }
  clone() { const r = new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); return r }
  static error() { const r = new Response(null, { status: 0, type: 'error' }); return r }
  static json(data, init = {}) { return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } }) }
  static redirect(url, status = 302) { return new Response(null, { status, headers: { location: String(url) } }) }
}
export class FormData {
  constructor() { this._list = [] } append(k, v, fn) { this._list.push([String(k), v instanceof Blob ? v : String(v), fn]) } set(k, v, fn) { this.delete(k); this.append(k, v, fn) } get(k) { const p = this._list.find(p => p[0] === k); return p ? p[1] : null } getAll(k) { return this._list.filter(p => p[0] === k).map(p => p[1]) } has(k) { return this._list.some(p => p[0] === k) } delete(k) { this._list = this._list.filter(p => p[0] !== k) }
  *entries() { for (const [k, v] of this._list) yield [k, v] } [Symbol.iterator]() { return this.entries() } keys() { return [...this.entries()].map(e => e[0])[Symbol.iterator]() } values() { return [...this.entries()].map(e => e[1])[Symbol.iterator]() } forEach(cb, t) { for (const [k, v] of this) cb.call(t, v, k, this) }
  _encode() { const boundary = '----webxrhost' + Math.random().toString(36).slice(2); const parts = []
    for (const [k, v, fn] of this._list) { if (v instanceof Blob) { parts.push(encodeUtf8(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${fn ?? v.name ?? 'blob'}"\r\nContent-Type: ${v.type || 'application/octet-stream'}\r\n\r\n`), v._bytes(), encodeUtf8('\r\n')) } else parts.push(encodeUtf8(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)) }
    parts.push(encodeUtf8(`--${boundary}--\r\n`)); let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length }
    return { bytes: out, type: `multipart/form-data; boundary=${boundary}` } }
}

// Relative URLs resolve against the document (window) or, in a worker, its base URL: a blob:/data: worker
// keeps the page's base, since a blob URL cannot be a base (the MSDF worker loads './fonts/Bungee.ttf').
export const baseURL = () => globalThis.__hostBaseURL ?? globalThis.location?.href ?? 'https://app.local/'
function originOf(url) { try { return new URL(url).origin } catch { return 'null' } }
export function installFetch(g) {
  const n = g.__native
  const same = () => (g.location?.origin ?? n.config?.web?.origin ?? 'https://app.local').replace(/\/$/, '')
  g.fetch = function fetch(input, init = {}) {
    const req = input instanceof Request && !init.body ? input : new Request(input, init)
    return new Promise((resolve, reject) => {
      if (req.signal?.aborted) return reject(abortError())
      const url = req.url
      if (url.startsWith('blob:')) { const obj = lookupObjectURL(url); if (!obj) return reject(new TypeError(`Failed to fetch: ${url}`)); return resolve(new Response(obj, { status: 200, url, headers: { 'content-type': obj.type || 'application/octet-stream', 'content-length': String(obj.size) } })) }
      if (url.startsWith('data:')) { try { const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url); const type = m[1] || 'text/plain;charset=US-ASCII'; const raw = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : encodeUtf8(decodeURIComponent(m[3])); return resolve(new Response(raw, { status: 200, url, headers: { 'content-type': type } })) } catch (e) { return reject(new TypeError(`Failed to fetch data URL`)) } }
      const origin = same()
      if (url.startsWith(origin + '/') || url === origin) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return reject(new TypeError(`Failed to fetch: ${req.method} ${url} (assets are read-only)`))
        const path = url.slice(origin.length + 1).split(/[?#]/)[0]
        const bytes = n.assets.read(path)
        if (bytes == null) { n.log(2, `fetch 404 ${path}`); return resolve(new Response(null, { status: 404, statusText: 'Not Found', url, headers: { 'content-type': 'text/plain' } })) }
        return resolve(new Response(req.method === 'HEAD' ? null : bytes, { status: 200, statusText: 'OK', url, headers: { 'content-type': n.assets.mime(path), 'content-length': String(bytes.byteLength), 'cache-control': 'max-age=31536000' } }))
      }
      const headers = [...req.headers.entries()]
      const send = (body) => n.net.fetch(req.method, url, headers, body, (status, statusText, hdrs, bodyBuf, error) => {
        if (error) { n.log(2, `fetch failed ${url}: ${error}`); return reject(new TypeError(`Failed to fetch: ${error}`)) }
        const r = new Response(status === 204 || status === 304 || req.method === 'HEAD' ? null : bodyBuf, { status, statusText, headers: hdrs, url }); r.type = originOf(url) === origin ? 'basic' : 'cors'; resolve(r)
      })
      if (req._body || req._stream) req._bytes().then(b => send(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), reject); else send(null)
    })
  }
  const abortError = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e }

  class XMLHttpRequestEventTarget extends g.EventTarget {}
  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.statusText = ''; this.responseType = ''; this.response = null; this.responseText = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false; this.upload = new XMLHttpRequestUpload(); this._headers = []; this._resHeaders = new Headers(); this._aborted = false }
    open(method, url) { this._method = String(method).toUpperCase(); this._url = new URL(String(url), baseURL()).href; this.readyState = 1; this.dispatchEvent(new Event('readystatechange')) }
    setRequestHeader(k, v) { this._headers.push([k, v]) }
    getResponseHeader(k) { return this._resHeaders.get(k) } getAllResponseHeaders() { return [...this._resHeaders.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n' }
    overrideMimeType() {}
    abort() { this._aborted = true; this.readyState = 0; this.dispatchEvent(new Event('abort')); this.dispatchEvent(new Event('loadend')) }
    send(body = null) {
      this.dispatchEvent(new ProgressEvent('loadstart'))
      g.fetch(this._url, { method: this._method, headers: this._headers, body }).then(async (res) => {
        if (this._aborted) return
        this.status = res.status; this.statusText = res.statusText; this.responseURL = res.url; this._resHeaders = res.headers; this.readyState = 2; this.dispatchEvent(new Event('readystatechange'))
        const buf = await res.arrayBuffer(); this.readyState = 3; this.dispatchEvent(new Event('readystatechange'))
        switch (this.responseType) { case 'arraybuffer': this.response = buf; break; case 'blob': this.response = new Blob([buf], { type: res.headers.get('content-type') ?? '' }); break; case 'json': try { this.response = JSON.parse(decodeUtf8(new Uint8Array(buf))) } catch { this.response = null } break; case 'document': this.response = null; break; default: this.responseText = decodeUtf8(new Uint8Array(buf)); this.response = this.responseText }
        this.readyState = 4; this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength })); this.dispatchEvent(new ProgressEvent('load')); this.dispatchEvent(new ProgressEvent('loadend'))
      }, () => { if (this._aborted) return; this.readyState = 4; this.status = 0; this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new ProgressEvent('error')); this.dispatchEvent(new ProgressEvent('loadend')) })
    }
    static get UNSENT() { return 0 } static get OPENED() { return 1 } static get HEADERS_RECEIVED() { return 2 } static get LOADING() { return 3 } static get DONE() { return 4 }
  }
  class FileReader extends g.EventTarget {
    constructor() { super(); this.readyState = 0; this.result = null; this.error = null; this.onload = null; this.onloadend = null; this.onerror = null; this.onprogress = null; this.onloadstart = null; this.onabort = null }
    _start(blob, finish) { if (!(blob instanceof Blob)) throw new TypeError('FileReader: not a Blob'); this.readyState = 1; this.dispatchEvent(new ProgressEvent('loadstart'))
      g.setTimeout(() => { if (this.readyState === 2) return; try { this.result = finish(blob._bytes()); this.readyState = 2; this.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: blob.size, total: blob.size })); this.dispatchEvent(new ProgressEvent('load')) } catch (e) { this.error = e; this.readyState = 2; this.dispatchEvent(new ProgressEvent('error')) } this.dispatchEvent(new ProgressEvent('loadend')) }, 0) }
    readAsArrayBuffer(b) { this._start(b, bytes => bytes.slice().buffer) }
    readAsText(b) { this._start(b, bytes => decodeUtf8(bytes)) }
    readAsBinaryString(b) { this._start(b, bytes => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s }) }
    readAsDataURL(b) { this._start(b, bytes => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return `data:${b.type || 'application/octet-stream'};base64,${g.btoa(s)}` }) }
    abort() { this.readyState = 2; this.dispatchEvent(new ProgressEvent('abort')); this.dispatchEvent(new ProgressEvent('loadend')) }
    static get EMPTY() { return 0 } static get LOADING() { return 1 } static get DONE() { return 2 }
  }
  Object.assign(g, { URL, URLSearchParams, Headers, Request, Response, Blob, File, FormData, ReadableStream, WritableStream, TransformStream, TextEncoder, TextDecoder, XMLHttpRequest, XMLHttpRequestEventTarget, XMLHttpRequestUpload, FileReader })
  g.__hostCreateObjectURL = createObjectURL; g.__hostRevokeObjectURL = revokeObjectURL; g.__hostLookupObjectURL = lookupObjectURL; setObjectURLHooks(createObjectURL, revokeObjectURL)
  // WebAssembly.instantiateStreaming / compileStreaming over our Response
  // V8 only exposes the streaming variants when the embedder wires a streaming callback; ours read the whole Response.
  if (g.WebAssembly) {
    g.WebAssembly.compileStreaming = async (src) => g.WebAssembly.compile(await (await src).arrayBuffer())
    g.WebAssembly.instantiateStreaming = async (src, imports) => g.WebAssembly.instantiate(await (await src).arrayBuffer(), imports)
  }
}
export { installFetch as install }
