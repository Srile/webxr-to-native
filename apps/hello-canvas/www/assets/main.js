// Canvas 2D + SVG picture test: the same script runs in a browser (open www/index.html) and on the host, and
// ../check.mjs compares the panel the host drew with Chrome's render of it (../chrome.png), cell by cell.
// Each 128 px cell is one thing a canvas-texture UI leans on: transforms (one chevron turned four ways), CSS
// colours, an SVG icon styled every way an export styles one, composite tints, rounded rects, shadows.
// web.canvasText and web.svg are on in host.json.
const W = 1024, H = 768, CELL = 128
const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
const ctx = canvas.getContext('2d')
globalThis.__panel = canvas
globalThis.__panelErrors = []

const svgUrl = (body, attrs = 'viewBox="0 0 24 24" width="48" height="48"') => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`)
const load = (url) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url })

const CHEVRON = 'M5 15 L12 8 L19 15'
const LOCK_BODY = 'M5 11 H19 V21 H5 Z', LOCK_SHACKLE = 'M8 11 V7 A4 4 0 0 1 16 7 V11'
const LOCK = `${LOCK_BODY} ${LOCK_SHACKLE}`
const FLAME = 'M12 2 C13 6 18 9 18 14 A6 6 0 0 1 6 14 C6 11 8 10 9 7 C10 9 11 9 12 2 Z'
const lockShapes = (a = '') => `<path d="${LOCK_SHACKLE}" fill="none" ${a}/><path d="${LOCK_BODY}" ${a}/>`

// name -> SVG source: one padlock / flame, yellow with a gold border, styled a different way each.
const svgs = {
  chevron: svgUrl(`<path d="${CHEVRON}" fill="none" stroke="#222" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`),
  attrHex: svgUrl(`<path d="${FLAME}" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"/>`),
  attrNamed: svgUrl(`<path d="${FLAME}" fill="gold" stroke="darkgoldenrod" stroke-width="1.5"/>`),
  styleAttr: svgUrl(`<path d="${FLAME}" style="fill:#FFD700;stroke:#B8860B;stroke-width:1.5"/>`),
  styleClass: svgUrl(`<defs><style>.a{fill:#FFD700;stroke:#B8860B;stroke-width:1.5}</style></defs><path class="a" d="${FLAME}"/>`),
  styleElement: svgUrl(`<style>path{fill:#FFD700;stroke:#B8860B;stroke-width:1.5}</style><path d="${FLAME}"/>`),
  styleCdata: svgUrl(`<style type="text/css"><![CDATA[ .st0{fill:#FFD700;stroke:#B8860B;stroke-width:1.5;} ]]></style><path class="st0" d="${FLAME}"/>`),
  styleId: svgUrl(`<style>#f{fill:#FFD700;stroke:#B8860B;stroke-width:1.5}</style><path id="f" d="${FLAME}"/>`),
  styleLate: svgUrl(`<path class="a" d="${FLAME}"/><style>.a{fill:#FFD700;stroke:#B8860B;stroke-width:1.5}</style>`),
  rgbFn: svgUrl(`<path d="${FLAME}" fill="rgb(255, 215, 0)" stroke="rgb(184,134,11)" stroke-width="1.5"/>`),
  rgbaFn: svgUrl(`<path d="${FLAME}" fill="rgba(255, 215, 0, 1)" stroke="rgba(184,134,11,1)" stroke-width="1.5"/>`),
  hslFn: svgUrl(`<path d="${FLAME}" fill="hsl(51, 100%, 50%)" stroke="hsl(43, 89%, 38%)" stroke-width="1.5"/>`),
  rootAttrs: svgUrl(`<path d="${FLAME}"/>`, 'viewBox="0 0 24 24" width="48" height="48" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"'),
  group: svgUrl(`<g fill="#FFD700" stroke="#B8860B" stroke-width="1.5">${lockShapes()}</g>`),
  currentColor: svgUrl(`<g color="#FFD700" fill="currentColor" stroke="#B8860B" stroke-width="1.5">${lockShapes()}</g>`),
  use: svgUrl(`<defs><path id="p" d="${FLAME}"/></defs><use href="#p" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"/>`),
  useXlink: svgUrl(`<symbol id="s" viewBox="0 0 24 24"><path d="${FLAME}"/></symbol><use xlink:href="#s" width="24" height="24" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"/>`),
  gradient: svgUrl(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF176"/><stop offset="1" stop-color="#FFB300"/></linearGradient></defs><path d="${FLAME}" fill="url(#g)" stroke="#B8860B" stroke-width="1.5"/>`),
  gradientLate: svgUrl(`<path d="${FLAME}" fill="url(#g)" stroke="#B8860B" stroke-width="1.5"/><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF176"/><stop offset="1" stop-color="#FFB300"/></linearGradient></defs>`),
  cssTransform: svgUrl(`<path d="${CHEVRON}" fill="none" stroke="#222" stroke-width="3" style="transform: rotate(90deg); transform-origin: 12px 12px"/>`),
  attrTransform: svgUrl(`<path d="${CHEVRON}" fill="none" stroke="#222" stroke-width="3" transform="rotate(90 12 12)"/>`),
  noSize: svgUrl(`<path d="${FLAME}" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"/>`, 'viewBox="0 0 24 24"'),
  opacity: svgUrl(`<path d="${FLAME}" fill="#FFD700" fill-opacity="0.5" stroke="#B8860B" stroke-opacity=".5" stroke-width="1.5"/>`),
  shapes: svgUrl(`<rect x="3" y="3" width="18" height="18" rx="4" fill="#FFD700" stroke="#B8860B" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="orange"/><polygon points="12,5 14,9 10,9" fill="tomato"/>`),
  important: svgUrl(`<style>.a{fill:#FFD700 !important;stroke:#B8860B;stroke-width:1.5px}</style><path class="a" d="${FLAME}"/>`),
  compound: svgUrl(`<style>svg .a, path.b{fill:#FFD700;stroke:#B8860B;stroke-width:1.5}</style><path class="a" d="${FLAME}"/>`),
}
const img = {}
await Promise.all(Object.entries(svgs).map(async ([k, url]) => { img[k] = await load(url) }))

let cellIndex = 0
function cell(draw) {
  const i = cellIndex++, x = (i % (W / CELL)) * CELL, y = Math.floor(i / (W / CELL)) * CELL
  ctx.save(); ctx.translate(x, y)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 4, CELL - 8, CELL - 8)
  try { draw() } catch (e) { console.error(`cell ${i}: ${e && e.message}`); globalThis.__panelErrors.push(`cell ${i}: ${e && e.message}`); ctx.fillStyle = '#ff00ff'; ctx.fillRect(4, 4, 16, 16) }
  ctx.restore()
}
const strokeChevron = () => { ctx.strokeStyle = '#222'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(new Path2D(CHEVRON)) }
// A 48 px icon drawn around (cx, cy) under a rotation, the way a UI turns one chevron asset four ways.
const rotated = (cx, cy, deg, draw) => { ctx.save(); ctx.translate(cx, cy); ctx.rotate(deg * Math.PI / 180); draw(); ctx.restore() }
const four = (draw) => { rotated(32, 32, 0, draw); rotated(96, 32, 90, draw); rotated(32, 96, -90, draw); rotated(96, 96, 180, draw) }
const drawSvg = (name, size = 96) => { const im = img[name]; if (!im) throw new Error(`svg ${name} failed to load`); ctx.drawImage(im, (CELL - size) / 2, (CELL - size) / 2, size, size) }

ctx.fillStyle = '#1d2630'; ctx.fillRect(0, 0, W, H)

// Row 1: transforms
cell(() => four(() => { ctx.scale(2, 2); ctx.translate(-12, -12); strokeChevron() }))                    // 0 Path2D stroke
cell(() => four(() => ctx.drawImage(img.chevron, -24, -24, 48, 48)))                                      // 1 SVG image
cell(() => four(() => { ctx.fillStyle = '#1565c0'; ctx.fillRect(-20, -8, 40, 16); ctx.fillStyle = '#ffd700'; ctx.fillRect(8, -8, 12, 16) }))  // 2 rects
cell(() => { rotated(64, 64, 30, () => { ctx.fillStyle = '#2e7d32'; ctx.fillRect(-40, -20, 80, 40); ctx.clearRect(-10, -10, 20, 20) }) })   // 3 30 degrees
cell(() => { ctx.fillStyle = '#111'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; four(() => ctx.fillText('HIIT', 0, 0)) })  // 4 text
cell(() => { ctx.transform(1, 0.3, -0.3, 1, 30, 10); ctx.fillStyle = '#6a1b9a'; ctx.fillRect(10, 10, 70, 50); ctx.drawImage(img.attrHex, 20, 40, 48, 48) })  // 5 transform()
cell(() => { const t = ctx.getTransform(); ctx.setTransform(0, 1, -1, 0, t.e + 124, t.f + 4); const g = ctx.createLinearGradient(0, 0, 120, 0); g.addColorStop(0, '#e53935'); g.addColorStop(1, '#1e88e5'); ctx.fillStyle = g; ctx.fillRect(10, 10, 100, 60); ctx.setTransform(t) })  // 6 setTransform + gradient
cell(() => { rotated(64, 64, 45, () => { ctx.beginPath(); ctx.rect(-30, -30, 60, 60); ctx.clip(); ctx.rotate(-Math.PI / 4); ctx.fillStyle = '#00838f'; ctx.fillRect(-60, -60, 120, 120); ctx.drawImage(img.attrHex, -24, -24) }) })  // 7 rotated clip

// Row 2: path colours and shapes
const icon = (d, fill, stroke) => { ctx.save(); ctx.translate(16, 16); ctx.scale(4, 4); ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; const p = new Path2D(d); ctx.fill(p); ctx.stroke(p); ctx.restore() }
cell(() => icon(FLAME, '#FFD700', '#B8860B'))                                                             // 8 hex
cell(() => icon(FLAME, 'gold', 'darkgoldenrod'))                                                          // 9 names
cell(() => icon(FLAME, 'hsl(51, 100%, 50%)', 'hsl(43 89% 38%)'))                                          // 10 hsl
cell(() => icon(LOCK_BODY, 'rgb(255 215 0 / 100%)', 'GoldenRod'))                                         // 11 modern rgb, mixed case
cell(() => { const g = ctx.createLinearGradient(0, 16, 0, 112); g.addColorStop(0, 'lightyellow'); g.addColorStop(1, 'orange'); icon(FLAME, g, 'saddlebrown') })  // 12 gradient fill
cell(() => { ctx.fillStyle = 'gold'; ctx.strokeStyle = 'darkgoldenrod'; ctx.lineWidth = 4; ctx.beginPath(); ctx.roundRect(16, 24, 96, 80, 16); ctx.fill(); ctx.stroke() })  // 13 roundRect
cell(() => { ctx.fillStyle = 'khaki'; ctx.strokeStyle = 'peru'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(32, 24); ctx.arcTo(112, 24, 112, 104, 16); ctx.arcTo(112, 104, 16, 104, 16); ctx.arcTo(16, 104, 16, 24, 16); ctx.arcTo(16, 24, 112, 24, 16); ctx.closePath(); ctx.fill(); ctx.stroke() })  // 14 arcTo
cell(() => { ctx.strokeStyle = 'crimson'; ctx.lineWidth = 6; ctx.setLineDash([12, 6]); ctx.strokeRect(20, 20, 88, 88); ctx.setLineDash([]); ctx.fillStyle = 'rebeccapurple'; ctx.beginPath(); ctx.arc(64, 64, 24, 0, Math.PI * 2); ctx.fill() })  // 15 dashes, circle

// Rows 3-5: SVG icon styling
for (const name of ['attrHex', 'attrNamed', 'styleAttr', 'styleClass', 'styleElement', 'styleCdata', 'styleId', 'styleLate',
  'rgbFn', 'rgbaFn', 'hslFn', 'rootAttrs', 'group', 'currentColor', 'use', 'useXlink',
  'gradient', 'gradientLate', 'cssTransform', 'attrTransform', 'noSize', 'opacity', 'shapes', 'important']) cell(() => drawSvg(name))

// Row 6: compositing and tints
const tinted = (name, colour, op) => { const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d'); x.drawImage(img[name], 0, 0, 96, 96); x.globalCompositeOperation = op; x.fillStyle = colour; x.fillRect(0, 0, 96, 96); return c }
cell(() => ctx.drawImage(tinted('chevron', 'gold', 'source-in'), 16, 16))                                 // 40
cell(() => ctx.drawImage(tinted('chevron', 'gold', 'source-atop'), 16, 16))                               // 41
cell(() => ctx.drawImage(tinted('chevron', 'gold', 'destination-over'), 16, 16))                          // 42
cell(() => ctx.drawImage(tinted('attrHex', '#1565c0', 'destination-in'), 16, 16))                         // 43
cell(() => ctx.drawImage(tinted('attrHex', '#808080', 'multiply'), 16, 16))                               // 44
cell(() => { ctx.globalAlpha = 0.4; drawSvg('attrHex'); ctx.globalAlpha = 1; ctx.filter = 'grayscale(1)'; ctx.drawImage(img.attrHex, 72, 72, 48, 48); ctx.filter = 'none' })  // 45 alpha, filter
cell(() => drawSvg('compound'))                                                                           // 46
cell(() => { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3; ctx.fillStyle = 'gold'; ctx.beginPath(); ctx.roundRect(24, 32, 80, 56, 12); ctx.fill() })  // 47 shadow

if (document.body) document.body.appendChild(canvas)
console.log('hello-canvas: drawn ' + cellIndex + ' cells')
globalThis.__panelDone = true
