// window / document / navigator / timers / performance — stubs and events, no layout.
import { atob, btoa } from '../fetch/base64.js'
import * as ev from './events.js'
import { URL } from '../fetch/url.js'

let W = globalThis  // the window object; the real global in the host, a sandbox in tests
const WARNED = new Set()
function warnOnce(key, msg) { if (WARNED.has(key)) return; WARNED.add(key); W.__native?.log?.(2, `dom-lite: ${msg}`) }

// Inline style: properties kept under their camelCase names (custom properties as written), so `style.paddingTop`,
// `setProperty('padding-top')` and `cssText` agree. No cascade: getComputedStyle reads these (below).
const camel = (k) => k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const kebab = (k) => k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
class CSSStyleDeclaration {
  constructor() { this._v = {}; return new Proxy(this, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' ? (t._v?.[k] ?? '') : undefined), set: (t, k, v) => { if (k in t) t[k] = v; else (t._v ??= {})[camel(String(k))] = String(v); return true } }) }
  setProperty(k, v) { (this._v ??= {})[camel(String(k))] = String(v ?? '') } getPropertyValue(k) { return this._v?.[camel(String(k))] ?? '' } removeProperty(k) { k = camel(String(k)); const v = this._v?.[k] ?? ''; if (this._v) delete this._v[k]; return v }
  get cssText() { return Object.entries(this._v ?? {}).map(([k, v]) => `${kebab(k)}: ${v};`).join(' ') }
  set cssText(text) { this._v = {}; for (const d of String(text ?? '').split(';')) { const i = d.indexOf(':'); if (i > 0) this._v[camel(d.slice(0, i).trim())] = d.slice(i + 1).trim() } }
  get length() { return Object.keys(this._v ?? {}).length } item(i) { const k = Object.keys(this._v ?? {})[i]; return k ? kebab(k) : '' }
}
// getComputedStyle without a cascade: the element's inline style with env(safe-area-inset-*) resolved to the host's
// insets (pages probe them with a padding of env() values) and the box shorthands spread to their four sides.
const SIDES = ['Top', 'Right', 'Bottom', 'Left']
function computedStyle(el) {
  const out = new CSSStyleDeclaration(), src = el?.style?._v ?? {}, sa = W.__hostSafeArea ?? [0, 0, 0, 0]
  const env = (v) => String(v).replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^)]*)?\)/g, (_, side) => `${sa[['top', 'right', 'bottom', 'left'].indexOf(side)]}px`)
  for (const k in src) {
    const v = env(src[k])
    if (k === 'padding' || k === 'margin') { const p = v.trim().split(/\s+/), q = [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]]; SIDES.forEach((s, i) => { out[k + s] = q[i] }) }
    else out[k] = v
  }
  if (!out.display) out.display = el?.localName === 'span' ? 'inline' : 'block'
  return out
}
class DOMTokenList {
  constructor(el) { this._el = el; this._set = new Set() }
  get length() { return this._set.size } get value() { return [...this._set].join(' ') } set value(v) { this._set = new Set(String(v).split(/\s+/).filter(Boolean)) }
  add(...c) { for (const x of c) this._set.add(String(x)) } remove(...c) { for (const x of c) this._set.delete(String(x)) } contains(c) { return this._set.has(String(c)) }
  toggle(c, force) { const has = this._set.has(c); const want = force === undefined ? !has : !!force; want ? this._set.add(c) : this._set.delete(c); return want }
  replace(a, b) { if (!this._set.has(a)) return false; this._set.delete(a); this._set.add(b); return true } item(i) { return [...this._set][i] ?? null } toString() { return this.value } [Symbol.iterator]() { return this._set.values() } forEach(cb, t) { for (const c of this._set) cb.call(t, c, c, this) }
}
export class DOMRectReadOnly { constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h } get top() { return Math.min(this.y, this.y + this.height) } get left() { return Math.min(this.x, this.x + this.width) } get bottom() { return Math.max(this.y, this.y + this.height) } get right() { return Math.max(this.x, this.x + this.width) } toJSON() { return { ...this, top: this.top, left: this.left, bottom: this.bottom, right: this.right } } }
export class DOMRect extends DOMRectReadOnly {}
export { DOMException } from './globals.js'
import { DOMException, installAbort } from './globals.js'
import { installInput } from './input.js'

let elSeq = 0
export class Node extends ev.EventTarget {
  constructor() { super(); this.childNodes = []; this.parentNode = null; this._id = ++elSeq }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); c._connected?.(); return c }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; i < 0 ? this.childNodes.push(c) : this.childNodes.splice(i, 0, c); c._connected?.(); return c }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i < 0) throw new DOMException('not a child', 'NotFoundError'); this.childNodes.splice(i, 1); c.parentNode = null; return c }
  replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); return old }
  remove() { this.parentNode?.removeChild(this) }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false }
  get firstChild() { return this.childNodes[0] ?? null } get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null } get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null } get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null }
  hasChildNodes() { return this.childNodes.length > 0 } cloneNode() { return new this.constructor() } get isConnected() { for (let p = this; p; p = p.parentNode) if (p instanceof Document) return true; return false }
  get ownerDocument() { return W.document } getRootNode() { let p = this; while (p.parentNode) p = p.parentNode; return p }
  get textContent() { return this.childNodes.map(c => c.textContent ?? '').join('') } set textContent(v) { this.childNodes = []; if (v != null && v !== '') this.appendChild(new Text(String(v))) }
  normalize() {}
}
const NODE_CONST = { ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11 }
Object.assign(Node, NODE_CONST); Object.assign(Node.prototype, NODE_CONST)
export class Text extends Node { constructor(data = '') { super(); this.data = String(data); this.nodeType = 3; this.nodeName = '#text' } get textContent() { return this.data } set textContent(v) { this.data = String(v) } get nodeValue() { return this.data } set nodeValue(v) { this.data = v == null ? '' : String(v) } get length() { return this.data.length } }
export class Comment extends Text { constructor(d) { super(d); this.nodeType = 8; this.nodeName = '#comment' } }
export class Element extends Node {
  constructor(tag = 'div') { super(); this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1; this.localName = this.tagName.toLowerCase(); this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    this.style = new CSSStyleDeclaration(); this.classList = new DOMTokenList(this); this.dataset = {}; this._attrs = new Map(); this.hidden = false; this.tabIndex = -1; this.title = ''; this.slot = '' }
  get id() { return this._attrs.get('id') ?? '' } set id(v) { this._attrs.set('id', String(v)) }
  get className() { return this.classList.value } set className(v) { this.classList.value = v }
  get children() { return this.childNodes.filter(c => c instanceof Element) } get childElementCount() { return this.children.length } get firstElementChild() { return this.children[0] ?? null } get lastElementChild() { const c = this.children; return c[c.length - 1] ?? null }
  get innerHTML() { return this._html ?? '' } set innerHTML(v) { this._html = String(v); this.childNodes = [] } get outerHTML() { return `<${this.localName}>${this.innerHTML}</${this.localName}>` } get innerText() { return this.textContent } set innerText(v) { this.textContent = v }
  setAttribute(k, v) {
    k = String(k).toLowerCase(); this._attrs.set(k, String(v))
    if (k === 'style') this.style.cssText = v
    if (k === 'class') this.classList.value = v
    if (k === 'id') this.id = v
    // A reflected property with a setter (script.src, link.href) must run it. PlayCanvas loads Ammo with
    // setAttribute('src') before appendChild, and the load starts from that setter once the node is connected.
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), k)
    if (desc?.set) desc.set.call(this, v)
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v)
  }
  getAttribute(k) { k = String(k).toLowerCase(); if (k === 'class') return this.classList.value || (this._attrs.has('class') ? '' : null); return this._attrs.has(k) ? this._attrs.get(k) : null }
  hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()) } removeAttribute(k) { this._attrs.delete(String(k).toLowerCase()) } getAttributeNames() { return [...this._attrs.keys()] } toggleAttribute(k, f) { const has = this.hasAttribute(k); const want = f === undefined ? !has : !!f; want ? this.setAttribute(k, '') : this.removeAttribute(k); return want }
  setAttributeNS(ns, k, v) { this.setAttribute(k, v) } getAttributeNS(ns, k) { return this.getAttribute(k) }
  // NamedNodeMap: HTML attrs are un-namespaced; XML parse (below) fills _xmlAttrs with real namespaceURI / localName.
  get attributes() { return new NamedNodeMap(this._xmlAttrs ?? [...this._attrs].map(([name, value]) => new Attr(name, value, null, name, null))) }
  getBoundingClientRect() { const r = this._hostRect; if (r) return new DOMRect(r[0], r[1], r[2], r[3]); const big = this._fillsViewport?.(); return big ? new DOMRect(0, 0, W.innerWidth, W.innerHeight) : new DOMRect(0, 0, this.clientWidth, this.clientHeight) }  // _hostRect: a touch zone's box (input.js)
  getClientRects() { return [this.getBoundingClientRect()] }
  get clientWidth() { return this._hostRect ? this._hostRect[2] : this._fillsViewport?.() ? W.innerWidth : (this._w ?? 0) } get clientHeight() { return this._hostRect ? this._hostRect[3] : this._fillsViewport?.() ? W.innerHeight : (this._h ?? 0) }
  get offsetWidth() { return this.clientWidth } get offsetHeight() { return this.clientHeight } get scrollWidth() { return this.clientWidth } get scrollHeight() { return this.clientHeight }
  get clientLeft() { return 0 } get clientTop() { return 0 } get offsetLeft() { return 0 } get offsetTop() { return 0 } get offsetParent() { return null } scrollTop = 0; scrollLeft = 0
  focus() {} blur() {} click() { this.dispatchEvent(new ev.MouseEvent('click', { bubbles: true })) } scrollIntoView() {} scrollTo() {} scroll() {}
  requestPointerLock() { return requestPointerLock(this) } requestFullscreen() { return Promise.resolve() }
  setPointerCapture(id) { W.__hostPointerCapture?.(this, id, true) } releasePointerCapture(id) { W.__hostPointerCapture?.(this, id, false) } hasPointerCapture(id) { return !!W.__hostPointerCapture?.(this, id) }
  querySelector(sel) { return querySel(this, sel)[0] ?? null } querySelectorAll(sel) { return querySel(this, sel) } getElementsByTagName(t) { return querySel(this, t) } getElementsByTagNameNS(ns, l) { return collectNS(this, ns, l) } getElementsByClassName(c) { return querySel(this, '.' + c) }
  matches(sel) { return matchOne(this, sel) } closest(sel) { for (let p = this; p; p = p.parentElement) if (matchOne(p, sel)) return p; return null }
  append(...n) { for (const x of n) this.appendChild(x instanceof Node ? x : new Text(x)) } prepend(...n) { for (const x of n.reverse()) this.insertBefore(x instanceof Node ? x : new Text(x), this.firstChild) } replaceChildren(...n) { this.childNodes = []; this.append(...n) }
  before(...n) { for (const x of n) this.parentNode?.insertBefore(x instanceof Node ? x : new Text(x), this) } after(...n) { for (const x of n.reverse()) this.parentNode?.insertBefore(x instanceof Node ? x : new Text(x), this.nextSibling) }
  insertAdjacentHTML() {} insertAdjacentElement(pos, el) { if (pos === 'beforeend') this.appendChild(el); return el } attachShadow() { return this } get shadowRoot() { return null }
  animate() { return { cancel() {}, finish() {}, play() {}, pause() {}, finished: Promise.resolve(), onfinish: null } } getAnimations() { return [] }
  cloneNode(deep) { const e = new this.constructor(this.localName); for (const [k, v] of this._attrs) e.setAttribute(k, v); if (deep) for (const c of this.childNodes) e.appendChild(c.cloneNode(true)); return e }
  get isContentEditable() { return false } get assignedSlot() { return null }
}
// Pointer lock: the element becomes document.pointerLockElement and the window host (if it can) captures its cursor;
// movementX/Y carry the motion. The promise resolves (current browsers return one); Esc or exitPointerLock releases.
export function requestPointerLock(el) {
  const d = W.document
  if (d && d.pointerLockElement !== el) { d.pointerLockElement = el; W.__native?.input?.pointerLock?.(true); d.dispatchEvent(new ev.Event('pointerlockchange')) }
  return Promise.resolve()
}
// Selectors: compounds (tag, #id, .class, [attr], [attr=value] and its ~= |= ^= $= *= forms, and :not(), :first-child,
// :last-child, :checked, :disabled) joined by descendant (space) and child (>) combinators, in comma lists. Other
// pseudo-classes never match. Each selector string is parsed once (a page polls the same few every frame) into a list
// of complex selectors, each a list of compounds and '>' tokens; matching walks that, right to left.
const SELECTORS = new Map()
const PART = /#[\w-]+|\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)|:[\w-]+(?:\([^)]*\))?/g
function parseCompound(t) {
  const m = /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)|:[\w-]+(?:\([^)]*\))?)*)$/.exec(t)
  if (!m) return null  // unparseable: matches nothing
  const c = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, parts: [] }
  for (const part of m[2].match(PART) ?? []) {
    if (part[0] === '#') c.parts.push({ k: 'id', v: part.slice(1) })
    else if (part[0] === '.') c.parts.push({ k: 'class', v: part.slice(1) })
    else if (part[0] === '[') { const am = /^\[([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]$/.exec(part); if (!am) return null; c.parts.push({ k: 'attr', name: am[1], op: am[2] ?? null, v: am[3] ?? '' }) }
    else if (part.startsWith(':not(')) c.parts.push({ k: 'not', v: parseSelector(part.slice(5, -1)) })
    else if (part === ':first-child' || part === ':last-child' || part === ':checked' || part === ':disabled') c.parts.push({ k: part })
    else return null
  }
  return c
}
function parseSelector(sel) {
  sel = String(sel)
  let p = SELECTORS.get(sel)
  if (p) return p
  p = sel.trim() === '*' ? [[{ tag: null, parts: [] }]] : sel.split(',').map(x => x.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean).map(t => t === '>' ? '>' : parseCompound(t)))
  if (SELECTORS.size > 512) SELECTORS.clear()
  SELECTORS.set(sel, p)
  return p
}
function matchCompound(el, c) {
  if (!c) return false
  if (c.tag && String(el.localName ?? '').toLowerCase() !== c.tag) return false
  for (const p of c.parts) {
    switch (p.k) {
      case 'id': if (el.id !== p.v) return false; break
      case 'class': if (!(el.classList ? el.classList.contains(p.v) : String(el.className ?? '').split(/\s+/).includes(p.v))) return false; break  // XML nodes have no classList
      case 'attr': {
        if (!el.hasAttribute?.(p.name)) return false
        if (p.op) { const v = el.getAttribute(p.name) ?? '', w = p.v
          if (!(p.op === '=' ? v === w : p.op === '~=' ? v.split(/\s+/).includes(w) : p.op === '^=' ? v.startsWith(w) : p.op === '$=' ? v.endsWith(w) : p.op === '*=' ? v.includes(w) : v === w || v.startsWith(w + '-'))) return false }
        break
      }
      case 'not': if (p.v.some(cx => matchComplex(el, cx))) return false; break
      case ':first-child': if (el.parentNode?.children?.[0] !== el) return false; break
      case ':last-child': { const k = el.parentNode?.children; if (!k || k[k.length - 1] !== el) return false; break }
      case ':checked': if (!el.checked) return false; break
      case ':disabled': if (!el.disabled) return false; break
    }
  }
  return true
}
function matchComplex(el, toks) {
  const step = (node, i) => {  // does toks[0..i] match with toks[i] on node?
    if (!matchCompound(node, toks[i])) return false
    if (i === 0) return true
    if (toks[i - 1] === '>') { const p = node.parentNode; return !!p && p.nodeType === 1 && step(p, i - 2) }
    for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (step(p, i - 1)) return true
    return false
  }
  return toks.length > 0 && step(el, toks.length - 1)
}
function matchOne(el, sel) { const list = parseSelector(sel); for (let i = 0; i < list.length; i++) if (matchComplex(el, list[i])) return true; return false }
// Query results: a NodeList (an Array underneath, so indexing, forEach and spreading work; anime.js tests instanceof).
export class NodeList extends Array { static get [Symbol.species]() { return Array } item(i) { return this[i] ?? null } }
export class HTMLCollection extends Array { static get [Symbol.species]() { return Array } item(i) { return this[i] ?? null } namedItem(n) { return this.find(e => e.id === n || e.getAttribute?.('name') === n) ?? null } }
function querySel(root, sel) { const out = new NodeList(); const walk = (n) => { for (const c of n.childNodes ?? []) { if (c.nodeType === 1) { if (matchOne(c, sel)) out.push(c); walk(c) } } }; walk(root); return out }  // nodeType, not instanceof: a canvas (images/) is an element too
function collectNS(root, ns, local) {
  const out = new NodeList(), anyNs = ns === '*', anyLocal = local === '*'
  const walk = (n) => { for (const c of n.childNodes ?? []) { if (c.nodeType !== 1) continue; if ((anyNs || c.namespaceURI === ns) && (anyLocal || c.localName === local)) out.push(c); walk(c) } }
  return (walk(root), out)
}
class Attr { constructor(name, value, namespaceURI, localName, prefix) { this.name = name; this.value = String(value); this.nodeValue = this.value; this.nodeType = 2; this.namespaceURI = namespaceURI; this.localName = localName; this.prefix = prefix; this.specified = true } }
class NamedNodeMap {
  constructor(a) { this._a = a }
  get length() { return this._a.length } item(i) { return this._a[i] ?? null }
  getNamedItem(name) { return this._a.find(a => a.name === name) ?? null }
  getNamedItemNS(ns, local) { return this._a.find(a => a.namespaceURI === ns && a.localName === local) ?? null }
  [Symbol.iterator]() { return this._a[Symbol.iterator]() }
}

export class HTMLElement extends Element { constructor(tag) { super(tag); this.lang = ''; this.dir = ''; this.draggable = false; this.spellcheck = false } }
export class HTMLDivElement extends HTMLElement { constructor() { super('div') } }
export class HTMLSpanElement extends HTMLElement { constructor() { super('span') } }
export class HTMLBodyElement extends HTMLElement { constructor() { super('body') } _fillsViewport() { return true } }
export class HTMLHtmlElement extends HTMLElement { constructor() { super('html') } _fillsViewport() { return true } }
export class HTMLHeadElement extends HTMLElement { constructor() { super('head') } }
export class HTMLAnchorElement extends HTMLElement { constructor() { super('a'); this.href = ''; this.target = ''; this.download = ''; this.rel = '' } }
export class HTMLButtonElement extends HTMLElement { constructor() { super('button'); this.disabled = false; this.type = 'submit' } }
export class HTMLInputElement extends HTMLElement { constructor() { super('input'); this.value = ''; this.type = 'text'; this.disabled = false; this.checked = false } select() {} setSelectionRange() {} }
export class HTMLStyleElement extends HTMLElement { constructor() { super('style'); this.sheet = { cssRules: [], insertRule() { return 0 }, deleteRule() {} } } }
const SW_HOOK = Symbol.for('webxr-host.serviceworker')  // set by runtime/src/serviceworker (host.json web.serviceWorker)
export class HTMLScriptElement extends HTMLElement {
  constructor() { super('script'); this.async = true; this.defer = false; this.type = ''; this.noModule = false; this.crossOrigin = null; this._src = '' }
  // Loaded once, when it is in the document with a src: inserted with one, or (as a browser does) given one after an
  // empty insert (Wonderland's loadScript appends first, then sets src).
  get src() { return this._src } set src(v) { this._src = String(v); if (this.isConnected) this._connected() }
  _connected() { if (!this._src || this._started) return; this._started = true
    const url = new W.URL(this._src, W.location.href).href
    const sw = W[SW_HOOK]  // a controlling service worker sees the load as a script request (WP-27)
    ;(sw ? sw.load(url, 'script') : W.fetch(url)).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const text = await r.text()
      if (this.type === 'module') await import(url)
      else {
        const prev = W.document?.currentScript
        if (W.document) W.document.currentScript = this
        try { W.__hostEvalScript?.(text, url) } finally { if (W.document) W.document.currentScript = prev ?? null }
      }
      this.dispatchEvent(new ev.Event('load'))
    }, e => { W.__native?.log?.(3, `script ${url}: ${e}`); this.dispatchEvent(new ev.Event('error')) }) }
}
export class HTMLLinkElement extends HTMLElement {
  constructor() { super('link'); this.rel = ''; this.as = ''; this.crossOrigin = null; this.media = ''; this.type = ''; this.sheet = null; this._href = '' }
  get href() { return this._href } set href(v) { this._href = String(v) }
  _connected() { const g = globalThis; if (!this._href) return
    if (this.rel === 'modulepreload' || this.rel === 'preload' || this.rel === 'prefetch') { // assets are local: fire load next tick (Vite's preload helper awaits it)
      g.setTimeout(() => this.dispatchEvent(new ev.Event('load')), 0); return }
    if (this.rel === 'stylesheet') { g.setTimeout(() => this.dispatchEvent(new ev.Event('load')), 0) } }
}
// What decodeAudioData decodes here (host/audio/decode.cpp; __native.audio.codecs): WAV, Ogg and WebM with Vorbis or
// Opus (libopus), MP3 (dr_mp3). Answered as a browser answers: 'maybe' for a container that holds several codecs
// named alone, 'probably' when every codec the type names is decoded (or the container has only one, as MP3's),
// '' otherwise. No playback unless host.json audio.elements (webaudio/media-elements.js): Audio.play() rejects.
const MEDIA_CODECS = {
  'audio/wav': ['1'], 'audio/wave': ['1'], 'audio/x-wav': ['1'],
  'audio/ogg': ['vorbis', 'opus'], 'application/ogg': ['vorbis', 'opus'], 'audio/webm': ['vorbis', 'opus'],
  'audio/mpeg': ['mp3'], 'audio/mp3': ['mp3'],
  'audio/mp4': ['aac'], 'audio/aac': ['aac'], 'audio/x-m4a': ['aac'], 'audio/m4a': ['aac'],
}
const IMPLIED = new Set(['audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/x-m4a', 'audio/m4a'])  // one codec only: 'probably' with no codecs parameter
function canPlayType(type) {
  const m = /^\s*([^\s;]+)\s*(?:;(.*))?$/.exec(String(type)); if (!m) return ''
  const mime = m[1].toLowerCase(), built = String(W.__native?.audio?.codecs ?? 'wav vorbis').split(' ')
  const codecs = (MEDIA_CODECS[mime] ?? []).filter(c => built.includes(c === '1' ? 'wav' : c))
  if (!codecs.length) return ''
  const p = /(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(m[2] ?? '')
  if (!p) return IMPLIED.has(mime) ? 'probably' : 'maybe'
  const want = (p[1] ?? p[2]).split(',').map(c => c.trim().toLowerCase()).filter(Boolean).map(c => c.startsWith('mp4a.') ? 'aac' : c)
  return want.length && want.every(c => codecs.includes(c)) ? 'probably' : ''
}
export class HTMLMediaElement extends HTMLElement { constructor(t) { super(t); this.src = ''; this.currentTime = 0; this.duration = NaN; this.paused = true; this.muted = false; this.volume = 1; this.loop = false; this.autoplay = false; this.playsInline = true; this.crossOrigin = null; this.readyState = 0; this.networkState = 0; this.videoWidth = 0; this.videoHeight = 0; this.preload = 'auto' } canPlayType(t) { return canPlayType(t) } play() { const e = new DOMException('media not supported in webxr-host', 'NotSupportedError'); return Promise.reject(e) } pause() {} load() {} addTextTrack() { return null } }
export class HTMLVideoElement extends HTMLMediaElement { constructor() { super('video'); this.width = 0; this.height = 0 } requestVideoFrameCallback() { return 0 } cancelVideoFrameCallback() {} getVideoPlaybackQuality() { return { droppedVideoFrames: 0, totalVideoFrames: 0 } } }
export class HTMLAudioElement extends HTMLMediaElement { constructor() { super('audio') } }
export class HTMLIFrameElement extends HTMLElement { constructor() { super('iframe'); this.src = ''; this.contentWindow = null; this.contentDocument = null } }
export class HTMLTemplateElement extends HTMLElement { constructor() { super('template'); this.content = new DocumentFragment() } }
export class DocumentFragment extends Node { constructor() { super(); this.nodeType = 11; this.nodeName = '#document-fragment' } querySelector(s) { return querySel(this, s)[0] ?? null } querySelectorAll(s) { return querySel(this, s) } append(...n) { for (const x of n) this.appendChild(x instanceof Node ? x : new Text(x)) } get children() { return this.childNodes.filter(c => c instanceof Element) } }
export class SVGElement extends Element { constructor(tag) { super(tag); this.namespaceURI = 'http://www.w3.org/2000/svg' } }

const TAGS = { div: HTMLDivElement, span: HTMLSpanElement, a: HTMLAnchorElement, button: HTMLButtonElement, input: HTMLInputElement, style: HTMLStyleElement, script: HTMLScriptElement, link: HTMLLinkElement, video: HTMLVideoElement, audio: HTMLAudioElement, iframe: HTMLIFrameElement, template: HTMLTemplateElement, body: HTMLBodyElement, head: HTMLHeadElement, html: HTMLHtmlElement }

export class Document extends Node {
  constructor() { super(); this.nodeType = 9; this.nodeName = '#document'; this.documentElement = new HTMLHtmlElement(); this.head = new HTMLHeadElement(); this.body = new HTMLBodyElement()
    super.appendChild(this.documentElement); this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body)
    this.title = ''; this.readyState = 'complete'; this.visibilityState = 'visible'; this.hidden = false; this.cookie = ''; this.referrer = ''; this.currentScript = null; this.fullscreenElement = null; this.pointerLockElement = null; this.characterSet = 'UTF-8'; this.compatMode = 'CSS1Compat'; this.contentType = 'text/html'; this.designMode = 'off'
    this.fonts = { ready: Promise.resolve(), check: () => true, load: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {}, add() {}, status: 'loaded' }
    this.implementation = { createHTMLDocument: () => new Document(), hasFeature: () => true }; this.defaultView = null; this.scrollingElement = this.documentElement }
  get URL() { return W.location?.href ?? '' } get documentURI() { return this.URL } get baseURI() { return this.URL } get location() { return W.location } get activeElement() { return this.body } get styleSheets() { return [] } get images() { return querySel(this, 'img') } get scripts() { return querySel(this, 'script') } get forms() { return [] } get links() { return querySel(this, 'a') }
  createElement(tag, opts) { tag = String(tag).toLowerCase()
    if (tag === 'canvas') { const c = W.__hostCreateCanvas?.(); if (c) return c; warnOnce('canvas', 'no canvas factory (WP-05 missing)') }
    if (tag === 'img') { const I = W.HTMLImageElement ?? W.Image; if (I) return new I() }
    const C = TAGS[tag]; return C ? new C() : new HTMLElement(tag) }
  createElementNS(ns, tag) { if (ns === 'http://www.w3.org/2000/svg') return new SVGElement(tag); return this.createElement(tag) }
  createTextNode(t) { return new Text(t) } createComment(t) { return new Comment(t) } createDocumentFragment() { return new DocumentFragment() } createEvent(type) { return type === 'CustomEvent' ? new ev.CustomEvent('') : new ev.Event('') } createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, getBoundingClientRect: () => new DOMRect(), getClientRects: () => [], collapse() {}, deleteContents() {}, cloneContents: () => new DocumentFragment() } }
  createTreeWalker() { return { nextNode: () => null, currentNode: null } } createNodeIterator() { return { nextNode: () => null } } importNode(n, deep) { return n.cloneNode(deep) } adoptNode(n) { return n }
  getElementById(id) {
    return querySel(this, '#' + id)[0] ?? null }
  querySelector(s) { return querySel(this, s)[0] ?? null } querySelectorAll(s) { return querySel(this, s) } getElementsByTagName(t) { return t === 'body' ? [this.body] : t === 'head' ? [this.head] : querySel(this, t) } getElementsByTagNameNS(ns, l) { return collectNS(this, ns, l) } getElementsByClassName(c) { return querySel(this, '.' + c) } getElementsByName() { return [] }
  hasFocus() { return true } elementFromPoint() { return null } elementsFromPoint() { return [] } exitPointerLock() { if (!this.pointerLockElement) return; this.pointerLockElement = null; W.__native?.input?.pointerLock?.(false); this.dispatchEvent(new ev.Event('pointerlockchange')) } exitFullscreen() { return Promise.resolve() } getSelection() { return { removeAllRanges() {}, addRange() {}, rangeCount: 0, toString: () => '' } } execCommand() { return false } write() {} writeln() {} open() { return this } close() {}
  get fullscreenEnabled() { return false } get pictureInPictureEnabled() { return false }
}
// DOMParser: XML (and SVG) parse into a real element tree, which three's SVGLoader walks (uikit draws its icons
// through it); HTML stays a stub document. Elements keep their names' case, as in an XML document.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const unescapeXml = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENTITIES[e] ?? m)
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/', SVG_NS = 'http://www.w3.org/2000/svg'
// Default xmlns applies to elements only (never to unprefixed attributes) and is inherited. xmlns:prefix binds a
// prefix for this element and its descendants. lazy-widgets UI XML depends on both: <ui-tree xmlns="lazy-widgets"
// xmlns:option="lazy-widgets:options"> then getElementsByTagNameNS + attribute.namespaceURI.
function parseXml(src) {
  const root = new DocumentFragment(), stack = [root], nsStack = [Object.create(null)], defStack = [null]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/gi
  for (let m; (m = re.exec(src));) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.appendChild(new Text(m[1]))
    else if (m[2]) { if (stack.length > 1) { stack.pop(); nsStack.pop(); defStack.pop() } }
    else if (m[3]) {
      const name = m[3]
      const raw = [...m[4].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)].map(a => ({ name: a[1], value: unescapeXml(a[2] ?? a[3] ?? '') }))
      const prefixes = Object.create(nsStack[nsStack.length - 1])
      let def = defStack[defStack.length - 1]
      for (const a of raw) {
        if (a.name === 'xmlns') def = a.value || null
        else if (a.name.startsWith('xmlns:')) prefixes[a.name.slice(6)] = a.value
      }
      const colon = name.indexOf(':')
      const prefix = colon >= 0 ? name.slice(0, colon) : null, local = colon >= 0 ? name.slice(colon + 1) : name
      let ns = prefix ? (prefixes[prefix] ?? null) : def
      if (!ns && local === 'svg') { ns = SVG_NS; def = SVG_NS }  // a bare <svg> is SVG, and so are the elements inside it
      const el = ns === SVG_NS ? new SVGElement(local) : new Element(local)
      el.tagName = el.nodeName = name; el.localName = local; el.prefix = prefix; el.namespaceURI = ns
      el._xmlAttrs = []
      for (const a of raw) {
        let ap = null, al = a.name, ans = null
        if (a.name === 'xmlns') { ans = XMLNS_NS; al = 'xmlns' }
        else if (a.name.startsWith('xmlns:')) { ans = XMLNS_NS; ap = 'xmlns'; al = a.name.slice(6) }
        else if (a.name.includes(':')) { const i = a.name.indexOf(':'); ap = a.name.slice(0, i); al = a.name.slice(i + 1); ans = prefixes[ap] ?? null }
        el._xmlAttrs.push(new Attr(a.name, a.value, ans, al, ap))
        el.setAttribute(a.name, a.value)
      }
      top.appendChild(el)
      if (!m[5]) { stack.push(el); nsStack.push(prefixes); defStack.push(def) }
    } else if (m[6] !== undefined && m[6].trim()) top.appendChild(new Text(unescapeXml(m[6])))
  }
  return root.children[0] ?? null
}
export class DOMParser {
  parseFromString(str, type) {
    const d = new Document(); d.contentType = type; d._source = str
    if (/xml|svg/i.test(String(type))) {
      const el = parseXml(String(str))
      d.childNodes = []; d.head = d.body = null; d.documentElement = el
      if (el) { el.parentNode = d; d.childNodes.push(el) }
    }
    return d
  }
}
export class XMLSerializer { serializeToString(n) { return n?.outerHTML ?? '' } }
export class MutationObserver { constructor(cb) { this._cb = cb } observe() {} disconnect() {} takeRecords() { return [] } }
// Observers hear once on observe and again whenever the viewport changes (the only resize there is without layout).
const RESIZE_OBSERVERS = new Set()
const resizeEntry = (el) => ({ target: el, contentRect: el.getBoundingClientRect(), borderBoxSize: [{ inlineSize: el.clientWidth, blockSize: el.clientHeight }], contentBoxSize: [{ inlineSize: el.clientWidth, blockSize: el.clientHeight }], devicePixelContentBoxSize: [{ inlineSize: Math.round(el.clientWidth * (W.devicePixelRatio ?? 1)), blockSize: Math.round(el.clientHeight * (W.devicePixelRatio ?? 1)) }] })
export class ResizeObserver { constructor(cb) { this._cb = cb; this._t = [] } observe(el) { this._t.push(el); RESIZE_OBSERVERS.add(this); const g = globalThis; g.setTimeout(() => this._cb([resizeEntry(el)], this), 0) } unobserve(el) { this._t = this._t.filter(t => t !== el); if (!this._t.length) RESIZE_OBSERVERS.delete(this) } disconnect() { this._t = []; RESIZE_OBSERVERS.delete(this) } _notify() { if (this._t.length) try { this._cb(this._t.map(resizeEntry), this) } catch (e) { ev.reportError(e) } } }
export class IntersectionObserver { constructor(cb) { this._cb = cb } observe(el) { W.setTimeout(() => this._cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: el.getBoundingClientRect(), intersectionRect: el.getBoundingClientRect(), rootBounds: null, time: W.performance.now() }], this), 0) } unobserve() {} disconnect() {} takeRecords() { return [] } }
export class PerformanceObserver { constructor() {} observe() {} disconnect() {} takeRecords() { return [] } static get supportedEntryTypes() { return [] } }
// A media query against the device (touch or not) and the viewport: comma lists, `and`, `not`, `only`, and the
// features games ask (pointer, hover, width/height ranges, orientation, reduced motion, colour scheme, resolution).
function mediaFeature(f) {
  const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(f.trim()); if (!m) return /^(all|screen)$/.test(f.trim())
  const [, name, val] = m, touch = W.__hostTouchDevice, px = (v) => parseFloat(v) * (/em$/.test(v) ? 16 : 1)
  switch (name) {
    case 'pointer': case 'any-pointer': return val === undefined ? true : val === (touch ? 'coarse' : 'fine')
    case 'hover': case 'any-hover': return val === undefined ? !touch : val === (touch ? 'none' : 'hover')
    case 'min-width': return W.innerWidth >= px(val); case 'max-width': return W.innerWidth <= px(val)
    case 'min-height': return W.innerHeight >= px(val); case 'max-height': return W.innerHeight <= px(val)
    case 'width': return W.innerWidth === px(val); case 'height': return W.innerHeight === px(val)
    case 'orientation': return val === (W.innerHeight > W.innerWidth ? 'portrait' : 'landscape')
    case 'prefers-reduced-motion': return val === undefined ? false : val === 'no-preference'
    case 'prefers-color-scheme': return val === 'light'
    case 'prefers-contrast': case 'forced-colors': return val === 'no-preference' || val === 'none'
    case 'min-resolution': return (W.devicePixelRatio ?? 1) >= parseFloat(val) / (/dpi$/.test(val) ? 96 : 1)
    case 'max-resolution': return (W.devicePixelRatio ?? 1) <= parseFloat(val) / (/dpi$/.test(val) ? 96 : 1)
    case '-webkit-min-device-pixel-ratio': case 'min-device-pixel-ratio': return (W.devicePixelRatio ?? 1) >= parseFloat(val)
    case 'display-mode': return val === 'fullscreen' || val === 'standalone'
    default: return false
  }
}
export function mediaMatches(q) {
  return String(q).split(',').some(part => {
    let p = part.trim().toLowerCase(), not = false
    if (p.startsWith('not ')) { not = true; p = p.slice(4) } else if (p.startsWith('only ')) p = p.slice(5)
    const ok = p.split(/\s+and\s+/).every(mediaFeature)
    return not ? !ok : ok
  })
}
// Lists with a listener hear a 'change' when the viewport flips their answer (__hostSetViewport), as in a browser.
const WATCHED_MEDIA = new Set()
class MediaQueryList extends ev.EventTarget {
  constructor(q) { super(); this.media = q; this.onchange = null; this._last = mediaMatches(q) }
  get matches() { return mediaMatches(this.media) }
  addEventListener(type, cb, opts) { super.addEventListener(type, cb, opts); if (type === 'change') { this._last = this.matches; WATCHED_MEDIA.add(this) } }
  set onchange(v) { this._onchange = v; if (v) { this._last = this.matches; WATCHED_MEDIA.add(this) } } get onchange() { return this._onchange ?? null }
  _recheck() { const m = this.matches; if (m === this._last) return; this._last = m; this.dispatchEvent(Object.assign(new ev.Event('change'), { matches: m, media: this.media })) } addListener(cb) { this.addEventListener('change', cb) } removeListener(cb) { this.removeEventListener('change', cb) } }
class Storage {
  constructor(n) { this._n = n; return new Proxy(this, { get: (t, k) => k in t || typeof k !== 'string' ? t[k] : t.getItem(k), set: (t, k, v) => { if (k in t) t[k] = v; else t.setItem(k, v); return true }, deleteProperty: (t, k) => { t.removeItem(k); return true }, has: (t, k) => k in t || t.getItem(k) !== null, ownKeys: (t) => { const ks = []; for (let i = 0; i < t.length; i++) ks.push(t.key(i)); return ks }, getOwnPropertyDescriptor: (t, k) => t.getItem(k) === null ? undefined : { value: t.getItem(k), enumerable: true, configurable: true, writable: true } }) }
  getItem(k) { return this._n.get(String(k)) } setItem(k, v) { if (!this._n.set(String(k), String(v))) throw new DOMException('quota exceeded', 'QuotaExceededError') } removeItem(k) { this._n.remove(String(k)) } clear() { this._n.clear() } key(i) { return this._n.key(i) } get length() { return this._n.length() }
}
function memStore() { const m = new Map(); return { get: k => m.has(k) ? m.get(k) : null, set: (k, v) => { m.set(k, v); return true }, remove: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, length: () => m.size } }
class Location { constructor(href) { this._u = new URL(href) } get href() { return this._u.href } set href(v) { W.__native?.log?.(2, `location.href = ${v} ignored`) } get origin() { return this._u.origin } get protocol() { return this._u.protocol } get host() { return this._u.host } get hostname() { return this._u.hostname } get port() { return this._u.port } get pathname() { return this._u.pathname } get search() { return this._u.search } get hash() { return this._u.hash } set hash(v) { this._u.hash = v } assign() {} replace() {} reload() { W.__native?.log?.(1, 'location.reload() requested; exiting for a restart'); W.__native?.loop.exit() } toString() { return this.href } }

// The page's own elements (pack.mjs reads them from index.html), as stubs: every id index.html declares exists
// (loading.ts & co. query them), built in document order under their parents. A top-level one (directly in the body)
// fills the viewport, as a game's container or overlay does in its CSS. Built once every element kind can be made
// (index.js calls this after images/), so a declared <canvas> is a real canvas (Wonderland renders into the page's).
export function installPageElements(g) {
  const built = []
  for (const e of g.__native?.config?.web?.elements ?? []) {
    const el = g.document.createElement(e.tag); if (e.id) el.id = e.id; if (e.class) el.className = e.class
    for (const k in e.attrs ?? {}) { try { el.setAttribute(k, e.attrs[k]) } catch {} }
    // parent: the index of an earlier element, -1 the body (pack.mjs); an id string or null in older stages
    const parent = typeof e.parent === 'number' ? built[e.parent] : e.parent ? g.document.getElementById(e.parent) : null
    if (!parent) el._fillsViewport = () => true
    ;(parent ?? g.document.body).appendChild(el); built.push(el)
  }
}

export function install(g) {
  W = g
  const n = g.__native
  Object.assign(g, ev, { Node, Text, Comment, Element, HTMLElement, HTMLDivElement, HTMLSpanElement, HTMLBodyElement, HTMLHtmlElement, HTMLHeadElement, HTMLAnchorElement, HTMLButtonElement, HTMLInputElement, HTMLStyleElement, HTMLScriptElement, HTMLLinkElement, HTMLMediaElement, HTMLVideoElement, HTMLAudioElement, HTMLIFrameElement, HTMLTemplateElement, DocumentFragment, SVGElement, Document, DOMParser, XMLSerializer, MutationObserver, ResizeObserver, IntersectionObserver, PerformanceObserver, DOMRect, DOMRectReadOnly, DOMException, CSSStyleDeclaration, DOMTokenList, MediaQueryList, NodeList, HTMLCollection })
  g.DOMPoint = g.DOMPointReadOnly = class DOMPointReadOnly { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w } static fromPoint(p) { return new g.DOMPointReadOnly(p.x, p.y, p.z, p.w) } toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w } } }
  // window is the global
  g.window = g; g.self = g; g.globalThis = g; g.parent = g; g.top = g; g.frames = g; g.frameElement = null; g.opener = null; g.closed = false; g.name = ''; g.isSecureContext = true; g.crossOriginIsolated = false; g.origin = (n.config?.web?.origin ?? 'https://app.local').replace(/\/$/, '')
  const target = new ev.EventTarget(); g.__hostWindowTarget = target
  g.addEventListener = (...a) => target.addEventListener(...a); g.removeEventListener = (...a) => target.removeEventListener(...a); g.dispatchEvent = (e) => { e.target ??= g; return target.dispatchEvent(e) }
  // timers
  const wrap = (cb, args) => typeof cb === 'function' ? (args.length ? () => cb(...args) : cb) : () => g.__hostEvalScript?.(String(cb), 'timer')
  g.setTimeout = (cb, ms = 0, ...args) => n.loop.setTimer(Math.max(0, +ms || 0), false, wrap(cb, args)); g.clearTimeout = (id) => { if (id) n.loop.clearTimer(id) }
  g.setInterval = (cb, ms = 0, ...args) => n.loop.setTimer(Math.max(1, +ms || 0), true, wrap(cb, args)); g.clearInterval = g.clearTimeout
  g.queueMicrotask = (cb) => { Promise.resolve().then(cb).catch(e => ev.reportError(e)) }
  g.requestIdleCallback = (cb) => g.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 5 }), 1); g.cancelIdleCallback = g.clearTimeout
  // rAF: flat source until WebXR takes over; callbacks run once per frame with a timestamp
  // Two queues swapped per frame (no Map per frame): callbacks registered while a batch runs land in the other one.
  let rafId = 0; let rafQueue = new Map(); let rafSpare = new Map(); let rafT = 0
  g.requestAnimationFrame = (cb) => { rafQueue.set(++rafId, cb); return rafId }; g.cancelAnimationFrame = (id) => { rafQueue.delete(id) }
  const rafRun = (cb) => { try { cb(rafT) } catch (e) { ev.reportError(e) } }
  g.__hostRunWindowFrame = (t) => { if (!rafQueue.size) return; g.__hostBeforeFlatFrame?.(); const q = rafQueue; rafQueue = rafSpare; rafT = t; q.forEach(rafRun); q.clear(); rafSpare = q }
  let flatOn = true; n.loop.onFrame((t) => { if (!flatOn) return; g.__hostDrainInput?.(); g.__hostRunWindowFrame(t); g.__hostAfterFlatFrame?.(); g.__hostControlsTick?.() })
  g.__hostSuspendFlatFrames = () => { flatOn = false }; g.__hostResumeFlatFrames = () => { flatOn = true }
  // performance
  const t0 = Date.now() - n.loop.now(); const marks = new Map()
  g.performance = { now: () => n.loop.now(), timeOrigin: t0, mark: (name, o) => { const e = { name, entryType: 'mark', startTime: o?.startTime ?? n.loop.now(), duration: 0, detail: o?.detail ?? null }; marks.set(name, e); return e }, measure: (name, a, b) => ({ name, entryType: 'measure', startTime: marks.get(a)?.startTime ?? 0, duration: (marks.get(b)?.startTime ?? n.loop.now()) - (marks.get(a)?.startTime ?? 0) }), clearMarks: (k) => k ? marks.delete(k) : marks.clear(), clearMeasures() {}, getEntries: () => [], getEntriesByType: () => [], getEntriesByName: (k) => marks.has(k) ? [marks.get(k)] : [], memory: { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 }, timing: {}, navigation: { type: 0, redirectCount: 0 }, toJSON: () => ({}), addEventListener() {}, removeEventListener() {}, eventCounts: new Map() }
  // misc globals
  g.structuredClone = (v, opts) => n.clone(v)
  g.atob = atob; g.btoa = btoa
  g.alert = (m) => n.log(2, `alert: ${m}`); g.confirm = () => true; g.prompt = () => null; g.open = () => { n.log(2, 'window.open ignored'); return null }; g.close = () => { n.loop?.exit?.() }  // the app's only window: closing it quits, as a native app does; g.focus = () => {}; g.blur = () => {}; g.print = () => {}; g.stop = () => {}; g.scrollTo = () => {}; g.scroll = () => {}; g.scrollBy = () => {}; g.moveTo = () => {}; g.resizeTo = () => {}; g.postMessage = (data) => { g.setTimeout(() => g.dispatchEvent(new ev.MessageEvent('message', { data, origin: g.origin, source: g })), 0) }
  g.getComputedStyle = (el) => computedStyle(el); g.matchMedia = (q) => new MediaQueryList(String(q)); g.getSelection = () => g.document.getSelection()
  g.devicePixelRatio = 1; g.innerWidth = 1280; g.innerHeight = 800; g.outerWidth = 1280; g.outerHeight = 800; g.screenX = 0; g.screenY = 0; g.scrollX = 0; g.scrollY = 0; g.pageXOffset = 0; g.pageYOffset = 0
  // The window, from native: its size in CSS pixels, the device pixel ratio, its framebuffer in pixels and the screen's
  // rotation (0, 90, 180, 270). A change fires resize (and orientationchange), and the resize observers hear it.
  g.__hostWindowPixels = [1280, 800]
  g.__hostSafeArea = [0, 0, 0, 0]  // the safe-area insets in CSS px: top, right, bottom, left (env(safe-area-inset-*))
  g.__hostSetViewport = (w, h, dpr = g.devicePixelRatio, fbW = Math.round(w * dpr), fbH = Math.round(h * dpr), angle = g.screen?.orientation?.angle ?? 0, top = 0, right = 0, bottom = 0, left = 0) => {
    g.__hostWindowPixels[0] = fbW; g.__hostWindowPixels[1] = fbH
    const turned = angle !== (g.screen?.orientation?.angle ?? 0), sa = g.__hostSafeArea
    const insetsMoved = sa[0] !== top || sa[1] !== right || sa[2] !== bottom || sa[3] !== left
    sa[0] = top; sa[1] = right; sa[2] = bottom; sa[3] = left
    if (g.innerWidth === w && g.innerHeight === h && g.devicePixelRatio === dpr && !turned && !insetsMoved) return
    g.innerWidth = g.outerWidth = w; g.innerHeight = g.outerHeight = h; g.devicePixelRatio = dpr
    g.screen.width = g.screen.availWidth = w; g.screen.height = g.screen.availHeight = h
    g.screen.orientation.angle = angle; g.screen.orientation.type = (w >= h ? 'landscape' : 'portrait') + (angle >= 180 ? '-secondary' : '-primary'); g.orientation = angle > 180 ? angle - 360 : angle
    g.dispatchEvent(new ev.UIEvent('resize'))
    if (turned) { g.dispatchEvent(new ev.Event('orientationchange')); g.screen.orientation.dispatchEvent?.(new ev.Event('change')) }
    for (const o of RESIZE_OBSERVERS) o._notify()
    for (const q of WATCHED_MEDIA) q._recheck()
  }
  g.screen = { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24, orientation: Object.assign(new ev.EventTarget(), { type: 'landscape-primary', angle: 0, onchange: null, lock: () => Promise.resolve(), unlock() {} }) }
  g.visualViewport = Object.assign(new ev.EventTarget(), { get width() { return g.innerWidth }, get height() { return g.innerHeight }, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 })
  g.history = { length: 1, state: null, scrollRestoration: 'auto', back() {}, forward() {}, go() {}, pushState(s) { this.state = s }, replaceState(s) { this.state = s } }
  const cfg = n.config ?? {}; const origin = g.origin; const query = cfg.web?.query ? (cfg.web.query[0] === '?' ? cfg.web.query : '?' + cfg.web.query) : ''
  g.location = new Location(origin + '/' + query)
  g.localStorage = new Storage(n.store); g.sessionStorage = new Storage(memStore())
  g.crypto = g.crypto ?? {}; if (!g.crypto.getRandomValues) g.crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256) & (a.BYTES_PER_ELEMENT === 1 ? 255 : a.BYTES_PER_ELEMENT === 2 ? 65535 : 0xFFFFFFFF); return a }
  if (!g.crypto.randomUUID) g.crypto.randomUUID = () => { const b = g.crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
  installAbort(g)
  g.reportError = ev.reportError
  // navigator
  // What the page is told it runs on (__native.info.formFactor): 'quest' (and the emulated-headset window hosts, which
  // pass for one), or 'phone': a mobile Chrome on Android with a touch screen. The user agent string is native's.
  const phone = n.info.formFactor === 'phone'
  g.__hostTouchDevice = phone
  // A phone has a touch screen: `'ontouchstart' in window` is how pages decide to build their touch UI, and the
  // host's controls follow that UI (touchControls.showWhen). Pointer events carry the touches.
  if (phone) { g.ontouchstart = null; g.ontouchmove = null; g.ontouchend = null; g.ontouchcancel = null }
  g.navigator = { userAgent: n.info.userAgent, platform: phone ? 'Linux armv81' : 'Linux aarch64', language: 'en-US', languages: ['en-US', 'en'], onLine: true, hardwareConcurrency: 4, maxTouchPoints: phone ? 5 : 0, cookieEnabled: false, vendor: 'webxr-host', vendorSub: '', product: 'Gecko', productSub: '20030107', appName: 'Netscape', appVersion: n.info.userAgent.replace(/^Mozilla\//, ''), appCodeName: 'Mozilla', doNotTrack: null, pdfViewerEnabled: false, webdriver: false, deviceMemory: 8,
    userAgentData: { brands: phone ? [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }] : [{ brand: 'Chromium', version: '140' }, { brand: 'OculusBrowser', version: '40' }], mobile: phone, platform: 'Android', getHighEntropyValues: () => Promise.resolve({ platform: 'Android', platformVersion: '14', architecture: 'arm', model: phone ? '' : 'Quest 3', mobile: phone }), toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform } } },
    getGamepads: () => [], vibrate: () => false, sendBeacon: () => false, javaEnabled: () => false, canShare: () => false, share: () => Promise.reject(new DOMException('unsupported', 'NotSupportedError')), requestMIDIAccess: () => Promise.reject(new DOMException('unsupported', 'NotSupportedError')),
    permissions: { query: (d) => Promise.resolve({ state: d?.name === 'xr-spatial-tracking' ? 'granted' : 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} }) },
    storage: { estimate: () => Promise.resolve({ usage: 0, quota: 5 * 1024 * 1024 }), persist: () => Promise.resolve(false), persisted: () => Promise.resolve(false) },
    locks: { request: (name, opts, cb) => Promise.resolve((typeof opts === 'function' ? opts : cb)?.({ name, mode: 'exclusive' })) },
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false, addEventListener() {}, removeEventListener() {} },
    // xr is installed by WP-07a; mediaDevices/gpu/clipboard/serviceWorker intentionally absent
  }
  g.clientInformation = g.navigator
  g.document = new Document(); g.document.defaultView = g
  g.document._windowTarget = target; Object.defineProperty(target, '_window', { value: g })  // events bubble from the document to the window
  g.document.title = cfg.web?.title ?? ''
  installInput(g, n)
  // new Audio(src): the constructor pages (Howler) probe codecs with; an <audio> element that plays nothing here.
  g.Audio = g.Audio ?? class Audio extends HTMLAudioElement { constructor(src) { super(); if (src !== undefined) this.src = String(src) } }
  g.customElements = { define() {}, get: () => undefined, whenDefined: () => Promise.resolve(), upgrade() {} }
  g.CSS = { supports: () => false, escape: (s) => String(s).replace(/[^\w-]/g, c => '\\' + c), px: (v) => ({ value: v, unit: 'px' }) }
  g.Image = g.Image ?? class Image extends HTMLElement { constructor(w, h) { super('img'); this.width = w ?? 0; this.height = h ?? 0; warnOnce('img', 'Image before WP-05 installed') } }
  g.FontFace = class FontFace { constructor(family, src, d = {}) { this.family = family; this.status = 'loaded'; this.loaded = Promise.resolve(this); Object.assign(this, d) } load() { return Promise.resolve(this) } }
  g.Notification = undefined
  g.__hostRequestPointerLock = requestPointerLock  // for canvases (images/), which are not dom-lite elements
  g.__hostEvalScript = (text, name) => { try { (0, eval)(text) } catch (e) { n.log(3, `script ${name}: ${e?.stack ?? e}`) } }
  g.onerror = null; g.onunhandledrejection = null
}
