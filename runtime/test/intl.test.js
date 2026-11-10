import test from 'node:test'; import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fakeNative } from './fake-native.js'
import { install as installCore } from '../src/dom-lite/index.js'
import { install as installIntl, languagesFor } from '../src/intl/index.js'

// host.json js.intl (WP-24): the Android V8 with ICU hands the page the system locale it set as ICU's default
// (__native.intl, host/js/intl.cpp); navigator says the same. Without it the navigator is what it always was.
const sandbox = (over) => { const g = Object.create(null); g.__native = fakeNative(over); g.Promise = Promise; installCore(g); installIntl(g); return g }

test('no __native.intl (the stock Android V8, every window host): navigator.language unchanged', () => {
  const g = sandbox()
  assert.equal(g.navigator.language, 'en-US')
  assert.deepEqual([...g.navigator.languages], ['en-US', 'en'])
  assert.equal(g.Intl, undefined)  // the runtime defines no Intl of its own: it is V8's or absent
})

test('__native.intl: navigator.language / languages follow the system locale', () => {
  const g = sandbox({ intl: { locale: 'de-DE', languages: ['de-DE', 'de'], timeZone: 'Europe/Berlin', icu: '77.1' } })
  assert.equal(g.navigator.language, 'de-DE')
  assert.deepEqual([...g.navigator.languages], ['de-DE', 'de'])
  assert.ok(Object.isFrozen(g.navigator.languages))
  assert.equal(g.clientInformation.language, 'de-DE')  // the same object
})

test('languages from the locale alone, as Chrome lists them', () => {
  assert.deepEqual(languagesFor('sv-SE'), ['sv-SE', 'sv'])
  assert.deepEqual(languagesFor('zh-Hant-TW'), ['zh-Hant-TW', 'zh'])
  assert.deepEqual(languagesFor('fi'), ['fi'])
  assert.deepEqual(languagesFor(''), ['en-US', 'en'])
  const g = sandbox({ intl: { locale: 'pt-BR', timeZone: 'America/Sao_Paulo' } })
  assert.deepEqual([...g.navigator.languages], ['pt-BR', 'pt'])
})

test('a worker gets it too: worker-global installs it from the worker native (n.intl)', () => {
  const src = readFileSync(new URL('../src/workers/worker-global.js', import.meta.url), 'utf8')
  assert.match(src, /installIntl\(g, n\.intl\)/)
  const w = { navigator: { language: 'en-US', languages: ['en-US'] } }
  installIntl(w, { locale: 'ru-RU', languages: ['ru-RU', 'ru'] })
  assert.equal(w.navigator.language, 'ru-RU')
  installIntl(w, undefined)  // a build without it: untouched
  assert.equal(w.navigator.language, 'ru-RU')
})
