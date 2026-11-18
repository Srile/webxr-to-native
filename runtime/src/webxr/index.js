// webxr/index.js — WebXR through IWER's host mode (`iwer/lib/host.js`, the `iwer/host` entry of Meta's Immersive Web Emulation Runtime, MIT).
// IWER is the WebXR implementation: XRSystem, XRSession, spaces, poses, input sources, layers, events. This file
// is the host side of its contract (iwer/lib/host/types.d.ts): it drives `device.runHostFrame` from
// `__native.xr.onFrame`, writes the native input record into IWER's host input (input.js), creates the swapchain
// through `__native.xr.begin` when the first layer asks (XRHostBackend.beginSwapchain), feeds plane and mesh
// detection from the native scene (scene.js) and turns native events into host events.
//
// What the host adds on top of IWER:
// - XRWebGLLayer: 4x multisampled, sRGB-correct on the Quest compositor, the host's depth texture (layer-target.js)
// - XRWebGLBinding: projection layers with the host's depth texture and one view (the Vision Pro)
// - XRSession.initiateRoomCapture (Meta's room setup, XR_FB_scene_capture)
// - the session modes and features a request may enable, from the native caps at the time of the request:
//   immersive-ar only with passthrough, plane/mesh detection only in immersive-ar with scene understanding
// - the depth range (renderState.depthNear/depthFar) sent to native, offerSession held until the host's own
//   affordance (xr.autoEnter, or the 'offer' event)
import {
  XRDevice, metaQuest3, oculusTouchV3,
  XRWebGLLayer as IwerXRWebGLLayer, XRHostWebGLBinding, XRSession, XRPlane, XRMesh,
  P_DEVICE, P_SESSION, P_WEBGL_LAYER, P_PROJECTION_LAYER, P_VIEWPORT,
} from 'iwer/lib/host.js'
import { F } from './record.js'
import { InputBridge } from './input.js'
import { SceneSource } from './scene.js'
import { installRenderModels } from './render-models.js'
import { HostLayerTarget } from './layer-target.js'

const BASE_FEATURES = ['viewer', 'local', 'local-floor', 'bounded-floor', 'layers', 'hand-tracking',
  'high-fixed-foveation-level', 'medium-fixed-foveation-level', 'low-fixed-foveation-level']  // Quest Browser: initial fixedFoveation
const SCENE_FEATURES = ['plane-detection', 'mesh-detection']
const GL_DEPTH24_STENCIL8 = 0x88F0

// A minimal DOMPointReadOnly where the global has none (IWER makes them; dom-lite installs the page's own).
class DOMPointReadOnlyShim {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w }
  static fromPoint(p = {}) { return new DOMPointReadOnlyShim(p.x, p.y, p.z, p.w) }
  toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w } }
}

export function install(g) {
  const native = g.__native || null
  const nx = native && native.xr ? native.xr : null
  const log = (level, text) => {
    if (native && typeof native.log === 'function') native.log(level, String(text))
    else if (g.console) (level >= 3 ? g.console.error : level === 2 ? g.console.warn : g.console.log)(text)
  }
  const config = () => (native && native.config && native.config.xr) || {}
  const supported = () => { try { return !!(nx && typeof nx.supported === 'function' && nx.supported()) } catch (e) { return false } }
  const caps = () => { try { return (nx && typeof nx.caps === 'function' && nx.caps()) || {} } catch (e) { return {} } }
  const DOMException = g.DOMException || globalThis.DOMException
  if (typeof globalThis.DOMPointReadOnly !== 'function') globalThis.DOMPointReadOnly = g.DOMPointReadOnly || DOMPointReadOnlyShim
  if (typeof g.DOMPointReadOnly !== 'function') g.DOMPointReadOnly = globalThis.DOMPointReadOnly

  // --- the session's host-side state ------------------------------------------------------------------------
  let active = null            // the running XRSession
  let swap = null              // its native begin() answer: width, height, arraySize, format, depthTexture, viewCount, …
  let opaque = undefined       // the projection layers' colorTexture: one object per session
  let frameRec = null          // native's frame record (one array, rewritten in place)
  let frameId = 0
  let sceneGen = -1
  let webglLayerSrgb = false   // true while an XRWebGLLayer constructs: its swapchain is asked for sRGB
  let platformEnded = false    // the person left (vision: the immersive space closed): no automatic re-entry
  let pendingPresent = null    // a requestSession held until the runtime's session has begun (headsetReady)
  let captureWaiters = null
  let depthNear = NaN, depthFar = NaN
  const scene = nx ? new SceneSource(nx, log) : null

  const wrapTexture = (name) => typeof g.__hostWrapTexture === 'function' ? g.__hostWrapTexture(name) : { __name: name }
  // The runtime's session state as native reports it; null where there is none (a test's fake without it).
  const nativeState = () => { try { return nx && typeof nx.state === 'function' ? nx.state() : null } catch (e) { return null } }
  // The runtime's session has begun (READY: xrBeginSession done) or is already showing. Before that no frame comes
  // (xrWaitFrame does not run while IDLE: the headset off at launch), and a page given a session then switches onto
  // XR rAF and freezes. The host publishes the state change while the page is still flat (app/host.cpp
  // publishXrState), so a held request opens on that event. No state(): ready.
  const headsetReady = () => { const st = nativeState(); return !st || !!(st.running || st.visible || st.focused) }
  const captureDone = () => {
    const w = captureWaiters
    captureWaiters = null
    if (w) for (let i = 0; i < w.length; i++) w[i]()
  }

  const backend = {
    beginSwapchain(o) {
      if (!nx || typeof nx.begin !== 'function') return null
      const cfg = config()
      const opts = { arraySize: o.arraySize, scale: o.scale, format: o.format }
      if (o.passthrough) opts.passthrough = 1
      if (o.unpremultiplied) opts.unpremultiplied = 1
      if (o.scene) opts.scene = 1
      if (webglLayerSrgb) opts.srgbLayer = 1
      if (cfg.preferredRate != null) opts.preferredRate = cfg.preferredRate
      // host.json wins; else the Quest Browser's startup features (high/medium/low-fixed-foveation-level)
      const fov = cfg.foveation != null ? Math.min(1, Math.max(0, +cfg.foveation || 0)) : (o.foveation ?? null)
      if (fov != null) opts.foveation = fov
      let res = null
      try { res = nx.begin(opts) } catch (e) { log(3, 'xr.begin failed: ' + e) }
      if (!res) return null
      swap = res
      // XR frames drive the window's rAF from here on; dom-lite's flat source stands down until the session ends
      if (typeof g.__hostSuspendFlatFrames === 'function') {
        try { g.__hostSuspendFlatFrames() } catch (e) { log(3, '__hostSuspendFlatFrames failed: ' + e) }
      }
      return {
        width: res.width, height: res.height, arraySize: res.arraySize ?? o.arraySize,
        rates: res.rates, rate: res.rate, hasStage: res.hasStage, stageWidth: res.stageWidth, stageDepth: res.stageDepth,
        foveation: fov ?? undefined,
      }
    },
    endSession() {
      try { if (nx && typeof nx.end === 'function') nx.end() } catch (e) { log(3, 'xr.end failed: ' + e) }
    },
    requestFrameRate(hz) {
      try { return !!(nx && typeof nx.requestRefreshRate === 'function' && nx.requestRefreshRate(hz)) } catch (e) { log(2, 'xr.requestRefreshRate failed: ' + e); return false }
    },
    setFixedFoveation(level) {
      try { if (nx && typeof nx.setFoveation === 'function') nx.setFoveation(level) } catch (e) { log(2, 'xr.setFoveation failed: ' + e) }
    },
    setPassthroughVisible(on) {
      try { if (nx && typeof nx.setPassthrough === 'function') nx.setPassthrough(on) } catch (e) { log(2, 'xr.setPassthrough failed: ' + e) }
    },
    // ONE object for the session whose name follows the acquired swapchain image (what a browser hands out); the
    // context re-attaches it wherever the page attached it, once per frame (onFrame below).
    getOpaqueColorTexture() {
      if (opaque === undefined) {
        const nameOf = () => frameRec !== null ? frameRec[F.COLOR_TEX] : 0
        opaque = typeof g.__hostOpaqueTexture === 'function' ? g.__hostOpaqueTexture(nameOf) : { _opaque: true, get _name() { return nameOf() }, get __name() { return nameOf() } }
      }
      return opaque
    },
    wrapTexture,
    runWindowFrame(time) { if (typeof g.__hostRunWindowFrame === 'function') g.__hostRunWindowFrame(time) },
    postTask(cb) {
      if (native && native.loop && typeof native.loop.postTask === 'function') native.loop.postTask(cb)
      else setTimeout(cb, 0)
    },
    get autoGrantOfferedSession() { return !!config().autoEnter && !platformEnded },
    get invalidateDepth() { return config().invalidate !== false },
    getPlanes() { return scene ? scene.planes(sceneGen, frameId) : null },
    getMeshes() { return scene ? scene.meshes(sceneGen, frameId) : null },
    reportError(error, source) { log(3, 'xr ' + source + ': ' + (error && error.stack || error)) },
  }

  // --- the device -----------------------------------------------------------------------------------------
  // Touch controllers with the fallback profiles the WebXR input profiles registry gives oculus-touch-v3. host.json
  // xr.controllerProfiles names other controllers with the same layout (the runtime maps them onto the Touch
  // bindings): the page sees those profiles, most specific first, instead (the Steam Frame's, on SteamVR).
  const named = Array.isArray(config().controllerProfiles) ? config().controllerProfiles.filter((p) => typeof p === 'string' && p) : []
  const controllerConfig = named.length
    ? { ...oculusTouchV3, profileId: named[0], fallbackProfileIds: named.slice(1) }
    : { ...oculusTouchV3, fallbackProfileIds: ['oculus-touch-v2', 'oculus-touch', 'generic-trigger-squeeze-thumbstick'] }
  // Every mode and feature the host can ever offer; requestSession below narrows them to what this system offers.
  const device = new XRDevice({
    ...metaQuest3,
    name: 'webxr-host',
    controllerConfig,
    supportedSessionModes: ['immersive-vr', 'immersive-ar'],
    supportedFeatures: BASE_FEATURES.concat(SCENE_FEATURES),
    supportedFrameRates: [],
    environmentBlendModes: { 'immersive-vr': 'opaque', 'immersive-ar': 'alpha-blend' },
  }, { host: backend })

  const input = new InputBridge(device.enableHostInput({
    controllerConfig,
    onHaptic(handedness, intensity, durationMs, hz) {
      try { if (nx && typeof nx.vibrate === 'function') nx.vibrate(handedness === 'left' ? 0 : 1, intensity, durationMs / 1000, hz) } catch (e) { log(2, 'xr.vibrate failed: ' + e) }
      const loop = native && native.loop
      if (loop && typeof loop.setTimer === 'function' && durationMs > 0) return new Promise((resolve) => loop.setTimer(durationMs, false, () => resolve(true)))
      return true
    },
  }))

  // IWER replaces WebGL contexts' makeXRCompatible with its own; the context's (webgl/context.js) records the flag.
  const WGL = globalThis.WebGL2RenderingContext
  const ownXRCompatible = WGL && WGL.prototype ? Object.getOwnPropertyDescriptor(WGL.prototype, 'makeXRCompatible') : undefined
  if (!g.navigator) g.navigator = {}
  if (!globalThis.navigator) globalThis.navigator = g.navigator
  device.installRuntime({ globalObject: g, forceInstall: true })
  installRenderModels(g, nx, log)
  if (ownXRCompatible) Object.defineProperty(WGL.prototype, 'makeXRCompatible', ownXRCompatible)
  const system = device[P_DEVICE].xrSystem
  if (g.navigator.xr !== system) Object.defineProperty(g.navigator, 'xr', { value: system, writable: true, configurable: true, enumerable: true })

  // --- the layer classes the page constructs ---------------------------------------------------------------
  class XRWebGLLayer extends IwerXRWebGLLayer {
    constructor(session, context, init = {}) {
      const gl = context || (typeof g.__hostGL === 'function' ? g.__hostGL() : null)
      if (!gl) throw new TypeError('XRWebGLLayer needs a WebGL context')
      const srgb = !!(gl._glExt && gl._glExt.has('GL_EXT_sRGB_write_control') && typeof gl._setSrgbRawFramebuffer === 'function')
      webglLayerSrgb = srgb
      try { super(session, gl, { ...init, depth: false, stencil: false }) } finally { webglLayerSrgb = false }
      const st = this[P_WEBGL_LAYER]
      if (st.host && swap) st.host = new HostLayerTarget(gl, st.host.framebuffer, swap, init, srgb, config().invalidate !== false, wrapTexture, config().clearFrame === true)

    }
  }

  class XRWebGLBinding extends XRHostWebGLBinding {
    constructor(session, context) {
      super(session, context || (typeof g.__hostGL === 'function' ? g.__hostGL() : null))
    }
    createProjectionLayer(init = {}) {
      const layer = super.createProjectionLayer(init)
      const p = layer[P_PROJECTION_LAYER]
      if (swap && p.textureType === 'texture') {
        // one view (the Vision Pro simulator): its sub-image is the whole image
        if (swap.viewCount === 1) { const vp = p.subImages[0].viewport[P_VIEWPORT]; vp.x = 0; vp.width = swap.width }
        // the host's depth texture (vision reads the page's depth into the compositor's); three attaches it to its
        // XR render target instead of its own renderbuffer when the layer has no stencil
        if (swap.depthTexture > 0 && p.depthFormat !== GL_DEPTH24_STENCIL8) {
          const depth = wrapTexture(swap.depthTexture)
          p.subImages[0].depthStencilTexture = depth
          p.subImages[1].depthStencilTexture = depth
          Object.defineProperty(layer, 'ignoreDepthValues', { configurable: true, get() { return false } })
        }
      }
      return layer
    }
  }

  // the page sees the standard names (the bundler renames classes that shadow an import)
  Object.defineProperty(XRWebGLLayer, 'name', { value: 'XRWebGLLayer' })
  Object.defineProperty(XRWebGLBinding, 'name', { value: 'XRWebGLBinding' })
  g.XRWebGLLayer = XRWebGLLayer
  g.XRWebGLBinding = XRWebGLBinding
  g.XRPlane = XRPlane
  g.XRMesh = XRMesh

  // Meta's room setup (the mesh-detection module's initiateRoomCapture), where the system has XR_FB_scene_capture.
  Object.defineProperty(XRSession.prototype, 'initiateRoomCapture', {
    configurable: true, writable: true, enumerable: false,
    value: function initiateRoomCapture() {
      const s = this[P_SESSION]
      if (s.ended) return Promise.reject(new DOMException('XRSession has already ended.', 'InvalidStateError'))
      if (!s.enabledFeatures.includes('plane-detection') && !s.enabledFeatures.includes('mesh-detection'))
        return Promise.reject(new DOMException('plane-detection or mesh-detection must be enabled', 'NotSupportedError'))
      let ok = false
      try { ok = !!(nx && typeof nx.requestSceneCapture === 'function' && nx.requestSceneCapture()) } catch (e) { log(2, 'xr.requestSceneCapture failed: ' + e) }
      if (!ok) return Promise.reject(new DOMException('room capture is not available', 'NotSupportedError'))
      return new Promise((resolve) => { (captureWaiters || (captureWaiters = [])).push(resolve) })
    },
  })

  // --- navigator.xr: what this system offers now ---------------------------------------------------------------
  const modeOk = (mode) => supported() && (mode === 'immersive-vr' || (mode === 'immersive-ar' && !!caps().passthrough))
  const featuresFor = (mode) => {
    const set = new Set(BASE_FEATURES)
    if (mode === 'immersive-ar' && caps().scene) for (let i = 0; i < SCENE_FEATURES.length; i++) set.add(SCENE_FEATURES[i])
    return set
  }
  const iwerRequest = system.requestSession.bind(system)
  const own = (name, value) => Object.defineProperty(system, name, { value, writable: true, configurable: true, enumerable: false })
  own('isSessionSupported', (mode) => typeof mode !== 'string' ? Promise.reject(new TypeError('mode must be a string')) : Promise.resolve(modeOk(mode)))
  // the pre-1.0 shape: resolves when supported, rejects otherwise
  own('supportsSession', (mode) => system.isSessionSupported(mode).then((ok) => {
    if (!ok) throw new DOMException('The specified session configuration is not supported.', 'NotSupportedError')
  }))
  // IWER's offerSession and grantOfferedSession come through here too
  own('requestSession', (mode, init = {}) => {
    if (mode !== 'immersive-vr' && mode !== 'immersive-ar') return Promise.reject(new DOMException('"' + mode + '" sessions are not supported', 'NotSupportedError'))
    if (!supported()) return Promise.reject(new DOMException('No XR device is available', 'NotSupportedError'))
    if (!modeOk(mode)) return Promise.reject(new DOMException('"' + mode + '" sessions are not supported on this device', 'NotSupportedError'))
    if (active !== null || pendingPresent !== null) return Promise.reject(new DOMException('An immersive session is already active', 'InvalidStateError'))
    const allowed = featuresFor(mode)
    const required = (init && init.requiredFeatures) || []
    for (let i = 0; i < required.length; i++) {
      if (!allowed.has(required[i])) return Promise.reject(new DOMException('Required feature "' + required[i] + '" is not supported', 'NotSupportedError'))
    }
    const optional = []
    const asked = (init && init.optionalFeatures) || []
    for (let i = 0; i < asked.length; i++) {
      if (allowed.has(asked[i])) optional.push(asked[i])
      else log(1, 'xr: optional feature "' + asked[i] + '" is not supported and was dropped')
    }
    const open = () => iwerRequest(mode, { ...init, requiredFeatures: required.slice(), optionalFeatures: optional }).then(started)
    if (headsetReady()) return open()
    return new Promise((resolve, reject) => { pendingPresent = { open, resolve, reject } })
  })

  function started(session) {
    active = session
    depthNear = NaN; depthFar = NaN
    // Opened while the runtime's session is READY or SYNCHRONIZED, the session starts hidden: those frames carry no
    // valid views, and a page that places its scene from the first frame it is given (a game's menu) keeps that
    // garbage for good. The READY state change was published before this session existed, so the state now stands
    // in for it; the VISIBLE / FOCUSED change brings the visibilitychange to 'visible' as it always did.
    const st = nativeState()
    if (st && !st.visible) device.dispatchHostEvent({ type: 'visibilitychange', visible: false, focused: false })
    session.addEventListener('end', () => {
      if (active === session) active = null
      swap = null
      opaque = undefined
      input.reset()
      if (scene) scene.clear()
      sceneGen = -1
      captureDone()
      if (typeof g.__hostResumeFlatFrames === 'function') {
        try { g.__hostResumeFlatFrames() } catch (e) { log(3, '__hostResumeFlatFrames failed: ' + e) }
      }
    }, { once: true })
    return session
  }

  // --- native → IWER ----------------------------------------------------------------------------------------
  // The host frame IWER reads during runHostFrame: one object, its arrays views on native's own record.
  const hostFrame = { predictedDisplayTime: 0, shouldRender: true, viewCount: 2, views: null, localPose: null, baseIsStage: true, colorTexture: 0, frameRate: 0 }
  function onFrame(f, rec) {
    if (frameRec !== f) {
      frameRec = f
      hostFrame.views = f.subarray(F.VIEW0, F.VIEW0 + 2 * F.VIEW_STRIDE)
      hostFrame.localPose = f.subarray(F.LOCAL_POS, F.LOCAL_POS + 7)
    }
    const session = active
    if (session === null) return
    frameId++
    hostFrame.predictedDisplayTime = f[F.TIME]
    hostFrame.shouldRender = f[F.SHOULD_RENDER] > 0.5
    const n = f[F.VIEW_COUNT] | 0
    hostFrame.viewCount = n < 1 ? 1 : n > 2 ? 2 : n
    hostFrame.baseIsStage = f[F.BASE_KIND] > 0.5
    hostFrame.colorTexture = f[F.COLOR_TEX]
    hostFrame.frameRate = f[F.RATE]
    sceneGen = f[F.SCENE_GEN]
    try { input.write(rec) } catch (e) { log(3, 'xr input: ' + (e && e.stack || e)) }
    if (session.visibilityState !== 'hidden') {
      // the GL queue's framebuffer bindings start the XR frame at 0 (the host unbinds after the last submit)
      const gl = typeof g.__hostGL === 'function' ? g.__hostGL() : null
      if (gl && gl.__hostXrFrameStart) gl.__hostXrFrameStart()
      // the projection layers' colorTexture now names this frame's image wherever the page attached it
      if (opaque !== undefined && opaque._ctx) {
        try { opaque._ctx._reattachOpaque(opaque) } catch (e) { log(3, 'opaque texture reattach: ' + (e && e.stack || e)) }
      }
    }
    device.runHostFrame(hostFrame)
    const rs = session.renderState
    if ((rs.depthNear !== depthNear || rs.depthFar !== depthFar) && nx && typeof nx.setDepthRange === 'function') {
      depthNear = rs.depthNear; depthFar = rs.depthFar
      try { nx.setDepthRange(depthNear, depthFar) } catch (e) { log(2, 'xr.setDepthRange failed: ' + e) }
    }
  }

  function onEvent(type, a, b) {
    if (type === 'offer') {  // the host's own enter affordance (vision: the window's button) accepts a held offer
      if (device.sessionOffered) device.grantOfferedSession()
      else log(1, 'xr: enter requested with no session on offer')
      return
    }
    if (type === 'scenecapture') { captureDone(); return }
    if (type === 'state' && pendingPresent !== null && headsetReady()) { const p = pendingPresent; pendingPresent = null; p.open().then(p.resolve, p.reject) }
    if (active === null) return
    if (type === 'state') device.dispatchHostEvent({ type: 'visibilitychange', visible: a > 0.5, focused: b > 0.5 })
    else if (type === 'rate') { if (a > 0) device.dispatchHostEvent({ type: 'frameratechange', rate: a }) }
    else if (type === 'reset') device.dispatchHostEvent({ type: 'referencespacereset' })
    else if (type === 'end') { platformEnded = true; device.dispatchHostEvent({ type: 'end' }) }
  }

  if (nx) {
    if (typeof nx.onFrame === 'function') nx.onFrame(onFrame)
    if (typeof nx.onEvent === 'function') nx.onEvent(onEvent)
  }

  const ctx = {
    device, system, backend, XRWebGLLayer, XRWebGLBinding,
    get session() { return active }, get swap() { return swap }, get frameRecord() { return frameRec },
  }
  return { xr: system, ctx }
}
