// A fake __native.gl for the WebGL wrapper tests: every call is recorded as
// [name, ...args]; a few queries answer from a small scripted table so the
// wrapper's typed getters, name wrapping and extension gating can be driven.
export function fakeGL(opts = {}) {
  const calls = []
  const extensions = opts.extensions !== undefined ? opts.extensions :
    'GL_OVR_multiview2 GL_OVR_multiview_multisampled_render_to_texture GL_EXT_multisampled_render_to_texture GL_EXT_texture_filter_anisotropic ' +
    'GL_KHR_texture_compression_astc_ldr GL_EXT_disjoint_timer_query GL_KHR_parallel_shader_compile GL_EXT_clip_control GL_OES_texture_float_linear'
  const version = opts.version || 'OpenGL ES 3.2 V@0502.0 (GIT@fake)'
  const answers = Object.assign({ params: {}, uniformLocations: {}, programParams: {}, shaderParams: {} }, opts.answers || {})
  let nextName = 1
  const gl = {
    calls,
    extensions() { return extensions },
    getString(name) { calls.push(['getString', name]); return name === 0x1F00 ? 'FakeVendor' : name === 0x1F01 ? 'FakeRenderer' : name === 0x1F02 ? version : null },
    getParameter(pname) { calls.push(['getParameter', pname]); return pname in answers.params ? answers.params[pname] : 0 },
    getUniformLocation(program, name) { calls.push(['getUniformLocation', program, name]); return name in answers.uniformLocations ? answers.uniformLocations[name] : -1 },
    // opts.batchUniforms: the native batch read (every active uniform at once), as the host offers it.
    getProgramParameter(p, pname) { calls.push(['getProgramParameter', p, pname]); return pname in answers.programParams ? answers.programParams[pname] : 0 },
    getShaderParameter(s, pname) { calls.push(['getShaderParameter', s, pname]); return pname in answers.shaderParams ? answers.shaderParams[pname] : 0 },
    getShaderPrecisionFormat(st, pt) { calls.push(['getShaderPrecisionFormat', st, pt]); return { rangeMin: 127, rangeMax: 127, precision: 23 } },
    getActiveUniform(p, i) { calls.push(['getActiveUniform', p, i]); return i === 0 ? { size: 1, type: 0x8B5C, name: 'modelViewMatrix' } : null },
    getActiveAttrib(p, i) { calls.push(['getActiveAttrib', p, i]); return i === 0 ? { size: 1, type: 0x8B51, name: 'position' } : null },
    getAttachedShaders(p) { calls.push(['getAttachedShaders', p]); return [7, 8] },
    getFramebufferAttachmentParameter(t, a, pname) { calls.push(['getFramebufferAttachmentParameter', t, a, pname]); return pname === 0x8CD0 ? 0x1702 : 42 },
    getQueryParameter(q, pname) { calls.push(['getQueryParameter', q, pname]); return pname === 0x8867 ? 1 : 1234 },
    getTexParameter(t, pname) { calls.push(['getTexParameter', t, pname]); return 1 },
    getVertexAttrib(i, pname) { calls.push(['getVertexAttrib', i, pname]); return pname === 0x889F ? 5 : 1 },
    getIndexedParameter(t, i) { calls.push(['getIndexedParameter', t, i]); return 9 },
    fenceSync(c, f) { calls.push(['fenceSync', c, f]); return opts.syncHandle === undefined ? 3 : opts.syncHandle },
    getError() { calls.push(['getError']); return 0 },
    // Indirect multi-draw: the command words are copied at record time (the wrapper reuses its scratch array).
    multiDrawElementsIndirect(mode, type, cmds, drawcount, flags) { calls.push(['multiDrawElementsIndirect', mode, type, Array.from(cmds.subarray(0, drawcount * 5)), drawcount, flags]) },
    multiDrawArraysIndirect(mode, cmds, drawcount, flags) { calls.push(['multiDrawArraysIndirect', mode, Array.from(cmds.subarray(0, drawcount * 4)), drawcount, flags]) },
  }
  // opts.drawIdAttrib: the reserved draw-id attribute location the native side reports (indirect multi-draw on).
  if (opts.drawIdAttrib !== undefined) gl.multiDrawInfo = () => opts.drawIdAttrib
  if (opts.batchUniforms) gl.getUniformLocations = program => { calls.push(['getUniformLocations', program]); return Object.entries(answers.uniformLocations).flat() }
  // Every other entry point: record and return a fresh name for create*, 0 otherwise.
  const names = [
    'activeTexture', 'attachShader', 'bindAttribLocation', 'bindBuffer', 'bindFramebuffer', 'bindRenderbuffer', 'bindTexture', 'blendColor', 'blendEquation',
    'blendEquationSeparate', 'blendFunc', 'blendFuncSeparate', 'checkFramebufferStatus', 'clear', 'clearColor', 'clearDepth', 'clearStencil', 'colorMask',
    'compileShader', 'copyTexImage2D', 'copyTexSubImage2D', 'createBuffer', 'createFramebuffer', 'createProgram', 'createRenderbuffer', 'createShader',
    'createTexture', 'cullFace', 'deleteBuffer', 'deleteFramebuffer', 'deleteProgram', 'deleteRenderbuffer', 'deleteShader', 'deleteTexture', 'depthFunc',
    'depthMask', 'depthRange', 'detachShader', 'disable', 'disableVertexAttribArray', 'drawArrays', 'drawElements', 'enable', 'enableVertexAttribArray',
    'finish', 'flush', 'framebufferRenderbuffer', 'framebufferTexture2D', 'frontFace', 'generateMipmap', 'getAttribLocation', 'getBufferParameter',
    'getRenderbufferParameter', 'hint', 'isBuffer', 'isEnabled', 'isFramebuffer', 'isProgram', 'isRenderbuffer', 'isShader', 'isTexture', 'lineWidth',
    'linkProgram', 'pixelStorei', 'polygonOffset', 'renderbufferStorage', 'sampleCoverage', 'scissor', 'stencilFunc', 'stencilFuncSeparate', 'stencilMask',
    'stencilMaskSeparate', 'stencilOp', 'stencilOpSeparate', 'texParameterf', 'texParameteri', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1i',
    'uniform2i', 'uniform3i', 'uniform4i', 'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv', 'useProgram', 'validateProgram', 'vertexAttrib1f', 'vertexAttrib2f', 'vertexAttrib3f',
    'vertexAttrib4f', 'vertexAttrib1fv', 'vertexAttrib2fv', 'vertexAttrib3fv', 'vertexAttrib4fv', 'vertexAttribPointer', 'viewport', 'copyBufferSubData',
    'blitFramebuffer', 'framebufferTextureLayer', 'readBuffer', 'renderbufferStorageMultisample', 'texStorage2D', 'texStorage3D', 'copyTexSubImage3D',
    'getFragDataLocation', 'uniform1ui', 'uniform2ui', 'uniform3ui', 'uniform4ui', 'uniform1uiv', 'uniform2uiv', 'uniform3uiv', 'uniform4uiv',
    'uniformMatrix3x2fv', 'uniformMatrix4x2fv', 'uniformMatrix2x3fv', 'uniformMatrix4x3fv', 'uniformMatrix2x4fv', 'uniformMatrix3x4fv', 'vertexAttribI4i',
    'vertexAttribI4iv', 'vertexAttribI4ui', 'vertexAttribI4uiv', 'vertexAttribIPointer', 'vertexAttribDivisor', 'drawArraysInstanced', 'drawElementsInstanced',
    'drawRangeElements', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'createQuery', 'deleteQuery', 'isQuery', 'beginQuery', 'endQuery',
    'getQuery', 'createSampler', 'deleteSampler', 'isSampler', 'bindSampler', 'samplerParameteri', 'samplerParameterf', 'createTransformFeedback',
    'deleteTransformFeedback', 'isTransformFeedback', 'bindTransformFeedback', 'beginTransformFeedback', 'endTransformFeedback', 'pauseTransformFeedback',
    'resumeTransformFeedback', 'bindBufferBase', 'bindBufferRange', 'getUniformBlockIndex', 'uniformBlockBinding', 'createVertexArray', 'deleteVertexArray',
    'isVertexArray', 'bindVertexArray',
    'bufferData', 'bufferSubData', 'getBufferSubData', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D',
    'compressedTexSubImage2D', 'compressedTexImage3D', 'compressedTexSubImage3D', 'readPixels', 'shaderSource', 'getShaderInfoLog', 'getProgramInfoLog',
    'getUniform', 'getUniformIndices', 'getActiveUniforms', 'getActiveUniformBlockParameter', 'getActiveUniformBlockName', 'getTransformFeedbackVarying',
    'transformFeedbackVaryings', 'getSamplerParameter', 'getVertexAttribOffset', 'drawBuffers', 'invalidateFramebuffer', 'invalidateSubFramebuffer', 'isSync',
    'deleteSync', 'clientWaitSync', 'waitSync', 'getSyncParameter', 'getInternalformatParameter',
    'multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL',
    'framebufferTextureMultiviewOVR', 'framebufferTextureMultisampleMultiviewOVR', 'renderbufferStorageMultisampleEXT', 'framebufferTexture2DMultisampleEXT',
    'queryCounterEXT', 'clipControlEXT', 'enableiOES', 'disableiOES', 'blendEquationiOES', 'blendEquationSeparateiOES', 'blendFunciOES',
    'blendFuncSeparateiOES', 'colorMaskiOES',
  ]
  for (const n of names) {
    if (gl[n]) continue
    if (opts.omit && opts.omit.includes(n)) continue
    gl[n] = (...args) => {
      calls.push([n, ...args])
      if (n.startsWith('create')) return nextName++
      if (n.startsWith('is')) return args[0] !== 0
      if (n === 'getShaderInfoLog' || n === 'getProgramInfoLog') return ''
      if (n === 'clientWaitSync') return 0x911A
      return 0
    }
  }
  return gl
}

export function last(gl, name) {
  for (let i = gl.calls.length - 1; i >= 0; i--) if (gl.calls[i][0] === name) return gl.calls[i]
  return null
}
export function count(gl, name) { return gl.calls.filter(c => c[0] === name).length }
