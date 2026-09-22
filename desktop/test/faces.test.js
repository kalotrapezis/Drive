const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const F = require('../faces')

// Unit vectors with a chosen cosine to a base vector.
const base = F.l2(Float32Array.from({ length: 192 }, (_, i) => (i % 2 ? 1 : 0)))
const other = F.l2(Float32Array.from({ length: 192 }, (_, i) => (i % 2 ? 0 : 1)))
const third = F.l2(Float32Array.from({ length: 192 }, (_, i) => (i % 2 ? (i % 4 === 1 ? 1 : -1) : 0))) // orthogonal to base and other
const withCosine = (c, away = other) => F.l2(Float32Array.from(base, (v, i) => c * v + Math.sqrt(1 - c * c) * away[i]))
const face = (embedding, quality = 0.9) => ({ embedding, quality, yaw: 0, roll: 0, box: { left: 10, top: 10, right: 60, bottom: 60 } })
const size = { width: 100, height: 100 }

test('phone scoring rules', () => {
  assert.equal(F.faceQualityScore(112, 18), 1)
  assert.ok(Math.abs(F.faceQualityScore(56, 9) - 0.5) < 1e-9)
  assert.ok(F.isReliableFace(0.68, 30, 20) && !F.isReliableFace(0.67) && !F.isReliableFace(0.9, 31) && !F.isReliableFace(0.9, 0, 21))
  assert.ok(Math.abs(F.cosine(withCosine(0.8), base) - 0.8) < 1e-5)
  const { yaw, roll } = F.headAngles({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 })
  assert.equal(Math.round(yaw), 0); assert.equal(roll, 0)
})

test('alignment puts the eyes at (38,44) and (74,44)', () => {
  // A 200×200 image, dark except two bright squares where the eyes are; after alignment they land on the phone's targets.
  const img = { width: 200, height: 200, data: new Uint8Array(200 * 200 * 3) }
  for (const [ex, ey] of [[60, 80], [132, 80]]) for (let y = ey - 3; y <= ey + 3; y++) for (let x = ex - 3; x <= ex + 3; x++) for (let c = 0; c < 3; c++) img.data[(y * 200 + x) * 3 + c] = 255
  const out = F.alignedInput(img, { x: 60.5, y: 80.5 }, { x: 132.5, y: 80.5 }) // pixel centres
  const at = (x, y) => out[(y * 112 + x) * 3]
  assert.ok(at(38, 44) > 0.9 && at(74, 44) > 0.9, 'eye pixels are bright')
  assert.equal(at(56, 44), -1) // between the eyes stays dark
})

test('grouping follows the phone: join ≥ 0.74, new person below, review 0.66–0.74, merge and undo keep ids', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2, 3, 4]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)

  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(withCosine(0.80))], size) // same person
  people.record(sha(3), [face(withCosine(0.70, third))], size) // new person + review against the first
  people.record(sha(4), [face(other)], size) // clearly someone else
  let list = people.list()
  assert.deepEqual(list.map(p => [p.name, p.count]), [['Person 1', 2], ['Person 2', 1], ['Person 3', 1]])
  const [p1, p2] = list
  const review = people.nextReview()
  assert.equal(review.personId, p1.id)
  assert.equal(people.reviewCount(), 1)

  people.rename(p1.id, 'Μαρία')
  assert.throws(() => people.rename(p2.id, ''), /empty/)
  assert.deepEqual(people.namesBySha()[sha(2)], ['Μαρία'])
  assert.equal(people.list()[0].name, 'Μαρία') // named people first

  const undo = people.merge(p2.id, p1.id)
  assert.deepEqual(people.shas(p1.id).sort(), [sha(1), sha(2), sha(3)])
  assert.equal(people.reviewCount(), 0) // the reviewed face now belongs to the candidate
  people.undoMerge(undo)
  assert.deepEqual(people.shas(p2.id), [sha(3)]) // same id comes back

  people.answer(review.faceId, review.personId, 'yes')
  assert.deepEqual(people.shas(p1.id).sort(), [sha(1), sha(2), sha(3)])
  assert.equal(people.nextReview(), null)
  assert.equal(people.pending().length, 0)
  assert.deepEqual(people.record(sha(1), [face(other)], size), []) // re-analysis never duplicates faces
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faces WHERE sha256 = ?').get(sha(1)).n, 1)
  fs.rmSync(tmp, { recursive: true })
})
