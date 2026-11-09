// Round-trips a PNG written by stb_image_write through host/img/decode.cpp:
// top-down RGBA8 byte for byte, JPEG within tolerance, errors on junk, and
// the bilinear resize. No V8, no device.
#include "img/decode.h"
#include <stb_image_write.h>  // the implementation is compiled in img/decode.cpp
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <vector>

static void append(void* ctx, void* data, int size) {
  auto* v = static_cast<std::vector<uint8_t>*>(ctx);
  v->insert(v->end(), static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + size);
}

int main() {
  using host::img::decode; using host::img::encodePng; using host::img::resize;

  // A 5x3 picture where every pixel is distinct and the alpha varies.
  const int W = 5, H = 3;
  std::vector<uint8_t> px(W * H * 4);
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
    uint8_t* p = &px[(y * W + x) * 4];
    p[0] = (uint8_t)(x * 40); p[1] = (uint8_t)(y * 90); p[2] = (uint8_t)(255 - x * 40); p[3] = (x + y) % 2 ? 255 : 128;
  }

  // stb_image_write → decode: byte-exact, rows top-down (pixel (0,0) is the first four bytes).
  std::vector<uint8_t> png; stbi_write_png_to_func(append, &png, W, H, 4, px.data(), W * 4);
  assert(png.size() > 8 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G');
  host::img::Image a = decode(png.data(), png.size());
  assert(a.ok()); assert(a.error.empty()); assert(a.width == W && a.height == H);
  assert(a.rgba.size() == px.size()); assert(a.rgba == px);
  assert(a.rgba[0] == 0 && a.rgba[1] == 0 && a.rgba[2] == 255 && a.rgba[3] == 128);        // top-left
  assert(a.rgba[(2 * W + 4) * 4 + 0] == 160 && a.rgba[(2 * W + 4) * 4 + 1] == 180);          // bottom-right

  // Our own encoder → decode: the same bytes again.
  std::vector<uint8_t> png2 = encodePng(W, H, px.data());
  assert(!png2.empty());
  host::img::Image b = decode(png2.data(), png2.size());
  assert(b.ok() && b.width == W && b.height == H && b.rgba == px);
  assert(encodePng(0, H, px.data()).empty()); assert(encodePng(W, H, nullptr).empty());

  // JPEG: a flat colour survives within the codec's tolerance; alpha comes back opaque.
  std::vector<uint8_t> flat(8 * 8 * 4);
  for (size_t i = 0; i < flat.size(); i += 4) { flat[i] = 200; flat[i + 1] = 30; flat[i + 2] = 60; flat[i + 3] = 255; }
  std::vector<uint8_t> jpg; stbi_write_jpg_to_func(append, &jpg, 8, 8, 4, flat.data(), 95);
  assert(jpg.size() > 3 && jpg[0] == 0xFF && jpg[1] == 0xD8);
  host::img::Image c = decode(jpg.data(), jpg.size());
  assert(c.ok() && c.width == 8 && c.height == 8);
  for (size_t i = 0; i < c.rgba.size(); i += 4) {
    assert(std::abs(int(c.rgba[i]) - 200) < 10); assert(std::abs(int(c.rgba[i + 1]) - 30) < 10);
    assert(std::abs(int(c.rgba[i + 2]) - 60) < 10); assert(c.rgba[i + 3] == 255);
  }

  // Errors: junk, a truncated PNG, nothing, a format we do not carry (GIF header).
  const uint8_t junk[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
  host::img::Image bad = decode(junk, sizeof junk); assert(!bad.ok() && !bad.error.empty());
  host::img::Image cut = decode(png.data(), png.size() / 2); assert(!cut.ok() && !cut.error.empty());
  host::img::Image none = decode(nullptr, 0); assert(!none.ok());
  const uint8_t gif[8] = {'G', 'I', 'F', '8', '9', 'a', 1, 0};
  host::img::Image g = decode(gif, sizeof gif); assert(!g.ok() && g.error.find("unsupported") != std::string::npos);

  // Resize: a 2x2 red/blue checker to 4x4 keeps its corners and blends in the middle.
  const uint8_t checker[16] = {255, 0, 0, 255,  0, 0, 255, 255,  0, 0, 255, 255,  255, 0, 0, 255};
  std::vector<uint8_t> big = resize(checker, 2, 2, 4, 4);
  assert(big.size() == 64);
  assert(big[0] == 255 && big[2] == 0 && big[3] == 255);                 // (0,0) red
  assert(big[3 * 4 + 0] == 0 && big[3 * 4 + 2] == 255);                  // (3,0) blue
  assert(big[(3 * 4 + 3) * 4 + 0] == 255 && big[(3 * 4 + 3) * 4 + 2] == 0); // (3,3) red
  const uint8_t* mid = &big[(2 * 4 + 2) * 4];
  assert(mid[0] > 0 && mid[0] < 255 && mid[2] > 0 && mid[2] < 255 && mid[3] == 255);
  std::vector<uint8_t> same = resize(checker, 2, 2, 2, 2);
  assert(same.size() == 16 && std::equal(same.begin(), same.end(), checker));
  std::vector<uint8_t> small = resize(big.data(), 4, 4, 1, 1);
  assert(small.size() == 4 && small[3] == 255);
  assert(resize(nullptr, 2, 2, 4, 4).empty()); assert(resize(checker, 2, 2, 0, 4).empty());

  puts("image_test ok");
  return 0;
}
