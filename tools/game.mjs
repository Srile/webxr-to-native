// The game a builder is run for (pack, mac, win, linux, ios): the first argument that is a host.json path, else the
// first that is a directory holding native/host.json or host.json (a game's repo: `npm run mac "../My Game"`). The
// toolkit holds no game configs; each game keeps its own. Only an existing directory counts, so an option's value
// (`--size 800x600`) is never taken for a game.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function gameArg(args) {
  const json = args.find(a => a.endsWith('.json'))
  if (json) return json
  for (const a of args) {
    if (a.startsWith('-') || !existsSync(a) || !statSync(a).isDirectory()) continue
    for (const f of [join(a, 'native', 'host.json'), join(a, 'host.json')]) if (existsSync(f)) return f
  }
  return undefined
}

// host.json network.webrtc (WP-21): fetch the sources on first need (tools/setup-webrtc.sh); with media.microphone
// as well, libsrtp for audio tracks (fetched before the first configure: CMake does not notice it arriving later).
export function ensureWebrtcSources(cfg) {
  if (cfg.network?.webrtc !== true) return
  const ldc = join(root, 'third_party/libdatachannel')
  if (!existsSync(join(ldc, '.stamp-v0.24.6-6')) || (cfg.media?.microphone === true && !existsSync(join(ldc, 'deps/libsrtp/.stamp-2.7.0'))))
    execFileSync('bash', [join(root, 'tools/setup-webrtc.sh')], { stdio: 'inherit' })
}
// The CMake switch for a window host's build directory (mac, linux): its -D define, and whether the directory was
// configured for the other setting (the last game built there differed) and so must be configured again.
export function webrtcSwitch(cfg, build) {
  ensureWebrtcSources(cfg)
  const flag = cfg.network?.webrtc === true ? 'ON' : 'OFF', cache = join(build, 'CMakeCache.txt')
  const was = existsSync(cache) ? (/HOST_WEBRTC:BOOL=(\w+)/.exec(readFileSync(cache, 'utf8'))?.[1] ?? 'OFF') : null
  return { define: `-DHOST_WEBRTC=${flag}`, stale: was !== null && was !== flag }
}
// host.json media.microphone (WP-25): the microphone's CMake switch for a window host's build directory, as webrtcSwitch.
export function microphoneSwitch(cfg, build) {
  const flag = cfg.media?.microphone === true ? 'ON' : 'OFF', cache = join(build, 'CMakeCache.txt')
  const was = existsSync(cache) ? (/HOST_MICROPHONE:BOOL=(\w+)/.exec(readFileSync(cache, 'utf8'))?.[1] ?? 'OFF') : null
  return { define: `-DHOST_MICROPHONE=${flag}`, stale: was !== null && was !== flag, on: flag === 'ON' }
}

// host.json js.intl (WP-24): the Android build links V8 with ICU (third_party/v8-intl) instead of the stock V8, which
// has no Intl. It comes from tools/setup-v8-android-intl.sh (the published build, or --build from source), run on
// first need; a failure there ends the build with its message. The window hosts' V8s (Homebrew on mac and Linux,
// NuGet on Windows, the Apple builds) always carry ICU: they have nothing to switch.
export function ensureV8Intl(cfg) {
  const on = cfg.js?.intl === true
  if (on && !existsSync(join(root, 'third_party/v8-intl/lib/libv8_monolith.a'))) {
    try { execFileSync('bash', [join(root, 'tools/setup-v8-android-intl.sh')], { stdio: 'inherit' }) }
    catch { console.error('js.intl: no third_party/v8-intl (V8 with ICU for Android): run tools/setup-v8-android-intl.sh, or with --build to build it from source'); process.exit(2) }
  }
  return on
}
// host.json storage.indexedDB / storage.cache (WP-26): either one builds the SQLite store into the host (HOST_STORAGE);
// its sources come on first need (tools/setup-storage.sh).
export const wantsStorage = (cfg) => cfg.storage?.indexedDB === true || cfg.storage?.cache === true
export function ensureStorageSources(cfg) {
  if (wantsStorage(cfg) && !existsSync(join(root, 'third_party/sqlite/.stamp-3540100')))
    execFileSync('bash', [join(root, 'tools/setup-storage.sh')], { stdio: 'inherit' })
}
// As webrtcSwitch: the -D define for a window host's build directory, and whether that directory must be configured again.
export function storageSwitch(cfg, build) {
  ensureStorageSources(cfg)
  const flag = wantsStorage(cfg) ? 'ON' : 'OFF', cache = join(build, 'CMakeCache.txt')
  const was = existsSync(cache) ? (/HOST_STORAGE:BOOL=(\w+)/.exec(readFileSync(cache, 'utf8'))?.[1] ?? 'OFF') : null
  return { define: `-DHOST_STORAGE=${flag}`, stale: was !== null && was !== flag }
}
