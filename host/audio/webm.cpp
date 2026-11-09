#include "audio/webm.h"
#include <cstring>

namespace host {
namespace audio {

namespace {

// Element IDs (with their length markers, as the Matroska spec writes them).
constexpr uint32_t ID_EBML = 0x1A45DFA3, ID_DOCTYPE = 0x4282, ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1F43B675,
                   ID_TRACKS = 0x1654AE6B, ID_TRACKENTRY = 0xAE, ID_TRACKNUMBER = 0xD7, ID_TRACKTYPE = 0x83,
                   ID_CODECID = 0x86, ID_CODECPRIVATE = 0x63A2, ID_CODECDELAY = 0x56AA, ID_AUDIO = 0xE1,
                   ID_SAMPLINGFREQ = 0xB5, ID_CHANNELS = 0x9F, ID_CONTENTENCODINGS = 0x6D80, ID_SIMPLEBLOCK = 0xA3,
                   ID_BLOCKGROUP = 0xA0, ID_BLOCK = 0xA1, ID_DISCARDPADDING = 0x75A2;
constexpr uint64_t UNKNOWN = ~0ull;  // an element size of all ones: "until the parent ends"
constexpr uint64_t TRACK_AUDIO = 2;

struct Reader {
  const uint8_t* b; size_t end;
  // An element ID: 1-4 bytes, the length marker kept.
  bool id(size_t& p, uint32_t* out) const {
    if (p >= end) return false;
    uint8_t f = b[p]; int n = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : f & 0x10 ? 4 : 0;
    if (!n || n > (int)(end - p)) return false;
    uint32_t v = 0; for (int i = 0; i < n; i++) v = v << 8 | b[p + i];
    p += n; *out = v; return true;
  }
  // A variable-length integer (sizes, track numbers, lace sizes): 1-8 bytes, the marker stripped. A size of all
  // ones reads as UNKNOWN unless `raw`.
  bool vint(size_t& p, uint64_t* out, bool raw = false, int* lenOut = nullptr) const {
    if (p >= end) return false;
    uint8_t f = b[p]; int n = 1; while (n <= 8 && !(f & (0x80 >> (n - 1)))) n++;
    if (n > 8 || n > (int)(end - p)) return false;
    uint64_t v = f & (0xFF >> n); bool ones = v == (0xFFu >> n);
    for (int i = 1; i < n; i++) { v = v << 8 | b[p + i]; ones = ones && b[p + i] == 0xFF; }
    p += n; *out = ones && !raw ? UNKNOWN : v; if (lenOut) *lenOut = n; return true;
  }
  bool header(size_t& p, uint32_t* id_, uint64_t* size) const { return id(p, id_) && vint(p, size); }
  uint64_t uint(size_t p, uint64_t n) const { uint64_t v = 0; for (uint64_t i = 0; i < n && i < 8; i++) v = v << 8 | b[p + i]; return v; }
  int64_t sint(size_t p, uint64_t n) const {
    if (n == 0 || n > 8) return 0;
    uint64_t v = uint(p, n); if (n < 8 && (v >> (8 * n - 1) & 1)) v |= ~0ull << (8 * n);
    return (int64_t)v;
  }
  double flt(size_t p, uint64_t n) const {
    if (n == 4) { uint32_t u = (uint32_t)uint(p, 4); float f; memcpy(&f, &u, 4); return f; }
    if (n == 8) { uint64_t u = uint(p, 8); double d; memcpy(&d, &u, 8); return d; }
    return 0;
  }
};

struct Track {
  uint64_t number = 0, type = 0, delay = 0, channels = 1;  // the spec's defaults: 1 channel at 8 kHz
  double rate = 8000; std::string codec; const uint8_t* priv = nullptr; size_t privLen = 0; bool encoded = false;
};

// Iterates the children of [p, end): calls f(id, dataPos, size) for each; false at a malformed or unknown-size child.
template <class F> bool children(const Reader& r, size_t p, size_t end, F&& f) {
  while (p < end) {
    uint32_t id; uint64_t size;
    if (!r.header(p, &id, &size) || size == UNKNOWN || size > end - p) return false;
    f(id, p, size); p += size;
  }
  return true;
}

bool trackEntry(const Reader& r, size_t p, size_t end, Track* t) {
  return children(r, p, end, [&](uint32_t id, size_t d, uint64_t n) {
    switch (id) {
      case ID_TRACKNUMBER: t->number = r.uint(d, n); break;
      case ID_TRACKTYPE: t->type = r.uint(d, n); break;
      case ID_CODECID: t->codec.assign((const char*)r.b + d, n); t->codec.resize(strnlen(t->codec.c_str(), n)); break;
      case ID_CODECPRIVATE: t->priv = r.b + d; t->privLen = n; break;
      case ID_CODECDELAY: t->delay = r.uint(d, n); break;
      case ID_CONTENTENCODINGS: t->encoded = true; break;
      case ID_AUDIO:
        children(r, d, d + n, [&](uint32_t aid, size_t ad, uint64_t an) {
          if (aid == ID_SAMPLINGFREQ) t->rate = r.flt(ad, an);
          else if (aid == ID_CHANNELS) t->channels = r.uint(ad, an);
        });
        break;
    }
  });
}

// One Block / SimpleBlock body: its frames (laced or not) for `track`, appended to `out`; the block's
// DiscardPadding belongs to its last frame. False if malformed.
bool block(const uint8_t* d, size_t n, uint64_t track, int64_t discardNs, std::vector<WebmAudio::Packet>& out) {
  Reader r{d, n}; size_t p = 0; uint64_t tn;
  if (!r.vint(p, &tn, true) || n - p < 3) return false;
  if (tn != track) return true;
  uint8_t flags = d[p + 2]; p += 3;
  int lacing = flags >> 1 & 3;  // 0 none, 1 Xiph, 2 fixed-size, 3 EBML
  if (lacing == 0) { out.push_back({d + p, (uint32_t)(n - p), discardNs}); return true; }
  if (p >= n) return false;
  int count = d[p++] + 1;
  uint64_t sz[256]; uint64_t sum = 0;
  if (lacing == 1) {
    for (int i = 0; i < count - 1; i++) {
      uint64_t s = 0; uint8_t v;
      do { if (p >= n) return false; v = d[p++]; s += v; } while (v == 255);
      sz[i] = s; sum += s;
    }
  } else if (lacing == 3) {
    uint64_t first; if (!r.vint(p, &first, true)) return false;
    sz[0] = first; sum = first;
    for (int i = 1; i < count - 1; i++) {
      uint64_t raw; int len; if (!r.vint(p, &raw, true, &len)) return false;
      int64_t s = (int64_t)sz[i - 1] + ((int64_t)raw - ((int64_t)1 << (7 * len - 1)) + 1);
      if (s < 0) return false;
      sz[i] = (uint64_t)s; sum += sz[i];
    }
  } else {
    if ((n - p) % count) return false;
    for (int i = 0; i < count - 1; i++) { sz[i] = (n - p) / count; sum += sz[i]; }
  }
  if (count > 1 && sum > n - p) return false;
  sz[count - 1] = n - p - (count > 1 ? sum : 0);
  for (int i = 0; i < count; i++) { out.push_back({d + p, (uint32_t)sz[i], i == count - 1 ? discardNs : 0}); p += sz[i]; }
  return true;
}

}  // namespace

bool demuxWebm(const uint8_t* b, size_t len, WebmAudio* out, std::string* err) {
  Reader r{b, len}; size_t p = 0; uint32_t id; uint64_t size;
  if (!r.header(p, &id, &size) || id != ID_EBML || size == UNKNOWN || size > len - p) { *err = "not an EBML file"; return false; }
  std::string doc = "matroska";  // the default DocType
  children(r, p, p + size, [&](uint32_t cid, size_t d, uint64_t n) { if (cid == ID_DOCTYPE) doc.assign((const char*)b + d, strnlen((const char*)b + d, n)); });
  if (doc != "webm" && doc != "matroska") { *err = "EBML DocType \"" + doc + "\" is not WebM/Matroska"; return false; }
  p += size;

  // A flat walk: the Segment and its Clusters are entered (their children follow them, and either may be of unknown
  // size), every other element is read whole or skipped by its size.
  Track track; bool haveTrack = false; bool bad = false;
  while (p < len) {
    if (!r.header(p, &id, &size)) break;
    if (id == ID_SEGMENT || id == ID_CLUSTER) continue;
    if (size == UNKNOWN || size > len - p) break;  // the file ends inside this element: keep what came before
    if (id == ID_TRACKS && !haveTrack) {
      children(r, p, p + size, [&](uint32_t cid, size_t d, uint64_t n) {
        Track t;
        if (haveTrack || cid != ID_TRACKENTRY || !trackEntry(r, d, d + n, &t) || t.type != TRACK_AUDIO) return;
        track = t; haveTrack = true;
      });
    } else if (haveTrack && id == ID_SIMPLEBLOCK) {
      bad |= !block(b + p, size, track.number, 0, out->packets);
    } else if (haveTrack && id == ID_BLOCKGROUP) {
      const uint8_t* blk = nullptr; uint64_t blkLen = 0; int64_t discard = 0;
      children(r, p, p + size, [&](uint32_t cid, size_t d, uint64_t n) {
        if (cid == ID_BLOCK) { blk = b + d; blkLen = n; }
        else if (cid == ID_DISCARDPADDING) discard = r.sint(d, n);
      });
      if (blk) bad |= !block(blk, blkLen, track.number, discard > 0 ? discard : 0, out->packets);
    }
    p += size;
  }
  if (!haveTrack) { *err = "WebM file without an audio track"; return false; }
  if (track.encoded) { *err = "WebM audio track is compressed or encrypted (ContentEncodings)"; return false; }
  if (out->packets.empty()) { *err = bad ? "WebM audio blocks are malformed" : "WebM audio track has no data"; return false; }
  out->codec = track.codec; out->priv = track.priv; out->privLen = track.privLen;
  out->rate = track.rate; out->channels = (int)track.channels; out->codecDelayNs = track.delay;
  return true;
}

}  // namespace audio
}  // namespace host
