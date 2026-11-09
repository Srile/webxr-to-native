import test from 'node:test'; import assert from 'node:assert/strict'
import { rewriteUnicodeEscapes } from '../../tools/unicode-regex.mjs'

// The rewritten regex must match exactly what the original matches (sampled over every plane).
const same = (orig, mod) => { for (let cp = 0; cp < 0x110000; cp += 97) { if (cp >= 0xD800 && cp <= 0xDFFF) continue; const s = String.fromCodePoint(cp); orig.lastIndex = mod.lastIndex = 0; if (orig.test(s) !== mod.test(s)) return false } return true }
const run = (src) => (0, eval)(`(() => { const a = [[1]], y = 4, f = (t, r) => r; return ${src} })()`)

test('property escapes become ranges with the same meaning, wherever the regex sits', () => {
  for (const [text, orig] of [
    ['/[\\p{Cc}\\p{Cf}\\u2028\\u2029]/gu', /[\p{Cc}\p{Cf}\u2028\u2029]/gu],
    ['[[/\\p{L}+/u, "word"]][0][0]', /\p{L}+/u],                       // inside an array literal (a review finding)
    ['(a[0], /[^\\P{N}x]/u)', /[^\P{N}x]/u],
    ['(y / 2, /\\P{L}/u)', /\P{L}/u],                                    // a division before the literal
    ['new RegExp("[\\\\p{Lu}\\\\[]+", "u")', new RegExp('[\\p{Lu}\\[]+', 'u')],  // a pattern string, an escaped [
    ['f(`${a[0]}`, /\\p{Lu}/u)', /\p{Lu}/u],
  ]) {
    const { src, count } = rewriteUnicodeEscapes(text)
    assert.ok(count > 0 && !/\\[pP]\{/.test(src), text)
    assert.ok(same(orig, run(src)), text)
  }
})

test('a comment or a literal backslash before p is left alone', () => {
  assert.equal(rewriteUnicodeEscapes('// about \\p{L}\nconst s = /\\\\p{L}/').count, 0)
})
