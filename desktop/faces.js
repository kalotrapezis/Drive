// People: a port of the phone's PhotoClassifier + PhotoMetadataStore face logic.
// Detection uses YuNet (ML Kit is Android only); alignment, MobileFaceNet embedding, quality,
// reliability and grouping thresholds are the phone's, so embeddings and groups are interchangeable.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const EMBEDDING_MODEL = 'mobilefacenet-192-eyes38x44-74x44' // phone: PhotoClassifier.embed
const ANALYSIS_VERSION = 'yunet2023mar-2pass+' + EMBEDDING_MODEL
// Where a face counts as someone this library already knows. Measured twice, and the second one is the one to
// trust: the first compared random pairs of faces, which is not what the app does. This measures the comparison
// it actually makes — a new face against each known person, taking that person's closest face — on this
// library's own named people, 304 faces across 27–28 people on each device:
//
//   line   joins of the same person (computer / phone)   different people wrongly joined
//   0.60            85.2% / 90.1%                              1.58% / 1.61%
//   0.68            76.6% / 80.6%                              0.33% / 0.31%
//   0.75            63.2% / 68.4%                              0.00% / 0.02%
//
// 0.60 joined wrongly on one comparison in sixty, which is what it looked like in the library. The line is 0.75,
// where different people essentially never meet, and everything below it down to 0.45 becomes a question rather
// than a silent join. The two mistakes are not equal: a wrong join has to be picked apart by hand, a missed one
// is a Combine or one answer to a card.
const SAME_PERSON = 0.75, REVIEW_FROM = 0.45, ANCHOR_QUALITY = 0.68
// The day a photo was taken, as evidence about who is in it — the phone's SAME_DAY_BONUS, same number, same
// reason. Measured on this library (2026-09-24, 290 faces, 46 people, 7020 comparisons of the kind the app
// makes): a comparison against someone who appears that same day is the same person 39.3% of the time, against
// 1.6% on another day. Twenty-five times the prior, so it earns a nudge, not a licence: +0.05 takes five points
// of the joins the line was missing for one wrong join in seven thousand, and the knee is well before +0.15.
const SAME_DAY_BONUS = 0.05
const DAY = 86400000
const dayOf = t => (t > 0 ? Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / DAY) : -Infinity)
// Two boxes this far into each other, on the same photo, are the same face found twice (sync, SYNC_PLAN.md 6c).
const SAME_FACE_OVERLAP = 0.4
const DETECT_SIZE = 640, DETECT_SCORE = 0.8, NMS_IOU = 0.3
// ponytail: yaw from the nose offset between the eyes (ML Kit gives it directly). NOSE_DEPTH was calibrated on 16 phone
// faces (2026-09-22) so faces ML Kit rated ≤ 30° stay ≤ 30° here; retune if frontal faces get rejected.
const NOSE_DEPTH = 0.6

// ---- pure helpers (tested) ----

const luminance = (d, i) => Math.trunc((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000)

function faceQualityScore(minSide, meanEdgeContrast) {
  const clamp = v => Math.min(1, Math.max(0, v))
  return clamp(minSide / 112) * 0.45 + clamp(meanEdgeContrast / 18) * 0.55
}

const isReliableFace = (quality, yaw = 0, roll = 0) => quality >= ANCHOR_QUALITY && Math.abs(yaw) <= 30 && Math.abs(roll) <= 20

/** Phone: Bitmap.faceQuality — edge contrast sampled on a grid inside the box. */
function faceQuality(img, b) {
  const w = b.right - b.left, h = b.bottom - b.top
  const step = Math.max(1, Math.trunc(Math.min(w, h) / 24))
  let contrast = 0, samples = 0
  for (let y = b.top; y < b.bottom - step; y += step) for (let x = b.left; x < b.right - step; x += step) {
    const at = (xx, yy) => luminance(img.data, (yy * img.width + xx) * 3)
    const l = at(x, y)
    contrast += Math.abs(l - at(x + step, y)) + Math.abs(l - at(x, y + step))
    samples += 2
  }
  return faceQualityScore(Math.min(w, h), Math.trunc(contrast / Math.max(1, samples)))
}

/** Phone: embed() — similarity transform putting the eyes at (38,44) and (74,44) of a 112×112 crop, bilinear, black outside. */
function alignedInput(img, left, right) {
  const dx = right.x - left.x, dy = right.y - left.y, len = Math.hypot(dx, dy)
  const cos = dx / len, sin = dy / len, inv = len / 36
  const out = new Float32Array(112 * 112 * 3)
  const px = (x, y, c) => (x < 0 || y < 0 || x >= img.width || y >= img.height) ? 0 : img.data[(y * img.width + x) * 3 + c]
  for (let ty = 0; ty < 112; ty++) for (let tx = 0; tx < 112; tx++) {
    const qx = tx + 0.5 - 38, qy = ty + 0.5 - 44
    const sx = left.x + inv * (cos * qx - sin * qy) - 0.5
    const sy = left.y + inv * (sin * qx + cos * qy) - 0.5
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
    for (let c = 0; c < 3; c++) {
      const v = px(x0, y0, c) * (1 - fx) * (1 - fy) + px(x0 + 1, y0, c) * fx * (1 - fy) + px(x0, y0 + 1, c) * (1 - fx) * fy + px(x0 + 1, y0 + 1, c) * fx * fy
      out[(ty * 112 + tx) * 3 + c] = (v - 127.5) / 127.5
    }
  }
  return out
}

function l2(v) {
  let m = 0
  for (const x of v) m += x * x
  m = Math.max(Math.sqrt(m), 0.00001)
  return Float32Array.from(v, x => x / m)
}

function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

/** Overlap of two [left, top, right, bottom] boxes, as fractions of the same photo. */
function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h
  return union > 0 ? (w * h) / union : 0
}

/** YuNet 2023mar output decoding (as OpenCV FaceDetectorYN) + greedy NMS. Coordinates are in the 640×640 input. */
function decodeYunet(out) {
  const faces = []
  for (const stride of [8, 16, 32]) {
    const cols = DETECT_SIZE / stride
    const cls = out[`cls_${stride}`].data, obj = out[`obj_${stride}`].data, box = out[`bbox_${stride}`].data, kps = out[`kps_${stride}`].data
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
      if (score < DETECT_SCORE) continue
      const c = i % cols, r = Math.trunc(i / cols)
      const cx = (c + box[i * 4]) * stride, cy = (r + box[i * 4 + 1]) * stride
      const w = Math.exp(box[i * 4 + 2]) * stride, h = Math.exp(box[i * 4 + 3]) * stride
      const points = []
      for (let n = 0; n < 5; n++) points.push({ x: (kps[i * 10 + 2 * n] + c) * stride, y: (kps[i * 10 + 2 * n + 1] + r) * stride })
      faces.push({ score, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, points })
    }
  }
  faces.sort((a, b) => b.score - a.score)
  const iou = (a, b) => {
    const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
    const inter = w * h
    return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter)
  }
  const kept = []
  for (const f of faces) if (kept.every(k => iou(k, f) <= NMS_IOU)) kept.push(f)
  return kept
}

/** Head angles from 5 landmarks: roll from the eye line, yaw from the nose offset. */
function headAngles(left, right, nose) {
  const roll = Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI
  const eyeDist = Math.hypot(right.x - left.x, right.y - left.y)
  const midX = (left.x + right.x) / 2
  const yaw = Math.atan((nose.x - midX) / eyeDist / NOSE_DEPTH) * 180 / Math.PI
  return { yaw, roll }
}

// ---- models ----

class FaceEngine {
  static async load(modelDir) {
    const ort = require('onnxruntime-node')
    const e = new FaceEngine()
    e.ort = ort
    // Loaded from buffers: works inside the packaged asar archive, where the runtime cannot open paths itself.
    e.detector = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, 'face_detection_yunet_2023mar.onnx')))
    e.embedder = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, 'mobilefacenet.onnx')))
    return e
  }

  /** Phone: decode at most 1280 px on the long side, upright. */
  static async decode(file) {
    const { data, info } = await (await require('./library').image(file)).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  }

  async detect(img) {
    const sharp = require('sharp')
    const scale = DETECT_SIZE / Math.max(img.width, img.height)
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale))
    const small = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h, { fit: 'fill' }).raw().toBuffer()
    const input = new Float32Array(3 * DETECT_SIZE * DETECT_SIZE) // top-left letterbox, BGR, 0–255 like OpenCV's blobFromImage
    const plane = DETECT_SIZE * DETECT_SIZE
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, t = y * DETECT_SIZE + x
      input[t] = small[s + 2]; input[plane + t] = small[s + 1]; input[2 * plane + t] = small[s]
    }
    const out = await this.detector.run({ input: new this.ort.Tensor('float32', input, [1, 3, DETECT_SIZE, DETECT_SIZE]) })
    return decodeYunet(out).map(f => ({
      score: f.score,
      x1: f.x1 / scale, y1: f.y1 / scale, x2: f.x2 / scale, y2: f.y2 / scale,
      points: f.points.map(p => ({ x: p.x / scale, y: p.y / scale })),
    }))
  }

  /**
   * Second pass on a zoomed square around one face, averaged with the first pass. Measured on 17 phone faces
   * (2026-09-22): phone-vs-desktop cosine mean 0.877 → 0.921, worst 0.667 → 0.761 (either pass alone had outliers).
   */
  async refine(img, d) {
    const cx = (d.x1 + d.x2) / 2, cy = (d.y1 + d.y2) / 2
    const side = Math.round(Math.max(d.x2 - d.x1, d.y2 - d.y1) * 2.5)
    const left = Math.round(cx - side / 2), top = Math.round(cy - side / 2)
    const crop = { width: side, height: side, data: Buffer.alloc(side * side * 3) } // black outside the photo
    for (let y = Math.max(0, -top); y < side && top + y < img.height; y++) {
      const sy = top + y, x0 = Math.max(0, -left), x1 = Math.min(side, img.width - left)
      if (x1 > x0) img.data.copy(crop.data, (y * side + x0) * 3, (sy * img.width + left + x0) * 3, (sy * img.width + left + x1) * 3)
    }
    const found = (await this.detect(crop)).map(f => ({ f, dist: Math.hypot((f.x1 + f.x2) / 2 - side / 2, (f.y1 + f.y2) / 2 - side / 2) })).sort((a, b) => a.dist - b.dist)[0]
    if (!found || found.dist > side / 4) return d
    const f = found.f
    return { ...d, points: f.points.map((p, i) => ({ x: (p.x + left + d.points[i].x) / 2, y: (p.y + top + d.points[i].y) / 2 })) }
  }

  async embed(img, left, right) {
    const out = await this.embedder.run({ input: new this.ort.Tensor('float32', alignedInput(img, left, right), [1, 112, 112, 3]) })
    return l2(out.embeddings.data)
  }

  /** Phone: classify() faces — reliable, front-facing faces only, with usable eye distance. */
  async analyze(img) {
    const faces = []
    for (const raw of await this.detect(img)) {
      const d = await this.refine(img, raw)
      const box = {
        left: Math.min(img.width, Math.max(0, Math.round(d.x1))), top: Math.min(img.height, Math.max(0, Math.round(d.y1))),
        right: Math.min(img.width, Math.max(0, Math.round(d.x2))), bottom: Math.min(img.height, Math.max(0, Math.round(d.y2))),
      }
      if (box.right - box.left < 24 || box.bottom - box.top < 24) continue
      const [left, right] = [d.points[0], d.points[1]].sort((a, b) => a.x - b.x)
      if (Math.abs(right.x - left.x) < 32) continue
      const quality = faceQuality(img, box)
      const { yaw, roll } = headAngles(left, right, d.points[2])
      if (!isReliableFace(quality, yaw, roll)) continue
      faces.push({ box, quality, yaw, roll, embedding: await this.embed(img, left, right) })
    }
    return faces
  }
}

// ---- storage and grouping ----

const isGeneratedName = name => /^Person \d+$/.test(name)

class People {
  constructor(db, dataDir) {
    this.db = db
    this.faceDir = path.join(dataDir, 'thumbs', 'faces')
    fs.mkdirSync(this.faceDir, { recursive: true })
    db.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS faces (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL,
        box_left REAL NOT NULL, box_top REAL NOT NULL, box_right REAL NOT NULL, box_bottom REAL NOT NULL, -- fractions of the upright image
        embedding BLOB NOT NULL, model TEXT NOT NULL, quality REAL NOT NULL, person_id TEXT, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS people_merges (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_name TEXT NOT NULL, face_ids TEXT NOT NULL, merged_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS faces_sha ON faces(sha256);
      CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);
      CREATE TABLE IF NOT EXISTS face_reviews (face_id TEXT NOT NULL, person_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL, PRIMARY KEY(face_id, person_id));
      CREATE TABLE IF NOT EXISTS face_analysis (sha256 TEXT PRIMARY KEY, version TEXT NOT NULL, faces INTEGER NOT NULL, analyzed_at INTEGER NOT NULL);`)
    // The face a person is shown by, when somebody has chosen one. Null means "the best one we can find".
    if (!db.prepare('PRAGMA table_info(people)').all().some(c => c.name === 'cover_face_id')) db.exec('ALTER TABLE people ADD COLUMN cover_face_id TEXT')
  }

  tx(fn) { this.db.exec('BEGIN'); try { const r = fn(); this.db.exec('COMMIT'); return r } catch (e) { this.db.exec('ROLLBACK'); throw e } }

  /** `everything` is a rescan: read photos that were read before, because the rules have changed since. */
  pending(everything = false) {
    if (everything) {
      return this.db.prepare(`SELECT m.sha256, MIN(m.path) AS path FROM media m WHERE m.is_video = 0
        GROUP BY m.sha256 ORDER BY MAX(m.taken_at) DESC`).all()
    }
    return this.db.prepare(`SELECT m.sha256, MIN(m.path) AS path FROM media m LEFT JOIN face_analysis a ON a.sha256 = m.sha256 AND a.version = ?
      WHERE m.is_video = 0 AND a.sha256 IS NULL GROUP BY m.sha256 ORDER BY MAX(m.taken_at) DESC`).all(ANALYSIS_VERSION)
  }

  /**
   * Throws away the people nobody has named, and their faces, so a rescan can group them again with whatever the
   * thresholds are now. People with a name keep their faces exactly as they are: a rescan redoes the guessing,
   * never a decision. Faces the phone sent come back on the next sync, since it still holds them.
   */
  forgetUnnamed() {
    return this.tx(() => {
      const doomed = this.db.prepare("SELECT id FROM people WHERE name GLOB 'Person [0-9]*'").all().map(r => r.id)
      this.db.prepare('DELETE FROM face_reviews WHERE face_id IN (SELECT id FROM faces WHERE person_id IS NULL)').run()
      this.db.prepare('DELETE FROM faces WHERE person_id IS NULL').run()
      for (const id of doomed) {
        this.db.prepare('DELETE FROM face_reviews WHERE person_id = ? OR face_id IN (SELECT id FROM faces WHERE person_id = ?)').run(id, id)
        this.db.prepare('DELETE FROM faces WHERE person_id = ?').run(id)
        this.db.prepare('DELETE FROM people_merges WHERE target_id = ? OR source_id = ?').run(id, id)
        this.db.prepare('DELETE FROM people WHERE id = ?').run(id)
      }
      this.db.prepare('DELETE FROM face_analysis').run() // every photo is worth reading again
      return doomed.length
    })
  }

  createPerson(now) {
    const names = new Set(this.db.prepare('SELECT name FROM people WHERE deleted = 0').all().map(r => r.name))
    let n = names.size + 1
    while (names.has(`Person ${n}`)) n++
    const id = crypto.randomUUID()
    this.db.prepare('INSERT INTO people(id, name, created_at, updated_at) VALUES(?,?,?,?)').run(id, `Person ${n}`, now, now)
    return id
  }

  /** Phone: recordFaces — match against anchors taken before this photo, join ≥ 0.74, else a new person; 0.66–0.74 also asks for review. */
  record(sha, faces, size) {
    const now = Date.now()
    return this.tx(() => {
      // A photo that already has faces (an earlier run, or synced from the phone) keeps them: re-analysis must never
      // duplicate faces or undo manual grouping.
      if (this.db.prepare('SELECT 1 FROM faces WHERE sha256 = ? AND deleted = 0').get(sha)) {
        this.db.prepare('INSERT INTO face_analysis(sha256, version, faces, analyzed_at) VALUES(?,?,0,?) ON CONFLICT(sha256) DO UPDATE SET version = excluded.version, analyzed_at = excluded.analyzed_at').run(sha, ANALYSIS_VERSION, now)
        return []
      }
      const taken = this.db.prepare('SELECT taken_at FROM media WHERE sha256 = ?').get(sha)?.taken_at ?? 0
      const day = dayOf(taken)
      const candidates = this.db.prepare(`SELECT f.person_id, f.embedding, m.taken_at FROM faces f
        JOIN people p ON p.id = f.person_id AND p.deleted = 0 JOIN media m ON m.sha256 = f.sha256
        WHERE f.deleted = 0 AND f.quality >= ?`).all(ANCHOR_QUALITY)
        .map(r => ({ person: r.person_id, embedding: new Float32Array(new Uint8Array(r.embedding).buffer), day: dayOf(r.taken_at) }))
      const ids = []
      for (const face of faces) {
        let best = null, similarity = -1
        // The day is evidence, not proof: a face seen on the same day as someone already known starts a little
        // closer to them, which is what catches the same person across two photos of one moment.
        for (const c of candidates) {
          const s = cosine(face.embedding, c.embedding) + (c.day === day ? SAME_DAY_BONUS : 0)
          if (s > similarity) { similarity = s; best = c }
        }
        const reliable = isReliableFace(face.quality, face.yaw, face.roll)
        const person = similarity >= SAME_PERSON ? best.person : !reliable ? null : this.createPerson(now)
        if (!person) continue
        const id = crypto.randomUUID()
        const b = face.box
        this.db.prepare(`INSERT INTO faces(id, sha256, box_left, box_top, box_right, box_bottom, embedding, model, quality, person_id, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, sha, b.left / size.width, b.top / size.height, b.right / size.width, b.bottom / size.height,
            Buffer.from(face.embedding.buffer, face.embedding.byteOffset, face.embedding.byteLength), EMBEDDING_MODEL, face.quality, person, now)
        if (reliable && similarity >= REVIEW_FROM && similarity < SAME_PERSON) {
          this.db.prepare('INSERT OR IGNORE INTO face_reviews(face_id, person_id, state, updated_at) VALUES(?,?,?,?)').run(id, best.person, 'pending', now)
        }
        ids.push(id)
      }
      this.db.prepare('INSERT INTO face_analysis(sha256, version, faces, analyzed_at) VALUES(?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET version = excluded.version, faces = excluded.faces, analyzed_at = excluded.analyzed_at')
        .run(sha, ANALYSIS_VERSION, ids.length, now)
      return ids
    })
  }

  skip(sha) {
    this.db.prepare('INSERT INTO face_analysis(sha256, version, faces, analyzed_at) VALUES(?,?,0,?) ON CONFLICT(sha256) DO UPDATE SET version = excluded.version, faces = 0, analyzed_at = excluded.analyzed_at')
      .run(sha, ANALYSIS_VERSION, Date.now())
  }

  async saveCrop(img, faceId, box) {
    const w = box.right - box.left, h = box.bottom - box.top, side = Math.round(Math.max(w, h) * 1.5)
    const left = Math.max(0, Math.round(box.left + w / 2 - side / 2)), top = Math.max(0, Math.round(box.top + h / 2 - side / 2))
    await require('sharp')(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
      .extract({ left, top, width: Math.min(side, img.width - left), height: Math.min(side, img.height - top) })
      .resize(160, 160, { fit: 'cover' }).webp({ quality: 80 }).toFile(path.join(this.faceDir, faceId + '.webp'))
  }

  /**
   * The 160-px crop People shows. Faces this app detected get one during analysis; a face that arrived from the
   * phone has none, so it is cut here from the photo itself using the fractions the phone sent.
   */
  async crop(faceId, photosRoot) {
    const file = path.join(this.faceDir, faceId + '.webp')
    if (fs.existsSync(file)) return file
    const f = this.db.prepare(`SELECT f.box_left, f.box_top, f.box_right, f.box_bottom,
      (SELECT MIN(m.path) FROM media m WHERE m.sha256 = f.sha256) AS path FROM faces f WHERE f.id = ?`).get(faceId)
    if (!f?.path) return null
    const sharp = require('sharp')
    const source = sharp(path.join(photosRoot, f.path)).rotate() // EXIF applied: the box is of the upright image
    const { width, height } = await source.metadata()
    const w = (f.box_right - f.box_left) * width, h = (f.box_bottom - f.box_top) * height
    const side = Math.round(Math.max(w, h) * 1.5)
    const left = Math.max(0, Math.round(f.box_left * width + w / 2 - side / 2))
    const top = Math.max(0, Math.round(f.box_top * height + h / 2 - side / 2))
    await source.extract({ left, top, width: Math.min(side, width - left), height: Math.min(side, height - top) })
      .resize(160, 160, { fit: 'cover' }).webp({ quality: 80 }).toFile(file)
    return file
  }

  /** Live people with photos present in the library. Named people first, like the phone. */
  list() {
    return this.db.prepare(`SELECT p.id, p.name, COUNT(DISTINCT f.sha256) AS count,
        (SELECT f3.id FROM faces f3 WHERE f3.id = p.cover_face_id AND f3.deleted = 0) AS chosenFace,
        (SELECT f2.id FROM faces f2 JOIN media m2 ON m2.sha256 = f2.sha256
          WHERE f2.person_id = p.id AND f2.deleted = 0 ORDER BY f2.quality DESC LIMIT 1) AS best
      FROM people p JOIN faces f ON f.person_id = p.id AND f.deleted = 0 JOIN media m ON m.sha256 = f.sha256
      WHERE p.deleted = 0 GROUP BY p.id`).all()
      // The face somebody chose, if it is still here; otherwise the best one. (SQLite will not resolve an outer
      // column inside a subquery's ORDER BY, so the choice is applied out here rather than in the query.)
      .map(r => ({ ...r, cover: (r.chosenFace && r.chosenFace !== r.best ? r.chosenFace : r.best) ?? r.best }))
      .sort((a, b) => Number(isGeneratedName(a.name)) - Number(isGeneratedName(b.name))
        || (isGeneratedName(a.name) ? Number(a.name.slice(7)) - Number(b.name.slice(7)) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))
  }

  /** The face a person is shown by, when somebody has chosen one, and every face there is to choose from. */
  facesOf(personId) {
    return this.db.prepare(`SELECT f.id, f.sha256, f.quality, f.box_left, f.box_top, f.box_right, f.box_bottom,
        CASE WHEN p.cover_face_id = f.id THEN 1 ELSE 0 END AS chosen, m.taken_at AS takenAt
      FROM faces f JOIN people p ON p.id = f.person_id JOIN media m ON m.sha256 = f.sha256
      WHERE f.person_id = ? AND f.deleted = 0 ORDER BY m.taken_at DESC`).all(String(personId))
      .map(r => ({ ...r, chosen: !!r.chosen }))
  }

  /** Choosing it is a decision, so it is kept and it travels like one. */
  setCover(personId, faceId) {
    this.live(personId)
    if (faceId && !this.db.prepare('SELECT 1 FROM faces WHERE id = ? AND person_id = ? AND deleted = 0').get(faceId, String(personId))) {
      throw new Error('That face does not belong to this person.')
    }
    this.db.prepare('UPDATE people SET cover_face_id = ?, updated_at = ? WHERE id = ?').run(faceId ?? null, Date.now(), String(personId))
  }

  shas(personId) {
    return this.db.prepare('SELECT DISTINCT sha256 FROM faces WHERE person_id = ? AND deleted = 0').all(String(personId)).map(r => r.sha256)
  }

  namesBySha() {
    const out = {}
    for (const r of this.db.prepare(`SELECT DISTINCT f.sha256, p.name FROM faces f JOIN people p ON p.id = f.person_id AND p.deleted = 0 WHERE f.deleted = 0 ORDER BY p.name`).all()) {
      if (!isGeneratedName(r.name)) (out[r.sha256] ??= []).push(r.name)
    }
    return out
  }

  // --- Sync (SYNC_PLAN.md phase 6c). Both apps embed with the same MobileFaceNet on the same aligned crop, so
  // an embedding means the same thing on either side; boxes travel as fractions of the upright photo. What the
  // phone sends is therefore usable as-is — no translation between two face models is needed, only a way to tell
  // that a face the phone found and a face this app found are the same face, which is what overlap does below.

  /** Was this person's name given by a human, or made up by the grouping? */
  isNamed(id) {
    const row = id && this.db.prepare('SELECT name FROM people WHERE id = ?').get(id)
    return !!row && !isGeneratedName(row.name)
  }
  isAutoNamed(id) {
    const row = id && this.db.prepare('SELECT name FROM people WHERE id = ?').get(id)
    return !row || isGeneratedName(row.name)
  }

  /** A person named on the phone. Its UUID becomes this person's id, so the name stays attached across syncs. */
  applyPerson(uuid, name, updatedAt, cover = null) {
    const local = this.db.prepare('SELECT updated_at, name FROM people WHERE id = ?').get(uuid)
    if (local) {
      if (local.updated_at >= updatedAt) return
      // The rule faces already had, and people did not: "Person 41" is what an algorithm called someone it had
      // not been told about, and it never replaces what a human typed, however recently it was written.
      if (isGeneratedName(name) && !isGeneratedName(local.name)) return
      // The face somebody chose to show this person by is a decision too, and travels with the name.
      return void this.db.prepare(`UPDATE people SET name = ?, updated_at = ?${cover ? ', cover_face_id = ?' : ''} WHERE id = ?`)
        .run(...(cover ? [name, updatedAt, cover, uuid] : [name, updatedAt, uuid]))
    }
    this.db.prepare('INSERT INTO people(id, name, created_at, updated_at, cover_face_id) VALUES(?,?,?,?,?)').run(uuid, name, updatedAt, updatedAt, cover)
  }

  /**
   * A face the phone detected. If this app already found a face in the same place on the same photo, that is the
   * same face: it joins the phone's person instead of being duplicated beside it. Otherwise the phone's face is
   * kept whole — embedding included — so People works here even before any local analysis has run.
   */
  applyFace({ uuid, sha256, box, embedding, model, quality, person, updatedAt }) {
    if (person && !this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(person)) return // its person has not arrived
    const mine = this.db.prepare('SELECT id, updated_at, person_id FROM faces WHERE id = ?').get(uuid)
      ?? (box && this.db.prepare('SELECT id, updated_at, person_id, box_left, box_top, box_right, box_bottom FROM faces WHERE sha256 = ? AND deleted = 0').all(sha256)
        .map(f => ({ ...f, overlap: iou(box, [f.box_left, f.box_top, f.box_right, f.box_bottom]) }))
        .filter(f => f.overlap >= SAME_FACE_OVERLAP).sort((a, b) => b.overlap - a.overlap)[0])
    if (mine) {
      if (mine.updated_at >= updatedAt || !person) return
      // A guess never overwrites a decision. "Person 41" is what an algorithm called someone it had not been
      // told about; a name is what a human typed. Newest-wins decides between two of the same kind, never
      // between those two — or a device that has just re-analysed from scratch can un-name a whole library,
      // which is exactly what happened on 2026-09-23.
      if (this.isAutoNamed(person) && this.isNamed(mine.person_id)) return
      // Two devices that both named this face, and disagree. Neither is wrong: grouping is order-dependent, so
      // two devices starting from the same library reach different people. Newest-wins here meant the face was
      // torn from one person and given to the other silently — and torn back on the next sync. A disagreement
      // between two decisions is a question, so the face stays where it is and the difference becomes a card.
      if (this.isNamed(person) && this.isNamed(mine.person_id) && person !== mine.person_id) return void this.ask(mine.id, mine.person_id, person, updatedAt)
      return void this.db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?').run(person, updatedAt, mine.id)
    }
    if (!box || !person || !embedding) return // without a box there is nothing to show and nothing to match later
    this.db.prepare(`INSERT INTO faces(id, sha256, box_left, box_top, box_right, box_bottom, embedding, model, quality, person_id, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(uuid, sha256, box[0], box[1], box[2], box[3], embedding, model || EMBEDDING_MODEL, quality ?? 1, person, updatedAt)
  }

  /**
   * An answer to Help organize, as the other device can recognise it: the face and the person it was asked
   * about, both by uuids that already cross, so the question needed no id of its own. Answers travel; a pending
   * question does not, because it is this device's own uncertainty rather than news.
   */
  reviewsSince(since) {
    return this.db.prepare(`SELECT face_id AS face, person_id AS person, state, updated_at AS updatedAt
      FROM face_reviews WHERE state != 'pending' AND updated_at > ?`).all(since)
  }

  /**
   * Raise the difference between two groupings as one card, not fifty. Two people who disagree about a face
   * usually disagree about all of that person's faces, and asking about each one would bury the library in
   * questions that are all the same question. One pending card per pair of people is enough to *show* the
   * disagreement; combining them, if that is the answer, is a person's own action on the People page.
   */
  ask(faceId, mine, theirs, updatedAt) {
    const already = this.db.prepare(`SELECT 1 FROM face_reviews r JOIN faces f ON f.id = r.face_id AND f.deleted = 0
      WHERE f.person_id = ? AND r.person_id = ? AND r.state = 'pending'`).get(mine, theirs)
    if (already) return
    this.db.prepare(`INSERT INTO face_reviews(face_id, person_id, state, updated_at) VALUES(?,?, 'pending', ?)
      ON CONFLICT(face_id, person_id) DO NOTHING`).run(faceId, theirs, updatedAt)
  }

  /** A question answered elsewhere stops being asked here. Only the state travels; where the face went is the face's own record. */
  applyReview(faceId, personId, state, updatedAt) {
    if (!['resolved', 'skipped'].includes(state)) return
    if (!this.db.prepare('SELECT 1 FROM faces WHERE id = ?').get(faceId)) return
    if (!this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) return
    const mine = this.db.prepare('SELECT state, updated_at FROM face_reviews WHERE face_id = ? AND person_id = ?').get(faceId, personId)
    if (mine && mine.state !== 'pending' && mine.updated_at >= updatedAt) return
    this.db.prepare(`INSERT INTO face_reviews(face_id, person_id, state, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(face_id, person_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .run(faceId, personId, state, updatedAt)
  }

  /** People and their faces for the phone's GET /metadata?since= pull. */
  changedSince(since) {
    return {
      people: this.db.prepare('SELECT id AS uuid, name, updated_at AS updatedAt, cover_face_id AS cover FROM people WHERE deleted = 0 AND updated_at > ?').all(since),
      // The whole face, not only who it belongs to: this computer finds faces the phone's detector misses, and a
      // face it has never seen is only usable there if the box, the embedding and the model travel with it. The
      // box is already in the protocol's own units — fractions of the upright photo — so it needs no translating.
      reviews: this.reviewsSince(since),
      faces: this.db.prepare(`SELECT id AS uuid, sha256, person_id AS person, updated_at AS updatedAt,
        box_left, box_top, box_right, box_bottom, embedding, model, quality
        FROM faces WHERE deleted = 0 AND updated_at > ?`).all(since).map(f => ({
        uuid: f.uuid, sha256: f.sha256, person: f.person, updatedAt: f.updatedAt, model: f.model, quality: f.quality,
        box: [f.box_left, f.box_top, f.box_right, f.box_bottom],
        embedding: Buffer.from(f.embedding).toString('base64'),
      })),
    }
  }

  /**
   * Every group combined into this person, newest first, still showing the head and the name it had at the time
   * — usually a bare "Person 41". A combine that was wrong can be taken back long after the moment it was made.
   */
  mergeHistory(targetId) {
    return this.db.prepare('SELECT id, source_id, source_name, face_ids, merged_at FROM people_merges WHERE target_id = ? ORDER BY merged_at DESC')
      .all(String(targetId)).map(row => {
        const ids = row.face_ids.split(',').filter(Boolean)
        const cover = ids.length ? this.db.prepare(`SELECT f.id FROM faces f JOIN media m ON m.sha256 = f.sha256
          WHERE f.id IN (${ids.map(() => '?').join(',')}) AND f.deleted = 0 ORDER BY f.quality DESC LIMIT 1`).get(...ids) : null
        return { id: row.id, sourceId: row.source_id, name: row.source_name, count: ids.length, mergedAt: row.merged_at, cover: cover?.id ?? null }
      })
  }

  restoreMerge(id) {
    const row = this.db.prepare('SELECT source_id, face_ids FROM people_merges WHERE id = ?').get(Number(id))
    if (!row) throw new Error('This combine has already been undone.')
    this.undoMerge({ sourceId: row.source_id, faceIds: row.face_ids.split(',').filter(Boolean) })
  }

  live(id) { if (!this.db.prepare('SELECT 1 FROM people WHERE id = ? AND deleted = 0').get(String(id))) throw new Error('This person no longer exists.') }

  rename(id, raw) {
    this.live(id)
    const name = require('./library').collectionName(raw) // phone: renameFaceGroup uses the collection-name rules
    this.db.prepare('UPDATE people SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
    return name
  }

  /** Phone: mergeFaceGroups — keep the open person, move the other's faces into it. Returns what undo needs. */
  merge(sourceId, targetId) {
    if (sourceId === targetId) throw new Error('Choose two different people.')
    this.live(sourceId); this.live(targetId)
    const now = Date.now()
    return this.tx(() => {
      const faceIds = this.db.prepare('SELECT id FROM faces WHERE person_id = ? AND deleted = 0').all(sourceId).map(r => r.id)
      this.db.prepare(`UPDATE face_reviews SET state = 'resolved', updated_at = ? WHERE face_id IN (SELECT id FROM faces WHERE person_id = ?)`).run(now, sourceId)
      this.db.prepare('UPDATE face_reviews SET person_id = ?, updated_at = ? WHERE person_id = ? AND NOT EXISTS (SELECT 1 FROM face_reviews r2 WHERE r2.face_id = face_reviews.face_id AND r2.person_id = ?)').run(targetId, now, sourceId, targetId)
      this.db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE person_id = ?').run(targetId, now, sourceId)
      const sourceName = this.db.prepare('SELECT name FROM people WHERE id = ?').get(sourceId)?.name ?? 'Person'
      this.db.prepare('UPDATE people SET deleted = 1, updated_at = ? WHERE id = ?').run(now, sourceId)
      // Kept, not just offered for as long as a toast lives: combining is the one action that throws a grouping
      // away, and the person it was wrong about cannot be reached afterwards unless we remember them.
      this.db.prepare('INSERT INTO people_merges(target_id, source_id, source_name, face_ids, merged_at) VALUES(?,?,?,?,?)')
        .run(targetId, sourceId, sourceName, faceIds.join(','), now)
      return { sourceId, faceIds }
    })
  }

  /**
   * Phone: detachPhotosFromGroup — take these photos' faces out of a person and give them a person of their own.
   * The classifier's own joins leave no history, so this is the only way out of one; the faces are not lost, they
   * stand as a new person that Combine can put back.
   */
  detach(personId, shas) {
    this.live(personId)
    const now = Date.now()
    return this.tx(() => {
      const marks = shas.map(() => '?').join(',')
      const ids = this.db.prepare(`SELECT id FROM faces WHERE person_id = ? AND deleted = 0 AND sha256 IN (${marks})`).all(personId, ...shas).map(r => r.id)
      if (!ids.length) throw new Error('Nothing to take out of this person.')
      const left = this.db.prepare(`SELECT COUNT(*) AS n FROM faces WHERE person_id = ? AND deleted = 0 AND id NOT IN (${ids.map(() => '?').join(',')})`).get(personId, ...ids).n
      if (!left) throw new Error('Taking every photo out would leave nobody here. Leave one behind, or combine this person into another.')
      const person = this.createPerson(now)
      this.db.prepare(`DELETE FROM face_reviews WHERE face_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
      const move = this.db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) move.run(person, now, id)
      return { person, faces: ids.length }
    })
  }

  /** Restores the same person id (not a copy), so sync sees one continuous identity. */
  undoMerge({ sourceId, faceIds }) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare('UPDATE people SET deleted = 0, updated_at = ? WHERE id = ?').run(now, sourceId)
      const move = this.db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?')
      for (const id of faceIds) move.run(sourceId, now, id)
      this.db.prepare('DELETE FROM people_merges WHERE source_id = ?').run(sourceId)
    })
  }

  nextReview() {
    return this.db.prepare(`SELECT r.face_id AS faceId, r.person_id AS personId, f.sha256, p.name,
        (SELECT f2.id FROM faces f2 WHERE f2.person_id = p.id AND f2.deleted = 0 AND f2.id != r.face_id ORDER BY f2.quality DESC LIMIT 1) AS personFace
      FROM face_reviews r JOIN faces f ON f.id = r.face_id AND f.deleted = 0 JOIN people p ON p.id = r.person_id AND p.deleted = 0
      JOIN media m ON m.sha256 = f.sha256 WHERE r.state = 'pending' LIMIT 1`).get() ?? null
  }

  reviewCount() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM face_reviews r JOIN faces f ON f.id = r.face_id AND f.deleted = 0 JOIN people p ON p.id = r.person_id AND p.deleted = 0 WHERE r.state = 'pending'`).get().n
  }

  /** Phone: resolveReview / skipReview. "Yes" moves the face into the candidate person. */
  answer(faceId, personId, answer) {
    const now = Date.now()
    this.tx(() => {
      if (answer === 'yes') this.db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?').run(personId, now, faceId)
      const state = answer === 'skip' ? 'skipped' : 'resolved'
      this.db.prepare(`UPDATE face_reviews SET state = ?, updated_at = ? WHERE face_id = ?${answer === 'skip' ? ' AND person_id = ?' : ''}`)
        .run(...(answer === 'skip' ? [state, now, faceId, personId] : [state, now, faceId]))
    })
  }
}

module.exports = { FaceEngine, People, ANALYSIS_VERSION, EMBEDDING_MODEL, SAME_DAY_BONUS, dayOf, iou, SAME_FACE_OVERLAP, faceQualityScore, isReliableFace, faceQuality, alignedInput, l2, cosine, decodeYunet, headAngles, isGeneratedName }
