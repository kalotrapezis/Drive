'use strict'
/**
 * Tetra Mail, step 1 of Tetra-mobile's MAIL_PLAN.md: the desktop fetches mail as Thunderbird does and keeps all of it as
 * plain files the assistant (and Claude) can read. Read-only for now: nothing is sent, moved, flagged or deleted on a server.
 *
 *   .System/Mail/Shared/accounts.json                     names, servers, colours, defaults; no secrets (main keeps those in safeStorage)
 *   .System/Mail/Shared/<address>/<Folder>/<yyyy>/<yyyy-mm-dd hhmm> <from> - <subject>.eml
 *   .System/Mail/Shared/<address>/<Folder>/<yyyy>/<same name>.files/   its attachments, as ordinary files
 *   .System/Mail/Shared/index.jsonl                       one line per mail; a later line with the same id replaces it
 *
 * <Folder> is the role of the server's folder (Inbox, Sent, Drafts, Archive, Spam, Trash), found by SPECIAL-USE or, failing
 * that, its name, so every account and language looks the same on disk. A mail is orange until its .eml is written and holds
 * as many bytes as the server said, then green (`saved`). A mail gone from the server stays on disk (`gone`), out of the lists.
 */
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')
const dns = require('node:dns').promises
const { EventEmitter } = require('node:events')

const ROLES = ['Inbox', 'Drafts', 'Sent', 'Archive', 'Spam', 'Trash']
const SPECIAL = { '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Archive': 'Archive', '\\Junk': 'Spam', '\\Trash': 'Trash' }
const COLORS = ['#e5534b', '#4f8ff7', '#e0a43a', '#3fb27f', '#b77ce6', '#e57ab0', '#3bb8c4']
const EVERY = 15 * 60_000 // a full look at every folder; new mail in the Inbox comes at once by IDLE

const GMAIL = { host: 'imap.gmail.com', port: 993, secure: true, users: ['%EMAILADDRESS%'], provider: 'google' }
const MICROSOFT = { host: 'outlook.office365.com', port: 993, secure: true, users: ['%EMAILADDRESS%'], provider: 'microsoft' }
/** Known providers first (MAIL_PLAN §9b); sch.gr's own server takes the user name without @sch.gr. */
const KNOWN = {
  'gmail.com': GMAIL, 'googlemail.com': GMAIL,
  'sch.gr': { host: 'mail.sch.gr', port: 993, secure: true, users: ['%EMAILLOCALPART%', '%EMAILADDRESS%'], provider: null },
  ...Object.fromEntries(['outlook.com', 'hotmail.com', 'hotmail.gr', 'live.com', 'msn.com'].map(d => [d, MICROSOFT])),
}

const pad = n => String(n).padStart(2, '0')
/** Where a file is written before it is renamed into place: a dotfile, which sync's walk skips, so no phone is offered half of one. */
const part = file => path.join(path.dirname(file), `.${path.basename(file)}.part`)
const OPS = ['read', 'unread', 'favorite', 'unfavorite', 'archive', 'delete', 'move', 'spam', 'notSpam']
/** Text a file name takes on every file system, at most [bytes] bytes of UTF-8 (names are 255 bytes, Greek is two each). */
function clean(s, bytes) {
  let out = String(s ?? '').replace(/[/\\\0:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  while (Buffer.byteLength(out) > bytes) out = out.slice(0, -1)
  return out.trim()
}
/** `2026/2026-10-31 0912 Γραμματεία ΜΠΣ - Προθεσμία εργασίας`, by local time, without the extension. */
function mailName(date, from, subject) {
  const d = new Date(date || 0), y = d.getFullYear()
  return `${y}/${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${clean(from, 60) || '-'} - ${clean(subject, 120) || '-'}`
}

/** Each role's folder on the server: SPECIAL-USE first, then imapflow's guess from the name; INBOX is always the Inbox. */
function roles(list) {
  const out = {}, rank = f => (f.specialUseSource === 'extension' ? 0 : 1)
  for (const f of [...list].sort((a, b) => rank(a) - rank(b))) {
    const role = f.path.toUpperCase() === 'INBOX' ? 'Inbox' : SPECIAL[f.specialUse]
    if (role && !out[role] && !f.flags?.has?.('\\Noselect')) out[role] = f.path
  }
  return out
}

/** Every folder to sync, [role, path]: each role's own, and the folders inside the Archive (archived by year or month, §3). */
function places(list, boxes) {
  const out = Object.entries(boxes), a = boxes.Archive
  if (a) for (const f of list) if (f.path.startsWith(a + (f.delimiter || '/')) && !f.flags?.has?.('\\Noselect')) out.push(['Archive', f.path])
  return out
}

/** How many parts of a BODYSTRUCTURE are attachments (a guess until the mail itself is read). */
const countAttachments = node => !node ? 0 : (node.childNodes ?? []).reduce((n, c) => n + countAttachments(c), node.disposition === 'attachment' ? 1 : 0)

/**
 * index.jsonl: every mail, one JSON line each; the last line for an id wins, so a change is one append. Read whole at
 * the start and written again whole only when it has grown to more than twice what it holds.
 */
class Index {
  constructor(file) {
    this.file = file; this.mails = new Map(); this.pending = []; this.timer = null
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch {}
    let lines = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      lines++
      try { const e = JSON.parse(line); if (e?.id) this.mails.set(e.id, e) } catch {} // a line cut by a crash: that mail is fetched again
    }
    if (lines > 2 * this.mails.size + 100) this.compact()
    else if (text && !text.endsWith('\n')) fs.appendFileSync(file, '\n')
  }
  get(id) { return this.mails.get(id) }
  all() { return this.mails.values() }
  put(e) {
    this.mails.set(e.id, e); this.pending.push(JSON.stringify(e))
    this.timer ??= setTimeout(() => this.flush(), 1000)
  }
  flush() {
    clearTimeout(this.timer); this.timer = null
    if (!this.pending.length) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, this.pending.join('\n') + '\n'); this.pending = []
  }
  compact() {
    this.pending = []; clearTimeout(this.timer); this.timer = null
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(part(this.file), [...this.mails.values()].map(e => JSON.stringify(e) + '\n').join(''))
    fs.renameSync(part(this.file), this.file)
  }
}

// ── Finding the servers (MAIL_PLAN §9b): known providers → Thunderbird's database → the domain's autoconfig → its MX → the usual names

/** The first IMAP server in a Thunderbird autoconfig file, or null. */
function parseConfig(xml) {
  const m = /<incomingServer\s+type="imap">([\s\S]*?)<\/incomingServer>/.exec(String(xml))
  if (!m) return null
  const tag = n => new RegExp(`<${n}>([^<]*)</${n}>`).exec(m[1])?.[1]?.trim()
  const host = tag('hostname'), port = Number(tag('port'))
  if (!host || !(port > 0 && port < 65536)) return null
  const provider = /gmail\.com$/i.test(host) ? 'google' : /office365\.com$|outlook\.com$/i.test(host) ? 'microsoft' : null
  return { host, port, secure: tag('socketType') === 'SSL', users: [tag('username') || '%EMAILADDRESS%'], provider }
}

/** %EMAILADDRESS% and the rest, as Thunderbird fills them. */
const userName = (pattern, address) => pattern.replace(/%EMAILADDRESS%/g, address).replace(/%EMAILLOCALPART%/g, address.split('@')[0]).replace(/%EMAILDOMAIN%/g, address.split('@')[1])

async function getConfig(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    return r.ok ? parseConfig(await r.text()) : null
  } catch { return null }
}

/** Whether a TLS IMAP server answers at host:port within 4 s. */
const answers = (host, port) => new Promise(resolve => {
  const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, timeout: 4000 }, () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false) })
})

/** { server, how } for an address, or null when nothing was found (then the manual setup). */
async function detect(address, { lookup = getConfig, mx = d => dns.resolveMx(d), probe = answers } = {}) {
  const domain = address.split('@')[1].toLowerCase()
  if (KNOWN[domain]) return { server: KNOWN[domain], how: 'known' }
  let s = await lookup(`https://autoconfig.thunderbird.net/v1.1/${domain}`)
  if (s) return { server: s, how: 'thunderbird' }
  s = await lookup(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`)
  if (s) return { server: s, how: 'domain' }
  const records = await mx(domain).catch(() => [])
  const top = records.sort((a, b) => a.priority - b.priority)[0]?.exchange?.toLowerCase()
  if (top) {
    if (/(^|\.)(google\.com|googlemail\.com)$/.test(top)) return { server: GMAIL, how: 'mx' }
    if (/(^|\.)outlook\.com$/.test(top)) return { server: MICROSOFT, how: 'mx' }
    const base = top.split('.').slice(-2).join('.')
    if (base !== domain && (s = await lookup(`https://autoconfig.thunderbird.net/v1.1/${base}`))) return { server: s, how: 'mx' }
  }
  for (const host of [`imap.${domain}`, `mail.${domain}`, ...(top ? [top] : [])])
    if (await probe(host, 993)) return { server: { host, port: 993, secure: true, users: ['%EMAILADDRESS%', '%EMAILLOCALPART%'], provider: null }, how: 'guess' }
  return null
}

/** What went wrong, as one word the window turns into a sentence: auth, appPassword, unreachable, other. */
function reason(e) {
  const text = `${e?.responseText ?? ''} ${e?.message ?? ''}`
  if (/application-specific password|app password/i.test(text)) return 'appPassword'
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|login failed/i.test(text)) return 'auth'
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'NoConnection'].includes(e?.code) || /timeout/i.test(text)) return 'unreachable'
  return 'other'
}
const failure = e => Object.assign(new Error(e?.responseText || e?.message || String(e)), { reason: reason(e) })

function client(server, user, pass) {
  const { ImapFlow } = require('imapflow')
  const c = new ImapFlow({ host: server.host, port: server.port, secure: server.secure, auth: { user, pass }, logger: false, maxIdleTime: 10 * 60_000 })
  c.on('error', () => {}) // a dropped connection also ends in 'close', which the account's loop waits for
  return c
}

/** Signs in with each user name the server may want; { user, roles } or throws with a .reason. */
async function check(server, address, pass) {
  let last
  for (const user of [...new Set(server.users.map(u => userName(u, address)))]) {
    const c = client(server, user, pass)
    try {
      await c.connect()
      const found = roles(await c.list())
      await c.logout().catch(() => {})
      return { user, roles: found }
    } catch (e) { last = e; c.close() }
    if (reason(last) !== 'auth') break
  }
  throw failure(last)
}

const sleep = (ms, run) => new Promise(r => { const t = setTimeout(r, ms); run.wake = why => { clearTimeout(t); r(why) } })

class Mail extends EventEmitter {
  /** [root] is .System/Mail/Shared; [secret](id) gives an account's password from the keychain, or null; [connect] is for tests. */
  constructor(root, { secret, connect = client }) {
    super()
    this.root = root; this.secret = secret; this.connect = connect
    this.index = new Index(path.join(root, 'index.jsonl'))
    this.live = new Map()  // account id → its loop: { acc, stop, client, wake }
    this.state = {}        // account id → { busy, error }
    this.nudge = null
    this.queue = {}        // account id → its actions, one after another
  }

  accounts() { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'accounts.json'), 'utf8')) } catch { return [] } }
  saveAccounts(list) {
    fs.mkdirSync(this.root, { recursive: true })
    const file = path.join(this.root, 'accounts.json')
    fs.writeFileSync(part(file), JSON.stringify(list, null, 2)); fs.renameSync(part(file), file)
  }

  /** A new account from a check that passed, with the plan's defaults (MAIL_PLAN §3, §9b); syncing starts at once. */
  add({ address, name, server, user }) {
    const list = this.accounts().filter(a => a.id !== address)
    const used = new Set(list.map(a => a.color))
    const acc = {
      id: address, address, name: name || (/^(gmail|googlemail)\.com$/.test(address.split('@')[1]) ? 'Gmail' : address.split('@')[1]), color: COLORS.find(c => !used.has(c)) ?? COLORS[list.length % COLORS.length],
      server: { host: server.host, port: server.port, secure: server.secure, user }, provider: server.provider ?? null,
      archive: true, archiveBy: 'year', serverClean: { on: true, attachmentsMonths: 36, otherMonths: 24 }, localClean: { on: false }, notify: true,
      addedOn: 'desktop', added: Date.now(),
    }
    this.saveAccounts([...list, acc])
    this.stop(acc.id); this.start(acc)
    return acc
  }
  /** Out of Tetra; its mail stays on disk and in the index (added again, nothing is fetched twice). */
  remove(id) { this.stop(id); this.saveAccounts(this.accounts().filter(a => a.id !== id)); delete this.state[id]; this.changed() }

  startAll() { for (const a of this.accounts()) this.start(a); this.watchRequests() }
  start(acc) {
    if (this.live.has(acc.id)) return
    const run = { acc, stop: false, client: null, wake: null }
    this.live.set(acc.id, run)
    this.loop(run)
  }
  stop(id) {
    const run = this.live.get(id)
    if (!run) return
    this.live.delete(id); run.stop = true; run.wake?.('stop')
    run.client?.logout().catch(() => run.client?.close())
  }
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id); this.watcher?.close(); clearInterval(this.retry); this.index.flush() }
  /** archiveBy (year, month, none) and the like, kept in accounts.json. */
  setAccount(id, changes) {
    const list = this.accounts(), a = list.find(x => x.id === id)
    if (!a) return
    if (['year', 'month', 'none'].includes(changes?.archiveBy)) a.archiveBy = changes.archiveBy
    this.saveAccounts(list); this.changed()
  }
  syncNow() { for (const run of this.live.values()) run.wake?.('all') }

  setState(id, s) { this.state[id] = { ...this.state[id], ...s }; this.changed() }
  /** The window hears of changes at most twice a second. */
  changed() { this.nudge ??= setTimeout(() => { this.nudge = null; this.emit('changed') }, 500) }

  async loop(run) {
    let delay = 30_000
    while (!run.stop) {
      try { await this.session(run); delay = 30_000 } catch (e) {
        if (run.stop) break
        const f = failure(e)
        console.warn('[mail]', run.acc.id, f.message)
        this.setState(run.acc.id, { busy: false, error: f.reason, detail: f.message })
      }
      if (run.stop) break
      await sleep(delay, run); delay = Math.min(delay * 2, 30 * 60_000)
    }
  }

  /** One connection: every folder, then IDLE in the Inbox until new mail, the quarter-hour look, or the connection ends. */
  async session(run) {
    const { acc } = run
    const pass = this.secret(acc.id)
    if (!pass) throw Object.assign(new Error('No password saved on this computer'), { authenticationFailed: true })
    const c = run.client = this.connect(acc.server, acc.server.user, pass)
    await c.connect()
    const closed = new Promise(r => c.once('close', () => r('closed')))
    const boxes = roles(await c.list())
    let what = 'all'
    for (;;) {
      this.setState(acc.id, { busy: true, error: null, detail: null })
      // listed again each time: an archive's new year folder is synced as soon as it is there
      let now = [['Inbox', boxes.Inbox]]
      if (what !== 'inbox' || !boxes.Inbox) { const list = await c.list(); Object.assign(boxes, roles(list)); now = places(list, boxes) }
      for (const [role, box] of now) await this.headers(c, acc, role, box, boxes[role])
      for (const role of ROLES) for (const [r, box] of now) if (r === role) await this.bodies(c, acc, role, box, run, boxes[role])
      this.index.flush()
      this.setState(acc.id, { busy: false, synced: Date.now() })
      this.requests().catch(() => {}) // a phone's actions that waited for the connection
      if (run.stop) return
      if (boxes.Inbox) { await c.mailboxOpen(boxes.Inbox, { readOnly: true }); c.idle().catch(() => {}) } // at once, not after imapflow's 15 s
      // shortcut: mail arriving while another folder is open waits for the quarter-hour look; enough for one person
      const onNew = () => run.wake?.('inbox')
      c.on('exists', onNew)
      what = await Promise.race([closed, sleep(EVERY, run).then(w => w ?? 'all')])
      c.off('exists', onNew)
      if (what === 'closed' || what === 'stop' || run.stop) return
    }
  }

  /** The mails of one server folder; a line from before folders were noted (`box`) is the role's own folder. */
  mine(acc, role, box, main = box) { return [...this.index.all()].filter(e => e.account === acc.id && e.folder === role && (e.box ?? main) === box) }

  /** A folder's list: new mails' headers (orange until fetched), flags of the known ones, the gone ones marked. */
  async headers(c, acc, role, box, main = box) {
    await c.mailboxOpen(box, { readOnly: true })
    const validity = String(c.mailbox.uidValidity)
    const mine = this.mine(acc, role, box, main), first = !mine.length
    const known = new Map(mine.filter(e => e.uidValidity === validity && !e.gone).map(e => [e.uid, e]))
    const uids = (c.mailbox.exists && await c.search({ all: true }, { uid: true })) || []
    const there = new Set(uids)
    for (const e of mine) if (!e.gone && (e.uidValidity !== validity || !there.has(e.uid))) this.index.put({ ...e, gone: true })
    if (known.size && uids.length) for await (const m of c.fetch('1:*', { uid: true, flags: true })) {
      const e = known.get(m.uid)
      if (!e) continue
      const seen = m.flags.has('\\Seen'), flagged = m.flags.has('\\Flagged')
      if (e.seen !== seen || e.flagged !== flagged) this.index.put({ ...e, seen, flagged })
    }
    const fresh = uids.filter(u => !known.has(u))
    for (let i = 0; i < fresh.length; i += 500) {
      for await (const m of c.fetch(fresh.slice(i, i + 500).join(','), { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true }, { uid: true })) {
        const env = m.envelope ?? {}, from = env.from?.[0] ?? {}
        const e = {
          id: box === main ? `${acc.id}/${role}/${validity}/${m.uid}` : `${acc.id}/${role}/${box}/${validity}/${m.uid}`, account: acc.id, folder: role, box, uidValidity: validity, uid: m.uid,
          date: +(env.date || m.internalDate || 0), from: from.name || from.address || '', fromAddress: from.address || '',
          to: (env.to ?? []).map(a => a.address).filter(Boolean), subject: env.subject || '', messageId: env.messageId || '',
          seen: m.flags.has('\\Seen'), flagged: m.flags.has('\\Flagged'), size: m.size, attachments: countAttachments(m.bodyStructure), snippet: '', saved: false,
        }
        this.index.put(e)
        if (!first && role === 'Inbox' && !e.seen && acc.notify) this.emit('new', e, acc)
      }
      this.changed()
    }
  }

  /** The mails of a folder not on disk yet, newest first: each written, its attachments beside it, then green. */
  async bodies(c, acc, role, box, run, main = box) {
    const todo = this.mine(acc, role, box, main).filter(e => !e.file && !e.gone).sort((a, b) => b.date - a.date)
    if (!todo.length) return
    // A mail moved (here, on a phone, on the web) is a new one in its new folder and gone from the old: its file follows it
    // by Message-ID instead of coming down again.
    const moved = new Map()
    for (const e of this.index.all()) if (e.account === acc.id && e.gone && e.file && e.messageId) moved.set(e.messageId, e)
    let open = false
    for (const e of todo) {
      if (run.stop) return
      const was = e.messageId && moved.get(e.messageId)
      if (was) {
        moved.delete(e.messageId)
        this.index.put({ ...e, ...this.relocate(acc, was, e) }); this.index.put({ ...was, file: null, movedTo: e.id })
        this.changed()
        continue
      }
      if (!open) { await c.mailboxOpen(box, { readOnly: true }); open = true }
      try {
        const m = await c.fetchOne(String(e.uid), { source: true }, { uid: true })
        if (!m?.source) continue
        this.index.put({ ...e, ...(await this.store(acc, e, m.source)) })
        this.changed()
      } catch (err) {
        if (!c.usable) throw err // the connection: the account's loop connects again
        console.warn('[mail]', e.id, err.message) // one mail the server will not give stays orange; the rest go on
      }
    }
  }

  /** A gone mail's file (and its attachments) moved to where [e] lives now; nothing is copied or deleted. */
  relocate(acc, was, e) {
    const from = path.join(this.root, was.file), base = mailName(e.date, e.from || e.fromAddress, e.subject)
    const keep = { saved: was.saved, attachments: was.attachments, snippet: was.snippet }
    const folder = path.join(this.root, acc.id, e.folder)
    if (path.dirname(from) === path.dirname(path.join(folder, base))) return { ...keep, file: was.file } // the same place on disk (Archive's year folders)
    let name = base
    for (let i = 2; fs.existsSync(path.join(folder, name + '.eml')); i++) name = `${base} (${i})`
    const file = path.join(folder, name + '.eml')
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.renameSync(from, file)
      if (fs.existsSync(from.slice(0, -4) + '.files')) fs.renameSync(from.slice(0, -4) + '.files', file.slice(0, -4) + '.files')
    } catch (err) { console.warn('[mail] not moved', was.file, err.message); return { ...keep, file: was.file } }
    return { ...keep, file: path.relative(this.root, file).split(path.sep).join('/') }
  }

  /** Writes one mail and its attachments; what the index learns from it. */
  async store(acc, e, source) {
    const { simpleParser } = require('mailparser')
    const folder = path.join(this.root, acc.id, e.folder), base = mailName(e.date, e.from || e.fromAddress, e.subject)
    let name = base
    for (let i = 2; fs.existsSync(path.join(folder, name + '.eml')); i++) name = `${base} (${i})`
    const file = path.join(folder, name + '.eml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(part(file), source); fs.renameSync(part(file), file)
    const p = await simpleParser(source, { skipTextLinks: true }).catch(() => null)
    const files = (p?.attachments ?? []).filter(a => !a.related) // pictures inside the text are part of the mail
    if (files.length) {
      const dir = file.slice(0, -4) + '.files', taken = new Set()
      fs.mkdirSync(dir, { recursive: true })
      for (const a of files) {
        const raw = clean(a.filename, 150) || 'attachment', dot = raw.lastIndexOf('.')
        let n = raw
        for (let i = 2; taken.has(n.toLowerCase()); i++) n = dot > 0 ? `${raw.slice(0, dot)} (${i})${raw.slice(dot)}` : `${raw} (${i})`
        taken.add(n.toLowerCase())
        fs.writeFileSync(path.join(dir, n), a.content)
      }
    }
    if (e.date) try { fs.utimesSync(file, new Date(e.date), new Date(e.date)) } catch {}
    return {
      file: path.relative(this.root, file).split(path.sep).join('/'),
      saved: source.length === e.size, // "checked": the bytes on disk are the bytes the server has
      attachments: p ? files.length : e.attachments,
      snippet: (p?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }
  }

  /** A short connection of its own for an action, one at a time per account, so the sync's open folder is never changed under it. */
  withClient(acc, fn) {
    const run = async () => {
      const pass = this.secret(acc.id)
      if (!pass) throw Object.assign(new Error('No password saved on this computer'), { reason: 'auth' })
      const c = this.connect(acc.server, acc.server.user, pass)
      try { await c.connect(); return await fn(c) } catch (e) { throw e.reason ? e : failure(e) } finally { await c.logout().catch(() => c.close()) }
    }
    const p = (this.queue[acc.id] ?? Promise.resolve()).then(run, run)
    this.queue[acc.id] = p.catch(() => {})
    return p
  }

  /**
   * One action, from the window or a phone's request (MAIL_PLAN §10 step 3): done on the server, then in the index.
   * The local copy is never deleted: a mail moved away is gone from its folder here until the sync finds it in the new
   * one, where its file follows it (bodies); one deleted for good on the server stays on disk, out of the lists.
   */
  async act({ op, ids, to } = {}) {
    if (!OPS.includes(op)) throw new Error(`Unknown mail action: ${op}`)
    if (op === 'move' && !ROLES.includes(to)) throw new Error(`No such folder: ${to}`)
    if (!Array.isArray(ids) || ids.length > 5000) throw new Error('Which mails?')
    const byAccount = new Map()
    for (const e of [...new Set(ids)].map(id => this.index.get(String(id))).filter(e => e && !e.gone)) byAccount.set(e.account, [...(byAccount.get(e.account) ?? []), e])
    for (const [id, list] of byAccount) {
      const acc = this.accounts().find(a => a.id === id)
      if (!acc) continue
      await this.withClient(acc, c => this.apply(c, acc, op, list, to))
      if (!['read', 'unread', 'favorite', 'unfavorite'].includes(op)) this.live.get(id)?.wake?.('all')
    }
    this.index.flush(); this.changed()
  }

  async apply(c, acc, op, list, to) {
    const folders = await c.list(), boxes = roles(folders), paths = new Set(folders.map(f => f.path))
    const byBox = new Map()
    for (const e of list) { const box = e.box ?? boxes[e.folder]; if (box) byBox.set(box, [...(byBox.get(box) ?? []), e]) }
    for (const [box, all] of byBox) {
      const lock = await c.getMailboxLock(box)
      try {
        const es = all.filter(e => e.uidValidity === String(c.mailbox.uidValidity)) // the folder was rebuilt: those uids are not these mails
        if (!es.length) continue
        const uids = es.map(e => e.uid).join(',')
        const flag = { read: ['\\Seen', true], unread: ['\\Seen', false], favorite: ['\\Flagged', true], unfavorite: ['\\Flagged', false] }[op]
        if (flag) {
          await (flag[1] ? c.messageFlagsAdd(uids, [flag[0]], { uid: true }) : c.messageFlagsRemove(uids, [flag[0]], { uid: true }))
          for (const e of es) this.index.put({ ...e, [flag[0] === '\\Seen' ? 'seen' : 'flagged']: flag[1] })
          continue
        }
        if (op === 'delete' && box === boxes.Trash) { // already in the Trash: deleted on the server; the copy here stays
          await c.messageDelete(uids, { uid: true })
          for (const e of es) this.index.put({ ...e, gone: true })
          continue
        }
        const targets = new Map()
        for (const e of es) {
          const dest = op === 'archive' ? await this.archiveBox(c, acc, boxes, folders, paths, e.date)
            : boxes[{ delete: 'Trash', spam: 'Spam', notSpam: 'Inbox', move: to }[op]]
          if (!dest) throw Object.assign(new Error(`This account has no ${op === 'delete' ? 'Trash' : op === 'spam' ? 'Spam' : to} folder`), { reason: 'noFolder' })
          if (dest !== box) targets.set(dest, [...(targets.get(dest) ?? []), e])
        }
        for (const [dest, moving] of targets) {
          await c.messageMove(moving.map(e => e.uid).join(','), dest, { uid: true })
          for (const e of moving) this.index.put({ ...e, gone: true })
        }
      } finally { lock.release() }
    }
  }

  /**
   * Where Archive puts a mail of [date]: the account's Archive folder (made, named Archive, when the server has none — on
   * Gmail a label, which takes the mail out of the Inbox), in a folder per year or per month as the account says
   * (`archiveBy`: year, the default as in Thunderbird; month; none).
   */
  async archiveBox(c, acc, boxes, folders, paths, date) {
    if (!boxes.Archive) { if (!paths.has('Archive')) await c.mailboxCreate('Archive'); paths.add('Archive'); boxes.Archive = 'Archive' }
    const d = new Date(date || Date.now()), by = acc.archiveBy ?? 'year'
    const sep = folders.find(f => f.path === boxes.Archive)?.delimiter || '/'
    const parts = by === 'none' ? [] : by === 'month' ? [String(d.getFullYear()), pad(d.getMonth() + 1)] : [String(d.getFullYear())]
    let box = boxes.Archive
    for (const p of parts) {
      box += sep + p
      if (!paths.has(box)) { await c.mailboxCreate(box); paths.add(box) }
    }
    return box
  }

  /**
   * The phones' and tablets' actions (MAIL_PLAN §10 step 3): `requests/<device>-<ms>.json`, each { op, ids, to?, at },
   * carried out oldest first and removed. One that cannot be done now (no connection, a password to fix) waits for the
   * next look; one that can never be done (an unknown action, mails long gone) is removed and said in the log.
   */
  async requests() {
    if (this.requesting) return
    this.requesting = true
    try {
      const dir = path.join(this.root, 'requests')
      let names = []
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('.')) } catch { return }
      const jobs = []
      for (const n of names) try { jobs.push({ file: path.join(dir, n), r: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }) } catch {} // half-arrived: the next look
      for (const { file, r } of jobs.sort((a, b) => (Number(a.r?.at) || 0) - (Number(b.r?.at) || 0))) {
        try { await this.act(r) } catch (e) {
          if (['unreachable', 'auth'].includes(e.reason)) continue
          console.warn('[mail] request dropped', path.basename(file), e.message)
        }
        fs.rmSync(file, { force: true })
      }
    } finally { this.requesting = false }
  }
  /** Looks for requests as they arrive (sync writes them) and every minute, for the ones that waited. */
  watchRequests() {
    const dir = path.join(this.root, 'requests')
    fs.mkdirSync(dir, { recursive: true })
    let settle = null
    const soon = () => { clearTimeout(settle); settle = setTimeout(() => this.requests().catch(e => console.warn('[mail]', e.message)), 500) }
    try { this.watcher = fs.watch(dir, soon) } catch (e) { console.warn('[mail] cannot watch requests', e.message) }
    this.retry = setInterval(soon, 60_000)
    soon()
  }

  /** The unified folders: per role, each account's unread, total and orange counts, with the account's state. */
  folders() {
    const accs = this.accounts(), at = new Map()
    const out = ROLES.map(role => ({ role, accounts: accs.map(a => { const x = { id: a.id, unread: 0, total: 0, orange: 0 }; at.set(`${role}\n${a.id}`, x); return x }) }))
    for (const e of this.index.all()) {
      const x = !e.gone && at.get(`${e.folder}\n${e.account}`)
      if (!x) continue
      x.total++; if (!e.seen) x.unread++; if (!e.saved) x.orange++
    }
    return out
  }
  status() { return this.state }

  /** A folder's mails, of one account or all; never the gone ones. */
  list(role, account = null) {
    const ids = new Set(this.accounts().map(a => a.id))
    return [...this.index.all()].filter(e => e.folder === role && !e.gone && ids.has(e.account) && (!account || e.account === account))
  }

  /** A mail to read: its text, the HTML with its inline pictures, and its attachments on disk. */
  async open(id) {
    const e = this.index.get(id)
    if (!e) return null
    if (!e.file) return { ...e, missing: true }
    const { simpleParser } = require('mailparser')
    const file = path.join(this.root, e.file)
    const p = await simpleParser(fs.readFileSync(file))
    let html = p.html || p.textAsHtml || ''
    for (const a of p.attachments) if (a.related && a.cid && a.size < 5e6) html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`)
    const dir = file.slice(0, -4) + '.files'
    let attachments = []
    try { attachments = fs.readdirSync(dir).map(n => ({ name: n, size: fs.statSync(path.join(dir, n)).size, file: `${e.file.slice(0, -4)}.files/${n}` })) } catch {}
    return { ...e, to: p.to?.text ?? e.to.join(', '), cc: p.cc?.text ?? '', html, attachments }
  }

  /** A path inside the archive, or null for anything that would leave it. */
  inside(rel) {
    const full = path.resolve(this.root, String(rel))
    return full.startsWith(this.root + path.sep) && fs.existsSync(full) ? full : null
  }
}

module.exports = { Mail, Index, ROLES, OPS, detect, check, parseConfig, roles, places, mailName, clean, userName, reason }
