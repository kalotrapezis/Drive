const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')

test('scan indexes photos, is incremental, follows deletions and never touches the library', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-lib-'))
  const root = path.join(tmp, 'Photos'), data = path.join(tmp, 'data')
  fs.mkdirSync(path.join(root, 'Camera'), { recursive: true })
  const sharp = require('sharp')
  const photo = path.join(root, 'Camera', 'a.jpg')
  await sharp({ create: { width: 64, height: 32, channels: 3, background: '#808080' } }).jpeg()
    .withMetadata({ orientation: 6, exif: { IFD2: { DateTimeOriginal: '2024:05:06 07:08:09' } } }).toFile(photo)
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not media')
  fs.writeFileSync(path.join(root, '.hidden.jpg'), 'skip me')
  const before = fs.readFileSync(photo)

  const db = library.open(data)
  assert.deepEqual(await library.scan(db, root, data), { total: 1, changed: 1, removed: 0 })
  const [row] = library.list(db)
  assert.equal(row.path, path.join('Camera', 'a.jpg'))
  assert.equal(row.sha256, await library.sha256(photo))
  assert.equal(row.taken_at, new Date(2024, 4, 6, 7, 8, 9).getTime())
  assert.deepEqual([row.width, row.height], [32, 64]) // orientation 6 = rotated
  assert.ok(fs.existsSync(path.join(data, 'thumbs', row.sha256 + '.webp')))

  assert.deepEqual(await library.scan(db, root, data), { total: 1, changed: 0, removed: 0 })
  assert.deepEqual(fs.readFileSync(photo), before)
  assert.deepEqual(fs.readdirSync(root).sort(), ['.hidden.jpg', 'Camera', 'notes.txt'])

  fs.rmSync(photo)
  assert.deepEqual(await library.scan(db, root, data), { total: 0, changed: 0, removed: 1 })
  fs.rmSync(tmp, { recursive: true })
})

test('favorites and collections are keyed by hash, use tombstones, and survive a file leaving', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-meta-'))
  const root = path.join(tmp, 'Photos'), data = path.join(tmp, 'data')
  fs.mkdirSync(root)
  const sharp = require('sharp')
  for (const n of ['a', 'b']) await sharp({ create: { width: 8, height: 8, channels: 3, background: n === 'a' ? '#f00' : '#00f' } }).png().toFile(path.join(root, n + '.png'))
  const db = library.open(data)
  await library.scan(db, root, data)
  const [a, b] = library.list(db).sort((x, y) => x.path.localeCompare(y.path))

  library.setFavorite(db, [a.sha256], true)
  assert.equal(library.list(db).find(m => m.id === a.id).favorite, 1)
  assert.throws(() => library.setFavorite(db, ['../etc/passwd'], true), /Invalid/)

  assert.throws(() => library.createCollection(db, '   '), /empty/)
  assert.throws(() => library.createCollection(db, 'x'.repeat(61)), /60/)
  assert.throws(() => library.createCollection(db, 'a\nb'), /unsupported/)
  const trip = library.createCollection(db, ' Trip ')
  assert.equal(trip.name, 'Trip')
  assert.throws(() => library.createCollection(db, 'trip'), /already exists/)

  library.setMembership(db, trip.id, [a.sha256, b.sha256], true)
  library.setMembership(db, trip.id, [b.sha256], false)
  assert.deepEqual(library.members(db, trip.id), [a.sha256])
  assert.equal(db.prepare('SELECT deleted FROM collection_items WHERE sha256 = ?').get(b.sha256).deleted, 1) // tombstone, not removed
  assert.deepEqual(library.collections(db).map(c => [c.name, c.count, c.cover]), [['Trip', 1, a.sha256]])

  // Trash: file goes to the (fake) trash, row leaves, metadata stays for a restore.
  const trashed = []
  assert.deepEqual(await library.trash(db, root, [a.id, 9999], async f => { trashed.push(f); fs.renameSync(f, path.join(tmp, 'restored.png')) }), { trashed: 1, failed: ['9999'] })
  assert.deepEqual(trashed, [path.join(root, 'a.png')])
  assert.equal(library.collections(db)[0].count, 0)
  fs.renameSync(path.join(tmp, 'restored.png'), path.join(root, 'a.png'))
  await library.scan(db, root, data)
  assert.equal(library.list(db).find(m => m.path === 'a.png').favorite, 1)
  assert.equal(library.collections(db)[0].count, 1)

  library.deleteCollection(db, trip.id)
  assert.deepEqual(library.collections(db), [])
  assert.equal(library.list(db).length, 2) // photos stay
  assert.ok(library.createCollection(db, 'Trip')) // name is free again
  fs.rmSync(tmp, { recursive: true })
})
