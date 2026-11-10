// hello-sw (WP-27): service workers on the host (host.json web.serviceWorker). Run it twice: the first launch
// registers /sw.js and is claimed by it; the second must be controlled from its start, before any register().
//  - surface, controller at start (null on the first run, the saved worker afterwards), register + ready, claim
//  - fetch events: a synthetic answer, a passthrough of an asset, a request left to the normal path, a rejected
//    respondWith; an XHR, an <img>, a <script src> and a Worker script through the service worker
//  - messages both ways, a MessageChannel reply, clients.matchAll; scope rules, unregister / re-register
//  - the Cache API offline check, SKIP while the host has no caches
// The screen is green when all pass, red otherwise; the log says which and ends with READY.
const log = (m) => console.log('hello-sw: ' + m)
const startController = navigator.serviceWorker?.controller ?? null  // before anything registers
const run = +(localStorage.getItem('hello-sw-run') ?? 0) + 1; localStorage.setItem('hello-sw-run', String(run))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const skip = (name, why) => log(`SKIP ${name} (${why})`)
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(what + ' timed out')), ms))])
const sw = navigator.serviceWorker
const ask = (cmd, extra = {}) => timeout(new Promise((resolve) => {
  const on = (e) => { if (e.data?.cmd === cmd || (cmd === 'hi' && e.data?.cmd === 'echo')) { sw.removeEventListener('message', on); resolve(e) } }
  sw.addEventListener('message', on); sw.controller.postMessage({ cmd, ...extra })
}), 5000, `message ${cmd}`)

async function lifecycle() {
  check('surface', 'serviceWorker' in navigator && typeof ServiceWorkerRegistration === 'function' && isSecureContext)
  if (run === 1) check('first run: no controller at start', startController === null)
  else check(`run ${run}: controlled from the start`, startController?.state === 'activated' && startController.scriptURL === location.origin + '/sw.js', startController ? startController.state : 'null')
  sw.startMessages()
  const changed = new Promise((r) => sw.addEventListener('controllerchange', r, { once: true }))
  const reg = await sw.register('/sw.js')
  const ready = await timeout(sw.ready, 5000, 'ready')
  check('register + ready', ready === reg && reg.scope === location.origin + '/' && !!reg.active, reg.scope)
  if (!sw.controller) await timeout(changed, 5000, 'controllerchange')
  check('controller (clients.claim)', sw.controller?.scriptURL === location.origin + '/sw.js' && reg.active === sw.controller)
  if (reg.active.state !== 'activated') await timeout(new Promise((r) => reg.active.addEventListener('statechange', () => reg.active.state === 'activated' && r())), 5000, 'activated')
  check('register again: the same registration', (await sw.register('/sw.js')) === reg && (await sw.getRegistration()) === reg)
  let scopeErr = ''; try { await sw.register('/sub/sw2.js', { scope: '/' }) } catch (e) { scopeErr = e.name }
  check('max scope is the script directory', scopeErr === 'SecurityError', scopeErr)
}

async function fetches() {
  const a = await fetch('/sw/hello'); check('synthetic response', (await a.text()) === 'hello from the service worker' && a.headers.get('x-from') === 'sw')
  const b = await fetch('/data.json'); const j = await b.json(); check('passthrough of an asset', j.ok === true && j.from === 'assets')
  check('no respondWith: the normal path', (await (await fetch('/plain.txt')).text()).startsWith('plain text from the assets'))
  let rej = ''; try { await fetch('/sw/reject') } catch (e) { rej = e.constructor.name } check('rejected respondWith: a network error', rej === 'TypeError', rej)
  const x = new XMLHttpRequest(); x.open('GET', '/sw/xhr'); const xl = new Promise((r, j) => { x.onload = r; x.onerror = j }); x.send(); await timeout(xl, 5000, 'xhr')
  check('XMLHttpRequest intercepted', x.responseText === 'xhr from the service worker')
  const img = new Image(); const il = new Promise((r, j) => { img.onload = r; img.onerror = j }); img.src = '/pixel.png'; await timeout(il, 5000, 'image')
  check('image load intercepted', img.naturalWidth === 2 && img.naturalHeight === 2, `${img.naturalWidth}x${img.naturalHeight}`)
  const s = document.createElement('script'); const sl = new Promise((r, j) => { s.onload = r; s.onerror = j }); s.src = '/sw/script.js'; document.head.appendChild(s); await timeout(sl, 5000, 'script')
  check('<script src> from the service worker', globalThis.__helloSwScript === 42)
  const w = new Worker('/sw/worker.js'); const wm = new Promise((r) => { w.onmessage = (e) => r(e.data) }); w.postMessage(21)
  check('Worker script from the service worker', (await timeout(wm, 5000, 'worker')) === 42); w.terminate()
  const { data } = await ask('seen')
  const want = ['fetch /sw/xhr', 'image /pixel.png', 'script /sw/script.js', 'worker /sw/worker.js']
  check('the service worker saw each destination', want.every((k) => data.seen.includes(k)), data.seen.length + ' requests')
}

async function messages() {
  const e = await ask('hi', { n: run })
  check('message round trip', e.data.data?.n === run && e.source === sw.controller && e.origin === location.origin && e.data.state === 'activated')
  const ch = new MessageChannel(); const pong = new Promise((r) => { ch.port1.onmessage = (ev) => r(ev.data) })
  sw.controller.postMessage({ cmd: 'port', ping: 7 }, [ch.port2])
  check('MessageChannel reply', (await timeout(pong, 5000, 'port reply'))?.pong === 7)
  const c = (await ask('clients')).data
  check('clients.matchAll: this page', c.n === 1 && c.type === 'window' && c.url === location.href && c.me)
}

async function registrations() {
  const sub = await sw.register('/sub/sw2.js')
  if (!sub.active) await timeout(new Promise((r) => { const w = sub.installing ?? sub.waiting; w.addEventListener('statechange', () => w.state === 'activated' && r()) }), 5000, 'sub activated')
  const n = (await sw.getRegistrations()).length
  const u1 = await sub.unregister(), u2 = await sub.unregister(), n2 = (await sw.getRegistrations()).length
  const again = await sw.register('/sub/sw2.js'); const u3 = await again.unregister()
  check('unregister / re-register', sub.scope === location.origin + '/sub/' && n === 2 && u1 === true && u2 === false && n2 === 1 && again !== sub && u3 === true, `${n}/${u1}/${u2}/${n2}/${u3}`)
}

async function offline() {
  const inSW = (await ask('caches')).data.caches
  if (typeof caches === 'undefined' || !inSW) return skip('caches offline', `no Cache API in the ${typeof caches === 'undefined' ? 'page' : 'service worker'}`)
  const c = await caches.open('hello-sw'); await c.put('/sw-cache/offline.txt', new Response('from the cache'))
  check('caches offline', (await (await fetch('/sw-cache/offline.txt')).text()) === 'from the cache')
}

function paint(ok) {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => { gl.clearColor(ok ? 0.1 : 0.8, ok ? 0.7 : 0.1, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw) }
  draw()
}

log(`run ${run}`)
for (const [name, f] of [['lifecycle', lifecycle], ['fetches', fetches], ['messages', messages], ['registrations', registrations], ['offline', offline]]) {
  try { await f() } catch (e) { check(name, false, String(e?.stack ?? e)) }
}
const ok = results.length > 0 && results.every(Boolean)
log(`${ok ? 'PASS' : 'FAIL'} ${results.filter(Boolean).length}/${results.length}`)
paint(ok)
log(ok ? 'READY' : 'FAILED')
