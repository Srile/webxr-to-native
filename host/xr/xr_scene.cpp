#include "xr/xr_scene.h"
#include "core/log.h"
#include <cmath>
#include <cstring>
#include <algorithm>

namespace host {
namespace {

// The labels Meta's runtime knows (XR_FB_scene 1.4). Asking for every one of them is what lets the
// runtime hand out the newer ones (TABLE for DESK, INVISIBLE_WALL_FACE) rather than mapping them to OTHER.
const char* kRecognizedLabels = "DESK,COUCH,FLOOR,CEILING,WALL_FACE,WINDOW_FRAME,DOOR_FRAME,STORAGE,BED,SCREEN,LAMP,PLANT,TABLE,WALL_ART,INVISIBLE_WALL_FACE,GLOBAL_MESH,OTHER";

// Runtime label → the WebXR semanticLabel the Quest Browser reports.
std::string webxrLabel(const std::string& raw) {
  std::string first = raw.substr(0, raw.find(','));
  static const struct { const char* fb; const char* web; } kMap[] = {
    {"FLOOR", "floor"}, {"CEILING", "ceiling"}, {"WALL_FACE", "wall"}, {"INVISIBLE_WALL_FACE", "invisible wall"},
    {"TABLE", "table"}, {"DESK", "table"}, {"COUCH", "couch"}, {"DOOR_FRAME", "door"}, {"WINDOW_FRAME", "window"},
    {"STORAGE", "storage"}, {"BED", "bed"}, {"SCREEN", "screen"}, {"LAMP", "lamp"}, {"PLANT", "plant"}, {"SHELF", "shelf"},
    {"WALL_ART", "wall art"}, {"GLOBAL_MESH", "global mesh"}, {"OTHER", "other"},
  };
  for (auto& m : kMap) if (first == m.fb) return m.web;
  std::string s = first; for (char& c : s) { if (c == '_') c = ' '; else if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a'); }
  return s.empty() ? "other" : s;
}

template <class T> void pfn(XrInstance inst, const char* name, T& out) { xrGetInstanceProcAddr(inst, name, (PFN_xrVoidFunction*)&out); }

}  // namespace

void XrScene::init(XrInstance inst, XrSession sess, const SceneExtensions& ext) {
  inst_ = inst; sess_ = sess; ext_ = ext;
  if (ext_.passthrough) {
    pfn(inst, "xrCreatePassthroughFB", pfnCreatePt_); pfn(inst, "xrDestroyPassthroughFB", pfnDestroyPt_);
    pfn(inst, "xrPassthroughStartFB", pfnStartPt_); pfn(inst, "xrPassthroughPauseFB", pfnPausePt_);
    pfn(inst, "xrCreatePassthroughLayerFB", pfnCreateLayer_); pfn(inst, "xrDestroyPassthroughLayerFB", pfnDestroyLayer_);
    pfn(inst, "xrPassthroughLayerPauseFB", pfnLayerPause_); pfn(inst, "xrPassthroughLayerResumeFB", pfnLayerResume_);
  }
  if (ext_.spatialEntity) {
    pfn(inst, "xrEnumerateSpaceSupportedComponentsFB", pfnEnumComponents_); pfn(inst, "xrGetSpaceComponentStatusFB", pfnGetStatus_);
    pfn(inst, "xrSetSpaceComponentStatusFB", pfnSetStatus_); pfn(inst, "xrGetSpaceUuidFB", pfnUuid_);
  }
  if (ext_.query) { pfn(inst, "xrQuerySpacesFB", pfnQuery_); pfn(inst, "xrRetrieveSpaceQueryResultsFB", pfnRetrieve_); }
  if (ext_.scene) {
    pfn(inst, "xrGetSpaceBoundary2DFB", pfnBoundary2D_); pfn(inst, "xrGetSpaceBoundingBox2DFB", pfnBox2D_);
    pfn(inst, "xrGetSpaceBoundingBox3DFB", pfnBox3D_); pfn(inst, "xrGetSpaceSemanticLabelsFB", pfnLabels_);
  }
  if (ext_.meshMeta) pfn(inst, "xrGetSpaceTriangleMeshMETA", pfnTriMesh_);
  if (ext_.sceneCapture) pfn(inst, "xrRequestSceneCaptureFB", pfnCapture_);
}

void XrScene::destroy() { stopPassthrough(); stopScene(); }

// --- passthrough -------------------------------------------------------------

bool XrScene::startPassthrough() {
  if (!passthroughSupported() || !pfnCreatePt_ || !pfnCreateLayer_) return false;
  if (ptLayer_) { setPassthroughVisible(true); return true; }
  XrPassthroughCreateInfoFB pci{XR_TYPE_PASSTHROUGH_CREATE_INFO_FB}; pci.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB;
  XrResult r = pfnCreatePt_(sess_, &pci, &pt_);
  if (XR_FAILED(r)) { HOST_LOGE("xrCreatePassthroughFB failed: %d", (int)r); pt_ = XR_NULL_HANDLE; return false; }
  XrPassthroughLayerCreateInfoFB lci{XR_TYPE_PASSTHROUGH_LAYER_CREATE_INFO_FB};
  lci.passthrough = pt_; lci.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB; lci.purpose = XR_PASSTHROUGH_LAYER_PURPOSE_RECONSTRUCTION_FB;
  r = pfnCreateLayer_(sess_, &lci, &ptLayer_);
  if (XR_FAILED(r)) { HOST_LOGE("xrCreatePassthroughLayerFB failed: %d", (int)r); pfnDestroyPt_(pt_); pt_ = XR_NULL_HANDLE; ptLayer_ = XR_NULL_HANDLE; return false; }
  ptVisible_ = true;
  ptComp_ = {XR_TYPE_COMPOSITION_LAYER_PASSTHROUGH_FB}; ptComp_.flags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT; ptComp_.space = XR_NULL_HANDLE; ptComp_.layerHandle = ptLayer_;
  HOST_LOGI("passthrough started (reconstruction layer)");
  return true;
}

void XrScene::stopPassthrough() {
  if (ptLayer_ && pfnDestroyLayer_) pfnDestroyLayer_(ptLayer_);
  if (pt_ && pfnDestroyPt_) pfnDestroyPt_(pt_);
  if (ptLayer_ || pt_) HOST_LOGI("passthrough stopped");
  ptLayer_ = XR_NULL_HANDLE; pt_ = XR_NULL_HANDLE; ptVisible_ = true;
}

void XrScene::setPassthroughVisible(bool visible) {
  if (!ptLayer_ || visible == ptVisible_) return;
  ptVisible_ = visible;
  XrResult r = visible ? (pfnLayerResume_ ? pfnLayerResume_(ptLayer_) : XR_SUCCESS) : (pfnLayerPause_ ? pfnLayerPause_(ptLayer_) : XR_SUCCESS);
  HOST_LOGI("passthrough layer %s: %d", visible ? "resumed" : "paused (page fully obscures it)", (int)r);
}

const XrCompositionLayerBaseHeader* XrScene::passthroughLayer() {
  if (!ptLayer_ || !ptVisible_) return nullptr;
  return (const XrCompositionLayerBaseHeader*)&ptComp_;
}

// --- scene ---------------------------------------------------------------------

void XrScene::startScene() {
  if (!sceneSupported()) return;
  sceneActive_ = true;
  requery();
}

void XrScene::stopScene() {
  sceneActive_ = false; queryPending_ = false; queryPermission_ = false;
  if (!entities_.empty()) { entities_.clear(); listChanged(); }
  memset(poses_, 0, sizeof poses_);
}

bool XrScene::requery() {
  if (!sceneActive_ || !pfnQuery_ || queryPending_) return false;
  // The LOCAL-storage filter is XR_FB_spatial_entity_storage's: without that extension the runtime refuses the
  // query outright (XR_ERROR_VALIDATION_FAILURE), so an unfiltered query stands in.
  XrSpaceStorageLocationFilterInfoFB loc{XR_TYPE_SPACE_STORAGE_LOCATION_FILTER_INFO_FB}; loc.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrSpaceQueryInfoFB qi{XR_TYPE_SPACE_QUERY_INFO_FB};
  qi.queryAction = XR_SPACE_QUERY_ACTION_LOAD_FB; qi.maxResultCount = kMaxEntities; qi.timeout = 0; qi.filter = ext_.storage ? (const XrSpaceFilterInfoBaseHeaderFB*)&loc : nullptr; qi.excludeFilter = nullptr;
  XrResult r = pfnQuery_(sess_, (const XrSpaceQueryInfoBaseHeaderFB*)&qi, &queryId_);
  if (r == XR_ERROR_VALIDATION_FAILURE && qi.filter) { qi.filter = nullptr; r = pfnQuery_(sess_, (const XrSpaceQueryInfoBaseHeaderFB*)&qi, &queryId_); }
  // -1000113001 .. : the runtime's own codes; a missing USE_SCENE permission comes back as XR_ERROR_PERMISSION_INSUFFICIENT (-1000710000) or a validation failure.
  if (XR_FAILED(r)) { HOST_LOGW("xrQuerySpacesFB failed: %d%s", (int)r, r == (XrResult)-1000710000 ? " (USE_SCENE permission missing)" : ""); queryPermission_ = (r == (XrResult)-1000710000); return false; }
  queryPending_ = true; queryPermission_ = false;
  HOST_LOGI("scene query sent (%llu)", (unsigned long long)queryId_);
  return true;
}

bool XrScene::requestCapture() {
  if (!captureSupported() || !pfnCapture_) return false;
  XrSceneCaptureRequestInfoFB ri{XR_TYPE_SCENE_CAPTURE_REQUEST_INFO_FB}; ri.requestByteCount = 0; ri.request = nullptr;
  XrResult r = pfnCapture_(sess_, &ri, &captureId_);
  HOST_LOGI("scene capture requested: %d", (int)r);
  return XR_SUCCEEDED(r);
}

SceneEntity* XrScene::find(XrSpace space) { for (auto& e : entities_) if (e.space == space) return &e; return nullptr; }

std::string XrScene::uuidHex(const XrUuidEXT& u) {
  static const char* hex = "0123456789abcdef"; std::string s; s.reserve(36);
  for (int i = 0; i < XR_UUID_SIZE; ++i) { if (i == 4 || i == 6 || i == 8 || i == 10) s += '-'; s += hex[u.data[i] >> 4]; s += hex[u.data[i] & 15]; }
  return s;
}

bool XrScene::handleEvent(const XrEventDataBuffer& ev) {
  switch (ev.type) {
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_RESULTS_AVAILABLE_FB: { auto* e = (const XrEventDataSpaceQueryResultsAvailableFB*)&ev; retrieveResults(e->requestId); return true; }
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_COMPLETE_FB: { auto* e = (const XrEventDataSpaceQueryCompleteFB*)&ev; queryPending_ = false; HOST_LOGI("scene query complete: %d, %zu entities", (int)e->result, entities_.size()); return true; }
    case XR_TYPE_EVENT_DATA_SPACE_SET_STATUS_COMPLETE_FB: {
      auto* e = (const XrEventDataSpaceSetStatusCompleteFB*)&ev;
      SceneEntity* ent = find(e->space);
      if (ent) {
        if (e->componentType == XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB) { ent->pendingLocatable = false; ent->locatable = XR_SUCCEEDED(e->result) && e->enabled; }
        if (describe(*ent)) { assignSlots(); listChanged(); }
      }
      return true; }
    case XR_TYPE_EVENT_DATA_SCENE_CAPTURE_COMPLETE_FB: {
      auto* e = (const XrEventDataSceneCaptureCompleteFB*)&ev; captureDone_ = true; captureOk_ = XR_SUCCEEDED(e->result);
      HOST_LOGI("scene capture complete: %d", (int)e->result);
      if (captureOk_) requery();
      return true; }
    case XR_TYPE_EVENT_DATA_PASSTHROUGH_STATE_CHANGED_FB: return true;
    default: return false;
  }
}

void XrScene::retrieveResults(XrAsyncRequestIdFB id) {
  if (!pfnRetrieve_) return;
  XrSpaceQueryResultsFB res{XR_TYPE_SPACE_QUERY_RESULTS_FB};
  if (XR_FAILED(pfnRetrieve_(sess_, id, &res))) return;
  std::vector<XrSpaceQueryResultFB> items(res.resultCountOutput);
  res.resultCapacityInput = (uint32_t)items.size(); res.results = items.data();
  if (XR_FAILED(pfnRetrieve_(sess_, id, &res))) return;
  bool changed = false;
  // A fresh result set replaces the list: spaces not in it are gone (a re-captured room), the rest keep their records.
  std::vector<SceneEntity> next;
  for (uint32_t i = 0; i < res.resultCountOutput; ++i) {
    SceneEntity* old = find(items[i].space);
    if (old) { next.push_back(std::move(*old)); old->space = XR_NULL_HANDLE; memset(old->uuid.data, 0, XR_UUID_SIZE); continue; }
    // Same uuid under a new handle: carry the record over so the page keeps its XRPlane/XRMesh identity.
    bool carried = false;
    for (auto& e : entities_) if (!memcmp(e.uuid.data, items[i].uuid.data, XR_UUID_SIZE) && e.space != XR_NULL_HANDLE) { SceneEntity c = e; c.space = items[i].space; e.space = XR_NULL_HANDLE; next.push_back(std::move(c)); carried = true; changed = true; break; }
    if (carried) continue;
    SceneEntity e; e.space = items[i].space; e.uuid = items[i].uuid; e.id = uuidHex(e.uuid);
    describe(e);
    next.push_back(std::move(e)); changed = true;
  }
  if (next.size() != entities_.size()) changed = true;
  entities_ = std::move(next);
  if (changed) { assignSlots(); listChanged(); }
  int planes = 0, meshes = 0; for (auto& e : entities_) { planes += e.kind == 1; meshes += e.kind == 2; }
  HOST_LOGI("scene: %u anchors → %d planes, %d meshes", res.resultCountOutput, planes, meshes);
}

void XrScene::assignSlots() {
  int slot = 0;
  for (auto& e : entities_) e.slot = (e.kind != 0 && slot < kMaxEntities) ? slot++ : -1;
}

// Reads the entity's components and, where they are enabled, its geometry and label. Components that
// are supported but off get an enable request; the completion event brings us back here.
bool XrScene::describe(SceneEntity& e) {
  if (!pfnEnumComponents_ || !pfnGetStatus_) return false;
  uint32_t n = 0; pfnEnumComponents_(e.space, 0, &n, nullptr);
  std::vector<XrSpaceComponentTypeFB> comps(n); if (n) pfnEnumComponents_(e.space, n, &n, comps.data());
  auto supports = [&](XrSpaceComponentTypeFB t) { return std::find(comps.begin(), comps.end(), t) != comps.end(); };
  auto enabled = [&](XrSpaceComponentTypeFB t) { XrSpaceComponentStatusFB st{XR_TYPE_SPACE_COMPONENT_STATUS_FB}; return supports(t) && XR_SUCCEEDED(pfnGetStatus_(e.space, t, &st)) && st.enabled; };
  auto enable = [&](XrSpaceComponentTypeFB t) {
    if (!pfnSetStatus_) return;
    XrSpaceComponentStatusFB st{XR_TYPE_SPACE_COMPONENT_STATUS_FB}; if (XR_FAILED(pfnGetStatus_(e.space, t, &st)) || st.changePending) return;
    XrSpaceComponentStatusSetInfoFB si{XR_TYPE_SPACE_COMPONENT_STATUS_SET_INFO_FB}; si.componentType = t; si.enabled = XR_TRUE; si.timeout = 0;
    XrAsyncRequestIdFB rid = 0; pfnSetStatus_(e.space, &si, &rid);
  };
  // The room itself (ROOM_LAYOUT) and bare containers carry no surface: skipped, kept for completeness.
  bool isPlane = supports(XR_SPACE_COMPONENT_TYPE_BOUNDED_2D_FB);
  bool isTriMesh = ext_.meshMeta && supports(XR_SPACE_COMPONENT_TYPE_TRIANGLE_MESH_META);
  bool isBox = supports(XR_SPACE_COMPONENT_TYPE_BOUNDED_3D_FB);
  if (!isPlane && !isTriMesh && !isBox) { e.kind = 0; e.described = true; return false; }
  if (supports(XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB)) {
    e.locatable = enabled(XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB);
    if (!e.locatable && !e.pendingLocatable) { e.pendingLocatable = true; enable(XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB); }
  }
  int kind = 0; std::string label; std::vector<float> polygon, vertices; std::vector<uint32_t> indices;
  if (supports(XR_SPACE_COMPONENT_TYPE_SEMANTIC_LABELS_FB) && pfnLabels_) {
    if (enabled(XR_SPACE_COMPONENT_TYPE_SEMANTIC_LABELS_FB)) {
      XrSemanticLabelsSupportInfoFB sup{XR_TYPE_SEMANTIC_LABELS_SUPPORT_INFO_FB};
      sup.flags = XR_SEMANTIC_LABELS_SUPPORT_MULTIPLE_SEMANTIC_LABELS_BIT_FB | XR_SEMANTIC_LABELS_SUPPORT_ACCEPT_DESK_TO_TABLE_MIGRATION_BIT_FB | XR_SEMANTIC_LABELS_SUPPORT_ACCEPT_INVISIBLE_WALL_FACE_BIT_FB;
      sup.recognizedLabels = kRecognizedLabels;
      XrSemanticLabelsFB sl{XR_TYPE_SEMANTIC_LABELS_FB}; sl.next = &sup;
      if (XR_SUCCEEDED(pfnLabels_(sess_, e.space, &sl)) && sl.bufferCountOutput > 0) {
        std::string buf(sl.bufferCountOutput, '\0'); sl.bufferCapacityInput = sl.bufferCountOutput; sl.buffer = buf.data();
        if (XR_SUCCEEDED(pfnLabels_(sess_, e.space, &sl))) { buf.resize(strnlen(buf.data(), buf.size())); label = webxrLabel(buf); }
      }
    } else enable(XR_SPACE_COMPONENT_TYPE_SEMANTIC_LABELS_FB);
  }
  if (isTriMesh && pfnTriMesh_) {
    if (enabled(XR_SPACE_COMPONENT_TYPE_TRIANGLE_MESH_META)) {
      XrSpaceTriangleMeshGetInfoMETA gi{XR_TYPE_SPACE_TRIANGLE_MESH_GET_INFO_META};
      XrSpaceTriangleMeshMETA tm{XR_TYPE_SPACE_TRIANGLE_MESH_META};
      if (XR_SUCCEEDED(pfnTriMesh_(e.space, &gi, &tm)) && tm.vertexCountOutput > 0 && tm.indexCountOutput > 0) {
        std::vector<XrVector3f> vs(tm.vertexCountOutput); indices.resize(tm.indexCountOutput);
        tm.vertexCapacityInput = (uint32_t)vs.size(); tm.vertices = vs.data(); tm.indexCapacityInput = (uint32_t)indices.size(); tm.indices = indices.data();
        if (XR_SUCCEEDED(pfnTriMesh_(e.space, &gi, &tm))) {
          vertices.resize((size_t)tm.vertexCountOutput * 3);
          for (uint32_t i = 0; i < tm.vertexCountOutput; ++i) { vertices[i * 3] = vs[i].x; vertices[i * 3 + 1] = vs[i].y; vertices[i * 3 + 2] = vs[i].z; }
          indices.resize(tm.indexCountOutput);
          kind = 2; if (label.empty()) label = "global mesh";
        } else indices.clear();
      }
    } else enable(XR_SPACE_COMPONENT_TYPE_TRIANGLE_MESH_META);
  }
  if (kind == 0 && isPlane && pfnBoundary2D_) {
    if (enabled(XR_SPACE_COMPONENT_TYPE_BOUNDED_2D_FB)) {
      XrBoundary2DFB b{XR_TYPE_BOUNDARY_2D_FB};
      if (XR_SUCCEEDED(pfnBoundary2D_(sess_, e.space, &b)) && b.vertexCountOutput >= 3) {
        std::vector<XrVector2f> pts(b.vertexCountOutput); b.vertexCapacityInput = (uint32_t)pts.size(); b.vertices = pts.data();
        if (XR_SUCCEEDED(pfnBoundary2D_(sess_, e.space, &b))) { polygon.resize((size_t)b.vertexCountOutput * 2); for (uint32_t i = 0; i < b.vertexCountOutput; ++i) { polygon[i * 2] = pts[i].x; polygon[i * 2 + 1] = -pts[i].y; } }
      }
      if (polygon.empty() && pfnBox2D_) {
        XrRect2Df r{};
        if (XR_SUCCEEDED(pfnBox2D_(sess_, e.space, &r))) {
          float x0 = r.offset.x, y0 = r.offset.y, x1 = x0 + r.extent.width, y1 = y0 + r.extent.height;
          polygon = { x0, -y0, x1, -y0, x1, -y1, x0, -y1 };
        }
      }
      if (!polygon.empty()) kind = 1;
    } else enable(XR_SPACE_COMPONENT_TYPE_BOUNDED_2D_FB);
  }
  if (kind == 0 && isBox && pfnBox3D_) {
    if (enabled(XR_SPACE_COMPONENT_TYPE_BOUNDED_3D_FB)) {
      XrRect3DfFB r{};
      if (XR_SUCCEEDED(pfnBox3D_(sess_, e.space, &r))) {
        float x0 = r.offset.x, y0 = r.offset.y, z0 = r.offset.z, x1 = x0 + r.extent.width, y1 = y0 + r.extent.height, z1 = z0 + r.extent.depth;
        vertices = { x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1 };
        indices = { 0, 2, 1, 0, 3, 2,  4, 5, 6, 4, 6, 7,  0, 1, 5, 0, 5, 4,  1, 2, 6, 1, 6, 5,  2, 3, 7, 2, 7, 6,  3, 0, 4, 3, 4, 7 };
        kind = 2;
      }
    } else enable(XR_SPACE_COMPONENT_TYPE_BOUNDED_3D_FB);
  }
  if (label.empty()) label = "other";
  // Invisible walls close an open room for the system; they are no surface a player can point at (the browser lists none).
  if (label == "invisible wall") kind = 0;
  bool changed = kind != e.kind || label != e.label || polygon != e.polygon || vertices != e.vertices || indices != e.indices;
  if (changed) { e.kind = kind; e.label = label; e.polygon = std::move(polygon); e.vertices = std::move(vertices); e.indices = std::move(indices); e.changed++; }
  e.described = true;
  return changed;
}

void XrScene::locate(XrSpace base, XrTime time) {
  if (!sceneActive_) return;
  const float s = 0.70710678f;  // rotX(+90°): the FB plane's +Z normal becomes the WebXR plane's +Y
  for (auto& e : entities_) {
    if (e.slot < 0) continue;
    float* o = poses_ + e.slot * kPoseStride;
    e.poseValid = false;
    if (e.locatable && e.space) {
      XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
      if (XR_SUCCEEDED(xrLocateSpace(e.space, base, time, &loc)) && (loc.locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) && (loc.locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT)) {
        e.poseValid = true;
        e.pos[0] = loc.pose.position.x; e.pos[1] = loc.pose.position.y; e.pos[2] = loc.pose.position.z;
        const auto& q = loc.pose.orientation;
        if (e.kind == 1) { e.quat[0] = q.w * s + q.x * s; e.quat[1] = q.y * s + q.z * s; e.quat[2] = q.z * s - q.y * s; e.quat[3] = q.w * s - q.x * s; }
        else { e.quat[0] = q.x; e.quat[1] = q.y; e.quat[2] = q.z; e.quat[3] = q.w; }
      }
    }
    o[0] = e.poseValid ? 1.f : 0.f;
    for (int i = 0; i < 3; ++i) o[1 + i] = e.pos[i];
    for (int i = 0; i < 4; ++i) o[4 + i] = e.quat[i];
  }
}

}  // namespace host
