// Photo library: scan the Photos folder, hash, read EXIF, make thumbnails, keep it all in SQLite.
// Never writes to the library folder; everything it creates lives in dataDir.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const IMAGE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp' }
const VIDEO = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp' }

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'library.db'))
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,       -- relative to the Photos root
      sha256 TEXT NOT NULL,            -- photo identity, shared with the phone (SYNC_PLAN.md)
      mime TEXT NOT NULL,
      is_video INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      taken_at INTEGER NOT NULL,       -- epoch ms: EXIF DateTimeOriginal, else file mtime
      width INTEGER, height INTEGER,
      latitude REAL, longitude REAL,
      camera TEXT,
      thumb INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS media_taken ON media(taken_at DESC);
    CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);`)
  return db
}

async function* walk(dir) {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.isFile()) yield full
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

async function imageInfo(file) {
  const exifr = require('exifr')
  const sharp = require('sharp')
  const out = {}
  try {
    const x = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'latitude', 'longitude'] })
    const date = x?.DateTimeOriginal || x?.CreateDate
    if (date instanceof Date && !isNaN(date)) out.taken_at = date.getTime()
    if (Number.isFinite(x?.latitude) && Number.isFinite(x?.longitude)) { out.latitude = x.latitude; out.longitude = x.longitude }
    const camera = [x?.Make, x?.Model].filter(Boolean).join(' ').trim()
    if (camera) out.camera = camera
  } catch {}
  try {
    const m = await sharp(file).metadata()
    const turned = m.orientation >= 5 // EXIF 5-8 swap width and height
    out.width = turned ? m.height : m.width
    out.height = turned ? m.width : m.height
  } catch {}
  return out
}

async function makeThumb(file, isVideo, target) {
  if (!isVideo) {
    await require('sharp')(file).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(target)
    return
  }
  // ponytail: needs a system ffmpeg; bundle ffmpeg-static if packaged users lack it.
  await new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'webp', target],
    err => err ? reject(err) : resolve()))
  if (!fs.existsSync(target)) throw new Error('no frame')
}

/** Brings the database in line with the folder. Unchanged files (same size + mtime) are not re-read. */
async function scan(db, root, dataDir, onProgress = () => {}) {
  const known = new Map(db.prepare('SELECT path, size, mtime, sha256, thumb FROM media').all().map(r => [r.path, r]))
  const seen = new Set()
  const insert = db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, width, height, latitude, longitude, camera, thumb)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, mime=excluded.mime, is_video=excluded.is_video,
    size=excluded.size, mtime=excluded.mtime, taken_at=excluded.taken_at, width=excluded.width, height=excluded.height,
    latitude=excluded.latitude, longitude=excluded.longitude, camera=excluded.camera, thumb=excluded.thumb`)
  let done = 0, changed = 0
  for await (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase()
    const mime = IMAGE[ext] || VIDEO[ext]
    if (!mime) continue
    const rel = path.relative(root, file)
    seen.add(rel)
    const st = await fsp.stat(file)
    const old = known.get(rel)
    if (old && old.size === st.size && old.mtime === Math.trunc(st.mtimeMs) && old.thumb) { onProgress(++done, changed); continue }
    const isVideo = !!VIDEO[ext]
    const hash = await sha256(file)
    const info = isVideo ? {} : await imageInfo(file)
    const thumbFile = path.join(dataDir, 'thumbs', hash + '.webp')
    let thumb = fs.existsSync(thumbFile)
    if (!thumb) thumb = await makeThumb(file, isVideo, thumbFile).then(() => true, () => false)
    insert.run(rel, hash, mime, isVideo ? 1 : 0, st.size, Math.trunc(st.mtimeMs), info.taken_at ?? Math.trunc(st.mtimeMs),
      info.width ?? null, info.height ?? null, info.latitude ?? null, info.longitude ?? null, info.camera ?? null, thumb ? 1 : 0)
    onProgress(++done, ++changed)
  }
  const del = db.prepare('DELETE FROM media WHERE path = ?')
  let removed = 0
  for (const rel of known.keys()) if (!seen.has(rel)) { del.run(rel); removed++ }
  return { total: seen.size, changed, removed }
}

function list(db) {
  return db.prepare('SELECT id, path, sha256, mime, is_video, size, taken_at, width, height, latitude, longitude, camera, thumb FROM media ORDER BY taken_at DESC, path').all()
}

module.exports = { open, scan, list, sha256 }
