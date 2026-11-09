// The visionOS shell: a window (the page's flat canvas and the touch input, the same HostView as iOS) and an
// immersive space whose CompositorLayer is where the page's XR frames go (vision/vision_xr.mm). The space
// opens as soon as the window is up; the page's session starts rendering into it when it asks for XR.
// Mixed immersion: the layer composites over passthrough (the page's alpha), the plan's AR route (WP-17).
// This is the whole Swift: everything else is C++ behind vision/vision_bridge.h.
import SwiftUI
import CompositorServices
import RealityKit
import Metal
import UIKit

struct HostViewRep: UIViewRepresentable {
  func makeUIView(context: Context) -> UIView {
    let v = HostView(frame: .zero)
    DispatchQueue.main.async { hostVisionStart(v) }  // after the view is in a window (its layer has a size)
    return v
  }
  func updateUIView(_ uiView: UIView, context: Context) {}
}

struct LayerConfiguration: CompositorLayerConfiguration {
  func makeConfiguration(capabilities: LayerRenderer.Capabilities, configuration: inout LayerRenderer.Configuration) {
    // One texture, two viewports: WebXR's 'texture' projection layout, what three takes without multiview.
    let layouts = capabilities.supportedLayouts(options: [])
    configuration.layout = layouts.contains(.shared) ? .shared : .dedicated
    configuration.isFoveationEnabled = false  // rasterization rate maps are Metal-only; GL renders the full texture
    // The page writes sRGB-encoded texels; an sRGB drawable tells the compositor so (GL sees it as plain BGRA8
    // through ANGLE's internal-format override, no encode on write).
    let colors = capabilities.supportedColorFormats
    configuration.colorFormat = colors.contains(.bgra8Unorm_srgb) ? .bgra8Unorm_srgb : colors.first ?? .bgra8Unorm_srgb
    configuration.depthFormat = .depth32Float
    configuration.defaultDepthRange = SIMD2<Float>(1000, 0.1)  // reverse-Z (far, near) in meters, the page's defaults
  }
}

let xrStateNote = Notification.Name("webxr-host.xr")

nonisolated(unsafe) var spaceOpened = false   // the immersive space is open (or opening); it outlives the window
nonisolated(unsafe) var spaceEverOpened = false   // the first window opens it at launch; afterwards only the host's request does
nonisolated(unsafe) var spaceClosedAt: Date? = nil   // when the person left the space (ProxyView.onDisappear)
nonisolated(unsafe) var openSpaceAction: OpenImmersiveSpaceAction? = nil   // the latest window's, for the host's request
// The person's return (a window they picked, the app activating, the gaze on the window, the button): a session
// that is alive but hidden gets its space back and resumes; otherwise the session the page has on offer is accepted.
func returnToGame(_ why: String) {
  if hostVisionXrActive() { NSLog("webxr-host vision: %@: the space back, the session resumes", why); openSpaceHook() }
  else { NSLog("webxr-host vision: %@: entering the session on offer", why); hostVisionEnterRequested() }
}
let openSpaceHook: @convention(c) () -> Void = {
  DispatchQueue.main.async {
    guard !spaceOpened, let a = openSpaceAction else { return }
    spaceOpened = true
    Task { @MainActor in
      let space = hostVisionRealityKitPresent() ? "rk" : "xr"
      let r = await a(id: space)
      NSLog("webxr-host vision: openImmersiveSpace(%@) on the host's request → %@", space, String(describing: r))
    }
  }
}

struct RootView: View {
  @Environment(\.openImmersiveSpace) private var openImmersiveSpace
  @Environment(\.dismissWindow) private var dismissWindow
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false
  @State private var hoverEnter: DispatchWorkItem? = nil
  var body: some View {
    HostViewRep()
      .ignoresSafeArea()
      .task {
        // A window the system brings back while the session renders (the simulator's home button, the app
        // reopened from its home view) is not wanted: the game is in the space. Down again at once.
        openSpaceAction = openImmersiveSpace
        hostVisionSetSpaceCallback(openSpaceHook)
        hostVisionSetSpaceClosedCallback({ DispatchQueue.main.async { spaceOpened = false; spaceClosedAt = Date() } })   // the compositor layer's space (the RealityKit one: ProxyView.onDisappear)
        // A dismissal from a window's own start, before it is up, has no effect: it waits a moment.
        if hostVisionXrActive() && spaceOpened && ProcessInfo.processInfo.environment["WEBXR_KEEP_WINDOW"] != "1" {
          NSLog("webxr-host vision: window back during the XR session: dismissed"); try? await Task.sleep(for: .milliseconds(600)); dismissWindow(id: "main"); return
        }
        if spaceEverOpened {
          // A later window. The one the system makes as the space closes is dismissed at once, so the app has no
          // window while the person is in the home view; the window made when they pick the app there is their
          // return, and the session the page has on offer is accepted straight away. WEBXR_KEEP_WINDOW=1: neither.
          if ProcessInfo.processInfo.environment["WEBXR_KEEP_WINDOW"] == "1" { return }
          // Measured: the system's own window, when it makes one, comes with the close; the person's pick comes
          // later (1.4 s on a quick pick), as a new window scene plus the app's activation.
          if let t = spaceClosedAt, Date().timeIntervalSince(t) < 0.7 { NSLog("webxr-host vision: the window after the space closed: dismissed, the app waits in the home view"); try? await Task.sleep(for: .milliseconds(600)); dismissWindow(id: "main") }
          else { returnToGame("the app reopened") }
          return
        }
        spaceEverOpened = true; spaceOpened = true
        hostVisionSetXrCallback { active in   // the host thread: hop to the main actor through a notification
          DispatchQueue.main.async { NotificationCenter.default.post(name: xrStateNote, object: nil, userInfo: ["active": active]) }
        }
        let space = hostVisionRealityKitPresent() ? "rk" : "xr"
        let r = await openImmersiveSpace(id: space)
        NSLog("webxr-host vision: openImmersiveSpace(%@) → %@", space, String(describing: r))
      }
      // The window carried the flat page (and the touch input of the simulator); once the page renders into the
      // immersive space it is in the way: dismissed.
      .onReceive(NotificationCenter.default.publisher(for: xrStateNote)) { n in
        // The compositor layer's path (the RealityKit space handles its own, ProxyView: this view is gone with
        // the window). Kept on the simulator: dismissing the only window freezes the simulator's passthrough
        // (its room stops following the camera until the app quits), and the window is its touch input.
        // Dismissed on a device (passthrough is the camera feed there); WEBXR_KEEP_WINDOW=1 / 0 overrides.
        if hostVisionRealityKitPresent() { return }
        if (n.userInfo?["active"] as? Bool) == true {
          #if targetEnvironment(simulator)
          let keep = ProcessInfo.processInfo.environment["WEBXR_KEEP_WINDOW"] != "0"
          #else
          let keep = ProcessInfo.processInfo.environment["WEBXR_KEEP_WINDOW"] == "1"
          #endif
          if keep { NSLog("webxr-host vision: XR session rendering, window kept") }
          else { NSLog("webxr-host vision: XR session rendering, window dismissed"); dismissWindow(id: "main") }
        }
      }
      // The window's phase is not the app's: dismissing it reads as .background while the immersive space renders on,
      // so the host is never idled from here (the compositor's paused state pauses the XR frames). But a window that
      // went to the background and comes back active is the app reopened from the home view: the person wants back
      // in, so the session the page has on offer is accepted, as the enter button would.
      // No event reaches the app when the person picks it from the home view with its window up (and the window is
      // always up: visionOS keeps an app's last scene), so the nearest thing to an automatic return is the window
      // noticing them: the gaze (a device) or the pointer (the simulator) resting on it for a moment enters the
      // session the page has on offer. WEBXR_VISION_HOVER_ENTER=0 turns it off.
      .onContinuousHover { phase in
        if ProcessInfo.processInfo.environment["WEBXR_VISION_HOVER_ENTER"] == "0" { return }
        switch phase {
        case .active:
          if hoverEnter == nil && !spaceOpened && spaceClosedAt != nil {
            let w = DispatchWorkItem { hoverEnter = nil; if !spaceOpened { returnToGame("the window held the gaze") } }
            hoverEnter = w; DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: w)
          }
        case .ended:
          hoverEnter?.cancel(); hoverEnter = nil
        }
      }
      // The app-level signal of the same thing (the home view resigns the app; coming back activates it).
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in NSLog("webxr-host vision: app resigned active"); wasBackground = true }
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
        NSLog("webxr-host vision: app became active")
        wasBackground = false
        if let t = spaceClosedAt, Date().timeIntervalSince(t) > 0.7, !spaceOpened { returnToGame("the app activated after leaving the space") }
      }
      .onChange(of: scenePhase) { _, phase in
        NSLog("webxr-host vision: window scene phase %@", String(describing: phase))
        // A visit to the home view takes the window to inactive (not background) and back to active.
        if phase == .inactive || phase == .background { wasBackground = true }
        else if phase == .active && wasBackground { wasBackground = false; if !hostVisionXrActive() { NSLog("webxr-host vision: back from the home view: entering"); hostVisionEnterRequested() } }
      }
  }
}

@main
struct WebXRHostApp: App {
  @State private var immersion: ImmersionStyle = .mixed
  var body: some SwiftUI.Scene {
    // Small: on the simulator it stays up through the XR session (see RootView) as the touch surface.
    WindowGroup(id: "main") { RootView() }.defaultSize(width: 480, height: 270).windowResizability(.contentMinSize)
    ImmersiveSpace(id: "xr") {
      CompositorLayer(configuration: LayerConfiguration()) { layer in
        NSLog("webxr-host vision: compositor layer renderer called")
        // Gaze + pinch (the simulator: a click at the pointer) with its selection ray: the aimed controller.
        layer.onSpatialEvent = { events in
          for e in events {
            var o = SIMD3<Float>(0, 0, 0), d = SIMD3<Float>(0, 0, -1); var hasRay: Int32 = 0
            if let ray = e.selectionRay { o = SIMD3<Float>(Float(ray.origin.x), Float(ray.origin.y), Float(ray.origin.z)); d = SIMD3<Float>(Float(ray.direction.x), Float(ray.direction.y), Float(ray.direction.z)); hasRay = 1 }
            let hand: Int32 = e.chirality == .left ? 0 : e.chirality == .right ? 1 : -1
            hostVisionSpatialEvent(UInt64(bitPattern: Int64(e.id.hashValue)), e.phase == .active ? 1 : 0, hasRay, o.x, o.y, o.z, d.x, d.y, d.z, hand)
          }
        }
        hostVisionLayerAttach(layer)
      }
    }
    .immersionStyle(selection: $immersion, in: .mixed, .full)
    .upperLimbVisibility(.visible)
    // The simulator's space (vision_bridge.h: hostVisionRealityKitPresent): the page's frame on a RealityKit quad.
    ImmersiveSpace(id: "rk") { ProxyView() }
      .immersionStyle(selection: .constant(.mixed), in: .mixed)
      .upperLimbVisibility(.visible)
  }
}

// ---- The RealityKit presentation (the simulator) -------------------------------------------------------------
// A quad carrying a LowLevelTexture the host blits each frame into (through ANGLE, as it does the compositor's
// drawable), placed at the frustum of the pose that frame was rendered from: RealityKit composites it with its
// own camera, which the simulator keeps in step with its room (a Compositor Services layer it does not).
let proxyWidth = 2560, proxyHeight = 1440
let proxyFovY: Float = 75 * .pi / 180   // vertical; the page renders this frustum, the quad spans it at proxyDistance
let proxyDistance: Float = 2.0

// The frame and the quad's pose must land on the same RealityKit frame or the content jitters a frame apart from
// its placement. So the host writes a pair of host-owned textures (begin hands one out, end marks it finished with
// its pose and the GL shared event), and RealityKit's own scene update copies the finished one into the quad's
// LowLevelTexture and moves the quad in the same step, then lets the host start the next frame.
final class ProxyLayer {
  nonisolated(unsafe) static var shared: ProxyLayer? = nil
  let queue: MTLCommandQueue
  let texture: LowLevelTexture
  let hostTextures: [MTLTexture]
  let quad: ModelEntity
  var subscription: EventSubscription? = nil
  struct Pending { let index: Int; let event: MTLSharedEvent?; let value: UInt64; let pose: simd_float4x4 }
  let lock = NSLock()
  nonisolated(unsafe) var pending: Pending? = nil
  nonisolated(unsafe) var current = 0
  nonisolated(unsafe) var inFlight = [false, false, false]   // being copied into the quad's texture on the GPU
  nonisolated(unsafe) var frames = 0
  var reopen: DispatchWorkItem? = nil   // the window's return after a session, unless another starts first
  var fadeStart: Date? = nil            // the quad fading in from its first frame (launch and resume alike)
  var material: UnlitMaterial

  @MainActor init() throws {
    let device = MTLCreateSystemDefaultDevice()!
    queue = device.makeCommandQueue()!
    var d = LowLevelTexture.Descriptor()
    d.pixelFormat = .bgra8Unorm_srgb; d.width = proxyWidth; d.height = proxyHeight
    d.textureUsage = [.renderTarget, .shaderRead]
    texture = try LowLevelTexture(descriptor: d)
    let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: proxyWidth, height: proxyHeight, mipmapped: false)
    td.usage = [.renderTarget, .shaderRead, .pixelFormatView]   // the host writes them through a linear view (ANGLE)
    td.storageMode = .private
    hostTextures = [device.makeTexture(descriptor: td)!, device.makeTexture(descriptor: td)!, device.makeTexture(descriptor: td)!]
    let resource = try TextureResource(from: texture)
    let h = 2 * proxyDistance * tan(proxyFovY / 2), w = h * Float(proxyWidth) / Float(proxyHeight)
    var mat = UnlitMaterial()
    mat.color = .init(tint: .white, texture: .init(resource))
    mat.blending = .transparent(opacity: .init(scale: 1.0))   // the page's alpha: passthrough where it is 0
    mat.opacityThreshold = 0
    material = mat
    quad = ModelEntity(mesh: .generatePlane(width: w, height: h), materials: [mat])
    quad.generateCollisionShapes(recursive: false)
    quad.components.set(InputTargetComponent())
    quad.transform = Transform(matrix: translate(0, 0, -proxyDistance))
    quad.isEnabled = false   // until the first frame: an unwritten texture shows magenta, and at the floor-level origin
  }

  // Host thread: a host texture to write this frame into: not the one pending, nor one the GPU is still copying
  // (a frame started right after a late one would otherwise overwrite the texture of the frame being shown).
  func begin() -> MTLTexture? {
    lock.lock(); defer { lock.unlock() }
    for _ in 0..<3 {
      current = (current + 1) % 3
      if !inFlight[current] && pending?.index != current { return hostTextures[current] }
    }
    return nil   // all three busy (the GPU far behind): skip this frame's hand-off
  }
  // Host thread: the frame is written (after the shared event); RealityKit's next update shows it.
  func end(event: MTLSharedEvent?, value: UInt64, pose: simd_float4x4) {
    lock.lock(); defer { lock.unlock() }
    pending = Pending(index: current, event: event, value: value, pose: pose)
  }
  // RealityKit's scene update (main): the finished frame into the quad's texture and the quad to its pose, in
  // one step, then the host may render the next frame.
  @MainActor func update() {
    lock.lock(); let p = pending; pending = nil; lock.unlock()
    if let p, let cb = queue.makeCommandBuffer() {
      let target = texture.replace(using: cb)
      if let e = p.event { cb.encodeWaitForEvent(e, value: p.value) }
      if let blit = cb.makeBlitCommandEncoder() { blit.copy(from: hostTextures[p.index], to: target); blit.endEncoding() }
      lock.lock(); inFlight[p.index] = true; lock.unlock()
      cb.addCompletedHandler { [self] _ in lock.lock(); inFlight[p.index] = false; lock.unlock() }
      cb.commit()
      quad.transform = Transform(matrix: p.pose * translate(0, 0, -proxyDistance))
      frames += 1
      if frames == 2 {   // the second: the first's copy has landed
        quad.isEnabled = true; fadeStart = Date(); setOpacity(0); NSLog("webxr-host vision: first frame on the RealityKit quad")
        // A resumed session never "starts" again, so the window's dismissal is asked for here as well.
        NotificationCenter.default.post(name: xrStateNote, object: nil, userInfo: ["active": true])
      }
    }
    if let t = fadeStart {   // half a second from transparent to opaque
      let k = Float(min(1, Date().timeIntervalSince(t) / 0.5))
      setOpacity(k)
      if k >= 1 { fadeStart = nil }
    }
    hostVisionProxyFrame()
  }
  @MainActor func setOpacity(_ k: Float) {
    material.blending = .transparent(opacity: .init(scale: k))
    quad.model?.materials = [material]
  }
}

let proxyBeginHook: @convention(c) () -> UnsafeMutableRawPointer? = {
  guard let p = ProxyLayer.shared, let tex = p.begin() else { return nil }
  return Unmanaged.passUnretained(tex as AnyObject).toOpaque()
}
let proxyEndHook: @convention(c) (UnsafeMutableRawPointer?, UInt64, UnsafePointer<Float>) -> Void = { ev, value, pose in
  guard let p = ProxyLayer.shared else { return }
  let event = ev.map { Unmanaged<AnyObject>.fromOpaque($0).takeUnretainedValue() as! MTLSharedEvent }
  var m = matrix_identity_float4x4
  withUnsafeMutableBytes(of: &m) { $0.copyMemory(from: UnsafeRawBufferPointer(start: pose, count: 64)) }
  p.end(event: event, value: value, pose: m)
}

struct ProxyView: View {
  @Environment(\.dismissWindow) private var dismissWindow
  @Environment(\.openWindow) private var openWindow
  var body: some View {
    RealityView { content in
      do {
        let p = try ProxyLayer()
        ProxyLayer.shared = p
        content.add(p.quad)
        p.subscription = content.subscribe(to: SceneEvents.Update.self) { _ in MainActor.assumeIsolated { p.update() } }
        hostVisionProxyAttach(Int32(proxyWidth), Int32(proxyHeight), proxyFovY, proxyDistance, proxyBeginHook, proxyEndHook)
        NSLog("webxr-host vision: RealityKit proxy quad up (%dx%d, fov %.0f deg at %.1f m)", proxyWidth, proxyHeight, proxyFovY * 180 / .pi, proxyDistance)
      } catch { NSLog("webxr-host vision: RealityKit proxy failed: %@", String(describing: error)) }
    }
    // A tap on the quad (the simulator's click): the ray from the head through the tapped point, as the
    // compositor layer's spatial event gave it.
    .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { v in
      guard let p = ProxyLayer.shared else { return }
      let hit = v.convert(v.location3D, from: .local, to: .scene)
      // The pinching hand's position is not on the tap's value; the simulator has no hands anyway, so the host
      // aims from a synthesised hand by the head. A device run (WP-17 17c) takes it from the spatial event's pose.
      hostVisionSpatialTap(Float(hit.x), Float(hit.y), Float(hit.z), 0, 0, 0, 0)
    })
    // The space closed under the page (the crown, the simulator's home button): the session ends (the host sends
    // the page its end), the window the system brought back shows the flat page, the next session reopens the space.
    .onDisappear { spaceOpened = false; spaceClosedAt = Date(); hostVisionProxyDetach() }
    // The page's XR session starting and ending, handled here because this view outlives the window: the window
    // goes while the session renders (the quad takes the taps; WEBXR_KEEP_WINDOW=1 keeps it) and comes back
    // when it ends, for the flat page; the quad hides until the next session's first frame.
    .onReceive(NotificationCenter.default.publisher(for: xrStateNote)) { n in
      let active = (n.userInfo?["active"] as? Bool) == true
      guard let p = ProxyLayer.shared else { return }
      if active {
        p.reopen?.cancel(); p.reopen = nil   // a session restarted straight away: the window stays down
        if ProcessInfo.processInfo.environment["WEBXR_KEEP_WINDOW"] == "1" { NSLog("webxr-host vision: XR session rendering, window kept") }
        else { NSLog("webxr-host vision: XR session rendering, window dismissed"); dismissWindow(id: "main") }
      } else {
        NSLog("webxr-host vision: XR session over: quad hidden, window back in a moment")
        p.quad.isEnabled = false; p.frames = 0
        let w = DispatchWorkItem { p.reopen = nil; openWindow(id: "main") }
        p.reopen?.cancel(); p.reopen = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: w)
      }
    }
  }
}

func translate(_ x: Float, _ y: Float, _ z: Float) -> simd_float4x4 { var m = matrix_identity_float4x4; m.columns.3 = [x, y, z, 1]; return m }
