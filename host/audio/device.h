#pragma once
// AudioContext over Oboe/AAudio: the graph lives on the stream's callback
// thread; host edits travel over a lock-free Command ring and are applied at
// quantum boundaries; a ring of rendered frames bridges the 128-frame quantum
// and whatever frame count the device asks for. Android (Oboe), and the
// experimental emulated-headset hosts: CoreAudio (mac: the default output unit,
// ios: remote I/O), WASAPI shared mode (win: an event-driven render thread), the PulseAudio client API (linux:
// a threaded mainloop's write callback; PipeWire serves the same API through pipewire-pulse).
#include <atomic>
#include <memory>
#include <thread>
#include "audio/context.h"

#ifdef __ANDROID__
#include <oboe/Oboe.h>
#endif

namespace host {
namespace audio {

class RealtimeContext : public ContextBase
#ifdef __ANDROID__
    , public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback
#endif
{
 public:
  // Opens the device stream and starts it. Without a device (open failed) the
  // context still exists at 48 kHz, suspended; resume() keeps failing.
  static RealtimeContext* create(uint32_t chunkSize, double preferredRate = 0);
  ~RealtimeContext() override;
  bool issue(const Command& c) override;
  bool resume() override;
  bool suspend() override;
  bool running() const override { return running_.load(); }
  bool hasDevice() const { return hasDevice_; }
  void tick() override;
  void close();
  uint32_t droppedCommands() const { return dropped_; }
  // iOS: the system stopped every output unit (a call, Siri, an alarm) and the interruption is over: the
  // contexts that were running start again (ios/main.mm, on the host thread); not the paused ones.
  static void resumeAfterInterruption();
  // The platform hides the page (vision: the person left the immersive space): the running contexts' output units
  // stop, their state untouched (the page's AudioContexts still run: their commands apply on the host thread
  // meanwhile, issue()), until resumeOutput(). Both on the host thread.
  static void pauseOutput();
  static void resumeOutput();

#ifdef __ANDROID__
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) override;
  void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) override;
#endif
  // The callback body, device-agnostic (tests may drive it): renders into interleaved stereo.
  void renderInto(float* interleaved, int32_t numFrames);

 private:
  RealtimeContext(double rate, uint32_t chunkSize);
  bool openStream(double preferredRate);
  Ring<Command> cmds_;
  static constexpr uint32_t RING_FRAMES = 4096;  // power of two
  float ring_[RING_FRAMES * MAX_CH]; uint32_t ringR_ = 0, ringW_ = 0;
  std::atomic<bool> running_{false}, needReopen_{false}, paused_{false};
  std::atomic<int> inRender_{0};  // Android: the Oboe callback is inside the graph (pauseOutput waits it out)
  bool hasDevice_ = false, closed_ = false; uint32_t dropped_ = 0; double preferredRate_ = 0;
#ifdef __ANDROID__
  std::shared_ptr<oboe::AudioStream> stream_;
#elif defined(__APPLE__)
  void* unit_ = nullptr;  // AudioComponentInstance (the default output unit)
#elif defined(_WIN32)
  void renderThread();
  void closeWasapi();
  void* client_ = nullptr; void* render_ = nullptr; void* event_ = nullptr;  // IAudioClient, IAudioRenderClient, HANDLE
  uint32_t bufferFrames_ = 0;
  std::thread thread_; std::atomic<bool> threadStop_{false};
#elif defined(__linux__)
  void closePulse();
  void corkPulse(bool cork);
  void pulseWrite(size_t bytes);  // the stream's write callback (mainloop thread, its lock held)
  void* paLoop_ = nullptr; void* paCtx_ = nullptr; void* paStream_ = nullptr;  // pa_threaded_mainloop, pa_context, pa_stream
#endif
};

}  // namespace audio
}  // namespace host
