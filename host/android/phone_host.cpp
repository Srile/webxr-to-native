#include "android/phone_host.h"
#include "android/jni_env.h"
#include "app/host.h"
#include "core/log.h"
#include <android_native_app_glue.h>
#include <android/asset_manager_jni.h>
#include <android/looper.h>
#include <pthread.h>
#include <unistd.h>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>

namespace host::phone {
bool g_entry = false;

namespace {
enum Kind { kAttach, kWindow, kWindowLost, kResume, kPause, kLowMemory, kDetach };
struct Cmd { Kind kind; android_app* app; ANativeWindow* win; uint64_t seq; };

// Shared between the activities' threads and the host thread, for the life of the process.
struct Shared {
  std::mutex m; std::condition_variable cv;
  std::deque<Cmd> cmds; uint64_t sent = 0, done = 0;
  static constexpr unsigned kRing = 256;  // input copied on the activity's thread, applied on the host thread
  Host::InputEvent ring[kRing]; unsigned head = 0, tail = 0; bool dropped = false;
  ALooper* looper = nullptr;  // the host thread's: woken for every command and every input event
  bool started = false, ended = false;
};
Shared S;

void wakeLocked() { if (S.looper) ALooper_wake(S.looper); }

// Hands a lifecycle step to the host thread and waits until it has been applied (or the host has ended).
void send(Kind k, android_app* app, ANativeWindow* win = nullptr) {
  std::unique_lock<std::mutex> l(S.m);
  if (S.ended) return;
  const uint64_t seq = ++S.sent;
  S.cmds.push_back({k, app, win, seq}); wakeLocked();
  S.cv.wait(l, [&] { return S.done >= seq || S.ended; });
}

void onCmd(android_app* app, int32_t cmd) {
  switch (cmd) {
    case APP_CMD_INIT_WINDOW: send(kWindow, app, app->window); break;
    case APP_CMD_TERM_WINDOW: send(kWindowLost, app, app->window); break;  // the glue clears app->window after this
    case APP_CMD_RESUME: send(kResume, app); break;
    case APP_CMD_PAUSE: send(kPause, app); break;
    case APP_CMD_LOW_MEMORY: send(kLowMemory, app); break;
    case APP_CMD_DESTROY: HOST_LOGI("APP_CMD_DESTROY"); break;
    default: break;
  }
}

int32_t onInput(android_app*, AInputEvent* e) {
  Host::InputEvent r;
  if (!Host::readInput(e, r)) return 0;
  std::lock_guard<std::mutex> l(S.m);
  if (S.tail - S.head < Shared::kRing) { S.ring[S.tail++ % Shared::kRing] = r; wakeLocked(); }
  else if (!S.dropped) { S.dropped = true; HOST_LOGW("phone input: the host thread is behind, events dropped"); }
  return 1;
}

// The application's AssetManager, held for the process: an activity's own goes with the activity, and the host's
// asset reads (workers too) outlive every activity.
AAssetManager* processAssets(android_app* app) {
  JniEnv j(app->activity->vm, "host-js"); JNIEnv* e = j.env;
  if (!e) return nullptr;
  auto call = [e](jobject o, const char* name, const char* sig) -> jobject {
    if (!o) return nullptr;
    jclass c = e->GetObjectClass(o); jmethodID m = e->GetMethodID(c, name, sig); e->DeleteLocalRef(c);
    if (!m) { e->ExceptionClear(); return nullptr; }
    jobject r = e->CallObjectMethod(o, m);
    if (e->ExceptionCheck()) { e->ExceptionClear(); return nullptr; }
    return r;
  };
  jobject application = call(app->activity->clazz, "getApplication", "()Landroid/app/Application;");
  jobject am = call(application, "getAssets", "()Landroid/content/res/AssetManager;");
  AAssetManager* out = nullptr;
  if (am) out = AAssetManager_fromJava(e, e->NewGlobalRef(am));  // never released: the process's
  if (am) e->DeleteLocalRef(am);
  if (application) e->DeleteLocalRef(application);
  if (!out) HOST_LOGW("phone: no application AssetManager; using the activity's");
  return out;
}

void hostMain(android_app* first) {
  pthread_setname_np(pthread_self(), "host-js");
  ALooper* looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);  // Choreographer posts its vsyncs here
  ALooper_acquire(looper);
  { std::lock_guard<std::mutex> l(S.m); S.looper = looper; }
  auto h = std::make_unique<Host>(first);
  h->useAssetManager(processAssets(first));
  h->ownLooper();
  const bool ok = h->start();
  if (!ok) HOST_LOGE("host start failed");
  android_app* current = first; ANativeWindow* bound = nullptr;
  std::deque<Cmd> cmds; Host::InputEvent in[32];
  for (;;) {
    { std::lock_guard<std::mutex> l(S.m); cmds.swap(S.cmds); }
    for (const Cmd& c : cmds) {
      switch (c.kind) {
        case kAttach: if (c.app != current) { h->attach(c.app); current = c.app; } break;
        case kWindow: if (c.app == current && c.win) { h->onWindow(c.win); bound = c.win; } break;
        case kWindowLost: if (bound && c.win == bound) { h->onWindowLost(); bound = nullptr; } break;  // an old activity's late loss is not the new window's
        case kResume: if (c.app == current) h->onResume(); break;
        case kPause: if (c.app == current) h->onPause(); break;
        case kLowMemory: h->onLowMemory(); break;
        case kDetach:
          if (c.app == current) { if (bound) { h->onWindowLost(); bound = nullptr; } h->detach(); current = nullptr; }
          break;
      }
      std::lock_guard<std::mutex> l(S.m); S.done = c.seq; S.cv.notify_all();
    }
    cmds.clear();
    for (;;) {
      unsigned n = 0;
      { std::lock_guard<std::mutex> l(S.m); while (S.head != S.tail && n < 32) in[n++] = S.ring[S.head++ % Shared::kRing]; }
      if (!n) break;
      for (unsigned i = 0; i < n; ++i) h->applyInput(in[i]);
    }
    if (!ok) { ALooper_pollOnce(100, nullptr, nullptr, nullptr); continue; }
    if (!h->tick()) break;
  }
  // The page asked to close (or the host failed): finish the activity while it still exists (its Detach is held up
  // until this thread answers), drop the host (its surface and V8), then let every waiting activity go.
  HOST_LOGI("host loop ended; finishing the activity");
  if (current) ANativeActivity_finish(current->activity);
  h.reset();
  { std::lock_guard<std::mutex> l(S.m); S.ended = true; S.looper = nullptr; S.cv.notify_all(); }
  ALooper_release(looper);
}
}  // namespace

void androidMain(android_app* app) {
  HOST_LOGI("android_main (phone)");
  bool first = false, ended = false;
  { std::lock_guard<std::mutex> l(S.m); ended = S.ended; first = !S.started; S.started = true; }
  if (ended) { HOST_LOGW("the host has ended in this process (V8 cannot start twice): the app closes"); _exit(0); }
  app->onAppCmd = onCmd; app->onInputEvent = onInput;
  if (first) std::thread(hostMain, app).detach();
  else { HOST_LOGI("activity recreated: attaching to the running host"); send(kAttach, app); }
  while (!app->destroyRequested) {
    int events; android_poll_source* source;
    if (ALooper_pollOnce(-1, nullptr, &events, (void**)&source) >= 0 && source) source->process(app, source);
  }
  send(kDetach, app);
  { std::lock_guard<std::mutex> l(S.m); ended = S.ended; }
  if (ended) { HOST_LOGI("android_main exit; the host has ended, so does the process"); _exit(0); }
  HOST_LOGI("android_main exit; the host stays for the next activity");
}
}  // namespace host::phone
