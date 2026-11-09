#pragma once
// Passthrough (XR_FB_passthrough) and scene understanding (XR_FB_scene +
// XR_FB_spatial_entity{,_query,_container} + XR_META_spatial_entity_mesh +
// XR_FB_scene_capture) — what an `immersive-ar` WebXR session needs on top of
// the projection layer: a passthrough layer composited UNDER it with the eye
// buffer alpha-blended over, and the room's anchors as planes (BOUNDED_2D) and
// meshes (TRIANGLE_MESH / BOUNDED_3D boxes) located every frame.
//
// Everything is converted to the WebXR conventions here, so the JS side only
// copies: a plane's space has +Y as its normal and its polygon lies on y = 0
// (OpenXR FB planes have +Z as the normal: the pose carries rotX(+90°) and a
// boundary point (x, y) becomes (x, 0, -y)); mesh vertices are in the mesh's
// own space, as the runtime hands them out.
#include <openxr/openxr.h>
#include <cstdint>
#include <string>
#include <vector>

namespace host {

struct SceneEntity {
  XrSpace space = XR_NULL_HANDLE;
  XrUuidEXT uuid{};
  std::string id;                 // uuid as hex
  int kind = 0;                   // 0 none (skipped), 1 plane, 2 mesh
  std::string label;              // WebXR semanticLabel ('wall', 'floor', 'global mesh', …)
  std::vector<float> polygon;     // plane: x, z pairs in the plane space (y = 0)
  std::vector<float> vertices;    // mesh: xyz triples in the mesh space
  std::vector<uint32_t> indices;  // mesh: triangle list
  bool locatable = false;         // LOCATABLE enabled (poses can be asked for)
  bool pendingLocatable = false;  // enable requested, completion not seen yet
  bool described = false;         // geometry / label read
  uint32_t changed = 0;           // bumped whenever geometry or label changes
  int slot = -1;                  // index into the pose record (-1: not listed)
  // Pose in the base space for the current frame (WebXR-oriented for planes).
  bool poseValid = false; float pos[3] = {0, 0, 0}; float quat[4] = {0, 0, 0, 1};
};

struct SceneExtensions {
  bool passthrough = false, spatialEntity = false, query = false, container = false, storage = false, scene = false, sceneCapture = false, meshMeta = false;
};

class XrScene {
 public:
  static constexpr int kMaxEntities = 128;

  // Loads the function pointers for the extensions that were enabled on the instance.
  void init(XrInstance inst, XrSession sess, const SceneExtensions& ext);
  void destroy();

  // --- passthrough ---------------------------------------------------------
  bool passthroughSupported() const { return ext_.passthrough && systemPassthrough_; }
  void setSystemPassthrough(bool v) { systemPassthrough_ = v; }
  void setPassthroughSupported(bool v) { ext_.passthrough = v; systemPassthrough_ = v; }  // hosts whose compositor blends by alpha without an extension (vision)
  void setSceneSupported(bool v) { ext_.spatialEntity = ext_.query = ext_.scene = v; }      // hosts that list the room without OpenXR (vision: ARKit)
  bool startPassthrough();           // creates the feature + a reconstruction layer, running
  void stopPassthrough();
  bool passthroughRunning() const { return ptLayer_ != XR_NULL_HANDLE; }
  // The page's passthroughFullyObscured hint: false pauses the layer (no camera feed composited).
  void setPassthroughVisible(bool visible);
  bool passthroughVisible() const { return ptVisible_; }
  // The composition layer to submit under the projection layer, or null.
  const XrCompositionLayerBaseHeader* passthroughLayer();

  // --- scene ---------------------------------------------------------------
  bool sceneSupported() const { return ext_.spatialEntity && ext_.query && ext_.scene; }
  bool captureSupported() const { return ext_.sceneCapture; }
  bool sceneActive() const { return sceneActive_; }
  void startScene();                 // queries the room's anchors (async: results arrive through events)
  void stopScene();                  // forgets every entity (the page's session ended)
  bool requery();                    // ask again (after a capture, a permission grant, a reset)
  bool requestCapture();             // XR_FB_scene_capture: the system's room setup flow
  // True when the event was one of ours. `captureDone` is set (with its result) when a capture finished.
  bool handleEvent(const XrEventDataBuffer& ev);
  bool captureFinished(bool& ok) { if (!captureDone_) return false; captureDone_ = false; ok = captureOk_; return true; }
  bool queryFailedPermission() const { return queryPermission_; }
  // Locates every listed entity in `base` at `time` (host frame loop, after xrWaitFrame).
  void locate(XrSpace base, XrTime time);
  uint32_t generation() const { return generation_; }
  const std::vector<SceneEntity>& entities() const { return entities_; }
  // Pose record: kMaxEntities × 8 floats (valid, pos xyz, quat xyzw), by slot.
  const float* poseRecord() const { return poses_; }
  static constexpr int kPoseStride = 8;

 private:
  bool describe(SceneEntity& e);     // reads components, geometry, label; returns true when something changed
  void retrieveResults(XrAsyncRequestIdFB id);
  void assignSlots();
  SceneEntity* find(XrSpace space);
  std::string uuidHex(const XrUuidEXT& u);
  void listChanged() { generation_++; }

  XrInstance inst_ = XR_NULL_HANDLE; XrSession sess_ = XR_NULL_HANDLE;
  SceneExtensions ext_;
  bool systemPassthrough_ = false;
  // passthrough
  XrPassthroughFB pt_ = XR_NULL_HANDLE; XrPassthroughLayerFB ptLayer_ = XR_NULL_HANDLE; bool ptVisible_ = true;
  XrCompositionLayerPassthroughFB ptComp_{XR_TYPE_COMPOSITION_LAYER_PASSTHROUGH_FB};
  PFN_xrCreatePassthroughFB pfnCreatePt_ = nullptr; PFN_xrDestroyPassthroughFB pfnDestroyPt_ = nullptr;
  PFN_xrPassthroughStartFB pfnStartPt_ = nullptr; PFN_xrPassthroughPauseFB pfnPausePt_ = nullptr;
  PFN_xrCreatePassthroughLayerFB pfnCreateLayer_ = nullptr; PFN_xrDestroyPassthroughLayerFB pfnDestroyLayer_ = nullptr;
  PFN_xrPassthroughLayerPauseFB pfnLayerPause_ = nullptr; PFN_xrPassthroughLayerResumeFB pfnLayerResume_ = nullptr;
  // scene
  bool sceneActive_ = false, captureDone_ = false, captureOk_ = false, queryPermission_ = false;
  XrAsyncRequestIdFB queryId_ = 0, captureId_ = 0; bool queryPending_ = false;
  std::vector<SceneEntity> entities_;
  uint32_t generation_ = 1;
  float poses_[kMaxEntities * kPoseStride] = {0};
  PFN_xrQuerySpacesFB pfnQuery_ = nullptr; PFN_xrRetrieveSpaceQueryResultsFB pfnRetrieve_ = nullptr;
  PFN_xrEnumerateSpaceSupportedComponentsFB pfnEnumComponents_ = nullptr;
  PFN_xrGetSpaceComponentStatusFB pfnGetStatus_ = nullptr; PFN_xrSetSpaceComponentStatusFB pfnSetStatus_ = nullptr;
  PFN_xrGetSpaceUuidFB pfnUuid_ = nullptr;
  PFN_xrGetSpaceBoundary2DFB pfnBoundary2D_ = nullptr; PFN_xrGetSpaceBoundingBox2DFB pfnBox2D_ = nullptr; PFN_xrGetSpaceBoundingBox3DFB pfnBox3D_ = nullptr;
  PFN_xrGetSpaceSemanticLabelsFB pfnLabels_ = nullptr;
  PFN_xrGetSpaceTriangleMeshMETA pfnTriMesh_ = nullptr;
  PFN_xrRequestSceneCaptureFB pfnCapture_ = nullptr;
};

}  // namespace host
