const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { Files } = require('../files')

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-files-'))
  const root = path.join(tmp, 'Drive')
  fs.mkdirSync(path.join(root, 'Docs', 'Inner'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Docs', 'a.txt'), 'alpha')
  fs.writeFileSync(path.join(root, 'Docs', 'Inner', 'b.md'), 'beta')
  fs.writeFileSync(path.join(root, 'Ελληνικά.pdf'), 'pdf')
  fs.writeFileSync(path.join(root, '.hidden'), 'x')
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside')
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'))
  return { tmp, root, files: new Files(new DatabaseSync(':memory:'), root) }
}

test('paths cannot leave Drive', async () => {
  const { tmp, files } = setup()
  for (const bad of ['../secret.txt', '/etc/passwd', 'Docs/../../secret.txt', 'Docs//a.txt', './Docs']) assert.throws(() => files.resolve(bad), /Invalid/)
  assert.throws(() => files.resolve('link.txt'), /outside Drive/) // symlink escaping the root
  assert.deepEqual((await files.list('')).map(i => i.name).sort(), ['Docs', 'Documents', 'Ελληνικά.pdf']) // links are not listed
  await assert.rejects(files.rename('Docs/a.txt', '../x.txt'), /Invalid name/)
  await assert.rejects(files.rename('Docs/a.txt', ' x.txt'), /Invalid name/)
  fs.rmSync(tmp, { recursive: true })
})

test('copy verifies and never overwrites; folders cannot go inside themselves', async () => {
  const { tmp, root, files } = setup()
  await assert.rejects(files.copy('Docs', ''), /already exists/)
  await assert.rejects(files.copy('Docs', 'Docs/Inner'), /inside itself/)
  await assert.rejects(files.move('Docs', 'Docs'), /inside itself/)
  assert.equal(await files.copy('Docs/a.txt', 'Docs/Inner'), 'Docs/Inner/a.txt')
  await assert.rejects(files.copy('Docs/a.txt', 'Docs/Inner'), /already exists/)
  assert.equal(fs.readFileSync(path.join(root, 'Docs/Inner/a.txt'), 'utf8'), 'alpha')
  fs.mkdirSync(path.join(root, 'Backup'))
  assert.equal(await files.copy('Docs', 'Backup'), 'Backup/Docs')
  assert.equal(fs.readFileSync(path.join(root, 'Backup/Docs/Inner/b.md'), 'utf8'), 'beta')
  await assert.rejects(files.rename('Docs/Inner/a.txt', 'b.md'), /already exists/)
  assert.equal(fs.readFileSync(path.join(root, 'Docs/Inner/b.md'), 'utf8'), 'beta') // untouched
  fs.rmSync(tmp, { recursive: true })
})

test('metadata follows rename, move and Trash; Empty Trash is the only delete', async () => {
  const { tmp, root, files } = setup()
  files.setFavorite('Docs', true)
  files.setColor('Docs', 'Blue')
  files.setTags('Docs/Inner/b.md', ['Work', 'Σχολείο'])
  assert.throws(() => files.setTags('Docs/a.txt', ['a,b']), /commas/)
  assert.throws(() => files.setTags('Docs/a.txt', ['x'.repeat(33)]), /1–32/)
  assert.throws(() => files.setColor('Docs/a.txt', 'Blue'), /Only folders/)
  files.recordOpen('Docs/Inner/b.md')

  assert.equal(await files.rename('Docs', 'Papers'), 'Papers')
  const [papers] = (await files.list('')).filter(i => i.name === 'Papers')
  assert.deepEqual([papers.favorite, papers.color], [true, 'Blue'])
  assert.deepEqual((await files.list('Papers/Inner'))[0].tags, ['Work', 'Σχολείο'])
  assert.deepEqual((await files.recents()).map(r => r.path), ['Papers/Inner/b.md'])
  assert.deepEqual((await files.search('σχολειο')).map(i => i.path), ['Papers/Inner/b.md']) // tag match, accents folded
  assert.deepEqual((await files.search('ελληνικα')).map(i => i.path), ['Ελληνικά.pdf'])
  assert.deepEqual((await files.withTag('work')).map(i => i.path), ['Papers/Inner/b.md'])

  assert.equal(await files.trash('Papers'), 'Trash/Papers')
  assert.deepEqual(await files.favorites(), []) // hidden while in Trash
  assert.ok(!(await files.all()).some(i => i.path.startsWith('Trash')))
  assert.ok(!(await files.destinations()).some(d => d.startsWith('Trash')))
  assert.equal(await files.move('Trash/Papers', ''), 'Papers') // restore = move back
  assert.equal((await files.favorites())[0].path, 'Papers')

  await files.trash('Ελληνικά.pdf')
  assert.equal(await files.emptyTrash(), 1)
  assert.ok(!fs.existsSync(path.join(root, 'Ελληνικά.pdf')) && fs.readdirSync(path.join(root, 'Trash')).length === 0)
  assert.ok(fs.existsSync(path.join(root, 'Papers/a.txt')))
  assert.deepEqual(await files.usage(), { Text: 9, Other: 1 }) // hidden files still use space
  fs.rmSync(tmp, { recursive: true })
})

test('the system folders are always there and stay put, while what is inside them moves', async () => {
  const { tmp, root, files } = setup()
  assert.ok(fs.statSync(path.join(root, 'Documents', 'Scanned Documents')).isDirectory())
  for (const rel of ['Documents', 'Documents/Scanned Documents']) {
    await assert.rejects(files.rename(rel, 'Other'), /system folder/)
    await assert.rejects(files.move(rel, 'Docs'), /system folder/)
    await assert.rejects(files.trash(rel), /system folder/)
  }
  fs.writeFileSync(path.join(root, 'Documents', 'Scanned Documents', 'scan.pdf'), 'x')
  await files.trash('Documents/Scanned Documents/scan.pdf')
  assert.ok(fs.existsSync(path.join(root, 'Trash', 'scan.pdf')))
  fs.rmSync(tmp, { recursive: true })
})

test('a chosen System folder is made and kept like Documents; left out, it goes, its contents out or to the Trash', async () => {
  const { tmp, root, files } = setup()
  assert.deepEqual(await files.chooseSystemFolders(['Music', 'AI', 'Work', 'Books', 'Nonsense']), ['Music', 'Work', 'AI', 'Books'])
  assert.ok(fs.statSync(path.join(root, 'AI')).isDirectory())
  assert.equal((await files.list('')).find(i => i.path === 'Music').system, true)
  await assert.rejects(files.trash('Music'), /system folder/)
  fs.writeFileSync(path.join(root, 'Music', 'song.mp3'), 'x')
  fs.mkdirSync(path.join(root, 'Music', 'Docs'))
  fs.writeFileSync(path.join(root, 'Work', 'plan.pdf'), 'x')
  await assert.rejects(files.chooseSystemFolders(['AI'], 'nowhere'), /contents/)
  // Out: what was inside is at the top, a name already there becoming "(2)"; the empty folder is gone.
  await files.chooseSystemFolders(['AI', 'Work', 'Books'], 'out')
  assert.ok(!fs.existsSync(path.join(root, 'Music')) && fs.existsSync(path.join(root, 'song.mp3')))
  assert.ok(fs.existsSync(path.join(root, 'Docs (2)')) && fs.existsSync(path.join(root, 'Docs', 'a.txt')))
  // Trash: the folder goes to the Trash whole; an empty one left out just goes.
  await files.chooseSystemFolders(['AI'], 'trash')
  assert.ok(fs.existsSync(path.join(root, 'Trash', 'Work', 'plan.pdf')) && !fs.existsSync(path.join(root, 'Books')))
  assert.ok(fs.existsSync(path.join(root, 'Documents')))
  // Another device's choices: the later one wins, a tie goes to chosen, an older one changes nothing; left out
  // over there, an empty folder goes here too.
  const at = files.systemFolderRecords().find(r => r.name === 'AI').updatedAt
  files.applySystemFolder({ name: 'AI', chosen: false, updatedAt: at - 1 })
  assert.ok(files.isSystem('AI'))
  files.applySystemFolder({ name: 'AI', chosen: false, updatedAt: at + 1 })
  assert.ok(!files.isSystem('AI') && !fs.existsSync(path.join(root, 'AI')))
  files.applySystemFolder({ name: 'Books', chosen: true, updatedAt: Date.now() + 1000 })
  assert.ok(files.isSystem('Books'))
  // Kept across restarts: a new Files on the same database knows the choice.
  assert.deepEqual(new Files(files.db, root).chosenFolders(), ['Books'])
  fs.rmSync(tmp, { recursive: true })
})

test('a name already in Trash never blocks a delete: the newcomer becomes "name (2)"', async () => {
  const { tmp, root, files } = setup()
  for (let i = 0; i < 2; i++) { fs.mkdirSync(path.join(root, 'QA')); fs.writeFileSync(path.join(root, 'a.txt'), 'x'); await files.trash('QA'); await files.trash('a.txt') }
  assert.deepEqual(fs.readdirSync(path.join(root, 'Trash')).sort(), ['QA', 'QA (2)', 'a (2).txt', 'a.txt'])
  fs.rmSync(tmp, { recursive: true })
})
