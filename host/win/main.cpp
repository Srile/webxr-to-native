// Windows host entry (experimental): a GLFW window whose HWND ANGLE renders into (Direct3D 11), and the host loop.
//   webxrhost-win <staged assets dir> [--files <dir>] [--size WxH]
// tools/win.mjs stages the assets (the same tree pack.mjs puts in the APK), builds and runs this. The host itself
// is emu/ (shared with mac/ and ios/); this file is the window, and glfw_input the controls. Packaged (win.mjs
// --app) it takes no arguments: the assets are assets\ next to the executable, the files (localStorage) live in
// %LOCALAPPDATA%\<package>, and the log goes to host.log there.
#define GLFW_INCLUDE_NONE
#define GLFW_EXPOSE_NATIVE_WIN32
#include <GLFW/glfw3.h>
#include <GLFW/glfw3native.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <timeapi.h>
#include <io.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "emu/glfw_input.h"
#include "emu/host_emu.h"
#include "core/fs.h"
#include "core/json.h"
#include "core/log.h"

namespace {
std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0'); WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr); return s;
}
std::wstring exeDirW() { wchar_t p[MAX_PATH * 4]; DWORD n = GetModuleFileNameW(nullptr, p, (DWORD)(sizeof p / sizeof *p)); return std::filesystem::path(std::wstring(p, n)).parent_path().wstring(); }
std::string exeDir() { return utf8(exeDirW()); }
// V8's ICU data, copied next to the executable (build and package alike). V8 opens it with a narrow fopen (the
// ANSI code page), so the path goes as its 8.3 short form, which is ASCII whatever the user's name is.
std::string icuNextToExe() {
  std::wstring p = exeDirW() + L"\\icudtl.dat";
  if (GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) return {};
  wchar_t s[MAX_PATH * 4]; DWORD n = GetShortPathNameW(p.c_str(), s, (DWORD)(sizeof s / sizeof *s));
  return utf8(n > 0 && n < sizeof s / sizeof *s ? std::wstring(s, n) : p);
}
}  // namespace

int main(int argc, char** argv) {
  // Arguments as UTF-8: argv is the ANSI code page.
  std::vector<std::string> args;
  { int n = 0; LPWSTR* w = CommandLineToArgvW(GetCommandLineW(), &n); for (int i = 1; i < n; ++i) args.push_back(utf8(w[i])); LocalFree(w); }
  std::string assets, files; int w = 1280, h = 800;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == "--files" && i + 1 < args.size()) files = args[++i];
    else if (args[i] == "--size" && i + 1 < args.size()) sscanf(args[++i].c_str(), "%dx%d", &w, &h);
    else assets = args[i];
  }
  const bool packaged = assets.empty();
  if (packaged) {
    assets = exeDir() + "\\assets";
    if (files.empty()) {
      // %LOCALAPPDATA%\<package>: the package name from the staged host.json.
      std::string pkg = "webxr-host", text;
      { std::ifstream f(host::fsPath(assets + "\\host.json"), std::ios::binary); std::stringstream ss; ss << f.rdbuf(); text = ss.str(); }
      if (!text.empty()) pkg = host::Json::parse(text).at("app").s("package", pkg);
      PWSTR local = nullptr;
      if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) { files = utf8(local) + "\\" + pkg; CoTaskMemFree(local); }
    }
  }
  if (assets.empty() || files.empty()) { fprintf(stderr, "usage: webxrhost-win <assets dir> [--files <dir>] [--size WxH]\n"); return 2; }
  { std::error_code ec; std::filesystem::create_directories(host::fsPath(files), ec); }
  // A GUI-subsystem build (the packaged one) has no console: the log goes to a file.
  if (!_isatty(_fileno(stderr))) _wfreopen(host::fsPath(files + "\\host.log").c_str(), L"w", stderr);
  setvbuf(stderr, nullptr, _IONBF, 0);
  timeBeginPeriod(1);  // the loop's short sleeps (emu/host_emu.cpp) would otherwise round up to the 15.6 ms tick

  if (!glfwInit()) { HOST_LOGE("glfwInit failed"); return 1; }
  glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);  // ANGLE owns the context; GLFW only makes the window
  GLFWwindow* win = glfwCreateWindow(w, h, "webxr-host (emulated headset)", nullptr, nullptr);
  if (!win) { HOST_LOGE("window creation failed"); return 1; }
  host::emu::setWindow(win);

  int code = 0;
  {
    host::Host app(assets, files);
    app.icuData = icuNextToExe();
    if (!app.start((void*)glfwGetWin32Window(win))) { HOST_LOGE("host start failed"); code = 1; }
    else {
      std::string title = app.config().at("app").s("name", "webxr-host") + " - emulated headset (right-drag look, WASD walk, click trigger)";
      glfwSetWindowTitle(win, title.c_str());
      while (!glfwWindowShouldClose(win)) {
        glfwPollEvents();
        // Minimised, a present returns at once (nothing to wait for): hold the loop to the display's rate.
        if (glfwGetWindowAttrib(win, GLFW_ICONIFIED)) glfwWaitEventsTimeout(1.0 / 60);
        if (!app.tick()) break;
      }
    }
  }
  glfwDestroyWindow(win); glfwTerminate();
  // No static destructors: the bindings keep v8::Global records at file scope, and V8 is not torn down (emu/host_emu.cpp).
  fflush(nullptr); _exit(code);
}
