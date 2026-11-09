// WP-13: the /host JSON-RPC handler: eval (awaits promises), stats, shot (readback of the last XR frame or the panel), tail.
#include "js/bridge.h"
#include "core/log.h"
#include "js/bind.h"
#include "js/engine.h"
#include "gl/egl.h"
#include <deque>
#include <mutex>
// stb_image_write's in-memory encoder lives in the implementation section; the implementation is compiled in img/decode.cpp (WP-05).
extern "C" unsigned char* stbi_write_png_to_mem(const unsigned char* pixels, int stride_bytes, int x, int y, int n, int* out_len);  // C linkage: stb_image_write.h declares it STBIWDEF = extern "C"

namespace host {
namespace {
std::mutex g_logMu; std::deque<std::string> g_log;
std::string b64(const unsigned char* d, size_t n) { static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string o; size_t i = 0;
  for (; i + 2 < n; i += 3) { uint32_t v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; o += T[v >> 18]; o += T[(v >> 12) & 63]; o += T[(v >> 6) & 63]; o += T[v & 63]; }
  if (i + 1 == n) { uint32_t v = d[i] << 16; o += T[v >> 18]; o += T[(v >> 12) & 63]; o += "=="; } else if (i + 2 == n) { uint32_t v = (d[i] << 16) | (d[i + 1] << 8); o += T[v >> 18]; o += T[(v >> 12) & 63]; o += T[(v >> 6) & 63]; o += '='; } return o; }
std::string jsonStr(const std::string& s) { Json j; j.type = Json::String; j.str = s; return j.dump(); }
}

std::string bridgeEncodeShot(int w, int h, const std::vector<unsigned char>& rgba) {
  std::vector<unsigned char> flipped(rgba.size()); for (int y = 0; y < h; ++y) memcpy(&flipped[(size_t)y * w * 4], &rgba[(size_t)(h - 1 - y) * w * 4], (size_t)w * 4);
  int len = 0; unsigned char* data = stbi_write_png_to_mem(flipped.data(), w * 4, w, h, 4, &len);
  if (!data) return "{\"error\":\"png encode failed\"}"; std::string png = b64(data, len); free(data);
  return "{\"width\":" + std::to_string(w) + ",\"height\":" + std::to_string(h) + ",\"png\":\"" + png + "\"}";
}
void bridgeLog(const std::string& line) { std::lock_guard<std::mutex> g(g_logMu); g_log.push_back(line); if (g_log.size() > 2000) g_log.pop_front(); }

void bridgeHandle(Bridge& b, const std::string& text, std::function<void(const std::string&)> reply) {
  std::string err; Json req = Json::parse(text, &err); if (!err.empty()) return reply("{\"error\":" + jsonStr("bad json: " + err) + "}");
  std::string method = req.s("method"); const Json& p = req.at("params");
  if (method == "eval") {
    std::string result, error; bool done = false;
    b.engine->run([&](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      v8::TryCatch tc(iso); v8::ScriptOrigin origin = HOST_SCRIPT_ORIGIN(iso, bind::str(iso, "bridge"));
      v8::Local<v8::Script> s; v8::Local<v8::Value> v;
      if (!v8::Script::Compile(ctx, bind::str(iso, p.s("expression")), &origin).ToLocal(&s) || !s->Run(ctx).ToLocal(&v)) { error = tc.HasCaught() ? Engine::toStdString(iso, tc.Exception()) : "compile failed"; done = true; return; }
      if (v->IsPromise()) { auto pr = v.As<v8::Promise>(); for (int spins = 0; pr->State() == v8::Promise::kPending && spins < 100000; ++spins) { iso->PerformMicrotaskCheckpoint(); b.pump(); } if (pr->State() == v8::Promise::kPending) { error = "promise still pending after pumping"; done = true; return; } if (pr->State() == v8::Promise::kRejected) { error = Engine::toStdString(iso, pr->Result()); done = true; return; } v = pr->Result(); }
      v8::Local<v8::String> js; if (v->IsUndefined()) result = "null"; else if (v8::JSON::Stringify(ctx, v).ToLocal(&js)) result = Engine::toStdString(iso, js); else result = jsonStr(Engine::toStdString(iso, v));
      if (result.empty()) result = jsonStr(Engine::toStdString(iso, v)); done = true;
    });
    if (!error.empty()) return reply("{\"error\":" + jsonStr(error) + "}");
    return reply("{\"result\":" + (result.empty() ? "null" : result) + "}");
  }
  if (method == "stats") return reply(b.stats ? b.stats() : "{}");
  if (method == "tail") { int n = (int)p.n("n", 100); std::lock_guard<std::mutex> g(g_logMu); Json arr; arr.type = Json::Array; int start = std::max(0, (int)g_log.size() - n); for (size_t i = start; i < g_log.size(); ++i) { Json s; s.type = Json::String; s.str = g_log[i]; arr.arr.push_back(s); } return reply("{\"result\":" + arr.dump() + "}"); }
  if (method == "shot") { int eye = p.s("eye", "left") == "right" ? 1 : 0; if (!b.shot) return reply("{\"error\":\"no frame source\"}"); b.shot(eye, reply); return; }
  reply("{\"error\":" + jsonStr("unknown method " + method) + "}");
}
}  // namespace host
