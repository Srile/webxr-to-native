// Several WebGL contexts over the ONE native GL (troika's SDF atlas canvas beside
// three's renderer): the context that made the last call owns the GL state, and a
// call from another context first snapshots the outgoing state by query and restores
// the incoming one's. Nothing here runs until a second context exists; from then on
// every method pays one identity check (installGuards). A snapshot is ~70 queries plus
// 5 per texture unit and 3 per UBO binding actually used (usage), written into a record
// the context keeps; only the rare switch pays it — never the per-frame path.
const CAPS = [0x0BE2 /* BLEND */, 0x0B44 /* CULL_FACE */, 0x0B71 /* DEPTH_TEST */, 0x0BD0 /* DITHER */, 0x8037 /* POLYGON_OFFSET_FILL */,
  0x809E /* SAMPLE_ALPHA_TO_COVERAGE */, 0x80A0 /* SAMPLE_COVERAGE */, 0x0C11 /* SCISSOR_TEST */, 0x0B90 /* STENCIL_TEST */, 0x8C89 /* RASTERIZER_DISCARD */]
const TEX_TARGETS = [[0x0DE1, 0x8069], [0x8513, 0x8514], [0x806F, 0x806A], [0x8C1A, 0x8C1D]]  // [target, binding] 2D, CUBE, 3D, 2D_ARRAY
const PIXEL_STORE = [0x0CF5, 0x0D05, 0x0CF2, 0x0CF3, 0x0CF4, 0x806D, 0x806E, 0x0D02, 0x0D03, 0x0D04]  // UNPACK_ALIGNMENT, PACK_ALIGNMENT, UNPACK_ROW_LENGTH, UNPACK_SKIP_ROWS, UNPACK_SKIP_PIXELS, UNPACK_SKIP_IMAGES, UNPACK_IMAGE_HEIGHT, PACK_ROW_LENGTH, PACK_SKIP_ROWS, PACK_SKIP_PIXELS
const PIXEL_STORE_DEFAULT = [4, 4, 0, 0, 0, 0, 0, 0, 0, 0]
const GL_TEXTURE0 = 0x84C0, GL_FRONT = 0x0404, GL_BACK = 0x0405, GL_ARRAY_BUFFER = 0x8892, GL_PIXEL_PACK = 0x88EB, GL_PIXEL_UNPACK = 0x88EC
const GL_UNIFORM_BUFFER = 0x8A11, GL_COPY_READ = 0x8F36, GL_COPY_WRITE = 0x8F37, GL_TRANSFORM_FEEDBACK = 0x8E22, GL_DRAW_FB = 0x8CA9, GL_READ_FB = 0x8CA8, GL_RENDERBUFFER = 0x8D41

const i = (N, p) => N.getParameter(p) | 0
const f = (N, p) => +N.getParameter(p) || 0
// n values of a vector query into out[off..], 0 where the answer is short.
function vec(N, p, n, out, off) { const v = N.getParameter(p); for (let k = 0; k < n; k++) out[off + k] = v && v[k] !== undefined ? +v[k] : 0 }

export function unitCount(N) { const m = i(N, 0x8B4D /* MAX_COMBINED_TEXTURE_IMAGE_UNITS */); return Math.max(8, Math.min(32, m || 16)) }
export function uboCount(N) { const m = i(N, 0x8A2F /* MAX_UNIFORM_BUFFER_BINDINGS */); return Math.max(0, Math.min(24, m || 0)) }

// High-water marks over EVERY context of the one GL: texture units touched (activeTexture / bindSampler; unit 0
// always) and indexed UNIFORM_BUFFER bindings touched (bindBufferBase / bindBufferRange). context.js bumps them.
// A switch snapshots and restores only below them: past the mark no context ever bound anything, so those units
// still hold GL's defaults in every context. They only grow, so a state saved earlier covers fewer units than the
// mark now; restore() treats its missing units as the defaults (nothing bound) they were when it was saved.
export const usage = { units: 1, ubos: 0 }

// One reusable state record per context (makeState once; snapshot / resetState write into it): a switch allocates
// nothing in JS. Units hold [2D, CUBE, 3D, 2D_ARRAY] texture names at u*4 and a sampler at u; UBOs [buffer, start, size] at b*3.
export function makeState(units, ubos) {
  return {
    caps: new Array(CAPS.length).fill(false), blend: [0, 0, 0, 0, 0, 0], blendColor: [0, 0, 0, 0],
    colorMask: [true, true, true, true], depthMask: true, depthFunc: 0, depthRange: [0, 1], clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0,
    cullFace: 0, frontFace: 0, lineWidth: 1, polyOffset: [0, 0], scissor: [0, 0, 0, 0], viewport: [0, 0, 0, 0], sampleCov: [1, false],
    stencilF: [0, 0, 0, 0, 0, 0, 0], stencilB: [0, 0, 0, 0, 0, 0, 0], pixel: PIXEL_STORE_DEFAULT.slice(),
    program: 0, vao: 0, arrayBuffer: 0, pixelPack: 0, pixelUnpack: 0, uniformBuffer: 0, copyRead: 0, copyWrite: 0, tf: 0,
    drawFb: 0, readFb: 0, renderbuffer: 0, activeTexture: GL_TEXTURE0,
    nUnits: 0, unitTex: new Array(units * 4).fill(0), unitSampler: new Array(units).fill(0),
    nUbos: 0, ubo: new Array(ubos * 3).fill(0),
  }
}

const markUnits = (s) => Math.min(usage.units, s.unitSampler.length)
const markUbos = (s) => Math.min(usage.ubos, s.ubo.length / 3)

export function snapshot(N, s) {
  N = traced(N)
  for (let k = 0; k < CAPS.length; k++) s.caps[k] = !!N.isEnabled(CAPS[k])
  const b = s.blend; b[0] = i(N, 0x80C9); b[1] = i(N, 0x80C8); b[2] = i(N, 0x80CB); b[3] = i(N, 0x80CA); b[4] = i(N, 0x8009); b[5] = i(N, 0x883D)  // SRC_RGB, DST_RGB, SRC_ALPHA, DST_ALPHA, EQ_RGB, EQ_ALPHA
  vec(N, 0x8005, 4, s.blendColor, 0)
  vec(N, 0x0C23, 4, s.colorMask, 0); for (let k = 0; k < 4; k++) s.colorMask[k] = !!s.colorMask[k]
  s.depthMask = !!N.getParameter(0x0B72); s.depthFunc = i(N, 0x0B74); vec(N, 0x0B70, 2, s.depthRange, 0)
  vec(N, 0x0C22, 4, s.clearColor, 0); s.clearDepth = f(N, 0x0B73); s.clearStencil = i(N, 0x0B91)
  s.cullFace = i(N, 0x0B45); s.frontFace = i(N, 0x0B46); s.lineWidth = f(N, 0x0B21); s.polyOffset[0] = f(N, 0x8038); s.polyOffset[1] = f(N, 0x2A00)
  vec(N, 0x0C10, 4, s.scissor, 0); vec(N, 0x0BA2, 4, s.viewport, 0); s.sampleCov[0] = f(N, 0x80AA); s.sampleCov[1] = !!N.getParameter(0x80AB)
  const sf = s.stencilF, sb = s.stencilB
  sf[0] = i(N, 0x0B92); sf[1] = i(N, 0x0B97); sf[2] = i(N, 0x0B93); sf[3] = i(N, 0x0B98); sf[4] = i(N, 0x0B94); sf[5] = i(N, 0x0B95); sf[6] = i(N, 0x0B96)  // FUNC, REF, VALUE_MASK, WRITEMASK, FAIL, PASS_DEPTH_FAIL, PASS_DEPTH_PASS
  sb[0] = i(N, 0x8800); sb[1] = i(N, 0x8CA3); sb[2] = i(N, 0x8CA4); sb[3] = i(N, 0x8CA5); sb[4] = i(N, 0x8801); sb[5] = i(N, 0x8802); sb[6] = i(N, 0x8803)
  for (let k = 0; k < PIXEL_STORE.length; k++) s.pixel[k] = i(N, PIXEL_STORE[k])
  s.program = i(N, 0x8B8D); s.vao = i(N, 0x85B5); s.arrayBuffer = i(N, 0x8894); s.pixelPack = i(N, 0x88ED); s.pixelUnpack = i(N, 0x88EF)
  s.uniformBuffer = i(N, 0x8A28); s.copyRead = i(N, 0x8F36); s.copyWrite = i(N, 0x8F37); s.tf = i(N, 0x8E25)
  s.drawFb = i(N, 0x8CA6); s.readFb = i(N, 0x8CAA); s.renderbuffer = i(N, 0x8CA7); s.activeTexture = i(N, 0x84E0) || GL_TEXTURE0
  const nu = s.nUnits = markUnits(s)
  for (let u = 0; u < nu; u++) {
    N.activeTexture(GL_TEXTURE0 + u)
    for (let t = 0; t < TEX_TARGETS.length; t++) s.unitTex[u * 4 + t] = i(N, TEX_TARGETS[t][1])
    s.unitSampler[u] = i(N, 0x8919 /* SAMPLER_BINDING */)
  }
  N.activeTexture(s.activeTexture)
  const nb = s.nUbos = markUbos(s)
  for (let k = 0; k < nb; k++) { s.ubo[k * 3] = N.getIndexedParameter(0x8A28, k) | 0; s.ubo[k * 3 + 1] = +N.getIndexedParameter(0x8A29, k) || 0; s.ubo[k * 3 + 2] = +N.getIndexedParameter(0x8A2A, k) || 0 }  // UNIFORM_BUFFER_BINDING, _START, _SIZE (0x8A2D/0x8A2E are MAX_*_UNIFORM_BLOCKS: INVALID_ENUM here)
  return s
}

const set = (a, v0, v1, v2, v3) => { a[0] = v0; a[1] = v1; if (a.length > 2) { a[2] = v2; a[3] = v3 } }
// A fresh context's state (WebGL defaults) into s, its default framebuffer being `fbo`.
export function resetState(s, w, h, fbo) {
  for (let k = 0; k < CAPS.length; k++) s.caps[k] = CAPS[k] === 0x0BD0
  const b = s.blend; b[0] = 1; b[1] = 0; b[2] = 1; b[3] = 0; b[4] = 0x8006; b[5] = 0x8006
  set(s.blendColor, 0, 0, 0, 0); set(s.colorMask, true, true, true, true); s.depthMask = true; s.depthFunc = 0x0201; set(s.depthRange, 0, 1)
  set(s.clearColor, 0, 0, 0, 0); s.clearDepth = 1; s.clearStencil = 0
  s.cullFace = GL_BACK; s.frontFace = 0x0901; s.lineWidth = 1; set(s.polyOffset, 0, 0); set(s.scissor, 0, 0, w, h); set(s.viewport, 0, 0, w, h); s.sampleCov[0] = 1; s.sampleCov[1] = false
  for (const st of [s.stencilF, s.stencilB]) { st[0] = 0x0207; st[1] = 0; st[2] = 0xFFFFFFFF; st[3] = 0xFFFFFFFF; st[4] = 0x1E00; st[5] = 0x1E00; st[6] = 0x1E00 }
  for (let k = 0; k < PIXEL_STORE.length; k++) s.pixel[k] = PIXEL_STORE_DEFAULT[k]
  s.program = 0; s.vao = 0; s.arrayBuffer = 0; s.pixelPack = 0; s.pixelUnpack = 0; s.uniformBuffer = 0; s.copyRead = 0; s.copyWrite = 0; s.tf = 0
  s.drawFb = fbo; s.readFb = fbo; s.renderbuffer = 0; s.activeTexture = GL_TEXTURE0
  s.nUnits = 0; s.nUbos = 0   // nothing bound anywhere: restore() writes the defaults up to the marks
  return s
}

// globalThis.__hostGLTrace = true → every call restore() makes is checked with getError and logged on failure.
function traced(N) {
  if (!globalThis.__hostGLTrace) return N
  return new Proxy(N, { get(t, k) { const v = t[k]; if (typeof v !== 'function' || k === 'getError') return v; return (...a) => { const r = v.apply(t, a); const e = t.getError(); if (e) (globalThis.__native?.log ?? console.warn)(2, `gl trace: ${String(k)}(${a.join(',')}) -> error 0x${e.toString(16)}`); return r } } })
}
export function restore(N, s) {
  N = traced(N)
  for (let k = 0; k < CAPS.length; k++) { if (s.caps[k]) N.enable(CAPS[k]); else N.disable(CAPS[k]) }
  N.blendFuncSeparate(s.blend[0], s.blend[1], s.blend[2], s.blend[3]); N.blendEquationSeparate(s.blend[4], s.blend[5]); N.blendColor(s.blendColor[0], s.blendColor[1], s.blendColor[2], s.blendColor[3])
  N.colorMask(s.colorMask[0], s.colorMask[1], s.colorMask[2], s.colorMask[3]); N.depthMask(s.depthMask); N.depthFunc(s.depthFunc); N.depthRange(s.depthRange[0], s.depthRange[1])
  N.clearColor(s.clearColor[0], s.clearColor[1], s.clearColor[2], s.clearColor[3]); N.clearDepth(s.clearDepth); N.clearStencil(s.clearStencil)
  N.cullFace(s.cullFace); N.frontFace(s.frontFace); N.lineWidth(s.lineWidth); N.polygonOffset(s.polyOffset[0], s.polyOffset[1])
  N.scissor(s.scissor[0], s.scissor[1], s.scissor[2], s.scissor[3]); N.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]); N.sampleCoverage(s.sampleCov[0], s.sampleCov[1])
  N.stencilFuncSeparate(GL_FRONT, s.stencilF[0], s.stencilF[1], s.stencilF[2]); N.stencilMaskSeparate(GL_FRONT, s.stencilF[3]); N.stencilOpSeparate(GL_FRONT, s.stencilF[4], s.stencilF[5], s.stencilF[6])
  N.stencilFuncSeparate(GL_BACK, s.stencilB[0], s.stencilB[1], s.stencilB[2]); N.stencilMaskSeparate(GL_BACK, s.stencilB[3]); N.stencilOpSeparate(GL_BACK, s.stencilB[4], s.stencilB[5], s.stencilB[6])
  for (let k = 0; k < PIXEL_STORE.length; k++) N.pixelStorei(PIXEL_STORE[k], s.pixel[k])
  N.useProgram(s.program); N.bindVertexArray(s.vao); N.bindBuffer(GL_ARRAY_BUFFER, s.arrayBuffer); N.bindBuffer(GL_PIXEL_PACK, s.pixelPack); N.bindBuffer(GL_PIXEL_UNPACK, s.pixelUnpack)
  N.bindBuffer(GL_COPY_READ, s.copyRead); N.bindBuffer(GL_COPY_WRITE, s.copyWrite); N.bindTransformFeedback(GL_TRANSFORM_FEEDBACK, s.tf)
  for (let b = 0, nb = markUbos(s); b < nb; b++) {
    const live = b < s.nUbos, buf = live ? s.ubo[b * 3] : 0, start = live ? s.ubo[b * 3 + 1] : 0, size = live ? s.ubo[b * 3 + 2] : 0
    if (buf && size > 0) N.bindBufferRange(GL_UNIFORM_BUFFER, b, buf, start, size); else N.bindBufferBase(GL_UNIFORM_BUFFER, b, buf)
  }
  N.bindBuffer(GL_UNIFORM_BUFFER, s.uniformBuffer)
  N.bindFramebuffer(GL_DRAW_FB, s.drawFb); N.bindFramebuffer(GL_READ_FB, s.readFb); N.bindRenderbuffer(GL_RENDERBUFFER, s.renderbuffer)
  for (let u = 0, nu = markUnits(s); u < nu; u++) {
    N.activeTexture(GL_TEXTURE0 + u)
    const live = u < s.nUnits
    for (let t = 0; t < TEX_TARGETS.length; t++) N.bindTexture(TEX_TARGETS[t][0], live ? s.unitTex[u * 4 + t] : 0)
    N.bindSampler(u, live ? s.unitSampler[u] : 0)
  }
  N.activeTexture(s.activeTexture)
}

// The context whose GL state is live, and the switcher of the latest install (the class is shared by every
// install — the tests install many times — so a later install's contexts are judged against its own `current`).
let current = null
let switchFn = null

// Every public method of the context (the generated pass-throughs in methods.gen.js and the hand-written ones in
// context.js) starts with `this._ensureCurrent()`. Until a second context exists that is the class's empty method,
// which TurboFan inlines to nothing; installGuards swaps in a one-compare version — no wrapper, no rest/apply, no
// extra call frame on the GL path (the old per-method `(...args) => fn.apply(this, args)` wrappers allocated an
// array per call and made every call site megamorphic once troika's canvas existed).
export function installGuards(Ctor, getCurrent, switchTo) {
  const proto = Ctor.prototype
  current = getCurrent()
  switchFn = (c) => { switchTo(c); current = getCurrent() }
  if (proto.__guarded) return
  Object.defineProperty(proto, '__guarded', { value: true })
  // Also re-asserts the caller after an image-source readback ran another canvas's context (texImage2D(canvas)).
  proto._ensureCurrent = function () { if (current !== this) switchFn(this) }
  const getExt = proto.getExtension
  proto.getExtension = function (name) {
    const ext = getExt.call(this, name)
    if (ext && typeof ext === 'object' && !ext.__guarded) {
      Object.defineProperty(ext, '__guarded', { value: true })
      const ctx = this
      for (const k of Object.keys(ext)) if (typeof ext[k] === 'function') { const fn = ext[k]; ext[k] = function (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) { if (current !== ctx) switchFn(ctx); return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) } }
    }
    return ext
  }
  installTrace(proto)
}

// globalThis.__hostGLTraceAll = true → every call made on a SECONDARY context (the canvases troika and the SDF
// generator draw into) is followed by getError and logged on failure, with its arguments; 'all' covers the main one
// too. Debug only: setting it wraps the prototype's methods (rest args, getError per call); clearing it unwraps.
function installTrace(proto) {
  if (Object.getOwnPropertyDescriptor(globalThis, '__hostGLTraceAll')?.get) return
  let trace = globalThis.__hostGLTraceAll
  let saved = null
  const argStr = (a) => a.map((v) => v && typeof v === 'object' ? (v._name !== undefined ? '#' + v._name : (v.length !== undefined ? '[' + v.length + ']' : '{}')) : String(v)).join(',')
  const apply = () => {
    if (trace && !saved) {
      saved = new Map()
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || name.startsWith('_') || name === 'getError') continue
        const d = Object.getOwnPropertyDescriptor(proto, name)
        if (!d || typeof d.value !== 'function') continue
        const fn = d.value
        saved.set(name, fn)
        proto[name] = function (...args) {
          const r = fn.apply(this, args)
          if (trace && (this._secondary || trace === 'all')) { const e = this._n.getError(); if (e) (globalThis.__native?.log ?? console.warn)(2, `gl ${this._secondary ? 'secondary' : 'main'}: ${name}(${argStr(args)}) -> error 0x${e.toString(16)}`) }
          return r
        }
      }
    } else if (!trace && saved) { for (const [name, fn] of saved) proto[name] = fn; saved = null }
  }
  Object.defineProperty(globalThis, '__hostGLTraceAll', { get: () => trace, set: (v) => { trace = v; apply() }, configurable: true, enumerable: false })
  apply()
}
