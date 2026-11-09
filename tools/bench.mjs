#!/usr/bin/env node
// bench.mjs <browser|host|both> <scene> [--n 300 | --ramp 100,1500,100] [--seconds 5] [--set k=v,k=v] [--pack] [--out f.json]
//
// Runs one of apps/bench/scenes/<scene> on the headset and prints its frame numbers (apps/bench/common/harness.js):
//   browser  Quest Browser loads apps/bench/dist/<scene>/ from a static server on this machine (adb reverse), the
//            session is entered over CDP (Runtime.evaluate with a user gesture), and __bench is driven over CDP.
//   host     the scene's APK (apps/bench/scenes/<scene>/host.json; --pack builds and installs it first) is started
//            and __bench is driven over tools/bridge.mjs eval.
//   both     browser, then host, then a side-by-side table.
// The other side is force-stopped first, so the two never share the GPU. The headset must be worn.
// Build the pages first: (cd apps/bench && npm run build).
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adb = existsSync(join(root, 'tools/sdk/android/platform-tools/adb')) ? join(root, 'tools/sdk/android/platform-tools/adb') : 'adb'
const args = process.argv.slice(2)
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const [mode, scene] = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')))
if (!['browser', 'host', 'both'].includes(mode) || !scene) { console.log('usage: bench.mjs <browser|host|both> <scene> [--n N | --ramp from,to,step] [--seconds S] [--set k=v,...] [--pack] [--out f.json]'); process.exit(2) }
const seconds = Number(opt('--seconds', 5))
const ramp = opt('--ramp') ? opt('--ramp').split(',').map(Number) : null
const n = opt('--n') ? Number(opt('--n')) : null
const extra = Object.fromEntries((opt('--set', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, isNaN(+v) ? v : +v] }))
const sceneDir = join(root, 'apps/bench/scenes', scene)
const hostCfg = JSON.parse(readFileSync(join(sceneDir, 'host.json'), 'utf8'))
const pkg = hostCfg.app.package
const PORT = 8090
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (...a) => { try { return execFileSync(adb, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } }

// One step = configure the scene for n, then sample it. Each runs in the page and parks its result on
// __bench.last; the driver polls. A ramp is a series of steps driven from here, each checked for a live session
// first (Quest Browser can drop one while a big step builds) and retried once.
const steps = ramp ? Array.from({ length: Math.floor((ramp[1] - ramp[0]) / (ramp[2] ?? 100)) + 1 }, (_, i) => ramp[0] + i * (ramp[2] ?? 100)) : [n]
const stepJob = (m) => `(() => { __bench.last = null; __bench.err = null; __bench.configure(${JSON.stringify({ ...extra, ...(m ? { n: m } : {}) })}).then(() => __bench.sample(${seconds})).then(r => { __bench.last = r }, e => { __bench.err = String(e && e.stack || e) }); return 'started' })()`
const pollJob = `JSON.stringify({ last: globalThis.__bench ? __bench.last : null, err: globalThis.__bench ? __bench.err : 'no __bench', xr: !!globalThis.__bench?.inXR })`
const held = (r) => r.droppedPct < 2 && r.fps >= 0.97 * r.hz

// The runtime's own once-a-second line (VrApi): CPU and GPU clocks. Both sides' numbers depend on them (the
// host raises its levels when it misses frames, xr.perf.adaptive; the browser has its own policy), so every
// step records the mean clocks over its sample window.
const vrapi = []
function startVrApi() {
  sh('logcat', '-c')
  const p = spawn(adb, ['logcat', '-s', 'VrApi', '-T', '1'], { stdio: ['ignore', 'pipe', 'ignore'] })
  p.stdout.on('data', (d) => { for (const l of d.toString().split('\n')) { const m = l.match(/CPU(\d)\/GPU=(\d+)\/(\d+),(\d+)\/(\d+)MHz/); if (m) vrapi.push({ t: Date.now(), cpuLvl: +m[1], cpuMHz: +m[4], gpuMHz: +m[5] }) } })
  return p
}
function clocks(t0, t1) {
  const w = vrapi.filter((v) => v.t >= t0 && v.t <= t1); if (!w.length) return {}
  const mean = (k) => Math.round(w.reduce((a, v) => a + v[k], 0) / w.length)
  return { cpuMHz: mean('cpuMHz'), gpuMHz: mean('gpuMHz'), cpuLvl: Math.max(...w.map((v) => v.cpuLvl)) }
}

async function runStep(evalJs, m, ensureXR) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureXR()
    await evalJs(stepJob(m))
    for (let i = 0; i < 45; i++) {
      await sleep(2000)
      const r = JSON.parse(await evalJs(pollJob))
      if (r.err) throw new Error(r.err)
      if (r.last && r.last.frames > 10) return { ...r.last, ...clocks(Date.now() - 2000 - seconds * 1000, Date.now() - 1000) }
      if (r.last || !r.xr) break  // no frames, or the session went away: again, once
    }
    console.log(`  n=${m}: no result${attempt ? '' : ', retrying'}`)
  }
  return { n: m, frames: 0, failed: true }
}
async function runJob(evalJs, ensureXR) {
  const rows = []
  for (const m of steps) {
    const r = await runStep(evalJs, m, ensureXR)
    rows.push(r)
    if (rows.length > 1 && !held(rows.at(-2)) && !held(r)) break  // two steps that missed the rate: done
  }
  return ramp ? { scene, rows } : rows[0]
}

// ---- Quest Browser over CDP -------------------------------------------------------------------------------------
function serveDist() {
  const dist = join(root, 'apps/bench/dist')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.ktx2': 'image/ktx2' }
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'
    const f = join(dist, p)
    if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(f))
  })
  return new Promise((r) => srv.listen(PORT, () => r(srv)))
}

async function cdpSession(url) {
  const tabs = (await (await fetch(url)).json()).filter((t) => t.type === 'page')
  return tabs
}

async function browserRun() {
  if (!existsSync(join(root, 'apps/bench/dist', scene, 'index.html'))) throw new Error(`apps/bench/dist/${scene} missing: (cd apps/bench && npm run build)`)
  for (const p of sh('shell', 'pm', 'list', 'packages', 'gg.dmnshd.webxrhost.bench').split('\n')) if (p.startsWith('package:')) sh('shell', 'am', 'force-stop', p.slice(8).trim())
  const srv = await serveDist()
  sh('reverse', `tcp:${PORT}`, `tcp:${PORT}`); sh('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote')
  const url = `http://localhost:${PORT}/${scene}/?offer=none`  // the driver requests the session itself (harness.js)
  sh('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, 'com.oculus.browser')
  let tab = null
  for (let i = 0; i < 60 && !tab; i++) {
    await sleep(1000)
    if (i === 20 || i === 40) { sh('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote'); sh('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, 'com.oculus.browser') }  // the browser may not have come up
    try { tab = (await cdpSession('http://localhost:9222/json')).find((t) => t.url.startsWith(url)) } catch {}
  }
  if (!tab) throw new Error('no Quest Browser tab on ' + url)
  // A fresh load each run (the tab may be an old one).
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0; const pending = new Map()
  const logs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 500))
  }
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
  const evalJs = async (expression, userGesture = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  await send('Runtime.enable')
  await send('Page.reload', { ignoreCache: true }); await sleep(3000)
  for (let i = 0; i < 60; i++) { if (await evalJs('!!(globalThis.__bench && __bench.ready)').catch(() => false)) break; await sleep(1000) }
  for (let i = 0; i < 20; i++) {
    if (await evalJs('!!globalThis.__bench?.inXR')) break
    await evalJs('__bench.enterXR()', true).catch(() => {}); await sleep(2000)
  }
  if (!(await evalJs('!!globalThis.__bench?.inXR'))) throw new Error('browser: no XR session (is the headset worn?)\n' + logs.slice(-20).join('\n'))
  await sleep(2000)
  const ensureXR = async () => {
    for (let i = 0; i < 15; i++) { if (await evalJs('!!globalThis.__bench?.inXR')) return; await evalJs('__bench.enterXR()', true).catch(() => {}); await sleep(2000) }
    throw new Error('browser: the XR session did not come back')
  }
  const res = await runJob(evalJs, ensureXR)
  ws.close(); srv.close()
  sh('shell', 'am', 'force-stop', 'com.oculus.browser')
  return { side: 'browser', ...res }
}

// ---- the host over the bridge -----------------------------------------------------------------------------------
function bridgeEval(expr) {
  const r = spawnSync(process.execPath, [join(root, 'tools/bridge.mjs'), 'eval', expr], { encoding: 'utf8' })
  const text = r.stdout.trim()
  let j; try { j = JSON.parse(text) } catch { throw new Error('bridge: ' + text + r.stderr) }
  if (j.error) throw new Error('bridge: ' + JSON.stringify(j.error))
  return j.value ?? j.result ?? j
}

async function hostRun() {
  sh('shell', 'am', 'force-stop', 'com.oculus.browser')
  if (args.includes('--pack')) {
    const r = spawnSync(process.execPath, [join(root, 'tools/pack.mjs'), join(sceneDir, 'host.json'), '--install'], { stdio: 'inherit' })
    if (r.status) throw new Error('pack failed')
  }
  // --glthread 0|1: the host's GL thread for this run (a system property the host reads at start, over host.json).
  if (opt('--glthread') !== undefined) sh('shell', 'setprop', 'debug.webxr.glthread', opt('--glthread'))
  sh('shell', 'setprop', 'debug.webxr.glpipeline', opt('--pipeline') ?? 'x')  // --pipeline 0|1: pipelined XR frames (gl.pipeline)
  // Every bench APK is stopped first: two would fight over the inspector port (9229) the bridge talks to.
  for (const p of sh('shell', 'pm', 'list', 'packages', 'gg.dmnshd.webxrhost.bench').split('\n')) if (p.startsWith('package:')) sh('shell', 'am', 'force-stop', p.slice(8).trim())
  await sleep(500)
  sh('shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1')
  for (let i = 0; i < 90; i++) { await sleep(1000); try { if (bridgeEval('!!(globalThis.__bench && __bench.ready && __bench.inXR)') === true) break } catch {} }
  if (bridgeEval('!!(globalThis.__bench && __bench.inXR)') !== true) throw new Error('host: the scene did not reach an XR session (is the headset worn?)')
  await sleep(2000)
  const ensureXR = async () => { for (let i = 0; i < 30; i++) { if (bridgeEval('!!globalThis.__bench?.inXR') === true) return; await sleep(1000) } throw new Error('host: no XR session') }
  const res = await runJob(async (e) => { const v = bridgeEval(e); return typeof v === 'string' ? v : JSON.stringify(v) }, ensureXR)
  let stats = null; try { stats = JSON.parse(spawnSync(process.execPath, [join(root, 'tools/bridge.mjs'), 'stats'], { encoding: 'utf8' }).stdout) } catch {}
  return { side: opt('--pipeline') === '1' ? 'host (gl thread, pipelined)' : opt('--glthread') === '1' ? 'host (gl thread)' : opt('--glthread') === '0' ? 'host (no gl thread)' : 'host', ...res, hostStats: stats }
}

// ---- output -----------------------------------------------------------------------------------------------------
const cols = ['n', 'draws', 'fps', 'droppedPct', 'intervalP50', 'intervalP99', 'jsP50', 'jsP90', 'jsP99', 'cpuMHz', 'gpuMHz']
const line = (r) => cols.map((c) => String(r[c] ?? '').padStart(c.length + 1)).join(' ')
// The knee: the largest n before the first step that missed the frame rate (97 % of it, under 2 % dropped).
function knee(res) {
  let k = null
  for (const r of res.rows ?? []) { if (held(r)) k = { n: r.n, draws: r.draws, jsP50: r.jsP50 }; else break }
  return k
}
function print(res) {
  if (res.rows) res.knee = knee(res)
  console.log(`\n${res.side}: ${scene}${res.knee ? `  knee n=${res.knee.n} (${res.knee.draws} draws, js p50 ${res.knee.jsP50} ms)` : ''}`)
  console.log(cols.map((c) => c.padStart(c.length + 1)).join(' '))
  for (const r of res.rows ?? [res]) console.log(line(r))
}

const results = []
const vrapiProc = startVrApi()
if (mode === 'browser' || mode === 'both') { const r = await browserRun(); print(r); results.push(r) }
if (mode === 'host' || mode === 'both') { const r = await hostRun(); print(r); results.push(r) }
vrapiProc.kill()
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(results, null, 2))
process.exit(0)
