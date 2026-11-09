// URL + URLSearchParams: a WHATWG-shaped parser sufficient for http(s), blob:, data: and relative resolution.
const SPECIAL = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21, 'file:': null }
function normalizePath(path) {
  const segs = []; const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const s = parts[i]
    if (s === '..') { if (segs.length) segs.pop(); if (i === parts.length - 1) segs.push('') }
    else if (s === '.') { if (i === parts.length - 1) segs.push('') }
    else segs.push(s)
  }
  return '/' + segs.join('/')
}
export class URLSearchParams {
  constructor(init = '') {
    this._list = []; this._url = null
    if (typeof init === 'string') { if (init[0] === '?') init = init.slice(1); for (const kv of init.split('&')) { if (!kv) continue; const i = kv.indexOf('='); const k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : kv.slice(i + 1); this._list.push([dec(k), dec(v)]) } }
    else if (init instanceof URLSearchParams) this._list = init._list.map(p => [...p])
    else if (Array.isArray(init) || init?.[Symbol.iterator]) for (const [k, v] of init) this._list.push([String(k), String(v)])
    else if (init && typeof init === 'object') for (const k of Object.keys(init)) this._list.push([k, String(init[k])])
  }
  _update() { if (this._url) this._url._search = this._list.length ? '?' + this.toString() : '' }
  get size() { return this._list.length }
  append(k, v) { this._list.push([String(k), String(v)]); this._update() }
  delete(k, v) { this._list = this._list.filter(p => !(p[0] === String(k) && (v === undefined || p[1] === String(v)))); this._update() }
  get(k) { const p = this._list.find(p => p[0] === String(k)); return p ? p[1] : null }
  getAll(k) { return this._list.filter(p => p[0] === String(k)).map(p => p[1]) }
  has(k, v) { return this._list.some(p => p[0] === String(k) && (v === undefined || p[1] === String(v))) }
  set(k, v) { k = String(k); v = String(v); const i = this._list.findIndex(p => p[0] === k); if (i < 0) this._list.push([k, v]); else { this._list[i][1] = v; this._list = this._list.filter((p, j) => j <= i || p[0] !== k) } this._update() }
  sort() { this._list.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this._update() }
  forEach(cb, thisArg) { for (const [k, v] of this._list) cb.call(thisArg, v, k, this) }
  keys() { return this._list.map(p => p[0])[Symbol.iterator]() } values() { return this._list.map(p => p[1])[Symbol.iterator]() } entries() { return this._list.map(p => [...p])[Symbol.iterator]() }
  [Symbol.iterator]() { return this.entries() }
  toString() { return this._list.map(([k, v]) => enc(k) + '=' + enc(v)).join('&') }
}
function enc(s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) }
function dec(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s } }

export class URL {
  constructor(url, base) {
    url = String(url).trim()
    let m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(url)
    if (!m) {
      if (base === undefined) throw new TypeError(`Invalid URL: ${url}`)
      const b = base instanceof URL ? base : new URL(String(base))
      this._protocol = b._protocol; this._username = b._username; this._password = b._password; this._host = b._host; this._port = b._port
      if (url === '') { this._pathname = b._pathname; this._search = b._search; this._hash = '' ; return }
      if (url.startsWith('//')) { const u = new URL(this._protocol + url); Object.assign(this, u); return }
      let rest = url, hash = '', search = ''
      const hi = rest.indexOf('#'); if (hi >= 0) { hash = rest.slice(hi); rest = rest.slice(0, hi) }
      const qi = rest.indexOf('?'); if (qi >= 0) { search = rest.slice(qi); rest = rest.slice(0, qi) }
      if (rest === '') { this._pathname = b._pathname; this._search = search || (qi < 0 ? b._search : ''); this._hash = hash; if (qi < 0 && hi >= 0) this._search = b._search; return }
      let path = rest[0] === '/' ? rest : b._pathname.slice(0, b._pathname.lastIndexOf('/') + 1) + rest
      this._pathname = this._protocol in SPECIAL ? normalizePath(path) : path; this._search = search; this._hash = hash
      return
    }
    this._protocol = m[1].toLowerCase() + ':'; let rest = m[2]
    this._username = ''; this._password = ''; this._host = ''; this._port = ''; this._pathname = ''; this._search = ''; this._hash = ''
    const hi = rest.indexOf('#'); if (hi >= 0) { this._hash = rest.slice(hi); rest = rest.slice(0, hi) }
    const qi = rest.indexOf('?'); if (qi >= 0) { this._search = rest.slice(qi); rest = rest.slice(0, qi) }
    if (this._protocol in SPECIAL || rest.startsWith('//')) {
      rest = rest.replace(/^\/*/, ''); const slash = rest.indexOf('/'); let auth = slash < 0 ? rest : rest.slice(0, slash); const path = slash < 0 ? '/' : rest.slice(slash)
      const at = auth.lastIndexOf('@'); if (at >= 0) { const cred = auth.slice(0, at); auth = auth.slice(at + 1); const ci = cred.indexOf(':'); this._username = ci < 0 ? cred : cred.slice(0, ci); this._password = ci < 0 ? '' : cred.slice(ci + 1) }
      const pm = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(auth); if (!pm) throw new TypeError(`Invalid URL: ${url}`)
      this._host = pm[1].toLowerCase(); this._port = pm[2] ?? ''; if (this._port !== '' && +this._port === SPECIAL[this._protocol]) this._port = ''
      if (this._protocol in SPECIAL && !this._host && this._protocol !== 'file:') throw new TypeError(`Invalid URL: ${url}`)
      this._pathname = this._protocol in SPECIAL ? normalizePath(path) : path
    } else this._pathname = rest
    if (this._hash === '#') this._hash = ''; if (this._search === '?') this._search = ''
  }
  get protocol() { return this._protocol } set protocol(v) { v = String(v).replace(/:$/, '') + ':'; if (/^[a-z][a-z0-9+.-]*:$/i.test(v)) this._protocol = v.toLowerCase() }
  get username() { return this._username } set username(v) { this._username = String(v) }
  get password() { return this._password } set password(v) { this._password = String(v) }
  get hostname() { return this._host } set hostname(v) { this._host = String(v).toLowerCase() }
  get port() { return this._port } set port(v) { v = String(v); this._port = v === '' || +v === SPECIAL[this._protocol] ? '' : String(parseInt(v, 10) || '') }
  get host() { return this._host + (this._port ? ':' + this._port : '') } set host(v) { const i = String(v).lastIndexOf(':'); if (i > 0 && /^\d*$/.test(v.slice(i + 1))) { this.hostname = v.slice(0, i); this.port = v.slice(i + 1) } else this.hostname = v }
  get origin() { return this._protocol in SPECIAL && this._protocol !== 'file:' ? this._protocol + '//' + this.host : this._protocol === 'blob:' ? (() => { try { return new URL(this._pathname).origin } catch { return 'null' } })() : 'null' }
  get pathname() { return this._pathname } set pathname(v) { v = String(v); if (this._protocol in SPECIAL) v = normalizePath(v[0] === '/' ? v : '/' + v); this._pathname = v }
  get search() { return this._search } set search(v) { v = String(v); this._search = v === '' || v === '?' ? '' : (v[0] === '?' ? v : '?' + v); if (this._sp) this._sp._list = new URLSearchParams(this._search)._list }
  get hash() { return this._hash } set hash(v) { v = String(v); this._hash = v === '' || v === '#' ? '' : (v[0] === '#' ? v : '#' + v) }
  get searchParams() { if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._url = this } return this._sp }
  get href() { const auth = this._username ? this._username + (this._password ? ':' + this._password : '') + '@' : ''; const slashes = this._protocol in SPECIAL || this._host ? '//' : ''; return this._protocol + slashes + auth + this.host + this._pathname + this._search + this._hash }
  set href(v) { Object.assign(this, new URL(v)) }
  toString() { return this.href } toJSON() { return this.href }
  static canParse(u, b) { try { new URL(u, b); return true } catch { return false } }
  static parse(u, b) { try { return new URL(u, b) } catch { return null } }
  static createObjectURL(obj) { return objectURLHooks.create(obj) }
  static revokeObjectURL(u) { objectURLHooks.revoke(u) }
}
const objectURLHooks = { create: () => { throw new TypeError('createObjectURL unavailable') }, revoke: () => {} }
export function setObjectURLHooks(create, revoke) { objectURLHooks.create = create; objectURLHooks.revoke = revoke }
