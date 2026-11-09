#pragma once
// The iOS host's view (ios/touch_input.mm): its layer is what the host renders into, a CAMetalLayer for ANGLE
// (gl/egl.cpp) or a CAEAGLLayer for Apple's GLES (ios/egl_eagl.mm),
// and its touches, with a hardware keyboard when one is attached, drive the emulated headset (emu.h's hooks):
//
//   one finger      aim the hand at it and hold its trigger (a tap is a click)
//   two fingers     drag to look around
//   three fingers   tap: menu button (left controller)
//   keyboard        the desktop map in emu.h (WASD walk, F squeeze, arrows thumbstick, Tab, V, O, R, ...)
#import <UIKit/UIKit.h>

@interface HostView : UIView
@end

namespace host {
namespace emu {
void setCloseRequested();  // the loop's own exit (ios/main.mm)
}
}  // namespace host
