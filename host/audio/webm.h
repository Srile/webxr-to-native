#pragma once
// WebM / Matroska audio demuxing for decodeAudioData: the file's first audio track, its codec setup and its packets
// in file order (decodeAudio decodes every packet and ignores block timestamps, as a browser's decodeAudioData
// does: some muxers write timestamps that disagree with the audio). Segments and clusters of unknown size
// (MediaRecorder's live WebM) are read through to the end of the file. Pointers alias the caller's bytes.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace host {
namespace audio {

struct WebmAudio {
  std::string codec;                  // the track's CodecID: "A_OPUS", "A_VORBIS", ...
  const uint8_t* priv = nullptr;      // CodecPrivate (OpusHead; Vorbis's three headers, Xiph-laced)
  size_t privLen = 0;
  double rate = 0;                    // Audio/SamplingFrequency
  int channels = 0;                   // Audio/Channels
  uint64_t codecDelayNs = 0;          // TrackEntry/CodecDelay
  struct Packet { const uint8_t* data; uint32_t len; int64_t discardNs; };  // discardNs: the block's DiscardPadding
  std::vector<Packet> packets;
};

// The first audio track of a WebM/Matroska file. False with *err set if there is none, or nothing to decode.
bool demuxWebm(const uint8_t* bytes, size_t len, WebmAudio* out, std::string* err);

}  // namespace audio
}  // namespace host
