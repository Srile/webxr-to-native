#pragma once
// The phone build's host thread (WP-20): the host outlives its activity.
//
// Android recreates an activity when the theme's resource overlays change (config change 0x80000000, which no
// manifest can claim): after boot, and when a wallpaper change picks new system colours. V8 starts once per
// process, so a host bound to its activity (the Quest's android_main) could only close the app then. On a phone the
// host runs on a thread of its own for the life of the process; each activity's android_main hands it the window,
// the input and the lifecycle, and a recreated activity attaches to the running host: the page carries on.
//
// The window is handed over synchronously (Android waits for the old surface to be released before it goes on),
// and so is every other lifecycle step; input is copied and queued. The Quest keeps its single thread: its OpenXR
// session belongs to the activity.
struct android_app;

namespace host::phone {
extern bool g_entry;              // set by the phone manifest's entry (phone_entry.cpp)
void androidMain(android_app* app);  // android_main for the phone entry
}  // namespace host::phone
