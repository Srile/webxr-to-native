// The ONE translation unit that compiles stb_image and stb_image_write.
#include "img/decode.h"
#ifdef HOST_HAS_WEBP
#include <webp/decode.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-function"
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wsign-compare"
#pragma clang diagnostic ignored "-Wimplicit-fallthrough"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wsign-compare"
#endif

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#include <stb_image.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include <stb_image_write.h>

#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace host {
namespace img {

namespace {

bool isPng(const uint8_t* b, size_t n) { return n >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A; }
bool isJpeg(const uint8_t* b, size_t n) { return n >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF; }
bool isWebp(const uint8_t* b, size_t n) { return n >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P'; }

void appendBytes(void* ctx, void* data, int size) {
  auto* out = static_cast<std::vector<uint8_t>*>(ctx);
  const uint8_t* p = static_cast<const uint8_t*>(data);
  out->insert(out->end(), p, p + size);
}

}  // namespace

Image decode(const uint8_t* bytes, size_t len) {
  Image out;
  if (!bytes || len == 0) { out.error = "empty image data"; return out; }
  if (len > static_cast<size_t>(INT32_MAX)) { out.error = "image data too large"; return out; }
  if (isWebp(bytes, len)) {
#ifdef HOST_HAS_WEBP
    int w = 0, h = 0;
    uint8_t* px = WebPDecodeRGBA(bytes, len, &w, &h);
    if (!px || w <= 0 || h <= 0) { if (px) WebPFree(px); out.error = "decode failed: bad WebP"; return out; }
    out.width = w; out.height = h; out.rgba.assign(px, px + static_cast<size_t>(w) * static_cast<size_t>(h) * 4); WebPFree(px);
    return out;
#else
    out.error = "unsupported image format (WebP: build without libwebp)"; return out;
#endif
  }
  if (!isPng(bytes, len) && !isJpeg(bytes, len)) { out.error = "unsupported image format (PNG, JPEG and WebP only)"; return out; }
  int w = 0, h = 0, channels = 0;
  // Always ask for 4 channels: palette, grey and RGB PNGs all come out RGBA8, top-down.
  stbi_uc* px = stbi_load_from_memory(bytes, static_cast<int>(len), &w, &h, &channels, 4);
  if (!px) {
    // stbi_failure_reason reads a process-wide static; good enough for a message.
    const char* why = stbi_failure_reason();
    out.error = std::string("decode failed: ") + (why ? why : "unknown error");
    return out;
  }
  if (w <= 0 || h <= 0) { stbi_image_free(px); out.error = "decode failed: empty image"; return out; }
  out.width = w; out.height = h;
  out.rgba.assign(px, px + static_cast<size_t>(w) * static_cast<size_t>(h) * 4);
  stbi_image_free(px);
  return out;
}

std::vector<uint8_t> encodePng(int width, int height, const uint8_t* rgba) {
  std::vector<uint8_t> out;
  if (width <= 0 || height <= 0 || !rgba) return out;
  out.reserve(static_cast<size_t>(width) * static_cast<size_t>(height) + 64);
  if (!stbi_write_png_to_func(appendBytes, &out, width, height, 4, rgba, width * 4)) out.clear();
  return out;
}

std::vector<uint8_t> resize(const uint8_t* src, int w, int h, int nw, int nh) {
  std::vector<uint8_t> out;
  if (!src || w <= 0 || h <= 0 || nw <= 0 || nh <= 0) return out;
  out.resize(static_cast<size_t>(nw) * static_cast<size_t>(nh) * 4);
  if (nw == w && nh == h) { std::copy(src, src + out.size(), out.begin()); return out; }
  const float sx = static_cast<float>(w) / static_cast<float>(nw);
  const float sy = static_cast<float>(h) / static_cast<float>(nh);
  const size_t srcRow = static_cast<size_t>(w) * 4;
  uint8_t* dst = out.data();
  for (int y = 0; y < nh; y++) {
    // Pixel-centre mapping, clamped at the edges (no wrap, no out-of-range taps).
    float fy = (static_cast<float>(y) + 0.5f) * sy - 0.5f;
    if (fy < 0) fy = 0;
    int y0 = static_cast<int>(fy); if (y0 > h - 1) y0 = h - 1;
    int y1 = std::min(y0 + 1, h - 1);
    const float ty = fy - static_cast<float>(y0);
    const uint8_t* row0 = src + static_cast<size_t>(y0) * srcRow;
    const uint8_t* row1 = src + static_cast<size_t>(y1) * srcRow;
    for (int x = 0; x < nw; x++) {
      float fx = (static_cast<float>(x) + 0.5f) * sx - 0.5f;
      if (fx < 0) fx = 0;
      int x0 = static_cast<int>(fx); if (x0 > w - 1) x0 = w - 1;
      int x1 = std::min(x0 + 1, w - 1);
      const float tx = fx - static_cast<float>(x0);
      const uint8_t* p00 = row0 + static_cast<size_t>(x0) * 4;
      const uint8_t* p10 = row0 + static_cast<size_t>(x1) * 4;
      const uint8_t* p01 = row1 + static_cast<size_t>(x0) * 4;
      const uint8_t* p11 = row1 + static_cast<size_t>(x1) * 4;
      for (int c = 0; c < 4; c++) {
        const float top = p00[c] + (p10[c] - p00[c]) * tx;
        const float bottom = p01[c] + (p11[c] - p01[c]) * tx;
        const float v = top + (bottom - top) * ty;
        *dst++ = static_cast<uint8_t>(std::min(255.0f, std::max(0.0f, v + 0.5f)));
      }
    }
  }
  return out;
}

}  // namespace img
}  // namespace host
