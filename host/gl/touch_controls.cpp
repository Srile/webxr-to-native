#include "gl/touch_controls.h"
#include "core/json.h"
#include "core/log.h"
#include "gl/egl.h"
#include "img/decode.h"
#include "js/dom_input.h"
#include "net/assets.h"
#include <algorithm>
#include <cmath>
#include <vector>

namespace host {
namespace touch {
namespace {

enum Kind { kStick, kButton };
enum Anchor { kTL, kT, kTR, kL, kC, kR, kBL, kB, kBR };
struct Control {
  Kind kind = kButton; Anchor anchor = kBR; float x = 0, y = 0, size = 80;
  int axes[2] = {0, 1}; int button = 0; unsigned icon = 0;
  float cx = 0, cy = 0;          // laid-out centre, CSS px
  int finger = -1;               // the id that holds it, -1: none
  float dx = 0, dy = 0;          // a stick's deflection, -1..1 (+y down)
};
std::vector<Control> g_controls;
bool g_on = false, g_used = false, g_wanted = true; float g_opacity = 1, g_fade = 0; double g_lastMs = 0;  // fade: 0 hidden .. 1 shown  // used: a control was touched (the pad exists from then on)
float g_w = 0, g_h = 0, g_dpr = 1, g_inset[4] = {0, 0, 0, 0};

Anchor anchorOf(const std::string& s) {
  static const char* names[] = {"top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"};
  for (int i = 0; i < 9; ++i) if (s == names[i]) return (Anchor)i;
  return kBR;
}

// A finger is on a control within this much of its radius: forgiving, since a thumb lands where it expects one.
constexpr float kHitSlack = 1.3f;
Control* hit(float x, float y) {
  if (!g_wanted || g_fade <= 0) return nullptr;  // hidden or fading out: the finger is the page's
  Control* best = nullptr; float bestD = 1e9f;
  for (auto& c : g_controls) {
    if (c.finger >= 0) continue;
    const float d = std::hypot(x - c.cx, y - c.cy);
    if (d <= c.size * 0.5f * kHitSlack && d < bestD) { best = &c; bestD = d; }
  }
  return best;
}
// A zone's joystick: drawn only (the page owns the finger), its knob following the finger the page's zone took.
struct ZoneStick { Anchor anchor = kBL; float x = 32, y = 32, size = 140, knob = 60, range = 40, travel = 60, cx = 0, cy = 0; int finger = -1; float sx = 0, sy = 0, kx = 0, ky = 0; };
std::vector<ZoneStick> g_zsticks;
void releaseZoneSticks() { for (auto& z : g_zsticks) { z.finger = -1; z.kx = z.ky = 0; } }

Control* owner(int id) { for (auto& c : g_controls) if (c.finger == id) return &c; return nullptr; }
void deflect(Control& c, float x, float y) {
  if (c.kind != kStick) return;
  float dx = (x - c.cx) / (c.size * 0.5f), dy = (y - c.cy) / (c.size * 0.5f); const float m = std::hypot(dx, dy);
  if (m > 1) { dx /= m; dy /= m; }
  c.dx = dx; c.dy = dy;
}

// ---- drawing: each control is a few discs, one shader, premultiplied alpha over the frame ----
const char* kVs = R"(#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;   // centre x, y and half size, framebuffer pixels from the top left
uniform vec2 uWin;
out vec2 vLocal; out vec2 vUv;
void main() {
  vec2 p = uRect.xy + aPos * uRect.zw;
  vLocal = aPos * uRect.zw; vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5;
  gl_Position = vec4(p.x / uWin.x * 2.0 - 1.0, 1.0 - p.y / uWin.y * 2.0, 0.0, 1.0);
})";
const char* kFs = R"(#version 300 es
precision mediump float;
in vec2 vLocal; in vec2 vUv;
uniform float uRadius, uBorder; uniform vec4 uFill, uStroke; uniform int uIcon; uniform sampler2D uTex;
out vec4 o;
void main() {
  float d = length(vLocal) - uRadius;
  float inside = clamp(0.5 - d, 0.0, 1.0);
  float ring = uBorder > 0.0 ? clamp(0.5 - abs(d + uBorder * 0.5) + uBorder * 0.5, 0.0, 1.0) : 0.0;
  vec4 c = uFill * inside;
  if (uIcon == 1) { vec4 t = texture(uTex, vUv); c = t * uFill.a * inside; }
  c = c * (1.0 - uStroke.a * ring) + uStroke * ring;
  o = c;
})";
GLuint g_prog = 0, g_vbo = 0, g_vao = 0;
GLint u_rect, u_win, u_radius, u_border, u_fill, u_stroke, u_icon, u_tex;

GLuint compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type); glShaderSource(s, 1, &src, nullptr); glCompileShader(s);
  GLint ok = 0; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[512]; glGetShaderInfoLog(s, sizeof log, nullptr, log); HOST_LOGE("touch controls shader: %s", log); }
  return s;
}
bool ensureGl() {
  if (g_prog) return true;
  GLuint vs = compile(GL_VERTEX_SHADER, kVs), fs = compile(GL_FRAGMENT_SHADER, kFs);
  g_prog = glCreateProgram(); glAttachShader(g_prog, vs); glAttachShader(g_prog, fs); glLinkProgram(g_prog);
  glDeleteShader(vs); glDeleteShader(fs);
  GLint ok = 0; glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
  if (!ok) { HOST_LOGE("touch controls: program did not link"); glDeleteProgram(g_prog); g_prog = 0; g_on = false; return false; }
  u_rect = glGetUniformLocation(g_prog, "uRect"); u_win = glGetUniformLocation(g_prog, "uWin"); u_radius = glGetUniformLocation(g_prog, "uRadius");
  u_border = glGetUniformLocation(g_prog, "uBorder"); u_fill = glGetUniformLocation(g_prog, "uFill"); u_stroke = glGetUniformLocation(g_prog, "uStroke");
  u_icon = glGetUniformLocation(g_prog, "uIcon"); u_tex = glGetUniformLocation(g_prog, "uTex");
  static const float quad[8] = {-1, -1, 1, -1, -1, 1, 1, 1};
  glGenVertexArrays(1, &g_vao); glBindVertexArray(g_vao);
  glGenBuffers(1, &g_vbo); glBindBuffer(GL_ARRAY_BUFFER, g_vbo); glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
  return true;
}

// Everything the draw touches, put back as the page's WebGL wrapper cached it.
struct SavedGl {
  GLint prog = 0, vao = 0, abuf = 0, active = 0, tex = 0, sampler = 0, draw = 0, vp[4] = {};
  GLboolean blend, depth, cull, stencil, scissor, discard, mask[4], depthMask;
  GLint bSrcRgb, bDstRgb, bSrcA, bDstA, bEqRgb, bEqA;
  SavedGl() {
    glGetIntegerv(GL_CURRENT_PROGRAM, &prog); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao); glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &abuf);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active); glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &tex); glGetIntegerv(GL_SAMPLER_BINDING, &sampler);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw); glGetIntegerv(GL_VIEWPORT, vp);
    blend = glIsEnabled(GL_BLEND); depth = glIsEnabled(GL_DEPTH_TEST); cull = glIsEnabled(GL_CULL_FACE); stencil = glIsEnabled(GL_STENCIL_TEST);
    scissor = glIsEnabled(GL_SCISSOR_TEST); discard = glIsEnabled(GL_RASTERIZER_DISCARD); glGetBooleanv(GL_COLOR_WRITEMASK, mask); glGetBooleanv(GL_DEPTH_WRITEMASK, &depthMask);
    glGetIntegerv(GL_BLEND_SRC_RGB, &bSrcRgb); glGetIntegerv(GL_BLEND_DST_RGB, &bDstRgb); glGetIntegerv(GL_BLEND_SRC_ALPHA, &bSrcA); glGetIntegerv(GL_BLEND_DST_ALPHA, &bDstA);
    glGetIntegerv(GL_BLEND_EQUATION_RGB, &bEqRgb); glGetIntegerv(GL_BLEND_EQUATION_ALPHA, &bEqA);
  }
  ~SavedGl() {
    glUseProgram((GLuint)prog); glBindVertexArray((GLuint)vao); glBindBuffer(GL_ARRAY_BUFFER, (GLuint)abuf);
    glBindTexture(GL_TEXTURE_2D, (GLuint)tex); glBindSampler(0, (GLuint)sampler); glActiveTexture((GLenum)active);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)draw); glViewport(vp[0], vp[1], vp[2], vp[3]);
    auto set = [](GLenum cap, GLboolean on) { if (on) glEnable(cap); else glDisable(cap); };
    set(GL_BLEND, blend); set(GL_DEPTH_TEST, depth); set(GL_CULL_FACE, cull); set(GL_STENCIL_TEST, stencil); set(GL_SCISSOR_TEST, scissor); set(GL_RASTERIZER_DISCARD, discard);
    glColorMask(mask[0], mask[1], mask[2], mask[3]); glDepthMask(depthMask);
    glBlendFuncSeparate((GLenum)bSrcRgb, (GLenum)bDstRgb, (GLenum)bSrcA, (GLenum)bDstA); glBlendEquationSeparate((GLenum)bEqRgb, (GLenum)bEqA);
  }
};

// One disc: centre and radius in CSS px, premultiplied fill and stroke.
void disc(float cx, float cy, float r, const float fill[4], const float stroke[4], float border, unsigned icon = 0) {
  const float s = g_dpr, pad = 2, k = g_opacity * g_fade;
  glUniform4f(u_rect, cx * s, cy * s, r * s + pad, r * s + pad);
  glUniform1f(u_radius, r * s); glUniform1f(u_border, border * s);
  glUniform4f(u_fill, fill[0] * k, fill[1] * k, fill[2] * k, fill[3] * k);
  glUniform4f(u_stroke, stroke[0] * k, stroke[1] * k, stroke[2] * k, stroke[3] * k);
  glUniform1i(u_icon, icon ? 1 : 0);
  if (icon) glBindTexture(GL_TEXTURE_2D, icon);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}
void premul(float a, float out[4]) { out[0] = out[1] = out[2] = a; out[3] = a; }  // white at alpha a

unsigned loadIcon(const Assets& assets, const std::string& path) {
  std::string bytes; if (!assets.read("www/" + path, bytes) && !assets.read(path, bytes)) { HOST_LOGW("touch controls: icon %s not found", path.c_str()); return 0; }
  img::Image im = img::decode((const uint8_t*)bytes.data(), bytes.size());
  if (!im.ok()) { HOST_LOGW("touch controls: icon %s: %s", path.c_str(), im.error.c_str()); return 0; }
  std::vector<uint8_t> px(im.rgba.size());
  for (size_t i = 0; i < px.size(); i += 4) { const int a = im.rgba[i + 3]; for (int c = 0; c < 3; ++c) px[i + c] = (uint8_t)(im.rgba[i + c] * a / 255); px[i + 3] = (uint8_t)a; }
  GLint prev = 0, unpack = 0, align = 4; glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev); glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpack); glGetIntegerv(GL_UNPACK_ALIGNMENT, &align);
  glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0); glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  GLuint t = 0; glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, im.width, im.height);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, im.width, im.height, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glBindTexture(GL_TEXTURE_2D, (GLuint)prev); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)unpack); glPixelStorei(GL_UNPACK_ALIGNMENT, align);
  return t;
}

}  // namespace

bool configure(const Json& config, const Assets& assets, bool touchScreen) {
  const Json& tc = config.at("touchControls");
  g_controls.clear(); g_zsticks.clear(); g_on = false;
  if (tc.type != Json::Object || (!touchScreen && !tc.bo("desktop", false))) return false;
  g_opacity = (float)tc.n("opacity", 1);
  g_wanted = tc.s("showWhen", "").empty(); g_fade = g_wanted ? 1.f : 0.f;  // with showWhen, hidden until the page shows its own
  for (const Json& j : tc.at("controls").arr) {
    Control c; c.kind = j.s("type", "button") == "stick" ? kStick : kButton; c.anchor = anchorOf(j.s("anchor", "bottom-right"));
    c.x = (float)j.n("x", 24); c.y = (float)j.n("y", 24); c.size = std::max(24.f, (float)j.n("size", c.kind == kStick ? 150 : 88));
    const Json& ax = j.at("axes"); if (ax.arr.size() >= 2) { c.axes[0] = std::clamp((int)ax.arr[0].num, 0, 3); c.axes[1] = std::clamp((int)ax.arr[1].num, 0, 3); }
    c.button = std::clamp((int)j.n("button", 0), 0, 16);
    if (!j.s("icon", "").empty()) c.icon = loadIcon(assets, j.s("icon", ""));
    g_controls.push_back(c);
  }
  for (const Json& z : tc.at("zones").arr) {
    const Json& j = z.at("stick"); if (j.type != Json::Object) continue;
    ZoneStick s; s.anchor = anchorOf(j.s("anchor", "bottom-left")); s.x = (float)j.n("x", 32); s.y = (float)j.n("y", 32); s.size = (float)j.n("size", 140);
    s.knob = (float)j.n("knob", 60); s.range = std::max(1.f, (float)j.n("range", 40)); s.travel = (float)j.n("travel", 60);
    g_zsticks.push_back(s);
  }
  g_on = !g_controls.empty() || !g_zsticks.empty();
  if (!g_controls.empty()) HOST_LOGI("touch controls: %zu, shown as a standard gamepad", g_controls.size());
  if (!g_zsticks.empty()) HOST_LOGI("touch controls: %zu joystick(s) drawn for the page's own touch zones", g_zsticks.size());
  return g_on;
}

bool active() { return g_on; }
void setWanted(bool wanted) {
  if (g_wanted == wanted) return;
  g_wanted = wanted;
  if (!wanted) { cancelAll(); releaseZoneSticks(); }  // as the page drops held input when it hides its touch UI
}

void layout(float cssW, float cssH, float dpr, const float insets[4]) {
  g_w = cssW; g_h = cssH; g_dpr = dpr > 0 ? dpr : 1;
  for (int i = 0; i < 4; ++i) g_inset[i] = insets ? insets[i] : 0;
  const float l = g_inset[3], r = cssW - g_inset[1], t = g_inset[0], b = cssH - g_inset[2];
  auto place = [&](Anchor a, float x, float y, float size, float& cx, float& cy) {
    const float half = size * 0.5f; const int col = a % 3, row = a / 3;
    cx = col == 0 ? l + x + half : col == 2 ? r - x - half : (l + r) * 0.5f + x;
    cy = row == 0 ? t + y + half : row == 2 ? b - y - half : (t + b) * 0.5f + y;
  };
  for (auto& c : g_controls) place(c.anchor, c.x, c.y, c.size, c.cx, c.cy);
  for (auto& z : g_zsticks) place(z.anchor, z.x, z.y, z.size, z.cx, z.cy);
}

bool down(int id, float x, float y) {
  if (!g_on) return false;
  Control* c = hit(x, y); if (!c) return false;
  c->finger = id; deflect(*c, x, y); g_used = true;
  return true;
}
void stickFinger(int id, float x, float y) {
  for (auto& z : g_zsticks) if (z.finger < 0) { z.finger = id; z.sx = x; z.sy = y; z.kx = z.ky = 0; return; }
}
bool move(int id, float x, float y) {
  for (auto& z : g_zsticks) if (z.finger == id) {  // the page has this finger; only the knob follows it here
    float dx = (x - z.sx) / z.range, dy = (y - z.sy) / z.range; const float m = std::hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    z.kx = dx * z.travel; z.ky = dy * z.travel;
  }
  Control* c = g_on ? owner(id) : nullptr; if (!c) return false; deflect(*c, x, y); return true;
}
bool up(int id) { for (auto& z : g_zsticks) if (z.finger == id) { z.finger = -1; z.kx = z.ky = 0; }
  Control* c = g_on ? owner(id) : nullptr; if (!c) return false; c->finger = -1; c->dx = c->dy = 0; return true; }
void cancelAll() { for (auto& c : g_controls) { c.finger = -1; c.dx = c.dy = 0; } releaseZoneSticks(); }

void frame(double nowMs, bool shown, int fbW, int fbH) {
  if (!g_on) return;
  if (!shown) cancelAll();
  const double dt = g_lastMs > 0 ? std::min(0.1, (nowMs - g_lastMs) / 1000.0) : 0; g_lastMs = nowMs;
  g_fade = std::clamp(g_fade + (g_wanted ? 1.f : -1.f) * (float)dt * 5.f, 0.f, 1.f);
  // As in a browser, the pad shows up once it is first used: a page that sees a gamepad at load may switch its menus
  // to gamepad focus, which a player tapping them never asked for.
  dom::Pad pad; pad.connected = g_used && !g_controls.empty(); pad.timestamp = nowMs;
  for (auto& c : g_controls) {
    if (c.kind == kStick) { pad.axes[c.axes[0]] = c.dx; pad.axes[c.axes[1]] = c.dy; }
    else if (c.finger >= 0) pad.buttons[c.button] = 1;
  }
  dom::setPad(pad);
  if (!shown || fbW <= 0 || fbH <= 0 || g_fade <= 0) return;
  SavedGl saved;  // before ensureGl: creating the program binds a VAO and a buffer the page must not be left with
  if (!ensureGl()) return;
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); glViewport(0, 0, fbW, fbH);
  glDisable(GL_DEPTH_TEST); glDisable(GL_CULL_FACE); glDisable(GL_STENCIL_TEST); glDisable(GL_SCISSOR_TEST); glDisable(GL_RASTERIZER_DISCARD);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_FALSE); glDepthMask(GL_FALSE);
  glEnable(GL_BLEND); glBlendEquation(GL_FUNC_ADD); glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
  glUseProgram(g_prog); glBindVertexArray(g_vao); glActiveTexture(GL_TEXTURE0); glBindSampler(0, 0); glUniform1i(u_tex, 0);
  glUniform2f(u_win, (float)fbW, (float)fbH);
  float fill[4], stroke[4], none[4] = {0, 0, 0, 0};
  for (auto& z : g_zsticks) {  // as the page's HTML joystick looks in a browser (a typical one: base 10 %, rim 20 %, knob 35 % white)
    premul(0.10f, fill); premul(0.20f, stroke); disc(z.cx, z.cy, z.size * 0.5f, fill, stroke, 2);
    premul(0.35f, fill); disc(z.cx + z.kx, z.cy + z.ky, z.knob * 0.5f, fill, none, 0);
  }
  for (auto& c : g_controls) {
    const bool held = c.finger >= 0; const float r = c.size * 0.5f;
    if (c.kind == kStick) {
      premul(held ? 0.16f : 0.10f, fill); premul(held ? 0.45f : 0.28f, stroke); disc(c.cx, c.cy, r, fill, stroke, 2.5f);
      premul(held ? 0.55f : 0.35f, fill); disc(c.cx + c.dx * r * 0.6f, c.cy + c.dy * r * 0.6f, r * 0.4f, fill, none, 0);
    } else {
      premul(held ? 0.40f : 0.14f, fill); premul(held ? 0.6f : 0.3f, stroke); disc(c.cx, c.cy, r, fill, stroke, 2.5f);
      if (c.icon) { premul(held ? 1.f : 0.8f, fill); disc(c.cx, c.cy, r * 0.62f, fill, none, 0, c.icon); }
    }
  }
}

}  // namespace touch
}  // namespace host
