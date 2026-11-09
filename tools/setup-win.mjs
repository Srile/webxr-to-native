#!/usr/bin/env node
// Experimental Windows host (host/win/): its third-party pieces, pinned here (versions and licences: THIRD_PARTY_NOTICES.md). Idempotent.
// Runs on Windows or, for cross-compiling with clang-cl (tools/win.mjs --cross), on a Mac.
//  - V8 13.0 for x64 (NuGet v8-v143-x64 + v8.redist-v143-x64, pmed/v8-nuget): headers, import libraries, DLLs,
//    icudtl.dat → third_party/v8-win/{include,lib,bin}. Built with pointer compression and the sandbox on.
//  - ANGLE (libEGL + libGLESv2 + d3dcompiler_47, GLES 3.0 on Direct3D 11) out of the same Electron release the
//    mac host takes it from → third_party/angle-win/bin, with import libraries made from the DLLs' export tables.
//  - GLFW 3.4 (the official Windows binaries, static lib-vc2022) → third_party/glfw-win/{include,lib}.
// Needs `tar` (Windows 10+ and macOS have it) and `llvm-lib` (LLVM; `lib` from Visual Studio also does) for the
// import libraries.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tp = join(root, 'third_party'); mkdirSync(tp, { recursive: true })
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const fail = (m) => { console.error(`  \x1b[31m✗\x1b[0m ${m}`); process.exit(1) }

const V8 = '13.0.245.25', ELECTRON = '37.2.0', GLFW = '3.4'
const pins = {
  v8: { url: `https://api.nuget.org/v3-flatcontainer/v8-v143-x64/${V8}/v8-v143-x64.${V8}.nupkg`, sha: 'ecc0c861324daa683dae32be3f6e517af9741b2174ce48a98999a5c3a1b902ed' },
  v8redist: { url: `https://api.nuget.org/v3-flatcontainer/v8.redist-v143-x64/${V8}/v8.redist-v143-x64.${V8}.nupkg`, sha: '6ae157305deb3e0136fc66e0d72df4904117d8fb2b10a6b492150e306ee61055' },
  electron: { url: `https://github.com/electron/electron/releases/download/v${ELECTRON}/electron-v${ELECTRON}-win32-x64.zip`, sha: '4d4451179993fa22a1125bbc0130858903bc16e5c87900a969fa7bbac5c8f6a3' },
  glfw: { url: `https://github.com/glfw/glfw/releases/download/${GLFW}/glfw-${GLFW}.bin.WIN64.zip`, sha: '54efa829400f2a0537f742b2b3bdd74e437bb4f2f048e4b7d3c5557d11a611e6' },
}

async function fetchPinned(name) {
  const { url, sha } = pins[name], file = join(tp, basename(new URL(url).pathname))
  if (!existsSync(file)) {
    console.log(`[setup-win] download ${url}`)
    const r = await fetch(url); if (!r.ok) fail(`${url}: HTTP ${r.status}`)
    writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer())); renameSync(file + '.part', file)
  }
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha) fail(`checksum mismatch: ${file}`)
  return file
}
// A zip's entries (or all of it) into dir; tar reads zips on Windows 10+ and macOS alike.
function unzip(zip, dir, entries = []) { mkdirSync(dir, { recursive: true }); execFileSync('tar', ['-xf', zip, '-C', dir, ...entries]) }
const current = (dir, v) => existsSync(join(dir, 'VERSION')) && readFileSync(join(dir, 'VERSION'), 'utf8').trim() === v

// An import library for a DLL: its export names from the PE export table, as a .def, through llvm-lib (or lib).
function exportsOf(dll) {
  const b = readFileSync(dll), pe = b.readUInt32LE(0x3c), opt = pe + 24, magic = b.readUInt16LE(opt)
  const dirs = opt + (magic === 0x20b ? 112 : 96), expRva = b.readUInt32LE(dirs)
  const nSec = b.readUInt16LE(pe + 6), secs = opt + b.readUInt16LE(pe + 20)
  const off = (rva) => { for (let i = 0; i < nSec; i++) { const s = secs + i * 40, va = b.readUInt32LE(s + 12), size = b.readUInt32LE(s + 16); if (rva >= va && rva < va + Math.max(size, b.readUInt32LE(s + 8))) return rva - va + b.readUInt32LE(s + 20) } fail(`${dll}: bad RVA`) }
  const e = off(expRva), n = b.readUInt32LE(e + 24), names = off(b.readUInt32LE(e + 32)), out = []
  for (let i = 0; i < n; i++) { let p = off(b.readUInt32LE(names + i * 4)), q = p; while (b[q]) q++; out.push(b.toString('latin1', p, q)) }
  return out
}
function importLib(dll, lib) {
  const def = lib.replace(/\.lib$/, '.def')
  writeFileSync(def, `LIBRARY ${basename(dll)}\nEXPORTS\n${exportsOf(dll).map(s => `  ${s}`).join('\n')}\n`)
  const tools = [process.env.LLVM_LIB, 'llvm-lib', '/opt/homebrew/opt/llvm/bin/llvm-lib', 'lib'].filter(Boolean)
  for (const t of tools) {
    const r = spawnSync(t, [`/def:${def}`, '/machine:x64', `/out:${lib}`], { stdio: 'ignore' })
    if (r.status === 0) return
  }
  fail(`no llvm-lib or lib to make ${basename(lib)} (install LLVM, or run from a Visual Studio prompt)`)
}

// V8
{
  const dir = join(tp, 'v8-win')
  if (!current(dir, `v8 ${V8}`)) {
    const [pkg, redist] = [await fetchPinned('v8'), await fetchPinned('v8redist')]
    const tmp = dir + '.tmp'; rmSync(tmp, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
    unzip(pkg, join(tmp, 'pkg')); unzip(redist, join(tmp, 'redist'))
    mkdirSync(join(dir, 'bin'), { recursive: true }); mkdirSync(join(dir, 'lib'))
    cpSync(join(tmp, 'pkg/include'), join(dir, 'include'), { recursive: true })
    for (const f of readdirSync(join(tmp, 'pkg/lib/Release'))) copyFileSync(join(tmp, 'pkg/lib/Release', f), join(dir, 'lib', f))
    for (const f of readdirSync(join(tmp, 'redist/lib/Release'))) copyFileSync(join(tmp, 'redist/lib/Release', f), join(dir, 'bin', f))
    rmSync(tmp, { recursive: true, force: true }); writeFileSync(join(dir, 'VERSION'), `v8 ${V8}\n`)
  }
  ok(`v8 ${V8} (${dir})`)
}

// ANGLE
{
  const dir = join(tp, 'angle-win')
  if (!current(dir, `electron ${ELECTRON}`)) {
    const zip = await fetchPinned('electron')
    rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'lib'), { recursive: true })
    unzip(zip, join(dir, 'bin'), ['libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll', 'LICENSES.chromium.html'])
    importLib(join(dir, 'bin/libEGL.dll'), join(dir, 'lib/libEGL.lib'))
    importLib(join(dir, 'bin/libGLESv2.dll'), join(dir, 'lib/libGLESv2.lib'))
    writeFileSync(join(dir, 'VERSION'), `electron ${ELECTRON}\n`)
  }
  ok(`angle (electron ${ELECTRON}, ${dir})`)
}

// GLFW
{
  const dir = join(tp, 'glfw-win')
  if (!current(dir, `glfw ${GLFW}`)) {
    const zip = await fetchPinned('glfw'), top = `glfw-${GLFW}.bin.WIN64`
    const tmp = dir + '.tmp'; rmSync(tmp, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
    unzip(zip, tmp, [`${top}/include`, `${top}/lib-vc2022/glfw3.lib`, `${top}/LICENSE.md`])
    mkdirSync(join(dir, 'lib'), { recursive: true })
    cpSync(join(tmp, top, 'include'), join(dir, 'include'), { recursive: true })
    copyFileSync(join(tmp, top, 'lib-vc2022/glfw3.lib'), join(dir, 'lib/glfw3.lib')); copyFileSync(join(tmp, top, 'LICENSE.md'), join(dir, 'LICENSE.md'))
    rmSync(tmp, { recursive: true, force: true }); writeFileSync(join(dir, 'VERSION'), `glfw ${GLFW}\n`)
  }
  ok(`glfw ${GLFW} (${dir})`)
}
