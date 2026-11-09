#pragma once
// Android runtime permissions from a NativeActivity (no Java in the APK): checkSelfPermission /
// requestPermissions through JNI. The result dialog's callback never reaches native code, so callers
// re-check `has` when the activity regains focus.
namespace host {
bool hasPermission(void* javaVm, void* activity, const char* name);
void requestPermission(void* javaVm, void* activity, const char* name);
}
