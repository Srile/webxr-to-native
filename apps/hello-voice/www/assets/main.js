// hello-voice: WebRTC audio tracks between RTCPeerConnections in this page (host.json network.webrtc +
// media.microphone; debug.micTone 660 makes the capture a 660 Hz tone, which each receiver must hear at 660 Hz).
//  1. a call: addTrack and its negotiationneeded, an Opus offer, the answerer's addTrack before its answer (no
//     needless renegotiation after it), the tone both ways, a remote track's enabled, replaceTrack(null) and back,
//     <audio srcObject> (audio.elements), a data channel added to the live call, close ending the remote tracks
//  2. the common game shape the other way round: a data channel first, voice added to the live call later
//  3. a peer sending its offer again before the answer
//  4. perfect negotiation with glare: both sides add their track and offer at once (two hosts: the same mids)
// The screen is green when all pass, red otherwise; the log ends with "hello-voice: PASS n/n" (or FAIL) and READY.
const log = (m) => console.log('hello-voice: ' + m)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const info = (m) => log('INFO ' + m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(what + ' timed out')), ms) })]).finally(() => clearTimeout(t)) }
const TONE = globalThis.__native?.config?.debug?.micTone ?? 660
const ctx = new AudioContext()
let state = 'running'

// A track's level and the frequency it peaks at, over `ms` (the largest RMS seen; the peak at the end).
function analyser(track) {
  const an = ctx.createAnalyser(); an.fftSize = 2048
  const src = ctx.createMediaStreamSource(new MediaStream([track])); src.connect(an)
  const sink = ctx.createGain(); sink.gain.value = 0; an.connect(sink); sink.connect(ctx.destination)
  return an
}
function rmsNow(an) { const t = new Float32Array(an.fftSize); an.getFloatTimeDomainData(t); let s = 0; for (const x of t) s += x * x; return Math.sqrt(s / t.length) }
function peakHz(an) { const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f); let p = 1; for (let k = 1; k < f.length; k++) if (f[k] > f[p]) p = k; return p * ctx.sampleRate / an.fftSize }
async function listen(an, ms) { let rms = 0; const end = performance.now() + ms; while (performance.now() < end) { rms = Math.max(rms, rmsNow(an)); await sleep(40) } return { rms, hz: peakHz(an) } }
const bin = () => ctx.sampleRate / 2048
const toneOk = (h) => h.rms > 0.01 && Math.abs(h.hz - TONE) <= 2 * bin()

function pair() {
  const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}) }
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}) }
  return [a, b]
}
const connected = (pc) => pc.connectionState === 'connected' ? Promise.resolve() : new Promise((r) => pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') r() }))
const trackOf = (pc) => new Promise((r) => pc.addEventListener('track', (e) => r(e), { once: true }))

async function basic(mic) {
  const [a, b] = pair(); let negA = 0, negB = 0
  a.onnegotiationneeded = () => negA++; b.onnegotiationneeded = () => negB++
  a.addTrack(mic.getAudioTracks()[0], mic)
  await sleep(20); check('negotiationneeded after addTrack', negA === 1, `${negA}`)
  const bTrack = trackOf(b), aTrack = trackOf(a)
  await a.setLocalDescription(await a.createOffer())
  check('offer carries one Opus audio m-line', (a.localDescription.sdp.match(/\nm=audio /g) || []).length === 1 && /a=rtpmap:\d+ opus\/48000/i.test(a.localDescription.sdp))
  await b.setRemoteDescription(a.localDescription)
  const be = await timeout(bTrack, 3000, 'B track event')
  check('track event on the answerer', be.track?.kind === 'audio' && be.streams.length === 1 && be.transceiver?.receiver?.track === be.track)
  // B answers with its own microphone on the transceiver the offer made (before the answer is made).
  const mic2 = await navigator.mediaDevices.getUserMedia({ audio: true })
  const sender = b.addTrack(mic2.getAudioTracks()[0], mic2)
  check('addTrack takes the offer\'s transceiver', b.getTransceivers().length === 1 && b.getTransceivers()[0].sender === sender && b.getTransceivers()[0].direction === 'sendrecv')
  await b.setLocalDescription(await b.createAnswer())
  await a.setRemoteDescription(b.localDescription)
  await timeout(Promise.all([connected(a), connected(b)]), 10000, 'connected')
  const ae = await timeout(aTrack, 3000, 'A track event')
  check('both connected, track event on the offerer', a.connectionState === 'connected' && ae.track?.kind === 'audio')
  await sleep(50)
  check('no needless negotiationneeded on the answerer (its answer carried the track)', negB === 0, `${negB}`)
  const anB = analyser(be.track), anA = analyser(ae.track)
  const hb = await listen(anB, 2500), ha = await listen(anA, 1500)
  check('A -> B: the tone arrives', toneOk(hb), `rms ${hb.rms.toFixed(3)}, peak ${hb.hz.toFixed(1)} Hz`)
  check('B -> A: the tone arrives', toneOk(ha), `rms ${ha.rms.toFixed(3)}, peak ${ha.hz.toFixed(1)} Hz`)
  // The receiver's track muted by the page: silence; unmuted: back.
  be.track.enabled = false; await sleep(400); const off = await listen(anB, 300)
  be.track.enabled = true; const on = await listen(anB, 1200)
  check('remote track enabled = false is silence, true brings it back', off.rms === 0 && toneOk(on), `off ${off.rms.toFixed(4)}, on ${on.rms.toFixed(3)}`)
  // The sender stops sending (replaceTrack(null)), then sends again.
  const sa = a.getSenders()[0]
  await sa.replaceTrack(null); await sleep(600); const quiet = await listen(anB, 400)
  await sa.replaceTrack(mic.getAudioTracks()[0]); const back = await listen(anB, 1500)
  check('replaceTrack(null) stops what arrives, a track again resumes it', quiet.rms < 0.005 && toneOk(back), `null ${quiet.rms.toFixed(4)}, again ${back.rms.toFixed(3)}`)
  // <audio srcObject> plays the remote stream (audio.elements).
  if (typeof Audio === 'function' && globalThis.__native?.config?.audio?.elements) {
    const el = new Audio(); el.srcObject = be.streams[0]
    let ok = true; try { await el.play() } catch (e) { ok = false; info('play: ' + e) }
    check('<audio srcObject> plays the remote stream', ok && !el.paused)
    el.pause()
  } else info('<audio> elements absent on this build')
  // A data channel added on the live call: the first one asks for negotiation, as in a browser.
  negA = 0; let renegotiated = false
  a.onnegotiationneeded = async () => { negA++; await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription); renegotiated = true }
  const remoteDc = new Promise((r) => { b.ondatachannel = (e) => r(e.channel) })
  const dc = a.createDataChannel('state')
  let opened = false
  try { await timeout(new Promise((r) => { dc.onopen = r }), 6000, 'channel open'); opened = true } catch {}
  check('a data channel added to the call negotiates itself and opens', negA >= 1 && renegotiated && opened, `negotiationneeded ${negA}, open ${opened}`)
  if (opened) { const rc = await timeout(remoteDc, 3000, 'remote channel'); const got = new Promise((r) => { rc.onmessage = (e) => r(e.data) }); dc.send('hi'); check('the channel carries a message', (await timeout(got, 3000, 'message')) === 'hi') }
  const after = await listen(anB, 1000)
  check('audio still flows after renegotiation', toneOk(after), `rms ${after.rms.toFixed(3)}`)
  info('holding the call 11 s for the receive stats lines'); await sleep(11000)
  a.close(); b.close()
  await sleep(200)
  check('close ends the remote tracks', be.track.readyState === 'ended' && ae.track.readyState === 'ended')
  mic2.getTracks().forEach((t) => t.stop())
}

// The common game shape: a data channel first (negotiated explicitly, as PeerJS does), voice added to the live call
// later (push-to-talk turned on): addTrack asks for negotiation, the renegotiation brings the track to the peer.
async function dataThenAudio(mic) {
  const [a, b] = pair()
  const dc = a.createDataChannel('game'); const remoteDc = new Promise((r) => { b.ondatachannel = (e) => r(e.channel) })
  const swap = async () => { await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription) }
  await swap()
  await timeout(new Promise((r) => { if (dc.readyState === 'open') r(); else dc.onopen = r }), 8000, 'channel open')
  await sleep(50)
  let neg = 0, renegotiated = null
  a.onnegotiationneeded = () => { neg++; renegotiated = swap().catch((e) => info('renegotiate: ' + e)) }
  const bTrack = trackOf(b)
  a.addTrack(mic.getAudioTracks()[0], mic)
  let ev = null; try { ev = await timeout(bTrack, 6000, 'track after renegotiation') } catch (e) { info(String(e.message)) }
  const h = ev ? await listen(analyser(ev.track), 2000) : { rms: 0, hz: 0 }
  check('data channel first, voice added later: renegotiated, the tone arrives', neg === 1 && !!ev && toneOk(h), `negotiationneeded ${neg}, rms ${h.rms.toFixed(3)}, peak ${h.hz.toFixed(1)} Hz`)
  const rc = await timeout(remoteDc, 3000, 'remote channel'); const got = new Promise((r) => { rc.onmessage = (e) => r(e.data) }); dc.send('still here')
  check('the data channel still carries messages after the audio renegotiation', (await timeout(got, 3000, 'message').catch(() => null)) === 'still here')
  a.close(); b.close()
}

// A peer that sends its offer again before the answer: the second one replaces the first.
async function repeatedOffer(mic) {
  const [c, d] = pair()
  c.addTrack(mic.getAudioTracks()[0], mic)
  await c.setLocalDescription(await c.createOffer())
  await d.setRemoteDescription(c.localDescription)
  let ok = true, why = ''
  try { await d.setRemoteDescription(c.localDescription) } catch (e) { ok = false; why = String(e?.message ?? e) }
  check('a remote offer over one not yet answered is taken', ok && d.signalingState === 'have-remote-offer', why)
  c.close(); d.close()
}

// Perfect negotiation with glare: both sides add their track at once and offer; the polite one rolls back.
async function glare(mic) {
  const [p, q] = pair()  // p polite, q impolite
  const chan = { p: null, q: null }
  const sides = [[p, true, 'q'], [q, false, 'p']]
  const heard = {}
  for (const [pc, polite, other] of sides) {
    let making = false, ignore = false
    pc.ontrack = (e) => { heard[polite ? 'p' : 'q'] = e.track }
    pc.onnegotiationneeded = async () => {
      try { making = true; await pc.setLocalDescription(); setTimeout(() => chan[other]({ description: pc.localDescription }), 5) } catch (e) { info('nn: ' + e) } finally { making = false }
    }
    chan[polite ? 'p' : 'q'] = async ({ description }) => {
      try {
        const collision = description.type === 'offer' && (making || pc.signalingState !== 'stable')
        ignore = !polite && collision
        if (ignore) return
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') { await pc.setLocalDescription(); setTimeout(() => chan[other]({ description: pc.localDescription }), 5) }
      } catch (e) { info(`${polite ? 'polite' : 'impolite'}: ${e?.message ?? e}`) }
    }
  }
  p.addTrack(mic.getAudioTracks()[0], mic); q.addTrack(mic.getAudioTracks()[0], mic)
  let ok = false
  try { await timeout(Promise.all([connected(p), connected(q)]), 10000, 'glare connect'); ok = true } catch (e) { info(String(e.message)) }
  await sleep(500)
  const hp = heard.p ? await listen(analyser(heard.p), 1500) : { rms: 0, hz: 0 }, hq = heard.q ? await listen(analyser(heard.q), 1500) : { rms: 0, hz: 0 }
  check('glare: perfect negotiation connects, the tone arrives both ways', ok && toneOk(hp) && toneOk(hq), `polite rms ${hp.rms.toFixed(3)}, impolite rms ${hq.rms.toFixed(3)}, ${p.getTransceivers().length}/${q.getTransceivers().length} transceivers`)
  p.close(); q.close()
}

function paint() {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => { if (state === 'pass') gl.clearColor(0.1, 0.7, 0.2, 1); else if (state === 'fail') gl.clearColor(0.8, 0.1, 0.2, 1); else gl.clearColor(0.15, 0.15, 0.18, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw) }
  draw()
}

paint()
try {
  check('API shape', typeof RTCRtpTransceiver === 'function' && typeof RTCRtpSender === 'function' && typeof RTCTrackEvent === 'function')
  const mic = await timeout(navigator.mediaDevices.getUserMedia({ audio: true }), 30000, 'getUserMedia')
  await basic(mic)
  await dataThenAudio(mic)
  await repeatedOffer(mic)
  await glare(mic)
} catch (e) { check('run', false, String(e?.stack ?? e)) }
const ok = results.length > 0 && results.every(Boolean)
log(`${ok ? 'PASS' : 'FAIL'} ${results.filter(Boolean).length}/${results.length}`)
state = ok ? 'pass' : 'fail'
log('READY')
