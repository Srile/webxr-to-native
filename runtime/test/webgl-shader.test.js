import { test } from 'node:test'
import assert from 'node:assert/strict'
import { std140Blocks } from '../src/webgl/shader-rewrite.js'

// WebGL 2 lays every uniform block out as std140; GLES leaves an unqualified block `shared` (driver-defined), which
// Adreno packs tighter than std140 (Wonderland Engine's camera block read from the wrong offsets on the Quest).
test('uniform blocks: none, shared and packed become std140 in place; std140 and plain uniforms are untouched', () => {
  const src = [
    '#version 300 es',
    'precision highp float;',
    'uniform ViewUniforms {',
    '  highp vec3 viewWorldPosition[2];',
    '  highp mat4 viewProjectionMatrix[2];',
    '};',
    'layout(std140) uniform A { vec4 x; };',
    'layout(shared, row_major) uniform B { mat4 m; } b;',
    'layout(packed) uniform;',
    'layout(row_major) uniform C{vec4 y;};',
    '#if defined(LIGHTS)',
    'uniform Lights { vec4 l[4]; } lights;',
    '#endif',
    'uniform highp sampler2D tex;',
    'uniform vec4 color;',
    'layout(location = 0) out vec4 outColor;',
    'void main() { outColor = color; }',
  ].join('\n')
  const out = std140Blocks(src).split('\n')
  assert.equal(out[2], 'layout(std140) uniform ViewUniforms {')
  assert.equal(out[6], 'layout(std140) uniform A { vec4 x; };')
  assert.equal(out[7], 'layout(std140, row_major) uniform B { mat4 m; } b;')
  assert.equal(out[8], 'layout(std140) uniform;')
  assert.equal(out[9], 'layout(std140, row_major) uniform C{vec4 y;};')
  assert.equal(out[11], 'layout(std140) uniform Lights { vec4 l[4]; } lights;')
  assert.equal(out[13], 'uniform highp sampler2D tex;')
  assert.equal(out[14], 'uniform vec4 color;')
  assert.equal(out[15], 'layout(location = 0) out vec4 outColor;')
  assert.equal(out.length, src.split('\n').length)
})

test('uniform blocks: an ESSL 1.00 shader (no blocks) passes through unchanged', () => {
  const src = 'precision mediump float;\nuniform vec4 c;\nvoid main() { gl_FragColor = c; }'
  assert.equal(std140Blocks(src), src)
})
