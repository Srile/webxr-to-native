#include "app/native_clear.h"
#include "core/log.h"
#include "gl/egl.h"
#include <cmath>
#include <cstring>

namespace host {

static const char* VS = R"(#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uMvp; void main(){ gl_Position = uMvp * vec4(aPos,1.0); })";
static const char* FS = R"(#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; })";

static uint32_t compile(uint32_t type, const char* src) {
  uint32_t s = glCreateShader(type); glShaderSource(s, 1, &src, nullptr); glCompileShader(s);
  int ok = 0; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[1024]; glGetShaderInfoLog(s, sizeof log, nullptr, log); HOST_LOGE("shader: %s", log); }
  return s;
}

bool NativeClear::init() {
  prog_ = glCreateProgram(); glAttachShader(prog_, compile(GL_VERTEX_SHADER, VS)); glAttachShader(prog_, compile(GL_FRAGMENT_SHADER, FS)); glLinkProgram(prog_);
  int ok = 0; glGetProgramiv(prog_, GL_LINK_STATUS, &ok); if (!ok) { HOST_LOGE("link failed"); return false; }
  uMvp_ = glGetUniformLocation(prog_, "uMvp"); uColor_ = glGetUniformLocation(prog_, "uColor");
  // 12 edges of a unit cube as lines
  const float h = 0.5f; const float v[8][3] = {{-h,-h,-h},{h,-h,-h},{h,h,-h},{-h,h,-h},{-h,-h,h},{h,-h,h},{h,h,h},{-h,h,h}};
  const int e[12][2] = {{0,1},{1,2},{2,3},{3,0},{4,5},{5,6},{6,7},{7,4},{0,4},{1,5},{2,6},{3,7}};
  float verts[24 * 3]; for (int i = 0; i < 12; ++i) for (int k = 0; k < 2; ++k) memcpy(&verts[(i * 2 + k) * 3], v[e[i][k]], 12);
  glGenVertexArrays(1, &vao_); glBindVertexArray(vao_); glGenBuffers(1, &vbo_); glBindBuffer(GL_ARRAY_BUFFER, vbo_);
  glBufferData(GL_ARRAY_BUFFER, sizeof verts, verts, GL_STATIC_DRAW); glEnableVertexAttribArray(0); glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 0, nullptr);
  glBindVertexArray(0); glGenFramebuffers(1, &fbo_);
  return true;
}

void xrProjection(float l, float r, float u, float d, float n, float f, float* m) {
  const float tl = tanf(l), tr = tanf(r), tu = tanf(u), td = tanf(d);
  const float w = tr - tl, h = tu - td;
  memset(m, 0, 64);
  m[0] = 2 / w; m[5] = 2 / h; m[8] = (tr + tl) / w; m[9] = (tu + td) / h; m[10] = -(f + n) / (f - n); m[11] = -1; m[14] = -(2 * f * n) / (f - n);
}

void poseToViewMatrix(const float* p, const float* q, float* m) {
  // inverse of translate(p) * rotate(q)
  const float x = q[0], y = q[1], z = q[2], w = q[3];
  float r[9] = {1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)};
  // r is column-major rotation; inverse = transpose
  m[0] = r[0]; m[1] = r[3]; m[2] = r[6]; m[3] = 0;
  m[4] = r[1]; m[5] = r[4]; m[6] = r[7]; m[7] = 0;
  m[8] = r[2]; m[9] = r[5]; m[10] = r[8]; m[11] = 0;
  m[12] = -(m[0] * p[0] + m[4] * p[1] + m[8] * p[2]); m[13] = -(m[1] * p[0] + m[5] * p[1] + m[9] * p[2]); m[14] = -(m[2] * p[0] + m[6] * p[1] + m[10] * p[2]); m[15] = 1;
}

static void mul(const float* a, const float* b, float* o) { for (int c = 0; c < 4; ++c) for (int r = 0; r < 4; ++r) { float s = 0; for (int k = 0; k < 4; ++k) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } }

void NativeClear::drawView(const float* view, const float* proj, int eye) {
  glClearColor(eye == 0 ? 0.2f : 0.8f, 0.4f, eye == 0 ? 0.8f : 0.2f, 1.f); glClearDepthf(1.f); glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  glEnable(GL_DEPTH_TEST); glUseProgram(prog_); glBindVertexArray(vao_);
  float model[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1.5f,-2.f,1}; float vm[16], mvp[16]; mul(view, model, vm); mul(proj, vm, mvp);
  glUniformMatrix4fv(uMvp_, 1, GL_FALSE, mvp); glUniform4f(uColor_, 1, 1, 1, 1); glLineWidth(3.f); glDrawArrays(GL_LINES, 0, 24);
  // floor cross at y=0 for the floor-height check
  float floorM[16] = {2,0,0,0, 0,0.001f,0,0, 0,0,2,0, 0,0,-2.f,1}; mul(view, floorM, vm); mul(proj, vm, mvp);
  glUniformMatrix4fv(uMvp_, 1, GL_FALSE, mvp); glUniform4f(uColor_, 1, 0.9f, 0.2f, 1); glDrawArrays(GL_LINES, 0, 24);
  glBindVertexArray(0);
}

void NativeClear::drawXr(const XrFrameInfo& f) {
  if (!f.colorTexture) return;
  glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
  if (depthW_ != f.width || depthH_ != f.height || depthLayers_ != f.arraySize) {
    if (depth_) glDeleteTextures(1, &depth_); glGenTextures(1, &depth_);
    if (f.arraySize > 1) { glBindTexture(GL_TEXTURE_2D_ARRAY, depth_); glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_DEPTH_COMPONENT24, f.width, f.height, f.arraySize); }
    else { glBindTexture(GL_TEXTURE_2D, depth_); glTexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH_COMPONENT24, f.width, f.height); }
    depthW_ = f.width; depthH_ = f.height; depthLayers_ = f.arraySize;
  }
  for (uint32_t eye = 0; eye < f.viewCount; ++eye) {
    if (f.arraySize > 1) { glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, f.colorTexture, 0, eye); glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, depth_, 0, eye); glViewport(0, 0, f.width, f.height); }
    else { glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f.colorTexture, 0); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth_, 0); glViewport(eye * f.width / 2, 0, f.width / 2, f.height); glEnable(GL_SCISSOR_TEST); glScissor(eye * f.width / 2, 0, f.width / 2, f.height); }
    if (eye == 0 && glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { HOST_LOGE("fbo incomplete 0x%x", glCheckFramebufferStatus(GL_FRAMEBUFFER)); }
    float view[16], proj[16]; const auto& v = f.views[eye];
    poseToViewMatrix(v.pos, v.quat, view); xrProjection(v.fovL, v.fovR, v.fovU, v.fovD, 0.1f, 100.f, proj);
    drawView(view, proj, (int)eye);
  }
  glDisable(GL_SCISSOR_TEST);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

void NativeClear::drawPanel(int w, int h, double t) {
  glBindFramebuffer(GL_FRAMEBUFFER, 0); glViewport(0, 0, w, h);
  float pos[3] = {0, 1.6f, 0}; float ang = (float)t * 0.5f; float quat[4] = {0, sinf(ang * 0.5f), 0, cosf(ang * 0.5f)}; float view[16], proj[16];
  poseToViewMatrix(pos, quat, view); float aspect = (float)w / (float)h; float fy = 0.6f; xrProjection(-atanf(tanf(fy) * aspect), atanf(tanf(fy) * aspect), fy, -fy, 0.1f, 100.f, proj);
  drawView(view, proj, 0);
}

void NativeClear::shutdown() { if (prog_) glDeleteProgram(prog_); if (vao_) glDeleteVertexArrays(1, &vao_); if (vbo_) glDeleteBuffers(1, &vbo_); if (fbo_) glDeleteFramebuffers(1, &fbo_); if (depth_) glDeleteTextures(1, &depth_); prog_ = vao_ = vbo_ = fbo_ = depth_ = 0; }

}  // namespace host
