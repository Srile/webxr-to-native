// WP-04: the WebGL2 binding over GLES 3.2 — __native.gl.
//
// The boring 80 % (one GL call per entry point) is generated from
// webgl_table.py into webgl_bind.gen.cpp; this file holds the awkward 20 %:
// everything with an overload set (bufferData, texImage2D, compressedTex*,
// readPixels), everything that returns a structured value (getParameter,
// getActiveUniform, getUniform, …), the GLsync handle table, the multi-draw
// loops, and installWebGL, which resolves extension entry points once and
// hands the lot to JS. Argument conventions: GL names and enums are
// numbers, typed arrays go by backing-store pointer and WebGL2's element
// offsets are honoured here, a wrong type is a TypeError, a GL error is never
// an exception (getError carries it, like a browser). The JS side
// (runtime/src/webgl/) owns object identity, the enum constants, extension
// objects, pixelStorei emulation and the gl_DrawID rewrite.
#include "gl/webgl_bind.h"
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif
#include "gl/egl.h"
#include "js/natives.h"
#include "js/bind.h"
#include "core/log.h"
#include <bit>
#include <cstring>
#include <string>
#include <vector>
#include "gl/gl_proxy.h"  // last: GL calls below run on the GL thread when the queue is on


namespace host {
namespace wgl {
std::atomic<uint64_t> drawCalls{0};
uint32_t g_xrImage = 0;
// Where the page attached kXrImage: (framebuffer, attachment) and how (kind 0 = 2D (a = textarget, b = level),
// 1 = layer (a = level, b = layer), 2 = multiview (a = level, b = base, c = n), 3 = multisampled multiview
// (a = level, b = samples, c = base, d = n), 4 = multisampled 2D, an antialiased XRWebGLLayer (a = textarget,
// b = level, c = samples)).
struct XrAttach { GLuint fbo; GLenum target, attachment; int kind; GLint a, b, c, d; };
static std::vector<XrAttach> g_xrAttach;
void noteXrAttach(GLenum target, GLenum attachment, int kind, GLint a, GLint b, GLint c, GLint d) {
  GLint fbo = 0; glGetIntegerv(target == GL_READ_FRAMEBUFFER ? GL_READ_FRAMEBUFFER_BINDING : GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
  for (auto& x : g_xrAttach) if (x.fbo == (GLuint)fbo && x.attachment == attachment) { x = {(GLuint)fbo, target, attachment, kind, a, b, c, d}; return; }
  g_xrAttach.push_back({(GLuint)fbo, target, attachment, kind, a, b, c, d});
}
void xrImageAcquired(GLuint image) {
  if (image == g_xrImage) return;
  g_xrImage = image;
  if (g_xrAttach.empty()) return;
  GLint draw = 0; glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
  size_t keep = 0;
  for (auto& x : g_xrAttach) {
    if (!glIsFramebuffer(x.fbo)) continue;  // deleted since
    g_xrAttach[keep++] = x;
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, x.fbo);
    switch (x.kind) {
      case 0: glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, x.attachment, (GLenum)x.a, image, x.b); break;
      case 1: glFramebufferTextureLayer(GL_DRAW_FRAMEBUFFER, x.attachment, image, x.a, x.b); break;
      case 2: if (ext.framebufferTextureMultiviewOVR) ext.framebufferTextureMultiviewOVR(GL_DRAW_FRAMEBUFFER, x.attachment, image, x.a, x.b, x.c); break;
      case 3: if (ext.framebufferTextureMultisampleMultiviewOVR) ext.framebufferTextureMultisampleMultiviewOVR(GL_DRAW_FRAMEBUFFER, x.attachment, image, x.a, x.b, x.c, x.d); break;
      case 4: if (ext.framebufferTexture2DMultisampleEXT) ext.framebufferTexture2DMultisampleEXT(GL_DRAW_FRAMEBUFFER, x.attachment, (GLenum)x.a, image, x.b, x.c); break;
    }
  }
  g_xrAttach.resize(keep);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)draw);
}
PixelStore g_pixelStore;

ExtFns ext;
GLenum g_synthError = GL_NO_ERROR;

// ---- GLsync handle table -----------------------------------------------------
static std::vector<GLsync> g_syncs;        // handle - 1 → sync (nullptr = free)
static std::vector<uint32_t> g_syncFree;

GLsync syncGet(uint32_t h) { return (h && h <= g_syncs.size()) ? g_syncs[h - 1] : nullptr; }
uint32_t syncAdd(GLsync s) {
  if (!s) return 0;
  if (!g_syncFree.empty()) { uint32_t h = g_syncFree.back(); g_syncFree.pop_back(); g_syncs[h - 1] = s; return h; }
  g_syncs.push_back(s); return (uint32_t)g_syncs.size();
}
void syncRemove(uint32_t h) {
  if (h && h <= g_syncs.size() && g_syncs[h - 1]) { g_syncs[h - 1] = nullptr; g_syncFree.push_back(h); }
}

}  // namespace wgl

namespace {
using wgl::Args; using wgl::View;

std::string g_glExtensions;
bool hasGLExt(const char* name) {
  size_t n = strlen(name); size_t pos = 0;
  while ((pos = g_glExtensions.find(name, pos)) != std::string::npos) {
    bool startOk = pos == 0 || g_glExtensions[pos - 1] == ' ';
    bool endOk = pos + n == g_glExtensions.size() || g_glExtensions[pos + n] == ' ';
    if (startOk && endOk) return true; pos += n;
  }
  return false;
}

// ---- small V8 helpers ---------------------------------------------------------
v8::Local<v8::String> jsStr(v8::Isolate* iso, const char* s, int len = -1) {
  if (!s) s = "";
  return v8::String::NewFromUtf8(iso, s, v8::NewStringType::kNormal, len).ToLocalChecked();
}
template <typename TA, typename T>
v8::Local<v8::Value> typedArray(v8::Isolate* iso, const T* src, size_t n) {
  v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(iso, n * sizeof(T));
  if (n) memcpy(ab->GetBackingStore()->Data(), src, n * sizeof(T));
  return TA::New(ab, 0, n);
}
v8::Local<v8::Value> boolArray(v8::Isolate* iso, const GLboolean* v, int n) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso, n);
  for (int i = 0; i < n; i++) arr->Set(ctx, i, v8::Boolean::New(iso, v[i] != GL_FALSE)).Check();
  return arr;
}
v8::Local<v8::Value> intArray(v8::Isolate* iso, const GLint* v, int n) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso, n);
  for (int i = 0; i < n; i++) arr->Set(ctx, i, v8::Integer::New(iso, v[i])).Check();
  return arr;
}
v8::Local<v8::Value> uintArray(v8::Isolate* iso, const GLuint* v, int n) {
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso, n);
  for (int i = 0; i < n; i++) arr->Set(ctx, i, v8::Integer::NewFromUnsigned(iso, v[i])).Check();
  return arr;
}
// Reads a JS array of strings (allocates; never on a frame path).
bool readStrings(const Args& a, int i, std::vector<std::string>& out) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (i >= a.Length() || !a[i]->IsArray()) { wgl::typeError(iso, "WebGL: expected a sequence of strings"); return false; }
  v8::Local<v8::Array> arr = a[i].As<v8::Array>();
  for (uint32_t k = 0; k < arr->Length(); k++) {
    v8::Local<v8::Value> e; if (!arr->Get(ctx, k).ToLocal(&e)) return false;
    v8::String::Utf8Value s(iso, e); out.emplace_back(*s ? *s : "", s.length());
  }
  return true;
}
// {size, type, name} for getActiveUniform / getActiveAttrib / getTransformFeedbackVarying.
void retActiveInfo(const Args& a, GLint size, GLenum type, const char* name, int len) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "size", size); bind::setNum(ctx, o, "type", type);
  bind::set(ctx, o, "name", jsStr(iso, name, len));
  a.GetReturnValue().Set(o);
}
// Bytes GL reads (unpack) or writes (pack) through a client pointer for a w*h*d image of
// (format, type) under the current UNPACK_* / PACK_* state (GLES 3.0 §3.7.1 / §4.3.1). false =
// a format/type pair with no client layout. The pointer-taking calls check the view against it:
// GL itself has no idea of the view's size and would read or write past it.
bool imageBytes(bool pack, GLint w, GLint h, GLint d, GLenum fmt, GLenum type, size_t& out) {
  out = 0;
  size_t comps;
  switch (fmt) {
    case GL_RGBA: case GL_RGBA_INTEGER: comps = 4; break;
    case GL_RGB: case GL_RGB_INTEGER: comps = 3; break;
    case GL_RG: case GL_RG_INTEGER: case GL_LUMINANCE_ALPHA: case GL_DEPTH_STENCIL: comps = 2; break;
    case GL_RED: case GL_RED_INTEGER: case GL_ALPHA: case GL_LUMINANCE: case GL_DEPTH_COMPONENT: case GL_STENCIL_INDEX8: comps = 1; break;
    default: return false;
  }
  size_t bpp;
  switch (type) {
    case GL_UNSIGNED_BYTE: case GL_BYTE: bpp = comps; break;
    case GL_UNSIGNED_SHORT: case GL_SHORT: case GL_HALF_FLOAT: case GL_HALF_FLOAT_OES: bpp = comps * 2; break;
    case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: bpp = comps * 4; break;
    case GL_UNSIGNED_SHORT_5_6_5: case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_5_5_5_1: bpp = 2; break;
    case GL_UNSIGNED_INT_2_10_10_10_REV: case GL_UNSIGNED_INT_10F_11F_11F_REV: case GL_UNSIGNED_INT_5_9_9_9_REV: case GL_UNSIGNED_INT_24_8: bpp = 4; break;
    case GL_FLOAT_32_UNSIGNED_INT_24_8_REV: bpp = 8; break;
    default: return false;
  }
  if (w <= 0 || h <= 0 || d <= 0) return true;
  GLint align = 4, rowLen = 0, skipPx = 0, skipRows = 0, imgH = 0, skipImg = 0;
  if (glq::active()) {  // the shadow pixelStorei keeps (webgl_bind.h): no round trip to the GL thread per upload
    const wgl::PixelStore& s = wgl::g_pixelStore;
    align = pack ? s.packAlignment : s.unpackAlignment; rowLen = pack ? s.packRowLength : s.unpackRowLength;
    skipPx = pack ? s.packSkipPixels : s.unpackSkipPixels; skipRows = pack ? s.packSkipRows : s.unpackSkipRows;
    if (!pack && d > 1) { imgH = s.unpackImageHeight; skipImg = s.unpackSkipImages; }
  } else {
  glGetIntegerv(pack ? GL_PACK_ALIGNMENT : GL_UNPACK_ALIGNMENT, &align);
  glGetIntegerv(pack ? GL_PACK_ROW_LENGTH : GL_UNPACK_ROW_LENGTH, &rowLen);
  glGetIntegerv(pack ? GL_PACK_SKIP_PIXELS : GL_UNPACK_SKIP_PIXELS, &skipPx);
  glGetIntegerv(pack ? GL_PACK_SKIP_ROWS : GL_UNPACK_SKIP_ROWS, &skipRows);
  if (!pack && d > 1) { glGetIntegerv(GL_UNPACK_IMAGE_HEIGHT, &imgH); glGetIntegerv(GL_UNPACK_SKIP_IMAGES, &skipImg); }
  }
  if (align <= 0) align = 1;
  size_t row = (size_t)(rowLen > 0 ? rowLen : w) * bpp;
  size_t stride = (row + (size_t)align - 1) / (size_t)align * (size_t)align;
  size_t image = stride * (size_t)(imgH > 0 ? imgH : h);
  out = (size_t)(skipImg + d - 1) * image + (size_t)(skipRows + h - 1) * stride + (size_t)(skipPx + w) * bpp;
  return true;
}
// The client pointer for a pixel upload / readback, or false (error raised) when the view cannot hold the image.
bool imageFits(const View& v, bool pack, GLint w, GLint h, GLint d, GLenum fmt, GLenum type) {
  size_t need = 0;
  if (!imageBytes(pack, w, h, d, fmt, type, need)) return true;  // unknown pair: GL raises INVALID_ENUM itself and touches no memory
  if (v.len < need || (need && !v.data)) { wgl::synthError(GL_INVALID_OPERATION); return false; }
  return true;
}
// A "pixels | pboOffset | null" argument: a number is a PBO offset.
struct PixelSrc { const void* ptr = nullptr; bool ok = true; };
bool pixelArg(const Args& a, int i, int offIdx, GLint w, GLint h, GLint d, GLenum fmt, GLenum type, PixelSrc& out) {
  if (i < a.Length() && a[i]->IsNumber()) { out.ptr = (const void*)(intptr_t)wgl::toI64(a[i].As<v8::Number>()->Value()); return true; }
  View v; if (!wgl::argView(a, i, v, true)) return false;
  if (v.isNull) { out.ptr = nullptr; return true; }
  if (offIdx >= 0 && !wgl::window(a, v, offIdx, -1)) return false;
  if (!imageFits(v, false, w, h, d, fmt, type)) return false;  // short source: INVALID_OPERATION, never a read past the view
  out.ptr = v.data; return true;
}
// A "data | imageSize" compressed argument: (ptr, size) from a view with srcOffset/srcLengthOverride, or a PBO offset + size.
bool compressedArg(const Args& a, int i, const void*& ptr, GLsizei& size) {
  if (i < a.Length() && a[i]->IsNumber()) {
    double sz = 0, off = 0; if (!wgl::argNum(a, i, sz) || !wgl::argNum(a, i + 1, off)) return false;
    size = (GLsizei)sz; ptr = (const void*)(intptr_t)wgl::toI64(off); return true;
  }
  View v; if (!wgl::argView(a, i, v)) return false; if (!wgl::window(a, v, i + 1, i + 2)) return false;
  ptr = v.data; size = (GLsizei)v.len; return true;
}

#define ARG_U32(i, n) GLuint n; if (!wgl::argU32(a, i, n)) return
#define ARG_I32(i, n) GLint n; if (!wgl::argI32(a, i, n)) return
#define ARG_I64(i, n) int64_t n; if (!wgl::argI64(a, i, n)) return
#define ARG_NUM(i, n) double n; if (!wgl::argNum(a, i, n)) return

// ---- strings -----------------------------------------------------------------
void f_extensions(const Args& a) { a.GetReturnValue().Set(jsStr(a.GetIsolate(), g_glExtensions.c_str())); }
void f_getString(const Args& a) {
  ARG_U32(0, name);
  const GLubyte* s = glGetString(name);
  if (!s) a.GetReturnValue().SetNull(); else a.GetReturnValue().Set(jsStr(a.GetIsolate(), (const char*)s));
}

// ---- getParameter and friends -----------------------------------------------------
void f_getParameter(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, p);
  switch (wgl::paramKind(p)) {
    case wgl::ParamKind::Bool: { GLboolean b = 0; glGetBooleanv(p, &b); wgl::retB(a, b != GL_FALSE); return; }
    case wgl::ParamKind::Int: { GLint i = 0; glGetIntegerv(p, &i); wgl::retI(a, i); return; }
    case wgl::ParamKind::Uint: { GLint i = 0; glGetIntegerv(p, &i); wgl::retU(a, (uint32_t)i); return; }
    case wgl::ParamKind::Float: { GLfloat f = 0; glGetFloatv(p, &f); wgl::ret(a, f); return; }
    case wgl::ParamKind::Int2: { GLint v[2] = {0, 0}; glGetIntegerv(p, v); a.GetReturnValue().Set(typedArray<v8::Int32Array>(iso, v, 2)); return; }
    case wgl::ParamKind::Int4: { GLint v[4] = {0, 0, 0, 0}; glGetIntegerv(p, v); a.GetReturnValue().Set(typedArray<v8::Int32Array>(iso, v, 4)); return; }
    case wgl::ParamKind::Float2: { GLfloat v[2] = {0, 0}; glGetFloatv(p, v); a.GetReturnValue().Set(typedArray<v8::Float32Array>(iso, v, 2)); return; }
    case wgl::ParamKind::Float4: { GLfloat v[4] = {0, 0, 0, 0}; glGetFloatv(p, v); a.GetReturnValue().Set(typedArray<v8::Float32Array>(iso, v, 4)); return; }
    case wgl::ParamKind::Bool4: { GLboolean v[4] = {0, 0, 0, 0}; glGetBooleanv(p, v); a.GetReturnValue().Set(boolArray(iso, v, 4)); return; }
    case wgl::ParamKind::String: { const GLubyte* s = glGetString(p); if (s) a.GetReturnValue().Set(jsStr(iso, (const char*)s)); else a.GetReturnValue().SetNull(); return; }
    case wgl::ParamKind::Int64: { GLint64 v = 0; glGetInteger64v(p, &v); wgl::ret(a, (double)v); return; }
    case wgl::ParamKind::CompressedFormats: {
      GLint n = 0; glGetIntegerv(GL_NUM_COMPRESSED_TEXTURE_FORMATS, &n); if (n < 0) n = 0;
      std::vector<GLint> v((size_t)n + 1); if (n) glGetIntegerv(GL_COMPRESSED_TEXTURE_FORMATS, v.data());
      a.GetReturnValue().Set(typedArray<v8::Uint32Array>(iso, (const GLuint*)v.data(), (size_t)n)); return;
    }
    case wgl::ParamKind::Unknown: default: {
      // Not in the table: read one GLint, and answer null for an enum the driver refuses
      // (the read consumes a pending GL error too; log so a lost error can be traced).
      GLint i = 0; glGetIntegerv(p, &i); GLenum err = glGetError();
      if (err == GL_INVALID_ENUM) { HOST_LOGW("getParameter(0x%x): INVALID_ENUM, not in webgl_table.PARAMS", p); a.GetReturnValue().SetNull(); return; }
      if (err != GL_NO_ERROR) HOST_LOGW("getParameter(0x%x): swallowed GL error 0x%x", p, err);
      wgl::retI(a, i); return;
    }
  }
}

void f_getIndexedParameter(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, target); ARG_U32(1, index);
  switch (target) {
    case GL_TRANSFORM_FEEDBACK_BUFFER_START: case GL_TRANSFORM_FEEDBACK_BUFFER_SIZE:
    case GL_UNIFORM_BUFFER_START: case GL_UNIFORM_BUFFER_SIZE: { GLint64 v = 0; glGetInteger64i_v(target, index, &v); wgl::ret(a, (double)v); return; }
    case GL_COLOR_WRITEMASK: { GLboolean v[4] = {0, 0, 0, 0}; glGetBooleani_v(target, index, v); a.GetReturnValue().Set(boolArray(iso, v, 4)); return; }
    case GL_BLEND: { wgl::retB(a, glIsEnabledi(target, index) != GL_FALSE); return; }
    default: { GLint v = 0; glGetIntegeri_v(target, index, &v); wgl::retI(a, v); return; }
  }
}

void f_getInternalformatParameter(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, target); ARG_U32(1, ifmt); ARG_U32(2, pname);
  if (pname != GL_SAMPLES) { a.GetReturnValue().SetNull(); return; }
  GLint n = 0; glGetInternalformativ(target, ifmt, GL_NUM_SAMPLE_COUNTS, 1, &n); if (n < 0) n = 0;
  std::vector<GLint> v((size_t)n + 1); if (n) glGetInternalformativ(target, ifmt, GL_SAMPLES, n, v.data());
  a.GetReturnValue().Set(typedArray<v8::Int32Array>(iso, v.data(), (size_t)n));
}

// ---- buffers -----------------------------------------------------------------
// bufferData(target, size | data | null, usage, srcOffset = 0, length = 0)
// ---- queued uploads (gl_queue.h) --------------------------------------------------
// The per-frame data calls record a command with the bytes GL will read copied into the ring, so the page goes on
// while the GL thread uploads. Past kQueueInlineMax (a texture at boot, a big buffer) the call runs synchronously
// instead, zero-copy: the page waits for the GL thread, which reads the page's memory directly.
enum : uint32_t { kOpBufferData = glq::kFirstHand, kOpBufferSubData, kOpTexImage2D, kOpTexSubImage2D, kOpTexImage3D, kOpTexSubImage3D,
                  kOpDrawBuffers, kOpInvalidate, kOpInvalidateSub, kOpSaveFb, kOpRestoreFb, kOpMultiDraw, kOpClearFrame };
constexpr size_t kQueueInlineMax = 1u << 20;
inline bool queueing() { return glq::active() && !glq::onGLThread(); }
// [op, head..., payload bytes rounded up to words]; head[0..] are the caller's words.
template <size_t H> void queueData(uint32_t op, const uint32_t (&head)[H], const void* src, size_t bytes) {
  const uint32_t sz = (uint32_t)(1 + H + (bytes + 3) / 4);
  const uint32_t pos = glq::reserve(sz); uint32_t* d = glq::data() + pos;
  d[0] = op; for (size_t i = 0; i < H; ++i) d[1 + i] = head[i];
  if (bytes) memcpy(d + 1 + H, src, bytes);
  glq::commit(pos + sz);
}
// A pixel source as recorded: 0 = null, 1 = inline bytes, 2 = a PBO offset (no bytes).
uint32_t h_bufferData(const uint32_t* c) {  // [op, target, usage, size, hasData, bytes...]
  glBufferData(c[1], (GLsizeiptr)c[3], c[4] ? (const void*)(c + 5) : nullptr, c[2]);
  return 5 + (c[4] ? (c[3] + 3) / 4 : 0);
}
uint32_t h_bufferSubData(const uint32_t* c) {  // [op, target, offset, size, bytes...]
  glBufferSubData(c[1], (GLintptr)c[2], (GLsizeiptr)c[3], c + 4);
  return 4 + (c[3] + 3) / 4;
}
inline const void* pixelPtr(const uint32_t* c, uint32_t kindIdx, uint32_t dataIdx) {
  return c[kindIdx] == 1 ? (const void*)(c + dataIdx) : c[kindIdx] == 2 ? (const void*)(uintptr_t)c[kindIdx + 1] : nullptr;
}
inline uint32_t pixelWords(const uint32_t* c, uint32_t kindIdx) { return c[kindIdx] == 1 ? (c[kindIdx + 1] + 3) / 4 : 0; }
uint32_t h_texImage2D(const uint32_t* c) {  // [op, target, level, ifmt, w, h, border, fmt, type, kind, bytes|pbo, data...]
  glTexImage2D(c[1], (GLint)c[2], (GLint)c[3], (GLsizei)c[4], (GLsizei)c[5], (GLint)c[6], c[7], c[8], pixelPtr(c, 9, 11));
  return 11 + pixelWords(c, 9);
}
uint32_t h_texSubImage2D(const uint32_t* c) {  // [op, target, level, x, y, w, h, fmt, type, kind, bytes|pbo, data...]
  glTexSubImage2D(c[1], (GLint)c[2], (GLint)c[3], (GLint)c[4], (GLsizei)c[5], (GLsizei)c[6], c[7], c[8], pixelPtr(c, 9, 11));
  return 11 + pixelWords(c, 9);
}
uint32_t h_texImage3D(const uint32_t* c) {  // [op, target, level, ifmt, w, h, d, border, fmt, type, kind, bytes|pbo, data...]
  glTexImage3D(c[1], (GLint)c[2], (GLint)c[3], (GLsizei)c[4], (GLsizei)c[5], (GLsizei)c[6], (GLint)c[7], c[8], c[9], pixelPtr(c, 10, 12));
  return 12 + pixelWords(c, 10);
}
uint32_t h_texSubImage3D(const uint32_t* c) {  // [op, target, level, x, y, z, w, h, d, fmt, type, kind, bytes|pbo, data...]
  glTexSubImage3D(c[1], (GLint)c[2], (GLint)c[3], (GLint)c[4], (GLint)c[5], (GLsizei)c[6], (GLsizei)c[7], (GLsizei)c[8], c[9], c[10], pixelPtr(c, 11, 13));
  return 13 + pixelWords(c, 11);
}
uint32_t h_drawBuffers(const uint32_t* c) { glDrawBuffers((GLsizei)c[1], c + 2); return 2 + c[1]; }  // [op, n, bufs...]
uint32_t h_invalidate(const uint32_t* c) { glInvalidateFramebuffer(c[1], (GLsizei)c[2], c + 3); return 3 + c[2]; }  // [op, target, n, att...]
uint32_t h_invalidateSub(const uint32_t* c) {  // [op, target, n, x, y, w, h, att...]
  glInvalidateSubFramebuffer(c[1], (GLsizei)c[2], c + 7, (GLint)c[3], (GLint)c[4], (GLsizei)c[5], (GLsizei)c[6]);
  return 7 + c[2];
}
// Saved draw/read framebuffer bindings around a runtime-internal rebinding (context.js _reattachOpaque), kept on
// the GL thread so the page never waits for a getParameter round trip to save them.
GLint g_savedFb[2] = {0, 0};
uint32_t h_saveFb(const uint32_t*) { glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &g_savedFb[0]); glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &g_savedFb[1]); return 1; }
uint32_t h_restoreFb(const uint32_t*) { glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)g_savedFb[0]); glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)g_savedFb[1]); return 1; }
// The pixel source of a queued texture call: its kind word, its bytes (or PBO offset) word, and the bytes to copy.
// false: run the call synchronously (too big, or a format/type pair whose client size is unknown).
bool queuedPixels(const Args& a, int i, const PixelSrc& px, GLint w, GLint h, GLint d, GLenum fmt, GLenum type, uint32_t& kind, uint32_t& second, size_t& bytes) {
  bytes = 0;
  if (i < a.Length() && a[i]->IsNumber()) { const int64_t off = (int64_t)(intptr_t)px.ptr; if (off < 0 || off > 0x7fffffff) return false; kind = 2; second = (uint32_t)off; return true; }
  if (!px.ptr) { kind = 0; second = 0; return true; }
  size_t need = 0; if (!imageBytes(false, w, h, d, fmt, type, need)) return false;
  if (need > kQueueInlineMax) return false;
  kind = 1; second = (uint32_t)need; bytes = need; return true;
}

void f_bufferData(const Args& a) {
  ARG_U32(0, target); ARG_U32(2, usage);
  if (a.Length() > 1 && a[1]->IsNumber()) {
    const double size = a[1].As<v8::Number>()->Value();
    if (queueing() && size >= 0 && size <= 0x7fffffff) { const uint32_t h[] = {target, usage, (uint32_t)size, 0}; queueData(kOpBufferData, h, nullptr, 0); return; }
    glBufferData(target, (GLsizeiptr)size, nullptr, usage); return;
  }
  View v; if (!wgl::argView(a, 1, v, true)) return;
  if (!v.isNull && !wgl::window(a, v, 3, 4)) return;
  if (queueing() && v.len <= kQueueInlineMax) { const uint32_t h[] = {target, usage, (uint32_t)v.len, v.isNull ? 0u : 1u}; queueData(kOpBufferData, h, v.data, v.isNull ? 0 : v.len); return; }
  glBufferData(target, (GLsizeiptr)v.len, v.isNull ? nullptr : v.data, usage);
}
// bufferSubData(target, dstByteOffset, data, srcOffset = 0, length = 0)
void f_bufferSubData(const Args& a) {
  ARG_U32(0, target); ARG_I64(1, dst);
  View v; if (!wgl::argView(a, 2, v)) return; if (!wgl::window(a, v, 3, 4)) return;
  if (queueing() && v.len <= kQueueInlineMax && dst >= 0 && dst <= 0x7fffffff) { const uint32_t h[] = {target, (uint32_t)dst, (uint32_t)v.len}; queueData(kOpBufferSubData, h, v.data, v.len); return; }
  glBufferSubData(target, (GLintptr)dst, (GLsizeiptr)v.len, v.data);
}
// getBufferSubData(target, srcByteOffset, dst, dstOffset = 0, length = 0): GLES has no glGetBufferSubData, so map + copy.
void f_getBufferSubData(const Args& a) {
  ARG_U32(0, target); ARG_I64(1, src);
  View v; if (!wgl::argView(a, 2, v)) return; if (!wgl::window(a, v, 3, 4)) return;
  if (!v.len) return;
  void* p = glMapBufferRange(target, (GLintptr)src, (GLsizeiptr)v.len, GL_MAP_READ_BIT);
  if (p) { memcpy(v.data, p, v.len); glUnmapBuffer(target); }
}

// ---- textures ------------------------------------------------------------------
// texImage2D(target, level, internalformat, width, height, border, format, type, pixels | pboOffset | null, srcOffset = 0)
void f_texImage2D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, ifmt); ARG_I32(3, w); ARG_I32(4, h); ARG_I32(5, border); ARG_U32(6, fmt); ARG_U32(7, type);
  PixelSrc px; if (!pixelArg(a, 8, 9, w, h, 1, fmt, type, px)) return;
  uint32_t kind, second; size_t bytes;
  if (queueing() && queuedPixels(a, 8, px, w, h, 1, fmt, type, kind, second, bytes)) {
    const uint32_t hd[] = {target, (uint32_t)level, (uint32_t)ifmt, (uint32_t)w, (uint32_t)h, (uint32_t)border, fmt, type, kind, second};
    queueData(kOpTexImage2D, hd, px.ptr, bytes); return;
  }
  glTexImage2D(target, level, ifmt, w, h, border, fmt, type, px.ptr);
}
// texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels | pboOffset | null, srcOffset = 0)
void f_texSubImage2D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, x); ARG_I32(3, y); ARG_I32(4, w); ARG_I32(5, h); ARG_U32(6, fmt); ARG_U32(7, type);
  PixelSrc px; if (!pixelArg(a, 8, 9, w, h, 1, fmt, type, px)) return;
  uint32_t kind, second; size_t bytes;
  if (queueing() && queuedPixels(a, 8, px, w, h, 1, fmt, type, kind, second, bytes)) {
    const uint32_t hd[] = {target, (uint32_t)level, (uint32_t)x, (uint32_t)y, (uint32_t)w, (uint32_t)h, fmt, type, kind, second};
    queueData(kOpTexSubImage2D, hd, px.ptr, bytes); return;
  }
  glTexSubImage2D(target, level, x, y, w, h, fmt, type, px.ptr);
}
// texImage3D(target, level, internalformat, width, height, depth, border, format, type, pixels | pboOffset | null, srcOffset = 0)
void f_texImage3D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, ifmt); ARG_I32(3, w); ARG_I32(4, h); ARG_I32(5, d); ARG_I32(6, border); ARG_U32(7, fmt); ARG_U32(8, type);
  PixelSrc px; if (!pixelArg(a, 9, 10, w, h, d, fmt, type, px)) return;
  uint32_t kind, second; size_t bytes;
  if (queueing() && queuedPixels(a, 9, px, w, h, d, fmt, type, kind, second, bytes)) {
    const uint32_t hd[] = {target, (uint32_t)level, (uint32_t)ifmt, (uint32_t)w, (uint32_t)h, (uint32_t)d, (uint32_t)border, fmt, type, kind, second};
    queueData(kOpTexImage3D, hd, px.ptr, bytes); return;
  }
  glTexImage3D(target, level, ifmt, w, h, d, border, fmt, type, px.ptr);
}
// texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels | pboOffset | null, srcOffset = 0)
void f_texSubImage3D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, x); ARG_I32(3, y); ARG_I32(4, z); ARG_I32(5, w); ARG_I32(6, h); ARG_I32(7, d); ARG_U32(8, fmt); ARG_U32(9, type);
  PixelSrc px; if (!pixelArg(a, 10, 11, w, h, d, fmt, type, px)) return;
  uint32_t kind, second; size_t bytes;
  if (queueing() && queuedPixels(a, 10, px, w, h, d, fmt, type, kind, second, bytes)) {
    const uint32_t hd[] = {target, (uint32_t)level, (uint32_t)x, (uint32_t)y, (uint32_t)z, (uint32_t)w, (uint32_t)h, (uint32_t)d, fmt, type, kind, second};
    queueData(kOpTexSubImage3D, hd, px.ptr, bytes); return;
  }
  glTexSubImage3D(target, level, x, y, z, w, h, d, fmt, type, px.ptr);
}
// compressedTexImage2D(target, level, internalformat, width, height, border, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
void f_compressedTexImage2D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_U32(2, ifmt); ARG_I32(3, w); ARG_I32(4, h); ARG_I32(5, border);
  const void* p; GLsizei size; if (!compressedArg(a, 6, p, size)) return;
  glCompressedTexImage2D(target, level, ifmt, w, h, border, size, p);
}
// compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
void f_compressedTexSubImage2D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, x); ARG_I32(3, y); ARG_I32(4, w); ARG_I32(5, h); ARG_U32(6, fmt);
  const void* p; GLsizei size; if (!compressedArg(a, 7, p, size)) return;
  glCompressedTexSubImage2D(target, level, x, y, w, h, fmt, size, p);
}
// compressedTexImage3D(target, level, internalformat, width, height, depth, border, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
void f_compressedTexImage3D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_U32(2, ifmt); ARG_I32(3, w); ARG_I32(4, h); ARG_I32(5, d); ARG_I32(6, border);
  const void* p; GLsizei size; if (!compressedArg(a, 7, p, size)) return;
  glCompressedTexImage3D(target, level, ifmt, w, h, d, border, size, p);
}
// compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
void f_compressedTexSubImage3D(const Args& a) {
  ARG_U32(0, target); ARG_I32(1, level); ARG_I32(2, x); ARG_I32(3, y); ARG_I32(4, z); ARG_I32(5, w); ARG_I32(6, h); ARG_I32(7, d); ARG_U32(8, fmt);
  const void* p; GLsizei size; if (!compressedArg(a, 9, p, size)) return;
  glCompressedTexSubImage3D(target, level, x, y, z, w, h, d, fmt, size, p);
}
// drawCount(): wgl::drawCalls (a double: exact far past any session's count).
void f_drawCount(const Args& a) { glq::finish(); a.GetReturnValue().Set((double)wgl::drawCalls.load()); }  // after the queued draws ran
// debugSlowOps(ms): the GL thread logs any one command that takes longer (0: off), for finding a frame's hitch.
void f_debugSlowOps(const Args& a) { glq::setSlowLogUs((uint64_t)(std::max(0.0, bind::num(a, 0, 0)) * 1000)); }
// clearDrawingBuffer(framebuffer, mask): a browser's implicit clear of a canvas's drawing buffer after it was presented
// (preserveDrawingBuffer false): colour 0, depth 1, stencil 0, whatever the page's masks, scissor and clear values are,
// all of which (and the draw binding) are put back. Pages that never clear the default framebuffer themselves
// (Wonderland's final pass runs depth-tested against it) rely on it. Stack only: it runs once per flat frame.
// Clears fbo to (0, 0, 0, alpha), depth 1, stencil 0 whatever the page's masks, scissor and clear values are, and
// leaves every one of them as it found it. On the thread that owns the context: the glGet* here are cheap there.
void clearFbo(GLuint fbo, GLuint mask, float alpha) {
  GLint draw = 0; glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
  GLboolean cm[4], dm; GLint sm = 0, smBack = 0; GLfloat cc[4], cd = 1; GLint cs = 0;
  glGetBooleanv(GL_COLOR_WRITEMASK, cm); glGetBooleanv(GL_DEPTH_WRITEMASK, &dm); glGetIntegerv(GL_STENCIL_WRITEMASK, &sm); glGetIntegerv(GL_STENCIL_BACK_WRITEMASK, &smBack);
  glGetFloatv(GL_COLOR_CLEAR_VALUE, cc); glGetFloatv(GL_DEPTH_CLEAR_VALUE, &cd); glGetIntegerv(GL_STENCIL_CLEAR_VALUE, &cs);
  const GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST), discard = glIsEnabled(GL_RASTERIZER_DISCARD);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
  if (scissor) glDisable(GL_SCISSOR_TEST);
  if (discard) glDisable(GL_RASTERIZER_DISCARD);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE); glDepthMask(GL_TRUE); glStencilMaskSeparate(GL_FRONT_AND_BACK, 0xFF);
  glClearColor(0, 0, 0, alpha); glClearDepthf(1); glClearStencil(0);
  glClear(mask & (GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT));
  glClearColor(cc[0], cc[1], cc[2], cc[3]); glClearDepthf(cd); glClearStencil(cs);
  glColorMask(cm[0], cm[1], cm[2], cm[3]); glDepthMask(dm);
  glStencilMaskSeparate(GL_FRONT, (GLuint)sm); glStencilMaskSeparate(GL_BACK, (GLuint)smBack);
  if (discard) glEnable(GL_RASTERIZER_DISCARD);
  if (scissor) glEnable(GL_SCISSOR_TEST);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)draw);
}
void f_clearDrawingBuffer(const Args& a) {
  ARG_U32(0, fbo); ARG_U32(1, mask);
  glq::sync("clearDrawingBuffer", [&] { clearFbo(fbo, mask, 0); });
}
// clearFrame(fbo, mask, alpha): the XR layer's per-frame clear (host.json xr.clearFrame; runtime/src/webxr/layers.js).
// One queued command with the GL thread on: no state is read back on the JS thread, the clear just takes its place
// in the stream before the page's draws. Inline otherwise.
uint32_t h_clearFrame(const uint32_t* c) { clearFbo((GLuint)c[1], (GLuint)c[2], std::bit_cast<float>(c[3])); return 4; }  // [op, fbo, mask, alpha]
void f_clearFrame(const Args& a) {
  ARG_U32(0, fbo); ARG_U32(1, mask); double alpha = 0; if (a.Length() > 2) (void)wgl::argNum(a, 2, alpha);
  if (glq::active() && !glq::onGLThread()) glq::put(kOpClearFrame, fbo, mask, (float)alpha);
  else clearFbo(fbo, mask, (float)alpha);
}
// readPixels(x, y, width, height, format, type, dst | pboOffset, dstOffset = 0)
void f_readPixels(const Args& a) {
  ARG_I32(0, x); ARG_I32(1, y); ARG_I32(2, w); ARG_I32(3, h); ARG_U32(4, fmt); ARG_U32(5, type);
  if (a.Length() > 6 && a[6]->IsNumber()) { glReadPixels(x, y, w, h, fmt, type, (void*)(intptr_t)wgl::toI64(a[6].As<v8::Number>()->Value())); return; }
  View v; if (!wgl::argView(a, 6, v)) return; if (!wgl::window(a, v, 7, -1)) return;
  if (!imageFits(v, true, w, h, 1, fmt, type)) return;  // too small / detached: INVALID_OPERATION, never a write past the view
  glReadPixels(x, y, w, h, fmt, type, v.data);
}

// ---- shaders & programs -----------------------------------------------------------
void f_shaderSource(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, shader);
  if (a.Length() < 2) { wgl::typeError(iso, "WebGL: shaderSource needs a string"); return; }
  v8::String::Utf8Value s(iso, a[1]);
  const char* src = *s ? *s : ""; GLint len = s.length();
  glShaderSource(shader, 1, &src, &len);
}
void f_getShaderInfoLog(const Args& a) {
  ARG_U32(0, shader);
  GLint len = 0; glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &len);
  std::string buf((size_t)(len > 0 ? len : 0) + 1, '\0'); GLsizei got = 0;
  glGetShaderInfoLog(shader, (GLsizei)buf.size(), &got, buf.data());
  a.GetReturnValue().Set(jsStr(a.GetIsolate(), buf.c_str(), got > 0 ? got : 0));
}
void f_getProgramInfoLog(const Args& a) {
  ARG_U32(0, program);
  GLint len = 0; glGetProgramiv(program, GL_INFO_LOG_LENGTH, &len);
  std::string buf((size_t)(len > 0 ? len : 0) + 1, '\0'); GLsizei got = 0;
  glGetProgramInfoLog(program, (GLsizei)buf.size(), &got, buf.data());
  a.GetReturnValue().Set(jsStr(a.GetIsolate(), buf.c_str(), got > 0 ? got : 0));
}
void f_getShaderPrecisionFormat(const Args& a) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  ARG_U32(0, shaderType); ARG_U32(1, precType);
  GLint range[2] = {0, 0}, precision = 0; glGetShaderPrecisionFormat(shaderType, precType, range, &precision);
  v8::Local<v8::Object> o = v8::Object::New(iso);
  bind::setNum(ctx, o, "rangeMin", range[0]); bind::setNum(ctx, o, "rangeMax", range[1]); bind::setNum(ctx, o, "precision", precision);
  a.GetReturnValue().Set(o);
}
void f_getActiveUniform(const Args& a) {
  ARG_U32(0, program); ARG_U32(1, index);
  GLint count = 0, maxLen = 0; glGetProgramiv(program, GL_ACTIVE_UNIFORMS, &count); glGetProgramiv(program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxLen);
  if ((GLint)index >= count) { a.GetReturnValue().SetNull(); return; }
  std::string name((size_t)(maxLen > 0 ? maxLen : 0) + 1, '\0'); GLsizei len = 0; GLint size = 0; GLenum type = 0;
  glGetActiveUniform(program, index, (GLsizei)name.size(), &len, &size, &type, name.data());
  retActiveInfo(a, size, type, name.c_str(), len);
}
void f_getActiveAttrib(const Args& a) {
  ARG_U32(0, program); ARG_U32(1, index);
  GLint count = 0, maxLen = 0; glGetProgramiv(program, GL_ACTIVE_ATTRIBUTES, &count); glGetProgramiv(program, GL_ACTIVE_ATTRIBUTE_MAX_LENGTH, &maxLen);
  if ((GLint)index >= count) { a.GetReturnValue().SetNull(); return; }
  std::string name((size_t)(maxLen > 0 ? maxLen : 0) + 1, '\0'); GLsizei len = 0; GLint size = 0; GLenum type = 0;
  glGetActiveAttrib(program, index, (GLsizei)name.size(), &len, &size, &type, name.data());
  retActiveInfo(a, size, type, name.c_str(), len);
}
void f_getAttachedShaders(const Args& a) {
  ARG_U32(0, program);
  GLuint sh[8]; GLsizei n = 0; glGetAttachedShaders(program, 8, &n, sh);
  a.GetReturnValue().Set(uintArray(a.GetIsolate(), sh, n));
}
void f_getUniformLocation(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, program);
  if (a.Length() < 2) { wgl::typeError(iso, "WebGL: getUniformLocation needs a name"); return; }
  v8::String::Utf8Value s(iso, a[1]);
  wgl::retI(a, glGetUniformLocation(program, *s ? *s : ""));
}
// getUniform(program, location): the type comes from the active-uniform list (a location
// has no type query of its own), then the matching glGetUniform*v fills the right container.
void f_getUniform(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, program); ARG_I32(1, loc);
  GLint count = 0, maxLen = 0; glGetProgramiv(program, GL_ACTIVE_UNIFORMS, &count); glGetProgramiv(program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxLen);
  std::string name((size_t)(maxLen > 0 ? maxLen : 0) + 1, '\0');
  GLenum type = 0; bool found = false;
  for (GLint i = 0; i < count && !found; i++) {
    GLsizei len = 0; GLint size = 0; GLenum t = 0;
    glGetActiveUniform(program, (GLuint)i, (GLsizei)name.size(), &len, &size, &t, name.data());
    std::string base(name.c_str(), (size_t)(len > 0 ? len : 0));
    if (base.size() > 3 && base.compare(base.size() - 3, 3, "[0]") == 0) base.resize(base.size() - 3);
    if (glGetUniformLocation(program, base.c_str()) == loc) { type = t; found = true; break; }
    for (GLint k = 0; k < size && !found; k++) {
      std::string el = base + "[" + std::to_string(k) + "]";
      if (glGetUniformLocation(program, el.c_str()) == loc) { type = t; found = true; }
    }
  }
  if (!found) { a.GetReturnValue().SetNull(); return; }
  int n = 1; char kind = 'f';
  switch (type) {
    case GL_FLOAT: n = 1; kind = 'f'; break;
    case GL_FLOAT_VEC2: n = 2; kind = 'f'; break; case GL_FLOAT_VEC3: n = 3; kind = 'f'; break; case GL_FLOAT_VEC4: n = 4; kind = 'f'; break;
    case GL_FLOAT_MAT2: n = 4; kind = 'f'; break; case GL_FLOAT_MAT3: n = 9; kind = 'f'; break; case GL_FLOAT_MAT4: n = 16; kind = 'f'; break;
    case GL_FLOAT_MAT2x3: case GL_FLOAT_MAT3x2: n = 6; kind = 'f'; break;
    case GL_FLOAT_MAT2x4: case GL_FLOAT_MAT4x2: n = 8; kind = 'f'; break;
    case GL_FLOAT_MAT3x4: case GL_FLOAT_MAT4x3: n = 12; kind = 'f'; break;
    case GL_INT: n = 1; kind = 'i'; break; case GL_INT_VEC2: n = 2; kind = 'i'; break; case GL_INT_VEC3: n = 3; kind = 'i'; break; case GL_INT_VEC4: n = 4; kind = 'i'; break;
    case GL_BOOL: n = 1; kind = 'b'; break; case GL_BOOL_VEC2: n = 2; kind = 'b'; break; case GL_BOOL_VEC3: n = 3; kind = 'b'; break; case GL_BOOL_VEC4: n = 4; kind = 'b'; break;
    case GL_UNSIGNED_INT: n = 1; kind = 'u'; break; case GL_UNSIGNED_INT_VEC2: n = 2; kind = 'u'; break;
    case GL_UNSIGNED_INT_VEC3: n = 3; kind = 'u'; break; case GL_UNSIGNED_INT_VEC4: n = 4; kind = 'u'; break;
    default: n = 1; kind = 'i'; break;  // samplers and anything else: one int
  }
  if (kind == 'f') {
    GLfloat v[16] = {0}; glGetUniformfv(program, loc, v);
    if (n == 1) wgl::ret(a, v[0]); else a.GetReturnValue().Set(typedArray<v8::Float32Array>(iso, v, (size_t)n));
  } else if (kind == 'u') {
    GLuint v[4] = {0}; glGetUniformuiv(program, loc, v);
    if (n == 1) wgl::retU(a, v[0]); else a.GetReturnValue().Set(typedArray<v8::Uint32Array>(iso, v, (size_t)n));
  } else {
    GLint v[4] = {0}; glGetUniformiv(program, loc, v);
    if (kind == 'b') {
      GLboolean b[4]; for (int k = 0; k < 4; k++) b[k] = v[k] ? GL_TRUE : GL_FALSE;
      if (n == 1) wgl::retB(a, v[0] != 0); else a.GetReturnValue().Set(boolArray(iso, b, n));
    } else if (n == 1) wgl::retI(a, v[0]); else a.GetReturnValue().Set(typedArray<v8::Int32Array>(iso, v, (size_t)n));
  }
}
void f_getUniformIndices(const Args& a) {
  ARG_U32(0, program);
  std::vector<std::string> names; if (!readStrings(a, 1, names)) return;
  std::vector<const char*> ptrs; for (auto& s : names) ptrs.push_back(s.c_str());
  std::vector<GLuint> out(names.size() + 1);
  if (!names.empty()) glGetUniformIndices(program, (GLsizei)names.size(), ptrs.data(), out.data());
  a.GetReturnValue().Set(uintArray(a.GetIsolate(), out.data(), (int)names.size()));
}
void f_getActiveUniforms(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, program); ARG_U32(2, pname);
  GLuint idx[256]; int n = wgl::readNumArray<GLuint>(a, 1, idx, 256); if (n < 0) return;
  GLint out[256] = {0}; if (n) glGetActiveUniformsiv(program, n, idx, pname, out);
  if (pname == GL_UNIFORM_IS_ROW_MAJOR) { GLboolean b[256]; for (int k = 0; k < n; k++) b[k] = out[k] ? GL_TRUE : GL_FALSE; a.GetReturnValue().Set(boolArray(iso, b, n)); }
  else a.GetReturnValue().Set(intArray(iso, out, n));
}
void f_getActiveUniformBlockParameter(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, program); ARG_U32(1, block); ARG_U32(2, pname);
  if (pname == GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES) {
    GLint n = 0; glGetActiveUniformBlockiv(program, block, GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS, &n); if (n < 0) n = 0;
    std::vector<GLint> v((size_t)n + 1); if (n) glGetActiveUniformBlockiv(program, block, pname, v.data());
    a.GetReturnValue().Set(typedArray<v8::Uint32Array>(iso, (const GLuint*)v.data(), (size_t)n)); return;
  }
  GLint v = 0; glGetActiveUniformBlockiv(program, block, pname, &v);
  if (pname == GL_UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER || pname == GL_UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER) wgl::retB(a, v != 0);
  else wgl::retI(a, v);
}
void f_getActiveUniformBlockName(const Args& a) {
  ARG_U32(0, program); ARG_U32(1, block);
  GLint len = 0; glGetActiveUniformBlockiv(program, block, GL_UNIFORM_BLOCK_NAME_LENGTH, &len);
  if (len <= 0) { a.GetReturnValue().SetNull(); return; }
  std::string buf((size_t)len + 1, '\0'); GLsizei got = 0;
  glGetActiveUniformBlockName(program, block, (GLsizei)buf.size(), &got, buf.data());
  a.GetReturnValue().Set(jsStr(a.GetIsolate(), buf.c_str(), got > 0 ? got : 0));
}
void f_getTransformFeedbackVarying(const Args& a) {
  ARG_U32(0, program); ARG_U32(1, index);
  GLint count = 0, maxLen = 0; glGetProgramiv(program, GL_TRANSFORM_FEEDBACK_VARYINGS, &count);
  glGetProgramiv(program, GL_TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH, &maxLen);
  if ((GLint)index >= count) { a.GetReturnValue().SetNull(); return; }
  std::string name((size_t)(maxLen > 0 ? maxLen : 0) + 1, '\0'); GLsizei len = 0; GLsizei size = 0; GLenum type = 0;
  glGetTransformFeedbackVarying(program, index, (GLsizei)name.size(), &len, &size, &type, name.data());
  retActiveInfo(a, size, type, name.c_str(), len);
}
void f_transformFeedbackVaryings(const Args& a) {
  ARG_U32(0, program); ARG_U32(2, mode);
  std::vector<std::string> names; if (!readStrings(a, 1, names)) return;
  std::vector<const char*> ptrs; for (auto& s : names) ptrs.push_back(s.c_str());
  glTransformFeedbackVaryings(program, (GLsizei)names.size(), names.empty() ? nullptr : ptrs.data(), mode);
}

// ---- parameter queries ------------------------------------------------------------
bool isFloatTexParam(GLenum p) { return p == GL_TEXTURE_MIN_LOD || p == GL_TEXTURE_MAX_LOD || p == GL_TEXTURE_MAX_ANISOTROPY_EXT; }
void f_getTexParameter(const Args& a) {
  ARG_U32(0, target); ARG_U32(1, pname);
  if (isFloatTexParam(pname)) { GLfloat f = 0; glGetTexParameterfv(target, pname, &f); wgl::ret(a, f); return; }
  GLint i = 0; glGetTexParameteriv(target, pname, &i); wgl::retI(a, i);
}
void f_getSamplerParameter(const Args& a) {
  ARG_U32(0, sampler); ARG_U32(1, pname);
  if (isFloatTexParam(pname)) { GLfloat f = 0; glGetSamplerParameterfv(sampler, pname, &f); wgl::ret(a, f); return; }
  GLint i = 0; glGetSamplerParameteriv(sampler, pname, &i); wgl::retI(a, i);
}
void f_getVertexAttrib(const Args& a) {
  v8::Isolate* iso = a.GetIsolate();
  ARG_U32(0, index); ARG_U32(1, pname);
  if (pname == GL_CURRENT_VERTEX_ATTRIB) {
    GLint isInt = 0; glGetVertexAttribiv(index, GL_VERTEX_ATTRIB_ARRAY_INTEGER, &isInt);
    if (isInt) { GLint v[4] = {0}; glGetVertexAttribIiv(index, pname, v); a.GetReturnValue().Set(typedArray<v8::Int32Array>(iso, v, 4)); return; }
    GLfloat v[4] = {0}; glGetVertexAttribfv(index, pname, v); a.GetReturnValue().Set(typedArray<v8::Float32Array>(iso, v, 4)); return;
  }
  GLint v = 0; glGetVertexAttribiv(index, pname, &v); wgl::retI(a, v);
}
void f_getVertexAttribOffset(const Args& a) {
  ARG_U32(0, index); ARG_U32(1, pname);
  void* p = nullptr; glGetVertexAttribPointerv(index, pname, &p); wgl::ret(a, (double)(intptr_t)p);
}
void f_getQueryParameter(const Args& a) {
  ARG_U32(0, query); ARG_U32(1, pname);
  if (pname == GL_QUERY_RESULT && wgl::ext.getQueryObjectui64vEXT) { GLuint64 v = 0; GLQ_SYNC(wgl::ext.getQueryObjectui64vEXT(query, pname, &v)); wgl::ret(a, (double)v); return; }
  GLuint v = 0; glGetQueryObjectuiv(query, pname, &v); wgl::retU(a, v);
}

// ---- framebuffer attachments lists ------------------------------------------------
void f_drawBuffers(const Args& a) {
  GLenum bufs[16]; int n = wgl::readNumArray<GLenum>(a, 0, bufs, 16); if (n < 0) return;
  if (queueing()) { const uint32_t h[] = {(uint32_t)n}; queueData(kOpDrawBuffers, h, bufs, n * 4u); return; }
  glDrawBuffers(n, bufs);
}
void f_invalidateFramebuffer(const Args& a) {
  ARG_U32(0, target);
  GLenum att[32]; int n = wgl::readNumArray<GLenum>(a, 1, att, 32); if (n < 0) return;
  if (queueing()) { const uint32_t h[] = {target, (uint32_t)n}; queueData(kOpInvalidate, h, att, n * 4u); return; }
  glInvalidateFramebuffer(target, n, att);
}
void f_invalidateSubFramebuffer(const Args& a) {
  ARG_U32(0, target);
  GLenum att[32]; int n = wgl::readNumArray<GLenum>(a, 1, att, 32); if (n < 0) return;
  ARG_I32(2, x); ARG_I32(3, y); ARG_I32(4, w); ARG_I32(5, h);
  if (queueing()) { const uint32_t hd[] = {target, (uint32_t)n, (uint32_t)x, (uint32_t)y, (uint32_t)w, (uint32_t)h}; queueData(kOpInvalidateSub, hd, att, n * 4u); return; }
  glInvalidateSubFramebuffer(target, n, att, x, y, w, h);
}

// ---- sync objects --------------------------------------------------------------
GLuint64 timeoutArg(double d) { return d < 0 ? GL_TIMEOUT_IGNORED : (GLuint64)d; }
void f_fenceSync(const Args& a) { ARG_U32(0, cond); ARG_U32(1, flags); wgl::retU(a, wgl::syncAdd(glFenceSync(cond, flags))); }
void f_isSync(const Args& a) { ARG_U32(0, h); GLsync s = wgl::syncGet(h); wgl::retB(a, s && glIsSync(s) != GL_FALSE); }
void f_deleteSync(const Args& a) { ARG_U32(0, h); GLsync s = wgl::syncGet(h); if (s) glDeleteSync(s); wgl::syncRemove(h); }
void f_clientWaitSync(const Args& a) {
  ARG_U32(0, h); ARG_U32(1, flags); ARG_NUM(2, timeout);
  GLsync s = wgl::syncGet(h); if (!s) { wgl::retU(a, GL_WAIT_FAILED); return; }
  wgl::retU(a, glClientWaitSync(s, flags, timeoutArg(timeout)));
}
void f_waitSync(const Args& a) {
  ARG_U32(0, h); ARG_U32(1, flags); ARG_NUM(2, timeout);
  GLsync s = wgl::syncGet(h); if (s) glWaitSync(s, flags, timeoutArg(timeout));
}
void f_getSyncParameter(const Args& a) {
  ARG_U32(0, h); ARG_U32(1, pname);
  GLsync s = wgl::syncGet(h); GLint v = 0; GLsizei n = 0; if (s) glGetSynciv(s, pname, 1, &n, &v);
  wgl::retI(a, v);
}

// ---- WEBGL_multi_draw ------------------------------------------------------------------------------
// Two paths. runtime/src/webgl/multidraw.js builds DrawElements/DrawArraysIndirectCommand records and calls
// multiDraw*Indirect (one glMultiDraw*IndirectEXT) when it can; everything else takes the per-draw loop below
// (ANGLE's baseline). gl_DrawID is either the uniform webgl_gl_DrawID (drawIdLoc >= 0, set per draw) or, when
// indirect draws are available, the integer attribute webgl_DrawID at the reserved location g_mdi.attrib
// (drawIdLoc == -2): divisor 1 over a buffer of 0..N-1 for the indirect call (baseInstance = i reads i), its
// constant current value (0, or i inside the loop) otherwise. Its array is enabled only around the indirect call.
constexpr GLint kDrawIdAttrib = -2;
constexpr int kRingSegments = 4;
constexpr size_t kRingMin = 64 * 1024;
struct MultiDraw {
  GLint attrib = -1;              // reserved attribute location; -1 = no indirect path
  bool mapped = false;            // ring is a persistent coherent mapping (GL_EXT_buffer_storage), else glBufferSubData
  GLuint ring = 0; uint8_t* map = nullptr; size_t cap = 0, pos = 0; int seg = 0;
  GLsync fence[kRingSegments] = {};
  GLuint ids = 0; GLsizei idCap = 0; std::vector<GLint> idData;
} g_mdi;

size_t pow2At(size_t n, size_t lo) { size_t c = lo; while (c < n) c <<= 1; return c; }
// (Re)creates the indirect ring with `cap` bytes, bound to GL_DRAW_INDIRECT_BUFFER. A replaced buffer is deleted at
// once: GL keeps its storage alive until the GPU is done with it. Only on first use and on growth.
void ringAlloc(size_t cap) {
  for (GLsync& f : g_mdi.fence) if (f) { glDeleteSync(f); f = nullptr; }
  if (g_mdi.ring) glDeleteBuffers(1, &g_mdi.ring);
  glGenBuffers(1, &g_mdi.ring);
  glBindBuffer(GL_DRAW_INDIRECT_BUFFER, g_mdi.ring);
  g_mdi.map = nullptr;
  if (g_mdi.mapped) {
    const GLbitfield fl = GL_MAP_WRITE_BIT | GL_MAP_PERSISTENT_BIT_EXT | GL_MAP_COHERENT_BIT_EXT;
    wgl::ext.bufferStorageEXT(GL_DRAW_INDIRECT_BUFFER, (GLsizeiptr)cap, nullptr, fl);
    g_mdi.map = (uint8_t*)glMapBufferRange(GL_DRAW_INDIRECT_BUFFER, 0, (GLsizeiptr)cap, fl);
    if (!g_mdi.map) {
      HOST_LOGW("multi-draw: persistent map of the indirect ring failed (0x%x); using glBufferSubData", glGetError());
      g_mdi.mapped = false;
      glDeleteBuffers(1, &g_mdi.ring); glGenBuffers(1, &g_mdi.ring); glBindBuffer(GL_DRAW_INDIRECT_BUFFER, g_mdi.ring);
    }
  }
  if (!g_mdi.mapped) glBufferData(GL_DRAW_INDIRECT_BUFFER, (GLsizeiptr)cap, nullptr, GL_DYNAMIC_DRAW);
  g_mdi.cap = cap; g_mdi.pos = 0; g_mdi.seg = 0;
}
// Copies n command bytes into the ring; returns their offset (the `indirect` argument) with the ring bound to
// GL_DRAW_INDIRECT_BUFFER (WebGL2 has no such target: the game never binds it, so nothing is restored). The ring
// is kRingSegments segments: leaving one fences it; entering one waits for its fence (mapped: the GPU must be done
// reading before the CPU overwrites; normally signalled frames ago) or, at the wrap, orphans the store (subdata).
GLintptr ringPut(const void* data, size_t n) {
  if (!g_mdi.ring || n > g_mdi.cap / kRingSegments) ringAlloc(pow2At(n * kRingSegments, kRingMin));
  else glBindBuffer(GL_DRAW_INDIRECT_BUFFER, g_mdi.ring);
  size_t segSize = g_mdi.cap / kRingSegments;
  if (g_mdi.pos + n > (size_t)(g_mdi.seg + 1) * segSize) {
    if (g_mdi.mapped) g_mdi.fence[g_mdi.seg] = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    g_mdi.seg = (g_mdi.seg + 1) % kRingSegments;
    g_mdi.pos = (size_t)g_mdi.seg * segSize;
    if (g_mdi.mapped) {
      GLsync& f = g_mdi.fence[g_mdi.seg];
      if (f) { glClientWaitSync(f, GL_SYNC_FLUSH_COMMANDS_BIT, 1000000000ull); glDeleteSync(f); f = nullptr; }
    } else if (g_mdi.seg == 0) {
      glBufferData(GL_DRAW_INDIRECT_BUFFER, (GLsizeiptr)g_mdi.cap, nullptr, GL_DYNAMIC_DRAW);
    }
  }
  if (g_mdi.mapped) memcpy(g_mdi.map + g_mdi.pos, data, n);
  else glBufferSubData(GL_DRAW_INDIRECT_BUFFER, (GLintptr)g_mdi.pos, (GLsizeiptr)n, data);
  GLintptr at = (GLintptr)g_mdi.pos;
  g_mdi.pos += (n + 15) & ~(size_t)15;
  return at;
}
// The draw-id buffer holds 0..idCap-1; grown (never shrunk) to cover drawcount. Uploaded through
// GL_DRAW_INDIRECT_BUFFER so no game binding is disturbed (ringPut rebinds the ring right after).
void ensureIds(GLsizei n) {
  if (n <= g_mdi.idCap) return;
  GLsizei cap = (GLsizei)pow2At((size_t)n, 256);
  g_mdi.idData.resize((size_t)cap);
  for (GLsizei i = 0; i < cap; i++) g_mdi.idData[(size_t)i] = i;
  if (!g_mdi.ids) glGenBuffers(1, &g_mdi.ids);
  glBindBuffer(GL_DRAW_INDIRECT_BUFFER, g_mdi.ids);
  glBufferData(GL_DRAW_INDIRECT_BUFFER, (GLsizeiptr)cap * 4, g_mdi.idData.data(), GL_STATIC_DRAW);
  g_mdi.idCap = cap;
}
// Points the bound VAO's draw-id attribute at the id buffer, divisor 1 (once per VAO; the array stays disabled).
void setupDrawIdVao() {
  GLint prev = 0; glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &prev);
  glBindBuffer(GL_ARRAY_BUFFER, g_mdi.ids);
  glVertexAttribIPointer((GLuint)g_mdi.attrib, 1, GL_INT, 0, nullptr);
  glVertexAttribDivisor((GLuint)g_mdi.attrib, 1);
  glBindBuffer(GL_ARRAY_BUFFER, (GLuint)prev);
}
// The commands argument: a Uint32Array of at least drawcount * words entries.
bool commands(const Args& a, int i, GLsizei drawcount, size_t words, View& v) {
  if (!wgl::argTyped(a, i, v, wgl::TA::Uint32Array)) return false;
  if (v.len < (size_t)drawcount * words * 4) { wgl::rangeError(a.GetIsolate(), "WebGL: multiDraw command list shorter than drawcount"); return false; }
  return true;
}
// flags: 1 = enable the draw-id attribute for the call, 2 = set its pointer on the bound VAO first.
void drawIdBegin(GLsizei drawcount, GLint flags) {
  if (!(flags & 1)) return;
  ensureIds(drawcount);
  if (flags & 2) setupDrawIdVao();
  glEnableVertexAttribArray((GLuint)g_mdi.attrib);
}
void drawIdEnd(GLint flags) { if (flags & 1) glDisableVertexAttribArray((GLuint)g_mdi.attrib); }

// multiDrawElementsIndirect(mode, type, commands: Uint32Array (5 words per draw), drawcount, flags)
void f_multiDrawElementsIndirect(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_U32(1, type); ARG_I32(3, drawcount); ARG_I32(4, flags);
  if (g_mdi.attrib < 0 || drawcount <= 0) return;
  View v; if (!commands(a, 2, drawcount, 5, v)) return;
  glq::sync("multiDrawIndirect", [&] {
    drawIdBegin(drawcount, flags);
    GLintptr at = ringPut(v.data, (size_t)drawcount * 20);
    wgl::ext.multiDrawElementsIndirectEXT(mode, type, (const void*)at, drawcount, 0);
    drawIdEnd(flags);
  });
}
// multiDrawArraysIndirect(mode, commands: Uint32Array (4 words per draw), drawcount, flags)
void f_multiDrawArraysIndirect(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_I32(2, drawcount); ARG_I32(3, flags);
  if (g_mdi.attrib < 0 || drawcount <= 0) return;
  View v; if (!commands(a, 1, drawcount, 4, v)) return;
  glq::sync("multiDrawIndirect", [&] {
    drawIdBegin(drawcount, flags);
    GLintptr at = ringPut(v.data, (size_t)drawcount * 16);
    wgl::ext.multiDrawArraysIndirectEXT(mode, (const void*)at, drawcount, 0);
    drawIdEnd(flags);
  });
}
// The reserved draw-id attribute location, or -1 when multi-draw runs as the uniform loop only.
void f_multiDrawInfo(const Args& a) { wgl::retI(a, g_mdi.attrib); }

// The loop. Lists are Int32Arrays (the JS side converts plain arrays); offsets are in elements; drawIdLoc: >= 0 the
// uniform, -2 the attribute, -1 none.
struct IntList { const GLint* p = nullptr; };
bool intList(const Args& a, int i, int offIdx, int count, IntList& out) {
  View v; if (!wgl::argView(a, i, v)) return false; if (!wgl::window(a, v, offIdx, -1)) return false;
  if (v.elem != 4) { wgl::typeError(a.GetIsolate(), "WebGL: multiDraw lists must be Int32Array"); return false; }
  if (v.len < (size_t)count * 4) { wgl::rangeError(a.GetIsolate(), "WebGL: multiDraw list shorter than drawcount"); return false; }
  out.p = (const GLint*)v.data; return true;
}
inline void setDrawId(GLint loc, GLint i) {
  if (loc >= 0) glUniform1i(loc, i);
  else if (loc == kDrawIdAttrib && g_mdi.attrib >= 0) glVertexAttribI4i((GLuint)g_mdi.attrib, i, 0, 0, 0);
}
inline void endDrawId(GLint loc) { if (loc == kDrawIdAttrib && g_mdi.attrib >= 0) glVertexAttribI4i((GLuint)g_mdi.attrib, 0, 0, 0, 0); }
// The WEBGL_multi_draw loop as one queued command (three's BatchedMesh calls it every frame): its lists are copied
// into the ring and the GL thread runs the loop. [op, variant, mode, type, drawcount, drawIdLoc, lists...];
// variant 0 arrays (firsts, counts), 1 elements (counts, offsets), 2 arrays instanced (firsts, counts, instances),
// 3 elements instanced (counts, offsets, instances).
void runMultiDraw(int variant, GLenum mode, GLenum type, GLint n, GLint loc, const GLint* l0, const GLint* l1, const GLint* l2) {
  for (GLint i = 0; i < n; i++) {
    if (variant == 0) { if (l1[i] <= 0) continue; setDrawId(loc, i); glDrawArrays(mode, l0[i], l1[i]); }
    else if (variant == 1) { if (l0[i] <= 0) continue; setDrawId(loc, i); glDrawElements(mode, l0[i], type, (const void*)(intptr_t)l1[i]); }
    else if (variant == 2) { if (l1[i] <= 0 || l2[i] <= 0) continue; setDrawId(loc, i); glDrawArraysInstanced(mode, l0[i], l1[i], l2[i]); }
    else { if (l0[i] <= 0 || l2[i] <= 0) continue; setDrawId(loc, i); glDrawElementsInstanced(mode, l0[i], type, (const void*)(intptr_t)l1[i], l2[i]); }
  }
  endDrawId(loc);
}
uint32_t h_multiDraw(const uint32_t* c) {
  const int variant = (int)c[1]; const GLint n = (GLint)c[4]; const GLint* l = (const GLint*)(c + 6);
  runMultiDraw(variant, c[2], c[3], n, (GLint)c[5], l, l + n, variant >= 2 ? l + 2 * n : nullptr);
  return 6 + (uint32_t)n * (variant >= 2 ? 3 : 2);
}
// Queues the loop (true) or leaves it to the caller (false: queue off, on the GL thread, or lists too long to copy).
bool queueMultiDraw(int variant, GLenum mode, GLenum type, GLint n, GLint loc, const GLint* l0, const GLint* l1, const GLint* l2) {
  const uint32_t lists = variant >= 2 ? 3 : 2;
  if (!queueing() || n < 0 || (size_t)n * lists * 4 > kQueueInlineMax) return false;
  const uint32_t sz = 6 + (uint32_t)n * lists;
  const uint32_t pos = glq::reserve(sz); uint32_t* d = glq::data() + pos;
  d[0] = kOpMultiDraw; d[1] = (uint32_t)variant; d[2] = mode; d[3] = type; d[4] = (uint32_t)n; d[5] = (uint32_t)loc;
  memcpy(d + 6, l0, (size_t)n * 4); memcpy(d + 6 + n, l1, (size_t)n * 4); if (l2) memcpy(d + 6 + 2 * n, l2, (size_t)n * 4);
  glq::commit(pos + sz);
  return true;
}
// multiDrawArraysWEBGL(mode, firsts, firstsOffset, counts, countsOffset, drawcount, drawIdLoc)
void f_multiDrawArraysWEBGL(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_I32(5, drawcount); ARG_I32(6, loc);
  IntList firsts, counts; if (!intList(a, 1, 2, drawcount, firsts) || !intList(a, 3, 4, drawcount, counts)) return;
  if (queueMultiDraw(0, mode, 0, drawcount, loc, firsts.p, counts.p, nullptr)) return;
  glq::sync("multiDraw", [&] {
    for (GLint i = 0; i < drawcount; i++) {
      if (counts.p[i] <= 0) continue;
      setDrawId(loc, i);
      glDrawArrays(mode, firsts.p[i], counts.p[i]);
    }
    endDrawId(loc);
  });
}
// multiDrawElementsWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, drawcount, drawIdLoc)
void f_multiDrawElementsWEBGL(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_U32(3, type); ARG_I32(6, drawcount); ARG_I32(7, loc);
  IntList counts, offsets; if (!intList(a, 1, 2, drawcount, counts) || !intList(a, 4, 5, drawcount, offsets)) return;
  if (queueMultiDraw(1, mode, type, drawcount, loc, counts.p, offsets.p, nullptr)) return;
  glq::sync("multiDraw", [&] {
    for (GLint i = 0; i < drawcount; i++) {
      if (counts.p[i] <= 0) continue;
      setDrawId(loc, i);
      glDrawElements(mode, counts.p[i], type, (const void*)(intptr_t)offsets.p[i]);
    }
    endDrawId(loc);
  });
}
// multiDrawArraysInstancedWEBGL(mode, firsts, firstsOffset, counts, countsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)
void f_multiDrawArraysInstancedWEBGL(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_I32(7, drawcount); ARG_I32(8, loc);
  IntList firsts, counts, inst;
  if (!intList(a, 1, 2, drawcount, firsts) || !intList(a, 3, 4, drawcount, counts) || !intList(a, 5, 6, drawcount, inst)) return;
  if (queueMultiDraw(2, mode, 0, drawcount, loc, firsts.p, counts.p, inst.p)) return;
  glq::sync("multiDraw", [&] {
    for (GLint i = 0; i < drawcount; i++) {
      if (counts.p[i] <= 0 || inst.p[i] <= 0) continue;
      setDrawId(loc, i);
      glDrawArraysInstanced(mode, firsts.p[i], counts.p[i], inst.p[i]);
    }
    endDrawId(loc);
  });
}
// multiDrawElementsInstancedWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)
void f_multiDrawElementsInstancedWEBGL(const Args& a) {
  ++wgl::drawCalls;
  ARG_U32(0, mode); ARG_U32(3, type); ARG_I32(8, drawcount); ARG_I32(9, loc);
  IntList counts, offsets, inst;
  if (!intList(a, 1, 2, drawcount, counts) || !intList(a, 4, 5, drawcount, offsets) || !intList(a, 6, 7, drawcount, inst)) return;
  if (queueMultiDraw(3, mode, type, drawcount, loc, counts.p, offsets.p, inst.p)) return;
  glq::sync("multiDraw", [&] {
    for (GLint i = 0; i < drawcount; i++) {
      if (counts.p[i] <= 0 || inst.p[i] <= 0) continue;
      setDrawId(loc, i);
      glDrawElementsInstanced(mode, counts.p[i], type, (const void*)(intptr_t)offsets.p[i], inst.p[i]);
    }
    endDrawId(loc);
  });
}

// ---- extension entry points, resolved once -----------------------------------------
template <typename F> F proc(const char* name) { return reinterpret_cast<F>(eglGetProcAddress(name)); }
int glesMinor() {
  // "OpenGL ES 3.2 V@0502..." → 2
  const char* v = (const char*)glGetString(GL_VERSION); if (!v) return 0;
  const char* d = strstr(v, "3."); return d ? d[2] - '0' : 0;
}
void loadExtensions() {
  wgl::ext = wgl::ExtFns();
  // eglGetProcAddress hands back a non-null stub for names it does not know on some drivers, so gate on the extension string.
  if (hasGLExt("GL_OVR_multiview2") || hasGLExt("GL_OVR_multiview"))
    wgl::ext.framebufferTextureMultiviewOVR = proc<PFNGLFRAMEBUFFERTEXTUREMULTIVIEWOVRPROC>("glFramebufferTextureMultiviewOVR");
  if (hasGLExt("GL_OVR_multiview_multisampled_render_to_texture"))
    wgl::ext.framebufferTextureMultisampleMultiviewOVR = proc<PFNGLFRAMEBUFFERTEXTUREMULTISAMPLEMULTIVIEWOVRPROC>("glFramebufferTextureMultisampleMultiviewOVR");
  if (hasGLExt("GL_EXT_multisampled_render_to_texture")) {
    wgl::ext.renderbufferStorageMultisampleEXT = proc<PFNGLRENDERBUFFERSTORAGEMULTISAMPLEEXTPROC>("glRenderbufferStorageMultisampleEXT");
    wgl::ext.framebufferTexture2DMultisampleEXT = proc<PFNGLFRAMEBUFFERTEXTURE2DMULTISAMPLEEXTPROC>("glFramebufferTexture2DMultisampleEXT");
  }
  if (hasGLExt("GL_EXT_disjoint_timer_query")) {
    wgl::ext.queryCounterEXT = proc<PFNGLQUERYCOUNTEREXTPROC>("glQueryCounterEXT");
    wgl::ext.getQueryObjectui64vEXT = proc<PFNGLGETQUERYOBJECTUI64VEXTPROC>("glGetQueryObjectui64vEXT");
    wgl::ext.getQueryObjectuivEXT = proc<PFNGLGETQUERYOBJECTUIVEXTPROC>("glGetQueryObjectuivEXT");
    wgl::ext.getQueryivEXT = proc<PFNGLGETQUERYIVEXTPROC>("glGetQueryivEXT");
  }
  if (hasGLExt("GL_EXT_clip_control")) wgl::ext.clipControlEXT = proc<PFNGLCLIPCONTROLEXTPROC>("glClipControlEXT");
  if (hasGLExt("GL_OES_draw_buffers_indexed")) {
    wgl::ext.enableiOES = proc<PFNGLENABLEIOESPROC>("glEnableiOES");
    wgl::ext.disableiOES = proc<PFNGLDISABLEIOESPROC>("glDisableiOES");
    wgl::ext.blendEquationiOES = proc<PFNGLBLENDEQUATIONIOESPROC>("glBlendEquationiOES");
    wgl::ext.blendEquationSeparateiOES = proc<PFNGLBLENDEQUATIONSEPARATEIOESPROC>("glBlendEquationSeparateiOES");
    wgl::ext.blendFunciOES = proc<PFNGLBLENDFUNCIOESPROC>("glBlendFunciOES");
    wgl::ext.blendFuncSeparateiOES = proc<PFNGLBLENDFUNCSEPARATEIOESPROC>("glBlendFuncSeparateiOES");
    wgl::ext.colorMaskiOES = proc<PFNGLCOLORMASKIOESPROC>("glColorMaskiOES");
  } else if (glesMinor() >= 2) {
    // Core in ES 3.2 under the un-suffixed names; same signatures.
    wgl::ext.enableiOES = glEnablei; wgl::ext.disableiOES = glDisablei;
    wgl::ext.blendEquationiOES = glBlendEquationi; wgl::ext.blendEquationSeparateiOES = glBlendEquationSeparatei;
    wgl::ext.blendFunciOES = glBlendFunci; wgl::ext.blendFuncSeparateiOES = glBlendFuncSeparatei; wgl::ext.colorMaskiOES = glColorMaski;
  }
  // Indirect multi-draw needs both: EXT_base_instance makes the command's baseInstance (draw id) honoured.
  if (glesMinor() >= 1 && hasGLExt("GL_EXT_multi_draw_indirect") && hasGLExt("GL_EXT_base_instance")) {
    wgl::ext.multiDrawElementsIndirectEXT = proc<PFNGLMULTIDRAWELEMENTSINDIRECTEXTPROC>("glMultiDrawElementsIndirectEXT");
    wgl::ext.multiDrawArraysIndirectEXT = proc<PFNGLMULTIDRAWARRAYSINDIRECTEXTPROC>("glMultiDrawArraysIndirectEXT");
  }
  if (hasGLExt("GL_EXT_buffer_storage")) wgl::ext.bufferStorageEXT = proc<PFNGLBUFFERSTORAGEEXTPROC>("glBufferStorageEXT");
}

// host.json gl.multiDrawIndirect (default true) and gl.indirectUpload ("map" default | "subdata").
void initMultiDraw(const Json* config) {
  for (GLsync& f : g_mdi.fence) if (f) { glDeleteSync(f); f = nullptr; }
  g_mdi = MultiDraw();
  const Json& c = config ? config->at("gl") : Json();
  bool want = c.bo("multiDrawIndirect", true);
  bool have = wgl::ext.multiDrawElementsIndirectEXT && wgl::ext.multiDrawArraysIndirectEXT;
  if (want && have) {
    GLint maxAttribs = 0; glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &maxAttribs);
    if (maxAttribs >= 2) {
      g_mdi.attrib = maxAttribs - 1;
      glVertexAttribI4i((GLuint)g_mdi.attrib, 0, 0, 0, 0);   // gl_DrawID outside a multi-draw: 0 (and an integer current value, as the int attribute needs)
    }
  }
  g_mdi.mapped = wgl::ext.bufferStorageEXT != nullptr && c.s("indirectUpload", "map") != "subdata";
  HOST_LOGI("multi-draw: %s (GL_EXT_multi_draw_indirect+base_instance %s, host.json gl.multiDrawIndirect %s); draw-id attribute %d; ring %s",
            g_mdi.attrib >= 0 ? "indirect" : "per-draw loop", have ? "yes" : "no", want ? "on" : "off", g_mdi.attrib,
            g_mdi.mapped ? "persistent map" : "glBufferSubData");
}

}  // namespace

// The EGL context is current on the host thread when this runs (after svc.egl->makeCurrent()).
void installWebGL(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  v8::Local<v8::Object> gl = bind::obj(ctx, native, "gl");
  const char* exts = (const char*)glGetString(GL_EXTENSIONS);
  g_glExtensions = exts ? exts : "";
  if (g_glExtensions.empty()) HOST_LOGW("installWebGL: no GL extension string (is the EGL context current?)");
  loadExtensions();
  initMultiDraw(svc.config);
  wgl::installGeneratedGL(ctx, gl, hasGLExt);
  // WebGL extensions withheld from the page (runtime/src/webgl/extensions.js): host.json gl.withholdExtensions, and
  // ANGLE's compressed formats in the iOS simulator, whose Metal path overreads the source on every
  // compressedTex(Sub)Image (EXC_BAD_ACCESS in UploadTextureContents; pages fall back to uncompressed textures).
  {
    std::vector<std::string> withheld;
    if (svc.config) for (auto& e : svc.config->at("gl").at("withholdExtensions").arr) if (e.type == Json::String) withheld.push_back(e.str);
#if defined(HOST_IOS_ANGLE) && TARGET_OS_SIMULATOR
    for (const char* e : {"WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_astc"}) withheld.push_back(e);
#endif
    // Mesa's llvmpipe (the software rasteriser: Linux without a GPU, CI) offers OVR_multiview2 but draws nothing
    // into a multiview framebuffer (Mesa 25.2: the page's frames come out as the clear colour only; the same
    // frames on zink, Mesa's GL over Vulkan, render both eyes). Withheld there, the page renders each eye on its
    // own. zink names llvmpipe inside its renderer string ("zink Vulkan 1.4(llvmpipe ...)"), so only a leading
    // "llvmpipe" counts.
    if (const char* r = (const char*)glGetString(GL_RENDERER); r && !strncmp(r, "llvmpipe", 8))
      for (const char* e : {"OVR_multiview2", "OCULUS_multiview"}) withheld.push_back(e);
    v8::Isolate* iso = isolateOf(ctx); v8::Local<v8::Array> arr = v8::Array::New(iso, (int)withheld.size());
    for (size_t i = 0; i < withheld.size(); ++i) (void)arr->Set(ctx, (uint32_t)i, bind::str(iso, withheld[i]));
    bind::set(ctx, gl, "withheld", arr);
    if (!withheld.empty()) { std::string l; for (auto& w : withheld) l += (l.empty() ? "" : ", ") + w; HOST_LOGI("WebGL: withholding %s", l.c_str()); }
  }

  struct { const char* name; v8::FunctionCallback cb; } hand[] = {
    {"extensions", f_extensions}, {"getString", f_getString}, {"getParameter", f_getParameter},
    {"getIndexedParameter", f_getIndexedParameter}, {"getInternalformatParameter", f_getInternalformatParameter},
    {"bufferData", f_bufferData}, {"bufferSubData", f_bufferSubData}, {"getBufferSubData", f_getBufferSubData},
    {"texImage2D", f_texImage2D}, {"texSubImage2D", f_texSubImage2D}, {"texImage3D", f_texImage3D}, {"texSubImage3D", f_texSubImage3D},
    {"compressedTexImage2D", f_compressedTexImage2D}, {"compressedTexSubImage2D", f_compressedTexSubImage2D},
    {"compressedTexImage3D", f_compressedTexImage3D}, {"compressedTexSubImage3D", f_compressedTexSubImage3D},
    {"readPixels", f_readPixels}, {"shaderSource", f_shaderSource}, {"getShaderInfoLog", f_getShaderInfoLog},
    {"getProgramInfoLog", f_getProgramInfoLog}, {"getShaderPrecisionFormat", f_getShaderPrecisionFormat},
    {"getActiveUniform", f_getActiveUniform}, {"getActiveAttrib", f_getActiveAttrib}, {"getAttachedShaders", f_getAttachedShaders},
    {"getUniformLocation", f_getUniformLocation}, {"getUniform", f_getUniform}, {"getUniformIndices", f_getUniformIndices},
    {"getActiveUniforms", f_getActiveUniforms}, {"getActiveUniformBlockParameter", f_getActiveUniformBlockParameter},
    {"getActiveUniformBlockName", f_getActiveUniformBlockName}, {"getTransformFeedbackVarying", f_getTransformFeedbackVarying},
    {"transformFeedbackVaryings", f_transformFeedbackVaryings}, {"getTexParameter", f_getTexParameter},
    {"getSamplerParameter", f_getSamplerParameter}, {"getVertexAttrib", f_getVertexAttrib}, {"getVertexAttribOffset", f_getVertexAttribOffset},
    {"getQueryParameter", f_getQueryParameter}, {"drawBuffers", f_drawBuffers}, {"invalidateFramebuffer", f_invalidateFramebuffer},
    {"invalidateSubFramebuffer", f_invalidateSubFramebuffer}, {"fenceSync", f_fenceSync}, {"isSync", f_isSync}, {"deleteSync", f_deleteSync},
    {"clientWaitSync", f_clientWaitSync}, {"waitSync", f_waitSync}, {"getSyncParameter", f_getSyncParameter},
    {"multiDrawArraysWEBGL", f_multiDrawArraysWEBGL}, {"multiDrawElementsWEBGL", f_multiDrawElementsWEBGL},
    {"multiDrawArraysInstancedWEBGL", f_multiDrawArraysInstancedWEBGL}, {"multiDrawElementsInstancedWEBGL", f_multiDrawElementsInstancedWEBGL},
    {"multiDrawElementsIndirect", f_multiDrawElementsIndirect}, {"multiDrawArraysIndirect", f_multiDrawArraysIndirect}, {"multiDrawInfo", f_multiDrawInfo}, {"clearDrawingBuffer", f_clearDrawingBuffer}, {"clearFrame", f_clearFrame}, {"drawCount", f_drawCount}, {"debugSlowOps", f_debugSlowOps},
  };
  for (auto& h : hand) wgl::installFn(ctx, gl, h.name, h.cb);
  // The GL thread's decoders, and the ring for the JS encoders (runtime/src/webgl/queue.gen.js).
  glq::registerOp(glq::kFirstGenerated, wgl::execQueued);
  glq::registerOp(kOpBufferData, h_bufferData); glq::registerOp(kOpBufferSubData, h_bufferSubData);
  glq::registerOp(kOpTexImage2D, h_texImage2D); glq::registerOp(kOpTexSubImage2D, h_texSubImage2D);
  glq::registerOp(kOpTexImage3D, h_texImage3D); glq::registerOp(kOpTexSubImage3D, h_texSubImage3D);
  glq::registerOp(kOpDrawBuffers, h_drawBuffers); glq::registerOp(kOpInvalidate, h_invalidate); glq::registerOp(kOpInvalidateSub, h_invalidateSub);
  glq::registerOp(kOpSaveFb, h_saveFb); glq::registerOp(kOpRestoreFb, h_restoreFb); glq::registerOp(kOpMultiDraw, h_multiDraw);
  glq::registerOp(kOpClearFrame, h_clearFrame);

  if (glq::active()) {
    v8::Isolate* iso = isolateOf(ctx);
    wgl::installFn(ctx, gl, "glqReserve", [](const Args& a) { uint32_t n = 0; if (!wgl::argU32(a, 0, n)) return; wgl::retU(a, glq::reserve(n)); });
    wgl::installFn(ctx, gl, "glqWake", [](const Args&) { glq::wake(); });
    wgl::installFn(ctx, gl, "glqSaveFb", [](const Args&) { glq::put(kOpSaveFb); });
    wgl::installFn(ctx, gl, "glqRestoreFb", [](const Args&) { glq::put(kOpRestoreFb); });
#ifndef V8_ENABLE_SANDBOX
    // The JS encoders write the ring directly. (A sandboxed V8 cannot alias native memory: the page's calls then
    // reach the C++ natives, which record the same commands.)
    auto store = v8::ArrayBuffer::NewBackingStore(glq::memory(), glq::memoryBytes(), [](void*, size_t, void*) {}, nullptr);
    bind::set(ctx, gl, "queue", v8::ArrayBuffer::New(iso, std::move(store)));
#endif
    HOST_LOGI("WebGL: GL thread on (%u-word ring)", glq::capacity());
  }
  HOST_LOGI("WebGL binding: %d generated (%d with a fast-API path) + %d hand-written entry points; multiview %d, msaa-multiview %d, msaa-rtt %d, timer %d, clip %d, dbi %d",
            wgl::generatedFunctionCount(), wgl::generatedFastCount(), (int)(sizeof(hand) / sizeof(hand[0])),
            wgl::ext.framebufferTextureMultiviewOVR != nullptr, wgl::ext.framebufferTextureMultisampleMultiviewOVR != nullptr,
            wgl::ext.renderbufferStorageMultisampleEXT != nullptr, wgl::ext.queryCounterEXT != nullptr,
            wgl::ext.clipControlEXT != nullptr, wgl::ext.enableiOES != nullptr);
}

}  // namespace host
