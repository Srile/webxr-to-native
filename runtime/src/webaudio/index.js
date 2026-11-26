// WebAudio over `__native.audio` (WP-08). install(g) defines AudioContext,
// OfflineAudioContext, BaseAudioContext, AudioNode and its subclasses,
// AudioParam, AudioBuffer, AudioListener and AudioDestinationNode on g.
// Scope: what WebXR games' audio code uses (no media elements, no AudioWorklet).
//
// __native.audio (host/audio/audio_bind.cpp) — handles are integers, 0 = none:
//   createContext(offline, channels, length, sampleRate|0)
//       → { id, sampleRate, destination, listener, running, device }
//       A realtime context opens the device stream and starts RUNNING (no
//       gesture gate here); sampleRate is the stream's. Offline renders
//       `length` frames of `channels` at `sampleRate`.
//   closeContext(id)            frees the graph, buffers it held, the stream
//   contextTime(id) → seconds   rendered frames / sampleRate (never wall time)
//   resume(id) / suspend(id) → bool   realtime only
//   createNode(ctx, kind) → handle    kind: 'gain' | 'bufferSource' | 'oscillator' | 'biquad' | 'compressor' | 'panner' | 'analyser' | 'mediaStream'
//   releaseNode(handle)         the JS wrapper is gone; native frees the node once it can never sound
//   connect(from, output, to, input) → bool
//   connectParam(from, output, to, paramName) → bool
//   disconnect(from, output|-1, to|0, input|-1)   to 0 = every node connection
//   disconnectParam(from, output|-1, to, paramName|undefined)
//   setProp(node, name, number|string|boolean) → bool
//       type, loop, loopStart, loopEnd, panningModel, distanceModel, refDistance,
//       rolloffFactor, maxDistance, coneInnerAngle, coneOuterAngle, coneOuterGain
//   getProp(node, name) → number      'reduction' (compressor)
//   setParam(node, paramName, value)  the AudioParam.value setter (intrinsic value now)
//   paramValue(node, paramName) → number   the last value the render computed
//   scheduleParam(node, paramName, op, value, time, timeConstant) → bool
//       op 0 setValueAtTime, 1 linearRampToValueAtTime, 2 exponentialRampToValueAtTime, 3 setTargetAtTime
//   cancelScheduled(node, paramName, time) / cancelAndHold(node, paramName, time)
//   start(node, when, offset, duration) / stop(node, when)
//   onEnded(node, cb|null)      cb(handle) posted to the host loop once; keeps cb alive until then
//   setBuffer(node, bufferId|0) → bool
//   createBuffer(channels, length, sampleRate) → bufferId
//   bufferInfo(bufferId) → { channels, length, sampleRate } | null
//   channelData(bufferId, ch) → Float32Array ALIASING the native PCM (its
//       backing store holds a reference; the PCM lives until every alias, the
//       wrapper (releaseBuffer) and every node holding it are gone)
//   releaseBuffer(bufferId)
//   decodeAudio(bytes, targetRate, cb(bufferId|0, channels, length, sampleRate, err|null))
//       copies the bytes, decodes WAV, Ogg or WebM (Vorbis, Opus) or MP3 off the host thread, resamples to targetRate
//   codecs: 'wav vorbis opus mp3' — what decodeAudio decodes in this build (opus: libopus, mp3: dr_mp3); canPlayType reads it
//   detach(arrayBuffer) → bool    browsers detach decodeAudioData's input; so do we
//   offlineRender(ctx, cb(bufferId|0, channels, length, sampleRate)) → bool
//   stats(ctx?) → { contexts, buffers, endedCallbacks, maxNodes, liveNodes?, droppedMsgs?, droppedCommands? }
//   analyserSize(node, fftSize) → bool            (WP-25) an 'analyser' node's history + FFT, sized here (host thread)
//   analyserTime(node, Float32Array|Uint8Array)    the latest fftSize samples into the array, in place
//   analyserFrequency(node, Float32Array|Uint8Array, smoothing, minDb, maxDb)   the spec's frequency data, in place
//   setInput(node, trackId) → bool                 a 'mediaStream' node reads that capture track (only in a build
//                                                  with the microphone, media/index.js; absent otherwise)
// The listener is a reserved handle: setParam/scheduleParam on it with
// positionX..Z, forwardX..Z, upX..Z. Every node has one input (sources none)
// and one output, so the output/input indices are validated here and 0 natively.

import { installMediaElements } from './media-elements.js'

const KINDS = { gain: 'gain', bufferSource: 'bufferSource', oscillator: 'oscillator', biquad: 'biquad', compressor: 'compressor', panner: 'panner', analyser: 'analyser' }
const OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle']
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']
const DISTANCE_MODELS = ['inverse', 'linear', 'exponential']
const PANNING_MODELS = ['equalpower', 'HRTF']

export function install(g) {
  const N = g.__native?.audio
  if (!N || typeof N.createContext !== 'function') { g.__native?.log?.(2, 'webaudio: __native.audio missing; AudioContext not installed'); return }
  const ET = g.EventTarget ?? class { addEventListener() {} removeEventListener() {} dispatchEvent() { return true } }
  const Ev = g.Event ?? class { constructor(type) { this.type = type } }
  const DOMEx = g.DOMException
  const err = (name, msg) => { const e = DOMEx ? new DOMEx(msg, name) : new Error(msg); if (!DOMEx) e.name = name; return e }
  const FR = g.FinalizationRegistry ?? globalThis.FinalizationRegistry
  const nodeReg = FR ? new FR(h => N.releaseNode(h)) : null
  const bufReg = FR ? new FR(id => N.releaseBuffer(id)) : null
  const ctxReg = FR ? new FR(id => N.closeContext(id)) : null
  const finite = (v, what) => { v = +v; if (!Number.isFinite(v)) throw new TypeError(`${what} is not a finite number`); return v }
  const nonNeg = (v, what) => { v = finite(v, what); if (v < 0) throw new RangeError(`${what} must be non-negative`); return v }

  // ---- AudioParam ---------------------------------------------------------------
  class AudioParam {
    constructor(ctx, handle, name, def, min, max, rate) {
      this._ctx = ctx; this._h = handle; this._name = name; this._v = def; this._auto = false
      this.defaultValue = def; this.minValue = min; this.maxValue = max; this.automationRate = rate
    }
    get value() { return this._auto ? N.paramValue(this._h, this._name) : this._v }
    set value(v) { v = finite(v, 'value'); this._v = v; N.setParam(this._h, this._name, v) }
    setValueAtTime(v, t) { N.scheduleParam(this._h, this._name, 0, finite(v, 'value'), nonNeg(t, 'startTime'), 0); this._auto = true; return this }
    linearRampToValueAtTime(v, t) { N.scheduleParam(this._h, this._name, 1, finite(v, 'value'), nonNeg(t, 'endTime'), 0); this._auto = true; return this }
    exponentialRampToValueAtTime(v, t) {
      v = finite(v, 'value'); if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must be non-zero')
      N.scheduleParam(this._h, this._name, 2, v, nonNeg(t, 'endTime'), 0); this._auto = true; return this
    }
    setTargetAtTime(target, t, tc) { N.scheduleParam(this._h, this._name, 3, finite(target, 'target'), nonNeg(t, 'startTime'), nonNeg(tc, 'timeConstant')); this._auto = true; return this }
    setValueCurveAtTime() { throw err('NotSupportedError', 'setValueCurveAtTime is not implemented by this host') }
    cancelScheduledValues(t) { N.cancelScheduled(this._h, this._name, nonNeg(t, 'cancelTime')); return this }
    cancelAndHoldAtTime(t) { N.cancelAndHold(this._h, this._name, nonNeg(t, 'cancelTime')); return this }
  }

  // ---- nodes ----------------------------------------------------------------------
  class AudioNode extends ET {
    constructor(ctx, handle, inputs, outputs) {
      super()
      if (!(ctx instanceof BaseAudioContext)) throw new TypeError('AudioNode: context required')
      this.context = ctx; this._h = handle; this.numberOfInputs = inputs; this.numberOfOutputs = outputs
      this.channelCount = 2; this.channelCountMode = 'max'; this.channelInterpretation = 'speakers'
      if (handle && nodeReg && !(this instanceof AudioDestinationNode)) nodeReg.register(this, handle, this)
    }
    _param(name, def, min = -3.4028234663852886e38, max = 3.4028234663852886e38, rate = 'a-rate') { return new AudioParam(this.context, this._h, name, def, min, max, rate) }
    connect(dest, output = 0, input = 0) {
      output = output | 0; input = input | 0
      if (output < 0 || output >= this.numberOfOutputs) throw err('IndexSizeError', `output index ${output} out of range`)
      if (dest instanceof AudioParam) {
        if (dest._ctx !== this.context) throw err('InvalidAccessError', 'connect: AudioParam belongs to another context')
        N.connectParam(this._h, output, dest._h, dest._name); return undefined
      }
      if (!(dest instanceof AudioNode)) throw new TypeError('connect: destination must be an AudioNode or AudioParam')
      if (dest.context !== this.context) throw err('InvalidAccessError', 'connect: node belongs to another context')
      if (input < 0 || input >= dest.numberOfInputs) throw err('IndexSizeError', `input index ${input} out of range`)
      N.connect(this._h, output, dest._h, input); return dest
    }
    disconnect(a, b, c) {
      if (a === undefined) { N.disconnect(this._h, -1, 0, -1); return }
      if (typeof a === 'number') { if (a < 0 || a >= this.numberOfOutputs) throw err('IndexSizeError', 'disconnect: bad output'); N.disconnect(this._h, a, 0, -1); return }
      if (a instanceof AudioParam) { N.disconnectParam(this._h, b === undefined ? -1 : b | 0, a._h, a._name); return }
      if (!(a instanceof AudioNode)) throw new TypeError('disconnect: bad destination')
      N.disconnect(this._h, b === undefined ? -1 : b | 0, a._h, c === undefined ? -1 : c | 0)
    }
  }
  class AudioDestinationNode extends AudioNode {
    constructor(ctx, handle, channels) { super(ctx, handle, 1, 0); this.maxChannelCount = channels; this.channelCount = channels }
  }
  class AudioScheduledSourceNode extends AudioNode {
    constructor(ctx, handle) { super(ctx, handle, 0, 1); this._started = false; this._stopped = false; this._onended = null; this._endedHooked = false }
    get onended() { return this._onended }
    set onended(f) { this._onended = typeof f === 'function' ? f : null; if (f) this._hookEnded() }
    addEventListener(type, cb, opts) { super.addEventListener(type, cb, opts); if (type === 'ended') this._hookEnded() }
    _hookEnded() { if (this._endedHooked) return; this._endedHooked = true; N.onEnded(this._h, () => this.dispatchEvent(new Ev('ended'))) }
    start(when = 0) {
      if (this._started) throw err('InvalidStateError', 'start() called twice')
      this._started = true; N.start(this._h, nonNeg(when, 'when'), 0, 0)
    }
    stop(when = 0) {
      if (!this._started) throw err('InvalidStateError', 'stop() before start()')
      this._stopped = true; N.stop(this._h, nonNeg(when, 'when'))
    }
  }
  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.bufferSource))
      this._buffer = null; this._loop = false; this._loopStart = 0; this._loopEnd = 0
      this.playbackRate = this._param('playbackRate', 1, undefined, undefined, 'k-rate'); this.detune = this._param('detune', 0, undefined, undefined, 'k-rate')
      if (opts.buffer) this.buffer = opts.buffer
      if (opts.loop) this.loop = opts.loop; if (opts.loopStart) this.loopStart = opts.loopStart; if (opts.loopEnd) this.loopEnd = opts.loopEnd
      if (opts.playbackRate !== undefined) this.playbackRate.value = opts.playbackRate; if (opts.detune !== undefined) this.detune.value = opts.detune
    }
    get buffer() { return this._buffer }
    set buffer(b) {
      if (b !== null && !(b instanceof AudioBuffer)) throw new TypeError('buffer must be an AudioBuffer or null')
      if (b && this._buffer) throw err('InvalidStateError', 'buffer has already been set')
      this._buffer = b; N.setBuffer(this._h, b ? b._id : 0)
    }
    get loop() { return this._loop } set loop(v) { this._loop = !!v; N.setProp(this._h, 'loop', this._loop) }
    get loopStart() { return this._loopStart } set loopStart(v) { this._loopStart = finite(v, 'loopStart'); N.setProp(this._h, 'loopStart', this._loopStart) }
    get loopEnd() { return this._loopEnd } set loopEnd(v) { this._loopEnd = finite(v, 'loopEnd'); N.setProp(this._h, 'loopEnd', this._loopEnd) }
    start(when = 0, offset = 0, duration) {
      if (this._started) throw err('InvalidStateError', 'start() called twice')
      when = nonNeg(when, 'when'); offset = nonNeg(offset, 'offset')
      if (duration !== undefined) duration = nonNeg(duration, 'duration')
      this._started = true; N.start(this._h, when, offset, duration === undefined ? 0 : duration)
    }
  }
  class OscillatorNode extends AudioScheduledSourceNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.oscillator)); this._type = 'sine'
      this.frequency = this._param('frequency', 440, -ctx.sampleRate / 2, ctx.sampleRate / 2); this.detune = this._param('detune', 0, -153600, 153600)
      if (opts.type) this.type = opts.type
      if (opts.frequency !== undefined) this.frequency.value = opts.frequency; if (opts.detune !== undefined) this.detune.value = opts.detune
    }
    get type() { return this._type }
    set type(t) {
      if (t === 'custom') throw err('InvalidStateError', 'type "custom" needs setPeriodicWave')
      if (!OSC_TYPES.includes(t)) return  // the spec ignores unknown enum values
      this._type = t; N.setProp(this._h, 'type', t)
    }
    setPeriodicWave() { throw err('NotSupportedError', 'PeriodicWave is not implemented by this host') }
  }
  class GainNode extends AudioNode {
    constructor(ctx, opts = {}) { super(ctx, N.createNode(ctx._id, KINDS.gain), 1, 1); this.gain = this._param('gain', 1); if (opts.gain !== undefined) this.gain.value = opts.gain }
  }
  class BiquadFilterNode extends AudioNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.biquad), 1, 1); this._type = 'lowpass'
      this.frequency = this._param('frequency', 350, 0, ctx.sampleRate / 2); this.detune = this._param('detune', 0, -153600, 153600)
      this.Q = this._param('Q', 1); this.gain = this._param('gain', 0, undefined, 1541)
      if (opts.type) this.type = opts.type
      for (const k of ['frequency', 'detune', 'Q', 'gain']) if (opts[k] !== undefined) this[k].value = opts[k]
    }
    get type() { return this._type }
    set type(t) { if (!FILTER_TYPES.includes(t)) return; this._type = t; N.setProp(this._h, 'type', t) }
    // The spec's coefficients, evaluated here for the current (unautomated) values.
    getFrequencyResponse(freqs, mag, phase) {
      const Fs = this.context.sampleRate, f0 = Math.min(Math.max(this.frequency.value * 2 ** (this.detune.value / 1200), 0), Fs / 2)
      const Q = this.Q.value, A = 10 ** (this.gain.value / 40), w0 = 2 * Math.PI * f0 / Fs, cw = Math.cos(w0), sw = Math.sin(w0)
      const aQ = Q > 0 ? sw / (2 * Q) : 1e9, aQdB = sw / (2 * 10 ** (Q / 20)), aS = sw / 2 * Math.SQRT2, sA = Math.sqrt(A)
      let b0, b1, b2, a0, a1, a2
      switch (this._type) {
        case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break
        case 'bandpass': b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break
        case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break
        case 'allpass': b0 = 1 - aQ; b1 = -2 * cw; b2 = 1 + aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break
        case 'peaking': b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; break
        case 'lowshelf': b0 = A * ((A + 1) - (A - 1) * cw + 2 * sA * aS); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - 2 * sA * aS); a0 = (A + 1) + (A - 1) * cw + 2 * sA * aS; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - 2 * sA * aS; break
        case 'highshelf': b0 = A * ((A + 1) + (A - 1) * cw + 2 * sA * aS); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - 2 * sA * aS); a0 = (A + 1) - (A - 1) * cw + 2 * sA * aS; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - 2 * sA * aS; break
        default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB
      }
      for (let i = 0; i < freqs.length; i++) {
        const w = 2 * Math.PI * freqs[i] / Fs
        const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w))
        const dr = a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w))
        const re = (nr * dr + ni * di) / (dr * dr + di * di), im = (ni * dr - nr * di) / (dr * dr + di * di)
        if (mag) mag[i] = Math.hypot(re, im); if (phase) phase[i] = Math.atan2(im, re)
      }
    }
  }
  class DynamicsCompressorNode extends AudioNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.compressor), 1, 1); this.channelCountMode = 'clamped-max'
      this.threshold = this._param('threshold', -24, -100, 0, 'k-rate'); this.knee = this._param('knee', 30, 0, 40, 'k-rate')
      this.ratio = this._param('ratio', 12, 1, 20, 'k-rate'); this.attack = this._param('attack', 0.003, 0, 1, 'k-rate'); this.release = this._param('release', 0.25, 0, 1, 'k-rate')
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) if (opts[k] !== undefined) this[k].value = opts[k]
    }
    get reduction() { return N.getProp(this._h, 'reduction') }
  }
  class PannerNode extends AudioNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.panner), 1, 1); this.channelCountMode = 'clamped-max'
      this._props = { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }
      for (const k of ['positionX', 'positionY', 'positionZ']) this[k] = this._param(k, 0)
      this.orientationX = this._param('orientationX', 1); this.orientationY = this._param('orientationY', 0); this.orientationZ = this._param('orientationZ', 0)
      for (const k in opts) if (k in this._props) this[k] = opts[k]; else if (this[k] instanceof AudioParam) this[k].value = opts[k]
    }
    setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z }
    setOrientation(x, y, z) { this.orientationX.value = x; this.orientationY.value = y; this.orientationZ.value = z }
  }
  for (const k of ['panningModel', 'distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain']) {
    Object.defineProperty(PannerNode.prototype, k, {
      get() { return this._props[k] },
      set(v) {
        if (k === 'panningModel') { if (!PANNING_MODELS.includes(v)) return }
        else if (k === 'distanceModel') { if (!DISTANCE_MODELS.includes(v)) return }
        else { v = finite(v, k); if ((k === 'refDistance' || k === 'maxDistance' || k === 'rolloffFactor') && v < 0) throw new RangeError(`${k} must be non-negative`); if (k === 'maxDistance' && v === 0) throw new RangeError('maxDistance must be positive') }
        this._props[k] = v; N.setProp(this._h, k, v)
      }, enumerable: true, configurable: true,
    })
  }
  // AnalyserNode (WP-25; not gated: a plain graph node). Its input passes through; the native side keeps the input's
  // history and computes the spec's analysis on each get*Data call (host/audio/analyser.cpp), writing into the
  // page's own array. Buffers are sized when fftSize is set, never on the render thread.
  class AnalyserNode extends AudioNode {
    constructor(ctx, opts = {}) {
      super(ctx, N.createNode(ctx._id, KINDS.analyser), 1, 1)
      this._fft = 2048; this._min = -100; this._max = -30; this._smooth = 0.8
      if (opts.fftSize !== undefined) this.fftSize = opts.fftSize; else N.analyserSize(this._h, this._fft)
      const min = opts.minDecibels === undefined ? -100 : finite(opts.minDecibels, 'minDecibels'), max = opts.maxDecibels === undefined ? -30 : finite(opts.maxDecibels, 'maxDecibels')
      if (!(min < max)) throw err('IndexSizeError', `minDecibels (${min}) must be less than maxDecibels (${max})`)
      this._min = min; this._max = max
      if (opts.smoothingTimeConstant !== undefined) this.smoothingTimeConstant = opts.smoothingTimeConstant
    }
    get fftSize() { return this._fft }
    set fftSize(v) {
      v = Math.trunc(finite(v, 'fftSize'))
      if (v < 32 || v > 32768 || (v & (v - 1)) !== 0) throw err('IndexSizeError', `fftSize ${v} is not a power of two between 32 and 32768`)
      this._fft = v; N.analyserSize(this._h, v)
    }
    get frequencyBinCount() { return this._fft / 2 }
    get minDecibels() { return this._min }
    set minDecibels(v) { v = finite(v, 'minDecibels'); if (v >= this._max) throw err('IndexSizeError', `minDecibels (${v}) must be less than maxDecibels (${this._max})`); this._min = v }
    get maxDecibels() { return this._max }
    set maxDecibels(v) { v = finite(v, 'maxDecibels'); if (v <= this._min) throw err('IndexSizeError', `maxDecibels (${v}) must be greater than minDecibels (${this._min})`); this._max = v }
    get smoothingTimeConstant() { return this._smooth }
    set smoothingTimeConstant(v) { v = finite(v, 'smoothingTimeConstant'); if (v < 0 || v > 1) throw err('IndexSizeError', 'smoothingTimeConstant must be between 0 and 1'); this._smooth = v }
    getFloatFrequencyData(a) { if (!(a instanceof Float32Array)) throw new TypeError('getFloatFrequencyData: Float32Array required'); N.analyserFrequency(this._h, a, this._smooth, this._min, this._max) }
    getByteFrequencyData(a) { if (!(a instanceof Uint8Array)) throw new TypeError('getByteFrequencyData: Uint8Array required'); N.analyserFrequency(this._h, a, this._smooth, this._min, this._max) }
    getFloatTimeDomainData(a) { if (!(a instanceof Float32Array)) throw new TypeError('getFloatTimeDomainData: Float32Array required'); N.analyserTime(this._h, a) }
    getByteTimeDomainData(a) { if (!(a instanceof Uint8Array)) throw new TypeError('getByteTimeDomainData: Uint8Array required'); N.analyserTime(this._h, a) }
  }
  class AudioListener {
    constructor(ctx, handle) {
      this._ctx = ctx; this._h = handle
      const defs = { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 }
      for (const k in defs) this[k] = new AudioParam(ctx, handle, k, defs[k], -3.4028234663852886e38, 3.4028234663852886e38, 'a-rate')
    }
    setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z }
    setOrientation(x, y, z, ux, uy, uz) { this.forwardX.value = x; this.forwardY.value = y; this.forwardZ.value = z; this.upX.value = ux; this.upY.value = uy; this.upZ.value = uz }
  }

  // ---- AudioBuffer ------------------------------------------------------------------
  class AudioBuffer {
    constructor(opts) {
      if (opts && opts._nativeId) { this._id = opts._nativeId; this.numberOfChannels = opts.numberOfChannels; this.length = opts.length; this.sampleRate = opts.sampleRate }
      else {
        if (!opts || typeof opts !== 'object') throw new TypeError('AudioBuffer: options required')
        const ch = opts.numberOfChannels ?? 1, len = opts.length, rate = opts.sampleRate
        if (!(ch >= 1 && ch <= 32)) throw err('NotSupportedError', 'numberOfChannels out of range')
        if (!(len > 0)) throw err('NotSupportedError', 'length must be positive')
        if (!(rate >= 3000 && rate <= 768000)) throw err('NotSupportedError', 'sampleRate out of range')
        this._id = N.createBuffer(ch | 0, len | 0, +rate); this.numberOfChannels = ch | 0; this.length = len | 0; this.sampleRate = +rate
      }
      this._ch = new Array(this.numberOfChannels).fill(null)
      if (bufReg) bufReg.register(this, this._id, this)
    }
    static _wrap(id, channels, length, sampleRate) { return new AudioBuffer({ _nativeId: id, numberOfChannels: channels, length, sampleRate }) }
    get duration() { return this.length / this.sampleRate }
    getChannelData(ch) {
      ch = ch | 0; if (ch < 0 || ch >= this.numberOfChannels) throw err('IndexSizeError', 'channel index out of range')
      return this._ch[ch] ?? (this._ch[ch] = N.channelData(this._id, ch))
    }
    copyFromChannel(dst, ch, start = 0) {
      const s = this.getChannelData(ch); start = start | 0
      if (start < 0 || start >= s.length) throw err('IndexSizeError', 'bufferOffset out of range')
      const n = Math.min(dst.length, s.length - start); dst.set(s.subarray(start, start + n))
    }
    copyToChannel(src, ch, start = 0) {
      const d = this.getChannelData(ch); start = start | 0
      if (start < 0 || start >= d.length) throw err('IndexSizeError', 'bufferOffset out of range')
      const n = Math.min(src.length, d.length - start); d.set(n === src.length ? src : src.subarray(0, n), start)
    }
  }

  // ---- contexts -----------------------------------------------------------------------
  class BaseAudioContext extends ET {
    constructor(offline, channels, length, sampleRate) {
      super()
      const r = N.createContext(offline, channels, length, sampleRate)
      this._id = r.id; this.sampleRate = r.sampleRate; this._state = r.running ? 'running' : 'suspended'; this.onstatechange = null
      this.destination = new AudioDestinationNode(this, r.destination, channels)
      this.listener = new AudioListener(this, r.listener)
      this.audioWorklet = undefined
      if (ctxReg) ctxReg.register(this, this._id, this)
    }
    get currentTime() { return N.contextTime(this._id) }
    get state() { return this._state }
    _setState(s) { if (this._state === s) return; this._state = s; this.dispatchEvent(new Ev('statechange')) }
    createBuffer(channels, length, sampleRate) { return new AudioBuffer({ numberOfChannels: channels, length, sampleRate }) }
    createBufferSource() { return new AudioBufferSourceNode(this) }
    createGain() { return new GainNode(this) }
    createOscillator() { return new OscillatorNode(this) }
    createBiquadFilter() { return new BiquadFilterNode(this) }
    createDynamicsCompressor() { return new DynamicsCompressorNode(this) }
    createPanner() { return new PannerNode(this) }
    createAnalyser() { return new AnalyserNode(this) }
    decodeAudioData(data, successCb, errorCb) {
      return new Promise((resolve, reject) => {
        if (!(data instanceof ArrayBuffer)) { const e = new TypeError('decodeAudioData: ArrayBuffer required'); errorCb?.(e); reject(e); return }
        if (data.byteLength === 0 || (data.detached === true)) { const e = err('DataCloneError', 'decodeAudioData: buffer is detached'); errorCb?.(e); reject(e); return }
        N.decodeAudio(data, this.sampleRate, (id, ch, len, rate, e) => {
          if (!id) { const ex = err('EncodingError', e || 'Unable to decode audio data'); try { errorCb?.(ex) } catch {} reject(ex); return }
          const buf = AudioBuffer._wrap(id, ch, len, rate); try { successCb?.(buf) } catch {} resolve(buf)
        })
        N.detach?.(data)  // the bytes were copied by the call above; like a browser we detach the caller's buffer
      })
    }
  }
  class AudioContext extends BaseAudioContext {
    constructor(opts = {}) {
      super(false, 2, 0, opts.sampleRate ? finite(opts.sampleRate, 'sampleRate') : 0)
      this.baseLatency = 128 / this.sampleRate; this.outputLatency = 0
    }
    resume() {
      if (this._state === 'closed') return Promise.reject(err('InvalidStateError', 'resume() on a closed context'))
      if (N.resume(this._id)) this._setState('running')
      return Promise.resolve()
    }
    suspend() {
      if (this._state === 'closed') return Promise.reject(err('InvalidStateError', 'suspend() on a closed context'))
      if (N.suspend(this._id)) this._setState('suspended')
      return Promise.resolve()
    }
    close() {
      if (this._state === 'closed') return Promise.reject(err('InvalidStateError', 'close() on a closed context'))
      N.closeContext(this._id); if (ctxReg) ctxReg.unregister(this); this._setState('closed')
      return Promise.resolve()
    }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: g.performance?.now?.() ?? 0 } }
    createMediaElementSource() { throw err('NotSupportedError', 'media elements are not implemented by this host') }
    createMediaStreamSource() { throw err('NotSupportedError', 'media streams are not implemented by this host') }
  }
  class OfflineAudioContext extends BaseAudioContext {
    constructor(a, b, c) {
      const o = typeof a === 'object' && a !== null ? a : { numberOfChannels: a, length: b, sampleRate: c }
      const ch = o.numberOfChannels ?? 1
      if (!(ch >= 1 && ch <= 32)) throw err('NotSupportedError', 'numberOfChannels out of range')
      if (!(o.length > 0)) throw err('NotSupportedError', 'length must be positive')
      if (!(o.sampleRate >= 3000 && o.sampleRate <= 768000)) throw err('NotSupportedError', 'sampleRate out of range')
      super(true, ch | 0, Math.ceil(o.length), +o.sampleRate)
      this.length = Math.ceil(o.length); this.oncomplete = null; this._rendering = false
    }
    startRendering() {
      if (this._rendering) return Promise.reject(err('InvalidStateError', 'startRendering() called twice'))
      this._rendering = true; this._setState('running')
      return new Promise((resolve, reject) => {
        const ok = N.offlineRender(this._id, (id, ch, len, rate) => {
          if (!id) { reject(err('InvalidStateError', 'offline render failed')); return }
          const buf = AudioBuffer._wrap(id, ch, len, rate)
          this._setState('closed')
          const ev = new Ev('complete'); ev.renderedBuffer = buf; this.dispatchEvent(ev)
          resolve(buf)
        })
        if (!ok) reject(err('InvalidStateError', 'offline render refused'))
      })
    }
    resume() { return Promise.reject(err('NotSupportedError', 'OfflineAudioContext.resume is not implemented')) }
    suspend() { return Promise.reject(err('NotSupportedError', 'OfflineAudioContext.suspend is not implemented')) }
  }

  // Stubs, not a capture implementation. adapter.js does `MediaStream = MediaStream || webkitMediaStream`, which
  // stores undefined when neither exists, and Howler then throws on `x instanceof MediaStream` ("right-hand side
  // is not an object") while setting up a sound. A constructor makes that check false for a normal source.
  class MediaStreamTrack {
    constructor() { this.kind = 'audio'; this.id = ''; this.label = ''; this.enabled = true; this.muted = false; this.readyState = 'ended' }
    stop() { this.readyState = 'ended' }
    clone() { return new MediaStreamTrack() }
  }
  class MediaStream {
    constructor(tracks) { this._tracks = tracks ? [...tracks] : [] }
    getTracks() { return this._tracks.slice() }
    getAudioTracks() { return this._tracks.filter((t) => t.kind !== 'video') }
    getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video') }
    addTrack(t) { this._tracks.push(t) }
    removeTrack(t) { const i = this._tracks.indexOf(t); if (i >= 0) this._tracks.splice(i, 1) }
    get id() { return '' }
    get active() { return false }
  }
  Object.assign(g, {
    AudioContext, OfflineAudioContext, BaseAudioContext, AudioNode, AudioScheduledSourceNode, AudioDestinationNode, AudioListener,
    AudioParam, AudioBuffer, AudioBufferSourceNode, OscillatorNode, GainNode, BiquadFilterNode, DynamicsCompressorNode, PannerNode, AnalyserNode,
    MediaStream, MediaStreamTrack,
  })
  g.webkitAudioContext = AudioContext
  g.webkitMediaStream = MediaStream
  if (g.__native?.config?.audio?.elements === true) installMediaElements(g, AudioContext)
}
