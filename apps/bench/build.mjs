// Builds every scene under scenes/ (or the ones named) into dist/<scene>/: one self-contained page each, which
// Quest Browser loads from `npx vite preview`-style static serving and tools/pack.mjs packs through the
// scene's host.json (web.dist = ../../dist/<scene>).
import { build } from 'vite'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wanted = process.argv.slice(2)
const scenes = readdirSync(join(here, 'scenes')).filter((s) => existsSync(join(here, 'scenes', s, 'index.html')) && (!wanted.length || wanted.includes(s)))
for (const s of scenes) {
  await build({
    root: join(here, 'scenes', s), base: './', logLevel: 'warn',
    build: { outDir: join(here, 'dist', s), emptyOutDir: true, target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 4000 },
  })
  console.log(`built dist/${s}`)
}
