// media-elements.js: <audio> playing through Web Audio (host.json audio.elements), on dom-lite's own elements (their
// dispatchEvent, their on<type> handlers) and a fake AudioContext.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { installMediaElements } from '../src/webaudio/media-elements.js'

function setup() {
  const started = [], fetched = [], sources = []
  class Node { connect() {} disconnect() { this.off = true } }
  class Source extends Node { start(when, offset) { this.offset = offset; started.push(this) } stop() { this.stopped = true } }
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node() }
    resume() {} createBufferSource() { return new Source() } createGain() { const n = new Node(); n.gain = { value: 1 }; return n }
    createMediaStreamSource(stream) { const n = new Node(); n.stream = stream; sources.push(n); return n }
    decodeAudioData(bytes) { return bytes.byteLength ? Promise.resolve({ duration: 0.5, bytes }) : Promise.reject(new Error('Unable to decode audio data')) }
  }
  const g = Object.create(null); g.__native = fakeNative(); g.Promise = Promise
  installCore(g)
  g.fetch = async (url) => { fetched.push(url); return { ok: !url.includes('missing'), status: url.includes('missing') ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(8) } }
  installMediaElements(g, AudioContext)
  // every event an element dispatches, and every on<type> call, in order
  const audio = (src) => {
    const a = new g.Audio(src); a.events = []; a.handlers = []
    for (const t of ['play', 'loadedmetadata', 'playing', 'pause', 'ended', 'error']) { a.addEventListener(t, () => a.events.push(t)); a['on' + t] = () => a.handlers.push(t) }
    return a
  }
  return { g, audio, started, fetched, sources }
}

test('an <audio> element plays its source through Web Audio, at its volume, and reports the end', async () => {
  const { audio, started, fetched } = setup()
  const a = audio()
  a.src = '/sounds/click.m4a'; a.volume = 0.15
  await a.play()
  assert.equal(fetched[0], 'https://app.local/sounds/click.m4a')
  assert.equal(started.length, 1)
  assert.equal(a.paused, false); assert.equal(a.duration, 0.5)
  assert.deepEqual(a.events, ['play', 'loadedmetadata', 'playing'])
  started[0].onended()
  assert.equal(a.paused, true); assert.deepEqual(a.events.slice(-2), ['pause', 'ended'])
  // The same clip again decodes once.
  const b = audio('/sounds/click.m4a'); await b.play()
  assert.equal(fetched.length, 1); assert.equal(started.length, 2)
  // Muting and volume follow while it plays; pause stops it.
  b.muted = true; assert.equal(b.__media.gain.gain.value, 0)
  b.pause(); assert.equal(started[1].stopped, true); assert.equal(b.paused, true)
  assert.throws(() => { b.volume = 2 })
})

test('each event reaches its listeners and its on<type> handler once', async () => {
  const { audio, started } = setup()
  const a = audio('/music/a.ogg')
  let next = 0; a.onended = () => { next++ }   // a playlist moving on from onended
  await a.play(); started[0].onended()
  assert.equal(next, 1)
  assert.deepEqual(a.handlers, ['play', 'loadedmetadata', 'playing', 'pause'])
  assert.deepEqual(a.events, ['play', 'loadedmetadata', 'playing', 'pause', 'ended'])
  const bad = audio('/music/missing.ogg'); await assert.rejects(bad.play())
  assert.deepEqual(bad.handlers.filter((t) => t === 'error'), ['error'])
})

test('play() on an element already playing its source does nothing; a new src plays from its start', async () => {
  const { audio, started } = setup()
  const a = audio('/music/theme.ogg')
  await a.play()
  await a.play(); await a.play()   // a tap that unlocks audio, again and again
  assert.equal(started.length, 1); assert.equal(started[0].stopped, undefined)
  assert.deepEqual(a.events, ['play', 'loadedmetadata', 'playing'])
  // Paused partway, it resumes where it was.
  a.__media.startedAt -= 0.25; a.pause(); await a.play()   // 0.25 s in
  assert.equal(started.length, 2); assert.equal(started[1].offset, 0.25)
  // Another track: the old one stops and the new one starts at 0, not at the old one's position.
  a.pause(); a.src = '/music/level2.ogg'; await a.play()
  assert.equal(started.length, 3); assert.equal(started[2].offset, 0); assert.equal(a.currentSrc, 'https://app.local/music/level2.ogg')
  a.src = '/music/level3.ogg'; await a.play()   // switched while playing
  assert.equal(started[2].stopped, true); assert.equal(started.length, 4); assert.equal(started[3].offset, 0)
})

test('a missing source fires error and rejects; a pause before decoding finishes plays nothing', async () => {
  const { audio, started } = setup()
  const a = audio('/sounds/missing.m4a')
  await assert.rejects(a.play(), /404/)
  assert.ok(a.events.includes('error')); assert.equal(a.paused, true)
  const b = audio('/sounds/chime.mp3')
  const p = b.play(); b.pause(); await p
  assert.equal(started.length, 0)
  await assert.rejects(audio().play(), /no supported sources/)
})

test('<video> is left alone: play() still rejects, so a page falls back, and it fetches nothing', async () => {
  const { g, fetched, started } = setup()
  const v = g.document.createElement('video')
  v.src = '/intro.mp4'
  await assert.rejects(v.play(), (e) => e.name === 'NotSupportedError')
  assert.equal(fetched.length, 0); assert.equal(started.length, 0)
  assert.ok(g.document.createElement('audio') instanceof g.HTMLAudioElement)
  assert.equal(typeof Object.getOwnPropertyDescriptor(g.HTMLAudioElement.prototype, 'srcObject')?.set, 'function')
  assert.equal(Object.getOwnPropertyDescriptor(g.HTMLMediaElement.prototype, 'srcObject'), undefined)
})

test('an <audio> with a srcObject plays the stream live through a MediaStreamAudioSourceNode, and stops with it', async () => {
  const { audio, sources } = setup()
  const a = audio()
  const stream = { getAudioTracks: () => [{ kind: 'audio' }] }
  a.srcObject = stream; await a.play()
  assert.equal(sources.length, 1); assert.equal(sources[0].stream, stream); assert.equal(a.paused, false)
  await a.play(); assert.equal(sources.length, 1)
  a.muted = true; assert.equal(a.__media.gain.gain.value, 0)
  a.srcObject = null; assert.equal(sources[0].off, true)
})
