#pragma once
// Everything the native side hands JS. HostServices is the bag of host objects
// the bindings reach; each install* owns one namespace of __native.
#include <functional>
#include <string>
#include <v8.h>
#include "core/json.h"
#include "core/loop.h"
#include "net/assets.h"
#include "net/http.h"
#include "store/local_storage.h"

namespace host {

class Egl; class OpenXrDevice; class Engine; class Host; class CodeCache;

struct HostServices {
  Loop* loop = nullptr; Assets* assets = nullptr; Http* http = nullptr; LocalStorage* store = nullptr;
  Egl* egl = nullptr; OpenXrDevice* xr = nullptr; Engine* engine = nullptr; Host* host = nullptr;
  CodeCache* codeCache = nullptr;  // V8 code caches for the page's modules (js/code_cache.h); null: none
  const Json* config = nullptr; std::string filesDir, packageName, systemName;
  void* javaVm = nullptr; void* activity = nullptr;  // JavaVM*, jobject (the NativeActivity) for SDKs that need them
  // XR control implemented by Host (begins/ends the session loop).
  std::function<bool(const Json& opts, Json& out)> xrBegin; std::function<void()> xrEnd;
  std::function<void()> requestExit;
  // What the page is told it runs on (WP-20): "quest" (the headset, and the emulated-headset window hosts, which pass
  // for one) or "phone". pageInput: __native.input exists (js/dom_input.h); flatScaled: the window host scales the
  // page's main canvas into the window when their sizes differ.
  std::string formFactor = "quest"; bool pageInput = false, flatScaled = false;
};

// Creates __native with loop/assets/net/store/clone/log/config/info and returns it.
v8::Local<v8::Object> installNativeCore(v8::Local<v8::Context> ctx, HostServices& svc);
// The frame callback registered by the prelude (if any); Host calls these per frame.
void nativeFlatFrame(v8::Isolate* iso, v8::Local<v8::Context> ctx, double timeMs);

// Owned by other files (WP-04/05/07a/08/06); stubs until their WP lands.
void installWebGL(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
void installImages(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
void installAudio(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
void installXr(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
void shutdownWorkers();  // stop and join every worker (before the host isolate is destroyed)
void installWorkers(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
void installPlatform(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
// __native.rtc: WebSocket + WebRTC data channels (rtc/rtc_bind.cpp, WP-21); nothing in a build without HOST_WEBRTC.
void installRtc(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
// __native.steam (host/steam/steam_bind.cpp): Steamworks through the game's libsteam_api.so, for host.json steam.appId.
void installSteam(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
// __native.media: microphone capture (media/media_bind.cpp, WP-25), only in a build with HOST_MICROPHONE (host.json
// media.microphone); installed before installAudio, which then binds __native.audio.setInput to its tracks.
void installMedia(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
namespace audio { struct LiveInput; }
// The audio binding's source of capture tracks (id -> a LiveInput with one reference for the caller, or null).
void setAudioLiveInputs(audio::LiveInput* (*resolve)(uint32_t trackId));
// Remote audio tracks (rtc/rtc_bind.cpp in a build with WebRTC media: network.webrtc and media.microphone) take
// track ids from kRemoteTrackBase up; the media binding's resolver passes those to the rtc binding's.
constexpr uint32_t kRemoteTrackBase = 0x40000000u;
void setRtcLiveInputs(audio::LiveInput* (*resolve)(uint32_t trackId));
// A capture track's input, with one reference for the caller (null if unknown or ended), for what the rtc binding
// sends. Host thread only. media/media_bind.cpp, so only in a build with the microphone.
audio::LiveInput* captureInput(uint32_t trackId);
// __native.storage: IndexedDB + Cache API over SQLite (storage/storage_bind.cpp, WP-26), only in a build with
// HOST_STORAGE (host.json storage.indexedDB / storage.cache). Installed on the page's __native and on every worker's.
void installStorage(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
// __native.wasmi: WebAssembly through WAMR where V8 has none (js/wasm_interp.cpp; a no-op in builds without WAMR).
// Installed on the page's __native and on every worker's.
void installWasmInterp(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc);
// A worker's thread ends: its modules and instances are freed (called inside the isolate's scope, before Dispose).
void uninstallWasmInterp();
void platformTick(HostServices& svc);
// Audio graph tick hooks (host thread), implemented by audio_bind.cpp
void audioTick(HostServices& svc);

}  // namespace host
