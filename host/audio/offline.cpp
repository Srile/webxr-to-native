#include "audio/offline.h"
#include <algorithm>

namespace host {
namespace audio {

OfflineContext::OfflineContext(int channels, uint32_t length, double sampleRate, uint32_t chunkSize)
    : ContextBase(sampleRate, channels, chunkSize, 1u << 16, false), channels_(channels < 1 ? 1 : (channels > MAX_CH ? MAX_CH : channels)), length_(length) {
  initDestination();
}
OfflineContext::~OfflineContext() { if (thread_.joinable()) thread_.join(); }

bool OfflineContext::issue(const Command& c) {
  if (rendering_.load()) return false;  // the game never edits a context mid-render; nothing to race
  graph_->apply(c);
  return true;
}

AudioBufferData* OfflineContext::renderAll() {
  AudioBufferData* out = AudioBufferData::create(channels_, length_, graph_->sampleRate());
  for (uint32_t f = 0; f < length_; f += QUANTUM) {
    graph_->render();
    uint32_t n = std::min<uint32_t>(QUANTUM, length_ - f);
    for (int c = 0; c < channels_; c++) memcpy(out->ch(c) + f, graph_->destOut(c), n * sizeof(float));
  }
  return out;
}

bool OfflineContext::startRendering(std::function<void(AudioBufferData*)> done) {
  if (rendering_.exchange(true)) return false;
  thread_ = std::thread([this, done]() { AudioBufferData* b = renderAll(); finished_.store(true); done(b); });
  return true;
}

AudioBufferData* OfflineContext::renderNow() {
  if (rendering_.exchange(true)) return nullptr;
  AudioBufferData* b = renderAll(); finished_.store(true); rendering_.store(false); return b;
}

}  // namespace audio
}  // namespace host
