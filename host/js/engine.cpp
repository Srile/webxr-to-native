#include "js/engine.h"
#include "core/log.h"
#include "js/gc.h"
#include "js/v8compat.h"
#include "js/code_cache.h"

namespace host {

std::unique_ptr<v8::Platform> Engine::platform_;
std::string Engine::snapshot_;
v8::StartupData Engine::startup_;

namespace {
// Rejections without a handler, held until the microtask checkpoint ends: a handler attached in a later microtask
// takes them back off (an async function returning a promise that rejected synchronously adopts it one microtask
// later). What is left is reported, as a browser reports an unhandled rejection after the checkpoint. The main
// isolate only (the one Engine::init sets the callbacks on), on its own thread.
struct PendingRejection { v8::Global<v8::Promise> promise; v8::Global<v8::Value> value; };
std::vector<PendingRejection> g_pendingRejections;

void reportRejections(v8::Isolate* iso, void* engine) {
  if (g_pendingRejections.empty()) return;
  std::vector<PendingRejection> list = std::move(g_pendingRejections);
  g_pendingRejections.clear();
  v8::HandleScope hs(iso);
  // A checkpoint the host runs between tasks (Engine::pump) has no context entered: the page's, or ToString of the
  // reason dereferences an empty one (V8 15.6 on the mac host crashed on hello-js's rejection on purpose).
  v8::Local<v8::Context> ctx = iso->InContext() ? iso->GetCurrentContext() : ((Engine*)engine)->context();
  v8::Context::Scope cs(ctx);
  for (auto& r : list) {
    v8::Local<v8::Value> v = r.value.Get(iso);
    std::string text = v.IsEmpty() ? "?" : Engine::toStdString(iso, v);
    if (!v.IsEmpty() && v->IsObject() && !ctx.IsEmpty()) {
      auto s = v.As<v8::Object>()->Get(ctx, v8::String::NewFromUtf8Literal(iso, "stack"));
      if (!s.IsEmpty() && s.ToLocalChecked()->IsString()) text = Engine::toStdString(iso, s.ToLocalChecked());
    }
    JS_LOG(ANDROID_LOG_ERROR, "Unhandled promise rejection: %s", text.c_str());
  }
}
}  // namespace

v8::Platform* Engine::platform() { return platform_.get(); }

bool Engine::initPlatform(std::string snapshot, const std::string& flags) {
  if (platform_) return true;
  snapshot_ = std::move(snapshot);
  if (!snapshot_.empty()) { startup_.data = snapshot_.data(); startup_.raw_size = (int)snapshot_.size(); v8::V8::SetSnapshotDataBlob(&startup_); }
  else HOST_LOGI("snapshot: the one built into V8");  // every V8 the hosts ship carries its startup snapshot
  // Pointer compression and 31-bit smis are build-time. Flags before Initialize:
  //  --turbo-fast-api-calls  (off by default in V8 10.0) lets TurboFan call the WebGL binding's
  //    v8::CFunction twins (host/gl/webgl_bind.gen.cpp) straight from optimized JS, skipping the
  //    FunctionCallbackInfo / HandleScope / exit-frame of a regular API call (apps/gl-bench measures
  //    it). Set first so host.json's gc.flags can turn it off again ("--no-turbo-fast-api-calls").
  v8::V8::SetFlagsFromString("--turbo-fast-api-calls");
  if (!flags.empty()) { v8::V8::SetFlagsFromString(flags.c_str(), flags.size()); HOST_LOGI("V8 flags: %s", flags.c_str()); }
  // Idle tasks on: the host hands V8 the slack after each frame submit (v8::platform::RunIdleTasks, js/gc.cpp).
  platform_ = v8::platform::NewDefaultPlatform(2, v8::platform::IdleTaskSupport::kEnabled);
  v8::V8::InitializePlatform(platform_.get());
  if (!v8::V8::Initialize()) { HOST_LOGE("V8::Initialize failed"); return false; }
  HOST_LOGI("V8 %s", v8::V8::GetVersion());
  return true;
}

// ONE allocator for the host isolate and every worker: an ArrayBuffer transferred between isolates
// carries its BackingStore across, and that store is freed through the allocator that made it —
// a per-worker allocator deleted with the worker crashed the host isolate's Dispose (double free
// in ~BackingStore at exit). Never deleted.
v8::ArrayBuffer::Allocator* Engine::sharedAllocator() { static v8::ArrayBuffer::Allocator* a = v8::ArrayBuffer::Allocator::NewDefaultAllocator(); return a; }

void Engine::shutdownPlatform() { if (!platform_) return; v8::V8::Dispose(); v8::V8::DisposePlatform(); platform_.reset(); }

bool Engine::create(const v8::ResourceConstraints* rc) {
  allocator_ = Engine::sharedAllocator();
  v8::Isolate::CreateParams params; params.array_buffer_allocator = allocator_;
  if (rc) params.constraints = *rc;
  isolate_ = v8::Isolate::New(params);
  if (!isolate_) { HOST_LOGE("Isolate::New failed"); return false; }
  // The JS thread stays entered for the isolate's whole life: timers, net replies and platform
  // callbacks run off the loop without a scope of their own, and V8 falls back to
  // Isolate::Current() on paths like BytecodeArrayIterator (SIGSEGV at 0xe8a8 on the first big compile).
  // Entered before anything is registered on it: V8 15 allocates the listener list in the current isolate.
  isolate_->Enter();
  isolate_->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  isolate_->SetCaptureStackTraceForUncaughtExceptions(true, 20);
  isolate_->AddMessageListenerWithErrorLevel([](v8::Local<v8::Message> msg, v8::Local<v8::Value> data) {
    v8::Isolate* iso = v8::Isolate::GetCurrent(); v8::HandleScope hs(iso);
    std::string text = Engine::toStdString(iso, msg->Get());
    std::string file = msg->GetScriptResourceName().IsEmpty() ? "?" : Engine::toStdString(iso, msg->GetScriptResourceName());
    int line = msg->GetLineNumber(iso->GetCurrentContext()).FromMaybe(0);
    std::string stack; v8::Local<v8::StackTrace> st = msg->GetStackTrace();
    if (!st.IsEmpty()) for (int i = 0; i < st->GetFrameCount(); ++i) { auto f = st->GetFrame(iso, i); char b[512]; snprintf(b, sizeof b, "\n    at %s (%s:%d:%d)", f->GetFunctionName().IsEmpty() ? "<anon>" : Engine::toStdString(iso, f->GetFunctionName()).c_str(), f->GetScriptName().IsEmpty() ? "?" : Engine::toStdString(iso, f->GetScriptName()).c_str(), f->GetLineNumber(), f->GetColumn()); stack += b; }
    JS_LOG(ANDROID_LOG_ERROR, "Uncaught %s (%s:%d)%s", text.c_str(), file.c_str(), line, stack.c_str());
  }, v8::Isolate::kMessageError | v8::Isolate::kMessageWarning);
  isolate_->SetPromiseRejectCallback([](v8::PromiseRejectMessage m) {
    v8::Isolate* iso = v8::Isolate::GetCurrent(); v8::HandleScope hs(iso);
    if (m.GetEvent() == v8::kPromiseRejectWithNoHandler) {
      v8::Local<v8::Value> v = m.GetValue();
      g_pendingRejections.push_back({v8::Global<v8::Promise>(iso, m.GetPromise()), v8::Global<v8::Value>(iso, v.IsEmpty() ? v8::Undefined(iso).As<v8::Value>() : v)});
    } else if (m.GetEvent() == v8::kPromiseHandlerAddedAfterReject) {
      v8::Local<v8::Promise> p = m.GetPromise();
      for (size_t i = 0; i < g_pendingRejections.size(); ++i)
        if (g_pendingRejections[i].promise == p) { g_pendingRejections.erase(g_pendingRejections.begin() + (long)i); break; }
    }
  });
  isolate_->AddMicrotasksCompletedCallback(reportRejections, this);
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  context_.Reset(isolate_, ctx);
  // --expose-gc-as (GcScheduler) installs the gc extension on every context; the host calls the C++ API, the page
  // must not see an extra global.
  { v8::Context::Scope cs(ctx); (void)ctx->Global()->Delete(ctx, v8::String::NewFromUtf8Literal(isolate_, GcScheduler::kGcGlobal)); }
  return true;
}

void Engine::destroy() {
  if (!isolate_) return;
  context_.Reset();
  isolate_->Exit();
  isolate_->Dispose(); isolate_ = nullptr;
  allocator_ = nullptr;
}

std::string Engine::toStdString(v8::Isolate* iso, v8::Local<v8::Value> v) {
  if (v.IsEmpty()) return {};
  v8::String::Utf8Value s(iso, v); return s.length() ? std::string(*s, s.length()) : std::string();
}

void Engine::reportException(v8::TryCatch& tc) {
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Message> msg = tc.Message();
  std::string text = toStdString(isolate_, tc.Exception());
  v8::Local<v8::Value> st; if (tc.StackTrace(context()).ToLocal(&st) && st->IsString()) text = toStdString(isolate_, st);
  if (!msg.IsEmpty()) { std::string file = toStdString(isolate_, msg->GetScriptResourceName()); int line = msg->GetLineNumber(context()).FromMaybe(0); JS_LOG(ANDROID_LOG_ERROR, "Exception at %s:%d: %s", file.c_str(), line, text.c_str()); }
  else JS_LOG(ANDROID_LOG_ERROR, "Exception: %s", text.c_str());
}

bool Engine::run(const std::function<void(v8::Isolate*, v8::Local<v8::Context>)>& f) {
  v8::Isolate::Scope is(isolate_); v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context(); v8::Context::Scope cs(ctx);
  v8::TryCatch tc(isolate_);
  f(isolate_, ctx);
  if (tc.HasCaught()) { reportException(tc); return false; }
  return true;
}

bool Engine::runScript(const std::string& source, const std::string& name, CodeCache* cache) {
  return run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
    v8::ScriptOrigin origin = HOST_SCRIPT_ORIGIN(iso, v8::String::NewFromUtf8(iso, name.c_str()).ToLocalChecked());
    v8::Local<v8::String> src = v8::String::NewFromUtf8(iso, source.data(), v8::NewStringType::kNormal, (int)source.size()).ToLocalChecked();
    v8::Local<v8::Script> script;
    if (cache && cache->enabled()) {
      v8::ScriptCompiler::CachedData* cached = cache->load(name, source);
      v8::ScriptCompiler::Source s(src, origin, cached);
      if (!v8::ScriptCompiler::Compile(ctx, &s, cached ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions).ToLocal(&script)) return;
      if (!cached || s.GetCachedData()->rejected) { cache_ = cache; uncached_.push_back({v8::Global<v8::UnboundScript>(iso, script->GetUnboundScript()), name, CodeCache::hash(source)}); }
    } else if (!v8::Script::Compile(ctx, src, &origin).ToLocal(&script)) return;
    (void)script->Run(ctx);
  });
}

void Engine::saveCodeCache() {
  if (!cache_) return;
  v8::Isolate::Scope is(isolate_); v8::HandleScope hs(isolate_);
  for (auto& u : uncached_) {
    std::unique_ptr<v8::ScriptCompiler::CachedData> data(v8::ScriptCompiler::CreateCodeCache(u.script.Get(isolate_)));
    if (data) { cache_->store(u.name, u.hash, *data); HOST_LOGI("code cache: %s, %d KB", u.name.c_str(), data->length / 1024); }
  }
  uncached_.clear();
}

void Engine::pump() {
  v8::Isolate::Scope is(isolate_); v8::HandleScope hs(isolate_);
  isolate_->PerformMicrotaskCheckpoint();
  while (v8::platform::PumpMessageLoop(platform_.get(), isolate_, v8::platform::MessageLoopBehavior::kDoNotWait)) {}
}

}  // namespace host
