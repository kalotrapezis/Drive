'use strict'
// Tetra's Calendar on the computer (Drive-Android Plan.md § Calendar). The calendars are files, so Claude or a person
// can change them: Files/Calendar/<calendar>/color (#RRGGBB) and <calendar>/<event>.ics, one iCalendar file per event.
// Files sync carries them; this reads and writes them the way the phone's Calendar.kt does, line for line kept.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')

const PALETTE = ['#E91E63', '#D50000', '#E67C73', '#F4511E', '#F6BF26', '#33B679', '#0B8043', '#039BE5', '#3F51B5', '#7986CB', '#8E24AA', '#616161']
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

// ——— content lines: NAME;PARAMS:VALUE, kept as written ———

function colonAt(line) {
  let q = false
  for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ':' && !q) return i }
  return -1
}

function parse(text) {
  const top = [], stack = []
  for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    if (!line.trim()) continue
    const c = colonAt(line)
    if (c < 0) continue
    const head = line.slice(0, c), value = line.slice(c + 1)
    const semi = head.indexOf(';') < 0 ? head.length : head.indexOf(';')
    const name = head.slice(0, semi).toUpperCase()
    if (name === 'BEGIN') { const comp = { name: value.trim().toUpperCase(), items: [] }; (stack.length ? stack[stack.length - 1].items : top).push(comp); stack.push(comp) }
    else if (name === 'END') stack.pop()
    else if (stack.length) stack[stack.length - 1].items.push({ name, params: head.slice(semi), value })
  }
  return top
}

function fold(line) {
  let out = '', bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > 75) { out += '\r\n '; bytes = 1 }
    out += ch; bytes += n
  }
  return out + '\r\n'
}

function write(comps) {
  let s = ''
  const comp = c => { s += fold('BEGIN:' + c.name); for (const i of c.items) i.items ? comp(i) : (s += fold(i.name + i.params + ':' + i.value)); s += fold('END:' + c.name) }
  comps.forEach(comp)
  return s
}

const props = (c, n) => c.items.filter(i => !i.items && i.name === n)
const prop = (c, n) => props(c, n)[0]
const subs = (c, n) => c.items.filter(i => i.items && i.name === n)
function param(p, key) {
  for (const m of (p.params || '').matchAll(/;([^;=]+)=("[^"]*"|[^;]*)/g)) if (m[1].toUpperCase() === key) return m[2].replace(/^"|"$/g, '')
  return null
}
function setProp(c, n, value, params = '') {
  const at = c.items.findIndex(i => !i.items && i.name === n)
  c.items = c.items.filter(i => i.items || i.name !== n)
  if (value == null) return
  const p = { name: n, params, value }
  if (at >= 0) c.items.splice(Math.min(at, c.items.length), 0, p)
  else { const sub = c.items.findIndex(i => i.items); c.items.splice(sub < 0 ? c.items.length : sub, 0, p) }
}
const escape = s => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const unescape = s => s.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c)

// ——— time: a wall time in a zone ———

function zone(tzid) {
  if (!tzid) return LOCAL_ZONE
  const parts = tzid.replace(/^\/+/, '').split('/')
  for (let k = 0; k < parts.length; k++) {
    const id = parts.slice(k).join('/')
    try { new Intl.DateTimeFormat('en', { timeZone: id }); return id } catch {}
  }
  return LOCAL_ZONE
}

const fmtCache = new Map()
function offsetMs(ms, tz) {
  let f = fmtCache.get(tz)
  if (!f) fmtCache.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000
}
/** The instant a wall time in [tz] is (the later reading at a DST gap, as java.time). */
function instant(y, mo, d, h, mi, s, tz) {
  if (tz === 'UTC') return Date.UTC(y, mo - 1, d, h, mi, s)
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let t = guess - offsetMs(guess, tz)
  const again = guess - offsetMs(t, tz)
  if (again !== t) t = Math.max(t, again)
  return t
}
/** The wall time of an instant in [tz]: { y, mo, d, h, mi, s }. */
function wall(ms, tz) {
  const t = ms + (tz === 'UTC' ? 0 : offsetMs(ms, tz))
  const x = new Date(t)
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds() }
}
const pad = n => String(n).padStart(2, '0')
const dateKey = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`
const addDays = (key, n) => { const [y, mo, d] = key.split('-').map(Number); const x = new Date(Date.UTC(y, mo - 1, d + n)); return dateKey(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()) }
const weekday = key => (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7 // 0 = Monday

/** A DATE or DATE-TIME property: { date, h, mi, s, tz, allDay, ms } (all day: the device's midnight). */
function timeOf(p) {
  const v = p.value.trim().split(',')[0]
  const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8)
  if ((param(p, 'VALUE') || '').toUpperCase() === 'DATE' || v.length === 8)
    return { date: dateKey(y, mo, d), h: 0, mi: 0, s: 0, tz: LOCAL_ZONE, allDay: true, ms: instant(y, mo, d, 0, 0, 0, LOCAL_ZONE) }
  const h = +v.slice(9, 11), mi = +v.slice(11, 13), s = +v.slice(13, 15)
  const tz = /z$/i.test(v) ? 'UTC' : zone(param(p, 'TZID'))
  return { date: dateKey(y, mo, d), h, mi, s, tz, allDay: false, ms: instant(y, mo, d, h, mi, s, tz) }
}
function timeValue(t, allDay) {
  const w = wall(t.ms, t.tz)
  if (allDay) return [t.date.replace(/-/g, ''), ';VALUE=DATE']
  const v = `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`
  return t.tz === 'UTC' ? [v + 'Z', ''] : [v, ';TZID=' + t.tz]
}
/** An instant as a time in [tz] (for "the same clock, N days on"). */
function timeAt(ms, tz) { const w = wall(ms, tz); return { date: dateKey(w.y, w.mo, w.d), h: w.h, mi: w.mi, s: w.s, tz, ms } }
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
const stampNow = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')

function duration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim().toUpperCase())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1, g = i => +(m[i] || 0)
  return { days: sign * (g(2) * 7 + g(3)), seconds: sign * (g(4) * 3600 + g(5) * 60 + g(6)) }
}
function durationValue(days, seconds) {
  const t = days * 86400 + seconds, a = Math.abs(t)
  const d = Math.floor(a / 86400), h = Math.floor(a % 86400 / 3600), m = Math.floor(a % 3600 / 60), s = a % 60
  const time = (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '')
  return (t < 0 ? '-' : '') + 'P' + (d ? d + 'D' : '') + (time ? 'T' + time : (d ? '' : 'T0S'))
}
/** start + nominal days (the clock kept across a DST change) + seconds. */
function plus(t, days, seconds) {
  const [y, mo, d] = addDays(t.date, days).split('-').map(Number)
  return instant(y, mo, d, t.h, t.mi, t.s, t.tz) + seconds * 1000
}

// ——— events ———

function eventOf(c) {
  const ds = prop(c, 'DTSTART')
  if (!ds) return null
  const start = timeOf(ds)
  let end = prop(c, 'DTEND') ? timeOf(prop(c, 'DTEND')) : null
  if (!end && prop(c, 'DURATION')) { const du = duration(prop(c, 'DURATION').value); if (du) { const ms = plus(start, du.days, du.seconds); end = { ...start, ms, date: start.allDay ? addDays(start.date, du.days) : start.date } } }
  if (!end || end.ms <= start.ms) end = start.allDay ? { ...start, date: addDays(start.date, 1), ms: plus(start, 1, 0) } : { ...start }
  const text = n => prop(c, n) ? unescape(prop(c, n).value) : ''
  const alarms = subs(c, 'VALARM').map(a => {
    const tr = prop(a, 'TRIGGER')
    if (!tr) return null
    const repeat = +(prop(a, 'REPEAT')?.value || 0)
    const every = prop(a, 'DURATION') ? (d => d ? d.days * 86400 + d.seconds : 0)(duration(prop(a, 'DURATION').value)) : 0
    if ((param(tr, 'VALUE') || '').toUpperCase() === 'DATE-TIME') return { at: timeOf(tr).ms, days: 0, seconds: 0, repeat, every }
    const du = duration(tr.value)
    return du && { ...du, fromEnd: (param(tr, 'RELATED') || '').toUpperCase() === 'END', repeat, every }
  }).filter(Boolean)
  const exdates = props(c, 'EXDATE').flatMap(p => p.value.split(',').map(v => timeOf({ ...p, value: v }).ms))
  const mod = prop(c, 'LAST-MODIFIED') || prop(c, 'DTSTAMP')
  return {
    uid: text('UID').trim(), title: text('SUMMARY'), place: text('LOCATION'), notes: text('DESCRIPTION'), allDay: start.allDay, start, end,
    rrule: prop(c, 'RRULE')?.value.trim() || null, exdates, recurrenceId: prop(c, 'RECURRENCE-ID') ? timeOf(prop(c, 'RECURRENCE-ID')).ms : null,
    cancelled: text('STATUS').toUpperCase() === 'CANCELLED', alarms, modified: mod ? timeOf(mod).ms : 0,
  }
}

function readFile(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  const comps = parse(text)
  const events = comps.flatMap(c => c.name === 'VEVENT' ? [c] : subs(c, 'VEVENT')).map(eventOf).filter(Boolean)
  const master = events.find(e => e.recurrenceId == null) || null
  const overrides = events.filter(e => e.recurrenceId != null)
  let mtime = 0
  try { mtime = fs.statSync(file).mtimeMs } catch {}
  const mods = [master, ...overrides].filter(Boolean).map(e => e.modified).filter(Boolean)
  return { file, comps, master, overrides, uid: master?.uid || overrides[0]?.uid || path.basename(file, '.ics'), modified: mods.length ? Math.max(...mods) : mtime }
}

// ——— repeats (RFC 5545 RRULE), in the event's own clock ———

function monthLength(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate() }
function nthWeekdays(y, mo, code) {
  const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(code)
  if (!m) return []
  const wd = DAYS.indexOf(m[2]), last = monthLength(y, mo)
  const days = []
  for (let d = 1; d <= last; d++) if (weekday(dateKey(y, mo, d)) === wd) days.push(dateKey(y, mo, d))
  if (!m[1]) return days
  const n = +m[1]
  return n > 0 ? (days[n - 1] ? [days[n - 1]] : []) : (days[days.length + n] ? [days[days.length + n]] : [])
}

/** The starts (ms) of a repeating event from [from] until [to]. */
function instants(e, from, to) {
  if (!e.rrule) return [e.start.ms]
  const r = Object.fromEntries(e.rrule.toUpperCase().split(';').filter(p => p.includes('=')).map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  const freq = r.FREQ, step = +(r.INTERVAL || 1), count = r.COUNT ? +r.COUNT : null
  let until = null
  if (r.UNTIL) until = r.UNTIL.length > 8 ? timeOf({ params: '', value: r.UNTIL }).ms : instant(+r.UNTIL.slice(0, 4), +r.UNTIL.slice(4, 6), +r.UNTIL.slice(6, 8), 23, 59, 59, e.start.tz)
  const list = k => (r[k] || '').split(',').filter(Boolean)
  const byday = list('BYDAY'), bymd = list('BYMONTHDAY').map(Number), bymonth = list('BYMONTH').map(Number), setpos = list('BYSETPOS').map(Number)
  const s = e.start, [sy, smo, sd] = s.date.split('-').map(Number)
  const monthDays = (y, mo) => {
    const last = monthLength(y, mo)
    if (bymd.length) return bymd.filter(d => d && Math.abs(d) <= last).map(d => dateKey(y, mo, d > 0 ? d : last + 1 + d)).sort()
    if (byday.length) return [...new Set(byday.flatMap(c => nthWeekdays(y, mo, c)))].sort()
    return sd <= last ? [dateKey(y, mo, sd)] : []
  }
  const out = []
  let n = 0
  for (let k = 0; k < 200000; k++) {
    let cands
    if (freq === 'DAILY') cands = [addDays(s.date, k * step)].filter(d => (!byday.length || byday.includes(DAYS[weekday(d)])) && (!bymonth.length || bymonth.includes(+d.slice(5, 7))))
    else if (freq === 'WEEKLY') {
      const week = addDays(s.date, -weekday(s.date) + 7 * k * step)
      const wds = byday.length ? [...new Set(byday.map(c => DAYS.indexOf(c.slice(-2))))] : [weekday(s.date)]
      cands = wds.sort((a, b) => a - b).map(w => addDays(week, w))
    } else if (freq === 'MONTHLY') {
      const m0 = smo - 1 + k * step
      cands = monthDays(sy + Math.floor(m0 / 12), m0 % 12 + 1)
    } else if (freq === 'YEARLY') {
      const y = sy + k * step
      cands = (bymonth.length ? bymonth : [smo]).flatMap(mo => (byday.length || bymd.length) ? monthDays(y, mo) : (sd <= monthLength(y, mo) ? [dateKey(y, mo, sd)] : [])).sort()
    } else return [e.start.ms]
    if (setpos.length) cands = setpos.map(p => cands[p > 0 ? p - 1 : cands.length + p]).filter(Boolean)
    for (const d of cands) {
      if (d < s.date) continue
      const [y, mo, dd] = d.split('-').map(Number)
      const t = instant(y, mo, dd, s.h, s.mi, s.s, s.tz)
      if ((until != null && t > until) || (count != null && n >= count) || t >= to) return out
      n++
      if (t >= from) out.push(t)
    }
  }
  return out
}

/** A birthday's year, when it was given (X-TETRA-BIRTH-YEAR on the event): the age shows. */
function birthYear(f) {
  const m = f.comps.flatMap(c => c.name === 'VEVENT' ? [c] : subs(c, 'VEVENT')).find(x => !prop(x, 'RECURRENCE-ID'))
  return +(m && prop(m, 'X-TETRA-BIRTH-YEAR')?.value) || null
}

/** Each time a file's event happens in [from, to): { e (the master or a changed day), start, end } in ms. */
function occurrencesOf(f, from, to) {
  const out = []
  const add = (e, s, en) => { if (!e.cancelled && s < to && (en > from || s >= from)) out.push({ e, start: s, end: en }) }
  const m = f.master
  const moved = new Set(f.overrides.map(o => o.recurrenceId))
  if (m) {
    if (!m.rrule) add(m, m.start.ms, m.end.ms)
    else {
      const skip = new Set([...m.exdates, ...moved])
      for (const s of instants(m, from - (m.end.ms - m.start.ms), to)) if (!skip.has(s)) {
        // an all-day trip stays its days across a DST change
        const end = m.allDay ? plus(timeAt(s, m.start.tz), daysBetween(m.start.date, m.end.date), 0) : s + (m.end.ms - m.start.ms)
        add(m, s, end)
      }
    }
  }
  for (const o of f.overrides) add(o, o.start.ms, o.end.ms)
  return out.sort((a, b) => a.start - b.start)
}

function fireTimes(a, start, end, startT) {
  const first = a.at != null ? a.at : a.fromEnd ? end + (a.days * 86400 + a.seconds) * 1000 : plus(timeAt(start, startT.tz), a.days, a.seconds)
  return Array.from({ length: Math.min(a.repeat || 0, 100) + 1 }, (_, i) => first + i * (a.every || 0) * 1000)
}

// ——— a small zip (Takeout in, Export all out): stored or deflated entries, no zip64 ———

function unzip(buf) {
  const out = []
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('Not a zip file.')
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(data, data + size)
    if (!name.endsWith('/')) out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw })
    p += 46 + nameLen + extra + comment
  }
  return out
}
function crc32(buf) {
  let c = ~0
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) }
  return ~c >>> 0
}
function zip(entries) {
  const parts = [], central = []
  let offset = 0
  for (const { name, data } of entries) {
    const n = Buffer.from(name), crc = crc32(data), body = zlib.deflateRawSync(data)
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42)
    parts.push(head, n, body); central.push(cd, n)
    offset += 30 + n.length + body.length
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

// ——— the store ———

class Calendar {
  /** [root]: Files/Calendar; [trash]: Files/Trash (sync never deletes: a move into it crosses as a move). */
  constructor(root, trash) { this.root = root; this.trashDir = trash; this.cache = new Map() }

  calendars() {
    let names = []
    try { names = fs.readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name) } catch {}
    return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((name, i) => {
      const dir = path.join(this.root, name)
      let color = null, display = null
      try { color = fs.readFileSync(path.join(dir, 'color'), 'utf8').trim().slice(0, 7) } catch {}
      try { display = fs.readFileSync(path.join(dir, 'displayname'), 'utf8').trim() || null } catch {}
      return { id: name, name: display || name, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color.toUpperCase() : PALETTE[i % PALETTE.length] }
    })
  }

  dir(id) {
    const d = path.resolve(this.root, String(id))
    if (path.dirname(d) !== path.resolve(this.root)) throw new Error('Not a calendar.')
    return d
  }
  file(rel) {
    const f = path.resolve(this.root, String(rel))
    if (!f.startsWith(path.resolve(this.root) + path.sep) || !f.endsWith('.ics')) throw new Error('Not an event file.')
    return f
  }

  /** A calendar's event files, read again only when changed; the same event twice (a sync conflict): the newer, with versions. */
  files(id) {
    const dir = this.dir(id)
    let names = []
    try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.ics') && !n.startsWith('.')) } catch {}
    const read = names.map(n => {
      const file = path.join(dir, n)
      let st = null
      try { st = fs.statSync(file) } catch { return null }
      const hit = this.cache.get(file)
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.f
      const f = readFile(file)
      this.cache.set(file, { size: st.size, mtime: st.mtimeMs, f })
      return f
    }).filter(Boolean)
    const byUid = new Map()
    for (const f of read) byUid.set(f.uid, [...(byUid.get(f.uid) || []), f])
    return [...byUid.values()].map(same => { const f = same.reduce((a, b) => b.modified > a.modified ? b : a); return { ...f, versions: same.length } })
  }

  /** Every time the calendars' events happen in [from, to), for the screen: plain values only. */
  occurrences(from, to) {
    const out = []
    for (const cal of this.calendars()) for (const f of this.files(cal.id)) for (const o of occurrencesOf(f, from, to)) {
      const m = f.master
      out.push({
        calendar: cal.id, file: path.relative(this.root, f.file), versions: f.versions, uid: f.uid,
        title: o.e.title, place: o.e.place, notes: o.e.notes, allDay: o.e.allDay, start: o.start, end: o.end,
        day: o.e.recurrenceId ?? o.start, repeating: !!(m?.rrule) || o.e.recurrenceId != null,
        rrule: m?.rrule ?? null, startDate: o.e.allDay ? timeAt(o.start, o.e.start.tz).date : null,
        endDate: o.e.allDay ? timeAt(o.end, o.e.start.tz).date : null,
        alarms: o.e.alarms, zone: o.e.start.tz,
        birthYear: birthYear(f),
        masterStart: m ? m.start.ms : null, masterDate: m ? m.start.date : null, dayDate: timeAt(o.e.recurrenceId ?? o.start, (m || o.e).start.tz).date,
      })
    }
    return out.sort((a, b) => a.start - b.start)
  }

  /** The reminders that ring in [from, to): { at, title, start, end, allDay, place, calendar, key }. */
  reminders(from, to, lead = 120 * 86400000) {
    const out = []
    for (const cal of this.calendars()) for (const f of this.files(cal.id)) for (const o of occurrencesOf(f, from - 86400000, to + lead)) {
      o.e.alarms.forEach((a, i) => fireTimes(a, o.start, o.end, o.e.start).forEach((at, n) => {
        if (at >= from && at < to) out.push({ at, key: `${f.uid}|${o.start}|${i}|${n}`, title: o.e.title, start: o.start, end: o.end, allDay: o.e.allDay, place: o.e.place, calendar: cal.id })
      }))
    }
    return out.sort((a, b) => a.at - b.at)
  }

  // ——— writing ———

  rewrite(file, change) {
    const comps = parse(fs.readFileSync(file, 'utf8'))
    const cal = comps.find(c => c.name === 'VCALENDAR')
    if (!cal) throw new Error(path.basename(file) + ' is not an iCalendar file.')
    change(cal)
    this.put(file, write(comps))
  }
  put(file, text) {
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.part') // a dot file: sync passes it by
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }
  touch(v, now) {
    const st = stampNow(now)
    setProp(v, 'DTSTAMP', st); setProp(v, 'LAST-MODIFIED', st)
    setProp(v, 'SEQUENCE', String((+(prop(v, 'SEQUENCE')?.value || 0)) + 1))
  }

  /** The editor's event { uid, title, place, notes, allDay, start: { date, time }, end: { date, time }, rrule, alarms } as a time. */
  static when(x, allDay, tz = LOCAL_ZONE) {
    const [y, mo, d] = x.date.split('-').map(Number), [h, mi] = allDay ? [0, 0] : (x.time || '00:00').split(':').map(Number)
    return { date: x.date, h, mi, s: 0, tz, allDay, ms: instant(y, mo, d, h, mi, 0, tz) }
  }
  fill(v, ev, now, isNew) {
    const st = stampNow(now)
    setProp(v, 'UID', ev.uid); setProp(v, 'DTSTAMP', st); setProp(v, 'LAST-MODIFIED', st)
    setProp(v, 'SEQUENCE', isNew ? '0' : String((+(prop(v, 'SEQUENCE')?.value || 0)) + 1))
    setProp(v, 'SUMMARY', escape(ev.title || ''))
    const s = Calendar.when(ev.start, ev.allDay), e = Calendar.when(ev.allDay ? { date: addDays(ev.end.date, 1) } : ev.end, ev.allDay)
    const [sv, sp] = timeValue(s, ev.allDay); setProp(v, 'DTSTART', sv, sp)
    setProp(v, 'DURATION', null)
    const [ev2, ep] = timeValue(e.ms > s.ms ? e : { ...s, ms: s.ms + 3600000 }, ev.allDay); setProp(v, 'DTEND', ev2, ep)
    setProp(v, 'LOCATION', ev.place ? escape(ev.place) : null)
    setProp(v, 'DESCRIPTION', ev.notes ? escape(ev.notes) : null)
    setProp(v, 'RRULE', ev.rrule || null)
    if (ev.exdates) { // a schedule's skipped days: { date, time }, in the event's clock
      v.items = v.items.filter(i => i.items || i.name !== 'EXDATE')
      const sub = v.items.findIndex(i => i.items)
      v.items.splice(sub < 0 ? v.items.length : sub, 0, ...ev.exdates.map(x => { const [xv, xp] = timeValue(Calendar.when(x, ev.allDay), ev.allDay); return { name: 'EXDATE', params: xp, value: xv } }))
    }
    for (const [k, val] of Object.entries(ev.extra || {})) setProp(v, k, String(val)) // e.g. a birthday's X-TETRA-BIRTH-YEAR
    if (ev.alarms) {
      v.items = v.items.filter(i => !(i.items && i.name === 'VALARM'))
      for (const a of ev.alarms) {
        const items = [{ name: 'ACTION', params: '', value: 'DISPLAY' }, { name: 'DESCRIPTION', params: '', value: 'Reminder' }, { name: 'TRIGGER', params: '', value: durationValue(a.days, a.seconds) }]
        if (a.repeat > 0) items.push({ name: 'REPEAT', params: '', value: String(a.repeat) }, { name: 'DURATION', params: '', value: durationValue(0, a.every) })
        v.items.push({ name: 'VALARM', items })
      }
    }
  }

  /**
   * A weekly schedule (a school timetable) as one repeating event (the user, 18 Oct): its first day the first chosen
   * weekday from [from], until [to] inclusive (UTC, as RFC 5545 wants with a zone), [skip]'s school days as EXDATEs.
   * The phone's scheduleEvent, the same.
   */
  static schedule({ title, place = '', days, at, until, from, to, skip = [], tz = LOCAL_ZONE }) {
    let first = from
    for (let i = 0; i < 7 && !days.includes(DAYS[weekday(first)]); i++) first = addDays(first, 1)
    const [y, mo, d] = to.split('-').map(Number)
    const untilUtc = stampNow(instant(y, mo, d, 23, 59, 59, tz))
    const end = until > at ? until : `${String(Math.min(+at.slice(0, 2) + 1, 23)).padStart(2, '0')}${at.slice(2)}`
    return {
      title, place, notes: '', allDay: false, start: { date: first, time: at }, end: { date: first, time: end },
      rrule: `FREQ=WEEKLY;BYDAY=${DAYS.filter(c => days.includes(c)).join(',')};UNTIL=${untilUtc}`,
      exdates: [...new Set(skip)].sort().filter(x => x >= first && x <= to && days.includes(DAYS[weekday(x)])).map(date => ({ date, time: at })),
      alarms: [],
    }
  }

  scheduleEvent(args) { return Calendar.schedule(args) }

  /** A new event's name: its title and eight letters of its UID's hash (Google's UIDs of a series begin alike). */
  static slug(title, uid) {
    const s = (title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'event'
    return `${s}-${crypto.createHash('sha1').update(uid).digest('hex').slice(0, 8)}.ics`
  }
  /** A new event's file in [dir]: never another event's ("name (2)" when taken). */
  static freeFile(dir, title, uid) {
    const name = Calendar.slug(title, uid)
    let f = path.join(dir, name)
    for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, name.replace(/\.ics$/, ` (${n}).ics`))
    return f
  }

  /** A new event in [calendar], or [rel]'s event written over (every line the editor does not know kept). */
  save(rel, calendar, ev, now = Date.now()) {
    if (!rel) {
      const uid = ev.uid || crypto.randomUUID()
      const v = { name: 'VEVENT', items: [] }
      this.fill(v, { ...ev, uid }, now, true)
      const file = Calendar.freeFile(this.dir(calendar), ev.title, uid)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      this.put(file, write([{ name: 'VCALENDAR', items: [{ name: 'VERSION', params: '', value: '2.0' }, { name: 'PRODID', params: '', value: '-//Tetra//Calendar//EN' }, v] }]))
      return path.relative(this.root, file)
    }
    const file = this.file(rel)
    this.rewrite(file, cal => {
      const v = subs(cal, 'VEVENT').find(x => !prop(x, 'RECURRENCE-ID'))
      const uid = prop(v, 'UID')?.value || ev.uid
      this.fill(v, { ...ev, uid, rrule: ev.rrule === undefined ? prop(v, 'RRULE')?.value : ev.rrule }, now, false)
    })
    return calendar && path.dirname(rel) !== calendar ? this.move(rel, calendar) : rel
  }

  /** One day of a repeat changed: a VEVENT with its RECURRENCE-ID (ms of that day's start) in the same file. */
  saveDay(rel, day, ev, now = Date.now()) {
    const f = readFile(this.file(rel))
    this.rewrite(f.file, cal => {
      let v = subs(cal, 'VEVENT').find(x => prop(x, 'RECURRENCE-ID') && timeOf(prop(x, 'RECURRENCE-ID')).ms === day)
      const isNew = !v
      if (isNew) { v = { name: 'VEVENT', items: [] }; cal.items.push(v) }
      this.fill(v, { ...ev, uid: f.uid, rrule: null }, now, isNew)
      const [rv, rp] = timeValue(timeAt(day, f.master.start.tz), f.master.allDay)
      setProp(v, 'RECURRENCE-ID', rv, rp)
    })
  }
  skipDay(rel, day, now = Date.now()) {
    const f = readFile(this.file(rel))
    this.rewrite(f.file, cal => {
      cal.items = cal.items.filter(c => !(c.items && c.name === 'VEVENT' && prop(c, 'RECURRENCE-ID') && timeOf(prop(c, 'RECURRENCE-ID')).ms === day))
      const m = subs(cal, 'VEVENT').find(x => !prop(x, 'RECURRENCE-ID'))
      if (!m) return
      const [xv, xp] = timeValue(timeAt(day, f.master.start.tz), f.master.allDay)
      const sub = m.items.findIndex(i => i.items)
      m.items.splice(sub < 0 ? m.items.length : sub, 0, { name: 'EXDATE', params: xp, value: xv })
      this.touch(m, now)
    })
  }
  /** A repeat ended before [day]: "this and following" deleted, or split off by a new event after it. */
  endBefore(rel, day, now = Date.now()) {
    const f = readFile(this.file(rel))
    this.rewrite(f.file, cal => {
      const m = subs(cal, 'VEVENT').find(x => !prop(x, 'RECURRENCE-ID'))
      if (!m || !prop(m, 'RRULE')) return
      const until = f.master.allDay ? addDays(timeAt(day, f.master.start.tz).date, -1).replace(/-/g, '') : stampNow(day - 1000)
      setProp(m, 'RRULE', [...prop(m, 'RRULE').value.split(';').filter(p => !/^(UNTIL|COUNT)=/i.test(p)), 'UNTIL=' + until].join(';'))
      cal.items = cal.items.filter(c => !(c.items && c.name === 'VEVENT' && prop(c, 'RECURRENCE-ID') && timeOf(prop(c, 'RECURRENCE-ID')).ms >= day))
      this.touch(m, now)
    })
  }

  /** Into the Trash of Files (a name there already: "name (2)"); a calendar's folder too. */
  trash(rel) {
    const from = path.resolve(this.root, String(rel))
    if (!from.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Only the Calendar folder.')
    fs.mkdirSync(this.trashDir, { recursive: true })
    const ext = path.extname(from), base = path.basename(from, ext)
    let to = path.join(this.trashDir, base + ext)
    for (let n = 2; fs.existsSync(to); n++) to = path.join(this.trashDir, `${base} (${n})${ext}`)
    fs.renameSync(from, to)
    return to
  }
  move(rel, calendar) {
    const from = this.file(rel), dir = this.dir(calendar)
    const ext = path.extname(from), base = path.basename(from, ext)
    let to = path.join(dir, base + ext)
    for (let n = 2; fs.existsSync(to); n++) to = path.join(dir, `${base} (${n})${ext}`)
    fs.renameSync(from, to)
    return path.relative(this.root, to)
  }
  /** "Keep this one": the other files of the same event (sync's "(2)") to the Trash. */
  keep(rel) {
    const f = readFile(this.file(rel)), dir = path.dirname(f.file)
    for (const n of fs.readdirSync(dir)) {
      const other = path.join(dir, n)
      if (other !== f.file && n.endsWith('.ics') && !n.startsWith('.') && readFile(other).uid === f.uid) this.trash(path.relative(this.root, other))
    }
  }

  newCalendar(name, color) {
    const clean = String(name).trim().replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+/, '') || 'Calendar'
    const dir = path.join(this.root, clean)
    if (fs.existsSync(dir)) throw new Error(`A calendar named ${clean} already exists.`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'color'), (color || PALETTE[this.calendars().length % PALETTE.length]) + '\n')
    return clean
  }
  setCalendar(id, name, color) {
    const dir = this.dir(id)
    if (color) fs.writeFileSync(path.join(dir, 'color'), color.toUpperCase() + '\n')
    if (name && name !== id) {
      const to = this.dir(String(name).trim().replace(/[/\\:*?"<>|]/g, '-'))
      if (fs.existsSync(to)) throw new Error(`A calendar named ${name} already exists.`)
      fs.renameSync(dir, to)
      return path.basename(to)
    }
    return id
  }
  deleteCalendar(id) { return this.trash(path.basename(this.dir(id))) }

  // ——— import and export ———

  static incoming(text, fallback) {
    const cals = parse(text).filter(c => c.name === 'VCALENDAR')
    const events = new Map(), zones = new Map()
    for (const cal of cals) {
      for (const z of subs(cal, 'VTIMEZONE')) { const id = prop(z, 'TZID')?.value; if (id) zones.set(id, z) }
      for (const v of subs(cal, 'VEVENT')) {
        let uid = prop(v, 'UID')?.value.trim()
        if (!uid) { uid = 'import-' + crypto.createHash('sha1').update((prop(v, 'DTSTART')?.value || '') + '|' + (prop(v, 'SUMMARY')?.value || '')).digest('hex').slice(0, 8); setProp(v, 'UID', uid) }
        events.set(uid, [...(events.get(uid) || []), v])
      }
    }
    const name = cals.map(c => prop(c, 'X-WR-CALNAME')).find(Boolean)
    const color = cals.map(c => prop(c, 'X-APPLE-CALENDAR-COLOR') || prop(c, 'COLOR')).find(Boolean)?.value.trim().slice(0, 7)
    return { name: name ? unescape(name.value).trim() : fallback, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : null, events, zones }
  }
  /** An .ics or a zip of them (Google Takeout) read from [file]: the calendars in it, with their counts. */
  static readImport(file) {
    const buf = fs.readFileSync(file)
    if (buf[0] === 0x50 && buf[1] === 0x4b) return unzip(buf).filter(e => /\.ics$/i.test(e.name)).map(e => Calendar.incoming(e.data.toString('utf8'), path.basename(e.name).replace(/\.ics$/i, '')))
    return [Calendar.incoming(buf.toString('utf8'), path.basename(file).replace(/\.ics$/i, ''))]
  }
  /** Writes [inc] into calendar [id] (made if missing), one file per event, the same UID replaced: { added, updated }. */
  importInto(inc, id) {
    if (!fs.existsSync(path.join(this.root, id))) this.newCalendar(id, inc.color)
    const dir = this.dir(id)
    const existing = new Map(this.files(id).map(f => [f.uid, f.file]))
    let added = 0, updated = 0
    for (const [uid, vevents] of inc.events) {
      const used = new Set()
      const walk = c => c.items.forEach(i => i.items ? walk(i) : (param(i, 'TZID') && used.add(param(i, 'TZID'))))
      vevents.forEach(walk)
      const items = [{ name: 'VERSION', params: '', value: '2.0' }, { name: 'PRODID', params: '', value: '-//Tetra//Calendar//EN' }, ...[...used].map(z => inc.zones.get(z)).filter(Boolean),
        ...vevents.slice().sort((a, b) => (prop(a, 'RECURRENCE-ID') ? 1 : 0) - (prop(b, 'RECURRENCE-ID') ? 1 : 0))]
      const title = vevents.map(v => prop(v, 'SUMMARY')).find(Boolean)
      const file = existing.get(uid) || Calendar.freeFile(dir, title ? unescape(title.value) : '', uid)
      fs.existsSync(file) ? updated++ : added++
      this.put(file, write([{ name: 'VCALENDAR', items }]))
    }
    return { added, updated }
  }
  /** A calendar as one .ics for other apps: its name, colour and every event (the zones' own VTIMEZONEs where files had them). */
  exportCalendar(id) {
    const cal = this.calendars().find(c => c.id === id)
    const zones = new Map(), events = []
    for (const f of this.files(id)) for (const c of f.comps) { for (const z of subs(c, 'VTIMEZONE')) zones.set(prop(z, 'TZID')?.value, z); events.push(...subs(c, 'VEVENT')) }
    // shortcut: no VTIMEZONE is made for a zone the files only name (Google and Thunderbird take IANA names); Tetra on the phone writes them.
    return write([{ name: 'VCALENDAR', items: [{ name: 'VERSION', params: '', value: '2.0' }, { name: 'PRODID', params: '', value: '-//Tetra//Calendar//EN' },
      { name: 'X-WR-CALNAME', params: '', value: escape(cal?.name || id) }, { name: 'X-APPLE-CALENDAR-COLOR', params: '', value: cal?.color || PALETTE[0] }, ...zones.values(), ...events] }])
  }
  exportAll() { return zip(this.calendars().map(c => ({ name: `Calendar/${c.name}.ics`, data: Buffer.from(this.exportCalendar(c.id)) }))) }
}

module.exports = { Calendar, PALETTE, parse, write, instants, timeOf, duration, durationValue, unzip, zip, LOCAL_ZONE }
