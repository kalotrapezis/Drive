// Documents: the phone asks ML Kit for a "paper" label, then counts OCR characters and text blocks.
// Here a text-detection model (PaddleOCR v4 det) finds text lines; each line's width ÷ height estimates
// its characters, and the phone's own thresholds turn that into a document confidence.
const fs = require('node:fs')
const path = require('node:path')

const SIDE = 960 // long side fed to the detector (multiple of 32)
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]
const TEXT_PROB = 0.3, MIN_LINE_AREA = 24
// Share of the photo's area covered by text lines (replaces the phone's "paper" gate). Calibrated 2026-09-22 against
// the phone's own decisions: its 18 documents 0.033–0.227, 57 of 60 non-documents ≤ 0.029 (watermarks, signs, shirts).
// At 0.03: 17/18 documents found (the miss: tiny passport-style text), 1/60 false alarm (a handwritten notebook page).
const MIN_COVERAGE = 0.03

/** Phone: PhotoClassifier.documentConfidence thresholds, fed with estimated characters and text lines. */
function documentConfidence(chars, lines, coverage = 1) {
  // Without the phone's "paper" gate: a little text in a photo (watermark, sign, caption) is not a document.
  if (coverage < MIN_COVERAGE) return 0
  if (chars >= 180 && lines >= 3) return 0.95
  if (chars >= 80 && lines >= 2) return 0.70
  if (chars >= 35) return 0.45
  return 0
}

/** Connected text regions in a probability map → estimated characters and number of lines. */
function measureText(prob, width, height) {
  const seen = new Uint8Array(width * height)
  let chars = 0, lines = 0, covered = 0
  const stack = []
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start] < TEXT_PROB) continue
    let minX = width, maxX = 0, minY = height, maxY = 0, area = 0
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const i = stack.pop(), x = i % width, y = (i - x) / width
      area++
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= prob.length || seen[j] || prob[j] < TEXT_PROB) continue
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1)) continue
        seen[j] = 1; stack.push(j)
      }
    }
    if (area < MIN_LINE_AREA) continue
    const w = maxX - minX + 1, h = maxY - minY + 1
    // ponytail: one region ≈ one text line; characters ≈ width / line height. Coarse, but it is what the thresholds need.
    lines++
    chars += Math.max(1, Math.round(w / Math.max(4, h)))
    covered += w * h
  }
  return { chars, lines, coverage: covered / (width * height) }
}

/** Phone: likelyTimeOfDay — capture hour first, then brightness. */
function likelyTimeOfDay(takenAt, luminance) {
  const hour = takenAt > 0 ? new Date(takenAt).getHours() : null
  if (hour !== null && (hour >= 20 || hour <= 5)) return 'Likely night'
  if (luminance < 28) return 'Likely night'
  if (hour !== null && hour >= 7 && hour <= 18 && luminance >= 60) return 'Likely day'
  return null
}

/** Phone: Bitmap.averageLuminance, sampled on a grid. */
function averageLuminance(img) {
  const step = Math.max(1, Math.trunc(Math.min(img.width, img.height) / 48))
  let total = 0, count = 0
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 3
    total += img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114; count++
  }
  return Math.trunc(total / (Math.max(1, count) * 1000))
}

/** The phone's advanced scene tags: EfficientNet-Lite0 (ImageNet), top 5 with score ≥ 0.15, as "Scene: label". */
class SceneEngine {
  static async load(modelDir) {
    const ort = require('onnxruntime-node')
    const e = new SceneEngine()
    e.ort = ort
    e.session = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, 'scene_efficientnet_lite0.onnx')))
    e.labels = fs.readFileSync(path.join(modelDir, 'scene_labels.txt'), 'utf8').split('\n').map(l => l.trim())
    return e
  }
  async classify(img) {
    const px = await require('sharp')(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(224, 224, { fit: 'fill' }).raw().toBuffer()
    const out = await this.session.run({ images: new this.ort.Tensor('uint8', new Uint8Array(px), [1, 224, 224, 3]) })
    const scores = out[this.session.outputNames[0]].data // uint8, TFLite output scale 1/256
    return [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 5).filter(k => scores[k] / 256 >= 0.15).map(k => `Scene: ${this.labels[k]}`)
  }
}

class DocEngine {
  static async load(modelDir) {
    const ort = require('onnxruntime-node')
    const e = new DocEngine()
    e.ort = ort
    e.session = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, 'text_detection_ppocrv4.onnx')))
    return e
  }

  /** img: upright RGB { data, width, height } (the same decode People uses). */
  async classify(img) {
    const sharp = require('sharp')
    const k = SIDE / Math.max(img.width, img.height)
    const w = Math.max(32, Math.round(img.width * k / 32) * 32), h = Math.max(32, Math.round(img.height * k / 32) * 32)
    const px = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h, { fit: 'fill' }).raw().toBuffer()
    const input = new Float32Array(3 * w * h), plane = w * h
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
      const v = px[i * 3 + (2 - c)] / 255 // BGR, as PaddleOCR's OpenCV pipeline feeds it
      input[c * plane + i] = (v - MEAN[c]) / STD[c]
    }
    const out = await this.session.run({ x: new this.ort.Tensor('float32', input, [1, 3, h, w]) })
    const { chars, lines, coverage } = measureText(out[this.session.outputNames[0]].data, w, h)
    return { chars, lines, coverage: +coverage.toFixed(3), confidence: documentConfidence(chars, lines, coverage) }
  }
}

const VERSION = 'ppocrv4-det+coverage0.03+effnetlite0'

/** Phone: PhotoMetadataStore.recordClassification / nextReview / resolveReview for documents. */
class Documents {
  constructor(db) { this.db = db }

  /** A 'phone' row is authoritative (synced, SYNC_PLAN.md phase 6a) and is never re-guessed here. */
  pending() {
    return this.db.prepare(`SELECT m.sha256, MIN(m.path) AS path FROM media m LEFT JOIN photo_ai a ON a.sha256 = m.sha256
      WHERE m.is_video = 0 AND COALESCE(a.source, 'desktop') != 'phone' AND (a.version IS NULL OR a.version != ?)
      GROUP BY m.sha256 ORDER BY MAX(m.taken_at) DESC`).all(VERSION)
  }

  record(sha, confidence, labels = null) {
    if (labels) {
      this.db.prepare('DELETE FROM photo_labels WHERE sha256 = ?').run(sha)
      const add = this.db.prepare('INSERT OR IGNORE INTO photo_labels(sha256, label) VALUES(?,?)')
      for (const l of labels) add.run(sha, l)
    }
    const verified = this.db.prepare('SELECT type FROM photo_ai WHERE sha256 = ? AND user_verified = 1').get(sha)
    const type = verified ? verified.type : confidence >= 0.70 ? 'document' : null
    const review = !verified && confidence >= 0.40 && confidence < 0.70 ? 'pending' : 'none'
    this.db.prepare(`INSERT INTO photo_ai(sha256, type, confidence, user_verified, review_state, version, source, updated_at) VALUES(?,?,?,?,?,?,'desktop',?)
      ON CONFLICT(sha256) DO UPDATE SET type = excluded.type, confidence = excluded.confidence, review_state = excluded.review_state,
      version = excluded.version, source = 'desktop', updated_at = excluded.updated_at`).run(sha, type, confidence, verified ? 1 : 0, review, VERSION, Date.now())
  }

  /** From the phone's POST /metadata: last-write-wins by updated_at, tagged source='phone'. */
  applyFromPhone(sha, type, confidence, userVerified, updatedAt) {
    const local = this.db.prepare('SELECT updated_at FROM photo_ai WHERE sha256 = ?').get(sha)
    if (local && local.updated_at >= updatedAt) return
    this.db.prepare(`INSERT INTO photo_ai(sha256, type, confidence, user_verified, review_state, version, source, updated_at) VALUES(?,?,?,?,'none',NULL,'phone',?)
      ON CONFLICT(sha256) DO UPDATE SET type = excluded.type, confidence = excluded.confidence, user_verified = excluded.user_verified,
      review_state = 'none', version = NULL, source = 'phone', updated_at = excluded.updated_at`)
      .run(sha, type, confidence ?? 0, userVerified ? 1 : 0, updatedAt)
  }

  /** For the phone's GET /metadata?since= pull. */
  changedSince(since) {
    return this.db.prepare('SELECT sha256, type, confidence, user_verified AS userVerified, updated_at AS updatedAt FROM photo_ai WHERE updated_at > ?').all(since)
  }

  nextReview() {
    return this.db.prepare(`SELECT a.sha256 FROM photo_ai a JOIN media m ON m.sha256 = a.sha256 WHERE a.review_state = 'pending' LIMIT 1`).get() ?? null
  }

  reviewCount() {
    return this.db.prepare(`SELECT COUNT(DISTINCT a.sha256) n FROM photo_ai a JOIN media m ON m.sha256 = a.sha256 WHERE a.review_state = 'pending'`).get().n
  }

  answer(sha, answer) {
    if (answer === 'skip') this.db.prepare(`UPDATE photo_ai SET review_state = 'none', updated_at = ? WHERE sha256 = ?`).run(Date.now(), sha)
    else this.db.prepare(`UPDATE photo_ai SET type = ?, user_verified = 1, review_state = 'none', updated_at = ? WHERE sha256 = ?`)
      .run(answer === 'yes' ? 'document' : null, Date.now(), sha)
  }

  /** The viewer's "Not a document" / "Mark as document": a user decision, kept across re-analysis. */
  set(sha, isDocument) {
    this.db.prepare(`INSERT INTO photo_ai(sha256, type, user_verified, review_state, updated_at) VALUES(?,?,1,'none',?)
      ON CONFLICT(sha256) DO UPDATE SET type = excluded.type, user_verified = 1, review_state = 'none', updated_at = excluded.updated_at`)
      .run(sha, isDocument ? 'document' : null, Date.now())
  }
}

module.exports = { DocEngine, SceneEngine, Documents, documentConfidence, measureText, likelyTimeOfDay, averageLuminance, VERSION }
