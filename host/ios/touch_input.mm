// emu.h's hooks on iOS: HostView's touches (the map in host_view.h) and, when one is attached, a hardware
// keyboard through GameController's GCKeyboard (the desktop map). Everything here runs on the main thread,
// as the host loop does (ios/main.mm).
#import "ios/host_view.h"
#include <TargetConditionals.h>
#import <GameController/GameController.h>
#import <QuartzCore/QuartzCore.h>
#include "emu/emu.h"
namespace host { namespace emu { std::mutex& touchMutex(); } }
#include <algorithm>
#include <mutex>
#include <cmath>

namespace {
// Touch state, in the view's points.
// A single finger aims and holds the trigger, but only once it has been down alone for kSettle: a two- or
// three-finger gesture starts with one finger too, and must not click first. A tap shorter than that, never
// joined by another finger, still clicks: the trigger for one frame when it lifts.
constexpr double kSettle = 0.08;
UITouch* g_aimTouch = nil; double g_aimSince = 0;
bool g_gestureMulti = false;                // this gesture (fingers down until none) has had more than one finger
bool g_tapPending = false;
CGPoint g_aim = {0, 0}; bool g_hasAim = false; CGSize g_size = {1, 1};
NSUInteger g_fingers = 0;
CGPoint g_lookPrev = {0, 0}; bool g_looking = false; float g_lookDX = 0, g_lookDY = 0;
bool g_menuTap = false;                     // a three-finger touch began: the menu button for a frame
bool g_menuHeld = false;
bool g_close = false;
bool g_prevKey[256] = {};

CGPoint centroid(NSSet<UITouch*>* touches, UIView* v) {
  CGPoint c = {0, 0}; for (UITouch* t in touches) { CGPoint p = [t locationInView:v]; c.x += p.x; c.y += p.y; }
  NSUInteger n = touches.count ? touches.count : 1; c.x /= n; c.y /= n; return c;
}

GCKeyboardInput* keyboard() { return GCKeyboard.coalescedKeyboard.keyboardInput; }
bool held(GCKeyCode k) { GCKeyboardInput* kb = keyboard(); return kb && [kb buttonForKeyCode:k].isPressed; }
bool edge(GCKeyCode k) { bool d = held(k), was = g_prevKey[k & 0xFF]; g_prevKey[k & 0xFF] = d; return d && !was; }
float axis(GCKeyCode plus, GCKeyCode minus) { return (held(plus) ? 1.f : 0.f) - (held(minus) ? 1.f : 0.f); }
}  // namespace

@implementation HostView
#if defined(HOST_IOS_ANGLE)
+ (Class)layerClass { return [CAMetalLayer class]; }  // ANGLE on Metal draws into it (gl/egl.cpp)
#elif TARGET_OS_VISION
+ (Class)layerClass { return [CALayer class]; }       // visionOS has no CAEAGLLayer: the frame is read back into it (ios/egl_eagl.mm)
#else
+ (Class)layerClass { return [CAEAGLLayer class]; }   // Apple's GLES (ios/egl_eagl.mm)
#endif

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.multipleTouchEnabled = YES;
#if !TARGET_OS_VISION
    self.contentScaleFactor = UIScreen.mainScreen.nativeScale;  // visionOS: the window scene's, applied when the view is added
#else
    // The window composites alpha: the splash (cleared transparent, emu/splash.cpp) shows as the logo alone on the
    // window's glass, and so would a page drawing a transparent flat canvas.
    self.opaque = NO; self.backgroundColor = UIColor.clearColor; self.layer.opaque = NO;
#endif
  }
  return self;
}

- (void)update:(UIEvent*)event {
  std::lock_guard<std::mutex> lock(host::emu::touchMutex());  // the immersive vision host reads from its own thread
  NSMutableSet<UITouch*>* live = [NSMutableSet set];
  for (UITouch* t in [event touchesForView:self]) if (t.phase != UITouchPhaseEnded && t.phase != UITouchPhaseCancelled) [live addObject:t];
  const NSUInteger n = live.count;
  g_size = self.bounds.size;
  if (n >= 3 && g_fingers < 3) { g_menuTap = true; g_menuHeld = true; }
  if (n < 3) g_menuHeld = false;
  if (n == 2) {
    const CGPoint c = centroid(live, self);
    if (g_looking) { g_lookDX += (float)(c.x - g_lookPrev.x); g_lookDY += (float)(c.y - g_lookPrev.y); }
    g_lookPrev = c; g_looking = true;
  } else g_looking = false;
  if (n > 1) g_gestureMulti = true;
  if (n == 1 && !g_gestureMulti) {
    UITouch* t = live.anyObject;
    if (g_fingers == 0) { g_aimTouch = t; g_aimSince = CACurrentMediaTime(); }
    if (t == g_aimTouch) { g_aim = [t locationInView:self]; g_hasAim = true; }
  } else {
    if (n == 0 && g_aimTouch && !g_gestureMulti && CACurrentMediaTime() - g_aimSince < kSettle) g_tapPending = true;  // a quick tap
    g_aimTouch = nil;
  }
  if (n == 0) g_gestureMulti = false;
  g_fingers = n;
}
- (void)touchesBegan:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event { [self update:event]; }
- (void)touchesMoved:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event { [self update:event]; }
- (void)touchesEnded:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event { [self update:event]; }
- (void)touchesCancelled:(NSSet<UITouch*>*)touches withEvent:(UIEvent*)event { [self update:event]; }
@end

namespace host {
namespace emu {

void setCloseRequested() { g_close = true; }

std::mutex& touchMutex() { static std::mutex m; return m; }

void readControls(Controls& c) {
  std::lock_guard<std::mutex> lock(touchMutex());
  c = Controls{};
  // Touch: a drag across the whole view turns the head about 1.5 radians.
  const float perPoint = 1.5f / (float)std::max(1.0, std::min(g_size.width, g_size.height));
  c.lookYaw = -g_lookDX * perPoint; c.lookPitch = -g_lookDY * perPoint; g_lookDX = g_lookDY = 0;
  c.hasAim = g_hasAim; c.aimX = (float)(g_aim.x / std::max(1.0, g_size.width)); c.aimY = (float)(g_aim.y / std::max(1.0, g_size.height));
  c.trigger = (g_aimTouch != nil && CACurrentMediaTime() - g_aimSince >= kSettle) || g_tapPending; g_tapPending = false;
  c.menu = g_menuTap || g_menuHeld; g_menuTap = false;
  // A hardware keyboard: the desktop map.
  if (keyboard()) {
    c.swapHand = edge(GCKeyCodeTab); c.toggleStereo = edge(GCKeyCodeKeyV); c.toggleSystemMenu = edge(GCKeyCodeKeyO); c.recenter = edge(GCKeyCodeKeyR);
    c.walk[0] = axis(GCKeyCodeKeyD, GCKeyCodeKeyA); c.walk[1] = axis(GCKeyCodeKeyE, GCKeyCodeKeyQ); c.walk[2] = axis(GCKeyCodeKeyW, GCKeyCodeKeyS);
    c.fast = held(GCKeyCodeLeftShift);
    c.squeeze = held(GCKeyCodeKeyF); c.stickClick = held(GCKeyCodeKeyC); c.a = held(GCKeyCodeKeyZ); c.b = held(GCKeyCodeKeyX);
    c.stick[0] = axis(GCKeyCodeRightArrow, GCKeyCodeLeftArrow); c.stick[1] = axis(GCKeyCodeDownArrow, GCKeyCodeUpArrow);
    c.otherTrigger = held(GCKeyCodeKeyG); c.otherSqueeze = held(GCKeyCodeKeyH);
    c.menu = c.menu || held(GCKeyCodeEscape) || held(GCKeyCodeKeyM);
  }
}

#if TARGET_OS_VISION
float displayRate() { return 60.f; }  // the flat window of the spike (UIScreen is deprecated on visionOS 26; the compositor runs 90)
#else
float displayRate() { return std::min(60.f, (float)UIScreen.mainScreen.maximumFramesPerSecond); }  // the vsync link's rate (ios/egl_eagl.mm)
#endif
// The page's viewport: derived from the framebuffer (cssW/H 0) at the screen's scale, as the view draws at it.
#if TARGET_OS_VISION
void viewport(float& cssW, float& cssH, float& dpr) { cssW = cssH = 0; dpr = 2.f; }
#else
void viewport(float& cssW, float& cssH, float& dpr) { cssW = cssH = 0; dpr = (float)UIScreen.mainScreen.nativeScale; }
#endif
bool closeRequested() { return g_close; }
void requestClose() { g_close = true; }

}  // namespace emu
}  // namespace host
