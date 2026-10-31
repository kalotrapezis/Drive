'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AiSwitch, APPS } = require('../ai')
const { Mistral, Live, Tools, Chat, TOOL_APP, SCHEMA } = require('../assistant')
const system = require('../system')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'))

test('ai: no choice yet is off, or on where a key is already set; the file is shared, an app not named is allowed', () => {
  const dir = tmp(), file = path.join(dir, 'ai.json')
  try {
    assert.equal(new AiSwitch(file).on(), false, 'a fresh install: off')
    assert.equal(new AiSwitch(file, { hasKey: () => true }).on(), true, 'a key already set: stays on')
    const s = new AiSwitch(file, { hasKey: () => true })
    fs.writeFileSync(file, JSON.stringify({ enabled: true, apps: { mail: false, photos: true } })) // as the phone writes it
    assert.equal(s.allows('mail'), false); assert.equal(s.allows('calendar'), true, 'not named: allowed')
    s.set({ apps: { calendar: false } })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual([saved.enabled, saved.apps.mail, saved.apps.calendar, saved.apps.photos], [true, false, false, true], 'the phone\'s own keys kept')
    s.set({ enabled: false })
    assert.equal(s.allows('notes'), false, 'off: no app')
    assert.ok(Object.values(TOOL_APP).every(a => APPS.includes(a)), 'every tool belongs to an app the switch knows')
    assert.ok(SCHEMA.every(f => TOOL_APP[f.function.name]), 'and every tool has its app')
    assert.equal(system.SHARED['AI Assist'], 'Assistant', 'synced as "AI Assist/ai.json"')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('ai: switched off, nothing is sent to the AI provider — no request, no live connection', async () => {
  let sent = 0, on = false
  const api = new Mistral({ key: () => 'k', fetch: async () => { sent++; return { ok: true, json: async () => ({}) } }, allowed: () => on })
  await assert.rejects(api.post('/chat/completions', {}), e => e.aiOff)
  await assert.rejects(api.request('/audio/voices'), e => e.aiOff)
  assert.equal(sent, 0)
  let opened = 0
  assert.throws(() => new Live({ key: 'k', allowed: () => on, WebSocketImpl: class { constructor() { opened++ } } }), e => e.aiOff)
  assert.equal(opened, 0)
  on = true
  await api.request('/audio/voices')
  assert.equal(sent, 1, 'on again: it goes')
})

test('ai: an app switched off is refused, and its tools are not even offered to the model', async () => {
  const off = new Set(['contacts', 'mail'])
  const notes = { list: () => [{ id: 'n', title: 'Ψώνια', content: 'γάλα', updatedAt: 1 }] }
  const contacts = { all: () => [{ info: { uid: 'm', formatted: 'Μαρία', emails: [{ value: 'maria@x.gr' }], phones: [{ value: '1' }], addresses: [], related: [], categories: [] } }] }
  const tools = new Tools({ notes, contacts, mail: { accounts: () => [] }, allowed: a => !off.has(a) })
  assert.match((await tools.run('contacts_find', { name: 'Μαρία' })).forModel, /switched AI Assist off for contacts/)
  assert.match((await tools.run('mail_new', {})).forModel, /switched AI Assist off for mail/)
  assert.match((await tools.run('notes_search', { query: 'γαλα' })).forModel, /Ψώνια/)
  assert.match((await tools.run('navigate', { contact: 'Μαρία' })).forModel, /No address/, 'maps cannot look a contact up either')
  const offered = tools.offered().map(s => s.function.name)
  assert.ok(!offered.some(n => TOOL_APP[n] === 'mail' || TOOL_APP[n] === 'contacts'))
  assert.ok(offered.includes('notes_search'))
  // and what the model is given in a real turn
  let given = null
  const chat = new Chat({ chat: async (messages, schema) => { given = schema.map(s => s.function.name); return { content: 'ok' } }, bill: { usd: 0, reset() {} } }, tools)
  await chat.ask('γεια')
  assert.ok(given.includes('notes_search') && !given.includes('mail_send'))
})
