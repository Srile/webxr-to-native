#!/usr/bin/env node
// mac.mjs <host.json> [--no-run] [--size WxH] [--fresh] [--app]
// Experimental desktop host (host/mac/): stages the assets exactly as pack.mjs stages the APK's, builds
// build-mac-host/webxrhost-mac and runs the game in a window with an emulated headset (controls in
// host/emu/emu.h). localStorage persists under build-mac-host/<package>/files; --fresh starts it empty.
// --app instead packages build-mac-host/<name>.app: the binary, every non-system library it loads (V8 and
// its parts, GLFW, ANGLE) repointed at Contents/Frameworks, V8's ICU data, the assets and the icon, ad-hoc
// signed, inspector off. It runs on any Apple-silicon Mac without Homebrew; its saves live in ~/Library/Application Support.
// Needs tools/setup-mac.sh once (Homebrew V8 + GLFW, ANGLE out of a pinned Electron).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gameArg, webrtcSwitch, microphoneSwitch, storageSwitch } from './game.mjs'
import { appVersion } from './app-version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const cfgArg = gameArg(args)
const cfgPath = cfgArg && resolve(cfgArg)  // child steps run from the repo root
if (!cfgPath) { console.error('usage: mac.mjs <host.json | game repo> [--no-run] [--size WxH] [--fresh] [--app]'); process.exit(2) }
if (process.platform !== 'darwin') { console.error('mac.mjs: macOS only'); process.exit(2) }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const pkg = cfg.app?.package ?? 'webxr-host'
const build = join(root, 'build-mac-host')
const run = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', ...o }); if (r.status !== 0) process.exit(r.status ?? 1) }

if (!existsSync(join(root, 'third_party/angle-mac/libGLESv2.dylib'))) run('bash', [join(root, 'tools/setup-mac.sh')])
const assets = join(build, pkg, 'assets'), files = join(build, pkg, 'files')
run('node', [join(root, 'tools/pack.mjs'), cfgPath, '--stage', assets, '--host', 'mac'])
// WebSocket + WebRTC data channels only for a game that asks (host.json network.webrtc, WP-21; tools/game.mjs).
const webrtc = webrtcSwitch(cfg, build)
// Microphone capture only for a game that asks (host.json media.microphone, WP-25). Unbundled, macOS asks the
// terminal app this runs from for the microphone; an --app bundle asks in its own name (NSMicrophoneUsageDescription).
const mic = microphoneSwitch(cfg, build)
const storage = storageSwitch(cfg, build)  // IndexedDB + Cache API (host.json storage, WP-26)
if (!existsSync(join(build, 'build.ninja')) || webrtc.stale || mic.stale || storage.stale) run('cmake', ['-S', 'host', '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', webrtc.define, mic.define, storage.define])
run('ninja', ['-C', build, 'webxrhost-mac'])
if (flag('--app')) { packageApp(); process.exit(0) }
if (flag('--no-run')) process.exit(0)
if (flag('--fresh')) rmSync(files, { recursive: true, force: true })
console.log(readFileSync(join(root, 'host/emu/emu.h'), 'utf8').split('desktop map (GLFW):')[1].split('namespace')[0].split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n').replace(/^\n+|\s+$/g, ''))
run(join(build, 'webxrhost-mac'), [assets, '--files', files, ...(opt('--size') ? ['--size', opt('--size')] : [])])

function packageApp() {
  const name = cfg.app?.name ?? 'webxr-host', version = appVersion(cfg, cfgPath)
  const app = join(build, `${name}.app`), contents = join(app, 'Contents')
  const macos = join(contents, 'MacOS'), fw = join(contents, 'Frameworks'), res = join(contents, 'Resources')
  rmSync(app, { recursive: true, force: true })
  for (const d of [macos, fw, res]) mkdirSync(d, { recursive: true })
  const exe = join(macos, 'webxrhost-mac')
  copyFileSync(join(build, 'webxrhost-mac'), exe)
  cpSync(assets, join(res, 'assets'), { recursive: true })
  // A build to hand out carries no debugger: the inspector's /host bridge evaluates any JS it is sent.
  const manifest = join(res, 'assets/host.json'), m = JSON.parse(readFileSync(manifest, 'utf8'))
  m.debug = { ...m.debug, inspector: false }; writeFileSync(manifest, JSON.stringify(m, null, 2))
  copyFileSync('/opt/homebrew/opt/v8/libexec/icudtl.dat', join(res, 'icudtl.dat'))
  // ANGLE's licences (Chromium's credits, from the Electron release it comes out of), beside the assets'
  // THIRD_PARTY_NOTICES.txt (pack.mjs)
  const chromiumLicences = join(root, 'third_party/angle-mac/LICENSES.chromium.html')
  if (existsSync(chromiumLicences)) copyFileSync(chromiumLicences, join(res, 'LICENSES.chromium.html'))
  else console.warn('mac.mjs: third_party/angle-mac/LICENSES.chromium.html missing (tools/setup-mac.sh extracts it): the .app ships ANGLE without its licences')

  // Libraries: walk the load commands from the binary down, copy each non-system dylib once, give it an
  // @rpath id and point every reference at that. @rpath references resolve against the build's search paths.
  const search = [join(root, 'third_party/angle-mac'), '/opt/homebrew/opt/v8/libexec', '/opt/homebrew/opt/v8/lib', '/opt/homebrew/lib']
  const otool = (f) => execFileSync('otool', ['-L', f], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.trim().split(' (')[0]).filter(Boolean)
  const locate = (ref) => {
    if (!ref.startsWith('@rpath/')) return ref
    const leaf = ref.slice(7); const hit = search.map(d => join(d, leaf)).find(existsSync)
    if (!hit) { console.error(`mac.mjs: cannot find ${ref}`); process.exit(1) }
    return hit
  }
  const system = (ref) => ref.startsWith('/System/') || ref.startsWith('/usr/lib/')
  const copied = new Map()  // leaf -> bundled path
  const fix = (file, isExe) => {
    for (const ref of otool(file)) {
      if (system(ref)) continue
      const leaf = basename(ref)
      if (!isExe && leaf === basename(file)) continue  // the library's own id
      if (!copied.has(leaf)) {
        const dst = join(fw, leaf); copyFileSync(locate(ref), dst); chmodSync(dst, 0o755); copied.set(leaf, dst)
        execFileSync('install_name_tool', ['-id', `@rpath/${leaf}`, dst], { stdio: 'ignore' })
        fix(dst, false)
      }
      if (ref !== `@rpath/${leaf}`) execFileSync('install_name_tool', ['-change', ref, `@rpath/${leaf}`, file], { stdio: 'ignore' })
    }
  }
  fix(exe, true)
  // The build's rpaths point into Homebrew and the checkout: the bundle answers only to its own Frameworks.
  // dyld searches the rpaths of every image in the load chain, so the executable's one entry serves the libraries
  // too; theirs are dropped where they point outside the bundle (Homebrew's own copies must never win).
  const rpaths = (f) => execFileSync('otool', ['-l', f], { encoding: 'utf8' }).split('\n').map(l => l.trim()).filter(l => l.startsWith('path ')).map(l => l.slice(5).split(' (offset')[0])
  for (const p of rpaths(exe)) execFileSync('install_name_tool', ['-delete_rpath', p, exe], { stdio: 'ignore' })
  execFileSync('install_name_tool', ['-add_rpath', '@executable_path/../Frameworks', exe], { stdio: 'ignore' })
  for (const lib of copied.values()) for (const p of rpaths(lib)) if (!p.startsWith('@')) execFileSync('install_name_tool', ['-delete_rpath', p, lib], { stdio: 'ignore' })

  // Icon: app.icon (as pack.mjs uses it) through an iconset.
  let icon = ''
  if (cfg.app?.icon) {
    const src = resolve(dirname(cfgPath), cfg.app.icon), set = join(build, 'AppIcon.iconset')
    rmSync(set, { recursive: true, force: true }); mkdirSync(set)
    for (const px of [16, 32, 128, 256, 512]) {
      execFileSync('magick', [src, '-resize', `${px}x${px}`, join(set, `icon_${px}x${px}.png`)])
      execFileSync('magick', [src, '-resize', `${px * 2}x${px * 2}`, join(set, `icon_${px}x${px}@2x.png`)])
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', join(res, 'AppIcon.icns')]); rmSync(set, { recursive: true }); icon = 'AppIcon'
  }
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${pkg}.desktop</string>
  <key>CFBundleExecutable</key><string>webxrhost-mac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleIconFile</key><string>${icon}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>${mic.on ? `
  <key>NSMicrophoneUsageDescription</key><string>${name} uses the microphone when the page asks for it.</string>` : ''}
</dict></plist>
`)
  run('codesign', ['--force', '--deep', '--sign', '-', app])
  const leftovers = [exe, ...copied.values()].flatMap(f => otool(f).filter(r => r.includes('/opt/homebrew') || r.includes(root)))
  if (leftovers.length) { console.error('mac.mjs: the bundle still references outside paths:\n  ' + leftovers.join('\n  ')); process.exit(1) }
  console.log(`${app}  (${copied.size} libraries bundled; open it, or: open "${app}")`)
}
