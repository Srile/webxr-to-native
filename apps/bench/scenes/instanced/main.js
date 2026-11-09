// instanced: the draw-calls scene's objects as ONE InstancedMesh (n instances, matrices rewritten every frame and
// uploaded with one bufferSubData). The control: almost no draws, the same JS work per object, a large upload.
import { InstancedMesh, BoxGeometry, MeshLambertMaterial, DirectionalLight, AmbientLight, Group, Object3D, Color } from '@iwsdk/core'
import { startBench, gridPositions } from '../../common/harness.js'

startBench({
  name: 'instanced',
  defaults: { n: 2000 },
  build(world, p) {
    const root = new Group(); world.scene.add(root)
    const dl = new DirectionalLight(0xffffff, 2); dl.position.set(1, 3, 2); root.add(dl, new AmbientLight(0x404040, 1))
    const geo = new BoxGeometry(0.03, 0.03, 0.03), mat = new MeshLambertMaterial()
    const im = new InstancedMesh(geo, mat, p.n); im.frustumCulled = false; root.add(im)
    const pos = gridPositions(p.n), o = new Object3D(), c = new Color()
    for (let i = 0; i < p.n; i++) im.setColorAt(i, c.setHSL((i * 0.618) % 1, 0.6, 0.55))
    return {
      update(dt, t) {
        for (let i = 0; i < p.n; i++) { o.position.set(...pos[i]); o.rotation.set(t * 0.5, t + i * 0.1, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix) }
        im.instanceMatrix.needsUpdate = true
      },
      dispose() { root.removeFromParent(); geo.dispose(); mat.dispose(); im.dispose() },
    }
  },
})
