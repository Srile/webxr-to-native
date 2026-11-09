#include "js/inspector.h"
#include "core/log.h"
#include "js/engine.h"
#include <cctype>
#include <cstring>
#ifdef _WIN32
// Winsock under the POSIX names used below (the Windows host, host/win/). A SOCKET is a small kernel handle:
// the int fields hold it, as they hold a descriptor elsewhere.
#include <winsock2.h>
#include <ws2tcpip.h>
#define poll WSAPoll
#define SHUT_RDWR SD_BOTH
typedef int ssize_t;
static int closeSock(int fd) { return closesocket((SOCKET)fd); }
static std::string sockError() { return "winsock error " + std::to_string(WSAGetLastError()); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <poll.h>
#include <cerrno>
typedef int SOCKET;
static int closeSock(int fd) { return close(fd); }
static std::string sockError() { return strerror(errno); }
#endif
#include <chrono>

namespace host {

// ---- minimal SHA-1 + base64 for the WebSocket handshake ----
namespace {
struct Sha1 { uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  static uint32_t rol(uint32_t v, int s) { return (v << s) | (v >> (32 - s)); }
  void block(const uint8_t* p) { uint32_t w[80]; for (int i = 0; i < 16; ++i) w[i] = (p[i * 4] << 24) | (p[i * 4 + 1] << 16) | (p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (int i = 16; i < 80; ++i) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; ++i) { uint32_t f, k; if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; } else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      uint32_t t = rol(a, 5) + f + e + k + w[i]; e = d; d = c; c = rol(b, 30); b = a; a = t; }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; }
  std::string digest(const std::string& msg) { std::string m = msg; uint64_t bits = (uint64_t)msg.size() * 8; m += (char)0x80; while (m.size() % 64 != 56) m += (char)0; for (int i = 7; i >= 0; --i) m += (char)((bits >> (i * 8)) & 0xFF);
    for (size_t i = 0; i < m.size(); i += 64) block((const uint8_t*)m.data() + i);
    std::string out; for (int i = 0; i < 5; ++i) for (int s = 24; s >= 0; s -= 8) out += (char)((h[i] >> s) & 0xFF); return out; }
};
std::string b64(const std::string& in) { static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string o; size_t i = 0;
  for (; i + 2 < in.size(); i += 3) { uint32_t v = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8) | (uint8_t)in[i + 2]; o += T[v >> 18]; o += T[(v >> 12) & 63]; o += T[(v >> 6) & 63]; o += T[v & 63]; }
  if (i + 1 == in.size()) { uint32_t v = (uint8_t)in[i] << 16; o += T[v >> 18]; o += T[(v >> 12) & 63]; o += "=="; } else if (i + 2 == in.size()) { uint32_t v = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8); o += T[v >> 18]; o += T[(v >> 12) & 63]; o += T[(v >> 6) & 63]; o += '='; }
  return o; }
std::string toUtf8(const v8_inspector::StringView& v) {
  if (v.is8Bit()) return std::string((const char*)v.characters8(), v.length());
  std::string out; const uint16_t* s = v.characters16();
  for (size_t i = 0; i < v.length(); ++i) { uint32_t c = s[i]; if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length()) { c = 0x10000 + ((c - 0xD800) << 10) + (s[i + 1] - 0xDC00); ++i; }
    if (c < 0x80) out += (char)c; else if (c < 0x800) { out += (char)(0xC0 | (c >> 6)); out += (char)(0x80 | (c & 0x3F)); } else if (c < 0x10000) { out += (char)(0xE0 | (c >> 12)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); } else { out += (char)(0xF0 | (c >> 18)); out += (char)(0x80 | ((c >> 12) & 0x3F)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); } }
  return out; }
}  // namespace

struct Inspector::Channel : public v8_inspector::V8Inspector::Channel {
  Inspector& o; explicit Channel(Inspector& i) : o(i) {}
  void sendResponse(int, std::unique_ptr<v8_inspector::StringBuffer> m) override { o.sendWs(o.devtoolsFd_, toUtf8(m->string())); }
  void sendNotification(std::unique_ptr<v8_inspector::StringBuffer> m) override { o.sendWs(o.devtoolsFd_, toUtf8(m->string())); }
  void flushProtocolNotifications() override {}
};

Inspector::Inspector(Engine& e, Loop& l) : engine_(e), loop_(l) {}
Inspector::~Inspector() { stop(); }

bool Inspector::start(int port, const std::string& title, bool loopbackOnly) {
  port_ = port; title_ = title;
  v8::Isolate* iso = engine_.isolate(); v8::Isolate::Scope is(iso); v8::HandleScope hs(iso);
  inspector_ = v8_inspector::V8Inspector::create(iso, this);
  v8::Local<v8::Context> ctx = engine_.context();
  const char* name = "webxr-host";
  inspector_->contextCreated(v8_inspector::V8ContextInfo(ctx, 1, v8_inspector::StringView((const uint8_t*)name, strlen(name))));
#ifdef _WIN32
  { WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa); }
#endif
  listenFd_ = (int)socket(AF_INET, SOCK_STREAM, 0); int one = 1;
#ifdef _WIN32
  setsockopt(listenFd_, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char*)&one, sizeof one);  // Windows' SO_REUSEADDR would let another socket take the port
#else
  setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof one);
#endif
  sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(loopbackOnly ? INADDR_LOOPBACK : INADDR_ANY); addr.sin_port = htons((uint16_t)port);
  if (bind(listenFd_, (sockaddr*)&addr, sizeof addr) < 0 || listen(listenFd_, 4) < 0) { HOST_LOGE("inspector: bind %d failed: %s", port, sockError().c_str()); closeSock(listenFd_); listenFd_ = -1; return false; }
  running_ = true; thread_ = std::thread([this] { serverThread(); });
  if (loopbackOnly) HOST_LOGI("inspector listening on 127.0.0.1:%d (chrome://inspect)", port);
  else HOST_LOGI("inspector listening on %d (adb forward tcp:%d tcp:%d; chrome://inspect)", port, port, port);
  return true;
}

void Inspector::stop() {
  running_ = false;
  if (listenFd_ >= 0) { shutdown(listenFd_, SHUT_RDWR); closeSock(listenFd_); listenFd_ = -1; }
  if (thread_.joinable()) thread_.join();
  session_.reset(); channel_.reset(); inspector_.reset();
}

double Inspector::currentTimeMS() { return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count(); }
v8::Local<v8::Context> Inspector::ensureDefaultContextInGroup(int) { return engine_.context(); }
void Inspector::runIfWaitingForDebugger(int) {}

void Inspector::consoleMessage(int level, const std::string& text) {
  if (!inspector_ || !session_) return;
  v8::Isolate* iso = engine_.isolate(); v8::HandleScope hs(iso); v8::Local<v8::Context> ctx = engine_.context();
  v8::Local<v8::Value> args[1] = {v8::String::NewFromUtf8(iso, text.c_str()).ToLocalChecked()};
  // Route through console API so DevTools shows it with the right level.
  v8::Local<v8::Object> con; v8::Local<v8::Value> cv;
  (void)level; (void)args; (void)ctx; (void)con; (void)cv;  // messages already reach DevTools via V8's console hooks when installed through the inspector; logcat is the fallback.
}

// ---- pause loop: service the socket on the host thread while JS is paused ----
void Inspector::runMessageLoopOnPause(int) {
  paused_ = true;
  while (paused_ && running_) { pollPaused(); std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
}
void Inspector::quitMessageLoopOnPause() { paused_ = false; }
void Inspector::pollPaused() {
  std::vector<std::string> q; { std::lock_guard<std::mutex> g(mu_); q.swap(pausedQueue_); }
  for (auto& m : q) if (session_) session_->dispatchProtocolMessage(v8_inspector::StringView((const uint8_t*)m.data(), m.size()));
}

// ---- socket thread ----
void Inspector::sendWs(int fd, const std::string& p) {
  if (fd < 0) return;
  std::string f; f += (char)0x81; size_t n = p.size();
  if (n < 126) f += (char)n; else if (n < 65536) { f += (char)126; f += (char)(n >> 8); f += (char)(n & 0xFF); } else { f += (char)127; for (int i = 7; i >= 0; --i) f += (char)((n >> (i * 8)) & 0xFF); }
  f += p; const char* d = f.data(); size_t left = f.size();
  while (left) { ssize_t w = send(fd, d, (int)left, 0); if (w <= 0) return; d += w; left -= w; }
}

namespace {
// A Host header that names this machine by address (an IPv4 or bracketed IPv6 literal, with or without a port) or
// as localhost; a hostname is a DNS-rebinding page's. Absent is fine (HTTP/1.0 clients).
bool localHost(const std::string& h) {
  if (h.empty()) return true;
  std::string host = h;
  if (host[0] == '[') { size_t e = host.find(']'); if (e == std::string::npos) return false; host = host.substr(1, e - 1); for (char ch : host) if (!isxdigit((unsigned char)ch) && ch != ':' && ch != '.') return false; return !host.empty(); }
  host = host.substr(0, host.find(':'));
  { std::string lower = host; for (char& ch : lower) ch = (char)tolower((unsigned char)ch); if (lower == "localhost") return true; }
  if (host.empty()) return false;
  for (char ch : host) if (!isdigit((unsigned char)ch) && ch != '.') return false;
  return true;
}
}  // namespace

void Inspector::handleHttp(Conn& c, const std::string& req) {
  std::string line = req.substr(0, req.find("\r\n")); std::string path = line.substr(line.find(' ') + 1); path = path.substr(0, path.find(' '));
  auto header = [&](const char* k) { std::string key = std::string("\r\n") + k + ": "; size_t p = req.find(key); if (p == std::string::npos) return std::string(); p += key.size(); return req.substr(p, req.find("\r\n", p) - p); };
  // Only a debugger may connect, not a web page: a browser opens a WebSocket to any port on this machine (or, with
  // DNS rebinding, reads /json), so a request carrying a page's Origin is refused (DevTools sends devtools://,
  // Node-style clients and tools/bridge.mjs none), as is a Host naming anything but an address or localhost.
  const std::string origin = header("Origin"), hostHdr = header("Host");
  if ((!origin.empty() && origin.rfind("devtools://", 0) != 0) || !localHost(hostHdr)) {
    HOST_LOGW("inspector: refused a connection (origin '%s', host '%s')", origin.c_str(), hostHdr.c_str());
    const char* resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    send(c.fd, resp, (int)strlen(resp), 0); shutdown(c.fd, SHUT_RDWR); return;
  }
  std::string wsKey = header("Sec-WebSocket-Key");
  if (!wsKey.empty()) {
    std::string accept = b64(Sha1().digest(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
    std::string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
    send(c.fd, resp.data(), resp.size(), 0); c.websocket = true; c.isBridge = path.rfind("/host", 0) == 0;
    if (!c.isBridge) { devtoolsFd_ = c.fd; connected_ = true;
      loop_.post([this] { v8::Isolate* iso = engine_.isolate(); v8::Isolate::Scope is(iso); v8::HandleScope hs(iso); channel_ = std::make_unique<Channel>(*this); session_ = inspector_->connect(1, channel_.get(), v8_inspector::StringView()
#if V8_MAJOR_VERSION >= 11
        , v8_inspector::V8Inspector::kFullyTrusted
#endif
      ); HOST_LOGI("inspector: DevTools connected"); }); }
    else HOST_LOGI("inspector: bridge connected");
    return;
  }
  std::string body, type = "application/json; charset=UTF-8";
  if (path.rfind("/json/version", 0) == 0) body = "{\"Browser\":\"webxr-host/0.1\",\"Protocol-Version\":\"1.3\",\"V8-Version\":\"" + std::string(v8::V8::GetVersion()) + "\"}";
  else if (path.rfind("/json", 0) == 0) {
    std::string ws = "127.0.0.1:" + std::to_string(port_) + "/devtools/page/1";
    body = "[{\"description\":\"webxr-host\",\"id\":\"1\",\"title\":\"" + title_ + "\",\"type\":\"node\",\"url\":\"https://app.local/\",\"webSocketDebuggerUrl\":\"ws://" + ws + "\",\"devtoolsFrontendUrl\":\"devtools://devtools/bundled/js_app.html?ws=" + ws + "\"}]";
  } else { body = "webxr-host inspector"; type = "text/plain"; }
  std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
  send(c.fd, resp.data(), resp.size(), 0); shutdown(c.fd, SHUT_RDWR);
}

void Inspector::onWsMessage(Conn& c, std::string msg) {
  if (c.isBridge) {
    int fd = c.fd; loop_.post([this, fd, msg] { if (!bridge) { sendWs(fd, "{\"error\":\"no bridge\"}"); return; } bridge(msg, [this, fd](const std::string& reply) { sendWs(fd, reply); }); });
    return;
  }
  if (paused_) { std::lock_guard<std::mutex> g(mu_); pausedQueue_.push_back(std::move(msg)); return; }
  loop_.post([this, msg] { if (session_) { v8::Isolate* iso = engine_.isolate(); v8::Isolate::Scope is(iso); v8::HandleScope hs(iso); v8::Context::Scope cs(engine_.context()); session_->dispatchProtocolMessage(v8_inspector::StringView((const uint8_t*)msg.data(), msg.size())); } });
}

void Inspector::serverThread() {
  std::vector<Conn> conns;
  while (running_) {
    std::vector<pollfd> pf; pf.push_back({(SOCKET)listenFd_, POLLIN, 0}); for (auto& c : conns) pf.push_back({(SOCKET)c.fd, POLLIN, 0});
    if (poll(pf.data(), (unsigned)pf.size(), 200) <= 0) continue;
    if (pf[0].revents & POLLIN) { int fd = (int)accept(listenFd_, nullptr, nullptr); if (fd >= 0) { int one = 1; setsockopt(fd, IPPROTO_TCP, 1 /*TCP_NODELAY*/, (const char*)&one, sizeof one); conns.push_back({fd}); } }
    for (size_t i = 0; i < conns.size(); ++i) {
      if (!(pf[i + 1].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      Conn& c = conns[i]; char buf[65536]; ssize_t n = recv(c.fd, buf, (int)sizeof buf, 0);
      if (n <= 0) { if (c.fd == devtoolsFd_) { devtoolsFd_ = -1; connected_ = false; paused_ = false; loop_.post([this] { session_.reset(); channel_.reset(); HOST_LOGI("inspector: DevTools disconnected"); }); } closeSock(c.fd); conns.erase(conns.begin() + i); --i; continue; }
      c.in.append(buf, n);
      if (!c.websocket) { size_t end = c.in.find("\r\n\r\n"); if (end != std::string::npos) { handleHttp(c, c.in.substr(0, end + 4)); c.in.erase(0, end + 4); if (!c.websocket) { closeSock(c.fd); conns.erase(conns.begin() + i); --i; } } continue; }
      // decode frames
      for (;;) {
        if (c.in.size() < 2) break; uint8_t b0 = c.in[0], b1 = c.in[1]; int op = b0 & 0x0F; bool mask = b1 & 0x80; uint64_t len = b1 & 0x7F; size_t hdr = 2;
        if (len == 126) { if (c.in.size() < 4) break; len = ((uint8_t)c.in[2] << 8) | (uint8_t)c.in[3]; hdr = 4; } else if (len == 127) { if (c.in.size() < 10) break; len = 0; for (int k = 0; k < 8; ++k) len = (len << 8) | (uint8_t)c.in[2 + k]; hdr = 10; }
        if (mask) hdr += 4; if (c.in.size() < hdr + len) break;
        std::string payload = c.in.substr(hdr, len);
        if (mask) { const uint8_t* m = (const uint8_t*)c.in.data() + hdr - 4; for (size_t k = 0; k < payload.size(); ++k) payload[k] ^= m[k & 3]; }
        c.in.erase(0, hdr + len);
        if (op == 8) { shutdown(c.fd, SHUT_RDWR); break; }
        if (op == 9) { std::string pong; pong += (char)0x8A; pong += (char)payload.size(); pong += payload; send(c.fd, pong.data(), pong.size(), 0); continue; }
        if (op == 1 || op == 2) onWsMessage(c, std::move(payload));
      }
    }
  }
  for (auto& c : conns) closeSock(c.fd);
}

}  // namespace host
