#!/usr/bin/env node
// check.mjs [--save <host.png>] [--tolerance 2]
// Compares what a running hello-canvas drew (its 2D canvas, pulled through the debug bridge) with Chrome's render of
// the same page (chrome.png, next to this file), cell by cell: the mean absolute difference of each 128 px cell,
// 0..255. Exit 1 when a cell is over the tolerance. The text cell is only reported: the faces differ by platform.
//   mac host:  node tools/mac.mjs apps/hello-canvas/host.json &   then   HOST_LOCAL=1 node apps/hello-canvas/check.mjs
//   device:    node tools/pack.mjs apps/hello-canvas/host.json --install --run   then   node apps/hello-canvas/check.mjs
// chrome.png is made with:
//   chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,768 \
//     --allow-file-access-from-files --virtual-time-budget=3000 --screenshot=chrome.png file://$PWD/www/index.html
// Needs ImageMagick (magick), as tools/compare.mjs does.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '../..')
const args = process.argv.slice(2)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const tolerance = +(opt('--tolerance') ?? 2)
const W = 1024, H = 768, CELL = 128, PAGE = '#1d2630', TEXT_CELL = 4
const port = process.env.HOST_PORT ?? String(JSON.parse(readFileSync(join(here, 'host.json'), 'utf8')).debug.port)
const bridge = (expr) => JSON.parse(execFileSync('node', [join(root, 'tools/bridge.mjs'), 'eval', expr], { encoding: 'utf8', env: { ...process.env, HOST_PORT: port }, maxBuffer: 64 << 20 })).result

if (bridge('String(globalThis.__panelDone)') !== 'true') { console.error('hello-canvas has not finished drawing (is it running? HOST_LOCAL=1 for a host on this machine)'); process.exit(2) }
const url = bridge('__panel.toDataURL()')
const dir = mkdtempSync(join(tmpdir(), 'hello-canvas-'))
const hostPng = opt('--save') ?? join(dir, 'host.png')
writeFileSync(hostPng, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
// Both pictures as raw RGB over the page colour (the canvas has transparent pixels; Chrome's screenshot shows the page through them).
const rgb = (png) => execFileSync('magick', [png, '-background', PAGE, '-alpha', 'remove', '-alpha', 'off', '-depth', '8', 'rgb:-'], { maxBuffer: 64 << 20 })
const a = rgb(join(here, 'chrome.png')), b = rgb(hostPng)
rmSync(dir, { recursive: true, force: true })
if (a.length !== W * H * 3 || b.length !== W * H * 3) { console.error(`unexpected picture size (${a.length} and ${b.length} bytes, want ${W * H * 3})`); process.exit(2) }

let worst = 0, bad = 0
for (let cy = 0; cy < H / CELL; cy++) {
  const row = []
  for (let cx = 0; cx < W / CELL; cx++) {
    let sum = 0
    for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) { const i = (y * W + x) * 3; sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) }
    const mean = sum / (CELL * CELL * 3), index = cy * (W / CELL) + cx
    if (index !== TEXT_CELL) { worst = Math.max(worst, mean); if (mean > tolerance) bad++ }
    row.push((index === TEXT_CELL ? '(' : mean > tolerance ? '!' : ' ') + mean.toFixed(1).padStart(5) + (index === TEXT_CELL ? ')' : ' '))
  }
  console.log(row.join(''))
}
const log = bridge('JSON.stringify((globalThis.__panelErrors || []))')
if (log !== '[]') console.log('page errors: ' + log)
console.log(bad || log !== '[]' ? `DIFF: ${bad} cell(s) over ${tolerance}, worst ${worst.toFixed(1)}` : `ok: every cell within ${tolerance} of Chrome (worst ${worst.toFixed(1)})`)
process.exit(bad || log !== '[]' ? 1 : 0)
