#include "android/permissions.h"
#include "core/log.h"
#include "android/jni_env.h"

namespace host {
using Env = JniEnv;

bool hasPermission(void* javaVm, void* activity, const char* name) {
  if (!javaVm || !activity) return false;
  Env e(javaVm); if (!e.env) return false;
  jobject act = (jobject)activity; jclass cls = e.env->GetObjectClass(act);
  jmethodID m = e.env->GetMethodID(cls, "checkSelfPermission", "(Ljava/lang/String;)I");
  if (!m) { e.env->ExceptionClear(); return false; }
  jstring js = e.env->NewStringUTF(name);
  jint r = e.env->CallIntMethod(act, m, js);
  if (e.env->ExceptionCheck()) { e.env->ExceptionClear(); r = -1; }
  e.env->DeleteLocalRef(js); e.env->DeleteLocalRef(cls);
  return r == 0;  // PackageManager.PERMISSION_GRANTED
}

void requestPermission(void* javaVm, void* activity, const char* name) {
  if (!javaVm || !activity) return;
  Env e(javaVm); if (!e.env) return;
  jobject act = (jobject)activity; jclass cls = e.env->GetObjectClass(act);
  jmethodID m = e.env->GetMethodID(cls, "requestPermissions", "([Ljava/lang/String;I)V");
  if (!m) { e.env->ExceptionClear(); return; }
  jclass str = e.env->FindClass("java/lang/String");
  jobjectArray arr = e.env->NewObjectArray(1, str, nullptr);
  jstring js = e.env->NewStringUTF(name); e.env->SetObjectArrayElement(arr, 0, js);
  e.env->CallVoidMethod(act, m, arr, 1);
  if (e.env->ExceptionCheck()) { e.env->ExceptionClear(); HOST_LOGW("requestPermissions(%s) threw", name); } else HOST_LOGI("requested permission %s", name);
  e.env->DeleteLocalRef(js); e.env->DeleteLocalRef(arr); e.env->DeleteLocalRef(str); e.env->DeleteLocalRef(cls);
}
}  // namespace host
