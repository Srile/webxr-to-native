// IndexedDB and the Cache API (WP-26) over __native.storage (host/storage/storage_bind.cpp, SQLite), installed only
// when the host was built with them and host.json asks (storage.indexedDB, storage.cache): otherwise indexedDB, the
// IDB* classes, caches, Cache and CacheStorage stay absent, so feature detection takes its no-storage path. The page
// (index.js), dedicated workers (workers/worker-global.js) and any other worker-like global call install(g): it needs
// the fetch classes (Request, Response, Headers, Blob, File, fetch), EventTarget, Event and DOMException on g, and
// g.__native.loop.postTask / now and g.__native.storage, nothing of the window.
import { installIndexedDB } from './idb.js'
import { installCaches } from './cache.js'

export function install(g) {
  const N = g.__native, S = N?.storage
  if (!S?.features) return
  // Blobs and Files in stored values (localforage stores Blobs): the native clone keeps them (storage_bind.cpp).
  if (g.Blob) S.setBlobHooks(g.Blob.prototype, g.File?.prototype ?? Object.create(null))
  if (S.features.indexedDB) installIndexedDB(g, S)
  if (S.features.cache) installCaches(g, S)
  // navigator.storage with what the files hold (the files of this origin under the app's data directory) and the
  // quota host.json gives (storage.quotaMB); app storage is never evicted, so it is persistent.
  const quota = S.quota || 2 ** 40
  const storage = {
    estimate: () => new Promise((resolve, reject) => N.loop.postTask(() => { try { resolve({ usage: S.usage(), quota }) } catch (e) { reject(e) } })),
    persist: () => Promise.resolve(true),
    persisted: () => Promise.resolve(true),
  }
  if (g.navigator) g.navigator.storage = storage
}
