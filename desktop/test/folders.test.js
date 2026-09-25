const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const { Folders, folderName } = require('../folders')

test('folders are named like the phone names them', () => {
  assert.equal(folderName('DCIM/Camera/a.jpg'), 'Camera')
  assert.equal(folderName('Pictures/Viber/a.jpg'), 'Viber')
  assert.equal(folderName('Movies/Viber/a.mp4'), 'Viber')
  assert.equal(folderName('Download/Mega/x/a.jpg'), 'Download')
  assert.equal(folderName('Holidays 2019/a.jpg'), 'Holidays 2019', 'any folder under the Photos root is photos')
  assert.equal(folderName('a.jpg'), null, 'loose in the root: always shown')
})

test('a folder is asked about, a yes shows it as a collection that keeps your removals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-folders-'))
  const db = library.open(tmp)
  const folders = new Folders(db)
  const add = (p, sha) => db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,1,1)`).run(p, sha)
  const [a, b, c] = ['a', 'b', 'c'].map(x => x.repeat(64))
  add('DCIM/Camera/1.jpg', a); add('Pictures/Viber/2.jpg', b)
  assert.deepEqual(folders.list().map(f => [f.name, f.included]), [['Viber', null]])
  assert.equal(folders.questions(), 1)
  assert.ok(folders.isShown('DCIM/Camera/1.jpg') && !folders.isShown('Pictures/Viber/2.jpg'))

  folders.set('Viber', true)
  assert.ok(folders.isShown('Pictures/Viber/2.jpg'))
  const viber = library.collections(db).find(x => x.name === 'Viber')
  assert.deepEqual(library.members(db, viber.id), [b])
  library.setMembership(db, viber.id, [b], false)
  add('Pictures/Viber/3.jpg', c)
  folders.fill()
  assert.deepEqual(library.members(db, viber.id), [c], 'the removal stays, the new photo joins')

  folders.set('viber', false)
  assert.ok(!folders.isShown('Pictures/Viber/2.jpg'), 'no hides it again, though the collection stays')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a collection that arrived from the phone answers its folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-folders-'))
  const db = library.open(tmp)
  const folders = new Folders(db)
  db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES('Pictures/Messenger/1.jpg', ?, 'image/jpeg',0,1,1,1)`).run('d'.repeat(64))
  library.applyCollection(db, 'phone-uuid', 'Messenger', false, 5)
  assert.equal(folders.questions(), 0)
  assert.ok(folders.isShown('Pictures/Messenger/1.jpg'))
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('taking a photo out of a folder album moves the file, never over another, and moves its membership', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-folders-move-'))
  const root = path.join(tmp, 'Photos')
  const db = library.open(path.join(tmp, 'data'))
  const folders = new Folders(db)
  const [a, b] = ['a', 'b'].map(x => x.repeat(64))
  for (const [p, sha] of [['DCIM/1.jpg', a], ['DCIM/Camera/1.jpg', b]]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.writeFileSync(path.join(root, p), sha)
    db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,1,1,1,1)`).run(p, sha)
  }
  folders.set('DCIM', true)
  const dcim = library.collections(db).find(x => x.name === 'DCIM')
  assert.deepEqual(library.members(db, dcim.id), [a])
  assert.ok(folders.places().some(p => p.path === 'DCIM/Camera'))

  const id = db.prepare('SELECT id FROM media WHERE sha256 = ?').get(a).id
  assert.deepEqual(folders.move(root, [id], 'DCIM/Camera'), { moved: 1, failed: [] })
  assert.equal(fs.readFileSync(path.join(root, 'DCIM', 'Camera', '1 (2).jpg'), 'utf8'), a, 'a taken name becomes (2)')
  assert.equal(fs.readFileSync(path.join(root, 'DCIM', 'Camera', '1.jpg'), 'utf8'), b, 'nothing overwritten')
  assert.ok(!fs.existsSync(path.join(root, 'DCIM', '1.jpg')))
  assert.equal(db.prepare('SELECT path FROM media WHERE id = ?').get(id).path, 'DCIM/Camera/1 (2).jpg')
  assert.deepEqual(library.members(db, dcim.id), [], 'out of the DCIM album')

  // Moved back, it joins the album again even though it had left it.
  folders.move(root, [id], 'DCIM')
  assert.deepEqual(library.members(db, dcim.id), [a])
  assert.throws(() => folders.move(root, [id], '../escape'), /not a folder/)
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('in a two-way chain a folder that is On anywhere is On here, whatever was answered here', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-folders-chain-'))
  const db = library.open(tmp)
  let chain = false
  const folders = new Folders(db, () => chain)
  db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES('Pictures/Viber/1.jpg',?,'image/jpeg',0,1,1,1,1)`).run('a'.repeat(64))
  folders.set('Viber', false)
  library.createCollection(db, 'Viber') // another device said yes, and its album arrived
  assert.ok(!folders.isShown('Pictures/Viber/1.jpg'), 'no device both ways: the No here stands')
  chain = true
  assert.ok(folders.isShown('Pictures/Viber/1.jpg'), 'both ways: On wins')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})
