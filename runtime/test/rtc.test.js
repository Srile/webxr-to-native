import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installRtc } from '../src/rtc/index.js'

function sandbox() {
  const calls = []
  let onEvent = null, id = 0
  const rtc = new Proxy({ onEvent: (f) => { onEvent = f }, pcCreate: () => ++id, pcCreateDataChannel: () => ++id, dcInfo: () => ['_PEERJSTEST', '', -1, true, -1, -1], pcClose() {}, dcClose() {} }, { get: (t, k) => t[k] ?? ((...a) => { calls.push([k, ...a]) }) })
  const g = Object.create(null); g.__native = fakeNative({ rtc }); g.Promise = Promise
  installCore(g); installFetch(g); installRtc(g)
  return { g, emit: (...a) => onEvent(...a), calls }
}

test('webrtc-adapter-style shims: states and handlers are prototype accessors, so a shim can wrap them', () => {
  const { g } = sandbox()
  for (const k of ['connectionState', 'iceConnectionState', 'signalingState', 'onconnectionstatechange', 'ontrack', 'ondatachannel']) assert.ok(k in g.RTCPeerConnection.prototype, k)
  for (const k of ['onopen', 'onmessage', 'onclose']) assert.ok(k in g.RTCDataChannel.prototype, k)
  // A getter-only shim over connectionState (adapter's shimConnectionState when missing) must not break construction.
  Object.defineProperty(g.RTCPeerConnection.prototype, 'connectionState', { get() { return this._state.connection }, configurable: true })
  const pc = new g.RTCPeerConnection({ iceServers: [{ urls: 'turn:x:3478', username: 'u', credential: 'p' }] })
  const dc = pc.createDataChannel('_PEERJSTEST', { ordered: true }); dc.binaryType = 'blob'
  assert.equal(dc.ordered, true); assert.equal(pc.connectionState, 'new'); dc.close(); pc.close(); assert.equal(pc.connectionState, 'closed')
})

test('events: candidates, gathering end, state changes, a remote channel announced before its open', () => {
  const { g, emit } = sandbox()
  const pc = new g.RTCPeerConnection(); const seen = []
  pc.onicecandidate = (e) => seen.push(e.candidate ? e.candidate.candidate.split(' ')[0] : null)
  pc.onconnectionstatechange = () => seen.push(pc.connectionState)
  pc.ondatachannel = (e) => { seen.push('dc:' + e.channel.label); e.channel.onopen = () => seen.push('open') }
  emit('pc-candidate', 1, 'candidate:1 1 UDP 2122317823 192.168.1.2 50000 typ host', '0')
  emit('dc-open', 9)                         // arrives before its announcement
  emit('pc-datachannel', 1, 9)
  emit('pc-gathering', 1, 'complete'); emit('pc-state', 1, 'connected')
  assert.deepEqual(seen, ['candidate:1', 'dc:_PEERJSTEST', 'open', null, 'connected'])
})

test('a shim that turns onicecandidate into addEventListener (webrtc-adapter) gets each event once', () => {
  const { g, emit } = sandbox()
  const proto = g.RTCPeerConnection.prototype, orig = Object.getOwnPropertyDescriptor(proto, 'onicecandidate')
  Object.defineProperty(proto, 'onicecandidate', { get() { return this._wrapped }, set(cb) { if (this._wrapped) this.removeEventListener('icecandidate', this._wrapped); if (cb) this.addEventListener('icecandidate', this._wrapped = cb) }, configurable: true })
  const pc = new g.RTCPeerConnection(); let n = 0
  pc.onicecandidate = () => n++
  emit('pc-candidate', 1, 'candidate:1 1 UDP 1 10.0.0.1 1 typ host', '0')
  assert.equal(n, 1)
  Object.defineProperty(proto, 'onicecandidate', orig)
})

test('setLocalDescription settles when no description follows (rollback), and waits for one otherwise', async () => {
  const { g, emit } = sandbox()
  let made = false
  g.__native.rtc.pcSetLocal = (id, type) => made = type !== 'rollback'
  const pc = new g.RTCPeerConnection()
  await pc.setLocalDescription({ type: 'rollback' })   // would hang before: no pc-description comes
  let done = false; const p = pc.setLocalDescription({ type: 'offer' }).then(() => { done = true })
  await new Promise(r => setTimeout(r, 5)); assert.equal(done, false)
  emit('pc-description', 1, 'offer', 'v=0'); await p; assert.equal(done, true)
})
