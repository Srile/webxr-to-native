// __native.img: decode / encodePng / resize over host/img/decode.cpp.
//   decode(bytes, cb(width, height, rgba: ArrayBuffer | null, error: string | null))
//     PNG/JPEG → RGBA8, top-down rows, straight alpha. The bytes are COPIED and
//     decoded on a worker thread; the callback runs on the host loop.
//   encodePng(width, height, rgba): ArrayBuffer   — synchronous
//   resize(rgba, w, h, nw, nh): ArrayBuffer       — bilinear, synchronous
// Result buffers are handed to V8 by backing store, no copy.
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "core/log.h"
#include "img/decode.h"
#include "js/bind.h"
#include "js/engine.h"
#include "js/natives.h"

namespace host {

namespace {

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
    job->out = img::decode(job->in.data(), job->in.size());
    deliver(job);
    return;
  }
  std::thread([job, loop] {
    job->out = img::decode(job->in.data(), job->in.size());
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

}  // namespace

void installImages(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native, HostServices& svc) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> img = bind::obj(ctx, native, "img");
  v8::Local<v8::Value> data = newExternal(iso, &svc);  // HostServices outlives the isolate
  bind::fn(ctx, img, "decode", Decode, data);
  bind::fn(ctx, img, "encodePng", EncodePng);
  bind::fn(ctx, img, "resize", Resize);
}

}  // namespace host
