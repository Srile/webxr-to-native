#pragma once
// Canvas 2D text: TrueType / OpenType faces through stb_truetype, no V8. The page's own fonts arrive as bytes
// (FontFace); generic families fall back to one sans-serif face of the platform. Text is UTF-16 as JS holds it.
// Glyphs are placed one after another with the face's kerning; no shaping (ligatures, complex scripts). A code
// point the face lacks is taken from the fallback face. JS thread only.
#include <cstddef>
#include <cstdint>
#include <string>

namespace host {
namespace img {

// A face from font file bytes (copied). The id, or -1 with err set.
int fontLoad(const uint8_t* bytes, size_t len, std::string& err);
// The platform's sans-serif face, loaded on first use; -1 when none of the known files exists.
int fontSystem();

struct TextMetrics {
  float width = 0;                     // advance, CSS px
  float left = 0, right = 0;           // ink extent from the pen start (left positive leftwards)
  float ascent = 0, descent = 0;       // ink extent from the baseline (descent positive downwards)
  float fontAscent = 0, fontDescent = 0;
};
// Metrics of s[0, n) at an em of px CSS pixels, spacing CSS px added after every character (letter-spacing).
bool textMeasure(int font, int fallback, float px, float spacing, const uint16_t* s, size_t n, TextMetrics& m);

// Coverage of s[0, n) with the pen starting at device point (ox, oy) on the baseline, at an em of px scaled by
// (scaleX, scaleY). Writes w, h and the device pixel (x0, y0) of the box's top left; fills alpha (w * h, rows
// top-down) only when cap holds it. False when nothing is inked or alpha is too small (then w * h is the size).
bool textRaster(int font, int fallback, float px, float spacing, float scaleX, float scaleY, float ox, float oy,
                const uint16_t* s, size_t n, uint8_t* alpha, size_t cap, int& w, int& h, int& x0, int& y0);

}  // namespace img
}  // namespace host
