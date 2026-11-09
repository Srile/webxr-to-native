// WebAudio graph DSP (see graph.h). Formulas follow the Web Audio API spec:
// AudioParam automation (§1.6), BiquadFilterNode coefficients (§1.9),
// PannerNode equalpower + distance models (§1.27, §6), channel mixing (§4).
#include "audio/graph.h"
#include <algorithm>
#include <cstdlib>

namespace host {
namespace audio {

namespace {
constexpr float NYQ = 1e30f;  // replaced by sampleRate / 2 at reset
constexpr float INF = INFINITY;
constexpr double PI = 3.14159265358979323846;
struct ParamDef { const char* name; float def, lo, hi; };
const ParamDef GAIN_P[] = {{"gain", 1, -INF, INF}};
const ParamDef BUFSRC_P[] = {{"playbackRate", 1, -INF, INF}, {"detune", 0, -INF, INF}};
const ParamDef OSC_P[] = {{"frequency", 440, -NYQ, NYQ}, {"detune", 0, -153600, 153600}};
const ParamDef BIQUAD_P[] = {{"frequency", 350, 0, NYQ}, {"detune", 0, -153600, 153600}, {"Q", 1, -INF, INF}, {"gain", 0, -INF, 1541}};
const ParamDef COMP_P[] = {{"threshold", -24, -100, 0}, {"knee", 30, 0, 40}, {"ratio", 12, 1, 20}, {"attack", 0.003f, 0, 1}, {"release", 0.25f, 0, 1}};
const ParamDef PAN_P[] = {{"positionX", 0, -INF, INF}, {"positionY", 0, -INF, INF}, {"positionZ", 0, -INF, INF},
                          {"orientationX", 1, -INF, INF}, {"orientationY", 0, -INF, INF}, {"orientationZ", 0, -INF, INF}};
const ParamDef LISTENER_P[] = {{"positionX", 0, -INF, INF}, {"positionY", 0, -INF, INF}, {"positionZ", 0, -INF, INF},
                               {"forwardX", 0, -INF, INF}, {"forwardY", 0, -INF, INF}, {"forwardZ", -1, -INF, INF},
                               {"upX", 0, -INF, INF}, {"upY", 1, -INF, INF}, {"upZ", 0, -INF, INF}};
const ParamDef* defs(Kind k, int* n) {
  switch (k) {
    case Kind::Gain: *n = 1; return GAIN_P;
    case Kind::BufferSource: *n = 2; return BUFSRC_P;
    case Kind::Oscillator: *n = 2; return OSC_P;
    case Kind::Biquad: *n = 4; return BIQUAD_P;
    case Kind::Compressor: *n = 5; return COMP_P;
    case Kind::Panner: *n = 6; return PAN_P;
    case Kind::Listener: *n = LISTENER_PARAMS; return LISTENER_P;
    default: *n = 0; return nullptr;
  }
}
const char* PROP_NAMES[P_Count] = {"type", "loop", "loopStart", "loopEnd", "panningModel", "distanceModel", "refDistance",
                                   "rolloffFactor", "maxDistance", "coneInnerAngle", "coneOuterAngle", "coneOuterGain"};
inline float db2lin(float db) { return std::pow(10.0f, db / 20.0f); }
inline float lin2db(float v) { return 20.0f * std::log10(v); }
}  // namespace

Kind kindFromString(const char* s) {
  if (!s) return Kind::None;
  if (!strcmp(s, "gain")) return Kind::Gain;
  if (!strcmp(s, "bufferSource")) return Kind::BufferSource;
  if (!strcmp(s, "oscillator")) return Kind::Oscillator;
  if (!strcmp(s, "biquad")) return Kind::Biquad;
  if (!strcmp(s, "compressor")) return Kind::Compressor;
  if (!strcmp(s, "panner")) return Kind::Panner;
  if (!strcmp(s, "destination")) return Kind::Destination;
  if (!strcmp(s, "listener")) return Kind::Listener;
  return Kind::None;
}
int paramIndex(Kind k, const char* name) {
  int n; const ParamDef* d = defs(k, &n);
  for (int i = 0; i < n; i++) if (!strcmp(d[i].name, name)) return i;
  return -1;
}
int propIndex(const char* name) {
  for (int i = 0; i < P_Count; i++) if (!strcmp(PROP_NAMES[i], name)) return i;
  return -1;
}
int enumValue(Prop p, const char* s) {
  static const char* waves[] = {"sine", "square", "sawtooth", "triangle"};
  static const char* filters[] = {"lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"};
  static const char* dist[] = {"inverse", "linear", "exponential"};
  static const char* pans[] = {"equalpower", "HRTF"};
  auto find = [&](const char* const* t, int n) { for (int i = 0; i < n; i++) if (!strcmp(t[i], s)) return i; return -1; };
  switch (p) {
    case P_Type: { int w = find(waves, 4); return w >= 0 ? w : find(filters, 8); }
    case P_DistanceModel: return find(dist, 3);
    case P_PanningModel: return find(pans, 2);
    default: return -1;
  }
}

// ---- AudioBufferData ---------------------------------------------------------

AudioBufferData* AudioBufferData::create(int channels, uint32_t length, double rate) {
  if (channels < 1) channels = 1;
  AudioBufferData* b = new AudioBufferData();
  b->channels = channels; b->length = length; b->sampleRate = rate;
  size_t n = (size_t)channels * length;
  b->data = n ? (float*)allocSamples(n * sizeof(float)) : nullptr;
  if (n) memset(b->data, 0, n * sizeof(float));
  return b;
}
void* (*AudioBufferData::allocSamples)(size_t) = [](size_t bytes) { return ::operator new(bytes); };
void (*AudioBufferData::freeSamples)(void*, size_t) = [](void* p, size_t) { ::operator delete(p); };
AudioBufferData::~AudioBufferData() { if (data) freeSamples(data, (size_t)channels * length * sizeof(float)); }
void AudioBufferData::unref() { if (refs.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this; }

// ---- AudioParam --------------------------------------------------------------

void AudioParam::reset(float def, float lo, float hi) {
  base = defaultValue = def; minV = lo; maxV = hi; n = 0; hasInput = false; dropped = 0;
  published.store(def, std::memory_order_relaxed);
}
void AudioParam::setValueNow(float v, double now) { base = v; insert(EvType::SetValue, v, now, 0, now); }

void AudioParam::insert(EvType type, float value, double time, float tc, double now) {
  if (time < now) time = now;
  if ((type == EvType::LinearRamp || type == EvType::ExpRamp) && n == 0) {
    // A ramp with nothing before it starts from the value held now (the spec's implicit SetValue).
    insert(EvType::SetValue, base, now, 0, now);
  }
  if (type == EvType::SetTarget && tc <= 0) { type = EvType::SetValue; tc = 0; }  // τ = 0 jumps to the target
  if (n >= MAX_EVENTS) { dropped++; n = MAX_EVENTS - 1; }  // overwrite the last scheduled event
  int i = 0; while (i < n && ev[i].time <= time) i++;
  float sv = i == 0 ? (n ? ev[0].startValue : base) : segmentEnd(i - 1, time);
  if (i == 0 && n == 0) sv = base;
  memmove(&ev[i + 1], &ev[i], (size_t)(n - i) * sizeof(ParamEvent));
  ev[i] = ParamEvent{type, value, tc, sv, time};
  n++;
  refreshStarts(i + 1);
}

void AudioParam::cancel(double t) {
  int i = 0; while (i < n && ev[i].time < t) i++;
  n = i;
}

void AudioParam::cancelHold(double t) {
  if (n == 0) return;
  float v = valueAt(t);
  int e1 = -1, e2 = -1;
  for (int i = 0; i < n; i++) { if (ev[i].time <= t) e1 = i; else { e2 = i; break; } }
  bool e1Target = e1 >= 0 && ev[e1].type == EvType::SetTarget;
  if (e2 >= 0 && (ev[e2].type == EvType::LinearRamp || ev[e2].type == EvType::ExpRamp)) {
    ev[e2].time = t; ev[e2].value = v; n = e2 + 1;  // the ramp now ends here, at the value it had reached
  } else {
    n = e2 >= 0 ? e2 : n;
  }
  if (e1Target) {
    // The spec's implicit SetValue(v(t), t): the approach stops where it is.
    if (n >= MAX_EVENTS) n = MAX_EVENTS - 1;
    ev[n] = ParamEvent{EvType::SetValue, v, 0, v, t}; n++;
  }
  refreshStarts(1);
}

void AudioParam::prune(double now) {
  while (n >= 2 && ev[1].time <= now) { memmove(&ev[0], &ev[1], (size_t)(n - 1) * sizeof(ParamEvent)); n--; }
}

// Value of event i's own segment at time t >= ev[i].time, ignoring whatever follows.
float AudioParam::segmentEnd(int i, double t) const {
  const ParamEvent& e = ev[i];
  if (e.type == EvType::SetTarget) {
    double dt = t - e.time; if (dt < 0) dt = 0;
    return e.value + (e.startValue - e.value) * (float)std::exp(-dt / (double)e.timeConstant);
  }
  return e.value;
}
void AudioParam::refreshStarts(int from) {
  if (from < 1) from = 1;
  for (int i = from; i < n; i++) ev[i].startValue = segmentEnd(i - 1, ev[i].time);
}

float AudioParam::valueAt(double t) const {
  if (n == 0) return base;
  int i = -1; while (i + 1 < n && ev[i + 1].time <= t) i++;
  if (i < 0) return ev[0].startValue;
  const ParamEvent& cur = ev[i];
  if (i + 1 < n && cur.type != EvType::SetTarget && (ev[i + 1].type == EvType::LinearRamp || ev[i + 1].type == EvType::ExpRamp)) {
    const ParamEvent& nx = ev[i + 1];
    double span = nx.time - cur.time; if (span <= 0) return nx.value;
    double x = (t - cur.time) / span; if (x > 1) x = 1;
    float v0 = cur.value, v1 = nx.value;
    if (nx.type == EvType::LinearRamp) return v0 + (v1 - v0) * (float)x;
    if (v0 == 0 || (v0 < 0) != (v1 < 0)) return v0;  // §1.6.3: opposite signs or zero start hold V0
    return v0 * (float)std::pow((double)v1 / (double)v0, x);
  }
  return segmentEnd(i, t);
}

void AudioParam::fill(float* out, int count, double t0, double dt, const float* input) {
  if (n == 0) { for (int i = 0; i < count; i++) out[i] = base; }
  else if (n == 1 && ev[0].type != EvType::SetTarget && ev[0].time <= t0) { float v = ev[0].value; for (int i = 0; i < count; i++) out[i] = v; }
  else { for (int i = 0; i < count; i++) out[i] = valueAt(t0 + i * dt); }
  if (hasInput && input) for (int i = 0; i < count; i++) out[i] += input[i];
  for (int i = 0; i < count; i++) out[i] = clampv(out[i]);
  published.store(out[count - 1], std::memory_order_relaxed);
}
float AudioParam::k(double t0, const float* input) {
  float v = valueAt(t0);
  if (hasInput && input) v += input[0];
  v = clampv(v);
  published.store(v, std::memory_order_relaxed);
  return v;
}

// ---- Graph: storage ------------------------------------------------------------

Graph::Graph(double sampleRate, int outChannels, uint32_t chunkSize, uint32_t msgCapacityPow2)
    : rate_(sampleRate), outCh_(outChannels < 1 ? 1 : (outChannels > MAX_CH ? MAX_CH : outChannels)), chunkSize_(chunkSize), msgs_(msgCapacityPow2) {
  int n; const ParamDef* d = defs(Kind::Listener, &n);
  for (int i = 0; i < n; i++) listener_[i].reset(d[i].def, d[i].lo, d[i].hi);
}
Graph::~Graph() {
  for (uint32_t c = 0; c < nodeChunkCount_; c++) {
    for (uint32_t i = 0; i < chunkSize_; i++) if (nodeChunks_[c][i].buffer) nodeChunks_[c][i].buffer->unref();
    delete[] nodeChunks_[c];
  }
  for (uint32_t c = 0; c < edgeChunkCount_; c++) delete[] edgeChunks_[c];
}
bool Graph::addNodeChunk(Node* chunk) {
  if (nodeChunkCount_ >= MAX_CHUNKS) { delete[] chunk; return false; }
  nodeChunks_[nodeChunkCount_++] = chunk; return true;
}
bool Graph::addEdgeChunk(Edge* chunk, uint32_t count) {
  if (edgeChunkCount_ >= MAX_CHUNKS) { delete[] chunk; return false; }
  uint32_t base = edgeCapacity_;
  edgeChunks_[edgeChunkCount_] = chunk; edgeChunkSizes_[edgeChunkCount_] = count; edgeChunkCount_++;
  edgeCapacity_ += count;
  for (uint32_t i = count; i-- > 0;) { chunk[i].used = false; chunk[i].nextOut = edgeFree_; edgeFree_ = base + i; }
  return true;
}
Node* Graph::node(uint32_t slot) const {
  uint32_t c = slot / chunkSize_;
  if (c >= nodeChunkCount_) return nullptr;
  return &nodeChunks_[c][slot % chunkSize_];
}
Edge* Graph::edge(uint32_t i) const {
  uint32_t c = 0, base = 0;
  while (c < edgeChunkCount_ && i >= base + edgeChunkSizes_[c]) { base += edgeChunkSizes_[c]; c++; }
  return c < edgeChunkCount_ ? &edgeChunks_[c][i - base] : nullptr;
}
uint32_t Graph::slotOf(const Node& n) const {
  for (uint32_t c = 0; c < nodeChunkCount_; c++) {
    const Node* b = nodeChunks_[c];
    if (&n >= b && &n < b + chunkSize_) return c * chunkSize_ + (uint32_t)(&n - b);
  }
  return NONE;
}
AudioParam* Graph::param(uint32_t slot, int idx) const {
  if (idx < 0) return nullptr;
  if (slot == LISTENER_SLOT) return idx < LISTENER_PARAMS ? const_cast<AudioParam*>(&listener_[idx]) : nullptr;
  Node* n = node(slot); if (!n || !n->used) return nullptr;
  int count; defs(n->kind, &count);
  return idx < count ? &n->params[idx] : nullptr;
}
void Graph::post(Msg m) { if (!msgs_.push(m)) droppedMsgs_++; }

// ---- Graph: edits --------------------------------------------------------------------

void Graph::apply(const Command& c) {
  switch (c.op) {
    case Op::AddNodeChunk: addNodeChunk((Node*)c.ptr); break;
    case Op::AddEdgeChunk: addEdgeChunk((Edge*)c.ptr, c.count); break;
    case Op::CreateNode: createNode(c.a, (Kind)c.kind); break;
    case Op::ReleaseNode: releaseNode(c.a); break;
    case Op::Connect: connect(c.a, c.b); break;
    case Op::ConnectParam: connectParam(c.a, c.b, c.param); break;
    case Op::Disconnect: disconnect(c.a, c.b); break;
    case Op::DisconnectParam: disconnectParam(c.a, c.b, c.param); break;
    case Op::SetProp: setProp(c.a, (Prop)c.prop, c.v); break;
    case Op::SetParam: setParam(c.a, c.param, (float)c.v); break;
    case Op::Schedule: schedule(c.a, c.param, (EvType)c.evType, (float)c.v, c.t, (float)c.v2); break;
    case Op::Cancel: cancel(c.a, c.param, c.t); break;
    case Op::CancelHold: cancelHold(c.a, c.param, c.t); break;
    case Op::Start: start(c.a, c.t, c.v, c.v2); break;
    case Op::Stop: stop(c.a, c.t); break;
    case Op::SetBuffer: setBuffer(c.a, (AudioBufferData*)c.ptr); break;
  }
}

void Graph::createNode(uint32_t slot, Kind kind) {
  Node* n = node(slot); if (!n) return;
  if (n->used) freeNode(slot);
  if (n->buffer) { n->buffer->unref(); n->buffer = nullptr; }
  // Reset everything but the (trivially re-zeroed) buffers.
  n->kind = kind; n->used = true; n->releasedByJs = false; n->visiting = false; n->stamp = 0;
  n->inHead = n->outHead = NONE; n->outCh = 0;
  n->started = n->ended = n->posInit = n->detachPending = false; n->startFrame = 0; n->stopFrame = INT64_MAX; n->offset = 0;
  n->loop = false; n->loopStart = n->loopEnd = n->pos = 0; n->wave = W_Sine; n->phase = 0;
  n->filter = F_Lowpass; n->z1[0] = n->z1[1] = n->z2[0] = n->z2[1] = 0; n->env = 0; n->reduction.store(0);
  n->panningModel = 0; n->distanceModel = D_Inverse; n->refDistance = 1; n->rolloff = 1; n->maxDistance = 10000;
  n->coneInner = n->coneOuter = 360; n->coneOuterGain = 0;
  int count; const ParamDef* d = defs(kind, &count);
  for (int i = 0; i < count && i < MAX_PARAMS; i++) {
    float lo = d[i].lo, hi = d[i].hi;
    if (lo == -NYQ) lo = (float)(-rate_ / 2); if (hi == NYQ) hi = (float)(rate_ / 2);
    n->params[i].reset(d[i].def, lo, hi);
  }
}

void Graph::releaseNode(uint32_t slot) {
  Node* n = node(slot); if (!n || !n->used) return;
  n->releasedByJs = true; maybeFree(slot);
}

uint32_t Graph::allocEdge() {
  if (edgeFree_ == NONE) return NONE;
  uint32_t i = edgeFree_; Edge* e = edge(i); edgeFree_ = e->nextOut;
  e->used = true; e->nextIn = e->nextOut = NONE; return i;
}
void Graph::unlinkEdge(uint32_t ei) {
  Edge* e = edge(ei); if (!e || !e->used) return;
  Node* from = node(e->from); Node* to = node(e->to);
  if (from) { uint32_t* p = &from->outHead; while (*p != NONE && *p != ei) p = &edge(*p)->nextOut; if (*p == ei) *p = e->nextOut; }
  if (to) { uint32_t* p = &to->inHead; while (*p != NONE && *p != ei) p = &edge(*p)->nextIn; if (*p == ei) *p = e->nextIn; }
  e->used = false; e->from = e->to = NONE; e->param = -1; e->nextOut = edgeFree_; edgeFree_ = ei;
}

bool Graph::connect(uint32_t from, uint32_t to) { return connectParam(from, to, -1); }
bool Graph::connectParam(uint32_t from, uint32_t to, int param) {
  Node* a = node(from); Node* b = node(to);
  if (!a || !b || !a->used || !b->used || a->kind == Kind::Destination) return false;
  if (param < 0 && b->isSource()) return false;
  for (uint32_t ei = a->outHead; ei != NONE; ei = edge(ei)->nextOut) { Edge* e = edge(ei); if (e->to == to && e->param == param) return true; }
  uint32_t ei = allocEdge(); if (ei == NONE) return false;
  Edge* e = edge(ei); e->from = from; e->to = to; e->param = (int16_t)param;
  e->nextOut = a->outHead; a->outHead = ei; e->nextIn = b->inHead; b->inHead = ei;
  return true;
}
void Graph::disconnect(uint32_t from, uint32_t to) {
  Node* a = node(from); if (!a || !a->used) return;
  uint32_t ei = a->outHead;
  while (ei != NONE) {
    Edge* e = edge(ei); uint32_t next = e->nextOut; uint32_t dest = e->to;
    if (e->param < 0 && (to == NONE || dest == to)) { unlinkEdge(ei); maybeFree(dest); }
    ei = next;
  }
}
void Graph::disconnectParam(uint32_t from, uint32_t to, int param) {
  Node* a = node(from); if (!a || !a->used) return;
  uint32_t ei = a->outHead;
  while (ei != NONE) {
    Edge* e = edge(ei); uint32_t next = e->nextOut;
    if (e->param >= 0 && e->to == to && (param < 0 || e->param == param)) unlinkEdge(ei);
    ei = next;
  }
}

void Graph::setProp(uint32_t slot, Prop p, double v) {
  Node* n = node(slot); if (!n || !n->used) return;
  switch (p) {
    case P_Type: if (n->kind == Kind::Oscillator) n->wave = (uint8_t)v; else if (n->kind == Kind::Biquad) { n->filter = (uint8_t)v; } break;
    case P_Loop: n->loop = v != 0; break;
    case P_LoopStart: n->loopStart = v; break;
    case P_LoopEnd: n->loopEnd = v; break;
    case P_PanningModel: n->panningModel = (uint8_t)v; break;
    case P_DistanceModel: n->distanceModel = (uint8_t)v; break;
    case P_RefDistance: n->refDistance = (float)v; break;
    case P_RolloffFactor: n->rolloff = (float)v; break;
    case P_MaxDistance: n->maxDistance = (float)v; break;
    case P_ConeInner: n->coneInner = (float)v; break;
    case P_ConeOuter: n->coneOuter = (float)v; break;
    case P_ConeOuterGain: n->coneOuterGain = (float)v; break;
    default: break;
  }
}
void Graph::setParam(uint32_t slot, int idx, float v) { if (AudioParam* p = param(slot, idx)) p->setValueNow(v, now()); }
void Graph::schedule(uint32_t slot, int idx, EvType type, float v, double time, float tc) { if (AudioParam* p = param(slot, idx)) p->insert(type, v, time, tc, now()); }
void Graph::cancel(uint32_t slot, int idx, double time) { if (AudioParam* p = param(slot, idx)) p->cancel(time); }
void Graph::cancelHold(uint32_t slot, int idx, double time) { if (AudioParam* p = param(slot, idx)) p->cancelHold(time); }
float Graph::paramValue(uint32_t slot, int idx) const { const AudioParam* p = param(slot, idx); return p ? p->published.load(std::memory_order_relaxed) : 0.0f; }
float Graph::reduction(uint32_t slot) const { Node* n = node(slot); return n && n->used && n->kind == Kind::Compressor ? n->reduction.load(std::memory_order_relaxed) : 0.0f; }

void Graph::start(uint32_t slot, double when, double offset, double duration) {
  Node* n = node(slot); if (!n || !n->used || !n->isSource() || n->started) return;
  double t = std::max(when, now());
  n->started = true; n->startFrame = (int64_t)std::llround(t * rate_); n->offset = offset < 0 ? 0 : offset;
  if (duration > 0) { int64_t stopAt = n->startFrame + (int64_t)std::llround(duration * rate_); if (stopAt < n->stopFrame) n->stopFrame = stopAt; }
}
void Graph::stop(uint32_t slot, double when) {
  Node* n = node(slot); if (!n || !n->used || !n->isSource() || n->ended) return;
  double t = std::max(when, now());
  int64_t f = (int64_t)std::llround(t * rate_);
  if (f < n->startFrame) f = n->startFrame;
  n->stopFrame = f;
  if (!n->started) { n->started = true; n->startFrame = f; }  // stop before start: ends at once, fires ended
}
void Graph::setBuffer(uint32_t slot, AudioBufferData* buf) {
  Node* n = node(slot); if (!n || !n->used) { if (buf) post(Msg{Msg::ReleaseBuffer, slot, buf}); return; }
  if (n->buffer) post(Msg{Msg::ReleaseBuffer, slot, n->buffer});
  n->buffer = buf;
}

// ---- Graph: lifetime -----------------------------------------------------------------

void Graph::maybeFree(uint32_t slot) {
  Node* n = node(slot); if (!n || !n->used || !n->releasedByJs || n->kind == Kind::Destination) return;
  if (n->isSource()) { if (n->started && !n->ended) return; }
  else if (n->inHead != NONE) return;
  freeNode(slot);
}
void Graph::freeNode(uint32_t slot) {
  Node* n = node(slot); if (!n || !n->used) return;
  n->used = false;  // first, so a cascade cannot re-enter this node
  while (n->inHead != NONE) unlinkEdge(n->inHead);
  while (n->outHead != NONE) { uint32_t to = edge(n->outHead)->to; unlinkEdge(n->outHead); maybeFree(to); }
  if (n->buffer) { post(Msg{Msg::ReleaseBuffer, slot, n->buffer}); n->buffer = nullptr; }
  post(Msg{Msg::Freed, slot, nullptr});
}
// A source that ends mid-quantum keeps its edges until the quantum is summed
// (its last partial block still has to reach the destination); render()
// detaches it afterwards.
void Graph::finishSource(Node& n, uint32_t slot) {
  n.ended = true; n.detachPending = true;
  post(Msg{Msg::Ended, slot, nullptr});
}
void Graph::detachFinished() {
  for (uint32_t c = 0; c < nodeChunkCount_; c++) for (uint32_t i = 0; i < chunkSize_; i++) {
    Node& n = nodeChunks_[c][i];
    if (!n.used || !n.detachPending) continue;
    n.detachPending = false; n.outCh = 0;
    while (n.outHead != NONE) { uint32_t to = edge(n.outHead)->to; unlinkEdge(n.outHead); maybeFree(to); }
    maybeFree(c * chunkSize_ + i);
  }
}

// ---- Graph: render ------------------------------------------------------------------

namespace {
inline void mixInto(float in[MAX_CH][QUANTUM], int& inCh, const float out[MAX_CH][QUANTUM], int srcCh) {
  if (srcCh <= 0) return;
  if (inCh == 0) {
    memcpy(in[0], out[0], sizeof(float) * QUANTUM);
    if (srcCh == 2) memcpy(in[1], out[1], sizeof(float) * QUANTUM);
    inCh = srcCh; return;
  }
  if (inCh == 1 && srcCh == 2) { memcpy(in[1], in[0], sizeof(float) * QUANTUM); inCh = 2; }
  for (int i = 0; i < QUANTUM; i++) in[0][i] += out[0][i];
  if (inCh == 2) { const float* s = srcCh == 2 ? out[1] : out[0]; for (int i = 0; i < QUANTUM; i++) in[1][i] += s[i]; }
}
inline float readMono(const float out[MAX_CH][QUANTUM], int ch, int i) { return ch == 2 ? 0.5f * (out[0][i] + out[1][i]) : out[0][i]; }
}  // namespace

void Graph::render() {
  double t0 = now();
  stamp_++;
  if (stamp_ == 0) stamp_ = 1;
  // Prune every live param's timeline; sources advance even when nothing pulls them.
  for (uint32_t c = 0; c < nodeChunkCount_; c++) for (uint32_t i = 0; i < chunkSize_; i++) {
    Node& n = nodeChunks_[c][i]; if (!n.used) continue;
    int count; defs(n.kind, &count);
    for (int p = 0; p < count && p < MAX_PARAMS; p++) n.params[p].prune(t0);
  }
  for (int p = 0; p < LISTENER_PARAMS; p++) listener_[p].prune(t0);
  Node* dest = node(0);
  if (dest && dest->used) pull(*dest);
  for (uint32_t c = 0; c < nodeChunkCount_; c++) for (uint32_t i = 0; i < chunkSize_; i++) {
    Node& n = nodeChunks_[c][i];
    if (n.used && n.isSource() && n.stamp != stamp_) pull(n);
  }
  detachFinished();
  frames_.fetch_add(QUANTUM, std::memory_order_release);
}

void Graph::pull(Node& n) {
  if (n.stamp == stamp_) return;
  if (n.visiting) { n.outCh = 0; return; }  // a cycle: silence (the game builds none)
  n.visiting = true;
  for (uint32_t ei = n.inHead; ei != NONE; ei = edge(ei)->nextIn) { Node* src = node(edge(ei)->from); if (src && src->used) pull(*src); }
  int inCh = 0;
  int count; defs(n.kind, &count);
  for (int p = 0; p < count && p < MAX_PARAMS; p++) n.params[p].hasInput = false;
  for (uint32_t ei = n.inHead; ei != NONE; ei = edge(ei)->nextIn) {
    Edge* e = edge(ei); Node* src = node(e->from);
    if (!src || !src->used || src->outCh == 0) continue;
    if (e->param < 0) { mixInto(n.in, inCh, src->out, src->outCh); continue; }
    if (e->param >= count || e->param >= MAX_PARAMS) continue;
    AudioParam& pr = n.params[e->param]; float* sc = scratch_[e->param];
    if (!pr.hasInput) { for (int i = 0; i < QUANTUM; i++) sc[i] = readMono(src->out, src->outCh, i); pr.hasInput = true; }
    else for (int i = 0; i < QUANTUM; i++) sc[i] += readMono(src->out, src->outCh, i);
  }
  process(n, inCh);
  n.visiting = false; n.stamp = stamp_;
}

void Graph::process(Node& n, int inCh) {
  switch (n.kind) {
    case Kind::Destination: processDestination(n, inCh); break;
    case Kind::Gain: processGain(n, inCh); break;
    case Kind::BufferSource: processBufferSource(n); break;
    case Kind::Oscillator: processOscillator(n); break;
    case Kind::Biquad: processBiquad(n, inCh); break;
    case Kind::Compressor: processCompressor(n, inCh); break;
    case Kind::Panner: processPanner(n, inCh); break;
    default: n.outCh = 0; break;
  }
}

void Graph::processDestination(Node& n, int inCh) {
  n.outCh = outCh_;
  if (inCh == 0) { memset(n.out, 0, sizeof(n.out)); return; }
  if (inCh == outCh_) { memcpy(n.out, n.in, sizeof(float) * QUANTUM * (size_t)inCh); return; }
  if (inCh == 1) { memcpy(n.out[0], n.in[0], sizeof(float) * QUANTUM); memcpy(n.out[1], n.in[0], sizeof(float) * QUANTUM); return; }
  for (int i = 0; i < QUANTUM; i++) n.out[0][i] = 0.5f * (n.in[0][i] + n.in[1][i]);  // stereo → mono, §4 speakers
}

void Graph::processGain(Node& n, int inCh) {
  if (inCh == 0) { n.outCh = 0; n.params[0].k(now(), nullptr); return; }
  n.outCh = inCh;
  AudioParam& g = n.params[0];
  if (g.constant()) {
    float v = g.k(now(), nullptr);
    for (int c = 0; c < inCh; c++) for (int i = 0; i < QUANTUM; i++) n.out[c][i] = n.in[c][i] * v;
    return;
  }
  g.fill(gain_, QUANTUM, now(), 1.0 / rate_, scratch_[0]);
  for (int c = 0; c < inCh; c++) for (int i = 0; i < QUANTUM; i++) n.out[c][i] = n.in[c][i] * gain_[i];
}

void Graph::processBufferSource(Node& n) {
  n.outCh = 0;
  if (!n.started || n.ended) return;
  int64_t q0 = (int64_t)frames();
  if (q0 + QUANTUM <= n.startFrame) { n.params[0].k(now(), nullptr); n.params[1].k(now(), nullptr); return; }
  uint32_t slot = slotOf(n);
  AudioBufferData* b = n.buffer;
  if (!b || b->length == 0) { finishSource(n, slot); return; }  // nothing to play: ends at once
  double bufRate = b->sampleRate > 0 ? b->sampleRate : rate_;
  float pr = n.params[0].k(now(), scratch_[0]);
  float det = n.params[1].k(now(), scratch_[1]);
  double step = (double)pr * std::pow(2.0, (double)det / 1200.0) * (bufRate / rate_);
  int ch = b->channels > MAX_CH ? MAX_CH : b->channels;
  double len = (double)b->length;
  double ls = 0, le = len;
  if (n.loop) {
    ls = std::min(std::max(n.loopStart * bufRate, 0.0), len);
    le = n.loopEnd > 0 ? std::min(n.loopEnd * bufRate, len) : len;
    if (le <= ls) { ls = 0; le = len; }
  }
  if (!n.posInit) {
    n.pos = n.offset * bufRate;
    if (n.loop && n.pos >= le) n.pos = ls;
    if (n.pos > len) n.pos = len;
    n.posInit = true;
  }
  bool done = false; int i = 0;
  for (; i < QUANTUM; i++) {
    int64_t f = q0 + i;
    if (f < n.startFrame) { for (int c = 0; c < ch; c++) n.out[c][i] = 0; continue; }
    if (f >= n.stopFrame) { done = true; break; }
    double p = n.pos;
    if (n.loop) {
      double span = le - ls;
      if (span > 0) { while (p >= le) p -= span; while (p < ls) p += span; }
    } else if (p >= len || p < 0) { done = true; break; }
    int64_t i0 = (int64_t)p; double frac = p - (double)i0;
    int64_t i1 = i0 + 1;
    if (n.loop) { if ((double)i1 >= le) i1 = (int64_t)ls; } else if (i1 >= (int64_t)b->length) i1 = i0;
    for (int c = 0; c < ch; c++) { const float* d = b->ch(c); float s0 = d[i0], s1 = d[i1]; n.out[c][i] = s0 + (float)frac * (s1 - s0); }
    n.pos = p + step;
  }
  for (; i < QUANTUM; i++) for (int c = 0; c < ch; c++) n.out[c][i] = 0;
  n.outCh = ch;
  if (done) finishSource(n, slot);
}

void Graph::processOscillator(Node& n) {
  n.outCh = 0;
  if (!n.started || n.ended) return;
  int64_t q0 = (int64_t)frames();
  double t0 = now(), dt = 1.0 / rate_;
  if (q0 + QUANTUM <= n.startFrame) { n.params[0].k(t0, nullptr); n.params[1].k(t0, nullptr); return; }
  n.params[0].fill(freq_, QUANTUM, t0, dt, scratch_[0]);
  n.params[1].fill(det_, QUANTUM, t0, dt, scratch_[1]);
  bool done = false; int i = 0;
  for (; i < QUANTUM; i++) {
    int64_t f = q0 + i;
    if (f < n.startFrame) { n.out[0][i] = 0; continue; }
    if (f >= n.stopFrame) { done = true; break; }
    double ph = n.phase; float v;
    switch (n.wave) {
      case W_Square: v = ph < 0.5 ? 1.0f : -1.0f; break;
      case W_Sawtooth: v = (float)(2.0 * (ph - std::floor(ph + 0.5))); break;
      case W_Triangle: { double u = ph + 0.75; u -= std::floor(u); v = (float)(1.0 - 4.0 * std::fabs(u - 0.5)); break; }
      default: v = (float)std::sin(2.0 * PI * ph); break;
    }
    n.out[0][i] = v;
    double hz = (double)freq_[i] * std::pow(2.0, (double)det_[i] / 1200.0);
    ph += hz * dt; ph -= std::floor(ph); n.phase = ph;
  }
  for (; i < QUANTUM; i++) n.out[0][i] = 0;
  n.outCh = 1;
  if (done) finishSource(n, slotOf(n));
}

void Graph::processBiquad(Node& n, int inCh) {
  double t0 = now();
  float fr = n.params[0].k(t0, scratch_[0]), det = n.params[1].k(t0, scratch_[1]);
  float Q = n.params[2].k(t0, scratch_[2]), G = n.params[3].k(t0, scratch_[3]);
  bool tail = std::fabs(n.z1[0]) + std::fabs(n.z2[0]) + std::fabs(n.z1[1]) + std::fabs(n.z2[1]) > 1e-9;
  if (inCh == 0 && !tail) { n.outCh = 0; return; }
  int ch = inCh == 0 ? 1 : inCh;
  if (inCh == 0) memset(n.in, 0, sizeof(float) * QUANTUM * (size_t)ch);
  n.outCh = ch;
  double f = (double)fr * std::pow(2.0, (double)det / 1200.0);
  double nyq = rate_ / 2; if (f < 0) f = 0; if (f > nyq) f = nyq;
  double w0 = 2.0 * PI * f / rate_, cw = std::cos(w0), sw = std::sin(w0);
  double A = std::pow(10.0, (double)G / 40.0);
  double aQ = Q > 0 ? sw / (2.0 * Q) : 1e9, aQdB = sw / (2.0 * std::pow(10.0, (double)Q / 20.0));
  double aS = sw / 2.0 * std::sqrt(2.0);  // S = 1
  double b0, b1, b2, a0, a1, a2;
  switch (n.filter) {
    case F_Highpass: b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break;
    case F_Bandpass: b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case F_Notch: b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case F_Allpass: b0 = 1 - aQ; b1 = -2 * cw; b2 = 1 + aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case F_Peaking: b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; break;
    case F_Lowshelf: {
      double sA = std::sqrt(A);
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * sA * aS); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - 2 * sA * aS);
      a0 = (A + 1) + (A - 1) * cw + 2 * sA * aS; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - 2 * sA * aS; break;
    }
    case F_Highshelf: {
      double sA = std::sqrt(A);
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * sA * aS); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - 2 * sA * aS);
      a0 = (A + 1) - (A - 1) * cw + 2 * sA * aS; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - 2 * sA * aS; break;
    }
    default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break;
  }
  double ia = 1.0 / a0; b0 *= ia; b1 *= ia; b2 *= ia; a1 *= ia; a2 *= ia;
  for (int c = 0; c < ch; c++) {
    double z1 = n.z1[c], z2 = n.z2[c];
    const float* x = n.in[c]; float* y = n.out[c];
    for (int i = 0; i < QUANTUM; i++) {  // transposed direct form II
      double in = x[i], out = b0 * in + z1;
      z1 = b1 * in - a1 * out + z2; z2 = b2 * in - a2 * out;
      y[i] = (float)out;
    }
    if (std::fabs(z1) < 1e-20) z1 = 0; if (std::fabs(z2) < 1e-20) z2 = 0;
    n.z1[c] = z1; n.z2[c] = z2;
  }
}

// Feed-forward compressor: a peak detector with attack/release one-poles over the
// linked channels, the spec's soft-knee gain computer in dB, and the spec's
// makeup gain ((1 / gain at 0 dBFS)^0.6). No lookahead.
void Graph::processCompressor(Node& n, int inCh) {
  double t0 = now();
  float T = n.params[0].k(t0, scratch_[0]), K = n.params[1].k(t0, scratch_[1]), R = n.params[2].k(t0, scratch_[2]);
  float att = n.params[3].k(t0, scratch_[3]), rel = n.params[4].k(t0, scratch_[4]);
  if (inCh == 0) { n.env *= 0.5f; n.reduction.store(0, std::memory_order_relaxed); n.outCh = 0; return; }
  n.outCh = inCh;
  auto computeDb = [&](float lvl) {
    float half = K * 0.5f;
    if (lvl < T - half) return lvl;
    if (lvl <= T + half && K > 0) { float d = lvl - T + half; return lvl + (1.0f / R - 1.0f) * d * d / (2.0f * K); }
    return T + (lvl - T) / R;
  };
  float makeup = std::pow(1.0f / db2lin(computeDb(0.0f)), 0.6f);
  float ca = att > 0 ? 1.0f - std::exp(-1.0f / (att * (float)rate_)) : 1.0f;
  float cr = rel > 0 ? 1.0f - std::exp(-1.0f / (rel * (float)rate_)) : 1.0f;
  float env = n.env, red = 0;
  for (int i = 0; i < QUANTUM; i++) {
    float x = std::fabs(n.in[0][i]);
    if (inCh == 2) { float r = std::fabs(n.in[1][i]); if (r > x) x = r; }
    env += (x - env) * (x > env ? ca : cr);
    float lvl = lin2db(env + 1e-9f);
    red = computeDb(lvl) - lvl;
    float g = db2lin(red) * makeup;
    for (int c = 0; c < inCh; c++) n.out[c][i] = n.in[c][i] * g;
  }
  n.env = env;
  n.reduction.store(red, std::memory_order_relaxed);
}

void Graph::processPanner(Node& n, int inCh) {
  double t0 = now();
  float sx = n.params[0].k(t0, scratch_[0]), sy = n.params[1].k(t0, scratch_[1]), sz = n.params[2].k(t0, scratch_[2]);
  n.params[3].k(t0, scratch_[3]); n.params[4].k(t0, scratch_[4]); n.params[5].k(t0, scratch_[5]);
  if (inCh == 0) { n.outCh = 0; return; }
  n.outCh = 2;
  float lx = listener_[0].k(t0, nullptr), ly = listener_[1].k(t0, nullptr), lz = listener_[2].k(t0, nullptr);
  float fx = listener_[3].k(t0, nullptr), fy = listener_[4].k(t0, nullptr), fz = listener_[5].k(t0, nullptr);
  float ux = listener_[6].k(t0, nullptr), uy = listener_[7].k(t0, nullptr), uz = listener_[8].k(t0, nullptr);
  // §6 azimuth: source direction projected onto the listener's horizontal plane.
  float dx = sx - lx, dy = sy - ly, dz = sz - lz;
  float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
  double azimuth = 0;
  float fl = std::sqrt(fx * fx + fy * fy + fz * fz);
  if (dist > 1e-6f && fl > 1e-6f) {
    fx /= fl; fy /= fl; fz /= fl;
    float rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    float rl = std::sqrt(rx * rx + ry * ry + rz * rz);
    if (rl > 1e-6f) {
      rx /= rl; ry /= rl; rz /= rl;
      float upx = ry * fz - rz * fy, upy = rz * fx - rx * fz, upz = rx * fy - ry * fx;  // right × forward
      float sxn = dx / dist, syn = dy / dist, szn = dz / dist;
      float upDot = sxn * upx + syn * upy + szn * upz;
      float px = sxn - upDot * upx, py = syn - upDot * upy, pz = szn - upDot * upz;
      float pl = std::sqrt(px * px + py * py + pz * pz);
      if (pl > 1e-6f) {
        px /= pl; py /= pl; pz /= pl;
        float dr = px * rx + py * ry + pz * rz; if (dr > 1) dr = 1; if (dr < -1) dr = -1;
        azimuth = 180.0 * std::acos(dr) / PI;
        if (px * fx + py * fy + pz * fz < 0) azimuth = 360.0 - azimuth;
        azimuth = (azimuth >= 0 && azimuth <= 270) ? 90.0 - azimuth : 450.0 - azimuth;
      }
    }
  }
  // Distance gain (§1.27.3), the rolloff clamped as the spec clamps it.
  float ref = n.refDistance, roll = n.rolloff, maxd = n.maxDistance, dg = 1;
  switch (n.distanceModel) {
    case D_Linear: {
      if (roll < 0) roll = 0; if (roll > 1) roll = 1;
      float d = std::min(std::max(dist, ref), maxd);
      dg = maxd > ref ? 1.0f - roll * (d - ref) / (maxd - ref) : 1.0f; break;
    }
    case D_Exponential: { if (roll < 0) roll = 0; float d = std::max(dist, ref); dg = ref > 0 ? std::pow(d / ref, -roll) : 1.0f; break; }
    default: { if (roll < 0) roll = 0; float d = std::max(dist, ref); float den = ref + roll * (d - ref); dg = den > 0 ? ref / den : 1.0f; break; }
  }
  // Equalpower (§6.2); 'HRTF' takes the same path.
  if (azimuth < -90) azimuth = -180 - azimuth; else if (azimuth > 90) azimuth = 180 - azimuth;
  double x = inCh == 1 ? (azimuth + 90) / 180 : (azimuth <= 0 ? (azimuth + 90) / 90 : azimuth / 90);
  float gl = (float)std::cos(x * PI / 2), gr = (float)std::sin(x * PI / 2);
  if (inCh == 1) {
    for (int i = 0; i < QUANTUM; i++) { float s = n.in[0][i] * dg; n.out[0][i] = s * gl; n.out[1][i] = s * gr; }
  } else if (azimuth <= 0) {
    for (int i = 0; i < QUANTUM; i++) { float l = n.in[0][i] * dg, r = n.in[1][i] * dg; n.out[0][i] = l + r * gl; n.out[1][i] = r * gr; }
  } else {
    for (int i = 0; i < QUANTUM; i++) { float l = n.in[0][i] * dg, r = n.in[1][i] * dg; n.out[0][i] = l * gl; n.out[1][i] = r + l * gr; }
  }
}

}  // namespace audio
}  // namespace host
