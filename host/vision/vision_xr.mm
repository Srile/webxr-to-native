// The Vision Pro host's XR device: OpenXrDevice (xr/openxr_device.h) over Compositor Services and ARKit's C
// APIs, the third implementation next to OpenXR (xr/openxr_device.cpp) and the emulated headset
// (emu/emu_xr.cpp), which this replaces on visionOS. The page sees the frame record it gets everywhere else.
//
// Frame: cp_layer_renderer_query_next_frame → predict timing → start/end update → wait until the optimal
// input time (the pacing, where xrWaitFrame is on a Quest) → start submission → the drawable: its device
// anchor from ARKit world tracking at the presentation time, its views' transforms and projections become the
// record's poses and fields of view, its colour texture becomes a GL texture through ANGLE's
// EGL_ANGLE_metal_texture_client_buffer (no copy: the page draws straight into the compositor's texture).
// The compositor's layout is `shared` (one texture, two viewports): WebXR's 'texture' projection layout.
// After the page's rAF, GL's work is ordered before the present with EGL_ANGLE_metal_shared_event_sync (glFinish
// without it), the depth texture is cleared to far (the compositor is reverse-Z only; converting the page's
// depth is WP-17's 17e), encode_present + end submission.
//
// Input: until hands arrive (17c), the window's touch input drives two synthesised controllers exactly as
// the desktop emulation does (emu.h's Controls), about the real head pose.
#include "xr/openxr_device.h"
#include "emu/emu.h"
#include "gl/egl.h"
#include "core/json.h"
#include "core/log.h"
#include "vision/vision_bridge.h"
#include "audio/device.h"
#import <CompositorServices/CompositorServices.h>
#import <ARKit/ARKit.h>
#import <Metal/Metal.h>
#import <CoreFoundation/CoreFoundation.h>
#import <QuartzCore/QuartzCore.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl32.h>
#include <GLES2/gl2ext.h>
#include <simd/simd.h>
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <mutex>
#include <thread>
#include <algorithm>
#include <uuid/uuid.h>
#include <unistd.h>
#include <cstdlib>
#import <Foundation/Foundation.h>

#pragma clang diagnostic ignored "-Wdeprecated-declarations"  // cp_frame_query_drawable (26 prefers the plural; one drawable here)

namespace host {
namespace {

// ANGLE's enums (eglext_angle.h), spelled out so the NDK's Khronos headers suffice.
constexpr EGLint kMetalTextureAngle = 0x34A7, kTextureInternalFormatAngle = 0x345D;
constexpr EGLint kSyncMetalSharedEventAngle = 0x34D8, kSyncSignalValueLo = 0x34DA, kSyncSignalValueHi = 0x34DB;
constexpr EGLint kDeviceExt = 0x322C, kMetalDeviceAngle = 0x34A6;
constexpr GLenum kBgra8Ext = 0x93A1;

Egl* g_egl = nullptr;
std::function<void(int, int)> g_overlay;
std::atomic<void*> g_pendingLayer{nullptr};   // a retained cp_layer_renderer_t: set by hostVisionLayerAttach (any thread), taken by the host thread
cp_layer_renderer_t g_layer = nil;
id<MTLDevice> g_device = nil;
id<MTLCommandQueue> g_queue = nil;
ar_session_t g_ar = nullptr;
ar_world_tracking_provider_t g_world = nullptr;
// Each frame's head pose in an anchor of its own: the drawable keeps the anchor it is given (the compositor
// corrects the frame from that pose to the display's when it shows it) and a query writes into the anchor it is
// passed, so one shared anchor would hand frames still in flight the next frame's pose. A ring, made once.
constexpr int kAnchorRing = 8;
ar_device_anchor_t g_anchors[kAnchorRing] = {};
int g_anchorNext = 0;
cp_frame_t g_frame = nullptr;
cp_frame_timing_t g_timing = nullptr;
cp_drawable_t g_drawable = nullptr;
id<MTLTexture> g_depthTex = nil;
struct Imported { GLuint tex = 0; EGLImageKHR image = EGL_NO_IMAGE_KHR; id<MTLTexture> view = nil; };  // view: the linear alias of an sRGB drawable, kept alive with the import
std::unordered_map<void*, Imported> g_imported;   // the compositor's textures (a small pool), as GL textures
PFNEGLCREATEIMAGEKHRPROC p_eglCreateImageKHR = nullptr;
PFNEGLDESTROYIMAGEKHRPROC p_eglDestroyImageKHR = nullptr;
PFNGLEGLIMAGETARGETTEXTURE2DOESPROC p_glEGLImageTargetTexture2DOES = nullptr;
typedef EGLSync (EGLAPIENTRY* CreateSyncFn)(EGLDisplay, EGLenum, const EGLAttrib*);   // EGL 1.5 (EGLAttrib lists), what ANGLE's shared-event sync takes
typedef EGLBoolean (EGLAPIENTRY* DestroySyncFn)(EGLDisplay, EGLSync);
CreateSyncFn p_eglCreateSync = nullptr;
DestroySyncFn p_eglDestroySync = nullptr;
void* (*p_eglCopyMetalSharedEventANGLE)(EGLDisplay, EGLSync) = nullptr;
bool g_sharedEventSync = false;
uint64_t g_syncValue = 0;
bool g_loggedViews = false, g_loggedNoAnchor = false, g_anchorOnce = false;
// The page's render target: a texture of the host's, blitted into the compositor's at the present with the rows
// flipped (ANGLE keeps GL's bottom-up rows in every texture; Metal, and the compositor, read top-down).
GLuint g_pageTex = 0, g_blitRead = 0, g_blitDraw = 0, g_dstTex = 0;
bool g_dstIsSrgb = false, g_srgbWriteControl = false;
// The page's depth (a DEPTH_COMPONENT24 texture its layer attaches) converted into the compositor's
// Depth32Float (imported like the colour): reverse-Z, 1 at its near, 0 at its far, flipped rows like the colour.
GLuint g_pageDepth = 0, g_depthProg = 0, g_depthVao = 0, g_depthFbo = 0; GLint g_uDepth = -1, g_uPage = -1, g_uComp = -1;
bool g_depthImportFailed = false, g_depthPassLogged = false;
GLuint g_dstDepth = 0;   // an sRGB-typed destination would encode the page's already-encoded texels on the blit
void (*g_xrCb)(bool) = nullptr;   // the shell's: XR session started / ended (vision/App.swift dismisses its window)
bool g_xrShellActive = false;      // what the shell was last told (a session restarted in one go is one transition each way)
// The compositor ends a client whose layer goes 10 s without a frame (wakeboardd: "past kill age"). The host
// thread is the page's: its boot holds it in JS for longer than that between the session's start and its first
// rAF, and so can a long task later. A keep-alive thread presents a cleared frame whenever no frame has gone out
// for a while and the host thread is not inside one (g_frameMu is held from beginFrame to endFrame).
std::mutex g_frameMu; std::atomic<double> g_lastPresentMs{0}; std::thread g_keepAlive; std::atomic<bool> g_keepAliveUp{false};
// The space's spatial events (vision/App.swift: LayerRenderer.onSpatialEvent): a pinch at the gaze, or the
// simulator's click, with its selection ray in the space's coordinates. While one is active the aimed hand
// follows the ray with its trigger down; the ray stays the aim for a moment after the release (the game reads
// the release at the ray). Written from SwiftUI's thread, read by the host thread.
// A spatial event: a ray (the compositor layer's selection ray: origin at the hand, through the gazed point), or
// a gazed point with or without the hand's position (the quad's tap), aimed from the hand or a synthesised one.
struct Spatial { bool active = false, hasRay = false, hasHit = false, hasHand = false, resolved = false, fromEye = false; uint64_t id = 0; float o[3] = {0, 0, 0}, d[3] = {0, 0, -1}, hit[3] = {0, 0, 0}; int hand = -1; double endedMs = 0, tapEndMs = 0; };
Spatial g_spatial; std::mutex g_spatialMu;
float g_headHeight = 1.6f;   // LOCAL (eye level) above the floor origin: the first tracked head height
// The base space is ARKit's origin lifted by this: 0 on a device (its origin is on the floor under the person);
// in the simulator a Compositor Services space has its origin at the default camera, 1.6 m above the simulated
// room's floor (the head comes back at exactly 0 until the camera moves), so the floor goes 1.6 m below it and
// the base space is the room's own frame (sim-rooms.json's planes). Every pose the page sees (views, hands,
// planes, selection rays) gets it added in y.
float g_floorBelowOrigin = 0.f;
#if TARGET_OS_SIMULATOR
constexpr float kSimEyeHeight = 1.6f;  // the simulator's default camera above its room's floor
#endif
double g_lastWakeMs = 0;
int g_texW = 0, g_texH = 0;
const Json* g_config = nullptr;   // the app's host.json (emu::setConfig)
// LOCAL's origin in the base space: the eye where tracking started, latched once. A reference space never moves
// with the head (OpenXR's LOCAL is located once per frame but is a fixed space; the desktop emulation's is a
// constant); writing the current eye height here each frame made local-floor ride up and down with the camera.
float g_localY = 0.f;
// --- the RealityKit presentation (vision_bridge.h: hostVisionRealityKitPresent; vision/App.swift: ProxyLayer) ---
// The simulator trails every Compositor Services layer behind its room while the camera moves (2026-10-21:
// Apple's own loop in a minimal app does it too; RealityKit content holds). There the page's frame goes onto a
// RealityKit quad: each frame the shell hands over the Metal texture of a LowLevelTexture (g_proxyBegin), the host
// blits the page into it as it does the drawable, orders it after GL with the shared event and the shell commits
// and moves the quad to the frustum of the render pose (g_proxyEnd). Mono, one view with the quad's field of
// view; paced by RealityKit's scene updates (g_proxyFrames). No depth, no device anchor: RealityKit's camera is
// the one the simulator keeps in step with its room.
bool g_rk = false;
// Where a gaze with nothing under it in the page's depth is taken to land: the page's menus (uikit panels, which
// write no depth) are parked this far ahead of the eye (the game's MENU_DIST, 1.35 m). host.json xr.gazeFallback.
float g_gazeFallback = 1.35f;
HostVisionProxyBegin g_proxyBegin = nullptr; HostVisionProxyEnd g_proxyEnd = nullptr;
int g_proxyW = 0, g_proxyH = 0; float g_proxyFovY = 1.3f, g_proxyDist = 2.f;
std::mutex g_proxyMu; std::condition_variable g_proxyCv; uint64_t g_proxyFrames = 0;
simd_float4x4 g_rkPose = matrix_identity_float4x4;   // the pose this frame renders from, for the quad
void (*g_spaceCb)(void) = nullptr;          // the shell's: open the immersive space (a session after the space closed)
void (*g_spaceClosedCb)(void) = nullptr;    // the shell's: the compositor layer's space closed (vision/App.swift notes the time)
std::atomic<bool> g_enterRequested{false};  // the window's enter button (emu::enterRequested)
// The compositor's refresh, measured: the shortest gap between consecutive presentation times (frames come no
// closer than one period; a slow page skips whole periods), accepted once seen repeatedly.
double g_lastPresentT = 0, g_minGap = 0; int g_minGapHits = 0, g_gaps = 0;

// Synthesised controllers (the window's touch input), as emu/emu_xr.cpp
struct Wearer { int mouseHand = 1; bool focused = true; } g_w;
constexpr float kIpd = 0.063f;

double steadyMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void qmul(const float a[4], const float b[4], float o[4]) {
  float r[4] = {a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]};
  memcpy(o, r, sizeof r);
}
void qaxis(float x, float y, float z, float angle, float o[4]) { float s = sinf(angle / 2); o[0] = x * s; o[1] = y * s; o[2] = z * s; o[3] = cosf(angle / 2); }
void qrot(const float q[4], const float v[3], float o[3]) {
  float t[3] = {2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])};
  float r[3] = {v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]), v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]), v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0])};
  memcpy(o, r, sizeof r);
}
void qlook(const float dir[3], const float up[3], float o[4]) {
  float z[3] = {-dir[0], -dir[1], -dir[2]}; float zl = sqrtf(z[0] * z[0] + z[1] * z[1] + z[2] * z[2]); for (float& c : z) c /= zl;
  float x[3] = {up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]};
  float xl = sqrtf(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]); if (xl < 1e-5f) { x[0] = 1; x[1] = x[2] = 0; xl = 1; } for (float& c : x) c /= xl;
  float y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
  float m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { float s = sqrtf(tr + 1) * 2; o[3] = s / 4; o[0] = (y[2] - z[1]) / s; o[1] = (z[0] - x[2]) / s; o[2] = (x[1] - y[0]) / s; }
  else if (m00 > m11 && m00 > m22) { float s = sqrtf(1 + m00 - m11 - m22) * 2; o[3] = (y[2] - z[1]) / s; o[0] = s / 4; o[1] = (y[0] + x[1]) / s; o[2] = (z[0] + x[2]) / s; }
  else if (m11 > m22) { float s = sqrtf(1 + m11 - m00 - m22) * 2; o[3] = (z[0] - x[2]) / s; o[0] = (y[0] + x[1]) / s; o[1] = s / 4; o[2] = (z[1] + y[2]) / s; }
  else { float s = sqrtf(1 + m22 - m00 - m11) * 2; o[3] = (x[1] - y[0]) / s; o[0] = (z[0] + x[2]) / s; o[1] = (z[1] + y[2]) / s; o[2] = s / 4; }
}
// Quaternion (x, y, z, w) of a column-major rotation (simd columns are the basis vectors).
void quatOf(const simd_float4x4& m, float o[4]) {
  const float r00 = m.columns[0].x, r10 = m.columns[0].y, r20 = m.columns[0].z;
  const float r01 = m.columns[1].x, r11 = m.columns[1].y, r21 = m.columns[1].z;
  const float r02 = m.columns[2].x, r12 = m.columns[2].y, r22 = m.columns[2].z;
  const float tr = r00 + r11 + r22;
  if (tr > 0) { float s = sqrtf(tr + 1) * 2; o[3] = s / 4; o[0] = (r21 - r12) / s; o[1] = (r02 - r20) / s; o[2] = (r10 - r01) / s; }
  else if (r00 > r11 && r00 > r22) { float s = sqrtf(1 + r00 - r11 - r22) * 2; o[3] = (r21 - r12) / s; o[0] = s / 4; o[1] = (r01 + r10) / s; o[2] = (r02 + r20) / s; }
  else if (r11 > r22) { float s = sqrtf(1 + r11 - r00 - r22) * 2; o[3] = (r02 - r20) / s; o[0] = (r01 + r10) / s; o[1] = s / 4; o[2] = (r12 + r21) / s; }
  else { float s = sqrtf(1 + r22 - r00 - r11) * 2; o[3] = (r10 - r01) / s; o[0] = (r02 + r20) / s; o[1] = (r12 + r21) / s; o[2] = s / 4; }
  const float n = sqrtf(o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + o[3] * o[3]); if (n > 0) for (int i = 0; i < 4; ++i) o[i] /= n;
}
void setButton(XrHandState& h, int i, bool down) { h.buttonValue[i] = down ? 1.f : 0.f; h.buttonPressed[i] = down; h.buttonTouched[i] = down; }

// The compositor's refresh from one more presentation time: the Hz once the shortest gap has been seen
// `hitsNeeded` times (0 until then; the window restarts after each answer).
float refreshFromGaps(double presentT, int hitsNeeded) {
  float hz = 0;
  if (g_lastPresentT > 0) {
    const double gap = presentT - g_lastPresentT;
    if (gap > 0.001) {
      if (g_minGap == 0 || gap < g_minGap - 0.0005) { g_minGap = gap; g_minGapHits = 1; } else if (gap < g_minGap + 0.0005) g_minGapHits++;
      if (++g_gaps >= 240 || g_minGapHits >= hitsNeeded) { if (g_minGapHits >= hitsNeeded) hz = roundf((float)(1.0 / g_minGap)); g_minGap = 0; g_minGapHits = g_gaps = 0; }
    }
  }
  g_lastPresentT = presentT;
  return hz >= 24 && hz <= 240 ? hz : 0;
}

void pump(double seconds) { if (NSThread.isMainThread) CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, TRUE); else usleep((useconds_t)(seconds * 1e6)); }  // the host thread waits; SwiftUI (main) attaches the layer

// The compositor layer, once the immersive space is up. Pumps the run loop (SwiftUI attaches it from there).
void keepAliveLoop();
bool takeLayer(double timeoutS) {
  const double t0 = steadyMs();
  while (!g_layer) {
    void* raw = g_pendingLayer.exchange(nullptr);
    if (raw) {
      cp_layer_renderer_t l = (__bridge_transfer cp_layer_renderer_t)raw;
      g_layer = l; g_device = cp_layer_renderer_get_device(l); g_queue = [g_device newCommandQueue];
      cp_layer_renderer_configuration_t cfg = cp_layer_renderer_get_configuration(l);
      HOST_LOGI("vision: compositor layer attached (layout %d, colour format %lu, device %s)", (int)cp_layer_renderer_configuration_get_layout(cfg),
                (unsigned long)cp_layer_renderer_configuration_get_color_format(cfg), g_device.name.UTF8String);
      if (!g_keepAliveUp) { g_keepAliveUp = true; g_keepAlive = std::thread(keepAliveLoop); g_keepAlive.detach(); }
      break;
    }
    if (steadyMs() - t0 > timeoutS * 1000) return false;
    pump(0.02);
  }
  return true;
}

void presentCleared(cp_drawable_t drawable);
void keepAliveLoop() {
  while (g_keepAliveUp) {
    usleep(50000);
    if (!g_layer || cp_layer_renderer_get_state(g_layer) != cp_layer_renderer_state_running) continue;
    if (steadyMs() - g_lastPresentMs < 300) continue;
    if (!g_frameMu.try_lock()) continue;   // the host thread is inside a frame
    if (!g_frame) {
      cp_frame_t f = cp_layer_renderer_query_next_frame(g_layer);
      if (f) {
        cp_frame_timing_t t = cp_frame_predict_timing(f);
        cp_frame_start_update(f); cp_frame_end_update(f);
        if (t) cp_time_wait_until(cp_frame_timing_get_optimal_input_time(t));
        cp_frame_start_submission(f);
        cp_drawable_t dr = cp_frame_query_drawable(f);
        if (dr) presentCleared(dr);
        cp_frame_end_submission(f);
        g_lastPresentMs = steadyMs();
      }
    }
    g_frameMu.unlock();
  }
}

bool loadEglProcs() {
  if (p_eglCreateImageKHR) return true;
  p_eglCreateImageKHR = (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
  p_eglDestroyImageKHR = (PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
  p_glEGLImageTargetTexture2DOES = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)eglGetProcAddress("glEGLImageTargetTexture2DOES");
  p_eglCreateSync = (CreateSyncFn)eglGetProcAddress("eglCreateSync");
  p_eglDestroySync = (DestroySyncFn)eglGetProcAddress("eglDestroySync");
  p_eglCopyMetalSharedEventANGLE = (void* (*)(EGLDisplay, EGLSync))eglGetProcAddress("eglCopyMetalSharedEventANGLE");
  const char* ext = eglQueryString(g_egl->display(), EGL_EXTENSIONS);
  const bool clientBuffer = ext && strstr(ext, "EGL_ANGLE_metal_texture_client_buffer");
  g_sharedEventSync = ext && strstr(ext, "EGL_ANGLE_metal_shared_event_sync") && p_eglCreateSync && p_eglDestroySync && p_eglCopyMetalSharedEventANGLE;
  // The textures must come from the device ANGLE renders with.
  EGLAttrib dev = 0, mtl = 0;
  auto qd = (PFNEGLQUERYDISPLAYATTRIBEXTPROC)eglGetProcAddress("eglQueryDisplayAttribEXT");
  auto qa = (PFNEGLQUERYDEVICEATTRIBEXTPROC)eglGetProcAddress("eglQueryDeviceAttribEXT");
  if (qd && qa && qd(g_egl->display(), kDeviceExt, &dev) && qa((EGLDeviceEXT)dev, kMetalDeviceAngle, &mtl)) {
    id<MTLDevice> angleDev = (__bridge id<MTLDevice>)(void*)mtl;
    if (angleDev != g_device) HOST_LOGW("vision: ANGLE's Metal device (%s) is not the compositor's (%s): texture import may fail", angleDev.name.UTF8String, g_device.name.UTF8String);
  }
  const char* glExt = (const char*)glGetString(GL_EXTENSIONS);
  g_srgbWriteControl = glExt && strstr(glExt, "GL_EXT_sRGB_write_control");
  HOST_LOGI("vision: ANGLE metal client buffer %s, shared-event sync %s, sRGB write control %s", clientBuffer ? "yes" : "NO", g_sharedEventSync ? "yes" : "no (glFinish)", g_srgbWriteControl ? "yes" : "no");
  return clientBuffer && p_eglCreateImageKHR && p_glEGLImageTargetTexture2DOES;
}

// The compositor's texture as a GL texture (cached: the drawables rotate through a small pool).
GLuint importTexture(id<MTLTexture> tex, bool srgbColour) {
  void* key = (__bridge void*)tex;
  auto it = g_imported.find(key);
  if (it != g_imported.end()) return it->second.tex;
  // The page writes sRGB-encoded texels and the blit must copy them as they are: an sRGB drawable is imported
  // through Metal's linear view of it (sRGB ↔ linear aliases need no pixel-format-view usage), so GL sees plain
  // BGRA8 and encodes nothing. ANGLE's own internal-format override refuses the sRGB texture (EGL_BAD_ATTRIBUTE).
  id<MTLTexture> view = nil;
  if (srgbColour) view = [tex newTextureViewWithPixelFormat:tex.pixelFormat == MTLPixelFormatBGRA8Unorm_sRGB ? MTLPixelFormatBGRA8Unorm : MTLPixelFormatRGBA8Unorm];
  void* src = view ? (__bridge void*)view : key;
  EGLImageKHR img = p_eglCreateImageKHR(g_egl->display(), EGL_NO_CONTEXT, kMetalTextureAngle, (EGLClientBuffer)src, nullptr);
  bool asLinear = view != nil && img != EGL_NO_IMAGE_KHR;
  if (img == EGL_NO_IMAGE_KHR && view) { HOST_LOGW("vision: import of the linear view refused (0x%x): importing the sRGB drawable itself, the blit will encode", eglGetError()); view = nil; img = p_eglCreateImageKHR(g_egl->display(), EGL_NO_CONTEXT, kMetalTextureAngle, (EGLClientBuffer)key, nullptr); }
  if (srgbColour && !view) HOST_LOGW("vision: no linear view of the sRGB drawable: colours will come out washed");
  if (srgbColour) g_dstIsSrgb = !asLinear;  // the colour import decides; depth imports take the plain path
  if (img == EGL_NO_IMAGE_KHR) { HOST_LOGE("vision: eglCreateImageKHR(metal texture %lux%lu fmt %lu) failed: 0x%x", (unsigned long)tex.width, (unsigned long)tex.height, (unsigned long)tex.pixelFormat, eglGetError()); return 0; }
  GLint prev = 0; glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev);
  GLuint t = 0; glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
  p_glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, (GLeglImageOES)img);
  const GLenum err = glGetError();
  glBindTexture(GL_TEXTURE_2D, (GLuint)prev);
  if (err) { HOST_LOGE("vision: glEGLImageTargetTexture2DOES failed: 0x%x", err); glDeleteTextures(1, &t); p_eglDestroyImageKHR(g_egl->display(), img); return 0; }
  g_imported[key] = {t, img, view};
  HOST_LOGI("vision: imported compositor texture %lux%lu (fmt %lu) as GL texture %u%s (%zu in the pool)", (unsigned long)tex.width, (unsigned long)tex.height, (unsigned long)tex.pixelFormat, t, srgbColour ? (asLinear ? " through its linear view" : " as sRGB") : "", g_imported.size());
  return t;
}

bool buildDepthPass() {
  if (g_depthProg) return true;
  static const char* vs = "#version 300 es\nout vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0); vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
  static const char* fs = "#version 300 es\nprecision highp float; uniform highp sampler2D uDepth; uniform vec2 uPage; uniform vec2 uComp; in vec2 vUv; out vec4 o;\n"
    // Where the page drew nothing (depth still at its clear value: passthrough in AR, nothing in VR) the compositor
    // gets 0, reverse-Z's infinity, as a Metal app's cleared depth: not a surface at the page's far plane, which
    // its reprojection would otherwise take for the scene (in room mode most of the image), carrying what IS
    // there along with the head.
    "void main(){ float d = texture(uDepth, vec2(vUv.x, 1.0 - vUv.y)).r; if (d >= 1.0) { gl_FragDepth = 0.0; o = vec4(0.0); return; } float n = uPage.x, f = uPage.y;"
    " float e = f * n / (f - d * (f - n));"
    " float cn = uComp.x, cf = uComp.y;"
    " gl_FragDepth = clamp(cn * (cf - e) / (e * (cf - cn)), 0.0, 1.0); o = vec4(0.0); }";
  auto compile = [](GLenum type, const char* src) { GLuint sh = glCreateShader(type); glShaderSource(sh, 1, &src, nullptr); glCompileShader(sh); GLint ok = 0; glGetShaderiv(sh, GL_COMPILE_STATUS, &ok); if (!ok) { char log[512]; glGetShaderInfoLog(sh, sizeof log, nullptr, log); HOST_LOGE("vision: depth pass shader: %s", log); } return sh; };
  GLuint v = compile(GL_VERTEX_SHADER, vs), f = compile(GL_FRAGMENT_SHADER, fs);
  g_depthProg = glCreateProgram(); glAttachShader(g_depthProg, v); glAttachShader(g_depthProg, f); glLinkProgram(g_depthProg);
  GLint ok = 0; glGetProgramiv(g_depthProg, GL_LINK_STATUS, &ok); glDeleteShader(v); glDeleteShader(f);
  if (!ok) { HOST_LOGE("vision: depth pass program failed to link"); glDeleteProgram(g_depthProg); g_depthProg = 0; return false; }
  g_uDepth = glGetUniformLocation(g_depthProg, "uDepth"); g_uPage = glGetUniformLocation(g_depthProg, "uPage"); g_uComp = glGetUniformLocation(g_depthProg, "uComp");
  glGenVertexArrays(1, &g_depthVao); glGenFramebuffers(1, &g_depthFbo);
  return true;
}

// The page's depth into the compositor's depth texture (window depth from the page's near/far to reverse-Z in
// the compositor's). The page's GL state is saved and put back.
void runDepthPass(GLuint dstDepth, int w, int h, float pageNear, float pageFar, float compNear, float compFar) {
  if (!buildDepthPass()) return;
  GLint prog = 0, vao = 0, unit = 0, tex0 = 0, fbR = 0, fbD = 0, vp[4], dfunc = 0; GLboolean dtest, dmask, cmask[4], scissor, cull, blend, stencil;
  glGetIntegerv(GL_CURRENT_PROGRAM, &prog); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao); glGetIntegerv(GL_ACTIVE_TEXTURE, &unit);
  glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &tex0);
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &fbR); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbD); glGetIntegerv(GL_VIEWPORT, vp); glGetIntegerv(GL_DEPTH_FUNC, &dfunc);
  dtest = glIsEnabled(GL_DEPTH_TEST); glGetBooleanv(GL_DEPTH_WRITEMASK, &dmask); glGetBooleanv(GL_COLOR_WRITEMASK, cmask);
  scissor = glIsEnabled(GL_SCISSOR_TEST); cull = glIsEnabled(GL_CULL_FACE); blend = glIsEnabled(GL_BLEND); stencil = glIsEnabled(GL_STENCIL_TEST);
  glBindFramebuffer(GL_FRAMEBUFFER, g_depthFbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, dstDepth, 0);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  const GLenum none = GL_NONE; glDrawBuffers(1, &none);
  const GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  if (status != GL_FRAMEBUFFER_COMPLETE) { if (!g_depthPassLogged) { g_depthPassLogged = true; HOST_LOGE("vision: depth pass framebuffer incomplete (0x%x)", status); } }
  else {
    glUseProgram(g_depthProg); glBindVertexArray(g_depthVao);
    glBindTexture(GL_TEXTURE_2D, g_pageDepth); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_NONE);
    glUniform1i(g_uDepth, 0); glUniform2f(g_uPage, pageNear, pageFar); glUniform2f(g_uComp, compNear, compFar);
    glViewport(0, 0, w, h); glDisable(GL_SCISSOR_TEST); glDisable(GL_CULL_FACE); glDisable(GL_BLEND); glDisable(GL_STENCIL_TEST);
    glEnable(GL_DEPTH_TEST); glDepthFunc(GL_ALWAYS); glDepthMask(GL_TRUE); glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    if (!g_depthPassLogged) { g_depthPassLogged = true; HOST_LOGI("vision: depth pass running (page %.2f..%.0f → compositor reverse-Z %.2f..%.0f), GL error 0x%x", pageNear, pageFar, compNear, compFar, glGetError()); }
  }
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, 0, 0);
  glUseProgram((GLuint)prog); glBindVertexArray((GLuint)vao); glBindTexture(GL_TEXTURE_2D, (GLuint)tex0); glActiveTexture((GLenum)unit);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)fbR); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)fbD); glViewport(vp[0], vp[1], vp[2], vp[3]);
  glDepthFunc((GLenum)dfunc); if (!dtest) glDisable(GL_DEPTH_TEST); glDepthMask(dmask); glColorMask(cmask[0], cmask[1], cmask[2], cmask[3]);
  if (scissor) glEnable(GL_SCISSOR_TEST); if (cull) glEnable(GL_CULL_FACE); if (blend) glEnable(GL_BLEND); if (stencil) glEnable(GL_STENCIL_TEST);
}

// WEBXR_VISION_DEPTH_PROBE=1 (SIMCTL_CHILD_ on a simulator launch): every 300 frames, the page's depth decoded to
// metres at 9 points across the middle row, read back through a 9x1 float target. A diagnostic: it stalls the GPU.
void probePageDepth(GLuint pageDepth, GLuint pageColour, float pageNear, float pageFar) {
  static GLuint prog = 0, fbo = 0, tex = 0, vao = 0; static GLint uD = -1, uP = -1, uC = -1;
  if (!prog) {
    static const char* vs = "#version 300 es\nvoid main(){ vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }";
    static const char* fs = "#version 300 es\nprecision highp float; uniform highp sampler2D uDepth; uniform vec2 uPage; out vec4 o;\n"
      "uniform highp sampler2D uColour;\n"
      "void main(){ vec2 uv = vec2(gl_FragCoord.x / 9.0, gl_FragCoord.y / 5.0); float d = texture(uDepth, uv).r; float n = uPage.x, f = uPage.y;"
      " o = vec4(f * n / (f - d * (f - n)), d, texture(uColour, uv).a, 1.0); }";
    auto sh = [](GLenum t, const char* s) { GLuint h = glCreateShader(t); glShaderSource(h, 1, &s, nullptr); glCompileShader(h); return h; };
    GLuint v = sh(GL_VERTEX_SHADER, vs), f = sh(GL_FRAGMENT_SHADER, fs);
    prog = glCreateProgram(); glAttachShader(prog, v); glAttachShader(prog, f); glLinkProgram(prog); glDeleteShader(v); glDeleteShader(f);
    uD = glGetUniformLocation(prog, "uDepth"); uP = glGetUniformLocation(prog, "uPage"); uC = glGetUniformLocation(prog, "uColour");
    glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex); glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA32F, 9, 5);
    glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_FRAMEBUFFER, fbo); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    glGenVertexArrays(1, &vao);
  }
  glBindFramebuffer(GL_FRAMEBUFFER, fbo); const GLenum c0 = GL_COLOR_ATTACHMENT0; glDrawBuffers(1, &c0);
  glUseProgram(prog); glBindVertexArray(vao); glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, pageDepth);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_NONE);
  glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, pageColour); glActiveTexture(GL_TEXTURE0);
  glUniform1i(uD, 0); glUniform1i(uC, 1); glUniform2f(uP, pageNear, pageFar);
  glViewport(0, 0, 9, 5); glDisable(GL_DEPTH_TEST); glDisable(GL_SCISSOR_TEST); glDisable(GL_BLEND); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  float px[9 * 5 * 4] = {0}; glReadPixels(0, 0, 9, 5, GL_RGBA, GL_FLOAT, px);
  glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, 0); glActiveTexture(GL_TEXTURE0);
  HOST_LOGI("vision: page depth probe (near %.2f far %.0f, GL error 0x%x): metres (alpha) on a 9x5 grid, top row first", pageNear, pageFar, glGetError());
  for (int r = 4; r >= 0; --r) {
    char line[512]; int o = 0;
    for (int c = 0; c < 9; ++c) { const float* q = px + (r * 9 + c) * 4; o += snprintf(line + o, sizeof line - o, " %6.2f(%.2f)", q[0], q[2]); }
    HOST_LOGI("vision:   %s", line);
  }
}

// The page's depth at one point of its frame (u, v in 0..1, GL rows), in metres along the view axis, or 0 where
// nothing was drawn (the clear). A tiny pass into a 1x1 float target and a readback: a GPU sync, for taps only.
float pageDepthAt(float u, float v, float pageNear, float pageFar) {
  static GLuint prog = 0, fbo = 0, tex = 0, vao = 0; static GLint uD = -1, uP = -1, uUv = -1;
  if (!g_pageDepth) return 0;
  if (!prog) {
    static const char* vs = "#version 300 es\nvoid main(){ vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }";
    static const char* fs = "#version 300 es\nprecision highp float; uniform highp sampler2D uDepth; uniform vec2 uPage; uniform vec2 uUv; out vec4 o;\n"
      "void main(){ float d = texture(uDepth, uUv).r; float n = uPage.x, f = uPage.y; o = vec4(d >= 1.0 ? 0.0 : f * n / (f - d * (f - n)), d, 0.0, 1.0); }";
    auto sh = [](GLenum t, const char* src) { GLuint h = glCreateShader(t); glShaderSource(h, 1, &src, nullptr); glCompileShader(h); return h; };
    GLuint v = sh(GL_VERTEX_SHADER, vs), f = sh(GL_FRAGMENT_SHADER, fs);
    prog = glCreateProgram(); glAttachShader(prog, v); glAttachShader(prog, f); glLinkProgram(prog); glDeleteShader(v); glDeleteShader(f);
    uD = glGetUniformLocation(prog, "uDepth"); uP = glGetUniformLocation(prog, "uPage"); uUv = glGetUniformLocation(prog, "uUv");
    glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex); glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA32F, 1, 1);
    glGenFramebuffers(1, &fbo); glGenVertexArrays(1, &vao);
  }
  GLint pr = 0, va = 0, fbR = 0, fbD = 0, tx = 0, unit = 0, vp[4]; GLboolean cm[4]; const GLboolean dt = glIsEnabled(GL_DEPTH_TEST), sc = glIsEnabled(GL_SCISSOR_TEST), bl = glIsEnabled(GL_BLEND);
  glGetIntegerv(GL_CURRENT_PROGRAM, &pr); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &va); glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &fbR); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbD); glGetIntegerv(GL_ACTIVE_TEXTURE, &unit);
  glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &tx); glGetIntegerv(GL_VIEWPORT, vp); glGetBooleanv(GL_COLOR_WRITEMASK, cm);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0); const GLenum c0 = GL_COLOR_ATTACHMENT0; glDrawBuffers(1, &c0);
  glUseProgram(prog); glBindVertexArray(vao); glBindTexture(GL_TEXTURE_2D, g_pageDepth); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_NONE);
  glUniform1i(uD, 0); glUniform2f(uP, pageNear, pageFar); glUniform2f(uUv, u, v);
  glViewport(0, 0, 1, 1); glDisable(GL_DEPTH_TEST); glDisable(GL_SCISSOR_TEST); glDisable(GL_BLEND); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  float px[4] = {0, 0, 0, 0}; glReadPixels(0, 0, 1, 1, GL_RGBA, GL_FLOAT, px);
  glUseProgram((GLuint)pr); glBindVertexArray((GLuint)va); glBindTexture(GL_TEXTURE_2D, (GLuint)tx); glActiveTexture((GLenum)unit);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)fbR); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)fbD); glViewport(vp[0], vp[1], vp[2], vp[3]);
  glColorMask(cm[0], cm[1], cm[2], cm[3]); if (dt) glEnable(GL_DEPTH_TEST); if (sc) glEnable(GL_SCISSOR_TEST); if (bl) glEnable(GL_BLEND);
  return px[0];
}

void releaseImported() {
  for (auto& [k, v] : g_imported) { glDeleteTextures(1, &v.tex); p_eglDestroyImageKHR(g_egl->display(), v.image); }
  g_imported.clear();
}

// Field of view (XrFovf angles) out of the compositor's projection for a view (GL conventions, reverse-Z:
// the first two rows are those of any perspective matrix: P00 = 2n/(r-l), P20 = (r+l)/(r-l), and likewise Y).
void fovOf(const simd_float4x4& P, XrViewInfo& v) {
  const float p00 = P.columns[0].x, p11 = P.columns[1].y, p20 = P.columns[2].x, p21 = P.columns[2].y;
  const float tanR = (1 + p20) / p00, tanL = (p20 - 1) / p00, tanU = (1 + p21) / p11, tanD = (p21 - 1) / p11;
  v.fovL = atanf(tanL); v.fovR = atanf(tanR); v.fovU = atanf(tanU); v.fovD = atanf(tanD);
}

// A drawable the page did not draw into is presented cleared (transparent, far): the compositor treats a
// submission ended without a present as a client bug.
void presentCleared(cp_drawable_t drawable) {
  id<MTLCommandBuffer> cb = [g_queue commandBuffer];
  MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
  const size_t n = cp_drawable_get_texture_count(drawable);
  for (size_t i = 0; i < n && i < 4; ++i) {
    rp.colorAttachments[i].texture = cp_drawable_get_color_texture(drawable, i); rp.colorAttachments[i].loadAction = MTLLoadActionClear; rp.colorAttachments[i].storeAction = MTLStoreActionStore; rp.colorAttachments[i].clearColor = MTLClearColorMake(0, 0, 0, 0);
  }
  if (n) { rp.depthAttachment.texture = cp_drawable_get_depth_texture(drawable, 0); rp.depthAttachment.loadAction = MTLLoadActionClear; rp.depthAttachment.storeAction = MTLStoreActionStore; rp.depthAttachment.clearDepth = 0.0; }
  id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp]; [enc endEncoding];
  cp_drawable_encode_present(drawable, cb);
  [cb commit];
}
void abandonFrame() {
  if (g_frame) { if (g_drawable) presentCleared(g_drawable); cp_frame_end_submission(g_frame); g_lastPresentMs = steadyMs(); }
  g_frame = nullptr; g_timing = nullptr; g_drawable = nullptr; g_depthTex = nil;
}

bool arStart() {
  if (g_ar) return true;
  if (!ar_world_tracking_provider_is_supported()) { HOST_LOGE("vision: ARKit world tracking unsupported here"); return false; }
  g_ar = ar_session_create();
  ar_world_tracking_configuration_t wc = ar_world_tracking_configuration_create();
  g_world = ar_world_tracking_provider_create(wc);
  ar_data_providers_t providers = ar_data_providers_create_with_data_providers(g_world, nil);
  ar_session_run(g_ar, providers);
  for (int i = 0; i < kAnchorRing; ++i) g_anchors[i] = ar_device_anchor_create();
  HOST_LOGI("vision: ARKit session running (world tracking)");
  return true;
}

}  // namespace

void emu::setPresentOverlay(std::function<void(int, int)> draw) { g_overlay = std::move(draw); }
void emu::setConfig(const Json* cfg) { g_config = cfg; }

// ---------------------------------------------------------------------------------------------------------
bool OpenXrDevice::createInstance(android_app*) {
  systemName_ = "Apple Vision Pro (Compositor Services)";
  return true;
}

bool OpenXrDevice::createSession(Egl& egl) {
  g_egl = &egl;
  rate_ = 90.f; rates_ = {rate_};   // until createSwapchain measures the compositor's (the simulator presents at 60)
  // host.json xr.input: "hands" (the default: the hands' joints and an aim from the hand, a device's ARKit hand
  // tracking; WP-17 17c, not built yet) or "transient-pointer" (gaze + pinch: the aim from the hand at the gazed
  // point). The simulator has no hands, so both are the transient pointer there.
  { std::string mode = g_config ? g_config->at("xr").s("input", "hands") : "hands";
    const bool hands = mode == "hands";
#if TARGET_OS_SIMULATOR
    HOST_LOGI("vision: input %s%s", mode.c_str(), hands ? " (no hands in the simulator: the transient pointer, gaze + pinch)" : "");
#else
    HOST_LOGI("vision: input %s%s", mode.c_str(), hands ? " (hand tracking is 17c, not built: the transient pointer meanwhile)" : "");
#endif
  }
  if (g_config) g_gazeFallback = (float)g_config->at("xr").n("gazeFallback", g_gazeFallback);
  g_rk = hostVisionRealityKitPresent();
  HOST_LOGI("vision: presenting through %s", g_rk ? "a RealityKit quad (the simulator's path; WEBXR_VISION_PRESENT=cs for the compositor layer)" : "the Compositor Services layer");
  if (g_rk) stageSpace_ = (XrSpace)(uintptr_t)1;   // the RealityKit space's origin is on the floor: local-floor = base, as on a device
  scene_.setPassthroughSupported(true);  // mixed immersion: the compositor shows the room where the page's alpha is 0
  scene_.setSceneSupported(true);  // ARKit planes + room mesh on a device; a synthetic floor in the simulator (startScene)
  HOST_LOGI("vision: ARKit planes %s, scene reconstruction %s, hands %s", ar_plane_detection_provider_is_supported() ? "supported" : "unsupported", ar_scene_reconstruction_provider_is_supported() ? "supported" : "unsupported", ar_hand_tracking_provider_is_supported() ? "supported" : "unsupported");
  // The immersive space opens with the window (vision/App.swift); its layer is taken when the page asks for a
  // swapchain. Until then the session reports running: the page boots meanwhile.
  running_ = true; state_ = XR_SESSION_STATE_FOCUSED;
#if !TARGET_OS_SIMULATOR
  // A device's ARKit origin is on the floor, so the base space IS the floor: local-floor = base (the stage branch).
  stageSpace_ = (XrSpace)(uintptr_t)1;
#endif
  // In the simulator the ARKit origin is at the eye, so the base space is left AS ARKit space (the eye near y = 0):
  // the page renders from exactly the pose given to the compositor as the device anchor — a lifted base space would
  // render each eye 1.6 m off the anchor and the compositor's reprojection would carry the scene with head motion.
  // local-floor then comes from LOCAL (at the eye) minus the runtime's eye-height fallback (1.6 m = kSimEyeHeight),
  // not the stage, so hasStage() stays false here.
  HOST_LOGI("xr (vision): Compositor Services, %.0f Hz", rate_);
  return true;
}

void OpenXrDevice::destroy() { destroySwapchain(); running_ = false; }

// The compositor owns the textures; what the page needs here is their size, learned from one frame's drawable.
bool OpenXrDevice::createSwapchain(const SwapchainDesc& d) {
  destroySwapchain();
  if (g_rk) {
    if (!g_proxyBegin && g_spaceCb) { HOST_LOGI("vision: asking the shell for the immersive space"); g_spaceCb(); }
    const double t0 = steadyMs();
    while (!g_proxyBegin && steadyMs() - t0 < 15000) pump(0.02);
    if (!g_proxyBegin) { HOST_LOGE("vision: no RealityKit proxy after 15 s (did the immersive space open?)"); return false; }
    if (!loadEglProcs()) return false;
    arStart();
    g_texW = g_proxyW; g_texH = g_proxyH; viewCount_ = 1;
    rates_ = {rate_};   // 90 until the scene updates are counted (the simulator's RealityKit runs ~90)
    HOST_LOGI("vision: RealityKit proxy %dx%d, %.0f deg vertical at %.1f m, %.0f Hz assumed", g_texW, g_texH, g_proxyFovY * 57.3f, g_proxyDist, rate_);
  } else {
  if (!takeLayer(15.0)) { HOST_LOGE("vision: no compositor layer after 15 s (did the immersive space open?)"); return false; }
  if (!loadEglProcs()) return false;
  arStart();
  for (int i = 0; i < 500 && cp_layer_renderer_get_state(g_layer) != cp_layer_renderer_state_running; ++i) pump(0.02);  // not wait_until_running: SwiftUI needs this thread
  if (cp_layer_renderer_get_state(g_layer) != cp_layer_renderer_state_running) { HOST_LOGE("vision: the compositor layer did not start running (state %d)", (int)cp_layer_renderer_get_state(g_layer)); return false; }
  if (!g_texW) {
    std::lock_guard<std::mutex> frameLock(g_frameMu);
    // A few more frames than the size needs: their presentation times give the compositor's refresh before the
    // page is told one (XRSession.frameRate, the GC's idle deadline).
    float hz = 0;
    for (int tries = 0; tries < 200 && (!g_texW || hz == 0); ++tries) {
      cp_frame_t f = cp_layer_renderer_query_next_frame(g_layer);
      if (!f) { pump(0.01); continue; }
      cp_frame_timing_t t = cp_frame_predict_timing(f);
      cp_frame_start_update(f); cp_frame_end_update(f);
      if (t) cp_time_wait_until(cp_frame_timing_get_optimal_input_time(t));
      if (t && hz == 0) { hz = refreshFromGaps(cp_time_to_cf_time_interval(cp_frame_timing_get_presentation_time(t)), 4); if (hz > 0 && std::fabs(hz - rate_) >= 1.f) { HOST_LOGI("vision: the compositor presents at %.0f Hz (assumed %.0f)", hz, rate_); rate_ = hz; rates_ = {rate_}; } }
      cp_frame_start_submission(f);
      cp_drawable_t dr = cp_frame_query_drawable(f);
      if (dr) {
        id<MTLTexture> tex = cp_drawable_get_color_texture(dr, 0);
        g_texW = (int)tex.width; g_texH = (int)tex.height;
        const size_t views = cp_drawable_get_view_count(dr);
        viewCount_ = (int)std::min<size_t>(2, std::max<size_t>(1, views));
        for (size_t i = 0; i < views && i < 2; ++i) {
          cp_view_t v = cp_drawable_get_view(dr, i); cp_view_texture_map_t m = cp_view_get_view_texture_map(v); MTLViewport vp = cp_view_texture_map_get_viewport(m);
          HOST_LOGI("vision: view %zu → texture %zu slice %zu viewport %.0f,%.0f %.0fx%.0f", i, cp_view_texture_map_get_texture_index(m), cp_view_texture_map_get_slice_index(m), vp.originX, vp.originY, vp.width, vp.height);
        }
        HOST_LOGI("vision: drawable %dx%d, %zu textures, %zu views, depth range (far %.1f, near %.2f)", g_texW, g_texH, cp_drawable_get_texture_count(dr), views, cp_drawable_get_depth_range(dr).x, cp_drawable_get_depth_range(dr).y);
      }
      if (dr) presentCleared(dr);  // only the size was wanted; the compositor still gets a (cleared) frame
      cp_frame_end_submission(f); g_lastPresentMs = steadyMs();
    }
    if (!g_texW) { HOST_LOGE("vision: the compositor gave no drawable"); return false; }
  }
  }  // compositor layer
  recW_ = g_texW / 2; recH_ = g_texH;
  scW_ = g_texW; scH_ = g_texH; scArray_ = 1; swapchainSerial_++;
  GLint prev2D = 0; glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev2D);
  glGenTextures(1, &g_pageTex); glBindTexture(GL_TEXTURE_2D, g_pageTex); glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, g_texW, g_texH);
  glGenTextures(1, &g_pageDepth); glBindTexture(GL_TEXTURE_2D, g_pageDepth); glTexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH_COMPONENT24, g_texW, g_texH);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glBindTexture(GL_TEXTURE_2D, (GLuint)prev2D);
  depthTex_ = g_pageDepth;
  if (!g_blitRead) { glGenFramebuffers(1, &g_blitRead); glGenFramebuffers(1, &g_blitDraw); }
  scImages_ = {g_pageTex};
  if (d.scene) scene_.startScene();
  if (g_xrCb && !g_xrShellActive) { g_xrShellActive = true; g_xrCb(true); }
  HOST_LOGI("swapchain (vision) #%u %dx%d side by side (arraySize asked %d; the compositor's shared layout)", swapchainSerial_, scW_, scH_, d.arraySize);
  return true;
}

void OpenXrDevice::destroySwapchain() {
  if (!g_egl) return;
  if (!g_imported.empty()) releaseImported();
  if (g_pageTex) { glDeleteTextures(1, &g_pageTex); g_pageTex = 0; scImages_.clear(); }
  if (g_xrCb && g_xrShellActive) { g_xrShellActive = false; g_xrCb(false); }
  if (g_pageDepth) { glDeleteTextures(1, &g_pageDepth); g_pageDepth = 0; depthTex_ = 0; }
  if (scene_.sceneActive()) scene_.stopScene();
}

bool OpenXrDevice::pollEvents() {
  if (emu::closeRequested()) exitRequested_ = true;
  if (exitRequested_) { running_ = false; return false; }
  if (g_rk) { state_ = !g_proxyBegin ? XR_SESSION_STATE_SYNCHRONIZED : g_w.focused ? XR_SESSION_STATE_FOCUSED : XR_SESSION_STATE_VISIBLE; return true; }   // no space: hidden
  if (!g_layer) {
    void* raw = g_pendingLayer.exchange(nullptr);
    if (raw) {  // starts the keep-alive: the space gets cleared frames until the page renders
      g_pendingLayer.store(raw); takeLayer(0);
      if (g_layer && g_texW) { HOST_LOGI("vision: the immersive space is back: the page's XR session resumes"); if (g_xrCb) g_xrCb(true); }  // the shell dismisses the window again
    }
    if (!g_layer) { state_ = XR_SESSION_STATE_SYNCHRONIZED; return true; }  // hidden: no space, no frames
  }
  switch (cp_layer_renderer_get_state(g_layer)) {
    case cp_layer_renderer_state_paused: state_ = XR_SESSION_STATE_VISIBLE; break;
    case cp_layer_renderer_state_running: state_ = g_w.focused ? XR_SESSION_STATE_FOCUSED : XR_SESSION_STATE_VISIBLE; break;
    case cp_layer_renderer_state_invalidated: {
      // The space closed (the crown, the home view). The layer is gone for good; the session stays, hidden, as on
      // the RealityKit path (hostVisionProxyDetach), until the shell opens the space again on the person's return
      // and its new layer arrives through hostVisionLayerAttach. It used to stop the device, which quit the app.
      HOST_LOGI("vision: compositor layer invalidated (the immersive space closed): the page's XR session hides until the space is back");
      { std::lock_guard<std::mutex> l(g_frameMu); abandonFrame(); g_layer = nil; g_queue = nil; }
      if (g_spaceClosedCb) g_spaceClosedCb();
      state_ = XR_SESSION_STATE_SYNCHRONIZED; break; }
  }
  return true;
}
void OpenXrDevice::requestExit() { exitRequested_ = true; emu::requestClose(); }

bool OpenXrDevice::requestRefreshRate(float hz) { return std::fabs(hz - rate_) < 0.5f; }
bool OpenXrDevice::setFoveation(float) { return false; }
std::string OpenXrDevice::perfLine() { return "vision"; }
std::string OpenXrDevice::profileLine() { return "vision"; }

bool OpenXrDevice::beginFrame(XrFrameInfo& out, double loopNowMs) {
  if (!running_) return false;
  cp_frame_t frame = nullptr; cp_frame_timing_t timing = nullptr; cp_drawable_t drawable = nullptr;
  emu::Controls c;
  // Hidden (the space closed, on either path): the page's audio output pauses with its frames, back when the frames are.
  static bool audioPaused = false;
  const bool hidden = g_texW && (g_rk ? !g_proxyBegin : !g_layer);
  if (hidden && !audioPaused) { audioPaused = true; audio::RealtimeContext::pauseOutput(); HOST_LOGI("vision: audio output paused while the space is closed"); }
  if (!hidden && audioPaused) { audioPaused = false; audio::RealtimeContext::resumeOutput(); HOST_LOGI("vision: audio output resumed"); }
  if (g_rk) {
    if (!g_proxyBegin || !g_texW) { pump(0.016); return false; }
    // One page frame per RealityKit scene update (a 40 ms cap: a paused space still runs the loop). A frame that
    // ran past an update starts the next one at once rather than waiting for the update after (which would halve
    // the rate as soon as a frame exceeds one period); the updates it missed are counted as drops.
    { static uint64_t lastSeen = 0; static int drops = 0, frames = 0; static double secStart = 0;
      std::unique_lock<std::mutex> l(g_proxyMu);
      g_proxyCv.wait_for(l, std::chrono::milliseconds(40), [&] { return g_proxyFrames != lastSeen; });
      if (g_proxyFrames > lastSeen + 1 && lastSeen) drops += (int)(g_proxyFrames - lastSeen - 1);
      lastSeen = g_proxyFrames; frames++;
      const double now = steadyMs(); if (secStart == 0) secStart = now;
      if (now - secStart >= 5000) { if (drops) HOST_LOGI("vision: proxy: %d RealityKit updates without a new frame in %d frames (%.1f s)", drops, frames, (now - secStart) / 1000); drops = frames = 0; secStart = now; } }
    emu::readControls(c);
    if (c.swapHand) { g_w.mouseHand ^= 1; HOST_LOGI("vision: the aimed hand is the %s controller", g_w.mouseHand ? "right" : "left"); }
    if (c.toggleSystemMenu) g_w.focused = !g_w.focused;
    wakeMs_ = steadyMs();
    frameState_.predictedDisplayPeriod = (XrDuration)(1e9 / rate_);
  } else {
  if (!g_layer || !g_texW) { pump(0.016); return false; }
  if (cp_layer_renderer_get_state(g_layer) != cp_layer_renderer_state_running) { pump(0.05); return false; }
  g_frameMu.lock();   // held until endFrame: the keep-alive thread stays out of this frame
  abandonFrame();  // a frame the host never ended (it did not render): present it cleared
  frame = cp_layer_renderer_query_next_frame(g_layer);
  if (!frame) { g_frameMu.unlock(); pump(0.005); return false; }
  timing = cp_frame_predict_timing(frame);
  if (!timing) { cp_frame_start_update(frame); cp_frame_end_update(frame); cp_frame_start_submission(frame); cp_frame_end_submission(frame); g_frameMu.unlock(); return false; }
  cp_frame_start_update(frame);
  emu::readControls(c);
  if (c.swapHand) { g_w.mouseHand ^= 1; HOST_LOGI("vision: the aimed hand is the %s controller", g_w.mouseHand ? "right" : "left"); }
  if (c.toggleSystemMenu) g_w.focused = !g_w.focused;
  cp_frame_end_update(frame);
  cp_time_wait_until(cp_frame_timing_get_optimal_input_time(timing));
  wakeMs_ = steadyMs();
  frameState_.predictedDisplayPeriod = (XrDuration)(1e9 / rate_);
  cp_frame_start_submission(frame);
  drawable = cp_frame_query_drawable(frame);
  if (!drawable) { cp_frame_end_submission(frame); g_frameMu.unlock(); return false; }
  g_frame = frame; g_timing = timing; g_drawable = drawable;
  }  // compositor layer

  // --- head: the device anchor at the presentation time (the proxy: the next RealityKit frame) ---
  simd_float4x4 D = matrix_identity_float4x4;
  const CFTimeInterval presentT = g_rk ? CACurrentMediaTime() + 1.0 / rate_ : cp_time_to_cf_time_interval(cp_frame_timing_get_presentation_time(timing));
  static int anchorFrames = 0; static bool anchorTracked = false;
  ar_device_anchor_t anchor = g_anchors[g_anchorNext]; g_anchorNext = (g_anchorNext + 1) % kAnchorRing;
  const ar_device_anchor_query_status_t aq = g_world && anchor ? ar_world_tracking_provider_query_device_anchor_at_timestamp(g_world, presentT, anchor) : ar_device_anchor_query_status_failure;
  if (aq == ar_device_anchor_query_status_success) {
    if (drawable) cp_drawable_set_device_anchor(drawable, anchor);
    D = ar_anchor_get_origin_from_anchor_transform(anchor);
    static bool loggedKeep = false;
    if (!loggedKeep && drawable) { loggedKeep = true; HOST_LOGI("vision: the drawable %s the device anchor it is given", cp_drawable_get_device_anchor(drawable) == anchor ? "keeps (no copy)" : "copies"); }
#if TARGET_OS_SIMULATOR
    // The first pose decides: an unmoved camera is exactly the origin (the camera may be moved before any
    // other pose arrives, so waiting for one off the origin would read a raised camera as an origin on the floor).
    if (!anchorTracked) {
      anchorTracked = true;
      // The compositor layer's space has its origin at the default camera (the eye); the RealityKit space's is on
      // the floor beneath it, as a device's (the head came back at 1.51 m).
      if (!g_rk && D.columns[3].y < 0.5f) g_floorBelowOrigin = kSimEyeHeight;
#else
    if (!anchorTracked && (fabsf(D.columns[3].y) > 0.01f || fabsf(D.columns[3].x) > 0.01f)) {
      anchorTracked = true;
      if (D.columns[3].y < 0.5f) g_floorBelowOrigin = 1.4f;  // an origin at the head: the floor goes 1.4 m under it
#endif
      g_headHeight = D.columns[3].y + g_floorBelowOrigin;
      g_localY = D.columns[3].y;   // LOCAL's origin, from here on fixed
      HOST_LOGI("vision: head tracked at %.2f %.2f %.2f; floor %.1f m below the origin, LOCAL %.2f m above the floor", D.columns[3].x, D.columns[3].y, D.columns[3].z, g_floorBelowOrigin, g_headHeight);
    }
    if (!g_anchorOnce) { g_anchorOnce = true; HOST_LOGI("vision: first device anchor at %.2f %.2f %.2f", D.columns[3].x, D.columns[3].y, D.columns[3].z); }
  } else if (!g_loggedNoAnchor) { g_loggedNoAnchor = true; HOST_LOGW("vision: no device anchor (status %d; world tracking warming up?)", (int)aq); }
  // Every change of the head pose (1 cm or ~1 deg), at most twice a second: does the simulator's camera reach ARKit?
  static simd_float4x4 lastD = matrix_identity_float4x4; static double lastChangeLogMs = 0; static int changeLogs = 0;
  {
    const simd_float3 dp = D.columns[3].xyz - lastD.columns[3].xyz, df = D.columns[2].xyz - lastD.columns[2].xyz;
    if ((simd_length(dp) > 0.01f || simd_length(df) > 0.017f) && steadyMs() - lastChangeLogMs > 500 && changeLogs < 400) {
      changeLogs++; lastChangeLogMs = steadyMs(); lastD = D;
      HOST_LOGI("vision: head moved: pos %.2f %.2f %.2f fwd %.2f %.2f %.2f (provider state %d, t %.1f)", D.columns[3].x, D.columns[3].y, D.columns[3].z, -D.columns[2].x, -D.columns[2].y, -D.columns[2].z, g_world ? (int)ar_data_provider_get_state(g_world) : -1, CACurrentMediaTime());
    }
  }
  // How often does the pose change at all (the simulator's tracking rate)? Per second, while it moves.
  // And how old is the pose a frame renders with: the anchor's own timestamp against the presentation time it
  // was asked for, and that presentation time against now (the prediction horizon).
  static simd_float4x4 prevD = matrix_identity_float4x4; static int secFrames = 0, secChanges = 0; static double secStart = 0, secAge = 0, secAgeMax = 0, secAhead = 0;
  { const bool changed = simd_length(D.columns[3].xyz - prevD.columns[3].xyz) > 1e-4f || simd_length(D.columns[2].xyz - prevD.columns[2].xyz) > 1e-4f; prevD = D; secFrames++; if (changed) secChanges++;
    if (aq == ar_device_anchor_query_status_success) { const double age = (presentT - ar_device_anchor_get_timestamp(anchor)) * 1000; secAge += age; secAgeMax = std::max(secAgeMax, age); secAhead += (presentT - CACurrentMediaTime()) * 1000; }
    const double now = steadyMs(); if (secStart == 0) secStart = now;
    if (now - secStart >= 1000) {
      if (secChanges > 0) HOST_LOGI("vision: tracking rate: %d distinct head poses in %d frames this second; pose %.1f ms (max %.1f) older than the presentation time, which is %.1f ms ahead", secChanges, secFrames, secAge / secFrames, secAgeMax, secAhead / secFrames);
      secStart = now; secFrames = secChanges = 0; secAge = secAgeMax = secAhead = 0;
    } }
  if (++anchorFrames % 180 == 1) {
    ar_device_anchor_t now = ar_device_anchor_create();
    const ar_device_anchor_query_status_t nq = g_world ? ar_world_tracking_provider_query_device_anchor_at_timestamp(g_world, CACurrentMediaTime(), now) : ar_device_anchor_query_status_failure;
    const simd_float4x4 N = nq == ar_device_anchor_query_status_success ? ar_anchor_get_origin_from_anchor_transform(now) : matrix_identity_float4x4;
    HOST_LOGI("vision: device anchor @present %d pos %.2f %.2f %.2f fwd %.2f %.2f %.2f | @now %d pos %.2f %.2f %.2f", (int)aq, D.columns[3].x, D.columns[3].y, D.columns[3].z, -D.columns[2].x, -D.columns[2].y, -D.columns[2].z, (int)nq, N.columns[3].x, N.columns[3].y, N.columns[3].z);
  }

  // --- refresh: measured from the presentation times (a mode change, or a first estimate that was wrong); the
  //     proxy's from RealityKit's scene updates per second ---
  if (g_rk) {
    static double secStart = 0; static int secFrames = 0;
    const double now = steadyMs(); if (secStart == 0) secStart = now; secFrames++;
    if (now - secStart >= 2000) {
      const float raw = secFrames * 1000.f / (float)(now - secStart);
      float hz = 0; for (float s : {60.f, 72.f, 90.f, 96.f, 100.f, 120.f}) if (hz == 0 || std::fabs(raw - s) < std::fabs(raw - hz)) hz = s;   // RealityKit's cadence wanders: the nearest standard rate
      if (raw >= 24 && raw <= 240 && std::fabs(hz - rate_) >= 1.f) { HOST_LOGI("vision: RealityKit updates at %.0f Hz (%.1f measured; was %.0f)", hz, raw, rate_); rate_ = hz; rates_ = {rate_}; rateChanged_ = true; frameState_.predictedDisplayPeriod = (XrDuration)(1e9 / rate_); }
      secStart = now; secFrames = 0;
    }
  } else if (const float hz = refreshFromGaps(presentT, 10); hz > 0 && std::fabs(hz - rate_) >= 1.f) {
    HOST_LOGI("vision: the compositor presents at %.0f Hz (was %.0f)", hz, rate_); rate_ = hz; rates_ = {rate_}; rateChanged_ = true; frameState_.predictedDisplayPeriod = (XrDuration)(1e9 / rate_);
  }

  const simd_float4x4 R = D;   // the render pose: ARKit's

  // --- views ---
  const size_t n = g_rk ? 1 : cp_drawable_get_view_count(drawable);
  out.viewCount = (uint32_t)std::min<size_t>(2, std::max<size_t>(1, n));
  for (uint32_t i = 0; i < out.viewCount; ++i) {
    simd_float4x4 W = R;
    XrViewInfo& v = out.views[i];
    if (g_rk) {  // the proxy: one view from the pose itself, the quad's symmetric frustum
      const float tY = tanf(g_proxyFovY / 2), tX = tY * (float)g_texW / (float)g_texH;
      v.fovL = -atanf(tX); v.fovR = atanf(tX); v.fovU = atanf(tY); v.fovD = -atanf(tY);
    } else {
      cp_view_t view = cp_drawable_get_view(drawable, i);
      W = simd_mul(R, cp_view_get_transform(view));
      fovOf(cp_drawable_compute_projection(drawable, cp_axis_direction_convention_right_up_back, i), v);
    }
    v.pos[0] = W.columns[3].x; v.pos[1] = W.columns[3].y; v.pos[2] = W.columns[3].z;  // raw ARKit = base space; matches the device anchor
    quatOf(W, v.quat);
  }
  if (g_rk) g_rkPose = R;
  // WEBXR_VISION_HEAD_STEP=1 (a diagnostic): the page's views jump 0.5 m in x every 120 frames, back and forth, so
  // how many frames the page takes to render from a new pose shows without moving the simulator's camera.
  static const bool headStep = [] { const char* v = getenv("WEBXR_VISION_HEAD_STEP"); return v && v[0] == '1'; }();
  static int stepFrames = 0;
  if (headStep && (++stepFrames / 120) % 2 == 1) for (uint32_t i = 0; i < out.viewCount; ++i) out.views[i].pos[0] += 0.5f;
  if (out.viewCount == 1) out.views[1] = out.views[0];  // one view (the simulator): the page renders mono, the record stays well-formed
  viewCount_ = (int)out.viewCount;
  if (!g_loggedViews) { g_loggedViews = true; const XrViewInfo& v = out.views[0]; HOST_LOGI("vision: view 0 fov %.1f/%.1f/%.1f/%.1f deg, eye at %.2f %.2f %.2f", v.fovL * 57.3f, v.fovR * 57.3f, v.fovU * 57.3f, v.fovD * 57.3f, v.pos[0], v.pos[1], v.pos[2]); }
  // LOCAL sits where the eye was when tracking started, in the base space (raw ARKit), and stays there (g_localY);
  // local-floor is derived from it (device: the stage, floor at base 0; simulator: LOCAL minus the runtime's 1.6 m
  // fallback, which equals kSimEyeHeight).
  out.localInBasePos[0] = 0; out.localInBasePos[1] = g_localY; out.localInBasePos[2] = 0;
  out.localInBaseQuat[0] = out.localInBaseQuat[1] = out.localInBaseQuat[2] = 0; out.localInBaseQuat[3] = 1;

  // --- controllers: a spatial event's ray (pinch at the gaze; the simulator's click), else the window's touch
  //     (as the desktop emulation: a ray from the left eye through the touch) ---
  out.input = XrInputState{};
  const XrViewInfo& eye = out.views[0];
  Spatial sp; { std::lock_guard<std::mutex> l(g_spatialMu);
    if (g_spatial.active && g_spatial.tapEndMs > 0 && steadyMs() > g_spatial.tapEndMs) { g_spatial.active = false; g_spatial.endedMs = steadyMs(); g_spatial.tapEndMs = 0; }  // a tap's press is over
    // The gazed point came as the tap's hit on the quad, 2 m out: the thing looked at is where the gaze ray meets
    // the page's geometry. The page's depth at that pixel gives the distance along the view axis, and the point
    // moves out along the ray to it (nothing drawn there: it stays on the quad). Once per tap.
    if (g_rk && g_spatial.hasHit && !g_spatial.resolved) {
      g_spatial.resolved = true;
      const simd_float4x4 inv = simd_inverse(g_rkPose);
      const simd_float4 v = simd_mul(inv, simd_make_float4(g_spatial.hit[0], g_spatial.hit[1], g_spatial.hit[2], 1));
      if (v.z < -0.05f) {
        const float tY = tanf(g_proxyFovY / 2), tX = tY * (float)g_texW / (float)g_texH;
        const float u = (v.x / -v.z) / tX * 0.5f + 0.5f, w = (v.y / -v.z) / tY * 0.5f + 0.5f;
        float metres = (u >= 0 && u <= 1 && w >= 0 && w <= 1) ? pageDepthAt(u, w, depthNear_, depthFar_) : 0;
        const bool drawn = metres > 0.01f;
        if (!drawn) metres = g_gazeFallback;   // a panel without depth (the page's menus), or passthrough: the menus' distance
        const float k = metres / -v.z;
        const simd_float4 at = simd_mul(g_rkPose, simd_make_float4(v.x * k, v.y * k, v.z * k, 1));   // scaled about the eye (w stays 1)
        HOST_LOGI("vision: gaze at %.2f m%s: the point (%.2f %.2f %.2f) → (%.2f %.2f %.2f)", metres, drawn ? "" : " (nothing with depth there: the menus' distance)", g_spatial.hit[0], g_spatial.hit[1], g_spatial.hit[2], at.x, at.y, at.z);
        g_spatial.hit[0] = at.x; g_spatial.hit[1] = at.y; g_spatial.hit[2] = at.z;
      }
    }
    sp = g_spatial; if (!sp.active && sp.hasRay && steadyMs() - sp.endedMs > 150) g_spatial.hasRay = false; }
  const bool spatialAim = sp.hasRay;
  if (spatialAim && sp.hand >= 0) g_w.mouseHand = sp.hand;
  // A click's ray and its press arrive together; the page gets the aim one frame before the trigger (a hover
  // first, as a controller's pointing would give it), then the trigger for as long as the pinch holds.
  static uint64_t aimedEventId = 0; static int aimedFrames = 0;
  if (spatialAim && sp.id != aimedEventId) { aimedEventId = sp.id; aimedFrames = 0; } else if (spatialAim) aimedFrames++;
  // A spatial event (a tap on the quad, a pinch at the gaze) presses the GAZE source below, not the controller:
  // the page fires at the gaze's own hit (its raycast into its scene, panels included). The window's touch
  // trigger stays the controller's.
  const bool tapPress = spatialAim && sp.active && aimedFrames >= 1;
  const bool trigger = c.trigger;
  const float nx = c.hasAim ? c.aimX : 0.5f, ny = c.hasAim ? c.aimY : 0.5f;
  const float tanL = tanf(eye.fovL), tanR = tanf(eye.fovR), tanU = tanf(eye.fovU), tanD = tanf(eye.fovD);
  const float tx = tanL + nx * (tanR - tanL), ty = tanU - ny * (tanU - tanD);
  float local[3] = {tx, ty, -1}, dirW[3]; qrot(eye.quat, local, dirW);
  const float up[3] = {0, 1, 0};
  for (int h = 0; h < 2; ++h) {
    XrHandState& hs = out.input.hand[h]; hs.active = true;
    const float side = h == 1 ? 1.f : -1.f;
    float pos[3], q[4];
    if (h == g_w.mouseHand && spatialAim) {
      // Transient pointer: from the hand (the platform's, else a hand's resting place by the head) at the gazed
      // point, so a shot leaves from where a hand would be, never from the camera.
      float headUp[3]; qrot(eye.quat, up, headUp);
      if (sp.hasHit) {
        // The hand stays where it is (the platform's hand, else a hand's resting place by the head: the launcher
        // never moves) and turns toward the resolved point. The page fires from its launcher's muzzle, 12 cm ahead
        // and 2 cm below the ray's origin, along the ray's direction, so the direction is solved for the muzzle to
        // meet the point (two rounds settle it); the ray through the point also picks the page's panels there.
        if (sp.hasHand) memcpy(pos, sp.o, sizeof pos);
        else { float rest[3] = {side * 0.16f, -0.26f, -0.3f}, ro[3]; qrot(eye.quat, rest, ro); for (int k = 0; k < 3; ++k) pos[k] = eye.pos[k] + ro[k]; }
        float dd[3]; for (int k = 0; k < 3; ++k) dd[k] = sp.hit[k] - pos[k];
        qlook(dd, headUp, q);
        for (int round = 0; round < 2; ++round) {
          const float muzzleLocal[3] = {0, -0.02f, -0.12f}; float mo[3]; qrot(q, muzzleLocal, mo);
          for (int k = 0; k < 3; ++k) dd[k] = sp.hit[k] - (pos[k] + mo[k]);
          qlook(dd, headUp, q);
        }
      } else {
        memcpy(pos, sp.o, sizeof pos);  // the spatial ray is already in base space (raw ARKit)
        qlook(sp.d, headUp, q);
      }
    } else if (h == g_w.mouseHand) {
      float rest[3] = {side * 0.16f, -0.26f, -0.3f}, ro[3]; qrot(eye.quat, rest, ro);
      for (int k = 0; k < 3; ++k) pos[k] = eye.pos[k] + ro[k];
      float target[3], dd[3]; for (int k = 0; k < 3; ++k) { target[k] = eye.pos[k] + dirW[k] * 3.f; dd[k] = target[k] - pos[k]; }
      float headUp[3]; qrot(eye.quat, up, headUp); qlook(dd, headUp, q);
    } else {
      float rest[3] = {side * 0.2f, -0.4f, -0.35f}, ro[3]; qrot(eye.quat, rest, ro);
      for (int k = 0; k < 3; ++k) pos[k] = eye.pos[k] + ro[k];
      float down[4], tilt[4]; qaxis(1, 0, 0, -0.35f, down); qmul(eye.quat, down, tilt); memcpy(q, tilt, sizeof tilt);
    }
    for (XrPoseF* p : {&hs.grip, &hs.aim}) { memcpy(p->pos, pos, sizeof pos); memcpy(p->quat, q, sizeof q); p->valid = true; }
  }
  // The gaze as a transient-pointer input source: the ray from the eye through the looked-at point (the quad's
  // tap resolved above; the compositor layer's selection ray as given), pressed for the tap.
  out.input.gazeActive = spatialAim;
  if (spatialAim) {
    float headUp[3]; qrot(eye.quat, up, headUp);
    if (sp.hasHit) { memcpy(out.input.gaze.pos, eye.pos, sizeof eye.pos); float dd[3]; for (int k = 0; k < 3; ++k) dd[k] = sp.hit[k] - eye.pos[k]; qlook(dd, headUp, out.input.gaze.quat); }
    else { memcpy(out.input.gaze.pos, sp.o, sizeof sp.o); qlook(sp.d, headUp, out.input.gaze.quat); }
    out.input.gaze.valid = true; out.input.gazePressed = tapPress; out.input.gazeValue = tapPress ? 1.f : 0.f;
  }
  if (g_w.focused) {
    XrHandState& m = out.input.hand[g_w.mouseHand]; XrHandState& o = out.input.hand[g_w.mouseHand ^ 1];
    setButton(m, 0, trigger); setButton(m, 1, c.squeeze); setButton(m, 3, c.stickClick); setButton(m, 4, c.a); setButton(m, 5, c.b);
    m.axes[2] = c.stick[0]; m.axes[3] = c.stick[1];
    if (m.axes[2] != 0 || m.axes[3] != 0) m.buttonTouched[3] = 1;
    setButton(o, 0, c.otherTrigger); setButton(o, 1, c.otherSqueeze);
    setButton(out.input.hand[0], 7, c.menu);
  }

  // --- the image: the page's texture (the proxy's size, or the drawable's, whose colour texture is imported) ---
  if (g_rk) {
    out.colorTexture = g_pageTex; out.shouldRender = true;
    out.width = g_texW; out.height = g_texH; out.arraySize = 1; out.imageIndex = 0;
  } else {
  id<MTLTexture> colour = cp_drawable_get_color_texture(drawable, 0);
  g_depthTex = cp_drawable_get_texture_count(drawable) > 0 ? cp_drawable_get_depth_texture(drawable, 0) : nil;
  const bool srgb = colour.pixelFormat == MTLPixelFormatBGRA8Unorm_sRGB || colour.pixelFormat == MTLPixelFormatRGBA8Unorm_sRGB;
  g_dstTex = importTexture(colour, srgb);
  g_dstDepth = (g_depthTex && !g_depthImportFailed) ? importTexture(g_depthTex, false) : 0;
  if (g_depthTex && !g_dstDepth && !g_depthImportFailed) { g_depthImportFailed = true; HOST_LOGW("vision: the compositor's depth texture cannot be imported: depth stays cleared to far"); }
  out.colorTexture = g_dstTex ? g_pageTex : 0;
  out.shouldRender = out.colorTexture != 0;
  out.width = (int)colour.width; out.height = (int)colour.height; out.arraySize = 1; out.imageIndex = 0;
  }
  out.displayTime = (XrTime)(wakeMs_ * 1e6); out.displayTimeMs = loopNowMs + 1000.0 / rate_;
  if (scene_.sceneActive()) scene_.locate(XR_NULL_HANDLE, 0);
  out.sceneGeneration = scene_.generation();
  return true;
}

// Present: GL's work ordered before the compositor reads the texture, the depth cleared to far (reverse-Z;
// the page's depth is converted in 17e), then encode_present + end submission.
// The page's texture into a Metal texture imported as GL texture `dst`, rows flipped (ANGLE keeps GL's bottom-up
// rows; Metal reads top-down). The page's GL state is put back afterwards.
static void blitPage(GLuint dst, int w, int h) {
  GLint prevRead = 0, prevDraw = 0; glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  const GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST); if (scissor) glDisable(GL_SCISSOR_TEST);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, g_blitRead); glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_pageTex, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_blitDraw); glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, dst, 0);
  if (g_dstIsSrgb && g_srgbWriteControl) glDisable(0x8DB9 /*GL_FRAMEBUFFER_SRGB_EXT*/);
  glBlitFramebuffer(0, 0, w, h, 0, h, w, 0, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  if (g_dstIsSrgb && g_srgbWriteControl) glEnable(0x8DB9);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0); glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  if (scissor) glEnable(GL_SCISSOR_TEST);
}

// The page's texture into the proxy's host texture, rows flipped, its premultiplied alpha made straight: WebXR
// composites the layer premultiplied (a faint additive glow, tiny alpha with colour, still adds its colour over
// passthrough; the page's room effects are drawn that way), RealityKit's unlit material reads straight alpha
// (colour times alpha: that glow would vanish). Where colour exceeds alpha the alpha is lifted to the brightest
// channel, so the glow shows at the cost of dimming passthrough a little more than the layer would.
static GLuint g_cvtProg = 0, g_cvtVao = 0; static GLint g_cvtTex = -1;
static void convertPage(GLuint dst, int w, int h) {
  if (!g_cvtProg) {
    static const char* vs = "#version 300 es\nout vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0); vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
    static const char* fs = "#version 300 es\nprecision highp float; uniform highp sampler2D uTex; in vec2 vUv; out vec4 o;\n"
      "void main(){ vec4 c = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)); float a = max(c.a, max(c.r, max(c.g, c.b))); o = a > 0.0 ? vec4(c.rgb / a, a) : vec4(0.0); }";
    auto compile = [](GLenum type, const char* src) { GLuint sh = glCreateShader(type); glShaderSource(sh, 1, &src, nullptr); glCompileShader(sh); return sh; };
    GLuint v = compile(GL_VERTEX_SHADER, vs), f = compile(GL_FRAGMENT_SHADER, fs);
    g_cvtProg = glCreateProgram(); glAttachShader(g_cvtProg, v); glAttachShader(g_cvtProg, f); glLinkProgram(g_cvtProg); glDeleteShader(v); glDeleteShader(f);
    GLint ok = 0; glGetProgramiv(g_cvtProg, GL_LINK_STATUS, &ok); if (!ok) { HOST_LOGE("vision: alpha conversion program failed to link"); glDeleteProgram(g_cvtProg); g_cvtProg = 0; blitPage(dst, w, h); return; }
    g_cvtTex = glGetUniformLocation(g_cvtProg, "uTex"); glGenVertexArrays(1, &g_cvtVao);
  }
  GLint prog = 0, vao = 0, unit = 0, tex0 = 0, fbR = 0, fbD = 0, vp[4]; GLboolean dtest, cmask[4], scissor, cull, blend, stencil;
  glGetIntegerv(GL_CURRENT_PROGRAM, &prog); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao); glGetIntegerv(GL_ACTIVE_TEXTURE, &unit);
  glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &tex0);
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &fbR); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbD); glGetIntegerv(GL_VIEWPORT, vp);
  dtest = glIsEnabled(GL_DEPTH_TEST); glGetBooleanv(GL_COLOR_WRITEMASK, cmask); scissor = glIsEnabled(GL_SCISSOR_TEST); cull = glIsEnabled(GL_CULL_FACE); blend = glIsEnabled(GL_BLEND); stencil = glIsEnabled(GL_STENCIL_TEST);
  glBindFramebuffer(GL_FRAMEBUFFER, g_blitDraw); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, dst, 0);
  const GLenum c0 = GL_COLOR_ATTACHMENT0; glDrawBuffers(1, &c0);
  glUseProgram(g_cvtProg); glBindVertexArray(g_cvtVao); glBindTexture(GL_TEXTURE_2D, g_pageTex); glUniform1i(g_cvtTex, 0);
  glViewport(0, 0, w, h); glDisable(GL_SCISSOR_TEST); glDisable(GL_CULL_FACE); glDisable(GL_BLEND); glDisable(GL_STENCIL_TEST); glDisable(GL_DEPTH_TEST); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  if (g_dstIsSrgb && g_srgbWriteControl) glDisable(0x8DB9 /*GL_FRAMEBUFFER_SRGB_EXT*/);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  if (g_dstIsSrgb && g_srgbWriteControl) glEnable(0x8DB9);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  glUseProgram((GLuint)prog); glBindVertexArray((GLuint)vao); glBindTexture(GL_TEXTURE_2D, (GLuint)tex0); glActiveTexture((GLenum)unit);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)fbR); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)fbD); glViewport(vp[0], vp[1], vp[2], vp[3]);
  if (dtest) glEnable(GL_DEPTH_TEST); glColorMask(cmask[0], cmask[1], cmask[2], cmask[3]);
  if (scissor) glEnable(GL_SCISSOR_TEST); if (cull) glEnable(GL_CULL_FACE); if (blend) glEnable(GL_BLEND); if (stencil) glEnable(GL_STENCIL_TEST);
}

// GL's work so far as a Metal shared event (ANGLE's EGL_ANGLE_metal_shared_event_sync): nil when unsupported,
// in which case the caller finishes GL instead. The sync is the caller's to destroy.
static id<MTLSharedEvent> glSharedEvent(EGLSync& sync, uint64_t& value) {
  sync = EGL_NO_SYNC; value = 0;
  if (!g_sharedEventSync) return nil;
  value = ++g_syncValue;
  const EGLAttrib attribs[] = { kSyncSignalValueHi, (EGLAttrib)(value >> 32), kSyncSignalValueLo, (EGLAttrib)(value & 0xffffffffu), EGL_NONE };
  sync = p_eglCreateSync(g_egl->display(), kSyncMetalSharedEventAngle, attribs);
  if (sync == EGL_NO_SYNC) return nil;
  id<MTLSharedEvent> event = (__bridge id<MTLSharedEvent>)p_eglCopyMetalSharedEventANGLE(g_egl->display(), sync);
  glFlush();
  return event;
}

void OpenXrDevice::endFrame(const XrFrameInfo& f, bool submit) {
  if (g_rk) {
    // The proxy: the page into the LowLevelTexture's current Metal texture, the shell orders and commits it and
    // moves the quad to the frame's pose. Nothing rendered: the quad keeps the last frame.
    if (submit && f.colorTexture && g_proxyBegin && g_proxyEnd) {
      void* raw = g_proxyBegin();
      id<MTLTexture> target = raw ? (__bridge id<MTLTexture>)raw : nil;
      GLuint dst = 0;
      if (target) { const bool srgb = target.pixelFormat == MTLPixelFormatBGRA8Unorm_sRGB || target.pixelFormat == MTLPixelFormatRGBA8Unorm_sRGB; dst = importTexture(target, srgb); }
      if (dst) convertPage(dst, f.width, f.height);
      EGLSync sync = EGL_NO_SYNC; uint64_t value = 0;
      id<MTLSharedEvent> event = dst ? glSharedEvent(sync, value) : nil;
      if (dst && !event) glFinish();
      float pose16[16]; memcpy(pose16, &g_rkPose, sizeof pose16);
      if (raw) g_proxyEnd(event ? (__bridge void*)event : nullptr, value, pose16);
      if (sync != EGL_NO_SYNC) p_eglDestroySync(g_egl->display(), sync);
      static bool once = false; if (!once) { once = true; HOST_LOGI("vision: first frame onto the RealityKit quad (%s, texture %s)", event ? "shared-event ordered" : "glFinish", dst ? "imported" : "NOT imported"); }
    }
    g_lastWakeMs = steadyMs(); g_lastPresentMs = g_lastWakeMs;
    return;
  }
  if (!g_frame) return;
  if (!(submit && f.colorTexture) && g_drawable) presentCleared(g_drawable);
  else if (submit && f.colorTexture && g_drawable) {
    blitPage(g_dstTex, f.width, f.height);
    // WEBXR_VISION_DEPTH=0 (SIMCTL_CHILD_WEBXR_VISION_DEPTH on a simulator launch) leaves the compositor's depth at
    // far: a comparison when reprojection misbehaves.
    static const bool depthOff = [] { const char* v = getenv("WEBXR_VISION_DEPTH"); return v && v[0] == '0'; }();
    static float loggedNear = -1, loggedFar = -1;
    const bool depthDone = g_dstDepth && g_pageDepth && !depthOff;
    if (depthDone) {
      const simd_float2 dr = cp_drawable_get_depth_range(g_drawable);
      if (depthNear_ != loggedNear || depthFar_ != loggedFar) { loggedNear = depthNear_; loggedFar = depthFar_; HOST_LOGI("vision: depth pass with the page's near %.2f far %.0f into the compositor's %.2f..%.0f", depthNear_, depthFar_, dr.y, dr.x); }
      runDepthPass(g_dstDepth, f.width, f.height, depthNear_, depthFar_, dr.y, dr.x);
      static const bool probe = [] { const char* v = getenv("WEBXR_VISION_DEPTH_PROBE"); return v && v[0] == '1'; }();
      static int probeFrames = 0;
      if (probe && ++probeFrames % 300 == 0) {
        GLint pr = 0, va = 0, fb = 0, tx = 0, unit = 0, vp[4]; GLboolean cm[4];
        glGetIntegerv(GL_CURRENT_PROGRAM, &pr); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &va); glGetIntegerv(GL_FRAMEBUFFER_BINDING, &fb); glGetIntegerv(GL_ACTIVE_TEXTURE, &unit);
        glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &tx); glGetIntegerv(GL_VIEWPORT, vp); glGetBooleanv(GL_COLOR_WRITEMASK, cm);
        const GLboolean dt = glIsEnabled(GL_DEPTH_TEST), sc = glIsEnabled(GL_SCISSOR_TEST), bl = glIsEnabled(GL_BLEND);
        probePageDepth(g_pageDepth, g_pageTex, depthNear_, depthFar_);
        glUseProgram((GLuint)pr); glBindVertexArray((GLuint)va); glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)fb); glBindTexture(GL_TEXTURE_2D, (GLuint)tx); glActiveTexture((GLenum)unit); glViewport(vp[0], vp[1], vp[2], vp[3]);
        glColorMask(cm[0], cm[1], cm[2], cm[3]); if (dt) glEnable(GL_DEPTH_TEST); if (sc) glEnable(GL_SCISSOR_TEST); if (bl) glEnable(GL_BLEND);
      }
    } else if (depthOff) { static bool once = false; if (!once) { once = true; HOST_LOGI("vision: depth pass OFF (WEBXR_VISION_DEPTH=0): the compositor gets far everywhere"); } }
    id<MTLCommandBuffer> cb = [g_queue commandBuffer];
    id<MTLSharedEvent> event = nil; EGLSync sync = EGL_NO_SYNC;
    if (g_sharedEventSync) {
      const uint64_t v = ++g_syncValue;
      const EGLAttrib attribs[] = { kSyncSignalValueHi, (EGLAttrib)(v >> 32), kSyncSignalValueLo, (EGLAttrib)(v & 0xffffffffu), EGL_NONE };
      sync = p_eglCreateSync(g_egl->display(), kSyncMetalSharedEventAngle, attribs);
      if (sync != EGL_NO_SYNC) { event = (__bridge id<MTLSharedEvent>)p_eglCopyMetalSharedEventANGLE(g_egl->display(), sync); glFlush(); [cb encodeWaitForEvent:event value:v]; }
    }
    if (!event) glFinish();
    if (g_depthTex && !depthDone) {
      MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
      rp.depthAttachment.texture = g_depthTex; rp.depthAttachment.loadAction = MTLLoadActionClear; rp.depthAttachment.storeAction = MTLStoreActionStore; rp.depthAttachment.clearDepth = 0.0;  // reverse-Z: far
      id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp]; [enc endEncoding];
    }
    // WEBXR_VISION_DEPTH_PROBE: the compositor's depth texture as it will present it, on the same 9x5 grid as the
    // page probe (Metal's rows top-down), read on the GPU's completion thread.
    {
      static const bool probe = [] { const char* v = getenv("WEBXR_VISION_DEPTH_PROBE"); return v && v[0] == '1'; }();
      static int probeFrames = 0;
      if (probe && g_depthTex && ++probeFrames % 300 == 150) {
        id<MTLBuffer> buf = [g_device newBufferWithLength:9 * 5 * 4 options:MTLResourceStorageModeShared];
        id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
        const NSUInteger W = g_depthTex.width, H = g_depthTex.height;
        for (int r = 0; r < 5; ++r) for (int c = 0; c < 9; ++c)
          [blit copyFromTexture:g_depthTex sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake((NSUInteger)((c + 0.5) * W / 9), (NSUInteger)((r + 0.5) * H / 5), 0) sourceSize:MTLSizeMake(1, 1, 1)
                       toBuffer:buf destinationOffset:(r * 9 + c) * 4 destinationBytesPerRow:4 destinationBytesPerImage:4];
        [blit endEncoding];
        const simd_float2 dr = cp_drawable_get_depth_range(g_drawable);
        [cb addCompletedHandler:^(id<MTLCommandBuffer>) {
          const float* z = (const float*)buf.contents; const float n = dr.y, f = dr.x;
          HOST_LOGI("vision: compositor depth probe: metres (reverse-Z, %.2f..%.0f) on a 9x5 grid, top row first", n, f);
          for (int r = 0; r < 5; ++r) {
            char line[256]; int o = 0;
            for (int c = 0; c < 9; ++c) { const float d = z[r * 9 + c]; const float e = d > 0 ? n * f / (d * (f - n) + n) : INFINITY; o += snprintf(line + o, sizeof line - o, " %7.2f", e); }
            HOST_LOGI("vision:   %s", line);
          }
        }];
      }
    }
    cp_drawable_encode_present(g_drawable, cb);
    // When does a frame's work finish against its rendering deadline and presentation time? Late frames are
    // shown later than the head pose they were rendered for. Summed here and on the GPU's completion thread,
    // logged once a second from the host thread.
    {
      static std::mutex mu; static double sumLate = 0, maxLate = 0, sumSubmit = 0; static int n = 0, missed = 0; static double lastLog = 0;
      const double deadline = cp_time_to_cf_time_interval(cp_frame_timing_get_rendering_deadline(g_timing));
      const double present = cp_time_to_cf_time_interval(cp_frame_timing_get_presentation_time(g_timing));
      const double submit = CACurrentMediaTime();
      [cb addCompletedHandler:^(id<MTLCommandBuffer>) {
        const double done = CACurrentMediaTime();
        std::lock_guard<std::mutex> l(mu);
        sumLate += (done - present) * 1000; maxLate = std::max(maxLate, (done - present) * 1000); sumSubmit += (submit - deadline) * 1000; n++; if (done > deadline) missed++;
      }];
      std::lock_guard<std::mutex> l(mu);
      if (n > 0 && submit - lastLog >= 1.0) {
        HOST_LOGI("vision: frame timing: GPU done %.1f ms after the presentation time (max %.1f), submitted %.1f ms after the rendering deadline, %d of %d past the deadline", sumLate / n, maxLate, sumSubmit / n, missed, n);
        lastLog = submit; sumLate = maxLate = sumSubmit = 0; n = missed = 0;
      }
    }
    [cb commit];
    if (sync != EGL_NO_SYNC) p_eglDestroySync(g_egl->display(), sync);
  }
  cp_frame_end_submission(g_frame);
  g_frame = nullptr; g_timing = nullptr; g_drawable = nullptr; g_depthTex = nil;
  g_lastWakeMs = steadyMs(); g_lastPresentMs = g_lastWakeMs;
  g_frameMu.unlock();
}

// ---- scene understanding: ARKit's planes and room mesh as the page's detectedPlanes / detectedMeshes ----------
// The providers report on their own queue; each report becomes a pending entry (geometry copied there, off the
// frame path). locate(), on the host thread each frame, folds the pending entries into the entity list (slots,
// generation) and writes the pose record from the anchors' transforms. WebXR's plane convention is ARKit's
// (+Y normal, the polygon on y = 0 in the anchor's space); mesh vertices are in the anchor's space.
namespace {
struct ScenePending { int kind = 0; bool removed = false; std::string label; std::vector<float> polygon, vertices; std::vector<uint32_t> indices; simd_float4x4 T = matrix_identity_float4x4; bool geometryChanged = false; };
std::mutex g_sceneMu; std::unordered_map<std::string, ScenePending> g_scenePending; std::unordered_map<std::string, simd_float4x4> g_scenePose;
ar_plane_detection_provider_t g_planes = nullptr; ar_scene_reconstruction_provider_t g_meshes = nullptr; dispatch_queue_t g_sceneQueue = nil;
bool g_sceneRunning = false, g_sceneAuthAsked = false; int g_sceneLogged = 0;

std::string uuidOf(ar_anchor_t a) { uuid_t u; ar_anchor_get_identifier(a, u); char h[37]; uuid_unparse_lower(u, h); return h; }
// A synthetic plane as a mesh entity too (a triangle fan over its polygon, in the plane's own space, the same
// pose): the simulator senses no room mesh, and the page's room effects (the wall a shot splashes on) install
// from detected MESHES only, as a device's ARKit room mesh would give them. Under g_sceneMu.
void addMeshForPlane(const std::string& id, const std::vector<float>& polygon, const simd_float4x4& T) {
  if (polygon.size() < 6) return;
  ScenePending m; m.kind = 2; m.label = "global mesh"; m.geometryChanged = true;
  const size_t n = polygon.size() / 2;
  for (size_t i = 0; i < n; ++i) { m.vertices.push_back(polygon[i * 2]); m.vertices.push_back(0.f); m.vertices.push_back(polygon[i * 2 + 1]); }
  for (size_t i = 1; i + 1 < n; ++i) { m.indices.push_back(0); m.indices.push_back((uint32_t)i); m.indices.push_back((uint32_t)(i + 1)); }
  g_scenePending[id] = std::move(m); g_scenePose[id] = T;
}
const char* planeLabel(ar_plane_classification_t c) {
  switch (c) {
    case ar_plane_classification_wall: return "wall"; case ar_plane_classification_floor: return "floor"; case ar_plane_classification_ceiling: return "ceiling";
    case ar_plane_classification_table: return "table"; case ar_plane_classification_seat: return "couch"; case ar_plane_classification_window: return "window";
    case ar_plane_classification_door: return "door"; default: return "other";
  }
}
bool onPlane(void* ctx, ar_plane_anchor_t a) {
  const bool removed = ctx != nullptr;
  ScenePending e; e.kind = 1; e.removed = removed;
  if (!removed) {
    e.label = planeLabel(ar_plane_anchor_get_plane_classification(a));
    e.T = ar_anchor_get_origin_from_anchor_transform(a);
    ar_plane_geometry_t g = ar_plane_anchor_get_geometry(a); ar_plane_extent_t ext = ar_plane_geometry_get_plane_extent(g);
    const float w = ar_plane_extent_get_width(ext) / 2, h = ar_plane_extent_get_height(ext) / 2;
    const simd_float4x4 M = ar_plane_extent_get_plane_anchor_from_plane_extent_transform(ext);
    const float corners[4][2] = {{-w, -h}, {w, -h}, {w, h}, {-w, h}};
    for (auto& c : corners) { simd_float4 p = simd_mul(M, simd_make_float4(c[0], 0, c[1], 1)); e.polygon.push_back(p.x); e.polygon.push_back(p.z); }
    e.geometryChanged = true;
  }
  std::lock_guard<std::mutex> l(g_sceneMu); const std::string id = uuidOf(a); g_scenePending[id] = std::move(e); if (!removed) g_scenePose[id] = ar_anchor_get_origin_from_anchor_transform(a);
  return true;
}
bool onMesh(void* ctx, ar_mesh_anchor_t a) {
  const bool removed = ctx != nullptr;
  ScenePending e; e.kind = 2; e.removed = removed; e.label = "global mesh";
  if (!removed) {
    e.T = ar_anchor_get_origin_from_anchor_transform(a);
    ar_mesh_geometry_t g = ar_mesh_anchor_get_geometry(a);
    ar_geometry_source_t vs = ar_mesh_geometry_get_vertices(g); ar_geometry_element_t fs = ar_mesh_geometry_get_faces(g);
    const size_t n = ar_geometry_source_get_count(vs), stride = ar_geometry_source_get_stride(vs), off = ar_geometry_source_get_offset(vs);
    const uint8_t* vb = (const uint8_t*)[ar_geometry_source_get_buffer(vs) contents] + off;
    e.vertices.resize(n * 3); for (size_t i = 0; i < n; ++i) memcpy(&e.vertices[i * 3], vb + i * stride, 12);
    const size_t tris = ar_geometry_element_get_count(fs), bpi = ar_geometry_element_get_bytes_per_index(fs);
    const uint8_t* ib = (const uint8_t*)[ar_geometry_element_get_buffer(fs) contents];
    e.indices.resize(tris * 3); for (size_t i = 0; i < tris * 3; ++i) e.indices[i] = bpi == 2 ? ((const uint16_t*)ib)[i] : ((const uint32_t*)ib)[i];
    e.geometryChanged = true;
  }
  std::lock_guard<std::mutex> l(g_sceneMu); const std::string id = uuidOf(a); g_scenePending[id] = std::move(e); if (!removed) g_scenePose[id] = ar_anchor_get_origin_from_anchor_transform(a);
  return true;
}
void onPlanes(void*, ar_plane_anchors_t added, ar_plane_anchors_t updated, ar_plane_anchors_t removed) {
  ar_plane_anchors_enumerate_anchors_f(added, nullptr, onPlane); ar_plane_anchors_enumerate_anchors_f(updated, nullptr, onPlane); ar_plane_anchors_enumerate_anchors_f(removed, (void*)1, onPlane);
}
void onMeshes(void*, ar_mesh_anchors_t added, ar_mesh_anchors_t updated, ar_mesh_anchors_t removed) {
  ar_mesh_anchors_enumerate_anchors_f(added, nullptr, onMesh); ar_mesh_anchors_enumerate_anchors_f(updated, nullptr, onMesh); ar_mesh_anchors_enumerate_anchors_f(removed, (void*)1, onMesh);
}
// World sensing needs the person's permission; the providers start once it is given.
void sceneRunProviders() {
  if (g_sceneRunning || !g_ar) return;
  g_sceneQueue = dispatch_queue_create("webxr-host.scene", DISPATCH_QUEUE_SERIAL);
  ar_data_providers_t providers = ar_data_providers_create();
  ar_data_providers_add_data_provider(providers, g_world);
  if (ar_plane_detection_provider_is_supported()) {
    ar_plane_detection_configuration_t pc = ar_plane_detection_configuration_create();
    ar_plane_detection_configuration_set_alignment(pc, (ar_plane_alignment_t)(ar_plane_alignment_horizontal | ar_plane_alignment_vertical));
    g_planes = ar_plane_detection_provider_create(pc);
    ar_plane_detection_provider_set_update_handler_f(g_planes, g_sceneQueue, nullptr, onPlanes);
    ar_data_providers_add_data_provider(providers, g_planes);
  }
  if (ar_scene_reconstruction_provider_is_supported()) {
    g_meshes = ar_scene_reconstruction_provider_create(ar_scene_reconstruction_configuration_create());
    ar_scene_reconstruction_provider_set_update_handler_f(g_meshes, g_sceneQueue, nullptr, onMeshes);
    ar_data_providers_add_data_provider(providers, g_meshes);
  }
  ar_session_run(g_ar, providers);  // the world tracking provider again, with the room's: a run replaces the set
  g_sceneRunning = true;
  HOST_LOGI("vision: scene understanding running (planes %s, mesh %s)", g_planes ? "yes" : "unsupported", g_meshes ? "yes" : "unsupported");
}
#if TARGET_OS_SIMULATOR
// The simulator senses nothing, but the room it renders (Settings' synthetic environment, the device's
// com.apple.RealityEnvironment activeSyntheticEnvironment) has its classified planes in its USD: tools/sim-rooms.mjs
// extracts them into the app as sim-rooms.json, in the room's frame, which is the base space here (the floor at
// y = 0 under the default camera, -Z ahead). False: no file, or a room it does not have.
bool simRoomPlanes() {
  NSString* json = [[NSBundle mainBundle] pathForResource:@"sim-rooms" ofType:@"json"];
  NSString* home = NSHomeDirectory();  // <device>/data/Containers/Data/Application/<id>
  const NSRange data = [home rangeOfString:@"/data/"];
  if (!json || data.location == NSNotFound) return false;
  NSString* prefs = [[home substringToIndex:data.location] stringByAppendingString:@"/data/Library/Preferences/com.apple.RealityEnvironment.plist"];
  id env = [NSDictionary dictionaryWithContentsOfFile:prefs][@"activeSyntheticEnvironment"];
  NSString* text = [NSString stringWithContentsOfFile:json encoding:NSUTF8StringEncoding error:nil];
  if (![env isKindOfClass:[NSString class]] || !text) return false;
  const Json rooms = Json::parse(text.UTF8String).at("rooms");
  const Json& planes = rooms.at([env UTF8String]);
  if (planes.type != Json::Array || planes.arr.empty()) { HOST_LOGW("vision: sim-rooms.json has no %s", [env UTF8String]); return false; }
  std::lock_guard<std::mutex> l(g_sceneMu);
  for (const Json& p : planes.arr) {
    const Json& pose = p.at("pose");
    if (pose.arr.size() != 16) continue;
    ScenePending e; e.kind = 1; e.label = p.s("label", "other"); e.geometryChanged = true;
    for (const Json& v : p.at("polygon").arr) e.polygon.push_back((float)v.num);
    simd_float4x4 T;
    for (int c = 0; c < 4; ++c) T.columns[c] = simd_make_float4((float)pose.arr[c * 4].num, (float)pose.arr[c * 4 + 1].num, (float)pose.arr[c * 4 + 2].num, (float)pose.arr[c * 4 + 3].num);
    const std::string id = "simulator-" + p.s("name");  // already in the base space (locate() leaves it unlifted)
    addMeshForPlane(id + "-mesh", e.polygon, T);
    g_scenePending[id] = std::move(e); g_scenePose[id] = T;
  }
  HOST_LOGI("vision: the simulator's %s: %zu planes from its scene understanding (sim-rooms.json)", [env UTF8String], planes.arr.size());
  return true;
}
#endif
}  // namespace

void XrScene::startScene() {
  if (sceneActive_) return;
  sceneActive_ = true;
  if (!g_ar) arStart();
  if (!g_ar) return;
  if (!ar_plane_detection_provider_is_supported() && !ar_scene_reconstruction_provider_is_supported()) {
#if TARGET_OS_SIMULATOR
    if (simRoomPlanes()) return;
#endif
    // No room sensing at all. A 6 x 6 x 2.6 m room of planes about the origin stands in (the
    // floor, four walls), so the page's room placement (planes as its targets) has surfaces. Poses in the BASE
    // space (floor at y = 0; locate() leaves "simulator-" entries unlifted): WebXR's plane space has +Y as the
    // normal and the polygon on y = 0, so a wall's space is the floor's rotated to face into the room.
    std::lock_guard<std::mutex> l(g_sceneMu);
    auto plane = [&](const char* id, const char* label, simd_float3 pos, simd_float3 X, simd_float3 Y, float halfW, float z0, float z1) {
      const simd_float3 Z = simd_cross(X, Y);
      ScenePending e; e.kind = 1; e.label = label; e.polygon = {-halfW, z0, halfW, z0, halfW, z1, -halfW, z1}; e.geometryChanged = true;
      simd_float4x4 T = matrix_identity_float4x4;
      T.columns[0] = simd_make_float4(X, 0); T.columns[1] = simd_make_float4(Y, 0); T.columns[2] = simd_make_float4(Z, 0); T.columns[3] = simd_make_float4(pos, 1);
      addMeshForPlane(std::string(id) + "-mesh", e.polygon, T);
      g_scenePending[id] = std::move(e); g_scenePose[id] = T;
    };
    const float R = 3.f, H = 2.6f;
    plane("simulator-floor", "floor", simd_make_float3(0, 0, 0), simd_make_float3(1, 0, 0), simd_make_float3(0, 1, 0), R, -R, R);
    // Walls: X along the wall, Y the inward normal; Z = X x Y is vertical, up or down, so the height spans
    // [0, H] or [-H, 0] in the plane's z.
    struct Wall { const char* id; simd_float3 pos, X, Y; } walls[] = {
      {"simulator-wall-n", simd_make_float3(0, 0, -R), simd_make_float3(1, 0, 0), simd_make_float3(0, 0, 1)},
      {"simulator-wall-s", simd_make_float3(0, 0, R), simd_make_float3(-1, 0, 0), simd_make_float3(0, 0, -1)},
      {"simulator-wall-e", simd_make_float3(R, 0, 0), simd_make_float3(0, 0, 1), simd_make_float3(-1, 0, 0)},
      {"simulator-wall-w", simd_make_float3(-R, 0, 0), simd_make_float3(0, 0, -1), simd_make_float3(1, 0, 0)},
    };
    for (const Wall& w : walls) { const float zy = simd_cross(w.X, w.Y).y; plane(w.id, "wall", w.pos, w.X, w.Y, R, zy > 0 ? 0 : -H, zy > 0 ? H : 0); }
    HOST_LOGI("vision: no room sensing here: a synthetic 6 x 6 x 2.6 m room (floor + 4 walls) stands in");
    return;
  }
  if (g_sceneAuthAsked) { sceneRunProviders(); return; }
  g_sceneAuthAsked = true;
  ar_session_request_authorization(g_ar, ar_authorization_type_world_sensing, ^(ar_authorization_results_t results, ar_error_t error) {
    __block bool allowed = false;
    if (results) ar_authorization_results_enumerate_results_f(results, &allowed, [](void* ctx, ar_authorization_result_t r) { if (ar_authorization_result_get_status(r) == ar_authorization_status_allowed) *(bool*)ctx = true; return true; });
    HOST_LOGI("vision: world sensing %s", allowed ? "allowed" : "not allowed (planes and meshes withheld)");
    if (allowed) sceneRunProviders();
  });
}
void XrScene::stopScene() { sceneActive_ = false; std::lock_guard<std::mutex> l(g_sceneMu); for (auto& e : entities_) { ScenePending p; p.kind = e.kind; p.removed = true; g_scenePending[e.id] = p; } }
bool XrScene::requery() { return sceneActive_; }
bool XrScene::requestCapture() { return false; }
void XrScene::setPassthroughVisible(bool visible) { ptVisible_ = visible; }
// Per frame on the host thread: pending reports into the list, poses from the anchors' transforms.
void XrScene::locate(XrSpace, XrTime) {
  std::lock_guard<std::mutex> l(g_sceneMu);
  if (!g_scenePending.empty()) {
    bool listChanged = false;
    for (auto& [id, p] : g_scenePending) {
      auto it = std::find_if(entities_.begin(), entities_.end(), [&](const SceneEntity& e) { return e.id == id; });
      if (p.removed) { if (it != entities_.end()) { entities_.erase(it); g_scenePose.erase(id); listChanged = true; } continue; }
      if (it == entities_.end()) { if (entities_.size() >= (size_t)kMaxEntities) continue; SceneEntity e; e.id = id; e.kind = p.kind; e.slot = -1; entities_.push_back(std::move(e)); it = entities_.end() - 1; listChanged = true; }
      if (p.geometryChanged) { it->label = p.label; it->polygon = std::move(p.polygon); it->vertices = std::move(p.vertices); it->indices = std::move(p.indices); it->changed++; it->described = true; listChanged = true; }
    }
    g_scenePending.clear();
    if (listChanged) {
      std::vector<bool> used(kMaxEntities, false); for (auto& e : entities_) if (e.slot >= 0) used[e.slot] = true;
      for (auto& e : entities_) if (e.slot < 0) for (int i = 0; i < kMaxEntities; ++i) if (!used[i]) { e.slot = i; used[i] = true; break; }
      generation_++;
      if (g_sceneLogged < 5) { g_sceneLogged++; int np = 0, nm = 0; for (auto& e : entities_) (e.kind == 1 ? np : nm)++; HOST_LOGI("vision: scene list #%u: %d planes, %d meshes", generation_, np, nm); }
    }
  }
  memset(poses_, 0, sizeof poses_);
  for (auto& e : entities_) {
    auto pit = g_scenePose.find(e.id); if (e.slot < 0 || pit == g_scenePose.end()) { e.poseValid = false; continue; }
    const simd_float4x4& T = pit->second; e.poseValid = true;
    // Base space is raw ARKit. ARKit's own planes are already there; the synthetic room's are in room space (its
    // floor at y = 0), so they drop to the ARKit floor (kSimEyeHeight below the eye origin) to sit under the room.
    const bool synthetic = e.id.rfind("simulator-", 0) == 0;
    e.pos[0] = T.columns[3].x; e.pos[1] = T.columns[3].y - (synthetic ? g_floorBelowOrigin : 0); e.pos[2] = T.columns[3].z; quatOf(T, e.quat);
    float* r = poses_ + e.slot * kPoseStride; r[0] = 1; r[1] = e.pos[0]; r[2] = e.pos[1]; r[3] = e.pos[2]; r[4] = e.quat[0]; r[5] = e.quat[1]; r[6] = e.quat[2]; r[7] = e.quat[3];
  }
}

// --- the parts of a Quest this has no counterpart for ---
void XrInput::vibrate(int, float, float, float) {}
const char* xrResultName(XrInstance, XrResult) { return "vision"; }

}  // namespace host

// ---- the shell's bridge (vision/vision_bridge.h) ----
extern "C" void hostVisionSetXrCallback(void (*cb)(bool)) { host::g_xrCb = cb; }
extern "C" bool hostVisionXrActive(void) { return host::g_xrShellActive; }
extern "C" void hostVisionSpatialEvent(uint64_t id, int active, int hasRay, float ox, float oy, float oz, float dx, float dy, float dz, int hand) {
  std::lock_guard<std::mutex> l(host::g_spatialMu);
  host::Spatial& s = host::g_spatial;
  if (active) { s.active = true; s.id = id; s.hand = hand; s.hasHit = false; if (hasRay) { s.hasRay = true; s.o[0] = ox; s.o[1] = oy; s.o[2] = oz; s.d[0] = dx; s.d[1] = dy; s.d[2] = dz; } }
  else if (s.id == id) { s.active = false; s.endedMs = host::steadyMs(); }
}
extern "C" bool hostVisionRealityKitPresent(void) {
  static const bool rk = [] {
    const char* v = getenv("WEBXR_VISION_PRESENT");
    if (v && v[0]) return strcmp(v, "rk") == 0 || strcmp(v, "realitykit") == 0;
#if TARGET_OS_SIMULATOR
    return true;
#else
    return false;
#endif
  }();
  return rk;
}
extern "C" void hostVisionProxyAttach(int width, int height, float fovYRadians, float distance, HostVisionProxyBegin begin, HostVisionProxyEnd end) {
  host::g_proxyW = width; host::g_proxyH = height; host::g_proxyFovY = fovYRadians; host::g_proxyDist = distance;
  host::g_proxyEnd = end; host::g_proxyBegin = begin;   // begin last: createSwapchain waits on it
  HOST_LOGI("vision: RealityKit proxy attached (%dx%d)", width, height);
}
bool host::emu::sessionEndRequested() { return false; }   // a closed space hides the session (pollEvents, hostVisionProxyDetach); only the page ends it
bool host::emu::enterRequested() { return host::g_enterRequested.exchange(false); }
extern "C" void hostVisionEnterRequested(void) { host::g_enterRequested = true; }
extern "C" void hostVisionProxyDetach(void) {
  { std::lock_guard<std::mutex> l(host::g_proxyMu); host::g_proxyBegin = nullptr; host::g_proxyEnd = nullptr; }
  host::g_proxyCv.notify_all();
  // The session stays, hidden (as the Quest's system menu hides a session): the page keeps its state and gets
  // no frames until the space is back (the shell reopens it on the person's return) and it is visible again.
  HOST_LOGI("vision: the immersive space closed: the page's XR session hides until the space is back");
}
extern "C" void hostVisionSetSpaceCallback(void (*cb)(void)) { host::g_spaceCb = cb; }
extern "C" void hostVisionSetSpaceClosedCallback(void (*cb)(void)) { host::g_spaceClosedCb = cb; }
extern "C" void hostVisionProxyFrame(void) {
  { std::lock_guard<std::mutex> l(host::g_proxyMu); host::g_proxyFrames++; }
  host::g_proxyCv.notify_all();
}
extern "C" void hostVisionSpatialTap(float hx, float hy, float hz, int hasHand, float ox, float oy, float oz) {
  std::lock_guard<std::mutex> l(host::g_spatialMu);
  host::Spatial& s = host::g_spatial;
  static uint64_t tapId = 1u << 20;
  s.active = true; s.id = ++tapId; s.hand = -1; s.hasRay = true; s.hasHit = true; s.hasHand = hasHand != 0; s.resolved = false; s.fromEye = false;
  s.hit[0] = hx; s.hit[1] = hy; s.hit[2] = hz; s.o[0] = ox; s.o[1] = oy; s.o[2] = oz;
  s.tapEndMs = host::steadyMs() + 150;   // a tap: pressed for a few frames, then released (beginFrame)
}
extern "C" void hostVisionLayerAttach(cp_layer_renderer_t layer) {
  void* prev = host::g_pendingLayer.exchange((__bridge_retained void*)layer);
  if (prev) { cp_layer_renderer_t drop = (__bridge_transfer cp_layer_renderer_t)prev; (void)drop; }
  HOST_LOGI("vision: immersive space ready");
}
