// EventTarget / Event family. Minimal, spec-shaped, allocation-light.
export class Event {
  constructor(type, init = {}) {
    this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed
    this.defaultPrevented = false; this.target = null; this.currentTarget = null; this.timeStamp = globalThis.performance?.now?.() ?? 0
    this.isTrusted = false; this.eventPhase = 0; this._stop = false; this._stopNow = false
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this._stop = true }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true }
  composedPath() { return this._path ? this._path.map(t => t._window ?? t) : this.target ? [this.target] : [] }
  static get NONE() { return 0 } static get CAPTURING_PHASE() { return 1 } static get AT_TARGET() { return 2 } static get BUBBLING_PHASE() { return 3 }
}
export class CustomEvent extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? null } }
export class ErrorEvent extends Event { constructor(type, init = {}) { super(type, init); this.message = init.message ?? ''; this.filename = init.filename ?? ''; this.lineno = init.lineno ?? 0; this.colno = init.colno ?? 0; this.error = init.error ?? null } }
export class PromiseRejectionEvent extends Event { constructor(type, init = {}) { super(type, init); this.promise = init.promise; this.reason = init.reason } }
export class ProgressEvent extends Event { constructor(type, init = {}) { super(type, init); this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0 } }
export class MessageEvent extends Event { constructor(type, init = {}) { super(type, init); this.data = init.data ?? null; this.origin = init.origin ?? ''; this.lastEventId = init.lastEventId ?? ''; this.source = init.source ?? null; this.ports = init.ports ?? [] } }
export class UIEvent extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? 0; this.view = init.view ?? null } }
export class FocusEvent extends UIEvent { constructor(type, init = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null } }
export class KeyboardEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.key = init.key ?? ''; this.code = init.code ?? ''; this.location = init.location ?? 0; this.repeat = !!init.repeat; this.isComposing = false
    this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey; this.keyCode = init.keyCode ?? 0; this.which = init.which ?? this.keyCode; this.charCode = 0 }
  getModifierState(k) { return k === 'Control' ? this.ctrlKey : k === 'Shift' ? this.shiftKey : k === 'Alt' ? this.altKey : k === 'Meta' ? this.metaKey : false }
}
export class MouseEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.screenX = init.screenX ?? 0; this.screenY = init.screenY ?? 0; this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.pageX = this.clientX; this.pageY = this.clientY; this.offsetX = this.clientX; this.offsetY = this.clientY; this.x = this.clientX; this.y = this.clientY
    this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey; this.button = init.button ?? 0; this.buttons = init.buttons ?? 0; this.relatedTarget = init.relatedTarget ?? null; this.movementX = init.movementX ?? 0; this.movementY = init.movementY ?? 0 }
  getModifierState() { return false }
}
export class WheelEvent extends MouseEvent { constructor(type, init = {}) { super(type, init); this.deltaX = init.deltaX ?? 0; this.deltaY = init.deltaY ?? 0; this.deltaZ = init.deltaZ ?? 0; this.deltaMode = init.deltaMode ?? 0 } }
export class PointerEvent extends MouseEvent {
  constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.width = init.width ?? 1; this.height = init.height ?? 1; this.pressure = init.pressure ?? 0; this.tangentialPressure = 0; this.tiltX = 0; this.tiltY = 0; this.twist = 0; this.pointerType = init.pointerType ?? 'mouse'; this.isPrimary = init.isPrimary ?? true }
  getCoalescedEvents() { return [this] } getPredictedEvents() { return [] }
}

// Touches (WP-20): one finger, and the lists a TouchEvent carries (arrays with item()).
export class Touch {
  constructor(init = {}) { this.identifier = init.identifier ?? 0; this.target = init.target ?? null; this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.pageX = this.clientX; this.pageY = this.clientY
    this.screenX = init.screenX ?? this.clientX; this.screenY = init.screenY ?? this.clientY; this.radiusX = init.radiusX ?? 12; this.radiusY = init.radiusY ?? 12; this.rotationAngle = 0; this.force = init.force ?? 0.5 }
}
export function touchList(arr) { const l = arr.slice(); l.item = (i) => l[i] ?? null; return l }
export class TouchEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.touches = init.touches ?? touchList([]); this.targetTouches = init.targetTouches ?? touchList([]); this.changedTouches = init.changedTouches ?? touchList([])
    this.ctrlKey = !!init.ctrlKey; this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey }
}

// A class whose on<event> attributes are prototype accessors (the WebRTC classes) keeps the handlers here, and
// dispatch calls them from here, not through the property: a shim that redefines the property on the prototype
// (webrtc-adapter turns onicecandidate into addEventListener) is then not called twice, as in a browser.
export const HANDLERS = Symbol.for('webxr-host.handlers')

export class EventTarget {
  constructor() { Object.defineProperty(this, '_listeners', { value: new Map(), enumerable: false, writable: true }) }
  addEventListener(type, cb, opts) {
    if (!cb) return
    const once = typeof opts === 'object' && !!opts?.once, capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    if (!this._listeners) Object.defineProperty(this, '_listeners', { value: new Map(), enumerable: false, writable: true })
    let list = this._listeners.get(type); if (!list) this._listeners.set(type, list = [])
    if (list.some(l => l.cb === cb && l.capture === capture)) return
    list.push({ cb, once, capture })
    if (opts?.signal) opts.signal.addEventListener?.('abort', () => this.removeEventListener(type, cb, opts), { once: true })
  }
  removeEventListener(type, cb, opts) {
    const list = this._listeners?.get(type); if (!list) return
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    const i = list.findIndex(l => l.cb === cb && l.capture === capture); if (i >= 0) list.splice(i, 1)
  }
  // Node-shaped targets (a parentNode chain) get the DOM's path: capture from the top (the window above a connected
  // document) down to the target, the target, then bubbling back up when the event bubbles.
  dispatchEvent(ev) {
    if (!ev || typeof ev.type !== 'string') throw new TypeError('dispatchEvent: not an Event')
    ev.target = ev.target ?? this
    if (this.parentNode === undefined && this.nodeType !== 9) { invoke(this, ev, 2); ev.currentTarget = null; ev.eventPhase = 0; return !ev.defaultPrevented }
    const path = [this]; for (let p = this.parentNode; p; p = p.parentNode) path.push(p)
    const top = path[path.length - 1]
    if (top.nodeType === 9 && top._windowTarget) path.push(top._windowTarget)  // the window's listeners (dom-lite install)
    ev._path = path
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) invoke(path[i], ev, 1)
    if (!ev._stop) invoke(this, ev, 2)
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) invoke(path[i], ev, 3)
    ev.currentTarget = null; ev.eventPhase = 0
    return !ev.defaultPrevented
  }
}
// One target's listeners for a phase: capture listeners in 1, all in 2 (at the target), the others in 3.
function invoke(t, ev, phase) {
  const self = t._window ?? t
  ev.currentTarget = self; ev.eventPhase = phase
  const list = t._listeners?.get(ev.type)
  if (list && list.length) for (const l of [...list]) {  // a snapshot: a listener added during dispatch waits for the next event
    if (ev._stopNow) break
    if (phase === 1 && !l.capture) continue
    if (phase === 3 && l.capture) continue
    if (l.once) t.removeEventListener(ev.type, l.cb, l.capture)
    try { typeof l.cb === 'function' ? l.cb.call(self, ev) : l.cb.handleEvent?.(ev) } catch (e) { reportError(e) }
  }
  if (phase !== 1 && !ev._stopNow) { const slots = t[HANDLERS], handler = slots ? slots[ev.type] : self['on' + ev.type]; if (typeof handler === 'function') { try { handler.call(self, ev) } catch (e) { reportError(e) } } }
}
export function reportError(e) {
  const g = globalThis
  try { if (g.window && g.window !== g) { } ; const ev = new ErrorEvent('error', { message: String(e?.message ?? e), error: e }); if (g.__hostWindowTarget) g.__hostWindowTarget.dispatchEvent(ev) } catch {}
  g.__native?.log?.(3, `Uncaught (in handler) ${e?.stack ?? e}`)
}
