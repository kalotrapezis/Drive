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

    assert.ok(['mail_status', 'mail_needs_answer', 'mail_search', 'mail_read'].every(n => MAIL_REPORT.includes(n) && SCHEMA.some(s => s.function.name === n)), 'the report uses only tools that exist')
    assert.match((await new Tools({}).run('mail_search', {})).forModel, /not set up/)
    mail.index.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
