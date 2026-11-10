// hello-storage's worker: the page's database and caches from another isolate (its own SQLite connections). It reads
// the page's save, bumps its own run counter in the same transaction (requests chained through promises: the
// transaction stays active through the microtasks after each success here too), and reads the page's cache.
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error) })
async function run() {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('hello'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const tx = db.transaction('saves', 'readwrite'), s = tx.objectStore('saves')
  const slot = await req(s.get('slot1'))
  const prev = await req(s.get('fromWorker'))
  const runs = (prev?.runs ?? 0) + 1
  s.put({ runs, sawLevel: slot?.level }, 'fromWorker')
  await done(tx)
  db.close()
  const hit = await (await caches.open('v1')).match('/generated')
  return { ok: true, level: slot?.level, runs, cache: hit ? await hit.text() : null }
}
run().then((r) => postMessage(r), (e) => postMessage({ ok: false, error: String(e?.stack ?? e) }))
