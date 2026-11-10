#pragma once
// Intl on the Android host (WP-24, host.json js.intl; CMake HOST_V8_INTL links third_party/v8-intl, V8 14.9 with ICU
// and its data compiled in, instead of the stock lib that has none). Android hands an app no LANG or TZ, so ICU would
// default to en-US-POSIX and a zone guessed from libc's abbreviation: init() sets ICU's default locale and time zone
// to the system's before the isolate exists (V8 reads both lazily and caches them per isolate), and install() hands
// the page and each worker what it chose as __native.intl = { locale, languages, timeZone, icu }, for
// navigator.language (runtime/src/intl). A build without HOST_V8_INTL has none of this.
#ifdef HOST_V8_INTL
#include <string>
#include <v8.h>

namespace host::intl {

// locale: a BCP 47 tag ("de-DE"), timeZone: an IANA id ("Europe/Berlin"); either may be empty (ICU's own default).
// Calls v8::V8::InitializeICU. Before Engine::initPlatform, once per process.
bool init(const std::string& locale, const std::string& timeZone);
// __native.intl on a page's or a worker's __native (any thread: the values are fixed by init()).
void install(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native);

}  // namespace host::intl
#endif
