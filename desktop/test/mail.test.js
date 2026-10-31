'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Mail, Index, detect, parseConfig, roles, mailName, clean, reason } = require('../mail')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'))

const raw = (subject, { attach = false } = {}) => Buffer.from([
  'From: =?UTF-8?B?zpPPgc6xzrzOvM6xz4TOtc6vzrEgzpzOoM6j?= <secretariat@nup.ac.cy>',
  'To: t@nup.ac.cy',
  `Subject: ${subject}`,
  'Date: Fri, 31 Oct 2026 09:12:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Dear students,   the deadline is 15 November.',
  ...(attach ? ['--b', 'Content-Type: application/pdf; name="Guide.pdf"', 'Content-Disposition: attachment; filename="Guide.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 x').toString('base64')] : []),
  '--b--', '',
].join('\r\n'))

/** Just enough of an imapflow client: one folder per path, uids → raw mail. */
function fakeServer(boxes) {
  let open = null
  return {
    get mailbox() { return { uidValidity: 7n, exists: Object.keys(boxes[open]).length } },
    async mailboxOpen(p) { open = p },
    async search() { return Object.keys(boxes[open]).map(Number) },
    async *fetch(range, query) {
      const want = range === '1:*' ? Object.keys(boxes[open]).map(Number) : range.split(',').map(Number)
      for (const uid of want) {
        const m = boxes[open][uid]
        yield { uid, flags: new Set(m.flags ?? []), size: m.source.length, internalDate: new Date('2026-10-31T07:12:00Z'),
          envelope: { date: new Date('2026-10-31T07:12:00Z'), subject: m.subject, from: [{ name: 'Γραμματεία ΜΠΣ', address: 'secretariat@nup.ac.cy' }], to: [{ address: 't@nup.ac.cy' }] },
          bodyStructure: { childNodes: [{}, ...(m.attach ? [{ disposition: 'attachment' }] : [])] } }
      }
    },
    async fetchOne(uid) { return { source: boxes[open][uid].source } },
  }
}

test('mail: a file name per mail by local time, safe on every disk and under 255 bytes', () => {
  const at = new Date(2026, 9, 31, 9, 5).getTime()
  assert.equal(mailName(at, 'Γραμματεία ΜΠΣ', 'Re: a/b: c?'), '2026/2026-10-31 0905 Γραμματεία ΜΠΣ - Re a b c')
  assert.equal(mailName(at, '', ''), '2026/2026-10-31 0905 - - -')
  const long = mailName(at, 'Α'.repeat(100), 'Θ'.repeat(300)).split('/')[1]
  assert.ok(Buffer.byteLength(long + '.files') < 255)
  assert.equal(clean('..hidden', 50), 'hidden')
})

test('mail: the index keeps the last line per id, survives a cut line and compacts when it has grown', () => {
  const dir = tmp(), file = path.join(dir, 'index.jsonl')
  try {
    const a = new Index(file)
    a.put({ id: 'x', saved: false }); a.put({ id: 'y' }); a.put({ id: 'x', saved: true }); a.flush()
    fs.appendFileSync(file, '{"id":"z","cut')
    const b = new Index(file)
    assert.deepEqual([...b.all()].map(e => e.id).sort(), ['x', 'y'])
    assert.equal(b.get('x').saved, true)
    b.put({ id: 'w' }); b.flush()
    assert.equal(new Index(file).get('w').id, 'w', 'a line after a cut one is read')
    for (let i = 0; i < 300; i++) b.put({ id: 'x', n: i })
    b.flush()
    const c = new Index(file)
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3)
    assert.equal(c.get('x').n, 299)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('mail: the roles come from SPECIAL-USE first, INBOX is always the Inbox, \\Noselect is skipped', () => {
  const list = [
    { path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk', specialUseSource: 'name' },
    { path: '[Gmail]/Ανεπιθύμητα', specialUse: '\\Junk', specialUseSource: 'extension' },
    { path: '[Gmail]', specialUse: '\\Sent', flags: new Set(['\\Noselect']) }, { path: '[Gmail]/Σταλμένα', specialUse: '\\Sent' },
    { path: '[Gmail]/All Mail', specialUse: '\\All' },
  ]
  assert.deepEqual(roles(list), { Inbox: 'INBOX', Spam: '[Gmail]/Ανεπιθύμητα', Sent: '[Gmail]/Σταλμένα' })
})

test('mail: the servers are found from known providers, Thunderbird\'s database, the MX, then the usual names', async () => {
  assert.equal((await detect('kalotrapezis@gmail.com')).server.host, 'imap.gmail.com')
  assert.equal((await detect('goodtable@sch.gr')).server.users[0], '%EMAILLOCALPART%')
  const xml = '<clientConfig><incomingServer type="pop3"><hostname>pop.x</hostname><port>995</port></incomingServer><incomingServer type="imap"><hostname>imap.x.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer></clientConfig>'
  assert.deepEqual(parseConfig(xml), { host: 'imap.x.org', port: 993, secure: true, users: ['%EMAILLOCALPART%'], provider: null })
  const none = async () => null, nomx = async () => []
  assert.equal((await detect('a@x.org', { lookup: async u => (u.includes('thunderbird') ? parseConfig(xml) : null) })).how, 'thunderbird')
  assert.equal((await detect('t@nup.ac.cy', { lookup: none, mx: async () => [{ priority: 0, exchange: 'nup-ac-cy.mail.protection.outlook.com' }] })).server.provider, 'microsoft')
  const guess = await detect('a@school.gr', { lookup: none, mx: nomx, probe: async h => h === 'mail.school.gr' })
  assert.equal(guess.server.host, 'mail.school.gr')
  assert.equal(await detect('a@nowhere.gr', { lookup: none, mx: nomx, probe: async () => false }), null)
})

test('mail: a sign-in failure becomes one word for one plain sentence', () => {
  assert.equal(reason({ authenticationFailed: true, responseText: 'Invalid credentials' }), 'auth')
  assert.equal(reason({ authenticationFailed: true, responseText: '[ALERT] Application-specific password required' }), 'appPassword')
  assert.equal(reason({ code: 'ENOTFOUND' }), 'unreachable')
  assert.equal(reason(new Error('boom')), 'other')
})

test('mail: a sync writes <account>/<Folder>/<yyyy>/… .eml with its attachments beside it, orange then green, gone kept on disk', async () => {
  const dir = tmp()
  try {
    const mail = new Mail(dir, { secret: () => 'x' })
    const acc = { id: 'a@nup.ac.cy', notify: true }
    mail.saveAccounts([acc])
    const boxes = { INBOX: { 5: { subject: 'Προθεσμία: 15/11', source: raw('Deadline', { attach: true }), attach: true }, 6: { subject: 'Hi', source: raw('Hi'), flags: ['\\Seen', '\\Flagged'] } } }
    const c = fakeServer(boxes), run = { stop: false }
    await mail.headers(c, acc, 'Inbox', 'INBOX')
    assert.deepEqual(mail.folders()[0].accounts[0], { id: 'a@nup.ac.cy', unread: 1, total: 2, orange: 2 })
    assert.equal(mail.list('Inbox').find(e => e.uid === 5).attachments, 1)
    await mail.bodies(c, acc, 'Inbox', 'INBOX', run)
    mail.index.flush()
    const e = mail.index.get('a@nup.ac.cy/Inbox/7/5')
    const y = new Date(e.date).getFullYear()
    assert.match(e.file, new RegExp(`^a@nup\\.ac\\.cy/Inbox/${y}/${y}-\\d\\d-\\d\\d \\d{4} Γραμματεία ΜΠΣ - Προθεσμία 15 11\\.eml$`))
    assert.equal(e.saved, true)
    assert.match(e.snippet, /^Dear students, the deadline/)
    assert.equal(fs.readFileSync(path.join(dir, e.file.slice(0, -4) + '.files', 'Guide.pdf'), 'utf8'), '%PDF-1.4 x')
    assert.equal(mail.folders()[0].accounts[0].orange, 0)
    const opened = await mail.open(e.id)
    assert.deepEqual(opened.attachments.map(a => a.name), ['Guide.pdf'])
    assert.ok(mail.inside(opened.attachments[0].file))
    assert.equal(mail.inside('../../etc/passwd'), null)
    assert.equal(mail.index.get('a@nup.ac.cy/Inbox/7/6').flagged, true)

    delete boxes.INBOX[6]
    await mail.headers(c, acc, 'Inbox', 'INBOX')
    assert.deepEqual(mail.list('Inbox').map(m => m.uid), [5], 'gone from the server, gone from the list')
    assert.ok(fs.existsSync(path.join(dir, mail.index.get('a@nup.ac.cy/Inbox/7/6').file)), 'and still on disk')

    mail.remove('a@nup.ac.cy')
    assert.deepEqual(mail.list('Inbox'), [], 'a removed account is out of the lists')
    assert.ok(fs.existsSync(path.join(dir, e.file)), 'its archive stays')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
