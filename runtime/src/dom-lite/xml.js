// XML text helpers shared by DOMParser (index.js) and the SVG normaliser (images/svg.js).
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
export const unescapeXml = (t) => t.indexOf('&') < 0 ? t : t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENTITIES[e] ?? m)
