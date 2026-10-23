'use strict'
// The same fixtures and the same answers as the phone's ContactsTest (Drive-Android), so the two engines agree.
process.env.TZ = 'Europe/Athens'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Contacts, readImport, info, nameOf, writeCard, cards } = require('../contacts')
const { Calendar, zip } = require('../calendar')

const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'contacts', n))
const read = n => readImport(fixture(n), n).map(info)
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-'))
  const calendar = new Calendar(path.join(tmp, 'Calendar'), path.join(tmp, 'Trash'))
  fs.mkdirSync(calendar.root, { recursive: true })
  return { tmp, calendar, contacts: new Contacts(path.join(tmp, 'Contacts'), path.join(tmp, 'Trash'), calendar) }
}

test('contacts: Samsung 2.1 — quoted-printable over lines, bare types, the inline photo', () => {
  const [eleni, plumber] = read('samsung-21.vcf')
  assert.equal(nameOf(eleni), 'Ελένη Δοκιμαστή')
  assert.deepEqual(eleni.phones, [{ label: 'Mobile', value: '+306900000001' }, { label: 'Home', value: '2310000001' }])
  assert.deepEqual(eleni.addresses[0].parts.slice(2, 7), ['Οδός Παραδείγματος 12', 'Δράμα', '', '66100', 'Ελλάδα'])
  assert.deepEqual(eleni.birthday, { year: 1985, month: 3, day: 14 })
  assert.equal(Buffer.from(eleni.photo, 'base64').length, 512)
  assert.deepEqual(plumber.phones, [{ label: 'Work', value: '+30 25210 00000' }])
})

test('contacts: Google 3.0 — custom labels, dates, related, labels and the star; Apple 1604 and vCard 4', () => {
  const [anna] = read('google-30.vcf')
  assert.deepEqual(anna.phones, [{ label: 'Mobile', value: '+30 690 000 0002' }, { label: 'Γιαγιά', value: '+30 2310 000002' }])
  assert.deepEqual(anna.birthday, { year: 1990, month: 5, day: 23 })
  assert.deepEqual(anna.dates, [{ label: 'Anniversary', value: '2015-06-12' }])
  assert.deepEqual(anna.related, [{ label: 'Spouse', value: 'Γιώργος' }])
  assert.equal(anna.note, 'Σημείωση, με κόμμα')
  assert.deepEqual(anna.categories, ['myContacts', 'Family', 'starred'])
  const [petros, dora] = read('apple-40.vcf')
  assert.deepEqual(petros.birthday, { year: null, month: 10, day: 23 })
  assert.deepEqual(dora.birthday, { year: null, month: 10, day: 23 })
  assert.equal(Buffer.from(dora.photo, 'base64').toString(), 'not really a jpeg')
  const [sofia, bakery] = read('google.csv')
  assert.equal(nameOf(sofia), 'Σοφία Υποθετική')
  assert.equal(sofia.phones.length, 3)
  assert.equal(nameOf(bakery), 'Tetra Bakery')
})

test('contacts: an edit changes only its lines; written again with no change, byte for byte', () => {
  const { tmp, contacts } = setup()
  try {
    assert.deepEqual(contacts.import(readImport(fixture('google-30.vcf'))), { added: 2, same: 0 })
    const anna = contacts.all().find(c => c.info.given === 'Άννα')
    const text = fs.readFileSync(anna.file, 'utf8')
    assert.ok(text.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'))
    assert.ok(text.includes('X-UNKNOWN-THING;X-PARAM=1:κάτι που δεν ξέρει το Tetra\r\n'))
    assert.equal(writeCard(cards(text)[0]), text)
    contacts.save(anna.info.uid, { ...anna.info, phones: [{ label: 'Mobile', value: '+30 690 999 9999' }] })
    const after = cards(fs.readFileSync(anna.file, 'utf8'))[0]
    const keep = l => l.filter(p => !p.name.endsWith('TEL') && p.name !== 'item1.X-ABLabel' && p.name !== 'REV').map(p => p.name + p.params + ':' + p.value)
    assert.deepEqual(keep(after), keep(anna.lines))
    // importing again: no doubles
    assert.deepEqual(contacts.import(readImport(fixture('google-30.vcf'))), { added: 0, same: 2 })
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('contacts: a new contact is the phone\'s plain vCard 3.0; sync\'s copies show as one; the Trash keeps the file', () => {
  const { tmp, contacts } = setup()
  try {
    const uid = contacts.save(null, { given: 'Νέα', family: 'Επαφή', phones: [{ label: 'Mobile', value: '6900000009' }, { label: 'Κουμπάρος', value: '6900000010' }],
      emails: [{ label: 'Work', value: 'nea@example.com' }], birthday: { year: null, month: 1, day: 2 } }, Date.parse('2026-10-23T18:00:00Z'))
    const c = contacts.byUid(uid), text = fs.readFileSync(c.file, 'utf8')
    for (const l of ['N:Επαφή;Νέα;;;', 'FN:Νέα Επαφή', 'TEL;TYPE=CELL:6900000009', 'item1.TEL:6900000010', 'item1.X-ABLabel:Κουμπάρος',
      'EMAIL;TYPE=INTERNET,WORK:nea@example.com', 'BDAY:--01-02', 'REV:2026-10-23T18:00:00Z']) assert.ok(text.includes(l + '\r\n'), l)
    assert.match(path.basename(c.file), /^νέα-επαφή-[0-9a-f]{6}\.vcf$/)
    fs.copyFileSync(c.file, c.file.replace('.vcf', ' (2).vcf'))
    contacts.save(uid, { ...c.info, note: 'newer' }, Date.parse('2026-10-23T18:00:05Z'))
    const shown = contacts.all()
    assert.equal(shown.length, 1); assert.equal(shown[0].info.note, 'newer'); assert.equal(shown[0].versions, 2)
    contacts.trash(uid)
    assert.equal(contacts.all().length, 0)
    assert.equal(fs.readdirSync(path.join(tmp, 'Trash')).filter(n => n.endsWith('.vcf')).length, 2) // moved, never deleted
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('contacts: a birthday is a yearly event in Γενέθλια that follows the contact', () => {
  const { tmp, calendar, contacts } = setup()
  try {
    calendar.newCalendar('Γενέθλια', '#8E24AA')
    const uid = contacts.save(null, { given: 'Ελένη', family: 'Δοκιμαστή', birthday: { year: 1985, month: 3, day: 14 }, dates: [{ label: 'Anniversary', value: '2015-06-12' }] })
    let have = contacts.linked().get(uid)
    assert.equal(have.length, 2)
    const bday = have.find(f => f.master.title === 'Ελένη Δοκιμαστή'), text = fs.readFileSync(bday.file, 'utf8')
    for (const l of ['DTSTART;VALUE=DATE:19850314', 'RRULE:FREQ=YEARLY', `X-TETRA-CONTACT:${uid}`, 'X-TETRA-BIRTH-YEAR:1985', 'TRIGGER:PT9H', 'TRIGGER:-PT15H']) assert.ok(text.includes(l), l)
    assert.equal(path.basename(path.dirname(bday.file)), 'Γενέθλια')
    const c = contacts.byUid(uid)
    contacts.save(uid, { ...c.info, birthday: { year: null, month: 3, day: 15 }, dates: [] })
    have = contacts.linked().get(uid)
    assert.equal(have.length, 1)
    assert.equal(have[0].master.start.date.slice(5), '03-15')
    assert.ok(!fs.readFileSync(have[0].file, 'utf8').includes('X-TETRA-BIRTH-YEAR'))
    contacts.trash(uid)
    assert.equal(contacts.linked().get(uid), undefined)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('contacts: Takeout\'s folders become labels; merge keeps every value; not the same is remembered', () => {
  const { tmp, contacts } = setup()
  try {
    const z = zip([{ name: 'Takeout/Contacts/All Contacts/All Contacts.vcf', data: fixture('google-30.vcf') }, { name: 'Takeout/Contacts/School/School.vcf', data: fixture('google-30.vcf') }])
    const got = readImport(z).map(info)
    assert.equal(got.length, 2)
    assert.deepEqual(got.find(i => i.given === 'Άννα').categories, ['myContacts', 'Family', 'starred', 'School'])
    const a = contacts.save(null, { formatted: 'Μαρία Δοκιμή', phones: [{ label: 'Mobile', value: '+30 690 000 0011' }], categories: ['Family'] })
    const b = contacts.save(null, { formatted: 'Μαρία Δοκιμή', phones: [{ label: 'Mobile', value: '6900000011' }, { label: 'Work', value: '2521000011' }], birthday: { year: 1980, month: 2, day: 3 }, categories: ['School'] })
    const c = contacts.save(null, { formatted: 'Άλλος', phones: [{ label: 'Mobile', value: '6900000011' }] })
    assert.equal(contacts.pairs().length, 3)
    contacts.notTheSame(c, a); contacts.notTheSame(c, b)
    const [[x, y]] = contacts.pairs()
    contacts.merge(x.uid, y.uid)
    const m = contacts.all().find(k => k.info.formatted === 'Μαρία Δοκιμή').info
    assert.equal(m.phones.length, 2); assert.deepEqual(m.birthday, { year: 1980, month: 2, day: 3 }); assert.deepEqual(new Set(m.categories), new Set(['Family', 'School']))
    assert.equal(contacts.all().length, 2)
    assert.equal(cards(contacts.exportCards()).length, 2)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
