// A fake __native for node tests of the prelude. Extend per test.
export function fakeNative(over = {}) {
  const timers = new Map(); let nextId = 1
  const now0 = Date.now()
  return {
    loop: {
      now: () => Date.now() - now0,
      setTimer: (ms, repeat, cb) => { const id = nextId++; const h = repeat ? setInterval(cb, ms) : setTimeout(cb, ms); timers.set(id, { h, repeat }); return id },
      clearTimer: (id) => { const t = timers.get(id); if (t) { (t.repeat ? clearInterval : clearTimeout)(t.h); timers.delete(id) } },
      postTask: (cb) => setImmediate(cb), onFrame: () => {}, exit: () => {},
    },
    assets: { read: () => null, readText: () => null, exists: () => false, mime: () => 'application/octet-stream' },
    net: { fetch: (m, u, h, b, cb) => cb(0, '', [], new ArrayBuffer(0), 'offline') },
    store: (() => { const m = new Map(); return { get: k => m.has(k) ? m.get(k) : null, set: (k, v) => { m.set(k, String(v)); return true }, remove: k => m.delete(k), clear: () => m.clear(), length: () => m.size, key: i => [...m.keys()][i] ?? null } })(),
    clone: (v) => structuredClone(v),
    log: (l, t) => {}, config: { web: { origin: 'https://app.local', entry: 'assets/index.js' } },
    info: { version: 'test', userAgent: 'webxr-host-test', systemName: 'test', package: 'test', filesDir: '/tmp' },
    gl: {}, img: {}, audio: {}, xr: { supported: () => false }, worker: {},
    ...over,
  }
}
