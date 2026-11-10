// WP-26: the SQLite store under IndexedDB and the Cache API (storage/kv.h), without V8: ranges, BLOB order, index
// entries with compound positions, transactions (rollback undoes data), the size cap (SQLITE_FULL), two connections on
// one file (WAL readers beside a writer; a second writer waits, then fails busy), and the time of a put + commit.
#include "storage/kv.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

using host::storage::Bytes;
using host::storage::Db;
static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

static Bytes B(const std::string& s) { return Bytes{s.data(), s.size()}; }
static const std::string kMax("\xFF", 1);
struct Rows { std::vector<std::string> k, p, v; };
static bool collect(void* c, Bytes k, Bytes p, Bytes v) {
  auto* r = (Rows*)c; r->k.emplace_back((const char*)k.p, k.n); r->p.emplace_back((const char*)p.p, p.n); r->v.emplace_back((const char*)v.p, v.n);
  return true;
}
static std::string join(const std::vector<std::string>& v) { std::string s; for (auto& x : v) { if (!s.empty()) s += ","; s += x; } return s; }

int main() {
  namespace fs = std::filesystem;
  const fs::path dir = fs::temp_directory_path() / ("storage_test_" + std::to_string((long)std::chrono::steady_clock::now().time_since_epoch().count()));
  fs::create_directories(dir);
  const std::string path = (dir / "t.sqlite").string();

  Db db;
  CHECK(!db.open((dir / "missing.sqlite").string(), false, 0), "open without create must fail on a missing file");
  CHECK(db.open(path, true, 0), "open: %s", db.errmsg().c_str());

  // kv: order is memcmp then length ("a" < "a\0" < "ab" < "b"), ranges are [lo, hi)
  CHECK(db.begin(true), "begin");
  for (const std::string& k : std::vector<std::string>{"b", "a", std::string("a\0", 2), "ab", "c"}) CHECK(db.put(1, B(k), B("v" + k)), "put");
  CHECK(db.put(2, B("a"), B("other ns")), "put ns 2");
  CHECK(db.commit(), "commit");
  { Rows r; db.scan(1, Bytes{}, B(kMax), false, -1, false, collect, &r);
    CHECK(r.k.size() == 5 && r.k[0] == "a" && r.k[1] == std::string("a\0", 2) && r.k[2] == "ab" && r.k[3] == "b" && r.k[4] == "c", "order: %s", join(r.k).c_str()); }
  { Rows r; db.scan(1, B("ab"), B("c"), true, -1, true, collect, &r);
    CHECK(r.k.size() == 2 && r.k[0] == "b" && r.k[1] == "ab" && r.v[0] == "vb", "reverse range: %s", join(r.k).c_str()); }
  { Rows r; db.scan(1, Bytes{}, B(kMax), false, 2, false, collect, &r); CHECK(r.k.size() == 2, "limit"); }
  { Bytes v; CHECK(db.get(1, B("ab"), v) == 1 && std::string((const char*)v.p, v.n) == "vab", "get"); db.release(); }
  { Bytes v; CHECK(db.get(1, B("zz"), v) == 0, "get missing"); }
  CHECK(db.has(2, B("a")) == 1 && db.has(2, B("b")) == 0, "has");
  CHECK(db.count(1, B("a"), B("b")) == 3, "count [a, b)");
  CHECK(db.put(1, B("b"), B("vb2")), "overwrite");
  { Bytes v; db.get(1, B("b"), v); CHECK(std::string((const char*)v.p, v.n) == "vb2", "overwritten"); db.release(); }
  CHECK(db.count(1, Bytes{}, B(kMax)) == 5, "overwrite keeps one row");

  // rollback undoes every write of the transaction
  CHECK(db.begin(true), "begin 2");
  CHECK(db.del(1, Bytes{}, B(kMax)) == 5, "delete all");
  CHECK(db.put(1, B("x"), B("vx")), "put x");
  CHECK(db.rollback(), "rollback");
  CHECK(db.count(1, Bytes{}, B(kMax)) == 5 && db.has(1, B("x")) == 0, "rollback restored");

  // ix: (key, pk) order, compound positions, the primary-key range delete, the unique probe, values joined from kv
  CHECK(db.begin(true), "begin ix");
  for (auto [k, p] : std::vector<std::pair<std::string, std::string>>{{"red", "b"}, {"blue", "c"}, {"red", "a"}, {"green", "ab"}, {"red", "c"}})
    CHECK(db.ixPut(7, B(k), B(p)), "ixPut");
  CHECK(db.ixPut(7, B("red"), B("a")), "duplicate entry ignored");
  CHECK(db.commit(), "commit ix");
  { Rows r; db.ixScan(7, Bytes{}, B(kMax), Bytes{}, Bytes{}, false, -1, -1, collect, &r);
    CHECK(join(r.k) == "blue,green,red,red,red" && join(r.p) == "c,ab,a,b,c", "ix order: %s / %s", join(r.k).c_str(), join(r.p).c_str()); }
  { Rows r; db.ixScan(7, Bytes{}, B(kMax), B("red"), B(std::string("a\0", 2)), false, -1, -1, collect, &r);  // (key,pk) > (red,a)
    CHECK(join(r.p) == "b,c", "after (red,a): %s", join(r.p).c_str()); }
  { Rows r; db.ixScan(7, Bytes{}, B(kMax), B("red"), B("b"), true, -1, -1, collect, &r);  // (key,pk) < (red,b), descending
    CHECK(join(r.k) == "red,green,blue" && r.p[0] == "a", "before (red,b): %s / %s", join(r.k).c_str(), join(r.p).c_str()); }
  { Rows r; db.ixScan(7, B("red"), B(std::string("red\0", 4)), B("red"), Bytes{}, false, -1, 1, collect, &r);  // values from kv ns 1
    CHECK(r.k.size() == 3 && r.v[0] == "va" && r.v[1] == "vb2" && r.v[2] == "vc", "joined values: %s", join(r.v).c_str()); }
  CHECK(db.ixCount(7, B("green"), B(kMax)) == 4, "ixCount");
  CHECK(db.ixOther(7, B("red"), B("a")) == 1 && db.ixOther(7, B("green"), B("ab")) == 0, "ixOther");
  CHECK(db.ixDelPk(7, B("a"), B("b")) == 2, "ixDelPk [a, b) removes (red,a) and (green,ab)");
  CHECK(db.ixCount(7, Bytes{}, B(kMax)) == 3, "after ixDelPk");
  CHECK(db.ixClear(7) == 3 && db.ixCount(7, Bytes{}, B(kMax)) == 0, "ixClear");

  // two connections on one file: a reader sees the last commit while a write transaction is open; a second writer
  // waits (busy_timeout) and fails busy while the first holds the lock
  {
    Db other; CHECK(other.open(path, false, 0), "second connection");
    CHECK(db.begin(true) && db.put(1, B("w"), B("pending")), "writer");
    CHECK(other.begin(false) && other.has(1, B("w")) == 0 && other.commit(), "reader does not see an open transaction");
    const auto t0 = std::chrono::steady_clock::now();
    CHECK(!other.begin(true), "second writer must not get the lock");
    const double waited = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    CHECK(other.err() == host::storage::Err::Busy && waited > 4.0, "busy after the timeout (%.1f s, err %d)", waited, (int)other.err());
    CHECK(db.commit(), "writer commit");
    CHECK(other.has(1, B("w")) == 1, "reader sees the commit");
  }

  // the size cap: SQLITE_FULL, reported as Full (QuotaExceededError in JS); the transaction rolls back cleanly
  {
    Db small; CHECK(small.open((dir / "small.sqlite").string(), true, 256 * 1024), "small");
    std::string big(400 * 1024, 'x');
    CHECK(small.begin(true), "begin small");
    CHECK(!small.put(1, B("big"), B(big)) && small.err() == host::storage::Err::Full, "cap: err %d %s", (int)small.err(), small.errmsg().c_str());
    CHECK(small.rollback(), "rollback after full");
    CHECK(small.put(1, B("ok"), B("small")), "a small put still works");
  }

  // a put + commit, as one IndexedDB readwrite transaction does it (WAL, synchronous=NORMAL: no fsync per commit)
  {
    std::string val(1024, 'v'); const int n = 1000;
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < n; ++i) { std::string k = "k" + std::to_string(i); db.begin(true); db.put(3, B(k), B(val)); db.commit(); }
    const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / n;
    printf("put (1 KB) + commit: %.1f us\n", us);
    CHECK(db.count(3, Bytes{}, B(kMax)) == n, "all committed");
  }
  CHECK(db.usedBytes() > 1000 * 1024, "usedBytes: %lld", (long long)db.usedBytes());
  db.close();
  std::error_code ec; fs::remove_all(dir, ec);
  if (failures) { fprintf(stderr, "storage_test: %d failures\n", failures); return 1; }
  puts("storage_test ok"); return 0;
}
