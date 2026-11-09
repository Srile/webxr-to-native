#pragma once
// HTTPS through JNI java.net.HttpURLConnection on a small thread pool; results
// are posted back to the host loop. No native TLS stack to ship.
#include <atomic>
#include <functional>
#include <map>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#ifdef __ANDROID__
#include <jni.h>
#else
typedef void JavaVM; typedef void JNIEnv;  // desktop host (host/mac/http_curl.cpp): no JVM
#endif
#include "core/loop.h"
namespace host {
struct HttpRequest { std::string method = "GET", url, body; std::vector<std::pair<std::string, std::string>> headers; };
struct HttpResponse { int status = 0; std::string statusText; std::vector<std::pair<std::string, std::string>> headers; std::string body; std::string error; };
class Http {
 public:
  void init(JavaVM* vm, Loop* loop, std::vector<std::string> allowOrigins);
  // Stops the pool: nothing still queued runs (its results would go to a loop that is closing) and the transfers
  // in flight are cut short (cancelInflight, per transport), so a quit never waits on a download.
  void shutdown();
  // cb runs on the host loop thread.
  void request(HttpRequest req, std::function<void(HttpResponse)> cb);
  bool allowed(const std::string& url) const;
 private:
  void worker();
  HttpResponse perform(JNIEnv* env, const HttpRequest& r);
  void cancelInflight();  // under no lock; cancels what inflight_ holds (the transport's handles), under mu_
  JavaVM* vm_ = nullptr; Loop* loop_ = nullptr; std::vector<std::string> allow_;
  std::vector<std::thread> threads_; std::mutex mu_; std::condition_variable cv_; std::atomic<bool> stop_{false};
  std::vector<void*> inflight_;  // the transfers in flight, as the transport knows them (guarded by mu_)
  std::queue<std::pair<HttpRequest, std::function<void(HttpResponse)>>> q_;
};
}
