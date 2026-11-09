#include "store/local_storage.h"
#include "core/fs.h"
#include "core/json.h"
#include "core/log.h"
#include <fstream>
#include <sstream>
namespace host {
static const size_t CAP = 5 * 1024 * 1024;
void LocalStorage::init(const std::string& p) {
  path_ = p; std::ifstream f(fsPath(p), std::ios::binary); if (!f) return;
  std::stringstream ss; ss << f.rdbuf(); std::string err; Json j = Json::parse(ss.str(), &err);
  if (!err.empty()) { HOST_LOGW("localStorage file unreadable: %s", err.c_str()); return; }
  for (auto& kv : j.obj) if (kv.second.type == Json::String) { map_[kv.first] = kv.second.str; bytes_ += kv.first.size() + kv.second.str.size(); }
  HOST_LOGI("localStorage: %zu keys, %zu bytes", map_.size(), bytes_);
}
bool LocalStorage::get(const std::string& k, std::string& v) const { auto it = map_.find(k); if (it == map_.end()) return false; v = it->second; return true; }
bool LocalStorage::set(const std::string& k, const std::string& v) {
  size_t old = 0; auto it = map_.find(k); if (it != map_.end()) old = k.size() + it->second.size();
  if (bytes_ - old + k.size() + v.size() > CAP) return false;
  bytes_ = bytes_ - old + k.size() + v.size(); map_[k] = v; if (!dirty_) dirtyAt_ = 0; dirty_ = true; return true;
}
void LocalStorage::remove(const std::string& k) { auto it = map_.find(k); if (it == map_.end()) return; bytes_ -= k.size() + it->second.size(); map_.erase(it); dirty_ = true; }
void LocalStorage::clear() { map_.clear(); bytes_ = 0; dirty_ = true; }
std::string LocalStorage::key(size_t i) const { size_t n = 0; for (auto& kv : map_) if (n++ == i) return kv.first; return {}; }
void LocalStorage::flush() {
  if (!dirty_ || path_.empty()) return;
  Json j; j.type = Json::Object; for (auto& kv : map_) { Json s; s.type = Json::String; s.str = kv.second; j.obj[kv.first] = s; }
  std::string tmp = path_ + ".tmp"; { std::ofstream f(fsPath(tmp), std::ios::binary | std::ios::trunc); f << j.dump(); }
  std::error_code ec; std::filesystem::rename(fsPath(tmp), fsPath(path_), ec);  // replaces the old file (Windows too, unlike std::rename)
  if (ec) { HOST_LOGW("localStorage: save failed: %s (kept dirty: the next tick, and the shutdown flush, try again)", ec.message().c_str()); dirtyAt_ = 0; return; }
  dirty_ = false;
}
void LocalStorage::tick(double now) { if (!dirty_) return; if (dirtyAt_ == 0) dirtyAt_ = now; if (now - dirtyAt_ > 200) { flush(); dirtyAt_ = 0; } }
}
