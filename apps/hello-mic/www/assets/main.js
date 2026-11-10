// hello-mic (WP-25): microphone capture into Web Audio on the host (host.json media.microphone).
//  1. the API is there: navigator.mediaDevices, MediaStream, MediaStreamTrack, AnalyserNode, createMediaStreamSource
//  2. permissions.query({ name: 'microphone' }) before; enumerateDevices lists one audioinput (no label before the grant)
//  3. getUserMedia({ audio: true }) resolves (the system's permission prompt the first time) with one live mono track
//  4. the permission is 'granted' after; the device has a label now
//  5. samples arrive through MediaStreamAudioSourceNode -> AnalyserNode (a real microphone is never digital silence)
//  6. the analyser's data changes over time; enabled = false gives silence, true brings the sound back
//  7. a second getUserMedia and a clone share the open device (it is not opened again) and carry samples too
//  8. stop() ends the tracks; the last one releases the device; its node goes silent
// tone.json (debug.micTone: the capture writes a tone in place of the microphone's samples, for a machine whose
// microphone gives silence, a MacBook with its lid closed) adds: the analyser's peak is at the tone's frequency.
// Then a live level meter (a fresh getUserMedia). The screen is green when all pass, red otherwise; the log ends
// with "hello-mic: PASS n/n" (or FAIL) and READY.
const log = (m) => console.log('hello-mic: ' + m)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(what + ' timed out')), ms) })]).finally(() => clearTimeout(t)) }
const native = () => globalThis.__native?.media?.stats?.() ?? {}

let level = 0, state = 'running'  // what the screen shows: the meter, then green or red
const ctx = new AudioContext()
// RMS and spread of what an analyser holds now (its last fftSize samples).
function measure(an) {
  const t = new Float32Array(an.fftSize); an.getFloatTimeDomainData(t)
  let s = 0, lo = Infinity, hi = -Infinity
  for (const x of t) { s += x * x; if (x < lo) lo = x; if (x > hi) hi = x }
  return { rms: Math.sqrt(s / t.length), spread: hi - lo, first: t[0], last: t[t.length - 1] }
}
// The largest RMS over `ms` of polling (a quiet room has a noise floor; digital silence is 0).
async function listen(an, ms) {
  let rms = 0, spread = 0; const end = performance.now() + ms
  while (performance.now() < end) { const m = measure(an); rms = Math.max(rms, m.rms); spread = Math.max(spread, m.spread); level = m.rms; await sleep(50) }
  return { rms, spread }
}

async function run() {
  check('API shape', typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaStream === 'function' && typeof MediaStreamTrack === 'function' &&
    typeof AnalyserNode === 'function' && typeof ctx.createMediaStreamSource === 'function' && navigator.mediaDevices.getSupportedConstraints().echoCancellation === true)
  const status = await navigator.permissions.query({ name: 'microphone' }); const before = status.state; let changed = 0; status.onchange = () => changed++
  const devBefore = await navigator.mediaDevices.enumerateDevices()
  check('permission and devices before', ['prompt', 'granted'].includes(before) && devBefore.length === 1 && devBefore[0].kind === 'audioinput' && (before === 'granted' || devBefore[0].label === ''),
    `permission ${before}, ${devBefore.length} device(s), label "${devBefore[0]?.label}"`)

  const stream = await timeout(navigator.mediaDevices.getUserMedia({ audio: true }), 60000, 'getUserMedia (the permission prompt)')
  const track = stream.getAudioTracks()[0], set = track?.getSettings() ?? {}
  check('getUserMedia resolves', stream.active && stream.getTracks().length === 1 && track.readyState === 'live' && track.kind === 'audio' && set.channelCount === 1 && set.sampleRate > 0,
    `${set.sampleRate} Hz, echoCancellation ${set.echoCancellation}, "${track?.label}", preset ${native().preset}`)
  const devAfter = await navigator.mediaDevices.enumerateDevices()
  check('permission and devices after', status.state === 'granted' && (before === 'granted' || changed === 1) && devAfter[0]?.label !== '', `${status.state}, change events ${changed}, label "${devAfter[0]?.label}"`)
  const opens = native().opens

  const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an)  // to nothing: no feedback
  const heard = await listen(an, 1000)
  check('samples arrive', heard.rms > 0 && heard.spread > 0, `rms ${heard.rms.toExponential(2)}, spread ${heard.spread.toExponential(2)}`)
  const tone = globalThis.__native?.config?.debug?.micTone
  if (tone) {  // debug.micTone (apps/hello-mic/tone.json): the capture's tone must come out at its frequency
    const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f)
    let peak = 0; for (let k = 1; k < f.length; k++) if (f[k] > f[peak]) peak = k
    const hz = peak * ctx.sampleRate / an.fftSize, bin = ctx.sampleRate / an.fftSize
    check('the tone comes out at its frequency (debug.micTone)', Math.abs(hz - tone) <= bin, `peak ${hz.toFixed(1)} Hz at ${f[peak].toFixed(1)} dB, tone ${tone} Hz, bin ${bin.toFixed(1)} Hz`)
  }
  const a = measure(an); await sleep(200); const b = measure(an)
  const freq = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(freq)
  check('analyser data changes', (a.first !== b.first || a.last !== b.last) && freq.some((v) => Number.isFinite(v)), `first ${a.first.toExponential(2)} -> ${b.first.toExponential(2)}`)

  track.enabled = false; await sleep(300); const off = measure(an)
  track.enabled = true; const on = await listen(an, 400)
  check('enabled = false is silence', off.rms === 0 && off.spread === 0 && on.rms > 0, `off rms ${off.rms}, on again ${on.rms.toExponential(2)}`)

  const second = await navigator.mediaDevices.getUserMedia({ audio: true }), copy = track.clone()
  const an2 = ctx.createAnalyser(); ctx.createMediaStreamSource(second).connect(an2)
  const an3 = ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream([copy])).connect(an3)
  const h2 = await listen(an2, 500), h3 = measure(an3)
  check('a second getUserMedia and a clone share the device', native().opens === opens && native().live === 3 && h2.rms > 0 && h3.rms > 0 && copy.readyState === 'live',
    `opened ${native().opens - opens} more time(s), ${native().live} live tracks, rms ${h2.rms.toExponential(2)} / ${h3.rms.toExponential(2)}`)

  let inactive = 0; stream.oninactive = () => inactive++
  track.stop(); second.getTracks()[0].stop(); copy.stop()
  await sleep(300); const gone = measure(an)
  const n = native()
  check('stop() ends the tracks and releases the device', track.readyState === 'ended' && !stream.active && inactive === 1 && n.live === 0 && gone.rms === 0,
    `live ${n.live}, inactive events ${inactive}, rms after ${gone.rms}`)
  if (n.live === 0) log('device released')
}

function paint() {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    gl.disable(gl.SCISSOR_TEST)
    if (state === 'pass') gl.clearColor(0.1, 0.7, 0.2, 1); else if (state === 'fail') gl.clearColor(0.8, 0.1, 0.2, 1); else gl.clearColor(0.15, 0.15, 0.18, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // The level meter: -60..0 dBFS across the width.
    const db = level > 0 ? 20 * Math.log10(level) : -60, f = Math.max(0, Math.min(1, (db + 60) / 60))
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(Math.round(w * 0.1), Math.round(h * 0.45), Math.round(w * 0.8), Math.round(h * 0.1)); gl.clearColor(0.05, 0.05, 0.05, 1); gl.clear(gl.COLOR_BUFFER_BIT)
    gl.scissor(Math.round(w * 0.1), Math.round(h * 0.45), Math.max(1, Math.round(w * 0.8 * f)), Math.round(h * 0.1)); gl.clearColor(1, 0.85, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT)
    requestAnimationFrame(draw)
  }
  draw()
}

paint()
try { await run() } catch (e) { check('run', false, String(e?.message ?? e)) }
const ok = results.length > 0 && results.every(Boolean)
log(`${ok ? 'PASS' : 'FAIL'} ${results.filter(Boolean).length}/${results.length}`)
state = ok ? 'pass' : 'fail'
log(ok ? 'READY' : 'FAILED')
// A live meter from here on (speak: the yellow bar moves).
try {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true }), an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(s).connect(an)
  globalThis.__helloMicMeter = s
  setInterval(() => { level = measure(an).rms }, 50)
} catch (e) { log('meter: ' + (e?.message ?? e)) }
