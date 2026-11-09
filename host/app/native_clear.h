#pragma once
// WP-01 proof: draws a per-eye clear and a tracked wireframe cube into the
// swapchain image without any JS. Also the panel-mode smoke test.
#include <cstdint>
#include "xr/openxr_device.h"
namespace host {
class NativeClear {
 public:
  bool init();
  // Draw both eyes into the array texture (layer i per eye) or side by side.
  void drawXr(const XrFrameInfo& f);
  // Draw a single view into the currently bound framebuffer at w x h.
  void drawPanel(int w, int h, double tSec);
  void shutdown();
 private:
  void drawView(const float* viewMat, const float* projMat, int eye);
  uint32_t prog_ = 0, vao_ = 0, vbo_ = 0, fbo_ = 0, depth_ = 0; int depthW_ = 0, depthH_ = 0, depthLayers_ = 0;
  int uMvp_ = -1, uColor_ = -1;
};
void xrProjection(float l, float r, float u, float d, float n, float f, float* out16);
void poseToViewMatrix(const float* pos, const float* quat, float* out16);
}
