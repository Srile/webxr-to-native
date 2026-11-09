// The phone build's activity entry (android.app.func_name in android/app/src/phone/AndroidManifest.xml, WP-20):
// native_app_glue's ANativeActivity_onCreate, then immersive mode, which hides the navigation bar (the gesture
// handle) and the status bar; a swipe from the edge shows them for a moment. NativeActivity calls this on the UI
// thread, where the window's insets may be changed, and calls the focus callback there too: immersive mode is set
// again whenever the activity regains focus (after the notification shade, a dialog, the recents screen).
#include <android/native_activity.h>
#include <jni.h>
#include "core/log.h"
#include "android/phone_host.h"

extern "C" void ANativeActivity_onCreate(ANativeActivity* activity, void* savedState, size_t savedStateSize);  // native_app_glue

namespace {
void (*g_glueFocus)(ANativeActivity*, int) = nullptr;

jobject call(JNIEnv* e, jobject o, const char* name, const char* sig) {
  if (!o) return nullptr;
  jclass c = e->GetObjectClass(o); jmethodID m = e->GetMethodID(c, name, sig); e->DeleteLocalRef(c);
  if (!m) { e->ExceptionClear(); return nullptr; }
  jobject r = e->CallObjectMethod(o, m);
  if (e->ExceptionCheck()) { e->ExceptionClear(); return nullptr; }
  return r;
}
void callInt(JNIEnv* e, jobject o, const char* name, int v) {
  jclass c = e->GetObjectClass(o); jmethodID m = e->GetMethodID(c, name, "(I)V"); e->DeleteLocalRef(c);
  if (!m) { e->ExceptionClear(); return; }
  e->CallVoidMethod(o, m, (jint)v);
  if (e->ExceptionCheck()) e->ExceptionClear();
}

void immersive(ANativeActivity* a) {
  JNIEnv* e = a->env;
  jobject window = call(e, a->clazz, "getWindow", "()Landroid/view/Window;");
  if (!window) return;
  bool done = false;
  if (a->sdkVersion >= 30) {  // WindowInsetsController: hide the system bars, show them transiently on a swipe
    jobject ctrl = call(e, window, "getInsetsController", "()Landroid/view/WindowInsetsController;");
    jclass type = ctrl ? e->FindClass("android/view/WindowInsets$Type") : nullptr;
    jmethodID bars = type ? e->GetStaticMethodID(type, "systemBars", "()I") : nullptr;
    if (bars) {
      const jint types = e->CallStaticIntMethod(type, bars);
      callInt(e, ctrl, "setSystemBarsBehavior", 2);  // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      callInt(e, ctrl, "hide", types);
      done = !e->ExceptionCheck();
    }
    if (e->ExceptionCheck()) e->ExceptionClear();
    if (type) e->DeleteLocalRef(type);
    if (ctrl) e->DeleteLocalRef(ctrl);
  }
  if (!done) {  // API 29: the system UI visibility flags (IMMERSIVE_STICKY, HIDE_NAVIGATION, FULLSCREEN, LAYOUT_*)
    jobject decor = call(e, window, "getDecorView", "()Landroid/view/View;");
    if (decor) { callInt(e, decor, "setSystemUiVisibility", 0x1000 | 0x400 | 0x200 | 0x100 | 0x4 | 0x2); e->DeleteLocalRef(decor); done = true; }
  }
  e->DeleteLocalRef(window);
  if (!done) HOST_LOGW("immersive mode not set: the system bars stay");
}

void onFocus(ANativeActivity* a, int focused) {
  if (g_glueFocus) g_glueFocus(a, focused);
  if (focused) immersive(a);
}
}  // namespace

extern "C" JNIEXPORT void webxrhost_onCreatePhone(ANativeActivity* activity, void* savedState, size_t savedStateSize) {
  host::phone::g_entry = true;  // android_main runs the phone host (android/phone_host.h)
  ANativeActivity_onCreate(activity, savedState, savedStateSize);
  g_glueFocus = activity->callbacks->onWindowFocusChanged;
  activity->callbacks->onWindowFocusChanged = onFocus;
  immersive(activity);
}
