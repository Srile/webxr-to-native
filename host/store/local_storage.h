#pragma once
// localStorage: a JSON file in the app's files dir, debounced writes, 5 MB cap.
#include <map>
#include <string>
namespace host {
class LocalStorage {
 public:
  void init(const std::string& filePath);
  bool get(const std::string& k, std::string& v) const;
  bool set(const std::string& k, const std::string& v);  // false when over the cap
  void remove(const std::string& k);
  void clear();
  size_t size() const { return map_.size(); }
  std::string key(size_t i) const;
  void flush();            // write now if dirty
  void tick(double nowMs); // debounce
 private:
  std::string path_; std::map<std::string, std::string> map_; bool dirty_ = false; double dirtyAt_ = 0; size_t bytes_ = 0;
};
}
