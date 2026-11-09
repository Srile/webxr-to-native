#pragma once
// WebAudio graph, rendered in 128-frame quanta (WP-08). Pure DSP: no V8, no
// Oboe, no allocation inside render(). The nodes WebXR games' audio code
// builds: Destination, Gain, BufferSource, Oscillator,
// BiquadFilter, DynamicsCompressor, Panner, plus the AudioListener's params.
//
// Ownership model
//   Nodes live in CHUNKS (arrays of Node) that the OWNER allocates on its own
//   thread and hands to the graph (addNodeChunk); the owner also hands out
//   slot numbers. Edges live in chunks the same way, but the graph keeps the
//   edge free list itself (it removes edges when nodes end or are freed).
//   The realtime context drives every edit through a Command queue applied
//   at quantum boundaries (device.cpp); the offline context calls the same
//   methods directly before rendering (offline.cpp).
//   A node is FREED by the graph (Msg::Freed back to the owner) once JS has
//   released its wrapper AND it can never sound again: a source that has
//   ended or never started, or a processing node with no incoming edges.
//   A source that ends drops its outgoing edges, which cascades.
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace host {
namespace audio {

constexpr int QUANTUM = 128;
constexpr int MAX_CH = 2;
constexpr int MAX_PARAMS = 6;
constexpr int LISTENER_PARAMS = 9;
constexpr int MAX_EVENTS = 16;
constexpr int MAX_CHUNKS = 64;
constexpr uint32_t NONE = 0xFFFFFFFFu;
// Pseudo slot addressing the listener's params through setParam/schedule.
constexpr uint32_t LISTENER_SLOT = 0xFFFFFFFEu;

enum class Kind : uint8_t { None, Destination, Gain, BufferSource, Oscillator, Biquad, Compressor, Panner, Listener };
enum class EvType : uint8_t { SetValue, LinearRamp, ExpRamp, SetTarget };
enum Prop : uint8_t {
  P_Type, P_Loop, P_LoopStart, P_LoopEnd, P_PanningModel, P_DistanceModel, P_RefDistance,
  P_RolloffFactor, P_MaxDistance, P_ConeInner, P_ConeOuter, P_ConeOuterGain, P_Count
};
enum Wave : uint8_t { W_Sine, W_Square, W_Sawtooth, W_Triangle };
enum Filter : uint8_t { F_Lowpass, F_Highpass, F_Bandpass, F_Lowshelf, F_Highshelf, F_Peaking, F_Notch, F_Allpass };
enum Distance : uint8_t { D_Inverse, D_Linear, D_Exponential };

Kind kindFromString(const char* s);
int paramIndex(Kind k, const char* name);     // -1 if the kind has no such AudioParam
int propIndex(const char* name);              // -1 if unknown
int enumValue(Prop p, const char* s);         // string props (type, models) → enum, -1 if unknown

// PCM, planar float, refcounted across the JS wrapper, the aliasing
// Float32Arrays and every node that holds it. Freed on the last unref,
// whichever thread that happens on.
struct AudioBufferData {
  std::atomic<int> refs{1};
  int channels = 0; uint32_t length = 0; double sampleRate = 0; float* data = nullptr;
  static AudioBufferData* create(int channels, uint32_t length, double rate);
  float* ch(int i) const { return data + (size_t)i * length; }
  void ref() { refs.fetch_add(1, std::memory_order_relaxed); }
  void unref();
  // Where sample memory comes from: the heap, unless the JS engine wants the ArrayBuffers that alias it
  // (getChannelData) inside its own allocation: V8's sandbox, which audio_bind.cpp then plugs in here.
  static void* (*allocSamples)(size_t bytes);
  static void (*freeSamples)(void* p, size_t bytes);
 private:
  AudioBufferData() = default; ~AudioBufferData();
};

struct ParamEvent { EvType type; float value; float timeConstant; float startValue; double time; };

// The spec's automation timeline over a fixed event array. Times are seconds
// on the context clock; the owner clamps them to >= now before inserting.
struct AudioParam {
  float base = 0, defaultValue = 0, minV = -INFINITY, maxV = INFINITY;
  std::atomic<float> published{0};  // last computed value, read by the host (AudioParam.value)
  int n = 0; ParamEvent ev[MAX_EVENTS];
  bool hasInput = false;            // a node→param connection summed something this quantum
  uint32_t dropped = 0;

  void reset(float def, float lo, float hi);
  void setValueNow(float v, double now);  // the .value setter: base + setValueAtTime(v, now)
  void insert(EvType type, float value, double time, float tc, double now);
  void cancel(double t);
  void cancelHold(double t);
  void prune(double now);
  float valueAt(double t) const;
  // a-rate: n values from t0 step dt (+ the param input scratch when hasInput). Publishes out[n-1].
  void fill(float* out, int count, double t0, double dt, const float* input);
  // k-rate: the value at t0 (+ input[0]). Publishes it.
  float k(double t0, const float* input);
  bool constant() const { return n == 0 && !hasInput; }
 private:
  float segmentEnd(int i, double t) const;
  void refreshStarts(int from);
  float clampv(float v) const { return v < minV ? minV : (v > maxV ? maxV : v); }
};

struct Edge { uint32_t from = NONE, to = NONE, nextIn = NONE, nextOut = NONE; int16_t param = -1; bool used = false; };

struct Node {
  Kind kind = Kind::None; bool used = false, releasedByJs = false, visiting = false;
  uint32_t stamp = 0, inHead = NONE, outHead = NONE;
  int outCh = 0;                      // channels produced this quantum (0 = silent, skip)
  float out[MAX_CH][QUANTUM];
  float in[MAX_CH][QUANTUM];
  AudioParam params[MAX_PARAMS];
  // scheduled sources
  bool started = false, ended = false, posInit = false, detachPending = false;
  int64_t startFrame = 0, stopFrame = INT64_MAX;
  double offset = 0;
  // buffer source
  AudioBufferData* buffer = nullptr; bool loop = false; double loopStart = 0, loopEnd = 0, pos = 0;
  // oscillator
  uint8_t wave = W_Sine; double phase = 0;
  // biquad
  uint8_t filter = F_Lowpass; double z1[MAX_CH] = {0, 0}, z2[MAX_CH] = {0, 0};
  // compressor
  float env = 0; std::atomic<float> reduction{0};
  // panner
  uint8_t panningModel = 0, distanceModel = D_Inverse;
  float refDistance = 1, rolloff = 1, maxDistance = 10000, coneInner = 360, coneOuter = 360, coneOuterGain = 0;
  bool isSource() const { return kind == Kind::BufferSource || kind == Kind::Oscillator; }
};

enum class Op : uint8_t {
  AddNodeChunk, AddEdgeChunk, CreateNode, ReleaseNode, Connect, ConnectParam, Disconnect, DisconnectParam,
  SetProp, SetParam, Schedule, Cancel, CancelHold, Start, Stop, SetBuffer
};
struct Command {
  Op op = Op::CreateNode; uint8_t kind = 0, evType = 0, prop = 0; int16_t param = -1;
  uint32_t a = 0, b = 0, count = 0; double t = 0, v = 0, v2 = 0; void* ptr = nullptr;
};
struct Msg { enum Type : uint8_t { Ended, Freed, ReleaseBuffer } type; uint32_t slot; void* ptr; };

// Single-producer single-consumer ring (power-of-two capacity, fixed at construction).
template <typename T> class Ring {
 public:
  explicit Ring(uint32_t capacityPow2) : cap_(capacityPow2), buf_(new T[capacityPow2]) {}
  ~Ring() { delete[] buf_; }
  Ring(const Ring&) = delete; Ring& operator=(const Ring&) = delete;
  bool push(const T& v) {
    uint32_t w = w_.load(std::memory_order_relaxed), r = r_.load(std::memory_order_acquire);
    if (w - r >= cap_) return false;
    buf_[w & (cap_ - 1)] = v; w_.store(w + 1, std::memory_order_release); return true;
  }
  bool pop(T& v) {
    uint32_t r = r_.load(std::memory_order_relaxed), w = w_.load(std::memory_order_acquire);
    if (r == w) return false;
    v = buf_[r & (cap_ - 1)]; r_.store(r + 1, std::memory_order_release); return true;
  }
  uint32_t size() const { return w_.load(std::memory_order_acquire) - r_.load(std::memory_order_acquire); }
  uint32_t capacity() const { return cap_; }
 private:
  uint32_t cap_; T* buf_; std::atomic<uint32_t> w_{0}, r_{0};
};

class Graph {
 public:
  Graph(double sampleRate, int outChannels, uint32_t chunkSize, uint32_t msgCapacityPow2);
  ~Graph();
  double sampleRate() const { return rate_; }
  int outChannels() const { return outCh_; }
  uint32_t chunkSize() const { return chunkSize_; }
  uint64_t frames() const { return frames_.load(std::memory_order_acquire); }
  double now() const { return (double)frames() / rate_; }

  // Storage (chunks are owned by the graph once handed over; freed in ~Graph).
  bool addNodeChunk(Node* chunk);
  bool addEdgeChunk(Edge* chunk, uint32_t count);
  Node* node(uint32_t slot) const;
  // Edits (render thread for realtime, host thread for offline before rendering).
  void apply(const Command& c);
  void createNode(uint32_t slot, Kind kind);
  void releaseNode(uint32_t slot);
  bool connect(uint32_t from, uint32_t to);
  bool connectParam(uint32_t from, uint32_t to, int param);
  void disconnect(uint32_t from, uint32_t to);        // to == NONE: every outgoing node connection
  void disconnectParam(uint32_t from, uint32_t to, int param);  // param < 0: every param of `to`
  void setProp(uint32_t slot, Prop p, double v);
  void setParam(uint32_t slot, int param, float v);
  void schedule(uint32_t slot, int param, EvType type, float v, double time, float tc);
  void cancel(uint32_t slot, int param, double time);
  void cancelHold(uint32_t slot, int param, double time);
  void start(uint32_t slot, double when, double offset, double duration);
  void stop(uint32_t slot, double when);
  void setBuffer(uint32_t slot, AudioBufferData* buf);
  float paramValue(uint32_t slot, int param) const;
  float reduction(uint32_t slot) const;

  // Renders one quantum into the destination's output (planar, outChannels × QUANTUM).
  void render();
  const float* destOut(int ch) const { return node(0)->out[ch]; }
  Ring<Msg>& msgs() { return msgs_; }
  uint32_t droppedMsgs() const { return droppedMsgs_; }

 private:
  AudioParam* param(uint32_t slot, int idx) const;
  void pull(Node& n);
  void process(Node& n, int inCh);
  void processSource(Node& n);
  void processBufferSource(Node& n);
  void processOscillator(Node& n);
  void processGain(Node& n, int inCh);
  void processBiquad(Node& n, int inCh);
  void processCompressor(Node& n, int inCh);
  void processPanner(Node& n, int inCh);
  void processDestination(Node& n, int inCh);
  void finishSource(Node& n, uint32_t slot);
  void detachFinished();
  void freeNode(uint32_t slot);
  void maybeFree(uint32_t slot);
  uint32_t allocEdge();
  void unlinkEdge(uint32_t e);
  void post(Msg m);
  uint32_t slotOf(const Node& n) const;

  double rate_; int outCh_; uint32_t chunkSize_;
  Node* nodeChunks_[MAX_CHUNKS] = {}; uint32_t nodeChunkCount_ = 0;
  Edge* edgeChunks_[MAX_CHUNKS] = {}; uint32_t edgeChunkSizes_[MAX_CHUNKS] = {}; uint32_t edgeChunkCount_ = 0, edgeCapacity_ = 0;
  uint32_t edgeFree_ = NONE;
  Edge* edge(uint32_t i) const;
  AudioParam listener_[LISTENER_PARAMS];
  std::atomic<uint64_t> frames_{0};
  uint32_t stamp_ = 0;
  float scratch_[MAX_PARAMS][QUANTUM];
  float freq_[QUANTUM], det_[QUANTUM], gain_[QUANTUM];
  Ring<Msg> msgs_; uint32_t droppedMsgs_ = 0;
};

}  // namespace audio
}  // namespace host
