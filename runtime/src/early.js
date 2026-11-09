// early.js — imported first by index.js, so its body runs before any other module's. IWER (webxr/) defines its
// classes at module level (`class XRSession extends EventTarget`), which needs EventTarget, Event and DOMException
// to exist while the bundle evaluates, before dom-lite's install() puts the rest of the page surface on the global.
// These are the very classes install() installs (it assigns the same ones), so nothing changes identity later.
import { Event, EventTarget } from './dom-lite/events.js'
import { DOMException } from './dom-lite/globals.js'

const g = globalThis
if (typeof g.EventTarget !== 'function') g.EventTarget = EventTarget
if (typeof g.Event !== 'function') g.Event = Event
if (typeof g.DOMException !== 'function') g.DOMException = DOMException
