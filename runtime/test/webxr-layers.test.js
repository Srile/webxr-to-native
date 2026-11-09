import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, F } from './webxr-fake.test.js'

// A WebGL2 context fake recording the calls the layer fallback makes.
function fakeGL() {
  const calls = []
  let bound = null
  const gl = {
    FRAMEBUFFER: 0x8D40, FRAMEBUFFER_BINDING: 0x8CA6, COLOR_ATTACHMENT0: 0x8CE0, TEXTURE_2D: 0x0DE1,
    RENDERBUFFER: 0x8D41, DEPTH_ATTACHMENT: 0x8D00, DEPTH_STENCIL_ATTACHMENT: 0x821A, RGBA8: 0x8058, DEPTH24_STENCIL8: 0x88F0,
    calls,
    createFramebuffer() { return { fbo: calls.length } },
    createRenderbuffer() { return { rb: true } },
    getParameter(p) { calls.push(['getParameter', p]); return bound },
    bindFramebuffer(t, f) { calls.push(['bindFramebuffer', f]); bound = f },
    bindRenderbuffer(t, r) { calls.push(['bindRenderbuffer', r]) },
    renderbufferStorage(t, fmt, w, h) { calls.push(['renderbufferStorage', fmt, w, h]) },
    framebufferRenderbuffer(t, a, rt, r) { calls.push(['framebufferRenderbuffer', a]) },
    framebufferTexture2D(t, a, tt, tex, l) { calls.push(['framebufferTexture2D', a, tex, l]) },
    getContextAttributes() { return { antialias: true, depth: true, stencil: false, alpha: true, xrCompatible: true } },
  }
  return gl
}

test('XRWebGLBinding.createProjectionLayer begins the swapchain for texture-array and builds the layer', async () => {
  const h = harness({ foveation: 0.25 })
  const s = await h.session()
  const gl = fakeGL()
  assert.ok(typeof h.g.XRWebGLBinding !== 'undefined')
  assert.ok('createProjectionLayer' in h.g.XRWebGLBinding.prototype)
  const binding = new h.g.XRWebGLBinding(s, gl)
  assert.equal(binding.nativeProjectionScaleFactor, 1)
  assert.equal(h.xr.begun, null)
  let suspended = 0
  h.g.__hostSuspendFlatFrames = () => suspended++
  const layer = binding.createProjectionLayer({ colorFormat: gl.RGBA8, depthFormat: gl.DEPTH24_STENCIL8, scaleFactor: 1.2, textureType: 'texture-array' })
  assert.deepEqual(h.xr.begun, { arraySize: 2, scale: 1.2, format: 0x8058, foveation: 0.25 })
  assert.equal(suspended, 1)
  assert.ok(layer instanceof h.g.XRProjectionLayer)
  assert.ok(layer instanceof h.g.XRCompositionLayer)
  assert.equal(layer.textureWidth, 1680); assert.equal(layer.textureHeight, 1760)
  assert.equal(layer.textureArrayLength, 2)
  assert.equal(layer.ignoreDepthValues, true)
  assert.equal(layer.colorFormat, gl.RGBA8); assert.equal(layer.depthFormat, gl.DEPTH24_STENCIL8)
  assert.equal(layer.mipLevels, 1); assert.equal(layer.layout, 'default'); assert.equal(layer.textureType, 'texture-array')
  assert.equal(layer.fixedFoveation, 0.25)
  layer.fixedFoveation = 1
  assert.equal(h.xr.foveation, 1); assert.equal(layer.fixedFoveation, 1)
  layer.fixedFoveation = 7; assert.equal(layer.fixedFoveation, 1)
  layer.fixedFoveation = -1; assert.equal(layer.fixedFoveation, 0)
  s.updateRenderState({ layers: [layer] })
  h.tick()
  assert.deepEqual([...s.renderState.layers], [layer])
  assert.equal(s.renderState.baseLayer, null)
  // a second layer reuses the swapchain
  binding.createProjectionLayer({ textureType: 'texture-array' })
  assert.equal(h.xr.begun.scale, 1.2)
  assert.throws(() => s.updateRenderState({ layers: [layer], baseLayer: new h.g.XRWebGLLayer(s, gl) }), TypeError)
})

test('getViewSubImage: reused per-eye object, ONE opaque colorTexture whose name follows frame[3], viewport per eye', async () => {
  const h = harness()
  const wrapped = []
  h.g.__hostWrapTexture = (name) => { const w = { __name: name }; wrapped.push(w); return w }
  const s = await h.session()
  const gl = fakeGL()
  const binding = new h.g.XRWebGLBinding(s, gl)
  const layer = binding.createProjectionLayer({ textureType: 'texture-array' })
  s.updateRenderState({ layers: [layer] })
  const floor = await s.requestReferenceSpace('local-floor')
  const seen = []
  const cb = (t, f) => {
    const pose = f.getViewerPose(floor)
    const a = binding.getViewSubImage(layer, pose.views[0])
    const b = binding.getViewSubImage(layer, pose.views[1])
    seen.push({ a, b, name: a.colorTexture.__name, bname: b.colorTexture.__name, same: a.colorTexture === b.colorTexture })
    s.requestAnimationFrame(cb)
  }
  s.requestAnimationFrame(cb)
  h.frame[F.COLOR_TEX] = 7; h.tick()
  h.frame[F.COLOR_TEX] = 8; h.tick()
  h.frame[F.COLOR_TEX] = 9; h.tick()
  h.frame[F.COLOR_TEX] = 7; h.tick()
  assert.equal(seen.length, 4)
  assert.deepEqual(seen.map((x) => x.name), [7, 8, 9, 7])
  assert.deepEqual(seen.map((x) => x.bname), [7, 8, 9, 7])
  assert.ok(seen.every((x) => x.same))
  assert.equal(seen[0].a, seen[3].a); assert.equal(seen[0].b, seen[3].b)  // the sub-image objects are reused
  assert.equal(seen[0].a.colorTexture, seen[1].a.colorTexture)  // ONE opaque texture object for every frame (three attaches it once)
  assert.equal(wrapped.length, 0)  // never a wrapper per swapchain image on this path
  const a = seen[0].a, b = seen[0].b
  assert.equal(a.depthStencilTexture, null)
  assert.deepEqual([a.viewport.x, a.viewport.y, a.viewport.width, a.viewport.height], [0, 0, 1680, 1760])
  assert.deepEqual([b.viewport.x, b.viewport.y, b.viewport.width, b.viewport.height], [0, 0, 1680, 1760])
  assert.equal(a.imageIndex, 0); assert.equal(b.imageIndex, 1)
  assert.equal(a.colorTextureWidth, 1680); assert.equal(a.colorTextureHeight, 1760)
})

test("a 'texture' projection layer is side by side at the swapchain's full width", async () => {
  const h = harness({}, { beginResult: { width: 3360, height: 1760, rates: [72], rate: 72, hasStage: false, stageWidth: 0, stageDepth: 0, hands: false } })
  const s = await h.session()
  const gl = fakeGL()
  const binding = new h.g.XRWebGLBinding(s, gl)
  const layer = binding.createProjectionLayer({})
  assert.equal(h.xr.begun.arraySize, 1)
  assert.equal(layer.textureArrayLength, 1); assert.equal(layer.layout, 'stereo'); assert.equal(layer.textureWidth, 3360)
  const floor = await s.requestReferenceSpace('local-floor')
  await assert.rejects(s.requestReferenceSpace('bounded-floor'), { name: 'NotSupportedError' })
  s.requestAnimationFrame((t, f) => {
    const pose = f.getViewerPose(floor)
    const a = binding.getViewSubImage(layer, pose.views[0]), b = binding.getViewSubImage(layer, pose.views[1])
    assert.deepEqual([a.viewport.x, a.viewport.width, b.viewport.x, b.viewport.width], [0, 1680, 1680, 1680])
    assert.equal(a.imageIndex, 0); assert.equal(b.imageIndex, 0)
  })
  h.tick()
})

test('XRWebGLLayer fallback: owns an FBO, attaches the swapchain image each frame, side-by-side viewports', async () => {
  const h = harness({}, { beginResult: { width: 3360, height: 1760, rates: [72], rate: 72, hasStage: true, stageWidth: 2, stageDepth: 2, hands: false } })
  const s = await h.session()
  const gl = fakeGL()
  const layer = new h.g.XRWebGLLayer(s, gl, { antialias: true, alpha: true, depth: true, stencil: false, framebufferScaleFactor: 0.9 })
  assert.deepEqual(h.xr.begun, { arraySize: 1, scale: 0.9, format: 0x8058 })
  assert.ok(layer instanceof h.g.XRLayer)
  assert.equal(layer.framebufferWidth, 3360); assert.equal(layer.framebufferHeight, 1760)
  assert.equal(layer.ignoreDepthValues, true)
  assert.equal(layer.antialias, true)
  assert.equal(layer.context, gl)
  assert.ok(layer.framebuffer && layer.framebuffer.fbo !== undefined)
  assert.equal(h.g.XRWebGLLayer.getNativeFramebufferScaleFactor(s), 1)
  s.updateRenderState({ baseLayer: layer })
  const floor = await s.requestReferenceSpace('local-floor')
  let vps
  s.requestAnimationFrame((t, f) => {
    const pose = f.getViewerPose(floor)
    vps = pose.views.map((v) => layer.getViewport(v))
    assert.throws(() => layer.getViewport({}), TypeError)
  })
  gl.calls.length = 0
  h.frame[F.COLOR_TEX] = 11
  h.tick()
  assert.equal(s.renderState.baseLayer, layer)
  assert.deepEqual(vps.map((v) => [v.x, v.y, v.width, v.height]), [[0, 0, 1680, 1760], [1680, 0, 1680, 1760]])
  const tex = gl.calls.find((c) => c[0] === 'framebufferTexture2D')
  assert.ok(tex); assert.equal(tex[2].__name, 11)
  assert.ok(gl.calls.some((c) => c[0] === 'renderbufferStorage' && c[1] === 0x81A6 && c[2] === 3360))
  assert.ok(gl.calls.some((c) => c[0] === 'framebufferRenderbuffer' && c[1] === gl.DEPTH_ATTACHMENT))
  // the FBO binding is restored to what three had bound (null here)
  assert.deepEqual(gl.calls.at(-1), ['bindFramebuffer', null])
  gl.calls.length = 0
  h.frame[F.COLOR_TEX] = 12
  h.tick()
  const tex2 = gl.calls.filter((c) => c[0] === 'framebufferTexture2D')
  assert.equal(tex2.length, 1); assert.equal(tex2[0][2].__name, 12)
  assert.equal(gl.calls.filter((c) => c[0] === 'renderbufferStorage').length, 0)
  // same image again: no GL calls at all
  gl.calls.length = 0
  h.tick()
  assert.equal(gl.calls.length, 0)
  assert.equal(layer.fixedFoveation, 0)
  layer.fixedFoveation = 0.5
  assert.equal(h.xr.foveation, 0.5)
})

test('XRWebGLLayer fallback: antialias is 4x multisampled through EXT_multisampled_render_to_texture, colour and depth', async () => {
  for (const antialias of [true, false]) {
    const h = harness({}, { beginResult: { width: 3360, height: 1760, rates: [72], rate: 72, hasStage: true, stageWidth: 2, stageDepth: 2, hands: false } })
    const s = await h.session()
    const gl = fakeGL()
    gl._glExt = new Set(['GL_EXT_multisampled_render_to_texture'])
    const getParameter = gl.getParameter
    gl.getParameter = (p) => p === 0x8D57 ? 8 : getParameter(p)  // MAX_SAMPLES: 8, the layer asks for 4
    gl._n = {
      framebufferTexture2DMultisampleEXT(t, a, tt, name, l, n) { gl.calls.push(['framebufferTexture2DMultisampleEXT', a, name, l, n]) },
      renderbufferStorageMultisampleEXT(t, n, fmt, w, hh) { gl.calls.push(['renderbufferStorageMultisampleEXT', n, fmt, w, hh]) },
    }
    const layer = new h.g.XRWebGLLayer(s, gl, { antialias })
    s.updateRenderState({ baseLayer: layer })
    s.requestAnimationFrame(() => {})
    gl.calls.length = 0
    h.frame[F.COLOR_TEX] = 11
    h.tick()
    const ms = gl.calls.filter((c) => c[0].endsWith('MultisampleEXT'))
    if (antialias) {
      assert.deepEqual(ms, [['framebufferTexture2DMultisampleEXT', gl.COLOR_ATTACHMENT0, 11, 0, 4], ['renderbufferStorageMultisampleEXT', 4, 0x81A6, 3360, 1760]])
      assert.equal(gl.calls.filter((c) => c[0] === 'framebufferTexture2D' || c[0] === 'renderbufferStorage').length, 0)
    } else {
      assert.equal(ms.length, 0)
      assert.ok(gl.calls.some((c) => c[0] === 'framebufferTexture2D'))
    }
  }
})

test('XRWebGLLayer fallback: asks for an sRGB swapchain where GL can write it unconverted, and registers its FBO', async () => {
  for (const [ext, format, expectRaw] of [[true, 0x8C43, true], [true, 0x8058, false], [false, 0x8058, false]]) {
    const h = harness({}, { beginResult: { width: 3360, height: 1760, format, rates: [72], rate: 72, hasStage: true, stageWidth: 2, stageDepth: 2, hands: false } })
    const s = await h.session()
    const gl = fakeGL()
    let raw = null
    if (ext) gl._glExt = new Set(['GL_EXT_sRGB_write_control'])
    gl._setSrgbRawFramebuffer = (fb) => { raw = fb }
    const layer = new h.g.XRWebGLLayer(s, gl, { antialias: false })
    assert.equal(h.xr.begun.srgbLayer, ext ? 1 : undefined)
    assert.equal(raw, expectRaw ? layer.framebuffer : null)
  }
})

test('layers from another session are refused by updateRenderState and the binding', async () => {
  const h = harness()
  const s = await h.session()
  const gl = fakeGL()
  const layer = new h.g.XRWebGLBinding(s, gl).createProjectionLayer({ textureType: 'texture-array' })
  await s.end()
  const s2 = await h.session()
  assert.throws(() => s2.updateRenderState({ layers: [layer] }), { name: 'InvalidStateError' })
  assert.throws(() => new h.g.XRWebGLBinding(s, gl), { name: 'InvalidStateError' })
  assert.throws(() => new h.g.XRWebGLLayer(s, gl), { name: 'InvalidStateError' })
  assert.equal(h.g.XRWebGLLayer.getNativeFramebufferScaleFactor(s), 0)
})

test('XRWebGLLayer fallback: depth is invalidated at frame end (after the draws, binding restored); colour never', async () => {
  const h = harness({}, { beginResult: { width: 3360, height: 1760, rates: [72], rate: 72, hasStage: true, stageWidth: 2, stageDepth: 2, hands: false } })
  const s = await h.session()
  const gl = fakeGL()
  gl.invalidateFramebuffer = (t, att) => gl.calls.push(['invalidateFramebuffer', t, att])
  const layer = new h.g.XRWebGLLayer(s, gl, { depth: true, stencil: true })
  s.updateRenderState({ baseLayer: layer })
  const three = { three: true }
  s.requestAnimationFrame(() => { gl.bindFramebuffer(gl.FRAMEBUFFER, three); gl.calls.push(['draw']) })
  h.tick()
  const i = gl.calls.findIndex((c) => c[0] === 'invalidateFramebuffer')
  assert.ok(i > gl.calls.findIndex((c) => c[0] === 'draw'))
  assert.deepEqual(gl.calls[i][2], [0x821A])  // DEPTH_STENCIL_ATTACHMENT only
  assert.equal(gl.calls[i - 1][1], layer.framebuffer)
  assert.deepEqual(gl.calls.at(-1), ['bindFramebuffer', three])
  const att = gl.calls[i][2]
  h.tick()
  assert.equal(gl.calls.filter((c) => c[0] === 'invalidateFramebuffer').at(-1)[2], att)  // one array for the layer's life
})

test('XRWebGLLayer fallback: host.json xr.invalidate false leaves depth alone; no depth buffer, nothing to invalidate', async () => {
  for (const [cfg, init] of [[{ invalidate: false }, { depth: true }], [{}, { depth: false }]]) {
    const h = harness(cfg)
    const s = await h.session()
    const gl = fakeGL()
    gl.invalidateFramebuffer = (t, att) => gl.calls.push(['invalidateFramebuffer', t, att])
    s.updateRenderState({ baseLayer: new h.g.XRWebGLLayer(s, gl, init) })
    h.tick()
    assert.equal(gl.calls.filter((c) => c[0] === 'invalidateFramebuffer').length, 0)
  }
})

test('Quest Browser fixed-foveation-level features set the starting foveation; host.json foveation wins', async () => {
  for (const [feature, want] of [['high-fixed-foveation-level', 1], ['medium-fixed-foveation-level', 2 / 3], ['low-fixed-foveation-level', 1 / 3]]) {
    const h = harness()
    const s = await h.session({ optionalFeatures: [feature] })
    assert.ok(s.enabledFeatures.includes(feature))
    const layer = new h.g.XRWebGLBinding(s, fakeGL()).createProjectionLayer({ textureType: 'texture-array' })
    assert.equal(h.xr.begun.foveation, want); assert.equal(layer.fixedFoveation, want)
  }
  const h = harness({ foveation: 0 })
  const s = await h.session({ optionalFeatures: ['high-fixed-foveation-level'] })
  new h.g.XRWebGLBinding(s, fakeGL()).createProjectionLayer({ textureType: 'texture-array' })
  assert.equal(h.xr.begun.foveation, 0)
  const h2 = harness()
  const s2 = await h2.session({})
  new h2.g.XRWebGLBinding(s2, fakeGL()).createProjectionLayer({ textureType: 'texture-array' })
  assert.equal('foveation' in h2.xr.begun, false)
})
