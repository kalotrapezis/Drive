// Photo library: scan the Photos folder, hash, read EXIF, make thumbnails, keep it all in SQLite.
// Never writes to the library folder; everything it creates lives in dataDir.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const IMAGE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
  // Camera raw. 83 .NEF sat in this library for months, verified and invisible, because they were not on this
  // list (SYNC_PLAN.md 6ag). Every raw file embeds a full-size JPEG preview and libvips reads it — a Nikon
  // .NEF opens as 4898×3265 with no extra dependency — so the only thing raw ever needed was to be named here.
  '.nef': 'image/x-nikon-nef', '.dng': 'image/x-adobe-dng', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3',
  '.arw': 'image/x-sony-arw', '.raf': 'image/x-fuji-raf', '.orf': 'image/x-olympus-orf', '.rw2': 'image/x-panasonic-rw2',
  '.pef': 'image/x-pentax-pef', '.srw': 'image/x-samsung-srw' }
// Bump when imageInfo learns something new: unchanged files get their details re-read once (no re-hash).
// v2: GPS was dropped by the EXIF field filter in v1. v3: 0,0 means no GPS fix.
const META_VERSION = 3

const VIDEO = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp' }

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'library.db'))
  // The analyzer process writes to the same database; wait for its short transactions instead of failing.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
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
    CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);

    -- User metadata, keyed by content hash and UUID so it can sync (SYNC_PLAN.md).
    -- Deletions are tombstones (deleted = 1), never row removals.
    CREATE TABLE IF NOT EXISTS photo_state (sha256 TEXT PRIMARY KEY, favorite INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS collections_name ON collections(name COLLATE NOCASE) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS collection_items (collection_id TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection_id, sha256));
    -- Phone: photo_ai_record. type 'document' or NULL; the user's answer (user_verified) always wins.
    -- source: 'desktop' (this app's own OCR guess) or 'phone' (synced, SYNC_PLAN.md phase 6a) — a
    -- 'phone' row is authoritative and is never re-guessed locally (see documents.js Documents.pending).
    CREATE TABLE IF NOT EXISTS photo_ai (sha256 TEXT PRIMARY KEY, type TEXT, confidence REAL NOT NULL DEFAULT 0, user_verified INTEGER NOT NULL DEFAULT 0,
      review_state TEXT NOT NULL DEFAULT 'none', version TEXT, source TEXT NOT NULL DEFAULT 'desktop', updated_at INTEGER NOT NULL);
    -- Phone: photo_ai_label. Local English labels for search ("Scene: …", "Likely day", "Portrait").
    CREATE TABLE IF NOT EXISTS photo_labels (sha256 TEXT NOT NULL, label TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(sha256, label));`)
  // Added after the first release: place name ('' = looked up, nothing near) and its search spellings.
  const columns = db.prepare('PRAGMA table_info(media)').all().map(c => c.name)
  if (!columns.includes('place')) db.exec('ALTER TABLE media ADD COLUMN place TEXT; ALTER TABLE media ADD COLUMN place_names TEXT;')
  if (!columns.includes('meta_v')) db.exec('ALTER TABLE media ADD COLUMN meta_v INTEGER NOT NULL DEFAULT 1')
  // Where the photo physically is (SYNC_PLAN.md D3): NULL is this computer's Photos folder, otherwise the id of the
  // storage drive it was moved to, at the same relative path under <drive>/Tetra/Photos. It stays in the library
  // either way — grid, People, collections and search keep it — only opening it needs the drive.
  if (!columns.includes('location')) db.exec('ALTER TABLE media ADD COLUMN location TEXT')
  // "Hide this album from Gallery" belongs to the album, not to this computer, so it lives here and syncs.
  if (!db.prepare('PRAGMA table_info(collections)').all().some(c => c.name === 'hidden')) db.exec('ALTER TABLE collections ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  // Labels had no clock, so they could only ever be sent one way (SYNC_PLAN.md 6w 2). Everything already
  // here is stamped once, now, so the first device to ask with a fresh cursor is given all of it.
  if (!db.prepare('PRAGMA table_info(photo_labels)').all().some(c => c.name === 'updated_at')) {
    db.exec('ALTER TABLE photo_labels ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
    db.prepare('UPDATE photo_labels SET updated_at = ?').run(Date.now())
  }
  const aiColumns = db.prepare('PRAGMA table_info(photo_ai)').all().map(c => c.name)
  if (!aiColumns.includes('source')) db.exec("ALTER TABLE photo_ai ADD COLUMN source TEXT NOT NULL DEFAULT 'desktop'")
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

const isHeic = file => /\.(heic|heif)$/i.test(file)
const isRaw = file => /\.(nef|dng|cr2|cr3|arw|raf|orf|rw2|pef|srw)$/i.test(file)
/** Neither a browser nor an editor can open these; both get the JPEG this app makes from them instead. */
const needsPreview = file => isHeic(file) || isRaw(file)

/**
 * An upright sharp pipeline for any library image. The bundled libvips reads no HEVC HEIC (the phone's
 * camera format), so those go through libheif (WASM), which already applies the rotation.
 */
async function image(file) {
  const sharp = require('sharp')
  if (!isHeic(file)) return sharp(file).rotate()
  const { width, height, data } = await require('heic-decode')({ buffer: await fsp.readFile(file) })
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
}

/** Full-size JPEG for formats Chromium cannot draw (HEIC), made once and cached. */
async function preview(file, sha, dataDir) {
  const target = path.join(dataDir, 'thumbs', sha + '.preview.jpg')
  if (!fs.existsSync(target)) await (await image(file)).resize(2560, 2560, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(target)
  return target
}

async function imageInfo(file) {
  const exifr = require('exifr')
  const out = {}
  try {
    const x = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'] })
    const date = x?.DateTimeOriginal || x?.CreateDate
    if (date instanceof Date && !isNaN(date)) out.taken_at = date.getTime()
    // 0,0 is what cameras write without a GPS fix, not a real place.
    if (Number.isFinite(x?.latitude) && Number.isFinite(x?.longitude) && (x.latitude || x.longitude)) { out.latitude = x.latitude; out.longitude = x.longitude }
    const camera = [x?.Make, x?.Model].filter(Boolean).join(' ').trim()
    if (camera) out.camera = camera
  } catch {}
  try {
    if (isHeic(file)) {
      const m = await (await image(file)).metadata()
      out.width = m.width; out.height = m.height
    } else {
      const m = await require('sharp')(file).metadata()
      const turned = m.orientation >= 5 // EXIF 5-8 swap width and height
      out.width = turned ? m.height : m.width
      out.height = turned ? m.width : m.height
    }
  } catch {}
  return out
}

async function makeThumb(file, isVideo, target) {
  if (!isVideo) {
    // Written aside and renamed: a crash mid-write must not leave a half thumbnail that looks finished.
    await (await image(file)).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(target + '.part')
    await fsp.rename(target + '.part', target)
    return
  }
  // ponytail: needs a system ffmpeg; bundle ffmpeg-static if packaged users lack it.
  await new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'webp', target],
    err => err ? reject(err) : resolve()))
  if (!fs.existsSync(target)) throw new Error('no frame')
}

/** Brings the database in line with the folder. Unchanged files (same size + mtime) are not re-read. */
async function scan(db, root, dataDir, onProgress = () => {}) {
  // Only what lives here: a photo moved to a storage drive is not in this folder, and that is not a deletion.
  const known = new Map(db.prepare('SELECT path, size, mtime, sha256, thumb, meta_v FROM media WHERE location IS NULL').all().map(r => [r.path, r]))
  // A folder that is not there is not a library that was emptied: a renamed folder or an unmounted disk must never
  // read as "every photo was deleted", which would drop every face and every place with them.
  if (known.size && !fs.existsSync(root)) throw new Error(`The Photos folder is missing (${root}); nothing was changed.`)
  const seen = new Set()
  const insert = db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, width, height, latitude, longitude, camera, thumb, meta_v)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,${META_VERSION}) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, mime=excluded.mime, is_video=excluded.is_video,
    size=excluded.size, mtime=excluded.mtime, taken_at=excluded.taken_at, width=excluded.width, height=excluded.height,
    latitude=excluded.latitude, longitude=excluded.longitude, camera=excluded.camera, thumb=excluded.thumb, meta_v=excluded.meta_v, place=NULL, place_names=NULL,
    location=NULL`) // found in the folder again (restored from the Trash, say): it lives here again
  let done = 0, changed = 0
  for await (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase()
    const mime = IMAGE[ext] || VIDEO[ext]
    if (!mime) continue
    const rel = path.relative(root, file)
    seen.add(rel)
    const st = await fsp.stat(file)
    const old = known.get(rel)
    const same = old && old.size === st.size && old.mtime === Math.trunc(st.mtimeMs)
    if (same && old.thumb && old.meta_v >= META_VERSION) { onProgress(++done, changed); continue }
    const isVideo = !!VIDEO[ext]
    const hash = same ? old.sha256 : await sha256(file)
    const info = isVideo ? {} : await imageInfo(file)
    const thumbFile = path.join(dataDir, 'thumbs', hash + '.webp')
    let thumb = fs.existsSync(thumbFile)
    if (!thumb) thumb = await makeThumb(file, isVideo, thumbFile).then(() => true, () => false)
    insert.run(rel, hash, mime, isVideo ? 1 : 0, st.size, Math.trunc(st.mtimeMs), info.taken_at ?? Math.trunc(st.mtimeMs),
      info.width ?? null, info.height ?? null, info.latitude ?? null, info.longitude ?? null, info.camera ?? null, thumb ? 1 : 0)
    onProgress(++done, ++changed)
  }
  // An empty mount point looks exactly like this. A handful of photos all deleted on purpose is allowed through.
  // ponytail: a count, not a mount check; switch to comparing the folder's device id if it ever misfires.
  if (known.size >= 20 && seen.size === 0) throw new Error(`The Photos folder is empty (${root}); nothing was changed.`)
  const del = db.prepare('DELETE FROM media WHERE path = ? AND location IS NULL')
  const byPath = db.prepare('SELECT sha256 FROM media WHERE path = ?')
  const gone = []
  let removed = 0
  for (const rel of known.keys()) if (!seen.has(rel)) {
    const row = byPath.get(rel)
    del.run(rel)
    if (row) gone.push({ rel, sha256: row.sha256 })
    removed++
  }
  // Removals run after every file on disk has been seen, so a photo that merely moved is already back in the
  // table under its new path and is not treated as gone. A photo sitting in the Trash is not gone either — it
  // can be put back, and it should come back to the person it belongs to, so its faces are left alone.
  if (gone.length) {
    const trashed = new Set((await trashedPhotos(root).catch(() => [])).map(t => t.path))
    forgetFacesOfGonePhotos(db, gone.filter(g => !trashed.has(g.rel)).map(g => g.sha256))
  }
  return { total: seen.size, changed, removed }
}

function list(db) {
  return db.prepare(`SELECT m.id, m.path, m.sha256, m.mime, m.is_video, m.size, m.taken_at, m.width, m.height, m.latitude, m.longitude, m.camera, m.thumb, m.place, m.place_names,
    m.location,
    COALESCE(s.favorite, 0) AS favorite, COALESCE(a.type = 'document', 0) AS document,
    (SELECT GROUP_CONCAT(label, ', ') FROM photo_labels l WHERE l.sha256 = m.sha256) AS labels
    FROM media m LEFT JOIN photo_state s ON s.sha256 = m.sha256 LEFT JOIN photo_ai a ON a.sha256 = m.sha256 ORDER BY m.taken_at DESC, m.path`).all()
}

function transaction(db, fn) {
  db.exec('BEGIN')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
}

const isHash = h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)
function hashes(list) {
  if (!Array.isArray(list) || !list.every(isHash)) throw new Error('Invalid photo list.')
  return [...new Set(list)]
}

function setFavorite(db, shas, favorite) {
  const now = Date.now()
  const q = db.prepare('INSERT INTO photo_state(sha256, favorite, updated_at) VALUES(?,?,?) ON CONFLICT(sha256) DO UPDATE SET favorite = excluded.favorite, updated_at = excluded.updated_at')
  transaction(db, () => { for (const h of hashes(shas)) q.run(h, favorite ? 1 : 0, now) })
}

// Same rules as the phone (PhotoMetadataRules.collectionName).
function collectionName(raw) {
  const name = String(raw ?? '').trim()
  if (!name) throw new Error('Collection name cannot be empty.')
  if (name.length > 60) throw new Error('Collection names can be at most 60 characters.')
  if (/\p{Cc}/u.test(name)) throw new Error('Collection name contains unsupported characters.')
  return name
}

/** Live collections with the count and cover (newest member) among photos present in the library. */
function collections(db) {
  return db.prepare(`SELECT c.id, c.name,
      (SELECT COUNT(DISTINCT m.sha256) FROM collection_items i JOIN media m ON m.sha256 = i.sha256 WHERE i.collection_id = c.id AND i.deleted = 0) AS count,
      (SELECT m.sha256 FROM collection_items i JOIN media m ON m.sha256 = i.sha256 WHERE i.collection_id = c.id AND i.deleted = 0 AND m.thumb = 1 ORDER BY m.taken_at DESC LIMIT 1) AS cover,
      c.hidden
    FROM collections c WHERE c.deleted = 0 ORDER BY c.name COLLATE NOCASE`).all().map(c => ({ ...c, hidden: !!c.hidden }))
}

function createCollection(db, raw) {
  const name = collectionName(raw)
  if (db.prepare('SELECT 1 FROM collections WHERE deleted = 0 AND name = ? COLLATE NOCASE').get(name)) throw new Error(`A collection named “${name}” already exists.`)
  const id = crypto.randomUUID(), now = Date.now()
  db.prepare('INSERT INTO collections(id, name, created_at, updated_at) VALUES(?,?,?,?)').run(id, name, now, now)
  return { id, name, count: 0, cover: null }
}

function liveCollection(db, id) {
  if (!db.prepare('SELECT 1 FROM collections WHERE id = ? AND deleted = 0').get(String(id))) throw new Error('This collection no longer exists.')
}

/** Removes the collection and its memberships only; photos stay in the library. */
function deleteCollection(db, id) {
  liveCollection(db, id)
  const now = Date.now()
  transaction(db, () => {
    db.prepare('UPDATE collections SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id)
    db.prepare('UPDATE collection_items SET deleted = 1, updated_at = ? WHERE collection_id = ? AND deleted = 0').run(now, id)
  })
}

function setMembership(db, id, shas, member) {
  liveCollection(db, id)
  const now = Date.now()
  const q = db.prepare('INSERT INTO collection_items(collection_id, sha256, updated_at, deleted) VALUES(?,?,?,?) ON CONFLICT(collection_id, sha256) DO UPDATE SET deleted = excluded.deleted, updated_at = excluded.updated_at')
  transaction(db, () => { for (const h of hashes(shas)) q.run(id, h, now, member ? 0 : 1) })
}

function members(db, id) {
  return db.prepare('SELECT sha256 FROM collection_items WHERE collection_id = ? AND deleted = 0').all(String(id)).map(r => r.sha256)
}

/**
 * Sends library files to the system Trash (reversible from the file manager). Only paths the
 * database knows, inside root. Favorites and collections stay, keyed by hash, so a restore brings them back.
 */
async function trash(db, root, ids, trashItem) {
  const get = db.prepare('SELECT path FROM media WHERE id = ?')
  const del = db.prepare('DELETE FROM media WHERE id = ?')
  const result = { trashed: 0, failed: [] }
  for (const id of ids) {
    const row = get.get(Number(id))
    const full = row && path.resolve(root, row.path)
    if (!full || !full.startsWith(path.resolve(root) + path.sep)) { result.failed.push(String(id)); continue }
    try { await trashItem(full); del.run(Number(id)); result.trashed++ } catch { result.failed.push(row.path) }
  }
  return result
}

/**
 * The desktop's Trash is the system's own: `shell.trashItem` moves a photo into the freedesktop trash, which
 * records where it came from in a .trashinfo file beside it. Reading those back is what lets Photos show a
 * Trash of its own, with the same two answers the phone gives — put it back, or finish the delete.
 *
 * Only items whose recorded origin was inside the library are listed: the rest of the user's trash is theirs.
 */
function trashDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Trash')
}

async function trashedPhotos(photosRoot) {
  const dir = trashDir()
  let names
  try { names = await fsp.readdir(path.join(dir, 'info')) } catch { return [] }
  const root = path.resolve(photosRoot) + path.sep
  const out = []
  for (const info of names) {
    if (!info.endsWith('.trashinfo')) continue
    let text
    try { text = await fsp.readFile(path.join(dir, 'info', info), 'utf8') } catch { continue }
    const origin = /^Path=(.*)$/m.exec(text)?.[1]
    const deleted = /^DeletionDate=(.*)$/m.exec(text)?.[1]
    if (!origin) continue
    const full = decodeURIComponent(origin)
    if (!path.resolve(full).startsWith(root)) continue
    const id = info.slice(0, -'.trashinfo'.length)
    const file = path.join(dir, 'files', id)
    let size = 0
    try { size = (await fsp.stat(file)).size } catch { continue } // the info outlived the file: not ours to show
    out.push({ id, name: path.basename(full), path: path.relative(photosRoot, full), size, deletedAt: Date.parse(deleted ?? '') || 0, file })
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Back to exactly where it came from, and never over something that has taken the name since. */
async function restoreTrashed(photosRoot, ids) {
  const dir = trashDir()
  const wanted = new Set((ids ?? []).map(String))
  const restored = [], failed = []
  for (const item of await trashedPhotos(photosRoot)) {
    if (!wanted.has(item.id)) continue
    const target = path.join(photosRoot, item.path)
    try {
      if (fs.existsSync(target)) throw new Error('Something else is already there.')
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.rename(item.file, target)
      await fsp.rm(path.join(dir, 'info', item.id + '.trashinfo'), { force: true })
      restored.push(item.path)
    } catch (e) { failed.push(`${item.name}: ${e.message}`) }
  }
  return { restored, failed }
}

/** Permanent, and only for the library's own items — the rest of the user's trash is left alone. */
async function emptyPhotoTrash(photosRoot) {
  const dir = trashDir()
  let removed = 0
  for (const item of await trashedPhotos(photosRoot)) {
    try {
      await fsp.rm(item.file, { recursive: true, force: true })
      await fsp.rm(path.join(dir, 'info', item.id + '.trashinfo'), { force: true })
      removed++
    } catch {}
  }
  return removed
}

// --- Sync (SYNC_PLAN.md phase 6b). Every record carries updated_at and removals are tombstones, so the two
// libraries converge without either side guessing: the newest write of a record wins, in both directions.

function applyFavorite(db, sha, favorite, updatedAt) {
  db.prepare(`INSERT INTO photo_state(sha256, favorite, updated_at) VALUES(?,?,?) ON CONFLICT(sha256)
    DO UPDATE SET favorite = excluded.favorite, updated_at = excluded.updated_at WHERE photo_state.updated_at < excluded.updated_at`)
    .run(sha, favorite ? 1 : 0, updatedAt)
}

/** The phone's collection UUID becomes this collection's id, so the same collection is one collection everywhere. */
function setCollectionHidden(db, id, hidden) {
  liveCollection(db, id)
  db.prepare('UPDATE collections SET hidden = ?, updated_at = ? WHERE id = ?').run(hidden ? 1 : 0, Date.now(), String(id))
}

function applyCollection(db, uuid, name, deleted, updatedAt, hidden = false) {
  const local = db.prepare('SELECT updated_at FROM collections WHERE id = ?').get(uuid)
  if (local) {
    if (local.updated_at >= updatedAt) return
    return void db.prepare('UPDATE collections SET name = ?, deleted = ?, hidden = ?, updated_at = ? WHERE id = ?')
      .run(collectionName(name), deleted ? 1 : 0, hidden ? 1 : 0, updatedAt, uuid)
  }
  if (deleted) return // nothing here to bury
  const sameName = db.prepare('SELECT id FROM collections WHERE deleted = 0 AND name = ? COLLATE NOCASE').get(name)
  if (sameName) { // made on both devices under the same name: adopt the phone's id rather than keeping two
    return transaction(db, () => {
      db.prepare('UPDATE collection_items SET collection_id = ? WHERE collection_id = ?').run(uuid, sameName.id)
      db.prepare('UPDATE collections SET id = ?, updated_at = ? WHERE id = ?').run(uuid, updatedAt, sameName.id)
    })
  }
  db.prepare('INSERT INTO collections(id, name, created_at, updated_at, deleted, hidden) VALUES(?,?,?,?,0,?)').run(uuid, collectionName(name), updatedAt, updatedAt, hidden ? 1 : 0)
}

function applyCollectionItem(db, collection, sha, deleted, updatedAt) {
  if (!db.prepare('SELECT 1 FROM collections WHERE id = ?').get(collection)) return // its collection has not arrived
  db.prepare(`INSERT INTO collection_items(collection_id, sha256, updated_at, deleted) VALUES(?,?,?,?) ON CONFLICT(collection_id, sha256)
    DO UPDATE SET deleted = excluded.deleted, updated_at = excluded.updated_at WHERE collection_items.updated_at < excluded.updated_at`)
    .run(collection, sha, updatedAt, deleted ? 1 : 0)
}

/**
 * A face belongs to a photo, so when the photo leaves this library the face goes with it, and a person left with
 * no faces at all stops existing here. Only photos that are really gone count: not one that merely moved, not
 * one waiting in the Trash to be put back, and not a photo the phone has told us about but never sent — that one
 * has no media row and never had one.
 *
 * The person's row is removed rather than tombstoned, on purpose: the phone may still hold that person's photos,
 * and a tombstone would travel there and delete someone who is perfectly alive. This way the next sync simply
 * brings them back.
 */
function forgetFacesOfGonePhotos(db, sha256s) {
  // People is a separate module and may never have run here, in which case there is nothing to clean up.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'faces'").get()) return
  const stillHere = db.prepare('SELECT 1 FROM media WHERE sha256 = ?')
  const forget = db.prepare('DELETE FROM faces WHERE sha256 = ?')
  for (const sha of sha256s) if (!stillHere.get(sha)) forget.run(sha)
  db.prepare(`DELETE FROM people WHERE deleted = 0
    AND id NOT IN (SELECT person_id FROM faces WHERE person_id IS NOT NULL AND deleted = 0)`).run()
}

/** Search labels only ever merge: they are produced by analysis, never removed by hand. */
function applyLabels(db, sha, labels, at = Date.now()) {
  const q = db.prepare('INSERT OR IGNORE INTO photo_labels(sha256, label, updated_at) VALUES(?,?,?)')
  for (const label of labels) if (typeof label === 'string' && label.trim()) q.run(sha, label.trim().slice(0, 120), at)
}

/** Desktop changes for the phone's GET /metadata?since= pull. */
function metadataSince(db, since) {
  return {
    favorites: db.prepare('SELECT sha256, favorite, updated_at AS updatedAt FROM photo_state WHERE updated_at > ?').all(since).map(r => ({ ...r, favorite: !!r.favorite })),
    collections: db.prepare('SELECT id AS uuid, name, deleted, hidden, updated_at AS updatedAt FROM collections WHERE updated_at > ?').all(since).map(r => ({ ...r, deleted: !!r.deleted, hidden: !!r.hidden })),
    collectionItems: db.prepare('SELECT collection_id AS collection, sha256, deleted, updated_at AS updatedAt FROM collection_items WHERE updated_at > ?').all(since).map(r => ({ ...r, deleted: !!r.deleted })),
    // Labels only ever merge — nothing removes one by hand — so they travel as the whole set for a photo.
    labels: Object.values(db.prepare('SELECT sha256, label, updated_at AS updatedAt FROM photo_labels WHERE updated_at > ?').all(since)
      .reduce((byPhoto, r) => {
        const row = byPhoto[r.sha256] ??= { sha256: r.sha256, labels: [], updatedAt: 0 }
        row.labels.push(r.label)
        row.updatedAt = Math.max(row.updatedAt, r.updatedAt)
        return byPhoto
      }, {})),
  }
}

module.exports = { open, scan, list, transaction, sha256, trash, image, preview, isHeic, isRaw, needsPreview, setFavorite, collectionName, collections, createCollection, deleteCollection, setMembership, members, setCollectionHidden, trashedPhotos, restoreTrashed, emptyPhotoTrash, applyFavorite, applyCollection, applyCollectionItem, applyLabels, metadataSince }
