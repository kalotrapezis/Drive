/*
 * AI Assist on the computer (Drive-Android Plan.md § Tetra Assistant; the phone's Assistant.kt is the spec, ported here).
 * What was said is written out by Mistral's Voxtral and sent with the conversation so far to mistral-small, which may call
 * Tetra's tools; the tools run here, on ~/Tetra/Files through the desktop's own modules (calendar.js, timer.js, notes.js,
 * files.js, contacts.js, maps.js), and hand back only what the model needs (names and titles, never a whole calendar,
 * contact list or note). A call waits for the user's own yes, heard by Tetra, never decided by the model. Web search and
 * pictures are Mistral's own tools, through its Conversations API (the chat API does not run them). The key stays in
 * this process: the window never sees it.
 */
const crypto = require('node:crypto')
const { t } = require('./i18n')
const { plain, nameOf } = require('./contacts')

const API = 'https://api.mistral.ai/v1'
const CHAT = 'mistral-small-latest'
const BUILT_IN = 'mistral-medium-latest' // the model Mistral's web search and image examples use
const TRANSCRIBE = 'voxtral-small-transcribe-3'
const REALTIME = 'voxtral-mini-transcribe-realtime-3'
const TTS = 'voxtral-mini-tts-3'
const RATE = 16000

// shortcut: Mistral's list prices in $ as published Oct 2026 (tools' from price tables, not Mistral's page); update when they change
const TOKENS = { [CHAT]: [0.1, 0.3], [BUILT_IN]: [0.4, 2.0] }
const PER_MINUTE = { [TRANSCRIBE]: 0.004, [REALTIME]: 0.006 }
const PER_CALL = { web_search: 0.03, image_generation: 0.10 }
const PER_CHAR = 0.016 / 1000 // voxtral-mini-tts-3: $0.016 a thousand characters

/** What a conversation has cost so far, in US dollars by Mistral's list prices; [counted] gets each cost too (the meter). */
class Bill {
  constructor(counted = () => {}) { this.usd = 0; this.counted = counted }
  add(x) { if (!(x > 0)) return; this.usd += x; this.counted(x) }
  reset() { this.usd = 0 }
  tokens(model, usage) { const p = TOKENS[model]; if (p && usage) this.add(((usage.prompt_tokens || 0) * p[0] + (usage.completion_tokens || 0) * p[1]) / 1e6) }
  minutes(model, seconds) { this.add((PER_MINUTE[model] || 0) * seconds / 60) }
  chars(text) { this.add(String(text).length * PER_CHAR) }
  /** "$0.0123": a cent's fractions while it is small. */
  static text(usd) { return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}` }
}

/** Every AI Assist cost, like a car's odometer and trip meter: total never goes back; reset starts a new trip and keeps the old in past. */
class Meter {
  constructor({ total = 0, trip = 0, since = Date.now(), past = [] } = {}) { Object.assign(this, { total, trip, since, past }) }
  add(x) { this.total += x; this.trip += x }
  reset(at = Date.now()) { this.past.unshift({ from: this.since, to: at, usd: this.trip }); this.trip = 0; this.since = at }
  json() { return JSON.stringify({ total: this.total, trip: this.trip, since: this.since, past: this.past }) }
  static of(json, now = Date.now()) { try { const o = JSON.parse(json); return new Meter({ ...o, since: o.since ?? now }) } catch { return new Meter({ since: now }) } }
}

/** A failure the window says in the user's words. */
const problem = status => new Error(status == null ? t('assistant.offline') : status === 401 ? t('assistant.badKey')
  : status === 429 ? t('assistant.busy') : t('assistant.server', { code: status }))

/** Voxtral's context_bias from My words (comma-separated) and the extra names: at most 100 terms, as Voxtral takes. */
const terms = (words, more = []) => [...new Set([...String(words || '').split(','), ...more].map(s => s.trim()).filter(Boolean))].slice(0, 100)

/** 16-bit mono PCM (16 kHz) as a WAV file. */
function wav(pcm) {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2)
  return b
}

/** Mistral's REST API; [key] answers the key at each request (a new one counts at once), [fetch] is the tests'. */
class Mistral {
  constructor({ key, bill = new Bill(), fetch = globalThis.fetch }) { Object.assign(this, { key, bill, fetch }) }

  async request(path, { body, type = 'application/json', signal } = {}) {
    const k = this.key()
    if (!k) throw new Error(t('assistant.noKey'))
    let r
    const go = () => this.fetch(API + path, { method: body == null ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${k}`, ...(type && body != null ? { 'Content-Type': type } : {}) }, body })
    // once more when the connection drops: Mistral closes a kept-alive one after a refusal, and the next request found it shut
    try { r = await go().catch(e => { if (e.name === 'AbortError') throw e; return go() }) } catch (e) { if (e.name === 'AbortError') throw e; throw problem(null) }
    if (!r.ok) { console.warn(`[assistant] Mistral ${path} answered ${r.status}`, (await r.text().catch(() => '')).slice(0, 300)); throw problem(r.status) }
    return r
  }
  async post(path, json) { return (await this.request(path, { body: JSON.stringify(json) })).json() }

  /** A server-sent stream, its data lines' JSON one at a time as they come. */
  async stream(path, json, each, signal) {
    const r = await this.request(path, { body: JSON.stringify(json), signal })
    const dec = new TextDecoder()
    let buf = ''
    const line = l => { const d = l.startsWith('data:') ? l.slice(5).trim() : ''; if (d.startsWith('{')) each(JSON.parse(d)) }
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let n
      while ((n = buf.indexOf('\n')) >= 0) { line(buf.slice(0, n).trim()); buf = buf.slice(n + 1) }
    }
    line(buf.trim())
  }

  /** One chat turn; with [onText] its words come as they are made, so the voice can start on the first sentence. */
  async chat(messages, tools, onText = null) {
    const body = { model: CHAT, messages, tools, tool_choice: 'auto', temperature: 0.2 }
    if (!onText) { const r = await this.post('/chat/completions', body); this.bill.tokens(CHAT, r.usage); return r.choices[0].message }
    let text = ''
    const calls = new Map()
    await this.stream('/chat/completions', { ...body, stream: true }, chunk => {
      if (chunk.usage) this.bill.tokens(CHAT, chunk.usage)
      const delta = chunk.choices?.[0]?.delta
      if (!delta) return
      const w = words(delta)
      if (w) { text += w; onText(w) }
      // a call comes whole or in pieces by its index: the pieces' arguments are joined
      for (const piece of delta.tool_calls ?? []) {
        const i = piece.index ?? calls.size
        const c = calls.get(i) ?? { type: 'function', function: { name: '', arguments: '' } }
        calls.set(i, c)
        if (piece.id) c.id = piece.id
        const f = piece.function ?? {}
        if (f.name) c.function.name = f.name
        if (typeof f.arguments === 'string') c.function.arguments += f.arguments
        else if (f.arguments && typeof f.arguments === 'object') c.function.arguments = JSON.stringify(f.arguments)
      }
    })
    return { role: 'assistant', content: text, ...(calls.size ? { tool_calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]) } : {}) }
  }

  /** One stateless turn of the Conversations API with one of Mistral's own tools (web_search, image_generation). */
  async conversation(inputs, tool, instructions) {
    const r = await this.post('/conversations', { model: BUILT_IN, inputs, instructions, store: false, tools: [{ type: tool }] })
    this.bill.tokens(BUILT_IN, r.usage); this.bill.add(PER_CALL[tool] || 0)
    return output(r.outputs ?? [])
  }

  /** Speech to text with Voxtral, in Greek, spelling [bias] as given (My words). */
  async transcribe(pcm, bias = []) {
    const f = new FormData()
    f.append('model', TRANSCRIBE); f.append('language', 'el')
    for (const x of bias) f.append('context_bias', x)
    f.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav')
    const r = await (await this.request('/audio/transcriptions', { body: f, type: null })).json()
    this.bill.minutes(TRANSCRIBE, pcm.length / RATE)
    return String(r.text || '').trim()
  }

  /** [text] read by Mistral's [voice], streamed: [audio] gets 24 kHz mono float samples as they are made. */
  async speech(voice, text, audio, signal) {
    await this.stream('/audio/speech', { model: TTS, input: text, voice_id: voice, response_format: 'pcm', stream: true }, d => {
      if (!d.audio_data) return
      const b = Buffer.from(d.audio_data, 'base64')
      audio(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4))))
    }, signal)
    this.bill.chars(text)
  }

  /** Mistral's preset voices as { id, name }, every page. */
  async voices() {
    const out = []
    for (let off = 0; ; off += 100) {
      const items = (await (await this.request(`/audio/voices?limit=100&offset=${off}`)).json()).items ?? []
      out.push(...items.map(v => ({ id: v.id, name: (v.name || v.id) + (v.languages?.length ? ` (${v.languages.join(', ')})` : '') })))
      if (items.length < 100) return out
    }
  }

  async download(fileId) { return Buffer.from(await (await this.request(`/files/${encodeURIComponent(fileId)}/content`)).arrayBuffer()) }
}

/** A message's text: a string, or Mistral's chunks (text pieces among others); spaces kept. */
function words(m) {
  const c = m?.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(k => k?.type === 'text').map(k => k.text ?? '').join('') : ''
}

/** A conversation's last answer: its text, the sources' titles and links, the files it made. */
function output(outputs) {
  let text = ''
  const sources = [], files = []
  for (const o of outputs) {
    if (o.type !== 'message.output') continue
    if (typeof o.content === 'string') text += o.content
    else for (const k of o.content ?? []) {
      if (k.type === 'text') text += k.text ?? ''
      else if (k.type === 'tool_reference') sources.push([k.title, k.url].filter(Boolean).join(' — '))
      else if (k.type === 'tool_file' && k.file_id) files.push(k.file_id)
    }
  }
  return { text: text.trim(), sources: [...new Set(sources.filter(Boolean))], files }
}

// ---- the tools ----

const fn = (name, description, required, properties = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const p = (type, description) => ({ type, description })
const CHOICE = { choice: p('integer', 'The number of the item in the list last shown (1 = the first).') }
const STRINGS = description => ({ type: 'array', items: { type: 'string' }, description })
const RELATION = 'Spouse, Partner, Mother, Father, Parent, Brother, Sister, Child, Friend, Assistant or Manager in English; any other in the user\'s own word (κουμπάρος).'
const RELATIONS = ['Spouse', 'Partner', 'Mother', 'Father', 'Parent', 'Brother', 'Sister', 'Child', 'Friend', 'Assistant', 'Manager']
const ONLY_ONE = new Set(['Spouse', 'Partner', 'Mother', 'Father', 'Assistant', 'Manager'])
const NO_ME = 'Tetra does not know which contact is the user. Ask the user for their own name as saved in Contacts, then call my_card, then try again.'

/** What the model may call, in Mistral's function-calling form. */
const SCHEMA = [
  fn('calendar_add', 'Add an event to the user\'s calendar.', ['title', 'start'], { title: p('string', 'The event\'s name, in the user\'s words.'),
    start: p('string', 'Local start, YYYY-MM-DDTHH:MM (a date alone when all_day).'), end: p('string', 'Local end, same form; leave out for one hour.'),
    all_day: p('boolean', 'A whole-day event.'), place: p('string', 'Where, if said.') }),
  fn('calendar_list', 'What is in the calendar from one day to another.', ['from'], { from: p('string', 'First day, YYYY-MM-DD.'), to: p('string', 'Last day, YYYY-MM-DD; leave out for one day.') }),
  fn('calendar_free', 'Free times on a day between 08:00 and 21:00.', ['date'], { date: p('string', 'YYYY-MM-DD.'), minutes: p('integer', 'How long the free time must be; 60 if not said.') }),
  fn('timer_start', 'Start a countdown timer in Tetra.', [], { minutes: p('integer', 'Minutes.'), seconds: p('integer', 'Seconds, besides the minutes.'), label: p('string', 'What it is for, if said.') }),
  fn('timer_list', 'The running and paused timers and the time left.', []),
  fn('timer_stop', 'Stop a timer from the last timer_list, or all of them.', [], { choice: p('integer', 'Its number in timer_list; leave out to stop all.') }),
  fn('notes_search', 'Find notes with some words anywhere in them; answers a numbered list of titles and the matching line.', ['query'], { query: p('string', 'Words to look for.') }),
  fn('note_open', 'Open a note from the last notes_search list in Tetra\'s Notes.', ['choice'], CHOICE),
  fn('note_new', 'Make a new text note with what the user dictates.', ['text'], { text: p('string', 'The note\'s text, as said.'), title: p('string', 'A title, only if the user gave one.') }),
  fn('shopping_list', 'Make a new checklist note (a shopping list).', ['items'], { title: p('string', 'The note\'s title; Ψώνια if not said.'), items: STRINGS('One entry per item.') }),
  fn('files_find', 'Find files in Tetra whose name contains some words; answers a numbered list.', ['query'], { query: p('string', 'Part of the file\'s name.') }),
  fn('file_open', 'Open a file from the last files_find list.', ['choice'], CHOICE),
  fn('contacts_find', 'Find the user\'s contacts by name, by their relation to the user ("my sister"), or by what they do (keywords); answers a numbered list of names (with the kind of number when one has several).', [],
    { name: p('string', 'The name as said.'), relation: p('string', RELATION),
      keywords: STRINGS('For a person known by a job or a role (η κομμώτρια, ο υδραυλικός): several related words and stems in Greek and English (κομμωτ, κουρε, κομμωτηριο, hair), looked for in names, companies, notes and labels.') }),
  fn('relation_remember', 'Save who someone is to the user ("Maria K. is my sister") on the user\'s own card in Contacts. No need to ask first.', ['relation', 'name'], { relation: p('string', RELATION), name: p('string', 'The contact\'s name.') }),
  fn('relation_forget', 'Forget a saved relation.', ['relation'], { relation: p('string', RELATION), name: p('string', 'Only this person, when several have the relation.') }),
  fn('my_card', 'Say which contact is the user themself, once, when a relation tool asks for it.', ['name'], { name: p('string', 'The user\'s own name as in Contacts.') }),
  fn('contact_call', 'Ask to call a contact from the last contacts_find list, on the user\'s phone. Tetra asks the user to confirm; it does not call by itself.', ['choice'], CHOICE),
  fn('navigate', 'Show a place in Tetra Maps (offline map on this computer), to plan the way there: a place, an address or a contact\'s saved address.', [],
    { place: p('string', 'A place, a town or an address ("Ερμού 10, Αθήνα").'), contact: p('string', 'A contact\'s name, to go to their address.') }),
  fn('youtube', 'Open YouTube in the browser on a search for a song or a video.', ['query'], { query: p('string', 'The song or video, with the artist if said.') }),
  fn('web_search', 'Search the web for current facts, news, opening hours, prices.', ['query'], { query: p('string', 'What to search for.') }),
  fn('make_image', 'Draw a picture from a description.', ['prompt'], { prompt: p('string', 'What the picture shows, in detail.') }),
]

const pad = n => String(n).padStart(2, '0')
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const shown = ms => { const d = new Date(ms); return `${WEEKDAY[d.getDay()]} ${dayKey(d)} ${hm(d)}` }
/** "2026-10-30T09:00" or "2026-10-30 09:00" → { date, time }; a date alone → { date }. */
function when(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(s ?? '').trim())
  if (!m) throw new Error(`Not a date: ${s}`)
  return { date: m[1], time: m[2] != null ? `${pad(+m[2])}:${m[3]}` : null }
}
const localMs = (date, time = '00:00') => { const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number); return new Date(y, mo - 1, d, h, mi).getTime() }
const addDays = (date, n) => dayKey(new Date(localMs(date) + n * 86400000 + 3 * 3600000)) // + 3 h: a day with a clock change stays that day

/**
 * The tools, each a thin bridge into Tetra's own code. [changed] says what was written ("calendar", "timer", "notes",
 * "contacts") so the window shows it and the devices are told; [search] and [image] are Mistral's tools. One per
 * conversation: the numbered lists it last showed are what "the first one" means.
 */
class Tools {
  constructor({ calendar, timers, notes, files, contacts, maps, now = () => Date.now(), changed = () => {}, search, image, me = () => null, setMe = () => {} }) {
    Object.assign(this, { calendar, timers, notes, files, contacts, maps, now, changed, search, image, me, setMe })
    this.lists = { contacts: [], files: [], notes: [], timers: [] }
  }

  async run(name, args = {}) {
    try {
      const f = this[name]
      if (!SCHEMA.some(s => s.function.name === name) || typeof f !== 'function') return { forModel: `No tool called ${name}.` }
      return await f.call(this, args)
    } catch (e) { return { forModel: `Failed: ${e.message}` } }
  }
  pick(list, args, use) { const n = Number(args.choice) || 0; return list[n - 1] ? use(list[n - 1]) : { forModel: `No choice ${n}: the last list had ${list.length}.` } }

  // ---- Calendar ----
  calendar_add(a) {
    const title = String(a.title || '').trim()
    if (!title) return { forModel: 'Say what the event is.' }
    const allDay = !!a.all_day, s = when(a.start)
    const start = { date: s.date, time: allDay ? null : s.time ?? '09:00' }
    const e = a.end ? when(a.end) : null
    // all-day ends are the last day itself (the editor's form); a timed one lasts an hour unless said
    const end = allDay ? { date: e?.date ?? s.date, time: null }
      : e?.time ? { date: e.date, time: e.time } : (x => ({ date: dayKey(x), time: hm(x) }))(new Date(localMs(start.date, start.time) + 3600000))
    let cal = this.calendar.calendars()[0]
    if (!cal) { this.calendar.newCalendar('Calendar'); cal = this.calendar.calendars()[0] }
    const alarms = [allDay ? { days: -1, seconds: 9 * 3600, repeat: 0, every: 0 } : { days: 0, seconds: -1800 }]
    this.calendar.save(null, cal.id, { title, place: String(a.place || '').trim(), notes: '', allDay, start, end, rrule: null, alarms })
    this.changed('calendar')
    return { forModel: `Added "${title}" on ${allDay ? start.date + ' (all day)' : shown(localMs(start.date, start.time))} to the calendar ${cal.name}.` }
  }

  calendar_list(a) {
    const from = when(a.from).date, to = a.to ? when(a.to).date : from
    const found = this.calendar.occurrences(localMs(from), localMs(addDays(to, 1)))
    if (!found.length) return { forModel: 'Nothing in the calendar then.' }
    return { forModel: found.slice(0, 30).map(o => (o.allDay ? `${o.startDate} all day` : `${shown(o.start)}–${hm(new Date(o.end))}`)
      + `: ${o.title}` + (o.place ? ` @ ${o.place}` : '')).join('\n') }
  }

  /** The free stretches of a day between 08:00 and 21:00 of at least [minutes]. */
  calendar_free(a) {
    const d = when(a.date).date, need = (Number(a.minutes) || 60) * 60000
    const dayStart = localMs(d, '08:00'), dayEnd = localMs(d, '21:00')
    const busy = this.calendar.occurrences(dayStart, dayEnd).filter(o => !o.allDay).map(o => [o.start, o.end]).sort((x, y) => x[0] - y[0])
    const free = []
    let at = Math.max(dayStart, dayKey(new Date(this.now())) === d ? this.now() : dayStart)
    for (const [s, e] of [...busy, [dayEnd, dayEnd]]) {
      if (s - at >= need) free.push(`${hm(new Date(at))}–${hm(new Date(s))}`)
      if (e > at) at = e
    }
    return { forModel: free.length ? `Free on ${d}: ${free.join(', ')}` : `No free time of that length on ${d}.` }
  }

  // ---- Timer ----
  timer_start(a) {
    const seconds = (Number(a.minutes) || 0) * 60 + (Number(a.seconds) || 0)
    if (seconds <= 0) return { forModel: 'Say how long.' }
    const label = String(a.label || '').trim()
    this.timers.start(seconds, this.now(), label)
    this.changed('timer')
    return { forModel: `Started a timer of ${Math.floor(seconds / 60)} min ${seconds % 60} s${label ? ` (${label})` : ''}.` }
  }
  timer_list() {
    const list = this.lists.timers = this.timers.active(this.now())
    if (!list.length) return { forModel: 'No timer is running.' }
    return { forModel: list.map((r, i) => `${i + 1}. ${r.label || 'timer'}: ${Math.floor(r.leftMs / 60000)} min ${Math.floor(r.leftMs / 1000) % 60} s left, ${r.state}`).join('\n') }
  }
  timer_stop(a) {
    const list = this.timers.active(this.now()), n = Number(a.choice) || 0
    const stop = n === 0 ? list : [list[n - 1]].filter(Boolean)
    if (!stop.length) return { forModel: 'No such timer is running.' }
    for (const r of stop) this.timers.change(r.id, 'stop', this.now())
    this.changed('timer')
    return { forModel: `Stopped ${stop.length} timer(s).` }
  }

  // ---- Notes ----
  // shortcut: reads every note whole for each search (the user: find what a note has inside); an index past a few thousand notes
  notes_search(a) {
    const q = plain(a.query)
    if (!q) return { forModel: 'Say what to look for.' }
    const lines = n => [n.title || '', ...String(n.content || '').split('\n'), ...(n.checklistItems ?? []).map(i => i.text)]
    const hits = this.notes.list().filter(n => !n.trashedAt && plain(lines(n).join('\n')).includes(q)).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 9)
    this.lists.notes = hits
    if (!hits.length) return { forModel: 'No note has that.' }
    const title = n => n.title || lines(n).find(l => l.trim())?.slice(0, 40) || '(untitled)'
    return { forModel: hits.map((n, i) => { const l = lines(n).slice(1).find(x => plain(x).includes(q))?.trim().slice(0, 80); return `${i + 1}. ${title(n)}${l ? `: ${l}` : ''}` }).join('\n'),
      choices: hits.map(n => ({ label: title(n), go: { note: n.id } })) }
  }
  note_open(a) { return this.pick(this.lists.notes, a, n => ({ forModel: 'Opened the note.', go: { note: n.id } })) }
  note_new(a) {
    const text = String(a.text || '').trim(), title = String(a.title || '').trim()
    if (!text) return { forModel: 'Say what the note says.' }
    const n = this.notes.create()
    this.notes.save(n.id, { title, content: text })
    this.changed('notes')
    return { forModel: 'Saved the note in Notes.', choices: [{ label: title || text.slice(0, 40), go: { note: n.id } }] }
  }
  shopping_list(a) {
    const items = (Array.isArray(a.items) ? a.items : []).map(s => String(s).trim()).filter(Boolean)
    if (!items.length) return { forModel: 'Say what goes on the list.' }
    const title = String(a.title || '').trim() || 'Ψώνια', at = this.now()
    const n = this.notes.create({ noteType: 'CHECKLIST' })
    this.notes.save(n.id, { title, checklistItems: items.map((text, i) => ({ id: crypto.randomUUID(), text, isChecked: false, order: i, originalOrder: i, createdAt: at, indentationLevel: 0 })) })
    this.changed('notes')
    return { forModel: `Made the list "${title}" with ${items.length} items in Notes.`, choices: [{ label: title, go: { note: n.id } }] }
  }

  // ---- Files ----
  async files_find(a) {
    const found = (await this.files.search(String(a.query || ''))).filter(i => !i.dir).sort((x, y) => y.mtime - x.mtime).slice(0, 8)
    this.lists.files = found
    if (!found.length) return { forModel: 'No file\'s name has that.' }
    return { forModel: found.map((f, i) => `${i + 1}. ${f.path}`).join('\n'), choices: found.map(f => ({ label: f.name, open: f.path })) }
  }
  file_open(a) { return this.pick(this.lists.files, a, f => ({ forModel: `Opened ${f.name}.`, open: f.path })) }

  // ---- Contacts ----
  all() { return this.contacts.all().map(c => ({ ...c.info, name: nameOf(c.info) })) }
  myCard() { const uid = this.me(); return uid ? this.contacts.all().find(c => c.info.uid === uid) ?? null : null }
  /** All a card says about who someone is, without accents: what keywords are looked for in. */
  about(i) { return plain([i.name, i.nickname, i.org, i.department, i.title, i.note, ...i.categories, ...i.related.flatMap(r => [r.label, r.value])].join('\n')) }
  /** The contacts a name means: the one with that very name, else those with all its words. */
  named(name) {
    const all = this.all(), q = plain(name)
    const exact = all.filter(i => plain(i.name) === q)
    if (exact.length) return exact
    const ws = q.split(/\s+/).filter(Boolean)
    return ws.length ? all.filter(i => { const hay = plain([i.name, i.nickname, i.org].join(' ')); return ws.every(w => hay.includes(w)) }).sort((x, y) => plain(x.name).localeCompare(plain(y.name))) : []
  }
  one(name, use) {
    const found = this.named(String(name || ''))
    if (!found.length) return { forModel: `No contact called ${name}.` }
    if (found.length > 1) return { forModel: `Several contacts match ${name}: ${found.slice(0, 9).map(i => i.name).join('; ')}. Ask which, then call again with the full name.` }
    return use(found[0])
  }
  /** Each match's name and the label of each of its numbers: the numbers themselves stay here. */
  contacts_find(a) {
    const relation = String(a.relation || '').trim(), same = (x, y) => plain(x) === plain(y)
    let found
    if (relation) {
      const card = this.myCard()
      if (!card) return { forModel: NO_ME }
      const names = card.info.related.filter(r => same(r.label, relation)).map(r => r.value)
      if (!names.length) return { forModel: `No ${relation} is saved on the user's card. Ask who it is, then relation_remember.` }
      found = [...new Set(names.flatMap(n => this.named(n)))].filter(i => i.phones.length)
      if (!found.length) return { forModel: `The user's ${relation} is ${names.join(', ')}, but no contact by that name has a phone number.` }
    } else {
      const keys = (Array.isArray(a.keywords) ? a.keywords : []).map(k => plain(k)).filter(k => k.length >= 3)
      const name = String(a.name || '').trim()
      if (!name && !keys.length) return { forModel: 'Say a name, a relation or some words.' }
      const byName = name ? this.named(name).filter(i => i.phones.length) : []
      // "η κομμώτρια": the words the model gives in anything the card says, and the user's own relations' labels
      found = byName.length ? byName : (() => {
        const mine = (this.myCard()?.info.related ?? []).filter(r => keys.some(k => plain(r.label).includes(k))).flatMap(r => this.named(r.value))
        const seen = new Set() // the user's own card holds every relation's label: never the one called
        return [...mine, ...this.all().filter(i => i.uid !== this.me() && keys.some(k => this.about(i).includes(k)))].filter(i => i.phones.length && !seen.has(i.uid) && seen.add(i.uid))
      })()
      found = found.sort((x, y) => plain(x.name).localeCompare(plain(y.name))).slice(0, 9)
    }
    // the number marked as the default is the one called, without asking (the user); all of them only when none is
    this.lists.contacts = found.flatMap(i => {
      const phones = i.phones.filter(x => x.value === i.defaultPhone).length ? i.phones.filter(x => x.value === i.defaultPhone) : i.phones
      return phones.map(x => ({ name: phones.length > 1 ? `${i.name} (${x.label || 'phone'})` : i.name, number: x.value }))
    })
    if (!this.lists.contacts.length) return { forModel: 'No contact like that with a phone number.' }
    return { forModel: this.lists.contacts.map((c, n) => `${n + 1}. ${c.name}`).join('\n'), choices: this.lists.contacts.map(c => ({ label: c.name, call: c })) }
  }
  contact_call(a) { return this.pick(this.lists.contacts, a, c => ({ forModel: `The call to ${c.name} waits for the user's yes (a button on the screen, or a spoken yes).`, call: c })) }
  my_card(a) { return this.one(a.name, i => { this.setMe(i.uid); return { forModel: `Saved: the user's own card is ${i.name}.` } }) }

  // Relations: on the user's own card, as Apple and Google write them (X-ABRELATEDNAMES with its X-ABLabel), so they sync and show in Contacts
  relation_remember(a) {
    const relation = String(a.relation || '').trim()
    if (!relation) return { forModel: 'Say the relation.' }
    const label = RELATIONS.find(r => plain(r) === plain(relation)) ?? relation
    const card = this.myCard()
    if (!card) return { forModel: NO_ME }
    return this.one(a.name, person => {
      const related = card.info.related, same = (x, y) => plain(x) === plain(y)
      if (related.some(r => same(r.label, label) && same(r.value, person.name))) return { forModel: `Already saved: ${person.name} is the user's ${label}.` }
      // a spouse or a mother is one; brothers, sisters, children and friends may be several
      const replaced = ONLY_ONE.has(label) || !RELATIONS.includes(label) ? related.filter(r => same(r.label, label)) : []
      this.contacts.save(card.info.uid, { ...card.info, related: [...related.filter(r => !replaced.includes(r)), { label, value: person.name }] })
      this.changed('contacts')
      return { forModel: `Saved on the user's card: ${person.name} is their ${label}.` + (replaced.length ? ` It replaced ${replaced.map(r => r.value).join(', ')}; tell the user.` : '') }
    })
  }
  relation_forget(a) {
    const relation = String(a.relation || '').trim(), name = plain(a.name)
    const card = this.myCard()
    if (!card) return { forModel: NO_ME }
    const gone = card.info.related.filter(r => plain(r.label) === plain(relation) && (!name || plain(r.value).includes(name)))
    if (!gone.length) return { forModel: `No ${relation} was saved.` }
    this.contacts.save(card.info.uid, { ...card.info, related: card.info.related.filter(r => !gone.includes(r)) })
    this.changed('contacts')
    return { forModel: `Forgot: ${gone.map(r => r.value).join(', ')} as the user's ${relation}.` }
  }

  // ---- Maps, YouTube ----
  // shortcut: opens Tetra Maps on a search for the place (the computer has no GPS to start directions from); Directions is a tap there
  navigate(a) {
    const contact = String(a.contact || '').trim()
    let where = String(a.place || '').trim()
    if (contact) {
      // a contact's address stays here: the model says whose, Tetra looks it up
      where = this.named(contact).map(i => i.addresses[0]?.parts.filter(Boolean).join(', ')).find(Boolean) ?? ''
      if (!where) return { forModel: `No address is saved for ${contact}.` }
    }
    if (!where) return { forModel: 'Say where to.' }
    return { forModel: `Tetra Maps is open on ${contact || where}; the user taps the place there for directions.`, go: { maps: where } }
  }
  youtube(a) { const q = String(a.query || '').trim(); return { forModel: `YouTube is open on a search for "${q}".`, go: { youtube: q } } }

  async web_search(a) { return { forModel: await this.search(String(a.query || '')) } }
  async make_image(a) { const f = await this.image(String(a.prompt || '')); return { forModel: `The picture is on the screen, saved as ${f.name} in Files › Assistant.`, image: f } }
}

const system = (now = new Date()) => `You are Tetra's AI Assist, on the user's Linux computer, inside the app Tetra (calendar, timers, notes, files, contacts, maps; the user's phone is paired with it).
Now: ${now.toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).
Answer in the user's language (usually Greek), in one or two short plain sentences: answers are often read aloud. No markdown.
Use the tools for anything about the user's own calendar, timers, notes, files or contacts; never invent what they hold.
When a search finds several, say how many and ask which one (the screen shows the numbered list); "the first", "η δεύτερη" mean that list's numbers.
A call is never placed by you: after contact_call say that the call waits for their yes; the phone dials it.
"My sister", "ο μπαμπάς μου", "η γυναίκα μου": contacts_find with that relation. When the user says who someone is to them, relation_remember it.
Someone known by a job or role ("πάρε την κομμώτρια"): contacts_find by relation, and if none, by keywords.
"Ψάξε στο internet", "google it", news, prices, opening hours, anything current: always web_search.
"Κλείσε ραντεβού" without a time: calendar_free first, offer two or three times, then calendar_add the one chosen.
"Πάμε εκεί", "βάλε προορισμό": navigate; "there" is the last place in this conversation; for a contact's home, navigate with contact.
A song or a video: youtube. "Κάνε σημείωση": note_new.
Work out dates yourself from today's date ("αύριο", "την Πέμπτη").`

const ROUNDS = 5 // tool rounds in one turn at most: find, then act, with room to spare

/** One conversation: the messages so far, until New chat. */
class Chat {
  constructor(api, tools, now = () => new Date()) { Object.assign(this, { api, tools, now }); this.messages = [] }
  get bill() { return this.api.bill }

  /** The user's [text] answered, the tools run on the way; [onText] gets the answer's words as they come. */
  async ask(text, onText = null) {
    this.messages.push({ role: 'user', content: text })
    const out = { text: '', choices: [], call: null, images: [], open: null, go: null }
    for (let round = 0; round < ROUNDS; round++) {
      const m = await this.api.chat([{ role: 'system', content: system(this.now()) }, ...this.messages], SCHEMA, onText)
      const calls = m.tool_calls ?? []
      this.messages.push({ role: 'assistant', content: m.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
      if (!calls.length) return { ...out, text: words(m).trim() }
      for (const c of calls) {
        let args = c.function.arguments
        if (typeof args === 'string') try { args = JSON.parse(args || '{}') } catch { args = {} }
        const r = await this.tools.run(c.function.name, args ?? {})
        if (r.choices?.length) out.choices = r.choices
        if (r.call) out.call = r.call
        if (r.image) out.images.push(r.image)
        if (r.open) out.open = r.open
        if (r.go) out.go = r.go
        this.messages.push({ role: 'tool', name: c.function.name, tool_call_id: c.id ?? '', content: r.forModel })
      }
    }
    return out
  }
  clear() { this.messages = []; this.bill.reset() }
}

/**
 * An answer coming a few words at a time, cut into sentences for the voice: each is read as soon as it ends. A cut needs a
 * stop and a space after it ("3.5" stays whole) and a dozen letters before it, so "κ. Νίκος" or "Ναι." do not go alone.
 */
class Sentences {
  constructor() { this.buf = '' }
  push(w) {
    this.buf += w
    const out = []
    for (;;) {
      const END = /[.!?;…·:]+\s+|\n+/g
      let m, cut = -1
      while ((m = END.exec(this.buf))) if (this.buf.slice(0, m.index).trim().length >= 12) { cut = m.index + m[0].length; break }
      if (cut < 0) return out
      out.push(this.buf.slice(0, cut).trim()); this.buf = this.buf.slice(cut)
    }
  }
  rest() { const r = this.buf.trim(); this.buf = ''; return r }
}

/**
 * Live: the window's microphone streamed to Voxtral realtime over a WebSocket that carries the key itself, so no server of
 * Tetra's own; Voxtral says when a turn ends, and the window hands it to the same chat and tools. While the window mutes
 * (thinking, reading the answer aloud) it sends silence, so Tetra does not hear itself and the stream stays open.
 */
class Live {
  constructor({ key, bias, pauseMs, heard, turn, failed, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { heard, turn, failed, open: true, text: '' })
    this.ws = new WebSocketImpl(`wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${REALTIME}`, { headers: { Authorization: `Bearer ${key}` } })
    this.ws.onmessage = m => { try { this.event(JSON.parse(String(m.data))) } catch (e) { console.warn('[assistant] live', e.message) } }
    this.ws.onerror = () => {}
    // a refused key and no internet look the same here (the handshake's status is not given): said as both
    this.ws.onclose = () => { if (this.open) { this.open = false; this.failed(new Error(t(this.ready ? 'assistant.liveLost' : 'assistant.liveFailed'))) } }
    this.session = { audio_format: { encoding: 'pcm_s16le', sample_rate: RATE }, language: 'el', context_bias: bias, target_streaming_delay_ms: 480,
      turn_detection: { min_silence_ms: pauseMs, end_timeout_ms: Math.max(3000, pauseMs + 1500) } }
    this.ready = false
  }
  event(e) {
    if (e.type === 'session.created') { this.ws.send(JSON.stringify({ type: 'session.update', session: this.session })); this.ready = true }
    else if (e.type === 'transcription.text.delta') { if (!this.muted) { this.text += e.text ?? ''; this.heard(this.text) } }
    else if (e.type === 'turn.end') { const said = this.text.trim(); this.text = ''; if (said && !this.muted) this.turn(said) }
    else if (e.type === 'error') { console.warn('[assistant] live', JSON.stringify(e).slice(0, 300)); if (this.open) { this.end(); this.failed(new Error(e.error?.message || 'Mistral')) } }
  }
  /** 16-bit PCM from the window (silence while muted); dropped until the session is set. */
  audio(bytes) { if (this.open && this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'input_audio.append', audio: Buffer.from(bytes).toString('base64') })) }
  /** While muted (thinking, speaking) nothing heard is a turn; unmuted, it starts afresh. */
  mute(on) { this.muted = !!on; this.text = '' }
  end() {
    if (!this.open) return
    this.open = false
    try { if (this.ws.readyState === 1) this.ws.send('{"type":"input_audio.end"}'); this.ws.close(1000) } catch {}
  }
}

module.exports = { Bill, Meter, Mistral, Tools, Chat, Sentences, Live, SCHEMA, system, terms, wav, output, words, RATE, REALTIME, TTS, PER_MINUTE, PER_CHAR }
