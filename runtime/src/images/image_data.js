// ImageData: a Uint8ClampedArray of straight-alpha RGBA8 plus its size. The
// fields are OWN data properties (not accessors) so a structured clone across
// a worker keeps them: the MSDF generator's worker posts one back as the atlas.
import { domError } from './pixels.js'

export function makeImageData(g) {
  function toSize(v, what) {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) throw new TypeError(`ImageData: ${what} is not a valid unsigned long`)
    return Math.floor(n)
  }

  class ImageData {
    constructor(a, b, c, d) {
      let data, w, h, settings
      if (typeof a === 'number' || (typeof a !== 'object' && a !== undefined)) { w = a; h = b; settings = c }
      else { data = a; w = b; h = c; settings = d }
      if (arguments.length < 2) throw new TypeError('ImageData: 2 arguments required')
      w = toSize(w, 'width')
      if (w === 0) throw domError(g, 'IndexSizeError', 'ImageData: width is zero')
      if (data === undefined) {
        h = toSize(h, 'height')
        if (h === 0) throw domError(g, 'IndexSizeError', 'ImageData: height is zero')
        data = new Uint8ClampedArray(w * h * 4)
      } else {
        if (!(data instanceof Uint8ClampedArray)) {
          if (ArrayBuffer.isView(data) && data.BYTES_PER_ELEMENT === 1) data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
          else if (data instanceof ArrayBuffer) data = new Uint8ClampedArray(data)
          else throw new TypeError('ImageData: data must be a Uint8ClampedArray')
        }
        if (data.length === 0 || data.length % 4 !== 0) throw domError(g, 'InvalidStateError', 'ImageData: data length is not a multiple of 4')
        const pixels = data.length / 4
        if (pixels % w !== 0) throw domError(g, 'IndexSizeError', 'ImageData: data length is not a multiple of width * 4')
        const rows = pixels / w
        if (h !== undefined) {
          h = toSize(h, 'height')
          if (h !== rows) throw domError(g, 'IndexSizeError', 'ImageData: data length does not match width * height * 4')
        }
        h = rows
      }
      Object.defineProperty(this, 'data', { value: data, enumerable: true, writable: false, configurable: false })
      Object.defineProperty(this, 'width', { value: w, enumerable: true, writable: false, configurable: false })
      Object.defineProperty(this, 'height', { value: h, enumerable: true, writable: false, configurable: false })
      Object.defineProperty(this, 'colorSpace', { value: (settings && settings.colorSpace) || 'srgb', enumerable: true, writable: false, configurable: false })
    }

    // The pixel-source convention: a Uint8Array over the same bytes.
    get __rgba() {
      let v = this.__rgbaView
      if (!v) {
        v = new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength)
        Object.defineProperty(this, '__rgbaView', { value: v, enumerable: false, writable: true, configurable: true })
      }
      return v
    }

    get [Symbol.toStringTag]() { return 'ImageData' }
  }

  return ImageData
}
