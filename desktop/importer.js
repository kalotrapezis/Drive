'use strict'
/**
 * Import (asked 2026-09-26): the computer only learns of photos a phone sends, or ones put in its Photos folder by
 * hand; this brings in photos and files from anywhere — another disk, a card, an old backup.
 *
 * Photos land in Photos/Imported/<the folder they came from>/…, a photo the library already has (same SHA-256) is
 * skipped, and every copy is hashed as it is written. **Straight to a drive** (for a disk with no room): in batches of
 * about a gigabyte, each photo is copied here *and* to the drive, both checked, the batch is scanned here (thumbnails,
 * dates, places, people), and then this computer's copy is let go — the photo lives on the drive, like a Move. This
 * disk only ever holds one batch.
 *
 * Files land in Files/Imported/, or in the drive's Tetra/Files/Imported/, folders kept as they were.
 *
 * **Move** instead of copy (asked the same day, "I have no space"): an original is deleted only once every copy of it
 * has been read back and matches; one the library already had goes too — the library holds it. Folders left empty go.
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const library = require('./library')
const history = require('./history')

const MEDIA = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp|avif|dng|cr2|cr3|nef|arw|orf|rw2|raf|mp4|mov|m4v|3gp|mkv|webm|avi)$/i
const BATCH = 1 << 30

/** Read back: the copy is what was hashed, byte for byte, or the original stays. */
async function letGo(src, copies, sha) {
  for (const c of copies) if (await library.sha256(c) !== sha) throw new Error('a copy did not read back the same; the original stays')
  await fsp.rm(src)
}

/** Folders a Move emptied, deepest first; one still holding anything stays. */
async function pruneEmpty(sources) {
  const dirs = []
  const walk = async d => { const st = await fsp.lstat(d).catch(() => null); if (!st?.isDirectory()) return; dirs.push(d); for (const e of await fsp.readdir(d)) await walk(path.join(d, e)) }
  for (const s of sources) await walk(s)
  for (const d of dirs.reverse()) await fsp.rmdir(d).catch(() => {})
}

/**
 * The time a Google Photos export (Takeout) recorded, from the .json beside a photo — for one with no date inside
 * and none in its name (33 of the import of 26 September were dated this way). Null when there is none.
 */
function sidecarDate(src) {
  for (const j of [`${src}.json`, `${src}.supplemental-metadata.json`, `${src}.takeout-metadata-repair.json`]) {
    try { const t = Number(JSON.parse(fs.readFileSync(j, 'utf8')).photoTakenTime?.timestamp) * 1000; if (t > Date.UTC(1995, 0)) return t } catch {}
  }
  return null
}

/** Every file under the chosen files and folders, with where it goes: <folder name>/<path inside it>. */
async function gather(sources, only = null) {
  const out = []
  const walk = async (full, rel) => {
    const st = await fsp.lstat(full).catch(() => null)
    if (!st || st.isSymbolicLink()) return
    if (st.isDirectory()) { for (const e of await fsp.readdir(full)) if (!e.startsWith('.')) await walk(path.join(full, e), path.join(rel, e)) }
    else if (st.isFile() && (!only || only.test(full))) out.push({ src: full, rel, size: st.size, mtime: st.mtime })
  }
  for (const s of sources) await walk(s, path.basename(s))
  return out
}

/** Copied through a .part, hashed on the way; kept only if it is `expected` (when given). Never over another file. */
async function copyChecked(src, dest, expected = null) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  let target = dest
  const { dir, name, ext } = path.parse(dest)
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${name} (${n})${ext}`)
  const part = `${target}.${crypto.randomUUID()}.part` // its own name: nothing else writing the same file can meet it
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const r = fs.createReadStream(src), w = fs.createWriteStream(part, { flags: 'wx' })
    r.on('data', c => hash.update(c)); r.on('error', reject); w.on('error', reject); w.on('finish', resolve)
    r.pipe(w)
  })
  const got = hash.digest('hex')
  if (expected && got !== expected) { await fsp.rm(part, { force: true }); throw new Error('it changed while it was copied') }
  await fsp.rename(part, target)
  const st = await fsp.stat(src)
  await fsp.utimes(target, st.atime, st.mtime)
  return target
}

/**
 * `drive`: null for this computer, or { id, name, mount }. `scan()` reads the Photos folder (resolves when done).
 * `onProgress({ done, total, imported, skipped })`.
 */
async function importPhotos({ db, photosRoot, sources, drive = null, move = false, stop = { cancelled: false }, scan, onProgress = () => {}, batchBytes = BATCH }) {
  const files = await gather(sources, MEDIA)
  const known = new Set(db.prepare('SELECT sha256 FROM media').all().map(r => r.sha256))
  const out = { imported: 0, skipped: 0, failed: [], total: files.length }
  let batch = [], bytes = 0
  const finish = async () => {
    if (!batch.length) return
    await scan()
    // A Takeout sidecar's date, where the scan had only the file's own date to go on.
    const dated = db.prepare('UPDATE media SET taken_at = ? WHERE path = ? AND taken_at = mtime')
    for (const b of batch) if (b.sidecar) dated.run(b.sidecar, b.rel)
    if (drive) {
      const row = db.prepare('SELECT id, path, sha256, size FROM media WHERE path = ? AND location IS NULL')
      const put = db.prepare('UPDATE media SET location = ? WHERE id = ?')
      for (const b of batch) {
        const r = row.get(b.rel)
        try {
          if (!r) throw new Error('not read by the scan')
          const st = await fsp.stat(path.join(drive.mount, 'Tetra', 'Photos', r.path)).catch(() => null)
          if (st?.size !== r.size) throw new Error(`the copy on ${drive.name} is not there`)
          put.run(drive.id, r.id) // first, so a scan running meanwhile reads the missing file as moved, not deleted
          await fsp.rm(path.join(photosRoot, r.path))
          history.record(db, { action: 'imported to drive', kind: 'photo', name: r.path, sha256: r.sha256, size: r.size, device: drive.id })
        } catch (e) { out.failed.push(`${b.rel}: ${e.message} (it stays on this computer)`) }
      }
    }
    batch = []; bytes = 0
  }
  for (const [i, f] of files.entries()) {
    // Cancel stops between photos; the batch in hand is finished — scanned, and let go to the drive — not left half.
    onProgress({ done: i, total: files.length, imported: out.imported, skipped: out.skipped })
    if (stop.cancelled) { out.stopped = true; break }
    try {
      const sha = await library.sha256(f.src)
      if (known.has(sha)) { out.skipped++; if (move) await fsp.rm(f.src); continue }
      const here = await copyChecked(f.src, path.join(photosRoot, 'Imported', f.rel), sha)
      const rel = path.relative(photosRoot, here)
      const onDrive = drive && await copyChecked(f.src, path.join(drive.mount, 'Tetra', 'Photos', rel), sha)
      if (move) await letGo(f.src, onDrive ? [here, onDrive] : [here], sha)
      known.add(sha)
      batch.push({ rel, sidecar: sidecarDate(f.src) }); bytes += f.size
      if (!drive) history.record(db, { action: 'imported', kind: 'photo', name: rel, sha256: sha, size: f.size })
      out.imported++
      if (drive && bytes >= batchBytes) await finish()
    } catch (e) { out.failed.push(`${f.rel}: ${e.message}`) }
  }
  await finish()
  if (move) await pruneEmpty(sources)
  onProgress({ done: files.length, total: files.length, imported: out.imported, skipped: out.skipped })
  return out
}

/** Files into `<root>/Imported/`, folders as they were; `root` is this computer's Files or a drive's Tetra/Files. */
async function importFiles({ db, root, sources, move = false, stop = { cancelled: false }, onProgress = () => {} }) {
  const files = await gather(sources)
  const out = { imported: 0, skipped: 0, failed: [], total: files.length }
  for (const [i, f] of files.entries()) {
    onProgress({ done: i, total: files.length, imported: out.imported, skipped: 0 })
    if (stop.cancelled) { out.stopped = true; break }
    try {
      const sha = move ? await library.sha256(f.src) : null
      const copy = await copyChecked(f.src, path.join(root, 'Imported', f.rel), sha)
      if (move) await letGo(f.src, [copy], sha)
      out.imported++
    } catch (e) { out.failed.push(`${f.rel}: ${e.message}`) }
  }
  if (move) await pruneEmpty(sources)
  if (out.imported) history.record(db, { action: 'imported', kind: 'file', detail: `${out.imported} files into ${root}` })
  return out
}

module.exports = { importPhotos, importFiles, gather, sidecarDate, MEDIA }
