// XrRenderModels::refresh over a fake runtime (the OpenXR entry points stubbed here): a model keeps its slot in the
// pose record while it stays listed, whatever order the runtime lists the ids in, and the generation moves whenever
// the set or any model's slot changes, so the page's views by slot (runtime/src/webxr/render-models.js) never point
// at the other controller.
#include "xr/xr_render_models.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <set>
#include <vector>

namespace {
std::vector<uint64_t> g_ids;          // what the runtime lists now, in its order
std::set<uint64_t> g_live;            // render models created and not yet destroyed
const XrPath kLeft = 11, kRight = 12;
uint64_t idOf(XrRenderModelEXT m) { return (uint64_t)(uintptr_t)m; }
// model 1 is held in the left hand, 2 in the right, any other in neither
XrPath handOf(uint64_t id) { return id == 1 ? kLeft : id == 2 ? kRight : XR_NULL_PATH; }

XrResult XRAPI_CALL createModel(XrSession, const XrRenderModelCreateInfoEXT* ci, XrRenderModelEXT* out) { *out = (XrRenderModelEXT)(uintptr_t)ci->renderModelId; g_live.insert(ci->renderModelId); return XR_SUCCESS; }
XrResult XRAPI_CALL destroyModel(XrRenderModelEXT m) { assert(g_live.erase(idOf(m)) == 1); return XR_SUCCESS; }
XrResult XRAPI_CALL props(XrRenderModelEXT, const XrRenderModelPropertiesGetInfoEXT*, XrRenderModelPropertiesEXT* p) { p->cacheId = {}; p->animatableNodeCount = 0; return XR_SUCCESS; }
XrResult XRAPI_CALL space(XrSession, const XrRenderModelSpaceCreateInfoEXT* ci, XrSpace* out) { *out = (XrSpace)(uintptr_t)(1000 + idOf(ci->renderModel)); return XR_SUCCESS; }
XrResult XRAPI_CALL createAsset(XrSession, const XrRenderModelAssetCreateInfoEXT*, XrRenderModelAssetEXT* out) { *out = (XrRenderModelAssetEXT)(uintptr_t)1; return XR_SUCCESS; }
XrResult XRAPI_CALL destroyAsset(XrRenderModelAssetEXT) { return XR_SUCCESS; }
XrResult XRAPI_CALL assetData(XrRenderModelAssetEXT, const XrRenderModelAssetDataGetInfoEXT*, XrRenderModelAssetDataEXT* d) { d->bufferCountOutput = 4; if (d->buffer) memcpy(d->buffer, "glTF", 4); return XR_SUCCESS; }
XrResult XRAPI_CALL assetProps(XrRenderModelAssetEXT, const XrRenderModelAssetPropertiesGetInfoEXT*, XrRenderModelAssetPropertiesEXT*) { return XR_SUCCESS; }
XrResult XRAPI_CALL state(XrRenderModelEXT, const XrRenderModelStateGetInfoEXT*, XrRenderModelStateEXT*) { return XR_SUCCESS; }
XrResult XRAPI_CALL enumerate(XrSession, const XrInteractionRenderModelIdsEnumerateInfoEXT*, uint32_t cap, uint32_t* count, XrRenderModelIdEXT* ids) {
  *count = (uint32_t)g_ids.size();
  if (cap) for (size_t i = 0; i < g_ids.size() && i < cap; ++i) ids[i] = (XrRenderModelIdEXT)g_ids[i];
  return XR_SUCCESS;
}
XrResult XRAPI_CALL topLevel(XrRenderModelEXT m, const XrInteractionRenderModelTopLevelUserPathGetInfoEXT*, XrPath* out) { *out = handOf(idOf(m)); return XR_SUCCESS; }
}  // namespace

// The core entry points xr_render_models.cpp calls directly.
extern "C" {
XRAPI_ATTR XrResult XRAPI_CALL xrGetInstanceProcAddr(XrInstance, const char* name, PFN_xrVoidFunction* fn) {
  struct { const char* n; PFN_xrVoidFunction f; } table[] = {
    {"xrCreateRenderModelEXT", (PFN_xrVoidFunction)createModel}, {"xrDestroyRenderModelEXT", (PFN_xrVoidFunction)destroyModel},
    {"xrGetRenderModelPropertiesEXT", (PFN_xrVoidFunction)props}, {"xrCreateRenderModelSpaceEXT", (PFN_xrVoidFunction)space},
    {"xrCreateRenderModelAssetEXT", (PFN_xrVoidFunction)createAsset}, {"xrDestroyRenderModelAssetEXT", (PFN_xrVoidFunction)destroyAsset},
    {"xrGetRenderModelAssetDataEXT", (PFN_xrVoidFunction)assetData}, {"xrGetRenderModelAssetPropertiesEXT", (PFN_xrVoidFunction)assetProps},
    {"xrGetRenderModelStateEXT", (PFN_xrVoidFunction)state}, {"xrEnumerateInteractionRenderModelIdsEXT", (PFN_xrVoidFunction)enumerate},
    {"xrGetRenderModelPoseTopLevelUserPathEXT", (PFN_xrVoidFunction)topLevel},
  };
  for (auto& t : table) if (!strcmp(t.n, name)) { *fn = t.f; return XR_SUCCESS; }
  *fn = nullptr; return XR_ERROR_FUNCTION_UNSUPPORTED;
}
XRAPI_ATTR XrResult XRAPI_CALL xrStringToPath(XrInstance, const char* s, XrPath* out) { *out = !strcmp(s, "/user/hand/left") ? kLeft : kRight; return XR_SUCCESS; }
XRAPI_ATTR XrResult XRAPI_CALL xrDestroySpace(XrSpace) { return XR_SUCCESS; }
XRAPI_ATTR XrResult XRAPI_CALL xrLocateSpace(XrSpace, XrSpace, XrTime, XrSpaceLocation* loc) { loc->locationFlags = 0; return XR_SUCCESS; }
}

int main() {
  host::XrRenderModels rm; rm.setEnabled(true);
  assert(rm.create((XrInstance)(uintptr_t)1, (XrSession)(uintptr_t)2, true, true));
  XrSpace grip[2] = {(XrSpace)(uintptr_t)5, (XrSpace)(uintptr_t)6};
  const auto slots = [&] { std::vector<uint64_t> v; for (auto& e : rm.models()) v.push_back(e.id); return v; };
  const auto refresh = [&](std::vector<uint64_t> ids) { g_ids = std::move(ids); rm.markDirty(); rm.update(grip, 0); };

  refresh({1, 2});
  assert((slots() == std::vector<uint64_t>{1, 2}));
  const uint32_t g0 = rm.generation();
  assert(rm.poseRecord()[0] == (float)g0 && rm.poseRecord()[1] == 2.f);
  assert(rm.models()[0].hand == 0 && rm.models()[1].hand == 1);

  // The same ids in another order: both keep their slots, and nothing changed for the page.
  refresh({2, 1});
  assert((slots() == std::vector<uint64_t>{1, 2}));
  assert(rm.generation() == g0);
  assert(g_live.size() == 2);   // nothing destroyed or made again

  // A new model goes after the ones that stay; the set changed.
  refresh({3, 2, 1});
  assert((slots() == std::vector<uint64_t>{1, 2, 3}));
  const uint32_t g1 = rm.generation(); assert(g1 > g0);

  // One before others goes: theirs move down a slot, so the generation moves too, and it is destroyed.
  refresh({3, 2});
  assert((slots() == std::vector<uint64_t>{2, 3}));
  assert(rm.generation() > g1 && g_live.count(1) == 0 && g_live.size() == 2);

  rm.destroy(); assert(g_live.empty());
  puts("render_models_test ok"); return 0;
}
