#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)
// test.mjs [app ...] [--update] — pack, install, run, wait for READY, shot, compare with apps/<name>/expected.png.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2); const update = args.includes('--update')
const names = args.filter(a => !a.startsWith('--')); const apps = names.length ? names : readdirSync(join(root, 'apps')).filter(d => existsSync(join(root, 'apps', d, 'host.json')))
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const rows = []
for (const app of apps) {
  const dir = join(root, 'apps', app); const cfg = JSON.parse(require('node:fs').readFileSync(join(dir, 'host.json'), 'utf8'))
  console.log(`\n== ${app} ==`)
  let r = sh('node', [join(root, 'tools/pack.mjs'), join(dir, 'host.json'), '--install', '--run'], { stdio: 'inherit' })
  if (r.status !== 0) { rows.push([app, 'pack/install failed']); continue }
  const deadline = Date.now() + 90000; let ready = false
  while (Date.now() < deadline) { const log = sh('node', [join(root, 'tools/device.mjs'), 'tail', '400']).stdout; if (/READY|session FOCUSED|frames \d+\/s/.test(log)) { ready = true; break } if (/FATAL|host start failed|Uncaught/.test(log) && !/on purpose/.test(log)) break; spawnSync('node', ['-e', 'setTimeout(()=>{},1000)']) }
  if (!ready) { rows.push([app, 'did not reach READY (headset worn? see device.mjs tail)']); continue }
  spawnSync('node', ['-e', 'setTimeout(()=>{},2000)'])
  const shot = join(dir, 'last.png'); let s = sh('node', [join(root, 'tools/bridge.mjs'), 'shot', shot]); if (s.status !== 0) s = sh('node', [join(root, 'tools/device.mjs'), 'shot', shot])
  const expected = join(dir, 'expected.png')
  if (update || !existsSync(expected)) { copyFileSync(shot, expected); rows.push([app, update ? 'expected.png updated' : 'no expected.png: shot saved as baseline (REVIEW IT)']) }
  else { const c = sh('node', [join(root, 'tools/compare.mjs'), shot, expected, '--tolerance', String(cfg.test?.tolerance ?? 0.02)]); rows.push([app, c.status === 0 ? 'ok ' + c.stdout.trim() : 'DIFF ' + c.stdout.trim()]) }
  sh('node', [join(root, 'tools/device.mjs'), 'stop', cfg.app.package])
}
console.log('\n' + rows.map(([a, s]) => `${a.padEnd(16)} ${s}`).join('\n'))
process.exit(rows.some(r => !/^ok|updated|baseline/.test(r[1])) ? 1 : 0)
