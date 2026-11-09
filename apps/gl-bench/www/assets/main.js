// gl-bench: ns per WebGL call through the host's JS → native GL path (runtime/src/webgl → host/gl).
// Each case is its own function with the call in a loop, so TurboFan optimizes it like a game's render
// loop would (inlined pass-through, and the V8 fast-API C function when --turbo-fast-api-calls is on).
// Phase "1ctx": only the primary context exists. Phase "2ctx": a second canvas context exists too (troika's
// case) and every call pays the current-context check. Results: logcat lines "gl-bench <phase> <case> <ns>"
// plus one "GLBENCH {json}" summary; the screen shows one bar per case (width = ns/call, 100 ns = full width;
// green = 1ctx, blue = 2ctx) once done, red if any GL error was raised along the way.
// Phase "multidraw" (runs first, one context): WEBGL_multi_draw multiDrawElementsWEBGL with
// 16 / 64 / 256 degenerate draws per call and gl_DrawID in the vertex shader, as indirect (one glMultiDrawElementsIndirectEXT)
// and as the per-draw loop (the same attribute set per draw); "call" = ns per multiDraw call, "finish" = the same with a
// gl.finish() per round folded in (the driver's deferred work). Logcat "gl-bench md <case> call <ns> finish <ns>"; the
// screen shows them below the call bars (orange = indirect, grey = loop; 50 us = full width). host-loop.json turns the
// indirect path off (host.json gl.multiDrawIndirect false: the old uniform loop, both case sets then loop);
// host-subdata.json uploads commands with glBufferSubData instead of the persistent map.
const log = (m) => console.log('gl-bench ' + m)
const canvas = document.getElementById('c') || document.createElement('canvas')
const gl = canvas.getContext('webgl2')

function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
const prog = gl.createProgram()
gl.attachShader(prog, shader(gl.VERTEX_SHADER, '#version 300 es\nlayout(location=0) in vec4 p; uniform mat4 m; void main(){ gl_Position = m * p; }'))
gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; uniform vec4 c; uniform int k; out vec4 o; void main(){ o = c + float(k); }'))
gl.linkProgram(prog)
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
gl.useProgram(prog)
const locC = gl.getUniformLocation(prog, 'c'), locM = gl.getUniformLocation(prog, 'm'), locK = gl.getUniformLocation(prog, 'k')
const vao = gl.createVertexArray(); gl.bindVertexArray(vao)
const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(64), gl.DYNAMIC_DRAW)
const ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(6), gl.STATIC_DRAW)
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0)
const v4 = new Float32Array([1, 0, 0, 1]), v8 = new Float32Array(8), m16 = new Float32Array(16), sub16 = new Float32Array(16), arr4 = [0, 1, 0, 1]
m16[0] = m16[5] = m16[10] = m16[15] = 1

// One function per case: the loop is what TurboFan optimizes (and where the call is inlined).
const CASES = {
  'empty-loop': (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s },
  'uniform4fv': (n) => { for (let i = 0; i < n; i++) gl.uniform4fv(locC, v4) },
  'uniform4fv-offset': (n) => { for (let i = 0; i < n; i++) gl.uniform4fv(locC, v8, 4, 4) },
  'uniform4fv-array': (n) => { for (let i = 0; i < n; i++) gl.uniform4fv(locC, arr4) },
  'uniformMatrix4fv': (n) => { for (let i = 0; i < n; i++) gl.uniformMatrix4fv(locM, false, m16) },
  'uniform4f': (n) => { for (let i = 0; i < n; i++) gl.uniform4f(locC, 1, 0, 0, 1) },
  'uniform1i': (n) => { for (let i = 0; i < n; i++) gl.uniform1i(locK, 0) },
  'bindBuffer': (n) => { for (let i = 0; i < n; i++) gl.bindBuffer(gl.ARRAY_BUFFER, vbo) },
  'bindVertexArray': (n) => { for (let i = 0; i < n; i++) gl.bindVertexArray(vao) },
  'useProgram': (n) => { for (let i = 0; i < n; i++) gl.useProgram(prog) },
  'enable+disable/2': (n) => { for (let i = 0; i < n; i += 2) { gl.enable(gl.BLEND); gl.disable(gl.BLEND) } },
  'vertexAttribPointer': (n) => { for (let i = 0; i < n; i++) gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0) },
  'drawElements(0)': (n) => { for (let i = 0; i < n; i++) gl.drawElements(gl.TRIANGLES, 0, gl.UNSIGNED_SHORT, 0) },
  'drawArrays(0)': (n) => { for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLES, 0, 0) },
  'bufferSubData(64B)': (n) => { for (let i = 0; i < n; i++) gl.bufferSubData(gl.ARRAY_BUFFER, 0, sub16) },
  'getError': (n) => { let e = 0; for (let i = 0; i < n; i++) e |= gl.getError(); return e },
}
const N = 50000, ROUNDS = 5, WARM = 30

// ---- multi-draw cases ----
const mdExt = gl.getExtension('WEBGL_multi_draw')
const mdProg = gl.createProgram()
gl.attachShader(mdProg, shader(gl.VERTEX_SHADER, '#version 300 es\n#extension GL_ANGLE_multi_draw : require\nlayout(location=0) in vec4 p; void main(){ gl_Position = p * (1.0 + float(gl_DrawID) * 1e-9); }'))
gl.attachShader(mdProg, shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; out vec4 o; void main(){ o = vec4(1.0); }'))
gl.linkProgram(mdProg)
if (!gl.getProgramParameter(mdProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(mdProg))
const mdVao = gl.createVertexArray(); gl.bindVertexArray(mdVao)
gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0)
const mdIbo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mdIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(3 * 256), gl.STATIC_DRAW)
gl.bindVertexArray(vao)
const mdIndirect = !!(gl._mdi && gl._mdi.attrib >= 0)
const MD_CASES = {}
for (const d of [16, 64, 256]) {
  const counts = new Int32Array(d).fill(3), offsets = new Int32Array(d)
  for (let i = 0; i < d; i++) offsets[i] = i * 6   // byte offsets of 3 UNSIGNED_SHORT indices each (all zero: degenerate)
  for (const mode of ['indirect', 'loop']) {
    MD_CASES[`md${d}-${mode}`] = (n) => {
      if (gl._mdi) gl._mdi.enabled = mdIndirect && mode === 'indirect'
      for (let i = 0; i < n; i++) mdExt.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_SHORT, offsets, 0, d)
    }
  }
}
const MD_N = 400, MD_ROUNDS = 5, MD_WARM = 5
function measureMd(name) {
  const f = MD_CASES[name]
  gl.useProgram(mdProg); gl.bindVertexArray(mdVao)
  for (let r = 0; r < MD_WARM; r++) { f(50); gl.finish() }
  let call = Infinity, fin = Infinity
  for (let r = 0; r < MD_ROUNDS; r++) {
    gl.finish()
    const t0 = performance.now(); f(MD_N); const t1 = performance.now(); gl.finish(); const t2 = performance.now()
    call = Math.min(call, t1 - t0); fin = Math.min(fin, t2 - t0)
  }
  if (gl._mdi) gl._mdi.enabled = mdIndirect
  gl.useProgram(prog); gl.bindVertexArray(vao)
  return { call: Math.round(call * 1e6 / MD_N), finish: Math.round(fin * 1e6 / MD_N) }
}

function measure(name) {
  const f = CASES[name]
  for (let r = 0; r < WARM; r++) f(2000)
  let best = Infinity
  for (let r = 0; r < ROUNDS; r++) { const t0 = performance.now(); f(N); const dt = performance.now() - t0; if (dt < best) best = dt }
  return best * 1e6 / N
}

const results = { '1ctx': {}, '2ctx': {}, multidraw: {} }
let glError = 0
const tick = () => new Promise((r) => setTimeout(r, 0))
async function phase(label) {
  for (const name of Object.keys(CASES)) {
    const ns = measure(name)
    results[label][name] = Math.round(ns * 10) / 10
    const e = gl.getError(); if (e) { glError = e; log(`${label} ${name}: GL error 0x${e.toString(16)}`) }
    log(`${label} ${name} ${ns.toFixed(1)} ns/call`)
    await tick()
  }
}

await tick()
log(`md indirect path ${mdIndirect ? 'available' : 'OFF (driver or host.json gl.multiDrawIndirect)'}`)
for (const name of Object.keys(MD_CASES)) {
  const r = results.multidraw[name] = measureMd(name)
  const e = gl.getError(); if (e) { glError = e; log(`md ${name}: GL error 0x${e.toString(16)}`) }
  log(`md ${name} call ${r.call} finish ${r.finish} ns`)
  await tick()
}
results.mdIndirect = mdIndirect
await phase('1ctx')
const c2 = document.createElement('canvas'); c2.width = 16; c2.height = 16
const gl2 = c2.getContext('webgl2'); gl2.clearColor(0, 0, 0, 0); gl2.clear(gl2.COLOR_BUFFER_BIT)  // secondary: from now on every call checks the current context
gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo)  // back on the primary (one switch)
await phase('2ctx')
console.log('GLBENCH ' + JSON.stringify({ error: glError, results }))

const names = Object.keys(CASES)
function draw() {
  const mdNames = Object.keys(MD_CASES)
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, row = Math.floor(h / (names.length + mdNames.length + 1))
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); gl.disable(gl.SCISSOR_TEST)
  gl.clearColor(glError ? 0.6 : 0.08, 0.08, 0.08, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  gl.enable(gl.SCISSOR_TEST)
  names.forEach((n, i) => {
    const y = h - (i + 1) * row
    const bar = (ns, dy, r, g, b) => { gl.scissor(0, y + dy, Math.max(2, Math.min(w, Math.round(ns / 100 * w))), Math.max(1, (row >> 1) - 2)); gl.clearColor(r, g, b, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
    bar(results['1ctx'][n] || 0, row >> 1, 0.2, 0.8, 0.3)
    bar(results['2ctx'][n] || 0, 0, 0.2, 0.5, 0.9)
  })
  mdNames.forEach((n, i) => {
    const y = h - (names.length + i + 1) * row, r = results.multidraw[n] || { call: 0 }, ind = n.endsWith('indirect')
    gl.scissor(0, y, Math.max(2, Math.min(w, Math.round(r.call / 50000 * w))), Math.max(1, row - 2))
    gl.clearColor(ind ? 0.95 : 0.6, ind ? 0.55 : 0.6, ind ? 0.1 : 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  })
  gl.disable(gl.SCISSOR_TEST)
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)
console.log('READY')
