#include "audio/device.h"
#include <chrono>
#include <cstring>
#include <thread>
#include <vector>
#include "core/log.h"
#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#include <TargetConditionals.h>
#elif defined(_WIN32)
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#elif defined(__linux__) && !defined(__ANDROID__)
#include <pulse/pulseaudio.h>
#endif

namespace host {
namespace audio {

namespace { std::vector<RealtimeContext*> g_live; }  // open contexts (host thread only): resumeAfterInterruption

RealtimeContext::RealtimeContext(double rate, uint32_t chunkSize)
    : ContextBase(rate, 2, chunkSize, 1u << 13, true), cmds_(1u << 14) { g_live.push_back(this); }

void RealtimeContext::resumeAfterInterruption() {
#ifdef __APPLE__
  for (RealtimeContext* c : g_live) if (c->unit_ && c->running_.load() && !c->paused_.load()) AudioOutputUnitStart((AudioComponentInstance)c->unit_);
#endif
}
void RealtimeContext::pauseOutput() {
#ifdef __APPLE__
  for (RealtimeContext* c : g_live) { c->paused_.store(true); if (c->unit_ && c->running_.load()) AudioOutputUnitStop((AudioComponentInstance)c->unit_); }  // Stop returns once the callback is out
#elif defined(__linux__) && !defined(__ANDROID__)
  for (RealtimeContext* c : g_live) { c->paused_.store(true); if (c->paStream_ && c->running_.load()) c->corkPulse(true); }  // corkPulse holds the mainloop lock: the callback is out
#elif defined(__ANDROID__)
  // The phone build in the background (app/host.cpp). Oboe's pause is asynchronous: the callback can still be in the
  // graph for one more buffer while this thread starts applying commands directly (issue()). So: paused first (a
  // callback that starts now sees it and writes silence), then wait out one already inside, then pause the stream.
  for (RealtimeContext* c : g_live) {
    c->paused_.store(true);
    for (int i = 0; i < 2000 && c->inRender_.load(); i++) std::this_thread::sleep_for(std::chrono::microseconds(50));
    if (c->stream_ && c->running_.load()) c->stream_->requestPause();
  }
#endif
}
void RealtimeContext::resumeOutput() {
#ifdef __APPLE__
  for (RealtimeContext* c : g_live) { c->paused_.store(false); if (c->unit_ && c->running_.load()) AudioOutputUnitStart((AudioComponentInstance)c->unit_); }
#elif defined(__linux__) && !defined(__ANDROID__)
  for (RealtimeContext* c : g_live) { c->paused_.store(false); if (c->paStream_ && c->running_.load()) c->corkPulse(false); }
#elif defined(__ANDROID__)
  for (RealtimeContext* c : g_live) { c->paused_.store(false); if (c->stream_ && c->running_.load()) c->stream_->requestStart(); }
#endif
}

RealtimeContext* RealtimeContext::create(uint32_t chunkSize, double preferredRate) {
  double rate = preferredRate > 0 ? preferredRate : 48000;
#ifdef __ANDROID__
  // Open first: the graph's rate is the stream's.
  oboe::AudioStreamBuilder b;
  b.setDirection(oboe::Direction::Output)->setPerformanceMode(oboe::PerformanceMode::LowLatency)
   ->setSharingMode(oboe::SharingMode::Shared)->setFormat(oboe::AudioFormat::Float)->setChannelCount(2)
   ->setUsage(oboe::Usage::Game)->setFormatConversionAllowed(true)->setChannelConversionAllowed(true);
  if (preferredRate > 0) b.setSampleRate((int32_t)preferredRate)->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium);
  std::shared_ptr<oboe::AudioStream> probe;
  oboe::Result r = b.openStream(probe);
  if (r == oboe::Result::OK && probe) { rate = probe->getSampleRate(); probe->close(); }
  else HOST_LOGE("audio: openStream failed: %s", oboe::convertToText(r));
#endif
  RealtimeContext* c = new RealtimeContext(rate, chunkSize);
  c->preferredRate_ = preferredRate;
  c->initDestination();
  // Nothing renders until the stream runs: apply the pending setup commands here, on the host thread.
  Command cmd; while (c->cmds_.pop(cmd)) c->graph_->apply(cmd);
  c->hasDevice_ = c->openStream(preferredRate);
  if (c->hasDevice_) c->resume();
  return c;
}

RealtimeContext::~RealtimeContext() { close(); }

bool RealtimeContext::openStream(double preferredRate) {
#ifdef __ANDROID__
  oboe::AudioStreamBuilder b;
  b.setDirection(oboe::Direction::Output)->setPerformanceMode(oboe::PerformanceMode::LowLatency)
   ->setSharingMode(oboe::SharingMode::Shared)->setFormat(oboe::AudioFormat::Float)->setChannelCount(2)
   ->setUsage(oboe::Usage::Game)->setFormatConversionAllowed(true)->setChannelConversionAllowed(true)
   ->setSampleRate((int32_t)graph_->sampleRate())->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
   ->setDataCallback(this)->setErrorCallback(this);
  (void)preferredRate;
  oboe::Result r = b.openStream(stream_);
  if (r != oboe::Result::OK) { HOST_LOGE("audio: openStream failed: %s", oboe::convertToText(r)); stream_.reset(); return false; }
  HOST_LOGI("audio: stream %d Hz, %d ch, burst %d, %s", stream_->getSampleRate(), stream_->getChannelCount(), stream_->getFramesPerBurst(),
            stream_->getAudioApi() == oboe::AudioApi::AAudio ? "AAudio" : "OpenSLES");
  return true;
#elif defined(__APPLE__)
  (void)preferredRate;
#if TARGET_OS_IPHONE
  // iOS: the remote I/O unit's output bus (the app's AVAudioSession is set up in ios/main.mm).
  AudioComponentDescription desc{kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
#else
  AudioComponentDescription desc{kAudioUnitType_Output, kAudioUnitSubType_DefaultOutput, kAudioUnitManufacturer_Apple, 0, 0};
#endif
  AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
  AudioComponentInstance unit = nullptr;
  if (!comp || AudioComponentInstanceNew(comp, &unit) != noErr) { HOST_LOGE("audio: no output unit"); return false; }
  // Interleaved float stereo at the graph's rate: the unit converts to the device's own format.
  AudioStreamBasicDescription fmt{};
  fmt.mSampleRate = graph_->sampleRate(); fmt.mFormatID = kAudioFormatLinearPCM; fmt.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  fmt.mChannelsPerFrame = 2; fmt.mBitsPerChannel = 32; fmt.mFramesPerPacket = 1; fmt.mBytesPerFrame = fmt.mBytesPerPacket = 8;
  AURenderCallbackStruct cb{[](void* self, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* io) -> OSStatus {
    ((RealtimeContext*)self)->renderInto((float*)io->mBuffers[0].mData, (int32_t)frames); return noErr; }, this};
  if (AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &fmt, sizeof fmt) != noErr ||
      AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb) != noErr ||
      AudioUnitInitialize(unit) != noErr) { HOST_LOGE("audio: output unit setup failed"); AudioComponentInstanceDispose(unit); return false; }
  unit_ = unit;
  HOST_LOGI("audio: CoreAudio %s output, %.0f Hz, 2 ch", TARGET_OS_IPHONE ? "remote I/O" : "default", fmt.mSampleRate);
  return true;
#elif defined(_WIN32)
  // The default render endpoint in shared mode, interleaved float stereo at the graph's rate: the audio engine
  // converts to the mix format (AUTOCONVERTPCM). Event-driven: renderThread() fills what the device consumed.
  (void)preferredRate;
  closeWasapi();  // a reopen after the device was lost
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IMMDeviceEnumerator* en = nullptr; IMMDevice* dev = nullptr; IAudioClient* client = nullptr; IAudioRenderClient* render = nullptr;
  auto fail = [&](const char* what, HRESULT hr) { HOST_LOGE("audio: %s failed (0x%08lx)", what, (unsigned long)hr); if (render) render->Release(); if (client) client->Release(); if (dev) dev->Release(); if (en) en->Release(); return false; };
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (FAILED(hr)) return fail("MMDeviceEnumerator", hr);
  if (FAILED(hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev))) return fail("GetDefaultAudioEndpoint", hr);
  if (FAILED(hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client))) return fail("Activate", hr);
  WAVEFORMATEX fmt{}; fmt.wFormatTag = 3 /*WAVE_FORMAT_IEEE_FLOAT*/; fmt.nChannels = 2; fmt.nSamplesPerSec = (DWORD)graph_->sampleRate();
  fmt.wBitsPerSample = 32; fmt.nBlockAlign = 8; fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * 8;
  const REFERENCE_TIME period = 100000;  // 10 ms, in 100 ns units: the shared engine's own period
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, period, 0, &fmt, nullptr);
  if (FAILED(hr)) return fail("IAudioClient::Initialize", hr);
  HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(ev);
  UINT32 frames = 0; client->GetBufferSize(&frames);
  if (FAILED(hr = client->GetService(__uuidof(IAudioRenderClient), (void**)&render))) { CloseHandle(ev); return fail("GetService", hr); }
  dev->Release(); en->Release();
  client_ = client; render_ = render; event_ = ev; bufferFrames_ = frames;
  threadStop_.store(false); thread_ = std::thread([this] { renderThread(); });
  HOST_LOGI("audio: WASAPI shared, %.0f Hz, 2 ch, buffer %u frames", graph_->sampleRate(), frames);
  return true;
#elif defined(__linux__)
  // The PulseAudio client API (libpulse; PipeWire's pipewire-pulse serves it too): a threaded mainloop, one
  // playback stream of interleaved float stereo at the graph's rate, filled from its write callback. Started
  // corked; resume() uncorks. ~10 ms target latency, the server's own rate conversion.
  (void)preferredRate;
  closePulse();  // a reopen after the server went away
  pa_threaded_mainloop* ml = pa_threaded_mainloop_new();
  if (!ml) { HOST_LOGE("audio: pa_threaded_mainloop_new failed"); return false; }
  pa_context* ctx = pa_context_new(pa_threaded_mainloop_get_api(ml), "webxr-host");
  if (!ctx) { pa_threaded_mainloop_free(ml); HOST_LOGE("audio: pa_context_new failed"); return false; }
  paLoop_ = ml; paCtx_ = ctx;
  pa_context_set_state_callback(ctx, [](pa_context* c, void* ud) {
    auto* self = (RealtimeContext*)ud; pa_context_state_t st = pa_context_get_state(c);
    if ((st == PA_CONTEXT_FAILED || st == PA_CONTEXT_TERMINATED) && self->paStream_ && !self->closed_) self->needReopen_.store(true);
    pa_threaded_mainloop_signal((pa_threaded_mainloop*)self->paLoop_, 0); }, this);
  if (pa_context_connect(ctx, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) { HOST_LOGE("audio: no PulseAudio server (%s)", pa_strerror(pa_context_errno(ctx))); closePulse(); return false; }
  pa_threaded_mainloop_lock(ml);
  if (pa_threaded_mainloop_start(ml) < 0) { pa_threaded_mainloop_unlock(ml); HOST_LOGE("audio: mainloop start failed"); closePulse(); return false; }
  for (;;) {
    pa_context_state_t st = pa_context_get_state(ctx);
    if (st == PA_CONTEXT_READY) break;
    if (!PA_CONTEXT_IS_GOOD(st)) { HOST_LOGE("audio: PulseAudio connect failed (%s)", pa_strerror(pa_context_errno(ctx))); pa_threaded_mainloop_unlock(ml); closePulse(); return false; }
    pa_threaded_mainloop_wait(ml);
  }
  const pa_sample_spec ss{PA_SAMPLE_FLOAT32LE, (uint32_t)graph_->sampleRate(), 2};
  pa_stream* st = pa_stream_new(ctx, "WebAudio", &ss, nullptr);
  if (!st) { HOST_LOGE("audio: pa_stream_new failed (%s)", pa_strerror(pa_context_errno(ctx))); pa_threaded_mainloop_unlock(ml); closePulse(); return false; }
  paStream_ = st;
  pa_stream_set_state_callback(st, [](pa_stream* s, void* ud) {
    auto* self = (RealtimeContext*)ud; pa_stream_state_t ss = pa_stream_get_state(s);
    if ((ss == PA_STREAM_FAILED || ss == PA_STREAM_TERMINATED) && !self->closed_) self->needReopen_.store(true);
    pa_threaded_mainloop_signal((pa_threaded_mainloop*)self->paLoop_, 0); }, this);
  pa_stream_set_write_callback(st, [](pa_stream*, size_t bytes, void* ud) { ((RealtimeContext*)ud)->pulseWrite(bytes); }, this);
  const uint32_t tlength = (uint32_t)pa_usec_to_bytes(10000, &ss);
  const pa_buffer_attr attr{(uint32_t)-1, tlength, (uint32_t)-1, (uint32_t)-1, (uint32_t)-1};
  if (pa_stream_connect_playback(st, nullptr, &attr, (pa_stream_flags_t)(PA_STREAM_ADJUST_LATENCY | PA_STREAM_START_CORKED), nullptr, nullptr) < 0) {
    HOST_LOGE("audio: connect_playback failed (%s)", pa_strerror(pa_context_errno(ctx))); pa_threaded_mainloop_unlock(ml); closePulse(); return false; }
  for (;;) {
    pa_stream_state_t s2 = pa_stream_get_state(st);
    if (s2 == PA_STREAM_READY) break;
    if (!PA_STREAM_IS_GOOD(s2)) { HOST_LOGE("audio: stream failed (%s)", pa_strerror(pa_context_errno(ctx))); pa_threaded_mainloop_unlock(ml); closePulse(); return false; }
    pa_threaded_mainloop_wait(ml);
  }
  const pa_buffer_attr* got = pa_stream_get_buffer_attr(st);
  HOST_LOGI("audio: PulseAudio %s, %u Hz, 2 ch, tlength %u frames", pa_context_get_server(ctx) ? pa_context_get_server(ctx) : "(default server)", ss.rate, got ? got->tlength / 8 : 0);
  pa_threaded_mainloop_unlock(ml);
  return true;
#else
  (void)preferredRate; return false;
#endif
}

#if defined(__linux__) && !defined(__ANDROID__)
void RealtimeContext::pulseWrite(size_t bytes) {
  auto* st = (pa_stream*)paStream_;
  void* data = nullptr; size_t n = bytes;
  if (pa_stream_begin_write(st, &data, &n) < 0 || !data) return;
  const int32_t frames = (int32_t)(n / 8);
  if (running_.load() && !paused_.load()) renderInto((float*)data, frames);
  else memset(data, 0, (size_t)frames * 8);
  pa_stream_write(st, data, (size_t)frames * 8, nullptr, 0, PA_SEEK_RELATIVE);
}

void RealtimeContext::corkPulse(bool cork) {
  auto* ml = (pa_threaded_mainloop*)paLoop_;
  pa_threaded_mainloop_lock(ml);
  if (pa_operation* op = pa_stream_cork((pa_stream*)paStream_, cork ? 1 : 0, nullptr, nullptr)) pa_operation_unref(op);
  pa_threaded_mainloop_unlock(ml);
}

void RealtimeContext::closePulse() {
  auto* ml = (pa_threaded_mainloop*)paLoop_;
  if (!ml) return;
  pa_threaded_mainloop_stop(ml);  // the callbacks are out once this returns (it joins the mainloop thread)
  if (paStream_) { pa_stream_disconnect((pa_stream*)paStream_); pa_stream_unref((pa_stream*)paStream_); paStream_ = nullptr; }
  if (paCtx_) { pa_context_disconnect((pa_context*)paCtx_); pa_context_unref((pa_context*)paCtx_); paCtx_ = nullptr; }
  pa_threaded_mainloop_free(ml); paLoop_ = nullptr;
}
#endif

#ifdef _WIN32
void RealtimeContext::closeWasapi() {
  threadStop_.store(true); if (thread_.joinable()) thread_.join();
  if (client_) { ((IAudioClient*)client_)->Stop(); }
  if (render_) { ((IAudioRenderClient*)render_)->Release(); render_ = nullptr; }
  if (client_) { ((IAudioClient*)client_)->Release(); client_ = nullptr; }
  if (event_) { CloseHandle((HANDLE)event_); event_ = nullptr; }
}

void RealtimeContext::renderThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
  auto* client = (IAudioClient*)client_; auto* render = (IAudioRenderClient*)render_;
  while (!threadStop_.load()) {
    // A lost device stops signalling: the timeout asks the client too, which then reports it invalidated.
    const bool signalled = WaitForSingleObject((HANDLE)event_, 200) == WAIT_OBJECT_0;
    UINT32 padding = 0; HRESULT hr = client->GetCurrentPadding(&padding);
    if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { HOST_LOGW("audio: device lost"); needReopen_.store(true); break; }
    if (FAILED(hr) || !signalled) continue;
    const UINT32 n = bufferFrames_ - padding; if (!n) continue;
    BYTE* data = nullptr; if (FAILED(render->GetBuffer(n, &data))) continue;
    if (running_.load()) { renderInto((float*)data, (int32_t)n); render->ReleaseBuffer(n, 0); }
    else render->ReleaseBuffer(n, AUDCLNT_BUFFERFLAGS_SILENT);
  }
  CoUninitialize();
}
#endif

bool RealtimeContext::issue(const Command& c) {
  if (closed_) return false;
  if (!hasDevice_ || paused_.load()) {  // no stream, or its unit stopped (pauseOutput): no callback drains the queue, so this thread does, in order
    Command q; while (cmds_.pop(q)) graph_->apply(q);
    graph_->apply(c); return true;
  }
  if (cmds_.push(c)) return true;
  // Full: the callback drains every ~2.7 ms. Wait briefly rather than lose an edit.
  for (int i = 0; i < 200; i++) { std::this_thread::sleep_for(std::chrono::microseconds(100)); if (cmds_.push(c)) return true; }
  dropped_++; HOST_LOGW("audio: command queue full, dropped op %d", (int)c.op);
  return false;
}

bool RealtimeContext::resume() {
#ifdef __ANDROID__
  if (!stream_) return false;
  oboe::Result r = stream_->requestStart();
  if (r != oboe::Result::OK) { HOST_LOGW("audio: requestStart: %s", oboe::convertToText(r)); return false; }
  running_.store(true); return true;
#elif defined(__APPLE__)
  if (!unit_ || AudioOutputUnitStart((AudioComponentInstance)unit_) != noErr) return false;
  running_.store(true); return true;
#elif defined(_WIN32)
  if (!client_) return false;
  if (HRESULT hr = ((IAudioClient*)client_)->Start(); FAILED(hr)) { if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { running_.store(true); needReopen_.store(true); } return false; }  // reopened (and restarted) by tick()
  running_.store(true); return true;
#elif defined(__linux__)
  if (!paStream_) return false;
  running_.store(true); if (!paused_.load()) corkPulse(false); return true;
#else
  return false;
#endif
}
bool RealtimeContext::suspend() {
#ifdef __ANDROID__
  if (!stream_) return false;
  stream_->requestPause(); running_.store(false); return true;
#elif defined(__APPLE__)
  if (!unit_) return false;
  AudioOutputUnitStop((AudioComponentInstance)unit_); running_.store(false); return true;
#elif defined(_WIN32)
  if (!client_) return false;
  ((IAudioClient*)client_)->Stop(); running_.store(false); return true;
#elif defined(__linux__)
  if (!paStream_) return false;
  corkPulse(true); running_.store(false); return true;
#else
  return false;
#endif
}
void RealtimeContext::close() {
  if (closed_) return;
  closed_ = true; running_.store(false);
  for (size_t i = 0; i < g_live.size(); ++i) if (g_live[i] == this) { g_live.erase(g_live.begin() + (long)i); break; }
#ifdef __ANDROID__
  if (stream_) { stream_->stop(); stream_->close(); stream_.reset(); }
#elif defined(__APPLE__)
  if (unit_) { AudioOutputUnitStop((AudioComponentInstance)unit_); AudioUnitUninitialize((AudioComponentInstance)unit_); AudioComponentInstanceDispose((AudioComponentInstance)unit_); unit_ = nullptr; }
#elif defined(_WIN32)
  closeWasapi();
#elif defined(__linux__)
  closePulse();
#endif
  // The callback thread is gone: anything still queued is applied here so buffers it holds are released in order.
  Command c; while (cmds_.pop(c)) graph_->apply(c);
}

void RealtimeContext::tick() {
  if (needReopen_.exchange(false) && !closed_) {
    HOST_LOGI("audio: reopening stream after device error");
    hasDevice_ = openStream(preferredRate_);
    if (hasDevice_ && running_.load()) resume();
  }
}

void RealtimeContext::renderInto(float* out, int32_t numFrames) {
  const uint32_t mask = RING_FRAMES - 1;
  for (int32_t i = 0; i < numFrames; i++) {
    if (ringR_ == ringW_) {
      Command c; while (cmds_.pop(c)) graph_->apply(c);  // quantum boundary
      graph_->render();
      const float* l = graph_->destOut(0); const float* r = graph_->destOut(1);
      for (int k = 0; k < QUANTUM; k++) { uint32_t w = (ringW_ + k) & mask; ring_[w * 2] = l[k]; ring_[w * 2 + 1] = r[k]; }
      ringW_ += QUANTUM;
    }
    uint32_t rd = ringR_ & mask; out[i * 2] = ring_[rd * 2]; out[i * 2 + 1] = ring_[rd * 2 + 1]; ringR_++;
  }
}

#ifdef __ANDROID__
oboe::DataCallbackResult RealtimeContext::onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) {
  (void)stream;
  inRender_.store(1);  // before reading paused_ (both seq_cst): pauseOutput either sees this or we see its paused_
  if (paused_.load()) memset(audioData, 0, (size_t)numFrames * 2 * sizeof(float));  // the stream is stereo float (create())
  else renderInto((float*)audioData, numFrames);
  inRender_.store(0);
  return oboe::DataCallbackResult::Continue;
}
void RealtimeContext::onErrorAfterClose(oboe::AudioStream*, oboe::Result error) {
  HOST_LOGW("audio: stream error %s", oboe::convertToText(error));
  needReopen_.store(true);
}
#endif

}  // namespace audio
}  // namespace host
