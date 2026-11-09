#include "net/assets.h"
#include <algorithm>
#ifdef __ANDROID__
#include <android/asset_manager.h>
#else
#include <fstream>
#include "core/fs.h"
#endif
namespace host {
#ifdef __ANDROID__
bool Assets::read(const std::string& path, std::string& out) const {
  if (!am_) return false;
  AAsset* a = AAssetManager_open(am_, path.c_str(), AASSET_MODE_BUFFER);
  if (!a) return false;
  out.assign((const char*)AAsset_getBuffer(a), AAsset_getLength(a)); AAsset_close(a); return true;
}
bool Assets::exists(const std::string& path) const {
  if (!am_) return false; AAsset* a = AAssetManager_open(am_, path.c_str(), AASSET_MODE_UNKNOWN); if (!a) return false; AAsset_close(a); return true;
}
#else
bool Assets::read(const std::string& path, std::string& out) const {
  if (root_.empty() || path.find("..") != std::string::npos) return false;
  std::ifstream f(fsPath(root_ + "/" + path), std::ios::binary); if (!f) return false;
  f.seekg(0, std::ios::end); out.resize((size_t)f.tellg()); f.seekg(0); f.read(out.data(), (std::streamsize)out.size()); return (bool)f;
}
bool Assets::exists(const std::string& path) const {
  std::error_code ec; return !root_.empty() && path.find("..") == std::string::npos && std::filesystem::is_regular_file(fsPath(root_ + "/" + path), ec);
}
#endif
std::string Assets::mime(const std::string& p) {
  size_t d = p.rfind('.'); std::string e = d == std::string::npos ? "" : p.substr(d + 1); std::transform(e.begin(), e.end(), e.begin(), ::tolower);
  if (e == "js" || e == "mjs") return "text/javascript"; if (e == "wasm") return "application/wasm"; if (e == "json") return "application/json";
  if (e == "html") return "text/html"; if (e == "css") return "text/css"; if (e == "txt") return "text/plain"; if (e == "glb") return "model/gltf-binary";
  if (e == "gltf") return "model/gltf+json"; if (e == "ktx2") return "image/ktx2"; if (e == "png") return "image/png"; if (e == "jpg" || e == "jpeg") return "image/jpeg";
  if (e == "webp") return "image/webp"; if (e == "svg") return "image/svg+xml"; if (e == "ogg") return "audio/ogg"; if (e == "mp3") return "audio/mpeg"; if (e == "wav") return "audio/wav";
  if (e == "webm") return "video/webm"; if (e == "weba") return "audio/webm"; if (e == "opus") return "audio/ogg";
  if (e == "ttf") return "font/ttf"; if (e == "woff2") return "font/woff2"; if (e == "bin") return "application/octet-stream";
  return "application/octet-stream";
}
}
