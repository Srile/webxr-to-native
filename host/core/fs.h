#pragma once
// A filesystem path from a UTF-8 string, on every host: Windows' narrow paths are the ANSI code page, not UTF-8.
#include <filesystem>
#include <string>
namespace host {
inline std::filesystem::path fsPath(const std::string& utf8) {
#if (defined(_MSVC_LANG) ? _MSVC_LANG : __cplusplus) >= 202002L
  return std::filesystem::path(std::u8string(utf8.begin(), utf8.end()));
#else
  return std::filesystem::u8path(utf8);
#endif
}
}  // namespace host
