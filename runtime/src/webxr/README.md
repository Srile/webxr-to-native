# runtime/src/webxr — WebXR through IWER's host mode

The WebXR implementation is IWER (Meta's Immersive Web Emulation Runtime, MIT, npm `iwer`, pinned in the root
`package.json`) in its host mode, the `iwer/host` entry (imported as `iwer/lib/host.js`, which both Node and
esbuild resolve). IWER owns the object model: `XRSystem`, `XRSession`, the render state, reference and offset
spaces, poses, views and projection matrices, input sources, gamepads, hands, layers, plane and mesh detection,
and every event. Its host contract is `node_modules/iwer/lib/host/types.d.ts` and its input contract
`node_modules/iwer/HOST-INPUT.md`. This folder is the host's side of that contract over `__native.xr`
(host/js/xr_bind.cpp; the record layouts in `record.js`).

| file | holds |
|---|---|
| `index.js` | `install(g)`: the IWER device and its `XRHostBackend`, `navigator.xr`, the frame and event wiring, the layer subclasses, `initiateRoomCapture` |
| `input.js` | the native input record → IWER's per-hand `XRHostInputState` (controllers, hands, the vision gaze) |
| `scene.js` | the native scene list and pose record → `NativePlane` / `NativeMesh` for `getPlanes` / `getMeshes` |
| `layer-target.js` | the framebuffer behind an `XRWebGLLayer`, in place of IWER's: 4x multisampled, sRGB-correct, the host's depth texture |
| `record.js` | the FIXED frame / input / scene record layouts native writes (`F`, `I`, `S`) |
| `math.js` | mat4 helpers over typed arrays (scene poses) |

`runtime/src/early.js` puts `EventTarget`, `Event` and `DOMException` on the global before any module body
runs: IWER declares `class XRSession extends EventTarget` at module level, and dom-lite's `install()` runs only
after the whole bundle has evaluated. They are the same classes `install()` installs later.

## The frame

`__native.xr.onFrame(cb(frame, input))` (set once at install) calls, for the running session:

1. the input record into IWER's host input (`input.js`; IWER reads it at the frame's start),
2. while visible: the GL context's `__hostXrFrameStart()` (the GL queue's framebuffer bindings start the frame
   at 0) and `_reattachOpaque` (the projection layers' one `colorTexture` names this frame's image wherever the
   page attached it),
3. `device.runHostFrame(hostFrame)`: one object whose `views` and `localPose` are views on native's own frame
   record, rewritten in place. IWER applies the pending render state, places the reference spaces, binds an
   `XRWebGLLayer`, updates planes / meshes / input sources (firing `inputsourceschange`, `select*`,
   `squeeze*`), runs the session's rAF callbacks, then the window's (`backend.runWindowFrame` →
   `g.__hostRunWindowFrame`, also while hidden), then the layer's end of frame,
4. the render state's `depthNear` / `depthFar` to `__native.xr.setDepthRange` when they changed.

Steady frames allocate nothing on the host side; IWER's host path allocates about one heap number per frame
(its changelog, measured with its own benchmark).

## The backend (`XRHostBackend`)

- `beginSwapchain`: the first layer of a session calls it. → `__native.xr.begin({ arraySize, scale, format,
  passthrough?, unpremultiplied?, scene?, srgbLayer?, preferredRate?, foveation? })`; host.json `xr.foveation`
  wins over the Quest Browser's startup features (`high/medium/low-fixed-foveation-level`, which IWER turns
  into 1, 2/3, 1/3). Calls `g.__hostSuspendFlatFrames()`: XR frames drive the window's rAF from then on.
- `endSession` (the page ended it) → `__native.xr.end()`. A native `'end'` event ends it without that call.
  Either way the session's `end` listener here calls `g.__hostResumeFlatFrames()` and forgets its state.
- `requestFrameRate`, `setFixedFoveation`, `setPassthroughVisible` → the native calls of the same purpose.
- `getOpaqueColorTexture`: ONE object per session (`g.__hostOpaqueTexture`, webgl/) whose name follows
  `frame[3]`, as a browser hands out swapchain images. `wrapTexture` → `g.__hostWrapTexture`.
- `autoGrantOfferedSession`: host.json `xr.autoEnter`, until the platform has ended a session (vision: the
  person closed the immersive space); then the page's own button is the way back. The host's `'offer'` event
  (vision's enter button) grants a held offer.
- `getPlanes` / `getMeshes`: `scene.js`, refetched when `frame[39]` (the scene generation) changes, posed from
  `__native.xr.scenePoses()` every frame. A plane the runtime cannot locate in a frame keeps its last pose.
- `invalidateDepth`: host.json `xr.invalidate` (default true). `reportError` → `__native.log` level 3.

## What the host narrows or adds

- `navigator.xr`: `isSessionSupported` / `requestSession` answer from the native state at the time of the call:
  `immersive-vr` when `__native.xr.supported()`, `immersive-ar` only with `caps().passthrough`, no `inline`.
  Features: `viewer`, `local`, `local-floor`, `bounded-floor`, `layers`, `hand-tracking`, the three foveation
  levels, and `plane-detection` / `mesh-detection` in `immersive-ar` with `caps().scene`. A required feature
  outside that rejects with `NotSupportedError`; an optional one is dropped with a log line. A second session
  while one runs rejects with `InvalidStateError`. `supportsSession` is the pre-1.0 shape.
- `XRWebGLLayer` (a subclass of IWER's): the swapchain is asked for sRGB where GL has
  `EXT_sRGB_write_control`, and IWER's layer target is replaced by `layer-target.js` (4x
  `EXT_multisampled_render_to_texture`, the sRGB raw framebuffer, the host's depth texture, one viewport for one
  view). Wonderland Engine draws text with alpha-to-coverage into this framebuffer.
- `XRWebGLBinding` (a subclass of IWER's `XRHostWebGLBinding`): a `'texture'` projection layer gets the host's
  depth texture as `depthStencilTexture` (vision) and, with one view, one sub-image over the whole image.
- `XRSession.prototype.initiateRoomCapture` (Meta's room setup) → `__native.xr.requestSceneCapture()`, resolved
  by the `'scenecapture'` event.
- Input: controllers are Touch (`oculus-touch-v3`, the registry's fallback profiles); the trigger and grip press
  at 0.7 and let go at 0.6, as Quest Browser's. Hands take Quest Browser's gamepad layout (IWER): 0 the index
  pinch, 4 the menu gesture. The vision gaze pinch reaches the page as the right hand's tracked-pointer
  controller with no grip while that hand shows nothing else (IWER's host input has no transient-pointer yet).

## Behaviour that changed with IWER (2026-11-10)

Pages built for a browser see a browser's behaviour in each case:
- `local-floor` is LOCAL's position and heading dropped to the floor, not the STAGE origin.
- `select` fires before `selectend`; a gamepad's `id` is `''`; a hand gamepad is `xr-standard` with 10 buttons.
- A hand without a tracked wrist is not listed.
- An inactive frame throws `InvalidStateError`.
- `detectedPlanes` and `trackedAnchors` are empty sets, not `undefined`.

Small differences from the WebXR IDL that are IWER's:
- `frameRate` and `XRInputSource.hand` are `undefined` rather than `null`.
- A short `fillPoses` array throws a `DOMException`, not a `TypeError`.

Tests: `runtime/test/webxr-*.test.js` against the fake `__native.xr` in `webxr-fake.test.js`. Its `tick()`
fails on anything logged at error level during the frame, so assertions inside rAF callbacks count.
