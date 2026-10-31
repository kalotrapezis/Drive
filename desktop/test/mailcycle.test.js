'use strict'
// Whole cycles against a real IMAP server and a real SMTP server on this computer (hoodiecrow-imap, smtp-server): fetch,
// a phone's request, archive, move, delete, a phone's outbox, the clean-up by age, the sync again — and then the archive
// and the server must agree, and no garbage is left.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Mail } = require('../mail')
const care = require('../mailclean')

const msg = (subject, date = 'Fri, 31 Oct 2026 09:12:00 +0200', extra = '') => `From: "Γραμματεία" <sec@example.gr>\r\nTo: me@test.gr\r\nSubject: ${subject}\r\n` +
  `Date: ${date}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.gr>\r\nMIME-Version: 1.0\r\n${extra}\r\nHello, ${subject}.\r\n`
const until = async (what, ms = 15_000) => { const end = Date.now() + ms; while (!what()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)) } }

test('mail: full cycles against a local IMAP and SMTP server leave the archive and the server matching, with no garbage', { timeout: 120_000 }, async () => {
  const hoodiecrow = require('hoodiecrow-imap'), { SMTPServer } = require('smtp-server'), { ImapFlow } = require('imapflow')
  const sent = []
  const smtp = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onAuth: (a, s, cb) => cb(a.username === 'me' && a.password === 'secret' ? null : new Error('535 no'), { user: 'me' }),
    onData: (stream, s, cb) => { const b = []; stream.on('data', c => b.push(c)); stream.on('end', () => { sent.push({ to: s.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(b).toString() }); cb() }) } })
  const imap = hoodiecrow({ plugins: ['ID', 'IDLE', 'SPECIAL-USE', 'ENABLE', 'UIDPLUS', 'LITERALPLUS'], users: { me: { password: 'secret' } },
    storage: { INBOX: { messages: ['keep', 'archive me', 'spam me', 'delete me', 'love me'].map(s => ({ raw: msg(s) })).concat({ raw: msg('very old', 'Mon, 2 Mar 2020 10:00:00 +0200') }) },
      '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] }, Drafts: { 'special-use': '\\Drafts', messages: [] },
        Junk: { 'special-use': '\\Junk', messages: [] }, Trash: { 'special-use': '\\Trash', messages: [] } } } } })
  await new Promise(r => smtp.listen(0, '127.0.0.1', r)); await new Promise(r => imap.listen(0, '127.0.0.1', r))
  const port = { imap: imap.server?.address?.().port ?? imap._server?.address().port, smtp: smtp.server.address().port }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcycle-'))
  const mail = new Mail(root, { secret: () => 'secret' })
  const server = async () => { // every mail on the server: box → [{ uid, messageId, flags }]
    const c = new ImapFlow({ host: '127.0.0.1', port: port.imap, secure: false, auth: { user: 'me', pass: 'secret' }, logger: false })
    await c.connect()
    const out = {}
    for (const f of await c.list()) {
      await c.mailboxOpen(f.path, { readOnly: true }); out[f.path] = []
      if (c.mailbox.exists) for await (const m of c.fetch('1:*', { uid: true, envelope: true, flags: true })) out[f.path].push({ uid: m.uid, messageId: m.envelope.messageId, flags: [...m.flags] })
    }
    await c.logout()
    return out
  }
  const synced = async () => { const before = mail.status()['me@test.gr']?.synced ?? 0; mail.syncNow(); await until(() => (mail.status()['me@test.gr']?.synced ?? 0) > before && !mail.status()['me@test.gr'].busy) }
  const find = s => mail.list('Inbox').find(e => e.subject === s)
  try {
    assert.ok(port.imap && port.smtp, 'both servers listen')
    mail.add({ address: 'me@test.gr', server: { host: '127.0.0.1', port: port.imap, secure: false, smtp: { host: '127.0.0.1', port: port.smtp, secure: false } }, user: 'me' })
    mail.watchRequests()
    await until(() => mail.status()['me@test.gr']?.synced)
    assert.equal(mail.list('Inbox').length, 6)
    assert.ok(mail.list('Inbox').every(e => e.saved), 'all green')

    // a phone's request, then the window's own actions
    fs.writeFileSync(path.join(root, 'requests', 'phone-1.json'), JSON.stringify({ op: 'favorite', ids: [find('love me').id], at: 1 }))
    await until(() => find('love me')?.flagged)
    await mail.act({ op: 'archive', ids: [find('archive me').id] })
    await mail.act({ op: 'spam', ids: [find('spam me').id] })
    await mail.act({ op: 'delete', ids: [find('delete me').id] })
    // a phone's mail through the outbox
    fs.writeFileSync(path.join(root, 'outbox', 'phone-2.json'), JSON.stringify({ account: 'me@test.gr', action: 'send', at: 2,
      draft: { to: [{ name: 'Σχολείο', address: 'school@example.gr' }], subject: 'Από το κινητό', html: '<p>Καλημέρα</p>' } }))
    await until(() => sent.length === 1)
    // the clean-up: the first run after the check, by age (the 2020 mail is past 2 years), only green on the server
    const acc = mail.accounts()[0]
    const p = care.plan(mail, acc)
    assert.deepEqual(p.server.map(e => e.subject), ['very old'])
    const done = await care.run(mail, acc, p)
    assert.equal(done.server, 1)
    await synced(); await synced() // the moved mails found in their new folders, their files moved with them

    const s = await server()
    assert.equal(s.INBOX.length, 2, 'keep and love me')
    assert.ok(s.INBOX.find(m => m.messageId === '<loveme@example.gr>').flags.includes('\\Flagged'))
    assert.equal(s[`Archive/${new Date(2026, 9, 31).getFullYear()}`]?.length, 1, 'archived by year')
    assert.equal(s.Junk.length, 1); assert.equal(s.Trash.length, 1); assert.equal(s.Sent.length, 1)
    assert.match(sent[0].raw, /Subject: =\?UTF-8\?/); assert.deepEqual(sent[0].to, ['school@example.gr'])

    // the archive and the server agree: every mail on the server has one green line with its file, and back
    const lines = [...mail.index.all()].filter(e => !e.gone)
    for (const [box, list] of Object.entries(s)) for (const m of list) {
      const e = lines.find(x => x.messageId === m.messageId && (x.box ?? box) === box && x.uid === m.uid)
      assert.ok(e && e.saved && fs.existsSync(path.join(root, e.file)), `${box} ${m.messageId} is here`)
    }
    assert.equal(lines.length, Object.values(s).flat().length, 'no line for a mail the server has not')
    const old = [...mail.index.all()].find(e => e.subject === 'very old')
    assert.ok(old.gone && fs.existsSync(path.join(root, old.file)), 'cleaned on the server, kept here')
    assert.ok(mail.list('Archive')[0].file.includes('/Archive/'), 'the archived file moved into Archive here too')

    const g = care.garbage(mail)
    assert.deepEqual(Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'bytes').map(([k, v]) => [k, v.length])),
      { orphans: 0, missing: 0, lonely: 0, partial: 0, empty: 0, leftovers: 0, duplicates: 0 })
    assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []); assert.deepEqual(fs.readdirSync(path.join(root, 'outbox')), [])
  } finally {
    mail.stopAll()
    await new Promise(r => setTimeout(r, 300))
    imap.close(); smtp.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
