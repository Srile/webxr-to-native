// Windows host: net/http.h's transport over WinHTTP (the system's TLS, trust store and proxy settings), on the same
// small worker pool as the other hosts; results are posted back to the host loop. The allow-list and the queue
// are shared (net/http_common.cpp).
#include "net/http.h"
#include "core/log.h"
#include <windows.h>
#include <winhttp.h>
#include <algorithm>

namespace host {
namespace {
std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n); return w;
}
std::string utf8(const wchar_t* w, int len = -1) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr); if (n <= 0) return {};
  std::string s(n, '\0'); WideCharToMultiByte(CP_UTF8, 0, w, len, s.data(), n, nullptr, nullptr);
  if (len < 0 && !s.empty()) s.pop_back();  // the terminator
  return s;
}
std::string lastError(const char* what) { return std::string(what) + " failed (WinHTTP error " + std::to_string(GetLastError()) + ")"; }
HINTERNET g_session = nullptr;
}  // namespace

void Http::init(JavaVM*, Loop* loop, std::vector<std::string> allow) {
  loop_ = loop; allow_ = std::move(allow);
  g_session = WinHttpOpen(L"webxr-host", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!g_session) HOST_LOGE("http: WinHttpOpen failed (%lu)", GetLastError());
  else {
    // Android's timeouts: 15 s to connect, then 30 s without a byte.
    WinHttpSetTimeouts(g_session, 15000, 15000, 30000, 30000);
    DWORD dec = WINHTTP_DECOMPRESSION_FLAG_ALL; WinHttpSetOption(g_session, WINHTTP_OPTION_DECOMPRESSION, &dec, sizeof dec);  // the body arrives decoded, like the JNI path
    DWORD never = WINHTTP_OPTION_REDIRECT_POLICY_NEVER; WinHttpSetOption(g_session, WINHTTP_OPTION_REDIRECT_POLICY, &never, sizeof never);
  }
  for (int i = 0; i < 4; ++i) threads_.emplace_back([this] { worker(); });
}

void Http::cancelInflight() {
  std::lock_guard<std::mutex> g(mu_);
  for (void* h : inflight_) WinHttpCloseHandle((HINTERNET)h);  // any thread may close a handle; the worker's pending call fails with it
  inflight_.clear();
}

void Http::worker() {
  for (;;) {
    std::pair<HttpRequest, std::function<void(HttpResponse)>> job;
    { std::unique_lock<std::mutex> lk(mu_); cv_.wait(lk, [&] { return stop_ || !q_.empty(); }); if (stop_ && q_.empty()) break; job = std::move(q_.front()); q_.pop(); }
    HttpResponse r = perform(nullptr, job.first);
    auto cb = job.second; loop_->post([cb, r] { cb(r); });
  }
}

// Redirects come back as responses (the session follows none) and are followed here one hop at a time, each
// target checked against network.allow (and kept to http/https), as mac/http_curl.cpp does. A 303, or a 301/302
// answering a POST, goes on as a GET without the body; 307/308 keep the method and body.
HttpResponse Http::perform(JNIEnv*, const HttpRequest& r) {
  HttpResponse out;
  if (!g_session) { out.error = "WinHTTP unavailable"; return out; }
  std::string url = r.url, method = r.method; bool sendBody = !r.body.empty();
  for (int hop = 0; ; ++hop) {
    out = HttpResponse{};
    std::wstring wurl = wide(url);
    URL_COMPONENTS uc{}; uc.dwStructSize = sizeof uc; uc.dwSchemeLength = uc.dwHostNameLength = uc.dwUrlPathLength = uc.dwExtraInfoLength = (DWORD)-1;
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc) || (uc.nScheme != INTERNET_SCHEME_HTTP && uc.nScheme != INTERNET_SCHEME_HTTPS)) { out.error = "unsupported URL: " + url; return out; }
    std::wstring hostName(uc.lpszHostName, uc.dwHostNameLength), path(uc.lpszUrlPath, uc.dwUrlPathLength);
    std::wstring extra(uc.lpszExtraInfo, uc.dwExtraInfoLength); extra = extra.substr(0, extra.find(L'#'));  // the fragment stays here
    path += extra; if (path.empty() || path[0] != L'/') path = L"/" + path;
    HINTERNET conn = WinHttpConnect(g_session, hostName.c_str(), uc.nPort, 0);
    if (!conn) { out.error = lastError("connect"); return out; }
    HINTERNET req = WinHttpOpenRequest(conn, wide(method).c_str(), path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!req) { out.error = lastError("open request"); WinHttpCloseHandle(conn); return out; }
    { std::lock_guard<std::mutex> g(mu_); if (stop_) { WinHttpCloseHandle(req); WinHttpCloseHandle(conn); out.error = "cancelled"; return out; } inflight_.push_back(req); }  // shutdown closes it, which fails the calls below
    std::wstring headers; for (auto& h : r.headers) headers += wide(h.first) + L": " + wide(h.second) + L"\r\n";
    const bool sent = WinHttpSendRequest(req, headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(), headers.empty() ? 0 : (DWORD)-1,
                                         sendBody ? (LPVOID)r.body.data() : WINHTTP_NO_REQUEST_DATA, sendBody ? (DWORD)r.body.size() : 0, sendBody ? (DWORD)r.body.size() : 0, 0);
    std::string next;
    if (!sent || !WinHttpReceiveResponse(req, nullptr)) out.error = lastError("request");
    else {
      DWORD status = 0, size = sizeof status;
      WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX);
      out.status = (int)status;
      size = 0; WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_TEXT, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
      if (size) { std::wstring t(size / sizeof(wchar_t), L'\0'); if (WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_TEXT, WINHTTP_HEADER_NAME_BY_INDEX, t.data(), &size, WINHTTP_NO_HEADER_INDEX)) out.statusText = utf8(t.c_str()); }
      // Every header line, "Name: value" after the status line.
      size = 0; WinHttpQueryHeaders(req, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
      if (size) {
        std::wstring raw(size / sizeof(wchar_t), L'\0');
        if (WinHttpQueryHeaders(req, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, raw.data(), &size, WINHTTP_NO_HEADER_INDEX)) {
          std::string all = utf8(raw.c_str()); size_t p = all.find("\r\n");
          while (p != std::string::npos && p + 2 < all.size()) {
            size_t e = all.find("\r\n", p + 2); std::string line = all.substr(p + 2, (e == std::string::npos ? all.size() : e) - p - 2); p = e;
            size_t c = line.find(':'); if (c == std::string::npos) continue;
            size_t v = c + 1; while (v < line.size() && line[v] == ' ') v++;
            out.headers.push_back({line.substr(0, c), line.substr(v)});
          }
        }
      }
      for (;;) {
        DWORD avail = 0; if (!WinHttpQueryDataAvailable(req, &avail)) { out.error = lastError("read"); break; }
        if (!avail) break;
        size_t at = out.body.size(); out.body.resize(at + avail); DWORD got = 0;
        if (!WinHttpReadData(req, out.body.data() + at, avail, &got)) { out.error = lastError("read"); break; }
        out.body.resize(at + got);
      }
      if (out.error.empty() && status >= 300 && status < 400) {
        size = 0; WinHttpQueryHeaders(req, WINHTTP_QUERY_LOCATION, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
        if (size) {
          std::wstring loc(size / sizeof(wchar_t), L'\0');
          if (WinHttpQueryHeaders(req, WINHTTP_QUERY_LOCATION, WINHTTP_HEADER_NAME_BY_INDEX, loc.data(), &size, WINHTTP_NO_HEADER_INDEX)) {
            next = utf8(loc.c_str());
            // A relative Location resolves against this URL: an absolute path keeps scheme and host, anything else the directory too.
            if (next.find("://") == std::string::npos) {
              std::string origin = url.substr(0, url.find('/', url.find("://") + 3));
              std::string base = url.substr(0, url.find_first_of("?#"));
              if (next.rfind("//", 0) == 0) next = url.substr(0, url.find("://") + 1) + next;
              else if (!next.empty() && next[0] == '/') next = origin + next;
              else if (!next.empty() && (next[0] == '?' || next[0] == '#')) next = base + next;
              else next = base.substr(0, base.rfind('/') + 1) + next;
            }
          }
        }
      }
    }
    bool mine; { std::lock_guard<std::mutex> g(mu_); auto it = std::find(inflight_.begin(), inflight_.end(), (void*)req); mine = it != inflight_.end(); if (mine) inflight_.erase(it); }
    if (mine) WinHttpCloseHandle(req); WinHttpCloseHandle(conn);  // not mine: shutdown closed it
    if (!out.error.empty() || next.empty()) return out;
    if (hop >= 10) { out.error = "too many redirects"; return out; }
    if (!allowed(next)) { out = HttpResponse{}; out.error = "redirect blocked by network.allow: " + next; return out; }
    if (out.status == 303 || ((out.status == 301 || out.status == 302) && method == "POST")) { method = "GET"; sendBody = false; }
    url = next;
  }
}

}  // namespace host
