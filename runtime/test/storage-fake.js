// An in-memory __native.storage for node tests of runtime/src/storage (WP-26): the same operations as
// host/storage/storage_bind.cpp over sorted arrays instead of SQLite, the same byte order (memcmp, then length).
// `files` outlives a sandbox, so a second sandbox over the same files is the app started again. Transactions snapshot
// the file at begin and put it back on rollback. Values are node's V8 serializer output, with Blobs as markers (node's
// Serializer cannot be told which plain objects are host objects). drain() cannot run microtasks from JS: false, so the
// runtime takes its one-event-per-task path; epoch() moves on at each posted task (loop() below) and at the next
// macrotask after it was read.
import v8 from 'node:v8'

export function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}
const u8 = (x) => x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
const copy = (x) => new Uint8Array(u8(x))
function lowerBound(arr, key, cmpEntry) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cmpEntry(arr[m], key) < 0) lo = m + 1; else hi = m } return lo }
function pack(list) { let n = 0; for (const b of list) n += 4 + b.length; const out = new Uint8Array(n), dv = new DataView(out.buffer); let o = 0; for (const b of list) { dv.setUint32(o, b.length, true); out.set(b, o + 4); o += 4 + b.length } return out.buffer }

export function fakeStorage({ indexedDB = true, cache = true, quota = 1 << 30, files = new Map(), origin = 'https_app.local' } = {}) {
  let epoch = 0, armed = false, hooks = null
  const conns = []  // handle - 1 -> { path, refs }
  const file = (path) => { let f = files.get(path); if (!f) files.set(path, f = { kv: new Map(), ix: new Map(), snap: null }); return f }
  const kvOf = (f, ns) => { let a = f.kv.get(ns); if (!a) f.kv.set(ns, a = []); return a }
  const ixOf = (f, ns) => { let a = f.ix.get(ns); if (!a) f.ix.set(ns, a = []); return a }
  const conn = (h) => { const c = conns[h - 1]; if (!c) { const e = new Error('storage: the database is closed'); e.name = 'UnknownError'; throw e } return file(c.path) }
  const usage = () => { let n = 0; for (const [p, f] of files) if (p.startsWith(origin)) for (const m of [f.kv, f.ix]) for (const a of m.values()) for (const e of a) n += e.k.length + (e.v?.length ?? 0) + (e.p?.length ?? 0); return n }
  const full = () => { const e = new Error('storage: over the quota (host.json storage.quotaMB)'); e.name = 'QuotaExceededError'; return e }
  const inRange = (k, lo, hi) => cmpBytes(k, u8(lo)) >= 0 && cmpBytes(k, u8(hi)) < 0
  const stem = (name) => 'd' + Buffer.from(name, 'utf8').toString('hex')

  const BLOB = '__fakeStorageBlob'
  function pre(v, memo) {
    if (typeof v !== 'object' || v === null) return v
    if (memo.has(v)) return memo.get(v)
    if (hooks && hooks.blob.isPrototypeOf(v)) { const file = hooks.file.isPrototypeOf(v), bytes = v._buf, type = v.type, name = file ? v.name : undefined, lastModified = file ? v.lastModified : undefined; const m = { [BLOB]: 1, bytes: copy(bytes), type, name, lastModified }; memo.set(v, m); return m }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date || v instanceof RegExp || v instanceof Error) return v
    if (Array.isArray(v)) { const a = new Array(v.length); memo.set(v, a); for (let i = 0; i < v.length; i++) if (i in v) a[i] = pre(v[i], memo); return a }
    if (v instanceof Map) { const m = new Map(); memo.set(v, m); for (const [k, x] of v) m.set(pre(k, memo), pre(x, memo)); return m }
    if (v instanceof Set) { const s = new Set(); memo.set(v, s); for (const x of v) s.add(pre(x, memo)); return s }
    const o = {}; memo.set(v, o); for (const k of Object.keys(v)) { const x = v[k]; if (typeof x === 'function') throw Object.assign(new Error(`${x} could not be cloned`), { name: 'DataCloneError' }); o[k] = pre(x, memo) }
    return o
  }
  function post(v, memo) {
    if (typeof v !== 'object' || v === null || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date || v instanceof RegExp) return v
    if (memo.has(v)) return memo.get(v)
    if (v[BLOB]) { const file = v.name !== undefined, b = Object.create(file ? hooks.file : hooks.blob); b._buf = v.bytes.slice(); b.type = v.type; if (file) { b.name = v.name; b.lastModified = v.lastModified; b.webkitRelativePath = '' } memo.set(v, b); return b }
    if (Array.isArray(v)) { memo.set(v, v); for (let i = 0; i < v.length; i++) if (i in v) v[i] = post(v[i], memo); return v }
    if (v instanceof Map) { const m = new Map(); memo.set(v, m); for (const [k, x] of v) m.set(post(k, memo), post(x, memo)); return m }
    if (v instanceof Set) { const s = new Set(); memo.set(v, s); for (const x of v) s.add(post(x, memo)); return s }
    memo.set(v, v); for (const k of Object.keys(v)) v[k] = post(v[k], memo); return v
  }
  function serialize(v) {
    if (typeof v === 'function' || typeof v === 'symbol') throw Object.assign(new Error(`${String(v)} could not be cloned`), { name: 'DataCloneError' })
    try { const b = v8.serialize(pre(v, new Map())); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } catch (e) { if (e.name === 'DataCloneError') throw e; throw Object.assign(new Error(e.message), { name: 'DataCloneError' }) }
  }
  const deserialize = (b) => post(v8.deserialize(Buffer.from(u8(b))), new Map())

  const S = {
    features: { indexedDB, cache }, quota,
    files,
    open(kind, name, create) {
      const path = kind === 1 ? `${origin}/cache.sqlite` : kind === 2 ? `${origin}/idb/${name}.sqlite` : `${origin}/idb/${stem(name)}.sqlite`
      const i = conns.findIndex(c => c && c.path === path); if (i >= 0) { conns[i].refs++; return i + 1 }
      if (!create && !files.has(path)) return 0
      file(path)
      let slot = conns.findIndex(c => !c); if (slot < 0) slot = conns.length
      conns[slot] = { path, refs: 1 }; return slot + 1
    },
    close(h) { const c = conns[h - 1]; if (c && --c.refs <= 0) conns[h - 1] = null },
    list() { const out = []; for (const p of files.keys()) { const m = new RegExp(`^${origin}/idb/(.+)\\.sqlite$`).exec(p); if (m) out.push([m[1], m[1][0] === 'd' ? Buffer.from(m[1].slice(1), 'hex').toString('utf8') : null]) } return out },
    drop(name) { const path = `${origin}/idb/${stem(name)}.sqlite`; if (conns.some(c => c && c.path === path)) return false; files.delete(path); return true },
    begin(h) { const f = conn(h); f.snap = { kv: new Map([...f.kv].map(([k, a]) => [k, a.slice()])), ix: new Map([...f.ix].map(([k, a]) => [k, a.slice()])) } },
    commit(h) { conn(h).snap = null },
    rollback(h) { const f = conn(h); if (f.snap) { f.kv = f.snap.kv; f.ix = f.snap.ix; f.snap = null } },
    get(h, ns, key, raw) { const a = kvOf(conn(h), ns), k = u8(key), i = lowerBound(a, k, (e, x) => cmpBytes(e.k, x)); if (i >= a.length || cmpBytes(a[i].k, k) !== 0) return undefined; return raw ? a[i].v.slice().buffer : deserialize(a[i].v) },
    has(h, ns, key) { return S.get(h, ns, key, true) !== undefined },
    put(h, ns, key, bytes) {
      const v = copy(bytes); if (usage() + v.length > quota) throw full()
      const a = kvOf(conn(h), ns), k = copy(key), i = lowerBound(a, k, (e, x) => cmpBytes(e.k, x))
      if (i < a.length && cmpBytes(a[i].k, k) === 0) a[i] = { k, v }; else a.splice(i, 0, { k, v })
    },
    del(h, ns, lo, hi) { const f = conn(h), a = kvOf(f, ns), keep = a.filter(e => !inRange(e.k, lo, hi)); f.kv.set(ns, keep); return a.length - keep.length },
    count(h, ns, lo, hi) { return kvOf(conn(h), ns).filter(e => inRange(e.k, lo, hi)).length },
    scan(h, ns, lo, hi, reverse, limit, mode) {
      let rows = kvOf(conn(h), ns).filter(e => inRange(e.k, lo, hi)); if (reverse) rows = rows.reverse(); if (limit >= 0) rows = rows.slice(0, limit)
      return [pack(rows.map(e => e.k)), ...(mode === 1 ? rows.map(e => deserialize(e.v)) : mode === 2 ? rows.map(e => e.v.slice().buffer) : [])]
    },
    ixPut(h, ns, key, pk) {
      const a = ixOf(conn(h), ns), e = { k: copy(key), p: copy(pk) }, c = (x, y) => cmpBytes(x.k, y.k) || cmpBytes(x.p, y.p), i = lowerBound(a, e, c)
      if (usage() + e.k.length + e.p.length > quota) throw full()
      if (i < a.length && c(a[i], e) === 0) return; a.splice(i, 0, e)
    },
    ixDelPk(h, ns, lo, hi) { const f = conn(h), a = ixOf(f, ns), keep = a.filter(e => !inRange(e.p, lo, hi)); f.ix.set(ns, keep); return a.length - keep.length },
    ixClear(h, ns) { const f = conn(h), n = ixOf(f, ns).length; f.ix.set(ns, []); return n },
    ixOther(h, ns, key, pk) { const k = u8(key), p = u8(pk); return ixOf(conn(h), ns).some(e => cmpBytes(e.k, k) === 0 && cmpBytes(e.p, p) !== 0) },
    ixCount(h, ns, lo, hi) { return ixOf(conn(h), ns).filter(e => inRange(e.k, lo, hi)).length },
    ixScan(h, ns, lo, hi, cK, cP, reverse, limit, storeNs, mode) {
      const f = conn(h), ck = u8(cK), cp = u8(cP)
      let rows = ixOf(f, ns).filter(e => inRange(e.k, lo, hi) && (reverse ? (cmpBytes(e.k, ck) || cmpBytes(e.p, cp)) < 0 : (cmpBytes(e.k, ck) || cmpBytes(e.p, cp)) >= 0))
      if (reverse) rows = rows.reverse(); if (limit >= 0) rows = rows.slice(0, limit)
      const vals = mode === 1 && storeNs >= 0 ? rows.map(e => S.get(h, storeNs, e.p, false)) : []
      return [pack(rows.map(e => e.k)), pack(rows.map(e => e.p)), ...vals]
    },
    serialize, deserialize,
    setBlobHooks(blob, file) { hooks = { blob, file } },
    epoch() { if (!armed) { armed = true; setImmediate(() => { armed = false; epoch++ }) } return epoch },
    bump() { epoch++ },
    drain() { return false },
    usage,
  }
  return S
}

// The loop a sandbox's __native gets: a posted task is a new task (the epoch moves on before it runs).
export function fakeLoop(S) {
  const now0 = performance.now()
  return { now: () => performance.now() - now0, postTask: (cb) => setImmediate(() => { S.bump(); cb() }), setTimer: (ms, rep, cb) => (rep ? setInterval : setTimeout)(cb, ms), clearTimer: (t) => clearTimeout(t), onFrame() {}, exit() {} }
}
