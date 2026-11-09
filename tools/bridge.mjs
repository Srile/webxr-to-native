#!/usr/bin/env node
// bridge.mjs eval '<expr>' | stats | shot <out.png> [--eye left|right] | tail [n] | forward
// Talks to the host's /host WebSocket endpoint (same port as the inspector, default 9229) through adb forward.
// HOST_LOCAL=1: a host on this machine (mac, win, the iOS simulator): no adb forward, which would take the port.
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adb = existsSync(join(root, 'tools/sdk/android/platform-tools/adb')) ? join(root, 'tools/sdk/android/platform-tools/adb') : 'adb'
const port = +(process.env.HOST_PORT ?? 9229)
const [cmd, ...rest] = process.argv.slice(2)
if (!process.env.HOST_LOCAL) try { execFileSync(adb, ['forward', `tcp:${port}`, `tcp:${port}`], { stdio: 'ignore' }) } catch {}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(port, '127.0.0.1'); let buf = Buffer.alloc(0); let upgraded = false
    const key = randomBytes(16).toString('base64')
    sock.on('connect', () => sock.write(`GET /host HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    sock.on('error', reject); sock.setTimeout(30000, () => reject(new Error('timeout')))
    sock.on('data', (d) => { buf = Buffer.concat([buf, d])
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; if (!buf.slice(0, i).toString().includes(' 101 ')) return reject(new Error(buf.slice(0, i).toString())); buf = buf.slice(i + 4); upgraded = true
        const payload = Buffer.from(JSON.stringify({ method, params })); const mask = randomBytes(4); const hdr = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 0xFE, payload.length >> 8, payload.length & 255]) : Buffer.concat([Buffer.from([0x81, 0xFF]), Buffer.from(new BigUint64Array([BigInt(payload.length)]).buffer).reverse()])
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3])); sock.write(Buffer.concat([hdr, mask, masked])) }
      if (buf.length < 2) return; let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + len) return; const text = buf.slice(off, off + len).toString(); sock.end()
      try { resolve(JSON.parse(text)) } catch { resolve(text) } })
  })
}
const out = (r) => console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
switch (cmd) {
  case 'eval': out(await rpc('eval', { expression: rest.join(' ') })); break
  case 'stats': out(await rpc('stats', {})); break
  case 'shot': { const eye = rest.includes('--eye') ? rest[rest.indexOf('--eye') + 1] : 'left'; const r = await rpc('shot', { eye }); if (r.png) { writeFileSync(rest[0], Buffer.from(r.png, 'base64')); console.log(`${rest[0]} ${r.width}x${r.height}`) } else out(r); break }
  case 'tail': out(await rpc('tail', { n: +rest[0] || 100 })); break
  case 'forward': console.log(`forwarded tcp:${port}`); break
  default: console.log('usage: bridge.mjs eval <expr> | stats | shot <out.png> [--eye left|right] | tail [n]')
}
