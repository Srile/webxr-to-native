// The SQLite store under IndexedDB and the Cache API (WP-26); see kv.h. Compiled only with HOST_STORAGE (storage.cmake)
// and in host/tests' storage_test.
#include "storage/kv.h"
#include <sqlite3.h>
#include <mutex>

namespace host::storage {
namespace {
// The schema: a rowid table for the records (values can be megabytes: WITHOUT ROWID wants small rows) with a unique
// index on (ns, key), and a WITHOUT ROWID table for index entries (small rows, ordered by the primary key itself) with
// a second index by primary key, which deleting a record's entries walks. BLOB columns have no affinity: SQLite
// compares them with memcmp, then length.
const char* kSchema =
  "CREATE TABLE IF NOT EXISTS kv(ns INTEGER NOT NULL, key BLOB NOT NULL, val BLOB NOT NULL);"
  "CREATE UNIQUE INDEX IF NOT EXISTS kv_key ON kv(ns, key);"
  "CREATE TABLE IF NOT EXISTS ix(ns INTEGER NOT NULL, key BLOB NOT NULL, pk BLOB NOT NULL, PRIMARY KEY(ns, key, pk)) WITHOUT ROWID;"
  "CREATE INDEX IF NOT EXISTS ix_pk ON ix(ns, pk);"
  "PRAGMA user_version=1;";

const char* kSql[Db::kNQ] = {
  "SELECT val FROM kv WHERE ns=?1 AND key=?2",
  "SELECT 1 FROM kv WHERE ns=?1 AND key=?2",
  "INSERT INTO kv(ns,key,val) VALUES(?1,?2,?3) ON CONFLICT(ns,key) DO UPDATE SET val=excluded.val",
  "DELETE FROM kv WHERE ns=?1 AND key>=?2 AND key<?3",
  "SELECT count(*) FROM kv WHERE ns=?1 AND key>=?2 AND key<?3",
  "SELECT key FROM kv WHERE ns=?1 AND key>=?2 AND key<?3 ORDER BY key LIMIT ?4",
  "SELECT key FROM kv WHERE ns=?1 AND key>=?2 AND key<?3 ORDER BY key DESC LIMIT ?4",
  "SELECT key, val FROM kv WHERE ns=?1 AND key>=?2 AND key<?3 ORDER BY key LIMIT ?4",
  "SELECT key, val FROM kv WHERE ns=?1 AND key>=?2 AND key<?3 ORDER BY key DESC LIMIT ?4",
  "INSERT OR IGNORE INTO ix(ns,key,pk) VALUES(?1,?2,?3)",
  "DELETE FROM ix WHERE ns=?1 AND pk>=?2 AND pk<?3",
  "DELETE FROM ix WHERE ns=?1",
  "SELECT 1 FROM ix WHERE ns=?1 AND key=?2 AND pk<>?3 LIMIT 1",
  "SELECT count(*) FROM ix WHERE ns=?1 AND key>=?2 AND key<?3",
  "SELECT key, pk FROM ix WHERE ns=?1 AND key>=?2 AND key<?3 AND (key,pk)>=(?4,?5) ORDER BY key, pk LIMIT ?6",
  "SELECT key, pk FROM ix WHERE ns=?1 AND key>=?2 AND key<?3 AND (key,pk)<(?4,?5) ORDER BY key DESC, pk DESC LIMIT ?6",
  "SELECT ix.key, ix.pk, kv.val FROM ix CROSS JOIN kv ON kv.ns=?7 AND kv.key=ix.pk WHERE ix.ns=?1 AND ix.key>=?2 AND ix.key<?3 AND (ix.key,ix.pk)>=(?4,?5) ORDER BY ix.key, ix.pk LIMIT ?6",
  "SELECT ix.key, ix.pk, kv.val FROM ix CROSS JOIN kv ON kv.ns=?7 AND kv.key=ix.pk WHERE ix.ns=?1 AND ix.key>=?2 AND ix.key<?3 AND (ix.key,ix.pk)<(?4,?5) ORDER BY ix.key DESC, ix.pk DESC LIMIT ?6",
  "BEGIN", "BEGIN IMMEDIATE", "COMMIT", "ROLLBACK",
  "SELECT (page_count - freelist_count) * page_size FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()",
};

// A zero-length BLOB, not NULL (sqlite3_bind_blob binds NULL for a null pointer, and NULL compares as nothing).
void bindB(sqlite3_stmt* s, int i, Bytes b) {
  if (b.n == 0) sqlite3_bind_zeroblob(s, i, 0);
  else sqlite3_bind_blob64(s, i, b.p, (sqlite3_uint64)b.n, SQLITE_STATIC);  // the caller's bytes, not copied
}
Bytes colB(sqlite3_stmt* s, int i) { Bytes b; b.p = sqlite3_column_blob(s, i); b.n = (size_t)sqlite3_column_bytes(s, i); return b; }
struct Reset { sqlite3_stmt* s; ~Reset() { if (s) { sqlite3_reset(s); sqlite3_clear_bindings(s); } } };
}  // namespace

const char* sqliteVersion() { return sqlite3_libversion(); }

bool Db::fail(int rc) {
  const int p = rc & 0xFF;
  err_ = p == SQLITE_FULL ? Err::Full : (p == SQLITE_BUSY || p == SQLITE_LOCKED) ? Err::Busy : Err::Other;
  msg_ = db_ ? sqlite3_errmsg(db_) : sqlite3_errstr(rc);
  return false;
}

bool Db::open(const std::string& path, bool create, int64_t maxBytes) {
  close();
  static std::once_flag init; std::call_once(init, [] { sqlite3_initialize(); });
  err_ = Err::None; msg_.clear();
  const int flags = SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0) | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_EXRESCODE;
  int rc = sqlite3_open_v2(path.c_str(), &db_, flags, nullptr);
  if (rc != SQLITE_OK) { fail(rc); sqlite3_close(db_); db_ = nullptr; return false; }
  sqlite3_busy_timeout(db_, 5000);  // another isolate's write transaction (a worker on the same file)
  sqlite3_limit(db_, SQLITE_LIMIT_ATTACHED, 0);
  char* em = nullptr;
  // WAL; the log cut back to 1 MB when a checkpoint empties it (a transaction rolled back at the quota leaves its pages there).
  rc = sqlite3_exec(db_, "PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576", nullptr, nullptr, &em);
  if (rc == SQLITE_OK) rc = sqlite3_exec(db_, kSchema, nullptr, nullptr, &em);
  if (rc == SQLITE_OK && maxBytes > 0) {
    const std::string cap = "PRAGMA max_page_count=" + std::to_string(maxBytes / 4096 + 1);  // 4096: SQLite's default page size
    rc = sqlite3_exec(db_, cap.c_str(), nullptr, nullptr, &em);
  }
  if (em) sqlite3_free(em);
  if (rc != SQLITE_OK) { fail(rc); close(); return false; }
  return true;
}

void Db::close() {
  for (auto& s : st_) if (s) { sqlite3_finalize(s); s = nullptr; }
  held_ = nullptr;
  if (db_) { if (txn_) sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr); sqlite3_close(db_); db_ = nullptr; }
  txn_ = false;
}

sqlite3_stmt* Db::q(Q id) {
  if (held_) release();
  if (!st_[id] && sqlite3_prepare_v3(db_, kSql[id], -1, SQLITE_PREPARE_PERSISTENT, &st_[id], nullptr) != SQLITE_OK) { fail(sqlite3_errcode(db_)); return nullptr; }
  return st_[id];
}
int64_t Db::changes(sqlite3_stmt* s) {
  const int rc = sqlite3_step(s);
  if (rc != SQLITE_DONE) { fail(rc); return -1; }
  return (int64_t)sqlite3_changes64(db_);
}

bool Db::begin(bool write) {
  sqlite3_stmt* s = q(write ? kBeginW : kBeginR); if (!s) return false; Reset r{s};
  const int rc = sqlite3_step(s); if (rc != SQLITE_DONE) return fail(rc);
  txn_ = true; return true;
}
bool Db::commit() {
  sqlite3_stmt* s = q(kCommit); if (!s) return false; Reset r{s};
  const int rc = sqlite3_step(s);
  if (rc != SQLITE_DONE) { fail(rc); if (sqlite3_get_autocommit(db_)) txn_ = false; return false; }
  txn_ = false; return true;
}
bool Db::rollback() {
  sqlite3_stmt* s = q(kRollback); if (!s) return false; Reset r{s};
  const int rc = sqlite3_step(s); txn_ = false;
  return rc == SQLITE_DONE || (sqlite3_get_autocommit(db_) ? true : fail(rc));
}

int Db::get(int64_t ns, Bytes key, Bytes& val) {
  sqlite3_stmt* s = q(kGet); if (!s) return -1;
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, key);
  const int rc = sqlite3_step(s);
  if (rc == SQLITE_ROW) { val = colB(s, 0); held_ = s; return 1; }
  sqlite3_reset(s); sqlite3_clear_bindings(s);
  if (rc == SQLITE_DONE) return 0;
  fail(rc); return -1;
}
void Db::release() { if (held_) { sqlite3_reset(held_); sqlite3_clear_bindings(held_); held_ = nullptr; } }
int Db::has(int64_t ns, Bytes key) {
  sqlite3_stmt* s = q(kHas); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, key);
  const int rc = sqlite3_step(s);
  if (rc == SQLITE_ROW) return 1;
  if (rc == SQLITE_DONE) return 0;
  fail(rc); return -1;
}
bool Db::put(int64_t ns, Bytes key, Bytes val) {
  sqlite3_stmt* s = q(kPut); if (!s) return false; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, key); bindB(s, 3, val);
  const int rc = sqlite3_step(s);
  return rc == SQLITE_DONE || fail(rc);
}
int64_t Db::del(int64_t ns, Bytes lo, Bytes hi) {
  sqlite3_stmt* s = q(kDel); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi);
  return changes(s);
}
int64_t Db::count(int64_t ns, Bytes lo, Bytes hi) {
  sqlite3_stmt* s = q(kCount); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi);
  const int rc = sqlite3_step(s);
  if (rc == SQLITE_ROW) return sqlite3_column_int64(s, 0);
  fail(rc); return -1;
}
int64_t Db::scan(int64_t ns, Bytes lo, Bytes hi, bool reverse, int64_t limit, bool values, RowFn f, void* ctx) {
  sqlite3_stmt* s = q(values ? (reverse ? kScanVD : kScanVA) : (reverse ? kScanKD : kScanKA)); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi); sqlite3_bind_int64(s, 4, limit < 0 ? -1 : limit);
  int64_t n = 0; int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    ++n;
    if (!f(ctx, colB(s, 0), Bytes{}, values ? colB(s, 1) : Bytes{})) return n;
  }
  if (rc != SQLITE_DONE) { fail(rc); return -1; }
  return n;
}

bool Db::ixPut(int64_t ns, Bytes key, Bytes pk) {
  sqlite3_stmt* s = q(kIxPut); if (!s) return false; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, key); bindB(s, 3, pk);
  const int rc = sqlite3_step(s);
  return rc == SQLITE_DONE || fail(rc);
}
int64_t Db::ixDelPk(int64_t ns, Bytes lo, Bytes hi) {
  sqlite3_stmt* s = q(kIxDelPk); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi);
  return changes(s);
}
int64_t Db::ixClear(int64_t ns) {
  sqlite3_stmt* s = q(kIxClear); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns);
  return changes(s);
}
int Db::ixOther(int64_t ns, Bytes key, Bytes pk) {
  sqlite3_stmt* s = q(kIxOther); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, key); bindB(s, 3, pk);
  const int rc = sqlite3_step(s);
  if (rc == SQLITE_ROW) return 1;
  if (rc == SQLITE_DONE) return 0;
  fail(rc); return -1;
}
int64_t Db::ixCount(int64_t ns, Bytes lo, Bytes hi) {
  sqlite3_stmt* s = q(kIxCount); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi);
  const int rc = sqlite3_step(s);
  if (rc == SQLITE_ROW) return sqlite3_column_int64(s, 0);
  fail(rc); return -1;
}
int64_t Db::ixScan(int64_t ns, Bytes lo, Bytes hi, Bytes cK, Bytes cP, bool reverse, int64_t limit, int64_t storeNs, RowFn f, void* ctx) {
  const bool values = storeNs >= 0;
  sqlite3_stmt* s = q(values ? (reverse ? kIxScanVD : kIxScanVA) : (reverse ? kIxScanKD : kIxScanKA)); if (!s) return -1; Reset r{s};
  sqlite3_bind_int64(s, 1, ns); bindB(s, 2, lo); bindB(s, 3, hi); bindB(s, 4, cK); bindB(s, 5, cP);
  sqlite3_bind_int64(s, 6, limit < 0 ? -1 : limit);
  if (values) sqlite3_bind_int64(s, 7, storeNs);
  int64_t n = 0; int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    ++n;
    if (!f(ctx, colB(s, 0), colB(s, 1), values ? colB(s, 2) : Bytes{})) return n;
  }
  if (rc != SQLITE_DONE) { fail(rc); return -1; }
  return n;
}

int64_t Db::usedBytes() {
  sqlite3_stmt* s = q(kPages); if (!s) return -1; Reset r{s};
  return sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : -1;
}

}  // namespace host::storage
