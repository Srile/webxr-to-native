// media-elements.js: <audio> playing through Web Audio (host.json audio.elements).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMediaElements } from '../src/webaudio/media-elements.js'

function setup() {
  const started = [], fetched = []
  class Node { connect() {} disconnect() {} }
  class Source extends Node { start(when, offset) { this.offset = offset; started.push(this) } stop() { this.stopped = true } }
  class Gain extends Node { constructor() { super(); this.gain = { value: 1 } } }
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node() }
    resume() {} createBufferSource() { return new Source() } createGain() { return new Gain() }
    decodeAudioData(bytes) { return bytes.byteLength ? Promise.resolve({ duration: 0.5, bytes }) : Promise.reject(new Error('Unable to decode audio data')) }
  }
  class Event { constructor(type) { this.type = type } }
  class HTMLMediaElement {
    constructor() { this.src = ''; this.currentTime = 0; this.paused = true; this.muted = false; this.volume = 1; this.loop = false; this.events = [] }
    dispatchEvent(e) { this.events.push(e.type); return true }
  }
  const g = {
    Event, HTMLMediaElement, DOMException: class extends Error { constructor(m, n) { super(m); this.name = n } },
    location: { href: 'https://game.example/index.html' },
    fetch: async (url) => { fetched.push(url); return { ok: !url.includes('missing'), status: url.includes('missing') ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(8) } },
  }
  installMediaElements(g, AudioContext)
  return { el: () => new g.HTMLMediaElement(), started, fetched }
}

test('an <audio> element plays its source through Web Audio, at its volume, and reports the end', async () => {
  const { el, started, fetched } = setup()
  const a = el()
  a.src = '/sounds/click.m4a'; a.volume = 0.15
  await a.play()
  assert.equal(fetched[0], 'https://game.example/sounds/click.m4a')
  assert.equal(started.length, 1)
  assert.equal(a.paused, false); assert.equal(a.duration, 0.5)
  assert.deepEqual(a.events, ['play', 'loadedmetadata', 'playing'])
  started[0].onended()
  assert.equal(a.paused, true); assert.deepEqual(a.events.slice(-2), ['pause', 'ended'])
  // The same clip again decodes once.
  const b = el(); b.src = '/sounds/click.m4a'; await b.play()
  assert.equal(fetched.length, 1); assert.equal(started.length, 2)
  // Muting and volume follow while it plays; pause stops it.
  b.muted = true; assert.equal(b.__media.gain.gain.value, 0)
  b.pause(); assert.equal(started[1].stopped, true); assert.equal(b.paused, true)
  assert.throws(() => { b.volume = 2 })
})

test('a missing source fires error and rejects; a pause before decoding finishes plays nothing', async () => {
  const { el, started } = setup()
  const a = el(); a.src = '/sounds/missing.m4a'
  await assert.rejects(a.play(), /404/)
  assert.ok(a.events.includes('error')); assert.equal(a.paused, true)
  const b = el(); b.src = '/sounds/chime.mp3'
  const p = b.play(); b.pause(); await p
  assert.equal(started.length, 0)
  await assert.rejects(el().play(), /no supported sources/)
})

test('an <audio> with a srcObject plays the stream live through a MediaStreamAudioSourceNode, and stops with it', async () => {
  const sources = []
  class Node { connect() {} disconnect() { this.off = true } }
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node() }
    resume() {} createGain() { const n = new Node(); n.gain = { value: 1 }; return n }
    createMediaStreamSource(stream) { const n = new Node(); n.stream = stream; sources.push(n); return n }
  }
  class HTMLMediaElement {
    constructor() { this.src = ''; this.currentTime = 0; this.paused = true; this.muted = false; this.volume = 1; this.loop = false; this.events = [] }
    dispatchEvent(e) { this.events.push(e.type); return true }
  }
  const g = { Event: class { constructor(t) { this.type = t } }, HTMLMediaElement, DOMException: class extends Error {}, location: { href: 'https://x/' }, fetch: async () => { throw new Error('no fetch for a stream') } }
  installMediaElements(g, AudioContext)
  const a = new g.HTMLMediaElement()
  const stream = { getAudioTracks: () => [{ kind: 'audio' }] }
  a.srcObject = stream; await a.play()
  assert.equal(sources.length, 1); assert.equal(sources[0].stream, stream); assert.equal(a.paused, false)
  a.muted = true; assert.equal(a.__media.gain.gain.value, 0)
  a.srcObject = null; assert.equal(sources[0].off, true)
})
