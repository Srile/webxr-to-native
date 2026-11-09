// The shader-source rewrites the binding makes: uniform blocks laid out as std140 (std140Blocks, below), and
// WEBGL_multi_draw's gl_DrawID.
//
// WEBGL_multi_draw's gl_DrawID. GLES has no gl_DrawID (it is GL_ANGLE_multi_draw's), and the
// `#extension GL_ANGLE_multi_draw` line (which the Adreno compiler would
// refuse) becomes the macro ANGLE defines, under the name webgl_ANGLE_multi_draw
// (a GL_ macro name may not be defined), with the shader's tests of the macro
// renamed to match. The identifier becomes one of:
//   'attribute' — `in highp int webgl_DrawID;`, a per-instance integer
//     attribute the host binds to a reserved location and feeds 0..N-1 with
//     divisor 1, so an indirect multi-draw's baseInstance = i reads i
//     (multidraw.js); the native loop sets it as a constant per draw instead.
//     ESSL 3.00 vertex shaders only (ESSL 1.00 has no int attributes).
//   'uniform' — `uniform highp int webgl_gl_DrawID;`, set per draw by the
//     native loop (ANGLE's baseline). Used when indirect draws are off or
//     unavailable, and for ESSL 1.00 vertex shaders.
//   'none' — left alone: a fragment shader with gl_DrawID fails to compile,
//     as in a browser (ANGLE declares gl_DrawID for the vertex stage only).
// Everything else passes through untouched. Identifiers starting with
// `webgl_` are reserved in WebGL, so neither name can clash with the game's.
export const DRAW_ID_UNIFORM = 'webgl_gl_DrawID'
export const DRAW_ID_ATTRIB = 'webgl_DrawID'

const ANGLE_EXT_LINE = /^[ \t]*#[ \t]*extension[ \t]+GL_ANGLE_multi_draw[^\n]*\n?/gm
const ANGLE_NAME = /\bGL_ANGLE_multi_draw\b/g
export const ANGLE_MACRO = 'webgl_ANGLE_multi_draw'
const DRAW_ID = /\bgl_DrawID\b/g
const DIRECTIVE = /^[ \t]*#[ \t]*(version|extension)\b/
const ESSL3 = /^[ \t]*#[ \t]*version[ \t]+3\d\d[ \t]+es\b/m
const VERTEX_SHADER = 0x8B31

// The mode a shader of `type` gets in a context whose gl_DrawID is the attribute (`attrib`) or the uniform.
export function drawIdMode(source, type, attrib) {
  if (!attrib) return 'uniform'
  if (type !== VERTEX_SHADER) return 'none'
  return ESSL3.test(source) ? 'attribute' : 'uniform'
}

// Uniform blocks: WebGL 2 has only the std140 layout (the spec: shared and packed are treated as std140), so a page
// fills a block's buffer at std140 offsets whatever it declared, without asking for them. GLES leaves a block without
// a layout qualifier `shared`, laid out as the driver likes: Adreno packs `vec3 a[2]` at a 12-byte stride where
// std140 pads to 16, so every later member was read from the wrong offset (Wonderland Engine's ViewUniforms: 472
// bytes instead of 480, its projection matrices garbage, nothing drawn on the Quest; ANGLE, the Mac's GL, lays
// `shared` out as std140 and hid it). Every block declaration, and a default `layout(...) uniform;`, gets std140
// in place of shared/packed or none, as a browser compiles it; one already std140 is left as it is. Declarations
// are rewritten where they stand, so a block inside an #if branch is covered too. ESSL 1.00 has no blocks.
const BLOCK_DECL = /\b(?:layout\s*\(([^)]*)\)\s*)?uniform(?:\s+([A-Za-z_]\w*)\s*\{|\s*;)/g
export function std140Blocks(source) {
  source = String(source)
  if (!ESSL3.test(source) || source.indexOf('uniform') < 0) return source
  return source.replace(BLOCK_DECL, (m, quals, block) => {
    if (block === undefined && quals === undefined) return m  // `uniform;` alone is not GLSL
    const tail = block === undefined ? 'uniform;' : m.slice(m.search(/\buniform\b/))
    if (quals === undefined) return 'layout(std140) ' + tail
    const q = quals.split(',').map(s => s.trim()).filter(Boolean)
    if (q.includes('std140')) return m
    const rest = q.filter(s => s !== 'shared' && s !== 'packed')
    return 'layout(' + ['std140', ...rest].join(', ') + ') ' + tail
  })
}

export function rewriteDrawId(source, mode = 'uniform') {
  source = String(source)
  const hasAngle = ANGLE_EXT_LINE.test(source); ANGLE_EXT_LINE.lastIndex = 0
  const uses = DRAW_ID.test(source); DRAW_ID.lastIndex = 0
  if (!hasAngle && !uses) return { source, usesDrawId: false, drawIdAttr: false }
  // ANGLE defines the GL_ANGLE_multi_draw macro when the extension is enabled; three's batching chunk
  // tests `#if !defined(GL_ANGLE_multi_draw)` to switch to its OWN per-draw uniform (_gl_DrawID) — which
  // it only sets when the WEBGL_multi_draw extension is absent. Without the macro that fallback shadowed
  // our uniform and every batched draw ran as draw 0 (the whole forest on one spot).
  // The macro cannot keep ANGLE's name: GLSL ES reserves every GL_ macro name, and Adreno refuses
  // `#define GL_...` ("name must not start with GL_"), which failed the whole shader. So the shader's own
  // tests of the macro are renamed to a reserved WebGL name and that one is defined in the extension's place.
  // Without the extension line the macro stays undefined, as in ANGLE, and nothing is renamed.
  let out = hasAngle ? source.replace(ANGLE_EXT_LINE, '#define ' + ANGLE_MACRO + ' 1\n').replace(ANGLE_NAME, ANGLE_MACRO) : source
  if (!uses || mode === 'none') return { source: out, usesDrawId: false, drawIdAttr: false }
  const attr = mode === 'attribute'
  const name = attr ? DRAW_ID_ATTRIB : DRAW_ID_UNIFORM
  out = out.replace(DRAW_ID, name)
  // Insert the declaration after the last #version / #extension line.
  const lines = out.split('\n')
  let at = 0
  for (let i = 0; i < lines.length; i++) if (DIRECTIVE.test(lines[i])) at = i + 1
  lines.splice(at, 0, (attr ? 'in highp int ' : 'uniform highp int ') + name + ';')
  return { source: lines.join('\n'), usesDrawId: true, drawIdAttr: attr }
}
