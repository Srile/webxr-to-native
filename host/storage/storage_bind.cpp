// __native.storage (WP-26): the SQLite store (storage/kv.h) under IndexedDB and the Cache API, for a game whose
// host.json asks for either (storage.indexedDB, storage.cache; CMake HOST_STORAGE). runtime/src/storage builds the
// browser classes on it. Installed in the page's isolate and in every worker's (each isolate is one thread with its own
// connections, so a worker opens the same files the page does; WAL lets their readers run beside a writer):
//   open(kind, name, create) -> handle       kind 0: an IndexedDB database by name, 1: the cache store, 2: an IndexedDB
//   close(h)  list() -> [[stem, name|null]]    file by stem (list()); 0 when create is false and there is no file
//   drop(name) -> bool                       deletes a database's files (false while this thread has it open)
//   begin(h, write) commit(h) rollback(h)
//   get(h, ns, key, raw) has(h, ns, key) put(h, ns, key, bytes) del(h, ns, lo, hi) count(h, ns, lo, hi)
//   scan(h, ns, lo, hi, reverse, limit, mode) -> [packed keys, values...]      mode 0 keys, 1 cloned values, 2 bytes
//   ixPut(h, ns, key, pk) ixDelPk(h, ns, lo, hi) ixClear(h, ns) ixOther(h, ns, key, pk) ixCount(h, ns, lo, hi)
//   ixScan(h, ns, lo, hi, cK, cP, reverse, limit, storeNs, mode) -> [packed keys, packed pks, values...]
//   serialize(v) -> ArrayBuffer  deserialize(bytes) -> v    V8's structured clone; Blob and File as host objects
//   setBlobHooks(Blob.prototype, File.prototype)  the classes whose objects are cloned as Blobs and Files
//   epoch() -> n                             bumped when a microtask checkpoint completes: the end of a task
//   drain() -> bool                          runs the microtask checkpoint now (false inside one)
//   usage() -> bytes   quota   features {indexedDB, cache}
// Keys and ranges are bytes (ArrayBuffer or a view, read in place); packed keys are [u32 length LE, bytes]... Errors
// throw an Error named QuotaExceededError (the size cap) or UnknownError. Compiled only with HOST_STORAGE (storage.cmake).
#include "js/natives.h"
#include "core/fs.h"
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/v8compat.h"
#include "storage/kv.h"
#include <v8-value-serializer.h>
#include <chrono>
#include <cstring>
#include <memory>
#include <vector>

namespace host {
namespace {
using storage::Bytes;
using storage::Db;
using FCI = v8::FunctionCallbackInfo<v8::Value>;

HostServices* g_svc = nullptr;
std::string g_dir;           // <filesDir>/storage/<origin>
int64_t g_quota = 0;         // bytes, host.json storage.quotaMB
bool g_idb = false, g_cache = false;

struct Conn { std::string path; Db db; int refs = 0; };
// Each isolate is one thread: its connections, its task epoch and its usage estimate are thread-local.
struct ThreadStore {
  std::vector<std::unique_ptr<Conn>> conns;  // handle = index + 1
  v8::Isolate* iso = nullptr;
  uint32_t epoch = 0;
  std::vector<uint8_t> packK, packP;  // scan output, reused
};
thread_local ThreadStore t;

// ---- paths ----
std::string hex(const std::string& s) { static const char* d = "0123456789abcdef"; std::string o; o.reserve(s.size() * 2); for (unsigned char c : s) { o += d[c >> 4]; o += d[c & 15]; } return o; }
bool unhex(const std::string& h, std::string& out) {
  if (h.size() % 2) return false; out.clear();
  auto v = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; };
  for (size_t i = 0; i < h.size(); i += 2) { int a = v(h[i]), b = v(h[i + 1]); if (a < 0 || b < 0) return false; out += (char)(a * 16 + b); }
  return true;
}
// A database's file stem: its name's UTF-8 in hex ("d" + hex), or past 100 bytes a hash ("h" + FNV-1a 64), whose full
// name the runtime keeps inside the file (its schema record). Hex: any name, case kept on case-insensitive disks.
std::string stemOf(const std::string& name) {
  if (name.size() <= 100) return "d" + hex(name);
  uint64_t h = 1469598103934665603ull; for (unsigned char c : name) { h ^= c; h *= 1099511628211ull; }
  char b[24]; snprintf(b, sizeof b, "h%016llx", (unsigned long long)h); return b;
}
std::string idbPath(const std::string& stem) { return g_dir + "/idb/" + stem + ".sqlite"; }

// What the origin's databases take: a file this thread has open counts its pages in use (its WAL's included, its free
// pages not), any other its size on disk. skip: a file left out (the one whose cap is being set).
int64_t originBytes(const std::string& skip = {}) {
  std::error_code ec; int64_t n = 0;
  for (auto it = std::filesystem::recursive_directory_iterator(fsPath(g_dir), ec); !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
    if (!it->is_regular_file(ec) || it->path().extension() != ".sqlite") continue;
    const std::string path = it->path().string(); if (path == skip) continue;
    int64_t used = -1;
    for (auto& c : t.conns) if (c && c->path == path) { used = c->db.usedBytes(); break; }
    n += used >= 0 ? used : (int64_t)it->file_size(ec);
  }
  return n;
}

// ---- errors ----
void throwNamed(v8::Isolate* iso, const char* name, const std::string& msg) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> e = v8::Exception::Error(bind::str(iso, msg)).As<v8::Object>();
  e->Set(ctx, bind::str(iso, "name"), bind::str(iso, name)).Check();
  iso->ThrowException(e);
}
void throwDb(v8::Isolate* iso, const Db& db) {
  if (db.err() == storage::Err::Full) throwNamed(iso, "QuotaExceededError", "storage: over the quota (host.json storage.quotaMB)");
  else throwNamed(iso, "UnknownError", "storage: " + db.errmsg());
}

Conn* conn(const FCI& a) {
  const int h = bind::i32(a, 0);
  if (h <= 0 || h > (int)t.conns.size() || !t.conns[h - 1]) { throwNamed(a.GetIsolate(), "UnknownError", "storage: the database is closed"); return nullptr; }
  return t.conns[h - 1].get();
}
Bytes arg(const FCI& a, int i) { if (i >= a.Length()) return {}; bind::Bytes b = bind::bytes(a[i]); return Bytes{b.data, b.len}; }
int64_t i64(const FCI& a, int i, int64_t d = 0) { return i < a.Length() && a[i]->IsNumber() ? (int64_t)a[i].As<v8::Number>()->Value() : d; }

// ---- structured clone: V8's ValueSerializer, with the page's Blob and File as host objects ----
// A Blob is the runtime's (runtime/src/fetch/index.js): its bytes in _buf (a Uint8Array) and type; a File adds name,
// lastModified and webkitRelativePath. They are read and made here from those data properties and the two
// prototypes setBlobHooks registered, without calling into JS: V8 runs ReadHostObject where JS must not run.
v8::Local<v8::Private> hooksKey(v8::Isolate* iso) { return v8::Private::ForApi(iso, bind::str(iso, "webxr-host.storage.blobHooks")); }
struct Hooks { v8::Local<v8::Object> blob, file; bool ok = false; };
Hooks hooksOf(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Value> data) {
  Hooks h; v8::Local<v8::Value> v, b, f;
  if (!data->IsObject() || !data.As<v8::Object>()->GetPrivate(ctx, hooksKey(iso)).ToLocal(&v) || !v->IsArray()) return h;
  auto arr = v.As<v8::Array>();
  if (!arr->Get(ctx, 0).ToLocal(&b) || !b->IsObject() || !arr->Get(ctx, 1).ToLocal(&f) || !f->IsObject()) return h;
  h.blob = b.As<v8::Object>(); h.file = f.As<v8::Object>(); h.ok = true;
  return h;
}
bool inherits(v8::Local<v8::Object> o, v8::Local<v8::Object> proto) {
  v8::Local<v8::Value> p = o->GetPrototype();
  for (int depth = 0; depth < 32 && p->IsObject(); ++depth) { if (p == proto) return true; p = p.As<v8::Object>()->GetPrototype(); }
  return false;
}
constexpr uint32_t kBlobTag = 0x424c4201, kFileTag = 0x424c4202;  // "BLB" + version/kind

struct SerDelegate : v8::ValueSerializer::Delegate {
  v8::Isolate* iso; v8::Local<v8::Context> ctx; Hooks h; v8::ValueSerializer* ser = nullptr;
  SerDelegate(v8::Isolate* i, v8::Local<v8::Context> c, Hooks hk) : iso(i), ctx(c), h(hk) {}
  void ThrowDataCloneError(v8::Local<v8::String> m) override {
    v8::Local<v8::Object> e = v8::Exception::Error(m).As<v8::Object>(); e->Set(ctx, bind::str(iso, "name"), bind::str(iso, "DataCloneError")).Check(); iso->ThrowException(e);
  }
  bool HasCustomHostObject(v8::Isolate*) override { return h.ok; }
  v8::Maybe<bool> IsHostObject(v8::Isolate*, v8::Local<v8::Object> o) override { return v8::Just(inherits(o, h.blob)); }
  v8::Maybe<bool> WriteHostObject(v8::Isolate*, v8::Local<v8::Object> o) override {
    v8::Local<v8::Value> buf, type, name, lm;
    if (!o->Get(ctx, bind::str(iso, "_buf")).ToLocal(&buf) || !o->Get(ctx, bind::str(iso, "type")).ToLocal(&type)) return v8::Nothing<bool>();
    bind::Bytes b = bind::bytes(buf);
    if (!b.ok) { ThrowDataCloneError(bind::str(iso, "a Blob without its bytes")); return v8::Nothing<bool>(); }
    const bool file = inherits(o, h.file);
    v8::String::Utf8Value t(iso, type);
    ser->WriteUint32(file ? kFileTag : kBlobTag);
    ser->WriteUint32((uint32_t)t.length()); ser->WriteRawBytes(*t, (size_t)t.length());
    if (file) {
      if (!o->Get(ctx, bind::str(iso, "name")).ToLocal(&name) || !o->Get(ctx, bind::str(iso, "lastModified")).ToLocal(&lm)) return v8::Nothing<bool>();
      v8::String::Utf8Value nm(iso, name);
      ser->WriteUint32((uint32_t)nm.length()); ser->WriteRawBytes(*nm, (size_t)nm.length());
      ser->WriteDouble(lm->IsNumber() ? lm.As<v8::Number>()->Value() : 0);
    }
    ser->WriteUint64(b.len); ser->WriteRawBytes(b.data, b.len);
    return v8::Just(true);
  }
};
struct DesDelegate : v8::ValueDeserializer::Delegate {
  v8::Isolate* iso; v8::Local<v8::Context> ctx; Hooks h; v8::ValueDeserializer* des = nullptr;
  DesDelegate(v8::Isolate* i, v8::Local<v8::Context> c, Hooks hk) : iso(i), ctx(c), h(hk) {}
  v8::MaybeLocal<v8::Object> ReadHostObject(v8::Isolate*) override {
    uint32_t tag = 0, n = 0; const void* p = nullptr; double lm = 0;
    auto bad = [&] { throwNamed(iso, "DataCloneError", "storage: an unreadable Blob in a stored value"); return v8::MaybeLocal<v8::Object>(); };
    if (!h.ok || !des->ReadUint32(&tag) || (tag != kBlobTag && tag != kFileTag)) return bad();
    if (!des->ReadUint32(&n) || !des->ReadRawBytes(n, &p)) return bad();
    v8::Local<v8::Name> names[5] = {bind::str(iso, "_buf"), bind::str(iso, "type"), bind::str(iso, "name"), bind::str(iso, "lastModified"), bind::str(iso, "webkitRelativePath")};
    v8::Local<v8::Value> values[5] = {v8::Undefined(iso), bind::str(iso, std::string((const char*)p, n)), v8::Undefined(iso), v8::Undefined(iso), bind::str(iso, "")};
    if (tag == kFileTag) {
      if (!des->ReadUint32(&n) || !des->ReadRawBytes(n, &p) ) return bad();
      values[2] = bind::str(iso, std::string((const char*)p, n));
      if (!des->ReadDouble(&lm)) return bad();
      values[3] = v8::Number::New(iso, lm);
    }
    uint64_t len = 0;
    if (!des->ReadUint64(&len) || !des->ReadRawBytes((size_t)len, &p)) return bad();
    auto store = v8::ArrayBuffer::NewBackingStore(iso, (size_t)len); if (len) memcpy(store->Data(), p, (size_t)len);
    values[0] = v8::Uint8Array::New(v8::ArrayBuffer::New(iso, std::move(store)), 0, (size_t)len);
    return v8::Object::New(iso, tag == kFileTag ? h.file : h.blob, names, values, tag == kFileTag ? 5 : 2);
  }
};
// The clone's bytes, malloc'd by V8 (free them). False: an exception is pending.
bool serializeTo(v8::Isolate* iso, v8::Local<v8::Context> ctx, const Hooks& h, v8::Local<v8::Value> v, std::pair<uint8_t*, size_t>& out) {
  SerDelegate d(iso, ctx, h); v8::ValueSerializer ser(iso, &d); d.ser = &ser;
  ser.WriteHeader();
  bool ok = false; if (!ser.WriteValue(ctx, v).To(&ok) || !ok) return false;
  out = ser.Release(); return true;
}
v8::MaybeLocal<v8::Value> deserializeFrom(v8::Isolate* iso, v8::Local<v8::Context> ctx, const Hooks& h, Bytes b) {
  DesDelegate d(iso, ctx, h); v8::ValueDeserializer des(iso, (const uint8_t*)b.p, b.n, &d); d.des = &des;
  bool hdr = false;
  if (!des.ReadHeader(ctx).To(&hdr) || !hdr) { throwNamed(iso, "UnknownError", "storage: a stored value is unreadable"); return {}; }
  return des.ReadValue(ctx);
}
v8::Local<v8::ArrayBuffer> copyOut(v8::Isolate* iso, Bytes b) {
  auto store = v8::ArrayBuffer::NewBackingStore(iso, b.n); if (b.n) memcpy(store->Data(), b.p, b.n);
  return v8::ArrayBuffer::New(iso, std::move(store));
}
void pack(std::vector<uint8_t>& out, Bytes b) {
  const uint32_t n = (uint32_t)b.n; const size_t at = out.size();
  out.resize(at + 4 + b.n); memcpy(out.data() + at, &n, 4); if (b.n) memcpy(out.data() + at + 4, b.p, b.n);  // little-endian hosts only
}

// ---- functions ----
void sOpen(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate();
  const int kind = bind::i32(a, 0); const std::string name = bind::string(a, 1); const bool create = bind::boolean(a, 2);
  if ((kind == 1 && !g_cache) || (kind != 1 && !g_idb)) { throwNamed(iso, "UnknownError", "storage: not enabled in host.json"); return; }
  std::string path;
  if (kind == 1) path = g_dir + "/cache.sqlite";
  else if (kind == 2) { if (name.empty() || name.find_first_of("/\\.") != std::string::npos) { a.GetReturnValue().Set(0); return; } path = idbPath(name); }
  else path = idbPath(stemOf(name));
  for (size_t i = 0; i < t.conns.size(); ++i) if (t.conns[i] && t.conns[i]->path == path) { t.conns[i]->refs++; a.GetReturnValue().Set((int)i + 1); return; }
  std::error_code ec;
  if (!create && !std::filesystem::exists(fsPath(path), ec)) { a.GetReturnValue().Set(0); return; }
  std::filesystem::create_directories(fsPath(path).parent_path(), ec);
  auto c = std::make_unique<Conn>(); c->path = path; c->refs = 1;
  // The quota over every file of the origin: this file may grow by what the others leave (as they are now).
  int64_t cap = 0;
  if (g_quota > 0) cap = std::max<int64_t>(g_quota - originBytes(fsPath(path).string()), 4096);
  if (!c->db.open(path, create, cap)) { HOST_LOGE("storage: open %s: %s", path.c_str(), c->db.errmsg().c_str()); throwDb(iso, c->db); return; }
  size_t slot = 0; while (slot < t.conns.size() && t.conns[slot]) ++slot;
  if (slot == t.conns.size()) t.conns.emplace_back(); t.conns[slot] = std::move(c);
  a.GetReturnValue().Set((int)slot + 1);
}
void sClose(const FCI& a) {
  const int h = bind::i32(a, 0); if (h <= 0 || h > (int)t.conns.size() || !t.conns[h - 1]) return;
  if (--t.conns[h - 1]->refs <= 0) t.conns[h - 1].reset();
}
void sList(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> out = v8::Array::New(iso); uint32_t n = 0; std::error_code ec;
  for (auto it = std::filesystem::directory_iterator(fsPath(g_dir + "/idb"), ec); !ec && it != std::filesystem::directory_iterator(); it.increment(ec)) {
    const auto p = it->path(); if (p.extension() != ".sqlite") continue;
    const std::string stem = p.stem().string(); std::string name;
    v8::Local<v8::Array> e = v8::Array::New(iso, 2);
    e->Set(ctx, 0, bind::str(iso, stem)).Check();
    if (stem.size() > 1 && stem[0] == 'd' && unhex(stem.substr(1), name)) e->Set(ctx, 1, bind::str(iso, name)).Check(); else e->Set(ctx, 1, v8::Null(iso)).Check();
    out->Set(ctx, n++, e).Check();
  }
  a.GetReturnValue().Set(out);
}
void sDrop(const FCI& a) {
  const std::string path = idbPath(stemOf(bind::string(a, 0)));
  for (auto& c : t.conns) if (c && c->path == path) { a.GetReturnValue().Set(false); return; }
  std::error_code ec;
  for (const char* sfx : {"", "-wal", "-shm"}) std::filesystem::remove(fsPath(path + sfx), ec);
  a.GetReturnValue().Set(true);
}
void sBegin(const FCI& a) { if (Conn* c = conn(a)) if (!c->db.begin(bind::boolean(a, 1))) throwDb(a.GetIsolate(), c->db); }
void sCommit(const FCI& a) { if (Conn* c = conn(a)) if (!c->db.commit()) throwDb(a.GetIsolate(), c->db); }
void sRollback(const FCI& a) { if (Conn* c = conn(a)) if (c->db.inTxn() && !c->db.rollback()) throwDb(a.GetIsolate(), c->db); }

void sGet(const FCI& a) {
  Conn* c = conn(a); if (!c) return;
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  Bytes v; const int r = c->db.get(i64(a, 1), arg(a, 2), v);
  if (r < 0) return throwDb(iso, c->db);
  if (r == 0) return;  // undefined
  if (bind::boolean(a, 3)) a.GetReturnValue().Set(copyOut(iso, v));
  else { v8::Local<v8::Value> out; if (deserializeFrom(iso, ctx, hooksOf(iso, ctx, a.Data()), v).ToLocal(&out)) a.GetReturnValue().Set(out); }
  c->db.release();
}
void sHas(const FCI& a) { Conn* c = conn(a); if (!c) return; const int r = c->db.has(i64(a, 1), arg(a, 2)); if (r < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set(r == 1); }
void sPut(const FCI& a) { Conn* c = conn(a); if (!c) return; if (!c->db.put(i64(a, 1), arg(a, 2), arg(a, 3))) throwDb(a.GetIsolate(), c->db); }
void sDel(const FCI& a) { Conn* c = conn(a); if (!c) return; const int64_t n = c->db.del(i64(a, 1), arg(a, 2), arg(a, 3)); if (n < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set((double)n); }
void sCount(const FCI& a) { Conn* c = conn(a); if (!c) return; const int64_t n = c->db.count(i64(a, 1), arg(a, 2), arg(a, 3)); if (n < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set((double)n); }

struct ScanCtx { v8::Isolate* iso; v8::Local<v8::Context> ctx; v8::Local<v8::Array> out; uint32_t n; int mode; bool pks; Hooks h; bool failed; };
bool onRow(void* p, Bytes k, Bytes pk, Bytes v) {
  auto* s = (ScanCtx*)p;
  pack(t.packK, k); if (s->pks) pack(t.packP, pk);
  if (s->mode == 1) { v8::Local<v8::Value> val; if (!deserializeFrom(s->iso, s->ctx, s->h, v).ToLocal(&val)) { s->failed = true; return false; } s->out->Set(s->ctx, s->n++, val).Check(); }
  else if (s->mode == 2) s->out->Set(s->ctx, s->n++, copyOut(s->iso, v)).Check();
  return true;
}
void finishScan(const FCI& a, ScanCtx& s, int64_t rows, Db& db) {
  if (s.failed) return;  // the exception is pending
  if (rows < 0) return throwDb(s.iso, db);
  s.out->Set(s.ctx, 0, copyOut(s.iso, Bytes{t.packK.data(), t.packK.size()})).Check();
  if (s.pks) s.out->Set(s.ctx, 1, copyOut(s.iso, Bytes{t.packP.data(), t.packP.size()})).Check();
  a.GetReturnValue().Set(s.out);
}
void sScan(const FCI& a) {  // (h, ns, lo, hi, reverse, limit, mode)
  Conn* c = conn(a); if (!c) return;
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  ScanCtx s{iso, ctx, v8::Array::New(iso), 1, bind::i32(a, 6), false, {}, false};
  if (s.mode == 1) s.h = hooksOf(iso, ctx, a.Data());
  t.packK.clear();
  const int64_t rows = c->db.scan(i64(a, 1), arg(a, 2), arg(a, 3), bind::boolean(a, 4), i64(a, 5, -1), s.mode != 0, onRow, &s);
  finishScan(a, s, rows, c->db);
}
void sIxPut(const FCI& a) { Conn* c = conn(a); if (!c) return; if (!c->db.ixPut(i64(a, 1), arg(a, 2), arg(a, 3))) throwDb(a.GetIsolate(), c->db); }
void sIxDelPk(const FCI& a) { Conn* c = conn(a); if (!c) return; const int64_t n = c->db.ixDelPk(i64(a, 1), arg(a, 2), arg(a, 3)); if (n < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set((double)n); }
void sIxClear(const FCI& a) { Conn* c = conn(a); if (!c) return; const int64_t n = c->db.ixClear(i64(a, 1)); if (n < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set((double)n); }
void sIxOther(const FCI& a) { Conn* c = conn(a); if (!c) return; const int r = c->db.ixOther(i64(a, 1), arg(a, 2), arg(a, 3)); if (r < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set(r == 1); }
void sIxCount(const FCI& a) { Conn* c = conn(a); if (!c) return; const int64_t n = c->db.ixCount(i64(a, 1), arg(a, 2), arg(a, 3)); if (n < 0) return throwDb(a.GetIsolate(), c->db); a.GetReturnValue().Set((double)n); }
void sIxScan(const FCI& a) {  // (h, ns, lo, hi, cK, cP, reverse, limit, storeNs, mode)
  Conn* c = conn(a); if (!c) return;
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  ScanCtx s{iso, ctx, v8::Array::New(iso), 2, bind::i32(a, 9), true, {}, false};
  if (s.mode == 1) s.h = hooksOf(iso, ctx, a.Data());
  t.packK.clear(); t.packP.clear();
  const int64_t rows = c->db.ixScan(i64(a, 1), arg(a, 2), arg(a, 3), arg(a, 4), arg(a, 5), bind::boolean(a, 6), i64(a, 7, -1), s.mode != 0 ? i64(a, 8, -1) : -1, onRow, &s);
  finishScan(a, s, rows, c->db);
}

void sSerialize(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  std::pair<uint8_t*, size_t> buf{nullptr, 0};
  if (!serializeTo(iso, ctx, hooksOf(iso, ctx, a.Data()), a[0], buf)) return;
  a.GetReturnValue().Set(copyOut(iso, Bytes{buf.first, buf.second})); free(buf.first);
}
void sDeserialize(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  Bytes b = arg(a, 0); if (!b.p && b.n == 0) return;
  v8::Local<v8::Value> out; if (deserializeFrom(iso, ctx, hooksOf(iso, ctx, a.Data()), b).ToLocal(&out)) a.GetReturnValue().Set(out);
}
void sSetBlobHooks(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!a.Data()->IsObject()) return;
  if (!a[0]->IsObject() || !a[1]->IsObject()) return bind::throwType(iso, "setBlobHooks(Blob.prototype, File.prototype)");
  v8::Local<v8::Array> arr = v8::Array::New(iso, 2); arr->Set(ctx, 0, a[0]).Check(); arr->Set(ctx, 1, a[1]).Check();
  (void)a.Data().As<v8::Object>()->SetPrivate(ctx, hooksKey(iso), arr);
}
void sEpoch(const FCI& a) { a.GetReturnValue().Set(t.epoch); }
void sDrain(const FCI& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (v8::MicrotasksScope::IsRunningMicrotasks(iso)) { a.GetReturnValue().Set(false); return; }
  iso->PerformMicrotaskCheckpoint();
  a.GetReturnValue().Set(true);
}
void sUsage(const FCI& a) { a.GetReturnValue().Set((double)originBytes()); }

void onMicrotasksDone(v8::Isolate*, void*) { ++t.epoch; }

std::string originDirName(std::string origin) {
  for (const char* p : {"https://", "http://"}) if (origin.rfind(p, 0) == 0) { origin = std::string(p, strlen(p) - 3) + "_" + origin.substr(strlen(p)); break; }
  for (char& ch : origin) if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '_')) ch = '_';
  return origin.empty() ? "default" : origin;
}
}  // namespace

void installStorage(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  const Json& cfg = svc.config->at("storage");
  const bool idb = cfg.bo("indexedDB", false), cache = cfg.bo("cache", false);
  if (!idb && !cache) return;  // built in, but this host.json asks for neither: the page sees none of it
  v8::Isolate* iso = isolateOf(ctx);
  static bool once = false;
  if (!once) {
    once = true; g_svc = &svc; g_idb = idb; g_cache = cache;
    g_quota = (int64_t)(std::max(0.0, cfg.n("quotaMB", 1024)) * 1024 * 1024);
    std::string origin = svc.config->at("web").s("origin", "https://app.local"); while (!origin.empty() && origin.back() == '/') origin.pop_back();
    g_dir = svc.filesDir + "/storage/" + originDirName(origin);
    HOST_LOGI("storage: %s%s%s under %s, quota %lld MB (SQLite %s)", idb ? "IndexedDB" : "", idb && cache ? " + " : "", cache ? "Cache API" : "", g_dir.c_str(), (long long)(g_quota >> 20), storage::sqliteVersion());
  }
  if (t.iso != iso) { t.iso = iso; iso->AddMicrotasksCompletedCallback(onMicrotasksDone, nullptr); }
  v8::Local<v8::Object> s = bind::obj(ctx, native, "storage");
  using Fn = void (*)(const FCI&);
  const std::pair<const char*, Fn> fns[] = {
    {"open", sOpen}, {"close", sClose}, {"list", sList}, {"drop", sDrop}, {"begin", sBegin}, {"commit", sCommit}, {"rollback", sRollback},
    {"get", sGet}, {"has", sHas}, {"put", sPut}, {"del", sDel}, {"count", sCount}, {"scan", sScan},
    {"ixPut", sIxPut}, {"ixDelPk", sIxDelPk}, {"ixClear", sIxClear}, {"ixOther", sIxOther}, {"ixCount", sIxCount}, {"ixScan", sIxScan},
    {"serialize", sSerialize}, {"deserialize", sDeserialize}, {"setBlobHooks", sSetBlobHooks}, {"epoch", sEpoch}, {"drain", sDrain}, {"usage", sUsage},
  };
  for (auto& [name, fn] : fns) bind::fn(ctx, s, name, fn, s);  // data: the object itself, which holds the Blob hooks
  bind::setNum(ctx, s, "quota", (double)g_quota);
  v8::Local<v8::Object> f = bind::obj(ctx, s, "features");
  bind::setBool(ctx, f, "indexedDB", g_idb); bind::setBool(ctx, f, "cache", g_cache);
}

}  // namespace host
