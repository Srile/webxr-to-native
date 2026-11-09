// materials: n meshes over every built-in material three has, each with its own texture: program switches,
// texture binds and per-material uniform uploads between draws, as a scene with varied content has.
import {
  Mesh, IcosahedronGeometry, TorusKnotGeometry, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial,
  MeshPhysicalMaterial, MeshToonMaterial, MeshNormalMaterial, MeshMatcapMaterial, DataTexture, RGBAFormat, SRGBColorSpace,
  DirectionalLight, AmbientLight, PointLight, Group, Color,
} from '@iwsdk/core'
import { startBench, gridPositions } from '../../common/harness.js'

const KINDS = [MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial, MeshNormalMaterial, MeshMatcapMaterial]

function texture(i) {
  const s = 16, d = new Uint8Array(s * s * 4), c = new Color().setHSL((i * 0.618) % 1, 0.7, 0.5)
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = (y * s + x) * 4, on = ((x >> 2) + (y >> 2)) & 1
    d[k] = on ? c.r * 255 : 255; d[k + 1] = on ? c.g * 255 : 255; d[k + 2] = on ? c.b * 255 : 255; d[k + 3] = 255
  }
  const t = new DataTexture(d, s, s, RGBAFormat); t.colorSpace = SRGBColorSpace; t.needsUpdate = true; return t
}

startBench({
  name: 'materials',
  defaults: { n: 300, textures: 64 },
  build(world, p) {
    const root = new Group(); world.scene.add(root)
    const dl = new DirectionalLight(0xffffff, 2); dl.position.set(1, 3, 2)
    const pl = new PointLight(0xffaa66, 3, 6); pl.position.set(0, 2, -1.5)
    root.add(dl, pl, new AmbientLight(0x404040, 1))
    const geos = [new IcosahedronGeometry(0.03, 1), new TorusKnotGeometry(0.02, 0.007, 32, 6)]
    const texs = Array.from({ length: Math.max(1, p.textures) }, (_, i) => texture(i))
    const meshes = [], mats = []
    for (const [i, pos] of gridPositions(p.n).entries()) {
      const Kind = KINDS[i % KINDS.length], tex = texs[i % texs.length]
      const mat = Kind === MeshNormalMaterial ? new Kind() : Kind === MeshMatcapMaterial ? new Kind({ matcap: tex }) : new Kind({ map: tex, color: 0xffffff })
      if (mat.roughness !== undefined) { mat.roughness = 0.4; mat.metalness = 0.3 }
      const m = new Mesh(geos[i & 1], mat); m.position.set(...pos); m.frustumCulled = false
      root.add(m); meshes.push(m); mats.push(mat)
    }
    return {
      update(dt, t) { for (let i = 0; i < meshes.length; i++) meshes[i].rotation.set(t * 0.4, t + i * 0.05, 0) },
      dispose() { root.removeFromParent(); for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); for (const t of texs) t.dispose() },
    }
  },
})
