// IndexedDB keys as bytes whose memcmp order is the spec's key order (WP-26), so SQLite's BLOB order (host/storage/kv.h)
// sorts records and index entries as IndexedDB does: number < date < string < binary < array.
//   number  0x10 + 8 bytes: the IEEE-754 double big-endian, sign bit flipped (negatives: every bit flipped); -0 is 0
//   date    0x20 + the same for its time value
//   string  0x30 + each UTF-16 code unit c: c+1 (c < 0x7F), 0x80|(c-0x7F)>>8 + low byte (to 0x407E), 0xC0 + 2 bytes;
//           then 0x00. Code units, not code points: the spec compares strings by code unit.
//   binary  0x40 + each byte b: b+1 (b < 0x7F), 0x80 + (b-0x7F); then 0x00
//   array   0x50 + each element's encoding; then 0x00
// Every encoding is self-delimiting, so a key followed by more bytes sorts after it and before the next key: an index
// entry's (key, primary key) and the range bounds below work on plain bytes. Bounds are half-open [lo, hi): a key's
// successor is key + 0x00 (nothing sorts between them), and 0xFF is above every key.
export const EMPTY = new Uint8Array(0)
export const MAX = Uint8Array.of(0xFF)
const T_NUM = 0x10, T_DATE = 0x20, T_STR = 0x30, T_BIN = 0x40, T_ARR = 0x50

const f64 = new Float64Array(1), f64b = new Uint8Array(f64.buffer)
let buf = new Uint8Array(256), len = 0
const room = (n) => { if (len + n > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, len + n)); b.set(buf.subarray(0, len)); buf = b } }
const put = (x) => { room(1); buf[len++] = x }
function putDouble(tag, x) {
  room(9); buf[len++] = tag; f64[0] = x === 0 ? 0 : x
  const neg = f64b[7] & 0x80
  for (let i = 7; i >= 0; i--) buf[len++] = neg ? ~f64b[i] & 0xFF : (i === 7 ? f64b[i] ^ 0x80 : f64b[i])
}
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]'
const isBinary = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v)
function bytesOf(v) {  // null: detached
  if (v instanceof ArrayBuffer) { if (v.detached) return null; return new Uint8Array(v) }
  if (v.buffer?.detached) return null
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

// The spec's "convert a value to a key": false for an invalid value. seen: the arrays on the path (a repeated array is
// invalid even without a cycle, as the spec has it).
function enc(v, seen) {
  if (typeof v === 'number') { if (v !== v) return false; putDouble(T_NUM, v); return true }
  if (typeof v === 'string') {
    room(v.length * 3 + 2); buf[len++] = T_STR
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i)
      if (c < 0x7F) buf[len++] = c + 1
      else if (c <= 0x407E) { const x = c - 0x7F; buf[len++] = 0x80 | (x >> 8); buf[len++] = x & 0xFF }
      else { const x = c - 0x407F; buf[len++] = 0xC0; buf[len++] = x >> 8; buf[len++] = x & 0xFF }
    }
    buf[len++] = 0; return true
  }
  if (typeof v !== 'object' || v === null) return false
  if (isDate(v)) { const t = v.getTime(); if (t !== t) return false; putDouble(T_DATE, t); return true }
  if (isBinary(v)) {
    const b = bytesOf(v); if (!b) return false
    room(b.length * 2 + 2); buf[len++] = T_BIN
    for (let i = 0; i < b.length; i++) { const x = b[i]; if (x < 0x7F) buf[len++] = x + 1; else { buf[len++] = 0x80; buf[len++] = x - 0x7F } }
    buf[len++] = 0; return true
  }
  if (Array.isArray(v)) {
    if (seen.includes(v)) return false
    seen.push(v); put(T_ARR)
    const n = v.length
    for (let i = 0; i < n; i++) { if (!Object.prototype.hasOwnProperty.call(v, i)) return false; if (!enc(v[i], seen)) return false }
    put(0); return true
  }
  return false
}
// A valid key's bytes (a fresh array), or null.
export function toKey(v) {
  len = 0
  if (!enc(v, [])) return null
  return buf.slice(0, len)
}
// multiEntry: the valid, distinct keys of an array's elements (invalid ones are skipped); a non-array is one key.
export function toMultiKeys(v) {
  if (!Array.isArray(v)) { const k = toKey(v); return k ? [k] : [] }
  const out = []
  for (let i = 0; i < v.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(v, i)) continue
    len = 0; if (!enc(v[i], [v])) continue
    const k = buf.slice(0, len)
    if (!out.some(o => cmp(o, k) === 0)) out.push(k)
  }
  return out
}
export function numberKey(n) { len = 0; putDouble(T_NUM, n); return buf.slice(0, len) }
export const isNumberKey = (k) => k.length === 9 && k[0] === T_NUM

function readDouble(b, o) {
  const neg = !(b[o] & 0x80)
  for (let i = 0; i < 8; i++) f64b[7 - i] = neg ? ~b[o + i] & 0xFF : (i === 0 ? b[o] ^ 0x80 : b[o + i])
  return f64[0]
}
// [value, next offset]
function dec(b, o) {
  const tag = b[o++]
  if (tag === T_NUM) return [readDouble(b, o), o + 8]
  if (tag === T_DATE) return [new Date(readDouble(b, o)), o + 8]
  if (tag === T_STR) {
    let s = ''; const units = []
    for (;;) {
      const c = b[o++]; if (c === 0) break
      if (c < 0x80) units.push(c - 1)
      else if (c < 0xC0) { units.push((((c & 0x3F) << 8) | b[o++]) + 0x7F) }
      else { units.push(((b[o] << 8) | b[o + 1]) + 0x407F); o += 2 }
      if (units.length > 4096) { s += String.fromCharCode.apply(null, units); units.length = 0 }
    }
    return [s + String.fromCharCode.apply(null, units), o]
  }
  if (tag === T_BIN) {
    const out = []
    for (;;) { const c = b[o++]; if (c === 0) break; out.push(c < 0x80 ? c - 1 : b[o++] + 0x7F) }
    return [Uint8Array.from(out).buffer, o]
  }
  if (tag === T_ARR) {
    const out = []
    while (b[o] !== 0) { const [v, n] = dec(b, o); out.push(v); o = n }
    return [out, o + 1]
  }
  throw new Error('storage: a corrupt key')
}
export const fromKey = (b) => dec(b, 0)[0]

export function cmp(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}
export function succ(k) { const s = new Uint8Array(k.length + 1); s.set(k); return s }
export const maxOf = (a, b) => cmp(a, b) >= 0 ? a : b
export const minOf = (a, b) => cmp(a, b) <= 0 ? a : b

// Key paths: '' (the value itself), identifiers joined by '.', or a non-empty array of those.
const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u
const validString = (p) => p === '' || p.split('.').every(s => IDENT.test(s))
export function validKeyPath(p) {
  if (typeof p === 'string') return validString(p)
  if (Array.isArray(p)) return p.length > 0 && p.every(x => typeof x === 'string' && validString(x))
  return false
}
// The spec's key path conversion (DOMString or sequence<DOMString>): a copy, so the caller's array is not kept.
export const normKeyPath = (p) => Array.isArray(p) ? p.map(String) : p === null || p === undefined ? null : String(p)

export const FAIL = Symbol('keypath-failure')
// "Evaluate a key path on a value" over a clone (plain data): own properties only, and the few attributes the spec
// reads off strings, arrays, Blobs and Files.
export function evaluate(value, path, g) {
  if (Array.isArray(path)) { const out = []; for (const p of path) { const v = evaluate(value, p, g); if (v === FAIL) return FAIL; out.push(v) } return out }
  if (path === '') return value
  for (const id of path.split('.')) {
    if (typeof value === 'string' && id === 'length') value = value.length
    else if (Array.isArray(value) && id === 'length') value = value.length
    else if (g.Blob && value instanceof g.Blob && (id === 'size' || id === 'type')) value = value[id]
    else if (g.File && value instanceof g.File && (id === 'name' || id === 'lastModified')) value = value[id]
    else if (g.File && value instanceof g.File && id === 'lastModifiedDate') value = new Date(value.lastModified)
    else {
      if (typeof value !== 'object' || value === null) return FAIL
      if (!Object.prototype.hasOwnProperty.call(value, id)) return FAIL
      value = value[id]
      if (value === undefined) return FAIL
    }
  }
  return value
}
// "Check that a key could be injected into a value" and "inject a key into a value" (autoIncrement with a key path).
export function canInject(value, path) {
  const ids = path.split('.'); ids.pop()
  for (const id of ids) {
    if (typeof value !== 'object' || value === null) return false
    if (!Object.prototype.hasOwnProperty.call(value, id)) return true
    value = value[id]
  }
  return typeof value === 'object' && value !== null
}
export function inject(value, path, key) {
  const ids = path.split('.'), last = ids.pop()
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(value, id)) Object.defineProperty(value, id, { value: {}, writable: true, enumerable: true, configurable: true })
    value = value[id]
  }
  Object.defineProperty(value, last, { value: key, writable: true, enumerable: true, configurable: true })
}

// Packed byte strings from __native.storage scans: [u32 length LE, bytes]...; views into the one buffer.
export function unpack(ab) {
  const out = []; if (!ab) return out
  const u = new Uint8Array(ab), dv = new DataView(ab)
  for (let o = 0; o < u.length;) { const n = dv.getUint32(o, true); out.push(u.subarray(o + 4, o + 4 + n)); o += 4 + n }
  return out
}
