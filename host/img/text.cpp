// The ONE translation unit that compiles stb_truetype.
#include "img/text.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>

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

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include <stb_truetype.h>

#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace host {
namespace img {

namespace {

struct Face {
  std::vector<uint8_t> bytes;
  stbtt_fontinfo info{};
  int ascent = 0, descent = 0;  // hhea, font units (descent negative)
};

std::vector<std::unique_ptr<Face>> g_faces;
int g_system = -2;  // -2: not looked for yet

const Face* face(int id) { return id >= 0 && id < (int)g_faces.size() ? g_faces[id].get() : nullptr; }

// One glyph of a run: its face (the primary or the fallback) and index there.
struct Glyph { const Face* f; int index; };
std::vector<Glyph> g_run;         // reused: text is drawn on UI repaints, which can be every frame
std::vector<uint8_t> g_glyphPx;   // one glyph's coverage

uint32_t nextCodepoint(const uint16_t* s, size_t n, size_t& i) {
  uint32_t c = s[i++];
  if (c >= 0xD800 && c < 0xDC00 && i < n && s[i] >= 0xDC00 && s[i] < 0xE000) c = 0x10000 + ((c - 0xD800) << 10) + (s[i++] - 0xDC00);
  return c;
}

// Maps s to glyphs of primary, or of fallback for a code point primary lacks. False when neither face exists.
bool shape(int font, int fallback, const uint16_t* s, size_t n) {
  const Face* p = face(font); const Face* fb = face(fallback);
  if (!p) { p = fb; fb = nullptr; }
  if (!p) return false;
  g_run.clear();
  for (size_t i = 0; i < n;) {
    uint32_t c = nextCodepoint(s, n, i);
    int gi = stbtt_FindGlyphIndex(&p->info, (int)c);
    if (gi == 0 && fb) { int fi = stbtt_FindGlyphIndex(&fb->info, (int)c); if (fi != 0) { g_run.push_back({fb, fi}); continue; } }
    g_run.push_back({p, gi});
  }
  return true;
}

float emScale(const Face* f, float px) { return stbtt_ScaleForMappingEmToPixels(&f->info, px); }

// The pen advance after glyph k, kerning against k + 1 when both come from the same face, in em-scaled units.
float advance(size_t k, float px) {
  const Glyph& g = g_run[k];
  int adv = 0, lsb = 0; stbtt_GetGlyphHMetrics(&g.f->info, g.index, &adv, &lsb);
  int kern = k + 1 < g_run.size() && g_run[k + 1].f == g.f ? stbtt_GetGlyphKernAdvance(&g.f->info, g.index, g_run[k + 1].index) : 0;
  return (float)(adv + kern) * emScale(g.f, px);
}

bool readFile(const char* path, std::vector<uint8_t>& out) {
  FILE* fp = fopen(path, "rb"); if (!fp) return false;
  fseek(fp, 0, SEEK_END); long len = ftell(fp); fseek(fp, 0, SEEK_SET);
  if (len <= 0) { fclose(fp); return false; }
  out.resize((size_t)len);
  bool ok = fread(out.data(), 1, out.size(), fp) == out.size();
  fclose(fp);
  return ok;
}

}  // namespace

int fontLoad(const uint8_t* bytes, size_t len, std::string& err) {
  if (!bytes || len < 12) { err = "not a font file"; return -1; }
  auto f = std::make_unique<Face>();
  f->bytes.assign(bytes, bytes + len);
  const int offset = stbtt_GetFontOffsetForIndex(f->bytes.data(), 0);  // a collection's first face
  if (offset < 0 || !stbtt_InitFont(&f->info, f->bytes.data(), offset)) { err = "unsupported font (TrueType or OpenType only; WOFF is not decoded)"; return -1; }
  int gap = 0; stbtt_GetFontVMetrics(&f->info, &f->ascent, &f->descent, &gap);
  g_faces.push_back(std::move(f));
  return (int)g_faces.size() - 1;
}

int fontSystem() {
  if (g_system != -2) return g_system;
  g_system = -1;
  static const char* const kPaths[] = {
    "/system/fonts/Roboto-Regular.ttf", "/system/fonts/NotoSans-Regular.ttf", "/system/fonts/DroidSans.ttf",  // Android
    "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",  // macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",  // Linux
    "C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\segoeui.ttf",  // Windows
  };
  std::vector<uint8_t> bytes; std::string err;
  for (const char* p : kPaths) {
    if (!readFile(p, bytes)) continue;
    int id = fontLoad(bytes.data(), bytes.size(), err);
    if (id >= 0) { g_system = id; break; }
  }
  return g_system;
}

bool textMeasure(int font, int fallback, float px, float spacing, const uint16_t* s, size_t n, TextMetrics& m) {
  m = TextMetrics{};
  if (!shape(font, fallback, s, n)) return false;
  const Face* p = g_run.empty() ? (face(font) ? face(font) : face(fallback)) : g_run[0].f;
  const float ps = emScale(p, px);
  m.fontAscent = (float)p->ascent * ps; m.fontDescent = (float)-p->descent * ps;
  float pen = 0, minX = 0, maxX = 0, minY = 0, maxY = 0; bool inked = false;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k]; const float sc = emScale(g.f, px);
    int bx0, by0, bx1, by1;
    if (stbtt_GetGlyphBox(&g.f->info, g.index, &bx0, &by0, &bx1, &by1) && bx1 > bx0 && by1 > by0) {
      const float x0 = pen + bx0 * sc, x1 = pen + bx1 * sc, y0 = by0 * sc, y1 = by1 * sc;  // y up
      if (!inked) { minX = x0; maxX = x1; minY = y0; maxY = y1; inked = true; }
      else { minX = std::min(minX, x0); maxX = std::max(maxX, x1); minY = std::min(minY, y0); maxY = std::max(maxY, y1); }
    }
    pen += advance(k, px) + spacing;
  }
  m.width = pen;
  if (inked) { m.left = -minX; m.right = maxX; m.ascent = maxY; m.descent = -minY; }
  return true;
}

bool textRaster(int font, int fallback, float px, float spacing, float scaleX, float scaleY, float ox, float oy,
                const uint16_t* s, size_t n, uint8_t* alpha, size_t cap, int& w, int& h, int& x0, int& y0) {
  w = h = x0 = y0 = 0;
  if (!shape(font, fallback, s, n) || g_run.empty() || !(px > 0) || !(scaleX > 0) || !(scaleY > 0)) return false;
  const float baseY = std::floor(oy), shiftY = oy - baseY;
  // Pass 1: the union of the glyph boxes, device pixels.
  int minX = 0, minY = 0, maxX = 0, maxY = 0; bool inked = false;
  float pen = ox;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k]; const float sc = emScale(g.f, px);
    const float ix = std::floor(pen);
    int bx0, by0, bx1, by1;
    stbtt_GetGlyphBitmapBoxSubpixel(&g.f->info, g.index, sc * scaleX, sc * scaleY, pen - ix, shiftY, &bx0, &by0, &bx1, &by1);
    if (bx1 > bx0 && by1 > by0) {
      const int gx0 = (int)ix + bx0, gx1 = (int)ix + bx1, gy0 = (int)baseY + by0, gy1 = (int)baseY + by1;
      if (!inked) { minX = gx0; maxX = gx1; minY = gy0; maxY = gy1; inked = true; }
      else { minX = std::min(minX, gx0); maxX = std::max(maxX, gx1); minY = std::min(minY, gy0); maxY = std::max(maxY, gy1); }
    }
    pen += (advance(k, px) + spacing) * scaleX;
  }
  if (!inked) return false;
  w = maxX - minX; h = maxY - minY; x0 = minX; y0 = minY;
  const size_t need = (size_t)w * (size_t)h;
  if (!alpha || cap < need) return false;
  memset(alpha, 0, need);
  // Pass 2: each glyph rendered alone, then merged by max so overlapping neighbours do not erase each other.
  pen = ox;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k]; const float sc = emScale(g.f, px);
    const float ix = std::floor(pen), fx = pen - ix;
    int bx0, by0, bx1, by1;
    stbtt_GetGlyphBitmapBoxSubpixel(&g.f->info, g.index, sc * scaleX, sc * scaleY, fx, shiftY, &bx0, &by0, &bx1, &by1);
    const int gw = bx1 - bx0, gh = by1 - by0;
    if (gw > 0 && gh > 0) {
      if (g_glyphPx.size() < (size_t)gw * gh) g_glyphPx.resize((size_t)gw * gh);
      stbtt_MakeGlyphBitmapSubpixel(&g.f->info, g_glyphPx.data(), gw, gh, gw, sc * scaleX, sc * scaleY, fx, shiftY, g.index);
      const int dx = (int)ix + bx0 - x0, dy = (int)baseY + by0 - y0;
      for (int r = 0; r < gh; r++) {
        uint8_t* dst = alpha + (size_t)(dy + r) * w + dx; const uint8_t* src = g_glyphPx.data() + (size_t)r * gw;
        for (int c = 0; c < gw; c++) if (src[c] > dst[c]) dst[c] = src[c];
      }
    }
    pen += (advance(k, px) + spacing) * scaleX;
  }
  return true;
}

}  // namespace img
}  // namespace host
