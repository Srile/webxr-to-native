// Unicode property escapes as a page writes them: literals, which tools/pack.mjs leaves as they are with js.intl
// (the stock Android V8 has no ICU and rejects them, so without js.intl they are spelled out at pack time). Its own
// module, imported dynamically: a V8 that cannot parse them fails this import, not the whole page.
export const letters = /^\p{L}+$/u
export const greek = /\p{Script=Greek}/u
export const emoji = /\p{Emoji}/u
export const emojiPresentation = /\p{Emoji_Presentation}/u
export const words = /[\p{L}\p{N}]+/gu
