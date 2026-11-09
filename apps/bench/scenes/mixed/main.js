// mixed: what an IWSDK app's frame looks like more than any single stress does: a floor, a shadow-casting light,
// opaque props over a handful of materials, transparent props (sorted back to front every frame), a few skinned
// figures and an instanced field. n scales the prop count; the draw count is roughly 2n (shadow pass included).
import {
  Mesh, InstancedMesh, SkinnedMesh, Skeleton, Bone, BoxGeometry, SphereGeometry, PlaneGeometry, CylinderGeometry, ConeGeometry,
  MeshStandardMaterial, MeshLambertMaterial, MeshPhongMaterial, Float32BufferAttribute, Uint16BufferAttribute,
  DirectionalLight, HemisphereLight, Group, Color, Object3D, DoubleSide,
} from '@iwsdk/core'
import { startBench } from '../../common/harness.js'

startBench({
  name: 'mixed',
  defaults: { n: 150 },
  build(world, p) {
    const r = world.renderer; r.shadowMap.enabled = true
    const root = new Group(); world.scene.add(root)
    const sun = new DirectionalLight(0xffffff, 2.5); sun.position.set(2, 4, 1); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024)
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 }); root.add(sun, new HemisphereLight(0xbbddff, 0x443322, 1))
    const floor = new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ color: 0x556655, roughness: 0.9 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; root.add(floor)
    const geos = [new BoxGeometry(0.12, 0.12, 0.12), new SphereGeometry(0.07, 12, 8), new CylinderGeometry(0.05, 0.05, 0.15, 10), new ConeGeometry(0.06, 0.14, 10)]
    const matKinds = [(c) => new MeshStandardMaterial({ color: c, roughness: 0.5 }), (c) => new MeshLambertMaterial({ color: c }), (c) => new MeshPhongMaterial({ color: c, shininess: 60 })]
    const props = [], mats = []
    for (let i = 0; i < p.n; i++) {
      const a = i * 2.39996, rad = 0.8 + 2.2 * Math.sqrt(i / p.n), transparent = i % 6 === 0
      const mat = matKinds[i % 3](new Color().setHSL((i * 0.618) % 1, 0.55, 0.55))
      if (transparent) { mat.transparent = true; mat.opacity = 0.5; mat.side = DoubleSide }
      const m = new Mesh(geos[i % geos.length], mat); m.position.set(Math.cos(a) * rad, 0.2 + (i % 5) * 0.25, -Math.abs(Math.sin(a) * rad) - 0.5)
      m.castShadow = !transparent; m.receiveShadow = true; m.frustumCulled = false; root.add(m); props.push(m); mats.push(mat)
    }
    // A few skinned figures.
    const figs = []
    for (let f = 0; f < 6; f++) {
      const B = 12, h = 0.5, g = new CylinderGeometry(0.03, 0.05, h, 8, B * 2, true), pos = g.attributes.position, si = [], sw = []
      for (let i = 0; i < pos.count; i++) { const y = Math.min(Math.max((pos.getY(i) + h / 2) / h * (B - 1), 0), B - 1), b = Math.min(Math.floor(y), B - 1); si.push(b, Math.min(b + 1, B - 1), 0, 0); sw.push(1 - (y - b), y - b, 0, 0) }
      g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4))
      const bones = []; let par = null; for (let b = 0; b < B; b++) { const bn = new Bone(); bn.position.y = b ? h / (B - 1) : -h / 2; par?.add(bn); bones.push(bn); par = bn }
      const mat = new MeshStandardMaterial({ color: 0xddaa77 }); const sm = new SkinnedMesh(g, mat); sm.add(bones[0]); sm.bind(new Skeleton(bones))
      sm.position.set(-1.2 + f * 0.5, 0.25, -1.6); sm.castShadow = true; sm.frustumCulled = false; root.add(sm); figs.push({ sm, bones }); mats.push(mat)
    }
    // An instanced field of grass blades.
    const blade = new ConeGeometry(0.01, 0.12, 3), grassMat = new MeshLambertMaterial({ color: 0x66aa44 })
    const grass = new InstancedMesh(blade, grassMat, 3000), o = new Object3D()
    for (let i = 0; i < 3000; i++) { o.position.set((Math.random() - 0.5) * 6, 0.06, -Math.random() * 4); o.rotation.y = Math.random() * 6; o.updateMatrix(); grass.setMatrixAt(i, o.matrix) }
    grass.frustumCulled = false; root.add(grass)
    return {
      update(dt, t) {
        for (let i = 0; i < props.length; i++) props[i].rotation.set(t * 0.3, t * 0.6 + i, 0)
        for (let f = 0; f < figs.length; f++) for (let b = 1; b < figs[f].bones.length; b++) figs[f].bones[b].rotation.z = Math.sin(t * 2 + f + b * 0.5) * 0.2
      },
      dispose() { root.removeFromParent(); r.shadowMap.enabled = false; for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); floor.geometry.dispose(); floor.material.dispose(); blade.dispose(); grassMat.dispose(); grass.dispose(); for (const { sm } of figs) { sm.geometry.dispose(); sm.skeleton.dispose() } },
    }
  },
})
