// render-models.js — the runtime's own controller models (host.json xr.renderModels; host/xr/xr_render_models.h,
// XR_EXT_render_model) for the page, which draws them in place of its own:
//
//   frame.getRenderModel(inputSource) → null, or {
//     id,          // the runtime's model id: a new id is a new model
//     glb,         // ArrayBuffer: the glTF binary
//     nodes,       // the animatable nodes' glTF names
//     tracked,     // this frame: false → don't draw it
//     pose,        // Float32Array(7): the model's origin in the source's gripSpace (position xyz, orientation xyzw)
//     nodeStates,  // Float32Array(8 per node): visible, position xyz, orientation xyzw in its parent node's space,
//   }              //   replacing the node's glTF transform
//
// WebXR conventions throughout (right-handed metres; glTF's too). The arrays are views over the record native
// rewrites every frame. Not a WebXR API: pages feature-test for XRFrame.prototype.getRenderModel.
const HEADER = 4, STRIDE = 8 + 64 * 8   // XrRenderModels::kHeader, kStride

export function installRenderModels(g, nx, log) {
  const XRFrame = g.XRFrame
  if (!XRFrame || !nx || typeof nx.renderModelPoses !== 'function' || typeof nx.renderModels !== 'function') return
  let poses
  try { poses = nx.renderModelPoses() } catch (e) { log(2, 'xr.renderModelPoses failed: ' + e) }
  if (!poses) return   // host.json xr.renderModels is off
  let gen = -1
  const byHand = [null, null]
  const kept = new Map()   // id → the page's object, kept while the runtime keeps the model
  function sync() {
    if (poses[0] === gen) return
    gen = poses[0]
    let list = []
    try { list = nx.renderModels() || [] } catch (e) { log(2, 'xr.renderModels failed: ' + e) }
    byHand[0] = byHand[1] = null
    const live = new Set()
    for (const m of list) {
      if ((m.hand !== 0 && m.hand !== 1) || byHand[m.hand]) continue
      const base = HEADER + m.slot * STRIDE
      let model = kept.get(m.id)
      if (!model) {
        model = { id: m.id, glb: m.glb, nodes: m.nodes, tracked: false, pose: null, nodeStates: null }
        kept.set(m.id, model)
      }
      model.base = base
      model.pose = poses.subarray(base + 1, base + 8)
      model.nodeStates = poses.subarray(base + 8, base + 8 + m.nodes.length * 8)
      byHand[m.hand] = model
      live.add(m.id)
    }
    for (const id of kept.keys()) if (!live.has(id)) kept.delete(id)
  }
  Object.defineProperty(XRFrame.prototype, 'getRenderModel', {
    configurable: true, writable: true, enumerable: false,
    value: function getRenderModel(source) {
      if (!source || source.hand) return null   // a tracked hand holds no controller
      sync()
      const model = byHand[source.handedness === 'left' ? 0 : source.handedness === 'right' ? 1 : 2] || null
      if (model) model.tracked = poses[model.base] === 1
      return model
    },
  })
}
