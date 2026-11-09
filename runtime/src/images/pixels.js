// Pixel helpers shared by the images module. Every buffer is RGBA8, rows
// TOP-DOWN, straight alpha unless a caller says it premultiplied it.

export function flipRows(rgba, w, h) {
  const row = w * 4
  const tmp = new Uint8Array(row)
  for (let y = 0, n = h >> 1; y < n; y++) {
    const a = y * row, b = (h - 1 - y) * row
    tmp.set(rgba.subarray(a, a + row))
    rgba.copyWithin(a, b, b + row)
    rgba.set(tmp, b)
  }
  return rgba
}

export function premultiply(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 255) continue
    if (a === 0) { rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; continue }
    rgba[i] = (rgba[i] * a + 127) / 255 | 0
    rgba[i + 1] = (rgba[i + 1] * a + 127) / 255 | 0
    rgba[i + 2] = (rgba[i + 2] * a + 127) / 255 | 0
  }
  return rgba
}

// A w × h window of src at (sx, sy); pixels outside the source are transparent black.
export function crop(src, sw, sh, sx, sy, w, h) {
  const out = new Uint8Array(w * h * 4)
  const x0 = Math.max(0, sx), x1 = Math.min(sw, sx + w)
  if (x1 <= x0) return out
  const span = (x1 - x0) * 4
  for (let y = Math.max(0, sy), yEnd = Math.min(sh, sy + h); y < yEnd; y++) {
    const from = (y * sw + x0) * 4
    out.set(src.subarray(from, from + span), ((y - sy) * w + (x0 - sx)) * 4)
  }
  return out
}

export function scaleNearest(src, sw, sh, nw, nh) {
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / nh))
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / nw))
      const si = (sy * sw + sx) * 4, di = (y * nw + x) * 4
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
    }
  }
  return out
}

// Source-over of a straight-alpha colour (a in 0..255) onto dst at byte index di.
export function blendPixel(dst, di, r, g, b, a) {
  if (a <= 0) return
  if (a >= 255) { dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255; return }
  const da = dst[di + 3]
  if (da === 0) { dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = a; return }
  const sa = a / 255, ia = 1 - sa, oa = sa + (da / 255) * ia
  const k = (da / 255) * ia
  dst[di] = Math.round((r * sa + dst[di] * k) / oa)
  dst[di + 1] = Math.round((g * sa + dst[di + 1] * k) / oa)
  dst[di + 2] = Math.round((b * sa + dst[di + 2] * k) / oa)
  dst[di + 3] = Math.round(oa * 255)
}

// Draws the source window (sx, sy, sw, sh) of src (srcW × srcH) onto the
// destination rect (dx, dy, dw, dh) of dst (dstW × dstH): nearest-neighbour,
// source-over, globalAlpha applied. Negative dw/dh mirror the picture.
export function blit(dst, dstW, dstH, src, srcW, srcH, sx, sy, sw, sh, dx, dy, dw, dh, alpha) {
  if (!(sw > 0) || !(sh > 0) || dw === 0 || dh === 0 || !(alpha > 0)) return
  let mirrorX = false, mirrorY = false
  if (dw < 0) { dx += dw; dw = -dw; mirrorX = true }
  if (dh < 0) { dy += dh; dh = -dh; mirrorY = true }
  const x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(dstW, Math.ceil(dx + dw))
  const y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(dstH, Math.ceil(dy + dh))
  for (let py = y0; py < y1; py++) {
    let v = (py + 0.5 - dy) / dh
    if (v < 0 || v >= 1) continue
    if (mirrorY) v = 1 - v
    const syy = Math.floor(sy + v * sh)
    if (syy < 0 || syy >= srcH) continue
    for (let px = x0; px < x1; px++) {
      let u = (px + 0.5 - dx) / dw
      if (u < 0 || u >= 1) continue
      if (mirrorX) u = 1 - u
      const sxx = Math.floor(sx + u * sw)
      if (sxx < 0 || sxx >= srcW) continue
      const si = (syy * srcW + sxx) * 4
      const a = alpha >= 1 ? src[si + 3] : src[si + 3] * alpha
      blendPixel(dst, (py * dstW + px) * 4, src[si], src[si + 1], src[si + 2], a)
    }
  }
}

const NAMED = {
  black: [0, 0, 0, 255], white: [255, 255, 255, 255], transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 255], green: [0, 128, 0, 255], lime: [0, 255, 0, 255], blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255], cyan: [0, 255, 255, 255], aqua: [0, 255, 255, 255], magenta: [255, 0, 255, 255],
  fuchsia: [255, 0, 255, 255], gray: [128, 128, 128, 255], grey: [128, 128, 128, 255], silver: [192, 192, 192, 255],
  orange: [255, 165, 0, 255], purple: [128, 0, 128, 255], navy: [0, 0, 128, 255], maroon: [128, 0, 0, 255],
}

function channel(s) {
  s = s.trim()
  if (s.endsWith('%')) return Math.round(Math.min(100, Math.max(0, parseFloat(s))) * 2.55)
  const v = parseFloat(s)
  return Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : NaN
}
function alphaChannel(s) {
  s = s.trim()
  const v = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
  return Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 255) : NaN
}

// CSS colour → [r, g, b, a] with a in 0..255, or null when it is not one we read:
// #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() (comma or space syntax), a few names.
export function parseColor(str) {
  if (typeof str !== 'string') return null
  const s = str.trim().toLowerCase()
  if (s in NAMED) return NAMED[s].slice()
  if (s[0] === '#') {
    const hex = s.slice(1)
    if (!/^[0-9a-f]+$/.test(hex)) return null
    if (hex.length === 3 || hex.length === 4) {
      const c = [...hex].map(ch => parseInt(ch + ch, 16))
      return [c[0], c[1], c[2], hex.length === 4 ? c[3] : 255]
    }
    if (hex.length === 6 || hex.length === 8) {
      const c = [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16))
      return [c[0], c[1], c[2], hex.length === 8 ? c[3] : 255]
    }
    return null
  }
  const m = /^rgba?\(\s*(.*?)\s*\)$/.exec(s)
  if (!m) return null
  let parts
  if (m[1].includes(',')) parts = m[1].split(',')
  else { const slash = m[1].split('/'); parts = slash[0].trim().split(/\s+/); if (slash[1] !== undefined) parts.push(slash[1]) }
  if (parts.length < 3 || parts.length > 4) return null
  const r = channel(parts[0]), g = channel(parts[1]), b = channel(parts[2])
  const a = parts.length === 4 ? alphaChannel(parts[3]) : 255
  if ([r, g, b, a].some(Number.isNaN)) return null
  return [r, g, b, a]
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Encode(bytes) {
  let out = ''
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0, b2 = i + 2 < n ? bytes[i + 2] : 0
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < n ? B64[b2 & 63] : '='
  }
  return out
}

export function base64Decode(str) {
  const clean = str.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let o = 0, acc = 0, bits = 0
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]); bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255 }
  }
  return o === out.length ? out : out.subarray(0, o)
}

// data:[<mime>][;base64],<payload> → { mime, bytes } or null.
export function decodeDataUrl(url) {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url)
  if (!m) return null
  const mime = m[1].split(';')[0] || 'text/plain'
  if (m[2]) return { mime, bytes: base64Decode(m[3]) }
  const text = decodeURIComponent(m[3])
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255
  return { mime, bytes }
}

export function domError(g, name, message) {
  const E = (g && g.DOMException) || globalThis.DOMException
  if (typeof E === 'function') { try { return new E(message, name) } catch {} }
  const e = new Error(message); e.name = name; return e
}

// Promise of { width, height, rgba: Uint8Array, premultiplied: false } for PNG/JPEG bytes,
// through __native.img.decode (off-thread in the host; a test's fake may answer inline).
export function decodeBytes(g, bytes) {
  return new Promise((resolve, reject) => {
    const img = g.__native && g.__native.img
    if (!img || typeof img.decode !== 'function') return reject(domError(g, 'InvalidStateError', 'image decoding is unavailable (__native.img.decode missing)'))
    let done = false
    try {
      img.decode(bytes, (w, h, rgba, err) => {
        if (done) return
        done = true
        if (!rgba || !(w > 0) || !(h > 0)) return reject(domError(g, 'InvalidStateError', 'The source image could not be decoded' + (err ? ': ' + err : '')))
        resolve({ width: w, height: h, rgba: rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba), premultiplied: false })
      })
    } catch (e) { if (!done) { done = true; reject(e) } }
  })
}

export function encodePngBytes(g, w, h, rgba) {
  const img = g.__native && g.__native.img
  if (!img || typeof img.encodePng !== 'function') throw new Error('PNG encoding is unavailable (__native.img.encodePng missing)')
  const out = img.encodePng(w, h, rgba)
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

export function isBlobLike(v) {
  return !!v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number'
}
