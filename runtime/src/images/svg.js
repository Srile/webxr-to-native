// SVG pictures (host.json web.svg). The host rasterises them with nanosvg, which reads presentation attributes,
// style attributes, class selectors and ten colour names. normalizeSvg rewrites a document into that subset, so an
// icon comes out as a browser draws it: every CSS rule (element, class, id, descendant selectors) and style
// attribute becomes presentation attributes, <use> becomes the shapes it references, every CSS colour (names,
// rgb()/hsl(), currentColor, alpha) becomes #rrggbb plus an opacity, CSS transforms and transform-origin become a
// transform attribute, object-bounding-box gradient coordinates become percentages, and the root gets the size a
// browser gives an <img> of it (the viewBox fitted into 300 x 150 when it has no width and height).
// svgSource keeps the normalised document with a decoded image so drawImage can ask for a raster at the size the
// picture lands at (__native.img.svgRaster), instead of scaling the one made at its natural size.
import { unescapeXml } from '../dom-lite/xml.js'
import { decodeBytes, parseColor } from './pixels.js'

// The host's img::isSvg (host/img/decode.cpp), in JS: the two must agree on what is an SVG.
export function isSvg(b) {
  let i = 0
  const n = b.length
  if (n >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) i = 3
  while (i < n && (b[i] === 32 || b[i] === 9 || b[i] === 13 || b[i] === 10)) i++
  if (i >= n || b[i] !== 60) return false
  for (let k = i, end = Math.min(n, i + 4096) - 3; k < end; k++) if (b[k] === 60 && b[k + 1] === 115 && b[k + 2] === 118 && b[k + 3] === 103) return true
  return false
}

const escapeXml = (t) => t.replace(/[&<>"]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')

// Elements are { tag, attrs: Map, kids: [] }; only a <style>'s text is kept.
function parseXml(src) {
  const root = { tag: '', attrs: new Map(), kids: [], css: '' }, stack = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g
  for (let m; (m = re.exec(src));) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) { if (top.tag === 'style') top.css += m[1] }
    else if (m[2]) { if (stack.length > 1) stack.pop() }
    else if (m[3]) {
      const el = { tag: m[3].replace(/^svg:/, ''), attrs: new Map(), kids: [], css: '' }
      for (const a of m[4].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) el.attrs.set(a[1], unescapeXml(a[2] ?? a[3] ?? ''))
      top.kids.push(el)
      if (!m[5]) stack.push(el)
    } else if (m[6] !== undefined && top.tag === 'style') top.css += unescapeXml(m[6])
  }
  return root.kids.find(k => k.tag === 'svg') ?? null
}

function serialize(el, out) {
  out.push('<', el.tag)
  for (const [k, v] of el.attrs) out.push(' ', k, '="', escapeXml(v), '"')
  if (!el.kids.length) { out.push('/>'); return }
  out.push('>')
  for (const k of el.kids) serialize(k, out)
  out.push('</', el.tag, '>')
}

function parseDecls(text) {
  const out = []
  for (const part of text.split(';')) {
    const i = part.indexOf(':'); if (i < 0) continue
    const name = part.slice(0, i).trim().toLowerCase(), value = part.slice(i + 1).replace(/!\s*important\s*$/i, '').trim()
    if (name && value) out.push([name, value])
  }
  return out
}

// A selector as its compounds, outermost first: { tag, id, classes }. Combinators all read as "descendant";
// attribute selectors and pseudo-classes other than :root are not matched (the rule is dropped).
function parseSelector(sel) {
  const compounds = []
  for (const part of sel.replace(/\s*[>+~]\s*/g, ' ').trim().split(/\s+/)) {
    const c = { tag: null, id: null, classes: [], root: false }
    let rest = part
    while (rest) {
      const m = /^(?:([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|(:root))/.exec(rest)
      if (!m) return null
      if (m[1]) { if (m[1] !== '*') c.tag = m[1] } else if (m[2]) c.id = m[2]; else if (m[3]) c.classes.push(m[3]); else c.root = true
      rest = rest.slice(m[0].length)
    }
    compounds.push(c)
  }
  return compounds.length ? compounds : null
}
function parseCss(text) {
  const rules = []
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = parseDecls(m[2]); if (!decls.length) continue
    for (const s of m[1].split(',')) {
      const sel = parseSelector(s.trim()); if (!sel) continue
      let spec = 0
      for (const c of sel) spec += (c.id ? 10000 : 0) + (c.classes.length + (c.root ? 1 : 0)) * 100 + (c.tag ? 1 : 0)
      rules.push({ sel, spec, decls, order: rules.length })
    }
  }
  return rules
}
function matchesCompound(c, el, isRoot) {
  if (c.tag && c.tag !== el.tag) return false
  if (c.root && !isRoot) return false
  if (c.id && el.attrs.get('id') !== c.id) return false
  if (c.classes.length) {
    const have = (el.attrs.get('class') ?? '').split(/\s+/)
    for (const k of c.classes) if (!have.includes(k)) return false
  }
  return true
}
// chain: the element's ancestors, root first.
function matches(sel, el, chain) {
  let i = sel.length - 1
  if (!matchesCompound(sel[i], el, chain.length === 0)) return false
  i--
  for (let a = chain.length - 1; a >= 0 && i >= 0; a--) if (matchesCompound(sel[i], chain[a], a === 0)) i--
  return i < 0
}

const UNIT = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16, ex: 8 }
// A length in CSS px, or null (absent, a percentage, auto).
function length(v) {
  if (v === undefined || v === null) return null
  const m = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(v)
  if (!m) return null
  const u = m[2].toLowerCase()
  if (u && !(u in UNIT)) return null
  const n = parseFloat(m[1]) * (u ? UNIT[u] : 1)
  return Number.isFinite(n) ? n : null
}
function viewBox(el) {
  const v = (el.attrs.get('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  return v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0 ? { x: v[0], y: v[1], w: v[2], h: v[3] } : null
}
const fmt = (n) => String(Math.round(n * 1e4) / 1e4)

// A CSS transform list as an SVG transform attribute, or null when it uses something with no attribute form.
function cssTransform(v) {
  if (/^none$/i.test(v.trim())) return ''
  const out = []
  for (const m of v.matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)) {
    const fn = m[1].toLowerCase(), args = m[2].split(/[\s,]+/).filter(Boolean)
    const nums = []
    for (const a of args) {
      const u = /^([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)([a-z%]*)$/i.exec(a); if (!u) return null
      const n = parseFloat(u[1]), unit = u[2].toLowerCase()
      if (unit === '' || unit === 'px' || unit === 'deg') nums.push(n)
      else if (unit === 'rad') nums.push(n * 180 / Math.PI)
      else if (unit === 'turn') nums.push(n * 360)
      else if (unit === 'grad') nums.push(n * 0.9)
      else return null
    }
    if (fn === 'translatex') out.push(`translate(${nums[0]} 0)`)
    else if (fn === 'translatey') out.push(`translate(0 ${nums[0]})`)
    else if (fn === 'scalex') out.push(`scale(${nums[0]} 1)`)
    else if (fn === 'scaley') out.push(`scale(1 ${nums[0]})`)
    else if (fn === 'translate' || fn === 'scale' || fn === 'rotate' || fn === 'skewx' || fn === 'skewy' || fn === 'matrix') out.push(`${fn === 'skewx' ? 'skewX' : fn === 'skewy' ? 'skewY' : fn}(${nums.join(' ')})`)
    else return null
  }
  return out.join(' ')
}
// transform-origin as user units: lengths, percentages and keywords of the viewBox (transform-box: view-box).
function origin(v, box) {
  const parts = v.trim().split(/\s+/)
  const one = (p, start, size) => {
    p = p.toLowerCase()
    if (p === 'center') return start + size / 2
    if (p === 'left' || p === 'top') return start
    if (p === 'right' || p === 'bottom') return start + size
    if (p.endsWith('%')) return start + size * parseFloat(p) / 100
    return length(p) ?? 0
  }
  if (parts.length === 1 && (parts[0] === 'top' || parts[0] === 'bottom')) return [box.x + box.w / 2, one(parts[0], box.y, box.h)]
  return [one(parts[0], box.x, box.w), one(parts[1] ?? 'center', box.y, box.h)]
}

const cloneNode = (el) => ({ tag: el.tag, attrs: new Map(el.attrs), kids: el.kids.map(cloneNode), css: el.css })
const DROPPED = new Set(['style', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'script', 'title', 'desc', 'metadata'])
const GRADIENT_COORDS = ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy']
const opacity = (v, fallback) => { if (v === undefined) return fallback; const n = v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback }
const hex = (c) => '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)

// SVG text → SVG text nanosvg draws as a browser would; null when it is not an SVG document.
export function normalizeSvgText(src) {
  const root = parseXml(src)
  if (!root) return null

  // 1. The cascade: presentation attributes, then the style sheets' rules by specificity, then the style attribute.
  let css = ''
  const collect = (el) => { if (el.tag === 'style') css += el.css + '\n'; for (const k of el.kids) collect(k) }
  collect(root)
  const rules = css.trim() ? parseCss(css) : []
  const vb = viewBox(root)
  const ids = new Map()
  const setProp = (el, name, value) => {
    if (name === 'transform') { const t = cssTransform(value); if (t !== null) { if (t) el.attrs.set('transform', t); else el.attrs.delete('transform') } }
    else if (name === 'visibility') { if (/^(hidden|collapse)$/i.test(value)) el.attrs.set('display', 'none') }
    else el.attrs.set(name, value)
  }
  const cascade = (el, chain) => {
    if (rules.length) {
      const hit = rules.filter(r => matches(r.sel, el, chain))
      if (hit.length > 1) hit.sort((p, q) => p.spec - q.spec || p.order - q.order)
      for (const r of hit) for (const d of r.decls) setProp(el, d[0], d[1])
    }
    const inline = el.attrs.get('style')
    if (inline !== undefined) { for (const d of parseDecls(inline)) setProp(el, d[0], d[1]); el.attrs.delete('style') }
    const to = el.attrs.get('transform-origin')
    if (to !== undefined) {
      el.attrs.delete('transform-origin')
      const t = el.attrs.get('transform')
      if (t) { const o = origin(to, vb ?? { x: 0, y: 0, w: length(root.attrs.get('width')) ?? 0, h: length(root.attrs.get('height')) ?? 0 }); if (o[0] || o[1]) el.attrs.set('transform', `translate(${fmt(o[0])} ${fmt(o[1])}) ${t} translate(${fmt(-o[0])} ${fmt(-o[1])})`) }
    }
    const id = el.attrs.get('id'); if (id && !ids.has(id)) ids.set(id, el)
    chain.push(el)
    for (const k of el.kids) cascade(k, chain)
    chain.pop()
  }
  cascade(root, [])

  // 2. Gradients: href for nanosvg's xlink:href, and bounding-box coordinates written as fractions made percentages
  // (nanosvg reads a bare number as user units).
  const gradientUnits = (el, depth) => {
    const u = el.attrs.get('gradientUnits'); if (u) return u
    const ref = (el.attrs.get('xlink:href') ?? '').trim()
    const parent = ref[0] === '#' ? ids.get(ref.slice(1)) : null
    return parent && depth < 8 ? gradientUnits(parent, depth + 1) : 'objectBoundingBox'
  }
  const gradients = (el) => {
    if (el.tag === 'linearGradient' || el.tag === 'radialGradient') {
      const href = el.attrs.get('href'); if (href !== undefined && !el.attrs.has('xlink:href')) { el.attrs.set('xlink:href', href); el.attrs.delete('href') }
      if (gradientUnits(el, 0) !== 'userSpaceOnUse') for (const k of GRADIENT_COORDS) { const v = el.attrs.get(k); if (v !== undefined && /^\s*[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?\s*$/i.test(v)) el.attrs.set(k, fmt(parseFloat(v) * 100) + '%') }
    }
    for (const k of el.kids) gradients(k)
  }
  gradients(root)

  // 3. <use>: a group carrying the use's own properties, around a copy of what it references.
  const expand = (el, depth) => {
    for (let i = 0; i < el.kids.length; i++) {
      let kid = el.kids[i]
      if (kid.tag === 'use') {
        const ref = (kid.attrs.get('href') ?? kid.attrs.get('xlink:href') ?? '').trim()
        const target = ref[0] === '#' && depth < 8 ? ids.get(ref.slice(1)) : null
        const group = { tag: 'g', attrs: new Map(kid.attrs), kids: [], css: '' }
        for (const k of ['href', 'xlink:href', 'x', 'y', 'width', 'height', 'id']) group.attrs.delete(k)
        let t = group.attrs.get('transform') ?? ''
        const x = length(kid.attrs.get('x')) ?? 0, y = length(kid.attrs.get('y')) ?? 0
        if (x || y) t += ` translate(${fmt(x)} ${fmt(y)})`
        if (target) {
          const copy = cloneNode(target); copy.attrs.delete('id')
          if (copy.tag === 'symbol' || copy.tag === 'svg') {
            const box = viewBox(copy), w = length(kid.attrs.get('width')) ?? length(copy.attrs.get('width')), h = length(kid.attrs.get('height')) ?? length(copy.attrs.get('height'))
            if (box && w > 0 && h > 0) { const s = Math.min(w / box.w, h / box.h); t += ` translate(${fmt((w - box.w * s) / 2 - box.x * s)} ${fmt((h - box.h * s) / 2 - box.y * s)}) scale(${fmt(s)})` }
            else if (box && (box.x || box.y)) t += ` translate(${fmt(-box.x)} ${fmt(-box.y)})`
            copy.tag = 'g'
            for (const k of ['viewBox', 'width', 'height', 'x', 'y', 'preserveAspectRatio']) copy.attrs.delete(k)
          }
          group.kids.push(copy)
        }
        if (t.trim()) group.attrs.set('transform', t.trim())
        el.kids[i] = kid = group
        expand(kid, depth + 1)
      } else expand(kid, depth)
    }
  }
  expand(root, 0)

  // 4. Colours, with color inherited for currentColor and a colour's alpha folded into the matching opacity. What
  // nanosvg would draw without being referenced (a <symbol>'s or a <clipPath>'s shapes) is dropped.
  const paint = (el, state) => {
    el.kids = el.kids.filter(k => !DROPPED.has(k.tag))
    const own = el.attrs.get('color')
    let color = state.color
    if (own !== undefined) { const c = parseColor(own); if (c) color = c }
    const next = { color, fill: state.fill, fillOp: state.fillOp, stroke: state.stroke, strokeOp: state.strokeOp }
    for (const name of ['fill', 'stroke', 'stop-color']) {
      const opName = name === 'stop-color' ? 'stop-opacity' : name + '-opacity'
      let alpha = name === 'stop-color' ? 1 : state[name]
      const v = el.attrs.get(name)
      if (v !== undefined) {
        const low = v.trim().toLowerCase()
        if (low === 'none') alpha = 1
        else if (low.startsWith('url(')) { const u = /^url\(\s*["']?([^"')\s]+)["']?\s*\)/.exec(v.trim()); el.attrs.set(name, u ? `url(${u[1]})` : 'none'); alpha = 1 }
        else {
          const c = low === 'currentcolor' ? color : parseColor(low)
          if (!c) el.attrs.delete(name)   // not a colour: as if it was never set
          else { el.attrs.set(name, hex(c)); alpha = c[3] / 255 }
        }
      }
      if (name === 'stop-color') { if (alpha < 1) el.attrs.set(opName, fmt(opacity(el.attrs.get(opName), 1) * alpha)); continue }
      // The opacity the page set (inherited apart from the colour's own alpha), then the two as one attribute.
      const op = opacity(el.attrs.get(opName), state[name + 'Op'])
      next[name] = alpha; next[name + 'Op'] = op
      if (el.attrs.has(opName) || op * alpha !== state[name + 'Op'] * state[name]) el.attrs.set(opName, fmt(op * alpha))
    }
    for (const k of el.kids) paint(k, next)
  }
  paint(root, { color: [0, 0, 0, 255], fill: 1, fillOp: 1, stroke: 1, strokeOp: 1 })

  // 5. The size of an <img> of it: width and height in px; a missing one follows the viewBox's ratio, and with
  // neither the viewBox is fitted into the default 300 x 150.
  let w = length(root.attrs.get('width')), h = length(root.attrs.get('height'))
  if (w === null && h === null) {
    if (vb) { const ratio = vb.w / vb.h; w = Math.min(300, 150 * ratio); h = w / ratio } else { w = 300; h = 150 }
  } else if (w === null) w = vb ? h * vb.w / vb.h : 300
  else if (h === null) h = vb ? w * vb.h / vb.w : 150
  root.attrs.set('width', fmt(Math.max(1, Math.round(w)))); root.attrs.set('height', fmt(Math.max(1, Math.round(h))))

  const out = []
  serialize(root, out)
  return out.join('')
}

// SVG bytes → normalised SVG bytes; the input when it cannot be read.
export function normalizeSvg(g, bytes) {
  try {
    const TD = g.TextDecoder || globalThis.TextDecoder, TE = g.TextEncoder || globalThis.TextEncoder
    if (typeof TD !== 'function' || typeof TE !== 'function') return bytes
    const text = normalizeSvgText(new TD('utf-8').decode(bytes))
    return text ? new TE().encode(text) : bytes
  } catch { return bytes }
}

// The rasters of one SVG picture by size. at(scale) is the picture drawn `scale` times its natural size, or null
// for the natural one (the image's own pixels) and where the host has no svgRaster.
export function svgSource(g, bytes, width, height) {
  const cache = []   // { key, width, height, rgba }, most recently used last
  const out = new Int32Array(2)
  let made = 0, held = 0
  return {
    at(scale) {
      if (!(scale > 0) || Math.abs(scale - 1) < 0.02) return null
      const n = g.__native && g.__native.img
      if (!n || typeof n.svgRaster !== 'function') return null
      // A picture drawn at ever-changing sizes (an animated scale) settles on steps of sqrt(2), rounded up.
      if (made > 16) scale = Math.pow(2, Math.ceil(Math.log2(scale) * 2) / 2)
      scale = Math.min(scale, 4096 / Math.max(width, height))
      const key = Math.max(1, Math.round(width * scale))
      if (key === width) return null
      // A raster up to 6% larger serves too: a size that wobbles by a pixel does not raster again.
      for (let i = cache.length - 1; i >= 0; i--) {
        const hit = cache[i]
        if (hit.key >= key && hit.key <= key * 1.06 + 1) { if (i !== cache.length - 1) { cache.splice(i, 1); cache.push(hit) } return hit }
      }
      let buf = null
      try { buf = n.svgRaster(bytes, key / width, out) } catch { buf = null }
      if (!buf || !(out[0] > 0) || !(out[1] > 0)) return null
      made++
      const entry = { key, width: out[0], height: out[1], rgba: buf instanceof Uint8Array ? buf : new Uint8Array(buf) }
      cache.push(entry); held += entry.rgba.length
      // At most four rasters and 16 MB a picture; the newest always stays.
      while (cache.length > 1 && (cache.length > 4 || held > (16 << 20))) held -= cache.shift().rgba.length
      return entry
    },
  }
}

// decodeBytes for any picture: an SVG is normalised first, and its result carries `svg` (svgSource) for rescaling.
export function decodeImage(g, bytes) {
  if (!isSvg(bytes)) return decodeBytes(g, bytes)
  const doc = normalizeSvg(g, bytes)
  return decodeBytes(g, doc).then(px => { px.svg = svgSource(g, doc, px.width, px.height); return px })
}
