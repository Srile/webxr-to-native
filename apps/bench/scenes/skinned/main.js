// skinned: n skinned meshes, each with its own skeleton animated every frame: a bone-texture upload and a draw per
// mesh, the data-upload half of a frame (characters, crowds).
import {
  SkinnedMesh, Skeleton, Bone, CylinderGeometry, MeshStandardMaterial, Float32BufferAttribute, Uint16BufferAttribute,
  DirectionalLight, AmbientLight, Group, Color,
} from '@iwsdk/core'
import { startBench, gridPositions } from '../../common/harness.js'

function skinnedGeometry(bones, h) {
  const g = new CylinderGeometry(0.01, 0.015, h, 6, bones * 2, true)
  const pos = g.attributes.position, idx = [], wts = []
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + h / 2, f = Math.min(Math.max((y / h) * (bones - 1), 0), bones - 1), b = Math.min(Math.floor(f), bones - 1), w = f - b  // clamped: the bottom ring rounds to -1e-7
    idx.push(b, Math.min(b + 1, bones - 1), 0, 0); wts.push(1 - w, w, 0, 0)
  }
  g.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4)); g.setAttribute('skinWeight', new Float32BufferAttribute(wts, 4))
  return g
}

startBench({
  name: 'skinned',
  defaults: { n: 100, bones: 16 },
  build(world, p) {
    const root = new Group(); world.scene.add(root)
    const dl = new DirectionalLight(0xffffff, 2); dl.position.set(1, 3, 2); root.add(dl, new AmbientLight(0x404040, 1))
    const h = 0.18, geo = skinnedGeometry(p.bones, h)
    const meshes = [], mats = []
    for (const [i, pos] of gridPositions(p.n).entries()) {
      const bones = []; let parent = null
      for (let b = 0; b < p.bones; b++) { const bone = new Bone(); bone.position.y = b === 0 ? -h / 2 : h / (p.bones - 1); if (parent) parent.add(bone); bones.push(bone); parent = bone }
      const mat = new MeshStandardMaterial({ color: new Color().setHSL((i * 0.618) % 1, 0.6, 0.5), roughness: 0.6 })
      const m = new SkinnedMesh(geo, mat); m.add(bones[0]); m.bind(new Skeleton(bones))
      m.position.set(...pos); m.frustumCulled = false; root.add(m); meshes.push({ m, bones }); mats.push(mat)
    }
    return {
      update(dt, t) {
        for (let i = 0; i < meshes.length; i++) { const bs = meshes[i].bones; for (let b = 1; b < bs.length; b++) bs[b].rotation.z = Math.sin(t * 2 + i * 0.3 + b * 0.4) * 0.25 }
      },
      dispose() { root.removeFromParent(); geo.dispose(); for (const m of mats) m.dispose(); for (const { m } of meshes) m.skeleton.dispose() },
    }
  },
})
