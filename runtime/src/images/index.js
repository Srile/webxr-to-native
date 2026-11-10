// images: ImageBitmap / createImageBitmap, ImageData, Image / HTMLImageElement,
// HTMLCanvasElement / OffscreenCanvas with the Canvas 2D subset, FontFace and
// document.fonts for its text (fonts.js). install(g)
// runs once at boot with g = globalThis (a test passes its own object).
//
// The pixel-source convention shared with the WebGL binding (WP-04): every
// image source texImage2D may receive is an object with numeric `width`,
// `height` and `__rgba` — a Uint8Array of width * height * 4, top-down RGBA8
// (bottom-up when `__rgbaBottomUp`: a secondary WebGL canvas's readback, in a
// buffer its context reuses — read it once, use it at once, never keep it),
// straight alpha unless an ImageBitmap was premultiplied at creation
// (`__premultiplied`). The decoder never flips rows; UNPACK_FLIP_Y_WEBGL does,
// and so does createImageBitmap(…, { imageOrientation: 'flipY' }).
//
// dom-lite's document.createElement('canvas') / ('img') call the factories
// this module defines: g.__hostCreateCanvas() and g.__hostCreateImage().
import { makeCanvas } from './canvas2d.js'
import { makeFonts } from './fonts.js'
import { makeImageBitmap } from './image_bitmap.js'
import { makeImageData } from './image_data.js'
import { makeImageElement } from './image_element.js'

// Fallback EventTarget/Event for a global without dom-lite's (node tests, early boot).
class HostEvent {
  constructor(type, init) {
    this.type = String(type)
    this.target = null; this.currentTarget = null
    this.bubbles = !!(init && init.bubbles); this.cancelable = !!(init && init.cancelable)
    this.defaultPrevented = false
    this.timeStamp = Date.now()
    this.__stop = false
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() {}
  stopImmediatePropagation() { this.__stop = true }
}

class HostEventTarget {
  constructor() { this.__listeners = null }
  addEventListener(type, fn, opts) {
    if (!fn) return
    const capture = typeof opts === 'object' && opts !== null ? !!opts.capture : !!opts
    const once = typeof opts === 'object' && opts !== null && !!opts.once
    if (!this.__listeners) this.__listeners = new Map()
    let list = this.__listeners.get(type)
    if (!list) { list = []; this.__listeners.set(type, list) }
    if (list.some(l => l.fn === fn && l.capture === capture)) return
    list.push({ fn, once, capture })
  }
  removeEventListener(type, fn, opts) {
    const list = this.__listeners && this.__listeners.get(type)
    if (!list) return
    const capture = typeof opts === 'object' && opts !== null ? !!opts.capture : !!opts
    const i = list.findIndex(l => l.fn === fn && l.capture === capture)
    if (i >= 0) list.splice(i, 1)
  }
  dispatchEvent(ev) {
    if (!ev || typeof ev.type !== 'string') throw new TypeError('dispatchEvent: not an Event')
    try { ev.target = this; ev.currentTarget = this } catch {}
    const list = this.__listeners && this.__listeners.get(ev.type)
    if (list && list.length) {
      for (const l of list.slice()) {
        if (l.once) this.removeEventListener(ev.type, l.fn, l.capture)
        if (typeof l.fn === 'function') l.fn.call(this, ev)
        else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(ev)
        if (ev.__stop) break
      }
    }
    try { ev.currentTarget = null } catch {}
    return !ev.defaultPrevented
  }
}

export function install(g) {
  const useGlobalEvents = typeof g.EventTarget === 'function' && typeof g.Event === 'function'
  const EventTargetBase = useGlobalEvents ? g.EventTarget : HostEventTarget
  const makeEvent = (type) => useGlobalEvents ? new g.Event(type) : new HostEvent(type)

  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    const c = g.console || globalThis.console
    if (c && typeof c.warn === 'function') c.warn(message)
  }
  const defer = (fn) => {
    const st = g.setTimeout || globalThis.setTimeout
    if (typeof st === 'function') { st(fn, 0); return }
    const loop = g.__native && g.__native.loop
    if (loop && typeof loop.setTimer === 'function') { loop.setTimer(0, false, fn); return }
    Promise.resolve().then(fn)
  }

  const ImageData = makeImageData(g)
  const { ImageBitmap, createImageBitmap, newBitmap } = makeImageBitmap(g)
  const { HTMLImageElement, Image } = makeImageElement(g, { EventTargetBase, makeEvent })
  const fonts = makeFonts(g, { EventTargetBase })
  const { HTMLCanvasElement, OffscreenCanvas, CanvasRenderingContext2D, Path2D } = makeCanvas(g, { EventTargetBase, ImageData, ImageBitmap, newBitmap, warnOnce, defer, fonts })

  const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })
  define('ImageData', ImageData)
  define('ImageBitmap', ImageBitmap)
  define('createImageBitmap', createImageBitmap)
  if (typeof g.VideoFrame !== 'function') define('VideoFrame', class VideoFrame {})  // WebCodecs; instanceof must not throw
  define('HTMLImageElement', HTMLImageElement)
  define('Image', Image)
  define('HTMLCanvasElement', HTMLCanvasElement)
  define('OffscreenCanvas', OffscreenCanvas)
  define('CanvasRenderingContext2D', CanvasRenderingContext2D)
  define('Path2D', Path2D)
  define('FontFace', fonts.FontFace)
  define('FontFaceSet', fonts.FontFaceSet)
  if (g.document && typeof g.document === 'object') Object.defineProperty(g.document, 'fonts', { value: fonts.fontSet, writable: true, configurable: true, enumerable: true })
  define('OffscreenCanvasRenderingContext2D', CanvasRenderingContext2D)
  define('__hostCreateCanvas', () => new HTMLCanvasElement())
  define('__hostCreateImage', () => new HTMLImageElement())
}
