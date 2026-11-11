// WebGL2RenderingContext over __native.gl (host/gl/webgl_bind.cpp; the native
// surface is documented in README.md beside this file). The native side is a
// flat object of GL calls taking names as numbers; this class owns everything
// a browser's context owns that GL does not: object identity (one wrapper per
// GL name per kind), the enum constants, the canvas and its drawing-buffer
// size, context attributes, the extension table, the pixelStorei emulation,
// the WebGL-only getParameter answers, the per-shader source cache and the
// gl_DrawID rewrite behind WEBGL_multi_draw.
//
// The pass-through methods (bindBuffer, uniform4fv, drawElements, …) are
// generated from host/gl/webgl_table.py into methods.gen.js and assigned onto
// the prototype; the methods defined on the class below override or add to
// them. Deliberately NOT done, for speed: no index-range validation on
// drawElements, no "object belongs to this context" checks, no GL-error
// synthesis — GL errors come back through getError exactly as the driver
// raises them.
import { GL, PARAM_OBJECTS } from './constants.gen.js'
import { generatedMethods, setNative, N, FB, fbReset } from './methods.gen.js'
import * as methods from './methods.gen.js'
import { KIND_CLASS, WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat } from './objects.js'
import { buildExtensionTable, EXTENSION_ALIASES } from './extensions.js'
import { UploadScratch, isImageSource, isArrayBufferish, prepareTypedUpload, prepareImageUpload } from './pixels.js'
import { rewriteDrawId, drawIdMode, std140Blocks, DRAW_ID_UNIFORM, DRAW_ID_ATTRIB } from './shader-rewrite.js'
import { MultiDrawIndirect, DRAW_ID_LOC_ATTRIB } from './multidraw.js'
import { usage } from './switch.js'

// GL_FRAMEBUFFER_SRGB_EXT (EXT_sRGB_write_control) as last set: one GL context under every WebGL one, on by default.
const GL_FRAMEBUFFER_SRGB_EXT = 0x8DB9
let srgbOn = true
function srgbWrites(on) { if (on !== srgbOn) { srgbOn = on; if (on) N.enable(GL_FRAMEBUFFER_SRGB_EXT); else N.disable(GL_FRAMEBUFFER_SRGB_EXT) } }

const VERSION_STRING = 'WebGL 2.0 (webxr-host)'
const GLSL_VERSION_STRING = 'WebGL GLSL ES 3.00 (webxr-host)'
const UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
const COMPLETION_STATUS_KHR = 0x91B1
const TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE

// texture internalformat → the upload format a GPU copy out of an RGBA8 drawing buffer reproduces exactly.
const COPY_FORMAT = new Map([[GL.RGBA, GL.RGBA], [GL.RGBA8, GL.RGBA], [GL.RGB, GL.RGB], [GL.RGB8, GL.RGB]])

// getParameter pname → the object kind its GL name wraps into.
const PARAM_OBJECT_KIND = new Map()
for (const kind in PARAM_OBJECTS) for (const p of PARAM_OBJECTS[kind]) PARAM_OBJECT_KIND.set(p, kind)

const DEFAULT_ATTRS = {
  alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false,
  powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false, desynchronized: false, xrCompatible: true,
}

function parseGLVersion(s) {
  // "OpenGL ES 3.2 V@0502.0 …" → 3.2
  const m = /OpenGL ES(?:-CM)? (\d+)\.(\d+)/.exec(String(s || ''))
  return m ? Number(m[1]) + Number(m[2]) / 10 : 3.0
}

export class WebGL2RenderingContext {
  constructor(native, canvas, attrs, log, type) {
    this._n = native
    this._webgl1 = type === 'webgl' || type === 'experimental-webgl'
    this.canvas = canvas
    this._attrs = Object.assign({}, DEFAULT_ATTRS)
    if (attrs && typeof attrs === 'object') {
      // antialias is honoured as ASKED (the WebGL default is true): three reads it back to pick 4 samples for its XR
      // render target (framebufferTextureMultisampleMultiviewOVR), which is where the headset's MSAA comes from.
      for (const k of ['alpha', 'depth', 'stencil', 'antialias', 'premultipliedAlpha', 'preserveDrawingBuffer', 'xrCompatible', 'desynchronized', 'failIfMajorPerformanceCaveat'])
        if (attrs[k] !== undefined) this._attrs[k] = !!attrs[k]
      if (typeof attrs.powerPreference === 'string') this._attrs.powerPreference = attrs.powerPreference
    }
    this._log = log || null
    this._warned = new Set()
    this._objs = {}
    for (const kind in KIND_CLASS) this._objs[kind] = new Map()
    this._pixel = { flipY: false, premultiply: false, colorspace: GL.BROWSER_DEFAULT_WEBGL, alignment: 4, rowLength: 0, skipPixels: 0, skipRows: 0, skipImages: 0 }
    this._scratch = new UploadScratch()
    this._currentProgram = null
    this._srgbRawFb = null  // an sRGB XRWebGLLayer's framebuffer (bindFramebuffer)
    this._lost = false
    this._lostErrorPending = false
    const extString = typeof native.extensions === 'function' ? native.extensions() : ''
    this._glExt = new Set(String(extString || '').split(/\s+/).filter(Boolean))
    this._glVersion = parseGLVersion(typeof native.getString === 'function' ? native.getString(GL.VERSION) : '')
    this._extTable = buildExtensionTable(this)
    this._extObjects = new Map()
    this._supported = null
    this._secondary = false; this._fbo = null; this._fboTex = null; this._fboDepth = null; this._fboW = 0; this._fboH = 0; this._savedState = null; this._stateRec = null; this._units = 16; this._ubos = 0
    this._rb = null; this._copyFbo = 0
    this._mdi = new MultiDrawIndirect(native)   // WEBGL_multi_draw as indirect draws; _mdi.attrib = the reserved draw-id attribute (-1: none)
    this._vao = null                           // the bound WebGLVertexArrayObject (null = default VAO), for multidraw.js
  }

  // ---- secondary contexts (index.js): the default framebuffer is an FBO sized to the canvas ----
  _initSecondary() {
    this._secondary = true
    this._ensureDrawingBuffer()
    this.bindFramebuffer(GL.FRAMEBUFFER, null)
    this.clearColor(0, 0, 0, 0); this.clear(GL.COLOR_BUFFER_BIT | (this._attrs.depth ? GL.DEPTH_BUFFER_BIT : 0) | (this._attrs.stencil ? GL.STENCIL_BUFFER_BIT : 0))
    this.viewport(0, 0, this.drawingBufferWidth, this.drawingBufferHeight); this.scissor(0, 0, this.drawingBufferWidth, this.drawingBufferHeight)
  }
  _ensureDrawingBuffer() {
    const w = Math.max(1, this.drawingBufferWidth), h = Math.max(1, this.drawingBufferHeight)
    if (this._fbo && this._fboW === w && this._fboH === h) return
    const prevTex = this.getParameter(GL.TEXTURE_BINDING_2D), prevRb = this.getParameter(GL.RENDERBUFFER_BINDING)
    const prevDraw = this.getParameter(GL.DRAW_FRAMEBUFFER_BINDING), prevRead = this.getParameter(GL.READ_FRAMEBUFFER_BINDING)
    if (!this._fbo) { this._fbo = this.createFramebuffer(); this._fboTex = this.createTexture() }
    this.bindTexture(GL.TEXTURE_2D, this._fboTex)
    this.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR); this.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR)
    this.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE); this.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE)
    this.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, w, h, 0, GL.RGBA, GL.UNSIGNED_BYTE, null)
    this.bindFramebuffer(GL.FRAMEBUFFER, this._fbo)
    this.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, this._fboTex, 0)
    if (this._attrs.depth || this._attrs.stencil) {
      if (!this._fboDepth) this._fboDepth = this.createRenderbuffer()
      this.bindRenderbuffer(GL.RENDERBUFFER, this._fboDepth)
      this.renderbufferStorage(GL.RENDERBUFFER, GL.DEPTH24_STENCIL8, w, h)
      this.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, this._fboDepth)
    }
    this._fboW = w; this._fboH = h
    this.bindTexture(GL.TEXTURE_2D, prevTex); this.bindRenderbuffer(GL.RENDERBUFFER, prevRb)
    this.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw === this._fbo ? null : prevDraw); this.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead === this._fbo ? null : prevRead)
  }
  __hostCanvasResized() { if (this._secondary) this._ensureDrawingBuffer() }
  // ---- the flat frame on a window host (index.js): before the page's callbacks, and the present after them ----
  // The implicit clear a browser gives a presented drawing buffer (colour 0, depth 1, stencil 0, unless the page asked
  // to preserve it) follows only a frame the page DREW: native counts the page's draw, clear and blit calls
  // (N.drawCount), and a frame without any (an on-demand renderer between changes) keeps what it showed.
  __hostBeginFlatFrame() {
    if (this._secondary || this._lost) return
    if (this._msaa === undefined) this._msaa = this._wantsMsaa()
    if (this._msaa) this._ensureMsaaBuffer()
    if (this._pendingClear && N.clearDrawingBuffer)
      N.clearDrawingBuffer(this._fbo ? this._fbo._name : 0, GL.COLOR_BUFFER_BIT | (this._attrs.depth ? GL.DEPTH_BUFFER_BIT : 0) | (this._attrs.stencil ? GL.STENCIL_BUFFER_BIT : 0))
    this._pendingClear = false
    this._drawMark = N.drawCount ? N.drawCount() : 0
  }
  // Multisampling (host.json gl.antialias, off by default): with it, a page that asks for antialias (WebGL's default)
  // draws into a 4x (or MAX_SAMPLES) multisampled drawing buffer, as in a browser; without it every page draws
  // single-sampled, as before. Wonderland's text needs it: drawn with alpha-to-coverage, one sample cuts its glyphs.
  _wantsMsaa() {
    const want = this._antialiasCfg === true && !!this._attrs.antialias  // host.json gl.antialias, set by index.js
    if (!want) return false
    this._msaaSamples = Math.min(4, N.getParameter(GL.MAX_SAMPLES) | 0)
    return this._msaaSamples > 1
  }
  // The multisampled drawing buffer the page's default framebuffer maps to, at the canvas size, and the single-sample
  // texture it resolves into after a drawn frame (the window is filled from that, so a skipped frame shows the last one).
  _ensureMsaaBuffer() {
    const w = Math.max(1, this.drawingBufferWidth), h = Math.max(1, this.drawingBufferHeight)
    if (this._fbo && this._fboW === w && this._fboH === h) return
    const prevRb = N.getParameter(GL.RENDERBUFFER_BINDING) | 0, prevTex = N.getParameter(GL.TEXTURE_BINDING_2D) | 0
    const prevDraw = N.getParameter(GL.DRAW_FRAMEBUFFER_BINDING) | 0, prevRead = N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0
    const old = this._fbo ? this._fbo._name : -1
    if (!this._fbo) {
      this._fbo = this.createFramebuffer(); this._msaaColor = this.createRenderbuffer()
      if (this._attrs.depth || this._attrs.stencil) this._fboDepth = this.createRenderbuffer()
      this._resolveFbo = this.createFramebuffer(); this._resolveTex = this.createTexture()
    }
    const n = this._msaaSamples
    N.bindRenderbuffer(GL.RENDERBUFFER, this._msaaColor._name); N.renderbufferStorageMultisample(GL.RENDERBUFFER, n, GL.RGBA8, w, h)
    N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._fbo._name); N.framebufferRenderbuffer(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, this._msaaColor._name)
    if (this._fboDepth) {
      N.bindRenderbuffer(GL.RENDERBUFFER, this._fboDepth._name); N.renderbufferStorageMultisample(GL.RENDERBUFFER, n, GL.DEPTH24_STENCIL8, w, h)
      N.framebufferRenderbuffer(GL.DRAW_FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, this._fboDepth._name)
    }
    N.bindTexture(GL.TEXTURE_2D, this._resolveTex._name); N.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, w, h, 0, GL.RGBA, GL.UNSIGNED_BYTE, null, 0)
    for (const [k, v] of [[GL.TEXTURE_MIN_FILTER, GL.LINEAR], [GL.TEXTURE_MAG_FILTER, GL.LINEAR], [GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE], [GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE]]) N.texParameteri(GL.TEXTURE_2D, k, v)
    N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._resolveFbo._name); N.framebufferTexture2D(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, this._resolveTex._name, 0)
    this._fboW = w; this._fboH = h; this._resolved = false
    N.bindRenderbuffer(GL.RENDERBUFFER, prevRb); N.bindTexture(GL.TEXTURE_2D, prevTex)
    // the page's "default framebuffer" binding (0, or the old buffer) follows to the new one
    N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw === 0 || prevDraw === old ? this._fbo._name : prevDraw)
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead === 0 || prevRead === old ? this._fbo._name : prevRead)
  }
  // The multisampled buffer resolved into the texture; its samples then invalidated (a tile GPU need not store them:
  // the next drawn frame starts with the implicit clear).
  _resolveMsaa(invalidate) {
    const prevRead = N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0, prevDraw = N.getParameter(GL.DRAW_FRAMEBUFFER_BINDING) | 0, scissor = !!N.isEnabled(GL.SCISSOR_TEST)
    if (scissor) N.disable(GL.SCISSOR_TEST)
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, this._fbo._name); N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._resolveFbo._name)
    N.blitFramebuffer(0, 0, this._fboW, this._fboH, 0, 0, this._fboW, this._fboH, GL.COLOR_BUFFER_BIT, GL.NEAREST)
    if (invalidate && !this._attrs.preserveDrawingBuffer) N.invalidateFramebuffer(GL.READ_FRAMEBUFFER, this._fboDepth ? [GL.COLOR_ATTACHMENT0, GL.DEPTH_STENCIL_ATTACHMENT] : [GL.COLOR_ATTACHMENT0])
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead); N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw)
    if (scissor) N.enable(GL.SCISSOR_TEST)
    this._resolved = true
  }
  // A read of the default framebuffer (readPixels, copyTex*) while it is multisampled reads its resolve, as a browser's
  // does: _readBegin() binds the resolve for the read (true when it did), _readEnd() binds the drawing buffer back.
  _readBegin() {
    if (!this._msaa || !this._fbo || (N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0) !== this._fbo._name) return false
    this._resolveMsaa(false)
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, this._resolveFbo._name)
    return true
  }
  _readEnd(began) { if (began) N.bindFramebuffer(GL.READ_FRAMEBUFFER, this._fbo._name) }
  // After the page's callbacks: a drawn frame asks for the implicit clear before the next one. On a window host the
  // drawing buffer then reaches the window: multisampled, through its resolve; sized unlike the window (a pixel-ratio
  // cap), through an FBO of its size scaled into it, as a browser scales the canvas; else it was the window itself.
  __hostFlatPresent(win) {
    if (this._secondary || this._lost) return
    const drew = N.drawCount ? N.drawCount() !== this._drawMark : true
    if (drew && !this._attrs.preserveDrawingBuffer) this._pendingClear = true
    const fbW = win[0] | 0, fbH = win[1] | 0, cw = this.drawingBufferWidth, ch = this.drawingBufferHeight
    if (this._msaa) {
      if (!this._fbo || !(fbW > 0 && fbH > 0)) return
      if (drew || !this._resolved) this._resolveMsaa(true)
      this._blitToWindow(this._resolveFbo._name, fbW, fbH, this._fboW === fbW && this._fboH === fbH ? GL.NEAREST : GL.LINEAR)
      return
    }
    if (!(fbW > 0 && fbH > 0 && cw > 0 && ch > 0 && (cw !== fbW || ch !== fbH))) { if (this._fbo) this._dropDrawingBuffer(); return }
    const fresh = !this._fbo
    this._ensureDrawingBuffer()
    if (fresh) return  // this frame went to the window; the next ones go to the FBO
    this._blitToWindow(this._fbo._name, fbW, fbH, GL.LINEAR)
  }
  _blitToWindow(src, fbW, fbH, filter) {
    const prevRead = N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0, prevDraw = N.getParameter(GL.DRAW_FRAMEBUFFER_BINDING) | 0, scissor = !!N.isEnabled(GL.SCISSOR_TEST)
    if (scissor) N.disable(GL.SCISSOR_TEST)
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, src); N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, 0)
    N.blitFramebuffer(0, 0, this._fboW, this._fboH, 0, 0, fbW, fbH, GL.COLOR_BUFFER_BIT, filter)
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead); N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw)
    if (scissor) N.enable(GL.SCISSOR_TEST)
  }
  _dropDrawingBuffer() {
    const name = this._fbo._name
    if ((N.getParameter(GL.DRAW_FRAMEBUFFER_BINDING) | 0) === name) N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, 0)
    if ((N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0) === name) N.bindFramebuffer(GL.READ_FRAMEBUFFER, 0)
    const fbo = this._fbo; this._fbo = null  // first, so the deletes below never map a null binding onto it
    this.deleteFramebuffer(fbo); this.deleteTexture(this._fboTex); if (this._fboDepth) this.deleteRenderbuffer(this._fboDepth)
    this._fboTex = null; this._fboDepth = null; this._fboW = this._fboH = 0
  }
  _ensureCurrent() {}  // replaced by installGuards once a second context exists
  // The drawing buffer's pixels as GL holds them: rows BOTTOM-UP (the canvas says so with __rgbaBottomUp, and every
  // consumer — prepareImageUpload, drawImage, toDataURL, createImageBitmap — accounts for it, so three's flipY=true upload
  // needs no flip at all), in a buffer this context reuses: valid until its next readback, never kept.
  __readback() {
    if (!this._secondary) return null
    this._ensureDrawingBuffer()
    const w = this._fboW, h = this._fboH
    const prevRead = this.getParameter(GL.READ_FRAMEBUFFER_BINDING), prevPack = this.getParameter(GL.PACK_ALIGNMENT), prevPbo = this.getParameter(GL.PIXEL_PACK_BUFFER_BINDING)
    this.bindFramebuffer(GL.READ_FRAMEBUFFER, null); this.bindBuffer(GL.PIXEL_PACK_BUFFER, null); this.pixelStorei(GL.PACK_ALIGNMENT, 1)
    let out = this._rb
    if (!out || out.length !== w * h * 4) out = this._rb = new Uint8Array(w * h * 4)
    this.readPixels(0, 0, w, h, GL.RGBA, GL.UNSIGNED_BYTE, out)
    this.pixelStorei(GL.PACK_ALIGNMENT, prevPack); this.bindBuffer(GL.PIXEL_PACK_BUFFER, prevPbo); this.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead)
    return out
  }
  // texImage2D / texSubImage2D from a SECONDARY WebGL canvas (troika's SDF atlas) into the bound TEXTURE_2D, as a GPU copy
  // out of that canvas's drawing-buffer FBO: both contexts are the one native GL, so raw N calls on the CURRENT state, no
  // switch, no readback (no tiler flush, no CPU copy). flipY=true is a straight copyTex(Sub)Image2D (the FBO is bottom-up,
  // as flipY wants); flipY=false is a Y-swapped blitFramebuffer through a scratch draw FBO. False (nothing done) where the
  // copy could differ from the readback upload: premultiply asked, a format/type/internalformat other than RGBA8/RGB8 with
  // UNSIGNED_BYTE (sRGB textures included: a copy would encode), unpack skips, a size other than the canvas's, feedback.
  _copyFromCanvas(source, target, level, internalformat, xo, yo, w, h, border, format, type, define) {
    const sc = source.__gl
    if (!(sc instanceof WebGL2RenderingContext) || !sc._secondary || !sc._fbo || sc._lost) return false
    const p = this._pixel
    if (target !== GL.TEXTURE_2D || type !== GL.UNSIGNED_BYTE || p.premultiply || p.rowLength || p.skipPixels || p.skipRows || border !== 0) return false
    const fw = sc._fboW, fh = sc._fboH
    if (fw !== Math.max(1, sc.drawingBufferWidth) || fh !== Math.max(1, sc.drawingBufferHeight) || w !== fw || h !== fh) return false
    const texName = N.getParameter(GL.TEXTURE_BINDING_2D) | 0
    if (!texName || texName === sc._fboTex._name) return false
    const tex = this._lookup('texture', texName)
    const ifmt = define ? internalformat >>> 0 : tex._ifmt
    if (COPY_FORMAT.get(ifmt) !== format) return false
    const flip = !p.flipY
    let scissor = false
    if (flip) { if (N.isEnabled(GL.RASTERIZER_DISCARD)) return false; scissor = !!N.isEnabled(GL.SCISSOR_TEST) }
    const prevRead = N.getParameter(GL.READ_FRAMEBUFFER_BINDING) | 0
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, sc._fbo._name)
    if (define) N.copyTexImage2D(target, level | 0, ifmt, 0, 0, w, h, 0)   // the storage; unflipped, the pixels too
    else if (!flip) N.copyTexSubImage2D(target, level | 0, xo | 0, yo | 0, 0, 0, w, h)
    if (flip) {
      const prevDraw = N.getParameter(GL.DRAW_FRAMEBUFFER_BINDING) | 0
      if (!this._copyFbo) this._copyFbo = N.createFramebuffer()
      N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._copyFbo)
      N.framebufferTexture2D(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, target, texName, level | 0)
      if (scissor) N.disable(GL.SCISSOR_TEST)
      N.blitFramebuffer(0, 0, w, h, xo | 0, (yo | 0) + h, (xo | 0) + w, yo | 0, GL.COLOR_BUFFER_BIT, GL.NEAREST)
      if (scissor) N.enable(GL.SCISSOR_TEST)
      N.framebufferTexture2D(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, target, 0, level | 0)
      N.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw)
    }
    N.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead)
    if (define && (level | 0) === 0) tex._ifmt = ifmt
    return true
  }
  // Remembers the bound TEXTURE_2D's level-0 internalformat (what _copyFromCanvas checks a texSubImage2D against).
  _noteFormat(target, level, internalformat) {
    if (target !== GL.TEXTURE_2D || (level | 0) !== 0) return
    // The texture bound as bindTexture/activeTexture recorded it (a getParameter would wait on the GL thread at
    // every upload: an avatar's bone texture is one each frame).
    const known = this._tex2d?.[this._unit ?? 0]
    const t = known !== undefined ? known : N.getParameter(GL.TEXTURE_BINDING_2D) | 0
    const o = t ? this._lookup('texture', t) : null
    if (o) o._ifmt = internalformat >>> 0
  }
  // ---- opaque textures (webxr projection layers): remember where they are attached, re-attach per frame ----
  // The framebuffer bound to `target` (DRAW or READ): from the recorded bindings with the GL thread on (no round
  // trip), from GL otherwise.
  _boundFb(target) {
    if (methods.queued) return FB[target === GL.READ_FRAMEBUFFER ? 1 : 0] | 0
    return N.getParameter(target === GL.READ_FRAMEBUFFER ? GL.READ_FRAMEBUFFER_BINDING : GL.DRAW_FRAMEBUFFER_BINDING) | 0
  }
  // Each XR frame starts with both bindings 0 (the host unbinds after the previous frame's submit).
  __hostXrFrameStart() { if (methods.queued) fbReset() }
  _noteAttach(texture, rec) {
    if (!texture || !texture._opaque || this._reattaching) return
    rec.fbo = this._boundFb(rec.target)
    const list = texture._attachments
    for (let i = 0; i < list.length; i++) if (list[i].fbo === rec.fbo && list[i].attachment === rec.attachment) { list[i] = rec; return }
    list.push(rec)
  }
  _reattachOpaque(tex) {
    const name = tex._name
    if (tex._lastName === name) return
    tex._lastName = name
    if (!tex._attachments.length) return
    this._reattaching = true
    // With the GL thread on, the bindings are saved and restored there (no getParameter round trip every frame).
    const onThread = typeof N.glqSaveFb === 'function'
    let prevDraw = null, prevRead = null
    const fb0 = FB[0], fb1 = FB[1]
    if (onThread) N.glqSaveFb(); else { prevDraw = this.getParameter(GL.DRAW_FRAMEBUFFER_BINDING); prevRead = this.getParameter(GL.READ_FRAMEBUFFER_BINDING) }
    for (const a of tex._attachments) {
      this.bindFramebuffer(a.target, this._lookup('framebuffer', a.fbo))
      if (a.kind === '2d') this.framebufferTexture2D(a.target, a.attachment, a.textarget, tex, a.level)
      else if (a.kind === 'layer') this.framebufferTextureLayer(a.target, a.attachment, tex, a.level, a.layer)
      else { const mv = this.getExtension('OCULUS_multiview') || this.getExtension('OVR_multiview2'); if (!mv) continue
        if (a.kind === 'mv') mv.framebufferTextureMultiviewOVR(a.target, a.attachment, tex, a.level, a.base, a.n)
        else mv.framebufferTextureMultisampleMultiviewOVR(a.target, a.attachment, tex, a.level, a.samples, a.base, a.n) }
    }
    if (onThread) { N.glqRestoreFb(); FB[0] = fb0; FB[1] = fb1 } else { this.bindFramebuffer(GL.DRAW_FRAMEBUFFER, prevDraw); this.bindFramebuffer(GL.READ_FRAMEBUFFER, prevRead) }
    this._reattaching = false
  }
  framebufferTexture2D(target, attachment, textarget, texture, level) {
    this._ensureCurrent()
    N.framebufferTexture2D(target, attachment, textarget, texture ? texture._name : 0, level)
    this._noteAttach(texture, { kind: '2d', target, attachment, textarget, level, fbo: 0 })
  }
  framebufferTextureLayer(target, attachment, texture, level, layer) {
    this._ensureCurrent()
    N.framebufferTextureLayer(target, attachment, texture ? texture._name : 0, level, layer)
    this._noteAttach(texture, { kind: 'layer', target, attachment, level, layer, fbo: 0 })
  }
  bindFramebuffer(target, framebuffer) {
    this._ensureCurrent()
    N.bindFramebuffer(target, framebuffer ? framebuffer._name : this._fbo ? this._fbo._name : 0)
    if (this._srgbRawFb !== null && target !== GL.READ_FRAMEBUFFER) srgbWrites(framebuffer !== this._srgbRawFb)
  }
  // An XRWebGLLayer over an sRGB swapchain (webxr/layers.js: the Quest compositor shows a 2D RGBA8 one as linear,
  // washed out). The page writes sRGB-encoded bytes into it, as into any 8-bit framebuffer, so GL's linear-to-sRGB
  // conversion on write is off while that framebuffer is the draw framebuffer and on otherwise: a page's own
  // SRGB8_ALPHA8 render target still encodes, as WebGL 2 has it. After a context switch (index.js) the restored
  // draw binding decides.
  _setSrgbRawFramebuffer(fb) { this._srgbRawFb = fb || null }
  _srgbSync(drawFbName) { if (this._srgbRawFb !== null) srgbWrites(drawFbName !== this._srgbRawFb._name) }

  // ---- bindings switch.js snapshots: bump the high-water marks it loops to -----------------------------
  activeTexture(texture) {
    this._ensureCurrent()
    texture >>>= 0
    const u = texture - 0x84C0 /* TEXTURE0 */ + 1
    if (u > usage.units && u <= 32) usage.units = u
    this._unit = u - 1
    N.activeTexture(texture)
  }
  bindTexture(target, texture) {
    this._ensureCurrent()
    target >>>= 0
    const name = texture ? texture._name : 0
    if (target === GL.TEXTURE_2D) (this._tex2d ??= [])[this._unit ?? 0] = name
    N.bindTexture(target, name)
  }
  bindSampler(unit, sampler) {
    this._ensureCurrent()
    unit >>>= 0
    if (unit >= usage.units && unit < 32) usage.units = unit + 1
    N.bindSampler(unit, sampler ? sampler._name : 0)
  }
  bindBufferBase(target, index, buffer) {
    this._ensureCurrent()
    target >>>= 0; index >>>= 0
    if (target === GL.UNIFORM_BUFFER && index >= usage.ubos && index < 24) usage.ubos = index + 1
    N.bindBufferBase(target, index, buffer ? buffer._name : 0)
  }
  bindBufferRange(target, index, buffer, offset, size) {
    this._ensureCurrent()
    target >>>= 0; index >>>= 0
    if (target === GL.UNIFORM_BUFFER && index >= usage.ubos && index < 24) usage.ubos = index + 1
    N.bindBufferRange(target, index, buffer ? buffer._name : 0, +offset, +size)
  }

  // ---- bookkeeping used by the generated methods ----------------------------------------
  _create(kind, name) {
    if (!name) return null
    const o = new KIND_CLASS[kind](name)
    this._objs[kind].set(name, o)
    return o
  }
  _lookup(kind, name) {
    if (!name) return null
    const m = this._objs[kind]
    let o = m.get(name)
    if (o === undefined) { o = new KIND_CLASS[kind](name); m.set(name, o) }
    return o
  }
  _release(kind, o) {
    const m = this._objs[kind]
    if (m.get(o._name) === o) m.delete(o._name)
    o._name = 0; o._deleted = true
  }
  _warn(msg) {
    if (this._warned.has(msg)) return
    this._warned.add(msg)
    if (this._log) this._log(msg)
  }
  _loseContext() {
    if (this._lost) return
    this._lost = true; this._lostErrorPending = true
    this._dispatch('webglcontextlost')
  }
  _restoreContext() {
    if (!this._lost) return
    this._lost = false
    this._dispatch('webglcontextrestored')
  }
  _dispatch(type) {
    const c = this.canvas
    if (!c || typeof c.dispatchEvent !== 'function') return
    const E = typeof globalThis.Event === 'function' ? globalThis.Event : null
    const ev = E ? new E(type, { cancelable: true }) : { type, cancelable: true, preventDefault() {} }
    try { c.dispatchEvent(ev) } catch (e) { this._warn('WebGL: ' + type + ' listener threw: ' + (e && e.message)) }
  }

  // ---- context-level surface ---------------------------------------------------------------
  get drawingBufferWidth() { return (this.canvas && this.canvas.width) | 0 }
  get drawingBufferHeight() { return (this.canvas && this.canvas.height) | 0 }
  get drawingBufferColorSpace() { return 'srgb' }
  set drawingBufferColorSpace(v) {}
  get unpackColorSpace() { return 'srgb' }
  set unpackColorSpace(v) {}
  get drawingBufferFormat() { return GL.RGBA8 }
  getContextAttributes() { return Object.assign({}, this._attrs) }
  isContextLost() { return this._lost }
  makeXRCompatible() { this._attrs.xrCompatible = true; return Promise.resolve() }
  commit() {}

  getError() {
    this._ensureCurrent()
    if (this._lostErrorPending) { this._lostErrorPending = false; return GL.CONTEXT_LOST_WEBGL }
    if (this._lost) return GL.NO_ERROR
    return N.getError()
  }

  getSupportedExtensions() {
    if (!this._supported) {
      this._supported = []
      for (const [name, e] of this._extTable) if (e.gate()) this._supported.push(name)
    }
    return this._supported.slice()
  }
  getExtension(name) {
    this._ensureCurrent()
    name = String(name)
    const canon = EXTENSION_ALIASES.get(name) || name
    let obj = this._extObjects.get(canon)
    if (obj !== undefined) return obj
    const e = this._extTable.get(canon)
    obj = e && e.gate() ? e.make() : null
    this._extObjects.set(canon, obj)
    return obj
  }

  // ---- pixel store ---------------------------------------------------------------------------
  pixelStorei(pname, param) {
    this._ensureCurrent()
    const p = this._pixel
    switch (pname) {
      case GL.UNPACK_FLIP_Y_WEBGL: p.flipY = !!param; return
      case GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL: p.premultiply = !!param; return
      case GL.UNPACK_COLORSPACE_CONVERSION_WEBGL: p.colorspace = param | 0; return
      case GL.UNPACK_ALIGNMENT: p.alignment = param | 0; break
      case GL.UNPACK_ROW_LENGTH: p.rowLength = param | 0; break
      case GL.UNPACK_SKIP_PIXELS: p.skipPixels = param | 0; break
      case GL.UNPACK_SKIP_ROWS: p.skipRows = param | 0; break
      case GL.UNPACK_SKIP_IMAGES: p.skipImages = param | 0; break
    }
    N.pixelStorei(pname, param)
  }

  // ---- getParameter and the typed getters ------------------------------------------------------
  getParameter(pname) {
    this._ensureCurrent()
    switch (pname) {
      case GL.UNPACK_FLIP_Y_WEBGL: return this._pixel.flipY
      case GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return this._pixel.premultiply
      case GL.UNPACK_COLORSPACE_CONVERSION_WEBGL: return this._pixel.colorspace
      case GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL: return 0
      case GL.VERSION: return VERSION_STRING
      case GL.SHADING_LANGUAGE_VERSION: return GLSL_VERSION_STRING
      case UNMASKED_VENDOR_WEBGL: return N.getString(GL.VENDOR)
      case UNMASKED_RENDERER_WEBGL: return N.getString(GL.RENDERER)
      case GL.MAX_VERTEX_ATTRIBS: if (this._mdi.attrib >= 0) return this._mdi.attrib; break   // the last location is the draw-id attribute's
    }
    const kind = PARAM_OBJECT_KIND.get(pname)
    const v = N.getParameter(pname)
    if (kind === undefined) return v
    const o = this._lookup(kind, v | 0)
    return this._fbo && o === this._fbo ? null : o   // a secondary context's drawing buffer reads as the default framebuffer
  }
  getIndexedParameter(target, index) {
    this._ensureCurrent()
    const v = N.getIndexedParameter(target, index)
    return (target === GL.TRANSFORM_FEEDBACK_BUFFER_BINDING || target === GL.UNIFORM_BUFFER_BINDING) ? this._lookup('buffer', v | 0) : v
  }
  getInternalformatParameter(target, internalformat, pname) { this._ensureCurrent(); return N.getInternalformatParameter(target, internalformat, pname) }
  getProgramParameter(program, pname) {
    this._ensureCurrent()
    const v = N.getProgramParameter(program ? program._name : 0, pname)
    switch (pname) {
      case GL.DELETE_STATUS: case GL.LINK_STATUS: case GL.VALIDATE_STATUS: case COMPLETION_STATUS_KHR: return v !== 0
      case GL.ACTIVE_ATTRIBUTES: return program && program._hiddenAttr >= 0 && v > 0 ? v - 1 : v
    }
    return v
  }
  getShaderParameter(shader, pname) {
    this._ensureCurrent()
    const v = N.getShaderParameter(shader ? shader._name : 0, pname)
    switch (pname) {
      case GL.DELETE_STATUS: case GL.COMPILE_STATUS: case COMPLETION_STATUS_KHR: return v !== 0
    }
    return v
  }
  getFramebufferAttachmentParameter(target, attachment, pname) {
    this._ensureCurrent()
    const v = N.getFramebufferAttachmentParameter(target, attachment, pname)
    if (pname !== GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) return v
    const type = N.getFramebufferAttachmentParameter(target, attachment, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
    if (type === GL.TEXTURE) return this._lookup('texture', v | 0)
    if (type === GL.RENDERBUFFER) return this._lookup('renderbuffer', v | 0)
    return null
  }
  getTexParameter(target, pname) {
    this._ensureCurrent()
    const v = N.getTexParameter(target, pname)
    return pname === GL.TEXTURE_IMMUTABLE_FORMAT ? v !== 0 : v
  }
  getSamplerParameter(sampler, pname) { this._ensureCurrent(); return N.getSamplerParameter(sampler ? sampler._name : 0, pname) }
  getVertexAttrib(index, pname) {
    this._ensureCurrent()
    if (index === this._mdi.attrib) return null   // past the MAX_VERTEX_ATTRIBS the game sees
    const v = N.getVertexAttrib(index, pname)
    switch (pname) {
      case GL.VERTEX_ATTRIB_ARRAY_ENABLED: case GL.VERTEX_ATTRIB_ARRAY_NORMALIZED: case GL.VERTEX_ATTRIB_ARRAY_INTEGER: return v !== 0
      case GL.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return this._lookup('buffer', v | 0)
    }
    return v
  }
  getVertexAttribOffset(index, pname) { this._ensureCurrent(); return N.getVertexAttribOffset(index, pname) }
  getQueryParameter(query, pname) {
    this._ensureCurrent()
    const v = N.getQueryParameter(query ? query._name : 0, pname)
    return pname === GL.QUERY_RESULT_AVAILABLE ? v !== 0 : v
  }
  getShaderPrecisionFormat(shadertype, precisiontype) {
    this._ensureCurrent()
    const r = N.getShaderPrecisionFormat(shadertype, precisiontype)
    return r ? new WebGLShaderPrecisionFormat(r.rangeMin, r.rangeMax, r.precision) : null
  }
  getActiveUniform(program, index) {
    this._ensureCurrent()
    const r = N.getActiveUniform(program ? program._name : 0, index)
    return r ? new WebGLActiveInfo(r.size, r.type, r.name) : null
  }
  getActiveAttrib(program, index) {
    this._ensureCurrent()
    const h = program ? program._hiddenAttr : -1
    const r = N.getActiveAttrib(program ? program._name : 0, h >= 0 && index >= h ? index + 1 : index)
    return r ? new WebGLActiveInfo(r.size, r.type, r.name) : null
  }
  getAttribLocation(program, name) {
    this._ensureCurrent()
    if (name === DRAW_ID_ATTRIB) return -1
    return N.getAttribLocation(program ? program._name : 0, name)
  }
  getTransformFeedbackVarying(program, index) {
    this._ensureCurrent()
    const r = N.getTransformFeedbackVarying(program ? program._name : 0, index)
    return r ? new WebGLActiveInfo(r.size, r.type, r.name) : null
  }
  getAttachedShaders(program) {
    this._ensureCurrent()
    if (!program) return null
    const names = N.getAttachedShaders(program._name)
    const out = []
    for (let i = 0; i < names.length; i++) out.push(this._lookup('shader', names[i]))
    return out
  }
  getShaderInfoLog(shader) { this._ensureCurrent(); return N.getShaderInfoLog(shader ? shader._name : 0) }
  getProgramInfoLog(program) { this._ensureCurrent(); return N.getProgramInfoLog(program ? program._name : 0) }
  getShaderSource(shader) { return shader ? shader._source : null }
  getUniformLocation(program, name) {
    this._ensureCurrent()
    if (!program) return null
    const loc = N.getUniformLocation(program._name, String(name))
    return loc < 0 ? null : new WebGLUniformLocation(loc, program)
  }
  getUniform(program, location) {
    this._ensureCurrent()
    if (!program || !location) return null
    return N.getUniform(program._name, location._loc)
  }
  getUniformIndices(program, names) { this._ensureCurrent(); return program ? N.getUniformIndices(program._name, Array.from(names, String)) : null }
  getActiveUniforms(program, indices, pname) { this._ensureCurrent(); return program ? N.getActiveUniforms(program._name, Array.from(indices), pname) : null }
  getActiveUniformBlockParameter(program, idx, pname) { this._ensureCurrent(); return program ? N.getActiveUniformBlockParameter(program._name, idx, pname) : null }
  getActiveUniformBlockName(program, idx) { this._ensureCurrent(); return program ? N.getActiveUniformBlockName(program._name, idx) : null }
  transformFeedbackVaryings(program, varyings, mode) { this._ensureCurrent(); N.transformFeedbackVaryings(program ? program._name : 0, Array.from(varyings, String), mode) }

  // ---- shaders & programs: the source cache, gl_DrawID and the current program -----------------
  createShader(type) {
    this._ensureCurrent()
    const s = this._create('shader', N.createShader(type >>> 0))
    if (s) s._type = type >>> 0
    return s
  }
  shaderSource(shader, source) {
    this._ensureCurrent()
    if (!shader) return
    const src = String(source)
    let mode = 'uniform'
    if (this._mdi.attrib >= 0 && src.indexOf('gl_DrawID') >= 0) {
      if (!shader._type) shader._type = N.getShaderParameter(shader._name, GL.SHADER_TYPE) >>> 0
      mode = drawIdMode(src, shader._type, true)
    }
    const r = rewriteDrawId(std140Blocks(src), mode)  // uniform blocks as WebGL lays them out (shader-rewrite.js)
    shader._source = src
    shader._translated = r.source
    shader._usesDrawId = r.usesDrawId
    shader._drawIdAttr = r.drawIdAttr
    N.shaderSource(shader._name, r.source)
  }
  attachShader(program, shader) {
    this._ensureCurrent()
    if (program && shader) program._shaders.add(shader)
    N.attachShader(program ? program._name : 0, shader ? shader._name : 0)
  }
  detachShader(program, shader) {
    this._ensureCurrent()
    if (program && shader) program._shaders.delete(shader)
    N.detachShader(program ? program._name : 0, shader ? shader._name : 0)
  }
  linkProgram(program) {
    this._ensureCurrent()
    if (!program) return
    let uniform = false, attr = false
    for (const s of program._shaders) if (s._usesDrawId) { if (s._drawIdAttr) attr = true; else uniform = true }
    if (attr) N.bindAttribLocation(program._name, this._mdi.attrib, DRAW_ID_ATTRIB)
    N.linkProgram(program._name)
    if (attr && !N.getProgramParameter(program._name, GL.LINK_STATUS)) {
      // The hidden attribute costs the program a location: one that needs every location the GPU has (uikit's
      // instanced panel takes 16, all an NVIDIA, llvmpipe or zink context offers; Adreno has 32) cannot link
      // with it, where a browser links it. Its vertex shaders go back to the uniform gl_DrawID (the per-draw
      // loop, as without indirect draws) and it links again; a program that still fails reports that link.
      for (const s of program._shaders) if (s._drawIdAttr) {
        const r = rewriteDrawId(std140Blocks(s._source), 'uniform')
        s._translated = r.source; s._usesDrawId = r.usesDrawId; s._drawIdAttr = false
        N.shaderSource(s._name, r.source); N.compileShader(s._name)
      }
      attr = false; uniform = true
      N.linkProgram(program._name)
    }
    program._drawIdLoc = attr ? DRAW_ID_LOC_ATTRIB : uniform ? N.getUniformLocation(program._name, DRAW_ID_UNIFORM) : -1
    program._hiddenAttr = -1
    if (attr) {
      // Hide the attribute from getActiveAttrib / ACTIVE_ATTRIBUTES (link time only, never per frame).
      const n = N.getProgramParameter(program._name, GL.ACTIVE_ATTRIBUTES) | 0
      for (let i = 0; i < n; i++) { const r = N.getActiveAttrib(program._name, i); if (r && r.name === DRAW_ID_ATTRIB) { program._hiddenAttr = i; break } }
    }
  }
  useProgram(program) {
    this._ensureCurrent()
    this._currentProgram = program || null
    N.useProgram(program ? program._name : 0)
  }

  // ---- vertex arrays: what multidraw.js needs to know about the bound VAO --------------------------
  bindVertexArray(vao) {
    this._ensureCurrent()
    this._vao = vao && vao._name !== 0 ? vao : null
    N.bindVertexArray(vao ? vao._name : 0)
  }
  deleteVertexArray(vao) {
    this._ensureCurrent()
    if (!vao || vao._name === 0) return
    if (this._vao === vao) this._vao = null   // GL reverts the binding to the default VAO
    N.deleteVertexArray(vao._name)
    this._release('vao', vao)
  }
  vertexAttribDivisor(index, divisor) {
    this._ensureCurrent()
    index >>>= 0; divisor >>>= 0
    const v = this._vao
    if (v !== null && index < 32) { if (divisor !== 0) v._divMask |= 1 << index; else v._divMask &= ~(1 << index) }
    N.vertexAttribDivisor(index, divisor)
  }

  // ---- buffers -------------------------------------------------------------------------------
  bufferData(target, data, usage, srcOffset, length) {
    this._ensureCurrent()
    if (Array.isArray(data)) data = new Float32Array(data)
    N.bufferData(target, data, usage, srcOffset, length)
  }
  bufferSubData(target, dstByteOffset, data, srcOffset, length) { this._ensureCurrent(); N.bufferSubData(target, dstByteOffset, data, srcOffset, length) }
  getBufferSubData(target, srcByteOffset, dst, dstOffset, length) { this._ensureCurrent(); N.getBufferSubData(target, srcByteOffset, dst, dstOffset, length) }

  // ---- textures: overload dispatch + pixelStorei emulation ---------------------------------------
  // texImage2D(target, level, internalformat, format, type, source)
  // texImage2D(target, level, internalformat, width, height, border, format, type, source | pixels | pboOffset | null[, srcOffset])
  texImage2D(target, level, internalformat, a3, a4, a5, a6, a7, a8, a9) {
    this._ensureCurrent()
    // 6-argument form: a5 is the source (an object); in the 9/10-argument form a5 is the border (a number)
    if (a6 === undefined && a5 !== null && typeof a5 === 'object') return this._texImage2DSource(target, level, internalformat, 0, 0, 0, a3, a4, a5, true)
    if (isImageSource(a8)) return this._texImage2DSource(target, level, internalformat, a3, a4, a5, a6, a7, a8, false)
    if (a8 === null || a8 === undefined || typeof a8 === 'number') { N.texImage2D(target, level, internalformat, a3, a4, a5, a6, a7, a8 == null ? null : a8, 0); this._noteFormat(target, level, internalformat); return }
    if (!isArrayBufferish(a8)) throw new TypeError('texImage2D: pixels must be an ArrayBufferView, an image source, a PBO offset or null')
    const u = prepareTypedUpload(this._pixel, a8, a9 | 0, a3, a4, a6, a7, this._scratch)
    N.texImage2D(target, level, internalformat, a3, a4, a5, a6, a7, u.data, u.srcOffset)
    this._noteFormat(target, level, internalformat)
  }
  _texImage2DSource(target, level, internalformat, width, height, border, format, type, source, sizeFromSource) {
    if (source.__gl && this._copyFromCanvas(source, target, level, internalformat, 0, 0, sizeFromSource ? source.width | 0 : width | 0, sizeFromSource ? source.height | 0 : height | 0, border | 0, format >>> 0, type >>> 0, true)) return
    const u = prepareImageUpload(this._pixel, source, format, type, this._scratch, (m) => this._warn(m))
    if (!u) throw new TypeError('texImage2D: the image source carries no pixels')
    this._ensureCurrent()  // the source may have been another canvas's WebGL context (troika's SDF atlas): its readback switched the GL to it
    const w = sizeFromSource ? u.width : width, h = sizeFromSource ? u.height : height
    N.texImage2D(target, level, internalformat, w, h, border, u.format, u.type, u.data, 0)
    this._noteFormat(target, level, internalformat)
  }
  // texSubImage2D(target, level, xoffset, yoffset, format, type, source)
  // texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, source | pixels | pboOffset | null[, srcOffset])
  texSubImage2D(target, level, xo, yo, a4, a5, a6, a7, a8, a9) {
    this._ensureCurrent()
    // 7-argument form: a6 is the source (an object); in the 9/10-argument form a6 is the format (a number)
    if (a7 === undefined && a6 !== null && typeof a6 === 'object') return this._texSubImage2DSource(target, level, xo, yo, 0, 0, a4, a5, a6, true)
    if (isImageSource(a8)) return this._texSubImage2DSource(target, level, xo, yo, a4, a5, a6, a7, a8, false)
    if (a8 === null || a8 === undefined || typeof a8 === 'number') return N.texSubImage2D(target, level, xo, yo, a4, a5, a6, a7, a8 == null ? null : a8, 0)
    if (!isArrayBufferish(a8)) throw new TypeError('texSubImage2D: pixels must be an ArrayBufferView, an image source, a PBO offset or null')
    const u = prepareTypedUpload(this._pixel, a8, a9 | 0, a4, a5, a6, a7, this._scratch)
    N.texSubImage2D(target, level, xo, yo, a4, a5, a6, a7, u.data, u.srcOffset)
  }
  _texSubImage2DSource(target, level, xo, yo, width, height, format, type, source, sizeFromSource) {
    if (source.__gl && this._copyFromCanvas(source, target, level, 0, xo, yo, sizeFromSource ? source.width | 0 : width | 0, sizeFromSource ? source.height | 0 : height | 0, 0, format >>> 0, type >>> 0, false)) return
    const u = prepareImageUpload(this._pixel, source, format, type, this._scratch, (m) => this._warn(m))
    if (!u) throw new TypeError('texSubImage2D: the image source carries no pixels')
    this._ensureCurrent()
    const w = sizeFromSource ? u.width : width, h = sizeFromSource ? u.height : height
    N.texSubImage2D(target, level, xo, yo, w, h, u.format, u.type, u.data, 0)
  }
  texStorage2D(target, levels, internalformat, width, height) {
    this._ensureCurrent()
    N.texStorage2D(target >>> 0, levels | 0, internalformat >>> 0, width | 0, height | 0)
    this._noteFormat(target >>> 0, 0, internalformat)
  }
  copyTexImage2D(target, level, internalformat, x, y, width, height, border) {
    this._ensureCurrent()
    const r = this._msaa && this._readBegin()
    N.copyTexImage2D(target >>> 0, level | 0, internalformat >>> 0, x | 0, y | 0, width | 0, height | 0, border | 0)
    if (r) this._readEnd(r)
    this._noteFormat(target >>> 0, level, internalformat)
  }
  // texImage3D(target, level, internalformat, width, height, depth, border, format, type, source | pixels | pboOffset | null[, srcOffset])
  // Flip / premultiply are not applied to 3D uploads (per-slice flipping is undefined for arrays; three never asks).
  texImage3D(target, level, internalformat, w, h, d, border, format, type, pixels, srcOffset) {
    this._ensureCurrent()
    if (isImageSource(pixels)) {
      const u = prepareImageUpload(this._pixel, pixels, format, type, this._scratch, (m) => this._warn(m))
      if (!u) throw new TypeError('texImage3D: the image source carries no pixels')
      this._ensureCurrent()
      return N.texImage3D(target, level, internalformat, w, h, d, border, u.format, u.type, u.data, 0)
    }
    N.texImage3D(target, level, internalformat, w, h, d, border, format, type, pixels == null ? null : pixels, srcOffset | 0)
  }
  texSubImage3D(target, level, xo, yo, zo, w, h, d, format, type, pixels, srcOffset) {
    this._ensureCurrent()
    if (isImageSource(pixels)) {
      const u = prepareImageUpload(this._pixel, pixels, format, type, this._scratch, (m) => this._warn(m))
      if (!u) throw new TypeError('texSubImage3D: the image source carries no pixels')
      return N.texSubImage3D(target, level, xo, yo, zo, w, h, d, u.format, u.type, u.data, 0)
    }
    N.texSubImage3D(target, level, xo, yo, zo, w, h, d, format, type, pixels == null ? null : pixels, srcOffset | 0)
  }
  compressedTexImage2D(target, level, internalformat, w, h, border, data, srcOffset, srcLengthOverride) {
    this._ensureCurrent()
    N.compressedTexImage2D(target, level, internalformat, w, h, border, data, srcOffset | 0, srcLengthOverride | 0)
  }
  compressedTexSubImage2D(target, level, xo, yo, w, h, format, data, srcOffset, srcLengthOverride) {
    this._ensureCurrent()
    N.compressedTexSubImage2D(target, level, xo, yo, w, h, format, data, srcOffset | 0, srcLengthOverride | 0)
  }
  compressedTexImage3D(target, level, internalformat, w, h, d, border, data, srcOffset, srcLengthOverride) {
    this._ensureCurrent()
    N.compressedTexImage3D(target, level, internalformat, w, h, d, border, data, srcOffset | 0, srcLengthOverride | 0)
  }
  compressedTexSubImage3D(target, level, xo, yo, zo, w, h, d, format, data, srcOffset, srcLengthOverride) {
    this._ensureCurrent()
    N.compressedTexSubImage3D(target, level, xo, yo, zo, w, h, d, format, data, srcOffset | 0, srcLengthOverride | 0)
  }
  readPixels(x, y, w, h, format, type, dst, dstOffset) { this._ensureCurrent(); const r = this._msaa && this._readBegin(); N.readPixels(x, y, w, h, format, type, dst, dstOffset | 0); if (r) this._readEnd(r) }
  copyTexSubImage2D(target, level, xo, yo, x, y, w, h) { this._ensureCurrent(); const r = this._msaa && this._readBegin(); N.copyTexSubImage2D(target >>> 0, level | 0, xo | 0, yo | 0, x | 0, y | 0, w | 0, h | 0); if (r) this._readEnd(r) }
  copyTexSubImage3D(target, level, xo, yo, zo, x, y, w, h) { this._ensureCurrent(); const r = this._msaa && this._readBegin(); N.copyTexSubImage3D(target >>> 0, level | 0, xo | 0, yo | 0, zo | 0, x | 0, y | 0, w | 0, h | 0); if (r) this._readEnd(r) }

  // ---- draw buffers / invalidation ---------------------------------------------------------------
  drawBuffers(buffers) { this._ensureCurrent(); N.drawBuffers(buffers) }
  invalidateFramebuffer(target, attachments) { this._ensureCurrent(); N.invalidateFramebuffer(target, attachments) }
  invalidateSubFramebuffer(target, attachments, x, y, w, h) { this._ensureCurrent(); N.invalidateSubFramebuffer(target, attachments, x, y, w, h) }

  // ---- sync objects --------------------------------------------------------------------------------
  fenceSync(condition, flags) { this._ensureCurrent(); return this._create('sync', N.fenceSync(condition, flags)) }
  isSync(sync) { this._ensureCurrent(); return !!sync && sync._name !== 0 && N.isSync(sync._name) }
  deleteSync(sync) { this._ensureCurrent(); if (!sync || sync._name === 0) return; N.deleteSync(sync._name); this._release('sync', sync) }
  // The projection layer's colour texture (__hostOpaqueTexture) is the runtime's swapchain image: an engine that
  // deletes it as the session ends (Babylon disposing its XR render target) leaves it to the runtime.
  deleteTexture(texture) {
    if (texture && texture._opaque) return
    if (texture && this._tex2d) for (let i = 0; i < this._tex2d.length; i++) if (this._tex2d[i] === texture._name) this._tex2d[i] = 0
    return methods.generatedMethods.deleteTexture.call(this, texture)
  }
  clientWaitSync(sync, flags, timeout) { this._ensureCurrent(); return N.clientWaitSync(sync ? sync._name : 0, flags, timeout) }
  waitSync(sync, flags, timeout) { this._ensureCurrent(); N.waitSync(sync ? sync._name : 0, flags, timeout) }
  getSyncParameter(sync, pname) { this._ensureCurrent(); return N.getSyncParameter(sync ? sync._name : 0, pname) }

  // ---- texture-unit anisotropy passes through texParameterf; nothing to do here ----------------------
  get [Symbol.toStringTag]() { return 'WebGL2RenderingContext' }
}

// Enum constants on the prototype (gl.TRIANGLES) and the class (WebGL2RenderingContext.TRIANGLES).
for (const k in GL) {
  Object.defineProperty(WebGL2RenderingContext.prototype, k, { value: GL[k], enumerable: true })
  Object.defineProperty(WebGL2RenderingContext, k, { value: GL[k], enumerable: true })
}
Object.defineProperty(WebGL2RenderingContext.prototype, 'TEXTURE_MAX_ANISOTROPY_EXT', { value: TEXTURE_MAX_ANISOTROPY_EXT, enumerable: false })

// Generated pass-throughs fill in whatever the class does not define itself.
for (const name in generatedMethods) {
  if (!Object.prototype.hasOwnProperty.call(WebGL2RenderingContext.prototype, name))
    Object.defineProperty(WebGL2RenderingContext.prototype, name, { value: generatedMethods[name], writable: true, configurable: true })
}

export { setNative }
