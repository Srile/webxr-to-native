import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { STRIDE, keyOf } from '../src/dom-lite/input.js'

// A native input queue the test fills: records as host/js/dom_input.h writes them.
function sandbox(info = {}, pad = null, config = null, shown = null) {
  const q = []
  const g = Object.create(null)
  g.__native = fakeNative({ info: { version: 'test', userAgent: 'ua', systemName: 'test', package: 'test', filesDir: '/tmp', ...info },
    input: { codes: ['Unidentified', 'KeyA', 'ArrowUp', 'ShiftLeft', 'Digit1'], read: (buf) => { const n = q.length; q.forEach((r, i) => buf.set(r, i * STRIDE)); q.length = 0; return n }, pad: pad ? (s) => { s.set(pad); return true } : undefined, controlsShown: (v) => shown?.push(v) }, ...(config ? { config } : {}) })
  g.Promise = Promise
  installCore(g)
  const canvas = g.document.createElement('div'); g.document.body.appendChild(canvas)
  g.__hostGL = () => ({ canvas })
  const rec = (type, id, x, y, extra = {}) => { const r = new Float64Array(STRIDE); r.set([type, id, x, y, extra.buttons ?? 0, extra.button ?? 0, extra.ptype ?? 0, extra.pressure ?? 0, extra.mods ?? 0, extra.code ?? 0, extra.dx ?? 0, extra.dy ?? 0]); q.push(r) }
  return { g, canvas, rec }
}

test('text nodes take nodeValue as React writes it', () => {
  const { g } = sandbox()
  const text = g.document.createTextNode('Lobby'), note = g.document.createComment('a')
  text.nodeValue = 'Sandbox'; note.nodeValue = 'b'
  assert.equal(text.data, 'Sandbox'); assert.equal(text.textContent, 'Sandbox'); assert.equal(note.nodeValue, 'b')
  text.nodeValue = null; assert.equal(text.data, '')
})

test('events capture on window, reach the target, bubble back', () => {
  const { g, canvas } = sandbox(); const order = []
  g.addEventListener('x', () => order.push('win-capture'), true); g.addEventListener('x', () => order.push('win-bubble'))
  g.document.body.addEventListener('x', (e) => { order.push('body'); assert.equal(e.currentTarget, g.document.body); assert.equal(e.target, canvas) })
  canvas.addEventListener('x', () => order.push('target'))
  canvas.dispatchEvent(new g.Event('x', { bubbles: true }))
  assert.deepEqual(order, ['win-capture', 'target', 'body', 'win-bubble'])
  order.length = 0; canvas.dispatchEvent(new g.Event('x')); assert.deepEqual(order, ['win-capture', 'target'])
})

test('a mouse click: pointer and mouse events on the canvas, in order', () => {
  const { g, canvas, rec } = sandbox(); const seen = []
  for (const t of ['pointerover', 'pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup', 'click']) canvas.addEventListener(t, (e) => seen.push(`${t}:${e.pointerType ?? ''}:${e.clientX}`))
  rec(1, 1, 10, 20, { buttons: 1 }); rec(2, 1, 15, 20, { buttons: 1 }); rec(3, 1, 15, 20)
  g.__hostDrainInput()
  assert.deepEqual(seen, ['pointerover:mouse:10', 'pointerdown:mouse:10', 'mousedown::10', 'pointermove:mouse:15', 'mousemove::15', 'pointerup:mouse:15', 'mouseup::15', 'click:mouse:15'])
})

test('touches: two fingers, primary first, a tap clicks, as pointer events (no touch events)', () => {
  const { g, canvas, rec } = sandbox({ formFactor: 'phone' }); const downs = []; let clicks = 0, touch = 0
  canvas.addEventListener('pointerdown', (e) => downs.push([e.pointerId, e.pointerType, e.isPrimary]))
  canvas.addEventListener('click', () => clicks++); canvas.addEventListener('touchstart', () => touch++)
  rec(1, 5, 100, 100, { ptype: 1, buttons: 1 }); rec(1, 6, 300, 100, { ptype: 1, buttons: 1 }); rec(3, 5, 101, 100, { ptype: 1 }); rec(2, 6, 400, 100, { ptype: 1, buttons: 1 }); rec(3, 6, 400, 100, { ptype: 1 })
  g.__hostDrainInput()
  assert.deepEqual(downs, [[5, 'touch', true], [6, 'touch', false]]); assert.equal(clicks, 1); assert.equal(touch, 0)
  assert.equal(g.navigator.maxTouchPoints, 5); assert.equal(g.navigator.userAgentData.mobile, true); assert.equal('ontouchstart' in g, true)
  assert.equal(g.matchMedia('(pointer: coarse)').matches, true); assert.equal(g.matchMedia('(hover: hover)').matches, false)
})

test('a cancelled pointerdown suppresses the mouse events and the click', () => {
  const { g, canvas, rec } = sandbox(); let mouse = 0
  canvas.addEventListener('pointerdown', (e) => e.preventDefault()); canvas.addEventListener('mousedown', () => mouse++); canvas.addEventListener('click', () => mouse++)
  rec(1, 1, 0, 0, { buttons: 1 }); rec(3, 1, 0, 0); g.__hostDrainInput(); assert.equal(mouse, 0)
})

test('keys: code, key with shift, keyCode, repeat, to the body and up to window', () => {
  const { g, rec } = sandbox(); const keys = []
  g.addEventListener('keydown', (e) => keys.push([e.code, e.key, e.keyCode, e.repeat, e.shiftKey]))
  rec(6, 0, 0, 0, { code: 1 }); rec(6, 0, 0, 0, { code: 1, mods: 1 | 16 }); rec(6, 0, 0, 0, { code: 2 }); rec(6, 0, 0, 0, { code: 4, mods: 1 })
  g.__hostDrainInput()
  assert.deepEqual(keys, [['KeyA', 'a', 65, false, false], ['KeyA', 'A', 65, true, true], ['ArrowUp', 'ArrowUp', 38, false, false], ['Digit1', '!', 49, false, true]])
  assert.equal(keyOf('Space', false), ' ')
})

test('the touch controls gamepad: one standard pad, updated in place, announced once', async () => {
  const state = new Float32Array(23); state[0] = 1; state[1] = 42; state[2] = -0.5; state[6 + 7] = 1
  const { g } = sandbox({}, state); let connected = 0
  g.addEventListener('gamepadconnected', (e) => { connected++; assert.equal(e.gamepad.mapping, 'standard') })
  const a = g.navigator.getGamepads(), b = g.navigator.getGamepads()
  assert.equal(a, b); assert.equal(a.length, 4); assert.equal(a[1], null)
  assert.equal(a[0].axes[0], -0.5); assert.equal(a[0].buttons[7].pressed, true); assert.equal(a[0].buttons[6].pressed, false)
  await new Promise(r => setTimeout(r, 5)); assert.equal(connected, 1)
})

test('viewport: size, pixel ratio, orientation, resize observers; visibility', async () => {
  const { g } = sandbox(); let resized = 0, turned = 0, vis = []
  g.addEventListener('resize', () => resized++); g.addEventListener('orientationchange', () => turned++)
  const seen = []; new g.ResizeObserver((entries) => seen.push(entries[0].contentRect.width)).observe(g.document.documentElement)
  await new Promise(r => setTimeout(r, 5))
  g.__hostSetViewport(915, 412, 2.625, 2400, 1080, 90)
  assert.equal(g.innerWidth, 915); assert.equal(g.devicePixelRatio, 2.625); assert.equal(g.screen.orientation.angle, 90); assert.equal(resized, 1); assert.equal(turned, 1)
  assert.deepEqual(g.__hostWindowPixels, [2400, 1080]); assert.equal(seen.at(-1), 915)
  assert.equal(g.matchMedia('(orientation: landscape) and (min-width: 900px)').matches, true)
  g.document.addEventListener('visibilitychange', () => vis.push(g.document.visibilityState)); g.__hostSetHidden(true); g.__hostSetHidden(false)
  assert.deepEqual(vis, ['hidden', 'visible'])
})

test('touch controls follow the page\'s own touch UI (showWhen)', () => {
  const shown = []
  const { g } = sandbox({ formFactor: 'phone' }, null, { web: { origin: 'https://app.local' }, touchControls: { showWhen: '.touch-controls' } }, shown)
  g.__hostControlsTick(); assert.deepEqual(shown, [false])               // not built yet
  const c = g.document.createElement('div'); c.className = 'touch-controls'; c.style.display = 'none'; g.document.body.appendChild(c)
  g.__hostControlsTick(); assert.deepEqual(shown, [false])               // built hidden: no change to report
  c.style.display = ''; g.__hostControlsTick(); g.__hostControlsTick(); assert.deepEqual(shown, [false, true])
  g.document.body.style.display = 'none'; g.__hostControlsTick(); assert.deepEqual(shown, [false, true, false])  // an ancestor hides it
  g.document.body.style.display = ''; c.remove(); g.__hostControlsTick(); assert.deepEqual(shown, [false, true, false])
})

test('style.setProperty on a fresh element sets the property', () => {
  const { g } = sandbox({ formFactor: 'phone' })
  const el = g.document.createElement('div')
  el.style.setProperty('display', 'none', 'important')
  assert.equal(el.style.display, 'none'); assert.equal(el.style.getPropertyValue('display'), 'none')
})

test('safe-area insets reach getComputedStyle through env()', () => {
  const { g } = sandbox({ formFactor: 'phone' })
  g.__hostSetViewport(915, 412, 2.625, 2400, 1080, 90, 0, 0, 0, 52)
  const probe = g.document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);'
  const cs = g.getComputedStyle(probe)
  assert.equal(cs.paddingLeft, '52px'); assert.equal(cs.paddingTop, '0px'); assert.equal(probe.style.position, 'fixed'); assert.match(probe.style.getPropertyValue('padding'), /^env\(safe-area-inset-top\)/)
})

test('DOMParser parses SVG into elements SVGLoader can walk', () => {
  const { g } = sandbox()
  const d = new g.DOMParser().parseFromString('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><!-- c --><g transform="translate(1 2)"><path d="M1 1 L 2 2" fill="black" style="fill-rule: evenodd"/></g><text>a &amp; b</text></svg>', 'image/svg+xml')
  const svg = d.documentElement
  assert.equal(svg.nodeName, 'svg'); assert.equal(svg.getAttribute('viewBox'), '0 0 24 24'); assert.equal(svg.nodeType, 1)
  const path = svg.getElementsByTagName('path')[0]
  assert.equal(path.nodeName, 'path'); assert.equal(path.getAttribute('d'), 'M1 1 L 2 2'); assert.equal(path.style.fillRule, 'evenodd'); assert.equal(path.parentNode.nodeName, 'g')
  assert.equal(svg.childNodes.length, 2); assert.equal(svg.lastChild.textContent, 'a & b')
  assert.equal(path.namespaceURI, 'http://www.w3.org/2000/svg')
})

test('DOMParser keeps XML namespaces a UI tree looks up', () => {
  const { g } = sandbox()
  const xml = '<?xml version="1.0"?><ui-tree name="default" xmlns="lazy-widgets" xmlns:option="lazy-widgets:options" xmlns:on="lazy-widgets:on"><layered-container><book option:id="mode-book" on:click="$go">Hi</book></layered-container></ui-tree>'
  const d = new g.DOMParser().parseFromString(xml, 'text/xml')
  const trees = d.getElementsByTagNameNS('lazy-widgets', 'ui-tree')
  assert.equal(trees.length, 1)
  assert.equal(trees[0].attributes.getNamedItemNS(null, 'name').value, 'default')
  assert.equal([...trees[0].attributes].find(a => a.name === 'xmlns').namespaceURI, 'http://www.w3.org/2000/xmlns/')
  const book = trees[0].getElementsByTagNameNS('lazy-widgets', 'book')[0]
  assert.equal(book.namespaceURI, 'lazy-widgets'); assert.equal(book.localName, 'book'); assert.equal(book.textContent, 'Hi')
  const attrs = [...book.attributes]
  assert.equal(attrs.find(a => a.localName === 'id').namespaceURI, 'lazy-widgets:options')
  assert.equal(attrs.find(a => a.localName === 'click').namespaceURI, 'lazy-widgets:on')
  assert.equal(g.Node.ELEMENT_NODE, 1); assert.equal(book.nodeType, g.Node.ELEMENT_NODE)
})

test('a touch in a touch zone goes to the page\'s zone element while it is shown; elsewhere to the canvas', () => {
  const sticks = []
  const { g, canvas, rec } = sandbox({ formFactor: 'phone' }, null, { web: { origin: 'https://app.local' }, touchControls: { zones: [{ selector: '.touch-zone-full', rect: [0, 0.5, 1, 1], stick: {} }] } })
  g.__native.input.stickFinger = (id, x, y) => sticks.push([id, x, y])
  g.__hostSetViewport(800, 400, 1, 800, 400, 0)
  const zone = g.document.createElement('div'); zone.className = 'touch-zone touch-zone-full'; g.document.body.appendChild(zone)
  const got = []; zone.addEventListener('pointerdown', (e) => got.push(['zone', e.clientX, e.clientY])); zone.addEventListener('pointermove', (e) => got.push(['zone-move', e.clientX]))
  canvas.addEventListener('pointerdown', () => got.push(['canvas']))
  rec(1, 7, 100, 350, { ptype: 1, buttons: 1 }); rec(2, 7, 150, 100, { ptype: 1, buttons: 1 }); rec(3, 7, 150, 100, { ptype: 1 })   // in the zone; moving out keeps it
  rec(1, 8, 100, 100, { ptype: 1, buttons: 1 }); rec(3, 8, 100, 100, { ptype: 1 })                                              // the top half: the canvas
  g.__hostDrainInput()
  assert.deepEqual(got, [['zone', 100, 350], ['zone-move', 150], ['canvas']]); assert.deepEqual(sticks, [[7, 100, 350]])
  assert.deepEqual([zone.getBoundingClientRect().top, zone.getBoundingClientRect().height], [200, 200])
  zone.style.display = 'none'; rec(1, 9, 100, 350, { ptype: 1, buttons: 1 }); rec(3, 9, 100, 350, { ptype: 1 }); g.__hostDrainInput()
  assert.deepEqual(got.at(-1), ['canvas'])                                                                                        // hidden: not a zone
})

test('new Audio() exists and reports the codecs decodeAudioData decodes', () => {
  const { g } = sandbox()
  const a = new g.Audio('x.ogg'); assert.equal(a.src, 'x.ogg'); assert.ok(a instanceof g.HTMLAudioElement)
  assert.equal(a.canPlayType('audio/ogg; codecs="vorbis"'), 'probably'); assert.equal(a.canPlayType('audio/wav'), 'maybe'); assert.equal(a.canPlayType('audio/wav; codecs="1"'), 'probably')
  assert.equal(a.canPlayType('audio/mp4; codecs="mp4a.40.2"'), '')
  // A host without __native.audio.codecs (or built without libopus and dr_mp3) decodes no Opus and no MP3.
  assert.equal(a.canPlayType('audio/webm; codecs="vorbis"'), 'probably'); assert.equal(a.canPlayType('audio/webm; codecs="opus"'), '')
  assert.equal(a.canPlayType('audio/mpeg'), '')
})

test('canPlayType: WebM and Ogg with Opus or Vorbis, MP3, when the host decodes them, as Howler and its kind ask', () => {
  const { g } = sandbox(); g.__native.audio = { codecs: 'wav vorbis opus mp3' }
  const a = new g.Audio()
  assert.equal(a.canPlayType('audio/webm; codecs="vorbis"'), 'probably')                 // Howler's "webm" and "weba"
  assert.equal(a.canPlayType('audio/webm; codecs="opus"'), 'probably')
  assert.equal(a.canPlayType('audio/webm;codecs=opus'), 'probably')
  assert.equal(a.canPlayType('audio/webm; codecs="vorbis, opus"'), 'probably')
  assert.equal(a.canPlayType('audio/webm'), 'maybe')
  assert.equal(a.canPlayType('video/webm; codecs="vp9, opus"'), '')                       // no video
  assert.equal(a.canPlayType('audio/ogg; codecs="opus"'), 'probably')                     // Howler's "opus"
  assert.equal(a.canPlayType('audio/ogg'), 'maybe')
  assert.equal(a.canPlayType('audio/mpeg;'), 'probably')                                  // Howler's "mp3" and "mpeg"
  assert.equal(a.canPlayType('audio/mp3;'), 'probably')
  assert.equal(a.canPlayType('audio/mpeg; codecs="mp3"'), 'probably')
  assert.equal(a.canPlayType('audio/webm; codecs="flac"'), '')
  assert.equal(a.canPlayType('audio/aac;'), ''); assert.equal(a.canPlayType('audio/x-m4a;'), ''); assert.equal(a.canPlayType('audio/flac;'), '')
  assert.equal(a.canPlayType(''), '')
  g.__native.audio = { codecs: 'wav vorbis opus' }                                          // built without dr_mp3
  assert.equal(a.canPlayType('audio/mpeg;'), '')
})

test('web.startGesture: a tap each time the page starts listening for taps, until the player touches', () => {
  const { g, canvas, rec } = sandbox({ formFactor: 'phone' }, null, { web: { origin: 'https://app.local', startGesture: true } })
  const taps = []
  g.__hostDrainInput(); assert.deepEqual(taps, [])                                                      // no listener yet
  canvas.addEventListener('pointerdown', (e) => taps.push([e.clientX, e.clientY, e.pointerType]))
  g.__hostDrainInput(); g.__hostDrainInput(); assert.deepEqual(taps, [[1, 1, 'touch']])                  // once per new listener
  rec(1, 3, 50, 50, { ptype: 1, buttons: 1 }); rec(3, 3, 50, 50, { ptype: 1 }); g.__hostDrainInput()     // the player's own tap
  canvas.addEventListener('pointerdown', () => taps.push('late')); g.__hostDrainInput()
  assert.deepEqual(taps, [[1, 1, 'touch'], [50, 50, 'touch']])                                          // no more synthetic ones
})

test('a listener added while an event is dispatched waits for the next event, even with one listener', () => {
  const { g, canvas } = sandbox(); const calls = []
  canvas.addEventListener('x', () => { calls.push('first'); canvas.addEventListener('x', () => calls.push('second')) })
  canvas.dispatchEvent(new g.Event('x')); assert.deepEqual(calls, ['first'])
})

test('matchMedia change fires when a rotation flips the answer', () => {
  const { g } = sandbox({ formFactor: 'phone' }); const seen = []
  g.__hostSetViewport(412, 915, 2.625, 1080, 2400, 0)
  const mq = g.matchMedia('(orientation: portrait)'); mq.addEventListener('change', (e) => seen.push(e.matches))
  const old = g.matchMedia('(min-width: 600px)'); old.addListener((e) => seen.push('wide:' + e.matches))
  g.__hostSetViewport(915, 412, 2.625, 2400, 1080, 90)
  assert.deepEqual(seen, [false, 'wide:true'])
})
