// The hosts without a headset (mac/, win/, ios/): OpenXrDevice (xr/openxr_device.h) over an emulated one
// instead of an OpenXR runtime. The page sees the same frame record it gets on the Quest: two views, a
// swapchain image to draw into, and two Touch controllers in the xr-standard layout. The platform's input
// drives them (emu.h: the hooks, and the desktop map); the left eye (or both, side by side) is blitted into
// the window at the end of each frame, and the window's vsync paces the loop where xrWaitFrame would.
#include "xr/openxr_device.h"
#include "emu/emu.h"
#include "gl/egl.h"
#include "core/log.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace host {
namespace {

Egl* g_egl = nullptr;
std::function<void(int, int)> g_overlay;
unsigned g_readFbo = 0;
uint32_t g_nextImage = 0;
double g_lastPresentMs = 0;

// Emulated wearer, in the stage (floor) space. LOCAL sits at the starting eye point, as on a Quest.
constexpr float kEyeHeight = 1.6f, kIpd = 0.063f, kHalfFovX = 0.785398f;  // 90° across each eye
struct Wearer {
  float pos[3] = {0, kEyeHeight, 0}; float yaw = 0, pitch = 0;
  int mouseHand = 1;            // the hand the mouse drives (Tab swaps): 1 right, 0 left
  bool stereo = false;          // show both eyes (V)
  bool focused = true;          // false: the system menu is up (O): VISIBLE, input withheld
} g_w;

double steadyMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

// --- small pose math (quaternions x, y, z, w) ---
void qmul(const float a[4], const float b[4], float o[4]) {
  float r[4] = {a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]};
  memcpy(o, r, sizeof r);
}
void qaxis(float x, float y, float z, float angle, float o[4]) { float s = sinf(angle / 2); o[0] = x * s; o[1] = y * s; o[2] = z * s; o[3] = cosf(angle / 2); }
void qrot(const float q[4], const float v[3], float o[3]) {  // q v q*
  float t[3] = {2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])};
  float r[3] = {v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]), v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]), v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0])};
  memcpy(o, r, sizeof r);
}
// The rotation that points -Z along `dir` with +Y as close to `up` as it gets.
void qlook(const float dir[3], const float up[3], float o[4]) {
  float z[3] = {-dir[0], -dir[1], -dir[2]}; float zl = sqrtf(z[0] * z[0] + z[1] * z[1] + z[2] * z[2]); for (float& c : z) c /= zl;
  float x[3] = {up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]};
  float xl = sqrtf(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]); if (xl < 1e-5f) { x[0] = 1; x[1] = x[2] = 0; xl = 1; } for (float& c : x) c /= xl;
  float y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
  float m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { float s = sqrtf(tr + 1) * 2; o[3] = s / 4; o[0] = (y[2] - z[1]) / s; o[1] = (z[0] - x[2]) / s; o[2] = (x[1] - y[0]) / s; }
  else if (m00 > m11 && m00 > m22) { float s = sqrtf(1 + m00 - m11 - m22) * 2; o[3] = (y[2] - z[1]) / s; o[0] = s / 4; o[1] = (y[0] + x[1]) / s; o[2] = (z[0] + x[2]) / s; }
  else if (m11 > m22) { float s = sqrtf(1 + m11 - m00 - m22) * 2; o[3] = (z[0] - x[2]) / s; o[0] = (y[0] + x[1]) / s; o[1] = s / 4; o[2] = (z[1] + y[2]) / s; }
  else { float s = sqrtf(1 + m22 - m00 - m11) * 2; o[3] = (x[1] - y[0]) / s; o[0] = (z[0] + x[2]) / s; o[1] = (z[1] + y[2]) / s; o[2] = s / 4; }
}
void headQuat(float q[4]) { float qy[4], qx[4]; qaxis(0, 1, 0, g_w.yaw, qy); qaxis(1, 0, 0, g_w.pitch, qx); qmul(qy, qx, q); }

void setButton(XrHandState& h, int i, bool down) { h.buttonValue[i] = down ? 1.f : 0.f; h.buttonPressed[i] = down; h.buttonTouched[i] = down; }

}  // namespace

void emu::setPresentOverlay(std::function<void(int, int)> draw) { g_overlay = std::move(draw); }
void emu::setConfig(const Json*) {}  // nothing of host.json's xr section applies to the emulated headset

// ---------------------------------------------------------------------------------------------------------
bool OpenXrDevice::createInstance(android_app*) {
  systemName_ = "Emulated headset (webxr-host desktop)";
  return true;
}

bool OpenXrDevice::createSession(Egl& egl) {
  g_egl = &egl;
  // The eye buffer follows the window (each eye shown alone fills it), capped so a Retina window stays cheap.
  int w = std::max(egl.windowWidth(), 640), h = std::max(egl.windowHeight(), 480);
  float s = std::min(1.f, 1600.f / (float)w); recW_ = (int)(w * s); recH_ = (int)(h * s);
  const float hz = emu::displayRate(); rate_ = hz > 0 ? hz : 60.f; rates_ = {rate_};
  // No lifecycle to wait for: the session runs and has focus from the start, as on a worn headset.
  running_ = true; state_ = XR_SESSION_STATE_FOCUSED;
  HOST_LOGI("xr (emulated): eye %dx%d, %.0f Hz (the display's vsync)", recW_, recH_, rate_);
  return true;
}

void OpenXrDevice::destroy() { destroySwapchain(); if (g_readFbo) { glDeleteFramebuffers(1, &g_readFbo); g_readFbo = 0; } running_ = false; }

bool OpenXrDevice::createSwapchain(const SwapchainDesc& d) {
  destroySwapchain();
  int w = d.width > 0 ? d.width : (int)(recW_ * (d.scale > 0 ? d.scale : 1.0)), h = d.height > 0 ? d.height : (int)(recH_ * (d.scale > 0 ? d.scale : 1.0));
  int layers = std::max(1, d.arraySize); if (layers == 1) w *= 2;  // side-by-side
  // sRGB formats would encode on write; the page already writes sRGB-encoded texels (SwapchainDesc::glFormat).
  GLenum fmt = d.glFormat == 0x8C43 /*GL_SRGB8_ALPHA8*/ ? GL_SRGB8_ALPHA8 : GL_RGBA8;
  GLint prev2D = 0, prevArr = 0; glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev2D); glGetIntegerv(GL_TEXTURE_BINDING_2D_ARRAY, &prevArr);
  // One image: the present below is a synchronous blit, so there is no compositor still reading the last one.
  // (Rotating three showed the page drawing into only the first it was given: two frames in three came out black.)
  for (int i = 0; i < 1; ++i) {
    GLuint t = 0; glGenTextures(1, &t);
    if (layers > 1) { glBindTexture(GL_TEXTURE_2D_ARRAY, t); glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, fmt, w, h, layers); }
    else { glBindTexture(GL_TEXTURE_2D, t); glTexStorage2D(GL_TEXTURE_2D, 1, fmt, w, h); }
    scImages_.push_back(t);
  }
  glBindTexture(GL_TEXTURE_2D, (GLuint)prev2D); glBindTexture(GL_TEXTURE_2D_ARRAY, (GLuint)prevArr);
  scW_ = w; scH_ = h; scArray_ = layers; swapchainSerial_++; g_nextImage = 0;
  HOST_LOGI("swapchain (emulated) #%u %dx%d x%d fmt 0x%x", swapchainSerial_, w, h, layers, fmt);
  return true;
}

void OpenXrDevice::destroySwapchain() {
  if (!scImages_.empty()) { glDeleteTextures((GLsizei)scImages_.size(), scImages_.data()); scImages_.clear(); }
}

bool OpenXrDevice::pollEvents() {
  if (emu::closeRequested()) exitRequested_ = true;
  if (exitRequested_) { running_ = false; return false; }
  return true;
}
void OpenXrDevice::requestExit() { exitRequested_ = true; emu::requestClose(); }

bool OpenXrDevice::requestRefreshRate(float hz) { return std::fabs(hz - rate_) < 0.5f; }  // the display's rate is the only one
bool OpenXrDevice::setFoveation(float) { return false; }
std::string OpenXrDevice::perfLine() { return "emulated"; }
std::string OpenXrDevice::profileLine() { return "emulated"; }

bool OpenXrDevice::beginFrame(XrFrameInfo& out, double loopNowMs) {
  if (!running_) return false;
  wakeMs_ = steadyMs();
  frameState_.predictedDisplayPeriod = (XrDuration)(1e9 / rate_);
  const double dt = g_lastPresentMs > 0 ? std::min(0.1, (wakeMs_ - g_lastPresentMs) / 1000.0) : 1.0 / rate_;

  // --- wearer controls ---
  emu::Controls c; emu::readControls(c);
  if (c.swapHand) { g_w.mouseHand ^= 1; HOST_LOGI("emu: the aimed hand is the %s controller", g_w.mouseHand ? "right" : "left"); }
  if (c.toggleStereo) g_w.stereo = !g_w.stereo;
  if (c.toggleSystemMenu) { g_w.focused = !g_w.focused; state_ = g_w.focused ? XR_SESSION_STATE_FOCUSED : XR_SESSION_STATE_VISIBLE; HOST_LOGI("emu: system menu %s", g_w.focused ? "closed" : "open"); }
  if (c.recenter) { g_w.pos[0] = 0; g_w.pos[1] = kEyeHeight; g_w.pos[2] = 0; g_w.yaw = g_w.pitch = 0; refChanged_ = true; }
  g_w.yaw += c.lookYaw; g_w.pitch = std::clamp(g_w.pitch + c.lookPitch, -1.5f, 1.5f);
  { const float r = c.walk[0], u = c.walk[1], f = c.walk[2];
    const float speed = (c.fast ? 3.f : 1.f) * (float)dt, sy = sinf(g_w.yaw), cyw = cosf(g_w.yaw);
    g_w.pos[0] += (-sy * f + cyw * r) * speed; g_w.pos[2] += (-cyw * f - sy * r) * speed; g_w.pos[1] = std::max(0.2f, g_w.pos[1] + u * speed); }

  // --- views: two eyes about the head, a symmetric frustum matching the window's shape ---
  float hq[4]; headQuat(hq);
  const float aspect = (float)recH_ / (float)std::max(1, recW_), halfY = atanf(tanf(kHalfFovX) * aspect);
  out.viewCount = 2;
  for (int i = 0; i < 2; ++i) {
    float off[3] = {(i == 0 ? -1.f : 1.f) * kIpd / 2, 0, 0}, wo[3]; qrot(hq, off, wo);
    XrViewInfo& v = out.views[i];
    for (int k = 0; k < 3; ++k) v.pos[k] = g_w.pos[k] + wo[k];
    memcpy(v.quat, hq, sizeof hq);
    v.fovL = -kHalfFovX; v.fovR = kHalfFovX; v.fovU = halfY; v.fovD = -halfY;
  }
  out.localInBasePos[0] = 0; out.localInBasePos[1] = kEyeHeight; out.localInBasePos[2] = 0;
  out.localInBaseQuat[0] = out.localInBaseQuat[1] = out.localInBaseQuat[2] = 0; out.localInBaseQuat[3] = 1;

  // --- controllers ---
  // The aimed hand points through the cursor (or the touch): its ray starts low and to the side of the shown
  // eye and passes through the point 3 m out along the cursor's line of sight, so what the cursor covers is
  // what the ray hits at that depth. Without a cursor it points where the head does. The other hand rests low
  // and forward, pointing where the head does.
  out.input = XrInputState{};
  const XrViewInfo& eye = out.views[0];
  float nx = c.hasAim ? c.aimX : 0.5f, ny = c.hasAim ? c.aimY : 0.5f;
  if (g_w.stereo) nx = std::fmod(nx * 2, 1.f);  // each half of the window is one eye
  const float tx = (nx * 2 - 1) * tanf(kHalfFovX), ty = (1 - ny * 2) * tanf(halfY);
  float local[3] = {tx, ty, -1}, dirW[3]; qrot(hq, local, dirW);
  const float up[3] = {0, 1, 0};
  for (int h = 0; h < 2; ++h) {
    XrHandState& hs = out.input.hand[h]; hs.active = true;
    const float side = h == 1 ? 1.f : -1.f;
    float pos[3], q[4];
    if (h == g_w.mouseHand) {
      float rest[3] = {side * 0.16f, -0.26f, -0.3f}, ro[3]; qrot(hq, rest, ro);
      for (int k = 0; k < 3; ++k) pos[k] = eye.pos[k] + ro[k];
      float target[3], d[3]; for (int k = 0; k < 3; ++k) { target[k] = eye.pos[k] + dirW[k] * 3.f; d[k] = target[k] - pos[k]; }
      float headUp[3]; qrot(hq, up, headUp); qlook(d, headUp, q);
    } else {
      float rest[3] = {side * 0.2f, -0.4f, -0.35f}, ro[3]; qrot(hq, rest, ro);
      for (int k = 0; k < 3; ++k) pos[k] = g_w.pos[k] + ro[k];
      float down[4], tilt[4]; qaxis(1, 0, 0, -0.35f, down); qmul(hq, down, tilt); memcpy(q, tilt, sizeof tilt);
    }
    for (XrPoseF* p : {&hs.grip, &hs.aim}) { memcpy(p->pos, pos, sizeof pos); memcpy(p->quat, q, sizeof q); p->valid = true; }
  }
  if (g_w.focused) {
    XrHandState& m = out.input.hand[g_w.mouseHand]; XrHandState& o = out.input.hand[g_w.mouseHand ^ 1];
    setButton(m, 0, c.trigger); setButton(m, 1, c.squeeze); setButton(m, 3, c.stickClick); setButton(m, 4, c.a); setButton(m, 5, c.b);
    m.axes[2] = c.stick[0]; m.axes[3] = c.stick[1];  // xr-standard: +y is down
    if (m.axes[2] != 0 || m.axes[3] != 0) m.buttonTouched[3] = 1;
    setButton(o, 0, c.otherTrigger); setButton(o, 1, c.otherSqueeze);
    setButton(out.input.hand[0], 7, c.menu);  // menu (left controller)
  }

  // --- the image to draw into ---
  out.displayTime = (XrTime)(wakeMs_ * 1e6); out.displayTimeMs = loopNowMs + 1000.0 / rate_;
  out.shouldRender = !scImages_.empty();
  out.width = scW_; out.height = scH_; out.arraySize = scArray_;
  out.colorTexture = 0;
  if (out.shouldRender) { out.imageIndex = g_nextImage; out.colorTexture = scImages_[g_nextImage]; g_nextImage = (g_nextImage + 1) % scImages_.size(); }
  return true;
}

// Present: the shown eye(s) into the window, letterboxed to keep their shape. The page's GL state (as the
// WebGL wrapper caches it) is put back afterwards: framebuffer bindings, scissor, clear colour, colour mask.
void OpenXrDevice::endFrame(const XrFrameInfo& f, bool submit) {
  if (submit && f.colorTexture && g_egl && g_egl->windowWidth() > 0) {
    GLint prevRead = 0, prevDraw = 0; glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST); GLfloat cc[4]; glGetFloatv(GL_COLOR_CLEAR_VALUE, cc); GLboolean mask[4]; glGetBooleanv(GL_COLOR_WRITEMASK, mask);
    if (!g_readFbo) glGenFramebuffers(1, &g_readFbo);
    glDisable(GL_SCISSOR_TEST); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE); glClearColor(0, 0, 0, 1);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, g_readFbo);
    const int W = g_egl->windowWidth(), H = g_egl->windowHeight(), eyeW = f.arraySize > 1 ? f.width : f.width / 2, eyeH = f.height;
    const int shown = g_w.stereo ? 2 : 1, slotW = W / shown;
    const float s = std::min((float)slotW / eyeW, (float)H / eyeH); const int dw = (int)(eyeW * s), dh = (int)(eyeH * s);
    for (int e = 0; e < shown; ++e) {
      int sx = 0;
      if (f.arraySize > 1) glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f.colorTexture, 0, e);
      else { glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f.colorTexture, 0); sx = e * eyeW; }
      const int x0 = e * slotW + (slotW - dw) / 2, y0 = (H - dh) / 2;
      glBlitFramebuffer(sx, 0, sx + eyeW, eyeH, x0, y0, x0 + dw, y0 + dh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    }
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    if (scissor) glEnable(GL_SCISSOR_TEST);
    glClearColor(cc[0], cc[1], cc[2], cc[3]); glColorMask(mask[0], mask[1], mask[2], mask[3]);
  }
  if (g_overlay && g_egl) g_overlay(g_egl->windowWidth(), g_egl->windowHeight());
  if (g_egl) g_egl->swap();  // blocks on vsync: the emulated xrWaitFrame
  g_lastPresentMs = steadyMs();
}

// --- the parts of a Quest the desktop has no counterpart for ---
void XrInput::vibrate(int, float, float, float) {}
void XrScene::setPassthroughVisible(bool visible) { ptVisible_ = visible; }
bool XrScene::requery() { return false; }
bool XrScene::requestCapture() { return false; }
const char* xrResultName(XrInstance, XrResult) { return "emulated"; }

}  // namespace host
