// Imports the game's entry module once the surface is up.
// before: a promise the entry waits for (a service worker that takes over at this start, WP-27), or undefined.
export function boot(g, before) {
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
    // Classic inline scripts in index.html (host.json web.inlineScripts: true; tools/pack.mjs stages their text).
    // The host does not parse the document, and a deferred module runs after them in a browser, so they run here,
    // before the entry: a page's own startup, including a click on a VR button the host never draws.
    const inline = cfg.web?.inlineScripts
    if (Array.isArray(inline)) for (const text of inline) g.__hostEvalScript?.(text, 'index.html')

    let ready = Promise.resolve(before)
    for (const u of inject) ready = ready.then(() => import(u)).then(() => n.log(1, `boot: injected ${u}`), (e) => n.log(3, `boot: inject ${u} failed: ${e?.stack ?? e}`))
    ready.then(() => {
      n.log(1, `boot: import ${url}`)
      g.document?.dispatchEvent?.(new g.Event('DOMContentLoaded'))
      return import(url)
    }).then(() => { n.log(1, 'boot: entry evaluated'); g.dispatchEvent?.(new g.Event('load')) },
      (e) => { n.log(3, `boot: entry failed: ${e?.stack ?? e}`) })
  })
}
