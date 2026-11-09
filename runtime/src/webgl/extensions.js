// The getExtension table. Each WebGL extension name maps to a GATE (does the
// driver have the GL extension it stands on; "always" for what is core in
// GLES 3.2) and a FACTORY building the extension object once. An absent GL
// extension answers null, so three probes and adapts exactly as in a browser.
import { EXT } from './constants.gen.js'

function withConsts(obj, consts) { if (consts) Object.assign(obj, consts); return obj }

export function buildExtensionTable(ctx) {
  const N = ctx._n
  const has = (e) => ctx._glExt.has(e)
  const es32 = ctx._glVersion >= 3.2
  const T = new Map()
  // Extensions the host withholds although the driver has them (__native.gl.withheld: host.json gl.withholdExtensions,
  // plus what a platform knows to be broken), so pages take their fallback.
  const withheld = new Set(N.withheld ?? [])
  const add = (name, gate, make) => T.set(name, { gate: withheld.has(name) ? () => false : gate, make })

  // --- WebGL1-era extensions, core in WebGL2: offered only to a context asked for as 'webgl', as browsers do ---
  add('ANGLE_instanced_arrays', () => ctx._webgl1, () => ({
    VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE,
    drawArraysInstancedANGLE(mode, first, count, n) { ctx.drawArraysInstanced(mode, first, count, n) },
    drawElementsInstancedANGLE(mode, count, type, offset, n) { ctx.drawElementsInstanced(mode, count, type, offset, n) },
    vertexAttribDivisorANGLE(index, divisor) { ctx.vertexAttribDivisor(index, divisor) },
  }))
  add('OES_vertex_array_object', () => ctx._webgl1, () => ({
    VERTEX_ARRAY_BINDING_OES: 0x85B5,
    createVertexArrayOES() { return ctx.createVertexArray() }, bindVertexArrayOES(v) { ctx.bindVertexArray(v) },
    deleteVertexArrayOES(v) { ctx.deleteVertexArray(v) }, isVertexArrayOES(v) { return ctx.isVertexArray(v) },
  }))
  add('OES_standard_derivatives', () => ctx._webgl1, () => ({ FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8B8B }))
  add('OES_element_index_uint', () => ctx._webgl1, () => ({}))
  add('OES_texture_float', () => ctx._webgl1, () => ({}))
  add('OES_texture_half_float', () => ctx._webgl1, () => ({ HALF_FLOAT_OES: 0x8D61 }))
  add('OES_texture_half_float_linear', () => ctx._webgl1, () => ({}))
  add('WEBGL_depth_texture', () => ctx._webgl1, () => ({ UNSIGNED_INT_24_8_WEBGL: 0x84FA }))
  add('EXT_blend_minmax', () => ctx._webgl1, () => ({ MIN_EXT: 0x8007, MAX_EXT: 0x8008 }))
  add('EXT_frag_depth', () => ctx._webgl1, () => ({}))
  add('EXT_shader_texture_lod', () => ctx._webgl1, () => ({}))
  add('EXT_sRGB', () => ctx._webgl1, () => ({ SRGB_EXT: 0x8C40, SRGB_ALPHA_EXT: 0x8C42, SRGB8_ALPHA8_EXT: 0x8C43, FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING_EXT: 0x8210 }))
  add('WEBGL_draw_buffers', () => ctx._webgl1, () => ({ MAX_DRAW_BUFFERS_WEBGL: 0x8824, MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF, drawBuffersWEBGL(bufs) { ctx.drawBuffers(bufs) } }))

  // --- core in GLES 3.x: always on ---
  add('EXT_color_buffer_float', () => true, () => ({}))
  add('EXT_color_buffer_half_float', () => true, () => withConsts({}, EXT.EXT_color_buffer_half_float))
  add('WEBGL_compressed_texture_etc', () => true, () => withConsts({}, EXT.WEBGL_compressed_texture_etc))
  add('WEBGL_debug_renderer_info', () => true, () => withConsts({}, EXT.WEBGL_debug_renderer_info))
  add('WEBGL_debug_shaders', () => true, () => ({
    getTranslatedShaderSource(shader) { return shader && shader._translated !== undefined ? shader._translated : '' },
  }))
  add('WEBGL_lose_context', () => true, () => ({
    loseContext() { ctx._loseContext() },
    restoreContext() { ctx._restoreContext() },
  }))
  add('WEBGL_multi_draw', () => true, () => {
    // Indirect draws where multidraw.js can (ctx._mdi), else the native per-draw loop with gl_DrawID as the
    // uniform (location >= 0) or the attribute (-2) set per draw. Lists go to the loop as Int32Arrays.
    const i32 = (l) => Array.isArray(l) ? new Int32Array(l) : l
    const md = ctx._mdi
    const loc = () => ctx._currentProgram ? ctx._currentProgram._drawIdLoc : -1
    return {
      multiDrawArraysWEBGL(mode, firsts, firstsOffset, counts, countsOffset, drawcount) {
        const l = loc()
        if (md.enabled && md.arrays(ctx._vao, l, mode, firsts, firstsOffset | 0, counts, countsOffset | 0, null, 0, drawcount | 0)) return
        N.multiDrawArraysWEBGL(mode, i32(firsts), firstsOffset, i32(counts), countsOffset, drawcount, l)
      },
      multiDrawElementsWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, drawcount) {
        const l = loc()
        if (md.enabled && md.elements(ctx._vao, l, mode, counts, countsOffset | 0, type, offsets, offsetsOffset | 0, null, 0, drawcount | 0)) return
        N.multiDrawElementsWEBGL(mode, i32(counts), countsOffset, type, i32(offsets), offsetsOffset, drawcount, l)
      },
      multiDrawArraysInstancedWEBGL(mode, firsts, firstsOffset, counts, countsOffset, instanceCounts, instOffset, drawcount) {
        const l = loc()
        if (md.enabled && md.arrays(ctx._vao, l, mode, firsts, firstsOffset | 0, counts, countsOffset | 0, instanceCounts, instOffset | 0, drawcount | 0)) return
        N.multiDrawArraysInstancedWEBGL(mode, i32(firsts), firstsOffset, i32(counts), countsOffset, i32(instanceCounts), instOffset, drawcount, l)
      },
      multiDrawElementsInstancedWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, instanceCounts, instOffset, drawcount) {
        const l = loc()
        if (md.enabled && md.elements(ctx._vao, l, mode, counts, countsOffset | 0, type, offsets, offsetsOffset | 0, instanceCounts, instOffset | 0, drawcount | 0)) return
        N.multiDrawElementsInstancedWEBGL(mode, i32(counts), countsOffset, type, i32(offsets), offsetsOffset, i32(instanceCounts), instOffset, drawcount, l)
      },
    }
  })

  // --- gated on the driver ---
  add('OES_texture_float_linear', () => has('GL_OES_texture_float_linear'), () => ({}))
  add('EXT_float_blend', () => has('GL_EXT_float_blend'), () => ({}))
  add('EXT_texture_filter_anisotropic', () => has('GL_EXT_texture_filter_anisotropic'), () => withConsts({}, EXT.EXT_texture_filter_anisotropic))
  add('EXT_texture_norm16', () => has('GL_EXT_texture_norm16'), () => withConsts({}, EXT.EXT_texture_norm16))
  add('KHR_parallel_shader_compile', () => has('GL_KHR_parallel_shader_compile'), () => withConsts({}, EXT.KHR_parallel_shader_compile))
  add('WEBGL_clip_cull_distance', () => has('GL_EXT_clip_cull_distance'), () => withConsts({}, EXT.WEBGL_clip_cull_distance))
  add('WEBGL_render_shared_exponent', () => has('GL_QCOM_render_shared_exponent'), () => withConsts({}, EXT.WEBGL_render_shared_exponent))
  add('EXT_clip_control', () => has('GL_EXT_clip_control') && typeof N.clipControlEXT === 'function', () => withConsts({
    clipControlEXT(origin, depth) { N.clipControlEXT(origin, depth) },
  }, EXT.EXT_clip_control))
  add('WEBGL_compressed_texture_astc', () => has('GL_KHR_texture_compression_astc_ldr') || has('GL_KHR_texture_compression_astc_hdr'), () => withConsts({
    getSupportedProfiles() { const p = ['ldr']; if (has('GL_KHR_texture_compression_astc_hdr')) p.push('hdr'); return p },
  }, EXT.WEBGL_compressed_texture_astc))
  add('WEBGL_compressed_texture_s3tc', () => has('GL_EXT_texture_compression_s3tc') || (has('GL_EXT_texture_compression_dxt1') && has('GL_ANGLE_texture_compression_dxt3') && has('GL_ANGLE_texture_compression_dxt5')),
    () => withConsts({}, EXT.WEBGL_compressed_texture_s3tc))
  add('WEBGL_compressed_texture_s3tc_srgb', () => has('GL_EXT_texture_compression_s3tc_srgb'), () => withConsts({}, EXT.WEBGL_compressed_texture_s3tc_srgb))
  add('WEBGL_compressed_texture_pvrtc', () => has('GL_IMG_texture_compression_pvrtc'), () => withConsts({}, EXT.WEBGL_compressed_texture_pvrtc))
  add('EXT_texture_compression_bptc', () => has('GL_EXT_texture_compression_bptc'), () => withConsts({}, EXT.EXT_texture_compression_bptc))
  add('EXT_texture_compression_rgtc', () => has('GL_EXT_texture_compression_rgtc'), () => withConsts({}, EXT.EXT_texture_compression_rgtc))
  add('WEBGL_multisampled_render_to_texture', () => has('GL_EXT_multisampled_render_to_texture') && typeof N.renderbufferStorageMultisampleEXT === 'function', () => withConsts({
    renderbufferStorageMultisampleEXT(target, samples, internalformat, width, height) { N.renderbufferStorageMultisampleEXT(target, samples, internalformat, width, height) },
    framebufferTexture2DMultisampleEXT(target, attachment, textarget, texture, level, samples) {
      N.framebufferTexture2DMultisampleEXT(target, attachment, textarget, texture ? texture._name : 0, level, samples)
    },
  }, EXT.WEBGL_multisampled_render_to_texture))
  add('EXT_disjoint_timer_query_webgl2', () => has('GL_EXT_disjoint_timer_query') && typeof N.queryCounterEXT === 'function', () => withConsts({
    queryCounterEXT(query, target) { N.queryCounterEXT(query ? query._name : 0, target) },
  }, EXT.EXT_disjoint_timer_query_webgl2))

  // OVR_multiview2 and OCULUS_multiview are ONE object (super-three keys its multiview path on OCULUS_multiview).
  let multiview = null
  const multiviewGate = () => (has('GL_OVR_multiview2') || has('GL_OVR_multiview')) && typeof N.framebufferTextureMultiviewOVR === 'function'
  const multiviewMake = () => {
    if (multiview) return multiview
    multiview = withConsts({
      framebufferTextureMultiviewOVR(target, attachment, texture, level, baseViewIndex, numViews) {
        N.framebufferTextureMultiviewOVR(target, attachment, texture ? texture._name : 0, level, baseViewIndex, numViews)
        ctx._noteAttach(texture, { kind: 'mv', target, attachment, level, base: baseViewIndex, n: numViews, fbo: 0 })
      },
    }, EXT.OVR_multiview2)
    if (has('GL_OVR_multiview_multisampled_render_to_texture') && typeof N.framebufferTextureMultisampleMultiviewOVR === 'function') {
      multiview.framebufferTextureMultisampleMultiviewOVR = function (target, attachment, texture, level, samples, baseViewIndex, numViews) {
        N.framebufferTextureMultisampleMultiviewOVR(target, attachment, texture ? texture._name : 0, level, samples, baseViewIndex, numViews)
        ctx._noteAttach(texture, { kind: 'mvms', target, attachment, level, samples, base: baseViewIndex, n: numViews, fbo: 0 })
      }
    }
    return multiview
  }
  add('OVR_multiview2', multiviewGate, multiviewMake)
  add('OCULUS_multiview', multiviewGate, multiviewMake)

  add('OES_draw_buffers_indexed', () => (has('GL_OES_draw_buffers_indexed') || es32) && typeof N.enableiOES === 'function', () => ({
    enableiOES(target, index) { N.enableiOES(target, index) },
    disableiOES(target, index) { N.disableiOES(target, index) },
    blendEquationiOES(buf, mode) { N.blendEquationiOES(buf, mode) },
    blendEquationSeparateiOES(buf, modeRGB, modeAlpha) { N.blendEquationSeparateiOES(buf, modeRGB, modeAlpha) },
    blendFunciOES(buf, src, dst) { N.blendFunciOES(buf, src, dst) },
    blendFuncSeparateiOES(buf, srcRGB, dstRGB, srcAlpha, dstAlpha) { N.blendFuncSeparateiOES(buf, srcRGB, dstRGB, srcAlpha, dstAlpha) },
    colorMaskiOES(buf, r, g, b, a) { N.colorMaskiOES(buf, r, g, b, a) },
  }))
  return T
}

// Browser-style vendor-prefixed aliases three or its loaders may ask for.
export const EXTENSION_ALIASES = new Map([
  ['WEBKIT_WEBGL_compressed_texture_pvrtc', 'WEBGL_compressed_texture_pvrtc'],
  ['MOZ_WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc'],
  ['WEBKIT_WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc'],
  ['MOZ_WEBGL_lose_context', 'WEBGL_lose_context'],
  ['WEBKIT_WEBGL_lose_context', 'WEBGL_lose_context'],
  ['WEBKIT_EXT_texture_filter_anisotropic', 'EXT_texture_filter_anisotropic'],
  ['MOZ_EXT_texture_filter_anisotropic', 'EXT_texture_filter_anisotropic'],
])
