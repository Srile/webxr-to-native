// Platform globals shared by the window and worker preludes: DOMException, AbortController/AbortSignal.
import * as ev from './events.js'
export class DOMException extends Error { constructor(message = '', name = 'Error') { super(message); this.name = name; this.code = DOMException._codes[name] ?? 0 } static _codes = { IndexSizeError: 1, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12, InvalidAccessError: 15, SecurityError: 18, NetworkError: 19, AbortError: 20, QuotaExceededError: 22, DataCloneError: 25 } }

export function installAbort(g) {
  class AbortSignal extends ev.EventTarget { constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null } throwIfAborted() { if (this.aborted) throw this.reason } static abort(r) { const s = new AbortSignal(); s.aborted = true; s.reason = r ?? new DOMException('aborted', 'AbortError'); return s } static timeout(ms) { const c = new AbortController(); g.setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms); return c.signal } static any(sigs) { const c = new AbortController(); for (const s of sigs) { if (s.aborted) { c.abort(s.reason); break } s.addEventListener('abort', () => c.abort(s.reason), { once: true }) } return c.signal } }
  class AbortController { constructor() { this.signal = new AbortSignal() } abort(r) { if (this.signal.aborted) return; this.signal.aborted = true; this.signal.reason = r ?? new DOMException('aborted', 'AbortError'); this.signal.dispatchEvent(new ev.Event('abort')) } }
  g.AbortSignal = AbortSignal; g.AbortController = AbortController
}
