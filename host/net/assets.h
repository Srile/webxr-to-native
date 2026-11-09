#pragma once
// APK asset reads (mmap'd where possible) + MIME by extension. Thread-safe.
#include <string>
#include <vector>
#include <cstdint>
struct AAssetManager;
namespace host {
class Assets {
 public:
#ifdef __ANDROID__
  void init(AAssetManager* am) { am_ = am; }
#else
  void init(std::string root) { root_ = std::move(root); }  // desktop host: the staged assets/ directory
#endif
  // path relative to assets/ (e.g. "www/assets/index.js"); false if missing.
  bool read(const std::string& path, std::string& out) const;
  bool exists(const std::string& path) const;
  static std::string mime(const std::string& path);
 private:
  AAssetManager* am_ = nullptr;
  std::string root_;
};
}
