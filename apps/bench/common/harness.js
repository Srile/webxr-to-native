// The bench harness: one IWSDK World per scene, a frame probe, and `window.__bench`, the hook both drivers
// (tools/bench.mjs over CDP in Quest Browser, over the bridge in the host) use to configure, sample and ramp a scene.
//
// What a frame costs is read the same way on both sides: the XR rAF callback is timed from its first to its last
// line (JS ms: the page's work, including whatever its GL calls cost on this thread), and the interval between
// callback starts is the frame rate the page actually got. In the browser the GL calls only serialise into a command
// buffer and the driver runs in the GPU process; in the host they ran on this thread until the GL thread
// (host/gl/gl_thread.h). Draw calls come from three's own counter (renderer.info), read after each frame.
import { World, SessionMode, createSystem } from '@iwsdk/core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function params(defaults) {
  const out = { ...defaults }
  const q = new URLSearchParams(globalThis.location?.search ?? '')
  for (const [k, v] of q) out[k] = typeof defaults[k] === 'number' ? Number(v) : typeof defaults[k] === 'boolean' ? v === '1' || v === 'true' : v
  return out
}

// A fixed-size ring of per-frame samples (no allocation per frame).
class Probe {
  constructor(n = 4096) {
    this.n = n; this.start = new Float64Array(n); this.js = new Float32Array(n); this.draws = new Uint32Array(n); this.tris = new Uint32Array(n)
    this.count = 0; this.recording = false
  }
  push(t0, t1, draws, tris) {
    if (!this.recording) return
    const i = this.count % this.n; this.start[i] = t0; this.js[i] = t1 - t0; this.draws[i] = draws; this.tris[i] = tris; this.count++
  }
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d

function summarize(probe, hz) {
  const n = Math.min(probe.count, probe.n)
  if (n < 3) return { frames: n }
  const first = probe.count > probe.n ? probe.count % probe.n : 0
  const at = (k) => (first + k) % probe.n
  const iv = [], js = []; let draws = 0, tris = 0
  for (let k = 0; k < n; k++) {
    js.push(probe.js[at(k)]); draws += probe.draws[at(k)]; tris += probe.tris[at(k)]
    if (k) iv.push(probe.start[at(k)] - probe.start[at(k - 1)])
  }
  const span = probe.start[at(n - 1)] - probe.start[at(0)]
  const period = 1000 / hz
  const dropped = iv.reduce((s, v) => s + Math.max(0, Math.round(v / period) - 1), 0)
  iv.sort((a, b) => a - b); const jsSorted = js.slice().sort((a, b) => a - b)
  return {
    frames: n, seconds: round(span / 1000), fps: round((n - 1) / (span / 1000), 1), hz,
    dropped, droppedPct: round(100 * dropped / (n - 1 + dropped), 1),
    intervalP50: round(pct(iv, 0.5)), intervalP99: round(pct(iv, 0.99)),
    jsMean: round(js.reduce((a, b) => a + b, 0) / n), jsP50: round(pct(jsSorted, 0.5)), jsP90: round(pct(jsSorted, 0.9)), jsP99: round(pct(jsSorted, 0.99)),
    draws: Math.round(draws / n), tris: Math.round(tris / n),
  }
}

/**
 * startBench({ name, defaults, build }) — `build(world, p)` populates the scene for parameters `p` and returns
 * `{ dispose(), update?(dt, t) }`; configure() disposes and rebuilds it. `p.n` is the scene's load knob (objects,
 * meshes, instances), which ramp() walks.
 */
export async function startBench({ name, defaults, build }) {
  // ?offer=none: no offered session (Quest Browser 154+ supports offerSession, and a pending offer makes the driver's
  // own requestSession fail with "already an active, immersive XRSession"); tools/bench.mjs asks for it in the browser.
  const p = params({ n: 300, hz: 72, offer: 'always', ...defaults })
  const container = document.getElementById('scene-container') ?? document.body
  const world = await World.create(container, {
    xr: { sessionMode: SessionMode.ImmersiveVR, offer: p.offer, features: { handTracking: false, layers: false } },
    features: { locomotion: false, grabbing: false, physics: false, sceneUnderstanding: false, spatialUI: false },
    render: { fov: 70, near: 0.05, far: 50, camera: { position: [0, 1.6, 0] } },
  })
  const renderer = world.renderer
  const probe = new Probe()
  let current = null, hz = p.hz
  // The scene's per-frame work runs as an IWSDK system, as a game's would.
  class BenchSystem extends createSystem({}) { update(dt, t) { current?.update?.(dt, t) } }
  world.registerSystem(BenchSystem)

  // Time every XR animation-frame callback the page registers (three registers one function, so the wrapper is
  // made once and cached).
  const wrapped = new Map()
  const raf = XRSession.prototype.requestAnimationFrame
  XRSession.prototype.requestAnimationFrame = function (cb) {
    let w = wrapped.get(cb)
    if (!w) {
      w = (t, frame) => {
        const t0 = performance.now()
        cb(t, frame)
        const t1 = performance.now()
        probe.push(t0, t1, renderer.info.render.calls, renderer.info.render.triangles)
      }
      wrapped.set(cb, w)
    }
    return raf.call(this, w)
  }

  // Ask the display for the bench's rate once a session exists, so both sides are measured against the same budget.
  let session = null
  const pollSession = setInterval(async () => {
    if (world.session && world.session !== session) {
      session = world.session
      if (session.updateTargetFrameRate && session.supportedFrameRates?.includes?.(hz)) { try { await session.updateTargetFrameRate(hz) } catch {} }
      else if (session.frameRate) hz = Math.round(session.frameRate)
    }
    if (!world.session) session = null
  }, 250)

  const scene = world.scene
  const api = {
    name, params: p,
    get inXR() { return !!world.session },
    get frameRate() { return world.session?.frameRate ?? null },
    enterXR() { world.launchXR(); return true },
    async configure(next = {}) {
      Object.assign(p, next)
      if (next.hz) hz = next.hz
      if (current) current.dispose()
      current = build(world, p) ?? {}
      renderer.compile?.(scene, world.camera)
      await sleep(500)
      return { ...p }
    },
    // sample(seconds): frame stats over the next `seconds`, after a short settle.
    async sample(seconds = 5, settle = 1) {
      await sleep(settle * 1000)
      probe.count = 0; probe.recording = true
      await sleep(seconds * 1000)
      probe.recording = false
      const s = summarize(probe, world.session?.frameRate ? Math.round(world.session.frameRate) : hz)
      return { scene: name, n: p.n, host: !!globalThis.__native, ...s }
    },
    // ramp({ from, to, step, seconds }): sample at each n; `knee` is the largest n that held the frame rate
    // (at least 97 % of it, and under 2 % of frames dropped).
    async ramp({ from = 100, to = 1500, step = 100, seconds = 4 } = {}) {
      const rows = []; let knee = null
      for (let n = from; n <= to; n += step) {
        await api.configure({ n })
        const r = await api.sample(seconds)
        rows.push(r)
        const held = (r) => r.droppedPct < 2 && r.fps >= 0.97 * r.hz
        if (held(r) && (!knee || knee.n === rows.at(-2)?.n)) knee = { n, draws: r.draws, jsP50: r.jsP50 }
        else if (rows.length > 1 && !held(rows.at(-2)) && !held(r)) break  // two bad steps: done
      }
      return { scene: name, knee, rows }
    },
  }
  globalThis.__bench = api
  await api.configure({})
  api.ready = true
  console.log(`[bench] ${name} ready (n=${p.n})`)
  return api
}

// Helpers the scenes share.
export function gridPositions(n, { width = 2.4, height = 1.4, z = -2.5, y = 1.5 } = {}) {
  // A wall in front of the viewer: every object in view (and frustum culling off), so the draw count does not move
  // with the head.
  const cols = Math.ceil(Math.sqrt(n * width / height)), rows = Math.ceil(n / cols)
  const out = []
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols)
    out.push([(c / Math.max(1, cols - 1) - 0.5) * width, y + (r / Math.max(1, rows - 1) - 0.5) * height, z + ((i * 7919) % 13) * 0.01])
  }
  return out
}
