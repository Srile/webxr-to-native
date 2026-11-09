#pragma once
// A JNIEnv for the calling thread: the one it has, else attached for this object's life (and detached after).
#include <jni.h>

namespace host {
struct JniEnv {
  JNIEnv* env = nullptr; bool attached = false; JavaVM* vm;
  explicit JniEnv(void* javaVm, const char* name = "host-jni") : vm((JavaVM*)javaVm) {
    if (!vm) return;
    if (vm->GetEnv((void**)&env, JNI_VERSION_1_6) == JNI_OK) return;
    JavaVMAttachArgs a{JNI_VERSION_1_6, name, nullptr};
    if (vm->AttachCurrentThread(&env, &a) == JNI_OK) attached = true; else env = nullptr;
  }
  ~JniEnv() { if (attached) vm->DetachCurrentThread(); }
  JniEnv(const JniEnv&) = delete; JniEnv& operator=(const JniEnv&) = delete;
};
}  // namespace host
