#pragma once
// Image codecs shared by the __native.img binding and the host tests: pure
// C++ over stb_image / stb_image_write, no V8. Pixels are RGBA8 with the rows
// TOP-DOWN (the first row is the top of the picture) and straight alpha.
// Nothing here flips rows: WebGL's UNPACK_FLIP_Y_WEBGL and createImageBitmap's
// imageOrientation decide that, in the JS wrapper, as in the browser.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace host {
namespace img {

struct Image {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgba;  // width * height * 4
  std::string error;          // non-empty on failure
  bool ok() const { return error.empty() && width > 0 && height > 0; }
};

// PNG, JPEG, WebP or SVG bytes → RGBA8. Any other container fails with an
// error (KTX2 goes through its own transcoder). Thread-safe: run it on any thread.
// SVG only in a build with HOST_HAS_SVG (nanosvg; CMake HOST_SVG, host.json web.svg).
Image decode(const uint8_t* bytes, size_t len);

// True when the bytes look like an SVG document (a BOM, whitespace, then markup with <svg near the start).
bool isSvg(const uint8_t* bytes, size_t len);

// RGBA8 → PNG file bytes. Empty on bad arguments.
std::vector<uint8_t> encodePng(int width, int height, const uint8_t* rgba);

// Bilinear resample of a straight-alpha RGBA8 image. Empty on bad arguments.
std::vector<uint8_t> resize(const uint8_t* rgba, int width, int height, int newWidth, int newHeight);

}  // namespace img
}  // namespace host
