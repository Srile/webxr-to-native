// WEBGL_multi_draw as indirect draws (runtime/src/webgl/multidraw.js): the gl_DrawID attribute rewrite,
// its hiding from the game, the command records, and every case that must keep the native loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { fakeGL, last, count } from './webgl-fake-gl.js'
import { install } from '../src/webgl/index.js'
import { GL } from '../src/webgl/constants.gen.js'
import { rewriteDrawId, drawIdMode } from '../src/webgl/shader-rewrite.js'

const R = 31   // the reserved location (MAX_VERTEX_ATTRIBS 32 - 1)
const VS = '#version 300 es\n#extension GL_ANGLE_multi_draw : require\nin vec3 position;\nuniform mat4 m[8];\nvoid main() { gl_Position = m[gl_DrawID] * vec4(position, 1.0); }\n'
const FS = '#version 300 es\nprecision mediump float;\nout vec4 c; void main() { c = vec4(1.0); }\n'

function host(glOpts = { drawIdAttrib: R }) {
  const gl = fakeGL(glOpts)
  // A linked program lists the draw-id attribute first, then position.
  gl.getProgramParameter = (p, pname) => { gl.calls.push(['getProgramParameter', p, pname]); return pname === GL.ACTIVE_ATTRIBUTES ? 2 : pname === GL.LINK_STATUS ? 1 : 0 }
  gl.getActiveAttrib = (p, i) => { gl.calls.push(['getActiveAttrib', p, i]); return i === 0 ? { size: 1, type: GL.INT, name: 'webgl_DrawID' } : i === 1 ? { size: 1, type: GL.FLOAT_VEC3, name: 'position' } : null }
  gl.getParameter = (pname) => { gl.calls.push(['getParameter', pname]); return pname === GL.MAX_VERTEX_ATTRIBS ? 32 : 0 }
  const g = { __native: fakeNative({ gl }), console: { warn() {} } }
  install(g)
  const ctx = g.__hostCreateWebGLContext({ width: 64, height: 64, dispatchEvent() {} }, {})
  return { gl, ctx, md: ctx.getExtension('WEBGL_multi_draw') }
}
function program(ctx, vsSrc = VS) {
  const vs = ctx.createShader(ctx.VERTEX_SHADER), fs = ctx.createShader(ctx.FRAGMENT_SHADER)
  ctx.shaderSource(vs, vsSrc); ctx.shaderSource(fs, FS)
  const p = ctx.createProgram(); ctx.attachShader(p, vs); ctx.attachShader(p, fs); ctx.linkProgram(p)
  return p
}

test('drawIdMode / rewriteDrawId: attribute for ESSL 3 vertex shaders, uniform for ESSL 1, none for fragment', () => {
  assert.equal(drawIdMode(VS, GL.VERTEX_SHADER, true), 'attribute')
  assert.equal(drawIdMode('void main(){ int i = gl_DrawID; }', GL.VERTEX_SHADER, true), 'uniform')
  assert.equal(drawIdMode(VS, GL.FRAGMENT_SHADER, true), 'none')
  assert.equal(drawIdMode(VS, GL.VERTEX_SHADER, false), 'uniform')
  const r = rewriteDrawId(VS, 'attribute')
  assert.equal(r.drawIdAttr, true); assert.equal(r.usesDrawId, true)
  const lines = r.source.split('\n')
  assert.equal(lines[0], '#version 300 es'); assert.equal(lines[1], 'in highp int webgl_DrawID;'); assert.equal(lines[2], '#define webgl_ANGLE_multi_draw 1')
  assert.ok(/m\[webgl_DrawID\]/.test(r.source) && !/\bgl_DrawID\b/.test(r.source))
  const f = rewriteDrawId('#version 300 es\n#extension GL_ANGLE_multi_draw : require\nvoid main(){ int i = gl_DrawID; }', 'none')
  assert.equal(f.source, '#version 300 es\n#define webgl_ANGLE_multi_draw 1\nvoid main(){ int i = gl_DrawID; }', 'fragment: only the macro; gl_DrawID left for the compiler to reject')
  assert.equal(f.usesDrawId, false)
})

test('the draw-id attribute: bound to the reserved location before link, hidden from the game', () => {
  const { gl, ctx } = host()
  const p = program(ctx)
  const sent = gl.calls.filter(c => c[0] === 'shaderSource')
  assert.ok(/in highp int webgl_DrawID;/.test(sent[0][2]), 'vertex shader gets the attribute')
  assert.equal(sent[1][2], FS)
  const bi = gl.calls.findIndex(c => c[0] === 'bindAttribLocation'), li = gl.calls.findIndex(c => c[0] === 'linkProgram')
  assert.deepEqual(gl.calls[bi], ['bindAttribLocation', p._name, R, 'webgl_DrawID'])
  assert.ok(bi < li, 'bound before link')
  assert.equal(p._drawIdLoc, -2); assert.equal(p._hiddenAttr, 0)
  assert.equal(count(gl, 'getUniformLocation'), 0, 'no uniform to look up')
  assert.equal(ctx.getParameter(ctx.MAX_VERTEX_ATTRIBS), R, 'the last location is not offered')
  assert.equal(ctx.getProgramParameter(p, ctx.ACTIVE_ATTRIBUTES), 1)
  assert.equal(ctx.getActiveAttrib(p, 0).name, 'position', 'index 0 skips the hidden attribute')
  assert.equal(ctx.getActiveAttrib(p, 1), null)
  assert.equal(ctx.getAttribLocation(p, 'webgl_DrawID'), -1)
  ctx.getAttribLocation(p, 'position'); assert.deepEqual(last(gl, 'getAttribLocation'), ['getAttribLocation', p._name, 'position'])
  assert.equal(ctx.getVertexAttrib(R, ctx.VERTEX_ATTRIB_ARRAY_ENABLED), null)
  assert.equal(ctx.getVertexAttrib(0, ctx.VERTEX_ATTRIB_ARRAY_ENABLED), true, 'the game\'s own attributes untouched')
  // an ESSL 1.00 vertex shader keeps the uniform
  const p1 = program(ctx, 'attribute vec3 position; uniform mat4 m[8]; void main(){ gl_Position = m[gl_DrawID] * vec4(position, 1.0); }')
  assert.ok(/uniform highp int webgl_gl_DrawID;/.test(gl.calls.filter(c => c[0] === 'shaderSource').at(-2)[2]))
  assert.equal(p1._hiddenAttr, -1); assert.deepEqual(last(gl, 'getUniformLocation'), ['getUniformLocation', p1._name, 'webgl_gl_DrawID'])
})

test('a program that cannot link with the draw-id attribute relinks with the uniform', () => {
  const { gl, ctx } = host()
  // The first link fails (the hidden attribute was one location too many), the second succeeds.
  let links = 0
  gl.linkProgram = (p) => { gl.calls.push(['linkProgram', p]); links++ }
  gl.getProgramParameter = (p, pname) => { gl.calls.push(['getProgramParameter', p, pname]); return pname === GL.LINK_STATUS ? (links >= 2 ? 1 : 0) : 0 }
  gl.getUniformLocation = (p, name) => { gl.calls.push(['getUniformLocation', p, name]); return 7 }
  const p = program(ctx)
  assert.equal(count(gl, 'linkProgram'), 2, 'linked again')
  const sent = gl.calls.filter(c => c[0] === 'shaderSource')
  assert.ok(/in highp int webgl_DrawID;/.test(sent[0][2]), 'first: the attribute')
  assert.ok(/uniform highp int webgl_gl_DrawID;/.test(sent.at(-1)[2]) && !/webgl_DrawID\b/.test(sent.at(-1)[2]), 'then: the uniform')
  const recompile = gl.calls.findLastIndex(c => c[0] === 'compileShader'), relink = gl.calls.findLastIndex(c => c[0] === 'linkProgram')
  assert.ok(recompile >= 0 && recompile < relink, 'recompiled before the second link')
  assert.equal(p._drawIdLoc, 7, 'the uniform\'s location'); assert.equal(p._hiddenAttr, -1)
  assert.equal(ctx.getProgramParameter(p, ctx.LINK_STATUS), true)
  // A program that links the first time keeps the attribute.
  const q = program(ctx)
  assert.equal(q._drawIdLoc, -2)
})

test('multiDrawElementsWEBGL → one indirect call with DrawElementsIndirectCommand records', () => {
  const { gl, ctx, md } = host()
  const p = program(ctx); ctx.useProgram(p)
  const vao = ctx.createVertexArray(); ctx.bindVertexArray(vao)
  const counts = new Int32Array([0, 6, 3, 9]), offsets = new Int32Array([0, 12, 24, 48, 96])
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, counts, 1, ctx.UNSIGNED_SHORT, offsets, 1, 3)
  assert.equal(count(gl, 'multiDrawElementsWEBGL'), 0, 'no loop')
  assert.deepEqual(last(gl, 'multiDrawElementsIndirect'), ['multiDrawElementsIndirect', GL.TRIANGLES, GL.UNSIGNED_SHORT, [
    6, 1, 6, 0, 0,     // count, instanceCount, firstIndex = 12 / 2, baseVertex, baseInstance = draw id
    3, 1, 12, 0, 1,
    9, 1, 24, 0, 2,
  ], 3, 3], 'first use on this VAO: enable + set up the draw-id attribute')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3, 3], 0, ctx.UNSIGNED_INT, [0, 16], 0, 2)
  assert.deepEqual(last(gl, 'multiDrawElementsIndirect'), ['multiDrawElementsIndirect', GL.TRIANGLES, GL.UNSIGNED_INT, [3, 1, 0, 0, 0, 3, 1, 4, 0, 1], 2, 1], 'plain arrays read in place; set up once per VAO')
  const vao2 = ctx.createVertexArray(); ctx.bindVertexArray(vao2)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_BYTE, [5], 0, 1)
  assert.equal(last(gl, 'multiDrawElementsIndirect')[5], 3, 'a new VAO is set up again')
  assert.deepEqual(last(gl, 'multiDrawElementsIndirect')[3], [3, 1, 5, 0, 0])
  // a program without gl_DrawID: baseInstance 0, no attribute
  const plain = ctx.createProgram(); ctx.attachShader(plain, ctx.createShader(ctx.FRAGMENT_SHADER)); ctx.linkProgram(plain); ctx.useProgram(plain)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3, 3], 0, ctx.UNSIGNED_SHORT, [0, 6], 0, 2)
  assert.deepEqual(last(gl, 'multiDrawElementsIndirect').slice(3), [[3, 1, 0, 0, 0, 3, 1, 3, 0, 0], 2, 0])
})

test('multiDrawArraysWEBGL → DrawArraysIndirectCommand records; instanced variants', () => {
  const { gl, ctx, md } = host()
  const p = program(ctx); ctx.useProgram(p)
  ctx.bindVertexArray(ctx.createVertexArray())
  md.multiDrawArraysWEBGL(ctx.TRIANGLES, new Int32Array([0, 3, 9]), 0, new Int32Array([3, 6, 0]), 0, 3)
  assert.deepEqual(last(gl, 'multiDrawArraysIndirect'), ['multiDrawArraysIndirect', GL.TRIANGLES, [3, 1, 0, 0, 6, 1, 3, 1, 0, 1, 9, 2], 3, 3])
  // instanced + gl_DrawID: instance k would read id k + i → the loop
  md.multiDrawArraysInstancedWEBGL(ctx.TRIANGLES, [0], 0, [3], 0, [4], 0, 1)
  assert.equal(last(gl, 'multiDrawArraysInstancedWEBGL')[9], -2, 'loop with the attribute as the draw id')
  md.multiDrawElementsInstancedWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, [4], 0, 1)
  assert.equal(count(gl, 'multiDrawElementsInstancedWEBGL'), 1)
  // instanced without gl_DrawID: indirect, baseInstance 0 (the game's instanced attributes are not shifted)
  const plain = ctx.createProgram(); ctx.attachShader(plain, ctx.createShader(ctx.FRAGMENT_SHADER)); ctx.linkProgram(plain); ctx.useProgram(plain)
  md.multiDrawElementsInstancedWEBGL(ctx.TRIANGLES, [3, 6], 0, ctx.UNSIGNED_SHORT, [0, 6], 0, [4, 2], 0, 2)
  assert.deepEqual(last(gl, 'multiDrawElementsIndirect').slice(3), [[3, 4, 0, 0, 0, 6, 2, 3, 0, 0], 2, 0])
  md.multiDrawArraysInstancedWEBGL(ctx.TRIANGLES, [1], 0, [3], 0, [7], 0, 1)
  assert.deepEqual(last(gl, 'multiDrawArraysIndirect').slice(2), [[3, 7, 1, 0], 1, 0])
})

test('the loop is kept: default VAO, game divisors, misaligned or negative values, short lists, uniform programs, switch off', () => {
  const { gl, ctx, md } = host()
  const p = program(ctx); ctx.useProgram(p)
  const loops = () => count(gl, 'multiDrawElementsWEBGL')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1)
  assert.equal(loops(), 1, 'default VAO: ES 3.1 indirect draws need a VAO')
  assert.equal(last(gl, 'multiDrawElementsWEBGL')[8], -2)
  const vao = ctx.createVertexArray(); ctx.bindVertexArray(vao)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [1], 0, 1); assert.equal(loops(), 2, 'odd byte offset for 16-bit indices')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [-1], 0, ctx.UNSIGNED_SHORT, [0], 0, 1); assert.equal(loops(), 3, 'negative count')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 2); assert.equal(loops(), 4, 'list shorter than drawcount')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.FLOAT, [0], 0, 1); assert.equal(loops(), 5, 'not an index type')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, new Uint32Array([3]), 0, ctx.UNSIGNED_SHORT, [0], 0, 1); assert.equal(loops(), 6, 'not an Int32List')
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 0); assert.equal(loops(), 7, 'drawcount 0 goes to the loop (no-op)')
  assert.equal(count(gl, 'multiDrawElementsIndirect'), 0)
  ctx.vertexAttribDivisor(3, 1)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1); assert.equal(loops(), 8, 'a game divisor + gl_DrawID: baseInstance would shift it')
  ctx.vertexAttribDivisor(3, 0)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1); assert.equal(loops(), 8, 'divisor back to 0: indirect again')
  assert.equal(count(gl, 'multiDrawElementsIndirect'), 1)
  md.multiDrawArraysWEBGL(ctx.TRIANGLES, [-3], 0, [3], 0, 1); assert.equal(count(gl, 'multiDrawArraysWEBGL'), 1, 'negative first')
  ctx._mdi.enabled = false
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1); assert.equal(loops(), 9, 'switched off: the attribute loop')
  ctx._mdi.enabled = true
  ctx.deleteVertexArray(vao)
  assert.equal(ctx._vao, null, 'deleting the bound VAO reverts to the default')
  ctx.bindVertexArray(ctx.createVertexArray())
  const p1 = program(ctx, 'attribute vec3 position; uniform mat4 m[8]; void main(){ gl_Position = m[gl_DrawID] * vec4(position, 1.0); }')
  gl.getUniformLocation = () => 5; ctx.linkProgram(p1); ctx.useProgram(p1)
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1)
  assert.equal(last(gl, 'multiDrawElementsWEBGL')[8], 5, 'uniform program: the loop sets the uniform per draw')
})

test('no indirect path (driver or host.json): uniform rewrite and the loop, as before', () => {
  const { gl, ctx, md } = host({})
  const p = program(ctx); ctx.useProgram(p)
  assert.ok(/uniform highp int webgl_gl_DrawID;/.test(gl.calls.find(c => c[0] === 'shaderSource')[2]))
  assert.equal(count(gl, 'bindAttribLocation'), 0)
  assert.equal(ctx.getParameter(ctx.MAX_VERTEX_ATTRIBS), 32)
  ctx.bindVertexArray(ctx.createVertexArray())
  md.multiDrawElementsWEBGL(ctx.TRIANGLES, [3], 0, ctx.UNSIGNED_SHORT, [0], 0, 1)
  assert.equal(count(gl, 'multiDrawElementsIndirect'), 0); assert.equal(count(gl, 'multiDrawElementsWEBGL'), 1)
})

test('the ANGLE macro: never defined under a GL_ name, three\'s batching test renamed with it, untouched without the extension', () => {
  // three's batching chunk, as the game's bundle ships it
  const chunk = '#ifdef USE_BATCHING\n\t#if ! defined( GL_ANGLE_multi_draw )\n\t#define gl_DrawID _gl_DrawID\n\tuniform int _gl_DrawID;\n\t#endif\n#endif\n'
  const on = rewriteDrawId('#version 300 es\n#extension GL_ANGLE_multi_draw : require\n' + chunk + 'void main(){ int i = gl_DrawID; }', 'uniform').source
  assert.ok(!/#\s*define\s+GL_/.test(on), 'no #define of a GL_ name (Adreno: "name must not start with GL_")')
  assert.ok(!/GL_ANGLE_multi_draw/.test(on), 'every reference to the ANGLE name is renamed')
  assert.match(on, /^#define webgl_ANGLE_multi_draw 1$/m)
  assert.match(on, /#if ! defined\( webgl_ANGLE_multi_draw \)/, 'three\'s test sees the macro as defined, so its own _gl_DrawID fallback stays off')
  // the game's multiview probe: both extension lines, layout before main
  const probe = rewriteDrawId('#version 300 es\n#extension GL_OVR_multiview : require\n#extension GL_ANGLE_multi_draw : require\nlayout(num_views = 2) in;\nvoid main() { gl_Position = vec4(float(gl_DrawID + int(gl_ViewID_OVR))); }', 'uniform').source.split('\n')
  assert.deepEqual(probe.slice(0, 4), ['#version 300 es', '#extension GL_OVR_multiview : require', 'uniform highp int webgl_gl_DrawID;', '#define webgl_ANGLE_multi_draw 1'])
  // no extension line: ANGLE leaves the macro undefined, so three's fallback must still see it undefined
  const off = rewriteDrawId('#version 300 es\n' + chunk + 'void main(){}', 'uniform').source
  assert.match(off, /#if ! defined\( GL_ANGLE_multi_draw \)/, 'the test of the macro is left alone')
  assert.ok(!/webgl_ANGLE_multi_draw/.test(off), 'and the macro is not defined')
})
