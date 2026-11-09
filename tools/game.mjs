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

// host.json network.webrtc (WP-21): fetch the sources on first need (tools/setup-webrtc.sh).
export function ensureWebrtcSources(cfg) {
  if (cfg.network?.webrtc === true && !existsSync(join(root, 'third_party/libdatachannel/.stamp-v0.24.6')))
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
