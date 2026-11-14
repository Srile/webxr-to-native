// __native.img: decode / encodePng / resize over host/img/decode.cpp.
//   decode(bytes, cb(width, height, rgba: ArrayBuffer | null, error: string | null))
//     PNG/JPEG → RGBA8, top-down rows, straight alpha. The bytes are COPIED and
//     decoded on a worker thread; the callback runs on the host loop.
//   encodePng(width, height, rgba): ArrayBuffer   — synchronous
//   resize(rgba, w, h, nw, nh): ArrayBuffer       — bilinear, synchronous
// Only with host.json web.canvasText in a build with HOST_HAS_CANVAS_TEXT (img/text.cpp; CMake HOST_CANVAS_TEXT):
//   fontLoad(bytes): id                            — TrueType/OpenType bytes (copied); throws when unreadable
//   fontSystem(): id | -1                          — the platform's sans-serif face
//   textMeasure(font, fallback, px, spacing, text, out: Float64Array(7))
//     out = width, ink left, ink right, ink ascent, ink descent, font ascent, font descent (CSS px)
//   textRaster(font, fallback, px, spacing, scaleX, scaleY, ox, oy, text, alpha: Uint8Array, out: Int32Array(4 or 5), rgba?: Uint8Array): bool
//     out[4]: the text has colour emoji, drawn into rgba (w * h * 4, straight alpha) rather than alpha
//     coverage into alpha, out = w, h, x0, y0 (device px); false with out set when alpha is too small or nothing inks
// decode takes SVG only with host.json web.svg in a build with HOST_HAS_SVG (nanosvg; CMake HOST_SVG).
// Result buffers are handed to V8 by backing store, no copy.
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "core/log.h"
#include "img/decode.h"
#ifdef HOST_HAS_CANVAS_TEXT
#include "img/text.h"
#endif
#include "js/bind.h"
#include "js/engine.h"
#include "js/natives.h"

namespace host {

namespace {

bool g_svg = false;  // host.json web.svg (set by installImages)

// The decode as the game's host.json allows it: SVG bytes are refused when web.svg is off, so a game that did not
// ask for it behaves the same in an APK built without nanosvg and on a desktop host built with it.
img::Image decodeAllowed(const uint8_t* bytes, size_t len) {
  if (!g_svg && img::isSvg(bytes, len)) { img::Image out; out.error = "unsupported image format (SVG images are off: host.json web.svg)"; return out; }
  return img::decode(bytes, len);
}

// Moves a byte vector into an ArrayBuffer without copying; V8 frees it. With V8's sandbox (the Windows prebuilt)
// an ArrayBuffer cannot alias memory outside it: there the pixels are copied in, once per decode.
v8::Local<v8::ArrayBuffer> wrapBytes(v8::Isolate* iso, std::vector<uint8_t>&& bytes) {
  if (bytes.empty()) return v8::ArrayBuffer::New(iso, 0);
#ifdef V8_ENABLE_SANDBOX
  { auto copy = v8::ArrayBuffer::NewBackingStore(iso, bytes.size()); memcpy(copy->Data(), bytes.data(), bytes.size()); return v8::ArrayBuffer::New(iso, std::move(copy)); }
#endif
  auto* heap = new std::vector<uint8_t>(std::move(bytes));
  std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(
      heap->data(), heap->size(),
      [](void*, size_t, void* data) { delete static_cast<std::vector<uint8_t>*>(data); }, heap);
  return v8::ArrayBuffer::New(iso, std::move(store));
}

struct DecodeJob {
  v8::Isolate* iso = nullptr;
  HostServices* svc = nullptr;
  v8::Global<v8::Context> ctx;
  v8::Global<v8::Function> cb;
  std::vector<uint8_t> in;
  img::Image out;
};

// Host thread: hand the decoded image (or the error) to the JS callback.
void deliver(DecodeJob* raw) {
  std::unique_ptr<DecodeJob> job(raw);
  v8::Isolate* iso = job->iso;
  v8::Isolate::Scope is(iso);
  v8::HandleScope hs(iso);
  v8::Local<v8::Context> ctx = job->ctx.Get(iso);
  v8::Context::Scope cs(ctx);
  v8::TryCatch tc(iso);
  v8::Local<v8::Value> argv[4];
  if (job->out.ok()) {
    argv[0] = v8::Number::New(iso, job->out.width);
    argv[1] = v8::Number::New(iso, job->out.height);
    argv[2] = wrapBytes(iso, std::move(job->out.rgba));
    argv[3] = v8::Null(iso);
  } else {
    argv[0] = v8::Number::New(iso, 0);
    argv[1] = v8::Number::New(iso, 0);
    argv[2] = v8::Null(iso);
    argv[3] = bind::str(iso, job->out.error.empty() ? std::string("decode failed") : job->out.error);
  }
  v8::Local<v8::Function> cb = job->cb.Get(iso);
  (void)cb->Call(ctx, v8::Undefined(iso), 4, argv);
  if (tc.HasCaught()) {
    if (job->svc && job->svc->engine) job->svc->engine->reportException(tc);
    else HOST_LOGE("img.decode: callback threw");
  }
}

void Decode(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  auto* svc = static_cast<HostServices*>(externalValue(a.Data()));
  bind::Bytes b = a.Length() > 0 ? bind::bytes(a[0]) : bind::Bytes{};
  if (!b.ok) { bind::throwType(iso, "img.decode: bytes must be an ArrayBuffer or a view"); return; }
  if (a.Length() < 2 || !a[1]->IsFunction()) { bind::throwType(iso, "img.decode: callback required"); return; }
  auto* job = new DecodeJob;
  job->iso = iso; job->svc = svc;
  job->ctx.Reset(iso, iso->GetCurrentContext());
  job->cb.Reset(iso, a[1].As<v8::Function>());
  // Copied: the decode runs off-thread while JS keeps (and may detach) the buffer.
  job->in.assign(b.data, b.data + b.len);
  Loop* loop = svc ? svc->loop : nullptr;
  if (!loop) {  // no loop to post to (tests): decode and deliver inline
    job->out = decodeAllowed(job->in.data(), job->in.size());
    deliver(job);
    return;
  }
  std::thread([job, loop] {
    job->out = decodeAllowed(job->in.data(), job->in.size());
    std::vector<uint8_t>().swap(job->in);
    loop->post([job] { deliver(job); });
  }).detach();
}

void EncodePng(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  int w = bind::i32(a, 0), h = bind::i32(a, 1);
  bind::Bytes b = a.Length() > 2 ? bind::bytes(a[2]) : bind::Bytes{};
  if (w <= 0 || h <= 0) { bind::throwType(iso, "img.encodePng: width and height must be positive"); return; }
  if (!b.ok) { bind::throwType(iso, "img.encodePng: rgba must be an ArrayBuffer or a view"); return; }
  if (b.len < static_cast<size_t>(w) * static_cast<size_t>(h) * 4) { bind::throwType(iso, "img.encodePng: rgba is shorter than width * height * 4"); return; }
  std::vector<uint8_t> png = img::encodePng(w, h, b.data);
  if (png.empty()) { bind::throwError(iso, "img.encodePng: encoding failed"); return; }
  a.GetReturnValue().Set(wrapBytes(iso, std::move(png)));
}

void Resize(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  bind::Bytes b = a.Length() > 0 ? bind::bytes(a[0]) : bind::Bytes{};
  int w = bind::i32(a, 1), h = bind::i32(a, 2), nw = bind::i32(a, 3), nh = bind::i32(a, 4);
  if (!b.ok) { bind::throwType(iso, "img.resize: rgba must be an ArrayBuffer or a view"); return; }
  if (w <= 0 || h <= 0 || nw <= 0 || nh <= 0) { bind::throwType(iso, "img.resize: sizes must be positive"); return; }
  if (b.len < static_cast<size_t>(w) * static_cast<size_t>(h) * 4) { bind::throwType(iso, "img.resize: rgba is shorter than width * height * 4"); return; }
  std::vector<uint8_t> out = img::resize(b.data, w, h, nw, nh);
  if (out.empty()) { bind::throwError(iso, "img.resize: failed"); return; }
  a.GetReturnValue().Set(wrapBytes(iso, std::move(out)));
}

#ifdef HOST_HAS_CANVAS_TEXT
void FontLoad(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  bind::Bytes b = a.Length() > 0 ? bind::bytes(a[0]) : bind::Bytes{};
  if (!b.ok) { bind::throwType(iso, "img.fontLoad: bytes must be an ArrayBuffer or a view"); return; }
  std::string err;
  int id = img::fontLoad(b.data, b.len, err);
  if (id < 0) { bind::throwError(iso, "img.fontLoad: " + err); return; }
  a.GetReturnValue().Set(id);
}

void FontSystem(const v8::FunctionCallbackInfo<v8::Value>& a) { a.GetReturnValue().Set(img::fontSystem()); }

// The text argument as UTF-16, into a reused buffer.
std::vector<uint16_t> g_text;
bool textArg(const v8::FunctionCallbackInfo<v8::Value>& a, int i) {
  if (i >= a.Length() || !a[i]->IsString()) return false;
  v8::Local<v8::String> s = a[i].As<v8::String>();
  const uint32_t n = (uint32_t)s->Length();
  g_text.resize(n);
  if (n) s->WriteV2(a.GetIsolate(), 0, n, g_text.data());
  return true;
}

void TextMeasure(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (!textArg(a, 4)) { bind::throwType(iso, "img.textMeasure: text must be a string"); return; }
  bind::Bytes out = a.Length() > 5 && a[5]->IsFloat64Array() ? bind::bytes(a[5]) : bind::Bytes{};
  if (!out.ok || out.len < 7 * sizeof(double)) { bind::throwType(iso, "img.textMeasure: out must be a Float64Array of 7"); return; }
  img::TextMetrics m;
  img::textMeasure(bind::i32(a, 0, -1), bind::i32(a, 1, -1), (float)bind::num(a, 2), (float)bind::num(a, 3), g_text.data(), g_text.size(), m);
  const double v[7] = {m.width, m.left, m.right, m.ascent, m.descent, m.fontAscent, m.fontDescent};
  memcpy(out.data, v, sizeof v);
}

void TextRaster(const v8::FunctionCallbackInfo<v8::Value>& a) {
  v8::Isolate* iso = a.GetIsolate();
  if (!textArg(a, 8)) { bind::throwType(iso, "img.textRaster: text must be a string"); return; }
  bind::Bytes alpha = a.Length() > 9 && a[9]->IsUint8Array() ? bind::bytes(a[9]) : bind::Bytes{};
  bind::Bytes out = a.Length() > 10 && a[10]->IsInt32Array() ? bind::bytes(a[10]) : bind::Bytes{};
  if (!alpha.ok || !out.ok || out.len < 4 * sizeof(int32_t)) { bind::throwType(iso, "img.textRaster: alpha must be a Uint8Array and out an Int32Array of 4"); return; }
  bind::Bytes rgba = a.Length() > 11 && a[11]->IsUint8Array() ? bind::bytes(a[11]) : bind::Bytes{};
  int w = 0, h = 0, x0 = 0, y0 = 0; bool color = false;
  bool ok = img::textRaster(bind::i32(a, 0, -1), bind::i32(a, 1, -1), (float)bind::num(a, 2), (float)bind::num(a, 3), (float)bind::num(a, 4, 1), (float)bind::num(a, 5, 1),
                            (float)bind::num(a, 6), (float)bind::num(a, 7), g_text.data(), g_text.size(), alpha.data, alpha.len, w, h, x0, y0,
                            rgba.ok ? rgba.data : nullptr, rgba.ok ? rgba.len : 0, color);
  const int32_t v[5] = {w, h, x0, y0, color ? 1 : 0};
  memcpy(out.data, v, out.len >= 5 * sizeof(int32_t) ? sizeof v : 4 * sizeof(int32_t));
  a.GetReturnValue().Set(ok);
}
#endif  // HOST_HAS_CANVAS_TEXT

}  // namespace

void installImages(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> img = bind::obj(ctx, native, "img");
  v8::Local<v8::Value> data = newExternal(iso, &svc);  // HostServices outlives the isolate
  bind::fn(ctx, img, "decode", Decode, data);
  bind::fn(ctx, img, "encodePng", EncodePng);
  bind::fn(ctx, img, "resize", Resize);
  static const Json none;
  const Json& web = svc.config ? svc.config->at("web") : none;

  g_svg = web.bo("svg", false);
#ifdef HOST_HAS_CANVAS_TEXT
  // Absent, the runtime measures text by estimate and draws none, as before (runtime/src/images/canvas2d.js).
  if (web.bo("canvasText", false)) {
    bind::fn(ctx, img, "fontLoad", FontLoad);
    bind::fn(ctx, img, "fontSystem", FontSystem);
    bind::fn(ctx, img, "textMeasure", TextMeasure);
    bind::fn(ctx, img, "textRaster", TextRaster);
  }
#endif

}

}  // namespace host
