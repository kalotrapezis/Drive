const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const { Documents, documentConfidence, measureText } = require('../documents')

test('phone thresholds, with the coverage gate replacing the paper label', () => {
  assert.equal(documentConfidence(180, 3, 0.2), 0.95)
  assert.equal(documentConfidence(80, 2, 0.2), 0.70)
  assert.equal(documentConfidence(35, 1, 0.2), 0.45)
  assert.equal(documentConfidence(34, 9, 0.2), 0)
  assert.equal(documentConfidence(500, 9, 0.029), 0) // a watermark strip is not a document
})

test('text lines are measured from the probability map', () => {
  const w = 40, h = 20, p = new Float32Array(w * h)
  for (let x = 2; x < 32; x++) for (let y = 2; y < 5; y++) p[y * w + x] = 0.9 // one line: 30×3 → 10 characters
  for (let x = 2; x < 12; x++) for (let y = 10; y < 12; y++) p[y * w + x] = 0.9 // another: 10×2, below the area floor? 20 px → dropped
  p[18 * w + 38] = 0.9 // noise
  const r = measureText(p, w, h)
  assert.deepEqual([r.lines, r.chars], [1, 8]) // 30 / max(4, 3) = 7.5 → 8
})

test('user answers win over re-analysis; reviews come and go', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-docs-'))
  const db = library.open(tmp)
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, String(n).repeat(64), n)
  const docs = new Documents(db)
  const [a, b, c] = ['1', '2', '3'].map(n => n.repeat(64))
  assert.equal(docs.pending().length, 3)
  docs.record(a, 0.95); docs.record(b, 0.45); docs.record(c, 0)
  assert.equal(docs.pending().length, 0)
  assert.deepEqual(library.list(db).filter(m => m.document).map(m => m.sha256), [a])
  assert.equal(docs.reviewCount(), 1)
  assert.equal(docs.nextReview().sha256, b)
  docs.answer(b, 'yes')
  assert.equal(docs.reviewCount(), 0)
  docs.set(a, false) // "Not a document"
  docs.record(a, 0.95); docs.record(b, 0) // re-analysis
  assert.deepEqual(library.list(db).filter(m => m.document).map(m => m.sha256), [b])
  fs.rmSync(tmp, { recursive: true })
})

test('time-of-day label follows the phone', () => {
  const { likelyTimeOfDay } = require('../documents')
  const at = h => new Date(2026, 0, 1, h).getTime()
  assert.equal(likelyTimeOfDay(at(22), 200), 'Likely night')
  assert.equal(likelyTimeOfDay(at(12), 20), 'Likely night')
  assert.equal(likelyTimeOfDay(at(12), 90), 'Likely day')
  assert.equal(likelyTimeOfDay(at(19), 90), null)
})
