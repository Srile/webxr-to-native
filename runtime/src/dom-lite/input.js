// Page input outside an XR session (WP-20): the window's pointers, wheel and keys, the host's touch controls as a
// gamepad, and the page's visibility. Native fills a queue of fixed-size records (no strings, no objects) and the
// runtime drains it at the start of each flat frame into the browser's event sequence:
//   pointerover/enter/down/move/up/cancel/out/leave (+ capture), the compatibility mouse* and click, contextmenu,
//   wheel, keydown/keyup.
// Pointer events target the page's main canvas (there is no layout to hit-test against), else the body, except a
// touch that starts inside one of host.json's touchControls.zones while that zone's element is shown: it goes to that
// element, as the page's own touch UI gets it in a browser (a game's joystick zone). Keys target the focused
// element, the body by default. No touch events: a page that sees touch builds HTML touch controls this
// host cannot show, so touch arrives as pointerType 'touch' and the host's own controls stand in for a gamepad.
//
// __native.input (absent: no input, as on the Quest):
//   read(Float64Array) -> count   records of STRIDE numbers each, oldest first, copied into the given buffer
//   pad(Float32Array)  -> bool    the touch controls' gamepad: [connected, timestamp, axes x4, buttons x17]
//   codes                         the DOM `code` names, indexed by a key record's code field
import * as ev from './events.js'

export const STRIDE = 12  // type, id, x, y, buttons, button, pointerType, pressure, mods, code, dx, dy
const DOWN = 1, MOVE = 2, UP = 3, CANCEL = 4, WHEEL = 5, KEYDOWN = 6, KEYUP = 7, LEAVE = 8
const TYPES = ['mouse', 'touch', 'pen']
const SHIFT = 1, CTRL = 2, ALT = 4, META = 8, REPEAT = 16

// `key` from `code` on a US layout; named keys are their own key.
const SHIFTED = { Digit1: '!', Digit2: '@', Digit3: '#', Digit4: '$', Digit5: '%', Digit6: '^', Digit7: '&', Digit8: '*', Digit9: '(', Digit0: ')', Minus: '_', Equal: '+', BracketLeft: '{', BracketRight: '}', Backslash: '|', Semicolon: ':', Quote: '"', Backquote: '~', Comma: '<', Period: '>', Slash: '?' }
const PLAIN = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', Space: ' ' }
const NAMED = { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta' }
const KEYCODE = { Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222 }
export function keyOf(code, shift) {
  if (/^Key[A-Z]$/.test(code)) return shift ? code[3] : code[3].toLowerCase()
  if (/^Digit\d$/.test(code)) return shift ? SHIFTED[code] : code[5]
  if (shift && SHIFTED[code]) return SHIFTED[code]
  return PLAIN[code] ?? NAMED[code] ?? code
}
function keyCodeOf(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit\d$/.test(code)) return code.charCodeAt(5)
  if (/^F\d+$/.test(code)) return 111 + +code.slice(1)
  return KEYCODE[code] ?? 0
}

class GamepadButton { constructor() { this.pressed = false; this.touched = false; this.value = 0 } }
class Gamepad {
  constructor() {
    this.id = 'webxr-host touch controls (STANDARD GAMEPAD)'; this.index = 0; this.connected = false; this.timestamp = 0; this.mapping = 'standard'
    this.axes = [0, 0, 0, 0]; this.buttons = Array.from({ length: 17 }, () => new GamepadButton()); this.vibrationActuator = null; this.hapticActuators = []
  }
}

// Shown: connected, and nothing from it up to the document hidden by display none, visibility hidden or `hidden`.
function visible(e) { if (!e || !e.isConnected) return false; for (let p = e; p && p.style; p = p.parentNode) { const st = p.style; if (st.display === 'none' || st.visibility === 'hidden' || p.hidden === true) return false } return true }

export function installInput(g, n) {
  const input = n.input
  // touchControls.zones: [{ selector, rect: [x0, y0, x1, y1] as fractions of the viewport, stick? }]. The element's box
  // is that rect (there is no layout): getBoundingClientRect answers it, so the page's own geometry checks work.
  const zones = (n.config?.touchControls?.zones ?? []).map(z => ({ ...z, el: null }))
  const zoneAt = (x, y) => {
    for (const z of zones) {
      if (!z.el || !z.el.isConnected) z.el = g.document.querySelector(z.selector)
      if (!visible(z.el)) continue
      const [x0, y0, x1, y1] = z.rect ?? [0, 0, 1, 1], W = g.innerWidth, H = g.innerHeight
      z.el._hostRect = [x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H]
      if (x >= x0 * W && x < x1 * W && y >= y0 * H && y < y1 * H) return z
    }
    return null
  }
  const buf = new Float64Array(STRIDE * 256)
  const codes = input?.codes ?? []
  const pointers = new Map()   // id -> { type, down, x, y, primary, downTarget, captured, moved }
  let primaryTouch = -1
  const target = () => g.__hostGL?.()?.canvas ?? g.document.body
  const mods = (m) => ({ shiftKey: !!(m & SHIFT), ctrlKey: !!(m & CTRL), altKey: !!(m & ALT), metaKey: !!(m & META) })

  const fire = (el, E, type, init) => { const e = new E(type, init); e.isTrusted = true; return el.dispatchEvent(e) }
  const pointerInit = (p, id, x, y, buttons, button, pressure, m, bubbles = true) => ({
    bubbles, cancelable: bubbles, composed: true, view: g, pointerId: id, pointerType: TYPES[p.type] ?? 'mouse', isPrimary: p.primary,
    clientX: x, clientY: y, screenX: x, screenY: y, offsetX: x, offsetY: y, movementX: x - p.x, movementY: y - p.y,
    buttons, button, pressure, width: p.type === 1 ? 24 : 1, height: p.type === 1 ? 24 : 1, ...mods(m),
  })
  const mouseInit = (x, y, buttons, button, m) => ({ bubbles: true, cancelable: true, composed: true, view: g, clientX: x, clientY: y, screenX: x, screenY: y, offsetX: x, offsetY: y, buttons, button, detail: 1, ...mods(m) })

  function pointer(type, id, x, y, buttons, button, ptype, pressure, m) {
    let p = pointers.get(id)
    if (!p) {
      if (type === UP || type === CANCEL || type === LEAVE) return
      p = { type: ptype, down: false, x, y, primary: ptype === 0 || primaryTouch < 0, downTarget: null, captured: null, moved: 0, over: null, zone: null }
      if (ptype !== 0 && primaryTouch < 0) primaryTouch = id
      if (ptype !== 0 && type === DOWN) { const z = zoneAt(x, y); if (z) { p.zone = z.el; if (z.stick) input?.stickFinger?.(id, x, y) } }
      pointers.set(id, p)
    }
    const el = p.captured ?? p.zone ?? target(), isMouse = ptype === 0
    if (p.over !== el) {
      if (p.over) { fire(p.over, ev.PointerEvent, 'pointerout', pointerInit(p, id, x, y, buttons, -1, pressure, m)); fire(p.over, ev.PointerEvent, 'pointerleave', pointerInit(p, id, x, y, buttons, -1, pressure, m, false)) }
      fire(el, ev.PointerEvent, 'pointerover', pointerInit(p, id, x, y, buttons, -1, pressure, m)); fire(el, ev.PointerEvent, 'pointerenter', pointerInit(p, id, x, y, buttons, -1, pressure, m, false))
      if (isMouse) { fire(el, ev.MouseEvent, 'mouseover', mouseInit(x, y, buttons, 0, m)); fire(el, ev.MouseEvent, 'mouseenter', { ...mouseInit(x, y, buttons, 0, m), bubbles: false }) }
      p.over = el
    }
    if (type === DOWN) {
      p.down = true; p.downTarget = el; p.moved = 0; p.suppress = false
      if (!fire(el, ev.PointerEvent, 'pointerdown', pointerInit(p, id, x, y, buttons, button, pressure, m))) p.suppress = true  // a cancelled pointerdown suppresses the mouse events
      if (isMouse && !p.suppress) { fire(el, ev.MouseEvent, 'mousedown', mouseInit(x, y, buttons, button, m)); if (button === 2) fire(el, ev.MouseEvent, 'contextmenu', mouseInit(x, y, buttons, button, m)) }
    } else if (type === MOVE) {
      if (x === p.x && y === p.y) return
      p.moved += Math.abs(x - p.x) + Math.abs(y - p.y)
      fire(el, ev.PointerEvent, 'pointermove', pointerInit(p, id, x, y, buttons, -1, pressure, m))
      if (isMouse) fire(el, ev.MouseEvent, 'mousemove', { ...mouseInit(x, y, buttons, 0, m), movementX: x - p.x, movementY: y - p.y })
    } else if (type === UP || type === CANCEL) {
      if (type === CANCEL) fire(el, ev.PointerEvent, 'pointercancel', pointerInit(p, id, x, y, 0, -1, 0, m))
      else {
        fire(el, ev.PointerEvent, 'pointerup', pointerInit(p, id, x, y, buttons, button, 0, m))
        // A tap (a touch that barely moved, or any mouse release over where it went down) clicks; a touch also gets
        // the compatibility mouse events a browser sends after one.
        if (!p.suppress && p.downTarget === el) {
          if (isMouse) { fire(el, ev.MouseEvent, 'mouseup', mouseInit(x, y, buttons, button, m)); fire(el, button === 0 ? ev.PointerEvent : ev.MouseEvent, button === 0 ? 'click' : 'auxclick', { ...pointerInit(p, id, x, y, buttons, button, 0, m), detail: 1 }) }
          else if (p.moved < 12) { fire(el, ev.MouseEvent, 'mousedown', mouseInit(x, y, 1, 0, m)); fire(el, ev.MouseEvent, 'mouseup', mouseInit(x, y, 0, 0, m)); fire(el, ev.PointerEvent, 'click', { ...pointerInit(p, id, x, y, 0, 0, 0, m), detail: 1 }) }
        } else if (isMouse) fire(el, ev.MouseEvent, 'mouseup', mouseInit(x, y, buttons, button, m))
      }
      if (p.captured) { const c = p.captured; p.captured = null; fire(c, ev.PointerEvent, 'lostpointercapture', pointerInit(p, id, x, y, 0, -1, 0, m)) }
      p.down = false
      if (!isMouse) {  // a finger leaves when it lifts; the mouse stays over the canvas
        fire(el, ev.PointerEvent, 'pointerout', pointerInit(p, id, x, y, 0, -1, 0, m)); fire(el, ev.PointerEvent, 'pointerleave', pointerInit(p, id, x, y, 0, -1, 0, m, false))
        pointers.delete(id); if (primaryTouch === id) primaryTouch = -1
        return
      }
    } else if (type === LEAVE) {
      fire(el, ev.PointerEvent, 'pointerout', pointerInit(p, id, x, y, buttons, -1, 0, m)); fire(el, ev.PointerEvent, 'pointerleave', pointerInit(p, id, x, y, buttons, -1, 0, m, false))
      if (isMouse) { fire(el, ev.MouseEvent, 'mouseout', mouseInit(x, y, buttons, 0, m)); fire(el, ev.MouseEvent, 'mouseleave', { ...mouseInit(x, y, buttons, 0, m), bubbles: false }) }
      pointers.delete(id); return
    }
    p.x = x; p.y = y
  }

  function key(type, code, m) {
    const name = codes[code] ?? 'Unidentified', k = keyOf(name, !!(m & SHIFT)), kc = keyCodeOf(name)
    const el = g.document.activeElement ?? g.document.body
    if (type === KEYDOWN && name === 'Escape' && g.document.pointerLockElement) g.document.exitPointerLock()  // as a browser: Esc releases the lock
    fire(el, ev.KeyboardEvent, type === KEYDOWN ? 'keydown' : 'keyup', { bubbles: true, cancelable: true, composed: true, view: g, key: k, code: name, repeat: !!(m & REPEAT), keyCode: kc, which: kc, location: /Right$/.test(name) ? 2 : /Left$/.test(name) && NAMED[name] ? 1 : 0, ...mods(m) })
  }

  // host.json web.startGesture: a native app has no autoplay rule, but a page written for one waits for a first tap
  // to start its sound (title music started by a pointerdown listener on the canvas). Until the player first
  // touches the screen, each time the page starts listening for taps on its canvas it gets one, at the top-left
  // corner (a tap on empty background), so its sound starts with the screen, as a native game's does.
  const startGesture = !!n.config?.web?.startGesture
  let realInput = false, seenListeners = 0
  const gesture = () => {
    const c = target(), l = c?._listeners?.get?.('pointerdown')?.length ?? 0
    if (l > seenListeners && !realInput) { pointer(DOWN, 999, 1, 1, 1, 0, g.__hostTouchDevice ? 1 : 0, 0.5, 0); pointer(UP, 999, 1, 1, 0, 0, g.__hostTouchDevice ? 1 : 0, 0, 0) }
    seenListeners = l
  }

  // Drained before the page's rAF callbacks, so a frame sees the input that came in since the last one.
  g.__hostDrainInput = () => {
    if (startGesture && !realInput) gesture()
    if (!input) return
    const count = input.read(buf)
    if (count) realInput = true
    for (let i = 0; i < count; i++) {
      const o = i * STRIDE, type = buf[o], id = buf[o + 1], x = buf[o + 2], y = buf[o + 3], m = buf[o + 8]
      if (type === WHEEL) fire(target(), ev.WheelEvent, 'wheel', { ...mouseInit(x, y, buf[o + 4], 0, m), deltaX: buf[o + 10], deltaY: buf[o + 11], deltaMode: 0 })
      else if (type === KEYDOWN || type === KEYUP) key(type, buf[o + 9], m)
      else pointer(type, id, x, y, buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7], m)
    }
  }

  // Pointer capture: every pointer already goes to the canvas, so capture only has to be answered and released.
  g.__hostPointerCapture = (el, id, on) => { const p = pointers.get(id); if (!p) return false; if (on === undefined) return p.captured === el; if (on) { p.captured = el; fire(el, ev.PointerEvent, 'gotpointercapture', { bubbles: true, pointerId: id, pointerType: TYPES[p.type] }) } else if (p.captured === el) p.captured = null; return true }

  // The touch controls' gamepad: one object, updated in place on every getGamepads() (Chrome's four slots).
  const pad = new Gamepad(), padState = new Float32Array(23), slots = [null, null, null, null]
  let announced = false
  g.navigator.getGamepads = () => {
    if (!input?.pad || !input.pad(padState) || padState[0] < 0.5) { slots[0] = null; return slots }
    pad.connected = true; pad.timestamp = padState[1]
    for (let i = 0; i < 4; i++) pad.axes[i] = padState[2 + i]
    for (let i = 0; i < 17; i++) { const b = pad.buttons[i], v = padState[6 + i]; b.value = v; b.pressed = v > 0.5; b.touched = v > 0 }
    slots[0] = pad
    if (!announced) { announced = true; g.setTimeout(() => g.dispatchEvent(Object.assign(new ev.Event('gamepadconnected'), { gamepad: pad })), 0) }
    return slots
  }
  g.Gamepad = Gamepad; g.GamepadButton = GamepadButton
  // A page that only listens for gamepadconnected learns of the pad once its controls exist.
  if (input?.pad && input.pad(padState) && padState[0] >= 0.5) g.navigator.getGamepads()

  // The touch controls follow the page's own touch UI (host.json touchControls.showWhen: a selector): shown while
  // that element is connected and nothing above it is display none or visibility hidden. Checked once a frame and
  // told to native only when it changes.
  const showWhen = n.config?.touchControls?.showWhen
  if (showWhen && input?.controlsShown) {
    let el = null, last = null
    g.__hostControlsTick = () => {
      if (!el || !el.isConnected) el = g.document.querySelector(showWhen)
      const v = visible(el)
      if (v !== last) { last = v; input.controlsShown(v) }
    }
  }

  // Visibility: the app went to the background (true) or came back. Saves flush on these in most games.
  g.__hostSetHidden = (hidden) => {
    const d = g.document; hidden = !!hidden
    if (d.hidden === hidden) return
    d.hidden = hidden; d.visibilityState = hidden ? 'hidden' : 'visible'
    if (hidden) g.dispatchEvent(new ev.Event('pagehide'))
    d.dispatchEvent(new ev.Event('visibilitychange', { bubbles: true }))
    if (!hidden) g.dispatchEvent(new ev.Event('pageshow'))
  }
}
