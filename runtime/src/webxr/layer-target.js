// layer-target.js — the framebuffer behind an XRWebGLLayer (the no-layers fallback), in place of IWER's
// XRHostLayerTarget, which index.js swaps out right after IWER's XRWebGLLayer constructor. Same contract
// (framebuffer, width, height, viewports, beginFrame(name), endFrame()); what this one adds:
//
// - antialias (WebGL's default): 4x multisampled, as a browser's XRWebGLLayer is. Through
//   EXT_multisampled_render_to_texture the samples live in tile memory and resolve into the swapchain image as the
//   tiles are stored: no multisampled buffer, no resolve pass. Wonderland Engine draws its text with
//   alpha-to-coverage and takes this framebuffer to be multisampled; one sample cut every glyph into polygons.
// - sRGB: the page writes sRGB-encoded bytes, as into any 8-bit framebuffer. The Quest compositor shows a 2D RGBA8
//   swapchain as linear (washed out: every tone encoded a second time). Where GL can store bytes unconverted
//   (EXT_sRGB_write_control) the layer asked for an sRGB swapchain (index.js, `srgbLayer`); when the host made one,
//   the context turns the conversion on write off while this framebuffer is bound (webgl/context.js).
// - the host's depth texture (vision: it reads the page's depth into the compositor's) as the depth attachment.
// - one view (the Vision Pro simulator): one viewport over the whole image.
import { XRViewport } from 'iwer/lib/host.js'

const GL_DEPTH_COMPONENT24 = 0x81A6
const GL_DEPTH24_STENCIL8 = 0x88F0
const GL_DEPTH_ATTACHMENT = 0x8D00
const GL_DEPTH_STENCIL_ATTACHMENT = 0x821A
const GL_SRGB8_ALPHA8 = 0x8C43
const GL_MAX_SAMPLES = 0x8D57
const GL_COLOR_BUFFER_BIT = 0x4000, GL_DEPTH_BUFFER_BIT = 0x100, GL_STENCIL_BUFFER_BIT = 0x400

export class HostLayerTarget {
  // gl: the page's context; fbo: the framebuffer IWER's constructor made (reused); swap: the host's begin() answer;
  // init: the page's XRWebGLLayerInit; srgb: the layer asked for an sRGB swapchain; invalidate: drop depth at frame
  // end; wrap(name): a swapchain image's GL name → WebGLTexture; clearFrame (host.json xr.clearFrame, off by
  // default): clear colour, depth and stencil before each frame's callbacks, as a browser does. Most engines clear
  // on their own; Wonderland's opaque passes never clear depth and draw nothing without it, so the games that need
  // it ask for it.
  constructor(gl, fbo, swap, init, srgb, invalidate, wrap, clearFrame = false) {
    this.gl = gl
    this.framebuffer = fbo || gl.createFramebuffer()
    this.width = swap.width
    this.height = swap.height
    this.wrap = wrap
    this.swap = swap
    const n = swap.viewCount > 0 ? swap.viewCount : 2
    const half = n > 1 ? (this.width / 2) | 0 : this.width
    this.viewports = [new XRViewport(0, 0, half, this.height), new XRViewport(half, 0, this.width - half, this.height)]
    if (srgb && swap.format === GL_SRGB8_ALPHA8) gl._setSrgbRawFramebuffer(this.framebuffer)
    this.depth = init.depth ?? true
    this.stencil = init.stencil ?? false
    this.samples = 0
    if ((init.antialias ?? true) && gl._n && gl._glExt && gl._glExt.has('GL_EXT_multisampled_render_to_texture') && !(swap.depthTexture > 0))
      this.samples = Math.max(0, Math.min(4, gl.getParameter(GL_MAX_SAMPLES) | 0))
    if (this.samples < 2) this.samples = 0
    this.invalidate = invalidate && typeof gl.invalidateFramebuffer === 'function'
    this.depthAtt = [this.stencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT]  // one array for the layer's life
    this.rb = null  // null: no depth yet; false: the host's depth texture; else our renderbuffer
    this.boundName = -1
    this.clearEach = !!clearFrame
    this.alpha = init.alpha ?? true
    this.clearBits = GL_COLOR_BUFFER_BIT | (this.depth ? GL_DEPTH_BUFFER_BIT : 0) | (this.stencil ? GL_STENCIL_BUFFER_BIT : 0)
  }

  // Before the frame's callbacks: the colour attachment follows the acquired swapchain image (the bound framebuffer
  // is put back so three's binding cache stays truthful), then the clear, when asked for.
  beginFrame(name) {
    if (name !== this.boundName) this.attach(name)
    if (this.clearEach) this.clear()
  }
  attach(name) {
    const gl = this.gl
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    if (this.samples) gl._n.framebufferTexture2DMultisampleEXT(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, name, 0, this.samples)
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.wrap(name), 0)
    if (this.rb === null && this.depth && this.swap.depthTexture > 0 && !this.stencil) {
      this.rb = false
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.wrap(this.swap.depthTexture), 0)
    } else if (this.rb === null && this.depth) {
      this.rb = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rb)
      const fmt = this.stencil ? GL_DEPTH24_STENCIL8 : GL_DEPTH_COMPONENT24
      if (this.samples) gl._n.renderbufferStorageMultisampleEXT(gl.RENDERBUFFER, this.samples, fmt, this.width, this.height)  // the colour's sample count
      else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, this.width, this.height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, this.depthAtt[0], gl.RENDERBUFFER, this.rb)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    this.boundName = name
  }

  // Colour to transparent black (a browser clears an alpha layer so; passthrough stays visible where the page draws
  // nothing), depth 1, stencil 0. The host's clearFrame does it where the context lives: one queued command on the
  // GL thread, no state read back on the JS thread per frame (six synchronous round trips, each a pipeline drain,
  // is what a JS version cost) and no allocation. Without it (a test's fake GL): the page's own calls, the state
  // saved and restored by query.
  clear() {
    const gl = this.gl, N = gl._n
    const alpha = this.alpha ? 0 : 1
    if (N && typeof N.clearFrame === 'function') { N.clearFrame(this.framebuffer._name, this.clearBits, alpha); return }
    if (typeof gl.clear !== 'function') return
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    const scissor = typeof gl.isEnabled === 'function' && gl.isEnabled(gl.SCISSOR_TEST)
    if (scissor) gl.disable(gl.SCISSOR_TEST)
    const cc = gl.getParameter(gl.COLOR_CLEAR_VALUE)
    const cd = gl.getParameter(gl.DEPTH_CLEAR_VALUE)
    const cs = gl.getParameter(gl.STENCIL_CLEAR_VALUE)
    const cm = gl.getParameter(gl.COLOR_WRITEMASK)
    const dm = gl.getParameter(gl.DEPTH_WRITEMASK)
    gl.colorMask(true, true, true, true)
    gl.depthMask(true)
    gl.clearColor(0, 0, 0, alpha)
    gl.clearDepth(1)
    gl.clearStencil(0)
    gl.clear(this.clearBits)
    if (cc && cc.length === 4) gl.clearColor(cc[0], cc[1], cc[2], cc[3])
    if (typeof cd === 'number') gl.clearDepth(cd)
    if (typeof cs === 'number') gl.clearStencil(cs)
    if (cm && cm.length === 4) gl.colorMask(cm[0], cm[1], cm[2], cm[3])
    if (typeof dm === 'boolean') gl.depthMask(dm)
    if (scissor) gl.enable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
  }


  // After the frame's last draw, before native releases the image: depth is never submitted (ignoreDepthValues), so
  // it is dropped instead of a tiler storing it. The host's depth texture is kept: the host reads it after the frame.
  endFrame() {
    if (!this.rb || !this.invalidate) return
    const gl = this.gl
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, this.depthAtt)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
  }
}
