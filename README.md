# webxr-to-native

Run an unmodified WebXR web game as a native app on Meta Quest and the Steam Frame, without a browser.

> This is a fork of [Srile/webxr-to-native](https://github.com/Srile/webxr-to-native), kept merged with it. It adds
> [Steam Frame support](#steam-frame) and what came up on the way there: a fuller Canvas 2D (anti-aliased fills,
> dashes, transforms, the whole SVG path grammar, fallback and colour-emoji fonts, a text cache), `<audio>`
> elements, AAC decoding, a Steamworks module, and a fix for WebSocket messages over 16 KiB on TLS. On upstream's
> WebRTC voice (whose jitter margin and FEC came from here) it adds receiver reports, so a browser peer puts FEC in
> what it sends, and browser-like renegotiation. Each is listed below where it belongs.

The game stays a web app: a three.js / IWSDK, Wonderland Engine or plain WebGL 2 build with its `index.html` and
assets. webxr-to-native is the runtime underneath:
- **Script:** V8 runs it.
- **Graphics:** WebGL 2 is bound straight to the headset's OpenGL ES driver.
- **XR:** WebXR is [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) in host mode, driven by
  OpenXR frames.
- **Audio:** WebAudio is a native audio graph.
- **The rest:** fetch reads the bundled assets and the network.

The result is an ordinary native APK, release-signed for the Meta Horizon Store or a Steam depot. It has no WebView, no browser
chrome and no browser cost per frame. A WebGL-heavy page often spends less time per frame than it does in Quest
Browser, because the GL calls go straight to the driver (on a GL thread of their own by default).

The same runtime runs the game on Android phones (flat, with touch controls drawn as a gamepad), and in an
emulated headset on macOS, Windows, Linux, iOS and the Apple Vision Pro simulator. Those hosts are for
development and experiments; the Quest is the main target, and the Steam Frame runs this toolkit's APKs too.

## Status

| Host | State |
|---|---|
| Meta Quest (`host/android`, OpenXR) | the main target: three.js/IWSDK and Wonderland Engine games on Quest 2 and Quest 3, at the headset's refresh rate (72 to 120 Hz), multiview, controllers and hands; passthrough AR and plane/mesh detection are built but less tested |
| Steam Frame (`host/android` in Valve's Lepton, on SteamVR's OpenXR) | working: immersive games at up to 90 Hz with multiview, controllers (drawn from SteamVR's own models), passthrough, `local-floor`, WebRTC voice, and Steamworks (account, ownership, friends, lobbies and invitations, rich presence) when Steam launches the APK; hand tracking is reported but less tested; no refresh-rate or foveation control. See [Steam Frame](#steam-frame) |
| Android phones (`android.formFactor: "phone"`) | in progress: flat games with on-screen touch controls run on a Pixel 7 Pro, WebSocket and WebRTC data channels when a game asks for them |
| macOS (`host/mac`) | experimental: the game in a window with an emulated headset (mouse aims, right-drag looks, WASD walks); can package a self-contained `.app` |
| Windows (`host/win`) | experimental: the same window host on ANGLE/Direct3D 11; builds natively or cross-compiles from a Mac |
| Linux (`host/linux`) | experimental: the window host on the system's GLES 3.2 (Mesa or NVIDIA); a second binary runs the Quest's OpenXR device on Monado or WiVRn |
| iOS (`host/ios`) | experimental: touch-driven, ANGLE on Metal, WebAssembly through WAMR; runs in the simulator |
| Apple Vision Pro (`host/vision`) | experimental, simulator only: mixed immersion through Compositor Services, gaze and pinch as input |

## What the page gets

- **JavaScript**: V8 (Android: V8 14.9 with the JIT), ES modules, dynamic `import()`, `import.meta.url`, Workers,
  WebAssembly (V8's, or WAMR's interpreter where V8 has none), `structuredClone`, timers, `requestAnimationFrame`.
  `Intl` with the device's locale and time zone (on Android opt-in with `js.intl`, which links a V8 with ICU).
- **WebGL 2** over the device's GLES 3.2:
  - The extensions three.js and Wonderland probe, including `OVR_multiview2` and `WEBGL_multi_draw` (as
    indirect draws where the driver has them).
  - Compressed textures (ASTC, ETC2), `EXT_disjoint_timer_query_webgl2`, `KHR_parallel_shader_compile`.
  - WebGL's own rules are kept: `UNPACK_FLIP_Y_WEBGL` and premultiplication, std140 uniform blocks, the implicit
    clear of the drawing buffer.
  - On the Quest the GL calls are recorded into a ring and run on a GL thread, as a browser's GPU process does.
- **WebXR** through [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) 2.8 in host mode:
  - **Sessions:** `immersive-vr`, and `immersive-ar` with passthrough (the passthrough layer extension, or the
    runtime's alpha-blend environment mode where there is none, as on the Steam Frame). `offerSession` is supported.
  - **Spaces:** `local`, `local-floor` and `bounded-floor` reference spaces; `xr.baseSpace: "local-floor"` makes
    `XR_EXT_local_floor` the base space where the runtime has it.
  - **Layers:** projection layers (`XRWebGLBinding`, texture arrays for multiview), and `XRWebGLLayer` with 4x MSAA.
  - **Input:** Touch controllers with gamepads and haptics, hand tracking with 25 joints, the hand's menu gesture;
    the input profile names the page sees are configurable (`xr.controllerProfiles`).
  - **Controller models:** with `xr.renderModels`, the runtime's own (`XR_EXT_render_model`) as
    `XRFrame.getRenderModel(inputSource)`, an addition, not a WebXR API: the model's glTF, its origin in the grip
    space, and the poses of its animated nodes (trigger, thumbstick) every frame.
  - **Session control:** refresh rates, fixed foveation, visibility events.
  - **Scene:** plane and mesh detection, and room setup (`initiateRoomCapture`).
- **WebAudio**:
  - A native graph, rendered on the audio thread: gain, buffer sources, oscillators, biquad, compressor, panner,
    listener, `OfflineAudioContext`.
  - `decodeAudioData` takes WAV, Ogg Vorbis, Ogg Opus, WebM (Opus, Vorbis), MP3, and on Android AAC (MP4/M4A,
    ADTS) through MediaCodec.
  - `<audio>` and `new Audio()` (opt-in, `audio.elements`): played through the graph, fetched and decoded whole
    (volume, `muted`, pause, `ended`); a `srcObject` stream plays live.
  - `AnalyserNode`, and, opt-in with `media.microphone`, the microphone: `getUserMedia({ audio })` (the headset's
    permission prompt, echo cancellation) into a `MediaStreamAudioSourceNode`.
- **Network and storage**:
  - `fetch` and `XMLHttpRequest` read from the bundled assets, and from an allow-list of HTTPS origins.
  - `localStorage` and `Blob` URLs.
  - Opt-in per game:
    - WebSocket and WebRTC data channels; with `media.microphone` too, WebRTC audio tracks (`addTrack`,
      `addTransceiver`, `ontrack`): Opus over SRTP, the microphone sent, each peer's audio a track that
      `createMediaStreamSource` and `<audio srcObject>` play. Interoperates with Chrome and Quest Browser peers.
      Incoming voice is read behind a jitter margin that follows the network (60 to 240 ms), lost packets come back
      from Opus's in-band FEC, and the log says every 5 s how each voice arrived.
    - IndexedDB and the Cache API, on SQLite, kept across launches, in the page and in workers.
    - Service workers. A registered worker answers the page's loads as `FetchEvent`s, and controls the page from
      the start of the next launch.
- **Images**: `createImageBitmap`, `<img>`, PNG, JPEG and WebP decoding off the main thread, and a Canvas 2D
  subset for UI: paths and `Path2D` (from SVG path data too, every command), anti-aliased fills, strokes with
  dashes, `roundRect`, `arcTo`, transforms with rotation, clipping, compositing, drawing images. Opt-in: text
  drawing with `FontFace` fonts (`web.canvasText`), falling back to the platform's symbol, CJK and colour emoji
  fonts, with synthetic bold for weights a face lacks and rasterised text kept between draws; and SVG images
  (`web.svg`).
- **The page**:
  - A light DOM: `document`, the elements `index.html` declares, events, pointer and keyboard input outside XR.
  - `index.html`'s classic inline scripts, run before the entry as in a browser (opt-in: `web.inlineScripts`).
  - `navigator.userAgent` reads like Quest Browser's (Chrome for Android's in a phone build).
  - `navigator.horizon` exposes the Meta Platform SDK (entitlement, user, leaderboards, achievements) when the
    app bundles it.
  - Steamworks, with `steam.appId`: `__native.steam` (the account, Web API tickets, ownership, friends, lobbies and
    invitations, rich presence, join requests), for the game's own bridge to build on; not a web API.
  - `window.close()` ends the app.

What it does not do:
- The page's HTML and CSS are never laid out or drawn: there is no layout engine. Menus have to be in the 3D
  scene. Where a page's HTML UI would make a choice (a "VR" button, a privacy prompt), a short boot script can
  make it: `web.inject` below.
- No `<video>` playback (`<audio>` with `audio.elements`), no camera, no WebGPU.

## How it works

```
 the game's dist/ (unmodified)          index.html, its module entry, assets
 ─────────────────────────────────────────────────────────────────────────────────
 runtime/   host-runtime.js             the browser surface in JS: DOM-lite, fetch, WebGL 2 wrapper,
                                        WebXR (IWER), WebAudio, workers, images; esbuild bundle
 ─────────────────────────────────────────────────────────────────────────────────
 __native   C++ bindings                gl.* (one function per GL entry point, typed arrays by pointer),
                                        xr.*, audio.*, net.*, img.*, loop.*, store.*, worker.*
 ─────────────────────────────────────────────────────────────────────────────────
 host/      C++20                       V8 embedder, event loop, EGL, OpenXR, Oboe/AAudio, HTTP, decoders
```

One process, one host thread that is the page's main thread: it runs V8, the event loop and the XR frame loop.
Workers run their own isolates, audio renders on its own thread, and on the Quest a GL thread runs the page's GL
calls.

Every XR frame, native writes a frame record (view poses and fields of view, the swapchain image) and an input
record (controllers, hands) into shared typed arrays. It then calls into JS once. IWER builds the `XRFrame`,
fires input events and runs the page's callbacks. Steady frames allocate nothing on the host side, so garbage
collection runs after the frame is submitted, not in the middle of it.

## Getting started on a Quest

You need:
- A Mac (arm64 or x64) or an x86_64 Linux machine, with Node 18+, CMake 3.22+, Ninja, curl and unzip.
- A Quest in developer mode, connected over USB.

```sh
git clone https://github.com/sherbondy/webxr-to-native.git && cd webxr-to-native
npm ci                     # esbuild and IWER
./tools/setup.sh           # JDK, Android SDK + NDK r27, V8, OpenXR loader, Oboe, stb, dr_mp3, libopus, libwebp, nanosvg
source tools/env.sh        # puts the repo-local adb, NDK and JDK on PATH
node tools/device.mjs status
node tools/pack.mjs apps/hello-xr/host.json --install --run    # a stereo clear and a cube, no JS
node tools/pack.mjs apps/hello-js/host.json --install --run    # V8, modules, fetch, WebAssembly, timers
```

`tools/setup.sh` installs everything into `tools/sdk/` and `third_party/` (both gitignored). It installs nothing
globally and needs no sudo. Running it accepts the Android SDK licence on your behalf (`sdkmanager --licenses`),
so read it at https://developer.android.com/studio/terms first. XR apps only render while the headset is worn.

### Your game

1. Build the web app as you would for the browser (`vite build` or similar).
2. Write a `host.json` that points at the build. It can live in your game's repository, typically in `native/`:

   ```json
   {
     "app": { "name": "My Game", "package": "com.example.mygame", "icon": "../public/icon-512.png" },
     "web": { "dist": "../dist", "origin": "https://mygame.example" },
     "network": { "allow": ["https://api.mygame.example"] },
     "xr": { "autoEnter": true, "preferredRate": 90 }
   }
   ```

3. Pack, install and run it:

   ```sh
   node tools/pack.mjs ../my-game/native/host.json --install --run
   # or name the repo: the builders find native/host.json or host.json in it
   npm run quest ../my-game
   ```

`pack.mjs` copies the build into the APK's assets and reads the module entry out of `index.html`. Unless the game
turns on `js.intl`, it also rewrites what V8 without ICU cannot parse (Unicode property escapes in regexes). Then it
builds the native library and packs, signs, installs and starts the APK.

### Release builds

```sh
KEYSTORE_PASS=... KEYSTORE_ALIAS=... node tools/pack.mjs ../my-game --release --keystore my.keystore
```

A release build is signed with your keystore. The passwords are passed to apksigner as environment references,
never as arguments. The inspector is off in a release build, and the runtime ships minified without its source
map (0.7 MB instead of 2.6). Uploading to a store is up to the game (Meta's `ovr-platform-util` takes the APK as it
is).

## Steam Frame

The Frame runs Android apps in Lepton, Valve's Android 11 container on SteamOS, so an APK from this toolkit runs
there too, on SteamVR's OpenXR runtime (2.19.2 when this was written): GLES 3.2 through Mesa (Zink on Turnip,
Adreno 750), `XR_KHR_opengl_es_enable`, multiview, controllers, hand tracking, `XR_EXT_local_floor`, the opaque
and alpha-blend environment modes (alpha blend is its passthrough), and `XR_EXT_render_model`. It renders at
90 Hz; the refresh-rate and foveation calls fail harmlessly, and its swapchains are sRGB only. A host.json for it:

```json
"xr": {
  "autoEnter": true, "preferredRate": 90, "baseSpace": "local-floor",
  "controllerProfiles": ["valve-frame-controller", "generic-trigger-squeeze-thumbstick"],
  "renderModels": true, "srgbSwapchain": true
}
```

- `srgbSwapchain`: SteamVR offers no RGBA8 swapchain and the Frame's GL has no `EXT_sRGB_write_control`, so a
  page's already-encoded colours were encoded again (everything pale) and the first format offered had no alpha
  (passthrough blended wrongly). With it the page draws into RGBA8 views of `SRGB8_ALPHA8` images.
- `controllerProfiles`: SteamVR binds the Frame's controllers to the Touch profile the host asks for; these
  names let the page pick its mapping and models for them.
- `renderModels`: the controllers drawn from SteamVR's own models; nothing of Valve's is packed into the APK.
- `immersive-ar` is passthrough through alpha blend: the page's transparent pixels show the room.

### A development build

1. Start "Lepton Development" from the Frame's Steam library: no Lepton container runs until something starts one.
2. Reach its adb: with the Frame on USB, `adb -s <frame serial> forward tcp:5555 tcp:5555 && adb connect
   localhost:5555`, or over the network as [Valve's page](https://partner.steamgames.com/doc/steamhardware/steamframe/adb_lepton)
   describes.
3. Pack with `--out` and install with your own adb: `adb -s localhost:5555 install -r -g app.apk`, then
   `adb -s localhost:5555 shell am start -n <package>/android.app.NativeActivity`.

Use your own adb throughout: `tools/device.mjs`, `--install`/`--run` and `bridge.mjs` use the repository's newer
adb, which restarts the adb server and drops the forward. For the bridge, forward its port and point it here:
`adb -s localhost:5555 forward tcp:9240 tcp:9240`, then `HOST_LOCAL=1 HOST_PORT=9240 node tools/bridge.mjs stats`.
The session only becomes visible while the headset is worn.

### Steamworks

Set `steam.appId`, and point `steam.lib` at the Steamworks SDK's `redistributable_bin/androidarm64/libsteam_api.so`
(not in this repository: copy it from your SDK). The APK carries it and opens it at runtime against the Steam client
Lepton provides. Steam lets an app talk to it only as itself, and a development install runs inside Lepton
Development, an app of its own (3056000): there `init` fails with "ConnectToGlobalUser failed" for your app id.
Test Steam features from a Steam launch.

### Shipping on Steam

[Valve's guide](https://partner.steamgames.com/doc/steamhardware/steamframe/apk_upload), in short: an Android
depot (SteamPipe › Depots, Operating System Android) with the release APK at its top level, a launch option with
that APK as its Executable and Operating System Android, and the depot in the app's packages. Sign every update
with the same key (`--release --keystore`): Android won't install an APK over one signed with another.

- Steam launches the APK in a container of its own (`lepton-steamlaunch-<app id>`) and installs it from the depot
  at each launch. The container's logcat is copied to `~/.local/share/Steam/logs/lepton-steamlaunch-<app id>.log`
  on the Frame, and its adb answers on 5555 while it runs. `adb install -r` over the running app ends it, and
  Lepton then stops the container; to try a build in a Steam launch, replace the APK in the game's install folder
  instead (`steamapps/common/<game>/`) and launch again. Steam puts its own back at the next update.
- When the app has Windows, macOS or Linux builds too, Steam on the Frame installs the Linux one (through FEX).
  The player picks the Android build with the "Lepton" compatibility tool (the game's Properties › Compatibility);
  when this was written no Steamworks setting chose it: Valve sets a Frame default per app.

## host.json

Paths are relative to the `host.json`. Every key is optional except `app.package` for an APK and `web.dist` for a
game. The web features a WebGL game rarely needs (Intl on Android, the microphone, IndexedDB, the Cache API,
service workers, Canvas text, SVG, inline scripts, WebRTC) are off unless the game turns them on. A game that
leaves one off carries none of its native code or permissions, and its page does not see the API.

| Key | Default | Meaning |
|---|---|---|
| `app.name`, `app.package` | | the app's label and Android application id |
| `app.icon` | the toolkit's icon | a square PNG, turned into the launcher, `.app` and `.exe` icons |
| `app.splash` | | an image the Quest shows instead of its loading void until the first frame |
| `app.version` | the game's `package.json` version | the version name |
| `app.orientation` | `landscape` | phones: `landscape`, `portrait` or `any` |
| `app.metaAppId` | | the Meta Platform SDK app id (`navigator.horizon`) |
| `web.dist` | | the built web app |
| `web.origin` | `https://app.local` | the page's `location.origin`; relative URLs resolve against it |
| `web.query` | | appended to `location.search` |
| `web.remote` | `[]` | same-origin path prefixes (`"/api/"`) fetched from `web.origin` over the network instead of the packed files |
| `web.exclude` | | globs of files not to pack (`*.map`, …) |
| `web.inject` | | the game's own boot scripts, imported before the entry: where the HTML UI would have made a choice |
| `web.startGesture` | `false` | phones: treat launch as the first tap, for pages that wait for one before starting sound |
| `web.inlineScripts` | `false` | run `index.html`'s classic inline scripts before the entry |
| `web.canvasText` | `false` | Canvas 2D `fillText`/`measureText` and `FontFace` (stb_truetype); off, text is measured by estimate and not drawn |
| `web.svg` | `false` | SVG images (nanosvg) |
| `web.serviceWorker` | `false` | `navigator.serviceWorker`; `debug.serviceWorker` logs every load it answers |
| `network.allow` | `[]` | origins `fetch`, XHR and WebSocket may reach; everything else is refused |
| `network.webrtc` | `false` | build WebSocket and WebRTC data channels (libdatachannel) into this game; with `media.microphone`, audio tracks too (libsrtp, Opus) |
| `storage.indexedDB`, `storage.cache` | `false` | IndexedDB, the Cache API (SQLite, under the app's files) |
| `storage.quotaMB` | `1024` | the origin's databases together; past it a write fails with `QuotaExceededError` |
| `media.microphone` | `false` | `getUserMedia` for audio; adds the `RECORD_AUDIO` permission, asked for on first use (Android, macOS) |
| `js.intl` | `false` | Android: link the V8 with ICU (+4.5 MB APK) for `Intl`; the other hosts always have it |
| `xr.autoEnter` | `false` | grant the page's `offerSession` at launch (enter XR without a click) |
| `xr.preferredRate` | the runtime's | display refresh rate to ask for (72, 80, 90, 120) |
| `xr.foveation` | the page's | fixed foveation 0..1, overriding what the page sets |
| `xr.foveationDynamic` | `false` | let the runtime lower foveation when the GPU has headroom |
| `xr.invalidate` | `true` | discard depth after each frame (saves bandwidth on tilers) |
| `xr.baseSpace` | `stage` | `local-floor`: the base space is `XR_EXT_local_floor` where the runtime has it |
| `xr.controllerProfiles` | Touch's | the WebXR input profiles the page sees for the controllers, most specific first |
| `xr.renderModels` | `false` | the runtime's own controller models (`XR_EXT_render_model`) as `XRFrame.getRenderModel(inputSource)` |
| `xr.srgbSwapchain` | `false` | an sRGB swapchain with alpha, drawn through RGBA8 texture views (runtimes with no RGBA8 swapchain and GL without `EXT_sRGB_write_control`) |
| `audio.elements` | `false` | `<audio>` / `new Audio()` play through the Web Audio graph (fetched and decoded whole) |
| `steam.appId`, `steam.lib` | | Steamworks (`__native.steam`, host/steam/steam_bind.cpp): the app id and the Steamworks SDK's Android `libsteam_api.so`, packed into the APK and opened at runtime against the device's Steam client (the Steam Frame's Android container provides `libsteamclient.so`) |
| `xr.clearFrame` | `false` | clear an `XRWebGLLayer` before each frame, as a browser does (one queued GL op); for engines that do not clear it themselves, like Wonderland |
| `xr.perf` | | CPU/GPU performance levels (`XR_EXT_performance_settings`): `{ enabled, start, adaptive, … }` |
| `gl.thread` | `true` (Quest) | run the page's GL calls on a GL thread; `adb shell setprop debug.webxr.glthread 0` overrides it |
| `gl.pipeline` | `false` | with the thread: record the next XR frame while the GL thread draws this one (one frame more latency) |
| `gl.threadRingMB` | `8` | the GL thread's command ring |
| `gl.antialias` | `false` | flat frames: honour the page's `antialias` with a 4x multisampled drawing buffer |
| `gl.multiDrawIndirect` | `true` | `WEBGL_multi_draw` as one indirect draw per call where the driver can |
| `gl.withholdExtensions` | `[]` | WebGL extension names to hide from the page |
| `gc.*` | | when V8 collects garbage: `enabled`, `semiSpaceMB` (16), `minorAfterSubmit` (0.25), `idle`, `idleMarginMs`, `flags` |
| `audio.maxNodes` | `512` | the audio graph's node limit |
| `android.formFactor` | `quest` | `phone` builds a phone APK: no OpenXR, a phone manifest, touch input |
| `android.frameRate` | `60` | phones: the page's frame rate on a 90/120 Hz display |
| `touchControls` | | phones: sticks and buttons drawn over the frame and handed to the page as a standard gamepad (`host/gl/touch_controls.h` has the layout); `showWhen` shows them only while one of the page's elements is visible, `zones` route touches to the page's own touch elements |
| `debug.inspector`, `debug.port` | `true`, `9229` | the V8 inspector and the debug bridge (off in release builds) |
| `debug.workers` | `false` | log every worker message |
| `mode` | `js` | `native-clear`: no page at all, only a cleared stereo frame (a bring-up test) |

## Debugging

The inspector speaks the Chrome DevTools Protocol on `debug.port`. On a Quest, `adb forward tcp:9229 tcp:9229`
and open `chrome://inspect`: you get the console, sources, breakpoints and CPU profiles of the page's isolate.
The same port serves the debug bridge:

```sh
node tools/bridge.mjs eval 'location.href'
node tools/bridge.mjs stats                      # fps, JS ms/frame, heap, GL thread time
node tools/bridge.mjs shot left.png --eye left   # the XR eye buffer as rendered
node tools/device.mjs log                        # logcat: tag webxr-host, the page's console as js:
node tools/profile.mjs 10                        # a 10 s CPU profile, summarised per function
```

A frame that hitches: `node tools/bridge.mjs eval '__native.gl.debugSlowOps(8)'` makes the host log, from then on, every
XR frame over 8 ms start to start in parts (the event loop's other work, the wait, the page's frame, the submit, the
GC) and any single command the GL thread takes longer than that over; `0` turns it off.

`HOST_LOCAL=1` points the bridge and profiler at a host on this machine (macOS, Windows, Linux, the iOS
simulator). On the Quest a debug build accepts inspector connections from the local network, not only through
`adb forward`, so don't hand out debug builds.

## Other hosts

Each one stages the game's assets exactly as `pack.mjs` stages the APK's, and takes the game the same way
(`npm run mac ../my-game`). Outside an XR session the mouse, wheel and keyboard reach the page as DOM events;
`host/emu/emu.h` lists the emulated headset's controls.

| Host | Setup | Run |
|---|---|---|
| macOS | `tools/setup-mac.sh` (Homebrew `v8` and `glfw`, ANGLE from a pinned Electron release) | `npm run mac <game>`, `npm run mac:app <game>` for a `.app` |
| Windows | `node tools/setup-win.mjs` (NuGet V8, Electron's ANGLE, GLFW) | `npm run win <game>`, `npm run win:app <game>` for a zip |
| Linux | `tools/setup-linux.sh [--angle]` (Homebrew's V8 bottle, the distribution's GLFW, curl, PulseAudio) | `npm run linux <game>`, `npm run linux:app`, `npm run linux:xr` (OpenXR on Monado/WiVRn) |
| iOS | `tools/setup-ios.sh` (npm `v8-ios`, raylib-iOS's ANGLE, WAMR); `tools/setup-v8-apple.sh` adds the newer V8 15.6 from this repository's releases | `npm run ios <game>` (simulator; `--device` with a signing identity) |
| visionOS | `tools/setup-v8-apple.sh`, `tools/setup-angle-apple.sh` (V8 and ANGLE for visionOS, downloaded from this repository's releases; `--build` builds them from source) | `node tools/ios.mjs <game> --vision` (runs both when a slice is missing) |
| Android phone | `tools/setup.sh [--emulator]` | `npm run phone <game>` |

### Prebuilt libraries

Some of the libraries have no upstream prebuilt that fits, so this repository publishes them as release assets:
- **[`v8-android-intl-14.9.207.39`](https://github.com/Srile/webxr-to-native/releases/tag/v8-android-intl-14.9.207.39):**
  V8 for Android with ICU, for games with `js.intl` (the stock Android V8 has no `Intl`). A build fetches it the
  first time a game asks (`tools/setup-v8-android-intl.sh`).
- **[`v8-apple-15.6.75.19`](https://github.com/Srile/webxr-to-native/releases/tag/v8-apple-15.6.75.19):** V8 for
  iOS and visionOS, four slices (`ios-arm64`, `iossim-arm64`, `xros-arm64`, `xrsim-arm64`) and the headers with ICU
  data.
- **[`angle-apple-2.1.28853`](https://github.com/Srile/webxr-to-native/releases/tag/angle-apple-2.1.28853):** ANGLE
  for visionOS, `xros-arm64` and `xrsim-arm64`, and the headers.

The setup scripts download them and check them against the SHA-256 they pin. With `--build` they build the same
thing from source instead: one to three hours for the Android V8, about 40 minutes per Apple V8 slice and 20 per
ANGLE slice, plus 10 to 17 GB of checkouts. Each archive carries the licences of what it contains, in `LICENSES/`.

## Tests

```sh
npm run test:runtime                                   # the JS runtime against fake natives (node --test)
cmake -S host -B build-tests -G Ninja -DHOST_TESTS=ON && ninja -C build-tests
# no Ninja on PATH? the SDK's: -DCMAKE_MAKE_PROGRAM="$(ls tools/sdk/android/cmake/*/bin/ninja)"
for t in json_test loop_test audio_test image_test gl_queue_test storage_test; do build-tests/$t; done
node tools/test.mjs                                    # on a headset: every app in apps/ against its expected.png
```

The native unit tests need the sources `tools/setup-linux.sh --sources` (or `tools/setup.sh`) fetches;
`storage_test` is built once `tools/setup-storage.sh` has fetched SQLite.
`apps/bench` holds IWSDK stress scenes that run unchanged in Quest Browser and on the host, for comparing frame
costs (`tools/bench.mjs`).

## Layout

```
host/        the native host (C++20, CMake): app/ core/ gl/ js/ xr/ audio/ img/ net/ store/ platform/ rtc/
             media/ (microphone) storage/ (IndexedDB, Cache API) steam/ (Steamworks),
             android/ the Quest and phone glue, emu/ the emulated headset of the desktop hosts, mac/ win/ linux/
             ios/ vision/, wamr/ the WebAssembly interpreter build, tests/ native unit tests
runtime/     the browser surface in JavaScript (runtime/src) and its tests (runtime/test)
android/     the Gradle shell that packs the native library, the runtime and the game into an APK
apps/        test apps (hello-xr, hello-js, hello-rtc, hello-intl, hello-mic, hello-storage, hello-sw, gl-bench)
             and the IWSDK benchmark scenes
tools/       setup scripts, the builders (pack, mac, win, linux, ios), device, bridge, profile, test, bench
licenses/    the licence texts of the third-party software the apps contain
third_party/ downloaded by the setup scripts (gitignored)
```

The native host calls itself `webxr-host` in places: the log tag, the binaries (`webxrhost-mac`, …), the user
agent suffix.

## Licence

MIT, see [LICENSE](LICENSE). The third-party software the toolkit downloads and builds into apps is under its own
licences. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists it, along with what you need to keep in an app you
ship. Every build already carries a `THIRD_PARTY_NOTICES.txt`.

## Credits

- Written by Florian Isikci, with contributions from Squareys.
- Built in collaboration with [Claude](https://claude.com/claude-code) (Anthropic), which wrote much of the code
  and ran most of the on-device verification.
- WebXR comes from [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) by Meta (MIT); its host
  mode is what this runtime drives.
- The engine underneath is [V8](https://v8.dev). The other hosts render through
  [ANGLE](https://chromium.googlesource.com/angle/angle), and the Quest's swapchains come from the
  [Khronos OpenXR loader](https://github.com/KhronosGroup/OpenXR-SDK).
