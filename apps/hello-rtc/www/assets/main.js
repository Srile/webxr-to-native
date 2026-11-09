// hello-rtc (WP-21): WebSocket and WebRTC data channels on the host.
//  1. two RTCPeerConnections in this page, signalled in-page (offer, answer, trickle ICE), a reliable ordered data
//     channel each way: text and binary round trips, and the remote side's datachannel event before its open
//  2. a wss:// echo server (TLS verified against the system's CAs): text and binary echo
//  3. a WebSocket the allow-list refuses closes with an error; a server with a self-signed certificate never opens
// The screen is green when all pass, red otherwise; the log says which and ends with READY.
const log = (m) => console.log('hello-rtc: ' + m)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(what + ' timed out')), ms))])
const once = (t, type) => new Promise((r) => t.addEventListener(type, r, { once: true }))

async function loopback() {
  const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate) }
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate) }
  const order = []
  const remote = new Promise((resolve) => { b.ondatachannel = (e) => { order.push('datachannel'); e.channel.onopen = () => order.push('open'); resolve(e.channel) } })
  const ch = a.createDataChannel('game', { ordered: true }); ch.binaryType = 'arraybuffer'
  await a.setLocalDescription(await a.createOffer())
  await b.setRemoteDescription(a.localDescription)
  await b.setLocalDescription(await b.createAnswer())
  await a.setRemoteDescription(b.localDescription)
  await timeout(once(ch, 'open'), 10000, 'channel open')
  const rc = await timeout(remote, 10000, 'remote datachannel'); rc.binaryType = 'arraybuffer'
  if (rc.readyState !== 'open') await timeout(once(rc, 'open'), 5000, 'remote open')
  check('datachannel before open', order[0] === 'datachannel', order.join(','))
  check('connection state', a.connectionState === 'connected' && b.connectionState === 'connected', `${a.connectionState}/${b.connectionState}`)
  const text = new Promise((r) => { rc.onmessage = (e) => r(e.data) }); ch.send('ping')
  check('text a->b', (await timeout(text, 5000, 'text')) === 'ping')
  const bin = new Promise((r) => { ch.onmessage = (e) => r(e.data) }); rc.send(new Uint8Array([1, 2, 3, 250]))
  const got = await timeout(bin, 5000, 'binary')
  check('binary b->a', got instanceof ArrayBuffer && new Uint8Array(got).join() === '1,2,3,250')
  const big = new Uint8Array(200000).map((_, i) => i & 255), bigGot = new Promise((r) => { rc.onmessage = (e) => r(e.data) }); ch.send(big)
  const bg = new Uint8Array(await timeout(bigGot, 10000, 'large message'))
  check('200 kB message', bg.length === big.length && bg[199999] === (199999 & 255), String(bg.length))
  const closed = once(rc, 'close'); ch.close(); await timeout(closed, 5000, 'close')
  check('close reaches the peer', rc.readyState === 'closed')
  a.close(); b.close()
}

async function echo() {
  const ws = new WebSocket('wss://echo.websocket.org'); ws.binaryType = 'arraybuffer'
  const msgs = []; ws.onmessage = (e) => msgs.push(e.data)
  await timeout(once(ws, 'open'), 15000, 'wss open')
  check('wss open', ws.readyState === WebSocket.OPEN)
  ws.send('hello'); ws.send(new Uint8Array([9, 8, 7]))
  await timeout(new Promise((r) => { const t = setInterval(() => { if (msgs.some(m => m === 'hello') && msgs.some(m => m instanceof ArrayBuffer)) { clearInterval(t); r() } }, 50) }), 10000, 'echo')
  check('wss text echo', msgs.includes('hello'))
  const b = msgs.find(m => m instanceof ArrayBuffer); check('wss binary echo', !!b && new Uint8Array(b).join() === '9,8,7')
  const closed = once(ws, 'close'); ws.close(); const ev = await timeout(closed, 5000, 'wss close')
  check('wss close', ws.readyState === WebSocket.CLOSED && ev.code === 1000, String(ev.code))
}

async function blocked() {
  const ws = new WebSocket('wss://example.com/socket')
  let errored = false; ws.onerror = () => { errored = true }
  await timeout(once(ws, 'close'), 5000, 'blocked close')
  check('allow-list refuses', errored && ws.readyState === WebSocket.CLOSED)
}

async function badCert() {
  const ws = new WebSocket('wss://self-signed.badssl.com/')
  let opened = false; ws.onopen = () => { opened = true }
  await timeout(once(ws, 'close'), 15000, 'bad certificate close')
  check('self-signed certificate refused', !opened)
}

function paint(ok) {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => { gl.clearColor(ok ? 0.1 : 0.8, ok ? 0.7 : 0.1, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw) }
  draw()
}

for (const [name, f] of [['loopback', loopback], ['echo', echo], ['blocked', blocked], ['bad certificate', badCert]]) {
  try { await f() } catch (e) { check(name, false, String(e?.message ?? e)) }
}
const ok = results.length > 0 && results.every(Boolean)
log(`${results.filter(Boolean).length}/${results.length} passed`)
paint(ok)
log(ok ? 'READY' : 'FAILED')
