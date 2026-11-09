#!/usr/bin/env node
// compare.mjs a.png b.png [--tolerance 0.02]  → RMSE (0..1) via ImageMagick; exit 1 when over tolerance. Writes a diff next to a.
import { spawnSync } from 'node:child_process'
const [a, b] = process.argv.slice(2); const tol = +(process.argv[process.argv.indexOf('--tolerance') + 1] || 0.02)
const diff = a.replace(/\.png$/, '.diff.png')
const r = spawnSync('magick', ['compare', '-metric', 'RMSE', a, b, diff], { encoding: 'utf8' })
const m = /\(([\d.e-]+)\)/.exec(r.stderr); const rmse = m ? +m[1] : NaN
console.log(`RMSE ${isNaN(rmse) ? r.stderr.trim() : rmse.toFixed(4)} (tolerance ${tol}) diff: ${diff}`)
process.exit(!isNaN(rmse) && rmse <= tol ? 0 : 1)
