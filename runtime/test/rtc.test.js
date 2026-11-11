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

test('audio (host with WebRTC audio): the offerer\'s transceiver, the answerer\'s track event, replaceTrack, negotiationneeded', async () => {
  const { g, calls } = sandbox()
  const rtc = g.__native.rtc
  let link = 100, remote = 2000
  rtc.pcAddAudio = (pc, dir) => { calls.push(['pcAddAudio', pc, dir]); return [++link, ++remote, 'audio'] }
  rtc.audioSetSource = (l, t) => calls.push(['audioSetSource', l, t])
  rtc.audioSetDirection = (l, d) => calls.push(['audioSetDirection', l, d])
  rtc.pcSignaling = () => 'stable'
  g.setTimeout = (f) => setTimeout(f, 0)
  // The audio API is installed only when the host has it: reinstall with it present.
  const { install } = await import('../src/rtc/index.js')
  const g2 = Object.create(null); g2.__native = g.__native; g2.Promise = Promise
  const { install: installCore } = await import('../src/dom-lite/index.js'); installCore(g2)
  g2.__hostRemoteTrack = (id) => ({ kind: 'audio', _nid: id, readyState: 'live', _end() { this.readyState = 'ended' } })
  g2.MediaStream = class { constructor(t) { this.tracks = t } }
  install(g2)

  // Offerer: addTransceiver makes the audio line, asks for negotiation once, and replaceTrack feeds it.
  const pc = new g2.RTCPeerConnection(); let needed = 0
  pc.onnegotiationneeded = () => needed++
  const t = pc.addTransceiver('audio', { direction: 'sendrecv' })
  assert.deepEqual(calls.at(-1), ['pcAddAudio', 1, 'sendrecv'])
  assert.equal(t.mid, 'audio'); assert.equal(t.receiver.track._nid, 2001); assert.deepEqual(pc.getTransceivers(), [t])
  await t.sender.replaceTrack({ kind: 'audio', readyState: 'live', _nid: 7 })
  assert.deepEqual(calls.at(-1), ['audioSetSource', 101, 7])
  await new Promise(r => setTimeout(r, 5)); assert.equal(needed, 1)
  // The answer says the other side sends too: one track event for the receiver.
  const tracks = []; pc.ontrack = (e) => tracks.push(e)
  rtc.pcSetRemote = () => []
  await pc.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=sendrecv\r\n' })
  await pc.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=sendrecv\r\n' })
  assert.equal(tracks.length, 1); assert.equal(tracks[0].transceiver, t); assert.equal(tracks[0].streams[0].tracks[0], t.receiver.track)

  // Answerer: the offer's audio line becomes a recvonly transceiver; the page turns it to sendrecv before answering.
  const pc2 = new g2.RTCPeerConnection(); const seen = []
  pc2.ontrack = (e) => seen.push(e.transceiver)
  rtc.pcSetRemote = () => [[301, 3001, '0']]
  await pc2.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=mid:0\r\na=sendrecv\r\n' })
  const [x] = pc2.getTransceivers()
  assert.equal(seen[0], x); assert.equal(x.direction, 'recvonly'); assert.deepEqual(calls.at(-1), ['audioSetDirection', 301, 'recvonly'])
  x.direction = 'sendrecv'; assert.deepEqual(calls.at(-1), ['audioSetDirection', 301, 'sendrecv'])
  // The answerer's own negotiated channel asks for nothing once its answer carries the data line.
  let renegotiate = 0; pc2.onnegotiationneeded = () => renegotiate++
  rtc.pcLocal = () => ['answer', 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n']
  pc2.createDataChannel('state', { negotiated: true, id: 1 })
  await new Promise(r => setTimeout(r, 5)); assert.equal(renegotiate, 0)
  pc2.close(); assert.equal(x.receiver.track.readyState, 'ended')
})
