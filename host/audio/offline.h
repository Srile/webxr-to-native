#pragma once
// OfflineAudioContext: the graph edited directly on the host thread, then
// rendered to a buffer on a worker thread. Also what the Mac unit tests drive.
#include <atomic>
#include <thread>
#include "audio/context.h"

namespace host {
namespace audio {

class OfflineContext : public ContextBase {
 public:
  OfflineContext(int channels, uint32_t length, double sampleRate, uint32_t chunkSize = 512);
  ~OfflineContext() override;
  bool issue(const Command& c) override;
  int channels() const { return channels_; }
  uint32_t length() const { return length_; }
  bool rendering() const { return rendering_.load(); }
  bool finished() const { return finished_.load(); }

  // Renders length frames on a new thread; `done` runs on that thread with the
  // result (one reference owned by the callee). false if already started.
  bool startRendering(std::function<void(AudioBufferData*)> done);
  // Synchronous render on the calling thread (tests).
  AudioBufferData* renderNow();
  // Renders exactly one quantum (tests that inspect the graph as it goes).
  void renderQuantum() { graph_->render(); }

 private:
  AudioBufferData* renderAll();
  int channels_; uint32_t length_;
  std::atomic<bool> rendering_{false}, finished_{false};
  std::thread thread_;
};

}  // namespace audio
}  // namespace host
