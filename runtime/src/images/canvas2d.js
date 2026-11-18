// HTMLCanvasElement / OffscreenCanvas over a CPU RGBA8 buffer (`__rgba`), and
// Canvas 2D for what uikit, the MSDF generator, three's texture resizing and a
// canvas-texture UI draw: the full affine transform (rotated icons and text),
// CSS colours, paths with dashes and joins, rounded rects, gradients, clips,
// the composite operators (tints) and shadows; path fills and strokes are
// antialiased (clip masks are not). getContext('webgl2'|'webgl') on the FIRST
// canvas hands out the host's one GL context through g.__hostCreateWebGLContext (WP-04).
import { base64Encode, blit, compositePixel, COMPOSITE_MODES, domError, encodePngBytes, flipRows, isUnbounded, parseColor } from './pixels.js'

const DEFAULT_W = 300, DEFAULT_H = 150

function elementStyle(g) {
  if (typeof g.CSSStyleDeclaration === 'function') return new g.CSSStyleDeclaration()
  const s = {}
  s.setProperty = (k, v) => { s[k] = String(v ?? '') }
  s.removeProperty = (k) => { const v = s[k] ?? ''; delete s[k]; return String(v) }
  s.getPropertyValue = (k) => s[k] ?? ''
  return s
}
export function makeCanvas(g, { EventTargetBase, ImageData, ImageBitmap, newBitmap, warnOnce, defer, fonts }) {
  let glOwner = null

  function toSize(v, fallback) {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.min(Math.floor(n), 32767)
  }

  // RGBA pixels of a drawImage source (its size is image.width x image.height), or null when it
  // has none yet (an Image still loading). `__rgba` is read exactly ONCE: on a secondary WebGL
  // canvas it is a getter that does a full readback and two context switches.
  function sourcePixels(image) {
    if (image === null || image === undefined || typeof image !== 'object') throw new TypeError('drawImage: the source is not an image')
    if (image instanceof ImageBitmap) {
      const px = image.__rgba
      if (!px) throw domError(g, 'InvalidStateError', 'drawImage: the ImageBitmap is closed')
      return px
    }
    if (image.__imageState === 'error') throw domError(g, 'InvalidStateError', 'drawImage: the image is broken')
    if (image.__imageState === 'loading' || image.__imageState === 'empty') return null
    const px = image.__rgba
    if (px instanceof Uint8Array && typeof image.width === 'number' && typeof image.height === 'number') return px
    if (px === null && '__gl' in image) throw domError(g, 'InvalidStateError', 'drawImage: a WebGL canvas has no readable pixels')
    throw new TypeError('drawImage: unsupported source type')
  }

  // A CSS colour string -> frozen [r, g, b, a] (or null), cached: uikit and the MSDF generator set
  // the same few fillStyles over and over. Bounded; cleared wholesale when full.
  const colourCache = new Map()
  function colour(str) {
    let c = colourCache.get(str)
    if (c === undefined) {
      c = parseColor(str); if (c) Object.freeze(c)
      if (colourCache.size >= 256) colourCache.clear()
      colourCache.set(str, c)
    }
    return c
  }

  // Rasteriser scratch, grow-only and shared by every context (JS is single-threaded):
  // edges are 5 doubles each (x0, y0, x1, y1, winding), crossings an x and a winding per entry.
  let edgeBuf = new Float64Array(5 * 256), xsBuf = new Float64Array(64), wsBuf = new Float64Array(64), covBuf = new Float32Array(258), difBuf = new Float32Array(258)   // a pixel row's coverage (scanFill)
  let orderBuf = new Int32Array(256), activeBuf = new Int32Array(256)   // edge offsets by top, and the ones a scanline crosses
  let touchBuf = new Int32Array(64)   // the cov/dif columns a pixel row's crossings wrote (scanFill)
  const gradPx = new Float64Array(4)   // a gradient colour at one pixel
  // Text scratch (__native.img.textMeasure / textRaster): metrics, a glyph-run coverage mask and its box.
  const textMetrics = new Float64Array(7), textBox = new Int32Array(5), emBox = new Float64Array(2)
  let textAlpha = new Uint8Array(64 * 1024)
  let textRgba = new Uint8Array(0)   // colour emoji (textBox[4]): RGBA, straight alpha, grown when text has any
  let boldA = new Uint8Array(0), boldT = new Uint8Array(0), boldRgba = new Uint8Array(0)

  // Rasterised text, kept by everything that shapes it (face, size, scale, quarter-pixel phase, weight, the string):
  // a menu repainting a hovered button draws the same labels again, and a raster (and its synthetic bold) costs far
  // more than a copy. At most 256 entries and 4 MB of coverage, the least recently used dropped first.
  const textCache = new Map()
  let textCacheBytes = 0
  const cacheGet = (key) => { const e = textCache.get(key); if (e) { textCache.delete(key); textCache.set(key, e) } return e }
  const cachePut = (key, e) => {
    textCache.set(key, e); textCacheBytes += e.A.length + (e.RGBA ? e.RGBA.length : 0)
    while (textCache.size > 256 || textCacheBytes > 4 << 20) {
      const [k, old] = textCache.entries().next().value
      textCache.delete(k); textCacheBytes -= old.A.length + (old.RGBA ? old.RGBA.length : 0)
    }
  }
  // Synthetic bold for a face that has no heavier weight (the platform's): the coverage dilated by r device pixels
  // (whole rings, then the fraction of one more), padded so nothing is cut off. Colour emoji are padded, not grown.
  function embolden(a, w, h, r, rgba) {
    const full = Math.floor(r), frac = r - full, R = full + (frac > 0 ? 1 : 0), W = w + 2 * R, H = h + 2 * R, n = W * H
    if (boldA.length < n) { boldA = new Uint8Array(n); boldT = new Uint8Array(n) }
    const P = boldA, T = boldT
    P.fill(0, 0, n)
    for (let y = 0; y < h; y++) P.set(a.subarray(y * w, y * w + w), (y + R) * W + R)
    const pass = (src, dst, step, len, lines, lineStep) => {
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep
        for (let i = 0; i < len; i++) {
          let m = 0
          const k0 = i - full < 0 ? 0 : i - full, k1 = i + full >= len ? len - 1 : i + full
          for (let j = k0, o = base + k0 * step; j <= k1; j++, o += step) { const v = src[o]; if (v > m) m = v }
          if (frac > 0 && m < 255) {
            const l0 = i - full - 1, l1 = i + full + 1
            if (l0 >= 0) { const v = src[base + l0 * step] * frac; if (v > m) m = v }
            if (l1 < len) { const v = src[base + l1 * step] * frac; if (v > m) m = v }
          }
          dst[base + i * step] = m
        }
      }
    }
    pass(P, T, 1, W, H, W)   // rows
    pass(T, P, W, H, W, 1)   // columns
    let out = null
    if (rgba) {
      if (boldRgba.length < n * 4) boldRgba = new Uint8Array(n * 4)
      out = boldRgba; out.fill(0, 0, n * 4)
      for (let y = 0; y < h; y++) out.set(rgba.subarray(y * w * 4, (y * w + w) * 4), ((y + R) * W + R) * 4)
    }
    return { a: P, rgba: out, w: W, h: H, pad: R }
  }
  // A run's raster at scale (sx, sy) with its pen at (qx, qy) inside its first pixel: from the cache, or rastered
  // (synthetic bold applied) and kept. { w, h, bx, by: the box from the pen's whole pixel, A: coverage, RGBA: colour
  // emoji or null }, or null when nothing inks.
  function textEntry(n, f, spacing, sx, sy, qx, qy, text) {
    const key = `${f.id}|${f.fallback}|${f.px}|${spacing}|${sx}|${sy}|${qx}|${qy}|${f.bold || 0}|${text}`
    let entry = cacheGet(key)
    if (entry) return entry
    if (!n.textRaster(f.id, f.fallback, f.px, spacing, sx, sy, qx, qy, text, textAlpha, textBox, textRgba)) {
      const need = textBox[0] * textBox[1], colour = textBox[4] === 1
      if (need <= textAlpha.length && (!colour || need * 4 <= textRgba.length)) return null   // nothing inked
      if (need > textAlpha.length) textAlpha = new Uint8Array(Math.max(need, textAlpha.length * 2))
      if (colour && need * 4 > textRgba.length) textRgba = new Uint8Array(Math.max(need * 4, textRgba.length * 2))
      if (!n.textRaster(f.id, f.fallback, f.px, spacing, sx, sy, qx, qy, text, textAlpha, textBox, textRgba)) return null
    }
    let w = textBox[0], h = textBox[1], bx = textBox[2], by = textBox[3], A = textAlpha, RGBA = textRgba
    const colour = textBox[4] === 1
    // A weight the face doesn't have (600 on the platform's regular face): grown by about 3.5% of the em at bold.
    if (f.bold > 0) {
      const r = f.bold * f.px * sy * 0.035
      if (r >= 0.2) { const b = embolden(A, w, h, r, colour ? RGBA : null); A = b.a; RGBA = b.rgba || RGBA; bx -= b.pad; by -= b.pad; w = b.w; h = b.h }
    }
    entry = { w, h, bx, by, A: A.slice(0, w * h), RGBA: colour ? RGBA.slice(0, w * h * 4) : null }
    cachePut(key, entry)
    return entry
  }
  // Bilinear sample of a w x h coverage (stride 1) or RGBA (stride 4, channel ch) buffer at (x, y), pixel centres on
  // whole numbers; 0 outside.
  function sampleAt(buf, w, h, x, y, stride = 1, ch = 0) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
    const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : buf[(j * w + i) * stride + ch])
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
  let textNative = null, textFace = null, textSpacing = 0   // set by __textSetup for the call that follows it
  const clampPx = new Uint8ClampedArray(4)   // rounds/clamps a filtered pixel exactly as a Uint8ClampedArray store does
  // A canvas's pixels as 32-bit words, for filling opaque spans a pixel at a time.
  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
  const wordViews = new WeakMap()
  const words = (buf) => {
    let w = wordViews.get(buf)
    if (!w) { w = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2); wordViews.set(buf, w) }
    return w
  }

  // Source-over of one constant colour (a in 0..255, fractional allowed) over buf[i, end):
  // blendPixel inlined over a span, byte-identical to it.
  function blendSpan(buf, i, end, r, gg, b, a) {
    if (a <= 0) return
    if (end - i >= 32 && (a >= 255 || buf[i + 3] === 0) && (i = wordRun(buf, i, end, r, gg, b, a)) >= end) return
    if (a >= 255) { for (; i < end; i += 4) { buf[i] = r; buf[i + 1] = gg; buf[i + 2] = b; buf[i + 3] = 255 } return }
    const sa = a / 255, ia = 1 - sa, rs = r * sa, gs = gg * sa, bs = b * sa
    for (; i < end; i += 4) {
      const da = buf[i + 3]
      if (da === 0) { buf[i] = r; buf[i + 1] = gg; buf[i + 2] = b; buf[i + 3] = a; continue }
      const k = (da / 255) * ia, oa = sa + k
      buf[i] = Math.round((rs + buf[i] * k) / oa)
      buf[i + 1] = Math.round((gs + buf[i + 1] * k) / oa)
      buf[i + 2] = Math.round((bs + buf[i + 2] * k) / oa)
      buf[i + 3] = Math.round(oa * 255)
    }
  }
  // blendSpan's long spans as 32-bit words, out of it so it stays small enough to inline (a stroke paints a span per
  // edge pixel): an opaque span whole, or the run of transparent pixels a translucent span starts over (they take the
  // colour as it is). The bytes a Uint8ClampedArray store would write (rounded, clamped). Returns where blendSpan's
  // own loop goes on from: `end` when it painted it all, `i` when it painted nothing.
  function wordRun(buf, i, end, r, gg, b, a) {
    if (!LITTLE_ENDIAN || (buf.byteOffset & 3) !== 0) return i
    let j = end
    if (a < 255) { j = i + 4; while (j < end && buf[j + 3] === 0) j += 4; if (j - i < 32) return i }
    clampPx[0] = r; clampPx[1] = gg; clampPx[2] = b; clampPx[3] = a
    words(buf).fill((clampPx[0] | clampPx[1] << 8 | clampPx[2] << 16 | clampPx[3] << 24) >>> 0, i >> 2, j >> 2)
    return j
  }
  // blendSpan for source-over; copy replaces the span, destination-out punches its alpha (the colour is unused) and
  // every other operator goes pixel by pixel.
  function paintSpan(buf, i, end, r, gg, b, a, mode) {
    if (mode === 0) { blendSpan(buf, i, end, r, gg, b, a); return }
    if (mode === 1) { const aa = a >= 255 ? 255 : a <= 0 ? 0 : Math.round(a); for (; i < end; i += 4) { buf[i] = r; buf[i + 1] = gg; buf[i + 2] = b; buf[i + 3] = aa } return }
    if (mode === 2) {
      if (a <= 0) return
      if (a >= 255) { for (; i < end; i += 4) buf[i + 3] = 0; return }
      const k = 1 - a / 255
      for (; i < end; i += 4) buf[i + 3] = Math.round(buf[i + 3] * k)
      return
    }
    if (mode === 4) {
      // Destination-over: what is already opaque stays (most of a panel painted under its contents), skipped here.
      if (a <= 0) return
      for (; i < end; i += 4) if (buf[i + 3] < 255) compositePixel(buf, i, r, gg, b, a, mode)
      return
    }
    for (; i < end; i += 4) compositePixel(buf, i, r, gg, b, a, mode)
  }

  // A gradient's colours are looked up in a table of this many steps along t, built once per set of stops and shared
  // by every gradient with the same stops (a UI makes a new gradient per button per repaint, the same few over and
  // over): a menu's gradient-filled buttons cost ~90% of a repaint when every pixel searched and interpolated them.
  const GRADIENT_STEPS = 4096
  const RAMP_TABLES = 64, rampTables = new Map()   // 64 KB each, the most recently used sets of stops
  class CanvasGradient {
    constructor(kind, p) { this.__kind = kind; this.__p = p; this.__stops = []; this.__table = null }
    addColorStop(offset, color) {
      offset = Number(offset); if (!(offset >= 0 && offset <= 1)) throw domError(g, 'IndexSizeError', 'addColorStop: offset out of range')
      const c = colour(String(color)); if (!c) throw domError(g, 'SyntaxError', `addColorStop: '${color}' is not a colour`)
      this.__stops.push([offset, c]); this.__stops.sort((a, b) => a[0] - b[0]); this.__table = null
    }
    // RGBA (alpha 0..255, unrounded) at GRADIENT_STEPS points of t in 0..1: __ramp's colours.
    __lut() {
      if (this.__table) return this.__table
      const key = this.__stops.map(([o, c]) => o + ':' + c[0] + ',' + c[1] + ',' + c[2] + ',' + c[3]).join(';')
      let table = rampTables.get(key)
      if (table) { rampTables.delete(key); rampTables.set(key, table); return (this.__table = table) }
      table = new Float32Array(GRADIENT_STEPS * 4); const out = [0, 0, 0, 0]
      for (let i = 0; i < GRADIENT_STEPS; i++) { this.__ramp(i / (GRADIENT_STEPS - 1), out); table[i * 4] = out[0]; table[i * 4 + 1] = out[1]; table[i * 4 + 2] = out[2]; table[i * 4 + 3] = out[3] }
      rampTables.set(key, table)
      if (rampTables.size > RAMP_TABLES) rampTables.delete(rampTables.keys().next().value)
      return (this.__table = table)
    }
    // Spec parameter t for a user-space point, or NaN where the gradient paints nothing.
    __t(x, y) {
      const p = this.__p
      if (this.__kind === 'linear') { const dx = p[2] - p[0], dy = p[3] - p[1], d = dx * dx + dy * dy; return d === 0 ? NaN : ((x - p[0]) * dx + (y - p[1]) * dy) / d }
      const cdx = p[3] - p[0], cdy = p[4] - p[1], dr = p[5] - p[2], pdx = x - p[0], pdy = y - p[1]
      const a = cdx * cdx + cdy * cdy - dr * dr, b = -2 * (pdx * cdx + pdy * cdy + p[2] * dr), c = pdx * pdx + pdy * pdy - p[2] * p[2]
      if (Math.abs(a) < 1e-9) { if (b === 0) return NaN; const t = -c / b; return p[2] + t * dr >= 0 ? t : NaN }
      const disc = b * b - 4 * a * c; if (disc < 0) return NaN
      const sq = Math.sqrt(disc); let t = (-b + sq) / (2 * a); if (p[2] + t * dr < 0) t = (-b - sq) / (2 * a)
      return p[2] + t * dr >= 0 ? t : NaN
    }
    __colorAt(x, y, out) {
      if (!this.__stops.length) { out[0] = out[1] = out[2] = out[3] = 0; return }
      const t = this.__t(x, y)
      if (Number.isNaN(t)) { out[0] = out[1] = out[2] = out[3] = 0; return }
      this.__ramp(t < 0 ? 0 : t > 1 ? 1 : t, out)
    }
    // The colour at t (0..1) between the stops.
    __ramp(t, out) {
      const st = this.__stops
      let i = 0; while (i < st.length && st[i][0] <= t) i++
      if (i === 0) { const c = st[0][1]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return }
      if (i === st.length) { const c = st[st.length - 1][1]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return }
      const [o0, c0] = st[i - 1], [o1, c1] = st[i]; const k = o1 === o0 ? 0 : (t - o0) / (o1 - o0)
      // Interpolate premultiplied so a stop at alpha 0 does not drag its colour across the ramp.
      const a0 = c0[3] / 255, a1 = c1[3] / 255, a = a0 + (a1 - a0) * k
      for (let ch = 0; ch < 3; ch++) { const v = c0[ch] * a0 + (c1[ch] * a1 - c0[ch] * a0) * k; out[ch] = a > 0 ? Math.round(v / a) : 0 }
      out[3] = a * 255
    }
  }
  g.CanvasGradient = CanvasGradient

  // CSS filter subset for drawImage: saturate / contrast / brightness / grayscale / opacity / invert,
  // compiled once per filter string to op codes and applied to each SAMPLED source pixel inside the
  // blit (no copy of the source).
  const F_SATURATE = 0, F_GRAYSCALE = 1, F_CONTRAST = 2, F_BRIGHTNESS = 3, F_OPACITY = 4, F_INVERT = 5
  const FILTER_NAMES = ['saturate', 'grayscale', 'contrast', 'brightness', 'opacity', 'invert']
  const filterCache = new Map()
  function parseFilter(str) {
    let f = filterCache.get(str); if (f) return f
    const codes = [], vals = []; const re = /([a-z-]+)\(([^)]*)\)/g; let m
    while ((m = re.exec(str))) {
      const name = m[1], raw = m[2].trim(); const v = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
      const code = FILTER_NAMES.indexOf(name)
      if (code >= 0 && Number.isFinite(v)) { codes.push(code); vals.push(v) }
      else warnOnce('filter:' + name, `canvas 2d: filter ${name}() is not applied on this host`)
    }
    f = { n: codes.length, codes: Uint8Array.from(codes), vals: Float64Array.from(vals) }
    filterCache.set(str, f); return f
  }
  // Filters src[si..si+3] into clampPx (rounded and clamped like a Uint8ClampedArray store).
  function filterPixel(f, src, si) {
    // A Uint8Array source reads the same through a clamped copy; a clamped source is already clamped.
    let r = src[si], gg = src[si + 1], b = src[si + 2], a = src[si + 3]
    const codes = f.codes, vals = f.vals
    for (let j = 0; j < f.n; j++) {
      const op = codes[j], v = vals[j]
      if (op === F_SATURATE || op === F_GRAYSCALE) { const k = op === F_SATURATE ? v : 1 - v; const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b; r = l + (r - l) * k; gg = l + (gg - l) * k; b = l + (b - l) * k }
      else if (op === F_CONTRAST) { r = (r - 128) * v + 128; gg = (gg - 128) * v + 128; b = (b - 128) * v + 128 }
      else if (op === F_BRIGHTNESS) { r *= v; gg *= v; b *= v }
      else if (op === F_OPACITY) a *= v
      else { r = r + (255 - 2 * r) * v; gg = gg + (255 - 2 * gg) * v; b = b + (255 - 2 * b) * v }
    }
    clampPx[0] = r; clampPx[1] = gg; clampPx[2] = b; clampPx[3] = a
  }
  // pixels.js blit with the filter (or null) applied per sampled pixel and/or a bottom-up source (a WebGL canvas's
  // readback: source row r lives at srcH - 1 - r); the same sampling, bit for bit.
  function blitEx(dst, dstW, dstH, src, srcW, srcH, sx, sy, sw, sh, dx, dy, dw, dh, alpha, f, bottomUp, clip, mode = 0) {
    if (!(sw > 0) || !(sh > 0) || dw === 0 || dh === 0 || (!(alpha > 0) && mode !== 1)) return
    let mirrorX = false, mirrorY = false
    if (dw < 0) { dx += dw; dw = -dw; mirrorX = true }
    if (dh < 0) { dy += dh; dh = -dh; mirrorY = true }
    let x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(dstW, Math.ceil(dx + dw))
    let y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(dstH, Math.ceil(dy + dh))
    const mask = clip && clip.kind === 'mask' ? clip : null
    if (Array.isArray(clip)) { x0 = Math.max(x0, clip[0]); y0 = Math.max(y0, clip[1]); x1 = Math.min(x1, clip[2]); y1 = Math.min(y1, clip[3]) }
    if (x1 <= x0 || y1 <= y0) return
    for (let py = y0; py < y1; py++) {
      let v = (py + 0.5 - dy) / dh
      if (v < 0 || v >= 1) continue
      if (mirrorY) v = 1 - v
      const syy = Math.floor(sy + v * sh)
      if (syy < 0 || syy >= srcH) continue
      const row = bottomUp ? srcH - 1 - syy : syy
      for (let px = x0; px < x1; px++) {
        if (mask && (px < mask.x || py < mask.y || px >= mask.x + mask.w || py >= mask.y + mask.h || !mask.bits[(py - mask.y) * mask.w + (px - mask.x)])) continue
        let u = (px + 0.5 - dx) / dw
        if (u < 0 || u >= 1) continue
        if (mirrorX) u = 1 - u
        const sxx = Math.floor(sx + u * sw)
        if (sxx < 0 || sxx >= srcW) continue
        const si = (row * srcW + sxx) * 4
        const sa = f ? (filterPixel(f, src, si), alpha >= 1 ? clampPx[3] : clampPx[3] * alpha) : (alpha >= 1 ? src[si + 3] : src[si + 3] * alpha)
        const rgb = f ? clampPx : src, ri = f ? 0 : si
        compositePixel(dst, (py * dstW + px) * 4, rgb[ri], rgb[ri + 1], rgb[ri + 2], sa, mode)
      }
    }
  }

  // Inside spans of a filled path, in device pixels: fn(py, x0, x1, cover) with x1 exclusive and cover in (0, 1].
  // With `aa` every pixel row is sampled on four lines with the exact horizontal coverage on each, so edges are
  // antialiased as a browser's are; without it one line through the pixel centres decides whole pixels (clip masks,
  // clearRect, the copy operator).
  function scanFill(path, evenodd, cw, ch, fn, aa) {
    let total = 0
    for (let s = 0; s < path.length; s++) total += path[s].length
    if (!total) return
    if (edgeBuf.length < total * 5) edgeBuf = new Float64Array(Math.max(total * 5, edgeBuf.length * 2))
    const edges = edgeBuf
    let ne = 0, minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity
    for (let s = 0; s < path.length; s++) {
      const sub = path[s], n = sub.length
      if (n < 2) continue
      for (let i = 0; i < n; i++) {
        const a = sub[i], b = sub[i + 1 < n ? i + 1 : 0]
        const ay = a[1], by = b[1]
        if (ay === by) continue
        const o = ne * 5
        if (ay < by) { edges[o] = a[0]; edges[o + 1] = ay; edges[o + 2] = b[0]; edges[o + 3] = by; edges[o + 4] = 1 }
        else { edges[o] = b[0]; edges[o + 1] = by; edges[o + 2] = a[0]; edges[o + 3] = ay; edges[o + 4] = -1 }
        ne++
        minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by)
        minX = Math.min(minX, a[0], b[0]); maxX = Math.max(maxX, a[0], b[0])
      }
    }
    if (!ne) return
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(ch, Math.ceil(maxY))
    if (xsBuf.length < ne) { xsBuf = new Float64Array(Math.max(ne, xsBuf.length * 2)); wsBuf = new Float64Array(xsBuf.length) }
    const xs = xsBuf, ws = wsBuf
    if (orderBuf.length < ne) { orderBuf = new Int32Array(Math.max(ne, orderBuf.length * 2)); activeBuf = new Int32Array(orderBuf.length) }
    const order = orderBuf, active = activeBuf
    for (let i = 0; i < ne; i++) order[i] = i * 5
    sortByTop(order, ne, edges)
    let next = 0, na = 0
    const bx0 = Math.max(0, Math.floor(minX)), bx1 = Math.min(cw, Math.ceil(maxX)), bw = bx1 - bx0
    // cov: each pixel's partly covered share; dif: where full coverage starts and ends, summed along the row. Both
    // are all zero between rows (a row clears what it read).
    if (aa) {
      if (!(bw > 0)) return
      if (covBuf.length < bw + 2) { covBuf = new Float32Array(Math.max(bw + 2, covBuf.length * 2)); difBuf = new Float32Array(covBuf.length) }
      if (touchBuf.length < 12 * ne) touchBuf = new Int32Array(Math.max(12 * ne, touchBuf.length * 2))   // 3 columns a crossing, at most ne crossings on each of 4 lines
    }
    // A row records the columns it writes (for sparseRow) when the row above was wide: a shape's rows are alike, so
    // a panel or an outline reads sparsely from its second row on, and a thin stroke never pays for the record.
    let record = false
    const cov = covBuf, dif = difBuf, touch = touchBuf, lines = aa ? 4 : 1, weight = 1 / lines
    for (let py = y0; py < y1; py++) {
      let lo = bw, hi = 0, nt = 0
      const sparse = record
      for (let line = 0; line < lines; line++) {
        const sy = py + (line + 0.5) * weight
        // The edges this line crosses: those that started above it (in order of their top) and have not ended.
        while (next < ne && edges[order[next] + 1] <= sy) active[na++] = order[next++]
        let nx = 0, live = 0
        for (let k = 0; k < na; k++) {
          const o = active[k], ey1 = edges[o + 3]
          if (sy >= ey1) continue
          active[live++] = o
          const ex0 = edges[o], ey0 = edges[o + 1]
          const x = ex0 + (sy - ey0) * (edges[o + 2] - ex0) / (ey1 - ey0), w = edges[o + 4]
          let j = nx - 1
          while (j >= 0 && xs[j] > x) { xs[j + 1] = xs[j]; ws[j + 1] = ws[j]; j-- }
          xs[j + 1] = x; ws[j + 1] = w; nx++
        }
        na = live
        let wind = 0
        if (!sparse) {
          for (let i = 0; i < nx - 1; i++) {
            wind += evenodd ? 1 : ws[i]
            if (!(evenodd ? (wind & 1) === 1 : wind !== 0)) continue
            if (!aa) {
              const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(cw, Math.round(xs[i + 1]))
              if (xb > xa) fn(py, xa, xb, 1)
              continue
            }
            const xa = Math.max(bx0, xs[i]) - bx0, xb = Math.min(bx1, xs[i + 1]) - bx0
            if (!(xb > xa)) continue
            const ia = Math.floor(xa), ib = Math.floor(xb)
            if (ia < lo) lo = ia
            if (ib >= hi) hi = ib < bw ? ib + 1 : bw
            if (ia === ib) cov[ia] += (xb - xa) * weight
            else { cov[ia] += (ia + 1 - xa) * weight; dif[ia + 1] += weight; dif[ib] -= weight; cov[ib] += (xb - ib) * weight }
          }
          continue
        }
        // The same, recording the columns written (sparse is only ever set with aa).
        for (let i = 0; i < nx - 1; i++) {
          wind += evenodd ? 1 : ws[i]
          if (!(evenodd ? (wind & 1) === 1 : wind !== 0)) continue
          const xa = Math.max(bx0, xs[i]) - bx0, xb = Math.min(bx1, xs[i + 1]) - bx0
          if (!(xb > xa)) continue
          const ia = Math.floor(xa), ib = Math.floor(xb)
          if (ia < lo) lo = ia
          if (ib >= hi) hi = ib < bw ? ib + 1 : bw
          if (ia === ib) { cov[ia] += (xb - xa) * weight; touch[nt++] = ia }
          else { cov[ia] += (ia + 1 - xa) * weight; dif[ia + 1] += weight; dif[ib] -= weight; cov[ib] += (xb - ib) * weight; touch[nt++] = ia; touch[nt++] = ia + 1; touch[nt++] = ib }
        }
      }
      if (hi <= lo) { for (let k = 0; k < nt; k++) { const t = touchBuf[k]; cov[t] = 0; dif[t] = 0 } record = false; continue }
      record = aa && hi - lo > 48
      // A wide row (a panel, a big shape) reads only the columns its crossings wrote (sparseRow); a narrow one (a
      // stroke, a glyph-sized shape) every column, where that costs less than sorting them.
      if (sparse && hi - lo > 2 * nt + 32) { sparseRow(fn, py, bx0, lo, hi, nt, bw); continue }
      // Runs: fully covered pixels together, each edge pixel with its own coverage.
      let acc = 0
      for (let x = lo; x < hi;) {
        acc += dif[x]
        const c = cov[x] + acc
        cov[x] = 0; dif[x] = 0
        if (c < 0.004) { x++; continue }
        if (c <= 0.996) { fn(py, bx0 + x, bx0 + x + 1, c); x++; continue }
        let e = x + 1
        for (; e < hi; e++) { const next = acc + dif[e]; if (cov[e] + next <= 0.996) break; acc = next; cov[e] = 0; dif[e] = 0 }
        fn(py, bx0 + x, bx0 + e, 1)
        x = e
      }
      cov[bw] = 0; dif[bw] = 0
    }
  }
  // scanFill's runs for a wide row from the nt columns its crossings wrote (touchBuf): read in order, and between two
  // of them the coverage holds, so a gap is one run. Each pixel gets the coverage the column-by-column pass gives it
  // (the same sums, in the same order), for work by crossings rather than by width. Clears what it reads.
  function sparseRow(fn, py, bx0, lo, hi, nt, bw) {
    const touched = touchBuf, cov = covBuf, dif = difBuf
    for (let k = 1; k < nt; k++) { const t = touched[k]; let j = k - 1; while (j >= 0 && touched[j] > t) { touched[j + 1] = touched[j]; j-- } touched[j + 1] = t }
    let acc = 0, x = lo, runA = -1, runB = -1   // a run of full pixels not yet handed to fn
    for (let k = 0; k <= nt; k++) {
      let t
      if (k < nt) {
        t = touched[k]
        if (k > 0 && t === touched[k - 1]) continue
        if (t >= hi) { cov[t] = 0; dif[t] = 0; continue }
      } else t = hi
      // The gap [x, t) at coverage acc, then column t (unless this is the end).
      for (let seg = 0; seg < 2; seg++) {
        let a, b, c
        if (seg === 0) { if (t <= x) continue; a = x; b = t; c = acc }
        else { if (k === nt) break; acc += dif[t]; c = cov[t] + acc; cov[t] = 0; dif[t] = 0; a = t; b = t + 1 }
        if (c > 0.996) {
          if (runB === a) runB = b
          else { if (runA >= 0) fn(py, bx0 + runA, bx0 + runB, 1); runA = a; runB = b }
          continue
        }
        if (runA >= 0) { fn(py, bx0 + runA, bx0 + runB, 1); runA = -1; runB = -1 }
        if (c >= 0.004) for (let p = a; p < b; p++) fn(py, bx0 + p, bx0 + p + 1, c)
      }
      x = t + 1
    }
    if (runA >= 0) fn(py, bx0 + runA, bx0 + runB, 1)
    cov[bw] = 0; dif[bw] = 0
  }
  // Heapsort of the edge offsets order[0..n) by their top y (edges[o + 1]): in place, no comparator closure.
  function sortByTop(order, n, edges) {
    const sift = (i, end) => {
      for (;;) {
        let c = 2 * i + 1
        if (c >= end) return
        if (c + 1 < end && edges[order[c + 1] + 1] > edges[order[c] + 1]) c++
        if (edges[order[c] + 1] <= edges[order[i] + 1]) return
        const t = order[i]; order[i] = order[c]; order[c] = t; i = c
      }
    }
    for (let i = (n >> 1) - 1; i >= 0; i--) sift(i, n)
    for (let end = n - 1; end > 0; end--) { const t = order[0]; order[0] = order[end]; order[end] = t; sift(0, end) }
  }
  function rectsOverlap(list) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) return true
    }
    return false
  }

  // Scratch for a draw that cannot go straight to the canvas (a shadow, or a composite operator that also changes
  // what the source does not cover): it lands here first. All zero between uses.
  let layerBuf = null, layerUsed = false, layerTimer = false
  // The layer for n bytes. It is kept between draws (a UI repainting every frame would otherwise allocate a canvas'
  // worth each time) and dropped once a couple of seconds pass without a layered draw.
  function layerFor(n) {
    layerUsed = true
    if (!layerBuf || layerBuf.length < n) layerBuf = new Uint8Array(n)
    if (!layerTimer && typeof g.setTimeout === 'function') { layerTimer = true; g.setTimeout(releaseLayer, 2000) }
    return layerBuf
  }
  function releaseLayer() {
    if (layerUsed) { layerUsed = false; g.setTimeout(releaseLayer, 2000); return }
    layerTimer = false; layerBuf = null
  }
  let shadowA = new Float32Array(0), shadowB = new Float32Array(0)
  const inv = new Float64Array(6)   // an inverse transform, from __inverse(): valid until the next one

  // drawImage under a rotation or a skew. Every device pixel of the destination quad's box (x0..y1) is mapped back
  // through `inv` into the destination rect and on into the source window: bilinear between source pixels when
  // smooth (premultiplied, so a transparent neighbour does not darken an edge), nearest otherwise and under a filter.
  function blitAffine(dst, dstW, dstH, src, srcW, srcH, sx, sy, sw, sh, dx, dy, dw, dh, x0, y0, x1, y1, alpha, f, bottomUp, smooth, clipCtx, mode) {
    if (!(sw > 0) || !(sh > 0) || dw === 0 || dh === 0 || (!(alpha > 0) && mode !== 1)) return
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(dstW, Math.ceil(x1)); y1 = Math.min(dstH, Math.ceil(y1))
    const i0 = inv[0], i1 = inv[1], i2 = inv[2], i3 = inv[3], i4 = inv[4], i5 = inv[5]
    const minX = Math.max(0, Math.floor(sx)), maxX = Math.min(srcW, Math.ceil(sx + sw)) - 1, minY = Math.max(0, Math.floor(sy)), maxY = Math.min(srcH, Math.ceil(sy + sh)) - 1
    if (maxX < minX || maxY < minY) return
    const kx = sw / dw, ky = sh / dh, ex = sx + sw, ey = sy + sh
    for (let py = y0; py < y1; py++) {
      const Y = py + 0.5
      for (let px = x0; px < x1; px++) {
        const X = px + 0.5
        const fx = sx + (i0 * X + i2 * Y + i4 - dx) * kx, fy = sy + (i1 * X + i3 * Y + i5 - dy) * ky   // in source pixels, centres at .5
        if (!(fx >= sx && fx < ex && fy >= sy && fy < ey)) continue
        if (clipCtx && !clipCtx.__covers(px, py)) continue
        const di = (py * dstW + px) * 4
        if (!smooth || f) {
          const sxx = Math.min(maxX, Math.max(minX, Math.floor(fx))), syy = Math.min(maxY, Math.max(minY, Math.floor(fy)))
          const si = ((bottomUp ? srcH - 1 - syy : syy) * srcW + sxx) * 4
          if (f) { filterPixel(f, src, si); compositePixel(dst, di, clampPx[0], clampPx[1], clampPx[2], clampPx[3] * alpha, mode) }
          else compositePixel(dst, di, src[si], src[si + 1], src[si + 2], src[si + 3] * alpha, mode)
          continue
        }
        const gx = fx - 0.5, gy = fy - 0.5
        let xa = Math.floor(gx), ya = Math.floor(gy)
        const tx = gx - xa, ty = gy - ya
        let xb = xa + 1, yb = ya + 1
        if (xa < minX) xa = minX; else if (xa > maxX) xa = maxX
        if (xb < minX) xb = minX; else if (xb > maxX) xb = maxX
        if (ya < minY) ya = minY; else if (ya > maxY) ya = maxY
        if (yb < minY) yb = minY; else if (yb > maxY) yb = maxY
        const ra = (bottomUp ? srcH - 1 - ya : ya) * srcW, rb = (bottomUp ? srcH - 1 - yb : yb) * srcW
        const p00 = (ra + xa) * 4, p10 = (ra + xb) * 4, p01 = (rb + xa) * 4, p11 = (rb + xb) * 4
        const a00 = src[p00 + 3] * (1 - tx) * (1 - ty), a10 = src[p10 + 3] * tx * (1 - ty), a01 = src[p01 + 3] * (1 - tx) * ty, a11 = src[p11 + 3] * tx * ty
        const sa = a00 + a10 + a01 + a11
        if (!(sa > 0)) { if (mode === 1) compositePixel(dst, di, 0, 0, 0, 0, mode); continue }
        const al = sa * alpha
        compositePixel(dst, di, Math.round((src[p00] * a00 + src[p10] * a10 + src[p01] * a01 + src[p11] * a11) / sa), Math.round((src[p00 + 1] * a00 + src[p10 + 1] * a10 + src[p01 + 1] * a01 + src[p11 + 1] * a11) / sa),
          Math.round((src[p00 + 2] * a00 + src[p10 + 2] * a10 + src[p01 + 2] * a01 + src[p11 + 2] * a11) / sa), al, mode)
      }
    }
  }

  // A box blur of the w x h plane `a` by `r` pixels each way, through `b`; three of them make the Gaussian of a shadow.
  function boxBlur(a, b, w, h, r) {
    const span = 2 * r + 1
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let x = -r; x <= r; x++) if (x >= 0 && x < w) sum += a[row + x]
      for (let x = 0; x < w; x++) { b[row + x] = sum / span; const out = x - r, inn = x + r + 1; if (out >= 0) sum -= a[row + out]; if (inn < w) sum += a[row + inn] }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = -r; y <= r; y++) if (y >= 0 && y < h) sum += b[y * w + x]
      for (let y = 0; y < h; y++) { a[y * w + x] = sum / span; const out = y - r, inn = y + r + 1; if (out >= 0) sum -= b[out * w + x]; if (inn < h) sum += b[inn * w + x] }
    }
  }

  // The outside corner of a stroke where two segments meet at (px, py), u1 and u2 their directions: the miter's
  // quad while it is within the limit, else the bevel's triangle.
  function addJoin(polys, px, py, u1x, u1y, u2x, u2y, hw, miter, limit) {
    const cross = u1x * u2y - u1y * u2x
    if (Math.abs(cross) < 1e-9) return
    const s = cross > 0 ? -hw : hw   // the side away from the turn
    const o1x = -u1y * s, o1y = u1x * s, o2x = -u2y * s, o2y = u2x * s
    const mx = o1x + o2x, my = o1y + o2y, mm = mx * mx + my * my
    if (miter && mm > 0 && 2 * hw / Math.sqrt(mm) <= limit) { const t = 2 * hw * hw / mm; polys.push([[px, py], [px + o1x, py + o1y], [px + mx * t, py + my * t], [px + o2x, py + o2y]]) }
    else polys.push([[px, py], [px + o1x, py + o1y], [px + o2x, py + o2y]])
  }

  // How many segments a curve whose control polygon is `len` long is cut into, at `res` device pixels a unit.
  const curveSteps = (len, res) => Math.max(16, Math.min(96, Math.ceil(len * res / 3)))

  // The path-building half of the context, shared with Path2D. A host object keeps `__path` (subpaths of points,
  // `closed` on the ones closePath ended), `__sub` (the open one), `__start` (where the next one begins after a
  // closePath), and answers __pt(x, y) (a user-space point as it is stored: the context stores device space, so a
  // transform applies to the points added under it), __cur() (the current point back in user space) and __res()
  // (device pixels per user unit, for flattening curves).
  const pathMethods = {
    moveTo(x, y) { x = Number(x); y = Number(y); if (!Number.isFinite(x) || !Number.isFinite(y)) return; this.__sub = [this.__pt(x, y)]; this.__path.push(this.__sub); this.__start = null },
    lineTo(x, y) {
      x = Number(x); y = Number(y); if (!Number.isFinite(x) || !Number.isFinite(y)) return
      if (!this.__sub) { if (!this.__start) return this.moveTo(x, y); this.__sub = [this.__start]; this.__path.push(this.__sub); this.__start = null }
      this.__sub.push(this.__pt(x, y))
    },
    closePath() { const s = this.__sub; if (s && s.length) { s.closed = true; this.__start = s[0]; this.__sub = null } },
    rect(x, y, w, h) { x = Number(x); y = Number(y); w = Number(w); h = Number(h); this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath() },
    // Stored points are an affine image of user space, and a Bezier curve maps with its control points: the curve is
    // cut in stored space.
    __curve(c1, c2, p) {
      if (!this.__sub) { this.__sub = [this.__start || c1]; this.__path.push(this.__sub); this.__start = null }
      const s = this.__sub, q = s[s.length - 1], px = q[0], py = q[1]
      const n = curveSteps(Math.hypot(c1[0] - px, c1[1] - py) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p[0] - c2[0], p[1] - c2[1]), this.__flat())
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t
        s.push([k0 * px + k1 * c1[0] + k2 * c2[0] + k3 * p[0], k0 * py + k1 * c1[1] + k2 * c2[1] + k3 * p[1]])
      }
    },
    quadraticCurveTo(cx, cy, x, y) {
      if (![cx, cy, x, y].every(v => Number.isFinite(Number(v)))) return
      const c = this.__pt(cx, cy), p = this.__pt(x, y)
      if (!this.__sub && !this.__start) { this.__sub = [c]; this.__path.push(this.__sub) }
      const s = this.__sub || [this.__start], q = s[s.length - 1]
      this.__curve([q[0] + (c[0] - q[0]) * 2 / 3, q[1] + (c[1] - q[1]) * 2 / 3], [p[0] + (c[0] - p[0]) * 2 / 3, p[1] + (c[1] - p[1]) * 2 / 3], p)
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      if (![c1x, c1y, c2x, c2y, x, y].every(v => Number.isFinite(Number(v)))) return
      this.__curve(this.__pt(c1x, c1y), this.__pt(c2x, c2y), this.__pt(x, y))
    },
    ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
      cx = Number(cx); cy = Number(cy); rx = Number(rx); ry = Number(ry); rot = Number(rot) || 0; a0 = Number(a0); a1 = Number(a1)
      if (![cx, cy, rx, ry, a0, a1].every(Number.isFinite)) return
      if (rx < 0 || ry < 0) throw domError(g, 'IndexSizeError', 'ellipse: negative radius')
      let sweep = a1 - a0
      if (ccw) { if (sweep > 0 && sweep < 2 * Math.PI) sweep -= 2 * Math.PI; else if (sweep >= 2 * Math.PI || sweep > 0) sweep = -2 * Math.PI; else if (sweep <= -2 * Math.PI) sweep = -2 * Math.PI }
      else { if (sweep < 0 && sweep > -2 * Math.PI) sweep += 2 * Math.PI; else if (sweep <= -2 * Math.PI || sweep < 0) sweep = 2 * Math.PI; else if (sweep >= 2 * Math.PI) sweep = 2 * Math.PI }
      const n = Math.max(8, Math.min(256, Math.ceil(Math.abs(sweep) * Math.max(rx, ry) * this.__res() / 3)))
      const cr = Math.cos(rot), sr = Math.sin(rot)
      for (let i = 0; i <= n; i++) {
        const t = a0 + sweep * i / n, ex = rx * Math.cos(t), ey = ry * Math.sin(t)
        this.lineTo(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr)
      }
    },
    arc(x, y, r, a0, a1, ccw) { if (Number(r) < 0) throw domError(g, 'IndexSizeError', 'arc: negative radius'); this.ellipse(x, y, r, r, 0, a0, a1, ccw) },
    // A line to the first tangent point, then the arc of radius r that rounds the corner at (x1, y1).
    arcTo(x1, y1, x2, y2, r) {
      x1 = Number(x1); y1 = Number(y1); x2 = Number(x2); y2 = Number(y2); r = Number(r)
      if (![x1, y1, x2, y2, r].every(Number.isFinite)) return
      if (r < 0) throw domError(g, 'IndexSizeError', 'arcTo: negative radius')
      if (!this.__sub && !this.__start) { this.moveTo(x1, y1); return }
      const p0 = this.__cur(), v1x = p0[0] - x1, v1y = p0[1] - y1, v2x = x2 - x1, v2y = y2 - y1
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y), cross = v1x * v2y - v1y * v2x
      if (r === 0 || l1 < 1e-9 || l2 < 1e-9 || Math.abs(cross) < 1e-9 * l1 * l2) { this.lineTo(x1, y1); return }
      const half = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)))) / 2
      const dist = r / Math.tan(half), cd = r / Math.sin(half)
      const t1x = x1 + v1x / l1 * dist, t1y = y1 + v1y / l1 * dist, t2x = x1 + v2x / l2 * dist, t2y = y1 + v2y / l2 * dist
      const bx = v1x / l1 + v2x / l2, by = v1y / l1 + v2y / l2, bl = Math.hypot(bx, by)
      const cx = x1 + bx / bl * cd, cy = y1 + by / bl * cd
      this.lineTo(t1x, t1y)
      this.ellipse(cx, cy, r, r, 0, Math.atan2(t1y - cy, t1x - cx), Math.atan2(t2y - cy, t2x - cx), cross > 0)
    },
    roundRect(x, y, w, h, radii = 0) {
      x = Number(x); y = Number(y); w = Number(w); h = Number(h)
      if (![x, y, w, h].every(Number.isFinite)) return
      let list = radii !== null && typeof radii === 'object' && typeof radii[Symbol.iterator] === 'function' ? [...radii] : [radii]
      if (list.length < 1 || list.length > 4) throw new RangeError('roundRect: 1 to 4 radii')
      list = list.map(v => v !== null && typeof v === 'object' ? [Number(v.x), Number(v.y)] : [Number(v), Number(v)])
      for (const v of list) { if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return; if (v[0] < 0 || v[1] < 0) throw new RangeError('roundRect: negative radius') }
      let tl = list[0], tr = list.length > 1 ? list[1] : tl, br = list.length > 2 ? list[2] : tl, bl = list.length > 3 ? list[3] : tr
      if (w < 0) { x += w; w = -w; let t = tl; tl = tr; tr = t; t = bl; bl = br; br = t }
      if (h < 0) { y += h; h = -h; let t = tl; tl = bl; bl = t; t = tr; tr = br; br = t }
      const fit = (size, a, b) => a + b > size ? size / (a + b) : 1
      const k = Math.min(fit(w, tl[0], tr[0]), fit(w, bl[0], br[0]), fit(h, tl[1], bl[1]), fit(h, tr[1], br[1]))
      const Q = Math.PI / 2
      const corner = (cx, cy, r, a) => { if (r[0] * k > 0 && r[1] * k > 0) this.ellipse(cx, cy, r[0] * k, r[1] * k, 0, a, a + Q) }
      this.moveTo(x + tl[0] * k, y)
      this.lineTo(x + w - tr[0] * k, y); corner(x + w - tr[0] * k, y + tr[1] * k, tr, -Q)
      this.lineTo(x + w, y + h - br[1] * k); corner(x + w - br[0] * k, y + h - br[1] * k, br, 0)
      this.lineTo(x + bl[0] * k, y + h); corner(x + bl[0] * k, y + h - bl[1] * k, bl, Q)
      this.lineTo(x, y + tl[1] * k); corner(x + tl[0] * k, y + tl[1] * k, tl, 2 * Q)
      this.closePath()
      this.__start = this.__pt(x, y)
    },
  }

  // What save() records and restore() puts back.
  const STATE = ['__fill', '__fillRgba', '__fillGrad', '__filter', '__stroke', '__strokeRgba', '__strokeGrad', '__alpha', '__font', '__opMode', '__clip',
    'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing', 'fontKerning', 'imageSmoothingEnabled', 'imageSmoothingQuality',
    'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', '__dash', 'lineDashOffset', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
    '__a', '__b', '__c', '__d', '__e', '__f']

  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas
      this.__stack = []   // save() records, reused: __depth of them are live
      this.__depth = 0
      this.__r = new Float64Array(4)   // __rect / a device box: x0, y0, x1, y1
      this.__tbuf = null   // the layer while a draw lands in it (see __layered)
      this.__reset()
    }
    __reset() {
      this.__fill = '#000000'; this.__fillRgba = [0, 0, 0, 255]; this.__fillGrad = null; this.__filter = 'none'; this.__path = []; this.__sub = null; this.__start = null
      this.__stroke = '#000000'; this.__strokeRgba = [0, 0, 0, 255]; this.__strokeGrad = null
      this.__alpha = 1
      this.__font = '10px sans-serif'
      this.__opMode = 0   // an index into COMPOSITE_MODES
      this.__clip = null   // null: the whole canvas. {kind:'rects', rects:[[x0,y0,x1,y1]]} or {kind:'mask', x, y, w, h, bits}
      this.textAlign = 'start'; this.textBaseline = 'alphabetic'; this.direction = 'inherit'
      this.letterSpacing = '0px'; this.wordSpacing = '0px'; this.fontKerning = 'auto'
      this.lineWidth = 1; this.lineCap = 'butt'; this.lineJoin = 'miter'; this.miterLimit = 10
      this.__dash = []; this.lineDashOffset = 0
      this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low'
      this.shadowBlur = 0; this.shadowColor = 'rgba(0, 0, 0, 0)'; this.shadowOffsetX = 0; this.shadowOffsetY = 0
      // The transform, as CSS names it: device x = a x + c y + e, y = b x + d y + f.
      this.__a = 1; this.__b = 0; this.__c = 0; this.__d = 1; this.__e = 0; this.__f = 0
      this.__depth = 0
    }

    get fillStyle() { return this.__fill }
    set fillStyle(v) {
      if (v instanceof CanvasGradient) { this.__fill = v; this.__fillGrad = v; return }
      if (typeof v !== 'string') { warnOnce('fillStyle:' + (v && v.constructor ? v.constructor.name : typeof v), 'canvas 2d: only colours and gradients are drawn as fillStyles'); return }
      const c = colour(v)
      if (!c) { warnOnce('fillStyle:' + v, `canvas 2d: fillStyle '${v}' is not a colour this host reads; kept the previous one`); return }
      this.__fill = v; this.__fillRgba = c; this.__fillGrad = null
    }
    get filter() { return this.__filter }
    set filter(v) { if (typeof v === 'string') this.__filter = v.trim() || 'none' }
    get strokeStyle() { return this.__stroke }
    set strokeStyle(v) {
      if (v instanceof CanvasGradient) { this.__stroke = v; this.__strokeGrad = v; return }
      if (typeof v !== 'string') return
      const c = colour(v)
      if (!c) { warnOnce('strokeStyle:' + v, `canvas 2d: strokeStyle '${v}' is not a colour this host reads; kept the previous one`); return }
      this.__stroke = v; this.__strokeRgba = c; this.__strokeGrad = null
    }
    get globalAlpha() { return this.__alpha }
    set globalAlpha(v) { v = Number(v); if (Number.isFinite(v) && v >= 0 && v <= 1) this.__alpha = v }
    get font() { return this.__font }
    set font(v) { if (typeof v === 'string' && v.trim()) this.__font = v }
    get globalCompositeOperation() { return COMPOSITE_MODES[this.__opMode] }
    set globalCompositeOperation(v) {
      const i = COMPOSITE_MODES.indexOf(v)
      if (i >= 0) { this.__opMode = i; return }
      warnOnce('gco:' + v, `canvas 2d: globalCompositeOperation '${v}' is left unchanged`)
    }
    // The composite mode a draw paints with and the pixels it paints into: the layer's while one is open.
    __mode() { return this.__tbuf ? 0 : this.__opMode }
    __target() { return this.__tbuf || this.canvas.__rgba }
    setLineDash(list) {
      if (!list || typeof list[Symbol.iterator] !== 'function') throw new TypeError('setLineDash: a sequence of numbers is required')
      const d = [...list].map(Number)
      if (d.some(v => !Number.isFinite(v) || v < 0)) return
      this.__dash = d.length % 2 ? d.concat(d) : d
    }
    getLineDash() { return this.__dash.slice() }

    getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false } }

    save() {
      let s = this.__stack[this.__depth]
      if (!s) this.__stack.push(s = new Array(STATE.length))
      this.__depth++
      for (let i = 0; i < STATE.length; i++) s[i] = this[STATE[i]]
    }
    restore() {
      if (this.__depth === 0) return
      const s = this.__stack[--this.__depth]
      for (let i = 0; i < STATE.length; i++) this[STATE[i]] = s[i]
      s.fill(null)   // do not keep a gradient or a clip alive through a dead record
    }

    scale(x, y) { x = Number(x); y = Number(y); if (!Number.isFinite(x) || !Number.isFinite(y)) return; this.__a *= x; this.__b *= x; this.__c *= y; this.__d *= y }
    translate(x, y) { x = Number(x); y = Number(y); if (!Number.isFinite(x) || !Number.isFinite(y)) return; this.__e += this.__a * x + this.__c * y; this.__f += this.__b * x + this.__d * y }
    rotate(angle) {
      angle = Number(angle); if (!Number.isFinite(angle)) return
      let cos = Math.cos(angle), sin = Math.sin(angle)
      // Quarter turns are exact, so an icon turned by them keeps its pixels and rects stay rects.
      if (Math.abs(cos) < 1e-12) { cos = 0; sin = sin < 0 ? -1 : 1 } else if (Math.abs(sin) < 1e-12) { sin = 0; cos = cos < 0 ? -1 : 1 }
      const a = this.__a, b = this.__b, c = this.__c, d = this.__d
      this.__a = a * cos + c * sin; this.__b = b * cos + d * sin; this.__c = c * cos - a * sin; this.__d = d * cos - b * sin
    }
    transform(a2, b2, c2, d2, e2, f2) {
      a2 = Number(a2); b2 = Number(b2); c2 = Number(c2); d2 = Number(d2); e2 = Number(e2); f2 = Number(f2)
      if (![a2, b2, c2, d2, e2, f2].every(Number.isFinite)) return
      const a = this.__a, b = this.__b, c = this.__c, d = this.__d
      this.__a = a * a2 + c * b2; this.__b = b * a2 + d * b2; this.__c = a * c2 + c * d2; this.__d = b * c2 + d * d2
      this.__e += a * e2 + c * f2; this.__f += b * e2 + d * f2
    }
    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) { b = a.b ?? a.m12; c = a.c ?? a.m21; d = a.d ?? a.m22; e = a.e ?? a.m41; f = a.f ?? a.m42; a = a.a ?? a.m11 }
      if (arguments.length === 0 || a === undefined) { this.resetTransform(); return }
      a = Number(a); b = Number(b) || 0; c = Number(c) || 0; d = Number(d); e = Number(e) || 0; f = Number(f) || 0
      if (!Number.isFinite(a) || !Number.isFinite(d)) return
      this.__a = a; this.__b = b; this.__c = c; this.__d = d; this.__e = e; this.__f = f
    }
    resetTransform() { this.__a = 1; this.__b = 0; this.__c = 0; this.__d = 1; this.__e = 0; this.__f = 0 }
    get __rot() { return this.__b !== 0 || this.__c !== 0 }   // the transform turns or skews
    getTransform() {
      const a = this.__a, b = this.__b, c = this.__c, d = this.__d, e = this.__e, f = this.__f
      if (typeof g.DOMMatrix === 'function') { try { return new g.DOMMatrix([a, b, c, d, e, f]) } catch {} }
      return { a, b, c, d, e, f, m11: a, m12: b, m21: c, m22: d, m41: e, m42: f, is2D: true, isIdentity: a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0 }
    }
    // The inverse transform into `inv`: user x = inv0 X + inv2 Y + inv4, y = inv1 X + inv3 Y + inv5. False when
    // the transform has none (a zero scale), and then nothing is drawn.
    __inverse() {
      const a = this.__a, b = this.__b, c = this.__c, d = this.__d, det = a * d - b * c
      if (det === 0 || !Number.isFinite(det)) return false
      inv[0] = d / det; inv[1] = -b / det; inv[2] = -c / det; inv[3] = a / det
      inv[4] = (c * this.__f - d * this.__e) / det; inv[5] = (b * this.__e - a * this.__f) / det
      return true
    }
    // Device pixels per user unit: the mean (line widths, text) and the larger axis (curve flattening).
    __scale() { return Math.sqrt(Math.abs(this.__a * this.__d - this.__b * this.__c)) }
    __res() { return Math.max(Math.hypot(this.__a, this.__b), Math.hypot(this.__c, this.__d)) }
    __flat() { return 1 }   // curves are cut where points are stored: in device pixels
    __pt(x, y) { x = Number(x); y = Number(y); return [this.__e + x * this.__a + y * this.__c, this.__f + x * this.__b + y * this.__d] }
    __cur() {
      const s = this.__sub, p = s ? s[s.length - 1] : this.__start
      if (!p || !this.__inverse()) return [0, 0]
      return [inv[0] * p[0] + inv[2] * p[1] + inv[4], inv[1] * p[0] + inv[3] * p[1] + inv[5]]
    }

    // A user-space rect in device pixels, clipped to the canvas, into this.__r (x0, y0, x1, y1): 1 when it covers
    // pixels, 0 when it covers none, 2 when the transform makes it something other than an upright rect (__quad).
    __rect(x, y, w, h) {
      x = Number(x); y = Number(y); w = Number(w); h = Number(h)
      const a = this.__a, b = this.__b, c = this.__c, d = this.__d
      let xa, ya, xb, yb
      if (!this.__rot) { xa = this.__e + x * a; ya = this.__f + y * d; xb = xa + w * a; yb = ya + h * d }
      else if (a === 0 && d === 0) { xa = this.__e + y * c; ya = this.__f + x * b; xb = xa + h * c; yb = ya + w * b }   // a quarter turn
      else return 2
      if (xb < xa) { const t = xa; xa = xb; xb = t }
      if (yb < ya) { const t = ya; ya = yb; yb = t }
      const cv = this.canvas, r = this.__r
      const x0 = r[0] = Math.max(0, Math.round(xa)), y0 = r[1] = Math.max(0, Math.round(ya))
      const x1 = r[2] = Math.min(cv.__w, Math.round(xb)), y1 = r[3] = Math.min(cv.__h, Math.round(yb))
      return x1 > x0 && y1 > y0 ? 1 : 0
    }
    __quad(x, y, w, h) {
      x = Number(x); y = Number(y); w = Number(w); h = Number(h)
      const s = [this.__pt(x, y), this.__pt(x + w, y), this.__pt(x + w, y + h), this.__pt(x, y + h)]
      s.closed = true
      return [s]
    }

    // A draw goes straight to the canvas unless it casts a shadow or its composite operator also changes the pixels
    // the source does not cover (source-in, source-out, destination-in, destination-atop).
    __shadowColour() {
      if (!(this.shadowBlur > 0) && !this.shadowOffsetX && !this.shadowOffsetY) return null
      const c = colour(String(this.shadowColor))
      return c && c[3] > 0 ? c : null
    }
    __direct() { return this.__tbuf !== null || (!isUnbounded(this.__opMode) && this.__shadowColour() === null) }
    // draw() straight onto the canvas, or through the layer when __direct() says no; (x0..y1) holds what it paints.
    __paint(x0, y0, x1, y1, draw) { if (this.__direct()) draw(); else this.__layered(x0, y0, x1, y1, draw) }
    // fn() with `path` as the current path, the context's own put back after.
    __withPath(path, fn) { const saved = this.__path; this.__path = path; try { return fn() } finally { this.__path = saved } }
    // Nothing to paint: a transparent source under an operator that leaves the destination alone then.
    __idle(a) { return !(a > 0) && this.__opMode !== 1 && !isUnbounded(this.__opMode) }
    // Runs draw() into a transparent layer, then puts the layer on the canvas: its shadow first, then the layer
    // through the composite operator. (x0, y0, x1, y1) is a device box holding everything draw() paints.
    __layered(x0, y0, x1, y1, draw) {
      const cv = this.canvas, cw = cv.__w, ch = cv.__h, n = cw * ch * 4, buf = cv.__rgba, mode = this.__opMode, unbounded = isUnbounded(mode)
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(cw, Math.ceil(x1)); y1 = Math.min(ch, Math.ceil(y1))
      const some = x1 > x0 && y1 > y0
      const layer = layerFor(n)
      try {
        if (some) {
          this.__tbuf = layer
          try { draw() } finally { this.__tbuf = null }
          const sc = this.__shadowColour()
          if (sc) this.__shadow(layer, x0, y0, x1, y1, sc, unbounded ? 0 : mode)
        }
        if (unbounded) {
          // Every pixel of the clip: the layer's box through the operator, the rest cleared (each of the four
          // leaves nothing where the source is transparent).
          this.__forClipRect(0, 0, cw, ch, (cx0, cy0, cx1, cy1) => {
            for (let py = cy0; py < cy1; py++) {
              const row = py * cw * 4
              if (!some || py < y0 || py >= y1) { buf.fill(0, row + cx0 * 4, row + cx1 * 4); continue }
              const a = Math.min(cx1, Math.max(cx0, x0)), b = Math.max(a, Math.min(cx1, x1))
              if (a > cx0) buf.fill(0, row + cx0 * 4, row + a * 4)
              for (let i = row + a * 4, end = row + b * 4; i < end; i += 4) compositePixel(buf, i, layer[i], layer[i + 1], layer[i + 2], layer[i + 3], mode)
              if (cx1 > b) buf.fill(0, row + b * 4, row + cx1 * 4)
            }
          })
        } else if (some) {
          for (let py = y0; py < y1; py++) for (let i = (py * cw + x0) * 4, end = (py * cw + x1) * 4; i < end; i += 4) if (layer[i + 3] !== 0) compositePixel(buf, i, layer[i], layer[i + 1], layer[i + 2], layer[i + 3], mode)
        }
      } finally {
        if (some) for (let py = y0; py < y1; py++) layer.fill(0, (py * cw + x0) * 4, (py * cw + x1) * 4)
      }
    }
    // The shadow of what the layer holds in (x0..y1): its alpha moved by the offset, blurred, in the shadow colour.
    __shadow(layer, x0, y0, x1, y1, c, mode) {
      const cv = this.canvas, cw = cv.__w, ch = cv.__h, buf = cv.__rgba
      const sigma = Math.max(0, Number(this.shadowBlur) || 0) / 2
      const r = sigma > 0 ? Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)) : 0
      const ox = Math.round(Number(this.shadowOffsetX) || 0), oy = Math.round(Number(this.shadowOffsetY) || 0)
      const sx0 = Math.max(0, x0 + ox - 3 * r), sy0 = Math.max(0, y0 + oy - 3 * r), sx1 = Math.min(cw, x1 + ox + 3 * r), sy1 = Math.min(ch, y1 + oy + 3 * r)
      const w = sx1 - sx0, h = sy1 - sy0
      if (w <= 0 || h <= 0) return
      if (shadowA.length < w * h) { shadowA = new Float32Array(w * h); shadowB = new Float32Array(w * h) }
      const A = shadowA
      for (let y = 0; y < h; y++) {
        const ly = sy0 + y - oy, inRow = ly >= y0 && ly < y1
        for (let x = 0; x < w; x++) { const lx = sx0 + x - ox; A[y * w + x] = inRow && lx >= x0 && lx < x1 ? layer[(ly * cw + lx) * 4 + 3] : 0 }
      }
      if (r > 0) for (let pass = 0; pass < 3; pass++) boxBlur(A, shadowB, w, h, r)
      const k = c[3] / 255
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = A[y * w + x] * k
        if (a >= 0.5 && this.__covers(sx0 + x, sy0 + y)) compositePixel(buf, ((sy0 + y) * cw + sx0 + x) * 4, c[0], c[1], c[2], a, mode)
      }
    }
    // The device box of a path into this.__r, grown by `pad`.
    __pathBox(path, pad) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let s = 0; s < path.length; s++) { const sub = path[s]; for (let i = 0; i < sub.length; i++) { const p = sub[i]; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] } }
      const r = this.__r
      r[0] = x0 - pad; r[1] = y0 - pad; r[2] = x1 + pad; r[3] = y1 + pad
    }

    clearRect(x, y, w, h) {
      const buf = this.canvas.__rgba; if (!buf) return
      const k = this.__rect(x, y, w, h)
      if (k === 0) return
      const cw = this.canvas.__w
      // clearRect ignores the composite mode and the fill, but it honours the clip: a repaint clears the whole
      // canvas inside a clip of just the dirty rectangles, and everything outside it has to survive.
      if (k === 2) { scanFill(this.__quad(x, y, w, h), false, cw, this.canvas.__h, (py, xa, xb) => this.__clipSpans(py, xa, xb, (a, b) => { buf.fill(0, (py * cw + a) * 4, (py * cw + b) * 4) })); return }
      const r = this.__r
      this.__forClipRect(r[0], r[1], r[2], r[3], (x0, y0, x1, y1) => {
        for (let py = y0; py < y1; py++) buf.fill(0, (py * cw + x0) * 4, (py * cw + x1) * 4)
      })
    }
    fillRect(x, y, w, h) {
      if (!this.canvas.__rgba) return
      const k = this.__rect(x, y, w, h)
      if (k === 2) { this.__withPath(this.__quad(x, y, w, h), () => this.fill()); return }
      if (this.__fillGrad && !this.__inverse()) return
      const rr = this.__r, x0 = rr[0], y0 = rr[1], x1 = rr[2], y1 = rr[3]
      // An empty rect still goes through __layered: source-in and its kind clear the clip.
      this.__paint(x0, y0, x1, y1, () => { if (!k) return; const buf = this.__target(); this.__forClipRect(x0, y0, x1, y1, (a, b, c, d) => this.__paintRect(buf, a, b, c, d)) })
    }
    __paintRect(buf, x0, y0, x1, y1) {
      if (this.__fillGrad) { this.__fillGradientSpan(buf, x0, y0, x1, y1); return }
      const c = this.__fillRgba, a = c[3] * this.__alpha, mode = this.__mode()
      if (a <= 0 && mode !== 1) return
      const cw = this.canvas.__w
      if (mode === 0 && a >= 255) {
        const first = (y0 * cw + x0) * 4, end = (y0 * cw + x1) * 4
        blendSpan(buf, first, end, c[0], c[1], c[2], 255)
        for (let py = y0 + 1; py < y1; py++) buf.copyWithin((py * cw + x0) * 4, first, end)
        return
      }
      for (let py = y0; py < y1; py++) paintSpan(buf, (py * cw + x0) * 4, (py * cw + x1) * 4, c[0], c[1], c[2], a, mode)
    }
    strokeRect(x, y, w, h) { const sub = this.__sub, start = this.__start; this.__withPath([], () => { this.__sub = null; this.__start = null; this.rect(x, y, w, h); this.stroke() }); this.__sub = sub; this.__start = start }

    createImageData(a, b, settings) {
      if (typeof a === 'object' && a) return new ImageData(a.width, a.height, settings)
      return new ImageData(Math.abs(Math.floor(Number(a))), Math.abs(Math.floor(Number(b))), settings)
    }
    getImageData(sx, sy, sw, sh) {
      sx = Math.floor(Number(sx)); sy = Math.floor(Number(sy)); sw = Math.floor(Number(sw)); sh = Math.floor(Number(sh))
      if (![sx, sy, sw, sh].every(Number.isFinite)) throw new TypeError('getImageData: arguments must be finite')
      if (sw === 0 || sh === 0) throw domError(g, 'IndexSizeError', 'getImageData: the source rectangle is empty')
      if (sw < 0) { sx += sw; sw = -sw }
      if (sh < 0) { sy += sh; sh = -sh }
      const out = new ImageData(sw, sh)
      const buf = this.canvas.__rgba; if (!buf) return out
      const cw = this.canvas.__w, ch = this.canvas.__h
      const x0 = Math.max(0, sx), x1 = Math.min(cw, sx + sw)
      if (x1 <= x0) return out
      const span = (x1 - x0) * 4
      for (let y = Math.max(0, sy), yEnd = Math.min(ch, sy + sh); y < yEnd; y++) {
        const from = (y * cw + x0) * 4
        out.data.set(buf.subarray(from, from + span), ((y - sy) * sw + (x0 - sx)) * 4)
      }
      return out
    }
    // A straight copy, as the spec has it: no alpha, no transform, no blending.
    putImageData(image, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
      if (!image || !ArrayBuffer.isView(image.data) || typeof image.width !== 'number') throw new TypeError('putImageData: the first argument is not an ImageData')
      const buf = this.canvas.__rgba; if (!buf) return
      dx = Math.floor(Number(dx)); dy = Math.floor(Number(dy))
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('putImageData: dx and dy must be finite')
      const iw = image.width, ih = image.height
      if (dirtyX === undefined) { dirtyX = 0; dirtyY = 0; dirtyW = iw; dirtyH = ih }
      else {
        dirtyX = Math.floor(Number(dirtyX)); dirtyY = Math.floor(Number(dirtyY)); dirtyW = Math.floor(Number(dirtyW)); dirtyH = Math.floor(Number(dirtyH))
        if (dirtyW < 0) { dirtyX += dirtyW; dirtyW = -dirtyW }
        if (dirtyH < 0) { dirtyY += dirtyH; dirtyH = -dirtyH }
        if (dirtyX < 0) { dirtyW += dirtyX; dirtyX = 0 }
        if (dirtyY < 0) { dirtyH += dirtyY; dirtyY = 0 }
        dirtyW = Math.min(dirtyW, iw - dirtyX); dirtyH = Math.min(dirtyH, ih - dirtyY)
      }
      if (dirtyW <= 0 || dirtyH <= 0) return
      const src = image.data, cw = this.canvas.__w, ch = this.canvas.__h
      const x0 = Math.max(dirtyX, -dx), x1 = Math.min(dirtyX + dirtyW, cw - dx)
      if (x1 <= x0) return
      const span = (x1 - x0) * 4
      for (let y = Math.max(dirtyY, -dy), yEnd = Math.min(dirtyY + dirtyH, ch - dy); y < yEnd; y++) {
        const from = (y * iw + x0) * 4
        buf.set(src.subarray(from, from + span), ((y + dy) * cw + (x0 + dx)) * 4)
      }
    }

    drawImage(image, a, b, c, d, e, f, h, i) {
      let pixels = sourcePixels(image)
      if (!pixels) return
      if (!this.canvas.__rgba) return
      // The source's pixel grid: an <img>'s natural size, whatever its width and height attributes say.
      let sw0 = image.naturalWidth > 0 ? image.naturalWidth : image.width, sh0 = image.naturalHeight > 0 ? image.naturalHeight : image.height
      let sx, sy, sw, sh, dx, dy, dw, dh
      const n = arguments.length
      if (n === 3) { sx = 0; sy = 0; sw = sw0; sh = sh0; dx = a; dy = b; dw = sw0; dh = sh0 }
      else if (n === 5) { sx = 0; sy = 0; sw = sw0; sh = sh0; dx = a; dy = b; dw = c; dh = d }
      else if (n === 9) { sx = a; sy = b; sw = c; sh = d; dx = e; dy = f; dw = h; dh = i }
      else throw new TypeError(`drawImage: ${n} arguments is not a valid overload`)
      sx = Number(sx); sy = Number(sy); sw = Number(sw); sh = Number(sh); dx = Number(dx); dy = Number(dy); dw = Number(dw); dh = Number(dh)
      if (!(Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sw) && Number.isFinite(sh) && Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dw) && Number.isFinite(dh))) return
      if (sw < 0) { sx += sw; sw = -sw }
      if (sh < 0) { sy += sh; sh = -sh }
      if (!(sw0 > 0) || !(sh0 > 0)) return
      // Clip the source rect to the picture and shrink the destination with it.
      const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy), cx1 = Math.min(sw0, sx + sw), cy1 = Math.min(sh0, sy + sh)
      if (cx1 <= cx0 || cy1 <= cy0) return
      if (cx0 !== sx || cx1 !== sx + sw) { const k = dw / sw; dx += (cx0 - sx) * k; dw = (cx1 - cx0) * k; sx = cx0; sw = cx1 - cx0 }
      if (cy0 !== sy || cy1 !== sy + sh) { const k = dh / sh; dy += (cy0 - sy) * k; dh = (cy1 - cy0) * k; sy = cy0; sh = cy1 - cy0 }
      const A = this.__a, B = this.__b, C = this.__c, D = this.__d, E = this.__e, F = this.__f
      // An SVG picture is drawn from a raster made for the size it lands at, as a browser draws it, not from its
      // natural-size pixels scaled.
      if (image.__svg) {
        const r = image.__svg.at(Math.max(Math.hypot(A, B) * Math.abs(dw / sw), Math.hypot(C, D) * Math.abs(dh / sh)))
        if (r) { const kx = r.width / sw0, ky = r.height / sh0; pixels = r.rgba; sx *= kx; sw *= kx; sy *= ky; sh *= ky; sw0 = r.width; sh0 = r.height }
      }
      let flt = this.__filter === 'none' ? null : parseFilter(this.__filter)
      if (flt && !flt.n) flt = null
      const bottomUp = !!image.__rgbaBottomUp
      const cw = this.canvas.__w, ch = this.canvas.__h, alpha = this.__alpha
      if (!this.__rot) {
        const ddx = E + dx * A, ddy = F + dy * D, ddw = dw * A, ddh = dh * D
        const draw = () => {
          const buf = this.__target(), mode = this.__mode(), clip = this.__clip
          const one = (region) => {
            if (flt || bottomUp) blitEx(buf, cw, ch, pixels, sw0, sh0, sx, sy, sw, sh, ddx, ddy, ddw, ddh, alpha, flt, bottomUp, region, mode)
            else blit(buf, cw, ch, pixels, sw0, sh0, sx, sy, sw, sh, ddx, ddy, ddw, ddh, alpha, region, mode)
          }
          if (!clip) one(null)
          else if (clip.kind === 'rects') { for (const r of clip.rects) one(r) }
          else one(clip)
        }
        this.__paint(Math.min(ddx, ddx + ddw), Math.min(ddy, ddy + ddh), Math.max(ddx, ddx + ddw), Math.max(ddy, ddy + ddh), draw)
        return
      }
      if (!this.__inverse()) return
      // Turned or skewed: the box of the destination's four corners, each pixel mapped back into the source.
      const ux = dw * A, uy = dw * B, vx = dh * C, vy = dh * D, px = E + dx * A + dy * C, py = F + dx * B + dy * D
      const bx0 = px + Math.min(0, ux) + Math.min(0, vx), bx1 = px + Math.max(0, ux) + Math.max(0, vx), by0 = py + Math.min(0, uy) + Math.min(0, vy), by1 = py + Math.max(0, uy) + Math.max(0, vy)
      const draw = () => blitAffine(this.__target(), cw, ch, pixels, sw0, sh0, sx, sy, sw, sh, dx, dy, dw, dh, bx0, by0, bx1, by1, alpha, flt, bottomUp, this.imageSmoothingEnabled !== false, this.__clip ? this : null, this.__mode())
      this.__paint(bx0, by0, bx1, by1, draw)
    }

    // Text: glyphs from the host's faces (fonts.js, host/img/text.h), placed with kerning and letterSpacing (px),
    // no shaping. __textSetup measures `text` in the current font into textMetrics; false when the host has no face.
    __textSetup(text) {
      const n = g.__native && g.__native.img
      if (!fonts || !n || typeof n.textMeasure !== 'function') return false
      const f = fonts.resolveFont(this.__font)
      if (f.id < 0) return false
      textNative = n; textFace = f; textSpacing = parseFloat(this.letterSpacing) || 0
      n.textMeasure(f.id, f.fallback, f.px, textSpacing, text, textMetrics)
      return true
    }
    __alignOffset(width) {
      const a = this.textAlign, rtl = this.direction === 'rtl'
      if (a === 'center') return -width / 2
      return a === 'right' || (a === 'end' && !rtl) || (a === 'start' && rtl) ? -width : 0
    }
    // The em box from the face's ascent and descent, into emBox (ascent, descent).
    __emBox(px) {
      const fa = textMetrics[5], fd = textMetrics[6]
      emBox[0] = fa + fd > 0 ? px * fa / (fa + fd) : px * 0.8; emBox[1] = px - emBox[0]
    }
    // How far below the textBaseline line the alphabetic baseline lies (y grows downwards). After __emBox.
    __baselineOffset() {
      const emA = emBox[0], emD = emBox[1]
      switch (this.textBaseline) {
        case 'top': return emA
        case 'hanging': return emA * 0.8
        case 'middle': return (emA - emD) / 2
        case 'ideographic': case 'bottom': return -emD
        default: return 0
      }
    }
    measureText(text) {
      text = String(text).replace(/[\t\n\f\r]/g, ' ')
      if (!this.__textSetup(text)) {
        warnOnce('measureText', 'canvas 2d: measureText() estimates 0.6 em per character; no font on this host')
        const m = /(\d+(?:\.\d+)?)px/.exec(this.__font)
        const px = m ? parseFloat(m[1]) : 10
        const width = 0.6 * px * text.length
        return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, actualBoundingBoxAscent: 0.8 * px, actualBoundingBoxDescent: 0.2 * px, fontBoundingBoxAscent: 0.8 * px, fontBoundingBoxDescent: 0.2 * px, emHeightAscent: 0.8 * px, emHeightDescent: 0.2 * px, hangingBaseline: 0.8 * px, alphabeticBaseline: 0, ideographicBaseline: -0.2 * px }
      }
      const m = textMetrics, width = m[0]
      this.__emBox(textFace.px)
      const off = this.__alignOffset(width), base = this.__baselineOffset(), emA = emBox[0], emD = emBox[1]
      return {
        width,
        actualBoundingBoxLeft: m[1] - off, actualBoundingBoxRight: off + m[2],
        actualBoundingBoxAscent: m[3] - base, actualBoundingBoxDescent: m[4] + base,
        fontBoundingBoxAscent: m[5] - base, fontBoundingBoxDescent: m[6] + base,
        emHeightAscent: emA - base, emHeightDescent: emD + base,
        hangingBaseline: emA * 0.8 - base, alphabeticBaseline: 0 - base, ideographicBaseline: -emD - base,
      }
    }
    fillText(text, x, y, maxWidth) {
      if (!this.canvas.__rgba) return
      text = String(text).replace(/[\t\n\f\r]/g, ' ')
      x = Number(x); y = Number(y)
      if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return
      if (!this.__textSetup(text)) { warnOnce('fillText', 'canvas 2d: fillText() draws nothing: no font on this host'); return }
      const width = textMetrics[0]
      let condense = 1
      if (maxWidth !== undefined) { maxWidth = Number(maxWidth); if (!(maxWidth > 0)) return; if (width > maxWidth) condense = maxWidth / width }
      const grad = this.__fillGrad, c = this.__fillRgba, alpha = this.__alpha
      this.__emBox(textFace.px)
      const ux = x + this.__alignOffset(width * condense), uy = y + this.__baselineOffset()   // the run's origin, user space
      const A = this.__a, D = this.__d
      // Upright text is rastered where it lands. Turned, mirrored or skewed text is rastered upright at the
      // transform's scale, then each device pixel reads its coverage back through the inverse transform.
      const upright = !this.__rot && A > 0 && D > 0
      const k = upright ? 1 : this.__scale()
      if (!(k > 0)) return
      const rsx = (upright ? A : k) * condense, rsy = upright ? D : k
      const ox = upright ? this.__e + ux * A : 0, oy = upright ? this.__f + uy * D : 0
      // Rastered at the pen's quarter-pixel phase and placed at its whole pixel: the same label again, or moved by
      // whole pixels, is a copy from the cache.
      let ix = Math.floor(ox), iy = Math.floor(oy), qx = Math.round((ox - ix) * 4) / 4, qy = Math.round((oy - iy) * 4) / 4
      if (qx === 1) { ix++; qx = 0 }
      if (qy === 1) { iy++; qy = 0 }
      const entry = textEntry(textNative, textFace, textSpacing, rsx, rsy, qx, qy, text)
      if (!entry) return
      const w = entry.w, h = entry.h, bx = entry.bx + ix, by = entry.by + iy, cover = entry.A, RGBA = entry.RGBA
      // Colour emoji are drawn in their own colours, whatever the fill style: only they keep a transparent fill busy.
      if (!grad && this.__idle(c[3] * alpha) && !RGBA) return
      const cw = this.canvas.__w, ch = this.canvas.__h
      if (upright) {
        const x0 = Math.max(0, bx), x1 = Math.min(cw, bx + w), y0 = Math.max(0, by), y1 = Math.min(ch, by + h)
        const draw = () => {
          const buf = this.__target(), mode = this.__mode()
          if (grad && !this.__inverse()) return
          for (let py = y0; py < y1; py++) {
            for (let px = x0, ai = (py - by) * w + (x0 - bx), di = (py * cw + x0) * 4; px < x1; px++, ai++, di += 4) {
              const cov = cover[ai]; if (cov === 0 || !this.__covers(px, py)) continue
              if (grad) {
                grad.__colorAt(inv[0] * (px + 0.5) + inv[2] * (py + 0.5) + inv[4], inv[1] * (px + 0.5) + inv[3] * (py + 0.5) + inv[5], gradPx)
                compositePixel(buf, di, gradPx[0], gradPx[1], gradPx[2], gradPx[3] * alpha * cov / 255, mode)
              } else compositePixel(buf, di, c[0], c[1], c[2], c[3] * alpha * cov / 255, mode)
            }
          }
          if (RGBA) for (let py = y0; py < y1; py++) {
            for (let px = x0, ri = ((py - by) * w + (x0 - bx)) * 4, di = (py * cw + x0) * 4; px < x1; px++, ri += 4, di += 4) {
              const a = RGBA[ri + 3]; if (a === 0 || !this.__covers(px, py)) continue
              compositePixel(buf, di, RGBA[ri], RGBA[ri + 1], RGBA[ri + 2], a * alpha, mode)
            }
          }
        }
        this.__paint(x0, y0, x1, y1, draw)
        return
      }
      if (!this.__inverse()) return
      // The coverage box's corners on the canvas: raster point (rx, ry) is the user point (ux + rx / k, uy + ry / k).
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let corner = 0; corner < 4; corner++) {
        const p = this.__pt(ux + (bx + (corner & 1 ? w : 0)) / k, uy + (by + (corner & 2 ? h : 0)) / k)
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1])
      }
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(cw, Math.ceil(x1)); y1 = Math.min(ch, Math.ceil(y1))
      const draw = () => {
        const buf = this.__target(), mode = this.__mode()
        const i0 = inv[0], i1 = inv[1], i2 = inv[2], i3 = inv[3], i4 = inv[4], i5 = inv[5]
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const X = px + 0.5, Y = py + 0.5, gx = i0 * X + i2 * Y + i4, gy = i1 * X + i3 * Y + i5
            const mx = (gx - ux) * k - bx - 0.5, my = (gy - uy) * k - by - 0.5   // in coverage pixels, between their centres
            const xa = Math.floor(mx), ya = Math.floor(my)
            if (xa < -1 || ya < -1 || xa >= w || ya >= h) continue
            const tx = mx - xa, ty = my - ya, xin = xa >= 0, xbin = xa + 1 < w, yin = ya >= 0, ybin = ya + 1 < h
            const cov = (yin ? ((xin ? cover[ya * w + xa] * (1 - tx) : 0) + (xbin ? cover[ya * w + xa + 1] * tx : 0)) * (1 - ty) : 0)
              + (ybin ? ((xin ? cover[(ya + 1) * w + xa] * (1 - tx) : 0) + (xbin ? cover[(ya + 1) * w + xa + 1] * tx : 0)) * ty : 0)
            if ((cov < 0.5 && !RGBA) || !this.__covers(px, py)) continue
            const di = (py * cw + px) * 4
            if (cov >= 0.5) {
              if (grad) { grad.__colorAt(gx, gy, gradPx); compositePixel(buf, di, gradPx[0], gradPx[1], gradPx[2], gradPx[3] * alpha * cov / 255, mode) }
              else compositePixel(buf, di, c[0], c[1], c[2], c[3] * alpha * cov / 255, mode)
            }
            if (RGBA) {
              const a = sampleAt(RGBA, w, h, mx, my, 4, 3)
              if (a >= 1) compositePixel(buf, di, sampleAt(RGBA, w, h, mx, my, 4, 0), sampleAt(RGBA, w, h, mx, my, 4, 1), sampleAt(RGBA, w, h, mx, my, 4, 2), a * alpha, mode)
            }
          }
        }
      }
      this.__paint(x0, y0, x1, y1, draw)
    }
    strokeText() { warnOnce('strokeText', 'canvas 2d: strokeText() draws nothing on this host') }

    // Paths are flattened to polygons in DEVICE space (pathMethods, above the class) and filled by scanFill.
    beginPath() { this.__path = []; this.__sub = null; this.__start = null }
    fill(pathOrRule, rule) {
      if (pathOrRule && typeof pathOrRule === 'object' && typeof pathOrRule.__toDevice === 'function') return this.__withPath(pathOrRule.__toDevice(this), () => this.fill(typeof rule === 'string' ? rule : 'nonzero'))
      if (!this.canvas.__rgba) return
      const evenodd = pathOrRule === 'evenodd', path = this.__path
      const solid = this.__fillGrad ? null : this.__fillRgba
      if (solid && this.__idle(solid[3] * this.__alpha)) return
      const draw = () => {
        const buf = this.__target(), cw = this.canvas.__w, ch = this.canvas.__h, alpha = this.__alpha, mode = this.__mode()
        let row = 0, cover = 1
        const span = (a, b) => {
          if (solid) paintSpan(buf, (row * cw + a) * 4, (row * cw + b) * 4, solid[0], solid[1], solid[2], solid[3] * alpha * cover, mode)
          else this.__fillGradientSpan(buf, a, row, b, row + 1, cover)
        }
        // Edge pixels carry their coverage as alpha; the copy operator would leave them translucent, so it fills whole pixels.
        scanFill(path, evenodd, cw, ch, (py, xa, xb, k) => { row = py; cover = k; this.__clipSpans(py, xa, xb, span) }, mode !== 1)
      }
      if (this.__fillGrad && !this.__inverse()) return
      if (this.__direct()) { draw(); return }
      this.__pathBox(path, 1)
      const r = this.__r
      this.__layered(r[0], r[1], r[2], r[3], draw)
    }
    // The path cut into its dashes (device space): each "on" stretch an open subpath.
    __dashed(path, k) {
      const dash = this.__dash.map(v => v * k), count = dash.length
      let total = 0
      for (const v of dash) total += v
      if (!(total > 0)) return path
      const out = []
      for (const sub of path) {
        if (sub.length < 2) continue
        const pts = sub.closed && sub.length > 2 ? [...sub, sub[0]] : sub
        let idx = 0, on = true, off = (((Number(this.lineDashOffset) || 0) * k) % total + total) % total
        while (off >= dash[idx] && off > 0) { off -= dash[idx]; idx = (idx + 1) % count; on = !on }
        let left = dash[idx] - off
        let cur = on ? [pts[0]] : null
        for (let i = 0; i + 1 < pts.length; i++) {
          let ax = pts[i][0], ay = pts[i][1]
          const bx = pts[i + 1][0], by = pts[i + 1][1]
          let len = Math.hypot(bx - ax, by - ay)
          if (len < 1e-9) continue
          const ux = (bx - ax) / len, uy = (by - ay) / len
          while (len > left) {
            ax += ux * left; ay += uy * left; len -= left
            if (on) { cur.push([ax, ay]); out.push(cur); cur = null } else cur = [[ax, ay]]
            on = !on; idx = (idx + 1) % count; left = dash[idx]
          }
          left -= len
          if (on) cur.push([bx, by])
        }
        if (on && cur && cur.length > 1) out.push(cur)
      }
      return out
    }
    // A stroke is filled as its outline: a quad per segment, the join at each corner (a miter within miterLimit,
    // else a bevel; a disc for round joins), a disc or a half-width extension at each end for round and square
    // caps, every polygon wound the same way so the nonzero fill unions them.
    stroke(pathArg) {
      if (pathArg && typeof pathArg === 'object' && typeof pathArg.__toDevice === 'function') return this.__withPath(pathArg.__toDevice(this), () => this.stroke())
      const k = this.__scale()
      const hw = Math.max(0.5, this.lineWidth * k / 2)
      if (!(hw > 0)) return
      const join = this.lineJoin, cap = this.lineCap, limit = Number(this.miterLimit) || 10
      const polys = [], disc = (x, y) => { const n = Math.max(8, Math.min(48, Math.ceil(hw * 2))), d = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; d.push([x + Math.cos(a) * hw, y + Math.sin(a) * hw]) } polys.push(d) }
      for (const sub of (this.__dash.length ? this.__dashed(this.__path, k) : this.__path)) {
        if (!sub.length) continue
        const pts = []
        for (const p of sub) { const q = pts[pts.length - 1]; if (!q || Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6) pts.push(p) }
        const closed = !!sub.closed && pts.length > 2
        if (closed && Math.abs(pts[0][0] - pts[pts.length - 1][0]) <= 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) <= 1e-6) pts.pop()
        const m = pts.length
        if (m === 1) { disc(pts[0][0], pts[0][1]); continue }
        const segs = closed ? m : m - 1
        for (let i = 0; i < segs; i++) {
          let ax = pts[i][0], ay = pts[i][1], bx = pts[(i + 1) % m][0], by = pts[(i + 1) % m][1]
          const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy)
          const ux = dx / len, uy = dy / len, nx = -uy * hw, ny = ux * hw
          if (cap === 'square' && !closed) { if (i === 0) { ax -= ux * hw; ay -= uy * hw } if (i === segs - 1) { bx += ux * hw; by += uy * hw } }
          polys.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]])
        }
        for (let i = closed ? 0 : 1, end = closed ? m : m - 1; i < end; i++) {
          const p = pts[i], q = pts[(i - 1 + m) % m], r = pts[(i + 1) % m]
          const l1 = Math.hypot(p[0] - q[0], p[1] - q[1]), l2 = Math.hypot(r[0] - p[0], r[1] - p[1])
          const u1x = (p[0] - q[0]) / l1, u1y = (p[1] - q[1]) / l1, u2x = (r[0] - p[0]) / l2, u2y = (r[1] - p[1]) / l2
          // A flattened curve turns a little at every vertex: the gap a join would fill there is under a quarter pixel.
          if (u1x * u2x + u1y * u2y > 0 && Math.abs(u1x * u2y - u1y * u2x) * hw < 0.25) continue
          if (join === 'round') disc(p[0], p[1])
          else addJoin(polys, p[0], p[1], u1x, u1y, u2x, u2y, hw, join !== 'bevel', limit)
        }
        if (cap === 'round' && !closed) { disc(pts[0][0], pts[0][1]); disc(pts[m - 1][0], pts[m - 1][1]) }
      }
      for (const p of polys) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1] } if (a < 0) p.reverse() }
      const path = this.__path, rgba = this.__fillRgba, grad = this.__fillGrad
      this.__path = polys; this.__fillRgba = this.__strokeRgba; this.__fillGrad = this.__strokeGrad
      try { this.fill('nonzero') } finally { this.__path = path; this.__fillRgba = rgba; this.__fillGrad = grad }
    }
    // Intersects the clip with the current path (or a Path2D). Rect paths stay a list of rectangles, which is what a
    // repaint's dirty region is; a rounded rect becomes a coverage mask the size of its own box. The result replaces
    // the clip and save() keeps the previous one, so the objects are never mutated.
    clip(pathOrRule, rule) {
      if (pathOrRule && typeof pathOrRule === 'object' && typeof pathOrRule.__toDevice === 'function') return this.__withPath(pathOrRule.__toDevice(this), () => this.clip(typeof rule === 'string' ? rule : 'nonzero'))
      const evenodd = pathOrRule === 'evenodd'
      const rects = this.__pathRects()
      if (rects && !rectsOverlap(rects) && (this.__clip === null || this.__clip.kind === 'rects')) {
        const cw = this.canvas.__w, ch = this.canvas.__h
        const base = this.__clip ? this.__clip.rects : [[0, 0, cw, ch]]
        const next = []
        for (const r of rects) for (const b of base) {
          const x0 = Math.max(r[0], b[0]), y0 = Math.max(r[1], b[1]), x1 = Math.min(r[2], b[2]), y1 = Math.min(r[3], b[3])
          if (x1 > x0 && y1 > y0) next.push([x0, y0, x1, y1])
        }
        if (!rectsOverlap(next)) { this.__clip = { kind: 'rects', rects: next }; return }
      }
      this.__clip = this.__maskClip(this.__path, evenodd)
    }
    // The current path as device-pixel rects, or null when a subpath is not an axis-aligned rectangle.
    __pathRects() {
      const path = this.__path
      if (!path.length) return []
      const cw = this.canvas.__w, ch = this.canvas.__h, rects = []
      for (const sub of path) {
        if (sub.length !== 4) return null
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const p of sub) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
        for (const p of sub) if ((p[0] !== x0 && p[0] !== x1) || (p[1] !== y0 && p[1] !== y1)) return null
        const px0 = Math.max(0, Math.round(x0)), py0 = Math.max(0, Math.round(y0))
        const px1 = Math.min(cw, Math.round(x1)), py1 = Math.min(ch, Math.round(y1))
        if (px1 > px0 && py1 > py0) rects.push([px0, py0, px1, py1])
      }
      return rects
    }
    __maskClip(path, evenodd) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const sub of path) for (const p of sub) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]) }
      const cw = this.canvas.__w, ch = this.canvas.__h
      if (!Number.isFinite(minX)) return { kind: 'rects', rects: [] }
      const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY))
      const x1 = Math.min(cw, Math.ceil(maxX)), y1 = Math.min(ch, Math.ceil(maxY))
      if (x1 <= x0 || y1 <= y0) return { kind: 'rects', rects: [] }
      const w = x1 - x0, h = y1 - y0, bits = new Uint8Array(w * h)
      scanFill(path, evenodd, cw, ch, (py, xa, xb) => {
        if (py < y0 || py >= y1) return
        const row = (py - y0) * w
        for (let x = Math.max(xa, x0), end = Math.min(xb, x1); x < end; x++) if (this.__covers(x, py)) bits[row + x - x0] = 1
      })
      return { kind: 'mask', x: x0, y: y0, w, h, bits }
    }
    __covers(x, y) {
      const c = this.__clip
      if (!c) return x >= 0 && y >= 0 && x < this.canvas.__w && y < this.canvas.__h
      if (c.kind === 'rects') { for (const r of c.rects) if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) return true; return false }
      if (x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h) return false
      return c.bits[(y - c.y) * c.w + (x - c.x)] !== 0
    }
    // fn(x0, y0, x1, y1) for each piece of the rect inside the clip. Rect clips stay rectangles; a mask breaks the
    // rect into spans a row tall.
    __forClipRect(x0, y0, x1, y1, fn) {
      const c = this.__clip
      if (!c) { fn(x0, y0, x1, y1); return }
      if (c.kind === 'rects') {
        for (const r of c.rects) {
          const a = Math.max(x0, r[0]), b = Math.max(y0, r[1]), d = Math.min(x1, r[2]), e = Math.min(y1, r[3])
          if (d > a && e > b) fn(a, b, d, e)
        }
        return
      }
      for (let y = y0; y < y1; y++) this.__clipSpans(y, x0, x1, (a, b) => fn(a, y, b, y + 1))
    }
    __clipSpans(y, x0, x1, fn) {
      const c = this.__clip
      if (!c) { if (x1 > x0) fn(x0, x1); return }
      if (c.kind === 'rects') {
        for (const r of c.rects) {
          if (y < r[1] || y >= r[3]) continue
          const a = Math.max(x0, r[0]), b = Math.min(x1, r[2])
          if (b > a) fn(a, b)
        }
        return
      }
      if (y < c.y || y >= c.y + c.h) return
      const row = (y - c.y) * c.w
      const start = Math.max(x0, c.x), end = Math.min(x1, c.x + c.w)
      let x = start
      while (x < end) {
        while (x < end && !c.bits[row + x - c.x]) x++
        const a = x
        while (x < end && c.bits[row + x - c.x]) x++
        if (x > a) fn(a, x)
      }
    }
    // Whether the device point (x, y) is inside the current path (or a Path2D), by its winding.
    isPointInPath(a, b, c, d) {
      let path = this.__path, x = a, y = b, rule = c
      if (a && typeof a === 'object' && typeof a.__toDevice === 'function') { path = a.__toDevice(this); x = b; y = c; rule = d }
      x = Number(x); y = Number(y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false
      let wind = 0, crossings = 0
      for (const sub of path) {
        for (let i = 0, n = sub.length; i < n && n > 1; i++) {
          const p = sub[i], q = sub[i + 1 < n ? i + 1 : 0]
          if ((p[1] <= y) === (q[1] <= y)) continue
          if (p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]) > x) { wind += q[1] > p[1] ? 1 : -1; crossings++ }
        }
      }
      return rule === 'evenodd' ? (crossings & 1) === 1 : wind !== 0
    }
    isPointInStroke() { return false }
    // Gradient fill of a device-space span: the colour at each pixel centre, mapped back to user space through `inv`
    // (the caller ran __inverse() once for the whole draw).
    __fillGradientSpan(buf, x0, y0, x1, y1, cover = 1) {
      const grad = this.__fillGrad, cw = this.canvas.__w, out = gradPx, alpha = this.__alpha * cover, mode = this.__mode()
      const i0 = inv[0], i1 = inv[1], i2 = inv[2], i3 = inv[3], i4 = inv[4], i5 = inv[5]
      if (grad.__stops.length) {
        // Colours from the gradient's table (__lut). A linear gradient's t is linear along a row (the inverse
        // transform is affine): it steps by the same amount each pixel, and pixels that look up the same entry are
        // painted as one span (a vertical gradient's whole row, a slanted one's runs).
        const table = grad.__lut(), n1 = GRADIENT_STEPS - 1, p = grad.__p
        const index = (t) => (((t < 0 ? 0 : t > 1 ? 1 : t) * n1 + 0.5) | 0) * 4
        const ldx = p[2] - p[0], ldy = p[3] - p[1], d = ldx * ldx + ldy * ldy
        if (grad.__kind === 'linear' && d > 0) {
          const step = (i0 * ldx + i1 * ldy) / d
          for (let py = y0; py < y1; py++) {
            const X = x0 + 0.5, Y = py + 0.5, row = py * cw * 4
            let t = ((i0 * X + i2 * Y + i4 - p[0]) * ldx + (i1 * X + i3 * Y + i5 - p[1]) * ldy) / d
            if (step === 0) {
              const i = index(t), a = table[i + 3] * alpha
              if (a > 0 || mode === 1) paintSpan(buf, row + x0 * 4, row + x1 * 4, table[i], table[i + 1], table[i + 2], a, mode)
              continue
            }
            let px = x0, i = index(t)
            while (px < x1) {
              let end = px + 1, j = -1
              t += step
              while (end < x1) { j = index(t); if (j !== i) break; end++; t += step }
              const a = table[i + 3] * alpha
              if (a > 0 || mode === 1) paintSpan(buf, row + px * 4, row + end * 4, table[i], table[i + 1], table[i + 2], a, mode)
              px = end; i = j
            }
          }
          return
        }
        if (grad.__kind !== 'linear') {
          for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
            const X = px + 0.5, Y = py + 0.5, t = grad.__t(i0 * X + i2 * Y + i4, i1 * X + i3 * Y + i5)
            const di = (py * cw + px) * 4
            if (Number.isNaN(t)) { if (mode === 1) compositePixel(buf, di, 0, 0, 0, 0, mode); continue }
            const i = index(t), a = table[i + 3] * alpha
            if (a > 0 || mode === 1) compositePixel(buf, di, table[i], table[i + 1], table[i + 2], a, mode)
          }
          return
        }
      }
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        grad.__colorAt(i0 * (px + 0.5) + i2 * (py + 0.5) + i4, i1 * (px + 0.5) + i3 * (py + 0.5) + i5, out)
        const a = out[3] * alpha
        if (a > 0 || mode === 1) compositePixel(buf, (py * cw + px) * 4, out[0], out[1], out[2], a, mode)
      }
    }
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient('linear', [x0, y0, x1, y1].map(Number)) }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { const p = [x0, y0, r0, x1, y1, r1].map(Number); if (p[2] < 0 || p[5] < 0) throw domError(g, 'IndexSizeError', 'createRadialGradient: negative radius'); return new CanvasGradient('radial', p) }
    createConicGradient(a, x, y) { warnOnce('conic', 'canvas 2d: conic gradients are drawn as radial'); return new CanvasGradient('radial', [x, y, 0, x, y, 1e9].map(Number)) }
    createPattern() { warnOnce('pattern', 'canvas 2d: patterns are not supported'); return null }

    get [Symbol.toStringTag]() { return 'CanvasRenderingContext2D' }
  }

  class CanvasBase extends EventTargetBase {
    constructor(w, h) {
      super()
      this.__w = w; this.__h = h
      this.__rgba = new Uint8Array(w * h * 4)
      this.__ctx = null
      this.__gl = null
    }
    get width() { return this.__w }
    set width(v) { this.__resize(toSize(v, DEFAULT_W), this.__h) }
    get height() { return this.__h }
    set height(v) { this.__resize(this.__w, toSize(v, DEFAULT_H)) }
    // Setting a dimension (even to its current value) clears the bitmap and the 2D state, as in the DOM.
    __resize(w, h) {
      this.__w = w; this.__h = h
      if (this.__gl) {
        if (typeof this.__gl.__hostCanvasResized === 'function') this.__gl.__hostCanvasResized(w, h)
      } else this.__rgba = new Uint8Array(w * h * 4)
      if (this.__ctx) this.__ctx.__reset()
    }

    getContext(type, attrs) {
      type = String(type)
      if (type === '2d') {
        if (this.__gl) return null
        if (!this.__ctx) this.__ctx = new CanvasRenderingContext2D(this)
        return this.__ctx
      }
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        if (this.__ctx) return null
        if (this.__gl) return this.__gl
        const make = g.__hostCreateWebGLContext
        if (typeof make !== 'function') return null
        const ctx = make(this, attrs || {}, type)
        if (!ctx) return null
        this.__gl = ctx
        if (!glOwner) { glOwner = this; this.__rgba = null }  // the primary drawing buffer lives on the GPU (XR swapchain / window)
        else {  // a secondary one reads back on demand: GL's bottom-up rows, in a buffer the context reuses
          Object.defineProperty(this, '__rgba', { get: () => ctx.__readback(), set() {}, configurable: true })
          Object.defineProperty(this, '__rgbaBottomUp', { value: true, configurable: true })
        }
        return ctx
      }
      return null
    }

    __encode(type) {
      if (type && type !== 'image/png') warnOnce('encode:' + type, `canvas: '${type}' is encoded as image/png on this host`)
      const px = this.__rgba  // once: a WebGL canvas reads back on every access
      if (!px || !(this.__w > 0) || !(this.__h > 0)) return null
      // A WebGL canvas's rows are bottom-up in its context's scratch buffer: flipped in place (the next readback overwrites it).
      return encodePngBytes(g, this.__w, this.__h, this.__rgbaBottomUp ? flipRows(px, this.__w, this.__h) : px)
    }
    __blob(type) {
      const bytes = this.__encode(type)
      if (!bytes) return null
      const B = g.Blob || globalThis.Blob
      if (typeof B !== 'function') throw new Error('canvas: Blob is not available')
      return new B([bytes], { type: 'image/png' })
    }
    toBlob(callback, type) {
      if (typeof callback !== 'function') throw new TypeError('toBlob: a callback is required')
      defer(() => callback(this.__blob(type)))
    }
    toDataURL(type) {
      const bytes = this.__encode(type)
      return bytes ? 'data:image/png;base64,' + base64Encode(bytes) : 'data:,'
    }
    convertToBlob(options) {
      return new Promise((resolve, reject) => defer(() => {
        try {
          const blob = this.__blob(options && options.type)
          blob ? resolve(blob) : reject(domError(g, 'IndexSizeError', 'convertToBlob: the canvas has no pixels'))
        } catch (e) { reject(e) }
      }))
    }
    // Hands the current pixels to a bitmap and starts a fresh transparent buffer.
    transferToImageBitmap() {
      if (this.__gl) {
        if (typeof this.__gl.__hostReadPixels === 'function') return newBitmap(this.__w, this.__h, new Uint8Array(this.__gl.__hostReadPixels()), false)
        throw domError(g, 'InvalidStateError', 'transferToImageBitmap: the WebGL canvas cannot be read back on this host')
      }
      if (!this.__ctx) throw domError(g, 'InvalidStateError', 'transferToImageBitmap: the canvas has no context')
      const bmp = newBitmap(this.__w, this.__h, this.__rgba, false)
      this.__rgba = new Uint8Array(this.__w * this.__h * 4)
      return bmp
    }
  }

  class OffscreenCanvas extends CanvasBase {
    constructor(width, height) {
      if (arguments.length < 2) throw new TypeError('OffscreenCanvas: 2 arguments required')
      super(toSize(width, 0), toSize(height, 0))
      this.oncontextlost = null; this.oncontextrestored = null
    }
    get [Symbol.toStringTag]() { return 'OffscreenCanvas' }
  }

  class HTMLCanvasElement extends CanvasBase {
    constructor() {
      super(DEFAULT_W, DEFAULT_H)
      this.tabIndex = -1  // a browser canvas is focusable once a keyboard driver asks; -1 until then
      this.__attrs = new Map()
      this.__classes = new Set()
      this._attrs = this.__attrs  // Element's id setter, once this object is an HTMLElement
      this.childNodes = []
      this.style = elementStyle(g)  // DOMRoot calls style.removeProperty; a plain object has none
      this.dataset = {}
      this.parentNode = null
      // Own fields, ahead of Element's accessors (those need Element's constructor, which this is not).
      Object.defineProperty(this, 'id', { value: '', writable: true, configurable: true, enumerable: true })
      Object.defineProperty(this, 'className', { value: '', writable: true, configurable: true, enumerable: true })
    }
    get tagName() { return 'CANVAS' }
    get nodeName() { return 'CANVAS' }
    get nodeType() { return 1 }
    get localName() { return 'canvas' }
    get ownerDocument() { return g.document || null }
    // Its CSS box: the viewport for the page's main canvas (the one the WebGL context was made for, or one a page
    // declared at its top level), else its bitmap's size. There is no layout; pages size their main canvas to the
    // window and read it back from here.
    __viewportSized() { return !!(this._fillsViewport?.() || (this.__gl && this.__gl === g.__hostGL?.() && this.parentNode)) }
    get clientWidth() { return this.__viewportSized() ? g.innerWidth : this.__w }
    get clientHeight() { return this.__viewportSized() ? g.innerHeight : this.__h }
    get offsetWidth() { return this.clientWidth }
    get offsetHeight() { return this.clientHeight }
    get classList() {
      const s = this.__classes
      return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)), contains: c => s.has(c), toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; on ? s.add(c) : s.delete(c); return on }, get length() { return s.size } }
    }
    getBoundingClientRect() { const w = this.clientWidth, h = this.clientHeight; return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return this } } }
    setAttribute(name, value) {
      name = String(name).toLowerCase()
      if (name === 'width') this.width = parseInt(value, 10)
      else if (name === 'height') this.height = parseInt(value, 10)
      else if (name === 'id') this.id = String(value)
      else if (name === 'class') this.className = String(value)
      else this.__attrs.set(name, String(value))
    }
    getAttribute(name) {
      name = String(name).toLowerCase()
      if (name === 'width') return String(this.__w)
      if (name === 'height') return String(this.__h)
      if (name === 'id') return this.id || null
      if (name === 'class') return this.className || null
      return this.__attrs.has(name) ? this.__attrs.get(name) : null
    }
    hasAttribute(name) { return this.getAttribute(name) !== null }
    removeAttribute(name) {
      name = String(name).toLowerCase()
      if (name === 'width') this.width = DEFAULT_W
      else if (name === 'height') this.height = DEFAULT_H
      else this.__attrs.delete(name)
    }
    remove() { if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this) }
    focus() {} blur() {}
    setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false }
    requestPointerLock() { return g.__hostRequestPointerLock ? g.__hostRequestPointerLock(this) : Promise.resolve() }
    captureStream() { throw domError(g, 'NotSupportedError', 'captureStream is not supported') }
    get [Symbol.toStringTag]() { return 'HTMLCanvasElement' }
  }

  // A browser canvas is an HTMLElement (instanceof, focus, tabIndex). CanvasBase stays an EventTarget so an
  // OffscreenCanvas is not an element; the element's own methods sit on HTMLCanvasElement.prototype and the
  // shared canvas methods are linked in under it, ahead of HTMLElement.
  if (typeof g.HTMLElement === 'function') {
    const bridge = Object.create(g.HTMLElement.prototype)
    for (const key of Reflect.ownKeys(CanvasBase.prototype)) {
      if (key === 'constructor') continue
      const desc = Object.getOwnPropertyDescriptor(CanvasBase.prototype, key)
      if (desc) Object.defineProperty(bridge, key, desc)
    }
    Object.setPrototypeOf(HTMLCanvasElement.prototype, bridge)
  }

  // A path kept in user space: SVG path data (the game's UI builds icons with `new Path2D("M … L … C … Z")` at
  // module load) and/or the context's path-building calls, then fill(path) / stroke(path) / clip(path) under
  // whatever transform is current.
  class Path2D {
    constructor(d) {
      this.__path = []; this.__sub = null; this.__start = null
      if (d instanceof Path2D) this.addPath(d)
      else if (d !== undefined && d !== null) parseSvgPath(this, d)
    }
    __pt(x, y) { return [Number(x), Number(y)] }
    __cur() { const s = this.__sub; return s ? s[s.length - 1] : this.__start || [0, 0] }
    // Flattened once and drawn at any scale: four device pixels a unit are assumed, for arcs (__res) and curves (__flat).
    __res() { return 4 }
    __flat() { return 4 }
    addPath(other, m) {
      if (!other || !other.__path) return
      for (const s of other.__path) {
        const copy = s.map(p => m ? [(m.a ?? 1) * p[0] + (m.c ?? 0) * p[1] + (m.e ?? 0), (m.b ?? 0) * p[0] + (m.d ?? 1) * p[1] + (m.f ?? 0)] : p.slice())
        copy.closed = !!s.closed
        this.__path.push(copy)
      }
      this.__sub = null; this.__start = null
    }
    __toDevice(ctx) {
      return this.__path.map(sub => {
        const d = sub.map(p => ctx.__pt(p[0], p[1]))
        d.closed = !!sub.closed
        return d
      })
    }
    get [Symbol.toStringTag]() { return 'Path2D' }
  }
  for (const key of Object.keys(pathMethods)) {
    Object.defineProperty(CanvasRenderingContext2D.prototype, key, { value: pathMethods[key], writable: true, configurable: true })
    Object.defineProperty(Path2D.prototype, key, { value: pathMethods[key], writable: true, configurable: true })
  }

  return { HTMLCanvasElement, OffscreenCanvas, CanvasRenderingContext2D, Path2D }
}

// SVG path data (M L H V C S Q T A Z, absolute and relative) into a Path2D through its own builders, which flatten
// the curves; the parser keeps the current point and the last control point for S and T.
function parseSvgPath(p, d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []
  let x = 0, y = 0, sx = 0, sy = 0, i = 0
  let cx = 0, cy = 0, prev = ''   // the last curve's far control point, for S and T
  const isCmd = (t) => /^[A-Za-z]$/.test(t)
  const num = () => parseFloat(tokens[i++])
  // An arc's flags are single digits and minifiers write them without a separator ("a4 4 0 014 4").
  const flag = () => { const t = tokens[i]; if (t !== undefined && t.length > 1 && (t[0] === '0' || t[0] === '1')) { tokens[i] = t.slice(1); return +t[0] } i++; return parseFloat(t) }
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (!isCmd(cmd)) break
    const rel = cmd === cmd.toLowerCase()
    let op = cmd.toUpperCase()
    if (op === 'Z') { p.closePath(); x = sx; y = sy; prev = 'Z'; continue }
    while (i < tokens.length && !isCmd(tokens[i])) {
      let nx, ny
      if (op === 'M') { nx = num(); ny = num(); if (rel) { nx += x; ny += y } p.moveTo(nx, ny); sx = nx; sy = ny; op = 'L' }   // further pairs are linetos
      else if (op === 'L') { nx = num(); ny = num(); if (rel) { nx += x; ny += y } p.lineTo(nx, ny) }
      else if (op === 'H') { nx = num(); ny = y; if (rel) nx += x; p.lineTo(nx, ny) }
      else if (op === 'V') { nx = x; ny = num(); if (rel) ny += y; p.lineTo(nx, ny) }
      else if (op === 'C' || op === 'S') {
        let c1x, c1y
        if (op === 'C') { c1x = num(); c1y = num(); if (rel) { c1x += x; c1y += y } }
        else { const smooth = prev === 'C' || prev === 'S'; c1x = smooth ? 2 * x - cx : x; c1y = smooth ? 2 * y - cy : y }
        let c2x = num(), c2y = num(); nx = num(); ny = num()
        if (rel) { c2x += x; c2y += y; nx += x; ny += y }
        p.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny); cx = c2x; cy = c2y
      } else if (op === 'Q' || op === 'T') {
        let qx, qy
        if (op === 'Q') { qx = num(); qy = num(); if (rel) { qx += x; qy += y } }
        else { const smooth = prev === 'Q' || prev === 'T'; qx = smooth ? 2 * x - cx : x; qy = smooth ? 2 * y - cy : y }
        nx = num(); ny = num(); if (rel) { nx += x; ny += y }
        p.quadraticCurveTo(qx, qy, nx, ny); cx = qx; cy = qy
      } else if (op === 'A') {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag()
        nx = num(); ny = num(); if (rel) { nx += x; ny += y }
        for (const q of svgArcPoints(x, y, rx, ry, rot, large, sweep, nx, ny)) p.lineTo(q[0], q[1])
      } else break
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
      x = nx; y = ny; prev = op
    }
  }
}

function svgArcPoints(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (!(rx > 0) || !(ry > 0)) return [[x2, y2]]
  const phi = phiDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy
  let rx2 = rx * rx, ry2 = ry * ry
  const lam = x1p * x1p / rx2 + y1p * y1p / ry2
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry }
  const sign = (large === sweep) ? -1 : 1
  const sq = Math.max(0, (rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p) / (rx2 * y1p * y1p + ry2 * x1p * x1p))
  const coef = sign * Math.sqrt(sq)
  const cxp = coef * rx * y1p / ry, cyp = coef * -ry * x1p / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux, uy, vx, vy) => { let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1)))); if (ux * vy - uy * vx < 0) a = -a; return a }
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI
  const n = Math.max(8, Math.min(64, Math.ceil(Math.abs(dtheta) * Math.max(rx, ry) * 8)))
  const pts = []
  for (let k = 1; k <= n; k++) {
    const t = theta1 + dtheta * k / n, ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    pts.push([cx + ex * cos - ey * sin, cy + ex * sin + ey * cos])
  }
  pts[pts.length - 1] = [x2, y2]
  return pts
}
