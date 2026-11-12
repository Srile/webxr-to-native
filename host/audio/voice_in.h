#pragma once
// A network voice's Opus packets into its ring, in arrival order (rtc/rtc_bind.cpp, libdatachannel's receive thread).
// A packet behind the last one decoded (reordered, or a duplicate) is dropped. A gap in the sequence (or, by
// packetAt, in the RTP timestamps) is filled:
// the last missing frame from the in-band FEC copy the sender put in this packet (useinbandfec=1; Opus's low-bitrate
// copy of the frame before), the ones before it (up to 4) by Opus's loss concealment, which on its own turns a voice
// robotic when packets go missing often.
#include <opus.h>
#include <algorithm>
#include <cstdint>

namespace host {
namespace audio {

class OpusVoiceIn {
 public:
  static constexpr int kMaxFrame = 5760;  // 120 ms at 48 kHz, Opus's longest
  static constexpr int kMaxFill = 5;      // frames filled for one gap at most

  explicit OpusVoiceIn(OpusDecoder* dec) : dec_(dec) {}

  // Counts since the caller last reset them.
  uint32_t concealed = 0, recovered = 0, late = 0;

  // One packet's Opus payload with its RTP sequence number, decoded into `ring` (a CaptureRing, or anything with
  // write(const float*, uint32_t)). False: dropped (late, or undecodable).
  template <class Sink>
  bool packet(uint16_t seq, const unsigned char* data, int len, Sink& ring) {
    if (lastSeq_ >= 0) {
      const int16_t ahead = (int16_t)(uint16_t)(seq - (uint16_t)(lastSeq_ + 1));
      if (ahead < 0) { late++; return false; }
      if (ahead > 0) fill(ahead, data, len, ring);
    }
    lastSeq_ = seq;
    return decode(data, len, ring) > 0;
  }

  // The same by RTP timestamp (48 kHz), for a receiver that is handed frames without their sequence numbers
  // (libdatachannel's depacketizer): the frames missing are the time between the end of the last one decoded and
  // this one, in frames of this one's length. A gap of a second or more is a sender that was silent, not loss:
  // nothing is filled.
  template <class Sink>
  bool packetAt(uint32_t ts, const unsigned char* data, int len, Sink& ring) {
    if (haveTs_) {
      const int32_t gap = (int32_t)(ts - nextTs_);
      if (gap < 0) { late++; return false; }
      const int frame = std::clamp(opus_packet_get_nb_samples(data, len, 48000), 120, kMaxFrame);
      if (gap >= frame && gap < 48000) fill(gap / frame, data, len, ring);
    }
    const int k = decode(data, len, ring);
    if (k <= 0) return false;
    nextTs_ = ts + (uint32_t)k; haveTs_ = true;
    return true;
  }

 private:
  // `missing` frames before this packet: the last from its FEC copy, the ones before it (kMaxFill in all) concealed.
  template <class Sink>
  void fill(int missing, const unsigned char* data, int len, Sink& ring) {
    // The missing frames are as long as this one (a sender keeps its frame size).
    const int frame = std::clamp(opus_packet_get_nb_samples(data, len, 48000), 120, kMaxFrame);
    const int n = std::min<int>(missing, kMaxFill);
    for (int i = 0; i < n - 1; ++i) {
      const int k = opus_decode_float(dec_, nullptr, 0, pcm_, frame, 0);
      if (k > 0) { ring.write(pcm_, (uint32_t)k); concealed++; }
    }
    const int k = opus_decode_float(dec_, data, len, pcm_, frame, 1);  // FEC (concealment if there is none)
    if (k > 0) { ring.write(pcm_, (uint32_t)k); recovered++; }
  }
  template <class Sink>
  int decode(const unsigned char* data, int len, Sink& ring) {
    const int k = opus_decode_float(dec_, data, len, pcm_, kMaxFrame, 0);
    if (k > 0) ring.write(pcm_, (uint32_t)k);
    return k;
  }

  OpusDecoder* dec_;
  int lastSeq_ = -1;
  uint32_t nextTs_ = 0; bool haveTs_ = false;
  float pcm_[kMaxFrame];
};

}  // namespace audio
}  // namespace host
