// host-runtime.js — the browser surface the game bundle runs on. Evaluated as a
// classic script before the game's entry module; __native is already installed.
import './early.js'  // first: EventTarget/Event/DOMException before IWER's module body (webxr/) runs
import { install as installCore, installPageElements } from './dom-lite/index.js'
import { install as installWasm } from './wasm/index.js'
import { install as installFetch } from './fetch/index.js'
import { install as installWebGL } from './webgl/index.js'
import { install as installImages } from './images/index.js'
import { install as installWorkers } from './workers/index.js'
import { install as installWebAudio } from './webaudio/index.js'
import { install as installWebXR } from './webxr/index.js'
import { install as installPlatform } from './platform/index.js'
import { install as installRtc } from './rtc/index.js'
import { boot } from './boot.js'

const g = globalThis
installCore(g)
installWasm(g, g.__native)  // before fetch: its *Streaming wrap this WebAssembly
installFetch(g)
installImages(g)
installWebGL(g)
installPageElements(g)  // after images/ and webgl/: a declared <canvas> is a real one
installWorkers(g)
installWebAudio(g)
installWebXR(g)
installPlatform(g)
installRtc(g)  // only with __native.rtc (host.json network.webrtc)
boot(g)
