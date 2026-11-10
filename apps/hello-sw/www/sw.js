// hello-sw's service worker (WP-27): answers /sw/* itself, passes /data.json and /pixel.png to its own fetch,
// serves /sw-cache/* from the Cache API when there is one, leaves every other request alone (no respondWith: the
// page's normal path), claims the page when it activates and answers the page's messages.
const seen = []
self.addEventListener('install', (e) => { e.waitUntil(new Promise((r) => setTimeout(r, 10))) })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return
  seen.push(`${e.request.destination || 'fetch'} ${url.pathname}`)
  const js = { headers: { 'content-type': 'text/javascript' } }
  switch (url.pathname) {
    case '/sw/hello': return e.respondWith(new Response('hello from the service worker', { headers: { 'x-from': 'sw' } }))
    case '/sw/xhr': return e.respondWith(new Response('xhr from the service worker'))
    case '/sw/script.js': return e.respondWith(new Response('globalThis.__helloSwScript = 42', js))
    case '/sw/worker.js': return e.respondWith(new Response('onmessage = (e) => postMessage(e.data * 2)', js))
    case '/sw/reject': return e.respondWith(Promise.reject(new Error('refused on purpose')))
    case '/data.json': case '/pixel.png': return e.respondWith(fetch(e.request))
  }
  if (url.pathname.startsWith('/sw-cache/')) e.respondWith(caches.match(e.request).then((r) => r ?? new Response('cache miss', { status: 404 })))
})
self.addEventListener('message', async (e) => {
  const cmd = e.data?.cmd
  if (cmd === 'seen') e.source.postMessage({ cmd, seen })
  else if (cmd === 'clients') { const all = await self.clients.matchAll(); e.source.postMessage({ cmd, n: all.length, type: all[0]?.type, url: all[0]?.url, me: all[0]?.id === e.source.id }) }
  else if (cmd === 'caches') e.source.postMessage({ cmd, caches: typeof caches !== 'undefined' })
  else if (cmd === 'port') e.ports[0].postMessage({ cmd, pong: e.data.ping })
  else e.source.postMessage({ cmd: 'echo', data: e.data, state: self.serviceWorker.state })
})
