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
    .withMetadata({ orientation: 6, exif: { IFD2: { DateTimeOriginal: '2024:05:06 07:08:09' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 38/1 2424/100', GPSLongitudeRef: 'E', GPSLongitude: '22/1 56/1 4000/100' } } }).toFile(photo)
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
  assert.deepEqual([row.latitude.toFixed(4), row.longitude.toFixed(4)], ['40.6401', '22.9444'])
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

test('offline place names', () => {
  const places = require('../places')
  assert.equal(places.nearest(40.6401, 22.9444).name, 'Thessaloníki')
  assert.match(places.nearest(40.6401, 22.9444).names, /Θεσσαλονίκη/)
  assert.equal(places.nearest(40.5830, 22.9510).name, 'Kalamariá')
  assert.equal(places.nearest(0, -30), null) // mid-Atlantic
})

test('a date in the name beats a copy date; an EXIF date is never replaced', () => {
  const { dateFromName, repairDatesFromNames } = library
  const local = (...a) => new Date(...a).getTime()
  assert.equal(dateFromName('Camera/20240325_104816.mp4'), local(2024, 2, 25, 10, 48, 16))
  assert.equal(dateFromName('IMG-20240305-WA0001.jpg'), local(2024, 2, 5, 12))
  assert.equal(dateFromName('Screenshot_2024-03-05-12-08-58.png'), local(2024, 2, 5, 12, 8, 58))
  assert.equal(dateFromName('PXL_20240305_120858123.jpg'), local(2024, 2, 5, 12, 8, 58))
  assert.equal(dateFromName('holiday.jpg'), null)
  assert.equal(dateFromName('IMG_99991231_000000.jpg'), null, 'not a plausible date')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dates-'))
  try {
    const db = library.open(tmp)
    const copied = local(2026, 7, 21, 15, 38)
    const add = (p, taken, mtime) => db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb, meta_v) VALUES(?,?,'video/mp4',1,1,?,?,1,99)`).run(p, p, mtime, taken)
    add('a/20240325_104816.mp4', copied, copied) // the copy's date: fixed
    add('a/20240320_112124.heic', local(2024, 2, 20, 9, 21), copied) // EXIF: kept
    add('a/20240401_101010.mp4', local(2024, 3, 1, 10, 10, 10), local(2024, 3, 1, 10, 10, 10)) // already right
    assert.equal(repairDatesFromNames(db), 1)
    assert.equal(db.prepare('SELECT taken_at FROM media WHERE path = ?').get('a/20240325_104816.mp4').taken_at, local(2024, 2, 25, 10, 48, 16))
    assert.equal(db.prepare('SELECT taken_at FROM media WHERE path = ?').get('a/20240320_112124.heic').taken_at, local(2024, 2, 20, 9, 21))
    db.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
