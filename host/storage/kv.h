#pragma once
// The store under IndexedDB and the Cache API (WP-26): one SQLite file (WAL), two tables of BLOBs that SQLite orders
// by memcmp, so the byte order of the runtime's key encoding (runtime/src/storage/keys.js) is the order of the keys:
//   kv (ns, key) -> val        records: an object store's (ns = its id), the schema (ns 0), a cache's entries
//   ix (ns, key, pk)           index entries: an index's key and the primary key of its record, both encoded
// Ranges are half-open [lo, hi): an empty lo is unbounded below; hi = {0xFF} above every encoded key. Prepared
// statements are made once per connection and reused; nothing here allocates per call. No V8: storage_bind.cpp binds
// it as __native.storage, host/tests/storage_test.cpp tests it alone. One Db per thread (SQLITE_THREADSAFE=2).
#include <cstddef>
#include <cstdint>
#include <string>

struct sqlite3;
struct sqlite3_stmt;

namespace host::storage {

struct Bytes { const void* p = nullptr; size_t n = 0; };
// One row of a scan: kv rows have no pk; key-only scans have no val. The pointers live until the next row.
using RowFn = bool (*)(void* ctx, Bytes key, Bytes pk, Bytes val);  // false: stop

enum class Err { None, Busy, Full, Other };
const char* sqliteVersion();

class Db {
 public:
  Db() = default;
  ~Db() { close(); }
  Db(const Db&) = delete;
  Db& operator=(const Db&) = delete;

  // Opens (creating when asked) the file, WAL, the schema; maxBytes > 0 caps the file (SQLITE_FULL past it).
  bool open(const std::string& path, bool create, int64_t maxBytes);
  void close();
  bool isOpen() const { return db_ != nullptr; }

  bool begin(bool write);  // BEGIN (a read snapshot) or BEGIN IMMEDIATE (the write lock now)
  bool commit();
  bool rollback();
  bool inTxn() const { return txn_; }

  // kv
  int get(int64_t ns, Bytes key, Bytes& val);  // 1 found (val valid until the next call on this Db), 0 none, -1 error
  void release();                              // ends a get early (its row)
  int has(int64_t ns, Bytes key);              // 1 / 0 / -1
  bool put(int64_t ns, Bytes key, Bytes val);
  int64_t del(int64_t ns, Bytes lo, Bytes hi);  // rows deleted, -1 error
  int64_t count(int64_t ns, Bytes lo, Bytes hi);
  int64_t scan(int64_t ns, Bytes lo, Bytes hi, bool reverse, int64_t limit, bool values, RowFn f, void* ctx);

  // ix
  bool ixPut(int64_t ns, Bytes key, Bytes pk);
  int64_t ixDelPk(int64_t ns, Bytes lo, Bytes hi);  // the entries whose primary key is in [lo, hi)
  int64_t ixClear(int64_t ns);
  int ixOther(int64_t ns, Bytes key, Bytes pk);     // an entry with this key and another primary key: 1 / 0 / -1
  int64_t ixCount(int64_t ns, Bytes lo, Bytes hi);
  // Entries with key in [lo, hi) and (key, pk) >= (cK, cP) ascending, or (key, pk) < (cK, cP) descending; with
  // storeNs >= 0 each row carries the record's value from kv (ns = storeNs, key = pk).
  int64_t ixScan(int64_t ns, Bytes lo, Bytes hi, Bytes cK, Bytes cP, bool reverse, int64_t limit, int64_t storeNs, RowFn f, void* ctx);

  int64_t usedBytes();  // the pages in use (page_count - freelist_count) * page_size: what the records take, the WAL's included
  Err err() const { return err_; }
  const std::string& errmsg() const { return msg_; }

  enum Q { kGet, kHas, kPut, kDel, kCount, kScanKA, kScanKD, kScanVA, kScanVD, kIxPut, kIxDelPk, kIxClear, kIxOther, kIxCount,
           kIxScanKA, kIxScanKD, kIxScanVA, kIxScanVD, kBeginR, kBeginW, kCommit, kRollback, kPages, kNQ };

 private:
  sqlite3_stmt* q(Q id);
  bool fail(int rc);
  int64_t changes(sqlite3_stmt* s);
  sqlite3* db_ = nullptr;
  sqlite3_stmt* st_[kNQ] = {};
  sqlite3_stmt* held_ = nullptr;  // the get whose row is still being read
  bool txn_ = false;
  Err err_ = Err::None;
  std::string msg_;
};

}  // namespace host::storage
