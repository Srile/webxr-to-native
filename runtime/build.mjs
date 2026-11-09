// Bundles runtime/src/index.js (the browser-surface prelude) into runtime/dist/host-runtime.js.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true })
for (const [entry, out] of [['./src/index.js', './dist/host-runtime.js'], ['./src/workers/worker-global.js', './dist/host-worker.js']]) await build({
  entryPoints: [new URL(entry, import.meta.url).pathname],
  bundle: true, format: 'iife', target: 'es2022', platform: 'neutral', mainFields: ['module', 'main'],
  outfile: new URL(out, import.meta.url).pathname,
  sourcemap: 'inline', legalComments: 'none', logLevel: 'info',
})
