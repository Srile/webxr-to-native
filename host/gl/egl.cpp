#include "gl/egl.h"
#include "core/log.h"
#ifdef __ANDROID__
#include <android/native_window.h>
#endif
#ifdef HOST_IOS_ANGLE
#include "ios/vsync.h"  // iOS over ANGLE: presents without blocking, then waits for the refresh in the run loop
#endif
#include <cstdlib>
#include <cstring>
#include <algorithm>

namespace host {

namespace { void* g_nativeDisplay = nullptr; }
void Egl::setNativeDisplay(void* display) { g_nativeDisplay = display; }

bool Egl::init() {
#ifdef __APPLE__
  // Desktop host: ANGLE on Metal (EGL_ANGLE_platform_angle_metal; the constants are ANGLE's eglext_angle.h).
  const EGLAttrib platform[] = { 0x3203 /*EGL_PLATFORM_ANGLE_TYPE_ANGLE*/, 0x3489 /*EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE*/, EGL_NONE };
  display_ = eglGetPlatformDisplay(0x3202 /*EGL_PLATFORM_ANGLE_ANGLE*/, (void*)EGL_DEFAULT_DISPLAY, platform);
#elif defined(_WIN32)
  // Windows host: ANGLE on Direct3D 11. HOST_ANGLE_DEVICE=warp picks WARP, D3D's software rasteriser (no GPU:
  // a VM, a CI runner).
  const char* dev = getenv("HOST_ANGLE_DEVICE"); const bool warp = dev && !strcmp(dev, "warp");
  const EGLAttrib platform[] = { 0x3203 /*EGL_PLATFORM_ANGLE_TYPE_ANGLE*/, 0x3208 /*EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE*/,
    0x3209 /*EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE*/, warp ? 0x320B /*D3D_WARP*/ : 0x320A /*HARDWARE*/, EGL_NONE };
  display_ = eglGetPlatformDisplay(0x3202 /*EGL_PLATFORM_ANGLE_ANGLE*/, (void*)EGL_DEFAULT_DISPLAY, platform);
#elif defined(__linux__) && !defined(__ANDROID__)
  // Linux host: the system's EGL (libglvnd: Mesa or NVIDIA) and its GLES 3.2, no ANGLE. The window is X11 (a
  // Wayland session runs it through XWayland), so the display is the X connection GLFW opened.
#ifdef HOST_LINUX_ANGLE
  // ANGLE on Vulkan (-DHOST_LINUX_ANGLE=ON), on the X display. HOST_ANGLE_DEVICE=swiftshader takes the SwiftShader
  // Vulkan ANGLE ships beside itself (no GPU, as win's warp).
  const char* dev = getenv("HOST_ANGLE_DEVICE"); const bool swift = dev && !strcmp(dev, "swiftshader");
  const EGLAttrib platform[] = { 0x3203 /*EGL_PLATFORM_ANGLE_TYPE_ANGLE*/, 0x3450 /*EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE*/,
    0x348F /*EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE*/, 0x31D5 /*EGL_PLATFORM_X11_EXT*/,
    0x3209 /*EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE*/, swift ? 0x3487 /*SWIFTSHADER*/ : 0x320A /*HARDWARE*/, EGL_NONE };
  display_ = eglGetPlatformDisplay(0x3202 /*EGL_PLATFORM_ANGLE_ANGLE*/, g_nativeDisplay ? g_nativeDisplay : (void*)EGL_DEFAULT_DISPLAY, platform);
#else
  if (g_nativeDisplay) display_ = eglGetPlatformDisplay(0x31D5 /*EGL_PLATFORM_X11_KHR*/, g_nativeDisplay, nullptr);
  else display_ = eglGetDisplay(EGL_DEFAULT_DISPLAY);
#endif
#else
  display_ = eglGetDisplay(EGL_DEFAULT_DISPLAY);
#endif
  if (display_ == EGL_NO_DISPLAY) { HOST_LOGE("eglGetDisplay failed"); return false; }
  EGLint maj, min;
  if (!eglInitialize(display_, &maj, &min)) { HOST_LOGE("eglInitialize failed 0x%x", eglGetError()); return false; }
  HOST_LOGI("EGL %d.%d", maj, min);
  // One config for pbuffer AND window: RGBA8, no depth (OpenXR swapchains and our FBOs carry their own).
  const EGLint attrs[] = {
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT | EGL_WINDOW_BIT,
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8, EGL_SAMPLES, 0, EGL_NONE };  // depth+stencil for the flat panel; XR renders into its own FBOs
  EGLint n = 0;
  if (!eglChooseConfig(display_, attrs, &config_, 1, &n) || n == 0) { HOST_LOGE("eglChooseConfig: no config"); return false; }
  const EGLint ctxAttrs[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 2, EGL_NONE };
  context_ = eglCreateContext(display_, config_, EGL_NO_CONTEXT, ctxAttrs);
  if (context_ == EGL_NO_CONTEXT) {
    const EGLint ctx31[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE };
    context_ = eglCreateContext(display_, config_, EGL_NO_CONTEXT, ctx31);
    if (context_ == EGL_NO_CONTEXT) {
      // ANGLE's Metal backend stops at ES 3.0, which is all WebGL2 needs.
      const EGLint ctx30[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE };
      context_ = eglCreateContext(display_, config_, EGL_NO_CONTEXT, ctx30);
      if (context_ == EGL_NO_CONTEXT) { HOST_LOGE("eglCreateContext failed 0x%x", eglGetError()); return false; }
      HOST_LOGW("GLES 3.2/3.1 context refused, got 3.0");
    } else HOST_LOGW("GLES 3.2 context refused, got 3.1");
  }
  const EGLint pbAttrs[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
  pbuffer_ = eglCreatePbufferSurface(display_, config_, pbAttrs);
  if (pbuffer_ == EGL_NO_SURFACE) { HOST_LOGE("eglCreatePbufferSurface failed 0x%x", eglGetError()); return false; }
  if (!makeCurrent()) return false;
  glExtensions_ = (const char*)glGetString(GL_EXTENSIONS);
  HOST_LOGI("GL %s | %s | %s", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION));
  HOST_LOGI("GL ext count %d, multiview2 %d, msaa-multiview %d, multi_draw_indirect %d",
            (int)std::count(glExtensions_.begin(), glExtensions_.end(), ' '),
            hasExtension("GL_OVR_multiview2"), hasExtension("GL_OVR_multiview_multisampled_render_to_texture"),
            hasExtension("GL_EXT_multi_draw_indirect"));
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

bool Egl::makeCurrent() {
  if (!eglMakeCurrent(display_, pbuffer_, pbuffer_, context_)) { HOST_LOGE("eglMakeCurrent(pbuffer) 0x%x", eglGetError()); return false; }
  return true;
}

bool Egl::releaseCurrent() { return display_ != EGL_NO_DISPLAY && eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT); }

bool Egl::makeCurrentPreferred() {
  if (window_ != EGL_NO_SURFACE) return eglMakeCurrent(display_, window_, window_, context_);
  return makeCurrent();
}

bool Egl::bindWindow(ANativeWindow* win) {
  unbindWindow();
#ifdef __ANDROID__
  EGLint fmt; eglGetConfigAttrib(display_, config_, EGL_NATIVE_VISUAL_ID, &fmt);
  ANativeWindow_setBuffersGeometry(win, 0, 0, fmt);
#endif
  // The emulated hosts: `win` is the window's CAMetalLayer (host/mac/main.mm, host/ios/main.mm), HWND
  // (host/win/main.cpp) or X11 Window id (host/linux/main.cpp: EGLNativeWindowType is an integer there).
  window_ = eglCreateWindowSurface(display_, config_, (EGLNativeWindowType)win, nullptr);
  if (window_ == EGL_NO_SURFACE) { HOST_LOGE("eglCreateWindowSurface 0x%x", eglGetError()); return false; }
  if (!eglMakeCurrent(display_, window_, window_, context_)) { HOST_LOGE("eglMakeCurrent(window) 0x%x", eglGetError()); return false; }
#ifdef HOST_IOS_ANGLE
  eglSwapInterval(display_, 0); host::ios::startVsync();
#endif
  eglQuerySurface(display_, window_, EGL_WIDTH, &winW_); eglQuerySurface(display_, window_, EGL_HEIGHT, &winH_);
  HOST_LOGI("window surface %dx%d", winW_, winH_);
  return true;
}

void Egl::unbindWindow() {
  if (window_ != EGL_NO_SURFACE) { makeCurrent(); eglDestroySurface(display_, window_); window_ = EGL_NO_SURFACE; winW_ = winH_ = 0; }
}

void Egl::swap() {
  if (window_ == EGL_NO_SURFACE) return;
  eglSwapBuffers(display_, window_);
#ifdef HOST_IOS_ANGLE
  host::ios::waitVsync();
#endif
  // A window resizes under the surface (a desktop window; a phone turning round or showing and hiding its system
  // bars): the next frame draws at the new size.
  eglQuerySurface(display_, window_, EGL_WIDTH, &winW_); eglQuerySurface(display_, window_, EGL_HEIGHT, &winH_);
}

void Egl::shutdown() {
  if (display_ == EGL_NO_DISPLAY) return;
  eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
  if (window_ != EGL_NO_SURFACE) eglDestroySurface(display_, window_);
  if (pbuffer_ != EGL_NO_SURFACE) eglDestroySurface(display_, pbuffer_);
  if (context_ != EGL_NO_CONTEXT) eglDestroyContext(display_, context_);
  eglTerminate(display_);
  display_ = EGL_NO_DISPLAY; context_ = EGL_NO_CONTEXT; pbuffer_ = window_ = EGL_NO_SURFACE;
}

}  // namespace host
