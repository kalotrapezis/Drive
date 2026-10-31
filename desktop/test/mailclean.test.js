'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Mail } = require('../mail')
const care = require('../mailclean')
const { memoryServer, message } = require('./mailfake')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mailclean-'))
const yearsAgo = n => new Date(Date.now() - n * 365.25 * 86_400_000)

/** An account with mail of every age on an in-memory server, synced once. */
async function setup(dir, extra = {}) {
  const folders = {
    INBOX: { validity: 7, next: 6, msgs: {
      1: message('Old with a file', 'a', { attach: true, date: yearsAgo(4) }), 2: message('Old plain', 'b', { date: yearsAgo(3) }),
      3: message('Recent', 'c', { date: yearsAgo(0.1) }), 4: message('Old but loved', 'd', { date: yearsAgo(5) }), 5: message('Old, not here', 'e', { date: yearsAgo(5) }) } },
    Archive: { use: '\\Archive', validity: 9, next: 2, msgs: { 1: message('Archived flat', 'f', { date: yearsAgo(1.1) }) } },
  }
  folders.INBOX.msgs[4].flags.add('\\Flagged')
  const c = memoryServer(folders)
  const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
  const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: {}, archiveBy: 'year', ...extra }
  mail.saveAccounts([acc])
  const run = { stop: false }
  for (const [role, box] of [['Inbox', 'INBOX'], ['Archive', 'Archive']]) await mail.headers(c, acc, role, box)
  for (const [role, box] of [['Inbox', 'INBOX'], ['Archive', 'Archive']]) await mail.bodies(c, acc, role, box, run)
  // one mail not downloaded: its line has no file, so the server must keep it
  const e = mail.index.get('me@sch.gr/Inbox/7/5'); mail.unlink(e.file); mail.index.put({ ...e, file: null, saved: false })
  return { c, folders, mail, acc: mail.accounts()[0], run }
}

test('clean-up: the plan deletes on the server only green mail past its age, never ♥, and files the Archive by year', async () => {
  const dir = tmp()
  try {
    const { mail, acc } = await setup(dir)
    const p = care.plan(mail, acc)
    const subjects = list => list.map(e => e.subject).sort()
    assert.deepEqual(subjects(p.server), ['Old plain', 'Old with a file'])
    assert.deepEqual(subjects(p.unsafe), ['Old, not here'], 'no checked copy here: kept on the server')
    assert.deepEqual(subjects(p.archive), ['Archived flat'])
    assert.deepEqual(p.local, [], 'the archive here is not cleaned by default')
    assert.equal(care.plan(mail, { ...acc, serverClean: { on: true, attachmentsMonths: 60, otherMonths: 24 } }).server.length, 1, 'its own age for mail with attachments')
    assert.equal(care.plan(mail, { ...acc, localClean: { on: true, attachmentsMonths: 12, otherMonths: 12 } }).warn, true, 'here before the server: no copy left')
    const s = care.summary(mail, p)
    assert.equal(s.server.count, 2); assert.ok(s.server.bytes > 0)
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('clean-up: nothing runs by itself before the first check; run deletes on the server, keeps the copy, and later deletes here', async () => {
  const dir = tmp()
  try {
    const { mail, acc, folders, c } = await setup(dir)
    assert.equal(await care.daily(mail, acc), null, 'not before the user has seen it once')
    const done = await care.run(mail, acc, care.plan(mail, acc))
    assert.equal(done.server, 2); assert.equal(done.archive, 1); assert.deepEqual(done.errors, [])
    assert.deepEqual(Object.keys(folders.INBOX.msgs).sort(), ['3', '4', '5'])
    assert.ok(Object.keys(folders[`Archive/${yearsAgo(1.1).getFullYear()}`]?.msgs ?? {}).length === 1, 'filed in Archive/<its year>')
    const gone = mail.index.get('me@sch.gr/Inbox/7/1')
    assert.ok(gone.gone && fs.existsSync(path.join(dir, gone.file)), 'gone from the server, still here')
    assert.ok(mail.accounts()[0].cleanConfirmed)
    assert.equal(await care.daily(mail, mail.accounts()[0]), null, 'once a day')

    const local = { ...mail.accounts()[0], localClean: { on: true, attachmentsMonths: 40, otherMonths: 40 } }
    const p = care.plan(mail, local)
    assert.deepEqual(p.local.map(e => e.subject).sort(), ['Old but loved', 'Old with a file'].filter(s => s !== 'Old but loved'), '♥ kept here too')
    await care.run(mail, local, p)
    const pruned = mail.index.get('me@sch.gr/Inbox/7/1')
    assert.ok(pruned.pruned && !pruned.file)
    const fetched = c.calls.filter(x => x[0] === 'fetchOne').length
    await mail.bodies(c, local, 'Inbox', 'INBOX', { stop: false })
    assert.equal(c.calls.filter(x => x[0] === 'fetchOne').length, fetched + 1, 'only the one never downloaded comes down; the pruned stays pruned')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('garbage: found and tidied without losing any mail', async () => {
  const dir = tmp()
  try {
    const { mail } = await setup(dir)
    const e = mail.index.get('me@sch.gr/Inbox/7/3'), file = path.join(dir, e.file)
    const year = path.dirname(file)
    fs.copyFileSync(file, path.join(year, 'stray.eml'))                       // an .eml no line knows
    fs.writeFileSync(path.join(year, '.half.eml.part'), 'x')                  // a download cut short
    fs.mkdirSync(path.join(year, 'gone.files')); fs.writeFileSync(path.join(year, 'gone.files', 'a.pdf'), 'x') // attachments without their mail
    fs.mkdirSync(path.join(dir, 'me@sch.gr', 'Spam', '2020'), { recursive: true }) // empty
    fs.mkdirSync(path.join(dir, 'requests')); const old = path.join(dir, 'requests', 'phone-1.json'); fs.writeFileSync(old, '{}')
    fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const lost = mail.index.get('me@sch.gr/Inbox/7/2'); fs.rmSync(path.join(dir, lost.file))    // a line whose file went
    const copy = path.join(year, 'copy.eml'); fs.copyFileSync(file, copy)                       // one mail twice
    mail.index.put({ ...e, id: 'me@sch.gr/Inbox/old/3', gone: true, file: path.relative(dir, copy) })

    const g = care.garbage(mail)
    assert.deepEqual(g.orphans.map(r => path.basename(r)), ['stray.eml'])
    assert.deepEqual(g.missing, ['me@sch.gr/Inbox/7/2'])
    assert.equal(g.lonely.length, 1); assert.equal(g.partial.length, 1); assert.equal(g.leftovers.length, 1)
    assert.ok(g.empty.some(r => r.endsWith('Spam/2020')))
    assert.deepEqual(g.duplicates, [{ keep: e.id, drop: 'me@sch.gr/Inbox/old/3' }])

    const done = await care.sweep(mail, g)
    assert.equal(done.adopted, 1); assert.equal(done.cleared, 1)
    assert.ok(fs.existsSync(path.join(year, 'stray.eml')), 'a stray mail is kept and indexed, not deleted')
    assert.ok(!fs.existsSync(copy) && fs.existsSync(file))
    const again = care.garbage(mail)
    assert.deepEqual([again.orphans, again.missing, again.lonely, again.partial, again.empty, again.leftovers, again.duplicates].map(x => x.length), [0, 0, 0, 0, 0, 0, 0])
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('filters: conditions, then flags before moves, and attachments saved into a Files folder', async () => {
  const dir = tmp(), files = tmp()
  try {
    const { mail, folders } = await setup(dir)
    care.setFilters(mail, [
      { name: 'Invoices', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'with a file' }, { field: 'hasAttachment', value: true }],
        actions: [{ type: 'saveAttachments', folder: 'Τιμολόγια/..' }, { type: 'favorite' }, { type: 'move', to: 'Archive' }] },
      { name: 'off', on: false, conditions: [{ field: 'from', op: 'contains', value: 's@x.gr' }], actions: [{ type: 'delete' }] },
    ])
    const entries = mail.list('Inbox')
    const r = await care.applyFilters(mail, entries, { filesRoot: files })
    assert.equal(r.matched, 1)
    assert.deepEqual(fs.readdirSync(path.join(files, 'Τιμολόγια')), ['Guide.pdf'], 'inside Files, ".." ignored')
    const moved = Object.values(folders.Archive.msgs).find(m => m.subject === 'Old with a file')
    assert.ok(moved && moved.flags.has('\\Flagged'), 'marked ♥, then moved')
    assert.equal(care.filesFolder(files, '../../etc'), path.join(files, 'etc'))
    assert.ok(await care.matches(mail, { match: 'any', conditions: [{ field: 'body', op: 'contains', value: 'deadline' }] }, mail.list('Inbox')[0]))
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(files, { recursive: true, force: true }) }
})

test('spam: the filter learns from Spam and Not spam, and never takes someone the user has written to', async () => {
  const dir = tmp()
  try {
    const junk = new care.Junk(path.join(dir, 'junk.json'))
    for (let i = 0; i < 12; i++) { junk.train(`win free money now casino bonus ${i}`, true); junk.train(`meeting tomorrow at school about the timetable ${i}`, false) }
    junk.save()
    assert.ok(junk.ready())
    assert.ok(junk.score('free casino money bonus') > 0.97)
    assert.ok(junk.score('school meeting timetable') < 0.1)
    assert.equal(new care.Junk(path.join(dir, 'junk.json')).nSpam, 12, 'kept')

    const folders = { INBOX: { validity: 7, next: 3, msgs: {} }, Spam: { use: '\\Junk', validity: 8, next: 1, msgs: {} }, Sent: { use: '\\Sent', validity: 9, next: 1, msgs: {} } }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: {} }
    mail.saveAccounts([acc])
    folders.Sent.msgs[1] = message('Re: hi', 's', { to: [{ address: 'friend@x.gr' }] })
    folders.INBOX.msgs[1] = message('free casino money bonus', 'p', { from: { name: '', address: 'win@spam.example' } })
    folders.INBOX.msgs[2] = message('free casino money bonus', 'q', { from: { name: '', address: 'friend@x.gr' } })
    for (const [role, box] of [['Sent', 'Sent'], ['Inbox', 'INBOX']]) await mail.headers(c, acc, role, box)
    mail.junkFilter = junk
    await care.onNew(mail, mail.list('Inbox'))
    assert.deepEqual(Object.values(folders.Spam.msgs).map(m => m.messageId), ['<p@x>'], 'the stranger to Spam, the friend stays')
    assert.equal(junk.nSpam, 12, 'its own guesses do not teach it')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
