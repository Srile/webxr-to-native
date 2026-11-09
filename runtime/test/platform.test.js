import test from 'node:test'; import assert from 'node:assert/strict'
import { fakeNative } from './fake-native.js'
import { install as installPlatform } from '../src/platform/index.js'
// A fake __native.platform: init settles as told, every other native answers from the table or rejects.
function sandbox({ init = true, answers = {} } = {}) {
  const g = Object.create(null); g.navigator = {}; g.Promise = Promise
  const call = (k) => () => k in answers ? (answers[k] instanceof Error ? Promise.reject(answers[k]) : Promise.resolve(answers[k])) : Promise.reject(new Error(`${k}: no answer`))
  g.__native = fakeNative({ config: { app: { metaAppId: '123' } }, platform: { available: true, init: () => init ? Promise.resolve(true) : Promise.reject(new Error('init failed')), entitled: call('entitled'), user: call('user'), ageCategory: call('ageCategory') } })
  installPlatform(g); return g
}
test('ageCategory maps the native answer through', async () => { const g = sandbox({ answers: { ageCategory: 'teen' } }); assert.equal(await g.navigator.horizon.ageCategory(), 'teen') })
test('ageCategory swallows a rejection into unknown', async () => { const g = sandbox({ answers: { ageCategory: new Error('boom') } }); assert.equal(await g.navigator.horizon.ageCategory(), 'unknown') })
test('ageCategory is unknown when init failed', async () => { const g = sandbox({ init: false, answers: { ageCategory: 'adult' } }); assert.equal(await g.navigator.horizon.ageCategory(), 'unknown'); assert.equal(await g.navigator.horizon.ready, false) })
test('entitled is false on a failed check and on a failed init, never rejected', async () => {
  assert.equal(await sandbox({ answers: { entitled: true } }).navigator.horizon.entitled(), true)
  assert.equal(await sandbox({ answers: { entitled: new Error('not entitled') } }).navigator.horizon.entitled(), false)
  assert.equal(await sandbox({ init: false, answers: { entitled: true } }).navigator.horizon.entitled(), false)
})
test('no horizon without the SDK', () => { const g = Object.create(null); g.navigator = {}; g.__native = fakeNative({ platform: undefined }); installPlatform(g); assert.equal(g.navigator.horizon, undefined) })
