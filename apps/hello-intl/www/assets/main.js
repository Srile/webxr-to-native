// hello-intl (WP-24): Intl and the rest of ECMA-402 / ICU on the host. With host.json js.intl the Android build links
// V8 with ICU (third_party/v8-intl); the window hosts' V8s always have it. Each check compares with what Chrome
// prints. The system's locale and zone (the device's: __native.intl on Android) must agree across Intl's defaults,
// Date's local time, navigator.language and a worker. The screen is green when all pass, red otherwise; the log
// says which, then "PASS n/n" (or "FAIL k/n") and READY / FAILED.
const log = (m) => console.log('hello-intl: ' + m)
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`) }
const eq = (name, got, want) => check(name, got === want, got === want ? JSON.stringify(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const sp = (s) => s.replace(/[\s ]/g, ' ')  // ICU puts U+00A0 / U+202F where Chrome shows a space
const run = (name, f) => { try { f() } catch (e) { check(name, false, String(e?.message ?? e)) } }
const sys = globalThis.__native?.intl  // the Android host with js.intl: the locale and zone it gave ICU

run('Intl exists', () => check('Intl exists', typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function', typeof Intl))
run('NumberFormat', () => {
  eq('NumberFormat de-DE grouping', new Intl.NumberFormat('de-DE').format(1234567.891), '1.234.567,891')
  eq('NumberFormat de-DE EUR', sp(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5)), '1.234,50 €')
  eq('NumberFormat en compact', new Intl.NumberFormat('en', { notation: 'compact' }).format(1234567), '1.2M')
})
run('DateTimeFormat', () => {
  const tokyo = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  eq('DateTimeFormat Asia/Tokyo', tokyo.format(new Date(Date.UTC(2024, 0, 1, 0, 0))), '09:00')
  eq('DateTimeFormat resolved zone', tokyo.resolvedOptions().timeZone, 'Asia/Tokyo')
})
run('system locale and zone', () => {
  const r = new Intl.DateTimeFormat().resolvedOptions()
  log(`system: Intl default locale ${r.locale}, time zone ${r.timeZone}; navigator.language ${navigator.language} [${navigator.languages}]${sys ? `; __native.intl ${JSON.stringify(sys)}` : ''}`)
  check('default locale and zone set', !!r.locale && !!r.timeZone && r.timeZone !== 'Etc/Unknown', `${r.locale} ${r.timeZone}`)
  // Date's local time runs on the same zone as Intl's default: the UTC offset Intl names for now is Date's.
  const d = new Date(), name = new Intl.DateTimeFormat('en-US', { timeZone: r.timeZone, timeZoneName: 'longOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value
  const m = /GMT(?:([+-])(\d\d):(\d\d))?/.exec(name), off = m && m[1] ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0
  check('Date local time = Intl default zone', -d.getTimezoneOffset() === off, `${name} vs getTimezoneOffset ${d.getTimezoneOffset()}`)
  if (sys) {  // Android with js.intl: the device's locale and zone made it through to the page
    eq('navigator.language = system locale', navigator.language, sys.locale)
    check('Intl default locale = navigator.language', r.locale === navigator.language || r.locale.startsWith(navigator.language + '-u-'), `${r.locale} / ${navigator.language}`)
    check('Intl default zone = system zone', r.timeZone === sys.timeZone || new Intl.DateTimeFormat('en', { timeZone: sys.timeZone }).resolvedOptions().timeZone === r.timeZone, `${r.timeZone} / ${sys.timeZone}`)
  }
})
run('PluralRules', () => {
  const en = new Intl.PluralRules('en'), ru = new Intl.PluralRules('ru')
  eq('PluralRules en', [1, 2].map(n => en.select(n)).join(), 'one,other')
  eq('PluralRules ru', [1, 2, 5, 21].map(n => ru.select(n)).join(), 'one,few,many,one')
  eq('PluralRules en ordinal', [1, 2, 3, 4].map(n => new Intl.PluralRules('en', { type: 'ordinal' }).select(n)).join(), 'one,two,few,other')
})
run('Collator', () => {
  eq('Collator de: ä with a', ['z', 'ä', 'a'].sort(new Intl.Collator('de').compare).join(''), 'aäz')
  eq('Collator sv: ä after z', ['z', 'ä', 'a'].sort(new Intl.Collator('sv').compare).join(''), 'azä')
  check('localeCompare de vs sv', 'ä'.localeCompare('z', 'de') < 0 && 'ä'.localeCompare('z', 'sv') > 0, `${'ä'.localeCompare('z', 'de')} ${'ä'.localeCompare('z', 'sv')}`)
})
run('RelativeTimeFormat', () => {
  eq('RelativeTimeFormat en auto', new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'), 'yesterday')
  eq('RelativeTimeFormat de', new Intl.RelativeTimeFormat('de').format(3, 'hour'), 'in 3 Stunden')
})
run('ListFormat', () => {
  eq('ListFormat en', new Intl.ListFormat('en', { type: 'conjunction' }).format(['a', 'b', 'c']), 'a, b, and c')
  eq('ListFormat de', new Intl.ListFormat('de').format(['a', 'b', 'c']), 'a, b und c')
})
run('Segmenter', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', s = family + 'é!'
  eq('Segmenter graphemes (ZWJ family, e + accent, !)', [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map(x => x.segment.length).join(), '11,2,1')
  eq('Segmenter words', [...new Intl.Segmenter('en', { granularity: 'word' }).segment('Hello, world!')].filter(x => x.isWordLike).map(x => x.segment).join('|'), 'Hello|world')
})
run('DisplayNames', () => {
  eq('DisplayNames en region', new Intl.DisplayNames(['en'], { type: 'region' }).of('DE'), 'Germany')
  eq('DisplayNames de language', new Intl.DisplayNames(['de'], { type: 'language' }).of('fr'), 'Französisch')
})
run('supportedValuesOf', () => check('supportedValuesOf', Intl.supportedValuesOf('timeZone').includes('Asia/Tokyo') && Intl.supportedValuesOf('currency').includes('EUR') && Intl.supportedValuesOf('collation').length > 3, `${Intl.supportedValuesOf('timeZone').length} zones`))
run('Locale', () => {
  eq('Locale maximize zh-TW', new Intl.Locale('zh-TW').maximize().toString(), 'zh-Hant-TW')
  eq('getCanonicalLocales', Intl.getCanonicalLocales('EN-us').join(), 'en-US')
})
run('toLocaleString', () => {
  eq('Number toLocaleString de-DE', (1234.5).toLocaleString('de-DE'), '1.234,5')
  eq('Date toLocaleString de-DE', new Date(Date.UTC(2024, 2, 5, 14, 7, 9)).toLocaleString('de-DE', { timeZone: 'UTC' }), '5.3.2024, 14:07:09')
  eq('toLocaleUpperCase tr', 'i'.toLocaleUpperCase('tr'), 'İ')
})
run('normalize', () => check('String normalize NFC/NFD/NFKC', 'é'.normalize('NFC') === 'é' && 'é'.normalize('NFD').length === 2 && 'ﬁ'.normalize('NFKC') === 'fi'))

async function regexes() {
  const r = await import('./regex.js')
  check('/\\p{L}+/u', r.letters.test('Grüße日本') && !r.letters.test('a1'))
  check('/\\p{Script=Greek}/u', r.greek.test('λόγος') && !r.greek.test('logos'))
  check('/\\p{Emoji}/u', r.emoji.test('\u{1F600}') && r.emojiPresentation.test('\u{1F680}') && !r.emojiPresentation.test('a'))
  eq('\\p{L}\\p{N} words', 'Grüße, 42 мира'.match(r.words).join('|'), 'Grüße|42|мира')
}

// A worker sees the same locale and has Intl too (workers are V8 isolates of their own).
async function worker() {
  const src = `postMessage([navigator.language, typeof Intl === 'object' ? new Intl.NumberFormat('de-DE').format(1234.5) : 'no Intl', typeof Intl === 'object' ? new Intl.DateTimeFormat().resolvedOptions().timeZone : ''])`
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  const got = await Promise.race([new Promise((r) => { w.onmessage = (e) => r(e.data) }), new Promise((_, j) => setTimeout(() => j(new Error('worker timed out')), 5000))])
  w.terminate?.()
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  check('worker: navigator.language, Intl, zone', got[0] === navigator.language && got[1] === '1.234,5' && got[2] === zone, JSON.stringify(got))
}

function paint(ok) {
  const c = document.createElement('canvas'); document.body.appendChild(c)
  const gl = c.getContext('webgl2'); if (!gl) return
  const draw = () => { gl.clearColor(ok ? 0.1 : 0.8, ok ? 0.7 : 0.1, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw) }
  draw()
}

for (const [name, f] of [['regexes', regexes], ['worker', worker]]) {
  try { await f() } catch (e) { check(name, false, String(e?.message ?? e)) }
}
const passed = results.filter(r => r.ok).length, ok = results.length > 0 && passed === results.length
log(`${ok ? 'PASS' : 'FAIL'} ${passed}/${results.length}${ok ? '' : ': ' + results.filter(r => !r.ok).map(r => r.name).join('; ')}`)
paint(ok)
log(ok ? 'READY' : 'FAILED')
