#pragma once
#include <functional>
#include <string>
#include <vector>
#include "core/json.h"
namespace host {
class Engine;
struct Bridge {
  Engine* engine = nullptr;
  std::function<void()> pump;                                   // run the loop once + V8 pump (used while awaiting promises)
  std::function<std::string()> stats;                           // JSON
  std::function<void(int eye, std::function<void(const std::string&)> reply)> shot;  // capture the next frame, reply JSON
};
// Handles one request; `reply` may be called later (shot) or synchronously.
void bridgeHandle(Bridge& b, const std::string& requestJson, std::function<void(const std::string&)> reply);
// Encode RGBA (GL bottom-up) to the {width,height,png} reply.
std::string bridgeEncodeShot(int w, int h, const std::vector<unsigned char>& rgba);
void bridgeLog(const std::string& line);
}
