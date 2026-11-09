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

export class HostLayerTarget {
  // gl: the page's context; fbo: the framebuffer IWER's constructor made (reused); swap: the host's begin() answer;
  // init: the page's XRWebGLLayerInit; srgb: the layer asked for an sRGB swapchain; invalidate: drop depth at frame
  // end; wrap(name): a swapchain image's GL name → WebGLTexture.
  constructor(gl, fbo, swap, init, srgb, invalidate, wrap) {
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
  }

  // Before the frame's callbacks: the colour attachment follows the acquired swapchain image. The bound framebuffer
  // is put back so three's binding cache stays truthful.
  beginFrame(name) {
    if (name === this.boundName) return
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
