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

// Composite modes by number (canvas2d.js maps globalCompositeOperation onto them). 0 source-over, 1 copy (the source
// replaces the destination, so a transparent source clears it), 2 destination-out (the source alpha punches the
// destination; its colour does not matter); 3..7 the other Porter-Duff operators that leave the destination alone
// where the source is transparent; 8..11 the ones that clear it there (canvas2d.js draws those through a layer so
// the pixels the source does not cover are composited too); 12 and up the separable blend modes.
export const COMPOSITE_MODES = ['source-over', 'copy', 'destination-out', 'source-atop', 'destination-over', 'xor', 'lighter', 'plus-lighter',
  'source-in', 'source-out', 'destination-in', 'destination-atop',
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']
const MODE_BLEND_FIRST = 12
// The operators that also clear what the source does not cover (source-in, source-out, destination-in, destination-atop).
export const isUnbounded = (mode) => mode >= 8 && mode <= 11

// B(backdrop, source) of a separable blend mode, channels in 0..1.
function blendChannel(mode, cb, cs) {
  switch (mode) {
    case 12: return cb * cs
    case 13: return cb + cs - cb * cs
    case 14: return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)
    case 15: return Math.min(cb, cs)
    case 16: return Math.max(cb, cs)
    case 17: return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))
    case 18: return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)
    case 19: return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)
    case 20: { if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb); const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb); return cb + (2 * cs - 1) * (d - cb) }
    case 21: return Math.abs(cb - cs)
    default: return cb + cs - 2 * cb * cs
  }
}

// One pixel under a composite mode (see COMPOSITE_MODES); r, g, b, a are the straight-alpha source, a in 0..255.
// Kept small, source-over inline and the rest in compositeOther, so the per-pixel loops that call it (blit, spans,
// text) can inline it: whole, it ran a scaled drawImage ~40% slower.
export function compositePixel(dst, di, r, g, b, a, mode) {
  if (a > 254.999) a = 255   // a coverage-scaled alpha a hair under opaque is opaque
  if (mode === 0) { blendPixel(dst, di, r, g, b, a); return }
  compositeOther(dst, di, r, g, b, a, mode)
}
function compositeOther(dst, di, r, g, b, a, mode) {
  if (mode === 1) { dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = a >= 255 ? 255 : a <= 0 ? 0 : Math.round(a); return }
  if (mode === 2) {
    if (a <= 0) return
    dst[di + 3] = a >= 255 ? 0 : Math.round(dst[di + 3] * (1 - a / 255))
    return
  }
  const sa = a >= 255 ? 1 : a <= 0 ? 0 : a / 255, da = dst[di + 3] / 255
  if (mode >= MODE_BLEND_FIRST) {
    // The source colour is mixed with the blend of the two where the backdrop is opaque, then drawn source-over.
    if (sa <= 0) return
    if (da > 0) {
      r = r * (1 - da) + 255 * da * blendChannel(mode, dst[di] / 255, r / 255)
      g = g * (1 - da) + 255 * da * blendChannel(mode, dst[di + 1] / 255, g / 255)
      b = b * (1 - da) + 255 * da * blendChannel(mode, dst[di + 2] / 255, b / 255)
    }
    blendPixel(dst, di, Math.round(r), Math.round(g), Math.round(b), a)
    return
  }
  // Porter-Duff: out = Fa * source + Fb * destination, premultiplied.
  let fa, fb
  switch (mode) {
    case 3: fa = da; fb = 1 - sa; break            // source-atop
    case 4: fa = 1 - da; fb = 1; break             // destination-over
    case 5: fa = 1 - da; fb = 1 - sa; break        // xor
    case 6: case 7: fa = 1; fb = 1; break          // lighter
    case 8: fa = da; fb = 0; break                 // source-in
    case 9: fa = 1 - da; fb = 0; break             // source-out
    case 10: fa = 0; fb = sa; break                // destination-in
    default: fa = 1 - da; fb = sa; break           // destination-atop
  }
  const ks = sa * fa, kd = da * fb, oa = Math.min(1, ks + kd)
  if (oa <= 0) { dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0; return }
  dst[di] = Math.min(255, Math.round((r * ks + dst[di] * kd) / oa)); dst[di + 1] = Math.min(255, Math.round((g * ks + dst[di + 1] * kd) / oa)); dst[di + 2] = Math.min(255, Math.round((b * ks + dst[di + 2] * kd) / oa))
  dst[di + 3] = Math.round(oa * 255)
}

// Draws the source window (sx, sy, sw, sh) of src (srcW × srcH) onto the
// destination rect (dx, dy, dw, dh) of dst (dstW × dstH): nearest-neighbour,
// source-over, globalAlpha applied. Negative dw/dh mirror the picture.
// clip is a device rect [x0, y0, x1, y1] or a mask {kind:'mask', x, y, w, h, bits}; mode as compositePixel.
export function blit(dst, dstW, dstH, src, srcW, srcH, sx, sy, sw, sh, dx, dy, dw, dh, alpha, clip, mode = 0) {
  if (!(sw > 0) || !(sh > 0) || dw === 0 || dh === 0 || (!(alpha > 0) && mode !== 1)) return
  let mirrorX = false, mirrorY = false
  if (dw < 0) { dx += dw; dw = -dw; mirrorX = true }
  if (dh < 0) { dy += dh; dh = -dh; mirrorY = true }
  let x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(dstW, Math.ceil(dx + dw))
  let y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(dstH, Math.ceil(dy + dh))
  const mask = clip && clip.kind === 'mask' ? clip : null
  if (Array.isArray(clip)) { x0 = Math.max(x0, clip[0]); y0 = Math.max(y0, clip[1]); x1 = Math.min(x1, clip[2]); y1 = Math.min(y1, clip[3]) }
  if (x1 <= x0 || y1 <= y0) return
  // An unscaled, unmirrored copy at whole pixels, nothing masked: each row copied as it is (what compositePixel's
  // copy does pixel by pixel: the source bytes, its alpha included).
  if (mode === 1 && alpha >= 1 && !mask && !mirrorX && !mirrorY && dw === sw && dh === sh &&
      Number.isInteger(dx) && Number.isInteger(dy) && Number.isInteger(sx) && Number.isInteger(sy)) {
    const ox = sx - dx, oy = sy - dy
    const cx0 = Math.max(x0, -ox), cx1 = Math.min(x1, srcW - ox), cy0 = Math.max(y0, -oy), cy1 = Math.min(y1, srcH - oy)
    if (cx0 === x0 && cx1 === x1 && cy0 === y0 && cy1 === y1) {
      for (let py = y0; py < y1; py++) {
        const si = ((py + oy) * srcW + x0 + ox) * 4
        dst.set(src.subarray(si, si + (x1 - x0) * 4), (py * dstW + x0) * 4)
      }
      return
    }
  }
  for (let py = y0; py < y1; py++) {
    let v = (py + 0.5 - dy) / dh
    if (v < 0 || v >= 1) continue
    if (mirrorY) v = 1 - v
    const syy = Math.floor(sy + v * sh)
    if (syy < 0 || syy >= srcH) continue
    for (let px = x0; px < x1; px++) {
      if (mask && (px < mask.x || py < mask.y || px >= mask.x + mask.w || py >= mask.y + mask.h || !mask.bits[(py - mask.y) * mask.w + (px - mask.x)])) continue
      let u = (px + 0.5 - dx) / dw
      if (u < 0 || u >= 1) continue
      if (mirrorX) u = 1 - u
      const sxx = Math.floor(sx + u * sw)
      if (sxx < 0 || sxx >= srcW) continue
      const si = (syy * srcW + sxx) * 4
      const a = alpha >= 1 ? src[si + 3] : src[si + 3] * alpha
      compositePixel(dst, (py * dstW + px) * 4, src[si], src[si + 1], src[si + 2], a, mode)
    }
  }
}

// The CSS named colours, name:hex, unpacked on the first name looked up.
const NAMED_SRC = 'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:0ff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000,blanchedalmond:ffebcd,blue:00f,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:0ff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:f0f,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:789,lightslategrey:789,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:0f0,limegreen:32cd32,linen:faf0e6,magenta:f0f,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:639,red:f00,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:fff,whitesmoke:f5f5f5,yellow:ff0,yellowgreen:9acd32'
let NAMED = null
function namedColor(s) {
  if (!NAMED) {
    NAMED = new Map([['transparent', [0, 0, 0, 0]]])
    for (const pair of NAMED_SRC.split(',')) {
      const i = pair.indexOf(':'), hex = pair.slice(i + 1), wide = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex
      NAMED.set(pair.slice(0, i), [parseInt(wide.slice(0, 2), 16), parseInt(wide.slice(2, 4), 16), parseInt(wide.slice(4, 6), 16), 255])
    }
  }
  return NAMED.get(s)
}

function channel(s) {
  s = s.trim()
  if (s === 'none') return 0
  if (s.endsWith('%')) return Math.round(Math.min(100, Math.max(0, parseFloat(s))) * 2.55)
  const v = parseFloat(s)
  return Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : NaN
}
function alphaChannel(s) {
  s = s.trim()
  if (s === 'none') return 0
  const v = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
  return Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 255) : NaN
}
// A hue in degrees from a CSS angle (deg by default; rad, grad, turn).
function hueDegrees(s) {
  s = s.trim()
  if (s === 'none') return 0
  const v = parseFloat(s)
  return s.endsWith('grad') ? v * 0.9 : s.endsWith('rad') ? v * 180 / Math.PI : s.endsWith('turn') ? v * 360 : v
}
function percent(s) { s = s.trim(); return s === 'none' ? 0 : Math.min(1, Math.max(0, parseFloat(s) / 100)) }

// CSS colour → [r, g, b, a] with a in 0..255, or null when it is not one we read: #rgb #rgba #rrggbb #rrggbbaa,
// rgb()/rgba(), hsl()/hsla() and hwb() (comma or space syntax), the named colours, transparent.
export function parseColor(str) {
  if (typeof str !== 'string') return null
  const s = str.trim().toLowerCase()
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
  const m = /^(rgb|hsl|hwb)a?\(\s*(.*?)\s*\)$/.exec(s)
  if (!m) { const c = namedColor(s); return c ? c.slice() : null }
  let parts
  if (m[2].includes(',')) parts = m[2].split(',')
  else { const slash = m[2].split('/'); parts = slash[0].trim().split(/\s+/); if (slash[1] !== undefined) parts.push(slash[1]) }
  if (parts.length < 3 || parts.length > 4) return null
  const a = parts.length === 4 ? alphaChannel(parts[3]) : 255
  let r, g, b
  if (m[1] === 'rgb') { r = channel(parts[0]); g = channel(parts[1]); b = channel(parts[2]) }
  else {
    const h = ((hueDegrees(parts[0]) % 360) + 360) % 360
    let f
    if (m[1] === 'hsl') {
      const sat = percent(parts[1]), l = percent(parts[2]), k = sat * Math.min(l, 1 - l)
      f = (n) => { const t = (n + h / 30) % 12; return l - k * Math.max(-1, Math.min(t - 3, 9 - t, 1)) }
    } else {
      let w = percent(parts[1]), bl = percent(parts[2]); if (w + bl > 1) { const sum = w + bl; w /= sum; bl /= sum }
      f = (n) => { const t = (n + h / 30) % 12; return (0.5 - 0.5 * Math.max(-1, Math.min(t - 3, 9 - t, 1))) * (1 - w - bl) + w }
    }
    r = Math.round(f(0) * 255); g = Math.round(f(8) * 255); b = Math.round(f(4) * 255)
  }
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
