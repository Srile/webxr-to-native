#pragma once
// V8 inspector over a tiny WebSocket server (no TLS) so Chrome DevTools attaches
// via `adb forward tcp:9229 tcp:9229` + chrome://inspect. Also carries the
// /host JSON-RPC bridge (WP-13). Socket I/O runs on its own thread; every
// inspector message is dispatched on the host thread through Loop::post.
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <v8-inspector.h>
#include "core/loop.h"

namespace host {

class Engine;

class Inspector : public v8_inspector::V8InspectorClient {
 public:
  Inspector(Engine& engine, Loop& loop);
  ~Inspector() override;
  // loopbackOnly: accept connections from this machine only (the desktop host, which sits on whatever network
  // its Mac is on). The headset keeps every interface: adb forward reaches it that way.
  bool start(int port, const std::string& title, bool loopbackOnly = false);
  void stop();
  bool connected() const { return connected_; }
  // Forward a console message to the DevTools console (host thread).
  void consoleMessage(int level, const std::string& text);
  // Host bridge handler: receives a JSON request text, returns the JSON reply text. Runs on the host thread.
  std::function<void(const std::string& request, std::function<void(const std::string&)> reply)> bridge;

  // V8InspectorClient
  void runMessageLoopOnPause(int contextGroupId) override;
  void quitMessageLoopOnPause() override;
  void runIfWaitingForDebugger(int contextGroupId) override;
  v8::Local<v8::Context> ensureDefaultContextInGroup(int contextGroupId) override;
  double currentTimeMS() override;

 private:
  struct Channel;
  struct Conn { int fd; bool websocket = false; bool isBridge = false; std::string in; };
  void serverThread();
  void handleHttp(Conn& c, const std::string& req);
  void onWsMessage(Conn& c, std::string msg);
  void sendWs(int fd, const std::string& payload);
  void pollPaused();

  Engine& engine_; Loop& loop_;
  std::unique_ptr<v8_inspector::V8Inspector> inspector_;
  std::unique_ptr<v8_inspector::V8InspectorSession> session_;
  std::unique_ptr<Channel> channel_;
  std::thread thread_;
  std::atomic<bool> running_{false}, connected_{false}, paused_{false};
  int listenFd_ = -1; int port_ = 9229; std::string title_;
  std::mutex mu_; std::vector<std::string> pausedQueue_; int devtoolsFd_ = -1;
  friend struct Channel;
};

}  // namespace host
