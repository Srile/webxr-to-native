#include "core/json.h"
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace host {
namespace {
struct P {
  const char* s; const char* e; std::string err;
  void ws() { while (s < e && (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r')) ++s; }
  bool lit(const char* l) { size_t n = strlen(l); if ((size_t)(e - s) >= n && !memcmp(s, l, n)) { s += n; return true; } return false; }
  bool fail(const char* m) { if (err.empty()) err = m; return false; }
  bool str(std::string& out) {
    if (s >= e || *s != '"') return fail("expected string"); ++s;
    while (s < e && *s != '"') {
      if (*s == '\\') { ++s; if (s >= e) return fail("bad escape");
        switch (*s) { case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
          case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break; case 'r': out += '\r'; break; case 't': out += '\t'; break;
          case 'u': { if (e - s < 5) return fail("bad \\u"); unsigned cp = strtoul(std::string(s + 1, 4).c_str(), nullptr, 16); s += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && e - s >= 7 && s[1] == '\\' && s[2] == 'u') { unsigned lo = strtoul(std::string(s + 3, 4).c_str(), nullptr, 16); s += 6; cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); }
            if (cp < 0x80) out += (char)cp; else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
            else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
            else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
            break; }
          default: return fail("bad escape"); }
        ++s; } else out += *s++;
    }
    if (s >= e) return fail("unterminated string"); ++s; return true;
  }
  bool val(Json& j, int depth) {
    if (depth > 200) return fail("too deep");
    ws(); if (s >= e) return fail("unexpected end");
    if (lit("null")) { j.type = Json::Null; return true; }
    if (lit("true")) { j.type = Json::Bool; j.b = true; return true; }
    if (lit("false")) { j.type = Json::Bool; j.b = false; return true; }
    if (*s == '"') { j.type = Json::String; return str(j.str); }
    if (*s == '[') { ++s; j.type = Json::Array; ws(); if (s < e && *s == ']') { ++s; return true; }
      for (;;) { j.arr.emplace_back(); if (!val(j.arr.back(), depth + 1)) return false; ws(); if (s < e && *s == ',') { ++s; continue; } if (s < e && *s == ']') { ++s; return true; } return fail("expected , or ]"); } }
    if (*s == '{') { ++s; j.type = Json::Object; ws(); if (s < e && *s == '}') { ++s; return true; }
      for (;;) { ws(); std::string k; if (!str(k)) return false; ws(); if (s >= e || *s != ':') return fail("expected :"); ++s;
        if (!val(j.obj[k], depth + 1)) return false; ws(); if (s < e && *s == ',') { ++s; continue; } if (s < e && *s == '}') { ++s; return true; } return fail("expected , or }"); } }
    char* end = nullptr; double d = strtod(s, &end); if (end == s) return fail("bad value"); s = end; j.type = Json::Number; j.num = d; return true;
  }
};
void dumpStr(const std::string& v, std::string& o) {
  o += '"'; for (unsigned char c : v) { switch (c) { case '"': o += "\\\""; break; case '\\': o += "\\\\"; break; case '\n': o += "\\n"; break; case '\r': o += "\\r"; break; case '\t': o += "\\t"; break;
    default: if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += (char)c; } } o += '"';
}
void dumpTo(const Json& j, std::string& o) {
  switch (j.type) {
    case Json::Null: o += "null"; break; case Json::Bool: o += j.b ? "true" : "false"; break;
    case Json::Number: { if (std::isfinite(j.num) && j.num == std::floor(j.num) && std::fabs(j.num) < 1e15) { char b[32]; snprintf(b, sizeof b, "%.0f", j.num); o += b; } else { char b[32]; snprintf(b, sizeof b, "%.17g", j.num); o += b; } break; }
    case Json::String: dumpStr(j.str, o); break;
    case Json::Array: { o += '['; bool f = true; for (auto& v : j.arr) { if (!f) o += ','; f = false; dumpTo(v, o); } o += ']'; break; }
    case Json::Object: { o += '{'; bool f = true; for (auto& kv : j.obj) { if (!f) o += ','; f = false; dumpStr(kv.first, o); o += ':'; dumpTo(kv.second, o); } o += '}'; break; }
  }
}
}  // namespace

Json Json::parse(const std::string& text, std::string* err) {
  Json j; P p{text.data(), text.data() + text.size(), {}};
  if (!p.val(j, 0)) { if (err) *err = p.err; return Json(); }
  p.ws(); if (p.s != p.e) { if (err) *err = "trailing characters"; return Json(); }
  return j;
}
std::string Json::dump() const { std::string o; dumpTo(*this, o); return o; }

}  // namespace host
