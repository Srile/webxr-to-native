// navigator.horizon — the Meta Platform SDK surface. Present only when the host bundled the SDK.
export function install(g) {
  const P = g.__native.platform
  if (!P?.available) return
  const appId = g.__native.config?.app?.metaAppId
  const ready = appId ? P.init(String(appId)).then(() => true, (e) => { g.__native.log(3, `horizon init failed: ${e?.message ?? e}`); return false }) : Promise.resolve(false)
  const after = (f) => ready.then(ok => ok ? f() : Promise.reject(new Error('horizon not initialised')))
  const horizon = Object.freeze({
    ready,
    // A failed init counts as a failed check (Meta's rule), so entitled() is false rather than rejected.
    entitled: () => after(() => P.entitled()).catch(() => false),
    // Never rejects: with no answer the game has to fall back to what it knows (its cache, else the strictest reading).
    ageCategory: () => after(() => P.ageCategory()).catch(() => 'unknown'),
    user: () => after(() => P.user()),
    leaderboards: Object.freeze({
      write: (name, score, opts = {}) => after(() => P.lbWrite(String(name), Math.round(score), opts.extra ?? '', !!opts.force)),
      read: (name, opts = {}) => after(() => P.lbRead(String(name), opts.limit ?? 10, opts.filter ?? 'none', opts.startAt ?? 'top')),
    }),
    achievements: Object.freeze({ unlock: (k) => after(() => P.achUnlock(String(k))), add: (k, n = 1) => after(() => P.achAdd(String(k), n)), bits: (k, b) => after(() => P.achBits(String(k), String(b))), all: () => after(() => P.achAll()) }),
  })
  Object.defineProperty(g.navigator, 'horizon', { value: horizon, enumerable: true, configurable: false })
}
