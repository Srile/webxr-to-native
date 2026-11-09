#!/usr/bin/env node
// ios.mjs <host.json> [--vision] [--device] [--sim <name|udid>] [--no-run] [--console] [--fresh] [--port N]
// Experimental iOS host (host/ios/): stages the assets exactly as pack.mjs stages the APK's, builds the app with
// CMake (CMAKE_SYSTEM_NAME=iOS) and finishes the bundle: assets, V8's ICU data (or its framework), the icon,
// signing. Then it installs and launches it on a simulator (the booted one, else --sim, else the newest iPhone)
// or, with --device, on a connected iPhone/iPad. The emulated headset is driven by touch (host/ios/host_view.h).
//   --vision    the same app for visionOS (CMAKE_SYSTEM_NAME=visionOS, xros/xrsimulator SDK, the xros V8 slice):
//               a flat window on the Apple Vision Pro simulator (WP-17's 17a spike), build-vision[-sim]/
//   --console   launch attached: the host's log in this terminal (otherwise it is host.log in the app's
//               Library/Application Support, which `xcrun simctl get_app_container <udid> <id> data` locates)
//   --fresh     uninstall first: localStorage starts empty
//   --port N    the inspector/bridge port (debug.port); a simulator app shares this Mac's loopback, so it must
//               not be one adb forward holds. Bridge it with HOST_LOCAL=1 HOST_PORT=N node tools/bridge.mjs ...
// Device builds need a signing identity and a provisioning profile for the bundle id:
//   IOS_SIGN_IDENTITY="Apple Development: ..." IOS_PROFILE=path/to.mobileprovision node tools/ios.mjs <cfg> --device
// The bundle id is ios.bundleId in host.json, else app.package. Needs tools/setup-ios.sh (WAMR, ANGLE) and
// tools/setup-v8-apple.sh (V8 from source, static, per slice) once; without the latter the iOS build falls back to
// the npm v8-ios framework. V8 runs jitless here; WebAssembly is WAMR's interpreter (host/js/wasm_interp.cpp).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gameArg } from './game.mjs'
import { simRooms } from './sim-rooms.mjs'
import { appVersion } from './app-version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const cfgArg = gameArg(args)
const cfgPath = cfgArg && resolve(cfgArg)
if (!cfgPath) { console.error('usage: ios.mjs <host.json | game repo> [--vision] [--device] [--sim <name|udid>] [--no-run] [--console] [--fresh] [--port N]'); process.exit(2) }
if (process.platform !== 'darwin') { console.error('ios.mjs: macOS only (Xcode)'); process.exit(2) }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const device = flag('--device'), vision = flag('--vision')
const os = vision ? 'vision' : 'ios'
const name = cfg.app?.name ?? 'webxr-host', version = appVersion(cfg, cfgPath)
const bundleId = cfg.ios?.bundleId ?? cfg.app?.package
if (!bundleId) { console.error(`${cfgPath}: neither ios.bundleId nor app.package is set (the app's bundle identifier)`); process.exit(2) }
const build = join(root, `build-${os}${device ? '' : '-sim'}`)
const v8Slice = `${vision ? 'xr' : 'ios'}${device ? (vision ? 'os' : '') : 'sim'}-arm64`  // tools/setup-v8-apple.sh's slice names
const run = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', ...o }); if (r.status !== 0) process.exit(r.status ?? 1) }
const out = (cmd, a) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8' })

if (!existsSync(join(root, 'third_party/wamr/VERSION'))) run('bash', [join(root, 'tools/setup-ios.sh')])
const v8Apple = existsSync(join(root, 'third_party/v8-apple/lib', v8Slice, 'libv8_monolith.a'))
if (!v8Apple && (vision || !existsSync(join(root, 'third_party/v8-ios/VERSION')))) run('bash', [join(root, 'tools/setup-v8-apple.sh'), v8Slice])
// visionOS renders through ANGLE built for xros: the slice from the prebuilt release (or built from source)
if (vision && !existsSync(join(root, 'third_party/angle-apple', v8Slice, 'libGLESv2.framework/libGLESv2'))) run('bash', [join(root, 'tools/setup-angle-apple.sh'), v8Slice])

// 1. assets, as pack.mjs stages the APK's
const assets = join(build, 'assets')
run('node', [join(root, 'tools/pack.mjs'), cfgPath, '--stage', assets, '--host', vision ? 'vision' : 'ios'])
if (opt('--port')) {
  const f = join(assets, 'host.json'), m = JSON.parse(readFileSync(f, 'utf8'))
  m.debug = { ...m.debug, port: +opt('--port') }; writeFileSync(f, JSON.stringify(m, null, 2))
}

// 2. the executable and its Info.plist (CMake's bundle)
run('cmake', ['-S', 'host', '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_SYSTEM_NAME=${vision ? 'visionOS' : 'iOS'}`,
  `-DCMAKE_OSX_SYSROOT=${vision ? (device ? 'xros' : 'xrsimulator') : (device ? 'iphoneos' : 'iphonesimulator')}`, '-DCMAKE_OSX_ARCHITECTURES=arm64',
  // The Swift shell of the immersive vision host (host/vision/App.swift): CMake passes swiftc no target triple for visionOS.
  ...(vision ? [`-DCMAKE_Swift_FLAGS=-target arm64-apple-xros2.0${device ? '' : '-simulator'}`] : []),
  `-DCMAKE_OSX_DEPLOYMENT_TARGET=${vision ? '2.0' : '15.0'}`,
  `-DIOS_BUNDLE_ID=${bundleId}`, `-DIOS_BUNDLE_NAME=${name}`, `-DIOS_VERSION=${version}`], { stdio: ['ignore', 'ignore', 'inherit'] })
run('ninja', ['-C', build, `webxrhost-${os}`])

// 3. the bundle: assets, V8 (its ICU data next to the assets, where emu/host_emu.cpp looks; or the v8-ios
// framework when the executable links it), icon, signature
const app = join(build, 'webxrhost.app')
rmSync(join(app, 'assets'), { recursive: true, force: true }); cpSync(assets, join(app, 'assets'), { recursive: true })
const slice = device ? 'ios-arm64' : 'ios-arm64_x86_64-simulator'
const fw = join(app, 'Frameworks'); rmSync(fw, { recursive: true, force: true }); mkdirSync(fw)
const linked = out('otool', ['-L', join(app, 'webxrhost')])
const frameworks = []
rmSync(join(app, 'icudtl.dat'), { force: true })
if (linked.includes('v8.framework')) {
  cpSync(join(root, 'third_party/v8-ios/v8.xcframework', slice, 'v8.framework'), join(fw, 'v8.framework'), { recursive: true })
  chmodSync(join(fw, 'v8.framework/v8'), 0o755); frameworks.push('v8')
} else if (existsSync(join(root, 'third_party/v8-apple/icudtl.dat'))) copyFileSync(join(root, 'third_party/v8-apple/icudtl.dat'), join(app, 'icudtl.dat'))
// ANGLE (GLES on Metal) when the executable links it; without third_party/angle-ios it runs on Apple's GLES.
// On visionOS the slice tools/setup-angle-apple.sh built (third_party/angle-apple/<slice>).
if (linked.includes('libGLESv2.framework')) for (const n of ['libEGL', 'libGLESv2']) {
  const src = vision ? join(root, 'third_party/angle-apple', v8Slice, `${n}.framework`) : join(root, 'third_party/angle-ios', `${n}.xcframework`, slice, `${n}.framework`)
  cpSync(src, join(fw, `${n}.framework`), { recursive: true })
  frameworks.push(n)
}
if (cfg.app?.icon) {
  const src = resolve(dirname(cfgPath), cfg.app.icon)
  for (const [base, px] of [['AppIcon60x60@2x', 120], ['AppIcon60x60@3x', 180], ['AppIcon76x76@2x~ipad', 152]])
    execFileSync('magick', [src, '-resize', `${px}x${px}`, '-alpha', 'remove', join(app, `${base}.png`)])
}
// The Vision Pro simulator's rooms as planes (tools/sim-rooms.mjs): it senses none, so vision/vision_xr.mm feeds
// the page the classified planes of the room it renders. Built here from this Mac's runtime, never committed.
rmSync(join(app, 'sim-rooms.json'), { force: true })
if (vision && !device) {
  const rooms = simRooms()
  if (rooms) writeFileSync(join(app, 'sim-rooms.json'), JSON.stringify(rooms))
  else console.warn('ios.mjs: no visionOS runtime rooms (tools/sim-rooms.mjs); the simulator gets a stand-in room')
}
// App Transport Security refuses plain http: the http:// origins network.allow names (a dev server) get an exception.
spawnSync('plutil', ['-remove', 'NSAppTransportSecurity', join(app, 'Info.plist')], { stdio: 'ignore' })  // none left from an earlier build
const insecure = [...new Set((cfg.network?.allow ?? []).filter(a => a.startsWith('http://')).map(a => new URL(a).hostname))]
if (insecure.length) {
  const ats = { NSExceptionDomains: Object.fromEntries(insecure.map(h => [h, { NSExceptionAllowsInsecureHTTPLoads: true, NSIncludesSubdomains: false }])) }
  if (insecure.some(h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))) ats.NSAllowsLocalNetworking = true
  run('plutil', ['-replace', 'NSAppTransportSecurity', '-json', JSON.stringify(ats), join(app, 'Info.plist')])
}
if (device) {
  const identity = process.env.IOS_SIGN_IDENTITY, profile = process.env.IOS_PROFILE
  if (!identity || !profile) { console.error('ios.mjs --device: set IOS_SIGN_IDENTITY and IOS_PROFILE (a .mobileprovision for ' + bundleId + ')'); process.exit(2) }
  copyFileSync(resolve(profile), join(app, 'embedded.mobileprovision'))
  // The entitlements the profile grants (application-identifier, team, get-task-allow) are the ones to sign with.
  const plist = out('security', ['cms', '-D', '-i', resolve(profile)])
  const ent = join(build, 'entitlements.plist')
  writeFileSync(join(build, 'profile.plist'), plist)
  writeFileSync(ent, out('plutil', ['-extract', 'Entitlements', 'xml1', '-o', '-', join(build, 'profile.plist')]))
  for (const n of frameworks) run('codesign', ['--force', '--sign', identity, join(fw, `${n}.framework`)])
  run('codesign', ['--force', '--sign', identity, '--entitlements', ent, app])
} else {
  for (const n of frameworks) run('codesign', ['--force', '--sign', '-', join(fw, `${n}.framework`)])
  run('codesign', ['--force', '--sign', '-', app])
}
console.log(`${app}  (${bundleId}, ${os} ${device ? 'device' : 'simulator'}, V8: ${frameworks.includes('v8') ? 'v8-ios framework' : `v8-apple ${v8Slice}`}, GL: ${frameworks.includes('libGLESv2') ? 'ANGLE on Metal' : "Apple's OpenGL ES"})`)
if (flag('--no-run')) process.exit(0)

// 4. install and launch
if (device) {
  const list = JSON.parse(spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', '/dev/stdout'], { encoding: 'utf8' }).stdout.replace(/^[^{]*/, ''))
  const dev = list.result?.devices?.find(d => d.connectionProperties?.tunnelState === 'connected')
  if (!dev) { console.error('ios.mjs: no connected device (xcrun devicectl list devices)'); process.exit(1) }
  if (flag('--fresh')) spawnSync('xcrun', ['devicectl', 'device', 'uninstall', 'app', '--device', dev.identifier, bundleId], { stdio: 'inherit' })
  run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', dev.identifier, app])
  run('xcrun', ['devicectl', 'device', 'process', 'launch', ...(flag('--console') ? ['--console'] : []), '--device', dev.identifier, bundleId])
} else {
  const sims = JSON.parse(out('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices
  const all = Object.entries(sims).filter(([rt]) => rt.includes(vision ? 'xrOS' : 'iOS')).flatMap(([rt, ds]) => ds.map(d => ({ ...d, rt })))
  const want = opt('--sim')
  const sim = want ? all.find(d => d.udid === want || d.name === want)
    : all.find(d => d.state === 'Booted') ?? all.filter(d => vision ? /^Apple Vision Pro$/.test(d.name) : /^iPhone \d+ Pro$/.test(d.name)).sort((a, b) => b.rt.localeCompare(a.rt, undefined, { numeric: true }))[0] ?? all[0]
  if (!sim) { console.error(`ios.mjs: no ${vision ? 'visionOS' : 'iOS'} simulator (xcrun simctl list devices)`); process.exit(1) }
  if (sim.state !== 'Booted') { run('xcrun', ['simctl', 'boot', sim.udid]); spawnSync('open', ['-a', 'Simulator']) }
  if (flag('--fresh')) spawnSync('xcrun', ['simctl', 'uninstall', sim.udid, bundleId], { stdio: 'inherit' })
  run('xcrun', ['simctl', 'install', sim.udid, app])
  spawnSync('xcrun', ['simctl', 'terminate', sim.udid, bundleId], { stdio: 'ignore' })
  console.log(`${sim.name} (${sim.udid}): ${bundleId}`)
  run('xcrun', ['simctl', 'launch', ...(flag('--console') ? ['--console-pty'] : []), sim.udid, bundleId])
}
