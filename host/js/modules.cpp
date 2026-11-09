#include "js/modules.h"
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/natives.h"
#include "js/code_cache.h"

namespace host {
namespace { Modules* g_mod = nullptr; }
Modules* Modules::current() { return g_mod; }

void Modules::init(Engine* e, HostServices* svc, const std::string& origin) {
  engine_ = e; svc_ = svc; origin_ = origin; while (!origin_.empty() && origin_.back() == '/') origin_.pop_back(); g_mod = this;
  e->isolate()->SetHostImportModuleDynamicallyCallback([](v8::Local<v8::Context> ctx, v8::Local<v8::Data> host_defined, v8::Local<v8::Value> resource_name, v8::Local<v8::String> specifier, v8::Local<v8::FixedArray>) -> v8::MaybeLocal<v8::Promise> {
    v8::Isolate* iso = isolateOf(ctx); auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    std::string ref = Engine::toStdString(iso, resource_name); std::string spec = Engine::toStdString(iso, specifier);
    std::string url = g_mod->resolve(spec, ref);
    v8::TryCatch tc(iso); v8::Local<v8::Module> m;
    if (!g_mod->load(ctx, url).ToLocal(&m)) { resolver->Reject(ctx, tc.HasCaught() ? tc.Exception() : v8::Exception::Error(bind::str(iso, "module load failed: " + url)).As<v8::Value>()).Check(); return resolver->GetPromise(); }
    if (m->GetStatus() == v8::Module::kUninstantiated && !m->InstantiateModule(ctx, [](v8::Local<v8::Context> c, v8::Local<v8::String> s, v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) -> v8::MaybeLocal<v8::Module> {
          int i = g_mod->findByModule(referrer); std::string ref = i >= 0 ? g_mod->entries_[i].url : g_mod->origin_ + "/"; return g_mod->load(c, g_mod->resolve(Engine::toStdString(isolateOf(c), s), ref)); }).FromMaybe(false)) {
      resolver->Reject(ctx, tc.HasCaught() ? tc.Exception() : v8::Exception::Error(bind::str(iso, "instantiate failed: " + url)).As<v8::Value>()).Check(); return resolver->GetPromise(); }
    v8::Local<v8::Value> result;
    if (m->GetStatus() == v8::Module::kEvaluated || m->GetStatus() == v8::Module::kEvaluating) { resolver->Resolve(ctx, m->GetModuleNamespace()).Check(); return resolver->GetPromise(); }
    if (!m->Evaluate(ctx).ToLocal(&result)) { resolver->Reject(ctx, tc.HasCaught() ? tc.Exception() : v8::Exception::Error(bind::str(iso, "evaluate failed: " + url)).As<v8::Value>()).Check(); return resolver->GetPromise(); }
    // Evaluate returns a promise for TLA modules; resolve with the namespace when it settles.
    v8::Local<v8::Module> mod = m;
    if (result->IsPromise()) {
      v8::Local<v8::Promise> p = result.As<v8::Promise>();
      v8::Local<v8::Object> data = v8::Object::New(iso); data->Set(ctx, bind::str(iso, "ns"), mod->GetModuleNamespace()).Check(); data->Set(ctx, bind::str(iso, "r"), resolver).Check();
      auto onOk = v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& a) { auto c = a.GetIsolate()->GetCurrentContext(); auto d = a.Data().As<v8::Object>(); d->Get(c, bind::str(a.GetIsolate(), "r")).ToLocalChecked().As<v8::Promise::Resolver>()->Resolve(c, d->Get(c, bind::str(a.GetIsolate(), "ns")).ToLocalChecked()).Check(); }, data).ToLocalChecked();
      auto onErr = v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& a) { auto c = a.GetIsolate()->GetCurrentContext(); auto d = a.Data().As<v8::Object>(); d->Get(c, bind::str(a.GetIsolate(), "r")).ToLocalChecked().As<v8::Promise::Resolver>()->Reject(c, a[0]).Check(); }, data).ToLocalChecked();
      (void)p->Then(ctx, onOk, onErr);
    } else resolver->Resolve(ctx, mod->GetModuleNamespace()).Check();
    return resolver->GetPromise();
  });
  e->isolate()->SetHostInitializeImportMetaObjectCallback([](v8::Local<v8::Context> ctx, v8::Local<v8::Module> m, v8::Local<v8::Object> meta) {
    int i = g_mod->findByModule(m); v8::Isolate* iso = isolateOf(ctx);
    bind::setStr(ctx, meta, "url", i >= 0 ? g_mod->entries_[i].url : g_mod->origin_ + "/");
    bind::set(ctx, meta, "env", v8::Object::New(iso));
  });
}

int Modules::findByModule(v8::Local<v8::Module> m) const { int h = m->GetIdentityHash(); for (size_t i = 0; i < entries_.size(); ++i) if (entries_[i].mod.Get(engine_->isolate())->GetIdentityHash() == h && entries_[i].mod.Get(engine_->isolate()) == m) return (int)i; return -1; }
int Modules::findByUrl(const std::string& url) const { for (size_t i = 0; i < entries_.size(); ++i) if (entries_[i].url == url) return (int)i; return -1; }

std::string Modules::resolve(const std::string& spec, const std::string& referrer) const {
  if (spec.rfind("http://", 0) == 0 || spec.rfind("https://", 0) == 0 || spec.rfind("blob:", 0) == 0 || spec.rfind("data:", 0) == 0) return spec;
  std::string base = referrer.empty() ? origin_ + "/" : referrer;
  size_t q = base.find_first_of("?#"); if (q != std::string::npos) base = base.substr(0, q);
  std::string result;
  if (spec[0] == '/') { size_t schemeEnd = base.find("://"); size_t hostEnd = base.find('/', schemeEnd == std::string::npos ? 0 : schemeEnd + 3); result = (hostEnd == std::string::npos ? base : base.substr(0, hostEnd)) + spec; }
  else { size_t slash = base.rfind('/'); result = base.substr(0, slash + 1) + spec; }
  // normalise ./ and ../ after the authority
  size_t schemeEnd = result.find("://"); size_t pathStart = result.find('/', schemeEnd == std::string::npos ? 0 : schemeEnd + 3); if (pathStart == std::string::npos) return result;
  std::string auth = result.substr(0, pathStart), path = result.substr(pathStart); std::vector<std::string> segs; size_t i = 1;
  while (i <= path.size()) { size_t j = path.find('/', i); std::string s = path.substr(i, (j == std::string::npos ? path.size() : j) - i); if (s == "..") { if (!segs.empty()) segs.pop_back(); } else if (s != "." && !(s.empty() && j != std::string::npos)) segs.push_back(s); if (j == std::string::npos) break; i = j + 1; }
  std::string out = auth; for (auto& s : segs) out += "/" + s; if (segs.empty()) out += "/"; return out;
}

std::string Modules::toAssetPath(const std::string& absUrl) const {
  std::string p = absUrl; if (p.rfind(origin_, 0) == 0) p = p.substr(origin_.size());
  size_t q = p.find_first_of("?#"); if (q != std::string::npos) p = p.substr(0, q);
  while (!p.empty() && p[0] == '/') p.erase(0, 1); return "www/" + p;
}

v8::MaybeLocal<v8::Module> Modules::load(v8::Local<v8::Context> ctx, const std::string& url) {
  v8::Isolate* iso = isolateOf(ctx);
  int i = findByUrl(url); if (i >= 0) return entries_[i].mod.Get(iso);
  std::string source;
  if (url.rfind("blob:", 0) == 0 || url.rfind("data:", 0) == 0) {
    // The prelude keeps blob/data module sources in __hostModuleSources[url].
    v8::Local<v8::Value> table; if (ctx->Global()->Get(ctx, bind::str(iso, "__hostModuleSources")).ToLocal(&table) && table->IsObject()) { v8::Local<v8::Value> src; if (table.As<v8::Object>()->Get(ctx, bind::str(iso, url)).ToLocal(&src) && src->IsString()) source = Engine::toStdString(iso, src); }
    if (source.empty()) { bind::throwError(iso, "module source not found for " + url); return {}; }
  } else if (!svc_->assets->read(toAssetPath(url), source)) { bind::throwError(iso, "Failed to fetch dynamically imported module: " + url); return {}; }
  v8::ScriptOrigin origin = HOST_SCRIPT_ORIGIN(iso, bind::str(iso, url), 0, 0, false, -1, v8::Local<v8::Value>(), false, false, true);
  // A code cache from an earlier launch for the page's own modules (not blob:/data:, which are minted per run).
  CodeCache* cache = svc_->codeCache && svc_->codeCache->enabled() && url.rfind(origin_, 0) == 0 ? svc_->codeCache : nullptr;
  v8::ScriptCompiler::CachedData* cached = cache ? cache->load(url, source) : nullptr;
  v8::ScriptCompiler::Source src(bind::str(iso, source), origin, cached);
  v8::Local<v8::Module> m;
  if (!v8::ScriptCompiler::CompileModule(iso, &src, cached ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions).ToLocal(&m)) return {};
  const bool hit = cached && !src.GetCachedData()->rejected;
  if (hit) HOST_LOGI("code cache: %s", url.c_str());
  else if (cached) HOST_LOGI("code cache: rejected for %s, compiling afresh", url.c_str());
  entries_.push_back({}); entries_.back().mod.Reset(iso, m); entries_.back().url = url;
  // Kept from before evaluation (V8 hands out a module's unbound script only then); serialized after warm-up.
  if (cache && !hit) { entries_.back().uncached.Reset(iso, m->GetUnboundModuleScript()); entries_.back().sourceHash = CodeCache::hash(source); }
  return m;
}

void Modules::saveCodeCache() {
  if (!svc_->codeCache || !svc_->codeCache->enabled()) return;
  v8::Isolate* iso = engine_->isolate(); v8::HandleScope hs(iso);
  for (auto& e : entries_) {
    if (e.uncached.IsEmpty()) continue;
    std::unique_ptr<v8::ScriptCompiler::CachedData> data(v8::ScriptCompiler::CreateCodeCache(e.uncached.Get(iso)));
    if (data) { svc_->codeCache->store(e.url, e.sourceHash, *data); HOST_LOGI("code cache: %s, %d KB", e.url.c_str(), data->length / 1024); }
    e.uncached.Reset();
  }
}

v8::MaybeLocal<v8::Value> Modules::import(const std::string& urlOrPath) {
  v8::Isolate* iso = engine_->isolate(); v8::Local<v8::Context> ctx = engine_->context();
  std::string url = resolve(urlOrPath, origin_ + "/");
  v8::Local<v8::Module> m; if (!load(ctx, url).ToLocal(&m)) return {};
  if (!m->InstantiateModule(ctx, [](v8::Local<v8::Context> c, v8::Local<v8::String> s, v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) -> v8::MaybeLocal<v8::Module> {
        int i = g_mod->findByModule(referrer); std::string ref = i >= 0 ? g_mod->entries_[i].url : g_mod->origin_ + "/"; return g_mod->load(c, g_mod->resolve(Engine::toStdString(isolateOf(c), s), ref)); }).FromMaybe(false)) return {};
  return m->Evaluate(ctx);
}

}  // namespace host
