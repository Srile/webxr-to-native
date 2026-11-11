// FontFace and document.fonts over __native.img's faces (host/img/text.h), and the resolution of a canvas `font`
// string to a face: the page's own fonts by family (added to document.fonts once loaded, as a browser has it),
// the platform's sans-serif face for generic and unknown families. No CSS @font-face: the host reads no style
// sheets. The faces exist only with host.json web.canvasText (the host registers fontLoad and friends then):
// without them every face fails to load and resolveFont finds no face, so canvas text stays an estimate.

import { domError } from './pixels.js'

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'])
const unquote = (s) => String(s).trim().replace(/^(['"])(.*)\1$/, '$2').trim()
const weightOf = (w) => { w = String(w ?? 'normal').trim(); return w === 'bold' ? 700 : w === 'normal' ? 400 : (parseFloat(w) || 400) }

export function makeFonts(g, { EventTargetBase }) {
  const img = () => g.__native && g.__native.img
  const byFamily = new Map()   // lowercased family -> loaded FontFaces in document.fonts
  const resolved = new Map()   // font string -> { id, fallback, px } (cleared when a face is added or removed)
  let systemId                 // undefined until asked

  function systemFont() {
    if (systemId === undefined) { const n = img(); systemId = n && typeof n.fontSystem === 'function' ? n.fontSystem() : -1 }
    return systemId
  }

  function sourceBytes(src) {
    if (src instanceof ArrayBuffer) return Promise.resolve(src)
    if (ArrayBuffer.isView(src)) return Promise.resolve(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength))
    const urls = [...String(src).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2])
    if (!urls.length) return Promise.reject(domError(g, 'SyntaxError', `FontFace: no url() in source '${src}'`))
    // The first source the host reads; a browser would try each in turn by format.
    return g.fetch(urls[0]).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
  }

  class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = unquote(family)
      this.style = descriptors.style ?? 'normal'
      this.weight = String(descriptors.weight ?? 'normal')
      this.stretch = descriptors.stretch ?? 'normal'
      this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF'
      this.display = descriptors.display ?? 'auto'
      this.status = 'unloaded'
      this.__source = source
      this.__id = -1
      this.loaded = new Promise((resolve, reject) => { this.__resolve = resolve; this.__reject = reject })
      this.loaded.catch(() => {})  // a face nobody awaits may fail quietly, as in a browser
      if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) this.load()
    }
    load() {
      if (this.status !== 'unloaded') return this.loaded
      this.status = 'loading'
      sourceBytes(this.__source).then((bytes) => {
        const n = img()
        if (!n || typeof n.fontLoad !== 'function') throw new Error('font loading is unavailable (__native.img.fontLoad missing: host.json web.canvasText is off)')

        this.__id = n.fontLoad(bytes)
        this.status = 'loaded'
        if (fontSet.has(this)) register(this)
        this.__resolve(this)
      }).catch((e) => {
        this.status = 'error'
        this.__reject(domError(g, 'NetworkError', `FontFace '${this.family}': ${e && e.message || e}`))
      })
      return this.loaded
    }
  }

  function register(face) {
    if (face.__id < 0) return
    const key = face.family.toLowerCase()
    let list = byFamily.get(key); if (!list) byFamily.set(key, list = [])
    if (!list.includes(face)) list.push(face)
    resolved.clear()
  }
  function unregister(face) {
    const list = byFamily.get(face.family.toLowerCase())
    const i = list ? list.indexOf(face) : -1
    if (i >= 0) { list.splice(i, 1); resolved.clear() }
  }

  // font shorthand: [style] [variant] [weight] [stretch] size[/line-height] family[, family]*
  function parse(font) {
    const m = /^(.*?)(?:^|\s)(\d*\.?\d+)(px|pt|em|rem|%)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(String(font).trim())
    if (!m) return null
    const v = parseFloat(m[2]), unit = m[3]
    const px = unit === 'px' ? v : unit === 'pt' ? v * 4 / 3 : unit === '%' ? v * 0.16 : v * 16
    const pre = m[1].toLowerCase().split(/\s+/)
    let weight = 400, italic = false
    for (const t of pre) { if (t === 'bold' || t === 'bolder') weight = 700; else if (t === 'lighter') weight = 300; else if (/^\d{3}$/.test(t)) weight = +t; else if (t === 'italic' || t === 'oblique') italic = true }
    return { px, weight, italic, families: m[4].split(',').map(unquote).filter(Boolean) }
  }
  function pick(list, weight, italic) {
    let best = null, score = Infinity
    for (const f of list) {
      const s = Math.abs(weightOf(f.weight) - weight) + ((f.style !== 'normal') !== italic ? 1000 : 0)
      if (s < score) { score = s; best = f }
    }
    return best
  }
  // { id, fallback, px, bold }: id the face to draw with (-1: none), fallback the face for code points it lacks.
  function resolveFont(font) {
    let r = resolved.get(font)
    if (r) return r
    const p = parse(font) || { px: 10, weight: 400, italic: false, families: ['sans-serif'] }
    const fallback = systemFont()
    let id = -1, faceWeight = 400   // the platform's faces are its regular weight
    for (const fam of p.families) {
      const key = fam.toLowerCase()
      const list = byFamily.get(key)
      if (list && list.length) { const face = pick(list, p.weight, p.italic); id = face.__id; faceWeight = weightOf(face.weight); break }
      if (GENERIC.has(key)) break
    }
    // bold: how much heavier the text asks to be than the face it gets (0..1 of a regular-to-bold step), drawn by
    // growing the glyphs (canvas2d.js embolden).
    r = { id: id >= 0 ? id : fallback, fallback, px: p.px, bold: Math.max(0, Math.min(1, (p.weight - faceWeight - 50) / 250)) }
    if (resolved.size >= 256) resolved.clear()
    resolved.set(font, r)
    return r
  }

  class FontFaceSet extends EventTargetBase {
    constructor() { super(); this.__faces = new Set(); this.onloading = null; this.onloadingdone = null; this.onloadingerror = null }
    get size() { return this.__faces.size }
    get status() { for (const f of this.__faces) if (f.status === 'loading') return 'loading'; return 'loaded' }
    get ready() { return Promise.all([...this.__faces].map((f) => f.status === 'loading' ? f.loaded.catch(() => {}) : null)).then(() => this) }
    add(face) { if (!(face instanceof FontFace)) throw new TypeError('FontFaceSet.add: not a FontFace'); this.__faces.add(face); if (face.status === 'loaded') register(face); return this }
    delete(face) { const had = this.__faces.delete(face); if (had) unregister(face); return had }
    clear() { for (const f of this.__faces) unregister(f); this.__faces.clear() }
    has(face) { return this.__faces.has(face) }
    forEach(cb, thisArg) { for (const f of this.__faces) cb.call(thisArg, f, f, this) }
    values() { return this.__faces.values() }
    keys() { return this.__faces.values() }
    entries() { return [...this.__faces].map((f) => [f, f]).values() }
    [Symbol.iterator]() { return this.__faces.values() }
    // True when every named family is generic or has a loaded face here (the host has no system fonts by name).
    check(font) {
      const p = parse(font); if (!p) throw domError(g, 'SyntaxError', `FontFaceSet.check: '${font}' is not a CSS font`)
      return p.families.every((f) => GENERIC.has(f.toLowerCase()) || (byFamily.get(f.toLowerCase()) || []).length > 0)
    }
    load(font) {
      const p = parse(font); if (!p) return Promise.reject(domError(g, 'SyntaxError', `FontFaceSet.load: '${font}' is not a CSS font`))
      const names = new Set(p.families.map((f) => f.toLowerCase()))
      const faces = [...this.__faces].filter((f) => names.has(f.family.toLowerCase()))
      return Promise.all(faces.map((f) => f.load()))
    }
  }
  const fontSet = new FontFaceSet()

  return { FontFace, FontFaceSet, fontSet, resolveFont }
}
