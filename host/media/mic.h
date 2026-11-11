#pragma once
// Microphone capture (WP-25), built only for a game whose host.json asks for it (media.microphone; CMake
// HOST_MICROPHONE, host/microphone.cmake). One capture device, the system's default input, opened when the
// first live track starts and closed when the last live track stops; every track (getUserMedia, clone(), a
// second getUserMedia) reads the same CaptureRing (audio/live_ring.h), each MediaStreamAudioSourceNode at its own
// cursor. Capture:
//   Android  an Oboe (AAudio) input stream, mono float at the device's rate, its InputPreset chosen from the
//            processing constraints: echoCancellation -> VoiceCommunication (the platform's AEC, NS and AGC),
//            else noiseSuppression or autoGainControl -> VoiceRecognition, else Unprocessed (VoiceRecognition
//            where a device refuses it)
//   mac      a CoreAudio HAL input unit (AUHAL) on the default input device at its nominal rate; no processing
//   Linux    a PulseAudio record stream, 48 kHz mono float (the server converts); no processing
// Windows and iOS have no capture (not built). Host thread only, except the capture callback (ring writes) and
// MicTrack::read (render threads).
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include "audio/live_ring.h"

namespace host {
class Loop;
namespace media {

struct Processing { bool echoCancellation = true, noiseSuppression = true, autoGainControl = true; };

// A capture track (MediaStreamTrack's native side): enabled false or ended = silence for every node reading it.
class MicTrack : public audio::LiveInput {
 public:
  MicTrack(uint32_t id, audio::CaptureRing* ring) : id(id), ring_(ring) {}
  const uint32_t id;
  std::atomic<bool> enabled{true}, ended{false};
  bool read(audio::LiveCursor& c, float* out, int n, double rate) override {
    if (!enabled.load(std::memory_order_relaxed) || ended.load(std::memory_order_relaxed)) { c.primed = c.waiting = false; return false; }
    return ring_->read(c, out, n, rate);
  }
  bool live() const override { return !ended.load(std::memory_order_relaxed); }
 private:
  audio::CaptureRing* ring_;
};

// A voice arriving over WebRTC (rtc/rtc_bind.cpp decodes it into the ring): read like a capture track, with a
// margin for the network's jitter that follows it (JitterTarget: 60-240 ms; readers drift to it in quiet stretches)
// and at most 250 ms more before the oldest is dropped.
class RemoteTrack : public audio::LiveInput {
 public:
  RemoteTrack() : ring(jitter.target(), 0.25, true) { ring.setRate(48000); }
  std::atomic<bool> enabled{true}, ended{false};
  audio::JitterTarget jitter;  // the receive thread's
  audio::CaptureRing ring;
  bool read(audio::LiveCursor& c, float* out, int n, double rate) override {
    if (!enabled.load(std::memory_order_relaxed) || ended.load(std::memory_order_relaxed)) { c.primed = c.waiting = false; return false; }
    return ring.read(c, out, n, rate);
  }
  bool live() const override { return !ended.load(std::memory_order_relaxed); }
};

class Capture;  // the platform's device (mic.cpp)

class Mic {
 public:
  static Mic& get();
  // toneHz: host.json debug.micTone (0: the microphone itself), see Capture::deliver.
  void init(Loop* loop, double toneHz = 0) { loop_ = loop; toneHz_ = toneHz; }
  // A new live track; opens the device when none is live (`want` picks its processing then; a later track shares
  // what is open). Null with *err = "NotReadableError: ..." / "NotFoundError: ..." when the device cannot open.
  uint32_t open(const Processing& want, std::string* err);
  void stop(uint32_t id);                    // ends the track; the last live track closes the device
  void release(uint32_t id);                 // stop + forget the id (the JS track is gone)
  bool setEnabled(uint32_t id, bool on);
  audio::LiveInput* input(uint32_t id);      // with a reference for the caller; null if unknown or ended
  // A remote track (its own id range): takes a reference; stop/release/setEnabled/input then work on its id.
  uint32_t addRemote(RemoteTrack* t);
  // The open device (valid while live() > 0), what it delivers.
  int live() const { return live_; }
  double rate() const;
  const Processing& processing() const { return actual_; }
  const std::string& label() const { return label_; }
  const char* preset() const { return preset_; }
  std::string defaultLabel();                // the default input's name (before opening; may be generic)
  audio::CaptureRing& ring() { return *ring_; }
  // Events for JS: ("ended", id) when the device is lost and cannot be reopened, ("devicechange", 0).
  std::function<void(const char* kind, uint32_t id)> onEvent;
  uint32_t opens() const { return opens_; }

 private:
  Mic();
  void watch();  // the device's health, on a loop timer while it is open
  void closeDevice(const char* why);
  Loop* loop_ = nullptr;
  audio::CaptureRing* ring_;
  std::unique_ptr<Capture> dev_;
  std::unordered_map<uint32_t, MicTrack*> tracks_;  // one reference each, until release()
  std::unordered_map<uint32_t, RemoteTrack*> remotes_;  // likewise; ids from kRemoteBase
  static constexpr uint32_t kRemoteBase = 1u << 20;
  uint32_t nextRemote_ = kRemoteBase;
  uint32_t nextId_ = 1, timer_ = 0, opens_ = 0; int live_ = 0; double toneHz_ = 0;
  Processing actual_, want_; std::string label_; const char* preset_ = "";
};

}  // namespace media
}  // namespace host
