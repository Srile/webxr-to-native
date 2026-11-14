// The ONE translation unit that compiles stb_truetype.
#include "img/text.h"
#include "img/decode.h"

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

int addFace(std::vector<uint8_t>&& bytes, int offset, std::string& err);
bool readFile(const char* path, std::vector<uint8_t>& out);

// What neither the page's font nor the sans-serif face draws, from the platform's other faces in turn: symbols
// (✓ ⌫ ✦ ♡; ♥), then CJK (the Simplified Chinese member of a collection). Each is read the first time a code point
// misses every face before it (Android's CJK collection is 20 MB).
struct Tier { const char* paths[4]; const char* face; };
const Tier kTiers[] = {
  {{"/system/fonts/NotoSansSymbols-Regular-Subsetted.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Apple Symbols.ttf", "C:\\Windows\\Fonts\\seguisym.ttf"}, nullptr},
  {{"/system/fonts/NotoSansSymbols-Regular-Subsetted2.ttf", nullptr, nullptr, nullptr}, nullptr},
  {{"/system/fonts/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/System/Library/Fonts/PingFang.ttc", "C:\\Windows\\Fonts\\msyh.ttc"}, "Noto Sans CJK SC"},
};
constexpr int kTierCount = (int)(sizeof(kTiers) / sizeof(kTiers[0]));
int g_tier[kTierCount] = {-2, -2, -2};

const Face* face(int id) { return id >= 0 && id < (int)g_faces.size() ? g_faces[id].get() : nullptr; }

const Face* tierFace(int t) {
  if (g_tier[t] == -2) {
    g_tier[t] = -1;
    for (const char* path : kTiers[t].paths) {
      std::vector<uint8_t> bytes; std::string err;
      if (!path || !readFile(path, bytes)) continue;
      int offset = kTiers[t].face ? stbtt_FindMatchingFont(bytes.data(), kTiers[t].face, STBTT_MACSTYLE_DONTCARE) : -1;
      if (offset < 0) offset = stbtt_GetFontOffsetForIndex(bytes.data(), 0);
      if ((g_tier[t] = addFace(std::move(bytes), offset, err)) >= 0) break;
    }
  }
  return face(g_tier[t]);
}

// One glyph of a run: its face (the primary, the fallback or a tier) and index there; a colour glyph is the emoji
// font's (f null).
struct Glyph { const Face* f; int index; bool color = false; };

// Colour emoji: CBDT/CBLC (Android's NotoColorEmoji), a PNG per glyph at one strike. stb_truetype reads outlines
// only, so this font is read here: its cmap for the glyph, hmtx for the advance, CBLC/CBDT for the picture, which is
// decoded once (a few dozen kept) and scaled to the text size.
struct ColorFont {
  std::vector<uint8_t> bytes;
  uint32_t cmap12 = 0, cmap4 = 0, hmtx = 0, cblc = 0, cbdt = 0, strike = 0;
  uint16_t numHMetrics = 0, upem = 0; int ppem = 0;
  std::vector<std::pair<int, Image>> cache;  // decoded glyphs, the most recent last
};
struct ColorGlyph { int w = 0, h = 0, bx = 0, by = 0; const uint8_t* png = nullptr; size_t len = 0; };  // strike pixels; by up
std::unique_ptr<ColorFont> g_color;
bool g_colorTried = false;

uint16_t be16(const std::vector<uint8_t>& b, size_t o) { return o + 2 <= b.size() ? (uint16_t)(b[o] << 8 | b[o + 1]) : 0; }
uint32_t be32(const std::vector<uint8_t>& b, size_t o) { return o + 4 <= b.size() ? (uint32_t)b[o] << 24 | (uint32_t)b[o + 1] << 16 | (uint32_t)b[o + 2] << 8 | b[o + 3] : 0; }

ColorFont* colorFont() {
  if (g_colorTried) return g_color.get();
  g_colorTried = true;
  static const char* const kPaths[] = {"/system/fonts/NotoColorEmoji.ttf", "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/noto/NotoColorEmoji.ttf"};
  for (const char* path : kPaths) {
    auto f = std::make_unique<ColorFont>();
    if (!readFile(path, f->bytes) || f->bytes.size() < 12) continue;
    const auto& b = f->bytes;
    uint32_t cmap = 0, hhea = 0, head = 0;
    for (uint16_t i = 0, n = be16(b, 4); i < n && 12 + 16 * (size_t)i + 16 <= b.size(); ++i) {
      const size_t r = 12 + 16 * (size_t)i; const uint32_t off = be32(b, r + 8);
      if (!memcmp(&b[r], "cmap", 4)) cmap = off; else if (!memcmp(&b[r], "hmtx", 4)) f->hmtx = off; else if (!memcmp(&b[r], "hhea", 4)) hhea = off;
      else if (!memcmp(&b[r], "head", 4)) head = off; else if (!memcmp(&b[r], "CBLC", 4)) f->cblc = off; else if (!memcmp(&b[r], "CBDT", 4)) f->cbdt = off;
    }
    if (!cmap || !f->hmtx || !hhea || !head || !f->cblc || !f->cbdt) continue;
    f->upem = be16(b, head + 18); f->numHMetrics = be16(b, hhea + 34);
    for (uint16_t i = 0, k = be16(b, cmap + 2); i < k; ++i) {
      const uint16_t pid = be16(b, cmap + 4 + 8 * (size_t)i), eid = be16(b, cmap + 6 + 8 * (size_t)i);
      const uint32_t sub = cmap + be32(b, cmap + 8 + 8 * (size_t)i), fmt = be16(b, sub);
      const bool unicode = pid == 0 || (pid == 3 && (eid == 1 || eid == 10));
      if (fmt == 12 && unicode) f->cmap12 = sub; else if (fmt == 4 && unicode && !f->cmap4) f->cmap4 = sub;
    }
    for (uint32_t k = 0, n = be32(b, f->cblc + 4); k < n; ++k) {  // the largest strike
      const uint32_t rec = f->cblc + 8 + 48 * k;
      if (rec + 48 <= b.size() && b[rec + 44] > f->ppem) { f->ppem = b[rec + 44]; f->strike = rec; }
    }
    if (!f->upem || !f->ppem || !f->numHMetrics || (!f->cmap12 && !f->cmap4)) continue;
    g_color = std::move(f);
    break;
  }
  return g_color.get();
}

int colorIndex(const ColorFont& f, uint32_t c) {
  const auto& b = f.bytes;
  if (f.cmap12) {
    uint32_t lo = 0, hi = be32(b, f.cmap12 + 12);
    while (lo < hi) {
      const uint32_t mid = (lo + hi) / 2; const size_t g = f.cmap12 + 16 + 12 * (size_t)mid;
      const uint32_t first = be32(b, g), last = be32(b, g + 4);
      if (c < first) hi = mid; else if (c > last) lo = mid + 1; else return (int)(be32(b, g + 8) + (c - first));
    }
    return 0;
  }
  if (c > 0xFFFF) return 0;
  const size_t segX2 = be16(b, f.cmap4 + 6), ends = f.cmap4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  for (size_t i = 0; i < segX2 / 2; ++i) {
    if (c > be16(b, ends + 2 * i)) continue;
    const uint16_t first = be16(b, starts + 2 * i), delta = be16(b, deltas + 2 * i), ro = be16(b, ranges + 2 * i);
    if (c < first) return 0;
    if (!ro) return (uint16_t)(c + delta);
    const uint16_t gi = be16(b, ranges + 2 * i + ro + 2 * (c - first));
    return gi ? (uint16_t)(gi + delta) : 0;
  }
  return 0;
}

// Where the glyph's picture is: index formats 1 and 3, image formats 17 and 18 (PNG). False for a glyph with none.
bool colorLocate(const ColorFont& f, int gi, ColorGlyph& out) {
  const auto& b = f.bytes;
  const uint32_t arr = f.cblc + be32(b, f.strike), nsub = be32(b, f.strike + 8);
  for (uint32_t k = 0; k < nsub; ++k) {
    const size_t e = arr + 8 * (size_t)k; const int first = be16(b, e), last = be16(b, e + 2);
    if (gi < first || gi > last) continue;
    const size_t h = arr + be32(b, e + 4); const uint16_t ifmt = be16(b, h), imfmt = be16(b, h + 2); const uint32_t data = be32(b, h + 4);
    uint32_t a = 0, z = 0; const size_t i = (size_t)(gi - first);
    if (ifmt == 1) { a = be32(b, h + 8 + 4 * i); z = be32(b, h + 12 + 4 * i); }
    else if (ifmt == 3) { a = be16(b, h + 8 + 2 * i); z = be16(b, h + 10 + 2 * i); }
    else return false;
    if (z <= a) return false;
    const size_t p = (size_t)f.cbdt + data + a; size_t png = 0;
    if (imfmt == 17 && p + 9 <= b.size()) { out.len = be32(b, p + 5); png = p + 9; }
    else if (imfmt == 18 && p + 12 <= b.size()) { out.len = be32(b, p + 8); png = p + 12; }
    else return false;
    if (png + out.len > b.size()) return false;
    out.h = b[p]; out.w = b[p + 1]; out.bx = (int8_t)b[p + 2]; out.by = (int8_t)b[p + 3]; out.png = &b[png];
    return out.w > 0 && out.h > 0;
  }
  return false;
}

const Image* colorImage(ColorFont& f, int gi) {
  for (size_t i = 0; i < f.cache.size(); ++i) if (f.cache[i].first == gi) {
    if (i + 1 != f.cache.size()) { auto keep = std::move(f.cache[i]); f.cache.erase(f.cache.begin() + (long)i); f.cache.push_back(std::move(keep)); }
    return &f.cache.back().second;
  }
  ColorGlyph g; if (!colorLocate(f, gi, g)) return nullptr;
  Image im = decode(g.png, g.len);
  if (!im.ok()) return nullptr;
  if (f.cache.size() >= 48) f.cache.erase(f.cache.begin());
  f.cache.emplace_back(gi, std::move(im));
  return &f.cache.back().second;
}

// The picture scaled into dst (RGBA, straight alpha, stride dw pixels) over the device rectangle that starts at
// (left, top) and is fw x fh pixels: each destination pixel averages the source pixels it covers.
void colorBlit(const Image& im, uint8_t* dst, int dw, int dh, int ox, int oy, float left, float top, float fw, float fh) {
  const int x0 = std::max(0, (int)std::floor(left) - ox), x1 = std::min(dw, (int)std::ceil(left + fw) - ox);
  const int y0 = std::max(0, (int)std::floor(top) - oy), y1 = std::min(dh, (int)std::ceil(top + fh) - oy);
  const float kx = im.width / fw, ky = im.height / fh;
  for (int y = y0; y < y1; ++y) {
    const float v0 = std::max(0.f, (y + oy - top) * ky), v1 = std::min((float)im.height, (y + oy + 1 - top) * ky);
    if (v1 <= v0) continue;
    for (int x = x0; x < x1; ++x) {
      const float u0 = std::max(0.f, (x + ox - left) * kx), u1 = std::min((float)im.width, (x + ox + 1 - left) * kx);
      if (u1 <= u0) continue;
      float r = 0, g = 0, bl = 0, a = 0, area = 0;
      for (int sy = (int)v0; sy < (int)std::ceil(v1); ++sy) {
        const float wy = std::min(v1, (float)sy + 1) - std::max(v0, (float)sy);
        for (int sx = (int)u0; sx < (int)std::ceil(u1); ++sx) {
          const float wgt = wy * (std::min(u1, (float)sx + 1) - std::max(u0, (float)sx));
          const uint8_t* s = &im.rgba[((size_t)sy * im.width + sx) * 4];
          const float sa = s[3] * wgt;
          r += s[0] * sa; g += s[1] * sa; bl += s[2] * sa; a += sa; area += wgt;
        }
      }
      if (a <= 0 || area <= 0) continue;
      uint8_t* d = dst + ((size_t)y * dw + x) * 4;
      d[0] = (uint8_t)std::lround(r / a); d[1] = (uint8_t)std::lround(g / a); d[2] = (uint8_t)std::lround(bl / a); d[3] = (uint8_t)std::lround(a / area);
    }
  }
}

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
    if (gi == 0 && (c == 0x200D || (c >= 0xFE00 && c <= 0xFE0F))) continue;  // joiners and variation selectors: nothing to draw
    if (gi == 0 && c > 0x20) {
      const Face* x = nullptr; int xi = 0;
      for (int t = 0; t < kTierCount && !xi; ++t) if ((x = tierFace(t))) xi = stbtt_FindGlyphIndex(&x->info, (int)c);
      if (xi) { g_run.push_back({x, xi}); continue; }
      ColorGlyph cg;
      if (ColorFont* cf = colorFont()) if (int ci = colorIndex(*cf, c); ci && colorLocate(*cf, ci, cg)) { g_run.push_back({nullptr, ci, true}); continue; }
    }
    g_run.push_back({p, gi});
  }
  return true;
}

float emScale(const Face* f, float px) { return stbtt_ScaleForMappingEmToPixels(&f->info, px); }

// The pen advance after glyph k, kerning against k + 1 when both come from the same face, in em-scaled units.
float advance(size_t k, float px) {
  const Glyph& g = g_run[k];
  if (g.color) {
    const ColorFont& f = *g_color; const size_t m = (size_t)std::min<int>(g.index, f.numHMetrics - 1);
    return (float)be16(f.bytes, f.hmtx + 4 * m) * px / f.upem;
  }
  int adv = 0, lsb = 0; stbtt_GetGlyphHMetrics(&g.f->info, g.index, &adv, &lsb);
  int kern = k + 1 < g_run.size() && g_run[k + 1].f == g.f && !g_run[k + 1].color ? stbtt_GetGlyphKernAdvance(&g.f->info, g.index, g_run[k + 1].index) : 0;
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

namespace {
int addFace(std::vector<uint8_t>&& bytes, int offset, std::string& err) {
  auto f = std::make_unique<Face>();
  f->bytes = std::move(bytes);
  if (offset < 0 || !stbtt_InitFont(&f->info, f->bytes.data(), offset)) { err = "unsupported font (TrueType or OpenType only; WOFF is not decoded)"; return -1; }
  int gap = 0; stbtt_GetFontVMetrics(&f->info, &f->ascent, &f->descent, &gap);
  g_faces.push_back(std::move(f));
  return (int)g_faces.size() - 1;
}
}  // namespace

int fontLoad(const uint8_t* bytes, size_t len, std::string& err) {
  if (!bytes || len < 12) { err = "not a font file"; return -1; }
  std::vector<uint8_t> copy(bytes, bytes + len);
  const int offset = stbtt_GetFontOffsetForIndex(copy.data(), 0);  // a collection's first face
  return addFace(std::move(copy), offset, err);
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
  const Face* p = face(font) ? face(font) : face(fallback);
  for (const Glyph& g : g_run) if (!g.color) { p = g.f; break; }
  if (!p) return false;
  const float ps = emScale(p, px);
  m.fontAscent = (float)p->ascent * ps; m.fontDescent = (float)-p->descent * ps;
  float pen = 0, minX = 0, maxX = 0, minY = 0, maxY = 0; bool inked = false;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k];
    ColorGlyph cg;
    if (g.color && colorLocate(*g_color, g.index, cg)) {
      const float cs = px / g_color->ppem, x0 = pen + cg.bx * cs, x1 = x0 + cg.w * cs, y1 = cg.by * cs, y0 = y1 - cg.h * cs;
      if (!inked) { minX = x0; maxX = x1; minY = y0; maxY = y1; inked = true; }
      else { minX = std::min(minX, x0); maxX = std::max(maxX, x1); minY = std::min(minY, y0); maxY = std::max(maxY, y1); }
      pen += advance(k, px) + spacing;
      continue;
    }
    const float sc = emScale(g.f, px);
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
                const uint16_t* s, size_t n, uint8_t* alpha, size_t cap, int& w, int& h, int& x0, int& y0,
                uint8_t* rgba, size_t rgbaCap, bool& color) {
  w = h = x0 = y0 = 0; color = false;
  if (!shape(font, fallback, s, n) || g_run.empty() || !(px > 0) || !(scaleX > 0) || !(scaleY > 0)) return false;
  const float baseY = std::floor(oy), shiftY = oy - baseY;
  // Pass 1: the union of the glyph boxes, device pixels.
  int minX = 0, minY = 0, maxX = 0, maxY = 0; bool inked = false;
  float pen = ox;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k];
    ColorGlyph cg;
    if (g.color) {
      if (colorLocate(*g_color, g.index, cg)) {
        const float cx = px / g_color->ppem * scaleX, cy = px / g_color->ppem * scaleY;
        const int gx0 = (int)std::floor(pen + cg.bx * cx), gx1 = (int)std::ceil(pen + (cg.bx + cg.w) * cx);
        const int gy0 = (int)std::floor(oy - cg.by * cy), gy1 = (int)std::ceil(oy + (cg.h - cg.by) * cy);
        if (!inked) { minX = gx0; maxX = gx1; minY = gy0; maxY = gy1; inked = true; }
        else { minX = std::min(minX, gx0); maxX = std::max(maxX, gx1); minY = std::min(minY, gy0); maxY = std::max(maxY, gy1); }
        color = true;
      }
      pen += (advance(k, px) + spacing) * scaleX;
      continue;
    }
    const float sc = emScale(g.f, px);
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
  if (color && (!rgba || rgbaCap < need * 4)) return false;
  memset(alpha, 0, need);
  if (color) memset(rgba, 0, need * 4);
  // Pass 2: each glyph rendered alone, then merged by max so overlapping neighbours do not erase each other. Colour
  // glyphs go to rgba instead (straight alpha), drawn over the fill-coloured text.
  pen = ox;
  for (size_t k = 0; k < g_run.size(); k++) {
    const Glyph& g = g_run[k];
    if (g.color) {
      ColorGlyph cg; const Image* im = colorLocate(*g_color, g.index, cg) ? colorImage(*g_color, g.index) : nullptr;
      if (im) {
        const float cx = px / g_color->ppem * scaleX, cy = px / g_color->ppem * scaleY;
        colorBlit(*im, rgba, w, h, x0, y0, pen + cg.bx * cx, oy - cg.by * cy, cg.w * cx, cg.h * cy);
      }
      pen += (advance(k, px) + spacing) * scaleX;
      continue;
    }
    const float sc = emScale(g.f, px);
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
