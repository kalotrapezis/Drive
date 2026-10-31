'use strict'
/**
 * The user's AI switch (31 Oct 2026: "a switch list on what apps you want the AI and a general off setting for the AI,
 * because we sell it as no-internet-big-company"): one small file every device shares, so one choice holds on the
 * computer, the phone and the tablet.
 *
 *   ~/Tetra/.System/Assistant/Shared/ai.json   (synced as "AI Assist/ai.json"; system.SHARED, TetraSystem.SHARED)
 *   { "enabled": bool, "apps": { "mail": true, "calendar": false, … }, "setAt": ms, "setBy": "desktop" | "<device>" }
 *   an app not named is allowed; whoever changes it writes the whole file, the later one winning
 *
 * Off, nothing at all is sent to an AI provider (assistant.js refuses before any request) and AI Assist is hidden; an app
 * switched off is neither read nor changed by the assistant, its tools not even offered. No file yet: on only where an
 * AI key is already set (an install that used AI Assist keeps working), off on a fresh one.
 */
const fs = require('node:fs')
const path = require('node:path')

/** The apps the assistant can reach, by the names both platforms use in "apps". */
const APPS = ['mail', 'calendar', 'notes', 'files', 'contacts', 'phone', 'timer', 'maps', 'web']

class AiSwitch {
  /** [hasKey]() says whether an AI key is set here: the default when no one has chosen yet. */
  constructor(file, { hasKey = () => false } = {}) { this.file = file; this.hasKey = hasKey }
  read() {
    let saved = null
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    const apps = Object.fromEntries(APPS.map(a => [a, saved?.apps?.[a] !== false]))
    return { enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : !!this.hasKey(), apps, chosen: !!saved }
  }
  /** Whether the AI may be used at all. */
  on() { return this.read().enabled }
  /** Whether the AI may read and act in [app]. */
  allows(app) { const s = this.read(); return s.enabled && s.apps[app] !== false }
  /** The whole file, written at once; other apps' keys (the phone may know more) are kept. */
  set(changes = {}) {
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    const now = this.read()
    const value = { ...saved, enabled: typeof changes.enabled === 'boolean' ? changes.enabled : now.enabled, apps: { ...saved.apps, ...now.apps }, setAt: Date.now(), setBy: 'desktop' }
    for (const [k, v] of Object.entries(changes.apps ?? {})) if (/^[a-z]{1,20}$/.test(k) && typeof v === 'boolean') value.apps[k] = v
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const part = path.join(path.dirname(this.file), `.${path.basename(this.file)}.part`)
    fs.writeFileSync(part, JSON.stringify(value, null, 2)); fs.renameSync(part, this.file)
    return this.read()
  }
}

module.exports = { AiSwitch, APPS }
