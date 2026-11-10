// HTMLImageElement / Image: `src` fetches through the global fetch (same
// routing as the game's own fetches), decodes through __native.img, then
// fires 'load' (onload AND addEventListener('load')) or 'error'.
import { decodeBytes, decodeDataUrl, domError } from './pixels.js'
const SW_HOOK = Symbol.for('webxr-host.serviceworker')  // set by runtime/src/serviceworker (host.json web.serviceWorker)

function elementStyle(g) {
  if (typeof g.CSSStyleDeclaration === 'function') return new g.CSSStyleDeclaration()
  const s = {}
  s.setProperty = (k, v) => { s[k] = String(v ?? '') }
  s.removeProperty = (k) => { const v = s[k] ?? ''; delete s[k]; return String(v) }
  s.getPropertyValue = (k) => s[k] ?? ''
  return s
}
export function makeImageElement(g, { EventTargetBase, makeEvent }) {
  function loadBytes(url) {
    if (/^data:/i.test(url)) {
      const d = decodeDataUrl(url)
      return d ? Promise.resolve(d.bytes) : Promise.reject(new TypeError('Image: malformed data: URL'))
    }
    const fetch = g.fetch, sw = g[SW_HOOK]  // a controlling service worker sees the load as an image request (WP-27)
    if (typeof fetch !== 'function') return Promise.reject(new Error('Image: fetch is not available'))
    return Promise.resolve(sw ? sw.load(url, 'image') : fetch(url)).then(res => {
      if (!res || (res.ok === false) || (typeof res.status === 'number' && (res.status < 200 || res.status >= 300))) throw new Error(`Image: HTTP ${res && res.status} for ${url}`)
      return res.arrayBuffer()
    }).then(buf => buf instanceof Uint8Array ? buf : new Uint8Array(buf))
  }

  function resolveUrl(url) {
    if (!url || /^(data|blob):/i.test(url)) return url
    try {
      const URLCtor = g.URL || URL
      const base = g.location && g.location.href
      return base ? new URLCtor(url, base).href : new URLCtor(url).href
    } catch { return url }
  }

  class HTMLImageElement extends EventTargetBase {
    constructor(width, height) {
      super()
      this.__src = ''
      this.__rgba = null
      this.__imageState = 'empty'  // 'empty' | 'loading' | 'loaded' | 'error'
      this.__gen = 0
      this.__waiters = []
      this.__onload = null
      this.__onerror = null
      this.__w = width === undefined ? undefined : (width | 0)
      this.__h = height === undefined ? undefined : (height | 0)
      this.naturalWidth = 0
      this.naturalHeight = 0
      this.crossOrigin = null
      this.referrerPolicy = ''
      this.decoding = 'auto'
      this.loading = 'eager'
      this.fetchPriority = 'auto'
      this.alt = ''
      this.style = elementStyle(g)
      this.parentNode = null
      this.__attrs = new Map()
      this._attrs = this.__attrs
      this.childNodes = []
      this.namespaceURI = 'http://www.w3.org/1999/xhtml'
      // Own fields, ahead of Element's accessors once this object is an HTMLElement.
      Object.defineProperty(this, 'id', { value: '', writable: true, configurable: true, enumerable: true })
      Object.defineProperty(this, 'className', { value: '', writable: true, configurable: true, enumerable: true })
    }

    get tagName() { return 'IMG' }
    get nodeName() { return 'IMG' }
    get nodeType() { return 1 }
    get localName() { return 'img' }
    get ownerDocument() { return g.document || null }

    get width() { return this.__w !== undefined ? this.__w : this.naturalWidth }
    set width(v) { this.__w = v | 0 }
    get height() { return this.__h !== undefined ? this.__h : this.naturalHeight }
    set height(v) { this.__h = v | 0 }
    get complete() { return this.__imageState !== 'loading' }
    get currentSrc() { return this.__imageState === 'loaded' ? this.__src : '' }

    get src() { return this.__src }
    set src(v) { this.__setSrc(v === null || v === undefined ? '' : String(v)) }

    // Handler attributes ride the listener list, so one dispatch reaches both.
    get onload() { return this.__onload }
    set onload(fn) {
      if (this.__onload) this.removeEventListener('load', this.__onload)
      this.__onload = typeof fn === 'function' ? fn : null
      if (this.__onload) this.addEventListener('load', this.__onload)
    }
    get onerror() { return this.__onerror }
    set onerror(fn) {
      if (this.__onerror) this.removeEventListener('error', this.__onerror)
      this.__onerror = typeof fn === 'function' ? fn : null
      if (this.__onerror) this.addEventListener('error', this.__onerror)
    }

    setAttribute(name, value) {
      name = String(name).toLowerCase()
      if (name === 'src') this.src = value
      else if (name === 'width') this.width = parseInt(value, 10) || 0
      else if (name === 'height') this.height = parseInt(value, 10) || 0
      else if (name === 'crossorigin') this.crossOrigin = String(value)
      else this.__attrs.set(name, String(value))
    }
    getAttribute(name) {
      name = String(name).toLowerCase()
      if (name === 'src') return this.__src || null
      if (name === 'width') return this.__w === undefined ? null : String(this.__w)
      if (name === 'height') return this.__h === undefined ? null : String(this.__h)
      if (name === 'crossorigin') return this.crossOrigin
      return this.__attrs.has(name) ? this.__attrs.get(name) : null
    }
    hasAttribute(name) { return this.getAttribute(name) !== null }
    removeAttribute(name) {
      name = String(name).toLowerCase()
      if (name === 'src') this.src = ''
      else if (name === 'width') this.__w = undefined
      else if (name === 'height') this.__h = undefined
      else if (name === 'crossorigin') this.crossOrigin = null
      else this.__attrs.delete(name)
    }
    remove() { if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this) }

    decode() {
      if (this.__imageState === 'loaded') return Promise.resolve()
      if (this.__imageState !== 'loading') return Promise.reject(domError(g, 'EncodingError', 'The source image cannot be decoded.'))
      return new Promise((resolve, reject) => this.__waiters.push({ resolve, reject }))
    }

    __settle(ok) {
      const waiters = this.__waiters; this.__waiters = []
      for (const w of waiters) ok ? w.resolve() : w.reject(domError(g, 'EncodingError', 'The source image cannot be decoded.'))
    }

    __setSrc(url) {
      const gen = ++this.__gen
      this.__src = resolveUrl(url)
      this.__rgba = null
      this.naturalWidth = 0; this.naturalHeight = 0
      if (!url) { this.__imageState = 'empty'; this.__settle(false); return }
      this.__imageState = 'loading'
      loadBytes(this.__src).then(bytes => decodeBytes(g, bytes)).then(px => {
        if (gen !== this.__gen) return
        this.__rgba = px.rgba
        this.naturalWidth = px.width; this.naturalHeight = px.height
        this.__imageState = 'loaded'
        this.__settle(true)
        this.dispatchEvent(makeEvent('load'))
      }, err => {
        if (gen !== this.__gen) return
        this.__imageState = 'error'
        this.__lastError = err
        this.__settle(false)
        this.dispatchEvent(makeEvent('error'))
      })
    }

    get [Symbol.toStringTag]() { return 'HTMLImageElement' }
  }

  // new Image(w, h) is an HTMLImageElement; the two share one prototype like the DOM's.
  function Image(width, height) { return new HTMLImageElement(width, height) }
  Image.prototype = HTMLImageElement.prototype

  // A browser image is an HTMLElement. lazy-widgets classifies an icon with `media instanceof Element`
  // and tagName IMG; anything else falls through to `instanceof VideoFrame`, which throws where that
  // constructor does not exist.
  if (typeof g.HTMLElement === 'function') Object.setPrototypeOf(HTMLImageElement.prototype, g.HTMLElement.prototype)

  return { HTMLImageElement, Image }
}
