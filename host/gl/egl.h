#pragma once
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl32.h>
#include <GLES2/gl2ext.h>
#include <string>
struct ANativeWindow;

namespace host {

// One EGL display/config/context for the whole host. VR renders through a
// 16x16 pbuffer (OpenXR owns the real surfaces); the flat-panel mode binds the
// activity window instead.
class Egl {
 public:
  bool init();
  void shutdown();
  bool bindWindow(ANativeWindow* win);   // panel mode: make the window surface current
  void unbindWindow();
  bool makeCurrent();                    // pbuffer current (VR mode)
  bool makeCurrentPreferred();           // window surface when one is bound, else the pbuffer
  bool releaseCurrent();                 // no context on this thread (the GL thread takes it: gl_queue.h)
  void swap();                           // panel mode present
  int windowWidth() const { return winW_; }
  int windowHeight() const { return winH_; }
  EGLDisplay display() const { return display_; }
  EGLConfig config() const { return config_; }
  EGLContext context() const { return context_; }
  bool hasExtension(const char* name) const;
  // Linux: the window system's display (an X11 Display*), set before init() so the display is that platform's
  // (eglGetPlatformDisplay); without one init() takes EGL's default display. Ignored elsewhere.
  static void setNativeDisplay(void* display);

 private:
  EGLDisplay display_ = EGL_NO_DISPLAY;
  EGLConfig config_ = nullptr;
  EGLContext context_ = EGL_NO_CONTEXT;
  EGLSurface pbuffer_ = EGL_NO_SURFACE;
  EGLSurface window_ = EGL_NO_SURFACE;
  int winW_ = 0, winH_ = 0;
  std::string glExtensions_;
};

}  // namespace host
