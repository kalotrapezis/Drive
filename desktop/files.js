// Files module: everything under one root (~/Drive/Drive), same rules as the phone's DriveRules.
// Paths are Drive-relative with '/' separators; every operation re-checks they resolve inside the root.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { sha256 } = require('./library')

const TRASH = 'Trash'
const RECENTS_LIMIT = 50
const COLORS = ['Blue', 'Green', 'Yellow', 'Red', 'Purple']

function openMeta(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS file_meta (path TEXT PRIMARY KEY, favorite INTEGER NOT NULL DEFAULT 0, color TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS file_tags (path TEXT NOT NULL, tag TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(path, tag));
    CREATE TABLE IF NOT EXISTS known_tags (name TEXT PRIMARY KEY COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS file_recents (path TEXT PRIMARY KEY, opened_at INTEGER NOT NULL);`)
}

const fail = message => { throw new Error(message) }
const isSafeRel = rel => typeof rel === 'string' && (rel === '' || (!rel.startsWith('/') && rel.split('/').every(p => p && p !== '.' && p !== '..')))
const isSafeName = name => typeof name === 'string' && name.trim() === name && name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
const inTrash = rel => rel === TRASH || rel.startsWith(TRASH + '/')

function tagName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > 32 || name.includes(',')) fail('Tags must be 1–32 characters and cannot contain commas.')
  return name
}

function typeGroup(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  for (const [group, list] of Object.entries({
    Documents: ['doc', 'docx', 'odt'], Spreadsheets: ['xls', 'xlsx', 'csv', 'ods'], PDF: ['pdf'], Text: ['txt', 'md'],
    Drawings: ['excalidraw'], Pictures: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'], Videos: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
  })) if (list.includes(ext)) return group
  return 'Other'
}

class Files {
  constructor(db, root) {
    this.db = db
    fs.mkdirSync(root, { recursive: true }) // created only when absent, like the phone
    this.root = fs.realpathSync(root)
    openMeta(db)
  }

  /** Absolute path for a relative one, after resolving symlinks, refusing anything outside the root. */
  resolve(rel, mustExist = true) {
    if (!isSafeRel(rel)) fail('Invalid Drive item.')
    const full = path.join(this.root, rel)
    let real
    try { real = fs.realpathSync(full) } catch { if (mustExist) fail('This item no longer exists.'); real = path.join(fs.realpathSync(path.dirname(full)), path.basename(full)) }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) fail('Item is outside Drive.')
    return real
  }
  rel(full) { return path.relative(this.root, full).split(path.sep).join('/') }

  item(full, st) {
    const rel = this.rel(full)
    const meta = this.db.prepare('SELECT favorite, color FROM file_meta WHERE path = ?').get(rel)
    const tags = this.db.prepare('SELECT tag FROM file_tags WHERE path = ? AND deleted = 0 ORDER BY tag COLLATE NOCASE').all(rel).map(r => r.tag)
    return { name: path.basename(full), path: rel, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.trunc(st.mtimeMs),
      type: st.isDirectory() ? 'Folder' : typeGroup(full), favorite: !!meta?.favorite, color: meta?.color ?? null, tags }
  }

  async list(rel) {
    const dir = this.resolve(rel)
    if (!(await fsp.stat(dir)).isDirectory()) fail('Not a folder.')
    const out = []
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue // never follow links out of Drive; dotfiles stay hidden like in file managers
      const full = path.join(dir, e.name)
      out.push(this.item(full, await fsp.stat(full)))
    }
    return out
  }

  /** Every item under the root, Trash excluded (search and destinations). */
  async all({ foldersOnly = false } = {}) {
    const out = []
    const walk = async dir => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (dir === this.root && e.name === TRASH) continue
        if (e.isDirectory()) { out.push(this.item(full, await fsp.stat(full))); await walk(full) }
        else if (!foldersOnly && e.isFile()) out.push(this.item(full, await fsp.stat(full)))
      }
    }
    await walk(this.root)
    return out
  }

  async search(query) {
    const words = String(query).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/\s+/).filter(Boolean)
    const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    return (await this.all()).filter(i => { const hay = fold([i.name, ...i.tags].join(' ')); return words.every(w => hay.includes(w)) })
  }

  async withTag(tag) { return (await this.all()).filter(i => i.tags.some(t => t.toLowerCase() === String(tag).toLowerCase())) }

  async destinations() { return ['', ...(await this.all({ foldersOnly: true })).map(i => i.path).sort((a, b) => a.localeCompare(b))] }

  target(sourceFull, destRel) {
    const dest = this.resolve(destRel)
    if (!fs.statSync(dest).isDirectory()) fail('Destination is not a folder.')
    if (fs.statSync(sourceFull).isDirectory() && (dest === sourceFull || dest.startsWith(sourceFull + path.sep))) fail('A folder cannot be placed inside itself.')
    const target = path.join(dest, path.basename(sourceFull))
    if (fs.existsSync(target)) fail('A file with this name already exists.')
    return target
  }

  /** Copies and verifies every file by SHA-256; a mismatch removes the bad copy. Never overwrites. */
  async copy(rel, destRel) {
    const src = this.resolve(rel)
    if (src === this.root) fail('Drive itself cannot be copied.')
    const target = this.target(src, destRel)
    const copyTree = async (from, to) => {
      const st = await fsp.lstat(from)
      if (st.isSymbolicLink()) return
      if (st.isDirectory()) {
        await fsp.mkdir(to)
        for (const name of await fsp.readdir(from)) await copyTree(path.join(from, name), path.join(to, name))
      } else {
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
        if (await sha256(from) !== await sha256(to)) { await fsp.rm(to); fail(`Copy of ${path.basename(from)} did not verify; nothing was kept.`) }
      }
    }
    try { await copyTree(src, target) } catch (e) { if (!fs.existsSync(target) || e.code === 'EEXIST') throw e; await fsp.rm(target, { recursive: true, force: true }); throw e }
    return this.rel(target)
  }

  async moveTo(src, target) {
    if (fs.existsSync(target)) fail('A file with this name already exists.')
    await fsp.rename(src, target)
    this.rewrite(this.rel(src), this.rel(target))
    return this.rel(target)
  }

  async move(rel, destRel) {
    const src = this.resolve(rel)
    if (src === this.root) fail('Drive itself cannot be moved.')
    return this.moveTo(src, this.target(src, destRel))
  }

  async rename(rel, name) {
    if (!isSafeName(name)) fail('Invalid name.')
    const src = this.resolve(rel)
    if (src === this.root) fail('Drive itself cannot be renamed.')
    const target = path.join(path.dirname(src), name)
    if (target === src) return rel
    return this.moveTo(src, target)
  }

  /** Reversible: Drive/Trash/ is an ordinary folder; Move brings items back. */
  async trash(rel) {
    if (inTrash(rel)) fail('This item is already in Trash.')
    await fsp.mkdir(path.join(this.root, TRASH), { recursive: true })
    return this.move(rel, TRASH)
  }

  /** The only permanent delete; the UI confirms first. */
  async emptyTrash() {
    const trash = path.join(this.root, TRASH)
    if (!fs.existsSync(trash)) return 0
    const names = await fsp.readdir(trash)
    for (const n of names) await fsp.rm(path.join(trash, n), { recursive: true })
    for (const t of ['file_meta', 'file_tags', 'file_recents']) this.db.prepare(`DELETE FROM ${t} WHERE substr(path, 1, 6) = 'Trash/'`).run()
    return names.length
  }

  /** Metadata follows renames and moves (phone: DriveStoredPathRules.rewrite). */
  rewrite(from, to) {
    for (const t of ['file_meta', 'file_tags', 'file_recents']) {
      this.db.prepare(`UPDATE ${t} SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?`)
        .run(to, from.length + 1, from, from.length + 1, from + '/')
    }
  }

  setMeta(rel, field, value) {
    this.resolve(rel)
    this.db.prepare(`INSERT INTO file_meta(path, ${field}, updated_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET ${field} = excluded.${field}, updated_at = excluded.updated_at`)
      .run(rel, value, Date.now())
  }
  setFavorite(rel, on) { this.setMeta(rel, 'favorite', on ? 1 : 0) }
  setColor(rel, color) {
    if (color !== null && !COLORS.includes(color)) fail('Unknown colour.')
    if (!fs.statSync(this.resolve(rel)).isDirectory()) fail('Only folders have a colour.')
    this.setMeta(rel, 'color', color)
  }

  async favorites() {
    const out = []
    for (const { path: rel } of this.db.prepare('SELECT path FROM file_meta WHERE favorite = 1').all()) {
      if (inTrash(rel)) continue
      try { const full = this.resolve(rel); out.push(this.item(full, await fsp.stat(full))) } catch {}
    }
    return out
  }

  recordOpen(rel) {
    if (!fs.statSync(this.resolve(rel)).isFile()) fail('Not a file.')
    this.db.prepare('INSERT INTO file_recents(path, opened_at) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at').run(rel, Date.now())
    this.db.prepare(`DELETE FROM file_recents WHERE path NOT IN (SELECT path FROM file_recents ORDER BY opened_at DESC LIMIT ${RECENTS_LIMIT})`).run()
  }

  async recents() {
    const out = []
    for (const r of this.db.prepare('SELECT path, opened_at FROM file_recents ORDER BY opened_at DESC').all()) {
      try { const full = this.resolve(r.path); const st = await fsp.stat(full); if (st.isFile()) out.push({ ...this.item(full, st), openedAt: r.opened_at }) } catch {}
    }
    return out
  }

  tags() {
    return this.db.prepare(`SELECT name FROM known_tags UNION SELECT tag FROM file_tags WHERE deleted = 0 AND substr(path, 1, 6) != 'Trash/' ORDER BY 1 COLLATE NOCASE`).all().map(r => r.name)
  }
  createTag(value) {
    const name = tagName(value)
    this.db.prepare('INSERT OR IGNORE INTO known_tags(name) VALUES(?)').run(name)
    return name
  }
  setTags(rel, names) {
    this.resolve(rel)
    const cleaned = [...new Set((names ?? []).map(tagName))]
    if (cleaned.length !== (names ?? []).length) fail('Tags must be unique.')
    const now = Date.now()
    this.db.prepare('UPDATE file_tags SET deleted = 1, updated_at = ? WHERE path = ? AND deleted = 0').run(now, rel)
    const put = this.db.prepare('INSERT INTO file_tags(path, tag, updated_at, deleted) VALUES(?,?,?,0) ON CONFLICT(path, tag) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at')
    for (const t of cleaned) { put.run(rel, t, now); this.createTag(t) }
  }

  async properties(rel) {
    const full = this.resolve(rel)
    const st = await fsp.stat(full)
    let size = st.size, files = 0
    if (st.isDirectory()) {
      size = 0
      const walk = async dir => { for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) await walk(f); else if (e.isFile()) { size += (await fsp.stat(f)).size; files++ }
      } }
      await walk(full)
    }
    return { ...this.item(full, st), size, files, absolute: full }
  }

  async usage() {
    const bytes = {}
    const walk = async dir => { for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) await walk(f); else if (e.isFile()) { const g = typeGroup(e.name); bytes[g] = (bytes[g] ?? 0) + (await fsp.stat(f)).size }
    } }
    await walk(this.root)
    return bytes
  }
}

module.exports = { Files, TRASH, COLORS, typeGroup, isSafeRel, isSafeName }
