#include "audio/decode.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include "audio/webm.h"
#ifdef HOST_HAS_OPUS
#include <opus_multistream.h>
#endif

#define STB_VORBIS_NO_STDIO
#define STB_VORBIS_NO_PUSHDATA_API
#include "stb_vorbis.c"

namespace host {
namespace audio {

namespace {

// Linear resample of planar `src` (channels × n at `from` Hz) into a fresh buffer at `to` Hz.
AudioBufferData* resample(AudioBufferData* src, double to) {
  if (to <= 0 || src->sampleRate == to || src->length == 0) return src;
  double ratio = to / src->sampleRate;
  uint32_t outLen = (uint32_t)std::max(1.0, std::floor((double)src->length * ratio + 0.5));
  AudioBufferData* out = AudioBufferData::create(src->channels, outLen, to);
  for (int c = 0; c < src->channels; c++) {
    const float* s = src->ch(c); float* d = out->ch(c);
    for (uint32_t i = 0; i < outLen; i++) {
      double p = (double)i / ratio; uint32_t i0 = (uint32_t)p; double f = p - i0;
      if (i0 >= src->length - 1) { d[i] = s[src->length - 1]; continue; }
      d[i] = (float)(s[i0] + f * (s[i0 + 1] - s[i0]));
    }
  }
  src->unref();
  return out;
}

uint32_t rd32(const uint8_t* p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | p[1] << 8); }

AudioBufferData* decodeWav(const uint8_t* b, size_t len, std::string* err) {
  if (len < 12 || memcmp(b, "RIFF", 4) || memcmp(b + 8, "WAVE", 4)) { *err = "not a RIFF/WAVE file"; return nullptr; }
  size_t p = 12; int fmt = 0, channels = 0, bits = 0; uint32_t rate = 0;
  const uint8_t* data = nullptr; size_t dataLen = 0;
  while (p + 8 <= len) {
    uint32_t sz = rd32(b + p + 4); const uint8_t* body = b + p + 8;
    size_t avail = std::min((size_t)sz, len - (p + 8));
    if (!memcmp(b + p, "fmt ", 4) && avail >= 16) {
      fmt = rd16(body); channels = rd16(body + 2); rate = rd32(body + 4); bits = rd16(body + 14);
      if (fmt == 0xFFFE && avail >= 26) fmt = rd16(body + 24);  // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
    } else if (!memcmp(b + p, "data", 4)) { data = body; dataLen = avail; }
    p += 8 + sz + (sz & 1);
  }
  if (!data || channels <= 0 || rate == 0) { *err = "WAV without fmt/data"; return nullptr; }
  int bytesPer = bits / 8; if (bytesPer <= 0) { *err = "WAV bad bit depth"; return nullptr; }
  uint32_t frames = (uint32_t)(dataLen / ((size_t)bytesPer * channels));
  AudioBufferData* out = AudioBufferData::create(channels, frames, rate);
  for (uint32_t i = 0; i < frames; i++) for (int c = 0; c < channels; c++) {
    const uint8_t* s = data + ((size_t)i * channels + c) * bytesPer; float v = 0;
    if (fmt == 3) { if (bits == 32) { float f; memcpy(&f, s, 4); v = f; } else if (bits == 64) { double d; memcpy(&d, s, 8); v = (float)d; } }
    else if (bits == 8) v = ((int)s[0] - 128) / 128.0f;
    else if (bits == 16) v = (int16_t)rd16(s) / 32768.0f;
    else if (bits == 24) { int32_t x = (int32_t)(s[0] << 8 | s[1] << 16 | s[2] << 24) >> 8; v = x / 8388608.0f; }
    else if (bits == 32) v = (int32_t)rd32(s) / 2147483648.0f;
    out->ch(c)[i] = v;
  }
  return out;
}

// Vorbis's channel order (Vorbis I, 4.3.9; Opus's mapping family 1 too) to the WAVE order a browser decodes to
// (L R C LFE BL BR SL SR, as libavcodec reorders): output channel c is decoded channel kVorbisOrder[n-1][c].
const uint8_t kVorbisOrder[8][8] = {{0}, {0, 1}, {0, 2, 1}, {0, 1, 2, 3}, {0, 2, 1, 3, 4}, {0, 2, 1, 5, 3, 4},
                                    {0, 2, 1, 6, 5, 3, 4}, {0, 2, 1, 7, 5, 6, 3, 4}};
int vorbisChannel(int channels, int c) { return channels <= 8 ? kVorbisOrder[channels - 1][c] : c; }

// Ogg Vorbis through stb_vorbis. `granules`: the pages carry granule positions (a real Ogg file: the length is read off
// the last page, a reservation only); `trimEnd` frames are dropped from the end (a WebM block's DiscardPadding).
AudioBufferData* decodeVorbis(const uint8_t* b, size_t len, bool granules, uint32_t trimEnd, std::string* err) {
  int e = 0;
  stb_vorbis* v = stb_vorbis_open_memory(b, (int)len, &e, nullptr);
  if (!v) { *err = "vorbis open failed (" + std::to_string(e) + ")"; return nullptr; }
  stb_vorbis_info info = stb_vorbis_get_info(v);
  int channels = info.channels < 1 ? 1 : info.channels;
  unsigned total = granules ? stb_vorbis_stream_length_in_samples(v) : 0;
  // Decode into growing planar vectors (the header's length is advisory), then pack.
  std::vector<std::vector<float>> pcm(channels);
  for (auto& c : pcm) c.reserve(total);
  float** out; int n;
  while ((n = stb_vorbis_get_frame_float(v, nullptr, &out)) > 0)
    for (int c = 0; c < channels; c++) pcm[c].insert(pcm[c].end(), out[c], out[c] + n);
  stb_vorbis_close(v);
  uint32_t frames = (uint32_t)pcm[0].size(); frames -= std::min(frames, trimEnd);
  AudioBufferData* buf = AudioBufferData::create(channels, frames, info.sample_rate);
  for (int c = 0; c < channels; c++) if (frames) memcpy(buf->ch(c), pcm[vorbisChannel(channels, c)].data(), frames * sizeof(float));
  return buf;
}

uint32_t nsToFrames(int64_t ns, double rate) { return ns <= 0 ? 0 : (uint32_t)std::llround((double)ns * rate / 1e9); }

// Ogg pages around Vorbis packets out of a Matroska track, for stb_vorbis, which reads only Ogg: the identification
// header alone on the first page, the comment and setup headers on the next, then the audio packets. No audio
// page carries a granule position (-1, "no packet ends here"), so stb_vorbis decodes every packet and trims by none.
struct OggWriter {
  std::vector<uint8_t> out;
  uint8_t lacing[255]; int nseg = 0; std::vector<uint8_t> body; uint32_t seq = 0;
  bool continued = false, first = true;  // the current page starts inside a packet / is the stream's first
  void packet(const uint8_t* d, size_t n) {
    for (bool inside = false;; inside = true) {
      if (nseg == 255) { page(-1, 0); continued = inside; }  // a full page: the packet goes on over the next one
      uint8_t chunk = (uint8_t)std::min<size_t>(n, 255);
      lacing[nseg++] = chunk; body.insert(body.end(), d, d + chunk); d += chunk; n -= chunk;
      if (chunk < 255) break;  // a lacing value below 255 ends the packet (0 after an exact multiple of 255)
    }
  }
  void page(int64_t granule, uint8_t flags) {
    static const std::array<uint32_t, 256> crcTable = [] {  // Ogg's CRC-32: polynomial 0x04C11DB7, unreflected
      std::array<uint32_t, 256> t{};
      for (uint32_t i = 0; i < 256; i++) { uint32_t r = i << 24; for (int k = 0; k < 8; k++) r = r & 0x80000000u ? r << 1 ^ 0x04C11DB7u : r << 1; t[i] = r; }
      return t;
    }();
    size_t at = out.size();
    const uint8_t head[6] = {'O', 'g', 'g', 'S', 0, (uint8_t)(flags | (continued ? 1 : 0) | (first ? 2 : 0))};
    out.insert(out.end(), head, head + 6);
    for (int i = 0; i < 8; i++) out.push_back((uint8_t)((uint64_t)granule >> 8 * i));
    for (int i = 0; i < 4; i++) out.push_back((uint8_t)(0x77656263u >> 8 * i));  // serial
    for (int i = 0; i < 4; i++) out.push_back((uint8_t)(seq >> 8 * i));
    for (int i = 0; i < 4; i++) out.push_back(0);                                  // CRC, filled in below
    out.push_back((uint8_t)nseg); out.insert(out.end(), lacing, lacing + nseg); out.insert(out.end(), body.begin(), body.end());
    uint32_t crc = 0; for (size_t i = at; i < out.size(); i++) crc = crc << 8 ^ crcTable[(crc >> 24) ^ out[i]];
    for (int i = 0; i < 4; i++) out[at + 22 + i] = (uint8_t)(crc >> 8 * i);
    nseg = 0; body.clear(); first = continued = false; seq++;
  }
};

AudioBufferData* decodeWebmVorbis(const WebmAudio& w, std::string* err) {
  // CodecPrivate: the three Vorbis headers, Xiph-laced (a count byte, then the sizes of all but the last).
  const uint8_t* h = w.priv; size_t n = w.privLen, p = 1; size_t sz[3];
  if (n < 1 || h[0] != 2) { *err = "WebM Vorbis track without its three headers"; return nullptr; }
  for (int i = 0; i < 2; i++) { size_t s = 0; uint8_t v; do { if (p >= n) { *err = "WebM Vorbis headers truncated"; return nullptr; } v = h[p++]; s += v; } while (v == 255); sz[i] = s; }
  if (sz[0] + sz[1] > n - p) { *err = "WebM Vorbis headers truncated"; return nullptr; }
  sz[2] = n - p - sz[0] - sz[1];
  OggWriter ogg;
  ogg.packet(h + p, sz[0]); ogg.page(0, 0);
  ogg.packet(h + p + sz[0], sz[1]); ogg.packet(h + p + sz[0] + sz[1], sz[2]); ogg.page(0, 0);
  for (const auto& pk : w.packets) ogg.packet(pk.data, pk.len);
  ogg.page(-1, 4);  // end of stream
  // A browser drops the last block's DiscardPadding; Vorbis in WebM has no pre-skip.
  return decodeVorbis(ogg.out.data(), ogg.out.size(), false, nsToFrames(w.packets.back().discardNs, w.rate), err);
}

#ifdef HOST_HAS_OPUS
// Opus at 48 kHz from its OpusHead (RFC 7845) and packets: the header's pre-skip dropped from the start, each packet's
// discardNs (a WebM block's DiscardPadding) from its end, `endTrim` frames from the stream's end (an Ogg stream's
// last granule position), the header's output gain applied, mapping family 1's channels in WAVE order. A packet
// that fails to decode is silence of its length, so the buffer's length is the stream's and is known up front.
AudioBufferData* decodeOpus(const uint8_t* h, size_t n, const std::vector<WebmAudio::Packet>& packets, uint64_t endTrim, std::string* err) {
  if (n < 19 || memcmp(h, "OpusHead", 8)) { *err = "Opus stream without an OpusHead"; return nullptr; }
  int channels = h[9], family = h[18], streams = 1, coupled = channels > 1;
  uint32_t preSkip = rd16(h + 10); int16_t gain = (int16_t)rd16(h + 16);
  unsigned char mapping[255] = {0, 1};
  if (family != 0) {
    if (n < 21 + (size_t)channels) { *err = "OpusHead channel mapping truncated"; return nullptr; }
    streams = h[19]; coupled = h[20]; memcpy(mapping, h + 21, channels);
  }
  if (channels < 1 || channels > 32 || (family == 0 && channels > 2)) { *err = "Opus: " + std::to_string(channels) + " channels"; return nullptr; }
  if (packets.empty()) { *err = "Opus stream without audio packets"; return nullptr; }
  int e = 0;
  OpusMSDecoder* dec = opus_multistream_decoder_create(48000, channels, streams, coupled, mapping, &e);
  if (!dec) { *err = std::string("Opus decoder: ") + opus_strerror(e); return nullptr; }
  if (gain) opus_multistream_decoder_ctl(dec, OPUS_SET_GAIN(gain));
  // Each packet's frames once trimmed, which sum to the buffer's length.
  std::vector<uint32_t> keep(packets.size()), skip(packets.size());
  uint64_t total = 0; uint32_t pre = preSkip;
  for (size_t i = 0; i < packets.size(); i++) {
    int s = opus_packet_get_nb_samples(packets[i].data, (opus_int32)packets[i].len, 48000);
    uint32_t f = s > 0 ? (uint32_t)s : 0;
    f -= std::min(f, nsToFrames(packets[i].discardNs, 48000));
    skip[i] = std::min(f, pre); pre -= skip[i]; keep[i] = f - skip[i]; total += keep[i];
  }
  for (size_t i = packets.size(); i-- > 0 && endTrim;) { uint32_t t = (uint32_t)std::min<uint64_t>(keep[i], endTrim); keep[i] -= t; endTrim -= t; total -= t; }
  if (total > 0xFFFFFFFFu) { opus_multistream_decoder_destroy(dec); *err = "Opus stream too long"; return nullptr; }
  AudioBufferData* buf = AudioBufferData::create(channels, (uint32_t)total, 48000);
  std::vector<float> pcm((size_t)5760 * channels);  // 120 ms, Opus's longest packet
  const bool reorder = family == 1;
  uint32_t at = 0, failed = 0;
  for (size_t i = 0; i < packets.size(); i++) {
    int got = opus_multistream_decode_float(dec, packets[i].data, (opus_int32)packets[i].len, pcm.data(), 5760, 0);
    if (got < (int)(skip[i] + keep[i])) {  // undecodable: silence where it was
      failed++;
      for (int c = 0; c < channels; c++) memset(buf->ch(c) + at, 0, keep[i] * sizeof(float));
    } else {
      for (int c = 0; c < channels; c++) {
        const float* s = pcm.data() + (size_t)skip[i] * channels + (reorder ? vorbisChannel(channels, c) : c);
        float* d = buf->ch(c) + at;
        for (uint32_t k = 0; k < keep[i]; k++) d[k] = s[(size_t)k * channels];
      }
    }
    at += keep[i];
  }
  opus_multistream_decoder_destroy(dec);
  if (failed == packets.size()) { buf->unref(); *err = "Opus: no packet decoded"; return nullptr; }
  return buf;
}

// Ogg Opus (RFC 7845): the first logical stream whose first packet is an OpusHead; OpusHead, OpusTags, then audio.
// Packets are reassembled across pages. The stream's length is its last granule position less the pre-skip (and less
// the first page's start offset, for a stream cut out of a longer one), so the last packet's padding is dropped.
AudioBufferData* decodeOggOpus(const uint8_t* b, size_t len, std::string* err) {
  std::vector<uint8_t> bytes; bytes.reserve(len);
  struct At { size_t off; uint32_t len; int64_t granule; };  // granule: its page's, if the packet is the last to end there
  std::vector<At> at;
  bool have = false, open = false; uint32_t serial = 0; size_t start = 0;
  for (size_t p = 0; p + 27 <= len;) {
    if (memcmp(b + p, "OggS", 4)) { p++; continue; }  // resync on the capture pattern
    uint8_t flags = b[p + 5]; uint32_t ser = rd32(b + p + 14); int nseg = b[p + 26];
    int64_t granule = (int64_t)((uint64_t)rd32(b + p + 6) | (uint64_t)rd32(b + p + 10) << 32);
    if (p + 27 + nseg > len) break;
    const uint8_t* lace = b + p + 27; size_t body = p + 27 + nseg, size = 0;
    for (int i = 0; i < nseg; i++) size += lace[i];
    if (body + size > len) break;  // a truncated page: keep what came before
    if (!have && (flags & 2) && size >= 8 && !memcmp(b + body, "OpusHead", 8)) { have = true; serial = ser; }
    if (have && ser == serial) {
      if (!(flags & 1) && open) { bytes.resize(start); open = false; }  // the page that went on with it is lost
      bool drop = (flags & 1) && !open;  // the page continues a packet we never saw the start of
      size_t q = body; int lastEnd = -1;
      for (int i = 0; i < nseg; i++) if (lace[i] < 255) lastEnd = i;
      for (int i = 0; i < nseg; q += lace[i], i++) {
        if (drop) { if (lace[i] < 255) drop = false; continue; }
        if (!open) { start = bytes.size(); open = true; }
        bytes.insert(bytes.end(), b + q, b + q + lace[i]);
        if (lace[i] < 255) { at.push_back({start, (uint32_t)(bytes.size() - start), i == lastEnd ? granule : -1}); open = false; }
      }
      if (flags & 4) break;  // end of our stream
    }
    p = body + size;
  }
  if (!have || at.size() < 2) { *err = "Ogg Opus stream without its headers"; return nullptr; }
  std::vector<WebmAudio::Packet> packets;
  for (size_t i = 2; i < at.size(); i++) packets.push_back({bytes.data() + at[i].off, at[i].len, 0});
  // Where the granule positions say the stream ends, against the frames its packets hold.
  uint64_t endTrim = 0, frames = 0; int64_t origin = -1;
  for (size_t i = 0; i < packets.size(); i++) {
    int s = opus_packet_get_nb_samples(packets[i].data, (opus_int32)packets[i].len, 48000);
    frames += s > 0 ? (uint64_t)s : 0;
    int64_t g = at[i + 2].granule;
    if (g < 0) continue;
    if (origin < 0) origin = std::max<int64_t>(0, g - (int64_t)frames);  // the first audio page: where the stream starts
    endTrim = frames > (uint64_t)(g - origin) ? frames - (uint64_t)(g - origin) : 0;
  }
  return decodeOpus(bytes.data() + at[0].off, at[0].len, packets, endTrim, err);
}
#endif

// An Ogg file whose first page opens an Opus stream (OpusHead) rather than Vorbis.
bool isOggOpus(const uint8_t* b, size_t len) {
  if (len < 27) return false;
  size_t body = 27 + (size_t)b[26];
  return body + 8 <= len && !memcmp(b + body, "OpusHead", 8);
}
AudioBufferData* decodeOggOpusOrSay(const uint8_t* b, size_t len, std::string* err) {
#ifdef HOST_HAS_OPUS
  return decodeOggOpus(b, len, err);
#else
  *err = "Opus decoding not built in (third_party/opus missing)"; return nullptr;
#endif
}

// MPEG audio: an ID3v2 tag, or a frame header at the start (sync, a layer, a valid bitrate and rate). Anything else is
// not taken for MP3: dr_mp3 would scan another container for something that looks like frames.
bool isMp3(const uint8_t* b, size_t len) {
  if (len >= 10 && !memcmp(b, "ID3", 3)) return true;
  return len >= 4 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0 && (b[1] >> 3 & 3) != 1 && (b[1] >> 1 & 3) != 0 &&
         (b[2] >> 4) != 15 && (b[2] >> 2 & 3) != 3;
}

AudioBufferData* decodeWebm(const uint8_t* b, size_t len, std::string* err) {
  WebmAudio w;
  if (!demuxWebm(b, len, &w, err)) return nullptr;
  if (w.codec == "A_VORBIS") return decodeWebmVorbis(w, err);
#ifdef HOST_HAS_OPUS
  if (w.codec == "A_OPUS") return decodeOpus(w.priv, w.privLen, w.packets, 0, err);
#else
  if (w.codec == "A_OPUS") { *err = "Opus decoding not built in (third_party/opus missing)"; return nullptr; }
#endif
  *err = "unsupported WebM audio codec " + w.codec;
  return nullptr;
}

}  // namespace

const char* decodableCodecs() {
#ifdef HOST_HAS_OPUS
  return mp3Built() ? "wav vorbis opus mp3" : "wav vorbis opus";
#else
  return mp3Built() ? "wav vorbis mp3" : "wav vorbis";
#endif
}

AudioBufferData* decodeAudio(const uint8_t* bytes, size_t len, double targetRate, std::string* err) {
  std::string e;
  AudioBufferData* b = nullptr;
  if (len >= 4 && !memcmp(bytes, "RIFF", 4)) b = decodeWav(bytes, len, &e);
  else if (len >= 4 && !memcmp(bytes, "OggS", 4)) b = isOggOpus(bytes, len) ? decodeOggOpusOrSay(bytes, len, &e) : decodeVorbis(bytes, len, true, 0, &e);
  else if (len >= 4 && !memcmp(bytes, "\x1A\x45\xDF\xA3", 4)) b = decodeWebm(bytes, len, &e);
  else if (isMp3(bytes, len)) b = decodeMp3(bytes, len, &e);
  else e = "unsupported audio container";
  if (!b) { if (err) *err = e; return nullptr; }
  return resample(b, targetRate);
}

DecodeWorker::~DecodeWorker() {
  { std::lock_guard<std::mutex> l(mu_); stop_ = true; }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}
void DecodeWorker::submit(std::vector<uint8_t> bytes, double targetRate, Done done) {
  std::lock_guard<std::mutex> l(mu_);
  q_.push(Job{std::move(bytes), targetRate, std::move(done)});
  if (!started_) { started_ = true; thread_ = std::thread([this] { run(); }); }
  cv_.notify_one();
}
void DecodeWorker::run() {
  for (;;) {
    Job j;
    { std::unique_lock<std::mutex> l(mu_); cv_.wait(l, [&] { return stop_ || !q_.empty(); }); if (stop_ && q_.empty()) return; j = std::move(q_.front()); q_.pop(); }
    std::string err; AudioBufferData* b = decodeAudio(j.bytes.data(), j.bytes.size(), j.rate, &err);
    j.done(b, err);
  }
}

}  // namespace audio
}  // namespace host
