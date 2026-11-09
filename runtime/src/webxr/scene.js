// scene.js — the native scene (host/xr/xr_scene.cpp: `__native.xr.sceneEntities()` + the `scenePoses()` record)
// as IWER's host-mode plane and mesh lists (XRHostBackend.getPlanes / getMeshes). Native has already converted
// everything to WebXR conventions: a plane's space has +Y as its normal and its polygon on y = 0; mesh vertices are
// in the mesh's own space.
//
// Each frame record carries a scene GENERATION (record.js F.SCENE_GEN); when it changes the entity list is fetched
// again and reconciled by entity id, so a NativePlane / NativeMesh (and the XRPlane / XRMesh IWER keeps for it)
// lives as long as the runtime keeps the anchor (IWSDK keys its entities on that identity). A changed polygon,
// mesh or label is a new value on the same object, which IWER reports through lastChangedTime. Poses come from the
// pose record native rewrites every frame, written into each object's transform in place.
import { NativeMesh, NativePlane, XRRigidTransform, P_RIGID_TRANSFORM } from 'iwer/lib/host.js'
import { mat4FromPoseAt } from './math.js'
import { S } from './record.js'

const KIND_PLANE = 1

export class SceneSource {
  constructor(nativeXr, log) {
    this.nx = nativeXr
    this.log = log
    this.poses = null
    this.clear()
  }

  clear() {
    this.gen = -1
    this.byId = new Map()      // entity id → { obj, slot, changed, kind }
    this.planeSet = new Set()  // what getPlanes / getMeshes answer: the same sets, updated in place
    this.meshSet = new Set()
    this.posedIn = -1
  }

  planes(gen, frameId) { this.sync(gen); this.pose(frameId); return this.planeSet }
  meshes(gen, frameId) { this.sync(gen); this.pose(frameId); return this.meshSet }

  sync(gen) {
    if (gen === this.gen) return
    this.gen = gen
    const nx = this.nx
    let list = null
    try { list = typeof nx.sceneEntities === 'function' ? nx.sceneEntities() : null } catch (e) { this.log(2, 'xr.sceneEntities failed: ' + e); return }
    if (this.poses === null && typeof nx.scenePoses === 'function') {
      try { this.poses = nx.scenePoses() || null } catch (e) { this.log(2, 'xr.scenePoses failed: ' + e) }
    }
    const seen = new Set()
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]
        seen.add(e.id)
        let rec = this.byId.get(e.id)
        if (rec !== undefined && rec.kind !== e.kind) { this.drop(e.id, rec); rec = undefined }  // a mesh became a plane, or back
        if (rec === undefined) {
          const t = new XRRigidTransform()
          const obj = e.kind === KIND_PLANE ? new NativePlane(t, points(e.polygon), e.label) : new NativeMesh(t, e.vertices, e.indices, e.label)
          rec = { obj, slot: e.slot, changed: e.changed, kind: e.kind }
          this.byId.set(e.id, rec)
          ;(e.kind === KIND_PLANE ? this.planeSet : this.meshSet).add(obj)
          this.posedIn = -1
        } else {
          rec.slot = e.slot
          if (rec.changed !== e.changed) {
            rec.changed = e.changed
            rec.obj.semanticLabel = e.label
            if (e.kind === KIND_PLANE) rec.obj.polygon = points(e.polygon)
            else { rec.obj.vertices = e.vertices; rec.obj.indices = e.indices }
          }
        }
      }
    }
    for (const [id, rec] of this.byId) if (!seen.has(id)) this.drop(id, rec)
  }

  drop(id, rec) {
    this.byId.delete(id)
    ;(rec.kind === KIND_PLANE ? this.planeSet : this.meshSet).delete(rec.obj)
  }

  // Every object's pose for this frame, once per frame. A slot the runtime cannot locate this frame keeps the
  // last pose it had.
  pose(frameId) {
    if (this.posedIn === frameId || this.poses === null) return
    this.posedIn = frameId
    const p = this.poses
    for (const rec of this.byId.values()) {
      if (rec.slot < 0) continue
      const b = rec.slot * S.STRIDE
      if (p[b + S.VALID] < 0.5) continue
      const st = rec.obj.transform[P_RIGID_TRANSFORM]
      mat4FromPoseAt(st.matrix, p, b + S.POS, b + S.QUAT)
      st.version++  // the transform's position / orientation are derived again on their next read
    }
  }
}

// x, z pairs on y = 0 → DOMPointReadOnly[]
function points(polygon) {
  const P = globalThis.DOMPointReadOnly
  const out = new Array(polygon ? polygon.length >> 1 : 0)
  for (let i = 0; i < out.length; i++) out[i] = new P(polygon[i * 2], 0, polygon[i * 2 + 1], 1)
  return out
}
