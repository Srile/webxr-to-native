// Imports the game's entry module once the surface is up.
export function boot(g) {
  const n = g.__native
  const cfg = n.config ?? {}
  const entry = cfg.web?.entry
  if (!entry) { n.log(1, 'no web.entry in host.json; nothing to run'); return }
  const origin = (cfg.web?.origin ?? 'https://app.local').replace(/\/$/, '')
  const url = origin + '/' + entry.replace(/^\.?\//, '')
  // host.json web.inject (staged by tools/pack.mjs): the game's own boot scripts, imported in order before anything
  // of the page runs, as an inline <script> in its <head> would be. One that fails is logged and the page still loads.
  const inject = (cfg.web?.inject ?? []).map((p) => origin + '/' + p)
  // Vite's modulepreload links are fetched by the browser; here the module graph loads on demand, so just warm the cache.
  n.loop.postTask(() => {
    let ready = Promise.resolve()
    for (const u of inject) ready = ready.then(() => import(u)).then(() => n.log(1, `boot: injected ${u}`), (e) => n.log(3, `boot: inject ${u} failed: ${e?.stack ?? e}`))
    ready.then(() => {
      n.log(1, `boot: import ${url}`)
      g.document?.dispatchEvent?.(new g.Event('DOMContentLoaded'))
      return import(url)
    }).then(() => { n.log(1, 'boot: entry evaluated'); g.dispatchEvent?.(new g.Event('load')) },
      (e) => { n.log(3, `boot: entry failed: ${e?.stack ?? e}`) })
  })
}
