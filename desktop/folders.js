'use strict'
// Folders as user collections (SYNC_PLAN.md §7 / D), the phone's FolderRules on this computer. The Photos root
// mirrors the phone's folders (DCIM/Camera, Pictures/Viber…), so the same folder gets the same name on both, and
// the collection it becomes is one collection everywhere (collections are matched by name when they first meet).
const fs = require('node:fs')
const path = require('node:path')
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
  /** `bothWays()` says whether any device syncs photos both ways with this computer (main.js asks sync). */
  constructor(db, bothWays = () => false) {
    this.db = db
    this.bothWays = bothWays
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
    // In a two-way chain a folder that is On anywhere is On everywhere: its album is the yes that travels, and a No
    // given here does not hide it (asked 2026-09-25). With no device both ways, this computer's answers stand.
    const chain = this.bothWays()
    for (const r of this.db.prepare('SELECT name, included FROM folder_choices').all()) {
      const key = r.name.toLowerCase()
      if (r.included || !(chain && out[key])) out[key] = !!r.included
    }
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

  /** Lower-cased names of the folders whose collection mirrors the folder (included, or always shown). */
  folderAlbums() {
    return new Set(this.list().filter(f => f.included).map(f => f.name.toLowerCase()))
  }

  /** The folders photos can be moved into: every folder that holds one here, and the camera's, busiest first. */
  places() {
    const count = new Map([['DCIM/Camera', 0]])
    for (const { path: p } of this.db.prepare('SELECT path FROM media WHERE location IS NULL').all()) {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
      if (dir) count.set(dir, (count.get(dir) ?? 0) + 1)
    }
    return [...count].map(([dir, n]) => ({ path: dir, name: folderName(dir + '/x') ?? dir, count: n })).sort((a, b) => b.count - a.count)
  }

  /**
   * Really moves photos into another folder under the Photos root (asked 2026-09-25: a folder album is a folder,
   * so taking a photo out of it moves the file). Never over another file — a name that is taken becomes "name (2)".
   * The photo leaves the old folder's collection and joins the new one's; everything keyed by hash (favorites,
   * other collections, people) is untouched. Photos on a storage drive stay where they are.
   */
  move(root, ids, dest) {
    const parts = String(dest ?? '').split('/').filter(Boolean)
    if (!parts.length || parts.some(p => p === '.' || p === '..' || /[\\\0]/.test(p) || p.startsWith('.'))) throw new Error('That is not a folder in Photos.')
    const rel = parts.join('/'), dir = path.join(root, rel)
    fs.mkdirSync(dir, { recursive: true })
    const get = this.db.prepare('SELECT id, path, sha256 FROM media WHERE id = ?')
    const setPath = this.db.prepare('UPDATE media SET path = ? WHERE id = ?')
    const stillThere = this.db.prepare('SELECT path FROM media WHERE sha256 = ?')
    const out = { moved: 0, failed: [] }
    const moved = new Set()
    const now = Date.now()
    for (const id of ids) {
      const row = get.get(Number(id))
      if (!row) continue
      if (this.db.prepare('SELECT location FROM media WHERE id = ?').get(row.id).location) { out.failed.push(`${row.path}: it lives on a storage drive`); continue }
      if (path.dirname(row.path) === rel) continue
      const { name, ext } = path.parse(row.path)
      let target = path.join(dir, name + ext)
      for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${name} (${n})${ext}`)
      try {
        fs.renameSync(path.join(root, row.path), target)
        try { setPath.run(path.relative(root, target), row.id) } catch (e) { fs.renameSync(target, path.join(root, row.path)); throw e }
        const from = folderName(row.path)
        // Out of the old folder's collection, unless another copy of the same photo is still in that folder.
        if (from && !stillThere.all(row.sha256).some(r => folderName(r.path)?.toLowerCase() === from.toLowerCase())) {
          this.db.prepare(`UPDATE collection_items SET deleted = 1, updated_at = ? WHERE sha256 = ? AND deleted = 0
            AND collection_id IN (SELECT id FROM collections WHERE deleted = 0 AND name = ? COLLATE NOCASE)`).run(now, row.sha256, from)
        }
        out.moved++; moved.add(row.sha256)
      } catch (e) { out.failed.push(`${row.path}: ${e.message}`) }
    }
    // Into the new folder's collection, even if it had been taken out of it by hand before.
    const to = folderName(rel + '/x')
    const into = to && this.folderAlbums().has(to.toLowerCase()) && this.db.prepare('SELECT id FROM collections WHERE deleted = 0 AND name = ? COLLATE NOCASE').get(to)
    if (into) {
      const add = this.db.prepare(`INSERT INTO collection_items(collection_id, sha256, updated_at, deleted) VALUES(?,?,?,0)
        ON CONFLICT(collection_id, sha256) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`)
      for (const sha of moved) add.run(into.id, sha, now)
    }
    this.fill()
    return out
  }

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
