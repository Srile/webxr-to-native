import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installFetch } from '../src/fetch/index.js'
import { install as installWorkers } from '../src/workers/index.js'
test('Worker wraps __native.worker and routes messages/ports', async () => {
  const spawned = []; let hostCb = null; const posted = []
  const g = Object.create(null); g.__native = fakeNative({ worker: { spawn: (src, url, mod) => { spawned.push({ src, url, mod }); return 7 }, post: (id, msg, bufs) => posted.push({ id, msg, bufs }), terminate: () => {}, onMessage: (cb) => { hostCb = cb }, onError: () => {} }, assets: { read: () => null, readText: (p) => p === 'w.js' ? 'self.onmessage = e => postMessage(e.data * 2)' : null, exists: () => true, mime: () => 'text/javascript' } })
  g.Promise = Promise; installCore(g); installFetch(g); installWorkers(g)
  const w = new g.Worker('/w.js'); assert.equal(spawned[0].url, 'https://app.local/w.js'); assert.match(spawned[0].src, /onmessage/)
  const buf = new ArrayBuffer(8); w.postMessage({ a: 1 }, [buf]); assert.equal(posted[0].id, 7); assert.deepEqual(posted[0].msg.data, { a: 1 }); assert.equal(posted[0].bufs[0], buf)
  const got = new Promise(r => w.onmessage = (e) => r(e.data)); hostCb(7, { __msg: 1, data: 42, ports: [] }); assert.equal(await got, 42)
  // a port transferred to the worker: messages for its id arrive on the port
  const ch = new g.MessageChannel(); w.postMessage('p', [ch.port2]); const pid = posted[1].msg.ports[0]; assert.ok(pid)
  const onPort = new Promise(r => ch.port2.onmessage = (e) => r(e.data)); hostCb(7, { __port: pid, data: 'via port', ports: [] }); assert.equal(await onPort, 'via port')
  // blob worker source
  const b = new g.Blob(['postMessage(1)'], { type: 'text/javascript' }); new g.Worker(g.URL.createObjectURL(b)); assert.equal(spawned[1].src, 'postMessage(1)')
})
