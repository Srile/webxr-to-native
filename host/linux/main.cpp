// Linux host entry (experimental, WP-18): a GLFW window on X11 (XWayland on a Wayland session) whose window id the
// system's EGL renders into (Mesa or NVIDIA GLES 3.2, no ANGLE), and the host loop.
//   webxrhost-linux <staged assets dir> [--files <dir>] [--size WxH]
// tools/linux.mjs stages the assets (the same tree pack.mjs puts in the APK), builds and runs this. The host itself
// is emu/ (shared with mac/, win/ and ios/); this file is the window, and glfw_input the controls. Packaged
// (linux.mjs --app) it takes no arguments: the assets are assets/ next to the executable, the files (localStorage)
// live in $XDG_DATA_HOME/<package> (~/.local/share/<package>), and the log goes to host.log there when stderr is
// not a terminal.
#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>
#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <unistd.h>
#include "emu/glfw_input.h"
#include "emu/host_emu.h"
#include "core/json.h"
#include "core/log.h"
#include "gl/egl.h"

// GLFW's X11 accessors, declared here rather than through glfw3native.h: that header pulls in Xlib.h, whose
// None/Bool/Status/Success macros break V8's headers. A Display* is a pointer and a Window an XID (unsigned long).
extern "C" void* glfwGetX11Display(void);
extern "C" unsigned long glfwGetX11Window(GLFWwindow* window);

namespace {
std::string exeDir() {
  char p[PATH_MAX]; ssize_t n = readlink("/proc/self/exe", p, sizeof p - 1);
  return n > 0 ? std::filesystem::path(std::string(p, (size_t)n)).parent_path().string() : std::string(".");
}
// $XDG_DATA_HOME/<package>, defaulting to ~/.local/share/<package> (the XDG base directory spec).
std::string xdgDataDir(const std::string& pkg) {
  const char* xdg = getenv("XDG_DATA_HOME");
  if (xdg && *xdg == '/') return std::string(xdg) + "/" + pkg;
  const char* home = getenv("HOME");
  return std::string(home && *home ? home : "/tmp") + "/.local/share/" + pkg;
}
}  // namespace

int main(int argc, char** argv) {
  std::string assets, files; int w = 1280, h = 800;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--files") && i + 1 < argc) files = argv[++i];
    else if (!strcmp(argv[i], "--size") && i + 1 < argc) sscanf(argv[++i], "%dx%d", &w, &h);
    else assets = argv[i];
  }
  const bool packaged = assets.empty();
  if (packaged) {
    assets = exeDir() + "/assets";
    if (files.empty()) {
      std::string pkg = "webxr-host", text;
      { std::ifstream f(assets + "/host.json", std::ios::binary); std::stringstream ss; ss << f.rdbuf(); text = ss.str(); }
      if (!text.empty()) pkg = host::Json::parse(text).at("app").s("package", pkg);
      files = xdgDataDir(pkg);
    }
  }
  if (!std::filesystem::exists(assets + "/host.json")) { fprintf(stderr, "usage: webxrhost-linux <assets dir> [--files <dir>] [--size WxH]\n"); return 2; }
  if (files.empty()) files = assets + "/../files";
  { std::error_code ec; std::filesystem::create_directories(files, ec); }
  if (packaged && !isatty(STDERR_FILENO)) freopen((files + "/host.log").c_str(), "w", stderr);  // started from a launcher: no terminal
  setvbuf(stderr, nullptr, _IOLBF, 0);  // line-buffered, so a crash keeps the log's tail
  signal(SIGPIPE, SIG_IGN);  // the inspector's sockets: a closed DevTools tab must not kill the host

#if GLFW_VERSION_MAJOR > 3 || (GLFW_VERSION_MAJOR == 3 && GLFW_VERSION_MINOR >= 4)
  glfwInitHint(GLFW_PLATFORM, GLFW_PLATFORM_X11);  // a 3.4 build with both backends: X11 (the EGL path below takes an XID)
#endif
  if (!glfwInit()) { HOST_LOGE("glfwInit failed (no X display? DISPLAY=%s)", getenv("DISPLAY") ? getenv("DISPLAY") : "unset"); return 1; }
  glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);  // EGL owns the context; GLFW only makes the window
  GLFWwindow* win = glfwCreateWindow(w, h, "webxr-host (emulated headset)", nullptr, nullptr);
  if (!win) { HOST_LOGE("window creation failed"); return 1; }
  host::emu::setWindow(win);
  host::Egl::setNativeDisplay(glfwGetX11Display());

  int code = 0;
  {
    host::Host app(assets, files);
    if (!app.start((void*)(uintptr_t)glfwGetX11Window(win))) { HOST_LOGE("host start failed"); code = 1; }
    else {
#ifdef HOST_XR_OPENXR
      std::string title = app.config().at("app").s("name", "webxr-host") + " - OpenXR (left eye)";
#else
      std::string title = app.config().at("app").s("name", "webxr-host") + " - emulated headset (right-drag look, WASD walk, click trigger)";
#endif
      glfwSetWindowTitle(win, title.c_str());
      while (!glfwWindowShouldClose(win)) {
        glfwPollEvents();
        if (glfwGetWindowAttrib(win, GLFW_ICONIFIED)) glfwWaitEventsTimeout(1.0 / 60);  // minimised: no vsync to wait for
        if (!app.tick()) break;
      }
    }
  }
  glfwDestroyWindow(win); glfwTerminate();
  // No static destructors: the bindings keep v8::Global records at file scope, and V8 is not torn down (emu/host_emu.cpp).
  fflush(nullptr); _exit(code);
}
