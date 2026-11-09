// __native.wasmi: WebAssembly through WAMR's fast interpreter (host/wamr/), where V8 has none: V8 for iOS runs
// jitless and is built without it. runtime/src/wasm/index.js builds the WebAssembly namespace on this, in the
// page and in every worker. host.json `wasm.interpreter: true` forces it where V8 has its own (testing on mac).
//
//   compile(bytes)                    → {handle, imports: [{module, name, kind}], exports: [{name, kind}]}
//   instantiate(module, importFns[])  → {handle, exports: [{name, kind, fn?}]}   (importFns: one per import)
//   memoryBuffer(inst) / memoryGrow(inst, pages) / tableGet(inst, name, i) / tableSize(inst, name) / globalGet(inst, name)
//   setErrors(CompileError, LinkError, RuntimeError)
//
// Imports: WAMR resolves imports by (module, field) from one process-wide registry, so each pair the page ever
// imports is registered once as a raw native whose attachment names it; the trampoline finds the calling instance
// (custom data) and its JS function for that pair. A JS exception thrown by an import unwinds the wasm stack as a
// WAMR exception and is rethrown, as itself, where the wasm call began (emscripten's invoke_* and exit rely on it).
// Memory: an exported memory's ArrayBuffer aliases the linear memory; when it moves or grows (a grow reallocates
// it: no guard pages here), the old buffer is detached before any JS runs against it and a new one handed out on
// the next memory.buffer read, as a browser does on grow. Modules and instances live as long as their thread: the
// page's for the process, a worker's until it ends (uninstallWasmInterp).
#include "js/natives.h"
#include "js/bind.h"
#include "core/log.h"
#ifdef HOST_HAS_WAMR
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>
#include "wasm_export.h"
#endif

namespace host {

#ifndef HOST_HAS_WAMR
void installWasmInterp(v8::Local<v8::Context>, v8::Local<v8::Object>, HostServices&) {}
void uninstallWasmInterp() {}
#else
namespace {

std::mutex g_mu;  // WAMR's native-symbol registry and loader are process-wide
std::thread::id g_initThread;

struct ImportKey { std::string module, field; NativeSymbol sym{}; };  // registered once, never freed
std::map<std::pair<std::string, std::string>, ImportKey*> g_keys;

struct Module {
  std::vector<uint8_t> bytes;  // WAMR keeps pointers into the binary
  wasm_module_t m = nullptr;
  std::vector<ImportKey*> keys;  // per import (functions; null for the others)
};
struct ImportFn { v8::Global<v8::Function> fn; std::vector<wasm_valkind_t> params, results; };
struct Instance;
struct ExportFn { Instance* in; wasm_function_inst_t f; std::vector<wasm_valkind_t> params, results; };
struct Instance {
  wasm_module_inst_t inst = nullptr; wasm_exec_env_t env = nullptr;
  v8::Isolate* iso = nullptr; v8::Global<v8::Context> ctx;
  std::unordered_map<ImportKey*, ImportFn> imports;
  void* memBase = nullptr; size_t memSize = 0; v8::Global<v8::ArrayBuffer> memBuf;
  std::unordered_map<uint64_t, v8::Global<v8::Function>> tableFns;  // (table name hash, index) → wrapper
  std::vector<ExportFn*> fns;  // the export wrappers' data, freed with the instance
  ~Instance() { for (ExportFn* f : fns) delete f; }
};

// Per thread (one isolate each): the handles, the error classes, the JS exception unwinding through wasm.
// Heap-held: a thread_local v8::Global would be reset after its isolate is gone. A worker's is freed by
// uninstallWasmInterp while its isolate is still up; the page's lives as long as the process.
struct Thread {
  std::vector<Module*> modules; std::vector<Instance*> instances;
  v8::Global<v8::Function> compileError, linkError, runtimeError;
  v8::Global<v8::Value> pending; bool hasPending = false;
  Instance* instantiating = nullptr;  // a start function's imports run before the custom data is set
  bool env = false;  // this thread's WAMR env is up (wasm_runtime_init_thread_env; the init thread has it from full_init)
};
thread_local Thread* t_thread = nullptr;
Thread& thr() { if (!t_thread) t_thread = new Thread(); return *t_thread; }

bool ensureRuntime() {
  static bool ok = [] {
    RuntimeInitArgs args; memset(&args, 0, sizeof args); args.mem_alloc_type = Alloc_With_System_Allocator;
    g_initThread = std::this_thread::get_id();
    bool r = wasm_runtime_full_init(&args);
    HOST_LOGI("wasm: WAMR fast interpreter %s", r ? "up" : "FAILED to start");
    return r;
  }();
  Thread& t = thr();
  if (ok && !t.env && std::this_thread::get_id() != g_initThread) wasm_runtime_init_thread_env();
  t.env = ok;
  return ok;
}

// The linear memory moved or grew since the page last read memory.buffer (a grow from inside wasm, or
// memoryGrow): the buffer aliasing the old block is detached now, before any JS runs against it, so a view kept
// across the grow reads as empty (a browser's does) instead of freed memory; the next read hands out a new one.
void syncMemory(Instance* in) {
  if (in->memBuf.IsEmpty()) return;
  wasm_memory_inst_t mem = wasm_runtime_get_default_memory(in->inst); if (!mem) return;
  void* base = wasm_memory_get_base_address(mem); size_t size = (size_t)wasm_memory_get_cur_page_count(mem) * wasm_memory_get_bytes_per_page(mem);
  if (base == in->memBase && size == in->memSize) return;
  v8::Isolate* iso = in->iso; v8::HandleScope hs(iso);
  (void)in->memBuf.Get(iso)->Detach(v8::Local<v8::Value>());
  in->memBuf.Reset(); in->memBase = nullptr; in->memSize = 0;
}

const char* kindName(wasm_import_export_kind_t k) { return k == WASM_IMPORT_EXPORT_KIND_FUNC ? "function" : k == WASM_IMPORT_EXPORT_KIND_TABLE ? "table" : k == WASM_IMPORT_EXPORT_KIND_MEMORY ? "memory" : "global"; }

void throwKind(v8::Isolate* iso, v8::Global<v8::Function>& ctor, const std::string& msg) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext(); v8::Local<v8::Value> m = bind::str(iso, msg); v8::Local<v8::Object> e;
  if (!ctor.IsEmpty() && ctor.Get(iso)->NewInstance(ctx, 1, &m).ToLocal(&e)) iso->ThrowException(e); else bind::throwError(iso, msg);
}

v8::Local<v8::Value> toJs(v8::Isolate* iso, wasm_valkind_t k, const void* p) {
  switch (k) {
    case WASM_I32: { int32_t v; memcpy(&v, p, 4); return v8::Integer::New(iso, v); }
    case WASM_I64: { int64_t v; memcpy(&v, p, 8); return v8::BigInt::New(iso, v); }
    case WASM_F32: { float v; memcpy(&v, p, 4); return v8::Number::New(iso, v); }
    case WASM_F64: { double v; memcpy(&v, p, 8); return v8::Number::New(iso, v); }
    default: return v8::Undefined(iso);
  }
}
// False with a JS exception pending when the value does not convert (an i64 from something that is not a BigInt).
bool fromJs(v8::Local<v8::Context> ctx, v8::Local<v8::Value> v, wasm_valkind_t k, void* p) {
  switch (k) {
    case WASM_I32: { int32_t x; if (!v->Int32Value(ctx).To(&x)) return false; memcpy(p, &x, 4); return true; }
    case WASM_I64: { v8::Local<v8::BigInt> b; if (!v->ToBigInt(ctx).ToLocal(&b)) return false; int64_t x = b->Int64Value(); memcpy(p, &x, 8); return true; }
    case WASM_F32: { double d; if (!v->NumberValue(ctx).To(&d)) return false; float x = (float)d; memcpy(p, &x, 4); return true; }
    case WASM_F64: { double x; if (!v->NumberValue(ctx).To(&x)) return false; memcpy(p, &x, 8); return true; }
    default: return true;
  }
}

// Every import, every module: the raw native WAMR calls with one uint64 slot per argument; the result goes in slot 0.
void trampoline(wasm_exec_env_t env, uint64_t* args) {
  auto* key = (ImportKey*)wasm_runtime_get_function_attachment(env);
  wasm_module_inst_t mi = wasm_runtime_get_module_inst(env);
  auto* in = (Instance*)wasm_runtime_get_custom_data(mi); if (!in) in = thr().instantiating;
  auto it = in ? in->imports.find(key) : decltype(in->imports.end()){};
  if (!in || it == in->imports.end()) { wasm_runtime_set_exception(mi, ("unlinked import " + key->module + "." + key->field).c_str()); return; }
  const ImportFn& f = it->second; v8::Isolate* iso = in->iso;
  v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = in->ctx.Get(iso);
  syncMemory(in);  // the wasm code may have grown its memory before calling out
  v8::Local<v8::Value> argv[16]; std::vector<v8::Local<v8::Value>> big; v8::Local<v8::Value>* av = argv;
  if (f.params.size() > 16) { big.resize(f.params.size()); av = big.data(); }
  for (size_t i = 0; i < f.params.size(); ++i) av[i] = toJs(iso, f.params[i], &args[i]);
  v8::TryCatch tc(iso); v8::Local<v8::Value> r;
  bool ok = f.fn.Get(iso)->Call(ctx, v8::Undefined(iso), (int)f.params.size(), av).ToLocal(&r);
  if (ok && !f.results.empty()) ok = fromJs(ctx, r, f.results[0], &args[0]);
  if (!ok) {
    Thread& t = thr();
    if (tc.HasCaught()) { t.pending.Reset(iso, tc.Exception()); t.hasPending = true; }
    wasm_runtime_set_exception(mi, "JS exception");  // unwinds to the wasm call that is waiting for it
  }
}

// After a wasm call failed: the JS exception that unwound it, else the trap as a WebAssembly.RuntimeError.
void throwFailure(v8::Isolate* iso, wasm_module_inst_t mi) {
  Thread& t = thr();
  if (t.hasPending) { v8::Local<v8::Value> e = t.pending.Get(iso); t.pending.Reset(); t.hasPending = false; wasm_runtime_clear_exception(mi); iso->ThrowException(e); return; }
  std::string msg = wasm_runtime_get_exception(mi) ? wasm_runtime_get_exception(mi) : "wasm call failed";
  if (msg.rfind("Exception: ", 0) == 0) msg = msg.substr(11);
  wasm_runtime_clear_exception(mi);
  throwKind(iso, t.runtimeError, msg);
}

void callExport(const v8::FunctionCallbackInfo<v8::Value>& a) {
  auto* ef = (ExportFn*)externalValue(a.Data()); v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  wasm_val_t args[16], res[4]; std::vector<wasm_val_t> bigArgs, bigRes; wasm_val_t* ap = args; wasm_val_t* rp = res;
  if (ef->params.size() > 16) { bigArgs.resize(ef->params.size()); ap = bigArgs.data(); }
  if (ef->results.size() > 4) { bigRes.resize(ef->results.size()); rp = bigRes.data(); }
  for (size_t i = 0; i < ef->params.size(); ++i) {
    ap[i].kind = ef->params[i];
    if (ef->params[i] == WASM_V128) return bind::throwType(iso, "type incompatibility when transforming from/to JS (v128)");
    if (!fromJs(ctx, i < (size_t)a.Length() ? a[(int)i] : v8::Local<v8::Value>(v8::Undefined(iso)), ef->params[i], &ap[i].of)) return;
  }
  for (size_t i = 0; i < ef->results.size(); ++i) rp[i].kind = ef->results[i];
  const bool ok = wasm_runtime_call_wasm_a(ef->in->env, ef->f, (uint32_t)ef->results.size(), rp, (uint32_t)ef->params.size(), ap);
  syncMemory(ef->in);
  if (!ok) return throwFailure(iso, ef->in->inst);
  if (ef->results.size() == 1) a.GetReturnValue().Set(toJs(iso, rp[0].kind, &rp[0].of));
  else if (ef->results.size() > 1) { v8::Local<v8::Array> arr = v8::Array::New(iso, (int)ef->results.size()); for (size_t i = 0; i < ef->results.size(); ++i) (void)arr->Set(ctx, (uint32_t)i, toJs(iso, rp[i].kind, &rp[i].of)); a.GetReturnValue().Set(arr); }
}

v8::Local<v8::Function> exportFunction(v8::Isolate* iso, v8::Local<v8::Context> ctx, Instance* in, wasm_function_inst_t f) {
  auto* ef = new ExportFn{in, f, {}, {}};
  ef->params.resize(wasm_func_get_param_count(f, in->inst)); ef->results.resize(wasm_func_get_result_count(f, in->inst));
  if (!ef->params.empty()) wasm_func_get_param_types(f, in->inst, ef->params.data());
  if (!ef->results.empty()) wasm_func_get_result_types(f, in->inst, ef->results.data());
  in->fns.push_back(ef);
  return v8::Function::New(ctx, callExport, newExternal(iso, ef), (int)ef->params.size()).ToLocalChecked();
}

Module* moduleArg(const v8::FunctionCallbackInfo<v8::Value>& a, int i) { uint32_t h = bind::u32(a, i); auto& v = thr().modules; return h < v.size() ? v[h] : nullptr; }
Instance* instanceArg(const v8::FunctionCallbackInfo<v8::Value>& a, int i) { uint32_t h = bind::u32(a, i); auto& v = thr().instances; return h < v.size() ? v[h] : nullptr; }

void wCompile(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); Thread& t = thr();
  bind::Bytes b = a.Length() ? bind::bytes(a[0]) : bind::Bytes{};
  if (!b.ok) return bind::throwType(iso, "WebAssembly.compile(): Argument 0 must be a buffer source");
  if (!ensureRuntime()) return throwKind(iso, t.compileError, "the wasm interpreter did not start");
  auto* m = new Module(); m->bytes.assign(b.data, b.data + b.len);
  char err[256] = {0};
  {
    std::lock_guard<std::mutex> g(g_mu);
    LoadArgs la; memset(&la, 0, sizeof la); la.name = (char*)"wasm"; la.wasm_binary_freeable = false; la.no_resolve = true;
    m->m = wasm_runtime_load_ex(m->bytes.data(), (uint32_t)m->bytes.size(), &la, err, sizeof err);
    if (!m->m) { delete m; return throwKind(iso, t.compileError, std::string("WebAssembly.Module(): ") + err); }
    // Each function import's (module, field) as a raw native, once per process; then link them.
    const int32_t n = wasm_runtime_get_import_count(m->m);
    for (int32_t i = 0; i < n; ++i) {
      wasm_import_t im; wasm_runtime_get_import_type(m->m, i, &im);
      if (im.kind != WASM_IMPORT_EXPORT_KIND_FUNC) { m->keys.push_back(nullptr); continue; }
      auto k = std::make_pair(std::string(im.module_name), std::string(im.name));
      auto it = g_keys.find(k);
      if (it == g_keys.end()) {
        auto* key = new ImportKey{k.first, k.second, {}};
        key->sym.symbol = key->field.c_str(); key->sym.func_ptr = (void*)trampoline; key->sym.signature = nullptr; key->sym.attachment = key;
        wasm_runtime_register_natives_raw(key->module.c_str(), &key->sym, 1);
        it = g_keys.emplace(k, key).first;
      }
      m->keys.push_back(it->second);
    }
    wasm_runtime_resolve_symbols(m->m);
  }
  uint32_t handle = (uint32_t)t.modules.size(); t.modules.push_back(m);
  v8::Local<v8::Object> out = v8::Object::New(iso); bind::setNum(ctx, out, "handle", handle);
  v8::Local<v8::Array> imps = v8::Array::New(iso), exps = v8::Array::New(iso);
  for (int32_t i = 0; i < wasm_runtime_get_import_count(m->m); ++i) {
    wasm_import_t im; wasm_runtime_get_import_type(m->m, i, &im);
    v8::Local<v8::Object> o = v8::Object::New(iso); bind::setStr(ctx, o, "module", im.module_name); bind::setStr(ctx, o, "name", im.name); bind::setStr(ctx, o, "kind", kindName(im.kind));
    (void)imps->Set(ctx, (uint32_t)i, o);
  }
  for (int32_t i = 0; i < wasm_runtime_get_export_count(m->m); ++i) {
    wasm_export_t ex; wasm_runtime_get_export_type(m->m, i, &ex);
    v8::Local<v8::Object> o = v8::Object::New(iso); bind::setStr(ctx, o, "name", ex.name); bind::setStr(ctx, o, "kind", kindName(ex.kind));
    (void)exps->Set(ctx, (uint32_t)i, o);
  }
  bind::set(ctx, out, "imports", imps); bind::set(ctx, out, "exports", exps);
  a.GetReturnValue().Set(out);
}

void wInstantiate(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext(); Thread& t = thr();
  Module* m = moduleArg(a, 0); if (!m) return bind::throwType(iso, "WebAssembly.Instance(): not a module");
  if (a.Length() < 2 || !a[1]->IsArray()) return bind::throwType(iso, "WebAssembly.Instance(): imports");
  v8::Local<v8::Array> fns = a[1].As<v8::Array>();
  auto* in = new Instance(); in->iso = iso; in->ctx.Reset(iso, ctx);
  for (int32_t i = 0; i < wasm_runtime_get_import_count(m->m); ++i) {
    wasm_import_t im; wasm_runtime_get_import_type(m->m, i, &im);
    if (im.kind != WASM_IMPORT_EXPORT_KIND_FUNC) { delete in; return throwKind(iso, t.linkError, std::string("WebAssembly.Instance(): import ") + im.module_name + "." + im.name + ": imported " + kindName(im.kind) + "s are not supported by the wasm interpreter"); }
    v8::Local<v8::Value> fv; if (!fns->Get(ctx, (uint32_t)i).ToLocal(&fv) || !fv->IsFunction()) { delete in; return throwKind(iso, t.linkError, std::string("WebAssembly.Instance(): import ") + im.module_name + "." + im.name + " must be callable"); }
    ImportFn& f = in->imports[m->keys[(size_t)i]]; f.fn.Reset(iso, fv.As<v8::Function>());
    f.params.resize(wasm_func_type_get_param_count(im.u.func_type)); f.results.resize(wasm_func_type_get_result_count(im.u.func_type));
    for (uint32_t p = 0; p < f.params.size(); ++p) f.params[p] = wasm_func_type_get_param_valkind(im.u.func_type, p);
    for (uint32_t r = 0; r < f.results.size(); ++r) f.results[r] = wasm_func_type_get_result_valkind(im.u.func_type, r);
  }
  char err[256] = {0};
  t.instantiating = in;
  in->inst = wasm_runtime_instantiate(m->m, 1024 * 1024 /*the interpreter's wasm stack*/, 0, err, sizeof err);
  t.instantiating = nullptr;
  if (!in->inst) {
    delete in;
    if (t.hasPending) { v8::Local<v8::Value> e = t.pending.Get(iso); t.pending.Reset(); t.hasPending = false; iso->ThrowException(e); return; }  // a start function's import threw
    return throwKind(iso, t.linkError, std::string("WebAssembly.Instance(): ") + err);
  }
  wasm_runtime_set_custom_data(in->inst, in);
  in->env = wasm_runtime_get_exec_env_singleton(in->inst);
  uint32_t handle = (uint32_t)t.instances.size(); t.instances.push_back(in);
  v8::Local<v8::Object> out = v8::Object::New(iso); bind::setNum(ctx, out, "handle", handle);
  v8::Local<v8::Array> exps = v8::Array::New(iso);
  for (int32_t i = 0; i < wasm_runtime_get_export_count(m->m); ++i) {
    wasm_export_t ex; wasm_runtime_get_export_type(m->m, i, &ex);
    v8::Local<v8::Object> o = v8::Object::New(iso); bind::setStr(ctx, o, "name", ex.name); bind::setStr(ctx, o, "kind", kindName(ex.kind));
    if (ex.kind == WASM_IMPORT_EXPORT_KIND_FUNC) { wasm_function_inst_t f = wasm_runtime_lookup_function(in->inst, ex.name); if (f) bind::set(ctx, o, "fn", exportFunction(iso, ctx, in, f)); }
    (void)exps->Set(ctx, (uint32_t)i, o);
  }
  bind::set(ctx, out, "exports", exps);
  a.GetReturnValue().Set(out);
}

void wMemoryBuffer(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); Instance* in = instanceArg(a, 0); if (!in) return bind::throwType(iso, "not an instance");
  wasm_memory_inst_t mem = wasm_runtime_get_default_memory(in->inst); if (!mem) { a.GetReturnValue().SetNull(); return; }
  void* base = wasm_memory_get_base_address(mem); size_t size = (size_t)wasm_memory_get_cur_page_count(mem) * wasm_memory_get_bytes_per_page(mem);
  if (in->memBuf.IsEmpty() || base != in->memBase || size != in->memSize) {
    if (!in->memBuf.IsEmpty()) (void)in->memBuf.Get(iso)->Detach(v8::Local<v8::Value>());  // moved or grew: views on the old one go empty, as on a grow
    auto store = v8::ArrayBuffer::NewBackingStore(base, size, [](void*, size_t, void*) {}, nullptr);
    in->memBuf.Reset(iso, v8::ArrayBuffer::New(iso, std::move(store))); in->memBase = base; in->memSize = size;
  }
  a.GetReturnValue().Set(in->memBuf.Get(iso));
}

void wMemoryGrow(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); Instance* in = instanceArg(a, 0); if (!in) return bind::throwType(iso, "not an instance");
  wasm_memory_inst_t mem = wasm_runtime_get_default_memory(in->inst); if (!mem) { a.GetReturnValue().Set(-1); return; }
  const uint64_t old = wasm_memory_get_cur_page_count(mem);
  const bool ok = wasm_runtime_enlarge_memory(in->inst, bind::u32(a, 1));
  syncMemory(in);
  a.GetReturnValue().Set(ok ? (double)old : -1.0);
}

void wTableSize(const v8::FunctionCallbackInfo<v8::Value>& a) {
  Instance* in = instanceArg(a, 0); std::string name = bind::string(a, 1); wasm_table_inst_t tab;
  a.GetReturnValue().Set(in && wasm_runtime_get_export_table_inst(in->inst, name.c_str(), &tab) ? (double)tab.cur_size : 0.0);
}

void wTableGet(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); Instance* in = instanceArg(a, 0); std::string name = bind::string(a, 1); uint32_t i = bind::u32(a, 2); wasm_table_inst_t tab;
  if (!in || !wasm_runtime_get_export_table_inst(in->inst, name.c_str(), &tab)) return bind::throwType(iso, "WebAssembly.Table.get(): no such table");
  if (i >= tab.cur_size) { iso->ThrowException(v8::Exception::RangeError(bind::str(iso, "WebAssembly.Table.get(): invalid index"))); return; }
  wasm_function_inst_t f = wasm_table_get_func_inst(in->inst, &tab, i);
  if (!f) { a.GetReturnValue().SetNull(); return; }
  const uint64_t key = (std::hash<std::string>()(name) << 32) ^ i;
  auto it = in->tableFns.find(key);
  if (it == in->tableFns.end()) it = in->tableFns.emplace(key, v8::Global<v8::Function>(iso, exportFunction(iso, iso->GetCurrentContext(), in, f))).first;
  a.GetReturnValue().Set(it->second.Get(iso));
}

void wGlobalGet(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); Instance* in = instanceArg(a, 0); std::string name = bind::string(a, 1); wasm_global_inst_t gl;
  if (!in || !wasm_runtime_get_export_global_inst(in->inst, name.c_str(), &gl)) return bind::throwType(iso, "WebAssembly.Global: no such global");
  a.GetReturnValue().Set(toJs(iso, gl.kind, gl.global_data));
}

void wSetErrors(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate(); Thread& t = thr();
  if (a.Length() >= 3 && a[0]->IsFunction() && a[1]->IsFunction() && a[2]->IsFunction()) {
    t.compileError.Reset(iso, a[0].As<v8::Function>()); t.linkError.Reset(iso, a[1].As<v8::Function>()); t.runtimeError.Reset(iso, a[2].As<v8::Function>());
  }
}

}  // namespace

void installWasmInterp(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  v8::Local<v8::Object> o = bind::obj(ctx, native, "wasmi");
  bind::fn(ctx, o, "compile", wCompile); bind::fn(ctx, o, "instantiate", wInstantiate);
  bind::fn(ctx, o, "memoryBuffer", wMemoryBuffer); bind::fn(ctx, o, "memoryGrow", wMemoryGrow);
  bind::fn(ctx, o, "tableGet", wTableGet); bind::fn(ctx, o, "tableSize", wTableSize); bind::fn(ctx, o, "globalGet", wGlobalGet);
  bind::fn(ctx, o, "setErrors", wSetErrors);
  bind::setBool(ctx, o, "force", svc.config && svc.config->at("wasm").bo("interpreter", false));
}

// A worker's thread ends (js/worker.cpp, inside its isolate's scope, before Dispose): its instances, modules and
// WAMR thread env go. The import registry is process-wide by design and stays.
void uninstallWasmInterp() {
  Thread* t = t_thread; if (!t) return; t_thread = nullptr;
  for (Instance* in : t->instances) { if (in->inst) wasm_runtime_deinstantiate(in->inst); delete in; }
  { std::lock_guard<std::mutex> g(g_mu); for (Module* m : t->modules) { if (m->m) wasm_runtime_unload(m->m); delete m; } }
  const bool env = t->env; delete t;
  if (env && std::this_thread::get_id() != g_initThread) wasm_runtime_destroy_thread_env();
}
#endif

}  // namespace host
