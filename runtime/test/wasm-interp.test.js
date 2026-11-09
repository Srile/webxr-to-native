import test from 'node:test'; import assert from 'node:assert/strict'
import { install as installWasm } from '../src/wasm/index.js'
// A fake __native.wasmi over Node's own WebAssembly, shaped like host/js/wasm_interp.cpp: handles, descriptors,
// export functions, memory/table/global by instance and name, and the error classes it is handed.
function fakeWasmi({ force = false } = {}) {
  const modules = [], instances = []; let errors = null
  const W = globalThis.WebAssembly
  return {
    force,
    setErrors(C, L, R) { errors = { C, L, R } },
    compile(bytes) {
      let m; try { m = new W.Module(bytes) } catch (e) { throw new errors.C('WebAssembly.Module(): ' + e.message) }
      modules.push(m); return { handle: modules.length - 1, imports: W.Module.imports(m), exports: W.Module.exports(m) }
    },
    instantiate(h, fns) {
      const m = modules[h], imports = {}
      W.Module.imports(m).forEach((im, i) => { (imports[im.module] ??= {})[im.name] = fns[i] })
      const inst = new W.Instance(m, imports); instances.push(inst)
      return { handle: instances.length - 1, exports: W.Module.exports(m).map(({ name, kind }) => ({ name, kind, fn: kind === 'function' ? inst.exports[name] : undefined })) }
    },
    memoryBuffer: (i) => Object.values(instances[i].exports).find(v => v instanceof W.Memory).buffer,
    memoryGrow: (i, d) => { try { return Object.values(instances[i].exports).find(v => v instanceof W.Memory).grow(d) } catch { return -1 } },
    tableGet: (i, n, k) => instances[i].exports[n].get(k),
    tableSize: (i, n) => instances[i].exports[n].length,
    globalGet: (i, n) => instances[i].exports[n].value,
  }
}
function sandbox(opts) { const g = Object.create(null); g.setTimeout = setTimeout; const native = { wasmi: fakeWasmi(opts), log() {} }; return { g, installed: installWasm(g, native) } }

// (module (import "env" "log" (func $log (param i32))) (memory (export "mem") 1 2) (table (export "tab") 1 funcref)
//   (global (export "g") i32 (i32.const 7)) (elem (i32.const 0) $add)
//   (func $add (export "add") (param i32 i32) (result i32) (call $log (local.get 0)) (i32.add (local.get 0) (local.get 1))))
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 11, 2, 96, 1, 127, 0, 96, 2, 127, 127, 1, 127, 2, 11, 1, 3, 101, 110, 118, 3, 108, 111, 103, 0, 0, 3, 2, 1, 1, 4, 4, 1, 112, 0, 1, 5, 4, 1, 1, 1, 2, 6, 6, 1, 127, 0, 65, 7, 11, 7, 23, 4, 3, 109, 101, 109, 2, 0, 3, 116, 97, 98, 1, 0, 1, 103, 3, 0, 3, 97, 100, 100, 0, 1, 9, 7, 1, 0, 65, 0, 11, 1, 1, 10, 13, 1, 11, 0, 32, 0, 16, 0, 32, 0, 32, 1, 106, 11, 0, 18, 4, 110, 97, 109, 101, 1, 11, 2, 0, 3, 108, 111, 103, 1, 3, 97, 100, 100])

test('installs only where there is no WebAssembly, unless forced', () => {
  const plain = Object.create(null); plain.WebAssembly = {}; assert.equal(installWasm(plain, { wasmi: fakeWasmi() }), false)
  const forced = Object.create(null); forced.WebAssembly = {}; forced.setTimeout = setTimeout; assert.equal(installWasm(forced, { wasmi: fakeWasmi({ force: true }), log() {} }), true); assert.ok(forced.WebAssembly.Module)
  assert.equal(installWasm(Object.create(null), {}), false)
})
test('instantiate: exports, imports, memory, table, global', async () => {
  const { g } = sandbox(); const seen = []
  const { module, instance } = await g.WebAssembly.instantiate(bytes, { env: { log: (x) => seen.push(x) } })
  assert.ok(module instanceof g.WebAssembly.Module); assert.ok(instance instanceof g.WebAssembly.Instance)
  assert.equal(instance.exports.add(2, 3), 5); assert.deepEqual(seen, [2])
  assert.ok(instance.exports.mem instanceof g.WebAssembly.Memory)
  const buf = instance.exports.mem.buffer; assert.equal(buf.byteLength, 65536); assert.equal(instance.exports.mem.buffer, buf)
  assert.equal(instance.exports.mem.grow(1), 1); assert.equal(instance.exports.mem.buffer.byteLength, 131072)
  assert.throws(() => instance.exports.mem.grow(5), RangeError)
  assert.equal(instance.exports.tab.length, 1); assert.equal(instance.exports.tab.get(0)(4, 5), 9)
  assert.equal(instance.exports.g.value, 7)
  assert.deepEqual(g.WebAssembly.Module.imports(module), [{ module: 'env', name: 'log', kind: 'function' }])
  assert.ok(Object.isFrozen(instance.exports))
})
test('errors: compile, link, promise forms reject', async () => {
  const { g } = sandbox()
  assert.equal(g.WebAssembly.validate(bytes), true); assert.equal(g.WebAssembly.validate(new Uint8Array([1, 2, 3])), false)
  assert.throws(() => new g.WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9])), g.WebAssembly.CompileError)
  await assert.rejects(g.WebAssembly.instantiate(new Uint8Array([1])), g.WebAssembly.CompileError)
  const m = new g.WebAssembly.Module(bytes)
  assert.throws(() => new g.WebAssembly.Instance(m, { env: {} }), g.WebAssembly.LinkError)
  assert.throws(() => new g.WebAssembly.Instance(m, {}), TypeError)
  assert.throws(() => new g.WebAssembly.Memory({ initial: 1 }), TypeError)
  const inst = await g.WebAssembly.instantiate(m, { env: { log() {} } }); assert.equal(inst.exports.add(1, 1), 2)
})
test('instantiateStreaming reads the response', async () => {
  const { g } = sandbox()
  const { instance } = await g.WebAssembly.instantiateStreaming(Promise.resolve({ arrayBuffer: async () => bytes.buffer }), { env: { log() {} } })
  assert.equal(instance.exports.add(20, 22), 42)
})
