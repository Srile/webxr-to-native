// draw-calls: n separate meshes, one draw each. The pure per-draw cost: one shared program, a material per mesh
// (its colour is a uniform upload per draw unless ?shared=1), a model matrix per draw, nothing batched.
// ?shadows=1 adds a shadow-map pass (a second draw per mesh).
import { Mesh, BoxGeometry, MeshLambertMaterial, DirectionalLight, AmbientLight, Color, Group } from '@iwsdk/core'
import { startBench, gridPositions } from '../../common/harness.js'

startBench({
  name: 'draw-calls',
  defaults: { n: 300, shared: false, shadows: false },
  build(world, p) {
    const root = new Group(); world.scene.add(root)
    const light = new DirectionalLight(0xffffff, 2); light.position.set(1, 3, 2); root.add(light, new AmbientLight(0x404040, 1))
    world.renderer.shadowMap.enabled = !!p.shadows
    if (p.shadows) { light.castShadow = true; light.shadow.mapSize.set(1024, 1024); Object.assign(light.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2 }) }
    const geo = new BoxGeometry(0.05, 0.05, 0.05)
    const sharedMat = new MeshLambertMaterial({ color: 0x88aaff })
    const meshes = []
    for (const [i, pos] of gridPositions(p.n).entries()) {
      const m = new Mesh(geo, p.shared ? sharedMat : new MeshLambertMaterial({ color: new Color().setHSL((i * 0.618) % 1, 0.6, 0.55) }))
      m.position.set(...pos); m.frustumCulled = false; m.castShadow = m.receiveShadow = !!p.shadows
      root.add(m); meshes.push(m)
    }
    return {
      update(dt, t) { for (let i = 0; i < meshes.length; i++) { meshes[i].rotation.set(t * 0.5, t + i * 0.1, 0) } },
      dispose() { root.removeFromParent(); geo.dispose(); sharedMat.dispose(); for (const m of meshes) if (m.material !== sharedMat) m.material.dispose() },
    }
  },
})
