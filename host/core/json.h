#pragma once
// A small JSON value + parser (RFC 8259, no exceptions) for host.json and
// the bridge. Not for hot paths.
#include <map>
#include <string>
#include <vector>

namespace host {

struct Json {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false; double num = 0; std::string str;
  std::vector<Json> arr; std::map<std::string, Json> obj;

  static Json parse(const std::string& text, std::string* err = nullptr);
  std::string dump() const;

  bool isNull() const { return type == Null; }
  const Json* get(const std::string& k) const { auto it = obj.find(k); return it == obj.end() ? nullptr : &it->second; }
  const Json& at(const std::string& k) const { static Json none; auto p = get(k); return p ? *p : none; }
  std::string s(const std::string& k, const std::string& d = "") const { auto p = get(k); return p && p->type == String ? p->str : d; }
  double n(const std::string& k, double d = 0) const { auto p = get(k); return p && p->type == Number ? p->num : d; }
  bool bo(const std::string& k, bool d = false) const { auto p = get(k); return p && p->type == Bool ? p->b : d; }
};

}  // namespace host
