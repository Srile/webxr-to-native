#include <pthread.h>
#include <unistd.h>
#include <android_native_app_glue.h>
#include <android/looper.h>
#include <memory>
#include "app/host.h"
#include "android/phone_host.h"
#include "core/log.h"

namespace {
struct State { std::unique_ptr<host::Host> h; bool started = false; bool fatal = false; };

void onCmd(android_app* app, int32_t cmd) {
  auto* st = (State*)app->userData;
  switch (cmd) {
    case APP_CMD_INIT_WINDOW: if (st->h) st->h->onWindow(app->window); break;
    case APP_CMD_TERM_WINDOW: if (st->h) st->h->onWindowLost(); break;
    case APP_CMD_RESUME: if (st->h) st->h->onResume(); break;
    case APP_CMD_PAUSE: if (st->h) st->h->onPause(); break;
    case APP_CMD_LOW_MEMORY: if (st->h) st->h->onLowMemory(); break;
    case APP_CMD_DESTROY: HOST_LOGI("APP_CMD_DESTROY"); break;
    default: break;
  }
}
int32_t onInput(android_app* app, AInputEvent* e) { auto* st = (State*)app->userData; return st->h && st->h->onInput(e) ? 1 : 0; }
}  // namespace

void android_main(android_app* app) {
  if (host::phone::g_entry) { host::phone::androidMain(app); return; }  // the phone: a host that outlives its activity
  pthread_setname_np(pthread_self(), "host-js");
  HOST_LOGI("android_main");
  // The Quest: the host lives on this activity's thread (its OpenXR session belongs to the activity). V8 runs once
  // per process, so an activity recreated in the same process ends the process instead of crashing in V8; every
  // configuration change the manifest can list is handled without one. The phone build keeps its host across
  // activities instead (android/phone_host.h).
  static bool ranBefore = false;
  if (ranBefore) { HOST_LOGW("activity recreated in a running process (V8 cannot start twice): the app closes"); _exit(0); }
  ranBefore = true;
  State st; app->userData = &st; app->onAppCmd = onCmd; app->onInputEvent = onInput;
  st.h = std::make_unique<host::Host>(app);
  if (!st.h->start()) { HOST_LOGE("host start failed"); st.fatal = true; }
  while (!app->destroyRequested) {
    int events; android_poll_source* source;
    // Non-blocking poll: the XR frame loop paces itself in xrWaitFrame.
    while (ALooper_pollOnce(0, nullptr, &events, (void**)&source) >= 0) { if (source) source->process(app, source); if (app->destroyRequested) break; }
    if (app->destroyRequested) break;
    if (st.fatal) { ALooper_pollOnce(100, nullptr, &events, (void**)&source); continue; }
    if (!st.h->tick()) { HOST_LOGI("host loop ended; finishing activity"); ANativeActivity_finish(app->activity); st.fatal = true; }
  }
  st.h.reset();
  HOST_LOGI("android_main exit");
}
