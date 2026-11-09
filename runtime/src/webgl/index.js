// WebGL (WP-04): install(g) defines WebGL2RenderingContext (WebGLRenderingContext
// is the same class — the host has one GL, GLES 3.2, and three r181 wants
// WebGL2), the WebGL object classes, and three host hooks:
//   g.__hostCreateWebGLContext(canvas, attrs, type) → the ONE context (a
//     singleton; images/canvas2d.js calls it from canvas.getContext('webgl2'))
//   g.__hostGL() → that context or null (webxr/layers.js's fallback)
//   g.__hostWrapTexture(name) → the WebGLTexture wrapper for a GL name the
//     native side created (the OpenXR swapchain images)
// The native surface it sits on is __native.gl, documented in README.md.
import { WebGL2RenderingContext, setNative } from './context.js'
import { OBJECT_CLASSES } from './objects.js'
import { snapshot, restore, makeState, resetState, installGuards, unitCount, uboCount } from './switch.js'

export function install(g) {
  const native = g.__native || null
  let context = null

  const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })
  define('WebGL2RenderingContext', WebGL2RenderingContext)
  // WebGLRenderingContext: one implementation, but as in a browser a context asked for as 'webgl2' is not an instance
  // of it (Emscripten's Safari workaround drops a context whose instanceof does not match the version it asked for).
  // Its constants and prototype are WebGL2's, so pages that read or patch either see the same thing.
  const WebGLRenderingContext = function WebGLRenderingContext() { throw new TypeError('Illegal constructor') }
  Object.setPrototypeOf(WebGLRenderingContext, WebGL2RenderingContext)
  WebGLRenderingContext.prototype = WebGL2RenderingContext.prototype
  Object.defineProperty(WebGLRenderingContext, Symbol.hasInstance, { value: (o) => o instanceof WebGL2RenderingContext && !!o._webgl1 })
  define('WebGLRenderingContext', WebGLRenderingContext)
  for (const name in OBJECT_CLASSES) define(name, OBJECT_CLASSES[name])

  const log = (msg) => {
    if (native && typeof native.log === 'function') native.log(2, 'webgl: ' + msg)
    else if (g.console && typeof g.console.warn === 'function') g.console.warn('webgl: ' + msg)
  }

  // The first canvas gets the PRIMARY context (the XR swapchain and the window are its
  // default framebuffer). Later canvases get SECONDARY contexts over the same GL, each
  // drawing into an FBO of its own (switch.js), so a library that keeps a scratch WebGL
  // canvas beside three's (troika's SDF atlas) works as in a browser.
  let current = null
  const switchTo = (next) => {
    const gl = native.gl
    if (current) {
      if (!current._stateRec) current._stateRec = makeState(current._units, current._ubos)
      current._savedState = snapshot(gl, current._stateRec)
    }
    current = next
    if (!next._savedState) {
      if (!next._stateRec) next._stateRec = makeState(next._units, next._ubos)
      next._savedState = resetState(next._stateRec, next.drawingBufferWidth, next.drawingBufferHeight, next._fbo ? next._fbo._name : 0)
    }
    restore(gl, next._savedState)
    next._srgbSync(next._savedState.drawFb)
    next._savedState = null
  }
  define('__hostCreateWebGLContext', function (canvas, attrs, type) {
    if (context && (!canvas || canvas === context.canvas)) return context
    const gl = native && native.gl
    if (!gl || typeof gl.getParameter !== 'function') { log('no __native.gl; getContext returns null'); return null }
    if (!context) {
      setNative(gl)
      context = new WebGL2RenderingContext(gl, canvas || null, attrs || {}, log, type)
      context._units = unitCount(gl); context._ubos = uboCount(gl)
      context._antialiasCfg = native.config?.gl?.antialias === true  // multisampled drawing buffer when the page asks (context.js)
      current = context
      return context
    }
    const secondary = new WebGL2RenderingContext(gl, canvas, attrs || {}, log, type)
    secondary._units = context._units; secondary._ubos = context._ubos
    installGuards(WebGL2RenderingContext, () => current, switchTo)
    secondary._initSecondary()
    log(`secondary context #${++secondaryCount} on a ${canvas.width}x${canvas.height} canvas (${type})`)
    return secondary
  })
  let secondaryCount = 0
  define('__hostGL', function () { return context })
  define('__hostBeforeFlatFrame', function () { if (context) context.__hostBeginFlatFrame() })
  // After each flat frame on a window host (__native.info.flatScaled): the primary canvas scaled into the window.
  if (native && native.info && native.info.flatScaled) define('__hostAfterFlatFrame', function () { if (context && g.__hostWindowPixels) context.__hostFlatPresent(g.__hostWindowPixels) })
  // An OPAQUE texture (a browser's projection-layer colorTexture): one WebGLTexture object whose GL
  // name is whatever `nameOf()` answers now (the acquired swapchain image). three attaches it to its
  // framebuffer ONCE; the context records such attachments and _reattachOpaque re-issues them per
  // frame, so the render lands in the image being submitted (without it only every third frame showed).
  define('__hostOpaqueTexture', function (nameOf) {
    const t = new OBJECT_CLASSES.WebGLTexture(0)
    Object.defineProperty(t, '_name', { get: nameOf, configurable: true })
    t._opaque = true; t._attachments = []; t._lastName = -1; t._ctx = context
    return t
  })
  define('__hostWrapTexture', function (name) { return context ? context._lookup('texture', name | 0) : null })
}
