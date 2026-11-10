// Microphone capture (WP-25) over __native.media (host/media/media_bind.cpp), installed only when the host was built
// with it (host.json media.microphone): without it there is no navigator.mediaDevices, MediaStream or
// MediaStreamTrack, and AudioContext.createMediaStreamSource keeps throwing NotSupportedError, exactly as before.
// Audio only: navigator.mediaDevices { getUserMedia, enumerateDevices, getSupportedConstraints, ondevicechange },
// MediaStream, MediaStreamTrack, MediaStreamTrackEvent, OverconstrainedError, MediaStreamAudioSourceNode (with
// AudioContext.createMediaStreamSource), and navigator.permissions.query({ name: 'microphone' }).
// Not here: video (getUserMedia with video rejects NotFoundError: no camera), getDisplayMedia, MediaRecorder,
// createMediaStreamDestination, WebRTC media tracks (RTCPeerConnection.addTrack still throws).
//
// Constraints, as browsers treat them: a bare value or { ideal } is a preference, { exact } (and min / max for the
// numbers) a requirement; an unsatisfiable requirement rejects with OverconstrainedError naming it. The device is
// shared: the first live track opens it with its processing (echoCancellation, noiseSuppression,
// autoGainControl; Android maps them to an input preset, mac and Linux have no processing and report false),
// later tracks and clones get what is open. Mono; sampleRate is the device's (Web Audio resamples).
export function install(g) {
  const N = g.__native && g.__native.media
  if (!N) return
  const A = g.__native.audio
  const { EventTarget, Event, DOMException } = g
  const HANDLERS = Symbol.for('webxr-host.handlers')  // dom-lite/events.js: on<event> handlers, called from dispatch
  const handlers = (C, names) => { for (const n of names) Object.defineProperty(C.prototype, 'on' + n, { get() { return this[HANDLERS][n] ?? null }, set(v) { this[HANDLERS][n] = typeof v === 'function' ? v : null }, configurable: true, enumerable: true }) }
  const err = (name, msg) => new DOMException(msg, name)
  const fromNative = (s) => { const i = s.indexOf(': '); return i > 0 ? err(s.slice(0, i), s.slice(i + 2)) : err('NotReadableError', s) }
  const TOKEN = Symbol('media')
  const live = new Set()        // live tracks, kept from GC while they capture (a meter's stream may be held by nothing but the graph)
  const byId = new Map()        // native track id -> track (device events)
  const reg = g.FinalizationRegistry ? new g.FinalizationRegistry((id) => N.release(id)) : null  // an ended track the page let go of
  const later = (f) => g.setTimeout(f, 0)

  class OverconstrainedError extends DOMException {
    constructor(constraint, message = '') { super(message, 'OverconstrainedError'); this.constraint = constraint }
  }
  class MediaStreamTrackEvent extends Event {
    constructor(type, init = {}) { super(type, init); if (!init.track) throw new TypeError('MediaStreamTrackEvent: track is required'); this.track = init.track }
  }

  // ------------------------------------------------------------------------------------------------- constraints
  const SUPPORTED = ['deviceId', 'groupId', 'sampleRate', 'sampleSize', 'channelCount', 'echoCancellation', 'autoGainControl', 'noiseSuppression']
  const PROCESSING = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
  // A constraint value as { exact, ideal, min, max } (undefined where absent).
  const parse = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v)) ? { exact: v.exact, ideal: v.ideal, min: v.min, max: v.max } : { ideal: v }
  const capsNow = () => {
    const c = N.capabilities(), d = N.devices()[0] ?? { deviceId: 'default', groupId: '' }
    return { deviceId: d.deviceId, groupId: d.groupId, channelCount: { min: 1, max: 1 }, sampleSize: { min: 16, max: 16 }, ...c }
  }
  // The requirements that the device cannot meet whatever it opens with: the first one's name, or null.
  function unmet(c, caps, settings) {
    for (const k of ['channelCount', 'sampleSize', 'sampleRate']) {
      if (c[k] === undefined) continue
      const p = parse(c[k]), r = k === 'sampleRate' ? (settings ? { min: settings.sampleRate, max: settings.sampleRate } : null) : caps[k]
      if (!r) continue  // the rate is known once the device is open (getUserMedia checks it then)
      if (p.exact !== undefined && (p.exact < r.min || p.exact > r.max)) return k
      if (p.min !== undefined && p.min > r.max) return k
      if (p.max !== undefined && p.max < r.min) return k
    }
    for (const k of ['deviceId', 'groupId']) {
      if (c[k] === undefined) continue
      const p = parse(c[k]); if (p.exact === undefined) continue
      const want = [].concat(p.exact).map(String), have = k === 'deviceId' ? ['default', caps.deviceId] : [caps.groupId]
      if (!want.some((w) => have.includes(w))) return k
    }
    for (const k of PROCESSING) {
      if (c[k] === undefined) continue
      const p = parse(c[k]); if (p.exact === undefined) continue
      if (!(settings ? [settings[k]] : caps[k]).includes(!!p.exact)) return k
    }
    return null
  }
  // The processing to open with: what is asked for (exact, ideal, a bare value; true by default, as in browsers)
  // where the device can, else what it can.
  function processing(c, caps) {
    const out = {}
    for (const k of PROCESSING) {
      const p = c[k] === undefined ? {} : parse(c[k]), v = p.exact ?? p.ideal
      const want = v === undefined ? true : !!v
      out[k] = caps[k].includes(want) ? want : caps[k][0]
    }
    return out
  }

  // ------------------------------------------------------------------------------------------------- permission
  const statuses = new Set()
  let permissionState = N.permission()
  class PermissionStatus extends EventTarget {
    constructor() { super(); this[HANDLERS] = Object.create(null); this.name = 'microphone' }
    get state() { return permissionState }
  }
  handlers(PermissionStatus, ['change'])
  const setPermission = (s) => {
    if (s === permissionState) return
    permissionState = s
    for (const st of statuses) st.dispatchEvent(new Event('change'))
  }
  let asking = null
  const ask = () => asking ?? (asking = new Promise((resolve) => N.request((s) => { asking = null; setPermission(s); resolve(s) })))
  const perms = g.navigator.permissions, query0 = perms?.query?.bind(perms)
  if (perms) perms.query = (d) => {
    if (d?.name !== 'microphone') return query0(d)
    setPermission(N.permission())  // the person may have changed it in the system's settings meanwhile
    const s = new PermissionStatus(); statuses.add(s)
    return Promise.resolve(s)
  }

  // ------------------------------------------------------------------------------------------------- tracks
  class MediaStreamTrack extends EventTarget {
    constructor(key, info, constraints) {
      if (key !== TOKEN) throw new TypeError('Illegal constructor')
      super(); this[HANDLERS] = Object.create(null)
      this.kind = 'audio'; this.id = g.crypto.randomUUID(); this.label = info.label ?? ''; this.contentHint = ''
      this._info = info; this._nid = info.id; this._constraints = constraints ? { ...constraints } : {}
      this._enabled = true; this._state = info.id ? 'live' : 'ended'; this._streams = new Set()
      if (this._nid) { byId.set(this._nid, this); if (this._state === 'live') live.add(this) }
    }
    get enabled() { return this._enabled }
    set enabled(v) { this._enabled = !!v; if (this._nid && this._state === 'live') N.setEnabled(this._nid, this._enabled) }
    get muted() { return false }
    get readyState() { return this._state }
    stop() { this._end(false) }
    // The track ends: by stop() (no event, as the spec says), or because its device went away ('ended').
    _end(fire) {
      if (this._state === 'ended') return
      this._state = 'ended'; live.delete(this)
      if (this._nid) { N.stop(this._nid); if (reg) reg.register(this, this._nid) }
      if (fire) this.dispatchEvent(new Event('ended'))
      for (const s of this._streams) s._trackEnded()
    }
    clone() {
      if (this._state === 'ended') return new MediaStreamTrack(TOKEN, { ...this._info, id: 0 }, this._constraints)
      const r = N.open(processing(this._constraints, capsNow()))
      const t = new MediaStreamTrack(TOKEN, typeof r === 'string' ? { ...this._info, id: 0 } : r, this._constraints)
      t.enabled = this._enabled
      return t
    }
    getSettings() {
      const i = this._info
      return { deviceId: i.deviceId, groupId: i.groupId, sampleRate: i.sampleRate, sampleSize: 16, channelCount: 1, echoCancellation: i.echoCancellation, autoGainControl: i.autoGainControl, noiseSuppression: i.noiseSuppression }
    }
    getConstraints() { return { ...this._constraints } }
    getCapabilities() {
      const c = capsNow(), r = this._info.sampleRate
      return { deviceId: this._info.deviceId, groupId: this._info.groupId, sampleRate: { min: r, max: r }, sampleSize: c.sampleSize, channelCount: c.channelCount, echoCancellation: c.echoCancellation, autoGainControl: c.autoGainControl, noiseSuppression: c.noiseSuppression }
    }
    // The device is shared and keeps the processing it opened with: a requirement it does not meet now fails.
    applyConstraints(c = {}) {
      if (c === null || typeof c !== 'object') return Promise.reject(new TypeError('applyConstraints: constraints must be an object'))
      const bad = this._state === 'live' ? unmet(c, capsNow(), this._info) : null
      if (bad) return Promise.reject(new OverconstrainedError(bad, `${bad} cannot be satisfied by the open device`))
      this._constraints = { ...c }
      return Promise.resolve()
    }
  }
  handlers(MediaStreamTrack, ['ended', 'mute', 'unmute'])
  N.onEvent((kind, id) => {
    if (kind === 'ended') byId.get(id)?._end(true)
    else if (kind === 'devicechange') devices.dispatchEvent(new Event('devicechange'))
  })

  // ------------------------------------------------------------------------------------------------- streams
  class MediaStream extends EventTarget {
    constructor(arg) {
      super(); this[HANDLERS] = Object.create(null)
      this.id = g.crypto.randomUUID(); this._tracks = []; this._active = false
      const tracks = arg instanceof MediaStream ? arg.getTracks() : arg === undefined ? [] : Array.isArray(arg) ? arg : null
      if (!tracks) throw new TypeError('MediaStream: expected a MediaStream or an array of MediaStreamTracks')
      for (const t of tracks) { if (!(t instanceof MediaStreamTrack)) throw new TypeError('MediaStream: not a MediaStreamTrack'); this._add(t) }
      this._active = this.active
    }
    get active() { return this._tracks.some((t) => t.readyState === 'live') }
    getTracks() { return this._tracks.slice() }
    getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio') }
    getVideoTracks() { return [] }
    getTrackById(id) { return this._tracks.find((t) => t.id === id) ?? null }
    addTrack(t) { if (!(t instanceof MediaStreamTrack)) throw new TypeError('addTrack: not a MediaStreamTrack'); this._add(t); this._active = this.active }
    removeTrack(t) {
      if (!(t instanceof MediaStreamTrack)) throw new TypeError('removeTrack: not a MediaStreamTrack')
      const i = this._tracks.indexOf(t); if (i < 0) return
      this._tracks.splice(i, 1); t._streams.delete(this); this._trackEnded()
    }
    clone() { return new MediaStream(this._tracks.map((t) => t.clone())) }
    _add(t) { if (this._tracks.includes(t)) return; this._tracks.push(t); t._streams.add(this) }
    // Chrome's 'inactive' (the spec's former oninactive): once no track is live, after the task that ended the last.
    _trackEnded() { if (!this._active || this.active) return; this._active = false; later(() => this.dispatchEvent(new Event('inactive'))) }
  }
  handlers(MediaStream, ['addtrack', 'removetrack', 'active', 'inactive'])

  // ------------------------------------------------------------------------------------------------- devices
  class MediaDeviceInfo {
    constructor(key, d) { if (key !== TOKEN) throw new TypeError('Illegal constructor'); this.deviceId = d.deviceId; this.kind = d.kind; this.label = d.label; this.groupId = d.groupId }
    toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId } }
  }
  class InputDeviceInfo extends MediaDeviceInfo {
    getCapabilities() { if (!this.deviceId) return {}; const c = capsNow(); return { deviceId: this.deviceId, groupId: this.groupId, channelCount: c.channelCount, sampleSize: c.sampleSize, echoCancellation: c.echoCancellation, autoGainControl: c.autoGainControl, noiseSuppression: c.noiseSuppression } }
  }
  class MediaDevices extends EventTarget {
    constructor(key) { if (key !== TOKEN) throw new TypeError('Illegal constructor'); super(); this[HANDLERS] = Object.create(null) }
    getSupportedConstraints() { return Object.fromEntries(SUPPORTED.map((k) => [k, true])) }
    // Until the page has the permission, browsers list each kind of device once with no id and no label.
    enumerateDevices() {
      const granted = N.permission() === 'granted'
      return Promise.resolve(N.devices().map((d) => new InputDeviceInfo(TOKEN, granted ? { kind: 'audioinput', ...d } : { kind: 'audioinput', deviceId: '', groupId: '', label: '' })))
    }
    async getUserMedia(c) {
      if (c === null || typeof c !== 'object') throw new TypeError("getUserMedia: constraints must be an object")
      if (!c.audio && !c.video) throw new TypeError('getUserMedia: at least one of audio and video must be requested')
      if (c.video) throw err('NotFoundError', 'Requested device not found')  // no camera on this host
      const ac = typeof c.audio === 'object' ? c.audio : {}
      if (!N.devices().length) throw err('NotFoundError', 'Requested device not found')
      const caps = capsNow(), bad = unmet(ac, caps, null)
      if (bad) throw new OverconstrainedError(bad, `${bad} cannot be satisfied`)
      let state = N.permission()
      if (state === 'prompt') state = await ask()
      setPermission(state)
      if (state !== 'granted') throw err('NotAllowedError', 'Permission denied')
      const r = N.open(processing(ac, caps))
      if (typeof r === 'string') throw fromNative(r)
      const track = new MediaStreamTrack(TOKEN, r, ac)
      const late = unmet(ac, caps, r)  // the rate, now that the device is open
      if (late) { track.stop(); throw new OverconstrainedError(late, `${late} cannot be satisfied`) }
      return new MediaStream([track])
    }
  }
  handlers(MediaDevices, ['devicechange'])
  const devices = new MediaDevices(TOKEN)
  Object.defineProperty(g.navigator, 'mediaDevices', { value: devices, enumerable: true, configurable: true })

  // ------------------------------------------------------------------------------------------------- Web Audio
  // MediaStreamAudioSourceNode: the stream's first audio track by id (as the spec picks it), read by a native graph
  // node at the context's rate. AudioContext only: an OfflineAudioContext has no createMediaStreamSource and the
  // constructor refuses it, as in browsers.
  let MediaStreamAudioSourceNode
  if (A && typeof A.setInput === 'function' && typeof g.AudioNode === 'function' && typeof g.AudioContext === 'function') {
    MediaStreamAudioSourceNode = class MediaStreamAudioSourceNode extends g.AudioNode {
      constructor(ctx, opts) {
        if (!(ctx instanceof g.AudioContext)) throw new TypeError("MediaStreamAudioSourceNode: parameter 1 is not of type 'AudioContext'")
        const stream = opts?.mediaStream
        if (!(stream instanceof MediaStream)) throw new TypeError("MediaStreamAudioSourceNode: member mediaStream is not a MediaStream")
        const tracks = stream.getAudioTracks()
        if (!tracks.length) throw err('InvalidStateError', 'MediaStream has no audio track')
        if (ctx.state === 'closed') throw err('InvalidStateError', 'the AudioContext is closed')
        const track = tracks.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
        super(ctx, A.createNode(ctx._id, 'mediaStream'), 0, 1)
        this._stream = stream; this._track = track
        if (track.readyState === 'live' && this._h) A.setInput(this._h, track._nid)
      }
      get mediaStream() { return this._stream }
    }
    g.AudioContext.prototype.createMediaStreamSource = function createMediaStreamSource(stream) { return new MediaStreamAudioSourceNode(this, { mediaStream: stream }) }
  }

  Object.assign(g, { MediaStream, MediaStreamTrack, MediaStreamTrackEvent, MediaDevices, MediaDeviceInfo, InputDeviceInfo, OverconstrainedError })
  g.webkitMediaStream = MediaStream  // webaudio/'s stub set it to its inert class (adapter.js reads it)
  if (MediaStreamAudioSourceNode) g.MediaStreamAudioSourceNode = MediaStreamAudioSourceNode
  g.__native.log?.(1, `media: navigator.mediaDevices (microphone, ${N.platform}), permission ${permissionState}`)
}
