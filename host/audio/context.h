#pragma once
// Host-thread side of an audio context: slot allocation over the graph's node
// chunks, Command construction, message draining. RealtimeContext (device.cpp)
// queues the commands for the Oboe callback; OfflineContext (offline.cpp)
// applies them directly and renders on demand.
#include <functional>
#include <memory>
#include <vector>
#include "audio/graph.h"

namespace host {
namespace audio {

class ContextBase {
 public:
  virtual ~ContextBase();
  double sampleRate() const { return graph_->sampleRate(); }
  double currentTime() const { return graph_->now(); }
  bool realtime() const { return realtime_; }
  Graph& graph() { return *graph_; }

  // Delivers an edit to the graph (queued or direct). Returns false if dropped.
  virtual bool issue(const Command& c) = 0;
  virtual bool resume() { return false; }
  virtual bool suspend() { return false; }
  virtual bool running() const { return false; }
  virtual void tick() {}  // host thread, every loop iteration

  // Node handles are slots; slot 0 is the destination.
  uint32_t createNode(Kind kind);
  void releaseNode(uint32_t slot) { Command c; c.op = Op::ReleaseNode; c.a = slot; issue(c); }
  bool connect(uint32_t from, uint32_t to) { Command c; c.op = Op::Connect; c.a = from; c.b = to; return issue(c); }
  bool connectParam(uint32_t from, uint32_t to, int param) { Command c; c.op = Op::ConnectParam; c.a = from; c.b = to; c.param = (int16_t)param; return issue(c); }
  void disconnect(uint32_t from, uint32_t to) { Command c; c.op = Op::Disconnect; c.a = from; c.b = to; issue(c); }
  void disconnectParam(uint32_t from, uint32_t to, int param) { Command c; c.op = Op::DisconnectParam; c.a = from; c.b = to; c.param = (int16_t)param; issue(c); }
  void setProp(uint32_t slot, Prop p, double v) { Command c; c.op = Op::SetProp; c.a = slot; c.prop = (uint8_t)p; c.v = v; issue(c); }
  void setParam(uint32_t slot, int param, double v) { Command c; c.op = Op::SetParam; c.a = slot; c.param = (int16_t)param; c.v = v; issue(c); }
  void schedule(uint32_t slot, int param, EvType t, double v, double time, double tc) { Command c; c.op = Op::Schedule; c.a = slot; c.param = (int16_t)param; c.evType = (uint8_t)t; c.v = v; c.t = time; c.v2 = tc; issue(c); }
  void cancel(uint32_t slot, int param, double time) { Command c; c.op = Op::Cancel; c.a = slot; c.param = (int16_t)param; c.t = time; issue(c); }
  void cancelHold(uint32_t slot, int param, double time) { Command c; c.op = Op::CancelHold; c.a = slot; c.param = (int16_t)param; c.t = time; issue(c); }
  void start(uint32_t slot, double when, double offset, double duration) { Command c; c.op = Op::Start; c.a = slot; c.t = when; c.v = offset; c.v2 = duration; issue(c); }
  void stop(uint32_t slot, double when) { Command c; c.op = Op::Stop; c.a = slot; c.t = when; issue(c); }
  // Takes a reference on buf for the node; released through Msg::ReleaseBuffer.
  void setBuffer(uint32_t slot, AudioBufferData* buf) { if (buf) buf->ref(); Command c; c.op = Op::SetBuffer; c.a = slot; c.ptr = buf; issue(c); }
  // Hands the node a reference on s (an AnalyserState, a LiveInput); released through Msg::ReleaseExt.
  void setExt(uint32_t slot, Shared* s) { if (s) s->ref(); Command c; c.op = Op::SetExt; c.a = slot; c.ptr = s; if (!issue(c) && s) s->unref(); }
  float paramValue(uint32_t slot, int param) const { return graph_->paramValue(slot, param); }
  float reduction(uint32_t slot) const { return graph_->reduction(slot); }

  // A slot's kind as this thread made it (Kind::None once freed). Not the graph's own node, which a realtime context
  // creates on its render thread when it applies the queued command: a node just made is not there yet.
  Kind kindOf(uint32_t slot) const { return slot == LISTENER_SLOT ? Kind::Listener : slot < kinds_.size() ? kinds_[slot] : Kind::None; }
  // Drains the graph's messages: frees slots and buffer references here, then hands Ended/Freed to `on`.
  void drain(const std::function<void(const Msg&)>& on);
  uint32_t liveSlots() const { return nextSlot_ - 1 - (uint32_t)free_.size(); }

 protected:
  ContextBase(double rate, int outChannels, uint32_t chunkSize, uint32_t msgCapacityPow2, bool realtime);
  void initDestination();  // call once issue() works: adds the first chunk and creates slot 0
  uint32_t allocSlot();
  std::unique_ptr<Graph> graph_;
  std::vector<uint32_t> free_;
  std::vector<Kind> kinds_;  // host thread: kindOf()
  uint32_t nextSlot_ = 1, capacity_ = 0, chunkSize_;
  bool realtime_;
};

}  // namespace audio
}  // namespace host
