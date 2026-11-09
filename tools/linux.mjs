#!/usr/bin/env node
// linux.mjs <host.json> [--no-run] [--size WxH] [--fresh] [--app] [--port N] [--xr] [--angle]
// Experimental Linux host (host/linux/, WP-18): stages the assets exactly as pack.mjs stages the APK's, builds
// build-linux-host/webxrhost-linux and runs the game in a window with an emulated headset (controls in
// host/emu/emu.h). localStorage persists under build-linux-host/<package>/files; --fresh starts it empty.
// GL is the system's GLES 3.2 (Mesa or NVIDIA). LIBGL_ALWAYS_SOFTWARE=1 renders with llvmpipe (no GPU), and
// MESA_LOADER_DRIVER_OVERRIDE=zink runs Mesa's GL on Vulkan, which carries OVR_multiview2 (single-pass stereo).
// --xr builds and runs webxrhost-linux-xr instead: the Quest's OpenXR device on the system's OpenXR runtime
// (Monado, WiVRn; XR_MNDX_egl_enable), WP-18b.
// --angle builds against ANGLE on Vulkan (tools/setup-linux.sh --angle: Electron's libEGL/libGLESv2, the mac and
// win hosts' GL stack) in build-linux-angle/, for parity checks; HOST_ANGLE_DEVICE=swiftshader without a GPU.
// --app instead packages build-linux-app/<name>/ (and <name>-linux-<arch>.tar.gz): the binary, the V8 bottle's
// shared libraries and their Homebrew dependencies under lib/ (RUNPATH $ORIGIN, nothing reaching back into
// Homebrew), V8's ICU data, the assets, the icon, inspector off. Mesa, GLFW, curl and PulseAudio stay the
// system's. Saves and host.log live in $XDG_DATA_HOME/<package>.
// Needs tools/setup-linux.sh once (Homebrew V8, the distribution's dev packages, the shared sources).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gameArg, webrtcSwitch } from './game.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const cfgArg = gameArg(args)
const cfgPath = cfgArg && resolve(cfgArg)
if (!cfgPath) { console.error('usage: linux.mjs <host.json | game repo> [--no-run] [--size WxH] [--fresh] [--app] [--port N] [--xr] [--angle]'); process.exit(2) }
if (process.platform !== 'linux') { console.error('linux.mjs: Linux only'); process.exit(2) }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const pkg = cfg.app?.package ?? 'webxr-host', name = cfg.app?.name ?? 'webxr-host'
const app = flag('--app'), xr = flag('--xr'), angle = flag('--angle')
const target = xr ? 'webxrhost-linux-xr' : 'webxrhost-linux'
const build = join(root, (app ? 'build-linux-app' : angle ? 'build-linux-angle' : 'build-linux-host') + (app && angle ? '-angle' : ''))
const run = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', ...o }); if (r.status !== 0) process.exit(r.status ?? 1) }
const brewPrefix = (f) => { try { return execFileSync('brew', ['--prefix', f], { encoding: 'utf8' }).trim() } catch { return `/home/linuxbrew/.linuxbrew/opt/${f}` } }
const v8 = process.env.V8_PREFIX ?? brewPrefix('v8')

if (!existsSync(join(v8, 'lib/libv8.so')) || !existsSync(join(root, 'third_party/stb/stb_image.h')) || !existsSync(join(root, 'third_party/wamr/VERSION')) ||
    (angle && !existsSync(join(root, 'third_party/angle-linux/libGLESv2.so'))))
  run('bash', [join(root, 'tools/setup-linux.sh'), ...(angle ? ['--angle'] : [])])

// 1. assets, as pack.mjs stages the APK's
const assets = join(build, pkg, 'assets'), files = join(build, pkg, 'files')
run('node', [join(root, 'tools/pack.mjs'), cfgPath, '--stage', assets, '--host', 'linux'])
if (opt('--port')) { const f = join(assets, 'host.json'), m = JSON.parse(readFileSync(f, 'utf8')); m.debug = { ...m.debug, port: +opt('--port') }; writeFileSync(f, JSON.stringify(m, null, 2)) }

// 2. the executable
const webrtc = webrtcSwitch(cfg, build)  // host.json network.webrtc (WP-21; tools/game.mjs)
if (!existsSync(join(build, 'build.ninja')))
  run('cmake', ['-S', 'host', '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DV8_PREFIX=${v8}`, ...(xr ? ['-DHOST_LINUX_XR=ON'] : []), ...(angle ? ['-DHOST_LINUX_ANGLE=ON'] : []), webrtc.define])
else if (xr || webrtc.stale) run('cmake', [build, ...(xr ? ['-DHOST_LINUX_XR=ON'] : []), webrtc.define])
run('ninja', ['-C', build, target])
if (app) { packageApp(); process.exit(0) }
if (flag('--no-run')) { console.log(join(build, target)); process.exit(0) }
if (flag('--fresh')) rmSync(files, { recursive: true, force: true })
if (!xr) console.log(readFileSync(join(root, 'host/emu/emu.h'), 'utf8').split('desktop map (GLFW):')[1].split('namespace')[0].split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n').replace(/^\n+|\s+$/g, ''))
run(join(build, target), [assets, '--files', files, ...(opt('--size') ? ['--size', opt('--size')] : [])])

function packageApp() {
  const out = join(build, name), lib = join(out, 'lib')
  rmSync(out, { recursive: true, force: true }); mkdirSync(lib, { recursive: true })
  const exe = join(out, name)
  copyFileSync(join(build, target), exe); chmodSync(exe, 0o755)
  run('cp', ['-R', assets, join(out, 'assets')])  // not fs.cpSync: Node 26's native directory copy fails on some mounts (virtiofs: EACCES mid-copy)
  // A build to hand out carries no debugger: the inspector's /host bridge evaluates any JS it is sent.
  const manifest = join(out, 'assets/host.json'), m = JSON.parse(readFileSync(manifest, 'utf8'))
  m.debug = { ...m.debug, inspector: false }; writeFileSync(manifest, JSON.stringify(m, null, 2))
  copyFileSync(join(v8, 'libexec/icudtl.dat'), join(out, 'icudtl.dat'))  // emu/host_emu.cpp: <assets>/../icudtl.dat

  // Libraries: every object the loader resolves out of Homebrew (the V8 component libraries, ICU, glib), copied
  // once, each given RUNPATH $ORIGIN, the executable $ORIGIN/lib. The system's own (glibc, libstdc++, Mesa,
  // GLFW, curl, pulse, X11) stay out: they belong to the machine it runs on.
  const brew = dirname(dirname(v8))  // <prefix>/opt/v8 -> <prefix>
  const ldd = (f) => execFileSync('ldd', [f], { encoding: 'utf8' }).split('\n').map(l => l.match(/=>\s+(\S+)\s+\(/)?.[1]).filter(Boolean)
  const angleDir = join(root, 'third_party/angle-linux')
  const bundled = (p) => p.startsWith(brew) || p.startsWith(v8) || p.startsWith(angleDir + '/')
  const copied = new Set()
  for (const dep of ldd(join(build, target)).filter(bundled)) {
    const leaf = basename(dep); if (copied.has(leaf)) continue
    const dst = join(lib, leaf); copyFileSync(dep, dst); chmodSync(dst, 0o755); copied.add(leaf)
  }
  const patchelf = (a) => run('patchelf', a)
  for (const leaf of copied) patchelf(['--set-rpath', '$ORIGIN', join(lib, leaf)])
  patchelf(['--set-rpath', '$ORIGIN/lib', '--force-rpath', exe])  // DT_RPATH: the whole chain, as the build's
  // Every object in the bundle must resolve inside it: nothing left pointing into Homebrew or the checkout.
  const outside = (p) => bundled(p) || (p.startsWith(root + '/') && !p.startsWith(out + '/'))
  const leftovers = [exe, ...[...copied].map(l => join(lib, l))].flatMap(f => ldd(f).filter(outside).map(p => `${basename(f)} -> ${p}`))
  if (leftovers.length) { console.error('linux.mjs: the bundle still resolves outside itself:\n  ' + leftovers.join('\n  ')); process.exit(1) }
  if (angle) for (const f of ['libvulkan.so.1', 'libvk_swiftshader.so', 'vk_swiftshader_icd.json', 'LICENSES.chromium.html']) copyFileSync(join(angleDir, f), join(f.endsWith('.html') ? out : lib, f))
  if (cfg.app?.icon) copyFileSync(resolve(dirname(cfgPath), cfg.app.icon), join(out, 'icon.png'))
  const tgz = join(build, `${name}-linux-${arch() === 'arm64' ? 'arm64' : 'x64'}.tar.gz`); rmSync(tgz, { force: true })
  run('tar', ['-czf', tgz, '-C', build, name])
  console.log(`${out}  (${copied.size} libraries bundled)\n${tgz}`)
}
