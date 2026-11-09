#!/usr/bin/env node
// sim-rooms.mjs [out.json]: the Apple Vision Pro simulator's rooms as WebXR planes, for the vision host.
//
// The simulator reports ARKit's plane detection unsupported, but each simulated room it renders (Living Room,
// Kitchen, Museum; day and night) ships its scene understanding: a SceneUnderstanding_Planes prim of
// classified planes (preliminary:sceneUnderstanding:planeClassification) in the room's USD under the runtime's
// System/Library/Assets/SystemEnvironments/SyntheticEnvironments. RealityKit's plane anchors find these in the
// simulator; ARKit hands them to no app. This reads them with macOS's usdcat and writes, per room, each plane's
// pose (column-major 4x4, metres, +Y the normal) and polygon (x, z pairs in the plane's space): the shape
// host/vision/vision_xr.mm feeds the page's detectedPlanes in the simulator. The room's frame is ARKit's world
// frame there (the origin on the floor under the simulator's default camera, -Z ahead), so poses need no
// alignment.
//
// The geometry is Apple's (the files say it may not be redistributed): this runs on the developer's Mac at build
// time and the output goes into the locally built simulator app only (tools/ios.mjs --vision), never into git.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABELS = {
  PlaneClassificationWall: 'wall', PlaneClassificationFloor: 'floor', PlaneClassificationCeiling: 'ceiling',
  PlaneClassificationTable: 'table', PlaneClassificationSeat: 'couch', PlaneClassificationWindow: 'window',
  PlaneClassificationDoor: 'door',
}  // the rest ("PlaneClassificationNone": shelves, cabinets) as "other", as ARKit's unknown classes

// ---- 4x4 column-major matrices ----
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const mul = (a, b) => { const r = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k]; return r }
const translate = ([x, y, z]) => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m }
const scale = ([x, y, z]) => { const m = ident(); m[0] = x; m[5] = y; m[10] = z; return m }
const rot = (axis, deg) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), m = ident()
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1]
  m[i * 4 + i] = c; m[j * 4 + i] = -s; m[i * 4 + j] = s; m[j * 4 + j] = c
  return m
}
const apply = (m, [x, y, z], w = 1) => [0, 1, 2].map(r => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w)
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l) }

// One xformOp as a matrix. USD's rotateXYZ turns about X first, then Y, then Z; an xformOpOrder's first op is
// the outermost, so a prim's local transform is ops[0] * ops[1] * ... for column vectors.
function opMatrix(name, v) {
  const kind = name.split(':')[1]
  if (kind === 'translate') return translate(v)
  if (kind === 'scale') return scale(v)
  if (kind === 'rotateXYZ') return mul(rot(2, v[2]), mul(rot(1, v[1]), rot(0, v[0])))
  if (kind === 'rotateX' || kind === 'rotateY' || kind === 'rotateZ') return rot('XYZ'.indexOf(kind.at(-1)), v[0])
  throw new Error(`sim-rooms: xformOp ${name} not handled`)
}
function inverse(name, v) {  // the inverse of an op (only pivots are inverted in these files)
  const kind = name.split(':')[1]
  if (kind === 'translate') return translate(v.map(x => -x))
  if (kind === 'scale') return scale(v.map(x => 1 / x))
  throw new Error(`sim-rooms: !invert! of ${name} not handled`)
}
const nums = s => s.match(/-?[\d.]+(?:e[-+]?\d+)?/gi).map(Number)
const triples = s => { const n = nums(s), r = []; for (let i = 0; i + 2 < n.length; i += 3) r.push(n.slice(i, i + 3)); return r }

// The planes of one room: usda text of SceneUnderstanding_Planes (and its ancestors) → [{ name, label, pose, polygon }].
// A line-based reader for usdcat's own output: one attribute per line, every "{" opens what one "}" closes.
function planesOf(usda) {
  const mpu = Number(usda.match(/metersPerUnit = ([\d.e-]+)/)?.[1] ?? 1)
  const stack = [], planes = []
  let pending = null
  const prim = () => [...stack].reverse().find(f => f.prim)
  for (const line of usda.split('\n')) {
    const t = line.trim()
    const def = t.match(/^def (\w+) "([^"]+)"/)
    if (def) { pending = { prim: true, type: def[1], name: def[2], ops: {}, order: [], points: null, normal: null, cls: null }; if (t.endsWith('{')) { stack.push(pending); pending = null }; continue }
    if (t === '{') { stack.push(pending ?? {}); pending = null; continue }
    if (t === '}') { const f = stack.pop(); if (f?.prim && f.type === 'Mesh' && f.cls && f.points) planes.push(finish(f, stack)); continue }
    if (t.endsWith('{')) { stack.push({}); continue }  // a dictionary inside metadata
    const p = prim(); if (!p) continue
    let m
    if ((m = t.match(/^(?:double3|float3|float|double) (xformOp:[\w:]+) = \(?([^)]*)\)?$/))) p.ops[m[1]] = nums(m[2])
    else if ((m = t.match(/xformOpOrder = \[(.*)\]/))) p.order = m[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1))
    else if ((m = t.match(/^point3f\[\] points = \[(.*)\]/))) p.points = triples(m[1])
    else if ((m = t.match(/^normal3f\[\] normals = \[(.*?)\]/))) p.normal = triples(m[1])[0]
    else if ((m = t.match(/planeClassification = "(\w+)"/))) p.cls = m[1]
  }
  return planes

  function local(f) {
    let m = ident()
    for (const op of f.order) m = mul(m, op.startsWith('!invert!') ? inverse(op.slice(8), f.ops[op.slice(8)]) : opMatrix(op, f.ops[op]))
    return m
  }
  function finish(f, ancestors) {
    let M = scale([mpu, mpu, mpu])
    for (const a of ancestors) if (a.prim) M = mul(M, local(a))
    M = mul(M, local(f))
    // World corners, then a frame of the plane's own: origin at the centre, +Y the (local) normal carried into the
    // world, X along the first edge. The polygon is the corners in that frame, ordered around the centre.
    const W = f.points.map(p => apply(M, p))
    const c = [0, 1, 2].map(i => W.reduce((s, p) => s + p[i], 0) / W.length)
    let Y = norm(cross(sub(W[1], W[0]), sub(W[2], W[0])))
    if (dot(Y, apply(M, f.normal ?? [0, 1, 0], 0)) < 0) Y = Y.map(v => -v)
    const e = sub(W[1], W[0]), X = norm(sub(e, Y.map(v => v * dot(e, Y)))), Z = cross(X, Y)
    const poly = W.map(p => { const d = sub(p, c); return [dot(d, X), dot(d, Z)] }).sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]))
    const r = v => Math.round(v * 10000) / 10000
    return { name: f.name, label: LABELS[f.cls] ?? 'other', pose: [...X, 0, ...Y, 0, ...Z, 0, ...c, 1].map(r), polygon: poly.flat().map(r) }
  }
}

// The newest installed visionOS simulator runtime's rooms: { runtime, rooms: { LivingRoomDay: [planes], ... } },
// or null without one.
export function simRooms() {
  let runtimes
  try { runtimes = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'runtimes', '-j'], { encoding: 'utf8' })).runtimes } catch { return null }
  const rt = runtimes.filter(r => r.identifier.includes('xrOS') && r.isAvailable).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
  if (!rt) return null
  const dir = join(rt.bundlePath, 'Contents/Resources/RuntimeRoot/System/Library/Assets/SystemEnvironments/SyntheticEnvironments')
  if (!existsSync(dir)) return null
  const rooms = {}
  for (const env of readdirSync(dir)) {
    const cfg = join(dir, env, 'AssetData/Config.plist')
    if (!existsSync(cfg)) continue
    const scene = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', cfg], { encoding: 'utf8' })).combinedScene
    const usda = execFileSync('usdcat', ['--flatten', join(dir, env, 'AssetData', scene), '--mask', '/SceneUnderstanding_Planes'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    rooms[env] = planesOf(usda)
  }
  return { runtime: `${rt.name} (${rt.buildversion})`, rooms }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = simRooms()
  if (!r) { console.error('sim-rooms: no visionOS simulator runtime with synthetic environments'); process.exit(1) }
  for (const [env, planes] of Object.entries(r.rooms)) {
    const count = {}; for (const p of planes) count[p.label] = (count[p.label] ?? 0) + 1
    console.log(`${env}: ${planes.length} planes (${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ')})`)
  }
  if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify(r)); console.log(`${process.argv[2]} (${r.runtime})`) }
}
