'use strict'
// The same files and the same answers as the phone's CalendarTest (Drive-Android), so the two engines agree.
process.env.TZ = 'Europe/Athens'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Calendar, unzip, zip } = require('../calendar')

const local = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Athens' }).slice(0, 16).replace(' ', 'T')
const at = s => new Date(s + ':00+03:00').getTime() // October dates; November ones say +02:00
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-'))
  const root = path.join(tmp, 'Calendar')
  const cal = new Calendar(root, path.join(tmp, 'Trash'))
  cal.newCalendar('Work', '#33B679')
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures', 'calendar'))) fs.copyFileSync(path.join(__dirname, 'fixtures', 'calendar', f), path.join(root, 'Work', f))
  return { tmp, root, cal }
}
const staff = (cal, from, to) => cal.occurrences(from, to).filter(o => o.uid.startsWith('staff'))

test('calendar: Google weekly meeting, a day off and a day moved; a third Tuesday; a birthday reminded three days at 9', () => {
  const { tmp, cal } = setup()
  try {
    assert.deepEqual(cal.calendars(), [{ id: 'Work', name: 'Work', color: '#33B679' }])
    const s = staff(cal, at('2026-10-01T00:00'), new Date('2026-12-01T00:00+02:00').getTime())
    assert.deepEqual(s.map(o => local(o.start)), ['2026-10-06T10:00', '2026-10-13T10:00', '2026-10-27T12:00', '2026-11-03T10:00', '2026-11-10T10:00'])
    assert.equal(s[2].title, 'Staff meeting (moved)')
    assert.equal(s[0].place, 'Room 2, first floor')
    assert.equal(s[0].notes, 'Agenda:\n1. Timetable\n2. Trips')
    assert.deepEqual(staff(cal, new Date('2026-11-01T00:00+02:00').getTime(), new Date('2027-01-01T00:00+02:00').getTime()).map(o => local(o.start)), ['2026-11-03T10:00', '2026-11-10T10:00'])
    const council = cal.occurrences(at('2026-10-01T00:00'), new Date('2027-03-01T00:00+02:00').getTime()).filter(o => o.uid === 'parents-council')
    assert.deepEqual(council.map(o => local(o.start)), ['2026-10-20T18:00', '2026-11-17T18:00', '2026-12-15T18:00'])
    assert.equal((council[0].end - council[0].start) / 60000, 90)
    const b = cal.occurrences(new Date('2027-03-01T00:00+02:00').getTime(), new Date('2027-04-01T00:00+03:00').getTime()).find(o => o.uid === 'mum-birthday-2026')
    assert.equal(b.allDay, true); assert.equal(b.startDate, '2027-03-12'); assert.equal(b.endDate, '2027-03-13')
    const r = cal.reminders(new Date('2027-03-08T00:00+02:00').getTime(), new Date('2027-03-12T00:00+02:00').getTime()).filter(x => x.title === "Mum's birthday")
    assert.deepEqual(r.map(x => local(x.at)), ['2027-03-09T09:00', '2027-03-10T09:00', '2027-03-11T09:00'])
    const d = cal.occurrences(at('2026-10-20T00:00'), at('2026-10-21T00:00')).find(o => o.title === 'Dentist')
    assert.equal(local(d.start), '2026-10-20T09:30')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('calendar: an edit keeps every other line; one day moved then deleted; this and following', () => {
  const { tmp, root, cal } = setup()
  try {
    const rel = 'Work/staff-meeting.ics'
    cal.save(rel, 'Work', { title: 'Staff meeting, Room 4', place: 'Room 2, first floor', notes: '', allDay: false,
      start: { date: '2026-10-06', time: '10:00' }, end: { date: '2026-10-06', time: '11:00' } })
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    assert.match(text, /X-GOOGLE-CONFERENCE:https:\/\/meet\.google\.com\/abc-defg-hij/)
    assert.match(text, /RECURRENCE-ID;TZID=Europe\/Athens:20261027T100000/)
    assert.match(text, /RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6/)
    assert.ok(text.split('\r\n').every(l => Buffer.byteLength(l) <= 75))
    assert.match(text.replace(/\r\n /g, ''), /CN=Θεολόγος Καλοτραπέζης/)
    const all = () => staff(cal, at('2026-10-01T00:00'), new Date('2026-12-01T00:00+02:00').getTime())
    assert.equal(all()[0].title, 'Staff meeting, Room 4')
    const nov3 = new Date('2026-11-03T10:00+02:00').getTime()
    cal.saveDay(rel, nov3, { title: 'In the library', allDay: false, start: { date: '2026-11-03', time: '13:00' }, end: { date: '2026-11-03', time: '14:00' } })
    assert.deepEqual(all().map(o => local(o.start)), ['2026-10-06T10:00', '2026-10-13T10:00', '2026-10-27T12:00', '2026-11-03T13:00', '2026-11-10T10:00'])
    cal.skipDay(rel, nov3)
    assert.deepEqual(all().map(o => local(o.start)), ['2026-10-06T10:00', '2026-10-13T10:00', '2026-10-27T12:00', '2026-11-10T10:00'])
    cal.endBefore(rel, new Date('2026-10-27T10:00+02:00').getTime())
    assert.deepEqual(all().map(o => local(o.start)), ['2026-10-06T10:00', '2026-10-13T10:00'])
    assert.match(fs.readFileSync(path.join(root, rel), 'utf8'), /UNTIL=20261027T075959Z/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('calendar: a new event written and read back; a conflict shown once; Trash, never deleted', () => {
  const { tmp, root, cal } = setup()
  try {
    const rel = cal.save(null, 'Work', { title: 'School trip; Delphi', place: 'Delphi', notes: 'Bring lunch,\nand water', allDay: true,
      start: { date: '2026-11-02' }, end: { date: '2026-11-03' }, alarms: [{ days: -3, seconds: 9 * 3600, repeat: 2, every: 86400 }] })
    assert.match(rel, /^Work\/school-trip-delphi-[0-9a-f]{8}\.ics$/)
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    assert.match(text, /DTSTART;VALUE=DATE:20261102/); assert.match(text, /DTEND;VALUE=DATE:20261104/); assert.match(text, /TRIGGER:-P2DT15H/)
    const o = cal.occurrences(new Date('2026-11-01T00:00+02:00').getTime(), new Date('2026-11-05T00:00+02:00').getTime()).find(x => x.file === rel)
    assert.equal(o.title, 'School trip; Delphi'); assert.equal(o.notes, 'Bring lunch,\nand water'); assert.equal(o.endDate, '2026-11-04')
    // the same event twice (sync's "(2)"): the newer shown, said so; Keep this one sends the other to the Trash
    fs.copyFileSync(path.join(root, 'Work/staff-meeting.ics'), path.join(root, 'Work/staff-meeting (2).ics'))
    cal.save('Work/staff-meeting (2).ics', 'Work', { title: 'Newer', allDay: false, start: { date: '2026-10-06', time: '10:00' }, end: { date: '2026-10-06', time: '11:00' } }, Date.parse('2026-10-18T10:00:00Z'))
    const shown = staff(cal, at('2026-10-06T00:00'), at('2026-10-07T00:00'))
    assert.equal(shown.length, 1); assert.equal(shown[0].title, 'Newer'); assert.equal(shown[0].versions, 2)
    cal.keep('Work/staff-meeting (2).ics')
    assert.ok(fs.existsSync(path.join(tmp, 'Trash', 'staff-meeting.ics')))
    cal.trash(rel)
    assert.ok(!fs.existsSync(path.join(root, rel)) && fs.readdirSync(path.join(tmp, 'Trash')).some(n => n.startsWith('school-trip')))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('calendar: Google export and Takeout zip imported, again without doubles; Export all and back', () => {
  const { tmp, cal } = setup()
  try {
    const file = path.join(__dirname, 'fixtures', 'takeout-greece.ics')
    const [inc] = Calendar.readImport(file)
    assert.equal(inc.name, 'School 2026-27')
    assert.deepEqual(cal.importInto(inc, inc.name), { added: 2, updated: 0 })
    assert.deepEqual(cal.importInto(Calendar.readImport(file)[0], inc.name), { added: 0, updated: 2 })
    const club = cal.occurrences(new Date('2026-11-01T00:00+02:00').getTime(), new Date('2026-11-21T00:00+02:00').getTime()).filter(o => o.uid === '4k1m8s@google.com')
    assert.deepEqual(club.map(o => local(o.start)), ['2026-11-06T09:00', '2026-11-13T11:00', '2026-11-20T09:00'])
    const z = path.join(tmp, 'takeout.zip')
    fs.writeFileSync(z, zip([{ name: 'Takeout/Calendar/School.ics', data: fs.readFileSync(file) }, { name: 'Takeout/Calendar/me.ics', data: fs.readFileSync(path.join(__dirname, 'fixtures', 'calendar', 'ai-style.ics')) }]))
    assert.deepEqual(Calendar.readImport(z).map(i => [i.name, i.events.size]), [['School 2026-27', 2], ['me', 1]])
    const back = unzip(cal.exportAll())
    assert.deepEqual(back.map(e => e.name), ['Calendar/School 2026-27.ics', 'Calendar/Work.ics'])
    const work = back[1].data.toString()
    assert.match(work, /X-WR-CALNAME:Work/); assert.match(work, /X-APPLE-CALENDAR-COLOR:#33B679/)
    assert.equal(Calendar.incoming(work, 'x').events.size, 4)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('calendar: two events of one title whose UIDs begin alike get two files (the user\'s import lost two, 18 Oct)', () => {
  const { tmp, root, cal } = setup()
  try {
    const ics = uid => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261018T000000Z\r\nSUMMARY:Lesson\r\nDTSTART:20261020T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    const long = '_60q30c1g60o30e1i60o4ac1g60rj8gpl88rj2c1h84s34h9g64o30c1g60o30c1g70o30c1g6ksk2e1n6sp3gc1g64o30c1g60o30c1g6os3achm6gpjcdi36l0j0d9m8l'
    const inc = Calendar.incoming(ics(long + '0@google.com') + ics(long + '1@google.com'), 'x')
    assert.deepEqual(cal.importInto(inc, 'Google'), { added: 2, updated: 0 })
    assert.equal(fs.readdirSync(path.join(root, 'Google')).filter(n => n.endsWith('.ics')).length, 2)
    assert.deepEqual(cal.importInto(inc, 'Google'), { added: 0, updated: 2 })
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('calendar: a school timetable is one weekly event, its holidays skipped; a birthday keeps its year', () => {
  const { tmp, cal } = setup()
  try {
    const ev = Calendar.schedule({ title: 'Lessons', days: ['MO', 'TU', 'WE', 'TH', 'FR'], at: '08:15', until: '13:30', from: '2026-09-01', to: '2027-06-26', skip: ['2026-10-28', '2026-12-25', '2026-12-26'] })
    assert.equal(ev.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270626T205959Z')
    assert.equal(ev.start.date, '2026-09-01')
    assert.equal(ev.exdates.length, 2) // the Saturday is no school day
    const rel = cal.save(null, 'Work', ev)
    const days = cal.occurrences(at('2026-10-26T00:00'), at('2026-10-31T00:00')).filter(o => o.file === rel).map(o => local(o.start))
    assert.deepEqual(days, ['2026-10-26T08:15', '2026-10-27T08:15', '2026-10-29T08:15', '2026-10-30T08:15'])
    const b = cal.save(null, 'Work', { title: "Maria's birthday", allDay: true, start: { date: '1980-03-12' }, end: { date: '1980-03-12' }, rrule: 'FREQ=YEARLY', alarms: [], extra: { 'X-TETRA-BIRTH-YEAR': 1980 } })
    const o = cal.occurrences(new Date('2027-03-01T00:00+02:00').getTime(), new Date('2027-04-01T00:00+03:00').getTime()).find(x => x.file === b)
    assert.equal(o.startDate, '2027-03-12'); assert.equal(o.birthYear, 1980)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
