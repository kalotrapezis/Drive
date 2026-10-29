'use strict'
/**
 * Settings › Clean up (the user, 27 Oct: "The applets leave garbage behind … Tetra should have a cleaner"): what Tetra
 * made for itself and no longer needs, each with its size and its own Clean. Never the person's photos or files: every
 * item is one folder of Tetra's own, and a clean removes only inside it (SYSTEM.md says who may delete what).
 *
 *   system:<App>  .System/<App>/Temp and Cache (system.js): work and what can be made again; not a running job's Temp
 *   history       the data dir's Files history: the old copy of a file a sync replaced, after 30 days (also by itself)
 *   thumbs        thumbnails of photos no longer in the library: a server only, once a scan has finished
 *   copies        the data dir's one-off safety copies (24 Sep 2026): moved to .System/Backups/Data, never deleted
 *   routing       GraphHopper's work folder (router.js) of a map no longer here
 */
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const system = require('./system')

const DAY = 86_400_000
const HISTORY_DAYS = 30
/** The safety copies made once, by hand or by home.js's move, that nothing reads. */
const COPIES = /^(library\.db\.before-.+|(phone-)?date-repair(-root)?-\d{8}\.json)$/
const THUMB = /^([0-9a-f]{64})\.(webp|preview\.jpg)$/

/** Bytes and files under `p`, links counted as themselves (never followed: routing's point into a map's graph). */
async function measure(p) {
  const st = await fsp.lstat(p).catch(() => null)
  if (!st) return { bytes: 0, files: 0 }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 }
  const out = { bytes: 0, files: 0 }
  for (const n of await fsp.readdir(p)) { const m = await measure(path.join(p, n)); out.bytes += m.bytes; out.files += m.files }
  return out
}
const sum = async paths => {
  const out = { bytes: 0, files: 0 }
  for (const p of paths) { const m = await measure(p); out.bytes += m.bytes; out.files += m.files }
  return out
}
const list = dir => fsp.readdir(dir).catch(() => [])

class Cleaner {
  /**
   * `db` the library; `dataDir` the app's data; `base` .System; `mapsRoot` .System/Maps/Shared; `isServer()`; `scanned()` true once a library scan
   * has finished and none runs; `busy(app)` true while that app's job uses its Temp; `routing()` the graph folders in use.
   */
  constructor({ db = null, dataDir, base = system.root(), mapsRoot, isServer = () => false, scanned = () => false, busy = () => false, routing = () => [] }) {
    Object.assign(this, { db, dataDir, base, mapsRoot, isServer, scanned, busy, routing })
  }

  /** What each item would remove now: paths, each inside the item's own folder. */
  async targets(id, now = Date.now()) {
    if (id.startsWith('system:')) {
      const app = id.slice(7)
      return ['Temp', 'Cache'].filter(k => !(k === 'Temp' && this.busy(app))).map(k => system.dir(app, k, this.base)).filter(p => fs.existsSync(p))
    }
    if (id === 'history') {
      const dir = path.join(this.dataDir, 'Files history'), out = []
      for (const n of await list(dir)) {
        // each folder is named for the time it was made (sync.js); one that is not goes by its own date
        const at = /^\d{13}$/.test(n) ? +n : (await fsp.stat(path.join(dir, n)).catch(() => ({ mtimeMs: now }))).mtimeMs
        if (now - at > HISTORY_DAYS * DAY) out.push(path.join(dir, n))
      }
      return out
    }
    if (id === 'thumbs') {
      if (!this.isServer() || !this.scanned() || !this.db) return []
      const dir = path.join(this.dataDir, 'thumbs')
      const known = new Set(this.db.prepare('SELECT DISTINCT sha256 FROM media').all().map(r => r.sha256))
      return (await list(dir)).filter(n => THUMB.test(n) && !known.has(THUMB.exec(n)[1])).map(n => path.join(dir, n))
    }
    if (id === 'copies') return (await list(this.dataDir)).filter(n => COPIES.test(n)).map(n => path.join(this.dataDir, n))
    if (id === 'routing') {
      const dir = path.join(this.dataDir, 'routing'), used = new Set(this.routing().map(d => path.basename(d)))
      return (await list(dir)).filter(n => !used.has(n) && !fs.existsSync(path.join(this.mapsRoot, n))).map(n => path.join(dir, n))
    }
    throw new Error('Not something Tetra cleans.')
  }

  /** The items, each { id, app?, bytes, files, ready }; `ready` false when it cannot be cleaned now (thumbs off a server or before a scan). */
  async items(now = Date.now()) {
    const out = []
    for (const app of system.APPS) {
      const m = await sum(await this.targets(`system:${app}`))
      if (m.files) out.push({ id: `system:${app}`, app, ...m, ready: true })
    }
    for (const id of ['history', 'thumbs', 'copies', 'routing']) {
      out.push({ id, ...await sum(await this.targets(id, now)), ready: id !== 'thumbs' || (this.isServer() && this.scanned()) })
    }
    return out
  }

  /** Cleans item `id`: { bytes, files }. The copies are moved into .System/Backups/Data (one that is there already stays where it was). */
  async clean(id, now = Date.now()) {
    const paths = await this.targets(id, now), done = await sum(paths)
    if (id === 'copies') {
      const to = system.dir('Backups', 'Data', this.base)
      await fsp.mkdir(to, { recursive: true })
      for (const p of paths) {
        const dest = path.join(to, path.basename(p))
        if (fs.existsSync(dest)) continue
        // shortcut: a copy across disks is copied then removed, no hash; they are small and one-off
        await fsp.rename(p, dest).catch(async e => { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(p, dest); await fsp.rm(p) })
      }
    } else for (const p of paths) await fsp.rm(p, { recursive: true, force: true })
    return done
  }
}

module.exports = { Cleaner, measure, HISTORY_DAYS }
