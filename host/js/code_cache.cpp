#include "js/code_cache.h"
#include "core/fs.h"
#include "core/log.h"
#include <cstring>
#include <fstream>
#include <sstream>

namespace host {
namespace {
constexpr char kMagic[8] = {'w', 'x', 'h', 'c', 'c', '0', '0', '1'};
}

uint64_t CodeCache::hash(const std::string& s) { uint64_t h = 1469598103934665603ull; for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; } return h; }

void CodeCache::init(const std::string& dir) {
  dir_ = dir; if (dir_.empty()) return;
  std::error_code ec; std::filesystem::create_directories(fsPath(dir_), ec);
  if (ec) { HOST_LOGW("code cache: %s: %s (off)", dir_.c_str(), ec.message().c_str()); dir_.clear(); }
}

std::string CodeCache::path(const std::string& name) const { char b[32]; snprintf(b, sizeof b, "/%016llx.bin", (unsigned long long)hash(name)); return dir_ + b; }

v8::ScriptCompiler::CachedData* CodeCache::load(const std::string& name, const std::string& source) const {
  if (dir_.empty()) return nullptr;
  std::ifstream f(fsPath(path(name)), std::ios::binary); if (!f) return nullptr;
  std::stringstream ss; ss << f.rdbuf(); const std::string b = ss.str();
  uint64_t h = 0;
  if (b.size() <= sizeof kMagic + 8 || memcmp(b.data(), kMagic, sizeof kMagic) != 0) return nullptr;
  memcpy(&h, b.data() + sizeof kMagic, 8); if (h != hash(source)) return nullptr;  // the script changed: compile it afresh
  const size_t n = b.size() - sizeof kMagic - 8; auto* bytes = new uint8_t[n]; memcpy(bytes, b.data() + sizeof kMagic + 8, n);
  return new v8::ScriptCompiler::CachedData(bytes, (int)n, v8::ScriptCompiler::CachedData::BufferOwned);
}

void CodeCache::store(const std::string& name, uint64_t sourceHash, const v8::ScriptCompiler::CachedData& data) const {
  if (dir_.empty()) return;
  const std::string p = path(name), tmp = p + ".tmp";
  { std::ofstream f(fsPath(tmp), std::ios::binary | std::ios::trunc); const uint64_t h = sourceHash;
    f.write(kMagic, sizeof kMagic); f.write((const char*)&h, 8); f.write((const char*)data.data, data.length); }
  std::error_code ec; std::filesystem::rename(fsPath(tmp), fsPath(p), ec);
  if (ec) HOST_LOGW("code cache: %s not saved: %s", name.c_str(), ec.message().c_str());
}

}  // namespace host
