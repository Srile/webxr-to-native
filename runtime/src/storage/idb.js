// IndexedDB (WP-26) over __native.storage: the object model in JS, the records in SQLite (host/storage/kv.h), one file
// per database. Not fake-indexeddb: its storage (records in sorted in-memory trees, schema in Maps, undo closures for
// rollback, transactions run concurrently) would all have to be replaced to persist, which is most of it; here an
// IndexedDB transaction is one SQLite transaction (BEGIN IMMEDIATE for readwrite: abort is ROLLBACK, data and schema).
//
// Scheduling, per database in this isolate: transactions run one at a time in creation order (the spec allows that;
// nothing can wait on a later transaction, since a transaction finishes once its requests drain), and open/delete
// requests wait in the connection queue. A request's operation runs when its turn comes, then its success or error
// event fires, then the microtasks the listeners queued run (__native.storage.drain), with the transaction active, as
// a browser runs them at the end of the listener's task: promise wrappers (idb, idb-keyval) chain requests there.
// A transaction is active from its creation to the end of that task: __native.storage.epoch() moves on when a
// microtask checkpoint completes. One run of the scheduler handles events back to back for up to 4 ms, then yields.
//
// Records: kv (ns = the store's id, key = keys.js encoding, value = V8's structured clone, Blobs kept);
// index entries: ix (ns = the index's id, key, primary key); the schema: kv ns 0 (name, version, stores, indexes, key
// generators). Across isolates (a worker on the same database) data is shared through the file; versionchange and
// blocked are delivered within an isolate only.
import { toKey, toMultiKeys, fromKey, cmp, succ, maxOf, minOf, EMPTY, MAX, numberKey, isNumberKey, validKeyPath, normKeyPath, evaluate, FAIL, canInject, inject, unpack } from './keys.js'

export function installIndexedDB(g, S) {
  const { DOMException, Event, EventTarget } = g
  const N = g.__native
  const post = N.loop.postTask, now = N.loop.now
  const TOKEN = Symbol('IndexedDB')
  const META = Uint8Array.of(1)  // kv ns 0: the schema record
  const BUDGET = 4               // ms of events per scheduler run before yielding to the frame
  const err = (name, msg) => new DOMException(msg ?? name, name)
  const illegal = (t) => { if (t !== TOKEN) throw new TypeError('Illegal constructor') }
  const DIRS = ['next', 'nextunique', 'prev', 'prevunique']
  const NATIVE_NAMES = new Set(['DataCloneError', 'QuotaExceededError', 'UnknownError', 'ConstraintError', 'DataError', 'InvalidStateError', 'NotFoundError', 'ReadOnlyError', 'TransactionInactiveError', 'AbortError', 'VersionError', 'InvalidAccessError', 'SyntaxError'])
  const toDom = (e) => e instanceof DOMException ? e : err(NATIVE_NAMES.has(e?.name) ? e.name : 'UnknownError', String(e?.message ?? e))
  const report = (e) => { if (g.reportError) g.reportError(e); else g.console?.error?.('Uncaught (in IndexedDB event handler)', e) }

  class DOMStringList {
    constructor(arr) { this._a = arr; for (let i = 0; i < arr.length; i++) this[i] = arr[i] }
    get length() { return this._a.length }
    item(i) { return this._a[i] ?? null }
    contains(s) { return this._a.includes(String(s)) }
    [Symbol.iterator]() { return this._a[Symbol.iterator]() }
  }
  const List = g.DOMStringList ?? DOMStringList

  // --------------------------------------------------------------------------------------------------- events
  // request -> transaction -> database, capture then bubble; true when a listener threw (the spec then aborts).
  function fire(target, ev, path) {
    try { ev.isTrusted = true } catch {}
    ev.target = target; const chain = [target, ...path]; ev._path = chain
    let threw = false
    const invoke = (t, phase) => {
      ev.currentTarget = t; ev.eventPhase = phase
      const list = t._listeners?.get(ev.type)
      if (list && list.length) for (const l of [...list]) {
        if (ev._stopNow) break
        if (phase === 1 && !l.capture) continue
        if (phase === 3 && l.capture) continue
        if (l.once) t.removeEventListener(ev.type, l.cb, l.capture)
        try { typeof l.cb === 'function' ? l.cb.call(t, ev) : l.cb.handleEvent?.(ev) } catch (e) { threw = true; report(e) }
      }
      if (phase !== 1 && !ev._stopNow) { const h = t['on' + ev.type]; if (typeof h === 'function') { try { h.call(t, ev) } catch (e) { threw = true; report(e) } } }
    }
    for (let i = chain.length - 1; i > 0 && !ev._stop; i--) invoke(chain[i], 1)
    if (!ev._stop) invoke(target, 2)
    if (ev.bubbles) for (let i = 1; i < chain.length && !ev._stop; i++) invoke(chain[i], 3)
    ev.currentTarget = null; ev.eventPhase = 0
    return threw
  }
  class IDBVersionChangeEvent extends Event {
    constructor(type, init = {}) { super(type, init); this._old = init.oldVersion ?? 0; this._new = init.newVersion ?? null }
    get oldVersion() { return this._old }
    get newVersion() { return this._new }
  }

  // --------------------------------------------------------------------------------------------------- databases
  const dbs = new Map()  // name -> the database's state in this isolate
  const state = (name) => { let d = dbs.get(name); if (!d) dbs.set(name, d = { name, h: 0, schema: null, conns: new Set(), txs: [], running: null, jobs: [] }); return d }
  function readSchema(d) {
    const o = S.get(d.h, 0, META, false)
    const s = { version: o?.version ?? 0, nextId: o?.nextId ?? 1, stores: new Map() }
    for (const m of o?.stores ?? []) s.stores.set(m.id, { id: m.id, name: m.name, keyPath: m.keyPath, autoIncrement: m.autoIncrement, current: m.current, indexes: new Map((m.indexes ?? []).map(i => [i.id, { ...i }])) })
    return s
  }
  function saveSchema(d) {
    const s = d.schema
    S.put(d.h, 0, META, S.serialize({ name: d.name, version: s.version, nextId: s.nextId, stores: [...s.stores.values()].map(m => ({ id: m.id, name: m.name, keyPath: m.keyPath, autoIncrement: m.autoIncrement, current: m.current, indexes: [...m.indexes.values()].map(i => ({ ...i })) })) }))
  }
  // After a rollback: the schema as committed (ids are never handed out twice in this isolate).
  function reloadSchema(d) { const next = d.schema?.nextId ?? 1; d.schema = readSchema(d); d.schema.nextId = Math.max(d.schema.nextId, next) }
  function ensureOpen(d, create) {
    if (d.h) return true
    const h = S.open(0, d.name, create)
    if (!h) { d.schema = { version: 0, nextId: 1, stores: new Map() }; return false }
    d.h = h; d.schema = readSchema(d); return true
  }
  const storeNamed = (d, name) => { for (const m of d.schema.stores.values()) if (m.name === name) return m; return null }
  const storeNames = (d) => [...d.schema.stores.values()].map(m => m.name).sort()

  // --------------------------------------------------------------------------------------------------- scheduler
  const pending = new Set(); let posted = false, yieldNow = false
  function kick(d) { pending.add(d); if (!posted) { posted = true; post(run) } }
  function afterDispatch() { if (!S.drain()) yieldNow = true }  // inside a microtask checkpoint: the rest waits for the next task
  function run() {
    const t0 = now(); yieldNow = false
    try {
      while (pending.size && !yieldNow) {
        for (const d of [...pending]) {
          if (!step(d)) pending.delete(d)
          if (yieldNow || now() - t0 > BUDGET) { yieldNow = true; break }
        }
      }
    } finally {
      posted = false
      if (pending.size) { posted = true; post(run) }
    }
  }
  // One unit of work for a database; false when it has nothing to do (or waits for a connection to close).
  function step(d) {
    if (d.running) return stepTx(d, d.running)
    if (d.txs.length) { startTx(d, d.txs.shift()); return true }
    if (d.jobs.length) return d.jobs[0].kind === 'open' ? stepOpen(d, d.jobs[0]) : stepDelete(d, d.jobs[0])
    release(d)
    return false
  }
  function release(d) {  // idle with no connection: the file closed (a database whose creation was aborted removed)
    if (d.conns.size || d.jobs.length || d.txs.length || d.running) return
    if (d.h) { const gone = d.schema?.version === 0; S.close(d.h); d.h = 0; if (gone) S.drop(d.name) }
    dbs.delete(d.name)
  }

  // --------------------------------------------------------------------------------------------------- transactions
  function startTx(d, tx) {
    d.running = tx; tx._started = true
    if (tx._state === 'finished') return  // aborted while it waited: its events follow
    try { S.begin(d.h, tx._mode !== 'readonly'); tx._began = true } catch (e) { abortTx(tx, 'UnknownError', toDom(e)) }
  }
  function stepTx(d, tx) {
    if (tx._events.length) { tx._events.shift()(); afterDispatch(); return true }
    if (tx._state === 'finished') { finishTx(d, tx); return true }
    if (tx._reqs.length) { execRequest(tx, tx._reqs.shift()); return true }
    if (tx._now() === 'active') {  // the task that made it is still running (a nested checkpoint): look again next task
      if (++tx._waits > 2) tx._state = 'inactive'
      yieldNow = true; return true
    }
    commitTx(d, tx); return true
  }
  function execRequest(tx, { r, op, internal }) {
    if (internal) { try { op() } catch (e) { abortTx(tx, toDom(e).name, toDom(e)) } return }
    let result, error = null
    try { result = op() } catch (e) { error = toDom(e) }
    r._ready = 'done'
    if (error) { r._error = error; r._result = undefined } else { r._result = result; r._error = null }
    if (tx._now() === 'inactive') { tx._state = 'active'; tx._epoch = S.epoch() }
    const ev = new Event(error ? 'error' : 'success', { bubbles: !!error, cancelable: !!error })
    const threw = fire(r, ev, [tx, tx._db])
    afterDispatch()
    if (tx._state === 'finished') return  // a listener aborted it
    if (threw) abortTx(tx, 'AbortError')
    else if (error && !ev.defaultPrevented) abortTx(tx, error.name, error)
  }
  function commitTx(d, tx) {
    try {
      if (tx._schemaDirty) saveSchema(d)
      if (tx._began) { S.commit(d.h); tx._began = false }
    } catch (e) { const x = toDom(e); abortTx(tx, x.name === 'QuotaExceededError' ? x.name : 'UnknownError', x); return }
    tx._state = 'finished'
    tx._events.push(() => fire(tx, new Event('complete'), [tx._db]))
    if (tx._mode === 'versionchange') tx._events.push(() => upgradeDone(d, tx, true))
  }
  // Aborts at once (ROLLBACK, the schema re-read); the events follow as tasks: an AbortError at each request that had
  // not run, then abort at the transaction (bubbling to the database), then for an upgrade the open request's error.
  function abortTx(tx, name, error) {
    if (tx._state === 'finished') return
    const d = tx._d
    if (tx._began) { try { S.rollback(d.h) } catch {} tx._began = false }
    if (d.h && (tx._mode !== 'readonly')) reloadSchema(d)
    tx._error = name ? (error ?? err(name)) : null
    tx._state = 'finished'; tx._aborted = true
    if (tx._mode === 'versionchange') tx._db._version = d.schema.version
    const reqs = tx._reqs; tx._reqs = []
    for (const { r, internal } of reqs) if (!internal) tx._events.push(() => {
      r._ready = 'done'; r._result = undefined; r._error = err('AbortError', 'The transaction was aborted')
      fire(r, new Event('error', { bubbles: true, cancelable: true }), [tx, tx._db])
    })
    tx._events.push(() => fire(tx, new Event('abort', { bubbles: true }), [tx._db]))
    if (tx._mode === 'versionchange') tx._events.push(() => upgradeDone(d, tx, false))
    kick(d)
  }
  function finishTx(d, tx) {
    if (d.running === tx) d.running = null
    const i = d.txs.indexOf(tx); if (i >= 0) d.txs.splice(i, 1)
    const c = tx._db; c._txs.delete(tx)
    if (c._closePending && !c._txs.size) closed(c)
  }
  function closed(c) { if (c._closed) return; c._names = c._d.schema ? storeNames(c._d) : []; c._closed = true; c._d.conns.delete(c); kick(c._d) }
  function request(tx, source, op) {
    const r = new IDBRequest(TOKEN, source, tx)
    tx._reqs.push({ r, op }); kick(tx._d)
    return r
  }

  // --------------------------------------------------------------------------------------------------- open / delete
  function finishJob(d, job, ev, error, result) {
    const r = job.request; r._ready = 'done'; r._result = result; r._error = error
    d.jobs.shift()
    fire(r, ev, []); afterDispatch()
    return true
  }
  const failJob = (d, job, e) => { if (job.conn) { job.conn._closePending = true; closed(job.conn) } return finishJob(d, job, new Event('error', { bubbles: true, cancelable: true }), e, undefined) }
  // The other connections get versionchange; blocked fires when any of them stays open.
  function versionchange(d, job, newVersion) {
    const others = [...d.conns].filter(c => c !== job.conn && !c._closed)
    for (const c of others) if (!c._closePending) { fire(c, new IDBVersionChangeEvent('versionchange', { oldVersion: job.old, newVersion }), []); afterDispatch() }
    if (others.some(c => !c._closePending)) { fire(job.request, new IDBVersionChangeEvent('blocked', { oldVersion: job.old, newVersion }), []); afterDispatch() }
  }
  const othersOpen = (d, job) => [...d.conns].some(c => c !== job.conn && !c._closed)
  function stepOpen(d, job) {
    if (job.stage === 0) {
      try { ensureOpen(d, true) } catch (e) { return failJob(d, job, toDom(e)) }
      const cur = d.schema.version, v = job.version ?? (cur || 1)
      if (cur > v) return failJob(d, job, err('VersionError', `the database is at version ${cur}, above the requested ${v}`))
      job.conn = new IDBDatabase(TOKEN, d, cur); d.conns.add(job.conn)
      if (cur === v) return finishJob(d, job, new Event('success'), null, job.conn)
      job.old = cur; job.v = v; job.stage = 1
      versionchange(d, job, v); job.stage = 2
      return true
    }
    if (job.stage === 2) {
      if (othersOpen(d, job)) return false  // closed() kicks again
      startUpgrade(d, job); job.stage = 3
      return true
    }
    return false  // stage 3: the upgrade transaction runs; upgradeDone ends the job
  }
  function startUpgrade(d, job) {
    const conn = job.conn, r = job.request
    const tx = new IDBTransaction(TOKEN, conn, null, 'versionchange', 'default')
    tx._openRequest = r; conn._upgradeTx = tx; conn._txs.add(tx)
    d.running = tx; tx._started = true
    try { S.begin(d.h, true); tx._began = true } catch (e) { abortTx(tx, 'UnknownError', toDom(e)); return }
    d.schema.version = job.v; tx._schemaDirty = true; conn._version = job.v
    r._ready = 'done'; r._result = conn; r._error = null; r._tx = tx
    tx._state = 'active'; tx._epoch = S.epoch()
    const threw = fire(r, new IDBVersionChangeEvent('upgradeneeded', { oldVersion: job.old, newVersion: job.v }), [])
    afterDispatch()
    if (threw && tx._state !== 'finished') abortTx(tx, 'AbortError')
  }
  function upgradeDone(d, tx, ok) {
    const job = d.jobs[0], conn = tx._db, r = tx._openRequest
    r._tx = null; conn._upgradeTx = null
    if (!ok || conn._closePending) {
      conn._closePending = true  // closed once the upgrade transaction is done with (finishTx)
      job.conn = null
      finishJob(d, job, new Event('error', { bubbles: true, cancelable: true }), err('AbortError', ok ? 'The connection was closed during the upgrade' : 'The upgrade transaction was aborted'), undefined)
      return
    }
    finishJob(d, job, new Event('success'), null, conn)
  }
  function stepDelete(d, job) {
    if (job.stage === 0) {
      try { ensureOpen(d, false) } catch (e) { return finishJob(d, job, new Event('error', { bubbles: true, cancelable: true }), toDom(e), undefined) }
      job.old = d.schema.version
      versionchange(d, job, null); job.stage = 1
      return true
    }
    if (othersOpen(d, job)) return false
    if (d.h) { S.close(d.h); d.h = 0 }
    d.schema = null
    if (!S.drop(d.name)) return finishJob(d, job, new Event('error', { bubbles: true, cancelable: true }), err('UnknownError', 'the database is still open'), undefined)
    return finishJob(d, job, new IDBVersionChangeEvent('success', { oldVersion: job.old, newVersion: null }), null, undefined)
  }

  // --------------------------------------------------------------------------------------------------- records
  function cloneValue(tx, value) {
    const prev = tx._state; tx._state = 'inactive'  // getters the clone runs see an inactive transaction
    try { return S.serialize(value) } catch (e) { throw e?.name === 'DataCloneError' && !(e instanceof DOMException) ? err('DataCloneError', e.message) : e } finally { if (tx._state === 'inactive') tx._state = prev }
  }
  function indexKeys(value, ix) {
    const v = evaluate(value, ix.keyPath, g)
    if (v === FAIL) return []
    if (ix.multiEntry) return toMultiKeys(v)
    const k = toKey(v); return k ? [k] : []
  }
  const liveStore = (d, id) => { const m = d.schema?.stores.get(id); if (!m) throw err('InvalidStateError', 'The object store has been deleted'); return m }
  // "Store a record into an object store": every check before any write, so a ConstraintError leaves nothing behind.
  function storeRecord(tx, id, k, bytes, clone, noOverwrite) {
    const d = tx._d, m = liveStore(d, id)
    let next
    if (m.autoIncrement) {
      if (k === null) {
        if (m.current > 2 ** 53) throw err('ConstraintError', 'The key generator is exhausted')
        k = numberKey(m.current); next = m.current + 1
        if (m.keyPath !== null) { clone = clone ?? S.deserialize(bytes); inject(clone, m.keyPath, m.current); bytes = S.serialize(clone) }
      } else if (isNumberKey(k)) { const n = fromKey(k); if (n >= m.current) next = Math.floor(Math.min(n, 2 ** 53)) + 1 }
    }
    if (noOverwrite && S.has(d.h, id, k)) throw err('ConstraintError', 'A record with this key already exists')
    const entries = []
    for (const ix of m.indexes.values()) {
      clone = clone ?? S.deserialize(bytes)
      const keys = indexKeys(clone, ix)
      if (ix.unique) for (const ik of keys) if (S.ixOther(d.h, ix.id, ik, k)) throw err('ConstraintError', `Index '${ix.name}' is unique and holds this key already`)
      entries.push([ix.id, keys])
    }
    if (entries.length) { const hi = succ(k); for (const [ixId] of entries) S.ixDelPk(d.h, ixId, k, hi) }
    S.put(d.h, id, k, bytes)
    for (const [ixId, keys] of entries) for (const ik of keys) S.ixPut(d.h, ixId, ik, k)
    if (next !== undefined) { m.current = next; tx._schemaDirty = true }
    return fromKey(k)
  }
  function deleteRange(d, m, lo, hi) { for (const ix of m.indexes.values()) S.ixDelPk(d.h, ix.id, lo, hi); S.del(d.h, m.id, lo, hi) }

  // --------------------------------------------------------------------------------------------------- key ranges
  class IDBKeyRange {
    constructor(t, lo, hi, lop, hop) { illegal(t); this._lo = lo; this._hi = hi; this._lop = lop; this._hop = hop }
    get lower() { return this._lo ? fromKey(this._lo) : undefined }
    get upper() { return this._hi ? fromKey(this._hi) : undefined }
    get lowerOpen() { return this._lop }
    get upperOpen() { return this._hop }
    includes(key) {
      const k = toKey(key); if (!k) throw err('DataError', 'Not a valid key')
      if (this._lo) { const c = cmp(k, this._lo); if (c < 0 || (c === 0 && this._lop)) return false }
      if (this._hi) { const c = cmp(k, this._hi); if (c > 0 || (c === 0 && this._hop)) return false }
      return true
    }
    static only(v) { const k = keyOrThrow(v); return new IDBKeyRange(TOKEN, k, k, false, false) }
    static lowerBound(v, open = false) { return new IDBKeyRange(TOKEN, keyOrThrow(v), null, !!open, true) }
    static upperBound(v, open = false) { return new IDBKeyRange(TOKEN, null, keyOrThrow(v), true, !!open) }
    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
      const a = keyOrThrow(lower), b = keyOrThrow(upper), c = cmp(a, b)
      if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) throw err('DataError', 'The lower bound is above the upper bound')
      return new IDBKeyRange(TOKEN, a, b, !!lowerOpen, !!upperOpen)
    }
    get [Symbol.toStringTag]() { return 'IDBKeyRange' }
  }
  function keyOrThrow(v) { const k = toKey(v); if (!k) throw err('DataError', 'Not a valid key'); return k }
  // A query as bytes: [lo, hi) and, for a single key, the key itself (a direct lookup).
  function toRange(q, nullDisallowed) {
    if (q instanceof IDBKeyRange) {
      const only = q._lo && q._hi && !q._lop && !q._hop && cmp(q._lo, q._hi) === 0 ? q._lo : null
      return { lo: q._lo ? (q._lop ? succ(q._lo) : q._lo) : EMPTY, hi: q._hi ? (q._hop ? q._hi : succ(q._hi)) : MAX, only }
    }
    if (q === undefined || q === null) { if (nullDisallowed) throw err('DataError', 'A key or key range is required'); return { lo: EMPTY, hi: MAX, only: null } }
    const k = keyOrThrow(q); return { lo: k, hi: succ(k), only: k }
  }
  function countArg(c) {
    if (c === undefined) return -1
    const n = Number(c); if (!Number.isFinite(n) || n < 0 || n > 0xFFFFFFFF) throw new TypeError('count is out of range')
    return Math.trunc(n) || -1
  }
  function dirArg(dir) { if (dir === undefined) return 'next'; dir = String(dir); if (!DIRS.includes(dir)) throw new TypeError(`'${dir}' is not a valid cursor direction`); return dir }

  // --------------------------------------------------------------------------------------------------- requests
  class IDBRequest extends EventTarget {
    constructor(t, source, tx) { illegal(t); super(); this._source = source; this._tx = tx; this._ready = 'pending'; this._result = undefined; this._error = null; this.onsuccess = null; this.onerror = null }
    get result() { if (this._ready !== 'done') throw err('InvalidStateError', 'The request has not finished'); return this._result }
    get error() { if (this._ready !== 'done') throw err('InvalidStateError', 'The request has not finished'); return this._error }
    get source() { return this._source }
    get transaction() { return this._tx }
    get readyState() { return this._ready }
    get [Symbol.toStringTag]() { return 'IDBRequest' }
  }
  class IDBOpenDBRequest extends IDBRequest {
    constructor(t) { super(t, null, null); this.onblocked = null; this.onupgradeneeded = null }
    get [Symbol.toStringTag]() { return 'IDBOpenDBRequest' }
  }

  // --------------------------------------------------------------------------------------------------- IDBDatabase
  class IDBDatabase extends EventTarget {
    constructor(t, d, version) {
      illegal(t); super(); this._d = d; this._version = version; this._closePending = false; this._closed = false; this._upgradeTx = null; this._txs = new Set(); this._names = null
      this.onabort = null; this.onclose = null; this.onerror = null; this.onversionchange = null
    }
    get name() { return this._d.name }
    get version() { return this._version }
    get objectStoreNames() { return new List(this._closed ? this._names : storeNames(this._d)) }
    _upgrade() {
      const tx = this._upgradeTx
      if (!tx || tx._state === 'finished') throw err('InvalidStateError', 'Not in a versionchange transaction')
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The versionchange transaction is not active')
      return tx
    }
    createObjectStore(name, options = {}) {
      if (arguments.length < 1) throw new TypeError('createObjectStore: a name is required')
      const tx = this._upgrade(), d = this._d
      name = String(name)
      const keyPath = normKeyPath(options?.keyPath), autoIncrement = !!options?.autoIncrement
      if (keyPath !== null && !validKeyPath(keyPath)) throw err('SyntaxError', 'Not a valid key path')
      if (storeNamed(d, name)) throw err('ConstraintError', `An object store named '${name}' exists`)
      if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) throw err('InvalidAccessError', 'autoIncrement needs a non-empty string key path or none')
      const m = { id: d.schema.nextId++, name, keyPath, autoIncrement, current: 1, indexes: new Map() }
      d.schema.stores.set(m.id, m); tx._schemaDirty = true
      return tx.objectStore(name)
    }
    deleteObjectStore(name) {
      if (arguments.length < 1) throw new TypeError('deleteObjectStore: a name is required')
      const tx = this._upgrade(), d = this._d
      const m = storeNamed(d, String(name)); if (!m) throw err('NotFoundError', `No object store named '${name}'`)
      for (const ix of m.indexes.values()) S.ixClear(d.h, ix.id)
      S.del(d.h, m.id, EMPTY, MAX)
      d.schema.stores.delete(m.id); tx._schemaDirty = true
    }
    transaction(storeNames, mode = 'readonly', options) {
      if (arguments.length < 1) throw new TypeError('transaction: store names are required')
      if (this._upgradeTx && this._upgradeTx._state !== 'finished') throw err('InvalidStateError', 'A versionchange transaction is running')
      if (this._closePending) throw err('InvalidStateError', 'The connection is closing')
      const d = this._d
      const names = [...new Set(typeof storeNames === 'string' || typeof storeNames !== 'object' || storeNames === null || !(Symbol.iterator in storeNames) ? [String(storeNames)] : Array.from(storeNames, String))].sort()
      for (const n of names) if (!storeNamed(d, n)) throw err('NotFoundError', `No object store named '${n}'`)
      if (!names.length) throw err('InvalidAccessError', 'The scope is empty')
      if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`'${mode}' is not a valid transaction mode`)
      const durability = options?.durability ?? 'default'
      if (!['default', 'strict', 'relaxed'].includes(durability)) throw new TypeError(`'${durability}' is not a valid durability`)
      const tx = new IDBTransaction(TOKEN, this, names, mode, durability)
      this._txs.add(tx); d.txs.push(tx); kick(d)
      return tx
    }
    close() { this._closePending = true; if (!this._txs.size) closed(this) }
    get [Symbol.toStringTag]() { return 'IDBDatabase' }
  }

  // --------------------------------------------------------------------------------------------------- IDBTransaction
  class IDBTransaction extends EventTarget {
    constructor(t, db, names, mode, durability) {
      illegal(t); super(); this._db = db; this._d = db._d; this._names = names; this._mode = mode; this._durability = durability
      this._state = 'active'; this._epoch = S.epoch(); this._waits = 0
      this._reqs = []; this._events = []; this._stores = new Map(); this._began = false; this._started = false
      this._error = null; this._aborted = false; this._schemaDirty = false; this._openRequest = null
      this.onabort = null; this.oncomplete = null; this.onerror = null
    }
    _now() { if (this._state === 'active' && this._epoch !== S.epoch()) this._state = 'inactive'; return this._state }
    get db() { return this._db }
    get mode() { return this._mode }
    get durability() { return this._durability }
    get error() { return this._error }
    get objectStoreNames() { return new List(this._names ?? storeNames(this._d)) }
    objectStore(name) {
      if (this._state === 'finished') throw err('InvalidStateError', 'The transaction has finished')
      name = String(name)
      const m = (this._names === null || this._names.includes(name)) ? storeNamed(this._d, name) : null
      if (!m) throw err('NotFoundError', `No object store named '${name}' in this transaction`)
      let s = this._stores.get(m.id); if (!s) this._stores.set(m.id, s = new IDBObjectStore(TOKEN, this, m.id))
      return s
    }
    abort() {
      const s = this._now(); if (s === 'committing' || s === 'finished') throw err('InvalidStateError', 'The transaction has finished')
      abortTx(this, null)
    }
    commit() {
      if (this._now() !== 'active') throw err('InvalidStateError', 'The transaction is not active')
      this._state = 'committing'; kick(this._d)
    }
    get [Symbol.toStringTag]() { return 'IDBTransaction' }
  }

  // --------------------------------------------------------------------------------------------------- IDBObjectStore
  class IDBObjectStore {
    constructor(t, tx, id) { illegal(t); this._tx = tx; this._id = id; this._name = tx._d.schema.stores.get(id).name; this._kp = undefined; this._ixs = new Map(); this._last = tx._d.schema.stores.get(id) }
    _m() { const m = this._tx._d.schema?.stores.get(this._id); if (m) { this._name = m.name; this._last = m } return m }
    get name() { this._m(); return this._name }
    set name(v) {
      v = String(v); const tx = this._tx, m = this._m()
      if (tx._mode !== 'versionchange' || !m) throw err('InvalidStateError', 'Stores are renamed in a versionchange transaction')
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (m.name === v) return
      if (storeNamed(tx._d, v)) throw err('ConstraintError', `An object store named '${v}' exists`)
      m.name = v; this._name = v; tx._schemaDirty = true
    }
    get keyPath() { const kp = this._last.keyPath; if (!Array.isArray(kp)) return kp; return this._kp ??= [...kp] }
    get indexNames() { const m = this._m() ?? this._last; return new List([...m.indexes.values()].map(i => i.name).sort()) }
    get transaction() { return this._tx }
    get autoIncrement() { return this._last.autoIncrement }
    _check(write) {
      const m = this._m(); if (!m) throw err('InvalidStateError', 'The object store has been deleted')
      if (this._tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (write && this._tx._mode === 'readonly') throw err('ReadOnlyError', 'The transaction is read-only')
      return m
    }
    put(value, key) { return this._put(value, key, false, arguments.length) }
    add(value, key) { return this._put(value, key, true, arguments.length) }
    _put(value, key, noOverwrite, argc) {
      if (argc < 1) throw new TypeError('a value is required')
      const m = this._check(true), tx = this._tx
      if (m.keyPath !== null && key !== undefined) throw err('DataError', 'The object store uses in-line keys and the key parameter was provided')
      if (m.keyPath === null && !m.autoIncrement && key === undefined) throw err('DataError', 'The object store uses out-of-line keys and has no key generator and the key parameter was not provided')
      let k = null
      if (key !== undefined) k = keyOrThrow(key)
      const bytes = cloneValue(tx, value)
      let clone
      if (m.keyPath !== null || m.indexes.size) clone = S.deserialize(bytes)
      if (m.keyPath !== null) {
        const v = evaluate(clone, m.keyPath, g)
        if (v !== FAIL) { k = toKey(v); if (!k) throw err('DataError', 'The key path yields no valid key') }
        else if (!m.autoIncrement) throw err('DataError', 'The key path yields no key and there is no key generator')
        else if (!canInject(clone, m.keyPath)) throw err('DataError', 'A generated key could not be injected into the value')
      }
      const id = this._id
      return request(tx, this, () => storeRecord(tx, id, k, bytes, clone, noOverwrite))
    }
    delete(query) {
      if (arguments.length < 1) throw new TypeError('a key or key range is required')
      this._check(true); const r = toRange(query, true), d = this._tx._d, id = this._id
      return request(this._tx, this, () => { deleteRange(d, liveStore(d, id), r.lo, r.hi); return undefined })
    }
    clear() {
      this._check(true); const d = this._tx._d, id = this._id
      return request(this._tx, this, () => { const m = liveStore(d, id); for (const ix of m.indexes.values()) S.ixClear(d.h, ix.id); S.del(d.h, id, EMPTY, MAX); return undefined })
    }
    get(query) {
      if (arguments.length < 1) throw new TypeError('a key or key range is required')
      this._check(false); const r = toRange(query, true), d = this._tx._d, id = this._id
      return request(this._tx, this, () => {
        liveStore(d, id)
        if (r.only) return S.get(d.h, id, r.only, false)
        const res = S.scan(d.h, id, r.lo, r.hi, false, 1, 1); return res.length > 1 ? res[1] : undefined
      })
    }
    getKey(query) {
      if (arguments.length < 1) throw new TypeError('a key or key range is required')
      this._check(false); const r = toRange(query, true), d = this._tx._d, id = this._id
      return request(this._tx, this, () => { liveStore(d, id); const k = unpack(S.scan(d.h, id, r.lo, r.hi, false, 1, 0)[0])[0]; return k ? fromKey(k) : undefined })
    }
    getAll(query, count) {
      this._check(false); const r = toRange(query, false), n = countArg(count), d = this._tx._d, id = this._id
      return request(this._tx, this, () => { liveStore(d, id); return S.scan(d.h, id, r.lo, r.hi, false, n, 1).slice(1) })
    }
    getAllKeys(query, count) {
      this._check(false); const r = toRange(query, false), n = countArg(count), d = this._tx._d, id = this._id
      return request(this._tx, this, () => { liveStore(d, id); return unpack(S.scan(d.h, id, r.lo, r.hi, false, n, 0)[0]).map(fromKey) })
    }
    count(query) {
      this._check(false); const r = toRange(query, false), d = this._tx._d, id = this._id
      return request(this._tx, this, () => { liveStore(d, id); return S.count(d.h, id, r.lo, r.hi) })
    }
    openCursor(query, direction) { return this._cursor(query, direction, false) }
    openKeyCursor(query, direction) { return this._cursor(query, direction, true) }
    _cursor(query, direction, keyOnly) {
      this._check(false); const r = toRange(query, false), dir = dirArg(direction)
      const c = new (keyOnly ? IDBCursor : IDBCursorWithValue)(TOKEN, this, this, null, dir, r, keyOnly)
      const req = request(this._tx, this, () => iterate(c, 1, null, null)); c._req = req
      return req
    }
    index(name) {
      if (!this._m()) throw err('InvalidStateError', 'The object store has been deleted')
      if (this._tx._state === 'finished') throw err('InvalidStateError', 'The transaction has finished')
      name = String(name)
      const ix = [...this._m().indexes.values()].find(i => i.name === name)
      if (!ix) throw err('NotFoundError', `No index named '${name}'`)
      let h = this._ixs.get(ix.id); if (!h) this._ixs.set(ix.id, h = new IDBIndex(TOKEN, this, ix.id))
      return h
    }
    createIndex(name, keyPath, options = {}) {
      if (arguments.length < 2) throw new TypeError('createIndex: a name and a key path are required')
      const tx = this._tx, d = tx._d
      if (tx._mode !== 'versionchange') throw err('InvalidStateError', 'Indexes are created in a versionchange transaction')
      const m = this._m(); if (!m) throw err('InvalidStateError', 'The object store has been deleted')
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      name = String(name)
      if ([...m.indexes.values()].some(i => i.name === name)) throw err('ConstraintError', `An index named '${name}' exists`)
      keyPath = normKeyPath(keyPath)
      if (!validKeyPath(keyPath)) throw err('SyntaxError', 'Not a valid key path')
      const unique = !!options?.unique, multiEntry = !!options?.multiEntry
      if (Array.isArray(keyPath) && multiEntry) throw err('InvalidAccessError', 'multiEntry with an array key path')
      const ix = { id: d.schema.nextId++, name, keyPath, unique, multiEntry }
      m.indexes.set(ix.id, ix); tx._schemaDirty = true
      // The records the store holds now; a unique index they break aborts the upgrade (a task later, as the spec has it).
      let lo = EMPTY, clash = false
      for (;;) {
        const res = S.scan(d.h, m.id, lo, MAX, false, 256, 1), ks = unpack(res[0])
        for (let i = 0; i < ks.length && !clash; i++) for (const ik of indexKeys(res[1 + i], ix)) {
          if (unique && S.ixOther(d.h, ix.id, ik, ks[i])) { clash = true; break }
          S.ixPut(d.h, ix.id, ik, ks[i])
        }
        if (clash || ks.length < 256) break
        lo = succ(ks[ks.length - 1])
      }
      if (clash) tx._reqs.push({ internal: true, op: () => { throw err('ConstraintError', `Index '${name}' is unique and the records break it`) } })
      return this.index(name)
    }
    deleteIndex(name) {
      if (arguments.length < 1) throw new TypeError('deleteIndex: a name is required')
      const tx = this._tx, d = tx._d
      if (tx._mode !== 'versionchange') throw err('InvalidStateError', 'Indexes are deleted in a versionchange transaction')
      const m = this._m(); if (!m) throw err('InvalidStateError', 'The object store has been deleted')
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      const ix = [...m.indexes.values()].find(i => i.name === String(name)); if (!ix) throw err('NotFoundError', `No index named '${name}'`)
      S.ixClear(d.h, ix.id); m.indexes.delete(ix.id); tx._schemaDirty = true
    }
    get [Symbol.toStringTag]() { return 'IDBObjectStore' }
  }

  // --------------------------------------------------------------------------------------------------- IDBIndex
  class IDBIndex {
    constructor(t, store, ixId) { illegal(t); this._store = store; this._ixId = ixId; this._last = store._m().indexes.get(ixId); this._kp = undefined }
    _m() { const sm = this._store._m(), im = sm?.indexes.get(this._ixId); if (im) this._last = im; return im ? [sm, im] : null }
    get objectStore() { return this._store }
    get name() { this._m(); return this._last.name }
    set name(v) {
      v = String(v); const tx = this._store._tx, p = this._m()
      if (tx._mode !== 'versionchange' || !p) throw err('InvalidStateError', 'Indexes are renamed in a versionchange transaction')
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (p[1].name === v) return
      if ([...p[0].indexes.values()].some(i => i.name === v)) throw err('ConstraintError', `An index named '${v}' exists`)
      p[1].name = v; tx._schemaDirty = true
    }
    get keyPath() { const kp = this._last.keyPath; if (!Array.isArray(kp)) return kp; return this._kp ??= [...kp] }
    get multiEntry() { return this._last.multiEntry }
    get unique() { return this._last.unique }
    _check() {
      const p = this._m(); if (!p) throw err('InvalidStateError', 'The index or its object store has been deleted')
      if (this._store._tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      return p
    }
    _live() { const p = this._m(); if (!p) throw err('InvalidStateError', 'The index has been deleted'); return p }
    get(query) {
      if (arguments.length < 1) throw new TypeError('a key or key range is required')
      this._check(); const r = toRange(query, true), d = this._store._tx._d
      return request(this._store._tx, this, () => { const [sm, im] = this._live(); const res = S.ixScan(d.h, im.id, r.lo, r.hi, r.lo, EMPTY, false, 1, sm.id, 1); return res.length > 2 ? res[2] : undefined })
    }
    getKey(query) {
      if (arguments.length < 1) throw new TypeError('a key or key range is required')
      this._check(); const r = toRange(query, true), d = this._store._tx._d
      return request(this._store._tx, this, () => { const [, im] = this._live(); const pk = unpack(S.ixScan(d.h, im.id, r.lo, r.hi, r.lo, EMPTY, false, 1, -1, 0)[1])[0]; return pk ? fromKey(pk) : undefined })
    }
    getAll(query, count) {
      this._check(); const r = toRange(query, false), n = countArg(count), d = this._store._tx._d
      return request(this._store._tx, this, () => { const [sm, im] = this._live(); return S.ixScan(d.h, im.id, r.lo, r.hi, r.lo, EMPTY, false, n, sm.id, 1).slice(2) })
    }
    getAllKeys(query, count) {
      this._check(); const r = toRange(query, false), n = countArg(count), d = this._store._tx._d
      return request(this._store._tx, this, () => { const [, im] = this._live(); return unpack(S.ixScan(d.h, im.id, r.lo, r.hi, r.lo, EMPTY, false, n, -1, 0)[1]).map(fromKey) })
    }
    count(query) {
      this._check(); const r = toRange(query, false), d = this._store._tx._d
      return request(this._store._tx, this, () => { const [, im] = this._live(); return S.ixCount(d.h, im.id, r.lo, r.hi) })
    }
    openCursor(query, direction) { return this._cursor(query, direction, false) }
    openKeyCursor(query, direction) { return this._cursor(query, direction, true) }
    _cursor(query, direction, keyOnly) {
      this._check(); const r = toRange(query, false), dir = dirArg(direction)
      const c = new (keyOnly ? IDBCursor : IDBCursorWithValue)(TOKEN, this, this._store, this, dir, r, keyOnly)
      const req = request(this._store._tx, this, () => iterate(c, 1, null, null)); c._req = req
      return req
    }
    get [Symbol.toStringTag]() { return 'IDBIndex' }
  }

  // --------------------------------------------------------------------------------------------------- cursors
  const cmp2 = (k1, p1, k2, p2) => cmp(k1, k2) || cmp(p1, p2)
  // "Iterate a cursor": the count-th record past the position (and at or past the target key / primary key).
  function iterate(c, count, tKey, tPk) {
    const d = c._store._tx._d, h = d.h
    const sm = c._store._m(); if (!sm) throw err('InvalidStateError', 'The object store has been deleted')
    let kB, pB, val
    if (c._index) {
      const im = sm.indexes.get(c._index._ixId); if (!im) throw err('InvalidStateError', 'The index has been deleted')
      const mode = c._keyOnly ? 0 : 1, vns = c._keyOnly ? -1 : sm.id, lo = c._lo, hi = c._hi, dir = c._dir
      if (dir === 'next' || dir === 'prev') {
        const rev = dir === 'prev'; let cK, cP
        if (!rev) {
          cK = lo; cP = EMPTY
          if (c._pos) { cK = c._pos; cP = succ(c._opos) }
          if (tKey) { const tp = tPk ?? EMPTY; if (cmp2(tKey, tp, cK, cP) > 0) { cK = tKey; cP = tp } }
        } else {
          cK = hi; cP = EMPTY
          if (c._pos) { cK = c._pos; cP = c._opos }
          if (tKey) { const tk = tPk ? tKey : succ(tKey), tp = tPk ? succ(tPk) : EMPTY; if (cmp2(tk, tp, cK, cP) < 0) { cK = tk; cP = tp } }
        }
        const res = S.ixScan(h, im.id, lo, hi, cK, cP, rev, count, vns, mode), ks = unpack(res[0])
        if (ks.length < count) return done(c)
        kB = ks[count - 1]; pB = unpack(res[1])[count - 1]; val = res[1 + count]
      } else if (dir === 'nextunique') {
        let cK = lo
        if (c._pos) cK = maxOf(cK, succ(c._pos))
        if (tKey) cK = maxOf(cK, tKey)
        for (let i = 0; i < count; i++) {
          const res = S.ixScan(h, im.id, lo, hi, cK, EMPTY, false, 1, vns, mode), ks = unpack(res[0])
          if (!ks.length) return done(c)
          kB = ks[0]; pB = unpack(res[1])[0]; val = res[2]; cK = succ(kB)
        }
      } else {  // prevunique: the highest key below the position, at its lowest primary key
        let cK = hi
        if (c._pos) cK = minOf(cK, c._pos)
        if (tKey) cK = minOf(cK, succ(tKey))
        for (let i = 0; i < count; i++) {
          const ks = unpack(S.ixScan(h, im.id, lo, hi, cK, EMPTY, true, 1, -1, 0)[0])
          if (!ks.length) return done(c)
          const K = ks[0], first = S.ixScan(h, im.id, K, succ(K), K, EMPTY, false, 1, vns, mode)
          kB = K; pB = unpack(first[1])[0]; val = first[2]; cK = K
        }
      }
    } else {
      const mode = c._keyOnly ? 0 : 1, rev = c._dir === 'prev' || c._dir === 'prevunique'
      let lo = c._lo, hi = c._hi
      if (!rev) { if (c._pos) lo = maxOf(lo, succ(c._pos)); if (tKey) lo = maxOf(lo, tKey) }
      else { if (c._pos) hi = minOf(hi, c._pos); if (tKey) hi = minOf(hi, succ(tKey)) }
      if (cmp(lo, hi) >= 0) return done(c)
      const res = S.scan(h, sm.id, lo, hi, rev, count, mode), ks = unpack(res[0])
      if (ks.length < count) return done(c)
      kB = ks[count - 1]; pB = kB; val = res[count]
    }
    c._pos = kB.slice(); c._opos = c._index ? pB.slice() : c._pos
    c._key = fromKey(c._pos); c._pk = c._index ? fromKey(c._opos) : c._key; c._value = val; c._gotValue = true
    return c
  }
  function done(c) { c._key = undefined; c._pk = undefined; c._value = undefined; c._gotValue = false; return null }

  class IDBCursor {
    constructor(t, source, store, index, dir, range, keyOnly) {
      illegal(t); this._source = source; this._store = store; this._index = index; this._dir = dir; this._lo = range.lo; this._hi = range.hi; this._keyOnly = keyOnly
      this._req = null; this._pos = null; this._opos = null; this._gotValue = false; this._key = undefined; this._pk = undefined; this._value = undefined
    }
    get source() { return this._source }
    get direction() { return this._dir }
    get key() { return this._key }
    get primaryKey() { return this._pk }
    get request() { return this._req }
    _deleted() { return this._index ? !this._index._m() : !this._store._m() }
    _move(op) {
      this._gotValue = false; this._req._ready = 'pending'
      const tx = this._store._tx; tx._reqs.push({ r: this._req, op }); kick(tx._d)
    }
    advance(count) {
      const n = Number(count)
      if (!Number.isFinite(n) || n < 0 || n > 0xFFFFFFFF) throw new TypeError('count is out of range')
      if (Math.trunc(n) === 0) throw new TypeError('count must be above 0')
      if (this._store._tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (this._deleted()) throw err('InvalidStateError', 'The source has been deleted')
      if (!this._gotValue) throw err('InvalidStateError', 'The cursor is moving or has finished')
      this._move(() => iterate(this, Math.trunc(n), null, null))
    }
    continue(key) {
      if (this._store._tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (this._deleted()) throw err('InvalidStateError', 'The source has been deleted')
      if (!this._gotValue) throw err('InvalidStateError', 'The cursor is moving or has finished')
      let k = null
      if (key !== undefined) {
        k = keyOrThrow(key); const c = cmp(k, this._pos)
        if ((this._dir === 'next' || this._dir === 'nextunique') ? c <= 0 : c >= 0) throw err('DataError', 'The key is not past the cursor')
      }
      this._move(() => iterate(this, 1, k, null))
    }
    continuePrimaryKey(key, primaryKey) {
      if (this._store._tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (this._deleted()) throw err('InvalidStateError', 'The source has been deleted')
      if (!this._index) throw err('InvalidAccessError', 'continuePrimaryKey is for index cursors')
      if (this._dir !== 'next' && this._dir !== 'prev') throw err('InvalidAccessError', 'continuePrimaryKey is for next and prev cursors')
      if (!this._gotValue) throw err('InvalidStateError', 'The cursor is moving or has finished')
      const k = keyOrThrow(key), p = keyOrThrow(primaryKey), c = cmp(k, this._pos)
      if (this._dir === 'next' ? (c < 0 || (c === 0 && cmp(p, this._opos) <= 0)) : (c > 0 || (c === 0 && cmp(p, this._opos) >= 0))) throw err('DataError', 'The key is not past the cursor')
      this._move(() => iterate(this, 1, k, p))
    }
    update(value) {
      const tx = this._store._tx
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (tx._mode === 'readonly') throw err('ReadOnlyError', 'The transaction is read-only')
      if (this._deleted()) throw err('InvalidStateError', 'The source has been deleted')
      if (!this._gotValue || this._keyOnly) throw err('InvalidStateError', 'The cursor has no value')
      const m = this._store._m(), bytes = cloneValue(tx, value), pk = this._opos
      let clone
      if (m.keyPath !== null || m.indexes.size) clone = S.deserialize(bytes)
      if (m.keyPath !== null) { const v = evaluate(clone, m.keyPath, g), k = v === FAIL ? null : toKey(v); if (!k || cmp(k, pk) !== 0) throw err('DataError', 'The value\'s key does not match the cursor\'s') }
      const id = this._store._id
      return request(tx, this, () => storeRecord(tx, id, pk, bytes, clone, false))
    }
    delete() {
      const tx = this._store._tx
      if (tx._now() !== 'active') throw err('TransactionInactiveError', 'The transaction is not active')
      if (tx._mode === 'readonly') throw err('ReadOnlyError', 'The transaction is read-only')
      if (this._deleted()) throw err('InvalidStateError', 'The source has been deleted')
      if (!this._gotValue || this._keyOnly) throw err('InvalidStateError', 'The cursor has no value')
      const pk = this._opos, d = tx._d, id = this._store._id
      return request(tx, this, () => { deleteRange(d, liveStore(d, id), pk, succ(pk)); return undefined })
    }
    get [Symbol.toStringTag]() { return 'IDBCursor' }
  }
  class IDBCursorWithValue extends IDBCursor {
    get value() { return this._value }
    get [Symbol.toStringTag]() { return 'IDBCursorWithValue' }
  }

  // --------------------------------------------------------------------------------------------------- IDBFactory
  function version(v) {
    const n = Number(v)
    if (!Number.isFinite(n) || Math.trunc(n) < 1 || n > Number.MAX_SAFE_INTEGER) throw new TypeError(`version ${v} is out of range`)
    return Math.trunc(n)
  }
  class IDBFactory {
    constructor(t) { illegal(t) }
    open(name, v) {
      if (arguments.length < 1) throw new TypeError('open: a name is required')
      const ver = v === undefined ? undefined : version(v)
      const r = new IDBOpenDBRequest(TOKEN), d = state(String(name))
      d.jobs.push({ kind: 'open', request: r, version: ver, stage: 0, conn: null }); kick(d)
      return r
    }
    deleteDatabase(name) {
      if (arguments.length < 1) throw new TypeError('deleteDatabase: a name is required')
      const r = new IDBOpenDBRequest(TOKEN), d = state(String(name))
      d.jobs.push({ kind: 'delete', request: r, stage: 0, conn: null }); kick(d)
      return r
    }
    databases() {
      return new Promise((resolve, reject) => post(() => {
        try {
          const out = []
          for (const [stem, name] of S.list()) {
            const d = name !== null ? dbs.get(name) : null
            if (d?.schema && d.h) { if (d.schema.version > 0) out.push({ name, version: d.schema.version }); continue }
            const h = S.open(2, stem, false); if (!h) continue
            try { const o = S.get(h, 0, META, false); if (o?.version > 0) out.push({ name: o.name ?? name, version: o.version }) } finally { S.close(h) }
          }
          resolve(out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        } catch (e) { reject(toDom(e)) }
      }))
    }
    cmp(a, b) {
      if (arguments.length < 2) throw new TypeError('cmp: two keys are required')
      return cmp(keyOrThrow(a), keyOrThrow(b))
    }
    get [Symbol.toStringTag]() { return 'IDBFactory' }
  }

  Object.assign(g, { IDBFactory, IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBCursor, IDBCursorWithValue, IDBKeyRange, IDBRequest, IDBOpenDBRequest, IDBVersionChangeEvent })
  if (!g.DOMStringList) g.DOMStringList = DOMStringList
  g.indexedDB = new IDBFactory(TOKEN)
}
