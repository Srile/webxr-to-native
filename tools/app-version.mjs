// The app's version name for every packager (pack, upload, mac, ios): host.json `app.version` when it pins one,
// else the GAME's own — the package.json beside its `web.dist` (../dist → ../package.json) — so a game that bumps
// its version as it ships never has a second copy here to forget.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function appVersion(cfg, cfgPath, fallback = '0.1.0') {
  if (cfg.app?.version) return cfg.app.version
  if (cfg.web?.dist) {
    const pj = join(dirname(resolve(dirname(resolve(cfgPath)), cfg.web.dist)), 'package.json')
    if (existsSync(pj)) { const v = JSON.parse(readFileSync(pj, 'utf8')).version; if (v) return v }
  }
  return fallback
}
