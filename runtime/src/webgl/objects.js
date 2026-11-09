// The WebGL object classes. Each wraps one GL name (uint32); identity lives on
// the JS side (context.js keeps one wrapper per name per kind), the native side
// only ever sees the number. A deleted object has _name 0, which GL treats as
// "no object", so a stale reference binds nothing and isX() answers false.
export class WebGLObject {
  constructor(name) { this._name = name; this._deleted = false }
}
export class WebGLBuffer extends WebGLObject {}
export class WebGLTexture extends WebGLObject {
  constructor(name) { super(name); this._ifmt = 0 }   // internalformat of level 0 as last defined through this wrapper (0: unknown)
}
export class WebGLProgram extends WebGLObject {
  // _drawIdLoc: the gl_DrawID uniform's location, -1 none, -2 the draw-id attribute (multidraw.js);
  // _hiddenAttr: that attribute's active-attribute index, skipped by getActiveAttrib / ACTIVE_ATTRIBUTES (-1 none).
  constructor(name) { super(name); this._shaders = new Set(); this._drawIdLoc = -1; this._hiddenAttr = -1 }
}
export class WebGLShader extends WebGLObject {
  constructor(name) { super(name); this._type = 0; this._source = ''; this._translated = ''; this._usesDrawId = false; this._drawIdAttr = false }
}
export class WebGLFramebuffer extends WebGLObject {}
export class WebGLRenderbuffer extends WebGLObject {}
export class WebGLVertexArrayObject extends WebGLObject {
  // _divMask: attribute arrays the game gave a non-zero divisor (bit per index); _mdReady: the draw-id attribute points at the host's id buffer.
  constructor(name) { super(name); this._divMask = 0; this._mdReady = false }
}
export class WebGLSampler extends WebGLObject {}
export class WebGLQuery extends WebGLObject {}
export class WebGLTransformFeedback extends WebGLObject {}
// A sync's _name is the native handle into the GLsync table (GLsync is a pointer).
export class WebGLSync extends WebGLObject {}

export class WebGLUniformLocation {
  constructor(loc, program) { this._loc = loc; this._program = program }
}
export class WebGLActiveInfo {
  constructor(size, type, name) { this.size = size; this.type = type; this.name = name }
}
export class WebGLShaderPrecisionFormat {
  constructor(rangeMin, rangeMax, precision) { this.rangeMin = rangeMin; this.rangeMax = rangeMax; this.precision = precision }
}

export const KIND_CLASS = {
  buffer: WebGLBuffer, texture: WebGLTexture, program: WebGLProgram, shader: WebGLShader, framebuffer: WebGLFramebuffer,
  renderbuffer: WebGLRenderbuffer, vao: WebGLVertexArrayObject, sampler: WebGLSampler, query: WebGLQuery,
  tf: WebGLTransformFeedback, sync: WebGLSync,
}

export const OBJECT_CLASSES = {
  WebGLObject, WebGLBuffer, WebGLTexture, WebGLProgram, WebGLShader, WebGLFramebuffer, WebGLRenderbuffer,
  WebGLVertexArrayObject, WebGLSampler, WebGLQuery, WebGLTransformFeedback, WebGLSync,
  WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat,
}
