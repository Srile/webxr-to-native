// The SERVICE-WORKER prelude (bundled to assets/host-sw.js, staged only for a game with host.json
// web.serviceWorker): the worker prelude, then the ServiceWorkerGlobalScope over it. host/js/worker.cpp runs it in
// place of host-worker.js for a worker spawned with {prelude: 'host-sw.js'} (serviceworker/index.js).
import { internals } from '../workers/worker-global.js'
import { installScope } from './scope.js'
installScope(globalThis, internals)
// The Cache API and IndexedDB (WP-26, host.json storage) are in this scope already: worker-global.js installs them
// (runtime/src/storage install(g)), and the worker isolate's __native.storage is bound by host/js/worker.cpp.
