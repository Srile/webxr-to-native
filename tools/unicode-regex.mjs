// Unicode property escapes (\p{…} / \P{…}) spelled out as character ranges, for the Android V8 (14.9, built
// without ICU: it rejects every property escape with "Invalid property name", so a bundle using one fails to load).
// pack.mjs runs this over the staged JavaScript. Node, which has full ICU, computes each property's code points once;
// the regex keeps its meaning (the ranges are this Node's Unicode version).
//
// Both spellings are rewritten: a regex literal's `\p{L}` and a string's `\\p{L}` (for new RegExp). Inside a
// character class the ranges go in as they are; outside one they are wrapped in [...] ([^...] for \P). Whether an
// escape is one, and inside a class, comes from scanning the file as JavaScript (escapeSites).
import { readFileSync, writeFileSync } from 'node:fs'

const cache = new Map()
function ranges(prop, negate) {
  const key = (negate ? 'P' : 'p') + prop
  if (cache.has(key)) return cache.get(key)
  let re; try { re = new RegExp(`^\\p{${prop}}$`, 'u') } catch { cache.set(key, null); return null }
  const out = []; let start = -1
  for (let cp = 0; cp <= 0x110000; cp++) {
    const inSet = cp < 0x110000 && (cp < 0xD800 || cp > 0xDFFF ? re.test(String.fromCodePoint(cp)) : false) !== negate
    if (inSet && start < 0) start = cp
    else if (!inSet && start >= 0) { out.push([start, cp - 1]); start = -1 }
  }
  cache.set(key, out)
  return out
}
const esc = (cp) => cp < 0x10000 ? '\\u' + cp.toString(16).padStart(4, '0') : '\\u{' + cp.toString(16) + '}'
const body = (rs) => rs.map(([a, b]) => a === b ? esc(a) : esc(a) + '-' + esc(b)).join('')

// Where each property escape is, found by scanning the source as JavaScript: comments, strings, template literals and
// regex literals (a '/' starts one where an expression is expected: after an operator, a '(' or ',', a keyword like
// return, or at the start). Inside a regex literal the character-class state is exact; inside a string (a pattern
// for new RegExp) it is read from the pattern the string spells, `\\[` being an escaped bracket. The result maps the
// index of each escape's first backslash to { inClass }; an escape anywhere else (a comment, a division) is not one.
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'])
function escapeSites(src) {
  const sites = new Map(), n = src.length, braces = []
  let i = 0, prev = '', prevWord = ''  // the last significant token: a punctuation char, 'id' (word/number), or ''
  const isProp = (k) => src[k] === 'p' || src[k] === 'P'
  const string = (q) => {  // i at the opening quote; ends after the closing one
    let cls = false; i++
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        if (src[i + 1] === '\\') {  // a pattern backslash
          if (isProp(i + 2) && src[i + 3] === '{') sites.set(i, { inClass: cls })
          i += src[i + 2] === '\\' && src[i + 3] === '\\' ? 4 : 3  // the escaped pattern character too
        } else i += 2
        continue
      }
      if (src[i] === '[' && !cls) cls = true; else if (src[i] === ']') cls = false
      i++
    }
    i++
  }
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '"' || c === "'") { string(c); prev = 'id'; continue }
    if (c === '`') {  // a template literal; ${ ... } goes back to code until its closing brace
      i++
      while (i < n && src[i] !== '`') { if (src[i] === '\\') { i += 2; continue } if (src[i] === '$' && src[i + 1] === '{') { braces.push('tpl'); i += 2; break } i++ }
      if (src[i] === '`') { i++; prev = 'id' } else prev = '{'
      continue
    }
    if (c === '}' && braces.length && braces[braces.length - 1] === 'tpl') {  // back into the template's text
      braces.pop(); i++
      while (i < n && src[i] !== '`') { if (src[i] === '\\') { i += 2; continue } if (src[i] === '$' && src[i + 1] === '{') { braces.push('tpl'); i += 2; break } i++ }
      if (src[i] === '`') { i++; prev = 'id' } else prev = '{'
      continue
    }
    if (c === '{') { braces.push('{'); prev = c; i++; continue }
    if (c === '}') { braces.pop(); prev = c; i++; continue }
    if (c === '/') {
      const regex = prev === '' || (prev !== 'id' && prev !== ')' && prev !== ']') || (prev === 'id' && KEYWORDS_BEFORE_REGEX.has(prevWord))
      if (regex) {
        let cls = false; i++
        while (i < n) {
          const r = src[i]
          if (r === '\\') { if (isProp(i + 1) && src[i + 2] === '{') sites.set(i, { inClass: cls }); i += 2; continue }
          if (r === '[') cls = true; else if (r === ']') cls = false; else if (r === '/' && !cls) break; else if (r === '\n') break
          i++
        }
        i++; while (i < n && /[a-z]/.test(src[i])) i++
        prev = 'id'; prevWord = ''; continue
      }
      prev = c; i++; continue
    }
    if (/[A-Za-z0-9_$\u0080-\uffff]/.test(c)) { let e = i; while (e < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(src[e])) e++; prevWord = src.slice(i, e); prev = 'id'; i = e; continue }
    if (/\s/.test(c)) { i++; continue }
    prev = c; prevWord = ''; i++
  }
  return sites
}

// Returns the rewritten source and how many escapes it replaced (unknown property names are left alone).
export function rewriteUnicodeEscapes(src) {
  let n = 0
  const sites = escapeSites(src)
  const out = src.replace(/(\\\\|\\)([pP])\{([A-Za-z_]+(?:=[A-Za-z_]+)?)\}/g, (m, slash, kind, prop, at) => {
    const site = sites.get(at)
    if (!site) return m  // not a property escape of a regex or a pattern string (a comment, a literal backslash)
    const inClass = site.inClass, negate = kind === 'P'
    const rs = ranges(prop, negate && inClass)
    if (!rs) return m
    let text = inClass ? body(rs) : (negate ? '[^' : '[') + body(rs) + ']'
    if (slash === '\\\\') text = text.replace(/\\/g, '\\\\')  // inside a string literal: the backslashes are escaped
    n++
    return text
  })
  return { src: out, count: n }
}

export function rewriteFile(path) {
  const src = readFileSync(path, 'utf8')
  if (!/\\[pP]\{/.test(src)) return 0
  const { src: out, count } = rewriteUnicodeEscapes(src)
  if (count) writeFileSync(path, out)
  return count
}
