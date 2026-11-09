// WebSocket and WebRTC data channels (WP-21) over __native.rtc (host/rtc/rtc_bind.cpp, libdatachannel), installed
// only when the host was built with them (host.json network.webrtc). The browser classes as pages and libraries
// (PeerJS, webrtc-adapter's Chrome shims) use them: WebSocket; RTCPeerConnection with data channels, offers and
// answers, trickle ICE and the state events; RTCDataChannel; RTCSessionDescription; RTCIceCandidate. No media:
// tracks, senders and transceivers are empty, addTrack throws.
export function install(g) {
  const N = g.__native && g.__native.rtc
  if (!N) return
  const { EventTarget, Event, MessageEvent, DOMException } = g
  const HANDLERS = Symbol.for('webxr-host.handlers')  // dom-lite/events.js: on<event> handlers, called from here
  const objects = new Map()  // native id -> WebSocket | RTCPeerConnection | RTCDataChannel
  const fire = (t, type, init) => { const e = init instanceof Event ? init : Object.assign(new Event(type), init); t.dispatchEvent(e) }
  const err = (name, msg) => new DOMException(msg, name)
  const toData = (data, binaryType) => typeof data === 'string' || binaryType === 'arraybuffer' ? data : new g.Blob([data])
  // What send() accepts: a string, an ArrayBuffer or a view as they are; a Blob is read first (async, in order).
  const bytesOf = (data) => ArrayBuffer.isView(data) ? data : data instanceof ArrayBuffer ? data : null

  // ---------------------------------------------------------------------------------------------------------- WebSocket
  class WebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url, protocols) {
      super(); this[HANDLERS] = Object.create(null)
      const u = new g.URL(String(url), g.location.href)
      if (u.protocol === 'http:') u.protocol = 'ws:'; else if (u.protocol === 'https:') u.protocol = 'wss:'
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw err('SyntaxError', `WebSocket: ${url} is not a ws: or wss: URL`)
      this.url = u.href; this.readyState = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob'
      this._closing = null; this._chain = Promise.resolve()
      this._id = N.wsOpen(this.url, protocols === undefined ? [] : [].concat(protocols).map(String))
      objects.set(this._id, this)
    }
    get bufferedAmount() { return this.readyState === 1 ? N.wsBuffered(this._id) : 0 }
    send(data) {
      if (this.readyState === 0) throw err('InvalidStateError', 'WebSocket is still connecting')
      if (this.readyState !== 1) return
      if (data instanceof g.Blob) { this._chain = this._chain.then(() => data.arrayBuffer()).then((b) => { if (this.readyState === 1) N.wsSend(this._id, b) }); return }
      N.wsSend(this._id, bytesOf(data) ?? String(data))
    }
    close(code = 1000, reason = '') { if (this.readyState >= 2) return; this.readyState = 2; this._closing = { code, reason: String(reason) }; N.wsClose(this._id) }
    _event(kind, a) {
      if (kind === 'ws-open') { this.readyState = 1; fire(this, 'open') }
      else if (kind === 'ws-message') fire(this, 'message', new MessageEvent('message', { data: toData(a, this.binaryType), origin: new g.URL(this.url).origin }))
      else if (kind === 'ws-error') { fire(this, 'error'); g.__native.log(2, `WebSocket ${this.url}: ${a}`) }
      else if (kind === 'ws-close') {
        const wasOpen = this.readyState !== 0, c = this._closing ?? { code: wasOpen ? 1005 : 1006, reason: '' }
        this.readyState = 3; objects.delete(this._id)
        fire(this, 'close', Object.assign(new Event('close'), { code: c.code, reason: c.reason, wasClean: !!this._closing }))
      }
    }
  }

  // ------------------------------------------------------------------------------------------------- descriptions
  class RTCSessionDescription {
    constructor(init = {}) { this.type = init.type ?? ''; this.sdp = init.sdp ?? '' }
    toJSON() { return { type: this.type, sdp: this.sdp } }
  }
  class RTCIceCandidate {
    constructor(init = {}) {
      if (init.sdpMid == null && init.sdpMLineIndex == null) throw new TypeError('RTCIceCandidate: sdpMid and sdpMLineIndex are both null')
      this.candidate = init.candidate ?? ''; this.sdpMid = init.sdpMid ?? null; this.sdpMLineIndex = init.sdpMLineIndex ?? null; this.usernameFragment = init.usernameFragment ?? null
      const f = this.candidate.replace(/^a=/, '').replace(/^candidate:/, '').split(/\s+/)
      this.foundation = f[0] ?? null; this.component = f[1] === '1' ? 'rtp' : f[1] === '2' ? 'rtcp' : null; this.protocol = f[2]?.toLowerCase() ?? null
      this.priority = f[3] ? +f[3] : null; this.address = f[4] ?? null; this.port = f[5] ? +f[5] : null; this.type = f[7] ?? null
      this.tcpType = null; this.relatedAddress = null; this.relatedPort = null
    }
    toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment } }
  }

  // ------------------------------------------------------------------------------------------------- data channels
  class RTCDataChannel extends EventTarget {
    constructor(id) {
      super(); this[HANDLERS] = Object.create(null)
      if (id === undefined) throw new TypeError('Illegal constructor')
      this._id = id; this.readyState = 'connecting'; this.binaryType = 'arraybuffer'; this._low = 0; this._chain = Promise.resolve()
      const i = N.dcInfo(id) ?? ['', '', -1, true, -1, -1]
      this.label = i[0]; this.protocol = i[1]; this._sid = i[2] < 0 ? null : i[2]; this.ordered = i[3]
      this.maxRetransmits = i[4] < 0 ? null : i[4]; this.maxPacketLifeTime = i[5] < 0 ? null : i[5]; this.negotiated = false
      objects.set(id, this)
    }
    get id() { if (this._sid === null) { const i = N.dcInfo(this._id); if (i && i[2] >= 0) this._sid = i[2] } return this._sid }
    get reliable() { return this.ordered && this.maxRetransmits === null && this.maxPacketLifeTime === null }
    get bufferedAmount() { return this.readyState === 'open' ? N.dcBuffered(this._id) : 0 }
    get bufferedAmountLowThreshold() { return this._low }
    set bufferedAmountLowThreshold(v) { this._low = Math.max(0, +v || 0); N.dcLowThreshold(this._id, this._low) }
    send(data) {
      if (this.readyState !== 'open') throw err('InvalidStateError', `RTCDataChannel.send: the channel is ${this.readyState}`)
      if (data instanceof g.Blob) { this._chain = this._chain.then(() => data.arrayBuffer()).then((b) => { if (this.readyState === 'open') N.dcSend(this._id, b) }); return }
      if (!N.dcSend(this._id, bytesOf(data) ?? String(data))) throw err('OperationError', 'RTCDataChannel.send failed')
    }
    close() { if (this.readyState === 'closing' || this.readyState === 'closed') return; this.readyState = 'closing'; fire(this, 'closing'); N.dcClose(this._id) }
    _event(kind, a) {
      if (kind === 'dc-open') { this.readyState = 'open'; this.id; fire(this, 'open') }
      else if (kind === 'dc-message') fire(this, 'message', new MessageEvent('message', { data: toData(a, this.binaryType) }))
      else if (kind === 'dc-low') fire(this, 'bufferedamountlow')
      else if (kind === 'dc-error') { fire(this, 'error', { error: err('OperationError', String(a)) }); g.__native.log(2, `RTCDataChannel ${this.label}: ${a}`) }
      else if (kind === 'dc-close') { if (this.readyState === 'closed') return; this.readyState = 'closed'; objects.delete(this._id); fire(this, 'close') }
    }
  }

  // ---------------------------------------------------------------------------------------------- peer connections
  const ICE_DEFAULT = [{ urls: ['stun:stun.l.google.com:19302'] }]
  class RTCPeerConnection extends EventTarget {
    constructor(config = {}) {
      super(); this[HANDLERS] = Object.create(null)
      const servers = (config.iceServers ?? ICE_DEFAULT).map(s => ({ urls: [].concat(s.urls ?? s.url ?? []).map(String), username: s.username ?? '', credential: s.credential ?? '' }))
      this._config = { ...config, iceServers: servers }
      this._id = N.pcCreate(servers, config.iceTransportPolicy === 'relay')
      objects.set(this._id, this)
      this._state = { connection: 'new', ice: 'new', gathering: 'new', signaling: 'stable' }
      this.canTrickleIceCandidates = null; this._closed = false; this._channels = new Set(); this._localWaiters = []
    }
    // State and handler attributes live on the prototype, as in a browser: webrtc-adapter's shims test
    // `'connectionState' in RTCPeerConnection.prototype` and define their own over a missing one.
    get connectionState() { return this._state.connection } get iceConnectionState() { return this._state.ice }
    get iceGatheringState() { return this._state.gathering } get signalingState() { return this._state.signaling }
    get localDescription() { const d = this._closed ? null : N.pcLocal(this._id); return d ? new RTCSessionDescription({ type: d[0], sdp: d[1] }) : null }
    get remoteDescription() { const d = this._closed ? null : N.pcRemote(this._id); return d ? new RTCSessionDescription({ type: d[0], sdp: d[1] }) : null }
    get currentLocalDescription() { return this.localDescription } get pendingLocalDescription() { return null }
    get currentRemoteDescription() { return this.remoteDescription } get pendingRemoteDescription() { return null }
    get sctp() { return this._sctp ?? null }
    getConfiguration() { return { ...this._config } }
    setConfiguration(c) { this._config = { ...this._config, ...c } }
    _live() { if (this._closed) throw err('InvalidStateError', 'RTCPeerConnection is closed') }
    _call(f) { return new Promise((resolve, reject) => { try { this._live(); resolve(f()) } catch (e) { reject(e instanceof DOMException ? e : err('OperationError', String(e?.message ?? e))) } }) }
    createOffer() { return this._call(() => ({ type: 'offer', sdp: N.pcCreateOffer(this._id) })) }
    createAnswer() { return this._call(() => ({ type: 'answer', sdp: N.pcCreateAnswer(this._id) })) }
    // The local description is libdatachannel's own (an offer or answer it makes for its state); the page's SDP, if
    // any, was made by createOffer/createAnswer from the same state. Resolves once the description is in place.
    setLocalDescription(desc) {
      const type = desc?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer')
      // Waits for the description event only when native made a new one (not for a rollback, or an offer it ignored).
      return this._call(() => new Promise((resolve) => { this._localWaiters.push(resolve); if (!N.pcSetLocal(this._id, type)) { this._localWaiters.splice(this._localWaiters.indexOf(resolve), 1); resolve() } }))
    }
    setRemoteDescription(desc) { return this._call(() => { if (!desc || !desc.sdp) throw err('TypeError', 'setRemoteDescription: no SDP'); N.pcSetRemote(this._id, desc.sdp, desc.type); this._sctp = { maxMessageSize: 262144, state: 'connecting', transport: null } }) }
    addIceCandidate(c) {
      return this._call(() => {
        if (!c || !c.candidate) return  // end of candidates
        N.pcAddCandidate(this._id, c.candidate.startsWith('a=') ? c.candidate.slice(2) : c.candidate, c.sdpMid ?? String(c.sdpMLineIndex ?? 0))
      })
    }
    createDataChannel(label, init = {}) {
      this._live()
      const dcId = N.pcCreateDataChannel(this._id, String(label ?? ''), init.ordered !== false, init.maxRetransmits ?? -1, init.maxPacketLifeTime ?? -1, !!init.negotiated, init.id ?? -1, String(init.protocol ?? ''))
      const dc = new RTCDataChannel(dcId); dc.negotiated = !!init.negotiated; this._channels.add(dc)
      return dc
    }
    close() {
      if (this._closed) return
      this._closed = true; Object.assign(this._state, { signaling: 'closed', connection: 'closed', ice: 'closed' })
      for (const dc of this._channels) if (dc.readyState !== 'closed') { dc.readyState = 'closed'; objects.delete(dc._id) }
      objects.delete(this._id); N.pcClose(this._id)
    }
    getStats() { return Promise.resolve(new Map()) }
    getSenders() { return [] } getReceivers() { return [] } getTransceivers() { return [] }
    addTrack() { throw err('NotSupportedError', 'RTCPeerConnection: no media on this host') }
    removeTrack() {} addTransceiver() { throw err('NotSupportedError', 'RTCPeerConnection: no media on this host') }
    restartIce() {}
    static generateCertificate() { return Promise.reject(err('NotSupportedError', 'generateCertificate is not supported')) }
    _event(kind, a, b) {
      if (this._closed) return
      if (kind === 'pc-description') { const w = this._localWaiters.splice(0); w.forEach(r => r()) }
      else if (kind === 'pc-candidate') {
        const mline = /^\d+$/.test(b) ? +b : 0
        fire(this, 'icecandidate', { candidate: new RTCIceCandidate({ candidate: 'candidate:' + a.replace(/^a=/, '').replace(/^candidate:/, ''), sdpMid: b, sdpMLineIndex: mline }), url: null })
      } else if (kind === 'pc-gathering') {
        this._state.gathering = a; fire(this, 'icegatheringstatechange')
        if (a === 'complete') fire(this, 'icecandidate', { candidate: null, url: null })
      } else if (kind === 'pc-state') {
        this._state.connection = a; if (this._sctp) this._sctp.state = a === 'connected' ? 'connected' : a === 'closed' ? 'closed' : this._sctp.state
        fire(this, 'connectionstatechange')
      } else if (kind === 'pc-ice') { this._state.ice = a; fire(this, 'iceconnectionstatechange') }
      else if (kind === 'pc-signaling') { this._state.signaling = a; fire(this, 'signalingstatechange') }
      else if (kind === 'pc-datachannel') { const dc = objects.get(a) ?? new RTCDataChannel(a); this._channels.add(dc); fire(this, 'datachannel', { channel: dc }) }
    }
  }

  // A channel the remote peer opens can report events (open, a first message) from libdatachannel's thread before
  // its pc-datachannel announcement is delivered: those wait, and follow the datachannel event, as in a browser.
  const early = new Map()
  // host.json debug.rtc: every event from native in the log (signalling and ICE trouble across networks).
  const trace = g.__native.config?.debug?.rtc ? (k, id, a, b) => g.__native.log(1, `rtc ${k} #${id}${a === undefined ? '' : ' ' + (typeof a === 'string' ? a.slice(0, 160).replace(/\r?\n/g, ' | ') : a instanceof ArrayBuffer ? `[${a.byteLength} bytes]` : a)}${b === undefined ? '' : ' ' + b}`) : null
  N.onEvent((kind, id, a, b) => {
    trace?.(kind, id, a, b)
    if (kind === 'pc-datachannel') {
      const pc = objects.get(id), dc = objects.get(a) ?? new RTCDataChannel(a)
      pc?._event(kind, a, b)
      for (const [k, x, y] of early.get(a) ?? []) dc._event(k, x, y)
      early.delete(a)
      return
    }
    const target = objects.get(id)
    if (target) target._event(kind, a, b)
    else if (kind.startsWith('dc-')) { let q = early.get(id); if (!q) early.set(id, q = []); q.push([kind, a, b]) }
  })

  for (const [name, value] of Object.entries({ WebSocket, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel,
    RTCPeerConnectionIceEvent: class RTCPeerConnectionIceEvent extends Event { constructor(t, i = {}) { super(t, i); this.candidate = i.candidate ?? null; this.url = i.url ?? null } },
    RTCDataChannelEvent: class RTCDataChannelEvent extends Event { constructor(t, i = {}) { super(t, i); this.channel = i.channel ?? null } } })) {
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })
  }
  // The on<event> handler attributes, on the prototypes as in a browser (the shims probe them there).
  const handlers = (C, names) => { for (const n of names) Object.defineProperty(C.prototype, 'on' + n, { get() { return this[HANDLERS][n] ?? null }, set(v) { this[HANDLERS][n] = typeof v === 'function' ? v : null }, configurable: true, enumerable: true }) }
  handlers(RTCPeerConnection, ['icecandidate', 'icecandidateerror', 'connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange', 'datachannel', 'negotiationneeded', 'track'])
  handlers(RTCDataChannel, ['open', 'message', 'close', 'closing', 'error', 'bufferedamountlow'])
  handlers(WebSocket, ['open', 'message', 'close', 'error'])
}
