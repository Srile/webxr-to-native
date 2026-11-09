// MP3 for decodeAudioData (MPEG 1/2/2.5, layers I-III) through dr_mp3 (third_party/dr_libs, tools/setup.sh), in its
// own translation unit (its internals and stb_vorbis's macros would collide). Float output, not clipped, as a
// browser's AudioBuffer holds it; the LAME tag's encoder delay and padding trimmed (dr_mp3 reads them), so a loop
// encoded by LAME is gapless, as Chrome and Safari decode it; ID3 tags skipped.
#include "audio/decode.h"

#if __has_include("dr_mp3.h")
#define DR_MP3_IMPLEMENTATION
#define DR_MP3_NO_STDIO
#define DR_MP3_FLOAT_OUTPUT
#include "dr_mp3.h"
#define HOST_HAS_MP3 1
#endif

namespace host {
namespace audio {

bool mp3Built() {
#ifdef HOST_HAS_MP3
  return true;
#else
  return false;
#endif
}

AudioBufferData* decodeMp3(const uint8_t* bytes, size_t len, std::string* err) {
#ifdef HOST_HAS_MP3
  drmp3 m;
  if (!drmp3_init_memory(&m, bytes, len, nullptr)) { *err = "no MP3 frames"; return nullptr; }
  int channels = (int)m.channels; uint32_t rate = m.sampleRate;
  if (channels < 1 || channels > 2 || rate == 0) { drmp3_uninit(&m); *err = "MP3 with " + std::to_string(channels) + " channels"; return nullptr; }
  // Interleaved as it decodes (an MP3 states no reliable length up front), then split into channels.
  std::vector<float> pcm; float chunk[4096 * 2];
  for (drmp3_uint64 n; (n = drmp3_read_pcm_frames_f32(&m, 4096, chunk)) > 0;) pcm.insert(pcm.end(), chunk, chunk + n * channels);
  drmp3_uninit(&m);
  uint32_t frames = (uint32_t)(pcm.size() / channels);
  if (!frames) { *err = "MP3 without audio"; return nullptr; }
  AudioBufferData* buf = AudioBufferData::create(channels, frames, rate);
  for (int c = 0; c < channels; c++) { float* d = buf->ch(c); for (uint32_t i = 0; i < frames; i++) d[i] = pcm[(size_t)i * channels + c]; }
  return buf;
#else
  *err = "MP3 decoding not built in (third_party/dr_libs/dr_mp3.h missing: tools/setup.sh)";
  return nullptr;
#endif
}

}  // namespace audio
}  // namespace host
