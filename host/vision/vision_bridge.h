// The visionOS shell's bridge (host/vision/App.swift ↔ the C++ host). Plain C: this is the Swift bridging
// header, so nothing C++ may appear here; the HostView class is re-declared (ios/host_view.h carries C++).
#pragma once
#import <UIKit/UIKit.h>
#import <CompositorServices/CompositorServices.h>

@interface HostView : UIView
@end

#ifdef __cplusplus
extern "C" {
#endif
// The window's HostView exists (its layer is what the flat page draws into): start the host loop on the main
// thread (ios/main.mm). Called once.
void hostVisionStart(UIView* _Nonnull view);
// The immersive space's compositor layer is ready (SwiftUI's CompositorLayer renderer closure): the XR device
// (vision/vision_xr.mm) renders into its drawables from now on.
void hostVisionLayerAttach(cp_layer_renderer_t _Nonnull layer);
// The window scene became active / inactive (the loop idles while inactive).
void hostVisionSetActive(bool active);
// Told when the page's XR session starts (true) and ends (false): the shell dismisses / reopens its window.
void hostVisionSetXrCallback(void (* _Nonnull cb)(bool));
// Whether the page's XR session is rendering now (a window the system brings back meanwhile dismisses itself).
bool hostVisionXrActive(void);
// A spatial event of the immersive space (a pinch at the gaze; the simulator's click): its id, whether it is
// active (1) or ended (0), and its selection ray (origin, direction) in the space's coordinates when it has one;
// hand 0 left, 1 right, -1 unknown.
void hostVisionSpatialEvent(uint64_t id, int active, int hasRay, float ox, float oy, float oz, float dx, float dy, float dz, int hand);

// --- The RealityKit presentation (the simulator; WEBXR_VISION_PRESENT=rk|cs overrides) ------------------------
// The simulator trails every Compositor Services layer behind its room while the camera moves (measured
// 2026-10-21 with Apple's own loop; RealityKit content holds). So there the page's frame goes onto a RealityKit
// quad instead: a LowLevelTexture the host blits into, shown at the frustum of the pose the frame was rendered
// from, composited by RealityKit with its camera. Mono, a planar proxy of the frame; a device keeps the layer.
bool hostVisionRealityKitPresent(void);
// The shell's hooks, called on the host thread each frame: begin returns the Metal texture to write this frame
// into (unretained; valid until end), end orders the frame after the shared event (nil: already finished),
// commits it and moves the quad to the pose (column-major 4x4, the render pose in ARKit space).
typedef void* _Nullable (* _Nonnull HostVisionProxyBegin)(void);
typedef void (* _Nonnull HostVisionProxyEnd)(void* _Nullable sharedEvent, uint64_t value, const float* _Nonnull pose16);
void hostVisionProxyAttach(int width, int height, float fovYRadians, float distance, HostVisionProxyBegin begin, HostVisionProxyEnd end);
// A RealityKit frame passed (its scene update): the host paces one page frame per call.
void hostVisionProxyFrame(void);
// The space closed (the person left it: the crown, the simulator's home button): the page's XR session ends,
// the window shows the flat page, and the next session asks the shell to open the space again (the callback).
void hostVisionProxyDetach(void);
void hostVisionSetSpaceCallback(void (* _Nonnull cb)(void));
// The compositor layer's space closed (its layer invalidated; the host thread): the shell notes the time, as
// ProxyView.onDisappear does for the RealityKit space, so the person's return is told from the system's own window.
void hostVisionSetSpaceClosedCallback(void (* _Nonnull cb)(void));
// The window's enter button: the host accepts the session the page has on offer (its offerSession).
void hostVisionEnterRequested(void);
// A tap on the quad: the gazed point (the tap's hit) and, when the platform knows it, the hand's position (the
// pinch); the host aims from the hand (a synthesised one without) at the point, pressed briefly.
void hostVisionSpatialTap(float hx, float hy, float hz, int hasHand, float ox, float oy, float oz);
#ifdef __cplusplus
}
#endif
