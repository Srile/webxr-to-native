import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { fakeGL, last, count } from './webgl-fake-gl.js'
import { install } from '../src/webgl/index.js'
import { GL } from '../src/webgl/constants.gen.js'

function host(glOpts) {
  const gl = fakeGL(glOpts)
  const g = { __native: fakeNative({ gl }), console: { warn() {} } }
  install(g)
  const canvas = { width: 1280, height: 800, events: [], dispatchEvent(e) { this.events.push(e.type) } }
  const ctx = g.__hostCreateWebGLContext(canvas, { antialias: true, alpha: false })
  return { g, gl, ctx, canvas }
}

test('install defines the classes, the constants and the singleton factory', () => {
  const { g, ctx, canvas } = host()
  assert.equal(typeof g.WebGL2RenderingContext, 'function')
  // WebGL1's name shares WebGL2's constants and prototype, but a 'webgl2' context is not an instance of it (as in a
  // browser: Emscripten checks), a 'webgl' one is
  assert.equal(g.WebGLRenderingContext.FLOAT, g.WebGL2RenderingContext.FLOAT)
  assert.equal(g.WebGLRenderingContext.prototype, g.WebGL2RenderingContext.prototype)
  assert.equal({ _webgl1: false, __proto__: g.WebGL2RenderingContext.prototype } instanceof g.WebGLRenderingContext, false)
  assert.equal({ _webgl1: true, __proto__: g.WebGL2RenderingContext.prototype } instanceof g.WebGLRenderingContext, true)
  assert.ok(ctx instanceof g.WebGL2RenderingContext)
  assert.equal(ctx.canvas, canvas)
  assert.equal(ctx.TRIANGLES, 4)
  assert.equal(g.WebGL2RenderingContext.TEXTURE_2D_ARRAY, 0x8C1A)
  assert.equal(ctx.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, 0x9247)
  assert.ok(Object.keys(GL).length >= 550)
  assert.equal(ctx.drawingBufferWidth, 1280)
  assert.equal(ctx.drawingBufferHeight, 800)
  assert.equal(g.__hostCreateWebGLContext(canvas, {}), ctx, 'the same canvas gets the same context')
  assert.equal(g.__hostGL(), ctx)
  const a = ctx.getContextAttributes()
  assert.equal(a.alpha, false); assert.equal(a.antialias, true, 'antialias reads back as asked: three sizes its XR render target samples from it'); assert.equal(a.xrCompatible, true)
  assert.equal(ctx.isContextLost(), false)
  return ctx.makeXRCompatible()
})

test('objects wrap GL names; identity, null → 0 and deletion', () => {
  const { g, gl, ctx } = host()
  const b = ctx.createBuffer()
  assert.ok(b instanceof g.WebGLBuffer)
  assert.equal(b._name, 1)
  ctx.bindBuffer(ctx.ARRAY_BUFFER, b)
  assert.deepEqual(last(gl, 'bindBuffer'), ['bindBuffer', GL.ARRAY_BUFFER, 1])
  ctx.bindBuffer(ctx.ARRAY_BUFFER, null)
  assert.deepEqual(last(gl, 'bindBuffer'), ['bindBuffer', GL.ARRAY_BUFFER, 0])
  gl.getParameter = (p) => (p === GL.ARRAY_BUFFER_BINDING ? 1 : 0)
  assert.equal(ctx.getParameter(ctx.ARRAY_BUFFER_BINDING), b, 'the binding query hands back the same wrapper')
  assert.equal(ctx.getParameter(ctx.TEXTURE_BINDING_2D), null, 'name 0 is null')
  gl.getParameter = (p) => (p === GL.CURRENT_PROGRAM ? 77 : 0)
  const p = ctx.getParameter(ctx.CURRENT_PROGRAM)
  assert.ok(p instanceof g.WebGLProgram); assert.equal(p._name, 77)
  assert.equal(ctx.getParameter(ctx.CURRENT_PROGRAM), p, 'an unknown name gets one wrapper, kept')
  ctx.deleteBuffer(b)
  assert.deepEqual(last(gl, 'deleteBuffer'), ['deleteBuffer', 1])
  assert.equal(b._name, 0)
  const n = gl.calls.length
  ctx.deleteBuffer(b); ctx.deleteBuffer(null)
  assert.equal(gl.calls.length, n, 'a second delete or null is a no-op')
  assert.equal(ctx.isBuffer(b), false)
  const sh = ctx.createShader(ctx.VERTEX_SHADER)
  assert.ok(sh instanceof g.WebGLShader)
  ctx.deleteShader(sh)
  assert.deepEqual(last(gl, 'deleteShader'), ['deleteShader', sh._name === 0 ? 2 : sh._name])
})

test('uniform locations: -1 is null, a null location is a silent no-op, arrays become typed arrays', () => {
  const { g, gl, ctx } = host({ answers: { uniformLocations: { uColor: 3 } } })
  const prog = ctx.createProgram()
  assert.equal(ctx.getUniformLocation(prog, 'missing'), null)
  const loc = ctx.getUniformLocation(prog, 'uColor')
  assert.ok(loc instanceof g.WebGLUniformLocation); assert.equal(loc._loc, 3)
  const n = gl.calls.length
  ctx.uniform1f(null, 1); ctx.uniform4fv(null, [1, 2, 3, 4]); ctx.uniformMatrix4fv(null, false, new Float32Array(16))
  assert.equal(gl.calls.length, n, 'null location calls nothing')
  ctx.uniform4fv(loc, [1, 2, 3, 4])
  const c = last(gl, 'uniform4fv')
  // a plain Array goes down as a reused scratch typed array windowed by (srcOffset 0, srcLength count)
  assert.equal(c[1], 3); assert.ok(c[2] instanceof Float32Array); assert.equal(c[3], 0); assert.equal(c[4], 4); assert.deepEqual(Array.from(c[2].subarray(0, 4)), [1, 2, 3, 4])
  ctx.uniform3fv(loc, [5, 6, 7, 8, 9, 10], 3)
  const c2 = last(gl, 'uniform3fv')
  assert.equal(c2[2], c[2], 'the same scratch array, no allocation per call'); assert.equal(c2[3], 0); assert.equal(c2[4], 3); assert.deepEqual(Array.from(c2[2].subarray(0, 3)), [8, 9, 10])
  const m = new Float32Array(64)
  ctx.uniformMatrix4fv(loc, false, m, 16, 32)
  assert.deepEqual(last(gl, 'uniformMatrix4fv'), ['uniformMatrix4fv', 3, false, m, 16, 32])
  ctx.uniform1iv(loc, [1, 2])
  assert.ok(last(gl, 'uniform1iv')[2] instanceof Int32Array)
  ctx.uniform2uiv(loc, [1, 2])
  assert.ok(last(gl, 'uniform2uiv')[2] instanceof Uint32Array)
  ctx.vertexAttrib4fv(1, [0, 0, 0, 1])
  assert.ok(last(gl, 'vertexAttrib4fv')[2] instanceof Float32Array)
  ctx.clearBufferfv(ctx.COLOR, 0, [0, 0, 0, 1])
  assert.ok(last(gl, 'clearBufferfv')[3] instanceof Float32Array)
})

test('getParameter: the WebGL-only enums are answered here, the rest pass through', () => {
  const { gl, ctx } = host({ answers: { params: { [GL.MAX_TEXTURE_SIZE]: 16384 } } })
  assert.equal(ctx.getParameter(ctx.VERSION), 'WebGL 2.0 (webxr-host)')
  assert.equal(ctx.getParameter(ctx.SHADING_LANGUAGE_VERSION), 'WebGL GLSL ES 3.00 (webxr-host)')
  assert.equal(ctx.getParameter(ctx.MAX_CLIENT_WAIT_TIMEOUT_WEBGL), 0)
  assert.equal(ctx.getParameter(ctx.UNPACK_FLIP_Y_WEBGL), false)
  const before = count(gl, 'pixelStorei')
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, 1)
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  ctx.pixelStorei(ctx.UNPACK_COLORSPACE_CONVERSION_WEBGL, ctx.NONE)
  assert.equal(count(gl, 'pixelStorei'), before, 'WebGL-only pixelStorei never reaches GL')
  assert.equal(ctx.getParameter(ctx.UNPACK_FLIP_Y_WEBGL), true)
  assert.equal(ctx.getParameter(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL), true)
  assert.equal(ctx.getParameter(ctx.UNPACK_COLORSPACE_CONVERSION_WEBGL), GL.NONE)
  ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 1)
  assert.deepEqual(last(gl, 'pixelStorei'), ['pixelStorei', GL.UNPACK_ALIGNMENT, 1])
  assert.equal(ctx.getParameter(ctx.MAX_TEXTURE_SIZE), 16384)
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
  assert.equal(ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL), 'FakeVendor')
  assert.equal(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL), 'FakeRenderer')
  assert.equal(ctx.getParameter(ctx.VENDOR), 0, 'VENDOR passes through to the native getParameter')
})

test('typed getters: booleans, WebGLActiveInfo, precision format, attached shaders, attachment objects', () => {
  const { g, gl, ctx } = host({ answers: { programParams: { [GL.LINK_STATUS]: 1, [GL.ACTIVE_UNIFORMS]: 3 }, shaderParams: { [GL.COMPILE_STATUS]: 0, [GL.SHADER_TYPE]: GL.VERTEX_SHADER } } })
  const p = ctx.createProgram(), s = ctx.createShader(ctx.VERTEX_SHADER)
  assert.equal(ctx.getProgramParameter(p, ctx.LINK_STATUS), true)
  assert.equal(ctx.getProgramParameter(p, ctx.ACTIVE_UNIFORMS), 3)
  assert.equal(ctx.getProgramParameter(p, 0x91B1), false, 'COMPLETION_STATUS_KHR is a boolean')
  assert.equal(ctx.getShaderParameter(s, ctx.COMPILE_STATUS), false)
  assert.equal(ctx.getShaderParameter(s, ctx.SHADER_TYPE), GL.VERTEX_SHADER)
  const pf = ctx.getShaderPrecisionFormat(ctx.FRAGMENT_SHADER, ctx.HIGH_FLOAT)
  assert.ok(pf instanceof g.WebGLShaderPrecisionFormat); assert.equal(pf.precision, 23)
  const u = ctx.getActiveUniform(p, 0)
  assert.ok(u instanceof g.WebGLActiveInfo); assert.equal(u.name, 'modelViewMatrix'); assert.equal(u.type, GL.FLOAT_MAT4)
  assert.equal(ctx.getActiveUniform(p, 5), null)
  assert.equal(ctx.getActiveAttrib(p, 0).name, 'position')
  const sh = ctx.getAttachedShaders(p)
  assert.equal(sh.length, 2); assert.ok(sh[0] instanceof g.WebGLShader); assert.equal(sh[1]._name, 8)
  const att = ctx.getFramebufferAttachmentParameter(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)
  assert.ok(att instanceof g.WebGLTexture); assert.equal(att._name, 42)
  assert.equal(ctx.getQueryParameter(ctx.createQuery(), ctx.QUERY_RESULT_AVAILABLE), true)
  assert.equal(ctx.getQueryParameter(ctx.createQuery(), ctx.QUERY_RESULT), 1234)
  assert.equal(ctx.getTexParameter(ctx.TEXTURE_2D, ctx.TEXTURE_IMMUTABLE_FORMAT), true)
  assert.equal(ctx.getVertexAttrib(0, ctx.VERTEX_ATTRIB_ARRAY_ENABLED), true)
  assert.ok(ctx.getVertexAttrib(0, ctx.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) instanceof g.WebGLBuffer)
  assert.ok(ctx.getIndexedParameter(ctx.UNIFORM_BUFFER_BINDING, 0) instanceof g.WebGLBuffer)
  assert.equal(ctx.getIndexedParameter(ctx.UNIFORM_BUFFER_SIZE, 0), 9)
  ctx.getShaderInfoLog(s)
  assert.deepEqual(last(gl, 'getShaderInfoLog'), ['getShaderInfoLog', s._name])
})

test('getExtension reports only what the driver has, with the OVR/OCULUS multiview object shared', () => {
  const { ctx } = host()
  const mv = ctx.getExtension('OVR_multiview2')
  assert.ok(mv); assert.equal(ctx.getExtension('OCULUS_multiview'), mv)
  assert.equal(mv.MAX_VIEWS_OVR, 0x9631)
  assert.equal(mv.FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR, 0x9630)
  assert.equal(mv.FRAMEBUFFER_ATTACHMENT_TEXTURE_BASE_VIEW_INDEX_OVR, 0x9632)
  assert.equal(mv.FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR, 0x9633)
  assert.equal(typeof mv.framebufferTextureMultiviewOVR, 'function')
  assert.equal(typeof mv.framebufferTextureMultisampleMultiviewOVR, 'function')
  const tex = ctx.createTexture()
  mv.framebufferTextureMultisampleMultiviewOVR(ctx.DRAW_FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, tex, 0, 4, 0, 2)
  assert.deepEqual(last(ctx._n, 'framebufferTextureMultisampleMultiviewOVR'), ['framebufferTextureMultisampleMultiviewOVR', GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, tex._name, 0, 4, 0, 2])
  assert.equal(ctx.getExtension('KHR_parallel_shader_compile').COMPLETION_STATUS_KHR, 0x91B1)
  assert.deepEqual(ctx.getExtension('WEBGL_compressed_texture_astc').getSupportedProfiles(), ['ldr'])
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_astc').COMPRESSED_RGBA_ASTC_4x4_KHR, 0x93B0)
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_etc').COMPRESSED_RGBA8_ETC2_EAC, 0x9278)
  assert.ok(ctx.getExtension('EXT_color_buffer_float'))
  assert.ok(ctx.getExtension('EXT_color_buffer_half_float'))
  assert.ok(ctx.getExtension('OES_texture_float_linear'))
  assert.ok(ctx.getExtension('EXT_texture_filter_anisotropic'))
  assert.ok(ctx.getExtension('WEBGL_multisampled_render_to_texture'))
  assert.ok(ctx.getExtension('EXT_disjoint_timer_query_webgl2'))
  assert.ok(ctx.getExtension('EXT_clip_control'))
  assert.ok(ctx.getExtension('WEBGL_multi_draw'))
  assert.ok(ctx.getExtension('WEBGL_lose_context'))
  assert.ok(ctx.getExtension('WEBGL_debug_shaders'))
  assert.ok(ctx.getExtension('OES_draw_buffers_indexed'), 'core in ES 3.2')
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_s3tc'), null)
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_s3tc_srgb'), null)
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_pvrtc'), null)
  assert.equal(ctx.getExtension('EXT_texture_compression_bptc'), null)
  assert.equal(ctx.getExtension('EXT_texture_compression_rgtc'), null)
  assert.equal(ctx.getExtension('WEBGL_clip_cull_distance'), null)
  assert.equal(ctx.getExtension('WEBGL_render_shared_exponent'), null)
  assert.equal(ctx.getExtension('EXT_texture_norm16'), null)
  assert.equal(ctx.getExtension('OES_standard_derivatives'), null, 'WebGL1-only names are null on a WebGL2 context')
  assert.equal(ctx.getExtension('WEBGL_multi_draw'), ctx.getExtension('WEBGL_multi_draw'), 'one object per name')
  const sup = ctx.getSupportedExtensions()
  assert.ok(sup.includes('OVR_multiview2') && sup.includes('OCULUS_multiview') && sup.includes('WEBGL_multi_draw'))
  assert.ok(!sup.includes('WEBGL_compressed_texture_s3tc'))
})

test('a bare driver: multiview gone, msaa-multiview gone, draw-buffers-indexed off on ES 3.1', () => {
  const { ctx } = host({ extensions: 'GL_OVR_multiview2 GL_EXT_texture_compression_s3tc', version: 'OpenGL ES 3.1', omit: ['framebufferTextureMultisampleMultiviewOVR', 'enableiOES'] })
  const mv = ctx.getExtension('OCULUS_multiview')
  assert.ok(mv)
  assert.equal(mv.framebufferTextureMultisampleMultiviewOVR, undefined, 'only with GL_OVR_multiview_multisampled_render_to_texture')
  assert.equal(ctx.getExtension('OES_draw_buffers_indexed'), null)
  assert.equal(ctx.getExtension('EXT_texture_filter_anisotropic'), null)
  assert.ok(ctx.getExtension('WEBGL_compressed_texture_s3tc'))
  assert.equal(ctx.getExtension('WEBGL_compressed_texture_s3tc').COMPRESSED_RGBA_S3TC_DXT5_EXT, 0x83F3)
  assert.equal(ctx.getExtension('KHR_parallel_shader_compile'), null)
})

test('shaderSource rewrites gl_DrawID into a uniform, keeps the original for getShaderSource, links the location, and multi-draw carries it', () => {
  const { gl, ctx } = host({ answers: { uniformLocations: { webgl_gl_DrawID: 12 } } })
  const vs = ctx.createShader(ctx.VERTEX_SHADER), fs = ctx.createShader(ctx.FRAGMENT_SHADER)
  const src = '#version 300 es\n#extension GL_ANGLE_multi_draw : require\n#define X 1\nprecision highp float;\nin vec3 position;\nuniform mat4 m[32];\nvoid main() { gl_Position = m[gl_DrawID] * vec4(position, 1.0); int gl_DrawIDx = 0; }\n'
  ctx.shaderSource(vs, src)
  const sent = last(gl, 'shaderSource')[2]
  assert.ok(!/#extension GL_ANGLE_multi_draw/.test(sent) && /#define webgl_ANGLE_multi_draw 1/.test(sent), 'the ANGLE extension line becomes the macro')
  assert.ok(!/\bgl_DrawID\b/.test(sent))
  assert.ok(/m\[webgl_gl_DrawID\]/.test(sent))
  assert.ok(/gl_DrawIDx/.test(sent), 'only whole identifiers are replaced')
  const lines = sent.split('\n')
  assert.equal(lines[0], '#version 300 es')
  assert.equal(lines[1], 'uniform highp int webgl_gl_DrawID;', 'declared right after the directives')
  assert.equal(lines[2], '#define webgl_ANGLE_multi_draw 1', 'the extension line became the macro ANGLE defines')
  assert.equal(lines[3], '#define X 1')
  assert.equal(ctx.getShaderSource(vs), src, 'the original is what getShaderSource returns')
  assert.equal(ctx.getExtension('WEBGL_debug_shaders').getTranslatedShaderSource(vs), sent)
  const plain = '#version 300 es\nprecision mediump float;\nout vec4 c; void main() { c = vec4(1.0); }\n'
  ctx.shaderSource(fs, plain)
  assert.equal(last(gl, 'shaderSource')[2], plain, 'a shader without gl_DrawID passes through unchanged')

  const p = ctx.createProgram()
  ctx.attachShader(p, vs); ctx.attachShader(p, fs)
  ctx.linkProgram(p)
  assert.deepEqual(last(gl, 'getUniformLocation'), ['getUniformLocation', p._name, 'webgl_gl_DrawID'])
  assert.equal(p._drawIdLoc, 12)
  ctx.useProgram(p)
  const md = ctx.getExtension('WEBGL_multi_draw')
  const firsts = new Int32Array([0, 10, 20]), counts = new Int32Array([3, 0, 6])
  md.multiDrawArraysWEBGL(ctx.TRIANGLES, firsts, 0, counts, 0, 3)
  assert.deepEqual(last(gl, 'multiDrawArraysWEBGL'), ['multiDrawArraysWEBGL', GL.TRIANGLES, firsts, 0, counts, 0, 3, 12])
  md.multiDrawElementsInstancedWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, [2], 0, 1)
  const c = last(gl, 'multiDrawElementsInstancedWEBGL')
  assert.ok(c[2] instanceof Int32Array && c[5] instanceof Int32Array && c[7] instanceof Int32Array)
  assert.equal(c[9], 1); assert.equal(c[10], 12)

  const p2 = ctx.createProgram()
  ctx.attachShader(p2, fs)
  const n = count(gl, 'getUniformLocation')
  ctx.linkProgram(p2)
  assert.equal(count(gl, 'getUniformLocation'), n, 'no drawId shader → no location query')
  ctx.useProgram(p2)
  md.multiDrawArraysWEBGL(ctx.TRIANGLES, firsts, 0, counts, 0, 3)
  assert.equal(last(gl, 'multiDrawArraysWEBGL')[7], -1)
  ctx.detachShader(p, vs)
  ctx.linkProgram(p)
  assert.equal(p._drawIdLoc, -1)
})

test('sync objects wrap the native handle', () => {
  const { g, gl, ctx } = host()
  const s = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0)
  assert.ok(s instanceof g.WebGLSync); assert.equal(s._name, 3)
  assert.equal(ctx.clientWaitSync(s, 0, 0), 0x911A)
  assert.deepEqual(last(gl, 'clientWaitSync'), ['clientWaitSync', 3, 0, 0])
  assert.equal(ctx.isSync(s), true)
  ctx.deleteSync(s)
  assert.deepEqual(last(gl, 'deleteSync'), ['deleteSync', 3])
  assert.equal(ctx.isSync(s), false)
  const { ctx: c2 } = host({ syncHandle: 0 })
  assert.equal(c2.fenceSync(c2.SYNC_GPU_COMMANDS_COMPLETE, 0), null)
})

test('buffers and compressed uploads pass straight through; PBO offsets stay numbers', () => {
  const { gl, ctx } = host()
  const data = new Float32Array(12)
  ctx.bufferData(ctx.ARRAY_BUFFER, data, ctx.STATIC_DRAW)
  assert.deepEqual(last(gl, 'bufferData'), ['bufferData', GL.ARRAY_BUFFER, data, GL.STATIC_DRAW, undefined, undefined])
  ctx.bufferData(ctx.ARRAY_BUFFER, 1024, ctx.DYNAMIC_DRAW)
  assert.equal(last(gl, 'bufferData')[2], 1024)
  ctx.bufferData(ctx.ARRAY_BUFFER, data, ctx.STATIC_DRAW, 4, 8)
  assert.deepEqual(last(gl, 'bufferData').slice(4), [4, 8])
  ctx.bufferSubData(ctx.ARRAY_BUFFER, 16, data, 2)
  assert.deepEqual(last(gl, 'bufferSubData'), ['bufferSubData', GL.ARRAY_BUFFER, 16, data, 2, undefined])
  const blob = new Uint8Array(64)
  ctx.compressedTexImage2D(ctx.TEXTURE_2D, 0, 0x93B0, 8, 8, 0, blob, 16, 32)
  assert.deepEqual(last(gl, 'compressedTexImage2D'), ['compressedTexImage2D', GL.TEXTURE_2D, 0, 0x93B0, 8, 8, 0, blob, 16, 32])
  ctx.compressedTexImage2D(ctx.TEXTURE_2D, 0, 0x93B0, 8, 8, 0, 64, 128)
  assert.deepEqual(last(gl, 'compressedTexImage2D').slice(7), [64, 128, 0])
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA8, 4, 4, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, 256)
  assert.deepEqual(last(gl, 'texImage2D'), ['texImage2D', GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, 256, 0])
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA8, 4, 4, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, null)
  assert.equal(last(gl, 'texImage2D')[9], null)
  ctx.texStorage3D(ctx.TEXTURE_2D_ARRAY, 1, ctx.SRGB8_ALPHA8, 1024, 1024, 2)
  assert.deepEqual(last(gl, 'texStorage3D'), ['texStorage3D', GL.TEXTURE_2D_ARRAY, 1, GL.SRGB8_ALPHA8, 1024, 1024, 2])
  const out = new Uint8Array(16)
  ctx.readPixels(0, 0, 2, 2, ctx.RGBA, ctx.UNSIGNED_BYTE, out)
  assert.deepEqual(last(gl, 'readPixels'), ['readPixels', 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, out, 0])
  ctx.drawBuffers([ctx.COLOR_ATTACHMENT0, ctx.NONE])
  assert.deepEqual(last(gl, 'drawBuffers'), ['drawBuffers', [GL.COLOR_ATTACHMENT0, GL.NONE]])
  ctx.drawElements(ctx.TRIANGLES, 36, ctx.UNSIGNED_SHORT, 72)
  assert.deepEqual(last(gl, 'drawElements'), ['drawElements', GL.TRIANGLES, 36, GL.UNSIGNED_SHORT, 72])
  const tex = ctx.createTexture()
  ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, tex, 0)
  assert.deepEqual(last(gl, 'framebufferTexture2D'), ['framebufferTexture2D', GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, tex._name, 0])
  assert.throws(() => ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA8, 4, 4, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, 'nope'), TypeError)
})

test('WEBGL_lose_context: flag, the one CONTEXT_LOST_WEBGL error, canvas events', () => {
  const { gl, ctx, canvas } = host()
  const lc = ctx.getExtension('WEBGL_lose_context')
  assert.equal(ctx.getError(), 0)
  lc.loseContext()
  assert.equal(ctx.isContextLost(), true)
  assert.deepEqual(canvas.events, ['webglcontextlost'])
  assert.equal(ctx.getError(), GL.CONTEXT_LOST_WEBGL)
  const n = count(gl, 'getError')
  assert.equal(ctx.getError(), GL.NO_ERROR)
  assert.equal(count(gl, 'getError'), n, 'no GL query while lost')
  lc.restoreContext()
  assert.equal(ctx.isContextLost(), false)
  assert.deepEqual(canvas.events, ['webglcontextlost', 'webglcontextrestored'])
})

test('__hostWrapTexture hands WebXR a real WebGLTexture for a swapchain name', () => {
  const { g, gl, ctx } = host()
  const t = g.__hostWrapTexture(900)
  assert.ok(t instanceof g.WebGLTexture); assert.equal(t._name, 900)
  assert.equal(g.__hostWrapTexture(900), t)
  ctx.framebufferTextureLayer(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, t, 0, 0)
  assert.deepEqual(last(gl, 'framebufferTextureLayer'), ['framebufferTextureLayer', GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, 900, 0, 0])
  gl.getParameter = (p) => (p === GL.TEXTURE_BINDING_2D_ARRAY ? 900 : 0)
  assert.equal(ctx.getParameter(ctx.TEXTURE_BINDING_2D_ARRAY), t)
})

test('uniform locations are read once per link when the host batches them', () => {
  const { g, gl, ctx } = host({ batchUniforms: true, answers: { uniformLocations: { uColor: 3, 'uBones[0]': 5, uBones: 5, 'uBones[1]': 6, uBlockMember: -1 } } })
  const prog = ctx.createProgram()
  ctx.linkProgram(prog)
  const a = ctx.getUniformLocation(prog, 'uColor')
  assert.ok(a instanceof g.WebGLUniformLocation); assert.equal(a._loc, 3)
  assert.equal(ctx.getUniformLocation(prog, 'uBones')._loc, 5)
  assert.equal(ctx.getUniformLocation(prog, 'uBones[1]')._loc, 6)
  assert.equal(ctx.getUniformLocation(prog, 'missing'), null, 'a name GL does not list is null')
  assert.equal(ctx.getUniformLocation(prog, 'uBlockMember'), null, 'a block member has no location')
  assert.equal(count(gl, 'getUniformLocations'), 1, 'one batch read for every name')
  assert.equal(count(gl, 'getUniformLocation'), 0, 'no per-name round trips')
  ctx.linkProgram(prog)
  ctx.getUniformLocation(prog, 'uColor')
  assert.equal(count(gl, 'getUniformLocations'), 2, 'a new link reads them again')
  assert.equal(ctx.getUniformLocation(null, 'uColor'), null)
})

test('object names come from a per-context pool, one round trip per batch', () => {
  const { g, gl, ctx } = host({ namePools: true })
  const buffers = Array.from({ length: 70 }, () => ctx.createBuffer())
  assert.ok(buffers.every(b => b instanceof g.WebGLBuffer && b._name > 0))
  assert.equal(new Set(buffers.map(b => b._name)).size, 70, 'every name is fresh')
  assert.equal(count(gl, 'genNames'), 2, '70 buffers: two batches of 64')
  assert.equal(count(gl, 'createBuffer'), 0, 'no per-object round trips')
  const t = ctx.createTexture(), v = ctx.createVertexArray(), f = ctx.createFramebuffer(), r = ctx.createRenderbuffer()
  assert.ok(t instanceof g.WebGLTexture && v instanceof g.WebGLVertexArrayObject && f instanceof g.WebGLFramebuffer && r instanceof g.WebGLRenderbuffer)
  assert.deepEqual(gl.calls.filter(c => c[0] === 'genNames').map(c => c[1]), ['buffer', 'buffer', 'texture', 'vao', 'framebuffer', 'renderbuffer'])
  const name = buffers[3]._name
  ctx.deleteBuffer(buffers[3])
  assert.deepEqual(last(gl, 'deleteBuffer'), ['deleteBuffer', name], 'a pooled name is deleted as any other')
})

test('without the native batch, create* asks for each name', () => {
  const { gl, ctx } = host()
  ctx.createBuffer(); ctx.createTexture()
  assert.equal(count(gl, 'createBuffer'), 1); assert.equal(count(gl, 'createTexture'), 1)
})

test('every three r181 entry point exists on the context', () => {
  const { ctx } = host()
  const needed = ('activeTexture attachShader bindAttribLocation bindBuffer bindBufferBase bindFramebuffer bindRenderbuffer bindTexture bindVertexArray blendColor blendEquation ' +
    'blendEquationSeparate blendFunc blendFuncSeparate blitFramebuffer bufferData bufferSubData clear clearBufferiv clearBufferuiv clearColor clearDepth clearStencil colorMask ' +
    'compileShader compressedTexImage2D compressedTexImage3D compressedTexSubImage2D compressedTexSubImage3D copyTexSubImage2D copyTexSubImage3D createBuffer createFramebuffer ' +
    'createProgram createRenderbuffer createShader createTexture createVertexArray cullFace deleteBuffer deleteFramebuffer deleteProgram deleteRenderbuffer deleteShader deleteSync ' +
    'deleteTexture deleteVertexArray depthFunc depthMask detachShader disable disableVertexAttribArray drawArrays drawArraysInstanced drawBuffers drawElements drawElementsInstanced ' +
    'enable enableVertexAttribArray fenceSync finish flush framebufferRenderbuffer framebufferTexture2D framebufferTextureLayer frontFace generateMipmap getActiveAttrib ' +
    'getActiveUniform getAttribLocation getBufferSubData getContextAttributes getError getExtension getParameter getProgramInfoLog getProgramParameter getShaderInfoLog ' +
    'getShaderParameter getShaderPrecisionFormat getShaderSource getUniformBlockIndex getUniformLocation invalidateFramebuffer lineWidth linkProgram makeXRCompatible pixelStorei ' +
    'polygonOffset readBuffer readPixels renderbufferStorage renderbufferStorageMultisample scissor shaderSource stencilFunc stencilMask stencilOp texImage2D texImage3D ' +
    'texParameterf texParameteri texStorage2D texStorage3D texSubImage2D texSubImage3D uniform1f uniform1fv uniform1i uniform1iv uniform1ui uniform1uiv uniform2f uniform2fv ' +
    'uniform2i uniform2iv uniform2ui uniform2uiv uniform3f uniform3fv uniform3i uniform3iv uniform3ui uniform3uiv uniform4f uniform4fv uniform4i uniform4iv uniform4ui uniform4uiv ' +
    'uniformBlockBinding uniformMatrix2fv uniformMatrix3fv uniformMatrix4fv useProgram vertexAttrib1fv vertexAttrib2fv vertexAttrib3fv vertexAttrib4fv vertexAttribDivisor ' +
    'vertexAttribIPointer vertexAttribPointer viewport getSupportedExtensions isContextLost clientWaitSync getSyncParameter beginQuery endQuery createQuery getQueryParameter ' +
    'createSampler bindSampler samplerParameteri getIndexedParameter getInternalformatParameter getUniform getActiveUniforms getUniformIndices getActiveUniformBlockParameter ' +
    'getActiveUniformBlockName transformFeedbackVaryings getTransformFeedbackVarying getVertexAttrib getVertexAttribOffset getTexParameter getSamplerParameter ' +
    'getFramebufferAttachmentParameter getRenderbufferParameter getBufferParameter getAttachedShaders invalidateSubFramebuffer waitSync isSync').split(' ')
  const missing = needed.filter(n => typeof ctx[n] !== 'function')
  assert.deepEqual(missing, [])
})

test('a second canvas gets a SECONDARY context: its own FBO as the default framebuffer, state switched by snapshot', () => {
  const { g, gl, ctx } = host()
  const canvas2 = { width: 64, height: 32 }
  const sec = g.__hostCreateWebGLContext(canvas2, { premultipliedAlpha: false, preserveDrawingBuffer: true }, 'webgl')
  assert.ok(sec instanceof g.WebGL2RenderingContext); assert.notEqual(sec, ctx); assert.equal(g.__hostGL(), ctx, 'the primary stays the host GL')
  assert.equal(sec.canvas, canvas2); assert.equal(sec.drawingBufferWidth, 64)
  // Creating it switched the GL to it (snapshot of the primary: isEnabled queries) and built the FBO.
  assert.ok(gl.calls.some(c => c[0] === 'isEnabled'), 'the primary state was snapshotted')
  const fboName = sec._fbo._name
  assert.ok(gl.calls.some(c => c[0] === 'framebufferTexture2D' && c[4] === sec._fboTex._name), 'colour attachment on the drawing-buffer texture')
  gl.calls.length = 0
  sec.bindFramebuffer(sec.FRAMEBUFFER, null)
  assert.deepEqual(gl.calls.at(-1), ['bindFramebuffer', sec.FRAMEBUFFER, fboName], 'null binds the secondary drawing buffer, not FBO 0')
  assert.equal(sec.getParameter(sec.FRAMEBUFFER_BINDING), null, 'and it reads back as the default framebuffer')
  // WebGL1 names exist on a 'webgl' context only.
  assert.ok(sec.getExtension('ANGLE_instanced_arrays')); assert.ok(sec.getExtension('OES_vertex_array_object'))
  assert.equal(ctx.getExtension('ANGLE_instanced_arrays'), null)
  // A primary call after secondary ones: snapshot the secondary, restore the primary (its framebuffer is FBO 0 again).
  sec.flush(); gl.calls.length = 0
  ctx.viewport(0, 0, 10, 10)
  const restoreBind = gl.calls.find(c => c[0] === 'bindFramebuffer' && c[1] === 0x8CA9)
  assert.ok(restoreBind && restoreBind[2] === 0, 'the primary draw framebuffer (0) was restored')
  assert.deepEqual(gl.calls.at(-1), ['viewport', 0, 0, 10, 10])
  gl.calls.length = 0
  ctx.viewport(0, 0, 20, 20)
  assert.equal(gl.calls.length, 1, 'no switch while the same context keeps calling')
  // Readback flips rows so the canvas reads top-down.
  const px = sec.__readback(); assert.equal(px.length, 64 * 32 * 4)
  assert.ok(gl.calls.some(c => c[0] === 'readPixels' && c[3] === 64 && c[4] === 32))
})

test('uploading a secondary canvas into a primary texture re-asserts the primary before the raw upload', () => {
  const { g, gl, ctx } = host()
  const canvas2 = { width: 8, height: 4 }
  const sec = g.__hostCreateWebGLContext(canvas2, { preserveDrawingBuffer: true }, 'webgl')
  Object.defineProperty(canvas2, '__rgba', { get: () => sec.__readback() })  // what dom-lite's canvas does for a WebGL canvas
  ctx.viewport(0, 0, 4, 4)  // the primary is current again
  gl.calls.length = 0
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  const names = gl.calls.map(c => c[0])
  const read = names.indexOf('readPixels'), up = names.lastIndexOf('texImage2D')
  assert.ok(read >= 0 && up > read, 'the readback ran on the secondary, then the upload')
  // Between the readback (secondary state) and the upload there must be a restore of the primary: its draw framebuffer (0) bound again.
  const restore = gl.calls.findIndex((c, i) => i > read && i < up && c[0] === 'bindFramebuffer' && c[1] === 0x8CA9 && c[2] === 0)
  assert.ok(restore > read, 'the primary state was restored before the raw texImage2D (the atlas upload used to land in the secondary\'s bindings)')
  assert.equal(gl.calls[up][4], 8); assert.equal(gl.calls[up][5], 4)  // the source canvas size went into the raw call
})

test('an opaque texture re-attaches to the framebuffers it was attached to when its name changes', () => {
  const { g, gl, ctx } = host()
  let cur = 7
  const tex = g.__hostOpaqueTexture(() => cur)
  assert.equal(tex._name, 7); assert.ok(tex instanceof g.WebGLTexture)
  const fbo = ctx.createFramebuffer(); ctx.bindFramebuffer(ctx.FRAMEBUFFER, fbo)
  gl.calls.length = 0
  ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, tex, 0)
  assert.deepEqual(gl.calls.find(c => c[0] === 'framebufferTexture2D'), ['framebufferTexture2D', ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, 7, 0])
  assert.equal(tex._attachments.length, 1)
  ctx.bindFramebuffer(ctx.FRAMEBUFFER, null)
  cur = 8; gl.calls.length = 0
  ctx._reattachOpaque(tex)
  const re = gl.calls.filter(c => c[0] === 'framebufferTexture2D')
  assert.deepEqual(re, [['framebufferTexture2D', ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, 8, 0]], 'the same attachment, the new image')
  assert.equal(gl.calls.at(-1)[0], 'bindFramebuffer', 'the previous binding is restored after')
  gl.calls.length = 0; ctx._reattachOpaque(tex); assert.equal(gl.calls.length, 0, 'nothing to do while the name holds')
})

test('deleting the opaque texture leaves the swapchain image alone', () => {
  const { g, gl, ctx } = host()
  const tex = g.__hostOpaqueTexture(() => 7)
  gl.calls.length = 0
  ctx.deleteTexture(tex)
  assert.equal(gl.calls.filter(c => c[0] === 'deleteTexture').length, 0, 'no glDeleteTextures of the runtime\'s image')
  assert.equal(tex._name, 7)
  const own = ctx.createTexture(); ctx.deleteTexture(own)
  assert.equal(gl.calls.filter(c => c[0] === 'deleteTexture').length, 1, 'the page\'s own textures still go')
})

test('call path: WebIDL-converted full-arity scalars, typed arrays by identity, a constant native holder', async () => {
  const { gl, ctx } = host({ answers: { uniformLocations: { u: 5 } } })
  const { N } = await import('../src/webgl/methods.gen.js')
  assert.equal(Object.getPrototypeOf(N), gl, 'N is a fixed holder whose prototype is the native object (TurboFan folds N.x)')
  ctx.drawElements(4, '6', 0x1403, undefined)
  const d = last(gl, 'drawElements')
  assert.deepEqual(d.slice(0, 4), ['drawElements', 4, 6, 0x1403]); assert.ok(Number.isNaN(d[4]), 'an absent GLintptr goes down as a number (NaN → 0 natively), never undefined')
  ctx.vertexAttribPointer(1, 3, GL.FLOAT, 0, 12, 4)
  assert.deepEqual(last(gl, 'vertexAttribPointer'), ['vertexAttribPointer', 1, 3, GL.FLOAT, false, 12, 4], 'GLboolean as a boolean')
  ctx.enable(-1)
  assert.deepEqual(last(gl, 'enable'), ['enable', 0xFFFFFFFF], 'GLenum is unsigned long: ToUint32')
  const loc = ctx.getUniformLocation(ctx.createProgram(), 'u')
  const f32 = new Float32Array(8), sub = f32.subarray(4)
  ctx.uniform4fv(loc, sub)
  const c = last(gl, 'uniform4fv')
  assert.equal(c[2], sub, 'a Float32Array subarray goes down as itself: no copy'); assert.equal(c[3], 0); assert.equal(c[4], 0, 'absent srcOffset/srcLength are 0, full arity')
  ctx.uniform4fv(loc, new Float64Array([1, 2, 3, 4]))
  const c2 = last(gl, 'uniform4fv')
  assert.ok(c2[2] instanceof Float32Array, 'another typed-array kind is converted like a sequence (WebIDL Float32List)'); assert.deepEqual(Array.from(c2[2].subarray(0, 4)), [1, 2, 3, 4])
  assert.throws(() => ctx.uniform4fv(loc, new DataView(new ArrayBuffer(16))), TypeError)
  ctx.uniformMatrix4fv(loc, 1, new Float32Array(16))
  assert.equal(last(gl, 'uniformMatrix4fv')[2], true)
  ctx.vertexAttrib4fv(0, [1, 2])
  assert.equal(last(gl, 'vertexAttrib4fv')[2].length, 0, 'a short list reaches the native short (INVALID_VALUE there), not padded by the scratch')
})

test('a second context costs one compare per call: no per-method wrappers; tracing wraps only while switched on', () => {
  const { g, gl, ctx } = host()
  const proto = g.WebGL2RenderingContext.prototype
  const before = proto.uniform4fv, beforeBind = proto.bindFramebuffer, beforeClear = proto.clear
  const sec = g.__hostCreateWebGLContext({ width: 8, height: 8 }, {}, 'webgl2')
  assert.equal(proto.uniform4fv, before, 'generated pass-through not wrapped'); assert.equal(proto.bindFramebuffer, beforeBind, 'hand-written method not wrapped')
  gl.calls.length = 0
  ctx.clear(GL.COLOR_BUFFER_BIT)
  assert.ok(gl.calls.some(c => c[0] === 'isEnabled'), 'a call on the other context still switches (snapshot) first')
  const n = gl.calls.length
  ctx.clear(GL.COLOR_BUFFER_BIT)
  assert.equal(gl.calls.length, n + 1, 'the current context pays no switch')
  const logs = []; g.__native.log = (lvl, m) => logs.push(m)
  globalThis.__native = g.__native
  try {
    globalThis.__hostGLTraceAll = true
    assert.notEqual(proto.clear, beforeClear, 'trace on wraps')
    gl.getError = () => 0x500
    sec.clear(GL.COLOR_BUFFER_BIT)
    assert.ok(logs.some(m => /gl secondary: clear\(16384\) -> error 0x500/.test(m)), logs.join('\n'))
    globalThis.__hostGLTraceAll = false
    assert.equal(proto.clear, beforeClear, 'trace off restores the originals')
  } finally { globalThis.__hostGLTraceAll = false; delete globalThis.__native }
})

// A host whose fake GL answers TEXTURE_BINDING_2D from `params` and enables only `enabled`, plus a secondary canvas
// shaped like dom-lite's (its __gl, the readback getter and the bottom-up flag).
function hostWithSecondary(w, h, enabled = []) {
  const params = {}
  const r = host({ answers: { params } })
  r.gl.isEnabled = (c) => { r.gl.calls.push(['isEnabled', c]); return enabled.includes(c) }
  r.gl.readPixels = (x, y, rw, rh, f, t, dst) => { r.gl.calls.push(['readPixels', x, y, rw, rh, f, t, dst]); for (let i = 0; i < rw * rh * 4; i++) dst[i] = (i / (rw * 4)) | 0 }  // each byte = its GL row
  const canvas2 = { width: w, height: h }
  const sec = r.g.__hostCreateWebGLContext(canvas2, { premultipliedAlpha: false }, 'webgl2')
  canvas2.__gl = sec
  Object.defineProperty(canvas2, '__rgba', { get: () => sec.__readback() })
  Object.defineProperty(canvas2, '__rgbaBottomUp', { value: true })
  r.ctx.viewport(0, 0, 1, 1)  // the primary is current again
  const tex = r.ctx.createTexture(); r.ctx.bindTexture(GL.TEXTURE_2D, tex); params[GL.TEXTURE_BINDING_2D] = tex._name
  return Object.assign(r, { params, sec, canvas2, tex })
}

test('texImage2D(secondary canvas), flipY=true: a GPU copy out of its FBO with no switch and no readback', () => {
  const { gl, ctx, sec, canvas2, tex, params } = hostWithSecondary(8, 4)
  params[GL.READ_FRAMEBUFFER_BINDING] = 77; params[GL.DRAW_FRAMEBUFFER_BINDING] = 78
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true)
  gl.calls.length = 0
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  const names = gl.calls.map(c => c[0])
  assert.ok(!names.includes('readPixels') && !names.includes('texImage2D'), names.join(' '))
  assert.ok(!names.includes('isEnabled') && !names.includes('activeTexture'), 'no context switch (no snapshot / restore)')
  assert.deepEqual(gl.calls.filter(c => c[0] === 'bindFramebuffer'), [['bindFramebuffer', GL.READ_FRAMEBUFFER, sec._fbo._name], ['bindFramebuffer', GL.READ_FRAMEBUFFER, 77]])
  assert.deepEqual(last(gl, 'copyTexImage2D'), ['copyTexImage2D', GL.TEXTURE_2D, 0, GL.RGBA, 0, 0, 8, 4, 0])
  assert.equal(tex._ifmt, GL.RGBA)
  // texSubImage2D into the same texture: copyTexSubImage2D at the offset
  gl.calls.length = 0
  ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 2, 3, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  assert.deepEqual(last(gl, 'copyTexSubImage2D'), ['copyTexSubImage2D', GL.TEXTURE_2D, 0, 2, 3, 0, 0, 8, 4])
  assert.equal(count(gl, 'readPixels'), 0)
})

test('texSubImage2D(secondary canvas), flipY=false: a Y-swapped blit into a texStorage2D texture, scissor lifted around it', () => {
  const { gl, ctx, sec, canvas2, tex, params } = hostWithSecondary(8, 4, [GL.SCISSOR_TEST])
  ctx.texStorage2D(ctx.TEXTURE_2D, 1, ctx.RGBA8, 16, 16)
  assert.equal(tex._ifmt, GL.RGBA8)
  params[GL.READ_FRAMEBUFFER_BINDING] = 5; params[GL.DRAW_FRAMEBUFFER_BINDING] = 6
  gl.calls.length = 0
  ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 1, 2, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  const names = gl.calls.map(c => c[0])
  assert.ok(!names.includes('readPixels') && !names.includes('texSubImage2D'), names.join(' '))
  const blit = last(gl, 'blitFramebuffer')
  assert.deepEqual(blit.slice(1), [0, 0, 8, 4, 1, 6, 9, 2, GL.COLOR_BUFFER_BIT, GL.NEAREST], 'source rows bottom-up, destination top-down')
  const scratch = ctx._copyFbo
  assert.ok(scratch)
  const seq = gl.calls.filter(c => ['bindFramebuffer', 'framebufferTexture2D', 'disable', 'enable', 'blitFramebuffer'].includes(c[0]))
  assert.deepEqual(seq, [
    ['bindFramebuffer', GL.READ_FRAMEBUFFER, sec._fbo._name],
    ['bindFramebuffer', GL.DRAW_FRAMEBUFFER, scratch],
    ['framebufferTexture2D', GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, tex._name, 0],
    ['disable', GL.SCISSOR_TEST], blit, ['enable', GL.SCISSOR_TEST],
    ['framebufferTexture2D', GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 0, 0],
    ['bindFramebuffer', GL.DRAW_FRAMEBUFFER, 6], ['bindFramebuffer', GL.READ_FRAMEBUFFER, 5]])
  gl.calls.length = 0
  ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  assert.equal(count(gl, 'createFramebuffer'), 0, 'the scratch FBO is made once')
})

test('a GPU copy is skipped wherever it could differ from the readback upload', () => {
  const cases = [
    ['premultiply', (ctx) => ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)],
    ['an sRGB texture', (ctx) => ctx.texStorage2D(ctx.TEXTURE_2D, 1, ctx.SRGB8_ALPHA8, 8, 4)],
    ['an unknown texture format', () => {}],
    ['unpack skips', (ctx) => { ctx.texStorage2D(ctx.TEXTURE_2D, 1, ctx.RGBA8, 8, 4); ctx.pixelStorei(ctx.UNPACK_SKIP_ROWS, 1) }],
    ['a LUMINANCE upload', (ctx) => ctx.texStorage2D(ctx.TEXTURE_2D, 1, ctx.RGBA8, 8, 4), GL.LUMINANCE],
  ]
  for (const [why, setup, format] of cases) {
    const { gl, ctx, canvas2 } = hostWithSecondary(8, 4)
    setup(ctx)
    gl.calls.length = 0
    ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, format || ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
    assert.equal(count(gl, 'readPixels'), 1, why); assert.equal(count(gl, 'texSubImage2D'), 1, why)
    assert.equal(count(gl, 'copyTexSubImage2D') + count(gl, 'blitFramebuffer'), 0, why)
  }
  // feedback: the destination is the canvas's own drawing buffer
  const { gl, ctx, sec, canvas2, params } = hostWithSecondary(8, 4)
  params[GL.TEXTURE_BINDING_2D] = sec._fboTex._name
  gl.calls.length = 0
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  assert.equal(count(gl, 'copyTexImage2D'), 0); assert.equal(count(gl, 'readPixels'), 1)
})

test('readback: one reused buffer, rows bottom-up; the upload flips only when flipY and the row order disagree', () => {
  const { gl, ctx, sec, canvas2 } = hostWithSecondary(2, 3)
  const a = sec.__readback(), b = sec.__readback()
  assert.equal(a, b, 'the same buffer every time')
  assert.deepEqual([a[0], a[8], a[16]], [0, 1, 2], 'GL row 0 (the bottom) first: no CPU flip')
  // flipY=true over bottom-up rows: the buffer goes down as is (the copy is refused here by premultiply, to force the readback)
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.SRGB8_ALPHA8, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  const up = last(gl, 'texImage2D')
  assert.equal(up[9], a, 'flipY=true uploads the readback buffer itself: zero copies')
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.SRGB8_ALPHA8, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas2)
  const up2 = last(gl, 'texImage2D')[9]
  assert.notEqual(up2, a); assert.deepEqual([up2[0], up2[8], up2[16]], [2, 1, 0], 'flipY=false: top row first')
})

test('a context switch snapshots and restores only the texture units and UBO bindings ever used, into a reused record', async () => {
  const { usage } = await import('../src/webgl/switch.js')
  const { g, gl, ctx } = host({ answers: { params: { [GL.MAX_UNIFORM_BUFFER_BINDINGS]: 24, [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 16 } } })
  const sec = g.__hostCreateWebGLContext({ width: 8, height: 8 }, {}, 'webgl2')
  ctx.activeTexture(GL.TEXTURE0 + 5); ctx.activeTexture(GL.TEXTURE0)
  ctx.bindBufferBase(GL.UNIFORM_BUFFER, 2, null)
  assert.ok(usage.units >= 6); assert.ok(usage.ubos >= 3)
  gl.calls.length = 0
  sec.clear(GL.COLOR_BUFFER_BIT)   // snapshot the primary, restore the secondary
  const units = usage.units, ubos = usage.ubos
  assert.equal(count(gl, 'getIndexedParameter'), ubos * 3, 'UBOs read up to the mark')
  assert.equal(count(gl, 'bindSampler'), units, 'units restored up to the mark')
  assert.equal(count(gl, 'activeTexture'), units + 1 + units + 1, 'snapshot and restore each walk the units once')
  assert.ok(units < ctx._units || units === ctx._units)
  const rec = ctx._stateRec; assert.ok(rec)
  ctx.clear(GL.COLOR_BUFFER_BIT); sec.clear(GL.COLOR_BUFFER_BIT)
  assert.equal(ctx._stateRec, rec, 'the primary keeps one record across switches')
  // a unit first used after a state was saved restores to nothing bound in that state
  sec.activeTexture(GL.TEXTURE0 + 9); sec.bindTexture(GL.TEXTURE_2D, sec.createTexture()); sec.activeTexture(GL.TEXTURE0)
  gl.calls.length = 0
  ctx.clear(GL.COLOR_BUFFER_BIT)
  const i9 = gl.calls.findIndex((c, i) => c[0] === 'activeTexture' && c[1] === GL.TEXTURE0 + 9 && gl.calls.slice(i).some(d => d[0] === 'bindSampler'))
  const binds = gl.calls.slice(i9).filter(c => c[0] === 'bindTexture').slice(0, 4)
  assert.deepEqual(binds.map(c => c[2]), [0, 0, 0, 0], 'unit 9 cleared for the primary, which never bound there')
})

// The flat-frame hooks over a fake GL that counts the page's draws (N.drawCount) and records the implicit clear.
function flatHost(config) {
  const gl = fakeGL({ answers: { params: { [GL.MAX_SAMPLES]: 8 } } })
  let draws = 0; gl.drawCount = () => draws; const draw = () => { draws++ }
  gl.clearDrawingBuffer = (fbo, mask) => gl.calls.push(['clearDrawingBuffer', fbo, mask])
  const g = { __native: fakeNative({ gl, config }), console: { warn() {} } }
  install(g)
  const canvas = { width: 640, height: 360, events: [], dispatchEvent() {} }
  const ctx = g.__hostCreateWebGLContext(canvas, { antialias: true })
  return { g, gl, ctx, draw }
}
test('the implicit clear follows only a frame the page drew', () => {
  const { gl, ctx, draw } = flatHost({})
  const clears = () => gl.calls.filter(c => c[0] === 'clearDrawingBuffer').length
  const frame = (drawn) => { ctx.__hostBeginFlatFrame(); if (drawn) draw(); ctx.__hostFlatPresent([640, 360]) }
  frame(true); assert.equal(clears(), 0, 'nothing to clear before the first drawn frame')
  frame(false); assert.equal(clears(), 1, 'a drawn frame was presented: cleared before the next')
  frame(false); assert.equal(clears(), 1, 'a skipped frame keeps what was shown')
  frame(true); frame(true); assert.equal(clears(), 2)
  assert.equal(gl.calls.find(c => c[0] === 'clearDrawingBuffer')[1], 0, 'same size as the window, no gl.antialias: the window itself')
})
test('gl.antialias: a 4x multisampled drawing buffer resolved into the window; off by default; reads see the resolve', () => {
  const off = flatHost({})
  off.ctx.__hostBeginFlatFrame()
  assert.equal(off.gl.calls.filter(c => c[0] === 'renderbufferStorageMultisample').length, 0, 'off by default: no multisampling')
  const { gl, ctx, draw } = flatHost({ gl: { antialias: true } })
  ctx.__hostBeginFlatFrame()
  const ms = gl.calls.filter(c => c[0] === 'renderbufferStorageMultisample')
  assert.deepEqual(ms.map(c => [c[2], c[3], c[4], c[5]]), [[4, GL.RGBA8, 640, 360], [4, GL.DEPTH24_STENCIL8, 640, 360]], 'colour + depth/stencil, 4 samples (MAX_SAMPLES 8), the canvas size')
  const msaaFbo = ctx._fbo._name, resolveFbo = ctx._resolveFbo._name
  ctx.bindFramebuffer(GL.FRAMEBUFFER, null)
  assert.deepEqual(gl.calls.at(-1), ['bindFramebuffer', GL.FRAMEBUFFER, msaaFbo], "the page's default framebuffer is the multisampled one")
  draw(); gl.calls.length = 0; ctx.__hostFlatPresent([1280, 720])
  const blits = gl.calls.filter(c => c[0] === 'blitFramebuffer')
  assert.equal(blits.length, 2, 'resolve, then the window')
  assert.deepEqual(blits[1].slice(5, 11), [0, 0, 1280, 720, GL.COLOR_BUFFER_BIT, GL.LINEAR], 'scaled into the window')
  assert.ok(gl.calls.some(c => c[0] === 'invalidateFramebuffer'), 'the samples are invalidated after the resolve')
  // a frame the page skipped re-shows the resolve, no new resolve
  ctx.__hostBeginFlatFrame(); gl.calls.length = 0; ctx.__hostFlatPresent([1280, 720])
  assert.equal(gl.calls.filter(c => c[0] === 'blitFramebuffer').length, 1)
  // readPixels on the default framebuffer reads the resolve
  gl.calls.length = 0
  const answers = { [GL.READ_FRAMEBUFFER_BINDING]: msaaFbo }; const gp = gl.getParameter; gl.getParameter = (p) => p in answers ? answers[p] : gp(p)
  ctx.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))
  const i = gl.calls.findIndex(c => c[0] === 'readPixels')
  assert.deepEqual(gl.calls.slice(0, i).filter(c => c[0] === 'bindFramebuffer').at(-1), ['bindFramebuffer', GL.READ_FRAMEBUFFER, resolveFbo])
  assert.deepEqual(gl.calls.at(-1), ['bindFramebuffer', GL.READ_FRAMEBUFFER, msaaFbo], 'and binds the drawing buffer back')
})

test('an sRGB XRWebGLLayer framebuffer: GL_FRAMEBUFFER_SRGB_EXT off while it is the draw binding, on otherwise', () => {
  const { gl, ctx } = host()
  const layerFb = ctx.createFramebuffer(), other = ctx.createFramebuffer()
  const srgb = () => gl.calls.filter((c) => (c[0] === 'enable' || c[0] === 'disable') && c[1] === 0x8DB9).map((c) => c[0])
  ctx.bindFramebuffer(ctx.FRAMEBUFFER, layerFb)
  assert.deepEqual(srgb(), [], 'nothing before a layer framebuffer is registered')
  ctx._setSrgbRawFramebuffer(layerFb)
  ctx.bindFramebuffer(ctx.FRAMEBUFFER, layerFb)
  ctx.bindFramebuffer(ctx.READ_FRAMEBUFFER, other)  // a read binding never changes it
  ctx.bindFramebuffer(ctx.DRAW_FRAMEBUFFER, layerFb)  // already off: no call
  ctx.bindFramebuffer(ctx.DRAW_FRAMEBUFFER, other)
  ctx.bindFramebuffer(ctx.FRAMEBUFFER, null)  // already on: no call
  ctx.bindFramebuffer(ctx.FRAMEBUFFER, layerFb)
  assert.deepEqual(srgb(), ['disable', 'enable', 'disable'])
  ctx._srgbSync(other._name)  // a context switch restored another draw binding
  assert.deepEqual(srgb(), ['disable', 'enable', 'disable', 'enable'])
})
