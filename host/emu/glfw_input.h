#pragma once
// emu.h's platform hooks over a GLFW window (mac/, win/ and linux/): mouse and keyboard, the map in emu.h.
struct GLFWwindow;
namespace host {
namespace emu {
void setWindow(GLFWwindow* w);
}
}  // namespace host
