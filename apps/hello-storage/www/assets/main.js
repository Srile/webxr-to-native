// hello-storage (WP-26): IndexedDB and the Cache API on the host (host.json storage.indexedDB, storage.cache), on
// disk across launches. Run it with empty files, then again:
//  phase 1 (no database yet): stores, indexes, generated keys, records with a Date, a Map, bytes, a Blob and a File;
//          a cache with a made response and two fetched assets
//  phase 2 (the database exists): all of that read back, then indexes, the unique constraint, cursors, ranges, a key
//          generator rolled back with its transaction, the cache's order, deleteDatabase and databases()
//  every run: transactions active through microtasks and gone after their task, abort's rollback, a worker on the
//          same database (its own connection) and the caches, put + commit time, the quota (storage.quotaMB 6)
// The screen is green when all pass, red otherwise; the log says which, then PASS n/n and READY (or FAILED).
const log = (m) => console.log('hello-storage: ' + m)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error ?? new Error('aborted')) })
const later = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const DB = 'hello', VERSION = 2

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION)
    r.onupgradeneeded = (e) => {
      const db = r.result
      if (e.oldVersion < 1) db.createObjectStore('saves')
      if (e.oldVersion < 2) {
        const items = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true })
        items.createIndex('sku', 'sku', { unique: true }); items.createIndex('tags', 'tags', { multiEntry: true })
      }
    }
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
  })
}

async function phase1(db) {
  const tx = db.transaction(['saves', 'items'], 'readwrite')
  const saves = tx.objectStore('saves'), items = tx.objectStore('items')
  saves.put({ level: 7, when: new Date(1e12), map: new Map([['k', 1]]), bytes: new Uint8Array([1, 2, 3]), nested: { a: [1, 'two', null] } }, 'slot1')
  saves.put(new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'image/png' }), 'blob')
  saves.put(new File(['file text'], 'notes.txt', { type: 'text/plain', lastModified: 1234 }), 'file')
  const keys = ['sword', 'shield', 'potion'].map((sku, i) => req(items.add({ sku, tags: i ? ['gear', sku] : ['gear', 'weapon'], qty: i + 1 })))
  await done(tx)
  check('generated keys', (await Promise.all(keys)).join() === '1,2,3')
  const c = await caches.open('v1')
  await c.put('/generated', new Response('made in phase 1', { headers: { 'content-type': 'text/plain' } }))
  await c.addAll(['/a.txt', '/b.json'])
  check('cache written', (await c.keys()).length === 3)
}

async function phase2(db) {
  let tx = db.transaction(['saves', 'items']); const saves = tx.objectStore('saves'), items = tx.objectStore('items')
  const slot = await req(saves.get('slot1'))
  check('records survived', slot?.level === 7 && slot.when instanceof Date && slot.when.getTime() === 1e12 && slot.map.get('k') === 1 && slot.bytes.join() === '1,2,3' && slot.nested.a[1] === 'two', JSON.stringify(slot?.nested))
  const blob = await req(saves.get('blob')), file = await req(saves.get('file'))
  check('Blob survived', blob instanceof Blob && blob.type === 'image/png' && new Uint8Array(await blob.arrayBuffer()).join() === '9,8,7,6')
  check('File survived', file instanceof File && file.name === 'notes.txt' && file.lastModified === 1234 && (await file.text()) === 'file text')
  tx = db.transaction('items'); const it = tx.objectStore('items')
  const shield = await req(it.index('sku').get('shield'))
  const gear = await req(it.index('tags').getAllKeys('gear'))
  check('indexes survived', shield?.id === 2 && gear.join() === '1,2,3', `${shield?.id} ${gear}`)
  const back = []
  await new Promise((res) => { const r = it.openCursor(IDBKeyRange.bound(1, 3, true, false), 'prev'); r.onsuccess = () => { const c = r.result; if (!c) return res(); back.push(c.value.sku); c.continue() } })
  check('cursor over a range', back.join() === 'potion,shield', back.join())
  // the unique index: an add that breaks it fails alone (preventDefault), the rest of the transaction commits
  tx = db.transaction('items', 'readwrite')
  const dup = tx.objectStore('items').add({ sku: 'sword' }); let dupName = ''
  dup.onerror = (e) => { dupName = dup.error.name; e.preventDefault() }
  tx.objectStore('items').put({ id: 3, sku: 'potion', tags: ['gear', 'potion'], qty: 30 })
  await done(tx)
  tx = db.transaction('items'); const p = await req(tx.objectStore('items').get(3))
  check('unique index refuses, the transaction goes on', dupName === 'ConstraintError' && p.qty === 30, dupName)
  // a generated key in an aborted transaction is handed out again
  tx = db.transaction('items', 'readwrite')
  const k1 = await req(tx.objectStore('items').add({ sku: 'tmp' })); tx.abort(); await done(tx).catch(() => {})
  tx = db.transaction('items', 'readwrite')
  const k2 = await req(tx.objectStore('items').add({ sku: 'tmp' })); tx.abort(); await done(tx).catch(() => {})
  check('key generator rolls back with an abort', k1 === 4 && k2 === 4, `${k1} ${k2}`)
  const c = await caches.open('v1')
  const urls = (await c.keys()).map(r => new URL(r.url).pathname)
  check('cache survived', urls.join() === '/generated,/a.txt,/b.json' && (await (await caches.match('/generated')).text()) === 'made in phase 1' && (await (await c.match('/a.txt')).text()) === 'alpha\n', urls.join())
  // a database deleted again: databases() lists the one that stays
  const scratch = await new Promise((res, rej) => { const r = indexedDB.open('scratch', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  scratch.close()
  const del = await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('scratch'); r.onsuccess = (e) => res(e.oldVersion); r.onerror = () => rej(r.error) })
  const list = await indexedDB.databases()
  check('deleteDatabase and databases()', del === 1 && list.length === 1 && list[0].name === DB && list[0].version === VERSION, JSON.stringify(list))
}

async function everyRun(db) {
  check('features', typeof indexedDB === 'object' && typeof IDBKeyRange === 'function' && typeof caches === 'object' && typeof navigator.storage?.estimate === 'function')
  const e0 = __native.storage.epoch(); await later(); const e1 = __native.storage.epoch()
  check('the task epoch moves', e1 > e0, `${e0} -> ${e1}`)
  // promise wrappers (idb): requests made in microtasks of the creating task, and after each success, are in time
  let tx = db.transaction('saves'); const s = tx.objectStore('saves')
  await Promise.resolve(); await null
  const a = await req(s.get('slot1')), b = await req(s.get('blob'))
  check('active through microtasks', a !== undefined && b !== undefined)
  tx = db.transaction('saves'); const s2 = tx.objectStore('saves')
  await later()
  let inactive = ''; try { s2.get('slot1') } catch (e) { inactive = e.name }
  check('inactive after its task', inactive === 'TransactionInactiveError', inactive)
  tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put('temporary', 'temp'); tx.abort()
  await done(tx).catch(() => {})
  tx = db.transaction('saves')
  check('abort rolls back', (await req(tx.objectStore('saves').get('temp'))) === undefined)
  // another isolate on the same file
  tx = db.transaction('saves'); const before = (await req(tx.objectStore('saves').get('fromWorker')))?.runs ?? 0
  const w = new Worker('/worker.js')
  const reply = await Promise.race([new Promise((res) => { w.onmessage = (e) => res(e.data) }), later(10000).then(() => ({ ok: false, error: 'timeout' }))])
  w.terminate()
  check('a worker reads and writes the same database and caches', reply.ok && reply.level === 7 && reply.runs === before + 1 && reply.cache === 'made in phase 1', JSON.stringify(reply))
  tx = db.transaction('saves')
  check('the worker\'s write is seen', (await req(tx.objectStore('saves').get('fromWorker')))?.runs === before + 1)
  // put + commit, one awaited readwrite transaction each
  const payload = new Uint8Array(1024).fill(7), n = 50, t0 = performance.now()
  for (let i = 0; i < n; i++) { const t = db.transaction('saves', 'readwrite'); t.objectStore('saves').put(payload, 'bench'); await done(t) }
  const ms = (performance.now() - t0) / n
  log(`put + commit (1 KB, one awaited transaction each): ${ms.toFixed(3)} ms`)
  check('put + commit under 5 ms', ms < 5, ms.toFixed(3) + ' ms')
  // the quota: 8 MB in a 6 MB quota
  tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(new Uint8Array(8 << 20), 'huge')
  const qname = await new Promise((res) => { tx.onabort = () => res(tx.error?.name); tx.oncomplete = () => res('complete') })
  let cname = ''; try { await (await caches.open('v1')).put('/huge', new Response(new Uint8Array(8 << 20))) } catch (e) { cname = e.name }
  const est = await navigator.storage.estimate()
  check('quota: QuotaExceededError', qname === 'QuotaExceededError' && cname === 'QuotaExceededError' && est.quota === 6 << 20 && est.usage > 0 && est.usage < est.quota, `${qname} ${cname} ${est.usage}/${est.quota}`)
}

function paint(ok) {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => { gl.clearColor(ok ? 0.1 : 0.8, ok ? 0.7 : 0.1, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw) }
  draw()
}

try {
  if (typeof indexedDB === 'undefined' || typeof caches === 'undefined') throw new Error('no indexedDB / caches: host.json storage is off or the host was built without it')
  const phase = (await indexedDB.databases()).some(d => d.name === DB) ? 2 : 1
  log(`phase ${phase}`)
  const db = await openDb()
  if (phase === 1) await phase1(db); else await phase2(db)
  await everyRun(db)
} catch (e) { check('run', false, String(e?.stack ?? e)) }
const ok = results.length > 0 && results.every(Boolean)
log(`PASS ${results.filter(Boolean).length}/${results.length}`)
paint(ok)
log(ok ? 'READY' : 'FAILED')
