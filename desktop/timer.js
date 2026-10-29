'use strict'
/**
 * Tetra's Timer on the computer (Drive-Android Plan.md § Timer; Timer.kt is the phone's twin, the same rules). A timer is
 * one small JSON file in ~/Tetra/.System/Timer/Shared, synced as files are, at once (files.js SCOPES.timer). Every device counts
 * down by itself from the end time in it; only Start, Pause, Resume, Stop and OK write the file:
 *
 *   {"id":"k3f9a2","seconds":300,"label":"","state":"running","ends":"2026-10-18T16:05:00Z","left":0,"rev":1,"by":"Tablet","pinned":false}
 *
 * `pinned`: the card stays when stopped or done, ready to start again; the trash takes it away (on every device).
 * state: running (to `ends`), paused (`left` seconds remain), stopped. `rev` goes up by one each change; the highest wins,
 * equal ones stopped first, so clocks a few seconds apart decide nothing. Claude starts one by writing such a file.
 */
const fs = require('node:fs')
const i18n = require('./i18n')
const path = require('node:path')
const crypto = require('node:crypto')

const RUNNING = 'running', PAUSED = 'paused', STOPPED = 'stopped'
const ORDER = [RUNNING, PAUSED, STOPPED]
const UNANSWERED_MS = 10 * 60_000 // a timer nobody answered rings ten minutes at most
const MAX = 9 // the screen holds nine (the user, 18 Oct)

function parse(text, file = null) {
  try {
    const o = JSON.parse(text)
    if (!o || typeof o !== 'object') return null
    const state = String(o.state ?? RUNNING).toLowerCase()
    if (!ORDER.includes(state)) return null
    const ends = typeof o.ends === 'string' && o.ends ? Date.parse(o.ends) : null
    if (Number.isNaN(ends)) return null
    const id = typeof o.id === 'string' && o.id ? o.id : file ? path.basename(file, '.json') : null
    if (!id) return null
    return { id, seconds: Math.max(0, Math.trunc(+o.seconds || 0)), label: typeof o.label === 'string' ? o.label : '', state, ends,
      left: Number.isFinite(+o.left) ? +o.left : 0, rev: Number.isSafeInteger(o.rev) ? o.rev : 0, by: typeof o.by === 'string' ? o.by : '', file, pinned: o.pinned === true }
  } catch { return null }
}

const leftMs = (r, now) => r.state === RUNNING ? Math.max(0, (r.ends ?? 0) - now) : r.state === PAUSED ? Math.round(r.left * 1000) : 0
const over = (r, now) => r.state === STOPPED || (r.state === RUNNING && (r.ends == null || now > r.ends + UNANSWERED_MS))
const card = (r, now) => !over(r, now) || r.pinned
const ringing = (r, now) => r.state === RUNNING && r.ends != null && now >= r.ends && !over(r, now)

/** One record per id: a timer changed on two devices between syncs comes as "x (2).json" beside "x.json". */
function winners(all) {
  const best = new Map()
  const rank = r => [r.rev, ORDER.indexOf(r.state), -(r.file ? path.basename(r.file).length : 0)]
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
  for (const r of all) if (!best.has(r.id) || better(r, best.get(r.id))) best.set(r.id, r)
  return [...best.values()]
}

/**
 * Each device writes only its own file of a timer, `<id>.<device>.json`, and the highest rev among them is the timer: two
 * devices never change one file, so sync never keeps two versions side by side ("x (3) (3).json", 18 Oct). A record with no
 * device (written by hand) keeps "<id>.json". As the phone's TimerFiles.fileName.
 */
const fileName = (id, by) => { const tag = String(by ?? '').replace(/[^A-Za-z0-9_-]/g, ''); return tag ? `${id}.${tag}.json` : `${id}.json` }

const json = r => JSON.stringify({ id: r.id, seconds: r.seconds, label: r.label, state: r.state, ends: r.ends == null ? null : new Date(r.ends).toISOString(),
  left: r.left, rev: r.rev, by: r.by, pinned: !!r.pinned }, null, 1) + '\n'

class Timers {
  constructor(root, by = 'Computer') { this.root = root; this.by = by }

  read() {
    let names = []
    try { names = fs.readdirSync(this.root) } catch { return [] }
    return winners(names.filter(n => !n.startsWith('.') && n.toLowerCase().endsWith('.json')).map(n => {
      const f = path.join(this.root, n)
      try { return fs.statSync(f).isFile() ? parse(fs.readFileSync(f, 'utf8'), f) : null } catch { return null }
    }).filter(Boolean))
  }

  /** The timers to show, the one ending first on top, each with its time left by this computer's clock. */
  active(now = Date.now()) {
    return this.read().filter(r => !over(r, now)).map(r => ({ ...r, leftMs: leftMs(r, now), ringing: ringing(r, now) })).sort((a, b) => a.leftMs - b.leftMs)
  }

  /** The cards on the screen: the active ones, then the pinned ones ready to start again (`ready`), nine at most. */
  cards(now = Date.now()) {
    return this.read().filter(r => card(r, now)).map(r => ({ ...r, leftMs: leftMs(r, now), ringing: ringing(r, now), ready: over(r, now) }))
      .sort((a, b) => a.ready - b.ready || a.leftMs - b.leftMs || a.seconds - b.seconds).slice(0, MAX)
  }

  /** Written beside, then renamed over: nobody reads half a timer. */
  write(r) {
    fs.mkdirSync(this.root, { recursive: true })
    const to = path.join(this.root, fileName(r.id, r.by))
    const part = path.join(this.root, `.${path.basename(to)}.part`)
    fs.writeFileSync(part, json(r))
    fs.renameSync(part, to)
    return { ...r, file: to }
  }

  /** A new timer, in the file of one that is over if there is one (its id on, a higher rev): files = timers at once. */
  start(seconds, now = Date.now(), label = '') {
    seconds = Math.trunc(+seconds)
    if (!(seconds > 0 && seconds < 100 * 3600)) throw new Error(i18n.t('timer.tooLong'))
    const all = this.read()
    if (all.filter(r => card(r, now)).length >= MAX) throw new Error(i18n.t('timer.tooMany'))
    const free = all.filter(r => over(r, now) && !r.pinned).sort((a, b) => String(a.file).localeCompare(String(b.file)))[0]
    return this.write({ id: free?.id ?? crypto.randomBytes(3).toString('hex'), seconds, label, state: RUNNING, ends: now + seconds * 1000, left: 0,
      rev: (free?.rev ?? 0) + 1, by: this.by, file: null })
  }

  /** Pause, resume, stop, ok, restart, pin, unpin or trash on [id], as its file is now; answers whether anything changed. */
  change(id, action, now = Date.now()) {
    const r = this.read().find(t => t.id === id)
    if (!r) return false
    let next = null
    if (action === 'pause' && r.state === RUNNING) next = { ...r, state: PAUSED, left: leftMs(r, now) / 1000, ends: null }
    else if (action === 'resume' && r.state === PAUSED) next = { ...r, state: RUNNING, ends: now + Math.round(r.left * 1000), left: 0 }
    else if ((action === 'stop' || action === 'ok') && r.state !== STOPPED) next = { ...r, state: STOPPED, ends: null, left: 0 }
    else if (action === 'restart') next = { ...r, state: RUNNING, ends: now + r.seconds * 1000, left: 0 }
    else if (action === 'pin' || action === 'unpin') { if (r.pinned !== (action === 'pin')) next = { ...r, pinned: action === 'pin' } }
    else if (action === 'trash') next = { ...r, state: STOPPED, ends: null, left: 0, pinned: false }
    if (!next) return false
    this.write({ ...next, rev: r.rev + 1, by: this.by })
    return true
  }

  /**
   * The waste (the user, 21 Oct: "the timer app creates a lot of duplicat files"): sync's "x (2).json" copies from before each
   * device wrote only its own file. Every timer's copies go; when the files that stay would not hold the timer as it is (its
   * newest state, pin and all, was in a copy), this computer first writes it into its own file. Sync never deletes, so the
   * phone does the same (TimerFiles.clean). Answers how many went.
   */
  clean() {
    let names = []
    try { names = fs.readdirSync(this.root) } catch { return 0 }
    const all = names.filter(n => !n.startsWith('.') && n.toLowerCase().endsWith('.json')).map(n => {
      const f = path.join(this.root, n)
      try { return fs.statSync(f).isFile() ? parse(fs.readFileSync(f, 'utf8'), f) : null } catch { return null }
    }).filter(Boolean)
    const copy = r => / \(\d+\)\.json$/i.test(path.basename(r.file))
    let removed = 0
    for (const id of new Set(all.map(r => r.id))) {
      const group = all.filter(r => r.id === id)
      const [w] = winners(group)
      const copies = group.filter(copy)
      if (!copies.length) continue
      const [rest] = winners(group.filter(r => !copy(r)))
      if (!rest || rest.rev < w.rev || rest.state !== w.state || rest.pinned !== w.pinned || rest.ends !== w.ends || rest.left !== w.left) this.write({ ...w, by: this.by })
      for (const r of copies) { try { fs.unlinkSync(r.file); removed++ } catch {} }
    }
    return removed
  }

  /** When the next running timer ends (for the alarm), or null. */
  nextEnd(now = Date.now()) {
    const ends = this.read().filter(r => r.state === RUNNING && r.ends != null && r.ends > now).map(r => r.ends)
    return ends.length ? Math.min(...ends) : null
  }
}

/** "5 min", "1 h 30 min", "45 s": as the phone's durationText. */
function durationText(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return [h && i18n.t('timer.h', { n: h }), m && i18n.t('timer.min', { n: m }), (s || !seconds) && i18n.t('timer.s', { n: s })].filter(Boolean).join(' ')
}

module.exports = { Timers, fileName, parse, winners, leftMs, over, ringing, durationText, UNANSWERED_MS, MAX }
