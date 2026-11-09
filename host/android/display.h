#pragma once
// The phone build's display (WP-20), through the activity's Display: its rotation, refresh rate and the safe-area
// insets of the cutout. init() attaches the host thread to the JVM once and caches the references, so the per-second
// rotation check in a frame is one int call with no attach and no Java allocation; the cutout (which allocates a
// DisplayCutout) is read only when the rotation or the window size changed. Host thread only.
namespace host {
class Display {
 public:
  bool init(void* javaVm, void* activity);  // again for each new activity (the phone host outlives them)
  void shutdown();  // before the thread that called init() ends: drops the references, detaches
  int rotationDegrees();                 // 0, 90, 180, 270 from the natural orientation
  float refreshRate();                   // Hz; 0 when unknown
  bool cutoutInsets(int out[4]);         // pixels: top, right, bottom, left; false (zeros) when there is none
 private:
  void* env_ = nullptr; void* vm_ = nullptr; bool attached_ = false;
  void* display_ = nullptr;  // jobject, global
  void* getRotation_ = nullptr; void* getRefreshRate_ = nullptr; void* getCutout_ = nullptr;  // jmethodID
  void* cutoutTop_ = nullptr; void* cutoutRight_ = nullptr; void* cutoutBottom_ = nullptr; void* cutoutLeft_ = nullptr;
};
}  // namespace host
