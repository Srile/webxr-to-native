#pragma once
// V8 embedding: platform, isolate, the main context, error reporting, the
// microtask checkpoint and the platform message pump. One Engine per process
// (workers create their own isolates through the same helpers, WP-06).
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <v8.h>
#include <libplatform/libplatform.h>

namespace host {

class CodeCache;

class Engine {
 public:
  // snapshot: contents of snapshot_blob.bin (kept alive by the engine). flags: V8 flags, set before
  // V8::Initialize (GcScheduler::v8Flags). The platform runs with idle-task support (GcScheduler::idleUntil).
  static bool initPlatform(std::string snapshot, const std::string& flags = std::string());
  static void shutdownPlatform();
  static v8::ArrayBuffer::Allocator* sharedAllocator();
  static v8::Platform* platform();

  bool create(const v8::ResourceConstraints* rc = nullptr);  // isolate + context; rc: heap sizing (main isolate)
  void destroy();
  v8::Isolate* isolate() const { return isolate_; }
  v8::Local<v8::Context> context() const { return context_.Get(isolate_); }

  // Compile+run a classic script. Returns false and logs on exception.
  bool runScript(const std::string& source, const std::string& name, CodeCache* cache = nullptr);
  void saveCodeCache();  // the scripts runScript compiled without a usable cache (call after warm-up)
  // Run f inside isolate/handle/context scopes with a TryCatch; reports exceptions.
  bool run(const std::function<void(v8::Isolate*, v8::Local<v8::Context>)>& f);
  void pump();                   // microtask checkpoint + platform message loop
  void reportException(v8::TryCatch& tc);
  static std::string toStdString(v8::Isolate* iso, v8::Local<v8::Value> v);

 private:
  v8::Isolate* isolate_ = nullptr;
  CodeCache* cache_ = nullptr; struct Uncached { v8::Global<v8::UnboundScript> script; std::string name; uint64_t hash; }; std::vector<Uncached> uncached_;
  v8::Global<v8::Context> context_;
  v8::ArrayBuffer::Allocator* allocator_ = nullptr;
  static std::unique_ptr<v8::Platform> platform_;
  static std::string snapshot_;
  static v8::StartupData startup_;
};

}  // namespace host
