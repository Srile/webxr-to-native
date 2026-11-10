// Intl on the Android host (WP-24). host.json js.intl builds the APK with a V8 that has ICU (third_party/v8-intl,
// tools/setup-v8-android-intl.sh) and, before the isolate exists, sets ICU's default locale and time zone to the
// system's (Android gives an app no LANG or TZ: ICU would format in en-US-POSIX and UTC). That V8 has Intl,
// locale-aware toLocale*String / localeCompare, a real String.prototype.normalize and Unicode property escapes in
// regular expressions by itself; what the native side hands over as __native.intl (host/js/intl.cpp) is the locale
// and zone it chose, so that navigator.language and navigator.languages name the locale Intl formats in, as in a
// browser. Installed on the page and in every worker.
// Without __native.intl nothing here runs: the stock Android V8 has no Intl at all, and the window hosts (mac, win,
// linux, ios), whose V8s always carry ICU, keep the navigator they had ('en-US').

// The languages list a browser reports for one system locale: the tag, then its language alone (Chrome on Android
// with de-DE says ['de-DE', 'de']).
export function languagesFor(locale) {
  const tag = String(locale || 'en-US')
  const base = tag.split('-')[0]
  return base && base !== tag ? [tag, base] : [tag]
}

export function install(g, intl = g.__native && g.__native.intl) {
  if (!intl || !g.navigator) return
  const languages = Array.isArray(intl.languages) && intl.languages.length ? intl.languages.map(String) : languagesFor(intl.locale)
  g.navigator.language = languages[0]
  g.navigator.languages = Object.freeze(languages)
}
