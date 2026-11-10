// Bundles runtime/src/index.js (the browser-surface prelude) into runtime/dist/host-runtime.js and the worker
// prelude into host-worker.js. By default readable, with an inline source map (the inspector shows runtime/src).
// --min (tools/pack.mjs --release): whitespace and syntax minified, no source map, identifiers kept, so a page's
// `constructor.name` checks and the host's stack traces still read as the source does; 0.4 MB instead of 2.6.
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rewriteUnicodeEscapes } from '../tools/unicode-regex.mjs'
const min = process.argv.includes('--min')
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true })
// The stock Android V8 (no ICU) rejects a Unicode property escape (\\p{...}) as a SyntaxError while it parses the
// bundle, so one regex literal anywhere in it (storage/keys.js's identifier check) stops every game from booting,
// whatever its switches. Each module is spelled out as it is loaded (tools/unicode-regex.mjs; pack.mjs does the same
// for the page's own JavaScript): on the readable source, which the rewrite's scanner reads reliably (a minified
// bundle it can misread), and the bundle is checked for any escape left.
const unicodeEscapes = { name: 'unicode-escapes', setup(b) {
  b.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
    const src = readFileSync(args.path, 'utf8'); if (!/\\[pP]\{/.test(src)) return undefined
    return { contents: rewriteUnicodeEscapes(src).src, loader: 'js' }
  })
} }
// host-sw.js: the service-worker prelude (WP-27), staged by tools/pack.mjs only for host.json web.serviceWorker.
for (const [entry, out] of [['./src/index.js', './dist/host-runtime.js'], ['./src/workers/worker-global.js', './dist/host-worker.js'], ['./src/serviceworker/sw-global.js', './dist/host-sw.js']]) {
  const outfile = fileURLToPath(new URL(out, import.meta.url))
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, format: 'iife', target: 'es2022', platform: 'neutral', mainFields: ['module', 'main'], plugins: [unicodeEscapes],
    outfile, sourcemap: min ? false : 'inline', minifyWhitespace: min, minifySyntax: min, legalComments: 'none', logLevel: 'info',
  })
  const left = (readFileSync(outfile, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '').match(/\\[pP]\{/g) ?? []).length
  if (left) { console.error(`${out.slice(7)}: ${left} Unicode property escape(s) left: the Android V8 would not parse it`); process.exit(1) }
}
