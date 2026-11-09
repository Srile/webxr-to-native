// WEBGL_multi_draw as real indirect draws (GL_EXT_multi_draw_indirect + GL_EXT_base_instance):
// one glMultiDraw*IndirectEXT per call instead of the native per-draw loop.
//
// The commands are built here, in a grow-only Uint32Array, straight from the
// game's lists (Int32Array or Array, read in place — never converted), and
// handed to the native side, which copies them into its indirect ring and
// draws (host/gl/webgl_bind.cpp, "multi-draw indirect").
//
// gl_DrawID: a program whose vertex shader uses it declares the integer
// attribute webgl_DrawID (shader-rewrite.js) bound to the reserved location
// the native side picked (MAX_VERTEX_ATTRIBS - 1, hidden from the game). It
// reads a host buffer of 0..N-1 with divisor 1, so baseInstance = i gives i.
// The native side points the attribute at that buffer once per VAO
// (FLAG_SETUP the first time this VAO is used) and enables the array only for
// the indirect call; otherwise it reads its constant current value, 0 (or i
// inside the native loop), so plain draws with the same program see draw 0.
//
// When the native loop is taken instead (returns false):
//   - no VAO bound (ES 3.1 indirect draws need one),
//   - the program has the gl_DrawID UNIFORM (an ESSL 1.00 vertex shader),
//   - gl_DrawID is used and the VAO has an array with a non-zero divisor of the
//     game's (baseInstance would shift it), or it is an instanced variant
//     (instance k would read k + i),
//   - anything the loop reports as an error: a list that is not an Int32Array /
//     Array or is too short, a negative count / first / offset, an element
//     offset not a multiple of the index size, an unknown index type.
export const DRAW_ID_LOC_ATTRIB = -2   // program._drawIdLoc: gl_DrawID is the attribute
export const FLAG_DRAW_ID = 1          // enable the draw-id attribute for this call
export const FLAG_SETUP = 2            // point the draw-id attribute of the bound VAO at the id buffer first

const isList = (l) => l instanceof Int32Array || Array.isArray(l)

export class MultiDrawIndirect {
  constructor(N) {
    this.N = N
    // The reserved attribute location, or -1: no indirect path (no extensions, or host.json gl.multiDrawIndirect false).
    this.attrib = typeof N.multiDrawInfo === 'function' ? (N.multiDrawInfo() | 0) : -1
    // Indirect calls on (true) or the native loop with the same attribute (false): the gl-bench switch.
    this.enabled = this.attrib >= 0
    this.cmds = new Uint32Array(5 * 256)
  }
  _room(words) {
    let c = this.cmds
    if (c.length < words) { let n = c.length; while (n < words) n *= 2; c = this.cmds = new Uint32Array(n) }
    return c
  }
  // Common gate. Returns 0 = take the loop, else FLAG_* | 4 (4 = go, no draw id).
  _gate(vao, loc, instanced, drawcount) {
    if (!this.enabled || vao === null || drawcount <= 0) return 0
    if (loc === -1) return 4
    if (loc !== DRAW_ID_LOC_ATTRIB || instanced || vao._divMask !== 0) return 0
    return 4 | FLAG_DRAW_ID | (vao._mdReady ? 0 : FLAG_SETUP)
  }
  // (mode, counts, countsOffset, type, offsets, offsetsOffset, instanceCounts|null, instOffset, drawcount) → drawn?
  elements(vao, loc, mode, counts, co, type, offsets, oo, inst, io, drawcount) {
    const g = this._gate(vao, loc, inst !== null, drawcount)
    if (g === 0) return false
    const shift = type === 0x1403 ? 1 : type === 0x1405 ? 2 : type === 0x1401 ? 0 : -1   // UNSIGNED_SHORT, UNSIGNED_INT, UNSIGNED_BYTE
    if (shift < 0 || !isList(counts) || !isList(offsets) || co < 0 || oo < 0 || co + drawcount > counts.length || oo + drawcount > offsets.length) return false
    if (inst !== null && (!isList(inst) || io < 0 || io + drawcount > inst.length)) return false
    const mask = (1 << shift) - 1, id = (g & FLAG_DRAW_ID) !== 0
    const c = this._room(drawcount * 5)
    for (let i = 0, w = 0; i < drawcount; i++, w += 5) {
      const n = counts[co + i] | 0, off = offsets[oo + i] | 0
      const k = inst === null ? 1 : inst[io + i] | 0
      if (n < 0 || off < 0 || (off & mask) !== 0 || k < 0) return false
      c[w] = n; c[w + 1] = k; c[w + 2] = off >>> shift; c[w + 3] = 0; c[w + 4] = id ? i : 0   // count, instanceCount, firstIndex, baseVertex, baseInstance
    }
    this.N.multiDrawElementsIndirect(mode >>> 0, type >>> 0, c, drawcount, g & 3)
    if (id) vao._mdReady = true
    return true
  }
  // (mode, firsts, firstsOffset, counts, countsOffset, instanceCounts|null, instOffset, drawcount) → drawn?
  arrays(vao, loc, mode, firsts, fo, counts, co, inst, io, drawcount) {
    const g = this._gate(vao, loc, inst !== null, drawcount)
    if (g === 0) return false
    if (!isList(firsts) || !isList(counts) || fo < 0 || co < 0 || fo + drawcount > firsts.length || co + drawcount > counts.length) return false
    if (inst !== null && (!isList(inst) || io < 0 || io + drawcount > inst.length)) return false
    const id = (g & FLAG_DRAW_ID) !== 0
    const c = this._room(drawcount * 4)
    for (let i = 0, w = 0; i < drawcount; i++, w += 4) {
      const f = firsts[fo + i] | 0, n = counts[co + i] | 0
      const k = inst === null ? 1 : inst[io + i] | 0
      if (n < 0 || f < 0 || k < 0) return false
      c[w] = n; c[w + 1] = k; c[w + 2] = f; c[w + 3] = id ? i : 0   // count, instanceCount, first, baseInstance
    }
    this.N.multiDrawArraysIndirect(mode >>> 0, c, drawcount, g & 3)
    if (id) vao._mdReady = true
    return true
  }
}
