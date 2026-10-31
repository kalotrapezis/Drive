'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Mail } = require('../mail')
const { Tools, MAIL_REPORT, SCHEMA } = require('../assistant')
const { memoryServer, message } = require('./mailfake')

test('assistant: finds mail, reads it whole, says what waits for an answer and how the accounts are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailassist-'))
  try {
    const day = n => new Date(Date.now() - n * 86_400_000)
    const folders = {
      INBOX: { validity: 7, next: 5, msgs: {
        1: message('Προθεσμία εργασίας', 'a', { attach: true, date: day(1), from: { name: 'Γραμματεία ΜΠΣ', address: 'secretariat@nup.ac.cy' } }),
        2: message('Σύλλογος διδασκόντων', 'b', { date: day(2), from: { name: 'Διεύθυνση', address: 'school@sch.gr' } }),
        3: message('Your order shipped', 'c', { date: day(1), from: { name: 'Shop', address: 'no-reply@shop.gr' } }),
        4: message('Old question', 'd', { date: day(30), from: { name: 'Νίκος', address: 'nikos@x.gr' } }) } },
      Sent: { use: '\\Sent', validity: 9, next: 2, msgs: { 1: message('Re: Σύλλογος', 's', { date: day(1), to: [{ address: 'school@sch.gr' }] }) } },
    }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: {} }
    mail.saveAccounts([acc])
    for (const [role, box] of [['Inbox', 'INBOX'], ['Sent', 'Sent']]) { await mail.headers(c, acc, role, box); await mail.bodies(c, acc, role, box, { stop: false }) }
    const tools = new Tools({ mail })

    const found = await tools.run('mail_search', { query: 'προθεσμια' })
    assert.match(found.forModel, /^1\. .*Γραμματεία ΜΠΣ <secretariat@nup\.ac\.cy> · Προθεσμία εργασίας \[Inbox, me@sch\.gr, unread, 1 attachment\(s\)\]/)
    const read = await tools.run('mail_read', { choice: 1 })
    assert.match(read.forModel, /Attachments: Guide\.pdf/); assert.match(read.forModel, /Dear students, the deadline is 15 November/)
    assert.match((await tools.run('mail_read', { choice: 5 })).forModel, /No choice 5/)

    const waits = await tools.run('mail_needs_answer', {})
    assert.match(waits.forModel, /Προθεσμία/)
    assert.doesNotMatch(waits.forModel, /Σύλλογος/, 'answered since')
    assert.doesNotMatch(waits.forModel, /order shipped/, 'a no-reply sender needs no answer')
    assert.doesNotMatch(waits.forModel, /Old question/, 'older than a week')
    assert.match((await tools.run('mail_status')).forModel, /me@sch\.gr: 4 unread in the Inbox, 0 not yet saved here/)
    assert.equal((await tools.run('mail_search', { days: 3, folder: 'sent' })).forModel.split('\n').length, 1)

    assert.ok(['mail_status', 'mail_new', 'mail_important', 'mail_read'].every(n => MAIL_REPORT.includes(n) && SCHEMA.some(s => s.function.name === n)), 'the report uses only tools that exist')
    assert.match((await new Tools({}).run('mail_search', {})).forModel, /not set up/)
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('assistant: new mail, what is important, mail from a contact, and a mail to send that waits for the user\'s yes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailassist-'))
  try {
    const day = n => new Date(Date.now() - n * 86_400_000)
    const folders = { INBOX: { validity: 7, next: 4, msgs: {
      1: message('Πληρωμή λογαριασμού έως Παρασκευή', 'a', { date: day(1), from: { name: 'ΔΕΗ', address: 'noreply@dei.gr' } }),
      2: message('Καλημέρα', 'b', { date: day(1), body: 'Τι κάνεις;', from: { name: 'Μαρία', address: 'maria@x.gr' } }),
      3: message('Newsletter', 'c', { date: day(1), body: 'New shoes!', from: { name: 'Shop', address: 'news@shop.gr' } }) } },
      Drafts: { use: '\\Drafts', validity: 4, next: 1, msgs: {} } }
    folders.INBOX.msgs[3].flags.add('\\Seen')
    const c = memoryServer(folders), sent = []
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c, smtp: () => ({ async sendMail(m) { sent.push(m) }, close() {} }) })
    const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: {}, smtp: { host: 'h', port: 465, secure: true } }
    mail.saveAccounts([acc])
    await mail.headers(c, acc, 'Inbox', 'INBOX'); await mail.bodies(c, acc, 'Inbox', 'INBOX', { stop: false })
    const card = (name, address) => ({ info: { uid: name, formatted: name, emails: address ? [{ value: address }] : [], phones: [], related: [], categories: [] } })
    const contacts = { all: () => [card('Μαρία Κωνσταντίνου', 'maria@x.gr'), card('Νίκος Χωρίς Μέιλ', null)] }
    const tools = new Tools({ mail, contacts })
    mail.setAccount('me@sch.gr', { name: '  Masters  ' })
    assert.equal(mail.accounts()[0].name, 'Masters', 'an account named by the user')
    assert.match((await tools.run('mail_search', { account: 'masters', contact: 'Μαρία' })).forModel, /\[Inbox, Masters \(me@sch\.gr\)/)
    assert.match((await tools.run('mail_search', { account: 'Work' })).forModel, /No mail account called Work: the accounts are Masters/)

    const fresh = (await tools.run('mail_new', {})).forModel
    assert.match(fresh, /Πληρωμή/); assert.match(fresh, /Καλημέρα/); assert.doesNotMatch(fresh, /Newsletter/, 'read already')
    const important = (await tools.run('mail_important', {})).forModel
    assert.match(important, /Πληρωμή/, 'a payment to make, even from a no-reply sender')
    assert.match(important, /Καλημέρα/, 'a person waiting for an answer')
    assert.doesNotMatch(important, /Newsletter/)
    assert.match((await tools.run('mail_search', { contact: 'Μαρία' })).forModel, /^1\. .*Καλημέρα/)
    assert.match((await tools.run('mail_search', { contact: 'Νίκος' })).forModel, /No email address/)

    const r = await tools.run('mail_send', { to: ['Μαρία Κωνσταντίνου'], subject: 'Αύριο', text: 'Γεια σου Μαρία,\n\nτα λέμε αύριο.' })
    assert.equal(sent.length, 0, 'never sent by the model')
    assert.equal(r.send.to, 'Μαρία Κωνσταντίνου'); assert.match(r.forModel, /waits for the user's yes/)
    assert.deepEqual(r.send.draft.to, [{ name: 'Μαρία Κωνσταντίνου', address: 'maria@x.gr' }])
    assert.match(r.send.draft.html, /^<p>Γεια σου Μαρία,<\/p><p>τα λέμε αύριο\.<\/p>/)
    assert.equal(Object.keys(folders.Drafts.msgs).length, 1, 'kept as a draft on the server')
    await mail.send(r.send.draft) // what the Send button does
    assert.equal(sent.length, 1); assert.equal(Object.keys(folders.Drafts.msgs).length, 0, 'and the draft goes')
    assert.match((await tools.run('mail_send', { to: ['Νίκος Χωρίς Μέιλ'], text: 'x' })).forModel, /No email address for Νίκος/)
    tools.lists.mail = mail.list('Inbox').filter(e => e.subject === 'Καλημέρα')
    const reply = await tools.run('mail_send', { reply_to: 1, text: 'Καλημέρα!' })
    assert.equal(reply.send.subject, 'Re: Καλημέρα'); assert.deepEqual(reply.send.draft.to.map(x => x.address), ['secretariat@nup.ac.cy'], 'to the sender in the mail itself')
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('assistant: finds mail kept on this computer, deleted from the server too, by an attachment or the text, and copies it to Documents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailassist-local-'))
  try {
    const day = n => new Date(Date.now() - n * 86_400_000)
    const folders = { INBOX: { validity: 7, next: 3, msgs: {
      1: message('Τιμολόγιο Οκτωβρίου', 'inv', { attach: true, date: day(40), from: { name: 'ΔΕΗ', address: 'bills@dei.gr' } }),
      2: message('Καλημέρα', 'hi', { date: day(1), from: { name: 'Μαρία', address: 'maria@x.gr' }, body: 'Ο κωδικός της πόρτας είναι 4417.' }) } } }
    const c = memoryServer(folders)
    const mail = new Mail(dir, { secret: () => 'x', connect: () => c })
    mail.filesRoot = path.join(dir, 'Files')
    const acc = { id: 'me@sch.gr', address: 'me@sch.gr', server: {} }
    mail.saveAccounts([acc])
    await mail.headers(c, acc, 'Inbox', 'INBOX'); await mail.bodies(c, acc, 'Inbox', 'INBOX', { stop: false })
    delete folders.INBOX.msgs[1] // deleted from the server by mistake
    await mail.headers(c, acc, 'Inbox', 'INBOX')
    const tools = new Tools({ mail, allowed: () => true })

    assert.match((await tools.run('mail_search', { query: 'τιμολογιο' })).forModel, /No mail found/, 'the live view no longer has it')
    const found = await tools.run('mail_find_local', { attachment: 'guide' })
    assert.match(found.forModel, /^1\. .*ΔΕΗ <bills@dei\.gr> · Τιμολόγιο Οκτωβρίου .*files: Guide\.pdf · only on this computer/)
    assert.match((await tools.run('mail_find_local', { query: 'κωδικος πορτας' })).forModel, /Καλημέρα/, 'found in the whole text')
    assert.match((await tools.run('mail_find_local', { after: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10), query: 'τιμολογιο' })).forModel, /Nothing found/)

    await tools.run('mail_find_local', { from: 'ΔΕΗ' })
    const one = await tools.run('mail_export', { choice: 1, attachment: 'guide' })
    assert.match(one.forModel, /Copied the attachment Guide\.pdf to .*Documents\/Guide\.pdf/)
    const two = await tools.run('mail_export', { choice: 1, attachment: 'Guide.pdf' })
    assert.match(two.forModel, /Guide \(2\)\.pdf/, 'never over the first copy')
    assert.match((await tools.run('mail_export', { choice: 1 })).forModel, /Copied the whole mail to .*Τιμολόγιο Οκτωβρίου\.eml/)
    assert.match((await tools.run('mail_export', { choice: 1, attachment: 'xlsx' })).forModel, /No attachment like "xlsx"; this mail has: Guide\.pdf/)
    const docs = fs.readdirSync(path.join(dir, 'Files', 'Documents'))
    assert.equal(docs.length, 3); assert.ok(docs.includes('Guide.pdf') && docs.includes('Guide (2).pdf') && docs.some(n => n.endsWith('Τιμολόγιο Οκτωβρίου.eml')))
    assert.match((await new Tools({ mail, allowed: app => app !== 'mail' }).run('mail_find_local', {})).forModel, /switched AI Assist off for mail/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
