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
  assert.deepEqual((await files.list('')).map(i => i.name).sort(), ['Docs', 'Documents', 'Ελληνικά.pdf']) // links are not listed; the required folders are always there
  // the Calendar's and the Timer's folders are there and sync, but Files does not show them (the user, 18 Oct)
  fs.mkdirSync(path.join(files.root, 'Timer'))
  assert.ok(fs.existsSync(path.join(files.root, 'Calendar')))
  assert.ok(!(await files.list('')).some(i => i.name === 'Calendar' || i.name === 'Timer'))
  assert.ok(!(await files.destinations()).some(d => d.startsWith('Calendar') || d.startsWith('Timer')))
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

test('an event removed by hand is a deletion: never asked back, and the other side follows into its Trash (23 Oct)', async () => {
  const { tmp, root, files } = setup()
  try {
    const sha = b => require('node:crypto').createHash('sha256').update(b).digest('hex')
    const cal = p => path.join(root, 'Calendar', p)
    const list = l => l.map(([p, b]) => ({ path: p, sha256: sha(b) }))
    fs.mkdirSync(cal('Personal'), { recursive: true }); fs.mkdirSync(cal('Γενέθλια'))
    const ev = 'BEGIN:VCALENDAR birthday', other = 'BEGIN:VCALENDAR other', moved = 'BEGIN:VCALENDAR moved'
    // the identical "(2)" kept the bytes here, so removing the original by hand was not remembered as a deletion
    for (const [p, b] of [['Personal/bday.ics', ev], ['Personal/bday (2).ics', ev], ['Personal/other.ics', other], ['Personal/moved.ics', moved]]) fs.writeFileSync(cal(p), b)
    const device = [['Calendar/Personal/bday.ics', ev], ['Calendar/Personal/bday (2).ics', ev], ['Calendar/Personal/other.ics', other], ['Calendar/Personal/moved.ics', moved]]
    let r = await files.reconcile(list(device), 'phone', { scope: 'calendar' })
    assert.deepEqual([r.want, r.have, r.moveTo], [[], [], []])
    // here: the original rm'd (its copy stays); another event moved to Γενέθλια by hand
    fs.rmSync(cal('Personal/bday.ics')); fs.renameSync(cal('Personal/moved.ics'), cal('Γενέθλια/moved.ics'))
    r = await files.reconcile(list(device), 'phone', { scope: 'calendar' })
    assert.deepEqual(r.want, [], 'nothing comes back')
    assert.deepEqual(r.moveTo.sort((a, b) => a.from.localeCompare(b.from)), [
      { from: 'Calendar/Personal/bday.ics', to: 'Trash/bday.ics' }, { from: 'Calendar/Personal/moved.ics', to: 'Calendar/Γενέθλια/moved.ics' }])
    // a device that did not follow is still not asked, sync after sync
    r = await files.reconcile(list(device), 'phone', { scope: 'calendar' })
    assert.deepEqual(r.want, [])
    // the device followed, and rm'd other.ics itself: this computer's copy goes to its Trash, nothing is offered back
    const after = [['Trash/bday.ics', ev], ['Calendar/Personal/bday (2).ics', ev], ['Calendar/Γενέθλια/moved.ics', moved]]
    r = await files.reconcile(list(after), 'phone', { scope: 'calendar' })
    assert.ok(!fs.existsSync(cal('Personal/other.ics'))); assert.equal(fs.readFileSync(path.join(root, 'Trash', 'other.ics'), 'utf8'), other)
    assert.deepEqual(r.have, []); assert.deepEqual(r.moveTo, [])
    assert.equal(fs.readFileSync(cal('Γενέθλια/moved.ics'), 'utf8'), moved, 'the event in the other calendar untouched')
    // an edit there after a removal here is not lost: it is asked for
    fs.writeFileSync(cal('Personal/x.ics'), 'BEGIN:VCALENDAR x')
    await files.reconcile(list([...after, ['Calendar/Personal/x.ics', 'BEGIN:VCALENDAR x']]), 'phone', { scope: 'calendar' })
    fs.rmSync(cal('Personal/x.ics'))
    r = await files.reconcile(list([...after, ['Calendar/Personal/x.ics', 'BEGIN:VCALENDAR x edited']]), 'phone', { scope: 'calendar' })
    assert.ok(r.want.includes('Calendar/Personal/x.ics'))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('a name already in Trash never blocks a delete: the newcomer becomes "name (2)"', async () => {
  const { tmp, root, files } = setup()
  for (let i = 0; i < 2; i++) { fs.mkdirSync(path.join(root, 'QA')); fs.writeFileSync(path.join(root, 'a.txt'), 'x'); await files.trash('QA'); await files.trash('a.txt') }
  assert.deepEqual(fs.readdirSync(path.join(root, 'Trash')).sort(), ['QA', 'QA (2)', 'a (2).txt', 'a.txt'])
  fs.rmSync(tmp, { recursive: true })
})

test('a scoped sync (the Calendar) answers for its part and leaves the memory of the rest as it was', async () => {
  const { tmp, root, files } = setup()
  try {
    const crypto = require('node:crypto')
    const sha = b => crypto.createHash('sha256').update(b).digest('hex')
    fs.mkdirSync(path.join(root, 'Calendar', 'Work'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Calendar', 'Work', 'a.ics'), 'BEGIN:VCALENDAR')
    // a whole sync: the device has Docs/a.txt and Calendar/Work/a.ics
    const all = [{ path: 'Docs/a.txt', sha256: sha('alpha') }, { path: 'Calendar/Work/a.ics', sha256: sha('BEGIN:VCALENDAR') }, { path: 'Docs/Inner/b.md', sha256: sha('beta') }, { path: 'Ελληνικά.pdf', sha256: sha('pdf') }]
    await files.reconcile(all, 'tab')
    const memory = () => files.db.prepare("SELECT device_id, path, sha256 FROM sync_manifest WHERE path NOT LIKE 'Calendar/%' ORDER BY device_id, path").all()
    const before = JSON.stringify(memory())
    // the device made an event: only the Calendar is sent, and it is asked for
    const ev = 'BEGIN:VCALENDAR new'
    let r = await files.reconcile([{ path: 'Calendar/Work/a.ics', sha256: sha('BEGIN:VCALENDAR') }, { path: 'Calendar/Work/new.ics', sha256: sha(ev) }, { path: 'Docs/a.txt', sha256: sha('alpha') }], 'tab', { scope: 'calendar' })
    assert.deepEqual(r.want, ['Calendar/Work/new.ics']) // Docs/a.txt is out of scope: ignored
    assert.deepEqual(r.have, [])
    assert.equal(JSON.stringify(memory()), before, 'the rest of the memory is untouched')
    // this computer edited an event (the skill): offered to the device as a replacement, at once
    fs.writeFileSync(path.join(root, 'Calendar', 'Work', 'a.ics'), 'BEGIN:VCALENDAR edited')
    r = await files.reconcile([{ path: 'Calendar/Work/a.ics', sha256: sha('BEGIN:VCALENDAR') }], 'tab', { scope: 'calendar' })
    assert.equal(r.have.length, 1); assert.equal(r.have[0].path, 'Calendar/Work/a.ics'); assert.equal(r.have[0].replaces, sha('BEGIN:VCALENDAR'))
    // the device received it; then deleted the event, which is a move into Trash: followed here
    await files.reconcile([{ path: 'Calendar/Work/a.ics', sha256: sha('BEGIN:VCALENDAR edited') }], 'tab', { scope: 'calendar' })
    r = await files.reconcile([{ path: 'Trash/a.ics', sha256: sha('BEGIN:VCALENDAR edited') }], 'tab', { scope: 'calendar' })
    assert.deepEqual(r.moved, [{ from: 'Calendar/Work/a.ics', to: 'Trash/a.ics' }])
    assert.ok(fs.existsSync(path.join(root, 'Trash', 'a.ics')))
    // and the next whole sync finds nothing amiss with the rest
    r = await files.reconcile(all.filter(f => !f.path.startsWith('Calendar/')).concat([{ path: 'Trash/a.ics', sha256: sha('BEGIN:VCALENDAR edited') }]), 'tab')
    assert.deepEqual(r.moved, []); assert.deepEqual(r.want, [])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
