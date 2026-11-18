#include "xr/xr_render_models.h"
#include "core/log.h"
#include <algorithm>
#include <cstring>

namespace host {
namespace {
template <class T> void pfn(XrInstance inst, const char* name, T& out) { xrGetInstanceProcAddr(inst, name, (PFN_xrVoidFunction*)&out); }
}  // namespace

bool XrRenderModels::create(XrInstance inst, XrSession sess, bool extRenderModel, bool extInteraction) {
  inst_ = inst; sess_ = sess; ready_ = false;
  if (!enabled_) return false;
  if (!extRenderModel || !extInteraction) { HOST_LOGI("render models: the runtime lacks XR_EXT_render_model / XR_EXT_interaction_render_model"); return false; }
  pfn(inst, "xrCreateRenderModelEXT", pfnCreate_); pfn(inst, "xrDestroyRenderModelEXT", pfnDestroy_);
  pfn(inst, "xrGetRenderModelPropertiesEXT", pfnProps_); pfn(inst, "xrCreateRenderModelSpaceEXT", pfnSpace_);
  pfn(inst, "xrCreateRenderModelAssetEXT", pfnCreateAsset_); pfn(inst, "xrDestroyRenderModelAssetEXT", pfnDestroyAsset_);
  pfn(inst, "xrGetRenderModelAssetDataEXT", pfnAssetData_); pfn(inst, "xrGetRenderModelAssetPropertiesEXT", pfnAssetProps_);
  pfn(inst, "xrGetRenderModelStateEXT", pfnState_);
  pfn(inst, "xrEnumerateInteractionRenderModelIdsEXT", pfnEnumerate_); pfn(inst, "xrGetRenderModelPoseTopLevelUserPathEXT", pfnTopLevel_);
  if (!pfnCreate_ || !pfnDestroy_ || !pfnProps_ || !pfnSpace_ || !pfnCreateAsset_ || !pfnDestroyAsset_ || !pfnAssetData_ || !pfnAssetProps_ || !pfnState_ || !pfnEnumerate_ || !pfnTopLevel_) {
    HOST_LOGW("render models: entry points missing"); return false;
  }
  xrStringToPath(inst, "/user/hand/left", &handPath_[0]); xrStringToPath(inst, "/user/hand/right", &handPath_[1]);
  ready_ = true; dirty_ = true;
  HOST_LOGI("render models: on");
  return true;
}

void XrRenderModels::release() {
  for (auto& e : models_) {
    if (e.space) xrDestroySpace(e.space);
    if (e.asset) pfnDestroyAsset_(e.asset);
    if (e.model) pfnDestroy_(e.model);
  }
  models_.clear();
}

void XrRenderModels::destroy() {
  if (ready_) release();
  ready_ = false;
  memset(record_, 0, sizeof(record_));
}

// The model's GLB, its animatable node names, its space and the hand it is posed by.
bool XrRenderModels::load(RenderModelEntry& e) {
  XrRenderModelCreateInfoEXT ci{XR_TYPE_RENDER_MODEL_CREATE_INFO_EXT}; ci.renderModelId = (XrRenderModelIdEXT)e.id;  // no glTF extensions: the base asset
  XrResult r = pfnCreate_(sess_, &ci, &e.model);
  if (XR_FAILED(r)) { HOST_LOGW("render models: xrCreateRenderModelEXT(%llu) %d", (unsigned long long)e.id, (int)r); return false; }
  XrRenderModelPropertiesGetInfoEXT pgi{XR_TYPE_RENDER_MODEL_PROPERTIES_GET_INFO_EXT}; XrRenderModelPropertiesEXT props{XR_TYPE_RENDER_MODEL_PROPERTIES_EXT};
  if (XR_FAILED(r = pfnProps_(e.model, &pgi, &props))) { HOST_LOGW("render models: properties %d", (int)r); return false; }
  XrRenderModelAssetCreateInfoEXT aci{XR_TYPE_RENDER_MODEL_ASSET_CREATE_INFO_EXT}; aci.cacheId = props.cacheId;
  if (XR_FAILED(r = pfnCreateAsset_(sess_, &aci, &e.asset))) { HOST_LOGW("render models: asset %d", (int)r); return false; }
  XrRenderModelAssetDataGetInfoEXT dgi{XR_TYPE_RENDER_MODEL_ASSET_DATA_GET_INFO_EXT}; XrRenderModelAssetDataEXT data{XR_TYPE_RENDER_MODEL_ASSET_DATA_EXT};
  if (XR_FAILED(r = pfnAssetData_(e.asset, &dgi, &data)) || !data.bufferCountOutput) { HOST_LOGW("render models: asset size %d", (int)r); return false; }
  e.glb.resize(data.bufferCountOutput); data.bufferCapacityInput = (uint32_t)e.glb.size(); data.buffer = e.glb.data();
  if (XR_FAILED(r = pfnAssetData_(e.asset, &dgi, &data))) { HOST_LOGW("render models: asset data %d", (int)r); return false; }
  std::vector<XrRenderModelAssetNodePropertiesEXT> nodes(props.animatableNodeCount);
  XrRenderModelAssetPropertiesGetInfoEXT agi{XR_TYPE_RENDER_MODEL_ASSET_PROPERTIES_GET_INFO_EXT}; XrRenderModelAssetPropertiesEXT aprops{XR_TYPE_RENDER_MODEL_ASSET_PROPERTIES_EXT};
  aprops.nodePropertyCount = props.animatableNodeCount; aprops.nodeProperties = nodes.data();
  if (props.animatableNodeCount && XR_FAILED(r = pfnAssetProps_(e.asset, &agi, &aprops))) { HOST_LOGW("render models: node names %d", (int)r); return false; }
  for (auto& n : nodes) e.nodes.emplace_back(n.uniqueName, strnlen(n.uniqueName, XR_MAX_RENDER_MODEL_ASSET_NODE_NAME_SIZE_EXT));
  XrRenderModelSpaceCreateInfoEXT sci{XR_TYPE_RENDER_MODEL_SPACE_CREATE_INFO_EXT}; sci.renderModel = e.model;
  if (XR_FAILED(r = pfnSpace_(sess_, &sci, &e.space))) { HOST_LOGW("render models: space %d", (int)r); return false; }
  XrInteractionRenderModelTopLevelUserPathGetInfoEXT ti{XR_TYPE_INTERACTION_RENDER_MODEL_TOP_LEVEL_USER_PATH_GET_INFO_EXT};
  ti.topLevelUserPathCount = 2; ti.topLevelUserPaths = handPath_;
  XrPath top = XR_NULL_PATH;
  if (XR_SUCCEEDED(pfnTopLevel_(e.model, &ti, &top))) e.hand = top == handPath_[0] ? 0 : top == handPath_[1] ? 1 : -1;
  HOST_LOGI("render models: %llu hand %d, %zu-byte GLB, %zu animatable nodes", (unsigned long long)e.id, e.hand, e.glb.size(), e.nodes.size());
  return true;
}

void XrRenderModels::refresh() {
  dirty_ = false;
  XrInteractionRenderModelIdsEnumerateInfoEXT ei{XR_TYPE_INTERACTION_RENDER_MODEL_IDS_ENUMERATE_INFO_EXT};
  uint32_t n = 0;
  XrResult r = pfnEnumerate_(sess_, &ei, 0, &n, nullptr);
  if (XR_FAILED(r)) { HOST_LOGW("render models: enumerate %d", (int)r); return; }
  std::vector<XrRenderModelIdEXT> ids(n);
  if (n && XR_FAILED(r = pfnEnumerate_(sess_, &ei, n, &n, ids.data()))) { HOST_LOGW("render models: enumerate %d", (int)r); return; }
  // The same ids keep their models (and the page its loaded meshes); the generation moves only when the set changes.
  std::vector<RenderModelEntry> next;
  bool changed = false;
  for (uint32_t i = 0; i < n && (int)next.size() < kMaxModels; ++i) {
    auto it = std::find_if(models_.begin(), models_.end(), [&](const RenderModelEntry& e) { return e.id == (uint64_t)ids[i]; });
    if (it != models_.end()) { next.push_back(std::move(*it)); models_.erase(it); continue; }
    RenderModelEntry e; e.id = (uint64_t)ids[i];
    if (load(e)) { next.push_back(std::move(e)); changed = true; }
    else { if (e.space) xrDestroySpace(e.space); if (e.asset) pfnDestroyAsset_(e.asset); if (e.model) pfnDestroy_(e.model); }
  }
  if (!models_.empty()) changed = true;
  release();
  models_ = std::move(next);
  // A hand's model may move to the other hand without changing ids (handed controllers report it once known).
  XrInteractionRenderModelTopLevelUserPathGetInfoEXT ti{XR_TYPE_INTERACTION_RENDER_MODEL_TOP_LEVEL_USER_PATH_GET_INFO_EXT};
  ti.topLevelUserPathCount = 2; ti.topLevelUserPaths = handPath_;
  for (auto& e : models_) {
    XrPath top = XR_NULL_PATH; int hand = -1;
    if (XR_SUCCEEDED(pfnTopLevel_(e.model, &ti, &top))) hand = top == handPath_[0] ? 0 : top == handPath_[1] ? 1 : -1;
    if (hand != e.hand) { e.hand = hand; changed = true; }
  }
  if (changed) { ++generation_; HOST_LOGI("render models: %zu listed (generation %u)", models_.size(), generation_); }
}

void XrRenderModels::update(XrSpace grip[2], XrTime time) {
  if (!ready_) return;
  if (dirty_) refresh();
  record_[0] = (float)generation_; record_[1] = (float)models_.size();
  for (size_t m = 0; m < models_.size(); ++m) {
    const RenderModelEntry& e = models_[m];
    float* o = record_ + kHeader + m * kStride;
    o[0] = 0;
    if (e.hand < 0 || !grip[e.hand]) continue;
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
    const XrSpaceLocationFlags tracked = XR_SPACE_LOCATION_POSITION_TRACKED_BIT | XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT;
    if (XR_FAILED(xrLocateSpace(e.space, grip[e.hand], time, &loc)) || (loc.locationFlags & tracked) != tracked) continue;
    o[0] = 1; o[1] = loc.pose.position.x; o[2] = loc.pose.position.y; o[3] = loc.pose.position.z;
    o[4] = loc.pose.orientation.x; o[5] = loc.pose.orientation.y; o[6] = loc.pose.orientation.z; o[7] = loc.pose.orientation.w;
    if (e.nodes.empty()) continue;
    states_.resize(e.nodes.size());
    XrRenderModelStateGetInfoEXT si{XR_TYPE_RENDER_MODEL_STATE_GET_INFO_EXT}; si.displayTime = time;
    XrRenderModelStateEXT st{XR_TYPE_RENDER_MODEL_STATE_EXT}; st.nodeStateCount = (uint32_t)states_.size(); st.nodeStates = states_.data();
    if (XR_FAILED(pfnState_(e.model, &si, &st))) continue;
    const size_t count = std::min(states_.size(), (size_t)kMaxNodes);
    for (size_t i = 0; i < count; ++i) {
      const XrRenderModelNodeStateEXT& s = states_[i]; float* q = o + 8 + i * 8;
      q[0] = s.isVisible ? 1.f : 0.f; q[1] = s.nodePose.position.x; q[2] = s.nodePose.position.y; q[3] = s.nodePose.position.z;
      q[4] = s.nodePose.orientation.x; q[5] = s.nodePose.orientation.y; q[6] = s.nodePose.orientation.z; q[7] = s.nodePose.orientation.w;
    }
  }
}

}  // namespace host
