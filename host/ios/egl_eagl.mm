// gl/egl.h's Egl on iOS: Apple's OpenGL ES 3.0 (EAGL) in place of EGL, which iOS does not have. The window
// is a framebuffer object whose colour renderbuffer is the view's CAEAGLLayer; the pbuffer is a 16x16 one.
// Framebuffer 0 means whichever of the two is current (ios/gl_ios.h maps it). swap() presents and then waits
// for the display's next refresh (ios/vsync.mm), as eglSwapBuffers does with a swap interval of 1. Also here:
// eglGetProcAddress for the WebGL binding's extensions. The fallback when ANGLE is not there (tools/setup-ios.sh):
// Apple's GLES in the simulator is a software renderer.
// visionOS (TARGET_OS_VISION): the xros SDK ships OpenGLES.framework and EAGL, but QuartzCore's CAEAGLLayer is
// API_UNAVAILABLE(visionos), so there is no drawable to present to. The window is then a plain FBO whose colour
// is read back after each frame and handed to the view's CALayer as a CGImage (a copy per frame: the WP-17 spike's
// flat path, enough to learn whether GLES runs there at all; the immersive host renders into an IOSurface).
#include "gl/egl.h"
#include "core/log.h"
#include "ios/vsync.h"
#include "gl/pack_guard.h"
#import <OpenGLES/EAGL.h>
#import <OpenGLES/EAGLDrawable.h>
#import <QuartzCore/QuartzCore.h>
#include <TargetConditionals.h>
#include <dlfcn.h>
#include <vector>
#include <algorithm>
#include <cstring>
#undef glBindFramebuffer
#undef glGetIntegerv
#undef glReadBuffer
#undef glDrawBuffers
#undef glInvalidateFramebuffer

namespace {
EAGLContext* g_ctx = nil;
#if TARGET_OS_VISION
CALayer* g_layer = nil;
std::vector<uint8_t> g_pixels;                           // the readback (allocated with the window)
#else
CAEAGLLayer* g_layer = nil;
#endif
GLuint g_pbFbo = 0, g_pbColor = 0;                       // the "pbuffer"
GLuint g_winFbo = 0, g_winColor = 0, g_winDepth = 0;      // the window
GLuint g_default = 0;                                     // what framebuffer 0 means now
int g_winW = 0, g_winH = 0;
CGSize g_layerSize = {0, 0}; CGFloat g_layerScale = 0;  // what the storage was allocated for

// Rebind framebuffer 0's targets to the new default where they had the old one.
void switchDefault(GLuint to) {
  if (g_default == to) return;
  GLint draw = 0, read = 0; glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw); glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
  if ((GLuint)draw == g_default) glBindFramebuffer(GL_DRAW_FRAMEBUFFER, to);
  if ((GLuint)read == g_default) glBindFramebuffer(GL_READ_FRAMEBUFFER, to);
  g_default = to;
}

// (Re)allocate the window's storage at the layer's current pixel size. False if it is not complete.
bool allocWindow() {
  GLint prevRb = 0; glGetIntegerv(GL_RENDERBUFFER_BINDING, &prevRb);
  GLint prevDraw = 0; glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  glBindRenderbuffer(GL_RENDERBUFFER, g_winColor);
  g_layerSize = g_layer.bounds.size; g_layerScale = g_layer.contentsScale;
#if TARGET_OS_VISION
  g_winW = std::max(1, (int)lround(g_layerSize.width * g_layerScale)); g_winH = std::max(1, (int)lround(g_layerSize.height * g_layerScale));
  glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, g_winW, g_winH);
  g_pixels.assign((size_t)g_winW * g_winH * 4, 0);
#else
  if (![g_ctx renderbufferStorage:GL_RENDERBUFFER fromDrawable:g_layer]) { HOST_LOGE("renderbufferStorage:fromDrawable failed"); return false; }
  glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH, &g_winW); glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_HEIGHT, &g_winH);
#endif
  glBindRenderbuffer(GL_RENDERBUFFER, g_winDepth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, g_winW, g_winH);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_winFbo);
  glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, g_winColor);
  glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g_winDepth);
  GLenum st = glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw); glBindRenderbuffer(GL_RENDERBUFFER, (GLuint)prevRb);
  if (st != GL_FRAMEBUFFER_COMPLETE) { HOST_LOGE("window framebuffer incomplete 0x%x", st); return false; }
  return true;
}

#if TARGET_OS_VISION
// The window's pixels into the layer: rows flipped (GL is bottom-up), as a CGImage over a copy of the readback.
void presentReadback() {
  host::PackGuard pack;  // the page may leave a pack buffer bound (gl/pack_guard.h)
  GLint prevRead = 0; glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, g_winFbo);
  glReadPixels(0, 0, g_winW, g_winH, GL_RGBA, GL_UNSIGNED_BYTE, g_pixels.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  const size_t row = (size_t)g_winW * 4;
  CFMutableDataRef data = CFDataCreateMutable(nullptr, (CFIndex)(row * g_winH));
  CFDataSetLength(data, (CFIndex)(row * g_winH));
  uint8_t* dst = CFDataGetMutableBytePtr(data);
  for (int y = 0; y < g_winH; ++y) memcpy(dst + (size_t)y * row, g_pixels.data() + (size_t)(g_winH - 1 - y) * row, row);
  CGDataProviderRef prov = CGDataProviderCreateWithCFData(data);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGImageRef img = CGImageCreate(g_winW, g_winH, 8, 32, row, cs, kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big, prov, nullptr, false, kCGRenderingIntentDefault);
  [CATransaction begin]; [CATransaction setDisableActions:YES];
  g_layer.contents = (__bridge id)img;
  [CATransaction commit];
  CGImageRelease(img); CGColorSpaceRelease(cs); CGDataProviderRelease(prov); CFRelease(data);
}
#endif
}  // namespace

extern "C" {
void hostIosBindFramebuffer(GLenum target, GLuint fb) { glBindFramebuffer(target, fb ? fb : g_default); }
void hostIosGetIntegerv(GLenum pname, GLint* data) {
  glGetIntegerv(pname, data);
  if ((pname == GL_DRAW_FRAMEBUFFER_BINDING || pname == GL_READ_FRAMEBUFFER_BINDING) && g_default && (GLuint)*data == g_default) *data = 0;
}
// The default framebuffer's GL_BACK is our object's first colour attachment.
static GLint boundDefault(GLenum binding) { GLint b = 0; glGetIntegerv(binding, &b); return g_default && (GLuint)b == g_default; }
void hostIosReadBuffer(GLenum src) { glReadBuffer(src == GL_BACK && boundDefault(GL_READ_FRAMEBUFFER_BINDING) ? GL_COLOR_ATTACHMENT0 : src); }
void hostIosDrawBuffers(GLsizei n, const GLenum* bufs) {
  if (n == 1 && bufs[0] == GL_BACK && boundDefault(GL_DRAW_FRAMEBUFFER_BINDING)) { const GLenum c = GL_COLOR_ATTACHMENT0; glDrawBuffers(1, &c); return; }
  glDrawBuffers(n, bufs);
}
void hostIosInvalidateFramebuffer(GLenum target, GLsizei n, const GLenum* att) {
  const GLenum binding = target == GL_READ_FRAMEBUFFER ? GL_READ_FRAMEBUFFER_BINDING : GL_DRAW_FRAMEBUFFER_BINDING;
  if (!boundDefault(binding) || n > 8) { glInvalidateFramebuffer(target, n, att); return; }
  GLenum mapped[8];
  for (GLsizei i = 0; i < n; ++i) mapped[i] = att[i] == GL_COLOR ? GL_COLOR_ATTACHMENT0 : att[i] == GL_DEPTH ? GL_DEPTH_ATTACHMENT : att[i] == GL_STENCIL ? GL_STENCIL_ATTACHMENT : att[i];
  glInvalidateFramebuffer(target, n, mapped);
}
// ES 3.2 entry points OpenGLES.framework (ES 3.0) does not export. The binding takes them only on a 3.2 context
// (webgl_bind.cpp loadExtensions), so on iOS they are never reached; the indexed query reports nothing.
void glEnablei(GLenum, GLuint) {}
void glDisablei(GLenum, GLuint) {}
GLboolean glIsEnabledi(GLenum, GLuint) { return GL_FALSE; }
void glBlendEquationi(GLuint, GLenum) {}
void glBlendEquationSeparatei(GLuint, GLenum, GLenum) {}
void glBlendFunci(GLuint, GLenum, GLenum) {}
void glBlendFuncSeparatei(GLuint, GLenum, GLenum, GLenum, GLenum) {}
void glColorMaski(GLuint, GLboolean, GLboolean, GLboolean, GLboolean) {}
void glGetBooleani_v(GLenum, GLuint, GLboolean* data) { if (data) data[0] = data[1] = data[2] = data[3] = GL_FALSE; }
// The WebGL binding resolves extension entry points by name: they are exported by OpenGLES.framework, if at all.
__eglMustCastToProperFunctionPointerType eglGetProcAddress(const char* name) { return (__eglMustCastToProperFunctionPointerType)dlsym(RTLD_DEFAULT, name); }
}

namespace host {

bool Egl::init() {
  g_ctx = [[EAGLContext alloc] initWithAPI:kEAGLRenderingAPIOpenGLES3];
  if (!g_ctx) { HOST_LOGE("EAGL: initWithAPI:kEAGLRenderingAPIOpenGLES3 returned nil"); return false; }
  if (![EAGLContext setCurrentContext:g_ctx]) { HOST_LOGE("EAGL: setCurrentContext failed"); return false; }
  display_ = (EGLDisplay)(__bridge void*)g_ctx; context_ = (EGLContext)(__bridge void*)g_ctx;  // non-null: "up"
  HOST_LOGI("EAGL (OpenGL ES 3.0)%s", TARGET_OS_VISION ? " on visionOS, window presented by readback" : "");
  glGenFramebuffers(1, &g_pbFbo); glGenRenderbuffers(1, &g_pbColor);
  glBindRenderbuffer(GL_RENDERBUFFER, g_pbColor); glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, 16, 16);
  glBindFramebuffer(GL_FRAMEBUFFER, g_pbFbo); glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, g_pbColor);
  glBindRenderbuffer(GL_RENDERBUFFER, 0);
  g_default = g_pbFbo;
  glExtensions_ = (const char*)glGetString(GL_EXTENSIONS);
  HOST_LOGI("GL %s | %s | %s", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION));
  HOST_LOGI("GL ext count %d, multiview2 %d, msaa-multiview %d, multi_draw_indirect %d",
            (int)std::count(glExtensions_.begin(), glExtensions_.end(), ' '),
            hasExtension("GL_OVR_multiview2"), hasExtension("GL_OVR_multiview_multisampled_render_to_texture"), hasExtension("GL_EXT_multi_draw_indirect"));
  ios::startVsync();
  return true;
}

bool Egl::hasExtension(const char* name) const {
  size_t n = strlen(name); size_t pos = 0;
  while ((pos = glExtensions_.find(name, pos)) != std::string::npos) {
    bool startOk = pos == 0 || glExtensions_[pos - 1] == ' ';
    bool endOk = pos + n == glExtensions_.size() || glExtensions_[pos + n] == ' ';
    if (startOk && endOk) return true; pos += n;
  }
  return false;
}

bool Egl::makeCurrent() { [EAGLContext setCurrentContext:g_ctx]; switchDefault(g_pbFbo); return true; }
bool Egl::makeCurrentPreferred() { [EAGLContext setCurrentContext:g_ctx]; switchDefault(g_winFbo ? g_winFbo : g_pbFbo); return true; }

// `win` is the view's CAEAGLLayer (ios/main.mm); on visionOS its plain CALayer.
bool Egl::bindWindow(ANativeWindow* win) {
  unbindWindow();
#if TARGET_OS_VISION
  g_layer = (__bridge CALayer*)(void*)win;
  g_layer.opaque = YES;
  g_layer.contentsGravity = kCAGravityResize;
#else
  g_layer = (__bridge CAEAGLLayer*)(void*)win;
  g_layer.opaque = YES;
  g_layer.drawableProperties = @{kEAGLDrawablePropertyRetainedBacking: @NO, kEAGLDrawablePropertyColorFormat: kEAGLColorFormatRGBA8};
#endif
  glGenFramebuffers(1, &g_winFbo); glGenRenderbuffers(1, &g_winColor); glGenRenderbuffers(1, &g_winDepth);
  if (!allocWindow()) { unbindWindow(); return false; }
  winW_ = g_winW; winH_ = g_winH; window_ = (EGLSurface)(__bridge void*)g_layer;
  makeCurrentPreferred();
  HOST_LOGI("window surface %dx%d", winW_, winH_);
  return true;
}

void Egl::unbindWindow() {
  if (!g_winFbo) return;
  makeCurrent();
  glDeleteFramebuffers(1, &g_winFbo); glDeleteRenderbuffers(1, &g_winColor); glDeleteRenderbuffers(1, &g_winDepth);
  g_winFbo = g_winColor = g_winDepth = 0; g_layer = nil; window_ = EGL_NO_SURFACE; winW_ = winH_ = 0;
}

void Egl::swap() {
  if (!g_winFbo) return;
#if TARGET_OS_VISION
  presentReadback();
#else
  GLint prevRb = 0; glGetIntegerv(GL_RENDERBUFFER_BINDING, &prevRb);
  glBindRenderbuffer(GL_RENDERBUFFER, g_winColor);
  [g_ctx presentRenderbuffer:GL_RENDERBUFFER];
  glBindRenderbuffer(GL_RENDERBUFFER, (GLuint)prevRb);
#endif
  // The view resizes (rotation, iPad multitasking) under the surface: the next frame draws at the new size.
  // Compared as the layer's own size and scale: its pixel size is rounded by Core Animation (scale 2.88, 2.608).
  if (!CGSizeEqualToSize(g_layer.bounds.size, g_layerSize) || g_layer.contentsScale != g_layerScale) { allocWindow(); winW_ = g_winW; winH_ = g_winH; }
  ios::waitVsync();
}

void Egl::shutdown() {
  if (!g_ctx) return;
  unbindWindow();
  if (g_pbFbo) { glDeleteFramebuffers(1, &g_pbFbo); glDeleteRenderbuffers(1, &g_pbColor); g_pbFbo = g_pbColor = 0; }
  [EAGLContext setCurrentContext:nil]; g_ctx = nil; g_default = 0;
  display_ = EGL_NO_DISPLAY; context_ = EGL_NO_CONTEXT;
}

}  // namespace host
