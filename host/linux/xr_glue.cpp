// webxrhost-linux-xr (WP-18b): the Quest's OpenXrDevice (xr/openxr_device.cpp) on the desktop's OpenXR runtime
// (Monado, or WiVRn streaming to a Quest) in place of the emulated headset. emu_xr.cpp is not in this build, so the
// two emu.h hooks the emu host calls on the device side are defined here: the splash overlay is drawn by the
// host's own window mirror (emu/host_emu.cpp mirrorToWindow), and no xr section of host.json is device-specific.
#include "emu/emu.h"

namespace host {
namespace emu {
void setPresentOverlay(std::function<void(int, int)>) {}
void setConfig(const Json*) {}
}  // namespace emu
}  // namespace host
