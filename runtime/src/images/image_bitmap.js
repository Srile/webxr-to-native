// ImageBitmap + createImageBitmap. A bitmap is width, height and `__rgba`
// (top-down RGBA8), with imageOrientation and premultiplyAlpha APPLIED at
// creation, as the browser does, so texImage2D's upload is a straight copy.
import { crop, decodeBytes, domError, flipRows, isBlobLike, premultiply, scaleNearest } from './pixels.js'

const KEY = Symbol('ImageBitmap.create')

const ORIENTATIONS = ['none', 'flipY', 'from-image']
const PREMULTIPLY = ['none', 'premultiply', 'default']
const COLORSPACE = ['none', 'default']
const QUALITY = ['low', 'medium', 'high', 'pixelated']

export function makeImageBitmap(g) {
  class ImageBitmap {
    constructor(key, width, height, rgba, premultiplied) {
      if (key !== KEY) throw new TypeError('Illegal constructor')
      this.width = width
      this.height = height
      this.__rgba = rgba
      this.__premultiplied = !!premultiplied
    }
    close() { this.width = 0; this.height = 0; this.__rgba = null }
    get [Symbol.toStringTag]() { return 'ImageBitmap' }
  }

  // Internal: a bitmap over pixels the caller already owns (no copy).
  function newBitmap(width, height, rgba, premultiplied) { return new ImageBitmap(KEY, width, height, rgba, premultiplied) }

  // { width, height, rgba, premultiplied } for any accepted source, as a promise.
  function pixelsOf(image) {
    if (image === null || image === undefined) return Promise.reject(new TypeError('createImageBitmap: the source is not an image'))
    if (isBlobLike(image)) return Promise.resolve(image.arrayBuffer()).then(buf => decodeBytes(g, new Uint8Array(buf)))
    if (image instanceof ImageBitmap) {
      if (!image.__rgba) return Promise.reject(domError(g, 'InvalidStateError', 'createImageBitmap: the ImageBitmap is closed'))
      return Promise.resolve({ width: image.width, height: image.height, rgba: image.__rgba, premultiplied: image.__premultiplied })
    }
    if (typeof image === 'object') {
      if (image.__imageState === 'error') return Promise.reject(domError(g, 'InvalidStateError', 'createImageBitmap: the image is broken'))
      if (image.__imageState === 'loading' || image.__imageState === 'empty') return Promise.reject(domError(g, 'InvalidStateError', 'createImageBitmap: the image is not loaded'))
      const px = image.__rgba  // read once: on a secondary WebGL canvas this is a readback
      if (px instanceof Uint8Array && typeof image.width === 'number' && typeof image.height === 'number') {
        if (!(image.width > 0) || !(image.height > 0)) return Promise.reject(domError(g, 'InvalidStateError', 'createImageBitmap: the source has no pixels'))
        // A WebGL canvas's readback is bottom-up in a buffer its context reuses: take a top-down copy now.
        const rgba = image.__rgbaBottomUp ? flipRows(px.slice(0, image.width * image.height * 4), image.width, image.height) : px
        return Promise.resolve({ width: image.width, height: image.height, rgba, premultiplied: !!image.__premultiplied })
      }
      if (px === null && ('__gl' in image || 'naturalWidth' in image)) return Promise.reject(domError(g, 'InvalidStateError', 'createImageBitmap: the source has no readable pixels'))
      if (ArrayBuffer.isView(image.data) && typeof image.width === 'number' && typeof image.height === 'number') {  // ImageData, or its clone
        const d = image.data
        return Promise.resolve({ width: image.width, height: image.height, rgba: new Uint8Array(d.buffer, d.byteOffset, d.byteLength), premultiplied: false })
      }
    }
    return Promise.reject(new TypeError('createImageBitmap: unsupported source type'))
  }

  function option(options, name, allowed) {
    const v = options[name]
    if (v === undefined) return allowed[0]
    const s = String(v)
    if (!allowed.includes(s)) throw new TypeError(`createImageBitmap: '${s}' is not a valid value for ${name}`)
    return s
  }

  function createImageBitmap(image, a, b, c, d, e) {
    let sx, sy, sw, sh, options
    if (arguments.length >= 5) { sx = a; sy = b; sw = c; sh = d; options = e } else options = a
    if (options === undefined || options === null) options = {}
    else if (typeof options !== 'object') return Promise.reject(new TypeError('createImageBitmap: options must be a dictionary'))
    let orientation, premul, quality, resizeW, resizeH
    try {
      orientation = option(options, 'imageOrientation', ORIENTATIONS)
      premul = option(options, 'premultiplyAlpha', PREMULTIPLY)
      option(options, 'colorSpaceConversion', COLORSPACE)
      quality = option(options, 'resizeQuality', QUALITY)
      if (options.resizeWidth !== undefined) { resizeW = Math.floor(Number(options.resizeWidth)); if (!(resizeW > 0)) throw domError(g, 'InvalidStateError', 'createImageBitmap: resizeWidth must be positive') }
      if (options.resizeHeight !== undefined) { resizeH = Math.floor(Number(options.resizeHeight)); if (!(resizeH > 0)) throw domError(g, 'InvalidStateError', 'createImageBitmap: resizeHeight must be positive') }
    } catch (err) { return Promise.reject(err) }
    if (sw !== undefined) {
      sx = Math.floor(Number(sx)); sy = Math.floor(Number(sy)); sw = Math.floor(Number(sw)); sh = Math.floor(Number(sh))
      if (![sx, sy, sw, sh].every(Number.isFinite)) return Promise.reject(new TypeError('createImageBitmap: crop rectangle is not finite'))
      if (sw === 0 || sh === 0) return Promise.reject(new RangeError('createImageBitmap: the crop rectangle is empty'))
      if (sw < 0) { sx += sw; sw = -sw }
      if (sh < 0) { sy += sh; sh = -sh }
    }
    return pixelsOf(image).then(src => {
      let { width, height, rgba } = src
      if (sw !== undefined) { rgba = crop(rgba, width, height, sx, sy, sw, sh); width = sw; height = sh }
      else rgba = rgba.slice()  // a bitmap never aliases its source
      if (resizeW !== undefined || resizeH !== undefined) {
        const nw = resizeW !== undefined ? resizeW : Math.max(1, Math.round(resizeH * width / height))
        const nh = resizeH !== undefined ? resizeH : Math.max(1, Math.round(resizeW * height / width))
        if (nw !== width || nh !== height) {
          const native = g.__native && g.__native.img
          if (quality !== 'pixelated' && native && typeof native.resize === 'function') {
            const out = native.resize(rgba, width, height, nw, nh)
            rgba = out instanceof Uint8Array ? out : new Uint8Array(out)
          } else rgba = scaleNearest(rgba, width, height, nw, nh)
          width = nw; height = nh
        }
      }
      if (orientation === 'flipY') flipRows(rgba, width, height)
      let premultiplied = src.premultiplied
      if (premul === 'premultiply' && !premultiplied) { premultiply(rgba); premultiplied = true }
      return new ImageBitmap(KEY, width, height, rgba, premultiplied)
    })
  }

  return { ImageBitmap, createImageBitmap, newBitmap }
}
