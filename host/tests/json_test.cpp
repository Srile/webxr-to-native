#include "core/json.h"
#include <cassert>
#include <cstdio>
using host::Json;
int main() {
  std::string err;
  Json j = Json::parse(R"({"a":1,"b":[true,null,"xé\n"],"c":{"d":-2.5e3}})", &err);
  assert(err.empty()); assert(j.n("a") == 1); assert(j.at("b").arr.size() == 3); assert(j.at("b").arr[2].str == "x\xc3\xa9\n");
  assert(j.at("c").n("d") == -2500);
  Json bad = Json::parse("{\"a\":}", &err); assert(!err.empty()); (void)bad;
  err.clear(); Json rt = Json::parse(j.dump(), &err); assert(err.empty()); assert(rt.dump() == j.dump());
  puts("json_test ok"); return 0;
}
