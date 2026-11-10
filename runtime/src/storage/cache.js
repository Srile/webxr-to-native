// The Cache API (WP-26): caches (CacheStorage) and Cache over __native.storage, in the page and in workers (a service
// worker's global gets it through install(g) as well). One SQLite file per origin (cache.sqlite), apart from the
// IndexedDB files:
//   kv ns 0                the cache list in creation order, the id and sequence counters
//   kv ns 2*id             an entry's request and response (URL, method, request headers, status, headers, type...)
//   kv ns 2*id+1           its body, as bytes
//   ix ns id               (URL without query, sequence): the entries a URL may match, in insertion order
// Each operation is one SQLite transaction and re-reads the list, so caches opened or deleted by another isolate show.
// add and addAll fetch through the runtime's fetch (host.json network.allow applies; same-origin URLs read assets).
import { toKey, succ, EMPTY, MAX, numberKey, unpack } from './keys.js'

export function installCaches(g, S) {
  const { DOMException } = g
  const TOKEN = Symbol('Cache')
  const META = Uint8Array.of(1)
  let h = 0
  const db = () => h || (h = S.open(1, '', true))
  const readMeta = () => S.get(db(), 0, META, false) ?? { caches: [], nextId: 1, nextSeq: 1 }
  const writeMeta = (m) => S.put(h, 0, META, S.serialize(m))
  const dom = (e) => (e?.name === 'QuotaExceededError' || e?.name === 'UnknownError') && !(e instanceof DOMException) ? new DOMException(e.message, e.name) : e
  function txn(write, f) {
    db(); S.begin(h, write)
    try { const r = f(); S.commit(h); return r } catch (e) { try { S.rollback(h) } catch {} throw dom(e) }
  }
  const stripFragment = (u) => { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i) }
  const stripQuery = (u) => { const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i) }
  const varyOf = (headers) => (headers.get('vary') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  function toRequest(input) {
    if (input instanceof g.Request) return input
    return new g.Request(String(input))
  }
  function httpOnly(req) { const p = req.url.slice(0, req.url.indexOf(':') + 1); if (p !== 'http:' && p !== 'https:') throw new TypeError(`Cache: ${req.url} is not an http(s) URL`) }
  const headerOf = (pairs, name) => { for (const [k, v] of pairs) if (k === name) return v; return null }

  // "Request matches cached item": the URL (without its fragment; without the query with ignoreSearch), and every
  // header the cached response varies on equal in both requests (unless ignoreVary).
  function matches(e, url, req, o) {
    let a = e.url, b = url
    if (o.ignoreSearch) { a = stripQuery(a); b = stripQuery(b) }
    if (a !== b) return false
    if (o.ignoreVary || !req) return true
    for (const name of e.vary) {
      if (name === '*') return false
      if (headerOf(e.reqHeaders, name) !== req.headers.get(name)) return false
    }
    return true
  }
  // [sequence key, entry] in insertion order; req undefined: every entry.
  function query(id, req, o = {}) {
    if (req === undefined) {
      const res = S.scan(h, 2 * id, EMPTY, MAX, false, -1, 1), ks = unpack(res[0])
      return ks.map((k, i) => [k.slice(), res[1 + i]])
    }
    if (!o.ignoreMethod && req.method !== 'GET') return []
    const url = stripFragment(req.url), base = toKey(stripQuery(url))
    const res = S.ixScan(h, id, base, succ(base), base, EMPTY, false, -1, 2 * id, 1), ps = unpack(res[1]), out = []
    for (let i = 0; i < ps.length; i++) if (matches(res[2 + i], url, req, o)) out.push([ps[i].slice(), res[2 + i]])
    return out
  }
  const alive = (M, id) => M.caches.some(c => c.id === id)
  function remove(id, seq) { const hi = succ(seq); S.del(h, 2 * id, seq, hi); S.del(h, 2 * id + 1, seq, hi); S.ixDelPk(h, id, seq, hi) }
  function insert(id, M, req, res, vary, body) {
    const seq = numberKey(M.nextSeq++), url = stripFragment(req.url)
    const e = { url, method: req.method, reqHeaders: [...req.headers], status: res.status, statusText: res.statusText, headers: [...res.headers],
      type: res.type ?? 'basic', respUrl: res.url ?? '', redirected: !!res.redirected, hasBody: body !== null, vary }
    S.put(h, 2 * id, seq, S.serialize(e))
    if (body !== null) S.put(h, 2 * id + 1, seq, body)
    S.ixPut(h, id, toKey(stripQuery(url)), seq)
  }
  function toResponse(id, seq, e) {
    const body = e.hasBody ? S.get(h, 2 * id + 1, seq, true) : null
    const r = new g.Response(body ? new Uint8Array(body) : null, { status: e.status, statusText: e.statusText, headers: e.headers, url: e.respUrl, type: e.type })
    r.redirected = e.redirected
    return r
  }
  async function readBody(res) { if (res.body === null) return null; return new Uint8Array(await res.arrayBuffer()) }

  class Cache {
    constructor(t, id, name) { if (t !== TOKEN) throw new TypeError('Illegal constructor'); this._id = id; this._name = name }
    async match(request, options = {}) {
      const req = toRequest(request)
      return txn(false, () => { const hit = alive(readMeta(), this._id) ? query(this._id, req, options)[0] : undefined; return hit ? toResponse(this._id, ...hit) : undefined })
    }
    async matchAll(request, options = {}) {
      const req = request === undefined ? undefined : toRequest(request)
      return txn(false, () => alive(readMeta(), this._id) ? query(this._id, req, options).map(([seq, e]) => toResponse(this._id, seq, e)) : [])
    }
    async keys(request, options = {}) {
      const req = request === undefined ? undefined : toRequest(request)
      const entries = txn(false, () => alive(readMeta(), this._id) ? query(this._id, req, options) : [])
      return entries.map(([, e]) => new g.Request(e.url, { method: e.method, headers: e.reqHeaders }))
    }
    async delete(request, options = {}) {
      const req = toRequest(request)
      return txn(true, () => { if (!alive(readMeta(), this._id)) return false; const hits = query(this._id, req, options); for (const [seq] of hits) remove(this._id, seq); return hits.length > 0 })
    }
    async put(request, response) {
      const req = toRequest(request)
      httpOnly(req)
      if (req.method !== 'GET') throw new TypeError('Cache.put: only GET requests can be stored')
      if (!(response instanceof g.Response)) throw new TypeError('Cache.put: not a Response')
      if (response.status === 206) throw new TypeError('Cache.put: a partial (206) response cannot be stored')
      const vary = varyOf(response.headers)
      if (vary.includes('*')) throw new TypeError('Cache.put: the response varies on *')
      if (response.bodyUsed) throw new TypeError('Cache.put: the response body is already used')
      const body = await readBody(response)
      txn(true, () => {
        const M = readMeta(); if (!alive(M, this._id)) return  // deleted from caches: this object stores nothing more
        for (const [seq] of query(this._id, req)) remove(this._id, seq)
        insert(this._id, M, req, response, vary, body); writeMeta(M)
      })
    }
    async add(request) { return this.addAll([request]) }
    async addAll(requests) {
      const reqs = Array.from(requests, toRequest)
      for (const r of reqs) { httpOnly(r); if (r.method !== 'GET') throw new TypeError('Cache.addAll: only GET requests can be stored') }
      const responses = await Promise.all(reqs.map(r => g.fetch(r)))
      responses.forEach((res, i) => {
        if (!res.ok || res.type === 'error') throw new TypeError(`Cache.addAll: ${reqs[i].url} answered ${res.status}`)
        if (varyOf(res.headers).includes('*')) throw new TypeError(`Cache.addAll: ${reqs[i].url} varies on *`)
      })
      for (let i = 0; i < reqs.length; i++) for (let j = 0; j < i; j++)
        if (stripFragment(reqs[i].url) === stripFragment(reqs[j].url)) throw new DOMException(`Cache.addAll: ${reqs[i].url} is listed twice`, 'InvalidStateError')
      const bodies = await Promise.all(responses.map(readBody))
      txn(true, () => {
        const M = readMeta(); if (!alive(M, this._id)) return
        reqs.forEach((req, i) => {
          for (const [seq] of query(this._id, req)) remove(this._id, seq)
          insert(this._id, M, req, responses[i], varyOf(responses[i].headers), bodies[i])
        })
        writeMeta(M)
      })
    }
    get [Symbol.toStringTag]() { return 'Cache' }
  }

  class CacheStorage {
    constructor(t) { if (t !== TOKEN) throw new TypeError('Illegal constructor') }
    async open(name) {
      name = String(name)
      return txn(true, () => {
        const M = readMeta(); let c = M.caches.find(x => x.name === name)
        if (!c) { c = { name, id: M.nextId++ }; M.caches.push(c); writeMeta(M) }
        return new Cache(TOKEN, c.id, c.name)
      })
    }
    async has(name) { name = String(name); return txn(false, () => readMeta().caches.some(c => c.name === name)) }
    async delete(name) {
      name = String(name)
      return txn(true, () => {
        const M = readMeta(), i = M.caches.findIndex(c => c.name === name); if (i < 0) return false
        const id = M.caches[i].id
        S.del(h, 2 * id, EMPTY, MAX); S.del(h, 2 * id + 1, EMPTY, MAX); S.ixClear(h, id)
        M.caches.splice(i, 1); writeMeta(M)
        return true
      })
    }
    async keys() { return txn(false, () => readMeta().caches.map(c => c.name)) }
    async match(request, options = {}) {
      const list = txn(false, () => readMeta().caches)
      if (options?.cacheName !== undefined) {
        const c = list.find(x => x.name === String(options.cacheName))
        return c ? new Cache(TOKEN, c.id, c.name).match(request, options) : undefined
      }
      for (const c of list) { const r = await new Cache(TOKEN, c.id, c.name).match(request, options); if (r) return r }
      return undefined
    }
    get [Symbol.toStringTag]() { return 'CacheStorage' }
  }

  Object.assign(g, { Cache, CacheStorage })
  g.caches = new CacheStorage(TOKEN)
}
