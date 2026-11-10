// Intl on the Android host (WP-24): ICU's default locale and time zone, and __native.intl (js/intl.h).
// ICU is the copy inside third_party/v8-intl's monolith; its public headers come with it (include/unicode, the
// ICU the archive was built from, so the C API's version-suffixed names match). Compiled only with HOST_V8_INTL.
#include "js/intl.h"
#ifdef HOST_V8_INTL
#include "core/log.h"
#include "js/bind.h"
#include "js/v8compat.h"
#include <unicode/ucal.h>
#include <unicode/uloc.h>
#include <unicode/utypes.h>
#include <unicode/uvernum.h>
#include <cstring>

namespace host::intl {
namespace {
// What init() left ICU at, as BCP 47 and IANA; read by install() on any thread after that.
std::string g_locale = "en-US", g_zone = "Etc/UTC";

std::string narrow(const UChar* s, int32_t n) { std::string r; r.reserve((size_t)n); for (int32_t i = 0; i < n; ++i) r += s[i] < 0x80 ? (char)s[i] : '?'; return r; }
int32_t widen(const std::string& s, UChar* out, int32_t cap) { int32_t n = 0; for (char c : s) { if (n + 1 >= cap) break; out[n++] = (UChar)(unsigned char)c; } out[n] = 0; return n; }
}  // namespace

bool init(const std::string& locale, const std::string& timeZone) {
  // The data is linked in (icu_use_data_file=false): nothing to load, but V8 wants the call before it is used.
  if (!v8::V8::InitializeICU()) { HOST_LOGE("intl: V8::InitializeICU failed"); return false; }
  UErrorCode e = U_ZERO_ERROR;
  if (!locale.empty()) {
    char id[ULOC_FULLNAME_CAPACITY] = {}; int32_t parsed = 0;
    uloc_forLanguageTag(locale.c_str(), id, (int32_t)sizeof id, &parsed, &e);
    if (U_SUCCESS(e) && id[0]) uloc_setDefault(id, &e);
    if (U_FAILURE(e) || !id[0]) HOST_LOGW("intl: locale '%s' refused (%s); ICU's default stays", locale.c_str(), u_errorName(e));
  }
  if (!timeZone.empty()) {
    UChar z[128], canon[128]; const int32_t n = widen(timeZone, z, 128); UBool known = false; e = U_ZERO_ERROR;
    ucal_getCanonicalTimeZoneID(z, n, canon, 128, &known, &e);
    if (U_SUCCESS(e) && known) ucal_setDefaultTimeZone(z, &e);
    if (U_FAILURE(e) || !known) HOST_LOGW("intl: time zone '%s' unknown to ICU (%s); ICU's default stays", timeZone.c_str(), u_errorName(e));
  }
  // Read back what ICU now holds. Its POSIX fallback reads as en-US, as V8's Isolate::DefaultLocale maps it.
  const char* def = uloc_getDefault();
  char tag[ULOC_FULLNAME_CAPACITY] = {}; e = U_ZERO_ERROR;
  if (def && (std::strcmp(def, "en_US_POSIX") == 0 || std::strcmp(def, "c") == 0)) g_locale = "en-US";
  else if (def && uloc_toLanguageTag(def, tag, (int32_t)sizeof tag, false, &e) > 0 && U_SUCCESS(e)) g_locale = tag;
  UChar zb[128]; e = U_ZERO_ERROR; const int32_t zn = ucal_getDefaultTimeZone(zb, 128, &e);
  if (U_SUCCESS(e) && zn > 0) g_zone = narrow(zb, zn);
  HOST_LOGI("intl: ICU %s, locale %s, time zone %s (the system's: '%s', '%s')", U_ICU_VERSION, g_locale.c_str(), g_zone.c_str(), locale.c_str(), timeZone.c_str());
  return true;
}

void install(v8::Local<v8::Context> ctx, v8::Local<v8::Object> native) {
  v8::Isolate* iso = isolateOf(ctx);
  v8::Local<v8::Object> o = bind::obj(ctx, native, "intl");
  bind::setStr(ctx, o, "locale", g_locale); bind::setStr(ctx, o, "timeZone", g_zone); bind::setStr(ctx, o, "icu", U_ICU_VERSION);
  // navigator.languages as Chrome lists one system locale: the tag, then its language alone.
  const std::string base = g_locale.substr(0, g_locale.find('-'));
  v8::Local<v8::Value> langs[2] = {bind::str(iso, g_locale), bind::str(iso, base)};
  bind::set(ctx, o, "languages", v8::Array::New(iso, langs, base != g_locale ? 2 : 1));
}

}  // namespace host::intl
#endif  // HOST_V8_INTL
