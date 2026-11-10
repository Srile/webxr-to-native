// HTMLCanvasElement / OffscreenCanvas over a CPU RGBA8 buffer (`__rgba`), and
// the Canvas 2D subset uikit, the MSDF generator and three's texture resizing
// touch. getContext('webgl2'|'webgl') on the FIRST canvas hands out the host's
// one GL context through g.__hostCreateWebGLContext (WP-04).
import { base64Encode, blit, compositePixel, domError, encodePngBytes, flipRows, parseColor } from './pixels.js'

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
  let edgeBuf = new Float64Array(5 * 256), xsBuf = new Float64Array(64), wsBuf = new Float64Array(64)
  const gradPx = new Float64Array(4)   // a gradient colour at one pixel
  // Text scratch (__native.img.textMeasure / textRaster): metrics, a glyph-run coverage mask and its box.
  const textMetrics = new Float64Array(7), textBox = new Int32Array(4), emBox = new Float64Array(2)
  let textAlpha = new Uint8Array(64 * 1024)
  let textNative = null, textFace = null, textSpacing = 0   // set by __textSetup for the call that follows it
  const clampPx = new Uint8ClampedArray(4)   // rounds/clamps a filtered pixel exactly as a Uint8ClampedArray store does

  // Source-over of one constant colour (a in 0..255, fractional allowed) over buf[i, end):
  // blendPixel inlined over a span, byte-identical to it.
  function blendSpan(buf, i, end, r, gg, b, a) {
    if (a <= 0) return
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
  // blendSpan for source-over; copy replaces the span and destination-out punches its alpha (the colour is unused).
  function paintSpan(buf, i, end, r, gg, b, a, mode) {
    if (mode === 1) { const aa = a >= 255 ? 255 : a <= 0 ? 0 : Math.round(a); for (; i < end; i += 4) { buf[i] = r; buf[i + 1] = gg; buf[i + 2] = b; buf[i + 3] = aa } return }
    if (mode === 2) {
      if (a <= 0) return
      if (a >= 255) { for (; i < end; i += 4) buf[i + 3] = 0; return }
      const k = 1 - a / 255
      for (; i < end; i += 4) buf[i + 3] = Math.round(buf[i + 3] * k)
      return
    }
    blendSpan(buf, i, end, r, gg, b, a)
  }

  class CanvasGradient {
    constructor(kind, p) { this.__kind = kind; this.__p = p; this.__stops = [] }
    addColorStop(offset, color) {
      offset = Number(offset); if (!(offset >= 0 && offset <= 1)) throw domError(g, 'IndexSizeError', 'addColorStop: offset out of range')
      const c = colour(String(color)); if (!c) throw domError(g, 'SyntaxError', `addColorStop: '${color}' is not a colour`)
      this.__stops.push([offset, c]); this.__stops.sort((a, b) => a[0] - b[0])
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
      const st = this.__stops
      if (!st.length) { out[0] = out[1] = out[2] = out[3] = 0; return }
      let t = this.__t(x, y)
      if (Number.isNaN(t)) { out[0] = out[1] = out[2] = out[3] = 0; return }
      t = t < 0 ? 0 : t > 1 ? 1 : t
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

  // Inside spans of a filled path, in device pixels: fn(py, x0, x1) with x1 exclusive. The same coverage fill() paints.
  function scanFill(path, evenodd, cw, ch, fn) {
    let total = 0
    for (let s = 0; s < path.length; s++) total += path[s].length
    if (!total) return
    if (edgeBuf.length < total * 5) edgeBuf = new Float64Array(Math.max(total * 5, edgeBuf.length * 2))
    const edges = edgeBuf
    let ne = 0, minY = Infinity, maxY = -Infinity
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
      }
    }
    if (!ne) return
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(ch, Math.ceil(maxY))
    if (xsBuf.length < ne) { xsBuf = new Float64Array(Math.max(ne, xsBuf.length * 2)); wsBuf = new Float64Array(xsBuf.length) }
    const xs = xsBuf, ws = wsBuf
    for (let py = y0; py < y1; py++) {
      const sy = py + 0.5
      let nx = 0
      for (let o = 0, end = ne * 5; o < end; o += 5) {
        const ey0 = edges[o + 1], ey1 = edges[o + 3]
        if (!(sy >= ey0 && sy < ey1)) continue
        const ex0 = edges[o]
        const x = ex0 + (sy - ey0) * (edges[o + 2] - ex0) / (ey1 - ey0), w = edges[o + 4]
        let j = nx - 1
        while (j >= 0 && xs[j] > x) { xs[j + 1] = xs[j]; ws[j + 1] = ws[j]; j-- }
        xs[j + 1] = x; ws[j + 1] = w; nx++
      }
      let wind = 0
      for (let i = 0; i < nx - 1; i++) {
        wind += evenodd ? 1 : ws[i]
        if (!(evenodd ? (wind & 1) === 1 : wind !== 0)) continue
        const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(cw, Math.round(xs[i + 1]))
        if (xb > xa) fn(py, xa, xb)
      }
    }
  }
  function rectsOverlap(list) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) return true
    }
    return false
  }

  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas
      this.__stack = []   // save() records, reused: __depth of them are live
      this.__depth = 0
      this.__r = new Float64Array(4)   // __rect output: x0, y0, x1, y1 in device pixels
      this.__reset()
    }
    __reset() {
      this.__fill = '#000000'; this.__fillRgba = [0, 0, 0, 255]; this.__fillGrad = null; this.__filter = 'none'; this.__path = []; this.__sub = null
      this.__stroke = '#000000'
      this.__alpha = 1
      this.__font = '10px sans-serif'
      this.__op = 'source-over'
      this.__clip = null   // null: the whole canvas. {kind:'rects', rects:[[x0,y0,x1,y1]]} or {kind:'mask', x, y, w, h, bits}
      this.textAlign = 'start'; this.textBaseline = 'alphabetic'; this.direction = 'inherit'
      this.letterSpacing = '0px'; this.wordSpacing = '0px'; this.fontKerning = 'auto'
      this.lineWidth = 1; this.lineCap = 'butt'; this.lineJoin = 'miter'; this.miterLimit = 10
      this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low'
      this.shadowBlur = 0; this.shadowColor = 'rgba(0, 0, 0, 0)'; this.shadowOffsetX = 0; this.shadowOffsetY = 0
      this.__tx = 0; this.__ty = 0; this.__sx = 1; this.__sy = 1
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
    set strokeStyle(v) { if (typeof v === 'string') this.__stroke = v }
    get globalAlpha() { return this.__alpha }
    set globalAlpha(v) { v = Number(v); if (Number.isFinite(v) && v >= 0 && v <= 1) this.__alpha = v }
    get font() { return this.__font }
    set font(v) { if (typeof v === 'string' && v.trim()) this.__font = v }
    get globalCompositeOperation() { return this.__op }
    set globalCompositeOperation(v) {
      if (v === 'source-over' || v === 'copy' || v === 'destination-out') { this.__op = v; return }
      warnOnce('gco:' + v, `canvas 2d: globalCompositeOperation '${v}' is left unchanged`)
    }
    __mode() { return this.__op === 'copy' ? 1 : this.__op === 'destination-out' ? 2 : 0 }

    getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false } }

    save() {
      let s = this.__stack[this.__depth]
      if (!s) this.__stack.push(s = { fill: null, fillRgba: null, fillGrad: null, filter: null, stroke: null, alpha: 0, font: null, op: null, align: null, base: null, spacing: null, lw: 0, smooth: false, tx: 0, ty: 0, sx: 0, sy: 0, clip: null })
      this.__depth++
      s.fill = this.__fill; s.fillRgba = this.__fillRgba; s.fillGrad = this.__fillGrad; s.filter = this.__filter; s.stroke = this.__stroke; s.alpha = this.__alpha; s.font = this.__font
      s.op = this.__op; s.clip = this.__clip; s.align = this.textAlign; s.base = this.textBaseline; s.spacing = this.letterSpacing; s.lw = this.lineWidth; s.smooth = this.imageSmoothingEnabled
      s.tx = this.__tx; s.ty = this.__ty; s.sx = this.__sx; s.sy = this.__sy
    }
    restore() {
      if (this.__depth === 0) return
      const s = this.__stack[--this.__depth]
      this.__fill = s.fill; this.__fillRgba = s.fillRgba; this.__fillGrad = s.fillGrad; this.__filter = s.filter; this.__stroke = s.stroke; this.__alpha = s.alpha; this.__font = s.font
      this.__op = s.op; this.__clip = s.clip; this.textAlign = s.align; this.textBaseline = s.base; this.letterSpacing = s.spacing; this.lineWidth = s.lw; this.imageSmoothingEnabled = s.smooth
      this.__tx = s.tx; this.__ty = s.ty; this.__sx = s.sx; this.__sy = s.sy
      s.fillGrad = null; s.fill = null   // do not keep a gradient alive through a dead record
    }
    // Translate and scale are kept (axis-aligned rects honour them); rotation is not drawn.
    scale(x, y) { x = Number(x); y = Number(y); if (Number.isFinite(x) && Number.isFinite(y)) { this.__sx *= x; this.__sy *= y } }
    translate(x, y) { x = Number(x); y = Number(y); if (Number.isFinite(x) && Number.isFinite(y)) { this.__tx += x * this.__sx; this.__ty += y * this.__sy } }
    rotate() { warnOnce('rotate', 'canvas 2d: rotate() is ignored') }
    transform() { warnOnce('transform', 'canvas 2d: transform() is ignored') }
    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) { b = a.b; c = a.c; d = a.d; e = a.e; f = a.f; a = a.a }
      if (arguments.length === 0 || a === undefined) { this.resetTransform(); return }
      if (b || c) warnOnce('setTransform', 'canvas 2d: setTransform() keeps only the scale and the translation')
      this.__sx = Number(a) || 0; this.__sy = Number(d) || 0; this.__tx = Number(e) || 0; this.__ty = Number(f) || 0
    }
    resetTransform() { this.__tx = 0; this.__ty = 0; this.__sx = 1; this.__sy = 1 }
    getTransform() { return { a: this.__sx, b: 0, c: 0, d: this.__sy, e: this.__tx, f: this.__ty, is2D: true, isIdentity: this.__sx === 1 && this.__sy === 1 && this.__tx === 0 && this.__ty === 0 } }

    // A user-space rect to device pixels, clipped to the canvas, into this.__r (x0, y0, x1, y1).
    // False when it covers no pixel.
    __rect(x, y, w, h) {
      x = this.__tx + Number(x) * this.__sx; y = this.__ty + Number(y) * this.__sy; w = Number(w) * this.__sx; h = Number(h) * this.__sy
      if (w < 0) { x += w; w = -w }
      if (h < 0) { y += h; h = -h }
      const c = this.canvas, r = this.__r
      const x0 = r[0] = Math.max(0, Math.round(x)), y0 = r[1] = Math.max(0, Math.round(y))
      const x1 = r[2] = Math.min(c.__w, Math.round(x + w)), y1 = r[3] = Math.min(c.__h, Math.round(y + h))
      return x1 > x0 && y1 > y0
    }

    clearRect(x, y, w, h) {
      const buf = this.canvas.__rgba; if (!buf) return
      if (!this.__rect(x, y, w, h)) return
      const r = this.__r, cw = this.canvas.__w
      // clearRect ignores the composite mode and the fill, but it honours the clip: a repaint clears the whole
      // canvas inside a clip of just the dirty rectangles, and everything outside it has to survive.
      this.__forClipRect(r[0], r[1], r[2], r[3], (x0, y0, x1, y1) => {
        for (let py = y0; py < y1; py++) buf.fill(0, (py * cw + x0) * 4, (py * cw + x1) * 4)
      })
    }
    fillRect(x, y, w, h) {
      const buf = this.canvas.__rgba; if (!buf) return
      if (!this.__rect(x, y, w, h)) return
      const rr = this.__r
      this.__forClipRect(rr[0], rr[1], rr[2], rr[3], (x0, y0, x1, y1) => this.__paintRect(buf, x0, y0, x1, y1))
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
    strokeRect(x, y, w, h) { const path = this.__path, sub = this.__sub; this.__path = []; this.__sub = null; this.rect(x, y, w, h); this.stroke(); this.__path = path; this.__sub = sub }

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
      const pixels = sourcePixels(image)
      if (!pixels) return
      const buf = this.canvas.__rgba; if (!buf) return
      const sw0 = image.width, sh0 = image.height
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
      const ddx = this.__tx + dx * this.__sx, ddy = this.__ty + dy * this.__sy, ddw = dw * this.__sx, ddh = dh * this.__sy
      let flt = this.__filter === 'none' ? null : parseFilter(this.__filter)
      if (flt && !flt.n) flt = null
      const bottomUp = !!image.__rgbaBottomUp
      const mode = this.__mode(), cw = this.canvas.__w, ch = this.canvas.__h
      const draw = (clip) => {
        if (flt || bottomUp) blitEx(buf, cw, ch, pixels, sw0, sh0, sx, sy, sw, sh, ddx, ddy, ddw, ddh, this.__alpha, flt, bottomUp, clip, mode)
        else blit(buf, cw, ch, pixels, sw0, sh0, sx, sy, sw, sh, ddx, ddy, ddw, ddh, this.__alpha, clip, mode)
      }
      const clip = this.__clip
      if (!clip) draw(null)
      else if (clip.kind === 'rects') { for (const r of clip.rects) draw(r) }
      else draw(clip)
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
      const buf = this.canvas.__rgba; if (!buf) return
      text = String(text).replace(/[\t\n\f\r]/g, ' ')
      x = Number(x); y = Number(y)
      if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return
      if (!this.__textSetup(text)) { warnOnce('fillText', 'canvas 2d: fillText() draws nothing: no font on this host'); return }
      const width = textMetrics[0]
      let condense = 1
      if (maxWidth !== undefined) { maxWidth = Number(maxWidth); if (!(maxWidth > 0)) return; if (width > maxWidth) condense = maxWidth / width }
      const sx = this.__sx * condense, sy = this.__sy
      if (!(sx > 0) || !(sy > 0)) { warnOnce('fillText:flip', 'canvas 2d: text under a mirrored or zero scale is not drawn'); return }
      this.__emBox(textFace.px)
      const ox = this.__tx + (x + this.__alignOffset(width * condense)) * this.__sx
      const oy = this.__ty + (y + this.__baselineOffset()) * this.__sy
      const n = textNative, f = textFace
      if (!n.textRaster(f.id, f.fallback, f.px, textSpacing, sx, sy, ox, oy, text, textAlpha, textBox)) {
        const need = textBox[0] * textBox[1]
        if (need <= textAlpha.length) return   // nothing inked
        textAlpha = new Uint8Array(Math.max(need, textAlpha.length * 2))
        if (!n.textRaster(f.id, f.fallback, f.px, textSpacing, sx, sy, ox, oy, text, textAlpha, textBox)) return
      }
      const w = textBox[0], h = textBox[1], bx = textBox[2], by = textBox[3]
      const cw = this.canvas.__w, ch = this.canvas.__h
      const grad = this.__fillGrad, c = this.__fillRgba, alpha = this.__alpha, mode = this.__mode()
      if (!grad && c[3] * alpha <= 0 && mode !== 1) return
      const x0 = Math.max(0, bx), x1 = Math.min(cw, bx + w), y0 = Math.max(0, by), y1 = Math.min(ch, by + h)
      for (let py = y0; py < y1; py++) {
        for (let px = x0, ai = (py - by) * w + (x0 - bx), di = (py * cw + x0) * 4; px < x1; px++, ai++, di += 4) {
          const cov = textAlpha[ai]; if (cov === 0 || !this.__covers(px, py)) continue
          if (grad) {
            grad.__colorAt((px + 0.5 - this.__tx) / this.__sx, (py + 0.5 - this.__ty) / this.__sy, gradPx)
            compositePixel(buf, di, gradPx[0], gradPx[1], gradPx[2], gradPx[3] * alpha * cov / 255, mode)
          } else compositePixel(buf, di, c[0], c[1], c[2], c[3] * alpha * cov / 255, mode)
        }
      }
    }
    strokeText() { warnOnce('strokeText', 'canvas 2d: strokeText() draws nothing on this host') }

    // Paths are flattened to polygons in DEVICE space and filled by a non-antialiased scanline pass.
    __pt(x, y) { return [this.__tx + Number(x) * this.__sx, this.__ty + Number(y) * this.__sy] }
    beginPath() { this.__path = []; this.__sub = null }
    closePath() { if (this.__sub && this.__sub.length) { this.__sub.closed = true; this.__sub = null } }
    moveTo(x, y) { this.__sub = [this.__pt(x, y)]; this.__path.push(this.__sub) }
    lineTo(x, y) { if (!this.__sub) return this.moveTo(x, y); this.__sub.push(this.__pt(x, y)) }
    rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath() }
    ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
      cx = Number(cx); cy = Number(cy); rx = Number(rx); ry = Number(ry); rot = Number(rot) || 0; a0 = Number(a0); a1 = Number(a1)
      if (![cx, cy, rx, ry, a0, a1].every(Number.isFinite)) return
      if (rx < 0 || ry < 0) throw domError(g, 'IndexSizeError', 'ellipse: negative radius')
      let sweep = a1 - a0
      if (ccw) { if (sweep > 0 && sweep < 2 * Math.PI) sweep -= 2 * Math.PI; else if (sweep >= 2 * Math.PI || sweep > 0) sweep = -2 * Math.PI; else if (sweep <= -2 * Math.PI) sweep = -2 * Math.PI }
      else { if (sweep < 0 && sweep > -2 * Math.PI) sweep += 2 * Math.PI; else if (sweep <= -2 * Math.PI || sweep < 0) sweep = 2 * Math.PI; else if (sweep >= 2 * Math.PI) sweep = 2 * Math.PI }
      const n = Math.max(8, Math.min(256, Math.ceil(Math.abs(sweep) * Math.max(rx, ry) * Math.max(Math.abs(this.__sx), Math.abs(this.__sy)) / 3)))
      const cr = Math.cos(rot), sr = Math.sin(rot)
      for (let i = 0; i <= n; i++) {
        const t = a0 + sweep * i / n, ex = rx * Math.cos(t), ey = ry * Math.sin(t)
        const x = cx + ex * cr - ey * sr, y = cy + ex * sr + ey * cr
        if (i === 0 && !this.__sub) this.moveTo(x, y); else this.lineTo(x, y)
      }
    }
    arc(x, y, r, a0, a1, ccw) { this.ellipse(x, y, r, r, 0, a0, a1, ccw) }
    arcTo(x1, y1, x2, y2) { this.lineTo(x1, y1); this.lineTo(x2, y2) }
    quadraticCurveTo(cx, cy, x, y) { if (!this.__sub) this.moveTo(cx, cy); const [px, py] = this.__sub[this.__sub.length - 1]; const inv = this.__inv(px, py); for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; this.lineTo(u * u * inv[0] + 2 * u * t * cx + t * t * x, u * u * inv[1] + 2 * u * t * cy + t * t * y) } }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { if (!this.__sub) this.moveTo(c1x, c1y); const [px, py] = this.__sub[this.__sub.length - 1]; const inv = this.__inv(px, py); for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; this.lineTo(u * u * u * inv[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * inv[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y) } }
    __inv(dx, dy) { return [(dx - this.__tx) / this.__sx, (dy - this.__ty) / this.__sy] }
    fill(pathOrRule, rule) {
      if (pathOrRule && typeof pathOrRule === 'object' && typeof pathOrRule.__toDevice === 'function') {
        const saved = this.__path
        this.__path = pathOrRule.__toDevice(this)
        try { return this.fill(typeof rule === 'string' ? rule : 'nonzero') }
        finally { this.__path = saved }
      }
      const buf = this.canvas.__rgba; if (!buf) return
      let ruleName = pathOrRule
      if (typeof ruleName !== 'string') ruleName = 'nonzero'
      const cw = this.canvas.__w, ch = this.canvas.__h
      const solid = this.__fillGrad ? null : this.__fillRgba
      const alpha = this.__alpha, mode = this.__mode()
      if (solid && solid[3] * alpha <= 0 && mode !== 1) return
      scanFill(this.__path, ruleName === 'evenodd', cw, ch, (py, xa, xb) => {
        this.__clipSpans(py, xa, xb, (a, b) => {
          if (solid) paintSpan(buf, (py * cw + a) * 4, (py * cw + b) * 4, solid[0], solid[1], solid[2], solid[3] * alpha, mode)
          else this.__fillGradientSpan(buf, a, py, b, py + 1)
        })
      })
    }
    // A stroke is filled as its outline: a quad per segment, a disc at each joint and end for round joins and caps
    // (a square cap extends the end by half the width; miter and bevel joins are drawn as round ones), every polygon
    // wound the same way so the nonzero fill unions them. Dashes are not drawn.
    stroke(pathArg) {
      if (pathArg && typeof pathArg === 'object' && typeof pathArg.__toDevice === 'function') {
        const saved = this.__path
        this.__path = pathArg.__toDevice(this)
        try { return this.stroke() }
        finally { this.__path = saved }
      }
      const c = colour(this.__stroke); if (!c) return
      const hw = Math.max(0.5, this.lineWidth * Math.sqrt(Math.abs(this.__sx * this.__sy)) / 2)
      const round = this.lineJoin === 'round' || this.lineCap === 'round', square = this.lineCap === 'square'
      const polys = [], disc = (x, y) => { const n = Math.max(8, Math.min(32, Math.ceil(hw * 1.5))), d = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; d.push([x + Math.cos(a) * hw, y + Math.sin(a) * hw]) } polys.push(d) }
      for (const sub of this.__path) {
        const n = sub.length; if (!n) continue
        const pts = sub.closed && n > 2 ? [...sub, sub[0]] : sub
        for (let i = 0; i + 1 < pts.length; i++) {
          let [ax, ay] = pts[i], [bx, by] = pts[i + 1]
          const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); if (len < 1e-6) continue
          const ux = dx / len, uy = dy / len, nx = -uy * hw, ny = ux * hw
          if (square && !sub.closed) { if (i === 0) { ax -= ux * hw; ay -= uy * hw } if (i + 2 === pts.length) { bx += ux * hw; by += uy * hw } }
          polys.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]])
        }
        if (round || n === 1) for (const [x, y] of pts) disc(x, y)
        else for (let i = 1; i + 1 < pts.length; i++) disc(pts[i][0], pts[i][1])  // joins without gaps
      }
      for (const p of polys) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1] } if (a < 0) p.reverse() }
      const path = this.__path, rgba = this.__fillRgba, grad = this.__fillGrad
      this.__path = polys; this.__fillRgba = c; this.__fillGrad = null
      try { this.fill('nonzero') } finally { this.__path = path; this.__fillRgba = rgba; this.__fillGrad = grad }
    }
    // Intersects the clip with the current path (or a Path2D). Rect paths stay a list of rectangles, which is what a
    // repaint's dirty region is; a rounded rect becomes a coverage mask the size of its own box. The result replaces
    // the clip and save() keeps the previous one, so the objects are never mutated.
    clip(pathOrRule, rule) {
      if (pathOrRule && typeof pathOrRule === 'object' && typeof pathOrRule.__toDevice === 'function') {
        const saved = this.__path
        this.__path = pathOrRule.__toDevice(this)
        try { return this.clip(typeof rule === 'string' ? rule : 'nonzero') }
        finally { this.__path = saved }
      }
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
    isPointInPath() { return false }
    // Gradient fill of a device-space span: the colour at each pixel centre, mapped back to user space.
    __fillGradientSpan(buf, x0, y0, x1, y1) {
      const grad = this.__fillGrad, cw = this.canvas.__w, out = gradPx, alpha = this.__alpha, mode = this.__mode()
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        grad.__colorAt((px + 0.5 - this.__tx) / this.__sx, (py + 0.5 - this.__ty) / this.__sy, out)
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

  // SVG path data, flattened to user-space polygons. The game's UI builds icons with
  // `new Path2D("M … L … C … Z")` at module load, then fill(path) / stroke(path).
  class Path2D {
    constructor(d) { this.__subs = d ? parseSvgPath(d) : [] }
    addPath(other) { if (other && other.__subs) for (const s of other.__subs) this.__subs.push(s.map(p => p.slice())) }
    __toDevice(ctx) {
      return this.__subs.map(sub => {
        const d = sub.map(([x, y]) => ctx.__pt(x, y))
        d.closed = !!sub.closed
        return d
      })
    }
    get [Symbol.toStringTag]() { return 'Path2D' }
  }

  return { HTMLCanvasElement, OffscreenCanvas, CanvasRenderingContext2D, Path2D }
}

// Commands the page uses: M/L/H/V/C/Z/A, absolute and relative. Curves and arcs are
// flattened so the existing scanline fill can draw them.
function parseSvgPath(d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []
  const subs = []
  let sub = null, x = 0, y = 0, sx = 0, sy = 0, i = 0
  const isCmd = (t) => /[A-Za-z]/.test(t)
  const num = () => parseFloat(tokens[i++])
  const start = (nx, ny) => { sub = [[nx, ny]]; sub.closed = false; subs.push(sub); x = nx; y = ny; sx = nx; sy = ny }
  const line = (nx, ny) => { if (!sub) start(nx, ny); else { sub.push([nx, ny]); x = nx; y = ny } }
  const curve = (c1x, c1y, c2x, c2y, nx, ny) => {
    if (!sub) start(x, y)
    const [px, py] = sub[sub.length - 1]
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, u = 1 - t
      sub.push([u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * nx, u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ny])
    }
    x = nx; y = ny
  }
  const arc = (rx, ry, rot, large, sweep, nx, ny) => {
    const pts = svgArcPoints(x, y, rx, ry, rot, large, sweep, nx, ny)
    for (const p of pts) line(p[0], p[1])
    x = nx; y = ny
  }
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (!isCmd(cmd)) break
    const rel = cmd === cmd.toLowerCase()
    const op = cmd.toUpperCase()
    if (op === 'Z') { if (sub && (x !== sx || y !== sy)) line(sx, sy); if (sub) sub.closed = true; sub = null; x = sx; y = sy; continue }
    while (i < tokens.length && !isCmd(tokens[i])) {
      if (op === 'M' || op === 'L') {
        let nx = num(), ny = num(); if (rel) { nx += x; ny += y }
        if (op === 'M' && sub === null) start(nx, ny); else if (op === 'M') start(nx, ny); else line(nx, ny)
        // Further pairs after M are lineto.
        if (op === 'M') while (i < tokens.length && !isCmd(tokens[i])) { let lx = num(), ly = num(); if (rel) { lx += x; ly += y } line(lx, ly) }
      } else if (op === 'H') { let nx = num(); if (rel) nx += x; line(nx, y) }
      else if (op === 'V') { let ny = num(); if (rel) ny += y; line(x, ny) }
      else if (op === 'C') {
        let c1x = num(), c1y = num(), c2x = num(), c2y = num(), nx = num(), ny = num()
        if (rel) { c1x += x; c1y += y; c2x += x; c2y += y; nx += x; ny += y }
        curve(c1x, c1y, c2x, c2y, nx, ny)
      } else if (op === 'A') {
        let rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), nx = num(), ny = num()
        if (rel) { nx += x; ny += y }
        arc(rx, ry, rot, large, sweep, nx, ny)
      } else break
    }
  }
  return subs
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
