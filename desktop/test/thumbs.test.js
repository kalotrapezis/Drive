const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Thumbs, kind, key, trim } = require('../thumbs')

test('a changed file is another thumbnail', () => {
  const k = key('/Tetra/a.docx', 100, 1000.4)
  assert.equal(k, key('/Tetra/a.docx', 100, 1000.9)) // the same millisecond
  assert.notEqual(k, key('/Tetra/a.docx', 101, 1000)) // edited: another size
  assert.notEqual(k, key('/Tetra/a.docx', 100, 2000)) // edited: another time
  assert.notEqual(k, key('/Tetra/b.docx', 100, 1000)) // renamed
})

test('kinds follow Office’s apps', () => {
  assert.equal(kind('Essay.DOCX'), 'words')
  assert.equal(kind('marks.ods'), 'tables')
  assert.equal(kind('talk.pptx'), 'slides')
  assert.equal(kind('IMG_1.heic'), 'picture')
  assert.equal(kind('clip.mp4'), 'video')
  assert.equal(kind('notes.txt'), null)
})

test('trim keeps the newest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-trim-'))
  for (let n = 1; n <= 5; n++) { const f = path.join(dir, `${n}.webp`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, n * 10, n * 10) }
  await trim(dir, 3)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['3.webp', '4.webp', '5.webp'])
})

test('a picture is made once, and again when it changes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'))
  const picture = path.join(tmp, 'p.png')
  await require('sharp')({ create: { width: 800, height: 600, channels: 3, background: '#3366cc' } }).png().toFile(picture)
  const thumbs = new Thumbs(path.join(tmp, 'data'))
  const first = await thumbs.get(picture)
  assert.ok(first && fs.existsSync(first))
  assert.deepEqual(await require('sharp')(first).metadata().then(m => [m.format, m.width, m.height]), ['webp', 384, 288])
  assert.equal(await thumbs.get(picture), first) // from the cache
  fs.utimesSync(picture, new Date(), new Date(Date.now() + 5000))
  assert.notEqual(await thumbs.get(picture), first)
  assert.equal(await thumbs.get(path.join(tmp, 'notes.txt')), null)
})

test('files find their category icon, and every icon is there', () => {
  const { kindIcon } = require('../files')
  assert.equal(kindIcon('/x/Essay.DOCX'), 'docs-word')
  assert.equal(kindIcon('backup.tar.gz'), 'archives')
  assert.equal(kindIcon('Tetra.AppImage'), 'programs-executables')
  assert.equal(kindIcon('paper.PDF'), 'pdf')
  assert.equal(kindIcon('photo.jpg'), null)
  for (const k of Object.values(require('../file-kinds.json').kinds)) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'kinds', k.icon.toLowerCase() + '.png')), k.icon)
})
