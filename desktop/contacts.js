'use strict'
// Tetra's Contacts on the computer (Drive-Android Plan.md § Contacts). One contact is one vCard 3.0 file in
// Files/Contacts, the phone's Contacts.kt rules line for line: read forgiving (2.1's QUOTED-PRINTABLE and CHARSET, 3.0,
// 4.0), written strict (CRLF, folded at 75 octets), a line Tetra does not read kept as it was, an edit changing only the
// lines of what changed; UID and REV; delete = a move into Files/Trash; sync's "(2)" copies shown as one. Birthdays and
// dates go into the chosen calendar as yearly events carrying X-TETRA-CONTACT (ContactsBirthdays on the phone).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { write: writeComps, unzip, Calendar } = require('./calendar')

// ——— content lines ———

const keyOf = p => p.name.slice(p.name.indexOf('.') + 1).toUpperCase()
const groupOf = p => (p.name.includes('.') ? p.name.slice(0, p.name.indexOf('.')) : '')
const escape = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const unescape = s => s.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c)
function splitParams(params) {
  const out = []
  let cur = '', q = false
  for (const ch of params) { if (ch === '"') q = !q; if (ch === ';' && !q) { if (cur) out.push(cur); cur = '' } else cur += ch }
  if (cur) out.push(cur)
  return out
}
function param(p, key) {
  for (const raw of splitParams(p.params)) { const eq = raw.indexOf('='); if (eq > 0 && raw.slice(0, eq).toUpperCase() === key) return raw.slice(eq + 1).replace(/^"|"$/g, '') }
  return null
}
function colonAt(line) {
  let q = false
  for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ':' && !q) return i }
  return -1
}

/** Unfolded lines: 2.1's quoted-printable soft breaks ("=" at the end) joined, then RFC folding (a leading space or tab). */
function logicalLines(text) {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < raw.length;) {
    let l = raw[i++]
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) { out[out.length - 1] += l.slice(1); continue }
    if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/i.test(l.split(':')[0])) while (l.endsWith('=') && i < raw.length) l = l.slice(0, -1) + raw[i++]
    out.push(l)
  }
  return out.filter(l => l.trim())
}

function quotedPrintable(s, charset) {
  const bytes = []
  for (let i = 0; i < s.length;) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 3 }
    else { bytes.push(...Buffer.from(s[i])); i++ }
  }
  try { return new TextDecoder(charset || 'utf-8').decode(Buffer.from(bytes)) } catch { return Buffer.from(bytes).toString('utf8') }
}

/** One line in 3.0's form; a line already in it comes back unchanged (a file's own lines are kept as they were). */
function normal(p) {
  const key = keyOf(p)
  if (key === 'VERSION') return { name: p.name, params: '', value: '3.0' }
  let value = p.value, changed = false, charset = 'utf-8', qp = false
  const kept = [], types = []
  for (const raw of splitParams(p.params)) {
    const eq = raw.indexOf('='), k = eq < 0 ? '' : raw.slice(0, eq).toUpperCase(), v = eq < 0 ? raw : raw.slice(eq + 1)
    if (eq < 0 && ['BASE64', 'B'].includes(raw.toUpperCase())) { kept.push('ENCODING=b'); changed = true }
    else if (eq < 0 && raw.toUpperCase() === 'QUOTED-PRINTABLE') { qp = true; changed = true }
    else if (eq < 0) { types.push(raw); changed = true } // 2.1's bare "CELL", "JPEG"
    else if (k === 'CHARSET') { charset = v.replace(/"/g, ''); changed = true }
    else if (k === 'ENCODING' && v.toUpperCase() === 'QUOTED-PRINTABLE') { qp = true; changed = true }
    else if (k === 'ENCODING' && v.toUpperCase() === 'BASE64') { kept.push('ENCODING=b'); changed = true }
    else kept.push(raw)
  }
  if (qp) value = quotedPrintable(value, charset)
  // vCard 4's photo as a data: link
  if (key === 'PHOTO' && /^data:/i.test(value) && /;base64,/i.test(value)) {
    const type = value.slice(value.indexOf('/') + 1, value.indexOf(';')).toUpperCase()
    return { name: p.name, params: `;ENCODING=b;TYPE=${type}`, value: value.slice(value.indexOf(',') + 1) }
  }
  if (!changed) return p
  if (types.length) kept.push('TYPE=' + types.join(','))
  return { name: p.name, params: kept.map(x => ';' + x).join(''), value }
}

/** Every card in a .vcf, its lines in 3.0's form. */
function cards(text) {
  const out = []
  let cur = null, depth = 0
  for (const line of logicalLines(text)) {
    const c = colonAt(line)
    if (c < 0) continue
    const head = line.slice(0, c), value = line.slice(c + 1)
    const semi = head.indexOf(';') < 0 ? head.length : head.indexOf(';')
    const name = head.slice(0, semi)
    if (name.toUpperCase() === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') { if (depth++ === 0) cur = [] }
    else if (name.toUpperCase() === 'END' && value.trim().toUpperCase() === 'VCARD') { if (--depth === 0) { if (cur) out.push(cur); cur = null }; depth = Math.max(depth, 0) }
    else if (depth === 1 && cur) cur.push(normal({ name, params: head.slice(semi), value }))
  }
  return out
}

/** A structured value's parts, each unescaped: N's five, ADR's seven, ORG's. */
function parts(value, sep = ';') {
  const out = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\' && i + 1 < value.length) { cur += c + value[++i]; continue }
    if (c === sep) { out.push(unescape(cur)); cur = '' } else cur += c
  }
  out.push(unescape(cur))
  return out
}

// ——— what Tetra reads ———

/** "1985-03-14", "19850314", "--03-14", "--0314"; Apple's 1604 is no year. { year, month, day } or null. */
function parseDate(s) {
  const t = String(s || '').trim()
  let m = /^--(\d{2})-?(\d{2})/.exec(t)
  if (m) return date(null, +m[1], +m[2])
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t)
  if (!m) return null
  const y = +m[1]
  return date(y !== 1604 && y > 0 ? y : null, +m[2], +m[3])
}
const date = (year, month, day) => (month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { year, month, day } : null)
const pad = n => String(n).padStart(2, '0')
const dateValue = d => (d.year != null ? `${String(d.year).padStart(4, '0')}-${pad(d.month)}-${pad(d.day)}` : `--${pad(d.month)}-${pad(d.day)}`)

const cleanLabel = s => s.replace(/^_\$!</, '').replace(/>!\$_$/, '').trim()
function typesOf(p) {
  return splitParams(p.params).flatMap(raw => { const eq = raw.indexOf('='); return eq > 0 && raw.slice(0, eq).toUpperCase() === 'TYPE' ? raw.slice(eq + 1).replace(/"/g, '').split(',') : [] })
    .map(t => t.trim().toUpperCase()).filter(Boolean)
}
function labelOf(p, lines) {
  const g = groupOf(p)
  if (g) { const l = lines.find(x => groupOf(x).toLowerCase() === g.toLowerCase() && keyOf(x) === 'X-ABLABEL'); if (l) return cleanLabel(unescape(l.value)) }
  const t = typesOf(p).filter(x => !['PREF', 'VOICE', 'INTERNET', 'X-INTERNET'].includes(x))
  if (t.includes('CELL') || t.includes('MOBILE')) return 'Mobile'
  if (t.includes('FAX') && t.includes('WORK')) return 'Work fax'
  if (t.includes('FAX')) return 'Home fax'
  if (t.includes('PAGER')) return 'Pager'
  if (t.includes('MAIN')) return 'Main'
  if (t.includes('HOME')) return 'Home'
  if (t.includes('WORK')) return 'Work'
  if (t.includes('OTHER')) return 'Other'
  const plain = t.find(x => !x.startsWith('X-'))
  if (plain) return plain[0] + plain.slice(1).toLowerCase()
  return t[0] ? cleanLabel(t[0].slice(2)) : ''
}

const STARRED = 'starred', MY_CONTACTS = 'myContacts'

/** What Tetra reads and edits of a card; the rest of its lines stay as they are. Plain values only (the window gets them). */
function info(lines) {
  const one = k => lines.find(p => keyOf(p) === k)
  const text = k => (one(k) ? unescape(one(k).value).trim() : '')
  const n = one('N') ? parts(one('N').value) : [], org = one('ORG') ? parts(one('ORG').value) : []
  const photoLine = one('PHOTO')
  const enc = photoLine ? (param(photoLine, 'ENCODING') || '').toLowerCase() : ''
  const photo = photoLine && (enc === 'b' || enc === 'base64') ? photoLine.value.replace(/\s/g, '') || null : null
  const fields = k => lines.filter(p => keyOf(p) === k).map(p => ({ label: labelOf(p, lines), value: unescape(p.value).trim() })).filter(f => f.value)
  const i = {
    uid: text('UID'),
    family: (n[0] || '').trim(), given: (n[1] || '').trim(), middle: (n[2] || '').trim(), prefix: (n[3] || '').trim(), suffix: (n[4] || '').trim(),
    formatted: text('FN'), nickname: text('NICKNAME'),
    org: (org[0] || '').trim(), department: org.slice(1).map(s => s.trim()).join(', ').replace(/^[, ]+|[, ]+$/g, ''), title: text('TITLE'),
    phones: fields('TEL'), emails: fields('EMAIL'),
    // the number starred as the default (TYPE=PREF on its TEL line, as Google and Android write it)
    defaultPhone: (p => p ? unescape(p.value).trim() || null : null)(lines.find(p => keyOf(p) === 'TEL' && typesOf(p).includes('PREF'))),
    addresses: lines.filter(p => keyOf(p) === 'ADR').map(p => { const x = parts(p.value).map(s => s.trim()); while (x.length < 7) x.push(''); return { label: labelOf(p, lines), parts: x } })
      .filter(a => a.parts.some(s => s)),
    urls: fields('URL'),
    birthday: one('BDAY') ? parseDate(one('BDAY').value) : null,
    dates: lines.filter(p => keyOf(p) === 'X-ABDATE' || keyOf(p) === 'ANNIVERSARY')
      .map(p => ({ label: keyOf(p) === 'ANNIVERSARY' ? 'Anniversary' : (labelOf(p, lines) || 'Other'), value: p.value.trim() })).filter(f => parseDate(f.value)),
    related: [...fields('X-ABRELATEDNAMES'), ...fields('RELATED')],
    note: text('NOTE'),
    categories: [...new Set(lines.filter(p => keyOf(p) === 'CATEGORIES').flatMap(p => parts(p.value, ',')).map(s => s.trim()).filter(Boolean))],
    photo,
    photoUrl: photoLine && !photo && /^http/i.test(photoLine.value) ? photoLine.value.trim() : null,
    person: text('X-TETRA-PERSON') || null,
    face: text('X-TETRA-FACE') || null,
    rev: text('REV'),
  }
  return i
}
const composed = i => [i.prefix, i.given, i.middle, i.family, i.suffix].filter(s => s && s.trim()).join(' ')
const nameOf = i => (i.formatted || '').trim() || composed(i) || i.org || i.phones[0]?.value || i.emails[0]?.value || ''
const favourite = i => i.categories.some(c => c.toLowerCase() === STARRED.toLowerCase())
const labels = i => i.categories.filter(c => c.trim() && ![STARRED, MY_CONTACTS, 'Starred in Android'].some(x => x.toLowerCase() === c.toLowerCase()))
const empty = () => ({ uid: '', prefix: '', given: '', middle: '', family: '', suffix: '', formatted: '', nickname: '', org: '', department: '', title: '',
  phones: [], defaultPhone: null, emails: [], addresses: [], urls: [], birthday: null, dates: [], related: [], note: '', categories: [], photo: null, photoUrl: null, person: null, face: null, rev: '' })
/** The window's view of a contact: the info and what is worked out from it. */
const view = i => ({ ...i, name: nameOf(i), favourite: favourite(i), labels: labels(i) })

// ——— writing ———

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const PHONE_TYPES = { Mobile: 'CELL', Home: 'HOME', Work: 'WORK', Main: 'MAIN', 'Home fax': 'HOME,FAX', 'Work fax': 'WORK,FAX', Pager: 'PAGER', Other: 'OTHER' }
const PLACE_TYPES = { Home: 'HOME', Work: 'WORK', Other: 'OTHER' }
const RELATIONS = ['Spouse', 'Partner', 'Mother', 'Father', 'Parent', 'Brother', 'Sister', 'Child', 'Friend', 'Assistant', 'Manager']
const revNow = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/**
 * [was] edited into [now], on [lines]: the lines of what changed are replaced (where they stood, else at the end), every
 * other line kept as it was. UID set when missing; REV the time of the change. The phone's VCard.apply, the same.
 */
function apply(lines, was, now, at = Date.now()) {
  const out = lines.slice()
  let nextGroup = Math.max(0, ...out.map(p => parseInt(groupOf(p).replace(/^item/i, ''), 10)).filter(n => !isNaN(n))) + 1
  function replace(keys, add) {
    const groups = new Set(out.filter(p => keys.includes(keyOf(p))).map(p => groupOf(p).toLowerCase()).filter(Boolean)
      .filter(g => !out.some(o => groupOf(o).toLowerCase() === g && !keys.includes(keyOf(o)) && keyOf(o) !== 'X-ABLABEL')))
    const goes = p => keys.includes(keyOf(p)) || (keyOf(p) === 'X-ABLABEL' && groups.has(groupOf(p).toLowerCase()))
    const first = out.findIndex(p => keys.includes(keyOf(p)))
    const pos = first < 0 ? out.length : first - out.slice(0, first).filter(goes).length
    for (let k = out.length - 1; k >= 0; k--) if (goes(out[k])) out.splice(k, 1)
    out.splice(Math.max(0, Math.min(pos, out.length)), 0, ...add)
  }
  function labelled(key, f, value, types) {
    const t = Object.entries(types).find(([k]) => k.toLowerCase() === String(f.label).toLowerCase())?.[1]
    if (!f.label || !String(f.label).trim()) return [{ name: key, params: '', value }]
    if (t) return [{ name: key, params: `;TYPE=${t}`, value }]
    const g = `item${nextGroup++}`
    return [{ name: `${g}.${key}`, params: '', value }, { name: `${g}.X-ABLabel`, params: '', value: escape(f.label) }]
  }
  const single = (key, v) => (v && v.trim() ? [{ name: key, params: '', value: escape(v) }] : [])
  const nKeys = i => [i.prefix, i.given, i.middle, i.family, i.suffix, i.formatted]
  const nLine = () => ({ name: 'N', params: '', value: [now.family, now.given, now.middle, now.prefix, now.suffix].map(s => escape(s || '')).join(';') })
  if (!same(nKeys(was), nKeys(now))) {
    replace(['N'], [nLine()])
    replace(['FN'], [{ name: 'FN', params: '', value: escape((now.formatted || '').trim() || composed(now) || now.org) }])
  }
  if (was.nickname !== now.nickname) replace(['NICKNAME'], single('NICKNAME', now.nickname))
  if (was.org !== now.org || was.department !== now.department)
    replace(['ORG'], !now.org && !now.department ? [] : [{ name: 'ORG', params: '', value: escape(now.org || '') + (now.department ? ';' + escape(now.department) : '') }])
  if (was.title !== now.title) replace(['TITLE'], single('TITLE', now.title))
  if (!same(was.phones, now.phones) || (was.defaultPhone ?? null) !== (now.defaultPhone ?? null)) replace(['TEL'], now.phones.flatMap(f => labelled('TEL', f, escape(f.value), PHONE_TYPES)
    .map(p => f.value !== now.defaultPhone || p.name.endsWith('X-ABLabel') ? p : { ...p, params: p.params.startsWith(';TYPE=') ? p.params + ',PREF' : ';TYPE=PREF' })))
  if (!same(was.emails, now.emails)) replace(['EMAIL'], now.emails.flatMap(f => labelled('EMAIL', f, escape(f.value), PLACE_TYPES)
    .map(p => !p.params && !p.name.includes('.') ? { ...p, params: ';TYPE=INTERNET' } : p.params.startsWith(';TYPE=') ? { ...p, params: ';TYPE=INTERNET,' + p.params.slice(6) } : p)))
  if (!same(was.addresses, now.addresses)) replace(['ADR'], now.addresses.flatMap(a => {
    const x = a.parts.slice(0, 7); while (x.length < 7) x.push('')
    return labelled('ADR', { label: a.label, value: '' }, x.map(escape).join(';'), PLACE_TYPES)
  }))
  if (!same(was.urls, now.urls)) replace(['URL'], now.urls.flatMap(f => labelled('URL', f, escape(f.value), {})))
  if (!same(was.birthday, now.birthday)) replace(['BDAY'], now.birthday ? [{ name: 'BDAY', params: '', value: dateValue(now.birthday) }] : [])
  if (!same(was.dates, now.dates)) replace(['X-ABDATE', 'ANNIVERSARY'], now.dates.flatMap(f => {
    const g = `item${nextGroup++}`, label = f.label.toLowerCase() === 'anniversary' ? '_$!<Anniversary>!$_' : (f.label || 'Other')
    return [{ name: `${g}.X-ABDATE`, params: '', value: f.value }, { name: `${g}.X-ABLabel`, params: '', value: escape(label) }]
  }))
  if (!same(was.related, now.related)) replace(['X-ABRELATEDNAMES', 'RELATED'], now.related.flatMap(f => {
    const g = `item${nextGroup++}`
    return [{ name: `${g}.X-ABRELATEDNAMES`, params: '', value: escape(f.value) }, { name: `${g}.X-ABLabel`, params: '', value: escape(RELATIONS.includes(f.label) ? `_$!<${f.label}>!$_` : f.label) }]
  }))
  if (was.note !== now.note) replace(['NOTE'], single('NOTE', now.note))
  if (!same(was.categories, now.categories)) replace(['CATEGORIES'], now.categories.length ? [{ name: 'CATEGORIES', params: '', value: now.categories.map(escape).join(',') }] : [])
  if (was.photo !== now.photo || was.photoUrl !== now.photoUrl) replace(['PHOTO'],
    now.photo ? [{ name: 'PHOTO', params: ';ENCODING=b;TYPE=JPEG', value: now.photo }] : now.photoUrl ? [{ name: 'PHOTO', params: ';VALUE=uri', value: now.photoUrl }] : [])
  if (was.person !== now.person) replace(['X-TETRA-PERSON'], now.person ? [{ name: 'X-TETRA-PERSON', params: '', value: now.person }] : [])
  if ((was.face ?? null) !== (now.face ?? null)) replace(['X-TETRA-FACE'], now.face ? [{ name: 'X-TETRA-FACE', params: '', value: now.face }] : [])
  if (!out.some(p => keyOf(p) === 'UID')) out.push({ name: 'UID', params: '', value: now.uid || crypto.randomUUID() })
  if (!out.some(p => keyOf(p) === 'FN')) out.push({ name: 'FN', params: '', value: escape(nameOf(now)) })
  if (!out.some(p => keyOf(p) === 'N')) out.push(nLine())
  replace(['REV'], [{ name: 'REV', params: '', value: revNow(at) }])
  return out
}
const build = (i, at) => apply([], empty(), { ...empty(), ...i, uid: i.uid || crypto.randomUUID() }, at)
/** One card as a 3.0 file. */
const writeCard = lines => writeComps([{ name: 'VCARD', items: [{ name: 'VERSION', params: '', value: '3.0' }, ...lines.filter(p => keyOf(p) !== 'VERSION')] }])

// ——— the folder ———

/** Lower case, accents off: "Άννα" and "αννα" sort and search together. */
const plain = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').trim()
const keysOf = i => new Set([...i.phones.map(p => p.value.replace(/\D/g, '').slice(-9)).filter(k => k.length >= 5), ...i.emails.map(e => e.value.toLowerCase().trim())])
/** The same person: one UID, or one name and a phone or e-mail in common (or no phone and no e-mail on either). */
function sameOne(a, b) {
  if (a.uid && a.uid === b.uid) return true
  if (!nameOf(a) || plain(nameOf(a)) !== plain(nameOf(b))) return false
  const ka = keysOf(a), kb = keysOf(b)
  return (!ka.size && !kb.size) || [...ka].some(k => kb.has(k))
}
const slug = (name, uid) => `${(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'contact'}-${crypto.createHash('sha1').update(uid).digest('hex').slice(0, 6)}.vcf`

class Contacts {
  /** [root]: Files/Contacts; [trash]: Files/Trash; [calendar]: the Calendar, for birthdays. */
  constructor(root, trash, calendar = null) { this.root = root; this.trashDir = trash; this.calendar = calendar; this.cache = new Map() }

  names() { try { return fs.readdirSync(this.root).filter(n => n.toLowerCase().endsWith('.vcf') && !n.startsWith('.')) } catch { return [] } }
  read(file) {
    let st = null
    try { st = fs.statSync(file) } catch { return null }
    const hit = this.cache.get(file)
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.c
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch {}
    const lines = cards(text)[0] || []
    const c = { file, lines, info: info(lines), mtime: st.mtimeMs }
    this.cache.set(file, { size: st.size, mtime: st.mtimeMs, c })
    return c
  }
  /** One per UID: sync's "x (2).vcf" copies show as one, the newer REV (then the newer file), with how many there are. */
  all() {
    const read = this.names().map(n => this.read(path.join(this.root, n))).filter(c => c && c.lines.length)
    const byUid = new Map()
    for (const c of read) { const k = c.info.uid || path.basename(c.file); byUid.set(k, [...(byUid.get(k) || []), c]) }
    return [...byUid.values()].map(same => {
      const c = same.reduce((a, b) => ((b.info.rev > a.info.rev) || (b.info.rev === a.info.rev && b.mtime > a.mtime) ? b : a))
      return { ...c, versions: same.length }
    })
  }
  /** For the window: every contact, sorted by first name (or last), plain values. */
  list(byLast = false) {
    const key = i => plain(byLast && i.family ? `${i.family} ${i.given}` : nameOf(i)).replace(/^[^\p{L}\p{N}]+/u, '')
    return this.all().map(c => ({ ...view(c.info), file: path.basename(c.file), versions: c.versions, key: key(c.info) }))
      .sort((a, b) => (!a.key - !b.key) || a.key.localeCompare(b.key))
  }
  byUid(uid) { const c = this.all().find(x => x.info.uid === uid); if (!c) throw new Error('No such contact.'); return c }
  put(file, lines) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.part') // a dot file: sync passes it by
    fs.writeFileSync(tmp, writeCard(lines))
    fs.renameSync(tmp, file)
  }
  freeFile(name, uid) {
    const n = slug(name, uid)
    let f = path.join(this.root, n)
    for (let k = 2; fs.existsSync(f); k++) f = path.join(this.root, n.replace(/\.vcf$/, ` (${k}).vcf`))
    return f
  }
  /** [now] saved: over [uid]'s file (only what changed rewritten), or a new contact; its dates into the calendar. Answers the UID. */
  save(uid, now, at = Date.now()) {
    const c = uid ? this.byUid(uid) : null
    const clean = { ...empty(), ...now }
    const lines = c ? apply(c.lines, c.info, { ...clean, uid: c.info.uid }, at) : build(clean, at)
    const i = info(lines)
    this.put(c ? c.file : this.freeFile(nameOf(i), i.uid), lines)
    this.dates(i)
    return i.uid
  }
  /** Into Files/Trash (sync never deletes; a move crosses as a move), its "(2)" copies and its events with it. */
  trash(uid) {
    const c = this.byUid(uid)
    for (const n of this.names()) { const f = path.join(this.root, n); if (f === c.file || this.read(f)?.info.uid === uid) this.toTrash(f) }
    this.dates(c.info, true)
  }
  toTrash(from) {
    fs.mkdirSync(this.trashDir, { recursive: true })
    const ext = path.extname(from), base = path.basename(from, ext)
    let to = path.join(this.trashDir, base + ext)
    for (let n = 2; fs.existsSync(to); n++) to = path.join(this.trashDir, `${base} (${n})${ext}`)
    fs.renameSync(from, to)
  }
  /** "Keep this one": sync's other copies of a contact to the Trash. */
  keep(uid) {
    const c = this.byUid(uid)
    for (const n of this.names()) { const f = path.join(this.root, n); if (f !== c.file && this.read(f)?.info.uid === uid) this.toTrash(f) }
  }
  trashed() {
    let names = []
    try { names = fs.readdirSync(this.trashDir).filter(n => n.toLowerCase().endsWith('.vcf') && !n.startsWith('.')) } catch {}
    return names.map(name => { const f = path.join(this.trashDir, name), c = this.read(f); let at = 0; try { at = fs.statSync(f).ctimeMs } catch {}; return c && { name, contact: view(c.info), at } })
      .filter(Boolean).sort((a, b) => b.at - a.at)
  }
  restore(name) {
    const from = path.resolve(this.trashDir, String(name))
    if (path.dirname(from) !== path.resolve(this.trashDir) || !from.toLowerCase().endsWith('.vcf')) throw new Error('Not a contact in the Trash.')
    const ext = path.extname(from), base = path.basename(from, ext)
    let to = path.join(this.root, base + ext)
    for (let n = 2; fs.existsSync(to); n++) to = path.join(this.root, `${base} (${n})${ext}`)
    fs.mkdirSync(this.root, { recursive: true })
    fs.renameSync(from, to)
    this.dates(this.read(to).info)
  }
  /** Cards into the folder; the same person already here is left alone (importing twice gives no doubles). */
  import(list, at = Date.now()) {
    const here = this.all().map(c => c.info)
    let added = 0, same = 0
    for (const lines0 of list) {
      const i0 = info(lines0)
      if (!nameOf(i0) && !i0.photo) continue
      if (here.some(h => sameOne(h, i0))) { same++; continue }
      const lines1 = i0.uid ? lines0 : [...lines0, { name: 'UID', params: '', value: crypto.randomUUID() }]
      const lines = apply(lines1, info(lines1), info(lines1), at)
      const i = info(lines)
      this.put(this.freeFile(nameOf(i), i.uid), lines)
      here.push(i); added++
      this.dates(i)
    }
    return { added, same }
  }

  // ——— merge & fix, export ———

  /** Suggested duplicates (the same name, or a phone or e-mail in common), the fuller first; "not the same" pairs left out. */
  pairs() {
    const all = this.all()
    const names = all.map(c => plain(nameOf(c.info))), keys = all.map(c => keysOf(c.info))
    const notSame = (c, uid) => c.lines.some(p => keyOf(p) === 'X-TETRA-NOT-DUPLICATE' && p.value.trim() === uid)
    const out = []
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      if (!(names[i] && names[i] === names[j]) && ![...keys[i]].some(k => keys[j].has(k))) continue
      if (notSame(all[i], all[j].info.uid) || notSame(all[j], all[i].info.uid)) continue
      const [a, b] = all[j].lines.length > all[i].lines.length ? [all[j], all[i]] : [all[i], all[j]]
      out.push([view(a.info), view(b.info)])
    }
    return out
  }
  static merged(a, b) {
    const s = (x, y) => x || y
    const by = (list, k) => { const seen = new Set(); return list.filter(x => { const v = k(x); if (seen.has(v)) return false; seen.add(v); return true }) }
    const bd = a.birthday && a.birthday.year == null && b.birthday && b.birthday.month === a.birthday.month && b.birthday.day === a.birthday.day ? b.birthday : a.birthday || b.birthday
    return {
      ...a, prefix: s(a.prefix, b.prefix), given: s(a.given, b.given), middle: s(a.middle, b.middle), family: s(a.family, b.family), suffix: s(a.suffix, b.suffix),
      formatted: s(a.formatted, b.formatted), nickname: s(a.nickname, b.nickname), org: s(a.org, b.org), department: s(a.department, b.department), title: s(a.title, b.title),
      phones: by([...a.phones, ...b.phones], p => p.value.replace(/\D/g, '').slice(-9) || p.value.trim()), defaultPhone: a.defaultPhone || b.defaultPhone,
      emails: by([...a.emails, ...b.emails], e => e.value.toLowerCase().trim()),
      addresses: by([...a.addresses, ...b.addresses], x => plain(x.parts.join(' '))), urls: by([...a.urls, ...b.urls], u => u.value.trim().toLowerCase()),
      birthday: bd, dates: by([...a.dates, ...b.dates], d => d.label.toLowerCase() + d.value),
      related: by([...a.related, ...b.related], r => r.label.toLowerCase() + plain(r.value)),
      note: [...new Set([a.note, b.note].filter(Boolean))].join('\n\n'),
      categories: by([...a.categories, ...b.categories], c => c.toLowerCase()),
      photo: a.photo || b.photo, photoUrl: a.photo ? a.photoUrl : a.photoUrl || b.photoUrl, person: a.person || b.person, face: a.photo ? a.face : a.face || b.face,
    }
  }
  /** [b] merged into [a]: one file with every value of both, [b] to the Trash, [b]'s events become [a]'s. */
  merge(aUid, bUid) {
    const a = this.byUid(aUid), b = this.byUid(bUid)
    const m = Contacts.merged(a.info, b.info)
    this.save(aUid, m)
    if (this.calendar) for (const f of this.linked().get(bUid) || []) {
      const kinds = (this.linked().get(aUid) || []).map(x => kindOf(x).toLowerCase())
      if (kinds.includes(kindOf(f).toLowerCase())) this.calendar.trash(path.relative(this.calendar.root, f.file))
      else this.calendar.rewrite(f.file, cal => setOn(cal, 'X-TETRA-CONTACT', aUid))
    }
    for (const n of this.names()) { const f = path.join(this.root, n); if (this.read(f)?.info.uid === bUid) this.toTrash(f) }
    this.dates(this.byUid(aUid).info)
  }
  notTheSame(aUid, bUid) {
    for (const [x, y] of [[aUid, bUid], [bUid, aUid]]) { const c = this.byUid(x); this.put(c.file, [...c.lines, { name: 'X-TETRA-NOT-DUPLICATE', params: '', value: y }]) }
  }
  /** One .vcf of these contacts (all when none named). */
  exportCards(uids) {
    const all = this.all()
    return all.filter(c => !uids || uids.includes(c.info.uid)).map(c => writeCard(c.lines)).join('')
  }

  // ——— birthdays and dates → the chosen calendar (the phone's ContactsBirthdays) ———

  /** The calendar birthdays go into: the chosen one, else Γενέθλια or Birthdays, else a new Γενέθλια. */
  birthdayCalendar(create = true) {
    const cals = this.calendar.calendars()
    const found = cals.find(c => c.id === this.chosen) || cals.find(c => c.name.toLowerCase() === 'γενέθλια') || cals.find(c => c.name.toLowerCase() === 'birthdays')
    if (found || !create) return found?.id ?? null
    return this.calendar.newCalendar('Γενέθλια', '#8E24AA')
  }
  linked() {
    const map = new Map()
    for (const cal of this.calendar.calendars()) for (const f of this.calendar.files(cal.id)) {
      const v = masterComp(f), uid = v && propValue(v, 'X-TETRA-CONTACT')
      if (uid) map.set(uid, [...(map.get(uid) || []), f])
    }
    return map
  }
  /** [i]'s events made to match it (or taken to the Trash when [gone]). */
  dates(i, gone = false, have = null) {
    if (!this.calendar || !i.uid) return 0
    have = have || this.linked().get(i.uid) || []
    const want = gone ? [] : [
      ...(i.birthday ? [['Birthday', i.birthday, nameOf(i)]] : []),
      ...i.dates.map(f => [f.label || 'Date', parseDate(f.value), `${nameOf(i)} · ${f.label || 'Date'}`]).filter(x => x[1]),
    ].filter((x, k, all) => all.findIndex(y => y[0] === x[0]) === k)
    let n = 0
    const thisYear = new Date().getFullYear()
    for (const [kind, d, title] of want) {
      const y = d.year ?? thisYear
      const day = Math.min(d.day, new Date(Date.UTC(y, d.month, 0)).getUTCDate())
      const startDate = `${String(y).padStart(4, '0')}-${pad(d.month)}-${pad(day)}`
      const f = have.find(x => kindOf(x).toLowerCase() === kind.toLowerCase())
      const year = kind === 'Birthday' && d.year != null ? String(d.year) : null
      if (!f) {
        const uid = 'tetra-contact-' + i.uid + (kind === 'Birthday' ? '' : '-' + kind.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'))
        const extra = { 'X-TETRA-CONTACT': i.uid }
        if (kind !== 'Birthday') extra['X-TETRA-KIND'] = escape(kind)
        if (year) extra['X-TETRA-BIRTH-YEAR'] = year
        this.calendar.save(null, this.birthdayCalendar(), { uid, title, place: '', notes: '', allDay: true, start: { date: startDate }, end: { date: startDate },
          rrule: 'FREQ=YEARLY', alarms: [{ days: 0, seconds: 9 * 3600 }, { days: -1, seconds: 9 * 3600 }], extra })
        n++; continue
      }
      const m = f.master
      if (!m) continue
      const [, mo, dd] = m.start.date.split('-').map(Number)
      const sameDay = mo === d.month && dd === d.day, ours = m.uid.startsWith('tetra-contact-')
      if (!sameDay || (ours && m.title !== title)) {
        const rel = path.relative(this.calendar.root, f.file)
        this.calendar.save(rel, null, { uid: m.uid, title: ours ? title : m.title, place: m.place, notes: m.notes, allDay: true,
          start: { date: sameDay ? m.start.date : startDate }, end: { date: sameDay ? m.start.date : startDate }, rrule: sameDay ? m.rrule : 'FREQ=YEARLY', alarms: m.alarms })
        n++
      }
      if (kind === 'Birthday' && (propValue(masterComp(f), 'X-TETRA-BIRTH-YEAR') || null) !== year) {
        this.calendar.rewrite(f.file, cal => setOn(cal, 'X-TETRA-BIRTH-YEAR', year)); n++
      }
    }
    for (const f of have) if (!want.some(w => w[0].toLowerCase() === kindOf(f).toLowerCase())) { this.calendar.trash(path.relative(this.calendar.root, f.file)); n++ }
    return n
  }
}

const masterComp = f => f.comps.flatMap(c => (c.name === 'VEVENT' ? [c] : c.items.filter(x => x.items && x.name === 'VEVENT'))).find(v => !v.items.some(p => !p.items && p.name === 'RECURRENCE-ID'))
const propValue = (v, n) => { const p = v?.items.find(x => !x.items && x.name === n); return p ? p.value.trim() : null }
const kindOf = f => { const v = propValue(masterComp(f), 'X-TETRA-KIND'); return v ? unescape(v) : 'Birthday' }
/** One property of an event file's event set (null: taken off). */
function setOn(cal, name, value) {
  const v = cal.items.filter(x => x.items && x.name === 'VEVENT').find(x => !x.items.some(p => !p.items && p.name === 'RECURRENCE-ID'))
  if (!v) return
  const at = v.items.findIndex(x => !x.items && x.name === name)
  v.items = v.items.filter(x => x.items || x.name !== name)
  if (value == null) return
  const sub = v.items.findIndex(x => x.items)
  v.items.splice(at >= 0 ? at : (sub < 0 ? v.items.length : sub), 0, { name, params: '', value })
}

// ——— other forms: Google's CSV, Takeout's zip ———

function rows(text) {
  const out = []
  let row = [], cell = '', q = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q && c === '"' && s[i + 1] === '"') { cell += '"'; i++ }
    else if (c === '"') q = !q
    else if (!q && c === ',') { row.push(cell); cell = '' }
    else if (!q && (c === '\n' || c === '\r')) { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(Boolean)) out.push(row); row = [] }
    else cell += c
  }
  row.push(cell); if (row.some(Boolean)) out.push(row)
  return out
}
const labelWord = s => ({ mobile: 'Mobile', cell: 'Mobile', home: 'Home', work: 'Work', main: 'Main', other: 'Other', 'work fax': 'Work fax', 'home fax': 'Home fax' })[s.trim().toLowerCase()] || s.trim()
/** Google Contacts' CSV, its 2024 form and its older one; several values in one cell " ::: " apart. */
function csv(text) {
  const all = rows(text)
  if (!all.length) return []
  const head = all[0].map(h => h.trim())
  const col = (row, ...names) => { for (const n of names) { const i = head.findIndex(h => h.toLowerCase() === n.toLowerCase()); if (i >= 0) return (row[i] || '').trim() } return '' }
  const many = v => v.split(' ::: ').map(s => s.trim()).filter(Boolean)
  const numbered = (row, what) => Array.from({ length: 20 }, (_, k) => k + 1).flatMap(k => {
    const label = labelWord(col(row, `${what} ${k} - Label`, `${what} ${k} - Type`).replace(/^\* /, ''))
    return many(col(row, `${what} ${k} - Value`)).map(value => ({ label, value }))
  })
  return all.slice(1).map(row => {
    const cats = many(col(row, 'Labels', 'Group Membership')).map(s => s.replace(/^\* /, '').trim())
      .map(s => s.toLowerCase() === 'my contacts' ? MY_CONTACTS : s.toLowerCase() === 'starred' ? STARRED : s)
    const addresses = Array.from({ length: 10 }, (_, k) => k + 1).map(k => {
      const p = ['PO Box', 'Extended Address', 'Street', 'City', 'Region', 'Postal Code', 'Country'].map(x => col(row, `Address ${k} - ${x}`))
      const formatted = col(row, `Address ${k} - Formatted`), label = labelWord(col(row, `Address ${k} - Label`, `Address ${k} - Type`).replace(/^\* /, ''))
      return p.some(Boolean) ? { label, parts: p } : formatted ? { label, parts: ['', '', formatted.replace(/\n/g, ' '), '', '', '', ''] } : null
    }).filter(Boolean)
    const i = {
      ...empty(), prefix: col(row, 'Name Prefix'), given: col(row, 'First Name', 'Given Name'), middle: col(row, 'Middle Name', 'Additional Name'),
      family: col(row, 'Last Name', 'Family Name'), suffix: col(row, 'Name Suffix'), formatted: col(row, 'Name'), nickname: col(row, 'Nickname'),
      org: col(row, 'Organization Name', 'Organization 1 - Name'), department: col(row, 'Organization Department', 'Organization 1 - Department'),
      title: col(row, 'Organization Title', 'Organization 1 - Title'), phones: numbered(row, 'Phone'), emails: numbered(row, 'E-mail'), addresses,
      urls: numbered(row, 'Website'), birthday: parseDate(col(row, 'Birthday')),
      dates: numbered(row, 'Event').filter(f => parseDate(f.value)).map(f => ({ label: f.label || 'Other', value: dateValue(parseDate(f.value)) })),
      related: numbered(row, 'Relation'), note: col(row, 'Notes'), categories: cats, photoUrl: /^http/.test(col(row, 'Photo')) ? col(row, 'Photo') : null,
    }
    return build({ ...i, formatted: i.formatted || composed(i) })
  }).filter(l => nameOf(info(l)))
}
/** Takeout's zip: one .vcf per label; each person once, with every folder's label. */
function zipCards(buf) {
  const got = []
  for (const e of unzip(buf)) {
    const dir = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/')) : ''
    const label = dir.slice(dir.lastIndexOf('/') + 1)
    if (/\.vcf$/i.test(e.name)) for (const c of cards(e.data.toString('utf8'))) got.push([label, c])
    else if (/\.csv$/i.test(e.name)) for (const c of csv(e.data.toString('utf8'))) got.push([label, c])
  }
  const out = []
  for (const [label, lines] of got) {
    const i = info(lines)
    const extra = !label || ['all contacts', 'contacts', 'my contacts'].includes(label.toLowerCase()) ? null : ['starred', 'starred in android'].includes(label.toLowerCase()) ? STARRED : label
    const at = out.findIndex(o => sameOne(o[0], i))
    const base = at >= 0 ? out[at] : [i, lines]
    const cats = extra && !base[0].categories.some(c => c.toLowerCase() === extra.toLowerCase()) ? [...base[0].categories, extra] : base[0].categories
    const merged = cats === base[0].categories ? base : [{ ...base[0], categories: cats }, apply(base[1], base[0], { ...base[0], categories: cats }).filter(p => keyOf(p) !== 'REV')]
    if (at >= 0) out[at] = merged; else out.push(merged)
  }
  return out.map(o => o[1])
}
/** Any of what Import takes, by its bytes: a zip (Takeout), a CSV, or vCard text. */
function readImport(buf, name = '') {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return zipCards(buf)
  const head = buf.subarray(0, 4000).toString('utf8')
  if (/\.csv$/i.test(name) || !/BEGIN:VCARD/i.test(head)) return csv(buf.toString('utf8'))
  return cards(buf.toString('utf8'))
}

module.exports = { Contacts, cards, info, apply, build, writeCard, readImport, csv, parseDate, dateValue, nameOf, view, plain, sameOne, empty }
