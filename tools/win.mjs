#!/usr/bin/env node
// win.mjs <host.json> [--no-run] [--size WxH] [--fresh] [--app] [--cross] [--port N]
// Experimental Windows host (host/win/): stages the assets exactly as pack.mjs stages the APK's, builds
// build-win/webxrhost-win.exe and runs the game in a window with an emulated headset (controls in host/emu/emu.h).
// localStorage persists under build-win/<package>/files; --fresh starts it empty. HOST_ANGLE_DEVICE=warp renders
// with Direct3D's software rasteriser (a machine without a GPU).
// --app instead packages build-win-app/<name>/ (and <name>-win64.zip): a GUI-subsystem build, the V8 and ANGLE
// DLLs, V8's ICU data, the assets, the icon, inspector off, and the Visual C++ runtime DLLs when the build
// environment has them (VCToolsRedistDir); without those the target needs the VC++ 2015-2022 x64 redistributable.
// Saves and host.log live in %LOCALAPPDATA%\<package>.
// On Windows it needs Visual Studio 2022's C++ tools (found with vswhere when not already in a developer prompt),
// CMake and Ninja. On a Mac (--cross, the default there) it cross-compiles with clang-cl against the MSVC CRT and
// Windows SDK splatted by xwin (tools/win-cross.cmake) and never runs: build, and --app to package.
// Needs tools/setup-win.mjs once (V8, ANGLE, GLFW).
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gameArg } from './game.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const cfgArg = gameArg(args)
const cfgPath = cfgArg && resolve(cfgArg)
if (!cfgPath) { console.error('usage: win.mjs <host.json | game repo> [--no-run] [--size WxH] [--fresh] [--app] [--cross] [--port N]'); process.exit(2) }
const cross = flag('--cross') || process.platform !== 'win32'
if (cross && process.platform !== 'darwin') { console.error('win.mjs: builds on Windows, or cross-compiles on a Mac'); process.exit(2) }
const app = flag('--app')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const pkg = cfg.app?.package ?? 'webxr-host', name = cfg.app?.name ?? 'webxr-host'
const build = join(root, app ? 'build-win-app' : 'build-win')
let env = process.env
const run = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', env, ...o }); if (r.status !== 0) process.exit(r.status ?? 1) }

// Visual Studio's environment when this is not already a developer prompt (vswhere ships with the installer).
if (!cross && !env.VCToolsInstallDir) {
  const vswhere = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio\\Installer\\vswhere.exe')
  const vs = existsSync(vswhere) && execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  if (!vs) { console.error('win.mjs: Visual Studio 2022 with the C++ tools is needed (or run from a developer prompt)'); process.exit(1) }
  const vcvars = join(vs, 'VC\\Auxiliary\\Build\\vcvars64.bat')
  const dump = execFileSync('cmd.exe', ['/s', '/c', `"call "${vcvars}" >nul && set"`], { encoding: 'utf8', windowsVerbatimArguments: true })
  env = Object.fromEntries(dump.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

// The prebuilts (after the environment: their import libraries need VS's lib.exe, or llvm-lib).
if (!existsSync(join(root, 'third_party/v8-win/VERSION')) || !existsSync(join(root, 'third_party/angle-win/VERSION')) || !existsSync(join(root, 'third_party/glfw-win/VERSION')))
  run('node', [join(root, 'tools/setup-win.mjs')])

// 1. assets, as pack.mjs stages the APK's
const assets = join(build, pkg, 'assets'), files = join(build, pkg, 'files')
run('node', [join(root, 'tools/pack.mjs'), cfgPath, '--stage', assets, '--host', 'win'])
if (opt('--port')) { const f = join(assets, 'host.json'), m = JSON.parse(readFileSync(f, 'utf8')); m.debug = { ...m.debug, port: +opt('--port') }; writeFileSync(f, JSON.stringify(m, null, 2)) }

// 2. the executable (and, for --app, its icon)
let ico = ''
if (app && cfg.app?.icon) {
  ico = join(build, 'app.ico')
  try { mkdirSync(build, { recursive: true }); execFileSync('magick', [resolve(dirname(cfgPath), cfg.app.icon), '-define', 'icon:auto-resize=256,64,48,32,16', ico]) }
  catch { console.warn('win.mjs: ImageMagick (magick) not found: the executable gets no icon'); ico = '' }
}
if (cfg.network?.webrtc === true) console.warn('win: WebSocket and WebRTC (host.json network.webrtc) are not built for Windows yet; the page gets neither')
if (!existsSync(join(build, 'build.ninja')))
  run('cmake', ['-S', 'host', '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DHOST_WIN_CONSOLE=${app ? 'OFF' : 'ON'}`, `-DHOST_WIN_ICON=${ico.replace(/\\/g, '/')}`,
    ...(cross ? [`-DCMAKE_TOOLCHAIN_FILE=${join(root, 'tools/win-cross.cmake')}`] : [])])
run('ninja', ['-C', build, 'webxrhost-win'])
if (app) { packageApp(); process.exit(0) }
if (cross || flag('--no-run')) { console.log(`${join(build, 'webxrhost-win.exe')}${cross ? '  (cross-compiled: copy build-win/ to a Windows machine to run it)' : ''}`); process.exit(0) }
if (flag('--fresh')) rmSync(files, { recursive: true, force: true })
console.log(readFileSync(join(root, 'host/emu/emu.h'), 'utf8').split('desktop map (GLFW):')[1].split('namespace')[0].split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n').replace(/^\n+|\s+$/g, ''))
run(join(build, 'webxrhost-win.exe'), [assets, '--files', files, ...(opt('--size') ? ['--size', opt('--size')] : [])])

function packageApp() {
  const out = join(build, name)
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
  copyFileSync(join(build, 'webxrhost-win.exe'), join(out, `${name}.exe`))
  for (const dir of [join(root, 'third_party/v8-win/bin'), join(root, 'third_party/angle-win/bin')])
    for (const f of readdirSync(dir)) if (/\.(dll|dat)$/.test(f)) copyFileSync(join(dir, f), join(out, f))
  cpSync(assets, join(out, 'assets'), { recursive: true })
  // A build to hand out carries no debugger: the inspector's /host bridge evaluates any JS it is sent.
  const manifest = join(out, 'assets/host.json'), m = JSON.parse(readFileSync(manifest, 'utf8'))
  m.debug = { ...m.debug, inspector: false }; writeFileSync(manifest, JSON.stringify(m, null, 2))
  copyFileSync(join(root, 'third_party/angle-win/bin/LICENSES.chromium.html'), join(out, 'LICENSES.chromium.html'))
  // The Visual C++ runtime, app-local, when this build environment carries the redistributable.
  const redist = env.VCToolsRedistDir && join(env.VCToolsRedistDir, 'x64')
  const crt = redist && existsSync(redist) && readdirSync(redist).find(d => /^Microsoft\.VC\d+\.CRT$/.test(d))
  if (crt) for (const f of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) copyFileSync(join(redist, crt, f), join(out, f))
  else console.warn('win.mjs: no VCToolsRedistDir here: the target needs the Visual C++ 2015-2022 x64 redistributable')
  const zip = join(build, `${name}-win64.zip`); rmSync(zip, { force: true })
  // tar makes zips on Windows 10+ and macOS (bsdtar): -a picks the format from the name.
  run('tar', ['-a', '-c', '-f', zip, '-C', build, name])
  console.log(`${out}\n${zip}`)
}
