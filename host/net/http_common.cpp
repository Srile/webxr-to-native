// The platform-neutral half of net/http.h: the network.allow check, the request queue and shutdown. Each host
// brings its own init/worker/perform (net/http.cpp: JNI HttpURLConnection; mac/http_curl.cpp: libcurl).
#include "net/http.h"
#include <algorithm>
#include <cctype>

namespace host {
namespace {
struct UrlParts { std::string scheme, host, port, path; bool ok = false; };

// scheme://[userinfo@]host[:port][/path][?query][#fragment] → lower-cased scheme and host, the port (scheme default
// when absent) and the path ("/" when absent). Anything else (no scheme, an empty host) is not ok.
UrlParts parseUrl(const std::string& url) {
  UrlParts u;
  size_t s = url.find("://"); if (s == std::string::npos || s == 0) return u;
  u.scheme = url.substr(0, s); std::transform(u.scheme.begin(), u.scheme.end(), u.scheme.begin(), ::tolower);
  size_t a = s + 3, e = url.find_first_of("/?#", a); if (e == std::string::npos) e = url.size();
  std::string auth = url.substr(a, e - a);
  if (size_t at = auth.rfind('@'); at != std::string::npos) auth = auth.substr(at + 1);
  if (size_t c = auth.rfind(':'); c != std::string::npos && auth.find(']', c) == std::string::npos) { u.port = auth.substr(c + 1); auth = auth.substr(0, c); }
  u.host = auth; std::transform(u.host.begin(), u.host.end(), u.host.begin(), ::tolower);
  if (u.port.empty()) u.port = u.scheme == "https" ? "443" : u.scheme == "http" ? "80" : "";
  size_t q = url.find_first_of("?#", e); u.path = e < url.size() && url[e] == '/' ? url.substr(e, (q == std::string::npos ? url.size() : q) - e) : "/";
  u.ok = !u.host.empty();
  return u;
}
}  // namespace

void Http::shutdown() {
  { std::lock_guard<std::mutex> g(mu_); stop_ = true; while (!q_.empty()) q_.pop(); }
  cv_.notify_all(); cancelInflight();
  for (auto& t : threads_) t.join(); threads_.clear();
}

// An entry allows a URL with the same scheme, host and port, and a path under the entry's (at a '/' boundary):
// "https://api.example.com" allows that origin, not https://api.example.com.evil.net; "*" allows everything.
bool Http::allowed(const std::string& url) const {
  UrlParts u = parseUrl(url); if (!u.ok) return false;
  for (auto& a : allow_) {
    if (a == "*") return true;
    UrlParts e = parseUrl(a);
    if (!e.ok || e.scheme != u.scheme || e.host != u.host || e.port != u.port) continue;
    std::string base = e.path.back() == '/' ? e.path : e.path + "/";
    if (e.path == "/" || u.path == e.path || u.path.rfind(base, 0) == 0) return true;
  }
  return false;
}

void Http::request(HttpRequest req, std::function<void(HttpResponse)> cb) {
  if (!allowed(req.url)) { HttpResponse r; r.error = "blocked by network.allow: " + req.url; loop_->post([cb, r] { cb(r); }); return; }
  { std::lock_guard<std::mutex> g(mu_); q_.push({std::move(req), std::move(cb)}); } cv_.notify_one();
}

}  // namespace host
