'use strict'
// Folders as user collections (SYNC_PLAN.md §7 / D), the phone's FolderRules on this computer. The Photos root
// mirrors the phone's folders (DCIM/Camera, Pictures/Viber…), so the same folder gets the same name on both, and
// the collection it becomes is one collection everywhere (collections are matched by name when they first meet).
const library = require('./library')

/** Always shown, never asked: the camera, screenshots, and what the computer sends to devices. */
const DEFAULTS = new Set(['camera', 'screenshots', 'tetra'])
const PHOTO_ROOTS = new Set(['dcim', 'pictures', 'movies'])

/**
 * The folder a file belongs to, or null for a file loose in the Photos root (always shown). Named after the
 * folder under DCIM/Pictures/Movies, so Pictures/Viber and Movies/Viber are one "Viber"; all of Download is one.
 * Unlike the phone, any other top-level folder counts: everything under the Photos root is a photo.
 */
function folderName(relFile) {
  const parts = String(relFile).split('/').slice(0, -1).filter(Boolean)
  if (!parts.length) return null
  const root = parts[0].toLowerCase()
  if (root === 'download') return 'Download'
  if (!PHOTO_ROOTS.has(root) || parts.length === 1) return parts[0]
  return parts[1]
}
const isDefault = name => DEFAULTS.has(name.toLowerCase())

class Folders {
  constructor(db) {
    this.db = db
    // Your answer per folder of this computer. A folder is this machine's, so the answer does not sync; its collection does.
    db.exec('CREATE TABLE IF NOT EXISTS folder_choices (name TEXT PRIMARY KEY COLLATE NOCASE, included INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  }

  /**
   * Lower-cased folder → answer. A folder that already has a collection of its name counts as a yes: that is
   * what a phone that included Viber sends here, and asking again about the same folder would be asking twice.
   */
  choices() {
    const out = {}
    for (const c of this.db.prepare('SELECT name FROM collections WHERE deleted = 0').all()) out[c.name.toLowerCase()] = true
    for (const r of this.db.prepare('SELECT name, included FROM folder_choices').all()) out[r.name.toLowerCase()] = !!r.included
    return out
  }

  isShown(relFile, choices = this.choices()) {
    const name = folderName(relFile)
    return name == null || isDefault(name) || choices[name.toLowerCase()] === true
  }

  /** Every folder that is not a default: its name, how much is in it, a few newest photos, and the answer (null = never asked). */
  list() {
    const choices = this.choices()
    const groups = new Map()
    for (const m of this.db.prepare('SELECT path, sha256, thumb FROM media ORDER BY taken_at DESC').all()) {
      const name = folderName(m.path)
      if (name == null || isDefault(name)) continue
      const key = name.toLowerCase()
      const g = groups.get(key) ?? groups.set(key, { spellings: {}, count: 0, samples: [], shas: new Set() }).get(key)
      g.spellings[name] = (g.spellings[name] ?? 0) + 1
      g.count++
      g.shas.add(m.sha256)
      if (m.thumb && g.samples.length < 4) g.samples.push(m.sha256)
    }
    return [...groups].map(([key, g]) => ({
      // Named the way most of its files spell it: pictures/Viber should not rename Viber.
      name: Object.entries(g.spellings).sort((a, b) => b[1] - a[1])[0][0],
      count: g.count, samples: g.samples, shas: [...g.shas], included: key in choices ? choices[key] : null,
    })).sort((a, b) => b.count - a.count)
  }

  questions() { return this.list().filter(f => f.included === null).length }

  set(name, included) {
    this.db.prepare(`INSERT INTO folder_choices(name, included, updated_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET included = excluded.included, updated_at = excluded.updated_at`).run(String(name), included ? 1 : 0, Date.now())
    this.fill()
  }

  /**
   * Keep each included folder's collection full as photos arrive. A photo you took out keeps its tombstone and
   * is not put back; new ones join. Returns whether anything changed, so sync is told only when it did.
   */
  fill() {
    let changed = false
    for (const f of this.list().filter(f => f.included)) {
      const id = this.db.prepare('SELECT id FROM collections WHERE deleted = 0 AND name = ? COLLATE NOCASE').get(f.name)?.id
        ?? library.createCollection(this.db, f.name).id
      const add = this.db.prepare('INSERT INTO collection_items(collection_id, sha256, updated_at, deleted) VALUES(?,?,?,0) ON CONFLICT DO NOTHING')
      const now = Date.now()
      library.transaction(this.db, () => { for (const sha of f.shas) if (add.run(id, sha, now).changes) changed = true })
    }
    return changed
  }
}

module.exports = { Folders, folderName }
