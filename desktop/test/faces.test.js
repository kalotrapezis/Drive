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
const fourth = F.l2(Float32Array.from({ length: 192 }, (_, i) => (i % 2 ? 0 : (i % 4 === 0 ? 1 : -1)))) // orthogonal to all three
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

test('grouping follows the phone: join ≥ 0.75, new person below, review 0.45–0.75, merge and undo keep ids', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2, 3, 4]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)

  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(withCosine(0.80, third))], size) // same person
  people.record(sha(3), [face(withCosine(0.52, fourth))], size) // below the line: new person + review against the first
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

test('a person whose photos all left goes, the best face is the cover, and the phone\'s own people are left alone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-gone-'))
  const photos = path.join(tmp, 'Photos')
  fs.mkdirSync(photos)
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  // Two real files, so a scan can see them leave.
  const files = ['a.jpg', 'b.jpg'].map(n => path.join(photos, n))
  files.forEach((f, i) => fs.writeFileSync(f, Buffer.concat([Buffer.from('\xff\xd8\xff'), Buffer.alloc(64, i + 1)])))
  await library.scan(db, photos, tmp, () => {})
  const [first, second] = db.prepare('SELECT sha256 FROM media ORDER BY path').all().map(r => r.sha256)

  people.record(first, [face(base, 0.7)], size)
  people.record(second, [face(withCosine(0.9), 0.95)], size) // the same person, seen better
  const person = people.list()[0]
  assert.equal(person.count, 2)
  const best = db.prepare('SELECT id FROM faces WHERE quality = 0.95').get().id
  assert.equal(person.cover, best, 'the better face is the portrait, wherever it was found')

  // A face the phone sent for a photo this computer has not been given: it must survive a scan untouched.
  people.applyPerson('phone-person', 'Elsewhere', Date.now())
  people.applyFace({ uuid: 'phone-face', sha256: 'f'.repeat(64), box: [0.1, 0.1, 0.4, 0.4],
    embedding: Buffer.from(new Float32Array(other).buffer), model: F.EMBEDDING_MODEL, quality: 0.8,
    person: 'phone-person', updatedAt: Date.now() })

  // The first photo goes to the Trash, from where it can be put back: its person must survive, name and all.
  const trash = path.join(tmp, 'xdg', 'Trash')
  fs.mkdirSync(path.join(trash, 'files'), { recursive: true }); fs.mkdirSync(path.join(trash, 'info'), { recursive: true })
  fs.renameSync(files[0], path.join(trash, 'files', 'a.jpg'))
  fs.writeFileSync(path.join(trash, 'info', 'a.jpg.trashinfo'), `[Trash Info]\nPath=${files[0]}\nDeletionDate=2026-09-23T09:00:00\n`)
  fs.rmSync(files[1]) // the other one is deleted outright, so this person has nothing left on show
  const xdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(tmp, 'xdg')
  await library.scan(db, photos, tmp, () => {})
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE sha256 = ?').get(second).n, 0, 'the deleted photo took its face')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE sha256 = ?').get(first).n, 1, 'a photo in the Trash can come back, so its face waits')
  assert.equal(people.list().length, 0, 'but nobody is listed while no photo of them is here')
  assert.ok(db.prepare('SELECT 1 FROM people').get(), 'the name typed for them is not thrown away')

  fs.renameSync(path.join(trash, 'files', 'a.jpg'), files[0]) // put it back, as the Trash would
  await library.scan(db, photos, tmp, () => {})
  assert.equal(people.list()[0].count, 1, 'and they are whole again when it returns')

  fs.rmSync(files[0]) // emptied from the Trash for real
  fs.rmSync(path.join(trash, 'info', 'a.jpg.trashinfo'))
  await library.scan(db, photos, tmp, () => {})
  process.env.XDG_DATA_HOME = xdg
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE sha256 IN (?,?)').get(first, second).n, 0, 'their faces went with them')
  assert.equal(people.list().length, 0, 'and the person nobody has a photo of is gone')
  assert.ok(db.prepare("SELECT 1 FROM faces WHERE id = 'phone-face'").get(), "the phone's face is not this computer's to delete")
  assert.ok(db.prepare("SELECT 1 FROM people WHERE id = 'phone-person'").get(), 'nor its person')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a device that re-analysed from scratch cannot un-name a person', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-name-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = 'a'.repeat(64)
  db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES('1.jpg',?,'image/jpeg',0,1,1,1,1)").run(sha)
  people.record(sha, [face(base)], size)
  const mine = people.list()[0]
  people.rename(mine.id, 'Γιάννης')

  // The other device sends the same face — same photo, same place — belonging to a group it just invented.
  people.applyPerson('fresh-person', 'Person 7', Date.now() + 1000)
  people.applyFace({ uuid: 'their-face', sha256: sha, box: [0.1, 0.1, 0.6, 0.6],
    embedding: Buffer.from(new Float32Array(base).buffer), model: F.EMBEDDING_MODEL, quality: 0.9,
    person: 'fresh-person', updatedAt: Date.now() + 1000 })
  assert.equal(people.list().find(p => p.id === mine.id)?.name, 'Γιάννης')
  assert.equal(people.list().find(p => p.id === mine.id)?.count, 1, 'the face stays with the person who has a name')

  // A name the user typed over there does not win either — it asks. Two devices that have both named this face
  // disagree about who it is, and neither is wrong: grouping is order-dependent, so two devices starting from
  // the same library reach different people. Letting the newer one win meant the face changed hands on every
  // sync, in whichever direction had synced last.
  people.applyPerson('named-elsewhere', 'Μαρία', Date.now() + 2000)
  people.applyFace({ uuid: 'their-face-2', sha256: sha, box: [0.1, 0.1, 0.6, 0.6],
    embedding: Buffer.from(new Float32Array(base).buffer), model: F.EMBEDDING_MODEL, quality: 0.9,
    person: 'named-elsewhere', updatedAt: Date.now() + 2000 })
  assert.equal(people.list().find(p => p.count > 0)?.name, 'Γιάννης', 'the face stays where it is')
  assert.equal(people.reviewCount(), 1, 'and the difference is asked about instead')
  assert.equal(people.nextReview()?.name, 'Μαρία')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('history keeps every combine, with the head and number it had, until it is put back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-history-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)
  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(other)], size) // someone else
  const [keep, gone] = people.list()
  people.rename(keep.id, 'Άννα')

  const undo = people.merge(gone.id, keep.id)
  const history = people.mergeHistory(keep.id)
  assert.equal(history.length, 1)
  assert.equal(history[0].name, gone.name, 'the number it had is what you will recognise it by')
  assert.equal(history[0].count, 1)
  assert.ok(history[0].cover, 'and a head to see')

  people.restoreMerge(history[0].id)
  assert.deepEqual(people.shas(gone.id), [sha(2)], 'the same person comes back, not a copy')
  assert.equal(people.mergeHistory(keep.id).length, 0, 'and stops being offered twice')
  assert.throws(() => people.restoreMerge(history[0].id), /already been undone/)
  assert.equal(undo.sourceId, gone.id)
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a face the classifier put in the wrong person can be taken back out', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-detach-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)
  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(withCosine(0.9))], size) // close enough that the classifier joined them on its own
  const [person] = people.list()
  assert.deepEqual(people.shas(person.id).sort(), [sha(1), sha(2)].sort(), 'one person, two photos')

  assert.throws(() => people.detach(person.id, [sha(1), sha(2)]), /leave nobody here/)
  const out = people.detach(person.id, [sha(2)])
  assert.equal(out.faces, 1)
  assert.deepEqual(people.shas(person.id), [sha(1)])
  assert.deepEqual(people.shas(out.person), [sha(2)], 'it stands as its own person, which Combine can put back')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a question answered on the phone stops being asked here — including "no", which moves nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-reviews-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)
  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(withCosine(0.52, third))], size) // uncertain: a question, not a join
  people.record(sha(3), [face(withCosine(0.50, fourth))], size) // a second one
  assert.equal(people.reviewCount(), 2)
  const first = people.nextReview()

  // The phone answered that one — "no", which changes nothing about where the face sits, so without this the
  // answer would leave no trace at all and this computer would ask again forever.
  assert.deepEqual(people.reviewsSince(0), [], 'nothing has been answered here yet')
  people.applyReview(first.faceId, first.personId, 'resolved', Date.now())
  assert.equal(people.reviewCount(), 1, 'it is not asked here any more')
  assert.notEqual(people.nextReview()?.faceId, first.faceId)

  // And what this computer answers is offered back, once, with the time it was answered.
  const second = people.nextReview()
  people.answer(second.faceId, second.personId, 'no')
  const out = people.reviewsSince(0)
  assert.deepEqual(out.map(r => [r.face, r.person, r.state]), [
    [first.faceId, first.personId, 'resolved'],
    [second.faceId, second.personId, 'resolved'],
  ])
  assert.deepEqual(people.reviewsSince(Date.now() + 1000), [], 'and not offered again after it has been sent')

  // An older answer never overrules a newer one, whichever device it comes from.
  people.applyReview(second.faceId, second.personId, 'skipped', 1)
  assert.equal(db.prepare('SELECT state FROM face_reviews WHERE face_id = ?').get(second.faceId).state, 'resolved')

  // A question about a face or a person this computer does not have is simply not a question here.
  people.applyReview('no-such-face', second.personId, 'resolved', Date.now())
  assert.equal(db.prepare('SELECT COUNT(*) n FROM face_reviews').get().n, 2)
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('two devices that disagree about who someone is ask, instead of taking turns overwriting', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-faces-disagree-'))
  const db = library.open(tmp)
  const people = new F.People(db, tmp)
  const sha = n => String(n).repeat(64).slice(0, 64)
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,?,1)").run(`${n}.jpg`, sha(n), n)
  people.record(sha(1), [face(base)], size)
  people.record(sha(2), [face(withCosine(0.80, third))], size) // the same person here
  const [anna] = people.list()
  people.rename(anna.id, 'Άννα')
  const faces = db.prepare('SELECT id FROM faces ORDER BY rowid').all().map(r => r.id)

  // The other device knows these faces as someone else it has also named.
  const maria = crypto.randomUUID()
  people.applyPerson(maria, 'Μαρία', Date.now())
  const later = Date.now() + 1000
  for (const id of faces) people.applyFace({ uuid: id, sha256: sha(1), person: maria, updatedAt: later })

  assert.deepEqual(people.shas(anna.id).sort(), [sha(1), sha(2)].sort(), 'nobody was torn apart')
  assert.deepEqual(people.shas(maria), [], 'and nobody was quietly taken over')
  assert.equal(people.reviewCount(), 1, 'one card for the pair, not one per face')
  const asked = people.nextReview()
  assert.equal(asked.personId, maria)

  // Answering it is what moves anything, and then it is not asked again.
  people.answer(asked.faceId, asked.personId, 'yes')
  assert.deepEqual(people.shas(maria), [sha(1)])
  assert.equal(people.reviewCount(), 0)

  // A guess still never wins against a name, and two guesses still settle by who wrote last.
  const guess = crypto.randomUUID()
  people.applyPerson(guess, 'Person 9', Date.now())
  people.applyFace({ uuid: faces[1], sha256: sha(2), person: guess, updatedAt: Date.now() + 5000 })
  assert.deepEqual(people.shas(anna.id), [sha(2)], 'Άννα keeps the face a number tried to take')
  assert.equal(people.reviewCount(), 0, 'and that is not a question, it is a rule')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})
