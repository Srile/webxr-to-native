// IndexedDB (WP-26, runtime/src/storage) against the in-memory fake of __native.storage (storage-fake.js): key order,
// persistence across a restart, stores, indexes, cursors, ranges, transactions (auto-commit, commit, abort with full
// rollback), versionchange / blocked, errors, Blobs in values, and the call shapes of idb-keyval and localforage.
import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { fakeStorage, fakeLoop, cmpBytes } from './storage-fake.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installStorage } from '../src/storage/index.js'
import { toKey, fromKey } from '../src/storage/keys.js'

function sandbox(files = new Map(), opts = {}) {
  const S = fakeStorage({ files, ...opts })
  const g = Object.create(null)
  g.__native = fakeNative({ storage: S, loop: fakeLoop(S) }); g.Promise = Promise
  installCore(g); installFetch(g); installStorage(g)
  return { g, S, files }
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error ?? new Error('aborted')) })
function open(g, name, version, upgrade) {
  return new Promise((res, rej) => {
    const r = g.indexedDB.open(name, version)
    r.onupgradeneeded = (e) => upgrade?.(r.result, r.transaction, e)
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
}
const tick = () => new Promise(r => setTimeout(r, 5))

test('keys: the byte order is the spec order (number < date < string < binary < array), and they decode back', () => {
  const keys = [-Infinity, -1e300, -2, -1.5, -Number.MIN_VALUE, 0, Number.MIN_VALUE, 1, 2, 1e300, Infinity,
    new Date(-1), new Date(0), new Date(1e12),
    '', '\u0000', 'A', 'a', 'a\u0000', 'aa', 'b', '~', '\u007f', 'Ā', '䁾', '䁿', '\ud800', '😀', '￿',
    new Uint8Array([]).buffer, new Uint8Array([0]).buffer, new Uint8Array([0, 0]).buffer, new Uint8Array([1]).buffer, new Uint8Array([0x7e]).buffer, new Uint8Array([0x7f]).buffer, new Uint8Array([0xff]).buffer,
    [], [-1], [0], [0, 0], [0, 'a'], ['a'], [[]], [[0]], [[[1]]]]
  const enc = keys.map(toKey)
  for (let i = 1; i < enc.length; i++) assert.equal(cmpBytes(enc[i - 1], enc[i]), -1, `${String(keys[i - 1])} < ${String(keys[i])}`)
  assert.equal(cmpBytes(toKey(-0), toKey(0)), 0)
  for (const k of keys) { const back = fromKey(toKey(k)); assert.equal(cmpBytes(toKey(back), toKey(k)), 0) }
  assert.ok(fromKey(toKey(new Date(5))) instanceof Date && fromKey(toKey(new Uint8Array([3]))) instanceof ArrayBuffer)
  for (const bad of [NaN, new Date(NaN), {}, null, undefined, true, Symbol.iterator, [NaN], [{}]]) assert.equal(toKey(bad), null)
  const cyc = []; cyc.push(cyc); assert.equal(toKey(cyc), null)
  const sparse = [1, , 3]; assert.equal(toKey(sparse), null)  // eslint-disable-line no-sparse-arrays
  const { g } = sandbox()
  assert.equal(g.indexedDB.cmp(1, 2), -1); assert.equal(g.indexedDB.cmp('b', 'a'), 1); assert.equal(g.indexedDB.cmp([1, 'x'], [1, 'x']), 0)
  assert.throws(() => g.indexedDB.cmp({}, 1), (e) => e.name === 'DataError')
})

test('open, upgradeneeded, put/get, and the records survive a restart', async () => {
  const { g, files } = sandbox()
  const db = await open(g, 'game', 2, (db, tx, e) => {
    assert.equal(e.oldVersion, 0); assert.equal(e.newVersion, 2); assert.equal(tx.mode, 'versionchange')
    db.createObjectStore('saves'); db.createObjectStore('players', { keyPath: 'id' })
  })
  assert.equal(db.version, 2); assert.deepEqual([...db.objectStoreNames], ['players', 'saves'])
  const tx = db.transaction(['saves', 'players'], 'readwrite')
  tx.objectStore('saves').put({ level: 3, when: new Date(10), map: new Map([[1, 'a']]), bytes: new Uint8Array([1, 2]) }, 'slot1')
  tx.objectStore('players').put({ id: 7, name: 'Chip' })
  await done(tx)
  db.close()

  const { g: g2 } = sandbox(files)  // the app again, on the same files
  const db2 = await open(g2, 'game')
  assert.equal(db2.version, 2)
  const t2 = db2.transaction('saves')
  const v = await req(t2.objectStore('saves').get('slot1'))
  assert.equal(v.level, 3); assert.ok(v.when instanceof Date && v.when.getTime() === 10); assert.equal(v.map.get(1), 'a'); assert.deepEqual([...v.bytes], [1, 2])
  assert.equal((await req(db2.transaction('players').objectStore('players').get(7))).name, 'Chip')
  assert.deepEqual(await g2.indexedDB.databases(), [{ name: 'game', version: 2 }])
  await assert.rejects(open(g2, 'game', 1), (e) => e.name === 'VersionError')
})

test('autoIncrement: keys generated and injected, explicit keys move the generator, an abort rolls it back', async () => {
  const { g } = sandbox()
  const db = await open(g, 'ai', 1, (db) => { db.createObjectStore('a', { autoIncrement: true }); db.createObjectStore('b', { keyPath: 'x.id', autoIncrement: true }) })
  let tx = db.transaction(['a', 'b'], 'readwrite')
  const k1 = req(tx.objectStore('a').add('one')), k2 = req(tx.objectStore('a').put('ten', 10)), k3 = req(tx.objectStore('a').add('next'))
  const kb = req(tx.objectStore('b').add({ name: 'n' }))
  assert.deepEqual([await k1, await k2, await k3, await kb], [1, 10, 11, 1])
  await done(tx)
  tx = db.transaction('b'); assert.deepEqual(await req(tx.objectStore('b').get(1)), { name: 'n', x: { id: 1 } })
  tx = db.transaction('a', 'readwrite')
  await req(tx.objectStore('a').add('rolled back'))  // 12
  tx.abort()
  await assert.rejects(done(tx))
  tx = db.transaction('a', 'readwrite')
  assert.equal(await req(tx.objectStore('a').add('after abort')), 12)
  assert.equal(await req(tx.objectStore('a').count()), 4)
})

test('indexes: unique (ConstraintError, preventDefault keeps the transaction), multiEntry, array and dotted key paths', async () => {
  const { g } = sandbox()
  const db = await open(g, 'ix', 1, (db) => {
    const s = db.createObjectStore('people', { keyPath: 'id' })
    s.createIndex('email', 'email', { unique: true })
    s.createIndex('tags', 'tags', { multiEntry: true })
    s.createIndex('full', ['last', 'first'])
    s.createIndex('city', 'addr.city')
  })
  let tx = db.transaction('people', 'readwrite'); const s = tx.objectStore('people')
  s.put({ id: 1, email: 'a@x', tags: ['red', 'blue', 'red'], last: 'Lee', first: 'Ann', addr: { city: 'Oslo' } })
  s.put({ id: 2, email: 'b@x', tags: ['blue'], last: 'Lee', first: 'Bob', addr: { city: 'Rome' } })
  s.put({ id: 3, email: 'c@x', tags: [], last: 'Ng', first: 'Cy' })
  const dup = s.add({ id: 4, email: 'a@x' })
  let sawError = false
  dup.onerror = (e) => { sawError = dup.error.name === 'ConstraintError'; e.preventDefault() }
  s.put({ id: 5, email: 'e@x', tags: ['green'] })
  await done(tx)
  assert.ok(sawError)
  tx = db.transaction('people'); const p = tx.objectStore('people')
  assert.equal(await req(p.count()), 4)  // 1, 2, 3, 5: the duplicate left nothing behind
  assert.equal((await req(p.index('email').get('b@x'))).id, 2)
  assert.equal(await req(p.index('email').getKey('c@x')), 3)
  assert.deepEqual(await req(p.index('tags').getAllKeys('blue')), [1, 2])
  assert.equal(await req(p.index('tags').count()), 4)  // red(1) blue(1, 2) green(5): duplicates in one record counted once
  assert.deepEqual((await req(p.index('full').getAll(g.IDBKeyRange.bound(['Lee', ''], ['Lee', '￿'])))).map(r => r.first), ['Ann', 'Bob'])
  assert.deepEqual(await req(p.index('city').getAllKeys()), [1, 2])
  // updating a record moves its index entries
  tx = db.transaction('people', 'readwrite')
  tx.objectStore('people').put({ id: 2, email: 'a@x' })
  const failed = await new Promise((res) => { tx.onabort = () => res(tx.error.name); tx.oncomplete = () => res('complete') })
  assert.equal(failed, 'ConstraintError')
  tx = db.transaction('people', 'readwrite')
  tx.objectStore('people').put({ id: 2, email: 'z@x', tags: ['red'] }); await done(tx)
  tx = db.transaction('people')
  assert.equal(await req(tx.objectStore('people').index('email').get('b@x')), undefined)
  assert.deepEqual(await req(tx.objectStore('people').index('tags').getAllKeys('red')), [1, 2])
})

test('cursors: directions, continue(key), advance, update, delete, key cursors, unique and continuePrimaryKey', async () => {
  const { g } = sandbox()
  const db = await open(g, 'cur', 1, (db) => { const s = db.createObjectStore('s'); s.createIndex('v', 'v') })
  let tx = db.transaction('s', 'readwrite')
  for (let i = 1; i <= 6; i++) tx.objectStore('s').put({ v: i % 3 }, i)
  await done(tx)
  const walk = (src, range, dir, each) => new Promise((res, rej) => { const out = []; const r = src.openCursor(range, dir); r.onerror = () => rej(r.error); r.onsuccess = () => { const c = r.result; if (!c) return res(out); out.push([c.key, c.primaryKey]); each ? each(c, out) : c.continue() } })
  tx = db.transaction('s'); let s = tx.objectStore('s')
  assert.deepEqual((await walk(s, null, 'next')).map(x => x[0]), [1, 2, 3, 4, 5, 6])
  assert.deepEqual((await walk(s, g.IDBKeyRange.bound(2, 5, true, false), 'prev')).map(x => x[0]), [5, 4, 3])
  assert.deepEqual((await walk(s, null, 'next', (c, out) => out.length === 1 ? c.continue(4) : c.advance(2))).map(x => x[0]), [1, 4, 6])
  const ix = s.index('v')
  assert.deepEqual(await walk(ix, null, 'next'), [[0, 3], [0, 6], [1, 1], [1, 4], [2, 2], [2, 5]])
  assert.deepEqual(await walk(ix, null, 'prev'), [[2, 5], [2, 2], [1, 4], [1, 1], [0, 6], [0, 3]])
  assert.deepEqual(await walk(ix, null, 'nextunique'), [[0, 3], [1, 1], [2, 2]])
  assert.deepEqual(await walk(ix, null, 'prevunique'), [[2, 2], [1, 1], [0, 3]])
  assert.deepEqual(await walk(ix, null, 'next', (c, out) => out.length === 1 ? c.continuePrimaryKey(1, 4) : c.continue()), [[0, 3], [1, 4], [2, 2], [2, 5]])
  assert.throws(() => s.openCursor(null, 'sideways'), TypeError)
  const keyOnly = await new Promise((res) => { const r = s.openKeyCursor(); r.onsuccess = () => res(r.result) })
  assert.equal(keyOnly.key, 1); assert.ok(!('value' in keyOnly))
  await done(tx).catch(() => {})
  tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s')
  await walk(s, null, 'next', (c) => { if (c.key === 2) c.update({ v: 9 }); if (c.key === 3) c.delete(); c.continue() })
  await done(tx)
  tx = db.transaction('s'); s = tx.objectStore('s')
  assert.deepEqual(await req(s.getAllKeys()), [1, 2, 4, 5, 6])
  assert.deepEqual(await req(s.index('v').getAllKeys(9)), [2])
  assert.deepEqual(await req(s.getAll(g.IDBKeyRange.lowerBound(4), 2)), [{ v: 1 }, { v: 2 }])
  assert.deepEqual(await req(s.getAllKeys(g.IDBKeyRange.upperBound(4, true))), [1, 2])
  assert.equal(await req(s.getKey(g.IDBKeyRange.lowerBound(3))), 4)
  assert.equal(await req(s.count(g.IDBKeyRange.only(5))), 1)
  const r = g.IDBKeyRange.bound(1, 5, false, true)
  assert.ok(r.includes(1) && !r.includes(5) && r.lower === 1 && r.upper === 5 && !r.lowerOpen && r.upperOpen)
  assert.throws(() => g.IDBKeyRange.bound(5, 1), (e) => e.name === 'DataError')
})

test('transactions: inactive after their task, read-only, schema only in upgrades, errors bubble request -> transaction -> database', async () => {
  const { g } = sandbox()
  const db = await open(g, 'tx', 1, (db) => db.createObjectStore('s'))
  const tx = db.transaction('s', 'readwrite'); const s = tx.objectStore('s')
  await tick()
  assert.throws(() => s.put(1, 1), (e) => e.name === 'TransactionInactiveError')
  const ro = db.transaction('s')
  assert.throws(() => ro.objectStore('s').put(1, 1), (e) => e.name === 'ReadOnlyError')
  assert.throws(() => db.createObjectStore('x'), (e) => e.name === 'InvalidStateError')
  assert.throws(() => db.transaction('nope'), (e) => e.name === 'NotFoundError')
  assert.throws(() => db.transaction([]), (e) => e.name === 'InvalidAccessError')
  assert.throws(() => db.transaction('s', 'versionchange'), TypeError)
  const t = db.transaction('s', 'readwrite'), order = []
  t.objectStore('s').add(1, 'k'); const second = t.objectStore('s').add(2, 'k')
  second.onerror = () => order.push('request'); t.onerror = () => order.push('transaction'); db.onerror = (e) => { order.push('database'); e.preventDefault() }
  t.objectStore('s').put(3, 'k3')
  await done(t)
  assert.deepEqual(order, ['request', 'transaction', 'database'])
  const t2 = db.transaction('s')
  assert.deepEqual(await req(t2.objectStore('s').getAll()), [1, 3])
  // commit(): no more requests, complete follows
  const t3 = db.transaction('s', 'readwrite'); t3.objectStore('s').put('c', 'c'); t3.commit()
  assert.throws(() => t3.objectStore('s').put('d', 'd'), (e) => e.name === 'TransactionInactiveError')
  await done(t3)
  // a value that cannot be cloned
  const t4 = db.transaction('s', 'readwrite')
  assert.throws(() => t4.objectStore('s').put({ f() {} }, 'f'), (e) => e.name === 'DataCloneError')
  await done(t4)
})

test('aborting an upgrade rolls back the version, the stores and the data; versionchange and blocked within the isolate', async () => {
  const { g } = sandbox()
  const db1 = await open(g, 'vc', 1, (db) => db.createObjectStore('keep').put('v', 'k'))
  const r = g.indexedDB.open('vc', 2), seen = []
  db1.onversionchange = (e) => { seen.push(`versionchange ${e.oldVersion}->${e.newVersion}`) }
  r.onblocked = (e) => { seen.push('blocked'); db1.close() }
  r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('new'); db.deleteObjectStore('keep'); seen.push('upgrade'); r.transaction.abort() }
  const err = await new Promise((res) => { r.onerror = () => res(r.error.name); r.onsuccess = () => res('success') })
  assert.equal(err, 'AbortError'); assert.deepEqual(seen, ['versionchange 1->2', 'blocked', 'upgrade'])
  const db = await open(g, 'vc')
  assert.equal(db.version, 1); assert.deepEqual([...db.objectStoreNames], ['keep'])
  assert.equal(await req(db.transaction('keep').objectStore('keep').get('k')), 'v')
  // deleteDatabase waits for the open connection (versionchange), then the database is gone
  db.onversionchange = () => db.close()
  const del = g.indexedDB.deleteDatabase('vc')
  const ev = await new Promise((res, rej) => { del.onsuccess = (e) => res(e); del.onerror = () => rej(del.error) })
  assert.equal(ev.oldVersion, 1)
  assert.deepEqual(await g.indexedDB.databases(), [])
  const fresh = await open(g, 'vc', 1, (db) => assert.equal(db.objectStoreNames.length, 0))
  assert.equal(fresh.version, 1)
})

test('Blobs and Files round-trip in values (localforage stores Blobs)', async () => {
  const { g, files } = sandbox()
  const db = await open(g, 'blobs', 1, (db) => db.createObjectStore('b'))
  const tx = db.transaction('b', 'readwrite')
  tx.objectStore('b').put({ img: new g.Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), f: new g.File(['hi'], 'a.txt', { type: 'text/plain', lastModified: 42 }) }, 1)
  await done(tx)
  const { g: g2 } = sandbox(files)
  const db2 = await open(g2, 'blobs')
  const v = await req(db2.transaction('b').objectStore('b').get(1))
  assert.ok(v.img instanceof g2.Blob); assert.equal(v.img.type, 'image/png'); assert.deepEqual([...new Uint8Array(await v.img.arrayBuffer())], [1, 2, 3])
  assert.ok(v.f instanceof g2.File); assert.equal(v.f.name, 'a.txt'); assert.equal(v.f.lastModified, 42); assert.equal(await v.f.text(), 'hi')
})

test('quota: a put past storage.quotaMB fails with QuotaExceededError and the transaction aborts', async () => {
  const { g } = sandbox(new Map(), { quota: 64 * 1024 })
  const db = await open(g, 'q', 1, (db) => db.createObjectStore('s'))
  const tx = db.transaction('s', 'readwrite')
  tx.objectStore('s').put(new Uint8Array(100 * 1024), 'big')
  const name = await new Promise((res) => { tx.onabort = () => res(tx.error.name); tx.oncomplete = () => res('complete') })
  assert.equal(name, 'QuotaExceededError')
  const est = await g.navigator.storage.estimate()
  assert.equal(est.quota, 64 * 1024); assert.ok(est.usage < 64 * 1024)
  assert.equal(await g.navigator.storage.persisted(), true)
})

test('idb-keyval call shapes: get, set, setMany, getMany, update, del, keys, values, entries, clear', async () => {
  const { g } = sandbox()
  // idb-keyval 6, as published (promisifyRequest, createStore, the functions over it)
  function promisifyRequest(request) { return new Promise((resolve, reject) => { request.oncomplete = request.onsuccess = () => resolve(request.result); request.onabort = request.onerror = () => reject(request.error) }) }
  function createStore(dbName, storeName) {
    let dbp
    const getDB = () => { if (dbp) return dbp; const request = g.indexedDB.open(dbName); request.onupgradeneeded = () => request.result.createObjectStore(storeName); dbp = promisifyRequest(request); dbp.then((db) => { db.onclose = () => (dbp = undefined) }, () => {}); return dbp }
    return (txMode, callback) => getDB().then((db) => callback(db.transaction(storeName, txMode).objectStore(storeName)))
  }
  const store = createStore('keyval-store', 'keyval')
  const get = (key) => store('readonly', (s) => promisifyRequest(s.get(key)))
  const set = (key, value) => store('readwrite', (s) => { s.put(value, key); return promisifyRequest(s.transaction) })
  const setMany = (entries) => store('readwrite', (s) => { entries.forEach((e) => s.put(e[1], e[0])); return promisifyRequest(s.transaction) })
  const getMany = (keys) => store('readonly', (s) => Promise.all(keys.map((k) => promisifyRequest(s.get(k)))))
  const update = (key, updater) => store('readwrite', (s) => new Promise((resolve, reject) => { s.get(key).onsuccess = function () { try { s.put(updater(this.result), key); resolve(promisifyRequest(s.transaction)) } catch (err) { reject(err) } } }))
  const del = (key) => store('readwrite', (s) => { s.delete(key); return promisifyRequest(s.transaction) })
  const keys = () => store('readonly', (s) => promisifyRequest(s.getAllKeys()))
  const values = () => store('readonly', (s) => promisifyRequest(s.getAll()))
  const entries = () => store('readonly', (s) => Promise.all([promisifyRequest(s.getAllKeys()), promisifyRequest(s.getAll())]).then(([k, v]) => k.map((key, i) => [key, v[i]])))
  const clear = () => store('readwrite', (s) => { s.clear(); return promisifyRequest(s.transaction) })
  await set('hello', 'world'); assert.equal(await get('hello'), 'world')
  await setMany([['a', 1], ['b', 2]]); assert.deepEqual(await getMany(['a', 'b', 'zz']), [1, 2, undefined])
  await update('a', (v) => v + 10); assert.equal(await get('a'), 11)
  await del('b'); assert.deepEqual(await keys(), ['a', 'hello']); assert.deepEqual(await values(), [11, 'world'])
  assert.deepEqual(await entries(), [['a', 11], ['hello', 'world']])
  await clear(); assert.deepEqual(await keys(), [])
})

test('localforage call shapes: open with upgrade, the Blob support probe, setItem / getItem / keys / iterate / length / removeItem / clear', async () => {
  const { g } = sandbox()
  // localforage 1.10's IndexedDB driver, the calls it makes (its promise plumbing trimmed)
  const DETECT = 'local-forage-detect-blob-support'
  const openDb = (name, version, storeName) => new Promise((resolve, reject) => {
    const r = g.indexedDB.open(name, version)
    r.onerror = () => reject(r.error)
    r.onupgradeneeded = (e) => { const db = r.result; try { db.createObjectStore(storeName); if (e.oldVersion <= 1) db.createObjectStore(DETECT) } catch (ex) { if (ex.name !== 'ConstraintError') throw ex } }
    r.onsuccess = () => { const db = r.result; db.onversionchange = (e) => e.target.close(); resolve(db) }
  })
  const db = await openDb('localforage', 2, 'keyvaluepairs')
  const blobSupport = await new Promise((resolve) => {
    const txn = db.transaction(DETECT, 'readwrite'); const blob = new g.Blob([''])
    txn.objectStore(DETECT).put(blob, 'key')
    txn.onabort = (e) => { e.preventDefault(); e.stopPropagation(); resolve(false) }
    txn.oncomplete = () => { const m = g.navigator.userAgent.match(/Chrome\/(\d+)/); resolve(!m || parseInt(m[1], 10) >= 43) }
  })
  assert.equal(blobSupport, true)
  const rw = (f) => new Promise((resolve, reject) => { const tx = db.transaction('keyvaluepairs', 'readwrite'); const st = tx.objectStore('keyvaluepairs'); let res; const r = f(st); r.onsuccess = () => { res = r.result }; tx.oncomplete = () => resolve(res); tx.onabort = tx.onerror = () => reject(r.error || tx.error) })
  const ro = (f) => new Promise((resolve, reject) => { const tx = db.transaction('keyvaluepairs', 'readonly'); const st = tx.objectStore('keyvaluepairs'); f(st, resolve, reject) })
  await rw((st) => st.put({ score: 9 }, 'save'))
  await rw((st) => st.put(new g.Blob([new Uint8Array([7, 8])], { type: 'application/octet-stream' }), 'pic'))
  const save = await ro((st, resolve) => { const r = st.get('save'); r.onsuccess = () => resolve(r.result === undefined ? null : r.result) })
  assert.deepEqual(save, { score: 9 })
  const pic = await ro((st, resolve) => { const r = st.get('pic'); r.onsuccess = () => resolve(r.result) })
  assert.ok(pic instanceof g.Blob); assert.deepEqual([...new Uint8Array(await pic.arrayBuffer())], [7, 8])
  const keys = await ro((st, resolve, reject) => { const r = st.openKeyCursor(); const out = []; r.onsuccess = () => { const c = r.result; if (!c) return resolve(out); out.push(c.key); c.continue() }; r.onerror = () => reject(r.error) })
  assert.deepEqual(keys, ['pic', 'save'])
  let iterations = 0
  await ro((st, resolve) => { const r = st.openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return resolve(); iterations++; c.continue() } })
  assert.equal(iterations, 2)
  assert.equal(await ro((st, resolve) => { const r = st.count(); r.onsuccess = () => resolve(r.result) }), 2)
  await rw((st) => st.delete('pic'))
  await rw((st) => st.clear())
  assert.equal(await ro((st, resolve) => { const r = st.count(); r.onsuccess = () => resolve(r.result) }), 0)
})

test('off: without __native.storage the page has no indexedDB, no IDB classes, no caches', () => {
  const g = Object.create(null); g.__native = fakeNative(); g.Promise = Promise
  installCore(g); installFetch(g); installStorage(g)
  for (const k of ['indexedDB', 'IDBFactory', 'IDBKeyRange', 'IDBDatabase', 'caches', 'CacheStorage', 'Cache']) assert.equal(g[k], undefined, k)
})
