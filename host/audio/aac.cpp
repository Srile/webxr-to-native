// AAC (MP4 / M4A, ADTS) for decodeAudioData through the platform's own decoder: Android's MediaCodec (NDK
// libmediandk), fed from memory by a custom AMediaDataSource. Other hosts report the container as unsupported.
#include "audio/decode.h"
#include <cstring>
#include <string>
#include <vector>

#ifdef __ANDROID__
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaDataSource.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>
#endif

namespace host {
namespace audio {

bool isAac(const uint8_t* b, size_t len) {
  if (len >= 12 && !memcmp(b + 4, "ftyp", 4)) return true;                       // MP4 / M4A
  return len >= 7 && b[0] == 0xFF && (b[1] & 0xF6) == 0xF0;                     // ADTS: sync, layer 00
}

#ifdef __ANDROID__
namespace {
struct Memory { const uint8_t* bytes; size_t len; };
ssize_t readAt(void* user, off64_t offset, void* buffer, size_t size) {
  const Memory* m = (const Memory*)user;
  if (offset < 0 || (size_t)offset >= m->len) return -1;
  size_t n = std::min(size, m->len - (size_t)offset);
  memcpy(buffer, m->bytes + offset, n);
  return (ssize_t)n;
}
ssize_t getSize(void* user) { return (ssize_t)((const Memory*)user)->len; }
void closeSource(void*) {}
}  // namespace

AudioBufferData* decodeAac(const uint8_t* bytes, size_t len, std::string* err) {
  Memory mem{bytes, len};
  AMediaDataSource* src = AMediaDataSource_new();
  if (!src) { *err = "AAC: no media data source"; return nullptr; }
  AMediaDataSource_setUserdata(src, &mem); AMediaDataSource_setReadAt(src, readAt); AMediaDataSource_setGetSize(src, getSize); AMediaDataSource_setClose(src, closeSource);
  AMediaExtractor* ex = AMediaExtractor_new();
  AMediaCodec* codec = nullptr; AMediaFormat* format = nullptr;
  AudioBufferData* out = nullptr;
  std::vector<float> pcm;  // interleaved
  int channels = 0, rate = 0, encoding = 2;  // 2: 16-bit PCM, 4: float (MediaFormat KEY_PCM_ENCODING)
  auto fail = [&](const std::string& why) { *err = "AAC: " + why; };
  do {
    if (AMediaExtractor_setDataSourceCustom(ex, src) != AMEDIA_OK) { fail("not a readable MP4/ADTS stream"); break; }
    int track = -1; const char* mime = nullptr;
    for (size_t t = 0, n = AMediaExtractor_getTrackCount(ex); t < n && track < 0; ++t) {
      AMediaFormat* f = AMediaExtractor_getTrackFormat(ex, t);
      const char* m = nullptr;
      if (AMediaFormat_getString(f, AMEDIAFORMAT_KEY_MIME, &m) && m && !strncmp(m, "audio/", 6)) { track = (int)t; format = f; mime = m; }
      else AMediaFormat_delete(f);
    }
    if (track < 0) { fail("no audio track"); break; }
    AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &channels);
    AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_SAMPLE_RATE, &rate);
    AMediaExtractor_selectTrack(ex, track);
    codec = AMediaCodec_createDecoderByType(mime);
    if (!codec) { fail(std::string("no decoder for ") + mime); break; }
    if (AMediaCodec_configure(codec, format, nullptr, nullptr, 0) != AMEDIA_OK || AMediaCodec_start(codec) != AMEDIA_OK) { fail("decoder would not start"); break; }
    bool inputDone = false, outputDone = false;
    int idle = 0;
    while (!outputDone && idle < 200) {  // 200 empty polls of 5 ms: a decoder that stopped answering
      bool progress = false;
      if (!inputDone) {
        ssize_t in = AMediaCodec_dequeueInputBuffer(codec, 5000);
        if (in >= 0) {
          size_t cap = 0; uint8_t* buf = AMediaCodec_getInputBuffer(codec, (size_t)in, &cap);
          ssize_t n = buf ? AMediaExtractor_readSampleData(ex, buf, cap) : -1;
          if (n < 0) { AMediaCodec_queueInputBuffer(codec, (size_t)in, 0, 0, 0, AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM); inputDone = true; }
          else { AMediaCodec_queueInputBuffer(codec, (size_t)in, 0, (size_t)n, (uint64_t)AMediaExtractor_getSampleTime(ex), 0); AMediaExtractor_advance(ex); }
          progress = true;
        }
      }
      AMediaCodecBufferInfo info;
      ssize_t o = AMediaCodec_dequeueOutputBuffer(codec, &info, 5000);
      if (o >= 0) {
        size_t cap = 0; uint8_t* buf = AMediaCodec_getOutputBuffer(codec, (size_t)o, &cap);
        if (buf && info.size > 0 && channels > 0) {
          const uint8_t* p = buf + info.offset;
          if (encoding == 4) { const float* s = (const float*)p; pcm.insert(pcm.end(), s, s + info.size / sizeof(float)); }
          else { const int16_t* s = (const int16_t*)p; size_t k = info.size / sizeof(int16_t); for (size_t i = 0; i < k; ++i) pcm.push_back(s[i] / 32768.f); }
        }
        AMediaCodec_releaseOutputBuffer(codec, (size_t)o, false);
        if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputDone = true;
        progress = true;
      } else if (o == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        AMediaFormat* f = AMediaCodec_getOutputFormat(codec);
        AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &channels);
        AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_SAMPLE_RATE, &rate);
        int32_t enc = 2; if (AMediaFormat_getInt32(f, "pcm-encoding", &enc)) encoding = enc;
        AMediaFormat_delete(f);
        progress = true;
      }
      idle = progress ? 0 : idle + 1;
    }
    if (!outputDone) { fail("decoder stalled"); break; }
    if (channels <= 0 || rate <= 0) { fail("no channel count or rate"); break; }
    const uint32_t frames = (uint32_t)(pcm.size() / (size_t)channels);
    out = AudioBufferData::create(channels, frames, rate);
    if (!out) { fail("out of memory"); break; }
    for (int c = 0; c < channels; ++c) { float* d = out->ch(c); for (uint32_t i = 0; i < frames; ++i) d[i] = pcm[(size_t)i * channels + c]; }
  } while (false);
  if (codec) { AMediaCodec_stop(codec); AMediaCodec_delete(codec); }
  if (format) AMediaFormat_delete(format);
  AMediaExtractor_delete(ex);
  AMediaDataSource_delete(src);
  return out;
}
bool aacBuilt() { return true; }
#else
AudioBufferData* decodeAac(const uint8_t*, size_t, std::string* err) { *err = "AAC is decoded only on Android (MediaCodec)"; return nullptr; }
bool aacBuilt() { return false; }
#endif

}  // namespace audio
}  // namespace host
