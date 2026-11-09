#include "android/display.h"
#include "core/log.h"
#include <jni.h>

namespace host {
namespace {
JNIEnv* E(void* e) { return (JNIEnv*)e; }
jobject callObj(JNIEnv* e, jobject o, const char* name, const char* sig) {
  if (!o) return nullptr;
  jclass c = e->GetObjectClass(o); jmethodID m = e->GetMethodID(c, name, sig); e->DeleteLocalRef(c);
  if (!m) { e->ExceptionClear(); return nullptr; }
  jobject r = e->CallObjectMethod(o, m);
  if (e->ExceptionCheck()) { e->ExceptionClear(); return nullptr; }
  return r;
}
}  // namespace

bool Display::init(void* javaVm, void* activity) {  // again for a new activity: the thread stays attached, the Display is re-read
  JavaVM* vm = (JavaVM*)javaVm;
  if (!vm || !activity) return false;
  if (!env_) {
    JNIEnv* e = nullptr; vm_ = vm;
    if (vm->GetEnv((void**)&e, JNI_VERSION_1_6) != JNI_OK) {
      JavaVMAttachArgs a{JNI_VERSION_1_6, "host-js", nullptr};
      if (vm->AttachCurrentThread(&e, &a) != JNI_OK) return false;
      attached_ = true;
    }
    env_ = e;
  }
  JNIEnv* e = E(env_);
  if (display_) { e->DeleteGlobalRef((jobject)display_); display_ = nullptr; }
  jobject wm = callObj(e, (jobject)activity, "getWindowManager", "()Landroid/view/WindowManager;");
  jobject d = callObj(e, wm, "getDefaultDisplay", "()Landroid/view/Display;");
  if (wm) e->DeleteLocalRef(wm);
  if (!d) { HOST_LOGW("display: no Display object"); return false; }
  display_ = e->NewGlobalRef(d); e->DeleteLocalRef(d);
  jclass dc = e->GetObjectClass((jobject)display_);
  getRotation_ = e->GetMethodID(dc, "getRotation", "()I"); getRefreshRate_ = e->GetMethodID(dc, "getRefreshRate", "()F");
  getCutout_ = e->GetMethodID(dc, "getCutout", "()Landroid/view/DisplayCutout;");  // API 29
  e->DeleteLocalRef(dc); if (e->ExceptionCheck()) e->ExceptionClear();
  if (jclass cc = e->FindClass("android/view/DisplayCutout")) {
    cutoutTop_ = e->GetMethodID(cc, "getSafeInsetTop", "()I"); cutoutRight_ = e->GetMethodID(cc, "getSafeInsetRight", "()I");
    cutoutBottom_ = e->GetMethodID(cc, "getSafeInsetBottom", "()I"); cutoutLeft_ = e->GetMethodID(cc, "getSafeInsetLeft", "()I");
    e->DeleteLocalRef(cc);
  }
  if (e->ExceptionCheck()) e->ExceptionClear();
  return true;
}

void Display::shutdown() {
  if (env_ && display_) E(env_)->DeleteGlobalRef((jobject)display_);
  display_ = nullptr;
  if (attached_ && vm_) ((JavaVM*)vm_)->DetachCurrentThread();
  attached_ = false; env_ = nullptr;
}

int Display::rotationDegrees() {
  if (!env_ || !display_ || !getRotation_) return 0;
  JNIEnv* e = E(env_); const int r = e->CallIntMethod((jobject)display_, (jmethodID)getRotation_);
  if (e->ExceptionCheck()) { e->ExceptionClear(); return 0; }
  return (r & 3) * 90;
}

float Display::refreshRate() {
  if (!env_ || !display_ || !getRefreshRate_) return 0;
  JNIEnv* e = E(env_); const float hz = e->CallFloatMethod((jobject)display_, (jmethodID)getRefreshRate_);
  if (e->ExceptionCheck()) { e->ExceptionClear(); return 0; }
  return hz;
}

bool Display::cutoutInsets(int out[4]) {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (!env_ || !display_ || !getCutout_ || !cutoutTop_) return false;
  JNIEnv* e = E(env_);
  jobject c = e->CallObjectMethod((jobject)display_, (jmethodID)getCutout_);
  if (e->ExceptionCheck()) { e->ExceptionClear(); return false; }
  if (!c) return false;
  out[0] = e->CallIntMethod(c, (jmethodID)cutoutTop_); out[1] = e->CallIntMethod(c, (jmethodID)cutoutRight_);
  out[2] = e->CallIntMethod(c, (jmethodID)cutoutBottom_); out[3] = e->CallIntMethod(c, (jmethodID)cutoutLeft_);
  if (e->ExceptionCheck()) e->ExceptionClear();
  e->DeleteLocalRef(c);
  return true;
}
}  // namespace host
