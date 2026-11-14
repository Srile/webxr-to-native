// media-elements.js — <audio> and new Audio() play through the native Web Audio graph (host.json audio.elements;
// without it an element plays nothing and play() rejects, dom-lite/index.js). The source is fetched and decoded
// whole (decodeAudioData: WAV, Ogg, WebM, MP3, and AAC where the host has a decoder), then played by a buffer source
// through a gain node that follows volume and muted. Decoded sounds are kept per URL: games replay the same few
// clips. No streaming, so a long track starts once it has decoded; no timeupdate events. A srcObject (a MediaStream:
// a WebRTC voice, a microphone) plays live through a MediaStreamAudioSourceNode while the element plays.
//
// Events: play, loadedmetadata, playing, pause, ended, error (each also through its on<type> property).
export function installMediaElements(g, AudioContext) {
  const proto = g.HTMLMediaElement && g.HTMLMediaElement.prototype
  if (!proto || !AudioContext) return
  let ctx = null
  const context = () => {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  }
  // Made now, as the page loads, not at the first play(): a context opens an audio output stream, ~50 ms on
  // some devices (a headset's Android layer), which in the middle of an XR session is several dropped frames.
  try { ctx = new AudioContext() } catch { ctx = null }
  const decoded = new Map()   // absolute URL → Promise<AudioBuffer>
  const decode = (url) => {
    let p = decoded.get(url)
    if (!p) {
      p = g.fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`)
        return r.arrayBuffer()
      }).then((bytes) => context().decodeAudioData(bytes))
      p.catch(() => decoded.delete(url))
      decoded.set(url, p)
    }
    return p
  }
  const absolute = (src) => { try { return new URL(src, g.location && g.location.href).href } catch { return src } }
  const fire = (el, type) => {
    try { el.dispatchEvent(new g.Event(type)) } catch (e) { g.__native?.log?.(2, `audio ${type}: ${e}`) }
    const on = el['on' + type]
    if (typeof on === 'function') try { on.call(el, new g.Event(type)) } catch (e) { g.__native?.log?.(2, `audio on${type}: ${e}`) }
  }
  const media = (el) => el.__media || (el.__media = { node: null, gain: null, buffer: null, startedAt: 0, token: 0, volume: 1, muted: false, time: 0 })
  const level = (m) => (m.muted ? 0 : Math.max(0, Math.min(1, m.volume)))
  const stop = (m) => {
    const node = m.node
    m.node = null
    if (node) { try { node.onended = null; node.stop() } catch {} try { node.disconnect() } catch {} }
    if (m.gain) { try { m.gain.disconnect() } catch {} m.gain = null }
  }

  Object.defineProperty(proto, 'srcObject', {
    configurable: true, enumerable: true,
    get() { return media(this).stream ?? null },
    set(v) {
      const m = media(this)
      m.stream = v ?? null
      if (m.node) stop(m)
      if (m.stream && !this.paused) live(this, m)
    },
  })
  function live(el, m) {
    const c = context()
    if (typeof c.createMediaStreamSource !== 'function' || !m.stream.getAudioTracks?.().length) return false
    const node = c.createMediaStreamSource(m.stream), gain = c.createGain(); gain.gain.value = level(m)
    node.connect(gain); gain.connect(c.destination)
    m.node = node; m.gain = gain
    return true
  }
  Object.defineProperty(proto, 'volume', {
    configurable: true, enumerable: true,
    get() { return media(this).volume },
    set(v) {
      v = Number(v)
      if (!(v >= 0 && v <= 1)) throw new (g.DOMException || RangeError)('volume must be between 0 and 1', 'IndexSizeError')
      const m = media(this); m.volume = v
      if (m.gain) m.gain.gain.value = level(m)
    },
  })
  Object.defineProperty(proto, 'muted', {
    configurable: true, enumerable: true,
    get() { return media(this).muted },
    set(v) { const m = media(this); m.muted = !!v; if (m.gain) m.gain.gain.value = level(m) },
  })
  Object.defineProperty(proto, 'currentTime', {
    configurable: true, enumerable: true,
    get() {
      const m = media(this)
      if (!m.node || !ctx) return m.time
      const t = ctx.currentTime - m.startedAt, d = m.buffer ? m.buffer.duration : Infinity
      return this.loop && d > 0 ? t % d : Math.min(t, d)
    },
    set(v) { const m = media(this); m.time = Math.max(0, Number(v) || 0); if (m.node && !this.paused) { const token = m.token; stop(m); if (m.buffer) start(this, m, m.buffer, token) } },
  })

  function start(el, m, buffer, token) {
    const c = context()
    const node = c.createBufferSource(); node.buffer = buffer; node.loop = !!el.loop
    const gain = c.createGain(); gain.gain.value = level(m)
    node.connect(gain); gain.connect(c.destination)
    const offset = m.time < buffer.duration ? m.time : 0
    node.onended = () => {
      if (m.node !== node || m.token !== token) return
      stop(m); m.time = 0; el.paused = true
      fire(el, 'pause'); fire(el, 'ended')
    }
    node.start(0, offset)
    m.node = node; m.gain = gain; m.startedAt = c.currentTime - offset
  }

  proto.play = function play() {
    const m = media(this)
    if (m.stream) {
      m.token++
      if (m.node) return Promise.resolve()
      const wasPaused = this.paused
      this.paused = false
      if (wasPaused) fire(this, 'play')
      if (!live(this, m)) { this.paused = true; return Promise.reject(new g.DOMException('The stream has no audio to play.', 'NotSupportedError')) }
      this.readyState = 4
      fire(this, 'playing')
      return Promise.resolve()
    }
    const src = this.src || (typeof this.getAttribute === 'function' ? this.getAttribute('src') : '') || ''
    if (!src) return Promise.reject(new g.DOMException('The element has no supported sources.', 'NotSupportedError'))
    const url = absolute(src)
    this.currentSrc = url
    const token = ++m.token
    stop(m)
    if (this.paused) { this.paused = false; fire(this, 'play') }
    return decode(url).then((buffer) => {
      if (m.token !== token || this.paused) return
      m.buffer = buffer
      this.duration = buffer.duration; this.readyState = 4; this.error = null
      fire(this, 'loadedmetadata')
      start(this, m, buffer, token)
      fire(this, 'playing')
    }, (e) => {
      if (m.token !== token) return
      this.paused = true
      this.error = { code: 4, message: String(e && e.message || e) }
      fire(this, 'error')
      throw new g.DOMException(`${url}: ${this.error.message}`, 'NotSupportedError')
    })
  }
  proto.pause = function pause() {
    const m = media(this)
    m.token++
    if (m.node) { m.time = this.currentTime; stop(m) }
    if (!this.paused) { this.paused = true; fire(this, 'pause') }
  }
  proto.load = function load() {
    const m = media(this)
    m.token++
    stop(m); m.buffer = null; m.time = 0
    this.paused = true; this.readyState = 0
  }
}
