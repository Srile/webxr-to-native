// Desktop host entry (experimental): a GLFW window whose CAMetalLayer ANGLE renders into, and the host loop.
//   webxrhost-mac <staged assets dir> [--files <dir>] [--size WxH]
// tools/mac.mjs stages the assets (the same tree pack.mjs puts in the APK), builds and runs this. The host
// itself is emu/ (shared with win/ and ios/); this file is the window, and glfw_input the controls. Inside an
// app bundle (mac.mjs --app) it takes no arguments: the assets are Contents/Resources/assets, the files
// (localStorage) live in ~/Library/Application Support/<bundle id>, and the log goes to host.log there.
#define GLFW_INCLUDE_NONE
#define GLFW_EXPOSE_NATIVE_COCOA
#include <GLFW/glfw3.h>
#include <GLFW/glfw3native.h>
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include "emu/glfw_input.h"
#include "emu/host_emu.h"
#include "core/log.h"

int main(int argc, char** argv) {
  std::string assets, files; int w = 1280, h = 800;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--files") && i + 1 < argc) files = argv[++i];
    else if (!strcmp(argv[i], "--size") && i + 1 < argc) sscanf(argv[++i], "%dx%d", &w, &h);
    else assets = argv[i];
  }
  NSBundle* bundle = [NSBundle mainBundle];
  if (assets.empty() && bundle.bundleIdentifier) {
    assets = std::string(bundle.resourcePath.UTF8String) + "/assets";
    if (files.empty()) {
      NSURL* support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
      files = std::string(support.path.UTF8String) + "/" + bundle.bundleIdentifier.UTF8String;
    }
  }
  if (assets.empty()) { fprintf(stderr, "usage: webxrhost-mac <assets dir> [--files <dir>] [--size WxH]\n"); return 2; }
  if (files.empty()) files = assets + "/../files";
  [NSFileManager.defaultManager createDirectoryAtPath:[NSString stringWithUTF8String:files.c_str()] withIntermediateDirectories:YES attributes:nil error:nil];
  if (!isatty(STDERR_FILENO)) freopen((files + "/host.log").c_str(), "w", stderr);  // started from Finder: no terminal to log to
  setvbuf(stderr, nullptr, _IOLBF, 0);  // a reopened stderr is block-buffered: a crash would take the log's tail with it
  signal(SIGPIPE, SIG_IGN);  // the inspector's sockets: a closed DevTools tab must not kill the host

  if (!glfwInit()) { HOST_LOGE("glfwInit failed"); return 1; }
  glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);  // ANGLE owns the context; GLFW only makes the window
  GLFWwindow* win = glfwCreateWindow(w, h, "webxr-host (emulated headset)", nullptr, nullptr);
  if (!win) { HOST_LOGE("window creation failed"); return 1; }
  NSWindow* nsw = glfwGetCocoaWindow(win);
  CAMetalLayer* layer = [CAMetalLayer layer];
  layer.contentsScale = nsw.backingScaleFactor;
  nsw.contentView.wantsLayer = YES; nsw.contentView.layer = layer;
  host::emu::setWindow(win);

  int code = 0;
  {
    host::Host app(assets, files);
    if (!app.start((__bridge void*)layer)) { HOST_LOGE("host start failed"); code = 1; }
    else {
      std::string title = app.config().at("app").s("name", "webxr-host") + " — emulated headset (right-drag look, WASD walk, click trigger)";
      glfwSetWindowTitle(win, title.c_str());
      while (!glfwWindowShouldClose(win)) {
        glfwPollEvents();
        if (glfwGetWindowAttrib(win, GLFW_ICONIFIED)) glfwWaitEventsTimeout(1.0 / 60);  // minimised: no vsync to wait for
        if (!app.tick()) break;
      }
    }
  }
  glfwDestroyWindow(win); glfwTerminate();
  // No static destructors: the bindings keep v8::Global records at file scope, and V8 is not torn down (~Host).
  fflush(nullptr); _exit(code);
}
