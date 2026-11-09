#pragma once
// The app's splash (host.json app.splash, staged as assets/vr_splash.png: the image the Quest shows until the
// app's first frame) in the emulated hosts' window while the page boots and warms up, which on a jitless V8
// (iOS) is seconds of black otherwise. It stays up until what the page draws has some structure (two pixel rows
// of the eye image or the window, read every few frames while the splash is up), at most kMaxMs.
#include <string>

namespace host {
class Assets;

class Splash {
 public:
  // Decodes the image and makes its texture (GL current). False: no splash for this app.
  bool load(const Assets& assets, const std::string& path);
  bool active() const { return tex_ != 0 && !done_; }
  // The page's frame so far: an eye image (XR) or the window (flat, framebuffer 0). Ends the splash once it
  // shows content, or once kMaxMs have passed since load.
  void sampleEye(unsigned colorTexture, int width, int height, int arraySize, double nowMs);
  void sampleWindow(int width, int height, double nowMs);
  // Over the window (framebuffer 0): black, the image centred at 60% of its width (80% of its height at most).
  void draw(int winW, int winH);

 private:
  void sample(int width, int height, double nowMs);  // reads rows of the bound read framebuffer
  void finish(const char* why);
  static constexpr double kMaxMs = 30000;
  unsigned tex_ = 0, fbo_ = 0;
  int w_ = 0, h_ = 0, frame_ = 0, hits_ = 0;
  double startMs_ = -1;
  bool done_ = false;
};

}  // namespace host
