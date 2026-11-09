// pixelStorei emulation on the CPU: UNPACK_FLIP_Y_WEBGL and
// UNPACK_PREMULTIPLY_ALPHA_WEBGL are WebGL's, not GL's, so the wrapper applies
// them before the upload, into one scratch buffer grown to the largest upload
// seen (no allocation on a steady-state frame). UNPACK_COLORSPACE_CONVERSION_WEBGL
// is a no-op; UNPACK_ALIGNMENT / ROW_LENGTH / SKIP_* pass through to GL and are
// only read here to lay rows out the way GL will read them.
//
// Image sources (WP-05's convention, shared with images/): any object with
// numeric `width`, `height` and `__rgba` — a Uint8Array (or ArrayBuffer) of
// width * height * 4 bytes, top-down (bottom-up when `__rgbaBottomUp` is true:
// a secondary WebGL canvas's readback, GL's own row order), RGBA8, straight
// alpha unless `__premultiplied` is true. An ImageData-shaped `data` (Uint8ClampedArray)
// is accepted as a fallback. The rows are converted to the requested format
// (RGBA / RGB / RG / RED / LUMINANCE / LUMINANCE_ALPHA / ALPHA, UNSIGNED_BYTE
// only — any other type is uploaded as RGBA8 with the caller's internalformat
// and left for GL to accept or refuse).
import { GL } from './constants.gen.js'

const COMPONENTS = new Map([
  [GL.RGBA, 4], [GL.RGBA_INTEGER, 4], [GL.RGB, 3], [GL.RGB_INTEGER, 3], [GL.RG, 2], [GL.RG_INTEGER, 2],
  [GL.RED, 1], [GL.RED_INTEGER, 1], [GL.ALPHA, 1], [GL.LUMINANCE, 1], [GL.LUMINANCE_ALPHA, 2],
  [GL.DEPTH_COMPONENT, 1], [GL.DEPTH_STENCIL, 1],
])
const COMPONENT_BYTES = new Map([
  [GL.UNSIGNED_BYTE, 1], [GL.BYTE, 1], [GL.UNSIGNED_SHORT, 2], [GL.SHORT, 2], [GL.HALF_FLOAT, 2],
  [GL.UNSIGNED_INT, 4], [GL.INT, 4], [GL.FLOAT, 4],
])
const PACKED_BYTES = new Map([
  [GL.UNSIGNED_SHORT_5_6_5, 2], [GL.UNSIGNED_SHORT_4_4_4_4, 2], [GL.UNSIGNED_SHORT_5_5_5_1, 2],
  [GL.UNSIGNED_INT_2_10_10_10_REV, 4], [GL.UNSIGNED_INT_10F_11F_11F_REV, 4], [GL.UNSIGNED_INT_5_9_9_9_REV, 4],
  [GL.UNSIGNED_INT_24_8, 4], [GL.FLOAT_32_UNSIGNED_INT_24_8_REV, 8],
])

// Bytes per pixel for a (format, type) pair; 0 when unknown (then rows cannot be flipped).
export function bytesPerPixel(format, type) {
  const packed = PACKED_BYTES.get(type)
  if (packed !== undefined) return packed
  const c = COMPONENTS.get(format), b = COMPONENT_BYTES.get(type)
  return c !== undefined && b !== undefined ? c * b : 0
}

export function isArrayBufferish(v) {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)
}

// Anything texImage2D may take that is not a typed array, a PBO offset or null.
export function isImageSource(v) {
  return typeof v === 'object' && v !== null && !isArrayBufferish(v) &&
    typeof v.width === 'number' && typeof v.height === 'number' && ('__rgba' in v || v.data != null)  // `in`, not a read: a WebGL canvas's __rgba is a getter that reads the whole drawing buffer back
}

export class UploadScratch {
  constructor() { this.buf = null }
  get(bytes) {
    if (!this.buf || this.buf.byteLength < bytes) this.buf = new Uint8Array(Math.max(bytes, this.buf ? this.buf.byteLength * 2 : 4096))
    return this.buf
  }
}

function alignUp(n, a) { return a > 1 ? (n + a - 1) & ~(a - 1) : n }

// Premultiplies RGBA8 pixels in place over [0, bytes).
function premultiplyRGBA8(buf, bytes) {
  for (let i = 0; i + 3 < bytes; i += 4) {
    const a = buf[i + 3]
    if (a === 255) continue
    if (a === 0) { buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; continue }
    buf[i] = (buf[i] * a + 127) / 255 | 0; buf[i + 1] = (buf[i + 1] * a + 127) / 255 | 0; buf[i + 2] = (buf[i + 2] * a + 127) / 255 | 0
  }
}

// A typed-array upload. `state` is the wrapper's pixel-store state. Returns
// { data, srcOffset } to hand to the native call — the caller's own view and
// offset when nothing applies (no copy), else a window of the scratch buffer.
export function prepareTypedUpload(state, pixels, srcOffset, width, height, format, type, scratch) {
  const flip = state.flipY && height > 1
  const premul = state.premultiply && format === GL.RGBA && type === GL.UNSIGNED_BYTE
  if (!flip && !premul) return { data: pixels, srcOffset }
  if (state.skipPixels || state.skipRows || state.skipImages) return { data: pixels, srcOffset }  // sub-rectangle layouts pass through
  const bpp = bytesPerPixel(format, type)
  if (!bpp) return { data: pixels, srcOffset }
  const elemBytes = pixels.BYTES_PER_ELEMENT || 1
  const byteOffset = (pixels.byteOffset || 0) + (srcOffset | 0) * elemBytes
  const avail = pixels.byteLength - (srcOffset | 0) * elemBytes
  if (avail <= 0) return { data: pixels, srcOffset }
  const stride = state.rowLength > 0 ? state.rowLength : width
  const rowBytes = alignUp(stride * bpp, state.alignment)
  const rows = Math.min(height, Math.floor((avail - (stride - width) * bpp) / rowBytes) + (avail >= rowBytes ? 0 : 0))
  const total = rowBytes * height
  if (rows < height) return { data: pixels, srcOffset }  // short source: let GL report it
  const src = new Uint8Array(pixels.buffer, byteOffset, Math.min(avail, total))
  const out = scratch.get(total)
  if (flip) {
    for (let r = 0; r < height; r++) {
      const s = (height - 1 - r) * rowBytes, d = r * rowBytes
      const n = Math.min(rowBytes, src.byteLength - s)
      if (n > 0) out.set(src.subarray(s, s + n), d)
    }
  } else out.set(src.subarray(0, total), 0)
  if (premul) premultiplyRGBA8(out, total)
  return { data: out.subarray(0, total), srcOffset: 0 }
}

function sourcePixels(source) {
  let p = source.__rgba  // read ONCE: a WebGL canvas's __rgba is a readback
  if (p == null) p = source.data
  if (p instanceof ArrayBuffer) p = new Uint8Array(p)
  else if (ArrayBuffer.isView(p) && !(p instanceof Uint8Array)) p = new Uint8Array(p.buffer, p.byteOffset, p.byteLength)
  if (!(p instanceof Uint8Array) || p.byteLength < source.width * source.height * 4) return null
  return p
}

// An image-source upload. Returns { data, width, height, format, type } for the native call, or null when the source carries no pixels.
export function prepareImageUpload(state, source, format, type, scratch, warn) {
  const w = source.width | 0, h = source.height | 0
  const src = sourcePixels(source)
  if (!src) return null
  if (type !== GL.UNSIGNED_BYTE) {
    if (warn) warn('texImage2D: image source uploaded as RGBA/UNSIGNED_BYTE (asked for type 0x' + type.toString(16) + ')')
    format = GL.RGBA; type = GL.UNSIGNED_BYTE
  }
  let comps = COMPONENTS.get(format)
  if (comps === undefined || format === GL.RGBA_INTEGER || format === GL.RGB_INTEGER || format === GL.RG_INTEGER || format === GL.RED_INTEGER ||
      format === GL.DEPTH_COMPONENT || format === GL.DEPTH_STENCIL) { format = GL.RGBA; comps = 4 }
  const premul = state.premultiply && !source.__premultiplied
  // Rows already bottom-up are what flipY asks for: flip only when the two disagree (none for three's flipY=true).
  const flip = h > 1 && !!state.flipY !== !!source.__rgbaBottomUp
  if (format === GL.RGBA && !premul && !flip && ((w * 4) % state.alignment) === 0) {
    return { data: src.byteLength === w * h * 4 ? src : src.subarray(0, w * h * 4), width: w, height: h, format, type }
  }
  const rowBytes = alignUp(w * comps, state.alignment)
  const total = rowBytes * h
  const out = scratch.get(total)
  for (let y = 0; y < h; y++) {
    let s = (flip ? h - 1 - y : y) * w * 4
    let d = y * rowBytes
    if (format === GL.RGBA) {
      if (!premul) { out.set(src.subarray(s, s + w * 4), d); continue }
      for (let x = 0; x < w; x++, s += 4, d += 4) {
        const a = src[s + 3]
        if (a === 255) { out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2] }
        else { out[d] = (src[s] * a + 127) / 255 | 0; out[d + 1] = (src[s + 1] * a + 127) / 255 | 0; out[d + 2] = (src[s + 2] * a + 127) / 255 | 0 }
        out[d + 3] = a
      }
    } else if (format === GL.RGB) {
      for (let x = 0; x < w; x++, s += 4, d += 3) {
        const a = premul ? src[s + 3] : 255
        if (a === 255) { out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2] }
        else { out[d] = (src[s] * a + 127) / 255 | 0; out[d + 1] = (src[s + 1] * a + 127) / 255 | 0; out[d + 2] = (src[s + 2] * a + 127) / 255 | 0 }
      }
    } else if (format === GL.RG) {
      for (let x = 0; x < w; x++, s += 4, d += 2) {
        const a = premul ? src[s + 3] : 255
        out[d] = a === 255 ? src[s] : (src[s] * a + 127) / 255 | 0
        out[d + 1] = a === 255 ? src[s + 1] : (src[s + 1] * a + 127) / 255 | 0
      }
    } else if (format === GL.LUMINANCE_ALPHA) {
      for (let x = 0; x < w; x++, s += 4, d += 2) {
        const a = src[s + 3]
        out[d] = premul && a !== 255 ? (src[s] * a + 127) / 255 | 0 : src[s]
        out[d + 1] = a
      }
    } else if (format === GL.ALPHA) {
      for (let x = 0; x < w; x++, s += 4, d += 1) out[d] = src[s + 3]
    } else {  // LUMINANCE, RED
      for (let x = 0; x < w; x++, s += 4, d += 1) {
        const a = premul ? src[s + 3] : 255
        out[d] = a === 255 ? src[s] : (src[s] * a + 127) / 255 | 0
      }
    }
  }
  return { data: out.subarray(0, total), width: w, height: h, format, type }
}
