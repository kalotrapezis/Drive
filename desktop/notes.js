'use strict'
/**
 * Notes (asked 2026-09-26): kept in a hidden folder of Files, `<Files>/.notes/`, one `<id>.json` per note in the
 * format the Notes apps already write (so nothing is lost moving in), with no folders — labels only.
 *
 * - `deletions.json`: a note deleted for good, so no other device brings it back.
 * - `history/<id>/<Title>-YYYY-MM-DD-HH-MM-N.json`: the note as it was each time its editor closed with changes.
 *   Undo is the editor's own, in memory; this is what is left after it.
 *
 * Sync is not Files sync (that keeps both copies of a changed file): each note is one id, and the newer
 * `updatedAt` wins, as it always has between the Notes apps. A deletion beats any edit.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const TRASH_DAYS = 30
const isId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)
const safeTitle = t => (String(t ?? '').replace(/[\/\\\0:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled')
const pad = n => String(n).padStart(2, '0')
const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}` }

class Notes {
  constructor(root, deviceId = 'desktop') {
    this.root = root
    this.deviceId = deviceId
  }

  file(id) { if (!isId(id)) throw new Error('Not a note.'); return path.join(this.root, `${id}.json`) }
  versions(id) { if (!isId(id)) throw new Error('Not a note.'); return path.join(this.root, 'history', id) }

  list() {
    let names = []
    try { names = fs.readdirSync(this.root) } catch { return [] }
    const out = []
    for (const n of names) {
      if (!n.endsWith('.json') || n === 'deletions.json') continue
      try { const note = JSON.parse(fs.readFileSync(path.join(this.root, n), 'utf8')); if (isId(note?.id)) out.push(note) } catch {}
    }
    return out
  }

  get(id) { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) } catch { return null } }

  /** Written whole, through a temporary file, so a crash never leaves half a note. */
  write(note) {
    fs.mkdirSync(this.root, { recursive: true })
    const tmp = `${this.file(note.id)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(note, null, 2))
    fs.renameSync(tmp, this.file(note.id))
    return note
  }

  create({ noteType = 'TEXT', labels = [] } = {}) {
    const now = Date.now()
    return this.write({ id: crypto.randomUUID(), title: '', content: '', createdAt: now, updatedAt: now, deviceId: this.deviceId,
      syncStatus: 'LOCAL_ONLY', noteType: noteType === 'CHECKLIST' ? 'CHECKLIST' : 'TEXT', isPinned: false, labels,
      ...(noteType === 'CHECKLIST' ? { checklistItems: [] } : {}) })
  }

  /** Only the fields a person edits; anything else a newer app wrote is kept. */
  save(id, changes) {
    const note = this.get(id)
    if (!note) throw new Error('That note is gone.')
    for (const k of ['title', 'content', 'checklistItems', 'labels', 'color', 'isPinned', 'archivedAt', 'trashedAt']) {
      if (!(k in changes)) continue
      if (changes[k] === null) delete note[k]; else note[k] = changes[k]
    }
    return this.write({ ...note, updatedAt: Date.now(), deviceId: this.deviceId })
  }

  /** The editor closed with changes: the note as it is now goes to its history, numbered. */
  snapshot(id) {
    const note = this.get(id)
    if (!note) return null
    const dir = this.versions(id)
    fs.mkdirSync(dir, { recursive: true })
    const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length + 1
    const name = `${safeTitle(note.title)}-${stamp(Date.now())}-${n}.json`
    fs.writeFileSync(path.join(dir, name), JSON.stringify(note, null, 2))
    return name
  }

  history(id) {
    const dir = this.versions(id)
    let names = []
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return [] }
    return names.map(name => { const v = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); return { name, at: v.updatedAt, title: v.title, content: v.content, checklistItems: v.checklistItems } })
      .sort((a, b) => b.at - a.at)
  }

  /** A version comes back as a new edit; what it replaces is kept in the history first. */
  restoreVersion(id, name) {
    if (path.basename(name) !== name) throw new Error('Not a version.')
    const v = JSON.parse(fs.readFileSync(path.join(this.versions(id), name), 'utf8'))
    this.snapshot(id)
    return this.save(id, { title: v.title, content: v.content, checklistItems: v.checklistItems ?? null })
  }

  deletions() { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'deletions.json'), 'utf8')) } catch { return [] } }

  /** For good: the file goes and the id is remembered. Its history stays, so it can still be read back. */
  remove(id, at = Date.now()) {
    fs.rmSync(this.file(id), { force: true })
    const list = this.deletions().filter(d => d.id !== id)
    list.push({ id, deletedAt: at, deviceId: this.deviceId })
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'deletions.json'), JSON.stringify(list))
  }

  /** Trash keeps a note 30 days, then it is deleted for good (its history stays). */
  sweep(now = Date.now()) {
    let n = 0
    for (const note of this.list()) if (note.trashedAt && note.trashedAt < now - TRASH_DAYS * 86_400_000) { this.remove(note.id, now); n++ }
    return n
  }

  /**
   * One exchange with a device: it sends every note and deletion it has; the newer of each note is kept here,
   * and the answer is what the device should take — notes newer here or missing there, and every deletion.
   */
  merge({ notes = [], deletions = [] } = {}) {
    const gone = new Map(this.deletions().map(d => [d.id, d]))
    for (const d of deletions) if (isId(d?.id) && !gone.has(d.id)) { gone.set(d.id, { id: d.id, deletedAt: Number(d.deletedAt) || Date.now(), deviceId: d.deviceId ?? null }); fs.rmSync(this.file(d.id), { force: true }) }
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'deletions.json'), JSON.stringify([...gone.values()]))
    const theirs = new Map()
    for (const n of notes) if (isId(n?.id) && !gone.has(n.id)) {
      theirs.set(n.id, n)
      const mine = this.get(n.id)
      if (!mine || (Number(n.updatedAt) || 0) > (Number(mine.updatedAt) || 0)) this.write(n)
    }
    const send = this.list().filter(m => !theirs.has(m.id) || (Number(m.updatedAt) || 0) > (Number(theirs.get(m.id).updatedAt) || 0))
    return { notes: send, deletions: [...gone.values()] }
  }

  /**
   * The Notes apps' vault (`notes/` and one level of folders), once: a folder becomes a label of its notes.
   * Notes already here are not touched; the old vault is only read.
   */
  importVault(dir) {
    const gone = new Set(this.deletions().map(d => d.id))
    let added = 0
    const take = (file, folder) => {
      let note
      try { note = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
      if (!isId(note?.id) || gone.has(note.id) || this.get(note.id)) return
      const label = note.folderName ?? folder
      delete note.folderName
      if (label) note.labels = [...new Set([...(note.labels ?? []), label])]
      this.write(note); added++
    }
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
    for (const e of entries) {
      if (e.isDirectory()) for (const f of fs.readdirSync(path.join(dir, e.name))) { if (f.endsWith('.json')) take(path.join(dir, e.name, f), e.name) }
      else if (e.name.endsWith('.json') && !['deletions.json', 'folders.json'].includes(e.name)) take(path.join(dir, e.name), null)
    }
    return added
  }
}

module.exports = { Notes, safeTitle }
