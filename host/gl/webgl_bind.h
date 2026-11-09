#pragma once
// Shared helpers for the WebGL2 binding (webgl_bind.cpp hand-written entry
// points + webgl_bind.gen.cpp generated from webgl_table.py). Everything here
// is inline and allocation-free: arguments are read straight off the V8 call
// info, typed arrays by backing-store pointer, and a wrong type throws a
// TypeError (a GL error never throws — getError carries it, as in a browser).
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <v8.h>
#include <v8-fast-api-calls.h>
#include "js/v8compat.h"
#include "gl/gl_queue.h"
#include <GLES3/gl32.h>
#include <GLES2/gl2ext.h>

// V8 fast API calls (webgl_table.py): the generated CFunction twins take v8::FastApiTypedArray, which V8 13
// removed. On a newer V8 (the experimental Mac host) only the slow callbacks are installed.
#if V8_MAJOR_VERSION < 13
#define HOST_FAST_API 1
#define HOST_FAST(cf) (&cf)
#else
#define HOST_FAST_API 0
#define HOST_FAST(cf) nullptr
#endif

namespace host {
namespace wgl {

using Args = v8::FunctionCallbackInfo<v8::Value>;

inline v8::Local<v8::String> str(v8::Isolate* iso, const char* s) {
  return v8::String::NewFromUtf8(iso, s).ToLocalChecked();
}
inline void typeError(v8::Isolate* iso, const char* msg) {
  iso->ThrowException(v8::Exception::TypeError(str(iso, msg)));
}
inline void rangeError(v8::Isolate* iso, const char* msg) {
  iso->ThrowException(v8::Exception::RangeError(str(iso, msg)));
}

// A numeric argument. undefined/null read as 0 (WebIDL's conversion for the
// integer types WebGL uses), booleans as 0/1; anything else is a TypeError.
inline bool argNum(const Args& a, int i, double& out) {
  if (i >= a.Length()) { out = 0; return true; }
  v8::Local<v8::Value> v = a[i];
  if (v->IsNumber()) { out = v.As<v8::Number>()->Value(); return true; }
  if (v->IsNullOrUndefined()) { out = 0; return true; }
  if (v->IsBoolean()) { out = v.As<v8::Boolean>()->Value() ? 1 : 0; return true; }
  typeError(a.GetIsolate(), "WebGL: argument must be a number"); return false;
}
inline bool argU32(const Args& a, int i, GLuint& out) {
  if (i < a.Length() && a[i]->IsUint32()) { out = a[i].As<v8::Uint32>()->Value(); return true; }
  double d; if (!argNum(a, i, d)) return false;
  out = (GLuint)(int64_t)d; return true;
}
inline bool argI32(const Args& a, int i, GLint& out) {
  if (i < a.Length() && a[i]->IsInt32()) { out = a[i].As<v8::Int32>()->Value(); return true; }
  double d; if (!argNum(a, i, d)) return false;
  out = (GLint)(int64_t)d; return true;
}
// WebIDL long long from a double: NaN → 0, truncated toward zero, clamped to the int64 range (no UB).
inline int64_t toI64(double d) {
  if (!(d == d)) return 0;
  if (d >= 9.2233720368547758e18) return INT64_MAX;
  if (d <= -9.2233720368547758e18) return INT64_MIN;
  return (int64_t)d;
}
inline bool argI64(const Args& a, int i, int64_t& out) {
  double d; if (!argNum(a, i, d)) return false;
  out = toI64(d); return true;
}
inline bool argF(const Args& a, int i, GLfloat& out) {
  double d; if (!argNum(a, i, d)) return false;
  out = (GLfloat)d; return true;
}
inline bool argBool(const Args& a, int i, GLboolean& out) {
  if (i >= a.Length()) { out = GL_FALSE; return true; }
  out = a[i]->BooleanValue(a.GetIsolate()) ? GL_TRUE : GL_FALSE; return true;
}

// WebGL's synthetic error flag: an error the binding raises itself (a srcOffset /
// srcLength out of range, a uniform array of the wrong length, a readPixels
// destination too small — WebGL makes those GL errors, not exceptions). getError reports it before the driver's; only the first
// raised error is kept until it is read, like a browser's error flag.
extern GLenum g_synthError;
// Draw, clear and blit calls the page has made (any framebuffer). The flat frame loop compares it across a frame to
// tell a frame the page drew from one it skipped (the browser's implicit clear follows only a drawn frame).
// Counted where the call runs: on the GL thread when it is on (gl_queue.h), so it is atomic.
extern std::atomic<uint64_t> drawCalls;
inline void synthError(GLenum e) { if (g_synthError == GL_NO_ERROR) g_synthError = e; }
inline GLenum takeError() {
  if (g_synthError != GL_NO_ERROR) { GLenum e = g_synthError; g_synthError = GL_NO_ERROR; return e; }
  return GLQ_SYNC(glGetError());
}

// The UNPACK_ / PACK_ pixel-store state as set through pixelStorei (the one way a page changes it). With the GL
// thread on, the hand-written upload and readback calls size their client data from this instead of asking GL
// for it on every call (a synchronous round trip each); without it they read GL, as before.
struct PixelStore {
  GLint unpackAlignment = 4, unpackRowLength = 0, unpackSkipPixels = 0, unpackSkipRows = 0, unpackImageHeight = 0, unpackSkipImages = 0;
  GLint packAlignment = 4, packRowLength = 0, packSkipPixels = 0, packSkipRows = 0;
};
extern PixelStore g_pixelStore;

// Pipelined XR frames (gl.pipeline): the page's JS for a frame runs before the GL thread has acquired that frame's
// swapchain image, so the page is given kXrImage as the colour texture's name. The GL thread resolves it to the
// acquired image wherever it is attached (xrTex) and, after every acquire, re-attaches the new image in each
// framebuffer that holds it (xrImageAcquired), so a page that attaches once and keeps the framebuffer works too.
constexpr uint32_t kXrImage = 0x7FFF0001u;
extern uint32_t g_xrImage;  // GL thread only
void noteXrAttach(GLenum target, GLenum attachment, int kind, GLint a, GLint b, GLint c, GLint d);
inline GLuint xrTex(GLuint tex, GLenum target, GLenum attachment, int kind, GLint a, GLint b = 0, GLint c = 0, GLint d = 0) {
  if (tex != kXrImage) return tex;
  noteXrAttach(target, attachment, kind, a, b, c, d);
  return g_xrImage;
}
void xrImageAcquired(GLuint image);
inline void pixelStore(GLenum pname, GLint v) {
  PixelStore& s = g_pixelStore;
  switch (pname) {
    case GL_UNPACK_ALIGNMENT: if (v == 1 || v == 2 || v == 4 || v == 8) s.unpackAlignment = v; break;
    case GL_PACK_ALIGNMENT: if (v == 1 || v == 2 || v == 4 || v == 8) s.packAlignment = v; break;
    case GL_UNPACK_ROW_LENGTH: if (v >= 0) s.unpackRowLength = v; break;
    case GL_UNPACK_SKIP_PIXELS: if (v >= 0) s.unpackSkipPixels = v; break;
    case GL_UNPACK_SKIP_ROWS: if (v >= 0) s.unpackSkipRows = v; break;
    case GL_UNPACK_IMAGE_HEIGHT: if (v >= 0) s.unpackImageHeight = v; break;
    case GL_UNPACK_SKIP_IMAGES: if (v >= 0) s.unpackSkipImages = v; break;
    case GL_PACK_ROW_LENGTH: if (v >= 0) s.packRowLength = v; break;
    case GL_PACK_SKIP_PIXELS: if (v >= 0) s.packSkipPixels = v; break;
    case GL_PACK_SKIP_ROWS: if (v >= 0) s.packSkipRows = v; break;
    default: break;
  }
}

// A view over an ArrayBuffer / SharedArrayBuffer / ArrayBufferView argument:
// the backing store's pointer + byteOffset, never a copy. `elem` is the element
// size of a typed array (1 for DataView / ArrayBuffer), which is what WebGL2's
// srcOffset / srcLength count in. A detached buffer reads as zero bytes (V8
// reports byteLength 0 and a null store; 10.0 has no public WasDetached), so
// every caller sees len 0 and never dereferences it. GetBackingStore() costs one
// shared_ptr atomic inc/dec (V8 10.0 has no ArrayBuffer::Data()); the fast-API
// entry points in webgl_bind.gen.cpp get the pointer from V8 directly instead.
struct View { uint8_t* data = nullptr; size_t len = 0; size_t elem = 1; bool isNull = true; };

inline bool readView(v8::Isolate* iso, v8::Local<v8::Value> v, View& out, bool allowNull) {
  out = View();
  if (v->IsArrayBufferView()) {
    v8::Local<v8::ArrayBufferView> view = v.As<v8::ArrayBufferView>();
    out.isNull = false;
    size_t len = view->ByteLength();  // 0 once detached
    if (v->IsTypedArray()) { size_t n = v.As<v8::TypedArray>()->Length(); out.elem = n ? len / n : 1; }
    if (len == 0) return true;  // empty or detached: no pointer needed (and none touched)
    // Buffer() moves a small on-heap typed array's bytes off-heap once (V8's own lazy step); the
    // pointer is stable from then on. A view over a SharedArrayBuffer comes through here too.
    void* base = view->Buffer()->GetBackingStore()->Data();
    if (base) { out.data = (uint8_t*)base + view->ByteOffset(); out.len = len; }
    return true;
  }
  if (v->IsArrayBuffer()) {
    std::shared_ptr<v8::BackingStore> bs = v.As<v8::ArrayBuffer>()->GetBackingStore();
    out.isNull = false; out.data = (uint8_t*)bs->Data(); out.len = out.data ? bs->ByteLength() : 0;
    return true;
  }
  if (v->IsSharedArrayBuffer()) {  // WebGL2's AllowSharedBufferSource (bufferData / bufferSubData)
    std::shared_ptr<v8::BackingStore> bs = v.As<v8::SharedArrayBuffer>()->GetBackingStore();
    out.isNull = false; out.data = (uint8_t*)bs->Data(); out.len = out.data ? bs->ByteLength() : 0;
    return true;
  }
  if (allowNull && v->IsNullOrUndefined()) return true;
  typeError(iso, allowNull ? "WebGL: expected an ArrayBufferView, ArrayBuffer or null" : "WebGL: expected an ArrayBufferView or ArrayBuffer");
  return false;
}
inline bool argView(const Args& a, int i, View& out, bool allowNull = false) {
  if (i >= a.Length()) {
    out = View();
    if (allowNull) return true;
    typeError(a.GetIsolate(), "WebGL: missing ArrayBufferView argument"); return false;
  }
  return readView(a.GetIsolate(), a[i], out, allowNull);
}

// Applies WebGL2's (srcOffset, srcLength) element window to a view: advances
// the pointer by srcOffset elements and cuts the length to srcLength elements
// (0 / absent = the rest). Out of range is INVALID_VALUE (WebGL2 spec 3.7.x),
// not an exception: the error is raised and false returned, so the caller
// skips the GL call. A non-number offset is a TypeError (false, exception pending).
inline bool windowRaw(View& v, double off, double len) {
  if (!(off >= 0) || !(len >= 0)) { synthError(GL_INVALID_VALUE); return false; }  // negative or NaN
  if (off * (double)v.elem > (double)v.len) { synthError(GL_INVALID_VALUE); return false; }
  size_t offB = (size_t)off * v.elem;
  if (v.data) v.data += offB;
  v.len -= offB;
  if (len > 0) {
    if (len * (double)v.elem > (double)v.len) { synthError(GL_INVALID_VALUE); return false; }
    v.len = (size_t)len * v.elem;
  }
  return true;
}
inline bool window(const Args& a, View& v, int offIdx, int lenIdx) {
  double off = 0, len = 0;
  if (!argNum(a, offIdx, off)) return false;
  if (lenIdx >= 0 && !argNum(a, lenIdx, len)) return false;
  return windowRaw(v, off, len);
}

// A typed array of exactly this kind (the JS pass-throughs convert anything else
// — an Array, a Float64Array — the way WebIDL's Float32List / Int32List do).
enum class TA : uint8_t { Float32Array, Int32Array, Uint32Array };
inline bool argTyped(const Args& a, int i, View& out, TA kind) {
  bool ok = false;
  if (i < a.Length()) {
    v8::Local<v8::Value> v = a[i];
    ok = kind == TA::Float32Array ? v->IsFloat32Array() : kind == TA::Int32Array ? v->IsInt32Array() : v->IsUint32Array();
  }
  if (!ok) {
    typeError(a.GetIsolate(), kind == TA::Float32Array ? "WebGL: expected a Float32Array" : kind == TA::Int32Array ? "WebGL: expected an Int32Array" : "WebGL: expected a Uint32Array");
    return false;
  }
  return readView(a.GetIsolate(), a[i], out, false);
}
// uniform*v / uniformMatrix*v: the (windowed) data must be a non-empty whole number of uniform elements (WebGL 5.14.10).
inline bool wholeElements(const View& v, size_t bytesPer) {
  if (v.len == 0 || v.len % bytesPer) { synthError(GL_INVALID_VALUE); return false; }
  return true;
}
// Fast-API twin of argTyped + window + wholeElements: element span [off, off+len) (len 0 = rest), a
// non-empty multiple of `per`. false = let the slow callback handle it (and raise the error).
#if HOST_FAST_API
template <typename T>
inline bool fastSpan(const v8::FastApiTypedArray<T>& d, uint32_t off, uint32_t len, size_t per, T*& e, size_t& n) {
  size_t total = d.length();
  if (off > total) return false;
  size_t avail = total - off;
  n = len ? len : avail;
  if (n == 0 || n > avail || n % per) return false;
  T* base; if (!d.getStorageIfAligned(&base)) return false;
  e = base + off; return true;
}
#endif

// Defines obj[name] as a native function. With `fast`, TurboFan may call that C function directly
// from optimized code (V8 fast API calls); `length` is the JS arity the pass-through always passes.
inline void installFn(v8::Local<v8::Context> ctx, v8::Local<v8::Object> obj, const char* name, v8::FunctionCallback cb,
                      const v8::CFunction* fast = nullptr, int length = 0) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(iso, cb, v8::Local<v8::Value>(), v8::Local<v8::Signature>(), length,
                                                                v8::ConstructorBehavior::kThrow, v8::SideEffectType::kHasSideEffect, fast);
  v8::Local<v8::Function> f = t->GetFunction(ctx).ToLocalChecked();
  v8::Local<v8::String> n = str(iso, name);
  f->SetName(n);
  obj->Set(ctx, n, f).Check();
}

// Reads a JS Array (or typed array) of numbers into a fixed buffer; returns the count or -1 on error.
template <typename T>
inline int readNumArray(const Args& a, int i, T* out, int cap) {
  v8::Isolate* iso = a.GetIsolate(); v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (i >= a.Length()) { typeError(iso, "WebGL: expected a sequence"); return -1; }
  v8::Local<v8::Value> v = a[i];
  if (v->IsArrayBufferView()) {
    View w; if (!readView(iso, v, w, false)) return -1;
    size_t n = w.elem ? w.len / w.elem : 0; if ((int)n > cap) n = cap;
    if (v->IsFloat32Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((float*)w.data)[k];
    else if (v->IsFloat64Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((double*)w.data)[k];
    else if (v->IsInt32Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((int32_t*)w.data)[k];
    else if (v->IsUint32Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((uint32_t*)w.data)[k];
    else if (v->IsInt16Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((int16_t*)w.data)[k];
    else if (v->IsUint16Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((uint16_t*)w.data)[k];
    else if (v->IsInt8Array()) for (size_t k = 0; k < n; k++) out[k] = (T)((int8_t*)w.data)[k];
    else for (size_t k = 0; k < n; k++) out[k] = (T)w.data[k];
    return (int)n;
  }
  if (!v->IsArray()) { typeError(iso, "WebGL: expected a sequence"); return -1; }
  v8::Local<v8::Array> arr = v.As<v8::Array>();
  uint32_t n = arr->Length(); if ((int)n > cap) n = cap;
  for (uint32_t k = 0; k < n; k++) {
    v8::Local<v8::Value> e; if (!arr->Get(ctx, k).ToLocal(&e)) return -1;
    double d = 0; if (e->IsNumber()) d = e.As<v8::Number>()->Value(); else if (!e->IsNullOrUndefined()) { typeError(iso, "WebGL: sequence element must be a number"); return -1; }
    out[k] = (T)(int64_t)d;
  }
  return (int)n;
}

inline void ret(const Args& a, double v) { a.GetReturnValue().Set(v); }
inline void retI(const Args& a, int32_t v) { a.GetReturnValue().Set(v); }
inline void retU(const Args& a, uint32_t v) { a.GetReturnValue().Set(v); }
inline void retB(const Args& a, bool v) { a.GetReturnValue().Set(v); }

// GLsync is a pointer; JS holds a small integer handle into this table.
GLsync syncGet(uint32_t handle);
uint32_t syncAdd(GLsync s);
void syncRemove(uint32_t handle);

// Extension entry points, resolved once in installWebGL (null when absent).
struct ExtFns {
  PFNGLFRAMEBUFFERTEXTUREMULTIVIEWOVRPROC framebufferTextureMultiviewOVR = nullptr;
  PFNGLFRAMEBUFFERTEXTUREMULTISAMPLEMULTIVIEWOVRPROC framebufferTextureMultisampleMultiviewOVR = nullptr;
  PFNGLRENDERBUFFERSTORAGEMULTISAMPLEEXTPROC renderbufferStorageMultisampleEXT = nullptr;
  PFNGLFRAMEBUFFERTEXTURE2DMULTISAMPLEEXTPROC framebufferTexture2DMultisampleEXT = nullptr;
  PFNGLQUERYCOUNTEREXTPROC queryCounterEXT = nullptr;
  PFNGLGETQUERYOBJECTUI64VEXTPROC getQueryObjectui64vEXT = nullptr;
  PFNGLGETQUERYOBJECTUIVEXTPROC getQueryObjectuivEXT = nullptr;
  PFNGLGETQUERYIVEXTPROC getQueryivEXT = nullptr;
  PFNGLCLIPCONTROLEXTPROC clipControlEXT = nullptr;
  PFNGLENABLEIOESPROC enableiOES = nullptr;
  PFNGLDISABLEIOESPROC disableiOES = nullptr;
  PFNGLBLENDEQUATIONIOESPROC blendEquationiOES = nullptr;
  PFNGLBLENDEQUATIONSEPARATEIOESPROC blendEquationSeparateiOES = nullptr;
  PFNGLBLENDFUNCIOESPROC blendFunciOES = nullptr;
  PFNGLBLENDFUNCSEPARATEIOESPROC blendFuncSeparateiOES = nullptr;
  PFNGLCOLORMASKIOESPROC colorMaskiOES = nullptr;
  PFNGLMULTIDRAWELEMENTSINDIRECTEXTPROC multiDrawElementsIndirectEXT = nullptr;  // GL_EXT_multi_draw_indirect
  PFNGLMULTIDRAWARRAYSINDIRECTEXTPROC multiDrawArraysIndirectEXT = nullptr;
  PFNGLBUFFERSTORAGEEXTPROC bufferStorageEXT = nullptr;                          // GL_EXT_buffer_storage
};
extern ExtFns ext;

// Kind of value getParameter(pname) returns, from the table (webgl_bind.gen.cpp).
enum class ParamKind : uint8_t { Unknown, Bool, Int, Uint, Float, Int2, Int4, Float2, Float4, Bool4, String, Int64, CompressedFormats };
ParamKind paramKind(GLenum pname);

// Installs every generated entry point on `gl`. `has(name)` says whether the driver reports a GL extension.
void installGeneratedGL(v8::Local<v8::Context> ctx, v8::Local<v8::Object> gl, bool (*has)(const char*));
int generatedFunctionCount();
// The GL thread's decoder for the generated commands (gl_queue.h): runs one, returns its length in words.
uint32_t execQueued(const uint32_t* cmd);
int generatedFastCount();  // entry points with a V8 fast-API C function

}  // namespace wgl
}  // namespace host
