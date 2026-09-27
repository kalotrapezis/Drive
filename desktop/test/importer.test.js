'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const { importPhotos, importFiles } = require('../importer')

// Stands in for the real scan: every photo file under the Photos folder gets its row.
function fakeScan(db, root) {
  return async () => {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
    for (const f of walk(root)) {
      const rel = path.relative(root, f)
      if (db.prepare('SELECT 1 FROM media WHERE path = ?').get(rel)) continue
      db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb, meta_v) VALUES(?,?,'image/jpeg',0,?,1,1,1,99)`)
        .run(rel, await library.sha256(f), fs.statSync(f).size)
    }
  }
}

test('import photos: new ones copied under Imported, ones the library has skipped; straight to a drive leaves none here', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'))
  try {
    const card = path.join(tmp, 'Card'); fs.mkdirSync(path.join(card, 'DCIM'), { recursive: true })
    fs.writeFileSync(path.join(card, 'DCIM', 'a.jpg'), 'photo a'); fs.writeFileSync(path.join(card, 'DCIM', 'b.jpg'), 'photo b')
    fs.writeFileSync(path.join(card, 'DCIM', 'copy of a.jpg'), 'photo a'); fs.writeFileSync(path.join(card, 'notes.txt'), 'not a photo')
    const photos = path.join(tmp, 'Photos'); fs.mkdirSync(photos)
    const db = library.open(path.join(tmp, 'data'))
    const r = await importPhotos({ db, photosRoot: photos, sources: [card], scan: fakeScan(db, photos) })
    assert.deepEqual({ ...r, failed: r.failed.length }, { imported: 2, skipped: 1, failed: 0, total: 3 })
    assert.equal(fs.readFileSync(path.join(photos, 'Imported', 'Card', 'DCIM', 'b.jpg'), 'utf8'), 'photo b')

    const mount = path.join(tmp, 'T7'); fs.mkdirSync(mount)
    const card2 = path.join(tmp, 'Old'); fs.mkdirSync(card2); fs.writeFileSync(path.join(card2, 'c.jpg'), 'photo c'); fs.writeFileSync(path.join(card2, 'd.jpg'), 'photo d')
    const r2 = await importPhotos({ db, photosRoot: photos, sources: [card2], drive: { id: 'T7', name: 'T7', mount }, scan: fakeScan(db, photos), batchBytes: 1 })
    assert.equal(r2.imported, 2)
    assert.ok(!fs.existsSync(path.join(photos, 'Imported', 'Old', 'c.jpg')), 'not kept here')
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', 'Photos', 'Imported', 'Old', 'c.jpg'), 'utf8'), 'photo c')
    assert.deepEqual(db.prepare("SELECT location FROM media WHERE path LIKE 'Imported/Old/%'").all().map(x => x.location), ['T7', 'T7'])
    const files = path.join(tmp, 'Files')
    assert.equal((await importFiles({ db, root: files, sources: [card] })).imported, 4)
    assert.ok(fs.existsSync(path.join(files, 'Imported', 'Card', 'notes.txt')))
    db.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('import with Move: originals go once their copies read back, the library\'s own too, and emptied folders', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-move-'))
  try {
    const card = path.join(tmp, 'Card'); fs.mkdirSync(path.join(card, 'DCIM'), { recursive: true })
    fs.writeFileSync(path.join(card, 'DCIM', 'a.jpg'), 'photo a'); fs.writeFileSync(path.join(card, 'DCIM', 'dup.jpg'), 'photo a')
    fs.writeFileSync(path.join(card, 'keep.txt'), 'not a photo, not moved')
    const photos = path.join(tmp, 'Photos'); fs.mkdirSync(photos)
    const mount = path.join(tmp, 'T7'); fs.mkdirSync(mount)
    const db = library.open(path.join(tmp, 'data'))
    const r = await importPhotos({ db, photosRoot: photos, sources: [card], drive: { id: 'T7', name: 'T7', mount }, move: true, scan: fakeScan(db, photos) })
    assert.deepEqual({ imported: r.imported, skipped: r.skipped, failed: r.failed.length }, { imported: 1, skipped: 1, failed: 0 })
    assert.ok(!fs.existsSync(path.join(card, 'DCIM')), 'both photos gone from the card, and the emptied folder')
    assert.ok(fs.existsSync(path.join(card, 'keep.txt')), 'what was not imported stays, and so does its folder')
    assert.ok(fs.existsSync(path.join(mount, 'Tetra', 'Photos', 'Imported', 'Card', 'DCIM', 'a.jpg')))
    db.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('import stops when asked, keeping what came in whole', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-stop-'))
  try {
    const card = path.join(tmp, 'Card'); fs.mkdirSync(card)
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(card, n + '.jpg'), 'photo ' + n)
    const photos = path.join(tmp, 'Photos'); fs.mkdirSync(photos)
    const db = library.open(path.join(tmp, 'data'))
    const stop = { cancelled: false }
    const r = await importPhotos({ db, photosRoot: photos, sources: [card], stop, scan: fakeScan(db, photos), onProgress: p => { if (p.imported === 1) stop.cancelled = true } })
    assert.equal(r.stopped, true)
    assert.equal(r.imported, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM media').get().n, 1, 'what came in was scanned')
    assert.deepEqual(fs.readdirSync(path.join(photos, 'Imported', 'Card')).filter(f => f.endsWith('.part')), [])
    db.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('import: a Google Takeout sidecar dates a photo that has no date of its own', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-sidecar-'))
  try {
    const card = path.join(tmp, 'Takeout'); fs.mkdirSync(card)
    fs.writeFileSync(path.join(card, 'Final.png'), 'no date inside')
    fs.writeFileSync(path.join(card, 'Final.png.json'), JSON.stringify({ photoTakenTime: { timestamp: '1700000000' } }))
    const photos = path.join(tmp, 'Photos'); fs.mkdirSync(photos)
    const db = library.open(path.join(tmp, 'data'))
    // The stand-in scan dates everything by the file, as the real one does for a PNG with no date.
    const scan = async () => { await fakeScan(db, photos)(); db.exec('UPDATE media SET taken_at = mtime') }
    await importPhotos({ db, photosRoot: photos, sources: [card], scan })
    assert.equal(db.prepare("SELECT taken_at FROM media WHERE path LIKE '%Final.png'").get().taken_at, 1700000000000)
    db.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('Remove on import leaves out the video half of a motion photo; Show as one brings it in', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-motion-'))
  try {
    const card = path.join(tmp, 'Card'); fs.mkdirSync(card)
    fs.writeFileSync(path.join(card, 'MVIMG_20191204_100537.jpg'), 'the picture')
    fs.writeFileSync(path.join(card, 'MVIMG_20191204_100537.MP4'), 'its seconds of video')
    fs.writeFileSync(path.join(card, '20230529_201908(2).MP4'), 'another motion part')
    fs.writeFileSync(path.join(card, '20230529_201908.heic'), 'its picture')
    fs.writeFileSync(path.join(card, 'holiday.mp4'), 'a real video')
    const photos = path.join(tmp, 'Photos'); fs.mkdirSync(photos)
    const db = library.open(path.join(tmp, 'data'))
    const r = await importPhotos({ db, photosRoot: photos, sources: [card], dropMotion: true, scan: fakeScan(db, photos) })
    assert.equal(r.imported, 3)
    assert.deepEqual(fs.readdirSync(path.join(photos, 'Imported', 'Card')).sort(), ['20230529_201908.heic', 'MVIMG_20191204_100537.jpg', 'holiday.mp4'])
    db.close()
    const photos2 = path.join(tmp, 'Photos2'); fs.mkdirSync(photos2)
    const db2 = library.open(path.join(tmp, 'data2'))
    assert.equal((await importPhotos({ db: db2, photosRoot: photos2, sources: [card], scan: fakeScan(db2, photos2) })).imported, 5)
    db2.close()
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
