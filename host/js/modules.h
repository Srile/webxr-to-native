#pragma once
// ES module loading from assets: resolution against the origin, import.meta.url,
// dynamic import(), a module map keyed by absolute URL.
#include <string>
#include <v8.h>
#include <vector>
namespace host {
class Engine; struct HostServices;
class Modules {
 public:
  void init(Engine* e, HostServices* svc, const std::string& origin);
  // Load+evaluate the module at `url` (absolute https://origin/... or www-relative path). Returns the evaluation promise or empty on failure.
  v8::MaybeLocal<v8::Value> import(const std::string& url);
  static Modules* current();
  // Store a code cache for every asset module that had none (or a rejected one): after the page has warmed up,
  // so the functions it compiled while booting are in it (HostServices::codeCache).
  void saveCodeCache();
  void reset() { entries_.clear(); }  // releases the module handles: before the isolate goes
 private:
  friend struct ModuleHooks;
  v8::MaybeLocal<v8::Module> load(v8::Local<v8::Context> ctx, const std::string& absUrl);
  std::string resolve(const std::string& spec, const std::string& referrer) const;
  std::string toAssetPath(const std::string& absUrl) const;
  Engine* engine_ = nullptr; HostServices* svc_ = nullptr; std::string origin_;
  struct Entry { v8::Global<v8::Module> mod; std::string url; v8::Global<v8::UnboundModuleScript> uncached; uint64_t sourceHash = 0; };  // uncached: to store
  std::vector<Entry> entries_;  // small; linear scan by identity hash is fine
  int findByModule(v8::Local<v8::Module> m) const;
  int findByUrl(const std::string& url) const;
};
}
