// Files module: everything under one root (~/Drive/Drive), same rules as the phone's DriveRules.
// Paths are Drive-relative with '/' separators; every operation re-checks they resolve inside the root.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { sha256 } = require('./library')

const TRASH = 'Trash'
/**
 * Folders the apps rely on: the phone's scanner saves into Scanned Documents, and both sync by these paths. Always
 * there, marked with an emblem, and never renamed, moved or put in the Trash — their contents can be.
 */
const SYSTEM_FOLDERS = ['Documents', 'Documents/Scanned Documents']
const isSystem = rel => SYSTEM_FOLDERS.includes(rel)
const systemFail = rel => fail(`${rel.split('/').pop()} is a system folder and stays where it is.`)
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
    for (const f of SYSTEM_FOLDERS) fs.mkdirSync(path.join(this.root, f), { recursive: true })
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
      if (rel === '' && e.name === TRASH) continue // Trash has its own place in the sidebar, not a folder to open by accident
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
    if (isSystem(rel)) systemFail(rel)
    return this.moveTo(src, this.target(src, destRel))
  }

  async rename(rel, name) {
    if (!isSafeName(name)) fail('Invalid name.')
    const src = this.resolve(rel)
    if (src === this.root) fail('Drive itself cannot be renamed.')
    if (isSystem(rel)) systemFail(rel)
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

  /**
   * Files the phone has, answered with the ones this device wants (SYNC_PLAN.md phase 6e).
   *
   * A file whose bytes are already in Drive under another name is only treated as **moved** when the phone had
   * it at that other path last time and does not now — that is a rename, a move between folders, or a move into
   * Drive/Trash/, and this follows it rather than asking for the bytes again. Without that memory, two devices
   * that simply keep the same file in different folders would look like a move, and this computer would quietly
   * reorganise its own Drive to match the phone's. So the last manifest is remembered per device.
   *
   * Copy, never delete: a path the phone no longer has is left alone, and a path this device already holds with
   * other bytes is never overwritten — the newer file arrives beside it, both kept, as everywhere else.
   */
  /**
   * What each side should do about the other's files (SYNC_PLAN.md 6e and 6i), in one answer:
   *
   *   want   — paths this computer is missing and would like sent
   *   moved  — what this computer moved itself, because the device moved it first
   *   have   — bytes this computer holds and the device does not: send them the other way
   *   moveTo — a move this computer made, mirrored, so the device follows instead of downloading a copy
   *
   * A move is only ever read from *memory*, never from the fact that two devices file the same bytes
   * differently: `sync_manifest` remembers what each side held last time, including this computer's own
   * layout under 'self'. The first sync with a device therefore moves nothing on either side, which is the
   * rule that stops one device quietly reorganising the other's Drive.
   */
  async reconcile(entries, deviceId = 'phone') {
    this.db.exec('CREATE TABLE IF NOT EXISTS sync_manifest (device_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(device_id, path))')
    const offered = new Map()
    for (const e of entries ?? []) if (isSafeRel(e?.path) && /^[0-9a-f]{64}$/.test(e?.sha256 ?? '')) offered.set(e.path, e.sha256)
    const before = new Map(this.db.prepare('SELECT path, sha256 FROM sync_manifest WHERE device_id = ?').all(deviceId).map(r => [r.path, r.sha256]))
    const mineBefore = new Map(this.db.prepare("SELECT path, sha256 FROM sync_manifest WHERE device_id = 'self'").all().map(r => [r.path, r.sha256]))
    const mine = new Map() // sha256 → the paths this device holds
    const minePaths = new Map() // path → sha256, as this computer holds it now
    for (const rel of await this.walk('')) {
      const sha = await this.hash(rel)
      if (!sha) continue
      if (!mine.has(sha)) mine.set(sha, [])
      mine.get(sha).push(rel)
      minePaths.set(rel, sha)
    }
    const want = [], moved = []
    for (const [rel, sha] of offered) {
      if (mine.get(sha)?.includes(rel)) continue // already here, at this very path
      // The phone kept these bytes here last time and does not any more: it moved them, so follow.
      const elsewhere = (mine.get(sha) ?? []).find(other => before.get(other) === sha && !offered.has(other))
      if (elsewhere) {
        const target = path.join(this.root, rel)
        if (fs.existsSync(target)) continue // something else is already there; keep both, ask for nothing
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await this.moveTo(this.resolve(elsewhere), target)
        mine.set(sha, mine.get(sha).filter(p => p !== elsewhere).concat(rel))
        minePaths.delete(elsewhere)
        minePaths.set(rel, sha)
        moved.push({ from: elsewhere, to: rel })
      } else want.push(rel)
    }
    // The same question asked the other way round.
    const offeredShas = new Map() // sha256 → the paths the device holds
    for (const [rel, sha] of offered) offeredShas.set(sha, (offeredShas.get(sha) ?? []).concat(rel))
    // What the device held last time and holds nowhere now, it deleted. Offering it back would undo that, which
    // is the same sin as deleting, read backwards — so it is never offered again.
    const gone = new Set([...before.values()].filter(sha => !offeredShas.has(sha)))
    const have = [], moveTo = []
    for (const [rel, sha] of minePaths) {
      if (offered.get(rel) === sha) continue // the device has these bytes at this very path
      const theirs = offeredShas.get(sha) ?? []
      // Offering a copy is safe on any sync, including the first: it adds, it never rearranges.
      if (!theirs.length) { if (gone.has(sha)) continue; have.push({ path: rel, sha256: sha, size: await this.sizeOf(rel), modified: await this.mtimeOf(rel) }); continue }
      // This computer moved it, and the device still has it where it was: mirror the move rather than send it.
      const from = theirs.find(other => mineBefore.get(other) === sha && !minePaths.has(other))
      if (from && !offered.has(rel)) moveTo.push({ from, to: rel })
    }
    // A path the device is being told to *move* must not also be asked for. Both answers are true on their own
    // — this computer does not hold those bytes at that path, and it moved them itself — and sending both made
    // the device upload the old path while renaming its copy, so the computer ended up with two of everything.
    // The move is the better answer, so it wins, and the next sync sees the device where this computer is.
    const following = new Set(moveTo.map(m => m.from))
    const wanted = want.filter(rel => !following.has(rel))

    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM sync_manifest WHERE device_id = ?').run(deviceId)
      this.db.prepare("DELETE FROM sync_manifest WHERE device_id = 'self'").run()
      const put = this.db.prepare('INSERT INTO sync_manifest(device_id, path, sha256) VALUES(?,?,?)')
      for (const [rel, sha] of offered) put.run(deviceId, rel, sha)
      for (const [rel, sha] of minePaths) put.run('self', rel, sha)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return { want: wanted, moved, have, moveTo }
  }

  async sizeOf(rel) { return (await fsp.stat(path.join(this.root, rel)).catch(() => null))?.size ?? 0 }
  async mtimeOf(rel) { return Math.round((await fsp.stat(path.join(this.root, rel)).catch(() => null))?.mtimeMs ?? 0) }

  /** Every file under Drive, as Drive-relative paths. Dotfiles and links are skipped, as everywhere else. */
  async walk(rel) {
    const out = []
    let entries
    try { entries = await fsp.readdir(path.join(this.root, rel), { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) out.push(...await this.walk(child))
      else if (e.isFile()) out.push(child)
    }
    return out
  }

  /** SHA-256 of a file, cached against its size and mtime so each file is read once. */
  async hash(rel) {
    this.db.exec('CREATE TABLE IF NOT EXISTS file_hashes (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, sha256 TEXT NOT NULL)')
    let st
    try { st = await fsp.stat(path.join(this.root, rel)) } catch { return null }
    const size = st.size, mtime = Math.trunc(st.mtimeMs)
    const cached = this.db.prepare('SELECT sha256 FROM file_hashes WHERE path = ? AND size = ? AND mtime = ?').get(rel, size, mtime)
    if (cached) return cached.sha256
    const sha = await sha256(path.join(this.root, rel))
    this.db.prepare(`INSERT INTO file_hashes(path, size, mtime, sha256) VALUES(?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256`).run(rel, size, mtime, sha)
    return sha
  }

  // --- Sync (SYNC_PLAN.md phase 6d). Files are keyed by their Drive-relative path on both devices, which is the
  // same path, so a record only needs a time: the newest edit of a path wins. Tags travel as the whole set for a
  // path — the set the newer side holds is the answer, and a tag missing from it was removed. `resolve` is not
  // called here on purpose: metadata for a file this device has not received yet is kept, not thrown away.

  /** Everything the user set on a file or folder, one record per path, changed after `since`. */
  metadataSince(since = 0) {
    const rows = this.db.prepare(`SELECT path, MAX(at) AS updatedAt FROM (
        SELECT path, updated_at AS at FROM file_meta UNION ALL SELECT path, updated_at FROM file_tags
      ) GROUP BY path HAVING updatedAt > ?`).all(since)
    const meta = this.db.prepare('SELECT favorite, color FROM file_meta WHERE path = ?')
    const tags = this.db.prepare('SELECT tag FROM file_tags WHERE path = ? AND deleted = 0')
    return rows.map(r => ({
      path: r.path, updatedAt: r.updatedAt,
      favorite: !!meta.get(r.path)?.favorite, color: meta.get(r.path)?.color ?? null,
      tags: tags.all(r.path).map(t => t.tag),
    }))
  }

  applyMetadata({ path, favorite, color, tags, updatedAt }) {
    if (!isSafeRel(path)) return
    const mine = this.db.prepare(`SELECT MAX(at) AS at FROM (
      SELECT updated_at AS at FROM file_meta WHERE path = ? UNION ALL SELECT updated_at FROM file_tags WHERE path = ?)`).get(path, path)
    if (mine?.at != null && mine.at >= updatedAt) return
    this.db.prepare(`INSERT INTO file_meta(path, favorite, color, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET favorite = excluded.favorite, color = excluded.color, updated_at = excluded.updated_at`)
      .run(path, favorite ? 1 : 0, COLORS.includes(color) ? color : null, updatedAt)
    this.db.prepare('UPDATE file_tags SET deleted = 1, updated_at = ? WHERE path = ? AND deleted = 0').run(updatedAt, path)
    const put = this.db.prepare(`INSERT INTO file_tags(path, tag, updated_at, deleted) VALUES(?,?,?,0)
      ON CONFLICT(path, tag) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`)
    for (const raw of tags ?? []) {
      const name = (() => { try { return tagName(raw) } catch { return null } })()
      if (name) { put.run(path, name, updatedAt); this.createTag(name) }
    }
  }

  recentsAll() {
    return this.db.prepare('SELECT path, opened_at AS openedAt FROM file_recents').all()
  }

  /** The most recent open of each file wins, whichever device it happened on. */
  mergeRecents(incoming) {
    const put = this.db.prepare(`INSERT INTO file_recents(path, opened_at) VALUES(?,?)
      ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at WHERE file_recents.opened_at < excluded.opened_at`)
    for (const r of incoming ?? []) if (isSafeRel(r.path) && Number(r.openedAt) > 0) put.run(r.path, Number(r.openedAt))
    this.db.prepare(`DELETE FROM file_recents WHERE path NOT IN (SELECT path FROM file_recents ORDER BY opened_at DESC LIMIT ${RECENTS_LIMIT})`).run()
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

module.exports = { Files, TRASH, SYSTEM_FOLDERS, isSystem, COLORS, typeGroup, isSafeRel, isSafeName }
