#pragma once
// V8 code caches for the page's scripts: the bytecode V8 compiled for them, stored after the page has warmed up
// and handed back to the compiler on the next launch. A jitless V8 (iOS) otherwise parses and compiles megabytes
// of JS again on every cold start, seconds of black screen. One file per script under <files>/code-cache, checked
// against a hash of the source; V8 checks its own version and flags and rejects a cache that does not fit.
#include <memory>
#include <string>
#include <v8.h>

namespace host {

class CodeCache {
 public:
  void init(const std::string& dir);  // empty: off (the Quest host does not use it)
  bool enabled() const { return !dir_.empty(); }
  // The cache for `name` if there is one for this source, for ScriptCompiler::Source (which then owns it).
  v8::ScriptCompiler::CachedData* load(const std::string& name, const std::string& source) const;
  void store(const std::string& name, uint64_t sourceHash, const v8::ScriptCompiler::CachedData& data) const;  // sourceHash: hash(source)
  static uint64_t hash(const std::string& s);

 private:
  std::string path(const std::string& name) const;
  std::string dir_;
};

}  // namespace host
