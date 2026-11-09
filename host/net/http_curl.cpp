// Desktop hosts (mac/, linux/): net/http.h's transport over libcurl (the system's, with the system trust store), on the same
// small worker pool as Android's JNI HttpURLConnection; results are posted back to the host loop. The allow-list
// and the queue are shared (net/http_common.cpp).
#include "net/http.h"
#include "core/log.h"
#include <curl/curl.h>
#include <cctype>

namespace host {

void Http::init(JavaVM*, Loop* loop, std::vector<std::string> allow) {
  loop_ = loop; allow_ = std::move(allow);
  curl_global_init(CURL_GLOBAL_DEFAULT);
  for (int i = 0; i < 4; ++i) threads_.emplace_back([this] { worker(); });
}

void Http::cancelInflight() {}  // the progress callback (perform) sees stop_

void Http::worker() {
  for (;;) {
    std::pair<HttpRequest, std::function<void(HttpResponse)>> job;
    { std::unique_lock<std::mutex> lk(mu_); cv_.wait(lk, [&] { return stop_ || !q_.empty(); }); if (stop_ && q_.empty()) break; job = std::move(q_.front()); q_.pop(); }
    HttpResponse r = perform(nullptr, job.first);
    auto cb = job.second; loop_->post([cb, r] { cb(r); });
  }
}

namespace {
size_t onBody(char* p, size_t sz, size_t n, void* ud) { ((std::string*)ud)->append(p, sz * n); return sz * n; }
size_t onHeader(char* p, size_t sz, size_t n, void* ud) {
  auto* out = (HttpResponse*)ud; std::string line(p, sz * n);
  while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
  if (line.rfind("HTTP/", 0) == 0) {  // a status line: a redirect starts the header list over
    out->headers.clear(); size_t s = line.find(' '); size_t t = s == std::string::npos ? s : line.find(' ', s + 1);
    out->statusText = t == std::string::npos ? "" : line.substr(t + 1);
  } else if (size_t c = line.find(':'); c != std::string::npos) {
    size_t v = c + 1; while (v < line.size() && isspace((unsigned char)line[v])) v++;
    out->headers.push_back({line.substr(0, c), line.substr(v)});
  }
  return sz * n;
}
}  // namespace

// Redirects are followed here, one hop at a time, rather than by curl: every hop must pass network.allow (and
// stay on http/https), as the first one did in Http::request. A 303, or a 301/302 answering a POST, goes on as a
// GET without the body (what HttpURLConnection and browsers do); 307/308 keep the method and body.
HttpResponse Http::perform(JNIEnv*, const HttpRequest& r) {
  HttpResponse out;
  std::string url = r.url, method = r.method; bool sendBody = !r.body.empty();
  for (int hop = 0; ; ++hop) {
    out = HttpResponse{};
    CURL* c = curl_easy_init(); if (!c) { out.error = "curl_easy_init failed"; return out; }
    curl_slist* hdrs = nullptr;
    for (auto& h : r.headers) hdrs = curl_slist_append(hdrs, (h.first + ": " + h.second).c_str());
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
    if (method == "GET") curl_easy_setopt(c, CURLOPT_HTTPGET, 1L);
    else if (method == "HEAD") curl_easy_setopt(c, CURLOPT_NOBODY, 1L);
    else if (method == "POST") curl_easy_setopt(c, CURLOPT_POST, 1L);
    else curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method.c_str());
    if (sendBody) { curl_easy_setopt(c, CURLOPT_POSTFIELDS, r.body.data()); curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)r.body.size()); }
    else if (method == "POST") curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)0);
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdrs);
    // Android's timeouts: 15 s to connect, then 30 s without a byte; a slow but moving download has no total cap.
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
    curl_easy_setopt(c, CURLOPT_LOW_SPEED_LIMIT, 1L); curl_easy_setopt(c, CURLOPT_LOW_SPEED_TIME, 30L);
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
    // shutdown() aborts the transfer from the progress callback (curl has no cross-thread cancel).
    curl_easy_setopt(c, CURLOPT_NOPROGRESS, 0L); curl_easy_setopt(c, CURLOPT_XFERINFODATA, this);
    curl_easy_setopt(c, CURLOPT_XFERINFOFUNCTION, +[](void* ud, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int { return static_cast<Http*>(ud)->stop_.load() ? 1 : 0; });
    curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");  // whatever curl can decode; the body arrives decoded, like the JNI path
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, onBody); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out.body);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, onHeader); curl_easy_setopt(c, CURLOPT_HEADERDATA, &out);
    CURLcode rc = curl_easy_perform(c);
    std::string next;
    if (rc != CURLE_OK) out.error = curl_easy_strerror(rc);
    else {
      long status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status); out.status = (int)status;
      char* loc = nullptr; if (status >= 300 && status < 400 && curl_easy_getinfo(c, CURLINFO_REDIRECT_URL, &loc) == CURLE_OK && loc) next = loc;
    }
    curl_slist_free_all(hdrs); curl_easy_cleanup(c);
    if (next.empty()) return out;
    if (hop >= 10) { out.error = "too many redirects"; return out; }
    if (!allowed(next)) { out = HttpResponse{}; out.error = "redirect blocked by network.allow: " + next; return out; }
    if (out.status == 303 || ((out.status == 301 || out.status == 302) && method == "POST")) { method = "GET"; sendBody = false; }
    url = next;
  }
}

}  // namespace host
