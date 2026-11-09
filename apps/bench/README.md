# apps/bench: IWSDK stress scenes, browser vs host

Five scenes built on the Immersive Web SDK (`@iwsdk/core`, three.js underneath), one per subfolder of `scenes/`,
each a page that runs unchanged in Quest Browser and in the host (its own `host.json`). They exist to measure one
thing: what a frame costs the page's thread as draw calls grow, on both sides, on the headset.

| scene | what grows with `n` | what it stresses |
|---|---|---|
| `draw-calls` | n meshes, one draw each, one program | the bare per-draw cost: a model matrix and a colour per draw (`?shared=1`: one material; `?shadows=1`: a shadow pass, two draws per mesh) |
| `materials` | n meshes over all eight built-in materials, a texture each | program switches, texture binds, per-material uniforms: varied content |
| `skinned` | n skinned meshes, 16 animated bones each | a bone-texture upload and a draw per mesh: per-frame data uploads |
| `instanced` | n instances of one InstancedMesh | the control: two draws, the same JS per object, one large buffer upload |
| `mixed` | n props plus a floor, a shadow light, transparent props, six skinned figures, an instanced field | an app-like frame; about 2n draws with the shadow pass |

Every object sits on a wall in front of the viewer with frustum culling off, so the draw count does not move with
the head.

## The harness

`common/harness.js` starts an IWSDK `World` (immersive-vr, offered at once), times every XR animation-frame
callback (`jsP50`/`jsP99`: the page's work per frame, including whatever its GL calls cost on its thread), the
interval between callbacks (`fps`, `droppedPct`) and three's draw count, and exposes `window.__bench`:

- `configure({ n, ... })` rebuilds the scene; `sample(seconds)` returns the frame stats;
- `ramp({ from, to, step, seconds })` samples every n; the knee is the largest n before the first step that
  missed the frame rate (97 % of it, under 2 % dropped).

Both sides run at 72 Hz (the harness asks the session for it; the scenes' `host.json` asks the same).

## Running

```sh
(cd apps/bench && npm install && npm run build)                      # dist/<scene>/
node tools/bench.mjs browser materials --ramp 200,1600,200          # Quest Browser over CDP
node tools/bench.mjs host materials --ramp 200,1600,200 --pack      # the scene's APK (--pack builds it first)
node tools/bench.mjs host materials --n 600 --glthread 1            # one sample, the GL thread on for this run
node tools/bench.mjs both skinned --n 120 --out /tmp/skinned.json   # browser, then host
```

The headset must be worn. `--glthread 0|1` sets `debug.webxr.glthread` and `--pipeline 0|1`
`debug.webxr.glpipeline`, which the host reads at start over `host.json gl.thread` / `gl.pipeline`, so one APK
serves every A/B. Each step also records the CPU/GPU clocks the runtime reported (VrApi): the Quest raises them
when frames miss, so compare at like clocks. The browser side serves `dist/` from this machine through
`adb reverse` and enters the session with a CDP user gesture.

