#pragma once
// The display's refresh on iOS (ios/vsync.mm), for whichever GL the host runs on (ANGLE, gl/egl.cpp; Apple's GLES,
// ios/egl_eagl.mm): the frame loop presents, then waits here for the next refresh.
namespace host {
namespace ios {
void startVsync();  // on the main thread, once
void waitVsync();   // runs the main run loop until the next refresh (50 ms at most)
}  // namespace ios
}  // namespace host
