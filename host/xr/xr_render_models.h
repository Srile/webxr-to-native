#pragma once
// The runtime's own controller models (XR_EXT_render_model + XR_EXT_interaction_render_model): the glTF binary
// (GLB) of each controller the action sets are bound to, as the runtime draws it (SteamVR on the Steam Frame:
// the Frame controllers), and every frame its pose in the grip space of the hand holding it, with the poses of
// its animatable nodes (trigger, thumbstick, buttons). Nothing is shipped: the models come from the runtime.
//
// Turned on by host.json xr.renderModels. Models are listed after xrSyncActions; the runtime queues
// XrEventDataInteractionRenderModelsChangedEXT whenever the set changes, and the list is read again then.
//
// The page reads the list by generation (__native.xr.renderModels()) and the pose record every frame
// (__native.xr.renderModelPoses(): a Float32Array over this buffer, layout below).
#include <openxr/openxr.h>
#include <cstdint>
#include <string>
#include <vector>

namespace host {

struct RenderModelEntry {
  uint64_t id = 0;                   // XrRenderModelIdEXT
  XrRenderModelEXT model = XR_NULL_HANDLE;
  XrRenderModelAssetEXT asset = XR_NULL_HANDLE;
  XrSpace space = XR_NULL_HANDLE;
  int hand = -1;                     // 0 left, 1 right, -1 neither
  std::vector<uint8_t> glb;
  std::vector<std::string> nodes;    // animatable node names, in node-state order
};

class XrRenderModels {
 public:
  // Pose record: kHeader floats [generation, model count, 0, 0], then kMaxModels slots of kStride floats:
  // [valid, px, py, pz, qx, qy, qz, qw] (the model's origin in its hand's grip space), then kMaxNodes nodes of
  // [visible, px, py, pz, qx, qy, qz, qw] (each animatable node in its parent node's space, replacing its glTF
  // transform). Right-handed metres throughout, as WebXR and glTF have them.
  static constexpr int kHeader = 4, kMaxModels = 4, kMaxNodes = 64, kStride = 8 + kMaxNodes * 8;

  void setEnabled(bool on) { enabled_ = on; }
  bool enabled() const { return enabled_; }
  bool create(XrInstance inst, XrSession sess, bool extRenderModel, bool extInteraction);
  void destroy();
  void markDirty() { dirty_ = true; }
  // After xrSyncActions: re-reads the list when it changed, then locates every model and its nodes.
  void update(XrSpace grip[2], XrTime time);
  const std::vector<RenderModelEntry>& models() const { return models_; }
  const float* poseRecord() const { return record_; }
  uint32_t generation() const { return generation_; }

 private:
  void refresh();
  void release();
  bool load(RenderModelEntry& e);

  bool enabled_ = false, ready_ = false, dirty_ = true;
  XrInstance inst_ = XR_NULL_HANDLE; XrSession sess_ = XR_NULL_HANDLE;
  XrPath handPath_[2] = {XR_NULL_PATH, XR_NULL_PATH};
  std::vector<RenderModelEntry> models_;
  uint32_t generation_ = 0;
  float record_[kHeader + kMaxModels * kStride] = {};
  std::vector<XrRenderModelNodeStateEXT> states_;

  PFN_xrCreateRenderModelEXT pfnCreate_ = nullptr;
  PFN_xrDestroyRenderModelEXT pfnDestroy_ = nullptr;
  PFN_xrGetRenderModelPropertiesEXT pfnProps_ = nullptr;
  PFN_xrCreateRenderModelSpaceEXT pfnSpace_ = nullptr;
  PFN_xrCreateRenderModelAssetEXT pfnCreateAsset_ = nullptr;
  PFN_xrDestroyRenderModelAssetEXT pfnDestroyAsset_ = nullptr;
  PFN_xrGetRenderModelAssetDataEXT pfnAssetData_ = nullptr;
  PFN_xrGetRenderModelAssetPropertiesEXT pfnAssetProps_ = nullptr;
  PFN_xrGetRenderModelStateEXT pfnState_ = nullptr;
  PFN_xrEnumerateInteractionRenderModelIdsEXT pfnEnumerate_ = nullptr;
  PFN_xrGetRenderModelPoseTopLevelUserPathEXT pfnTopLevel_ = nullptr;
};

}  // namespace host
