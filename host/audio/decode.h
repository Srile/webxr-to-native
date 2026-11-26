#pragma once
// decodeAudioData: RIFF WAV (PCM 8/16/24/32, float 32/64), Ogg with Vorbis
// (stb_vorbis) or Opus (libopus, HOST_HAS_OPUS), WebM/Matroska with Opus or Vorbis
// (audio/webm.h) and MP3 (dr_mp3, audio/mp3.cpp) → planar float, resampled
// (linear) to the context rate. The worker
// runs decodes off the host thread and hands results to a `post` function
// (the binding wraps them into Loop::post).
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>
#include "audio/graph.h"

namespace host {
namespace audio {

// Returns a buffer with one reference, or nullptr with *err set. targetRate 0 keeps the file's rate.
AudioBufferData* decodeAudio(const uint8_t* bytes, size_t len, double targetRate, std::string* err);
// The codecs decodeAudio decodes in this build, space-separated: "wav vorbis opus mp3" (opus with libopus, mp3
// with dr_mp3).
const char* decodableCodecs();

// MP3 (audio/mp3.cpp, dr_mp3); mp3Built() false when dr_mp3.h was not there to build it.
AudioBufferData* decodeMp3(const uint8_t* bytes, size_t len, std::string* err);
bool mp3Built();

// AAC in MP4 / M4A or ADTS (audio/aac.cpp): the platform's decoder (Android MediaCodec); aacBuilt() false elsewhere.
bool isAac(const uint8_t* bytes, size_t len);
AudioBufferData* decodeAac(const uint8_t* bytes, size_t len, std::string* err);
bool aacBuilt();

class DecodeWorker {
 public:
  using Done = std::function<void(AudioBufferData*, std::string err)>;
  ~DecodeWorker();
  // `done` runs on the worker thread; `post` (if given) is used to run it elsewhere.
  void submit(std::vector<uint8_t> bytes, double targetRate, Done done);
 private:
  void run();
  struct Job { std::vector<uint8_t> bytes; double rate; Done done; };
  std::thread thread_; std::mutex mu_; std::condition_variable cv_; std::queue<Job> q_; bool stop_ = false, started_ = false;
};

}  // namespace audio
}  // namespace host
