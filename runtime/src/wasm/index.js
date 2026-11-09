// WebAssembly where V8 has none (V8 for iOS: jitless, built without it), over the host's WAMR interpreter
// (__native.wasmi, host/js/wasm_interp.cpp). Installed before fetch (its compileStreaming/instantiateStreaming
// wrap compile/instantiate) in the page and in every worker. host.json `wasm.interpreter: true` (wasmi.force)
// replaces a V8 WebAssembly too, to test this path where V8 has one.
//
// What it covers is what emscripten output uses: Module, Instance, instantiate/compile/validate, exported
// memories (buffer, grow), exported tables (get, length), exported globals (value), and the three error classes.
// Imported memories, tables and globals, and Table.set/grow, are not supported: they throw LinkError/TypeError.
export function install(g, native) {
  const w = native && native.wasmi
  if (!w || (g.WebAssembly && !w.force)) return false

  class CompileError extends Error { constructor(m) { super(m); this.name = 'CompileError' } }
  class LinkError extends Error { constructor(m) { super(m); this.name = 'LinkError' } }
  class RuntimeError extends Error { constructor(m) { super(m); this.name = 'RuntimeError' } }
  w.setErrors(CompileError, LinkError, RuntimeError)

  const token = Symbol('wasmi')  // only the interpreter makes Memory/Table/Global objects
  const bytesOf = (src) => {
    if (src instanceof ArrayBuffer) return src
    if (ArrayBuffer.isView(src)) return src
    throw new TypeError('WebAssembly: argument must be a buffer source')
  }

  class Module {
    constructor(bytes) { const r = w.compile(bytesOf(bytes)); this._h = r.handle; this._imports = r.imports; this._exports = r.exports }
    static imports(m) { return m._imports.map(({ module, name, kind }) => ({ module, name, kind })) }
    static exports(m) { return m._exports.map(({ name, kind }) => ({ name, kind })) }
    static customSections() { return [] }
    get [Symbol.toStringTag]() { return 'WebAssembly.Module' }
  }

  class Memory {
    constructor(t, inst) { if (t !== token) throw new TypeError('WebAssembly.Memory: only exported memories are supported by the wasm interpreter'); this._i = inst }
    get buffer() { return w.memoryBuffer(this._i) }
    grow(delta) {
      const old = w.memoryGrow(this._i, delta >>> 0)
      if (old < 0) throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded')
      return old
    }
    get [Symbol.toStringTag]() { return 'WebAssembly.Memory' }
  }

  class Table {
    constructor(t, inst, name) { if (t !== token) throw new TypeError('WebAssembly.Table: only exported tables are supported by the wasm interpreter'); this._i = inst; this._n = name }
    get length() { return w.tableSize(this._i, this._n) }
    get(i) { return w.tableGet(this._i, this._n, i >>> 0) }
    set() { throw new TypeError('WebAssembly.Table.set() is not supported by the wasm interpreter') }
    grow() { throw new RangeError('WebAssembly.Table.grow() is not supported by the wasm interpreter') }
    get [Symbol.toStringTag]() { return 'WebAssembly.Table' }
  }

  class Global {
    constructor(t, inst, name) { if (t !== token) throw new TypeError('WebAssembly.Global: only exported globals are supported by the wasm interpreter'); this._i = inst; this._n = name }
    get value() { return w.globalGet(this._i, this._n) }
    valueOf() { return this.value }
    get [Symbol.toStringTag]() { return 'WebAssembly.Global' }
  }

  class Instance {
    constructor(module, importObject) {
      if (!(module instanceof Module)) throw new TypeError('WebAssembly.Instance(): Argument 0 must be a WebAssembly.Module')
      const fns = module._imports.map((im, i) => {
        if (im.kind !== 'function') throw new LinkError(`WebAssembly.Instance(): Import #${i} "${im.module}" "${im.name}": imported ${im.kind}s are not supported by the wasm interpreter`)
        const ns = importObject == null ? undefined : importObject[im.module]
        if (ns == null || typeof ns !== 'object' && typeof ns !== 'function') throw new TypeError(`WebAssembly.Instance(): Import #${i} "${im.module}": module is not an object or function`)
        const v = ns[im.name]
        if (typeof v !== 'function') throw new LinkError(`WebAssembly.Instance(): Import #${i} "${im.module}" "${im.name}": function import requires a callable`)
        return v
      })
      const r = w.instantiate(module._h, fns)
      const exports = Object.create(null)
      for (const e of r.exports) {
        exports[e.name] = e.kind === 'function' ? e.fn : e.kind === 'memory' ? new Memory(token, r.handle) : e.kind === 'table' ? new Table(token, r.handle, e.name) : new Global(token, r.handle, e.name)
      }
      this.exports = Object.freeze(exports)
    }
    get [Symbol.toStringTag]() { return 'WebAssembly.Instance' }
  }

  // The promise forms settle on a later turn, as a browser's do (compilation there is asynchronous).
  const later = (f) => new Promise((resolve, reject) => g.setTimeout(() => { try { resolve(f()) } catch (e) { reject(e) } }, 0))
  const WebAssembly = {
    Module, Instance, Memory, Table, Global, CompileError, LinkError, RuntimeError,
    validate(bytes) { try { new Module(bytes); return true } catch (e) { if (e instanceof CompileError) return false; throw e } },
    compile(bytes) { return later(() => new Module(bytes)) },
    instantiate(src, imports) {
      if (src instanceof Module) return later(() => new Instance(src, imports))
      return later(() => { const module = new Module(src); return { module, instance: new Instance(module, imports) } })
    },
    async compileStreaming(src) { return WebAssembly.compile(await (await src).arrayBuffer()) },
    async instantiateStreaming(src, imports) { return WebAssembly.instantiate(await (await src).arrayBuffer(), imports) },
    [Symbol.toStringTag]: 'WebAssembly',
  }
  Object.defineProperty(g, 'WebAssembly', { value: WebAssembly, writable: true, configurable: true, enumerable: false })
  native.log?.(1, 'wasm: WebAssembly is the host interpreter (WAMR)' + (w.force ? ', forced by host.json wasm.interpreter' : ''))
  return true
}
