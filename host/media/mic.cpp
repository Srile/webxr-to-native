// Microphone capture (WP-25): the shared device and its tracks (see mic.h). The platform capture is Capture
// below: an Oboe input stream (Android), a CoreAudio HAL input unit (mac), a PulseAudio record stream (Linux).
// Its callback only writes the ring: no lock, no allocation.
#include "media/mic.h"
#include <cmath>
#include <cstring>
#include "core/log.h"
#include "core/loop.h"
#ifdef __ANDROID__
#include <oboe/Oboe.h>
#elif defined(__APPLE__)
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#elif defined(__linux__)
#include <pulse/pulseaudio.h>
#endif

namespace host {
namespace media {

class Capture
#ifdef __ANDROID__
    : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback
#endif
{
 public:
  Capture(audio::CaptureRing& ring, double toneHz) : ring_(ring), toneHz_(toneHz) {}
  ~Capture() { close(); }
  // Opens and starts the default input; *actual is what its processing really is.
  bool open(const Processing& want, Processing* actual, std::string* label, const char** preset, std::string* err);
  void close();
  bool failed() const { return failed_.load(); }
  bool defaultChanged() { return changed_.exchange(false); }
  static std::string defaultLabel();

 private:
  // The capture callback's samples into the ring; with host.json debug.micTone, a tone at that frequency (0.25 of
  // full scale) in their place, at the callback's own pace (for checking the path where the microphone gives
  // silence: a MacBook with its lid closed cuts its microphone off).
  void deliver(const float* x, uint32_t n) {
    if (toneHz_ <= 0) { ring_.write(x, n); return; }
    const double step = toneHz_ / ring_.rate();
    while (n) {
      const uint32_t k = n < kToneChunk ? n : kToneChunk;
      for (uint32_t i = 0; i < k; i++) { tone_[i] = 0.25f * (float)std::sin(6.283185307179586 * phase_); phase_ += step; phase_ -= (double)(int64_t)phase_; }
      ring_.write(tone_, k); n -= k;
    }
  }
  audio::CaptureRing& ring_;
  double toneHz_, phase_ = 0;
  static constexpr uint32_t kToneChunk = 1024;
  float tone_[kToneChunk];
  std::atomic<bool> failed_{false}, changed_{false};
#ifdef __ANDROID__
 public:
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream*, void* data, int32_t n) override {
    deliver((const float*)data, (uint32_t)n); return oboe::DataCallbackResult::Continue;
  }
  void onErrorAfterClose(oboe::AudioStream*, oboe::Result r) override { HOST_LOGW("mic: input stream error %s", oboe::convertToText(r)); failed_.store(true); }
 private:
  std::shared_ptr<oboe::AudioStream> stream_;
#elif defined(__APPLE__)
  static OSStatus input(void* self, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* ts, UInt32 bus, UInt32 frames, AudioBufferList*);
  static OSStatus property(AudioObjectID, UInt32 n, const AudioObjectPropertyAddress* a, void* self);
  AudioComponentInstance unit_ = nullptr; AudioDeviceID dev_ = 0; float* buf_ = nullptr; UInt32 maxFrames_ = 0; bool listening_ = false;
#elif defined(__linux__)
  void* paLoop_ = nullptr; void* paCtx_ = nullptr; void* paStream_ = nullptr;
#endif
};

#ifdef __ANDROID__
bool Capture::open(const Processing& want, Processing* actual, std::string* label, const char** preset, std::string* err) {
  // The processing constraints as an input preset: what Android's capture path applies for each (the AEC, NS and
  // AGC effects come with VoiceCommunication on the devices that have them).
  oboe::InputPreset p = want.echoCancellation ? oboe::InputPreset::VoiceCommunication
                      : (want.noiseSuppression || want.autoGainControl) ? oboe::InputPreset::VoiceRecognition : oboe::InputPreset::Unprocessed;
  for (int attempt = 0; attempt < 2; attempt++) {
    oboe::AudioStreamBuilder b;
    b.setDirection(oboe::Direction::Input)->setPerformanceMode(oboe::PerformanceMode::LowLatency)->setSharingMode(oboe::SharingMode::Shared)
     ->setFormat(oboe::AudioFormat::Float)->setChannelCount(1)->setInputPreset(p)->setFormatConversionAllowed(true)->setChannelConversionAllowed(true)
     ->setDataCallback(this)->setErrorCallback(this);
    oboe::Result r = b.openStream(stream_);
    if (r == oboe::Result::OK) break;
    stream_.reset();
    if (p == oboe::InputPreset::Unprocessed) { HOST_LOGW("mic: Unprocessed input refused (%s); VoiceRecognition instead", oboe::convertToText(r)); p = oboe::InputPreset::VoiceRecognition; continue; }
    *err = std::string("NotReadableError: the microphone could not be opened (") + oboe::convertToText(r) + ")"; return false;
  }
  if (!stream_) { *err = "NotReadableError: the microphone could not be opened"; return false; }
  ring_.setRate(stream_->getSampleRate()); failed_.store(false);
  oboe::Result r = stream_->requestStart();
  if (r != oboe::Result::OK) { *err = std::string("NotReadableError: the microphone did not start (") + oboe::convertToText(r) + ")"; stream_->close(); stream_.reset(); return false; }
  *preset = p == oboe::InputPreset::VoiceCommunication ? "VoiceCommunication" : p == oboe::InputPreset::VoiceRecognition ? "VoiceRecognition" : "Unprocessed";
  actual->echoCancellation = p == oboe::InputPreset::VoiceCommunication;
  actual->noiseSuppression = actual->autoGainControl = p != oboe::InputPreset::Unprocessed;
  *label = "Default";
  HOST_LOGI("mic: Oboe input %d Hz, %d ch, burst %d, %s, preset %s", stream_->getSampleRate(), stream_->getChannelCount(), stream_->getFramesPerBurst(),
            stream_->getAudioApi() == oboe::AudioApi::AAudio ? "AAudio" : "OpenSLES", *preset);
  return true;
}
void Capture::close() { if (stream_) { stream_->stop(); stream_->close(); stream_.reset(); } }
std::string Capture::defaultLabel() { return "Default"; }

#elif defined(__APPLE__)
namespace {
const AudioObjectPropertyAddress kDefaultInput{kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
const AudioObjectPropertyAddress kAlive{kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
AudioDeviceID defaultInput() {
  AudioDeviceID dev = 0; UInt32 sz = sizeof dev;
  return AudioObjectGetPropertyData(kAudioObjectSystemObject, &kDefaultInput, 0, nullptr, &sz, &dev) == noErr ? dev : 0;
}
std::string deviceName(AudioDeviceID dev) {
  const AudioObjectPropertyAddress a{kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  CFStringRef s = nullptr; UInt32 sz = sizeof s; char buf[256] = {};
  if (AudioObjectGetPropertyData(dev, &a, 0, nullptr, &sz, &s) != noErr || !s) return "Default";
  CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8); CFRelease(s);
  return buf;
}
}  // namespace
OSStatus Capture::input(void* self, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* ts, UInt32 bus, UInt32 frames, AudioBufferList*) {
  auto* c = (Capture*)self;
  if (frames > c->maxFrames_) frames = c->maxFrames_;
  AudioBufferList abl; abl.mNumberBuffers = 1; abl.mBuffers[0].mNumberChannels = 1; abl.mBuffers[0].mDataByteSize = frames * 4; abl.mBuffers[0].mData = c->buf_;
  const OSStatus r = AudioUnitRender(c->unit_, flags, ts, bus, frames, &abl);
  if (r == noErr) c->deliver(c->buf_, frames);
  return r;
}
OSStatus Capture::property(AudioObjectID, UInt32 n, const AudioObjectPropertyAddress* a, void* self) {
  auto* c = (Capture*)self;
  for (UInt32 i = 0; i < n; i++) {
    if (a[i].mSelector == kAudioHardwarePropertyDefaultInputDevice) c->changed_.store(true);
    else if (a[i].mSelector == kAudioDevicePropertyDeviceIsAlive) c->failed_.store(true);
  }
  return noErr;
}
bool Capture::open(const Processing&, Processing* actual, std::string* label, const char** preset, std::string* err) {
  dev_ = defaultInput();
  if (!dev_) { *err = "NotFoundError: no input device"; return false; }
  AudioComponentDescription desc{kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
  if (!comp || AudioComponentInstanceNew(comp, &unit_) != noErr) { unit_ = nullptr; *err = "NotReadableError: no HAL input unit"; return false; }
  auto fail = [&](const char* what, OSStatus s) { *err = std::string("NotReadableError: ") + what + " failed (" + std::to_string((int)s) + ")"; close(); return false; };
  UInt32 on = 1, off = 0; OSStatus s;
  if ((s = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, sizeof on)) != noErr) return fail("EnableIO input", s);
  if ((s = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, sizeof off)) != noErr) return fail("EnableIO output", s);
  if ((s = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev_, sizeof dev_)) != noErr) return fail("CurrentDevice", s);
  // The unit converts format and channels but not the rate: the client side runs at the device's.
  AudioStreamBasicDescription hw{}; UInt32 sz = sizeof hw;
  if ((s = AudioUnitGetProperty(unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &sz)) != noErr || hw.mSampleRate <= 0) return fail("device format", s);
  AudioStreamBasicDescription fmt{};
  fmt.mSampleRate = hw.mSampleRate; fmt.mFormatID = kAudioFormatLinearPCM; fmt.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  fmt.mChannelsPerFrame = 1; fmt.mBitsPerChannel = 32; fmt.mFramesPerPacket = 1; fmt.mBytesPerFrame = fmt.mBytesPerPacket = 4;
  if ((s = AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &fmt, sizeof fmt)) != noErr) return fail("client format", s);
  maxFrames_ = 4096; sz = sizeof maxFrames_;
  AudioUnitGetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames_, &sz);
  buf_ = new float[maxFrames_];
  AURenderCallbackStruct cb{&Capture::input, this};
  if ((s = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, sizeof cb)) != noErr) return fail("input callback", s);
  if ((s = AudioUnitInitialize(unit_)) != noErr) return fail("AudioUnitInitialize", s);
  ring_.setRate(hw.mSampleRate); failed_.store(false); changed_.store(false);
  if ((s = AudioOutputUnitStart(unit_)) != noErr) return fail("AudioOutputUnitStart", s);
  AudioObjectAddPropertyListener(kAudioObjectSystemObject, &kDefaultInput, &Capture::property, this);
  AudioObjectAddPropertyListener(dev_, &kAlive, &Capture::property, this);
  listening_ = true;
  *actual = Processing{false, false, false}; *preset = "none"; *label = deviceName(dev_);
  HOST_LOGI("mic: CoreAudio input \"%s\", %.0f Hz (device %u ch), max %u frames per callback", label->c_str(), hw.mSampleRate, (unsigned)hw.mChannelsPerFrame, (unsigned)maxFrames_);
  return true;
}
void Capture::close() {
  if (listening_) {
    AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &kDefaultInput, &Capture::property, this);
    AudioObjectRemovePropertyListener(dev_, &kAlive, &Capture::property, this);
    listening_ = false;
  }
  if (unit_) { AudioOutputUnitStop(unit_); AudioUnitUninitialize(unit_); AudioComponentInstanceDispose(unit_); unit_ = nullptr; }  // Stop returns once the callback is out
  delete[] buf_; buf_ = nullptr;
}
std::string Capture::defaultLabel() { AudioDeviceID d = defaultInput(); return d ? deviceName(d) : "Default"; }

#elif defined(__linux__)
bool Capture::open(const Processing&, Processing* actual, std::string* label, const char** preset, std::string* err) {
  // As the output (audio/device.cpp): a threaded mainloop, here with one record stream of mono float at 48 kHz
  // (the server converts from the source), ~10 ms fragments, read from its read callback.
  pa_threaded_mainloop* ml = pa_threaded_mainloop_new();
  if (!ml) { *err = "NotReadableError: pa_threaded_mainloop_new failed"; return false; }
  pa_context* ctx = pa_context_new(pa_threaded_mainloop_get_api(ml), "webxr-host microphone");
  paLoop_ = ml; paCtx_ = ctx;
  if (!ctx) { *err = "NotReadableError: pa_context_new failed"; close(); return false; }
  pa_context_set_state_callback(ctx, [](pa_context* c, void* ud) {
    auto* self = (Capture*)ud; pa_context_state_t st = pa_context_get_state(c);
    if (st == PA_CONTEXT_FAILED || st == PA_CONTEXT_TERMINATED) self->failed_.store(true);
    pa_threaded_mainloop_signal((pa_threaded_mainloop*)self->paLoop_, 0); }, this);
  if (pa_context_connect(ctx, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) { *err = "NotFoundError: no PulseAudio server"; close(); return false; }
  pa_threaded_mainloop_lock(ml);
  auto fail = [&](const std::string& what) { *err = what; pa_threaded_mainloop_unlock(ml); close(); return false; };
  if (pa_threaded_mainloop_start(ml) < 0) return fail("NotReadableError: mainloop start failed");
  for (;;) {
    pa_context_state_t st = pa_context_get_state(ctx);
    if (st == PA_CONTEXT_READY) break;
    if (!PA_CONTEXT_IS_GOOD(st)) return fail(std::string("NotFoundError: PulseAudio connect failed (") + pa_strerror(pa_context_errno(ctx)) + ")");
    pa_threaded_mainloop_wait(ml);
  }
  const pa_sample_spec ss{PA_SAMPLE_FLOAT32LE, 48000, 1};
  pa_stream* st = pa_stream_new(ctx, "Microphone", &ss, nullptr);
  if (!st) return fail("NotReadableError: pa_stream_new failed");
  paStream_ = st;
  pa_stream_set_state_callback(st, [](pa_stream* s, void* ud) {
    auto* self = (Capture*)ud; pa_stream_state_t ss = pa_stream_get_state(s);
    if (ss == PA_STREAM_FAILED || ss == PA_STREAM_TERMINATED) self->failed_.store(true);
    pa_threaded_mainloop_signal((pa_threaded_mainloop*)self->paLoop_, 0); }, this);
  pa_stream_set_read_callback(st, [](pa_stream* s, size_t, void* ud) {
    auto* self = (Capture*)ud;
    while (pa_stream_readable_size(s) > 0) {
      const void* d = nullptr; size_t n = 0;
      if (pa_stream_peek(s, &d, &n) < 0 || n == 0) return;
      if (d) self->deliver((const float*)d, (uint32_t)(n / 4)); else self->ring_.writeSilence((uint32_t)(n / 4));  // a hole
      pa_stream_drop(s);
    }
  }, this);
  const pa_buffer_attr attr{(uint32_t)-1, (uint32_t)-1, (uint32_t)-1, (uint32_t)-1, (uint32_t)pa_usec_to_bytes(10000, &ss)};
  ring_.setRate(48000); failed_.store(false);
  if (pa_stream_connect_record(st, nullptr, &attr, PA_STREAM_ADJUST_LATENCY) < 0) return fail(std::string("NotReadableError: connect_record failed (") + pa_strerror(pa_context_errno(ctx)) + ")");
  for (;;) {
    pa_stream_state_t s2 = pa_stream_get_state(st);
    if (s2 == PA_STREAM_READY) break;
    if (!PA_STREAM_IS_GOOD(s2)) return fail(std::string("NotFoundError: record stream failed (") + pa_strerror(pa_context_errno(ctx)) + ")");
    pa_threaded_mainloop_wait(ml);
  }
  const char* dev = pa_stream_get_device_name(st);
  *label = dev ? dev : "Default";
  pa_threaded_mainloop_unlock(ml);
  *actual = Processing{false, false, false}; *preset = "none";
  HOST_LOGI("mic: PulseAudio record \"%s\", 48000 Hz, 1 ch", label->c_str());
  return true;
}
void Capture::close() {
  auto* ml = (pa_threaded_mainloop*)paLoop_;
  if (!ml) return;
  pa_threaded_mainloop_stop(ml);  // joins the mainloop thread: no callback after this
  if (paStream_) { pa_stream_disconnect((pa_stream*)paStream_); pa_stream_unref((pa_stream*)paStream_); paStream_ = nullptr; }
  if (paCtx_) { pa_context_disconnect((pa_context*)paCtx_); pa_context_unref((pa_context*)paCtx_); paCtx_ = nullptr; }
  pa_threaded_mainloop_free(ml); paLoop_ = nullptr;
}
std::string Capture::defaultLabel() { return "Default"; }

#else
bool Capture::open(const Processing&, Processing*, std::string*, const char**, std::string* err) { *err = "NotFoundError: no microphone capture on this platform"; return false; }
void Capture::close() {}
std::string Capture::defaultLabel() { return ""; }
#endif

// ---- Mic: the tracks over the one device -------------------------------------------------------------------

Mic& Mic::get() { static Mic* m = new Mic(); return *m; }  // never destroyed: render threads may still read its ring
Mic::Mic() : ring_(new audio::CaptureRing()) {}
double Mic::rate() const { return ring_->rate(); }
std::string Mic::defaultLabel() { return Capture::defaultLabel(); }

uint32_t Mic::open(const Processing& want, std::string* err) {
  if (live_ == 0) {
    if (!dev_) dev_ = std::make_unique<Capture>(*ring_, toneHz_);
    want_ = want;
    if (!dev_->open(want, &actual_, &label_, &preset_, err)) { dev_.reset(); return 0; }
    opens_++;
    if (loop_ && !timer_) timer_ = loop_->setTimer(250, true, [this] { watch(); });
  }
  const uint32_t id = nextId_++;
  tracks_[id] = new MicTrack(id, ring_);
  live_++;
  HOST_LOGI("mic: track %u live (%d live)", id, live_);
  return id;
}

void Mic::stop(uint32_t id) {
  if (auto r = remotes_.find(id); r != remotes_.end()) { r->second->ended.store(true); return; }
  auto it = tracks_.find(id);
  if (it == tracks_.end() || it->second->ended.load()) return;
  it->second->ended.store(true);
  if (--live_ == 0) closeDevice("the last track stopped");
  else HOST_LOGI("mic: track %u stopped (%d live)", id, live_);
}

uint32_t Mic::addRemote(RemoteTrack* t) {
  t->ref();
  const uint32_t id = nextRemote_++;
  remotes_[id] = t;
  return id;
}

void Mic::release(uint32_t id) {
  if (auto r = remotes_.find(id); r != remotes_.end()) { r->second->ended.store(true); r->second->unref(); remotes_.erase(r); return; }
  stop(id);
  auto it = tracks_.find(id); if (it == tracks_.end()) return;
  it->second->unref(); tracks_.erase(it);
}

bool Mic::setEnabled(uint32_t id, bool on) {
  if (auto r = remotes_.find(id); r != remotes_.end()) { r->second->enabled.store(on); return true; }
  auto it = tracks_.find(id); if (it == tracks_.end()) return false;
  it->second->enabled.store(on); return true;
}

audio::LiveInput* Mic::input(uint32_t id) {
  if (auto r = remotes_.find(id); r != remotes_.end()) {
    if (r->second->ended.load()) return nullptr;
    r->second->ref(); return r->second;
  }
  auto it = tracks_.find(id);
  if (it == tracks_.end() || it->second->ended.load()) return nullptr;
  it->second->ref(); return it->second;
}

void Mic::closeDevice(const char* why) {
  if (dev_) dev_->close();
  dev_.reset();
  if (timer_ && loop_) { loop_->clearTimer(timer_); timer_ = 0; }
  HOST_LOGI("mic: capture closed, device released (%s); %u underruns, %u overruns", why, ring_->underruns(), ring_->overruns());
}

// The open device's health: a lost device (unplugged, the server gone, a stream error) or a new default input is
// opened again with the same processing; if it cannot be, every live track ends (their 'ended' event), as a
// browser ends tracks whose device went away.
void Mic::watch() {
  if (!dev_ || live_ == 0) return;
  const bool changed = dev_->defaultChanged();
  if (!dev_->failed() && !changed) return;
  HOST_LOGW("mic: %s; reopening", changed ? "the default input changed" : "the input device failed");
  dev_->close();
  std::string err;
  if (dev_->open(want_, &actual_, &label_, &preset_, &err)) { opens_++; if (changed && onEvent) onEvent("devicechange", 0); return; }
  HOST_LOGE("mic: reopen failed (%s): the tracks end", err.c_str());
  for (auto& [tid, t] : tracks_) if (!t->ended.load()) { t->ended.store(true); if (onEvent) onEvent("ended", tid); }
  live_ = 0;
  closeDevice("the device was lost");
}

}  // namespace media
}  // namespace host
