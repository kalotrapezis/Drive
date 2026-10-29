'use strict'
// AI Assist's tools on throwaway Files folders, through Tetra's own modules; the phone's AssistantTest cases where they meet.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Calendar } = require('../calendar')
const { Timers } = require('../timer')
const { Notes } = require('../notes')
const { Contacts } = require('../contacts')
const { Tools, Chat, Mistral, Bill, Meter, Sentences, terms, output } = require('../assistant')

const at = new Date(2026, 9, 29, 10, 0).getTime() // Thursday 29 Oct 2026, 10:00 local
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-'))
  const calendar = new Calendar(path.join(root, 'Calendar'), path.join(root, 'Trash'))
  fs.mkdirSync(path.join(root, 'Calendar', 'Personal'), { recursive: true })
  const contacts = new Contacts(path.join(root, 'Contacts'), path.join(root, 'Trash'))
  const changed = []
  let me = null
  const tools = new Tools({ calendar, timers: new Timers(path.join(root, 'Timer'), 'PC'), notes: new Notes(path.join(root, '.notes'), 'test'),
    contacts, files: { search: async q => [{ name: 'Report.pdf', path: `Docs/${q}-Report.pdf`, dir: false, mtime: 1 }] },
    now: () => at, changed: w => changed.push(w), me: () => me, setMe: u => { me = u } })
  return { tools, calendar, contacts, changed }
}

test('calendar: add, list, and the free times around what is there', async () => {
  const { tools, calendar, changed } = setup()
  assert.match((await tools.run('calendar_add', { title: 'Οδοντίατρος', start: '2026-10-30T12:00', place: 'Ερμού 10' })).forModel, /Added "Οδοντίατρος" on Fri 2026-10-30 12:00/)
  await tools.run('calendar_add', { title: 'Εκδρομή', start: '2026-10-31', all_day: true })
  const o = calendar.occurrences(new Date(2026, 9, 30).getTime(), new Date(2026, 10, 1).getTime())
  assert.deepEqual(o.map(x => [x.title, x.allDay, x.end - x.start]), [['Οδοντίατρος', false, 3_600_000], ['Εκδρομή', true, 86_400_000]])
  assert.deepEqual(o[0].alarms.map(a => a.seconds), [-1800]) // the editor's default reminders
  assert.equal((await tools.run('calendar_list', { from: '2026-10-30', to: '2026-10-31' })).forModel,
    'Fri 2026-10-30 12:00–13:00: Οδοντίατρος @ Ερμού 10\n2026-10-31 all day: Εκδρομή')
  assert.equal((await tools.run('calendar_free', { date: '2026-10-30', minutes: 120 })).forModel, 'Free on 2026-10-30: 08:00–12:00, 13:00–21:00')
  // today: from now on
  assert.equal((await tools.run('calendar_free', { date: '2026-10-29' })).forModel, 'Free on 2026-10-29: 10:00–21:00')
  assert.deepEqual(changed, ['calendar', 'calendar'])
})

test('timers: start, list, stop by number', async () => {
  const { tools } = setup()
  await tools.run('timer_start', { minutes: 5, label: 'μακαρόνια' })
  await tools.run('timer_start', { seconds: 90 })
  assert.equal((await tools.run('timer_list')).forModel, '1. timer: 1 min 30 s left, running\n2. μακαρόνια: 5 min 0 s left, running')
  assert.equal((await tools.run('timer_stop', { choice: 2 })).forModel, 'Stopped 1 timer(s).')
  assert.equal((await tools.run('timer_list')).forModel, '1. timer: 1 min 30 s left, running')
  assert.equal((await tools.run('timer_start', {})).forModel, 'Say how long.')
})

test('notes: a new note found by a word inside it, accents aside; a shopping list as a checklist', async () => {
  const { tools } = setup()
  await tools.run('note_new', { text: 'Να πάρω τηλέφωνο τον υδραυλικό\nγια τη βρύση' })
  await tools.run('shopping_list', { items: ['γάλα', ' ψωμί ', ''] })
  const r = await tools.run('notes_search', { query: 'βρυση' })
  assert.equal(r.forModel, '1. Να πάρω τηλέφωνο τον υδραυλικό: για τη βρύση')
  assert.equal((await tools.run('note_open', { choice: 1 })).go.note, r.choices[0].go.note)
  const list = tools.notes.list().find(n => n.noteType === 'CHECKLIST')
  assert.equal(list.title, 'Ψώνια')
  assert.deepEqual(list.checklistItems.map(i => [i.text, i.isChecked]), [['γάλα', false], ['ψωμί', false]])
  assert.match((await tools.run('notes_search', { query: 'ψωμι' })).forModel, /^1\. Ψώνια: ψωμί/)
})

test('contacts: by name, by what they do (κομμώτρια → Στέλλα κούρεμα), the default number, and relations on the user\'s card', async () => {
  const { tools, contacts } = setup()
  const me = contacts.save(null, { formatted: 'Θεολόγος Καλοτραπέζης', given: 'Θεολόγος', family: 'Καλοτραπέζης', phones: [{ label: 'Mobile', value: '6900000000' }] })
  contacts.save(null, { formatted: 'Στέλλα κούρεμα', phones: [{ label: 'Mobile', value: '6911111111' }] })
  contacts.save(null, { formatted: 'Μαρία Κωστοπούλου', phones: [{ label: 'Mobile', value: '6922222222' }, { label: 'Work', value: '2100000000' }], defaultPhone: '2100000000' })
  contacts.save(null, { formatted: 'Μαρία Νικολάου', phones: [{ label: 'Home', value: '2310000000' }] })

  assert.equal((await tools.run('contacts_find', { keywords: ['κομμωτ', 'κουρε', 'hair'] })).forModel, '1. Στέλλα κούρεμα')
  const two = await tools.run('contacts_find', { name: 'μαρια' })
  assert.equal(two.forModel, '1. Μαρία Κωστοπούλου\n2. Μαρία Νικολάου') // the model sees names, not numbers
  assert.equal(two.choices[0].call.number, '2100000000') // the default one, without asking which
  assert.equal((await tools.run('contact_call', { choice: 2 })).call.number, '2310000000')

  assert.match((await tools.run('relation_remember', { relation: 'sister', name: 'Μαρία Κωστοπούλου' })).forModel, /does not know which contact is the user/)
  assert.match((await tools.run('my_card', { name: 'Θεολόγος Καλοτραπέζης' })).forModel, /Saved/)
  assert.match((await tools.run('relation_remember', { relation: 'sister', name: 'Μαρία Κωστοπούλου' })).forModel, /is their Sister/)
  assert.match((await tools.run('relation_remember', { relation: 'κουμπάρος', name: 'Μαρία Νικολάου' })).forModel, /is their κουμπάρος/)
  assert.deepEqual(contacts.byUid(me).info.related, [{ label: 'Sister', value: 'Μαρία Κωστοπούλου' }, { label: 'κουμπάρος', value: 'Μαρία Νικολάου' }])
  assert.equal((await tools.run('contacts_find', { relation: 'Sister' })).forModel, '1. Μαρία Κωστοπούλου')
  // a custom relation's label is a keyword too ("πάρε τον κουμπάρο")
  assert.equal((await tools.run('contacts_find', { keywords: ['κουμπαρ'] })).forModel, '1. Μαρία Νικολάου')
  await tools.run('relation_forget', { relation: 'sister' })
  assert.deepEqual(contacts.byUid(me).info.related.map(r => r.label), ['κουμπάρος'])
})

test('files, maps, YouTube: what the window is to open, never done by the model', async () => {
  const { tools } = setup()
  assert.equal((await tools.run('files_find', { query: 'tax' })).forModel, '1. Docs/tax-Report.pdf')
  assert.equal((await tools.run('file_open', { choice: 1 })).open, 'Docs/tax-Report.pdf')
  assert.match((await tools.run('file_open', { choice: 4 })).forModel, /No choice 4/)
  assert.deepEqual((await tools.run('navigate', { place: 'Θεσσαλονίκη' })).go, { maps: 'Θεσσαλονίκη' })
  assert.deepEqual((await tools.run('youtube', { query: 'Χατζιδάκις' })).go, { youtube: 'Χατζιδάκις' })
  assert.match((await tools.run('rm_rf', {})).forModel, /No tool called/)
})

/** A fetch that answers each request with the next of [answers]: an object as JSON, or an array of SSE data lines. */
function fakeFetch(answers, seen = []) {
  return async (url, init) => {
    seen.push({ url, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const a = answers.shift()
    if (Array.isArray(a)) {
      const text = a.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n'
      const bytes = new TextEncoder().encode(text)
      return { ok: true, status: 200, body: [bytes.slice(0, 7), bytes.slice(7)] } // cut mid-line, as the network does
    }
    return { ok: a.status == null, status: a.status ?? 200, json: async () => a, text: async () => JSON.stringify(a) }
  }
}

test('a turn: the model asks for a tool in streamed pieces, Tetra runs it, the answer streams back and is billed', async () => {
  const { tools } = setup()
  const seen = [], spent = []
  const api = new Mistral({ key: () => 'k', bill: new Bill(x => spent.push(x)), fetch: fakeFetch([
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'timer_start', arguments: '{"minu' } }] } }] },
     { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tes": 3}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 10 } }],
    [{ choices: [{ delta: { content: 'Ξεκίνησα ' } }] }, { choices: [{ delta: { content: 'χρονόμετρο 3 λεπτών.' } }], usage: { prompt_tokens: 1200, completion_tokens: 20 } }],
  ], seen) })
  const chat = new Chat(api, tools)
  let streamed = ''
  const r = await chat.ask('βάλε χρονόμετρο τρία λεπτά', w => { streamed += w })
  assert.equal(r.text, 'Ξεκίνησα χρονόμετρο 3 λεπτών.')
  assert.equal(streamed, r.text)
  assert.equal(tools.timers.active(at)[0].seconds, 180)
  assert.deepEqual(seen[1].body.messages.slice(-2).map(m => m.role), ['assistant', 'tool'])
  assert.equal(seen[1].body.messages.at(-1).content, 'Started a timer of 3 min 0 s.')
  assert.ok(Math.abs(chat.bill.usd - (1000 * 0.1 + 10 * 0.3 + 1200 * 0.1 + 20 * 0.3) / 1e6) < 1e-12)
  assert.equal(spent.length, 2)
})

test('a wrong key says so in words; a missing key never reaches the network', async () => {
  const api = new Mistral({ key: () => 'bad', fetch: fakeFetch([{ status: 401 }]) })
  await assert.rejects(api.chat([], []), /key|κλειδί/i)
  await assert.rejects(new Mistral({ key: () => null, fetch: () => assert.fail() }).chat([], []))
})

test('web search and pictures: the Conversations API\'s outputs read', () => {
  const r = output([{ type: 'message.output', content: [{ type: 'text', text: 'Ανοίγει 9:00.' }, { type: 'tool_reference', title: 'Site', url: 'https://x.gr' }, { type: 'tool_file', file_id: 'f1' }] }])
  assert.deepEqual(r, { text: 'Ανοίγει 9:00.', sources: ['Site — https://x.gr'], files: ['f1'] })
})

test('sentences for the voice: cut at a stop with room before it, "3.5" and "κ. Νίκος" kept whole', () => {
  const s = new Sentences()
  assert.deepEqual(s.push('Ναι. Ο κ. Νίκος έρχεται'), [])
  assert.deepEqual(s.push(' στις 3.5 το απόγευμα. Μετά'), ['Ναι. Ο κ. Νίκος έρχεται στις 3.5 το απόγευμα.'])
  assert.equal(s.rest(), 'Μετά')
})

test('the money counter: a trip meter that resets, a total that never does, past trips kept', () => {
  const m = Meter.of(null, 100)
  m.add(0.5); m.reset(200); m.add(0.25)
  const back = Meter.of(m.json())
  assert.deepEqual([back.total, back.trip, back.since, back.past], [0.75, 0.25, 200, [{ from: 100, to: 200, usd: 0.5 }]])
  assert.deepEqual(terms('Καλοτραπέζης, Tetra,, Tetra', ['Στέλλα']), ['Καλοτραπέζης', 'Tetra', 'Στέλλα'])
  assert.equal(Bill.text(0.01234), '$0.0123')
})
