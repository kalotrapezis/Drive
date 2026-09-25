'use strict'
/**
 * Trash → Purgatory → gone (SYNC_PLAN.md D6). A deleted photo or file waits in the Trash for its days, and is then
 * not deleted but moved to a hidden `.purgatory` folder — on this computer (the server) by default, or on a drive
 * the person chose for it — where it waits again before it is deleted: about sixty days of grace in all. Emptying
 * the Trash by hand stays a plain delete.
 *
 * Every copy is hashed while it is written and read back before the original may go; an unplugged drive means the
 * item waits in the Trash, never that it is dropped. Every step is written to the history.
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const library = require('./library')
const history = require('./history')

const DAY = 86_400_000
const DEFAULTS = { trashDays: 30, purgatoryDays: 30 } // purgatoryDays 0: never deleted

class Purgatory {
  /**
   * `files` is the Files module (its Trash is Files/Trash/). `serverBase` is where the purgatory lives when no drive
   * was chosen for it: <serverBase>/Tetra/.purgatory, on this computer — the server keeps it by default.
   */
  /** `held(sha)`: a copy is already safe on the server or its backup drive, so the Trash item just goes. */
  constructor({ db, photosRoot, files, serverBase = null, held = null }) {
    Object.assign(this, { db, photosRoot, files, serverBase, held })
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS purgatory (id INTEGER PRIMARY KEY, drive_id TEXT NOT NULL, kind TEXT NOT NULL,
        rel TEXT NOT NULL, origin TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, entered_at INTEGER NOT NULL)`)
  }

  settings() {
    const get = k => this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value
    const n = (k) => { const v = Number(get(k)); return Number.isInteger(v) && v >= 0 ? v : DEFAULTS[k] }
    // '' is this computer; otherwise the id of the drive the person chose for it (Add a drive, or the drive's card).
    return { trashDays: n('trashDays'), purgatoryDays: n('purgatoryDays'), location: get('purgatoryLocation') || '' }
  }

  /**
   * Chooses where the purgatory lives and moves what it already holds there, each item copied, read back and only
   * then removed from the old place. `baseOf(id)` is where a location is right now ('' = this computer), or null
   * when a drive is not plugged in — what is on it then stays there and moves next time.
   */
  async relocate(to, baseOf) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES('purgatoryLocation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(to || '')
    const toId = to || 'server', toBase = await baseOf(to || '')
    const out = { moved: 0, waiting: 0, failed: [] }
    if (!toBase) return { ...out, waiting: this.db.prepare('SELECT COUNT(*) n FROM purgatory WHERE drive_id != ?').get(toId).n }
    for (const row of this.db.prepare('SELECT * FROM purgatory WHERE drive_id != ?').all(toId)) {
      const fromBase = await baseOf(row.drive_id === 'server' ? '' : row.drive_id)
      if (!fromBase) { out.waiting++; continue }
      const src = path.join(fromBase, 'Tetra', '.purgatory', row.rel)
      let rel = row.rel
      const { dir, name, ext } = path.parse(rel)
      for (let n = 2; fs.existsSync(path.join(toBase, 'Tetra', '.purgatory', rel)); n++) rel = path.join(dir, `${name} (${n})${ext}`)
      try {
        await copyTree(src, path.join(toBase, 'Tetra', '.purgatory', rel))
        await fsp.rm(src, { recursive: true, force: true })
        this.db.prepare('UPDATE purgatory SET drive_id = ?, rel = ? WHERE id = ?').run(toId, rel, row.id)
        out.moved++
      } catch (e) { out.failed.push(`${row.origin}: ${e.message}`) }
    }
    if (out.moved) history.record(this.db, { action: 'purgatory moved', device: to || null, detail: `${out.moved} items` })
    return out
  }

  setSettings({ trashDays, purgatoryDays } = {}) {
    const put = this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    if (Number.isInteger(trashDays) && trashDays >= 1 && trashDays <= 3650) put.run('trashDays', String(trashDays))
    if (Number.isInteger(purgatoryDays) && purgatoryDays >= 0 && purgatoryDays <= 36500) put.run('purgatoryDays', String(purgatoryDays))
    return this.settings()
  }

  /** What the purgatory holds on each drive, for the Devices page. */
  summary() {
    return this.db.prepare('SELECT drive_id AS driveId, COUNT(*) AS items, COALESCE(SUM(size), 0) AS bytes, MIN(entered_at) AS oldest FROM purgatory GROUP BY drive_id').all()
  }

  /**
   * One pass with the drive at `mount`: Trash items past their days go to the purgatory, and purgatory items past
   * theirs are deleted. Returns what it did.
   */
  async sweep(driveId, mount, now = Date.now()) {
    const { trashDays, purgatoryDays } = this.settings()
    const cutoff = now - trashDays * DAY
    const out = { entered: 0, purged: 0, failed: [] }

    for (const item of await library.trashedPhotos(this.photosRoot)) {
      if (!item.deletedAt || item.deletedAt > cutoff) continue
      try {
        const sha = this.held ? await library.sha256(item.file) : null
        if (sha && this.held(sha)) {
          await fsp.rm(item.file, { recursive: true, force: true })
          await fsp.rm(path.join(path.dirname(path.dirname(item.file)), 'info', item.id + '.trashinfo'), { force: true })
          history.record(this.db, { action: 'emptied from Trash, a copy is safe', kind: 'photo', name: item.path, sha256: sha, size: item.size, at: now })
          out.released = (out.released ?? 0) + 1
          continue
        }
        await this.enter(driveId, mount, 'photo', item.file, item.path, now)
        await fsp.rm(item.file, { recursive: true, force: true })
        await fsp.rm(path.join(path.dirname(path.dirname(item.file)), 'info', item.id + '.trashinfo'), { force: true })
        out.entered++
      } catch (e) { out.failed.push(`${item.path}: ${e.message}`) }
    }

    const filesTrash = this.files && path.join(this.files.root, 'Trash')
    for (const name of filesTrash && fs.existsSync(filesTrash) ? await fsp.readdir(filesTrash) : []) {
      const full = path.join(filesTrash, name)
      // A move into Trash/ changes the item's ctime and nothing else, so that is when it was trashed.
      const st = await fsp.lstat(full)
      if (st.ctimeMs > cutoff) continue
      try {
        await this.enter(driveId, mount, 'file', full, name, now)
        await fsp.rm(full, { recursive: true, force: true })
        out.entered++
      } catch (e) { out.failed.push(`Files/Trash/${name}: ${e.message}`) }
    }

    if (purgatoryDays > 0) {
      const old = this.db.prepare('SELECT * FROM purgatory WHERE drive_id = ? AND entered_at < ?').all(driveId, now - purgatoryDays * DAY)
      for (const row of old) {
        const target = path.join(mount, 'Tetra', '.purgatory', row.rel)
        try {
          await fsp.rm(target, { recursive: true, force: true })
          this.db.prepare('DELETE FROM purgatory WHERE id = ?').run(row.id)
          history.record(this.db, { action: 'deleted from purgatory', kind: row.kind, name: row.origin, sha256: row.sha256, size: row.size, device: driveId })
          out.purged++
        } catch (e) { out.failed.push(`${row.origin}: ${e.message}`) }
      }
    }
    return out
  }

  /**
   * Copies a file or a folder into <drive>/Tetra/.purgatory/<photos|files>/<day>/<origin>, never over anything,
   * each file hashed as it is written and read back. Only when all of it matches is it recorded.
   */
  async enter(driveId, mount, kind, src, origin, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10)
    let rel = path.join(kind === 'photo' ? 'photos' : 'files', day, origin)
    const { dir, name, ext } = path.parse(rel)
    for (let n = 2; fs.existsSync(path.join(mount, 'Tetra', '.purgatory', rel)); n++) rel = path.join(dir, `${name} (${n})${ext}`)
    const target = path.join(mount, 'Tetra', '.purgatory', rel)
    const { size, sha256 } = await copyTree(src, target)
    this.db.prepare('INSERT INTO purgatory(drive_id, kind, rel, origin, size, sha256, entered_at) VALUES(?,?,?,?,?,?,?)')
      .run(driveId, kind, rel, origin, size, sha256, now)
    history.record(this.db, { action: 'to purgatory', kind, name: origin, sha256, size, device: driveId, at: now })
    return rel
  }
}

/** Verified copy of a file or a whole folder. Returns the total size and, for a single file, its hash. */
async function copyTree(src, target) {
  const st = await fsp.lstat(src)
  if (st.isDirectory()) {
    await fsp.mkdir(target, { recursive: true })
    let size = 0
    for (const e of await fsp.readdir(src)) size += (await copyTree(path.join(src, e), path.join(target, e))).size
    return { size, sha256: null }
  }
  if (!st.isFile()) return { size: 0, sha256: null } // links and devices are not photos or documents
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const part = target + '.part'
  const written = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const r = fs.createReadStream(src), w = fs.createWriteStream(part, { flags: 'wx' })
    r.on('data', c => written.update(c)); r.on('error', reject); w.on('error', reject); w.on('finish', resolve)
    r.pipe(w)
  })
  const back = crypto.createHash('sha256')
  for await (const c of fs.createReadStream(part)) back.update(c)
  const sha256 = written.digest('hex')
  if (back.digest('hex') !== sha256) { await fsp.rm(part, { force: true }); throw new Error('the copy on the drive did not read back the same') }
  await fsp.rename(part, target)
  return { size: st.size, sha256 }
}

module.exports = { Purgatory, DEFAULTS }
