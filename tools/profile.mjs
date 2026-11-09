#!/usr/bin/env node
// profile.mjs <seconds> [out.cpuprofile] [--top N] [--eval '<expr>']: a CPU profile of the host's main isolate
// over the inspector (CDP Profiler.*), summarised as self time per function and per file. Same port/forward
// rules as bridge.mjs (HOST_LOCAL=1 for a host on this machine, HOST_PORT). --eval runs an expression through
// the bridge first (a game's own debug hook) and waits 3 s before sampling. The host's inspector answers
// the WebSocket handshake itself (no Node WebSocket: it checks Sec-WebSocket-Key case-sensitively).
import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const pos = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')))
const seconds = Number(pos[0] ?? 10), out = pos[1], top = Number(opt('--top', 30))
const port = +(process.env.HOST_PORT ?? 9229)
const adb = process.env.ADB ?? join(dirname(fileURLToPath(import.meta.url)), 'sdk/android/platform-tools/adb')
if (!process.env.HOST_LOCAL) try { execFileSync(adb, ['forward', `tcp:${port}`, `tcp:${port}`], { stdio: 'ignore' }) } catch {}

function frame(payload) {
  const mask = randomBytes(4)
  const hdr = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 0xFE, payload.length >> 8, payload.length & 255]) : Buffer.concat([Buffer.from([0x81, 0xFF]), Buffer.from(new BigUint64Array([BigInt(payload.length)]).buffer).reverse()])
  return Buffer.concat([hdr, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))])
}

// One CDP session over a raw WebSocket: send(method, params) → result.
function cdp(path) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(port, '127.0.0.1'); let buf = Buffer.alloc(0); let upgraded = false; let id = 0
    const pending = new Map()
    const key = randomBytes(16).toString('base64')
    sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    sock.on('error', reject)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return
        if (!buf.slice(0, i).toString().includes(' 101 ')) return reject(new Error(buf.slice(0, i).toString()))
        buf = buf.slice(i + 4); upgraded = true
        resolve({ send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); sock.write(frame(Buffer.from(JSON.stringify({ id: n, method, params })))) }), close: () => sock.end() })
      }
      for (;;) {
        if (buf.length < 2) return
        let len = buf[1] & 127, off = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (buf.length < off + len) return
        const text = buf.slice(off, off + len).toString(); buf = buf.slice(off + len)
        let m; try { m = JSON.parse(text) } catch { continue }
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
      }
    })
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const bridge = (cmd, ...rest) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'bridge.mjs'), cmd, ...rest], { encoding: 'utf8', env: process.env }).stdout

const evalExpr = opt('--eval')
if (evalExpr) { process.stderr.write(bridge('eval', evalExpr)); await sleep(3000) }
const s = await cdp('/devtools/page/1')
await s.send('Profiler.enable')
await s.send('Profiler.setSamplingInterval', { interval: 200 })
await s.send('Profiler.start')
const statsBefore = bridge('stats')
await sleep(seconds * 1000)
const statsAfter = bridge('stats')
const { profile } = await s.send('Profiler.stop')
s.close()
if (out) writeFileSync(out, JSON.stringify(profile))

// Self time per node from the sample stream (timeDeltas are µs between consecutive samples).
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const self = new Map()
let total = 0
for (let i = 0; i < profile.samples.length; i++) { const dt = profile.timeDeltas[i] || 0; total += dt; self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt) }
const fnKey = (n) => { const f = n.callFrame; const file = (f.url || '').split('/').pop(); return `${f.functionName || '(anonymous)'} ${file}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}` }
const byFn = new Map(), byFile = new Map()
for (const [id, t] of self) { const n = byId.get(id); const k = fnKey(n); byFn.set(k, (byFn.get(k) || 0) + t); const file = (n.callFrame.url || '').split('/').pop() || `(${n.callFrame.functionName})`; byFile.set(file, (byFile.get(file) || 0) + t) }
const ms = (t) => (t / 1000).toFixed(1).padStart(8)
const pct = (t) => (100 * t / total).toFixed(1).padStart(5) + '%'
const js = (() => { try { return { before: JSON.parse(statsBefore), after: JSON.parse(statsAfter) } } catch { return null } })()
console.log(`profile: ${(total / 1e6).toFixed(1)} s sampled, ${profile.samples.length} samples` + (js ? `, jsMs ${js.before.jsMs} → ${js.after.jsMs}, fps ${js.after.fps}` : ''))
console.log('\nself time by file:')
for (const [k, t] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${ms(t)} ms ${pct(t)}  ${k}`)
console.log(`\nself time by function (top ${top}):`)
for (const [k, t] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms(t)} ms ${pct(t)}  ${k}`)
