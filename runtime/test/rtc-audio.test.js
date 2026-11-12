import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installRtc } from '../src/rtc/index.js'

// Audio transceivers over fake natives: which m-line each gets, what it sends, the track events.
function sandbox({ media = true } = {}) {
  const calls = [], state = { signaling: 'stable' }
  let onEvent = null, id = 0, xid = 100, remote = 0x40000000
  const base = {
    onEvent: (f) => { onEvent = f }, pcCreate: () => ++id, pcClose() {}, pcCreateOffer: () => 'v=0', pcCreateAnswer: () => 'v=0',
    pcSetLocal: (pc, type) => { calls.push(['pcSetLocal', type]); if (type === 'offer') state.signaling = 'have-local-offer'; else if (type === 'answer' || type === 'rollback') state.signaling = 'stable'; return false },
    pcSetRemote: (pc, sdp, type) => { calls.push(['pcSetRemote', type]); state.signaling = type === 'offer' ? 'have-remote-offer' : 'stable' },
    pcSignaling: () => state.signaling, pcLocal: () => state.local ?? null, pcRemote: () => null,
  }
  if (media) Object.assign(base, {
    audioAdd: (pc, mid, pt) => { calls.push(['audioAdd', mid, pt]); return [++xid, ++remote] },
    audioSource: (x, nid) => calls.push(['audioSource', x, nid]),
    audioBitrate: (x, bps) => calls.push(['audioBitrate', x, bps]),
    audioClose: (x) => calls.push(['audioClose', x]),
    audioRemoteEnabled: (nid, on) => calls.push(['audioRemoteEnabled', nid, on]),
  })
  const g = Object.create(null); g.__native = fakeNative({ rtc: base }); g.Promise = Promise
  installCore(g); installFetch(g)
  // What media/ gives a build with the microphone: remote tracks and MediaStream.
  g.MediaStream = class MediaStream { constructor() { this.tracks = [] } getTracks() { return this.tracks.slice() } addTrack(t) { this.tracks.push(t) } }
  g.__hostMedia = { remoteTrack: () => ({ kind: 'audio', readyState: 'live', _nid: 0, _setNative(n) { this._nid = n }, _end() { this.readyState = 'ended' } }) }
  installRtc(g)
  return { g, calls, state, emit: (...a) => onEvent(...a) }
}
const mic = (nid = 7) => ({ kind: 'audio', readyState: 'live', _nid: nid })
const offer = (mid, { pt = 111, dir = 'sendrecv', msid = 'stream1 track1' } = {}) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF ${pt} 63\r\nc=IN IP4 0.0.0.0\r\na=mid:${mid}\r\na=${dir}\r\na=msid:${msid}\r\na=rtpmap:${pt} opus/48000/2\r\na=rtpmap:63 red/48000/2\r\n`

test('addTrack before our offer: the offer carries one Opus m-line, which sends the track', async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection(); let needed = 0
  pc.onnegotiationneeded = () => needed++
  const sender = pc.addTrack(mic())
  await new Promise(r => setTimeout(r, 1)); assert.equal(needed, 1)
  await pc.createOffer()
  assert.deepEqual(calls.filter(c => c[0] === 'audioAdd'), [['audioAdd', 'audio0', 111]])
  assert.deepEqual(calls.find(c => c[0] === 'audioSource'), ['audioSource', 101, 7])
  assert.equal(pc.getTransceivers()[0].mid, 'audio0'); assert.equal(pc.getSenders()[0], sender)
})

test("a remote offer's m-line goes to the transceiver addTrack made, with the peer's Opus payload type", async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection(); const events = []
  pc.ontrack = (e) => events.push(e)
  pc.addTrack(mic(3))
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0', { pt: 109 }) })
  assert.deepEqual(calls.filter(c => c[0] === 'audioAdd'), [['audioAdd', '0', 109]])
  assert.ok(calls.findIndex(c => c[0] === 'audioAdd') < calls.findIndex(c => c[0] === 'pcSetRemote'), 'the track exists before the offer is applied')
  assert.equal(events.length, 1)
  const [e] = events, t = pc.getTransceivers()[0]
  assert.equal(e.transceiver, t); assert.equal(e.track, t.receiver.track); assert.equal(e.track._nid, 0x40000001)
  assert.equal(e.streams.length, 1); assert.deepEqual(e.streams[0].getTracks(), [e.track])
  assert.equal(t.currentDirection, 'sendrecv')
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0', { pt: 109 }) })  // a renegotiation: no second event
  assert.equal(events.length, 1)
})

test('a remote offer with no transceiver of ours makes a recvonly one, which a later addTrack takes', async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection()
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0') })
  const [t] = pc.getTransceivers(); assert.equal(t.direction, 'recvonly')
  const sender = pc.addTrack(mic(5))
  assert.equal(pc.getTransceivers().length, 1); assert.equal(sender, t.sender); assert.equal(t.direction, 'sendrecv')
  assert.deepEqual(calls.filter(c => c[0] === 'audioSource').at(-1), ['audioSource', 101, 5])
})

test('glare: a remote offer applied over our offer releases our unanswered m-line, the offer\'s takes the track', async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection()
  pc.addTrack(mic(9))
  await pc.setLocalDescription()          // our offer: audio0
  assert.equal(pc.signalingState, 'have-local-offer')
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0') })  // the polite peer's implicit rollback
  assert.ok(calls.some(c => c[0] === 'audioClose' && c[1] === 101))
  const live = pc.getTransceivers().filter(t => !t.stopped && t.mid)
  assert.equal(live.length, 1); assert.equal(live[0].mid, '0'); assert.equal(live[0].sender.track._nid, 9)
  assert.deepEqual(calls.filter(c => c[0] === 'audioSource').at(-1), ['audioSource', 102, 9])
  // setLocalDescription() now answers: the signalling state is read from native, not from a late event.
  await pc.setLocalDescription(); assert.deepEqual(calls.filter(c => c[0] === 'pcSetLocal').at(-1), ['pcSetLocal', 'answer'])
})

test('sender: maxBitrate reaches the encoder, replaceTrack(null) sends nothing, muted directions send nothing', async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection()
  const sender = pc.addTrack(mic(4)); await pc.createOffer()
  const p = sender.getParameters(); p.encodings[0].maxBitrate = 24000; await sender.setParameters(p)
  assert.deepEqual(calls.filter(c => c[0] === 'audioBitrate').at(-1), ['audioBitrate', 101, 24000])
  await sender.replaceTrack(null); assert.deepEqual(calls.filter(c => c[0] === 'audioSource').at(-1), ['audioSource', 101, 0])
  await sender.replaceTrack(mic(4)); pc.getTransceivers()[0].direction = 'recvonly'
  assert.deepEqual(calls.filter(c => c[0] === 'audioSource').at(-1), ['audioSource', 101, 0])
})

test('close ends the remote tracks; a build without media still refuses addTrack', () => {
  const { g } = sandbox()
  const pc = new g.RTCPeerConnection(); pc.addTransceiver('audio', { direction: 'recvonly' })
  const track = pc.getReceivers()[0].track; pc.close(); assert.equal(track.readyState, 'ended')
  const none = sandbox({ media: false })
  assert.throws(() => new none.g.RTCPeerConnection().addTrack(mic()), /no media/)
  assert.equal(none.g.RTCRtpTransceiver, undefined)
})

test('negotiationneeded: an addition the description in place carries asks for nothing; a removal asks', async () => {
  const { g, state } = sandbox()
  const pc = new g.RTCPeerConnection(); let needed = 0
  pc.onnegotiationneeded = () => needed++
  // The peer's offer, then the page's track, then the answer, in one task: the answer carries the track's m-line.
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0') })
  const sender = pc.addTrack(mic(6))
  await pc.setLocalDescription(); state.local = ['answer', offer('0')]
  await new Promise(r => setTimeout(r, 2)); assert.equal(needed, 0)
  pc.removeTrack(sender)
  await new Promise(r => setTimeout(r, 2)); assert.equal(needed, 1)
  // A transceiver with no m-line yet does ask.
  pc.addTransceiver('audio')
  await new Promise(r => setTimeout(r, 2)); assert.equal(needed, 2)
})

test('the first data channel asks for negotiation unless the description carries the data line already', async () => {
  const { g, state } = sandbox()
  g.__native.rtc.pcCreateDataChannel = () => 50; g.__native.rtc.dcInfo = () => ['state', '', -1, true, -1, -1]
  const pc = new g.RTCPeerConnection(); let needed = 0
  pc.onnegotiationneeded = () => needed++
  pc.createDataChannel('game')
  await new Promise(r => setTimeout(r, 2)); assert.equal(needed, 1)
  const pc2 = new g.RTCPeerConnection(); let needed2 = 0
  pc2.onnegotiationneeded = () => needed2++
  state.local = ['answer', 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n']
  pc2.createDataChannel('state', { negotiated: true, id: 1 })
  await new Promise(r => setTimeout(r, 2)); assert.equal(needed2, 0)
})

test('a remote offer over one not yet answered replaces it (rolled back first), keeping its transceivers', async () => {
  const { g, calls } = sandbox()
  const pc = new g.RTCPeerConnection(); const events = []
  pc.ontrack = (e) => events.push(e)
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0') })
  await pc.setRemoteDescription({ type: 'offer', sdp: offer('0') })
  assert.deepEqual(calls.filter(c => c[0] === 'pcSetRemote').map(c => c[1]), ['offer', 'rollback', 'offer'])
  assert.equal(calls.filter(c => c[0] === 'audioAdd').length, 1); assert.equal(events.length, 1)
  assert.equal(pc.signalingState, 'have-remote-offer')
})
