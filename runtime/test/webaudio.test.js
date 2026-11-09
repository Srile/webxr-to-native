import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installWebAudio } from '../src/webaudio/index.js'

// A fake __native.audio that keeps the host's bookkeeping in JS: contexts, node
// handles (ctx << 20 | slot), buffers as Float32Arrays, a call log for assertions,
// an ended trigger and a clock the test advances by hand.
function fakeAudio() {
  const log = []; const ctxs = [null]; const buffers = new Map(); let nextBuf = 1
  const ended = new Map()
  const handle = (ci, slot) => (ci << 20) | slot
  const nodeOf = h => { const c = ctxs[h >> 20]; return c?.nodes.get(h & 0xFFFFF) }
  const A = {
    log, buffers, ctxs,
    createContext(offline, channels, length, rate) {
      const id = ctxs.length; ctxs.push({ offline, channels, length, rate: rate || 48000, time: 0, running: !offline, nodes: new Map([[0, { kind: 'destination', params: {} }], [0xFFFFF, { kind: 'listener', params: {} }]]), next: 1, edges: [] })
      log.push(['createContext', offline, channels, length, rate])
      return { id, sampleRate: ctxs[id].rate, destination: handle(id, 0), listener: handle(id, 0xFFFFF), running: !offline, device: !offline }
    },
    closeContext(id) { log.push(['closeContext', id]); ctxs[id] = null },
    contextTime(id) { return ctxs[id]?.time ?? 0 },
    resume(id) { const c = ctxs[id]; if (!c || c.offline) return false; c.running = true; return true },
    suspend(id) { const c = ctxs[id]; if (!c || c.offline) return false; c.running = false; return true },
    createNode(id, kind) { const c = ctxs[id]; const slot = c.next++; c.nodes.set(slot, { kind, params: {}, props: {}, buffer: 0, started: null, stopped: null }); log.push(['createNode', id, kind]); return handle(id, slot) },
    releaseNode(h) { log.push(['releaseNode', h]) },
    connect(from, out, to, inp) { log.push(['connect', from, out, to, inp]); ctxs[from >> 20].edges.push([from, to, null]); return true },
    connectParam(from, out, to, name) { log.push(['connectParam', from, out, to, name]); ctxs[from >> 20].edges.push([from, to, name]); return true },
    disconnect(from, out, to, inp) { log.push(['disconnect', from, out, to, inp]) },
    disconnectParam(from, out, to, name) { log.push(['disconnectParam', from, out, to, name]) },
    setProp(h, name, v) { log.push(['setProp', h, name, v]); nodeOf(h).props[name] = v; return true },
    getProp(h, name) { return name === 'reduction' ? -3.5 : 0 },
    setParam(h, name, v) { log.push(['setParam', h, name, v]); nodeOf(h).params[name] = v; return true },
    paramValue(h, name) { const n = nodeOf(h); return n.params[name] ?? 0 },
    scheduleParam(h, name, op, v, t, tc) { log.push(['scheduleParam', h, name, op, v, t, tc]); nodeOf(h).params[name] = v; return true },
    cancelScheduled(h, name, t) { log.push(['cancelScheduled', h, name, t]) },
    cancelAndHold(h, name, t) { log.push(['cancelAndHold', h, name, t]) },
    start(h, when, offset, dur) { log.push(['start', h, when, offset, dur]); nodeOf(h).started = when },
    stop(h, when) { log.push(['stop', h, when]); nodeOf(h).stopped = when },
    onEnded(h, cb) { if (cb) ended.set(h, cb); else ended.delete(h) },
    fireEnded(h) { const cb = ended.get(h); ended.delete(h); cb?.(h) },
    setBuffer(h, id) { log.push(['setBuffer', h, id]); nodeOf(h).buffer = id; return true },
    createBuffer(ch, len, rate) { const id = nextBuf++; buffers.set(id, { ch: Array.from({ length: ch }, () => new Float32Array(len)), rate }); return id },
    bufferInfo(id) { const b = buffers.get(id); return b ? { channels: b.ch.length, length: b.ch[0].length, sampleRate: b.rate } : null },
    channelData(id, ch) { return buffers.get(id).ch[ch] },
    releaseBuffer(id) { buffers.delete(id) },
    detach(ab) { try { structuredClone(ab, { transfer: [ab] }); return true } catch { return false } },
    decodeAudio(bytes, rate, cb) {
      const u8 = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer)
      const ok = u8[0] === 0x52 && u8[1] === 0x49  // 'RI'
      const copy = u8.slice()
      setImmediate(() => { if (!ok) return cb(0, 0, 0, 0, 'unsupported audio container'); const id = A.createBuffer(2, copy.length, rate); buffers.get(id).ch[0].set(Float32Array.from(copy, x => x / 255)); cb(id, 2, copy.length, rate, null) })
    },
    offlineRender(id, cb) { const c = ctxs[id]; if (!c?.offline || c.rendered) return false; c.rendered = true; setImmediate(() => { const b = A.createBuffer(c.channels, c.length, c.rate); buffers.get(b).ch[0].fill(0.25); c.time = c.length / c.rate; cb(b, c.channels, c.length, c.rate) }); return true },
    stats() { return { contexts: ctxs.filter(Boolean).length, buffers: buffers.size } },
  }
  return A
}
function sandbox() {
  const g = Object.create(null); const audio = fakeAudio(); g.__native = fakeNative({ audio }); g.Promise = Promise; g.ArrayBuffer = ArrayBuffer
  installCore(g); installWebAudio(g); return { g, A: audio }
}
const calls = (A, name) => A.log.filter(e => e[0] === name)
const tick = () => new Promise(r => setImmediate(r))

test('install defines the surface; a context runs at the device rate', () => {
  const { g, A } = sandbox()
  for (const k of ['AudioContext', 'OfflineAudioContext', 'BaseAudioContext', 'AudioNode', 'AudioParam', 'AudioBuffer', 'AudioListener', 'AudioDestinationNode', 'GainNode', 'AudioBufferSourceNode', 'OscillatorNode', 'BiquadFilterNode', 'DynamicsCompressorNode', 'PannerNode']) assert.equal(typeof g[k], 'function', k)
  const ctx = new g.AudioContext()
  assert.equal(ctx.state, 'running'); assert.equal(ctx.sampleRate, 48000); assert.equal(ctx.currentTime, 0)
  assert.ok(ctx.destination instanceof g.AudioDestinationNode); assert.equal(ctx.destination.numberOfInputs, 1); assert.equal(ctx.destination.numberOfOutputs, 0)
  assert.ok(ctx.listener instanceof g.AudioListener); assert.ok(ctx.listener.positionX instanceof g.AudioParam); assert.equal(ctx.listener.forwardZ.value, -1)
  A.ctxs[ctx._id].time = 1.5; assert.equal(ctx.currentTime, 1.5)
  assert.ok(ctx instanceof g.BaseAudioContext); assert.ok(ctx instanceof g.EventTarget)
})

test('listener params and the setPosition/setOrientation fallbacks reach the reserved handle', () => {
  const { g, A } = sandbox(); const ctx = new g.AudioContext(); const l = ctx.listener
  l.positionX.value = 1; l.upY.value = 1; l.setPosition(2, 3, 4); l.setOrientation(0, 0, -1, 0, 1, 0)
  const sp = calls(A, 'setParam'); assert.equal(sp[0][1], l._h); assert.equal(sp[0][1] & 0xFFFFF, 0xFFFFF)
  assert.deepEqual(sp.map(e => [e[2], e[3]]).slice(2, 5), [['positionX', 2], ['positionY', 3], ['positionZ', 4]])
  assert.equal(l.positionX.value, 2)
})

test('resume/suspend/close drive the state machine and statechange', async () => {
  const { g } = sandbox(); const ctx = new g.AudioContext(); let changes = 0; ctx.onstatechange = () => changes++
  await ctx.suspend(); assert.equal(ctx.state, 'suspended'); await ctx.resume(); assert.equal(ctx.state, 'running'); assert.equal(changes, 2)
  let fin = false; await ctx.resume().finally(() => { fin = true }); assert.ok(fin)
  await ctx.close(); assert.equal(ctx.state, 'closed'); await assert.rejects(ctx.resume(), e => e.name === 'InvalidStateError')
})

test('factories, constructors, connect chaining and param connections', () => {
  const { g, A } = sandbox(); const ctx = new g.AudioContext()
  const osc = ctx.createOscillator(), gain = ctx.createGain(), bq = new g.BiquadFilterNode(ctx, { type: 'bandpass', Q: 3 }), comp = ctx.createDynamicsCompressor(), pan = ctx.createPanner()
  assert.equal(osc.connect(gain), gain); assert.equal(gain.connect(bq).connect(comp).connect(ctx.destination), ctx.destination)
  assert.equal(osc.connect(gain.gain), undefined)
  assert.equal(osc.numberOfInputs, 0); assert.equal(osc.numberOfOutputs, 1)
  const c = calls(A, 'connect'); assert.equal(c.length, 4); assert.deepEqual(c[0].slice(1), [osc._h, 0, gain._h, 0]); assert.deepEqual(c[3].slice(1), [comp._h, 0, ctx.destination._h, 0])
  assert.deepEqual(calls(A, 'connectParam')[0].slice(1), [osc._h, 0, gain._h, 'gain'])
  assert.equal(bq.type, 'bandpass'); assert.equal(bq.Q.value, 3); assert.deepEqual(calls(A, 'setProp').find(e => e[1] === bq._h).slice(2), ['type', 'bandpass'])
  // errors the spec requires
  const other = new g.AudioContext()
  assert.throws(() => gain.connect(other.createGain()), e => e.name === 'InvalidAccessError')
  assert.throws(() => gain.connect(osc), e => e.name === 'IndexSizeError')
  assert.throws(() => gain.connect(ctx.destination, 1), e => e.name === 'IndexSizeError')
  assert.throws(() => gain.connect({}), TypeError)
  // disconnect variants
  gain.disconnect(); gain.disconnect(0); gain.disconnect(bq); gain.disconnect(bq, 0, 0); osc.disconnect(gain.gain)
  const d = calls(A, 'disconnect'); assert.deepEqual(d.map(e => e.slice(2)), [[-1, 0, -1], [0, 0, -1], [-1, bq._h, -1], [0, bq._h, 0]])
  assert.deepEqual(calls(A, 'disconnectParam')[0].slice(1), [osc._h, -1, gain._h, 'gain'])
  void pan
})

test('AudioParam: value, every automation method, its op codes and range errors', () => {
  const { g, A } = sandbox(); const ctx = new g.AudioContext(); const gn = ctx.createGain(); const p = gn.gain
  assert.equal(p.defaultValue, 1); assert.equal(p.value, 1); assert.equal(p.automationRate, 'a-rate')
  p.value = 0.5; assert.equal(p.value, 0.5); assert.deepEqual(calls(A, 'setParam')[0].slice(1), [gn._h, 'gain', 0.5])
  assert.equal(p.setValueAtTime(0.0001, 1), p); p.exponentialRampToValueAtTime(0.3, 1.008); p.linearRampToValueAtTime(0, 2); p.setTargetAtTime(0.0001, 1.5, 0.1)
  p.cancelAndHoldAtTime(1.9); p.cancelScheduledValues(3)
  const s = calls(A, 'scheduleParam').map(e => e.slice(3))
  assert.deepEqual(s, [[0, 0.0001, 1, 0], [2, 0.3, 1.008, 0], [1, 0, 2, 0], [3, 0.0001, 1.5, 0.1]])
  assert.deepEqual(calls(A, 'cancelAndHold')[0].slice(1), [gn._h, 'gain', 1.9]); assert.deepEqual(calls(A, 'cancelScheduled')[0].slice(1), [gn._h, 'gain', 3])
  // after automation the getter reads the render's value
  A.ctxs[ctx._id].nodes.get(gn._h & 0xFFFFF).params.gain = 0.123; assert.equal(p.value, 0.123)
  assert.throws(() => p.exponentialRampToValueAtTime(0, 1), RangeError)
  assert.throws(() => p.setTargetAtTime(1, 0, -1), RangeError)
  assert.throws(() => p.setValueAtTime(1, -1), RangeError)
  assert.throws(() => p.setValueAtTime(NaN, 1), TypeError)
  assert.equal(typeof p.cancelAndHoldAtTime, 'function')  // audio.ts feature-detects it
})

test('AudioBufferSourceNode: buffer once, loop props, start(when, offset, duration), stop, onended', async () => {
  const { g, A } = sandbox(); const ctx = new g.AudioContext()
  const buf = ctx.createBuffer(1, 480, 48000); const src = ctx.createBufferSource()
  src.buffer = buf; assert.equal(src.buffer, buf); assert.deepEqual(calls(A, 'setBuffer')[0].slice(1), [src._h, buf._id])
  assert.throws(() => { src.buffer = ctx.createBuffer(1, 1, 48000) }, e => e.name === 'InvalidStateError')
  assert.throws(() => { src.buffer = {} }, TypeError)
  src.loop = true; src.loopStart = 0.1; src.loopEnd = 0.5
  assert.deepEqual(calls(A, 'setProp').filter(e => e[1] === src._h).map(e => e.slice(2)), [['loop', true], ['loopStart', 0.1], ['loopEnd', 0.5]])
  src.playbackRate.value = 1.5; src.playbackRate.setTargetAtTime(0.9, 0.2, 0.06); assert.equal(src.playbackRate.automationRate, 'k-rate')
  assert.throws(() => src.stop(), e => e.name === 'InvalidStateError')
  let endedEvents = 0; src.onended = () => endedEvents++; src.addEventListener('ended', () => endedEvents++)
  src.start(0.25, 0.03); assert.deepEqual(calls(A, 'start')[0].slice(1), [src._h, 0.25, 0.03, 0])
  assert.throws(() => src.start(), e => e.name === 'InvalidStateError')
  src.stop(0.4); assert.deepEqual(calls(A, 'stop')[0].slice(1), [src._h, 0.4])
  A.fireEnded(src._h); assert.equal(endedEvents, 2)
  // the ones audio.ts uses: start() bare, start(t), start(t, offset); stop(t) on a looping held source; no buffer + stop
  const s2 = ctx.createBufferSource(); s2.start(); s2.stop(1.2); assert.deepEqual(calls(A, 'start').at(-1).slice(2), [0, 0, 0])
  const s3 = new g.AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: 2 }); assert.equal(s3.loop, true); assert.equal(s3.playbackRate.value, 2); s3.start(0, 0, 0.5); assert.equal(calls(A, 'start').at(-1)[4], 0.5)
})

test('oscillator, biquad, compressor, panner properties', () => {
  const { g, A } = sandbox(); const ctx = new g.AudioContext()
  const osc = ctx.createOscillator(); assert.equal(osc.type, 'sine'); osc.type = 'triangle'; assert.equal(osc.type, 'triangle'); osc.type = 'bogus'; assert.equal(osc.type, 'triangle')
  assert.throws(() => { osc.type = 'custom' }, e => e.name === 'InvalidStateError')
  assert.equal(osc.frequency.value, 440); assert.equal(osc.frequency.maxValue, 24000); osc.frequency.setValueAtTime(150, 0); osc.frequency.exponentialRampToValueAtTime(70, 0.12)
  osc.start(0); osc.stop(0.14)
  const bq = ctx.createBiquadFilter(); for (const t of ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']) { bq.type = t; assert.equal(bq.type, t) }
  bq.type = 'lowpass'; bq.frequency.value = 500; bq.Q.value = 0
  const mag = new Float32Array(1); bq.getFrequencyResponse(new Float32Array([1000]), mag, new Float32Array(1)); assert.ok(Math.abs(20 * Math.log10(mag[0]) - -11.16) < 0.05, `lowpass response ${20 * Math.log10(mag[0])}`)
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12
  assert.equal(comp.reduction, -3.5); assert.equal(comp.threshold.automationRate, 'k-rate'); assert.equal(comp.ratio.maxValue, 20)
  const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 2; pan.rolloffFactor = 0.6; pan.maxDistance = 40; pan.positionX.value = 1; pan.positionY.value = 2; pan.positionZ.value = -3
  assert.equal(pan.panningModel, 'HRTF'); assert.equal(pan.refDistance, 2); pan.distanceModel = 'nope'; assert.equal(pan.distanceModel, 'inverse')
  assert.deepEqual(calls(A, 'setProp').filter(e => e[1] === pan._h).map(e => e.slice(2)), [['panningModel', 'HRTF'], ['distanceModel', 'inverse'], ['refDistance', 2], ['rolloffFactor', 0.6], ['maxDistance', 40]])
  assert.throws(() => { pan.refDistance = -1 }, RangeError)
  pan.setPosition(4, 5, 6); assert.equal(pan.positionZ.value, 6); pan.setOrientation(0, 0, 1); assert.equal(pan.orientationZ.value, 1)
  assert.equal(new g.PannerNode(ctx, { distanceModel: 'linear', positionX: 7 }).positionX.value, 7)
})

test('AudioBuffer: aliasing channel data, copyTo/FromChannel, constructor and limits', () => {
  const { g } = sandbox(); const ctx = new g.AudioContext()
  const b = ctx.createBuffer(2, 1000, 44100); assert.equal(b.numberOfChannels, 2); assert.equal(b.length, 1000); assert.equal(b.sampleRate, 44100); assert.ok(Math.abs(b.duration - 1000 / 44100) < 1e-12)
  const d = b.getChannelData(0); assert.ok(d instanceof Float32Array); assert.equal(d.length, 1000); assert.equal(b.getChannelData(0), d)
  for (let i = 0; i < d.length; i++) d[i] = i / 1000  // the game writes the noise bed straight into it
  const out = new Float32Array(10); b.copyFromChannel(out, 0, 5); assert.equal(out[0], d[5]); assert.equal(out[9], d[14])
  b.copyToChannel(new Float32Array([1, 2, 3]), 1, 7); const d1 = b.getChannelData(1); assert.deepEqual([...d1.subarray(6, 11)], [0, 1, 2, 3, 0])
  b.copyToChannel(d.subarray(0, 2000), 1)  // longer source: clipped, no throw
  assert.throws(() => b.getChannelData(2), e => e.name === 'IndexSizeError')
  const c = new g.AudioBuffer({ numberOfChannels: 1, length: 10, sampleRate: 48000 }); assert.equal(c.getChannelData(0).length, 10)
  assert.throws(() => new g.AudioBuffer({ length: 0, sampleRate: 48000 }), e => e.name === 'NotSupportedError')
})

test('decodeAudioData: promise and callback forms, input detached, EncodingError on garbage', async () => {
  const { g } = sandbox(); const ctx = new g.AudioContext()
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 10, 20, 30, 40]).buffer
  const copy = wav.slice(0)
  const buf = await ctx.decodeAudioData(copy)
  assert.ok(buf instanceof g.AudioBuffer); assert.equal(buf.numberOfChannels, 2); assert.equal(buf.length, 8); assert.equal(buf.sampleRate, 48000)
  assert.ok(Math.abs(buf.getChannelData(0)[4] - 10 / 255) < 1e-6)
  assert.equal(copy.byteLength, 0, 'input detached like a browser'); assert.equal(wav.byteLength, 8, 'the caller\'s own copy untouched')
  let cbBuf = null; await ctx.decodeAudioData(wav.slice(0), b => { cbBuf = b }); assert.ok(cbBuf instanceof g.AudioBuffer)
  const bad = new Uint8Array([1, 2, 3, 4]).buffer; let errCb = null
  await assert.rejects(ctx.decodeAudioData(bad, null, e => { errCb = e }), e => e.name === 'EncodingError'); assert.equal(errCb?.name, 'EncodingError')
  await assert.rejects(ctx.decodeAudioData(new Uint8Array(4)), TypeError)
  await assert.rejects(ctx.decodeAudioData(copy), e => e.name === 'DataCloneError')
})

test('OfflineAudioContext: both constructor forms, startRendering once, complete event', async () => {
  const { g, A } = sandbox()
  const off = new g.OfflineAudioContext(1, 4800, 48000); assert.equal(off.length, 4800); assert.equal(off.sampleRate, 48000); assert.equal(off.state, 'suspended')
  assert.deepEqual(calls(A, 'createContext')[0].slice(1), [true, 1, 4800, 48000])
  const osc = off.createOscillator(); osc.connect(off.destination); osc.start(0); osc.stop(0.05)
  let completed = null; off.oncomplete = e => { completed = e.renderedBuffer }
  const p = off.startRendering(); assert.equal(off.state, 'running')
  await assert.rejects(off.startRendering(), e => e.name === 'InvalidStateError')
  const buf = await p; assert.ok(buf instanceof g.AudioBuffer); assert.equal(buf.length, 4800); assert.equal(buf.numberOfChannels, 1); assert.equal(buf.getChannelData(0)[100], 0.25)
  assert.equal(completed, buf); assert.equal(off.state, 'closed'); assert.equal(off.currentTime, 0.1)
  const off2 = new g.OfflineAudioContext({ numberOfChannels: 2, length: 100.5, sampleRate: 44100 }); assert.equal(off2.length, 101); assert.equal(off2.destination.maxChannelCount, 2)
  assert.throws(() => new g.OfflineAudioContext(1, 0, 48000), e => e.name === 'NotSupportedError')
  await assert.rejects(off2.suspend(), e => e.name === 'NotSupportedError')
})

// The game's own patterns (src/audio.ts), transcribed: the live patch, the
// bake's measure-then-render pass, the held loop, the placed sample.
test('audio.ts shapes: live patch, bake, hold, positional sample', async () => {
  const { g, A } = sandbox(); const a = new g.AudioContext()
  const master = a.createDynamicsCompressor(); master.threshold.value = -18; master.knee.value = 12; master.ratio.value = 6; master.attack.value = 0.002; master.release.value = 0.12; master.connect(a.destination)
  const noise = a.createBuffer(1, a.sampleRate, a.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  function bloop(v, f0, f1, dur, gain, when = 0, type = 'sine') {
    const t = v.t + when; if (t + dur + 0.02 > v.end) v.end = t + dur + 0.02; if (!v.dest) return
    const osc = v.a.createOscillator(), gn = v.a.createGain(); osc.type = type
    osc.frequency.setValueAtTime(Math.max(f0, 1), t); osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur)
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(gain, t + 0.008); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(gn).connect(v.dest); osc.start(t); osc.stop(t + dur + 0.02)
  }
  function fizz(v, c0, c1, q, dur, gain, when = 0) {
    const t = v.t + when; if (t + dur + 0.02 > v.end) v.end = t + dur + 0.02; if (!v.dest) return
    const src = v.a.createBufferSource(); src.buffer = noise; const bp = v.a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q
    bp.frequency.setValueAtTime(Math.max(c0, 40), t); bp.frequency.exponentialRampToValueAtTime(Math.max(c1, 40), t + dur)
    const gn = v.a.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(gain, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp).connect(gn).connect(v.dest); src.start(t); src.stop(t + dur + 0.02)
  }
  function note(v, f0, f1, bend, dur, gain, when = 0, attack = 0.02) {
    const t = v.t + when; if (t + dur + 0.02 > v.end) v.end = t + dur + 0.02; if (!v.dest) return
    const osc = v.a.createOscillator(), gn = v.a.createGain()
    osc.frequency.setValueAtTime(Math.max(f0, 1), t); if (bend > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + bend)
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(gain, t + attack); gn.gain.setTargetAtTime(0.0001, t + attack, dur * 0.25)
    if (gn.gain.cancelAndHoldAtTime) { gn.gain.cancelAndHoldAtTime(t + dur - 0.02); gn.gain.linearRampToValueAtTime(0.0001, t + dur) }
    osc.connect(gn).connect(v.dest); osc.start(t); osc.stop(t + dur + 0.02)
  }
  const patches = [v => { bloop(v, 150, 70, 0.12, 0.22); fizz(v, 900, 2600, 2.5, 0.09, 0.045, 0.02) }, v => { note(v, 440, 523, 0.035, 0.42, 0.11, 0.004, 0.025); fizz(v, 1300, 2000, 3, 0.03, 0.012) }]
  // live
  const live = { a, dest: master, t: a.currentTime, end: 0 }; patches[0](live); patches[1](live)
  // bake: measure with no dest, then render offline, then slice into buffers
  const v = { a, dest: null, t: 0, end: 0 }; const at = [], span = []; let cursor = 0.05
  for (const p of patches) { v.t = cursor; v.end = cursor; p(v); at.push(cursor); span.push(v.end - cursor); cursor = v.end + 0.05 }
  const off = new g.OfflineAudioContext(1, Math.ceil(cursor * a.sampleRate), a.sampleRate); v.a = off; v.dest = off.destination
  for (let i = 0; i < patches.length; i++) { v.t = at[i]; v.end = at[i]; patches[i](v) }
  const pcm = (await off.startRendering()).getChannelData(0)
  const baked = []
  for (let i = 0; i < patches.length; i++) { const from = Math.floor(at[i] * a.sampleRate), to = Math.min(pcm.length, Math.ceil((at[i] + span[i]) * a.sampleRate) + 1); const buf = a.createBuffer(1, to - from, a.sampleRate); buf.copyToChannel(pcm.subarray(from, to), 0); baked.push(buf) }
  assert.equal(baked.length, 2); assert.equal(baked[0].getChannelData(0)[10], 0.25)
  // a baked play, scattered: a single source at a rate through a gain
  const src = a.createBufferSource(); src.buffer = baked[0]; src.playbackRate.value = 2 ** (0.7 / 12); const gn = a.createGain(); gn.gain.value = 0.8; src.connect(gn).connect(master); src.start(a.currentTime + 0.07)
  // hold: a looping source steered every frame
  const h = a.createBufferSource(); h.buffer = baked[1]; h.loop = true; const hg = a.createGain(); hg.gain.value = 0; h.connect(hg).connect(master); h.start()
  for (let f = 0; f < 3; f++) { const t = a.currentTime; hg.gain.setTargetAtTime(0.5 + f * 0.1, t, 0.06); h.playbackRate.setTargetAtTime(0.9 + f * 0.05, t, 0.06) }
  hg.gain.setTargetAtTime(0, a.currentTime, 0.08); h.stop(a.currentTime + 0.4)
  // positional: listener pose then a panner per play
  const l = a.listener; l.positionX.value = 0; l.positionY.value = 1.6; l.positionZ.value = 0; l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0
  const pan = a.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1; pan.rolloffFactor = 1; pan.maxDistance = 30; pan.positionX.value = 2; pan.positionY.value = 1; pan.positionZ.value = -3
  const ps = a.createBufferSource(); ps.buffer = baked[0]; const pg = a.createGain(); pg.gain.value = 0.45; ps.connect(pg).connect(pan).connect(master); ps.start()
  const toMono = (buf) => { const n = buf.numberOfChannels; if (n < 2) return buf; const mono = a.createBuffer(1, buf.length, buf.sampleRate); const d = mono.getChannelData(0); for (let c = 0; c < n; c++) { const s = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] += s[i] / n } return mono }
  const decoded = toMono(await a.decodeAudioData(new Uint8Array([0x52, 0x49, 0x46, 0x46, 255, 255]).buffer)); assert.equal(decoded.numberOfChannels, 1); assert.ok(Math.abs(decoded.getChannelData(0)[4] - 0.5) < 1e-6)
  assert.ok(calls(A, 'createNode').length > 20); assert.ok(calls(A, 'scheduleParam').length > 40)
  assert.equal(A.log.filter(e => e[0] === 'createNode' && e[1] === off._id).length, calls(A, 'createNode').filter(e => e[1] === off._id).length)
})

test('no __native.audio: install logs and leaves the globals undefined', () => {
  const g = Object.create(null); g.__native = fakeNative({ audio: {} }); installCore(g); installWebAudio(g); assert.equal(g.AudioContext, undefined)
})
