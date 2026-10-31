'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Mail, Index, detect, parseConfig, roles, mailName, clean, reason } = require('../mail')
const { raw, memoryServer, message, smtpSpy } = require('./mailfake')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'))


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
  assert.deepEqual(parseConfig(xml), { host: 'imap.x.org', port: 993, secure: true, users: ['%EMAILLOCALPART%'], provider: null, smtp: null })
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


test('mail: the Archive\'s year folders are synced as Archive', () => {
  const list = [{ path: 'INBOX' }, { path: 'Archive', specialUse: '\\Archive', delimiter: '/' }, { path: 'Archive/2026', delimiter: '/' }, { path: 'Archived', delimiter: '/' }]
  const { places } = require('../mail')
  assert.deepEqual(places(list, roles(list)), [['Inbox', 'INBOX'], ['Archive', 'Archive'], ['Archive', 'Archive/2026']])
})

test('mail: actions go to the server and the index; an archived mail\'s file follows it into Archive/<year> without a new download', async () => {
  const dir = tmp()
  try {
    const folders = { INBOX: { validity: 7, next: 3, msgs: { 1: message('Deadline', 'a'), 2: message('Hi', 'b') } }, Trash: { use: '\\Trash', validity: 8, next: 1, msgs: {} } }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    const acc = { id: 'me@sch.gr', server: {}, archiveBy: 'year' }
    mail.saveAccounts([acc])
    const run = { stop: false }
    await mail.headers(c, acc, 'Inbox', 'INBOX'); await mail.bodies(c, acc, 'Inbox', 'INBOX', run)
    const [a, b] = ['me@sch.gr/Inbox/7/1', 'me@sch.gr/Inbox/7/2']

    await mail.act({ op: 'read', ids: [a] }); await mail.act({ op: 'favorite', ids: [a, b] })
    assert.equal(mail.index.get(a).seen, true)
    assert.ok(folders.INBOX.msgs[1].flags.has('\\Seen') && folders.INBOX.msgs[2].flags.has('\\Flagged'))

    const before = mail.index.get(a).file
    await mail.act({ op: 'archive', ids: [a] })
    const y = String(new Date(mail.index.get(a).date).getFullYear())
    assert.deepEqual(c.calls.filter(x => x[0] !== 'fetchOne'), [['create', 'Archive'], ['create', `Archive/${y}`], ['move', 'INBOX', '1', `Archive/${y}`]])
    assert.equal(mail.list('Inbox').length, 1, 'gone from the Inbox at once')

    const fetched = c.calls.filter(x => x[0] === 'fetchOne').length
    await mail.headers(c, acc, 'Archive', `Archive/${y}`, 'Archive'); await mail.bodies(c, acc, 'Archive', `Archive/${y}`, run, 'Archive')
    const moved = mail.list('Archive')[0]
    assert.equal(moved.id, `me@sch.gr/Archive/Archive/${y}/9/1`)
    assert.equal(c.calls.filter(x => x[0] === 'fetchOne').length, fetched, 'not downloaded again')
    assert.match(moved.file, new RegExp(`^me@sch\\.gr/Archive/${y}/`))
    assert.ok(fs.existsSync(path.join(dir, moved.file)) && !fs.existsSync(path.join(dir, before)), 'the file moved with it')
    assert.equal(moved.saved, true)

    await mail.act({ op: 'delete', ids: [b] })
    assert.deepEqual(Object.keys(folders.Trash.msgs), ['1'])
    await assert.rejects(mail.act({ op: 'spam', ids: [moved.id] }), /no Spam folder/)
    await assert.rejects(mail.act({ op: 'explode', ids: [] }), /Unknown/)
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('mail: a phone\'s requests are carried out oldest first and removed; one that can never be done is dropped', async () => {
  const dir = tmp()
  try {
    const folders = { INBOX: { validity: 7, next: 2, msgs: { 1: message('Hi', 'a') } } }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    const acc = { id: 'me@sch.gr', server: {} }
    mail.saveAccounts([acc])
    await mail.headers(c, acc, 'Inbox', 'INBOX')
    const req = path.join(dir, 'requests')
    fs.mkdirSync(req)
    fs.writeFileSync(path.join(req, 'tablet-2.json'), JSON.stringify({ op: 'unfavorite', ids: ['me@sch.gr/Inbox/7/1'], at: 2 }))
    fs.writeFileSync(path.join(req, 'phone-1.json'), JSON.stringify({ op: 'favorite', ids: ['me@sch.gr/Inbox/7/1'], at: 1 }))
    fs.writeFileSync(path.join(req, 'phone-3.json'), JSON.stringify({ op: 'explode', ids: [], at: 3 }))
    fs.writeFileSync(path.join(req, 'phone-4.json'), '{"op":"rea') // still arriving
    await mail.requests()
    assert.deepEqual(fs.readdirSync(req), ['phone-4.json'])
    assert.equal(mail.index.get('me@sch.gr/Inbox/7/1').flagged, false, 'the later one wins')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})


test('mail: sending goes by SMTP, the same bytes are in Sent here (green) and on the server, and the server\'s copy takes the file over', async () => {
  const dir = tmp()
  try {
    const folders = { INBOX: { validity: 7, next: 1, msgs: {} }, Sent: { use: '\\Sent', validity: 3, next: 1, msgs: {} }, Drafts: { use: '\\Drafts', validity: 4, next: 1, msgs: {} } }
    const c = memoryServer(folders), smtp = smtpSpy()
    const mail = new Mail(dir, { secret: () => 'pw', connect: () => c, smtp: smtp.make })
    const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: { host: 'mail.sch.gr', user: 'me' }, smtp: { host: 'mail.sch.gr', port: 465, secure: true } }
    mail.saveAccounts([acc])
    const file = path.join(dir, 'Οδηγίες.pdf'); fs.writeFileSync(file, '%PDF')
    mail.picked = new Set([file])
    const d = { account: 'me@sch.gr', to: [{ name: 'Γραμματεία', address: 's@x.gr' }], bcc: [{ address: 'hidden@x.gr' }], subject: 'Εργασία', html: '<p>Καλησπέρα</p>', attachments: [{ name: 'Οδηγίες.pdf', path: file }] }

    const { messageId } = await mail.saveDraft(d)
    await mail.saveDraft({ ...d, messageId, html: '<p>Καλησπέρα σας</p>' })
    assert.equal(Object.keys(folders.Drafts.msgs).length, 1, 'one version of a draft on the server')
    assert.equal(mail.list('Drafts').length, 1, 'and here')

    await mail.send({ ...d, messageId })
    assert.deepEqual(smtp.sent[0].envelope, { from: 'me@sch.gr', to: ['s@x.gr', 'hidden@x.gr'] })
    assert.equal(smtp.sent[0].auth, 'me')
    const raw = smtp.sent[0].raw.toString()
    assert.doesNotMatch(raw, /hidden@x\.gr/, 'Bcc is not in the mail')
    assert.match(raw, /Content-Type: text\/plain/); assert.match(raw, /Content-Disposition: attachment/)
    assert.equal(Object.keys(folders.Drafts.msgs).length, 0, 'the draft goes once it is sent')
    assert.equal(mail.list('Drafts').length, 0)
    const sent = mail.list('Sent')[0]
    assert.ok(sent.saved && fs.existsSync(path.join(dir, sent.file)), 'green here at once')
    assert.equal(folders.Sent.msgs[1].source.toString(), raw, 'the same bytes on the server')

    const fetched = c.calls.filter(x => x[0] === 'fetchOne').length
    await mail.headers(c, acc, 'Sent', 'Sent'); await mail.bodies(c, acc, 'Sent', 'Sent', { stop: false })
    assert.deepEqual(mail.list('Sent').map(e => [e.id, e.file]), [['me@sch.gr/Sent/3/1', sent.file]], 'the server\'s copy has the file, nothing downloaded')
    assert.equal(c.calls.filter(x => x[0] === 'fetchOne').length, fetched)

    await assert.rejects(mail.send({ account: 'me@sch.gr', to: [], subject: 'x', html: '' }), /No one/)
    await assert.rejects(mail.send({ ...d, attachments: [{ name: 'passwd', path: '/etc/passwd' }] }), /not there/, 'only files picked here')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('mail: reply, reply all and forward are filled from the mail, the signature above or below the quote', async () => {
  const dir = tmp()
  try {
    const folders = { INBOX: { validity: 7, next: 2, msgs: { 1: { subject: 'Deadline', messageId: '<a@x>', flags: new Set(), source: Buffer.from(raw('Deadline', { attach: true }).toString().replace('To: t@nup.ac.cy', 'To: me@nup.ac.cy, b@x.gr\r\nCc: c@x.gr\r\nMessage-ID: <a@x>')) } } } }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    const acc = { id: 'me@nup.ac.cy', address: 'me@nup.ac.cy', server: {} }
    mail.saveAccounts([acc])
    await mail.headers(c, acc, 'Inbox', 'INBOX'); await mail.bodies(c, acc, 'Inbox', 'INBOX', { stop: false })
    const id = 'me@nup.ac.cy/Inbox/7/1'
    mail.setSignature('me@nup.ac.cy', { html: '<b>Θεολόγος</b>', newMail: true, replies: true, position: 'below' })

    const r = await mail.draftFor(id, 'reply')
    assert.deepEqual(r.to.map(a => a.address), ['secretariat@nup.ac.cy'])
    assert.equal(r.subject, 'Re: Deadline'); assert.equal(r.inReplyTo, '<a@x>'); assert.deepEqual(r.references, ['<a@x>'])
    assert.ok(r.html.indexOf('<blockquote') < r.html.indexOf('tetra-signature'), 'below the quote')
    const all = await mail.draftFor(id, 'replyAll')
    assert.deepEqual(all.cc.map(a => a.address), ['b@x.gr', 'c@x.gr'], 'everyone but me')
    mail.setSignature('me@nup.ac.cy', { html: '<b>Θεολόγος</b>', newMail: false, replies: true, position: 'above' })
    const above = await mail.draftFor(id, 'reply')
    assert.ok(above.html.indexOf('tetra-signature') < above.html.indexOf('<blockquote'), 'above the quote')
    assert.doesNotMatch((await mail.draftFor(null, 'new', 'me@nup.ac.cy')).html, /tetra-signature/, 'not on new mail when switched off')

    const f = await mail.draftFor(id, 'forward')
    assert.equal(f.subject, 'Fwd: Deadline'); assert.deepEqual(f.attachments.map(a => a.name), ['Guide.pdf']); assert.match(f.html, /Dear students/)
    const fa = await mail.draftFor(id, 'forwardAttached')
    assert.deepEqual(fa.attachments.map(a => [a.name, a.type]), [['Deadline.eml', 'message/rfc822']])
    assert.ok(mail.addresses().some(a => a.address === 's@x.gr' && a.name === 'Γραμματεία'))
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('mail: a phone\'s outbox is sent and removed; Gmail files its own Sent copy; a mail that cannot go says why', async () => {
  const dir = tmp()
  try {
    const folders = { INBOX: { validity: 7, next: 1, msgs: {} }, Sent: { use: '\\Sent', validity: 3, next: 1, msgs: {} } }
    const c = memoryServer(folders), smtp = smtpSpy()
    const mail = new Mail(dir, { secret: () => 'pw', connect: () => c, smtp: smtp.make })
    mail.saveAccounts([{ id: 'me@gmail.com', address: 'me@gmail.com', provider: 'google', server: { user: 'me@gmail.com' }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } }])
    const out = path.join(dir, 'outbox')
    fs.mkdirSync(path.join(out, 'phone-1.files'), { recursive: true })
    fs.writeFileSync(path.join(out, 'phone-1.files', 'photo.jpg'), 'jpg')
    fs.writeFileSync(path.join(out, 'phone-1.json'), JSON.stringify({ account: 'me@gmail.com', action: 'send', at: 1,
      draft: { to: [{ address: 'x@y.gr' }], subject: 'Από το κινητό', html: '<p>Γεια</p>', attachments: [{ name: 'photo.jpg', file: 'outbox/phone-1.files/photo.jpg' }] } }))
    fs.writeFileSync(path.join(out, 'phone-2.json'), JSON.stringify({ account: 'me@gmail.com', action: 'send', at: 2, draft: { to: [], subject: 'κανείς' } }))
    await mail.outbox()
    assert.equal(smtp.sent.length, 1)
    assert.match(smtp.sent[0].raw.toString(), /photo\.jpg/)
    assert.equal(Object.keys(folders.Sent.msgs).length, 0, 'Gmail keeps its own Sent copy')
    assert.equal(mail.list('Sent').length, 1)
    assert.deepEqual(fs.readdirSync(out).sort(), ['phone-2.failed.json'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'phone-2.failed.json'), 'utf8')).error, 'noRecipients')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
