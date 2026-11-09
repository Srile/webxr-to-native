#include "audio/context.h"

namespace host {
namespace audio {

ContextBase::ContextBase(double rate, int outChannels, uint32_t chunkSize, uint32_t msgCapacityPow2, bool realtime)
    : graph_(new Graph(rate, outChannels, chunkSize, msgCapacityPow2)), chunkSize_(chunkSize), realtime_(realtime) {}
ContextBase::~ContextBase() {}

void ContextBase::initDestination() {
  allocSlot();  // slot 0
  Command c; c.op = Op::CreateNode; c.a = 0; c.kind = (uint8_t)Kind::Destination; issue(c);
  nextSlot_ = 1;
}

uint32_t ContextBase::allocSlot() {
  if (!free_.empty()) { uint32_t s = free_.back(); free_.pop_back(); return s; }
  if (nextSlot_ >= capacity_) {
    // A new chunk of nodes (and four edges per node), constructed here and handed over.
    Node* nodes = new Node[chunkSize_];
    Command c; c.op = Op::AddNodeChunk; c.ptr = nodes; c.count = chunkSize_;
    if (!issue(c)) { delete[] nodes; return NONE; }
    Edge* edges = new Edge[chunkSize_ * 4];
    Command e; e.op = Op::AddEdgeChunk; e.ptr = edges; e.count = chunkSize_ * 4;
    if (!issue(e)) delete[] edges;
    capacity_ += chunkSize_;
  }
  return nextSlot_++;
}

uint32_t ContextBase::createNode(Kind kind) {
  uint32_t slot = allocSlot();
  if (slot == NONE) return NONE;
  Command c; c.op = Op::CreateNode; c.a = slot; c.kind = (uint8_t)kind;
  if (!issue(c)) { free_.push_back(slot); return NONE; }
  return slot;
}

void ContextBase::drain(const std::function<void(const Msg&)>& on) {
  Msg m;
  while (graph_->msgs().pop(m)) {
    switch (m.type) {
      case Msg::Ended: on(m); break;
      case Msg::Freed: if (m.slot != 0) free_.push_back(m.slot); on(m); break;
      case Msg::ReleaseBuffer: if (m.ptr) ((AudioBufferData*)m.ptr)->unref(); break;
    }
  }
}

}  // namespace audio
}  // namespace host
