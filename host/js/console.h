#pragma once
#include <functional>
#include <string>
#include <v8.h>
namespace host {
// console.* on the global; each message also goes to `sink` (the inspector, when attached).
void installConsole(v8::Local<v8::Context> ctx, std::function<void(int level, const std::string&)> sink);
}
