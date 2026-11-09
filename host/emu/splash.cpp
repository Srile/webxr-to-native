#include "emu/splash.h"
#include "core/log.h"
#include "gl/egl.h"
#include "img/decode.h"
#include "net/assets.h"
#include <algorithm>

namespace host {
namespace {
// The bindings and switches the splash touches, put back as the page's WebGL wrapper cached them.
struct SavedGl {
  GLint read = 0, draw = 0, pack = 0; GLboolean scissor = GL_FALSE; GLfloat clear[4] = {0, 0, 0, 0}; GLboolean mask[4] = {1, 1, 1, 1};
  SavedGl() {
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw); glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &pack);
    scissor = glIsEnabled(GL_SCISSOR_TEST); glGetFloatv(GL_COLOR_CLEAR_VALUE, clear); glGetBooleanv(GL_COLOR_WRITEMASK, mask);
  }
  ~SavedGl() {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)read); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)draw); glBindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)pack);
    if (scissor) glEnable(GL_SCISSOR_TEST); else glDisable(GL_SCISSOR_TEST);
    glClearColor(clear[0], clear[1], clear[2], clear[3]); glColorMask(mask[0], mask[1], mask[2], mask[3]);
  }
};
constexpr int kEvery = 6;     // frames between samples
constexpr int kSpread = 20;   // luma spread (0-255) along the sampled rows that counts as content
constexpr int kMaxRow = 4096; // pixels read per row at most
}  // namespace

bool Splash::load(const Assets& assets, const std::string& path) {
  std::string bytes; if (!assets.read(path, bytes)) return false;
  img::Image im = img::decode((const uint8_t*)bytes.data(), bytes.size());
  if (!im.ok()) { HOST_LOGW("splash %s: %s", path.c_str(), im.error.c_str()); return false; }
  // Premultiplied, its alpha kept, bottom-up rows for GL: over an opaque window it reads as over black (the Quest
  // shows it so); a window that composites alpha (visionOS glass) shows the image alone.
  std::vector<uint8_t> px((size_t)im.width * im.height * 4);
  for (int y = 0; y < im.height; ++y) for (int x = 0; x < im.width; ++x) {
    const uint8_t* s = &im.rgba[((size_t)y * im.width + x) * 4]; uint8_t* d = &px[((size_t)(im.height - 1 - y) * im.width + x) * 4];
    for (int c = 0; c < 3; ++c) d[c] = (uint8_t)(s[c] * s[3] / 255); d[3] = s[3];
  }
  GLint prevTex = 0, prevUnpack = 0, align = 4; glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTex); glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &prevUnpack); glGetIntegerv(GL_UNPACK_ALIGNMENT, &align);
  glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0); glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glGenTextures(1, &tex_); glBindTexture(GL_TEXTURE_2D, tex_);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, im.width, im.height);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, im.width, im.height, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
  glBindTexture(GL_TEXTURE_2D, (GLuint)prevTex); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)prevUnpack); glPixelStorei(GL_UNPACK_ALIGNMENT, align);
  SavedGl saved;
  glGenFramebuffers(1, &fbo_); glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo_); glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex_, 0);
  w_ = im.width; h_ = im.height;
  HOST_LOGI("splash %s %dx%d until the page draws", path.c_str(), w_, h_);
  return true;
}

void Splash::finish(const char* why) {
  if (done_) return;
  done_ = true;
  glDeleteFramebuffers(1, &fbo_); glDeleteTextures(1, &tex_);
  fbo_ = tex_ = 0;
  HOST_LOGI("splash off: %s", why);
}

// Two rows of the bound read framebuffer (a third and two thirds up): content once they are not one flat colour.
// Plain row reads, no scaled blit (a downscaling blit read back black under ANGLE in the iOS simulator).
void Splash::sample(int width, int height, double nowMs) {
  static GLubyte px[kMaxRow * 4];
  const int w = std::min(width, kMaxRow); int lo = 255, hi = 0;
  glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  GLint align = 4; glGetIntegerv(GL_PACK_ALIGNMENT, &align); glPixelStorei(GL_PACK_ALIGNMENT, 4);
  for (int row : {height / 3, height * 2 / 3}) {
    glReadPixels(0, row, w, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
    for (int i = 0; i < w; ++i) { const int l = (px[i * 4] * 54 + px[i * 4 + 1] * 183 + px[i * 4 + 2] * 19) >> 8; lo = std::min(lo, l); hi = std::max(hi, l); }
  }
  glPixelStorei(GL_PACK_ALIGNMENT, align);
  hits_ = hi - lo >= kSpread ? hits_ + 1 : 0;
  if (hits_ >= 2) finish("the page draws");
  else if (nowMs - startMs_ > kMaxMs) finish("timed out");
}

void Splash::sampleEye(unsigned tex, int width, int height, int arraySize, double nowMs) {
  if (!active() || !tex) return;
  if (startMs_ < 0) startMs_ = nowMs;
  if (frame_++ % kEvery) return;
  SavedGl saved; GLuint eye = 0; glGenFramebuffers(1, &eye);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, eye);
  if (arraySize > 1) glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, tex, 0, 0);
  else glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
  sample(arraySize > 1 ? width : width / 2, height, nowMs);  // the left eye
  glDeleteFramebuffers(1, &eye);
}

void Splash::sampleWindow(int width, int height, double nowMs) {
  if (!active() || width <= 0) return;
  if (startMs_ < 0) startMs_ = nowMs;
  if (frame_++ % kEvery) return;
  SavedGl saved;
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  sample(width, height, nowMs);
}

void Splash::draw(int winW, int winH) {
  if (!active() || winW <= 0 || winH <= 0) return;
  SavedGl saved;
  glDisable(GL_SCISSOR_TEST); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE); glClearColor(0, 0, 0, 0);  // transparent: a window that composites alpha (visionOS glass) shows only the image
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); glClear(GL_COLOR_BUFFER_BIT);
  const float s = std::min(winW * 0.6f / w_, winH * 0.8f / h_);  // large, as the Quest shows it
  const int dw = (int)(w_ * s), dh = (int)(h_ * s), x0 = (winW - dw) / 2, y0 = (winH - dh) / 2;
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo_);
  glBlitFramebuffer(0, 0, w_, h_, x0, y0, x0 + dw, y0 + dh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
}

}  // namespace host
