import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installWebAudio } from '../src/webaudio/index.js'
import { install as installMedia } from '../src/media/index.js'

// A fake __native.media (host/media/media_bind.cpp): one default input, a permission the test answers, tracks by id.
function fakeMedia({ answer = 'granted', perm = 'prompt', rate = 48000, caps } = {}) {
  let nextId = 1, onEvent = null
  const calls = [], tracks = new Map()
  const M = {
    platform: 'test', calls, tracks,
    permission: () => perm,
    request: (cb) => { calls.push(['request']); setImmediate(() => { perm = answer; cb(answer) }) },
    devices: () => [{ deviceId: 'default', groupId: 'g1', label: 'Test Mic' }],
    capabilities: () => caps ?? ({ echoCancellation: [true, false], noiseSuppression: [true, false], autoGainControl: [true, false] }),
    open: (p) => {
      calls.push(['open', p]); if (perm !== 'granted') return 'NotAllowedError: not granted'
      const id = nextId++; tracks.set(id, { live: true, enabled: true })
      return { id, label: 'Test Mic', deviceId: 'default', groupId: 'g1', sampleRate: rate, preset: 'x', ...p }
    },
    stop: (id) => { calls.push(['stop', id]); tracks.get(id).live = false },
    release: (id) => calls.push(['release', id]),
    setEnabled: (id, on) => { calls.push(['setEnabled', id, on]); tracks.get(id).enabled = on; return true },
    onEvent: (f) => { onEvent = f },
    emit: (...a) => onEvent(...a),
    setPerm: (p) => { perm = p },
    stats: () => ({}),
  }
  return M
}
// Just enough __native.audio for the node wrappers: contexts, node handles, the calls made.
function fakeAudio() {
  const calls = []; let ctxs = 0, next = 1
  return {
    calls,
    createContext: (offline, ch, len, rate) => { const id = ++ctxs; return { id, sampleRate: rate || 48000, destination: (id << 20), listener: (id << 20) | 0xFFFFF, running: !offline, device: !offline } },
    closeContext() {}, contextTime: () => 0, resume: () => true, suspend: () => true,
    createNode: (id, kind) => { calls.push(['createNode', kind]); return (id << 20) | next++ },
    releaseNode() {}, connect: () => true, disconnect() {}, setParam: () => true, setProp: () => true,
    setInput: (h, nid) => { calls.push(['setInput', h, nid]); return true },
    analyserSize: (h, n) => { calls.push(['analyserSize', h, n]); return true },
    analyserTime: (h, a) => { calls.push(['analyserTime', h, a.constructor.name, a.length]); a.fill(a instanceof Uint8Array ? 128 : 0.25) },
    analyserFrequency: (h, a, s, min, max) => { calls.push(['analyserFrequency', h, a.constructor.name, a.length, s, min, max]); a.fill(a instanceof Uint8Array ? 7 : -42) },
  }
}
function sandbox(opts = {}, { media = true } = {}) {
  const g = Object.create(null)
  const m = media ? fakeMedia(opts) : null, audio = fakeAudio()
  g.__native = fakeNative({ audio, ...(m ? { media: m } : {}) }); g.Promise = Promise; g.ArrayBuffer = ArrayBuffer
  g.Float32Array = Float32Array; g.Uint8Array = Uint8Array; g.FinalizationRegistry = FinalizationRegistry
  installCore(g); installWebAudio(g); installMedia(g)
  return { g, m, audio }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

test('without __native.media the page sees no microphone: no mediaDevices, source node; MediaStream only as an inert stub', async () => {
  const { g } = sandbox({}, { media: false })
  assert.equal(g.navigator.mediaDevices, undefined)
  assert.equal(g.MediaStreamAudioSourceNode, undefined)
  // webaudio/ defines inert MediaStream / MediaStreamTrack stubs for every page (Howler's `x instanceof MediaStream`
  // throws when MediaStream is undefined): constructible, no tracks, nothing captures.
  assert.equal(typeof g.MediaStream, 'function'); assert.equal(new g.MediaStream().getTracks().length, 0)
  assert.equal(g.webkitMediaStream, g.MediaStream)
  assert.equal('mediaDevices' in g.navigator, false)
  const ctx = new g.AudioContext()
  assert.throws(() => ctx.createMediaStreamSource({}), (e) => e.name === 'NotSupportedError')
  assert.equal((await g.navigator.permissions.query({ name: 'microphone' })).state, 'prompt')
  assert.equal(typeof g.AnalyserNode, 'function', 'AnalyserNode is not gated')
})

test('API shape: mediaDevices, constraints, devices before and after the permission', async () => {
  const { g } = sandbox()
  assert.equal(g.webkitMediaStream, g.MediaStream, 'webkitMediaStream follows the real MediaStream')
  const md = g.navigator.mediaDevices
  assert.ok(md instanceof g.EventTarget); assert.ok('ondevicechange' in md)
  assert.throws(() => new g.MediaDevices(), TypeError)
  assert.deepEqual(Object.keys(md.getSupportedConstraints()).sort(), ['autoGainControl', 'channelCount', 'deviceId', 'echoCancellation', 'groupId', 'noiseSuppression', 'sampleRate', 'sampleSize'])
  let d = await md.enumerateDevices()
  assert.equal(d.length, 1); assert.equal(d[0].kind, 'audioinput'); assert.equal(d[0].label, ''); assert.equal(d[0].deviceId, '')
  assert.ok(d[0] instanceof g.InputDeviceInfo); assert.deepEqual(JSON.parse(JSON.stringify(d[0])), { deviceId: '', kind: 'audioinput', label: '', groupId: '' })
  await md.getUserMedia({ audio: true })
  d = await md.enumerateDevices()
  assert.equal(d[0].label, 'Test Mic'); assert.equal(d[0].deviceId, 'default'); assert.equal(d[0].groupId, 'g1')
})

test('getUserMedia: asks once, resolves a stream with one live audio track; the permission status follows', async () => {
  const { g, m } = sandbox()
  const st = await g.navigator.permissions.query({ name: 'microphone' })
  assert.equal(st.state, 'prompt'); let changes = 0; st.onchange = () => changes++
  const [a, b] = await Promise.all([g.navigator.mediaDevices.getUserMedia({ audio: true }), g.navigator.mediaDevices.getUserMedia({ audio: {} })])
  assert.equal(m.calls.filter((c) => c[0] === 'request').length, 1, 'one prompt for two calls')
  assert.equal(st.state, 'granted'); assert.equal(changes, 1)
  assert.ok(a instanceof g.MediaStream); assert.equal(a.active, true)
  const [t] = a.getAudioTracks()
  assert.equal(t.kind, 'audio'); assert.equal(t.readyState, 'live'); assert.equal(t.enabled, true); assert.equal(t.muted, false); assert.equal(t.label, 'Test Mic')
  assert.deepEqual(a.getVideoTracks(), []); assert.equal(a.getTrackById(t.id), t); assert.equal(a.getTrackById('x'), null)
  assert.notEqual(a.id, b.id); assert.notEqual(t.id, b.getTracks()[0].id)
  assert.deepEqual(t.getSettings(), { deviceId: 'default', groupId: 'g1', sampleRate: 48000, sampleSize: 16, channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true })
  assert.deepEqual(t.getCapabilities().sampleRate, { min: 48000, max: 48000 }); assert.deepEqual(t.getCapabilities().echoCancellation, [true, false])
  await g.navigator.mediaDevices.getUserMedia({ audio: true })
  assert.equal(m.calls.filter((c) => c[0] === 'request').length, 1, 'granted: no second prompt')
})

test('getUserMedia rejects as browsers do: video, nothing asked, a denied permission', async () => {
  const { g } = sandbox({ answer: 'denied' })
  const md = g.navigator.mediaDevices
  await assert.rejects(md.getUserMedia({ video: true }), (e) => e.name === 'NotFoundError')
  await assert.rejects(md.getUserMedia({ audio: true, video: true }), (e) => e.name === 'NotFoundError')
  await assert.rejects(md.getUserMedia({}), TypeError)
  await assert.rejects(md.getUserMedia(), TypeError)
  await assert.rejects(md.getUserMedia({ audio: true }), (e) => e.name === 'NotAllowedError')
  assert.equal((await g.navigator.permissions.query({ name: 'microphone' })).state, 'denied')
  assert.equal((await g.navigator.permissions.query({ name: 'camera' })).state, 'prompt', 'other names unchanged')
})

test('constraints: exact requirements the device cannot meet are OverconstrainedError; preferences are honoured where they can be', async () => {
  const { g, m } = sandbox({ perm: 'granted', rate: 48000 })
  const md = g.navigator.mediaDevices
  const over = (c, name) => assert.rejects(md.getUserMedia({ audio: c }), (e) => e instanceof g.OverconstrainedError && e.name === 'OverconstrainedError' && e.constraint === name)
  await over({ channelCount: { exact: 2 } }, 'channelCount')
  await over({ channelCount: { min: 2 } }, 'channelCount')
  await over({ deviceId: { exact: 'elsewhere' } }, 'deviceId')
  await over({ sampleRate: { exact: 44100 } }, 'sampleRate')
  assert.equal(m.calls.at(-1)[0], 'stop', 'the rate is known once open: that track is stopped again')
  const s = await md.getUserMedia({ audio: { channelCount: 2, sampleRate: 16000, deviceId: 'elsewhere', echoCancellation: false, noiseSuppression: { exact: false }, autoGainControl: { ideal: false } } })
  assert.deepEqual(m.calls.filter((c) => c[0] === 'open').at(-1)[1], { echoCancellation: false, noiseSuppression: false, autoGainControl: false })
  const t = s.getTracks()[0]
  assert.equal(t.getConstraints().channelCount, 2)
  await assert.rejects(t.applyConstraints({ echoCancellation: { exact: true } }), (e) => e.constraint === 'echoCancellation')
  await t.applyConstraints({ echoCancellation: true }); assert.equal(t.getConstraints().echoCancellation, true)
  await md.getUserMedia({ audio: { deviceId: { exact: 'default' }, sampleRate: { exact: 48000 }, channelCount: { exact: 1 } } })
  // A platform without processing (mac, Linux): preferences fall back to what it has; requirements fail.
  const mac = sandbox({ perm: 'granted', caps: { echoCancellation: [false], noiseSuppression: [false], autoGainControl: [false] } })
  const s2 = await mac.g.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
  assert.equal(s2.getTracks()[0].getSettings().echoCancellation, false)
  await assert.rejects(mac.g.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: { exact: true } } }), (e) => e.constraint === 'echoCancellation')
})

test('tracks: enabled, stop (no ended event, the stream goes inactive), a lost device (ended), clone', async () => {
  const { g, m } = sandbox({ perm: 'granted' })
  const s = await g.navigator.mediaDevices.getUserMedia({ audio: true }); const t = s.getTracks()[0], nid = m.calls.filter((c) => c[0] === 'open').length
  t.enabled = false; assert.deepEqual(m.calls.at(-1), ['setEnabled', nid, false]); assert.equal(t.enabled, false)
  const c = t.clone(); assert.notEqual(c.id, t.id); assert.equal(c.enabled, false); assert.equal(c.readyState, 'live')
  assert.equal(m.calls.filter((x) => x[0] === 'open').length, nid + 1, 'a clone opens its own track on the shared device')
  let ended = 0, inactive = 0; t.onended = () => ended++; s.oninactive = () => inactive++
  t.stop(); t.stop()
  assert.equal(t.readyState, 'ended'); assert.equal(s.active, false); assert.equal(m.calls.filter((x) => x[0] === 'stop').length, 1)
  await tick(); assert.equal(ended, 0, 'stop() fires no ended'); assert.equal(inactive, 1)
  assert.equal(t.clone().readyState, 'ended', 'a clone of an ended track is ended')
  let cEnded = 0; c.addEventListener('ended', () => cEnded++)
  m.emit('ended', nid + 1)
  assert.equal(c.readyState, 'ended'); assert.equal(cEnded, 1, "the device's end fires ended")
  let changed = 0; g.navigator.mediaDevices.ondevicechange = () => changed++; m.emit('devicechange', 0); assert.equal(changed, 1)
})

test('MediaStream: constructors, addTrack/removeTrack, clone, the inactive event', async () => {
  const { g } = sandbox({ perm: 'granted' })
  const s = await g.navigator.mediaDevices.getUserMedia({ audio: true }); const t = s.getTracks()[0]
  assert.equal(new g.MediaStream().active, false); assert.equal(new g.MediaStream().getTracks().length, 0)
  const copy = new g.MediaStream(s); assert.equal(copy.getTracks()[0], t); assert.notEqual(copy.id, s.id)
  const arr = new g.MediaStream([t]); assert.equal(arr.getTracks()[0], t)
  assert.throws(() => new g.MediaStream([{}]), TypeError); assert.throws(() => new g.MediaStream(5), TypeError)
  const e = new g.MediaStream(); e.addTrack(t); e.addTrack(t); assert.equal(e.getTracks().length, 1); assert.equal(e.active, true)
  let inactive = 0; e.addEventListener('inactive', () => inactive++)
  e.removeTrack(t); assert.equal(e.getTracks().length, 0); await tick(); assert.equal(inactive, 1)
  const cl = s.clone(); assert.notEqual(cl.getTracks()[0], t); assert.equal(cl.getTracks()[0].readyState, 'live')
  assert.throws(() => new g.MediaStreamTrack(), TypeError)
  const ev = new g.MediaStreamTrackEvent('addtrack', { track: t }); assert.equal(ev.track, t)
})

test('MediaStreamAudioSourceNode: the native node reads the first audio track by id; AudioContext only', async () => {
  const { g, audio } = sandbox({ perm: 'granted' })
  const s = await g.navigator.mediaDevices.getUserMedia({ audio: true })
  const ctx = new g.AudioContext()
  const n = ctx.createMediaStreamSource(s)
  assert.ok(n instanceof g.MediaStreamAudioSourceNode); assert.ok(n instanceof g.AudioNode)
  assert.equal(n.mediaStream, s); assert.equal(n.numberOfInputs, 0); assert.equal(n.numberOfOutputs, 1)
  assert.deepEqual(audio.calls.filter((c) => c[0] === 'createNode').at(-1), ['createNode', 'mediaStream'])
  assert.deepEqual(audio.calls.at(-1), ['setInput', n._h, 1])
  const n2 = new g.MediaStreamAudioSourceNode(ctx, { mediaStream: s }); assert.equal(n2.mediaStream, s)
  assert.throws(() => new g.MediaStreamAudioSourceNode(new g.OfflineAudioContext(1, 128, 48000), { mediaStream: s }), TypeError)
  assert.equal(new g.OfflineAudioContext(1, 128, 48000).createMediaStreamSource, undefined)
  assert.throws(() => ctx.createMediaStreamSource(new g.MediaStream()), (e) => e.name === 'InvalidStateError')
  assert.throws(() => ctx.createMediaStreamSource({}), TypeError)
  const an = ctx.createAnalyser(); n.connect(an)  // the meter pattern
  // Of two tracks the source takes the one whose id sorts first.
  const two = new g.MediaStream([s.getTracks()[0], s.getTracks()[0].clone()]); const first = two.getTracks().slice().sort((a, b) => (a.id < b.id ? -1 : 1))[0]
  ctx.createMediaStreamSource(two); assert.equal(audio.calls.at(-1)[2], first._nid)
})

test('AnalyserNode: defaults, validation, the page\'s arrays handed to native', () => {
  const { g, audio } = sandbox({}, { media: false })
  const ctx = new g.AudioContext(), a = ctx.createAnalyser()
  assert.ok(a instanceof g.AnalyserNode); assert.equal(a.numberOfInputs, 1); assert.equal(a.numberOfOutputs, 1)
  assert.equal(a.fftSize, 2048); assert.equal(a.frequencyBinCount, 1024); assert.equal(a.minDecibels, -100); assert.equal(a.maxDecibels, -30); assert.equal(a.smoothingTimeConstant, 0.8)
  assert.deepEqual(audio.calls.at(-1), ['analyserSize', a._h, 2048])
  a.fftSize = 512; assert.equal(a.frequencyBinCount, 256); assert.deepEqual(audio.calls.at(-1), ['analyserSize', a._h, 512])
  for (const bad of [0, 16, 48, 1000, 65536]) assert.throws(() => { a.fftSize = bad }, (e) => e.name === 'IndexSizeError', String(bad))
  assert.throws(() => { a.minDecibels = -30 }, (e) => e.name === 'IndexSizeError'); assert.throws(() => { a.maxDecibels = -100 }, (e) => e.name === 'IndexSizeError')
  assert.throws(() => { a.smoothingTimeConstant = 1.5 }, (e) => e.name === 'IndexSizeError')
  a.smoothingTimeConstant = 0; a.minDecibels = -90; a.maxDecibels = -10
  const f = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(f); assert.equal(f[0], -42)
  assert.deepEqual(audio.calls.at(-1), ['analyserFrequency', a._h, 'Float32Array', 256, 0, -90, -10])
  const b = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(b); assert.equal(b[3], 7)
  const t = new Float32Array(a.fftSize); a.getFloatTimeDomainData(t); assert.equal(t[0], 0.25)
  const tb = new Uint8Array(a.fftSize); a.getByteTimeDomainData(tb); assert.equal(tb[0], 128)
  assert.throws(() => a.getFloatFrequencyData(new Uint8Array(4)), TypeError); assert.throws(() => a.getByteTimeDomainData([]), TypeError)
  const o = new g.AnalyserNode(ctx, { fftSize: 256, minDecibels: -80, maxDecibels: -20, smoothingTimeConstant: 0.5 })
  assert.equal(o.fftSize, 256); assert.equal(o.minDecibels, -80); assert.equal(o.smoothingTimeConstant, 0.5)
  assert.throws(() => new g.AnalyserNode(ctx, { minDecibels: -10, maxDecibels: -20 }), (e) => e.name === 'IndexSizeError')
  assert.ok(new g.OfflineAudioContext(1, 128, 48000).createAnalyser() instanceof g.AnalyserNode)
})
