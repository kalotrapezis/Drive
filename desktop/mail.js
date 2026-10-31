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
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { t, locale } = require('./i18n')

const ROLES = ['Inbox', 'Drafts', 'Sent', 'Archive', 'Spam', 'Trash']
const SPECIAL = { '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Archive': 'Archive', '\\Junk': 'Spam', '\\Trash': 'Trash' }
const COLORS = ['#e5534b', '#4f8ff7', '#e0a43a', '#3fb27f', '#b77ce6', '#e57ab0', '#3bb8c4']
const EVERY = 15 * 60_000 // a full look at every folder; new mail in the Inbox comes at once by IDLE

const GMAIL = { host: 'imap.gmail.com', port: 993, secure: true, users: ['%EMAILADDRESS%'], provider: 'google', smtp: { host: 'smtp.gmail.com', port: 465, secure: true } }
const MICROSOFT = { host: 'outlook.office365.com', port: 993, secure: true, users: ['%EMAILADDRESS%'], provider: 'microsoft', smtp: { host: 'smtp.office365.com', port: 587, secure: false } }
/** Known providers first (MAIL_PLAN §9b); sch.gr's own server takes the user name without @sch.gr. */
const KNOWN = {
  'gmail.com': GMAIL, 'googlemail.com': GMAIL,
  'sch.gr': { host: 'mail.sch.gr', port: 993, secure: true, users: ['%EMAILLOCALPART%', '%EMAILADDRESS%'], provider: null, smtp: { host: 'mail.sch.gr', port: 465, secure: true } },
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
  const out = /<outgoingServer\s+type="smtp">([\s\S]*?)<\/outgoingServer>/.exec(String(xml))?.[1] ?? ''
  const otag = n => new RegExp(`<${n}>([^<]*)</${n}>`).exec(out)?.[1]?.trim()
  const smtp = otag('hostname') && Number(otag('port')) > 0 ? { host: otag('hostname'), port: Number(otag('port')), secure: otag('socketType') === 'SSL' } : null
  return { host, port, secure: tag('socketType') === 'SSL', users: [tag('username') || '%EMAILADDRESS%'], provider, smtp }
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
const failure = e => Object.assign(new Error(e?.responseText || e?.message || String(e)), { reason: e?.reason ?? reason(e) })

/** [auth]: a password, or { accessToken } for an account signed in with Microsoft (XOAUTH2). */
function client(server, user, auth) {
  const { ImapFlow } = require('imapflow')
  const c = new ImapFlow({ host: server.host, port: server.port, secure: server.secure, auth: typeof auth === 'string' ? { user, pass: auth } : { user, accessToken: auth.accessToken },
    logger: false, maxIdleTime: 10 * 60_000 })
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
  /** [token](acc): an access token for an account signed in with Microsoft (main keeps and renews it, msauth.js). */
  constructor(root, { secret, token = null, connect = client, smtp = o => require('nodemailer').createTransport(o) }) {
    super()
    this.root = root; this.secret = secret; this.token = token; this.connect = connect; this.smtp = smtp
    this.index = new Index(path.join(root, 'index.jsonl'))
    this.live = new Map()  // account id → its loop: { acc, stop, client, wake }
    this.state = {}        // account id → { busy, error }
    this.nudge = null
    this.queue = {}        // account id → its actions, one after another
    this.loadForeign()
  }

  // ── What the phones fetch themselves (Tetra-mobile's MAIL_PLAN §11): their own files, read here, never written

  /** index.<device>.jsonl: the phones' lines, by id; a later line without a file does not hide the file an earlier one had. */
  loadForeign() {
    this.foreign = new Map()
    let names = []
    try { names = fs.readdirSync(this.root).filter(n => /^index\..+\.jsonl$/.test(n)).sort() } catch {}
    for (const n of names) {
      let text = ''
      try { text = fs.readFileSync(path.join(this.root, n), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line), was = e?.id && this.foreign.get(e.id)
          if (e?.id) this.foreign.set(e.id, !e.file && was?.file ? { ...e, file: was.file, saved: was.saved } : e)
        } catch {}
      }
    }
  }
  /** A phone's line for a mail whose file is on this disk (sync brought it). */
  foreignFile(id) { const f = this.foreign.get(id); return f?.file && fs.existsSync(path.join(this.root, f.file)) ? f : null }
  /** Accounts a phone fetches itself (accounts.<device>.json) and this computer does not: shown dimmed, ⇄ phone, never fetched here. */
  shadows() {
    const own = new Set(this.accounts().map(a => a.id)), out = new Map()
    let names = []
    try { names = fs.readdirSync(this.root).filter(n => /^accounts\..+\.json$/.test(n)).sort() } catch {}
    for (const n of names) {
      let list = []
      try { list = JSON.parse(fs.readFileSync(path.join(this.root, n), 'utf8')) } catch { continue }
      for (const a of Array.isArray(list) ? list : [list]) if (a?.id && !own.has(a.id) && !out.has(a.id))
        out.set(a.id, { ...a, shadow: true, device: a.device ?? n.slice(9, -5), serverClean: a.serverClean ?? { on: false }, localClean: a.localClean ?? { on: false } })
    }
    return [...out.values()]
  }
  allAccounts() { return [...this.accounts(), ...this.shadows()] }
  /** A mail as this computer knows it: its own line (with a phone's file when it has none here), else a phone's line. */
  entry(id) {
    const e = this.index.get(id)
    if (!e) return this.foreign.get(id) ?? null
    const f = !e.file && this.foreignFile(id)
    return f ? { ...e, file: f.file, saved: f.saved } : e
  }
  /** Every mail: this computer's lines, then the phones' lines for mail it does not know. */
  *view() {
    for (const e of this.index.all()) { const f = !e.file && this.foreign.size ? this.foreignFile(e.id) : null; yield f ? { ...e, file: f.file, saved: f.saved } : e }
    for (const [id, f] of this.foreign) if (!this.index.get(id)) yield f
  }

  accounts() { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'accounts.json'), 'utf8')) } catch { return [] } }
  saveAccounts(list) {
    fs.mkdirSync(this.root, { recursive: true })
    const file = path.join(this.root, 'accounts.json')
    fs.writeFileSync(part(file), JSON.stringify(list, null, 2)); fs.renameSync(part(file), file)
  }

  /** A new account from a check that passed, with the plan's defaults (MAIL_PLAN §3, §9b); syncing starts at once. */
  add({ address, name, server, user, auth = 'password' }) {
    const list = this.accounts().filter(a => a.id !== address)
    const used = new Set(list.map(a => a.color))
    const acc = {
      id: address, address, name: name || (/^(gmail|googlemail)\.com$/.test(address.split('@')[1]) ? 'Gmail' : address.split('@')[1]), color: COLORS.find(c => !used.has(c)) ?? COLORS[list.length % COLORS.length],
      server: { host: server.host, port: server.port, secure: server.secure, user }, provider: server.provider ?? null,
      // shortcut: a server found by guessing sends through its own host on 465; a different one needs editing accounts.json
      smtp: server.smtp ?? { host: server.host, port: 465, secure: true },
      archive: true, archiveBy: 'year', serverClean: { on: true, attachmentsMonths: 36, otherMonths: 24 }, localClean: { on: false }, notify: true,
      auth, addedOn: 'desktop', added: Date.now(),
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
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id); for (const w of this.watchers ?? []) w.close(); clearInterval(this.retry); this.index.flush() }
  /** archiveBy (year, month, none) and the like, kept in accounts.json. */
  setAccount(id, changes) {
    const list = this.accounts(), a = list.find(x => x.id === id)
    if (!a) return
    if (['year', 'month', 'none'].includes(changes?.archiveBy)) a.archiveBy = changes.archiveBy
    // the clean-up's switches and ages (MAIL_PLAN §3), in months, 1 to 50 years
    const ages = (x, was) => x && typeof x === 'object' ? { ...was, ...(typeof x.on === 'boolean' ? { on: x.on } : {}),
      ...Object.fromEntries(['attachmentsMonths', 'otherMonths'].filter(k => Number.isInteger(x[k]) && x[k] >= 1 && x[k] <= 600).map(k => [k, x[k]])) } : was
    a.serverClean = ages(changes?.serverClean, a.serverClean)
    a.localClean = ages(changes?.localClean, a.localClean)
    if (typeof changes?.keepFavorites === 'boolean') a.keepFavorites = changes.keepFavorites
    this.saveAccounts(list); this.changed()
  }
  syncNow() { for (const id of this.live.keys()) this.kick(id) }
  /** Another pass soon; remembered when it comes between two passes, so it is never lost. */
  kick(id, what = 'all') { const run = this.live.get(id); if (!run) return; run.again = run.again === 'all' ? 'all' : what; run.wake?.(what) }

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
    const c = run.client = this.connect(acc.server, acc.server.user, await this.login(acc))
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
      run.fresh = []
      for (const role of ROLES) for (const [r, box] of now) if (r === role) await this.bodies(c, acc, role, box, run, boxes[role])
      this.index.flush()
      // new mail through the filters and the spam filter (once on disk, so they can read it); then the daily clean-up
      const care = require('./mailclean')
      await care.onNew(this, run.fresh.splice(0), { filesRoot: this.filesRoot }).catch(e => console.warn('[mail] new mail', e.message))
      await care.daily(this, this.accounts().find(a => a.id === acc.id) ?? acc).catch(e => console.warn('[mail] clean-up', e.message))
      this.setState(acc.id, { busy: false, synced: Date.now() })
      this.requests().catch(() => {}) // a phone's actions that waited for the connection
      if (run.stop) return
      if (boxes.Inbox) { await c.mailboxOpen(boxes.Inbox, { readOnly: true }); c.idle().catch(() => {}) } // at once, not after imapflow's 15 s
      // shortcut: mail arriving while another folder is open waits for the quarter-hour look; enough for one person
      const onNew = () => this.kick(acc.id, 'inbox')
      c.on('exists', onNew)
      if (run.again) { what = run.again; run.again = null } // asked for while the last pass was ending
      else { what = await Promise.race([closed, sleep(EVERY, run).then(w => w ?? 'all')]); run.again = null }
      c.off('exists', onNew)
      if (what === 'closed' || what === 'stop' || run.stop) return
    }
  }

  /** The mails of one server folder; a line from before folders were noted (`box`) is the role's own folder. */
  mine(acc, role, box, main = box) { return [...this.index.all()].filter(e => e.account === acc.id && e.folder === role && (e.box ?? main) === box) }

  /** A folder's list: new mails' headers (orange until fetched), flags of the known ones, the gone ones marked. */
  async headers(c, acc, role, box, main = box, run = this.live.get(acc.id)) {
    await c.mailboxOpen(box, { readOnly: true })
    const validity = String(c.mailbox.uidValidity)
    const mine = this.mine(acc, role, box, main), first = !mine.length
    const known = new Map(mine.filter(e => e.uidValidity === validity && !e.gone).map(e => [e.uid, e]))
    const uids = (c.mailbox.exists && await c.search({ all: true }, { uid: true })) || []
    const there = new Set(uids)
    for (const e of mine) if (!e.gone && e.uidValidity !== 'local' && (e.uidValidity !== validity || !there.has(e.uid))) this.index.put({ ...e, gone: true })
    // what Tetra wrote itself (a sent mail, a draft) waits as 'local' until the server's copy turns up, and gives it its file
    const locals = new Map(mine.filter(e => e.uidValidity === 'local' && !e.gone).map(e => [e.messageId, e]))
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
        const local = e.messageId && locals.get(e.messageId)
        if (local) {
          locals.delete(e.messageId)
          if (local.file && local.size === e.size) Object.assign(e, { file: local.file, saved: true, snippet: local.snippet, attachments: local.attachments })
          else if (local.file) this.unlink(local.file) // the server changed it (Gmail's Sent copy): its own copy comes down instead
          this.index.put({ ...local, gone: true, file: null, movedTo: e.id })
        }
        this.index.put(e)
        if (!first && role === 'Inbox') { run?.fresh?.push(e); if (!e.seen && acc.notify) this.emit('new', e, acc) }
      }
      this.changed()
    }
  }

  /** The mails of a folder not on disk yet, newest first: each written, its attachments beside it, then green. */
  async bodies(c, acc, role, box, run, main = box) {
    const todo = this.mine(acc, role, box, main).filter(e => !e.file && !e.gone && !e.pruned).sort((a, b) => b.date - a.date) // pruned: let go here by the clean-up, not fetched again
    if (!todo.length) return
    // A mail moved (here, on a phone, on the web) is a new one in its new folder and gone from the old: its file follows it
    // by Message-ID instead of coming down again.
    const moved = new Map()
    for (const e of this.index.all()) if (e.account === acc.id && e.gone && e.file && e.messageId) moved.set(e.messageId, e)
    let open = false
    for (const e of todo) {
      if (run.stop) return
      const theirs = this.foreignFile(e.id) // the phone fetched it too (the same account on both): its file, not a second download
      if (theirs) {
        let size = 0
        try { size = fs.statSync(path.join(this.root, theirs.file)).size } catch {}
        this.index.put({ ...e, file: theirs.file, saved: size === e.size, snippet: theirs.snippet || e.snippet, attachments: theirs.attachments ?? e.attachments })
        this.changed()
        continue
      }
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

  /** The local spam filter, read once. */
  junk() { const { Junk } = require('./mailclean'); return this.junkFilter ??= new Junk(path.join(this.root, 'junk.json')) }
  /** A mail's folder on the server, for a line from before folders were noted. */
  async boxOf(c, e) { return e.box ?? roles(await c.list())[e.folder] }

  /** privacy.json (§9c): remote content off by default; the senders and domains it is always shown for. */
  privacy() { try { return { images: 'ask', senders: [], ...JSON.parse(fs.readFileSync(path.join(this.root, 'privacy.json'), 'utf8')) } } catch { return { images: 'ask', senders: [] } } }
  setPrivacy(p) {
    const value = { images: p?.images === 'always' ? 'always' : 'ask', senders: [...new Set((p?.senders ?? []).map(s => String(s).trim().toLowerCase()).filter(s => /^[^\s]*@?[^\s@]+\.[^\s@]+$/.test(s)))].slice(0, 2000) }
    fs.mkdirSync(this.root, { recursive: true })
    const file = path.join(this.root, 'privacy.json')
    fs.writeFileSync(part(file), JSON.stringify(value, null, 2)); fs.renameSync(part(file), file)
    return value
  }
  /** The pictures a mail loads from the web, fetched here and put into it, so the page loads nothing itself; 1×1 trackers never. */
  remoteImages(html) {
    const found = [...html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)[^>]*>/gi)]
    return [...new Set(found.filter(m => !/\s(width|height)\s*=\s*["']?[01]["'\s>/]/i.test(m[0])).map(m => m[1]))].slice(0, 40)
  }
  async inlineImages(html) {
    for (const u of this.remoteImages(html)) try {
      const r = await fetch(u.replace(/&amp;/g, '&'), { signal: AbortSignal.timeout(8000) })
      const type = (r.headers.get('content-type') ?? '').split(';')[0]
      if (!r.ok || !type.startsWith('image/')) continue
      const b = Buffer.from(await r.arrayBuffer())
      if (b.length <= 3e6) html = html.split(u).join(`data:${type};base64,${b.toString('base64')}`)
    } catch {}
    return html
  }

  /** How this account signs in here: its password, or a Microsoft access token. Throws, with a reason, when it cannot. */
  async login(acc) {
    if (acc.auth === 'microsoft') {
      if (!this.token) throw Object.assign(new Error('Microsoft sign-in is not set up here'), { reason: 'noClient', authenticationFailed: true })
      return { accessToken: await this.token(acc) }
    }
    const pass = this.secret(acc.id)
    if (!pass) throw Object.assign(new Error('No password saved on this computer'), { reason: 'auth', authenticationFailed: true })
    return pass
  }

  /** A short connection of its own for an action, one at a time per account, so the sync's open folder is never changed under it. */
  withClient(acc, fn) {
    const run = async () => {
      const c = this.connect(acc.server, acc.server.user, await this.login(acc))
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
  async act({ op, ids, to, learn = true } = {}) {
    if (!OPS.includes(op)) throw new Error(`Unknown mail action: ${op}`)
    if (op === 'move' && !ROLES.includes(to)) throw new Error(`No such folder: ${to}`)
    if (!Array.isArray(ids) || ids.length > 5000) throw new Error('Which mails?')
    const byAccount = new Map()
    for (const e of [...new Set(ids)].map(id => this.index.get(String(id))).filter(e => e && !e.gone)) byAccount.set(e.account, [...(byAccount.get(e.account) ?? []), e])
    for (const [id, list] of byAccount) {
      const acc = this.accounts().find(a => a.id === id)
      if (!acc) continue
      await this.withClient(acc, c => this.apply(c, acc, op, list, to))
      if (!['read', 'unread', 'favorite', 'unfavorite'].includes(op)) this.kick(id)
      if (learn && (op === 'spam' || op === 'notSpam')) { // Spam and Not spam teach the local filter (§5)
        const { mailText } = require('./mailclean'), junk = this.junk()
        for (const e of list) junk.train(await mailText(this, e), op === 'spam')
        junk.save()
      }
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
  /** Looks at requests/ and outbox/ as sync writes into them, and every minute for what waited. */
  watchRequests() {
    this.watchers = []
    let settle = null
    const soon = () => { clearTimeout(settle); settle = setTimeout(() => { this.requests().catch(e => console.warn('[mail]', e.message)); this.outbox().catch(e => console.warn('[mail]', e.message)) }, 500) }
    for (const name of ['requests', 'outbox']) {
      const dir = path.join(this.root, name)
      fs.mkdirSync(dir, { recursive: true })
      try { this.watchers.push(fs.watch(dir, soon)) } catch (e) { console.warn('[mail] cannot watch', name, e.message) }
    }
    this.retry = setInterval(soon, 60_000)
    soon()
    let again = null
    try {
      this.watchers.push(fs.watch(this.root, (_, name) => {
        if (!/^(index\..+\.jsonl|accounts\..+\.json)$/.test(String(name ?? ''))) return
        clearTimeout(again); again = setTimeout(() => { this.loadForeign(); this.changed() }, 1000)
      }))
    } catch (e) { console.warn('[mail] cannot watch the phones\' files', e.message) }
  }

  // ── Writing (MAIL_PLAN §10 step 4)

  account(id) {
    const acc = this.accounts().find(a => a.id === id)
    if (!acc) throw Object.assign(new Error(`No account ${id}`), { reason: 'other' })
    return acc
  }
  /** A file Tetra wrote itself and is replacing (an old draft, a sent copy the server changed), with its attachments. */
  unlink(rel) {
    const full = this.inside(rel)
    if (!full) return
    fs.rmSync(full, { force: true }); fs.rmSync(full.slice(0, -4) + '.files', { recursive: true, force: true })
  }
  /** The name in this account's own sent mail, so a new mail says "Theologos Kalotrapezis" as the old ones did. */
  fromName(acc) {
    const names = new Map()
    for (const e of this.index.all()) if (e.account === acc.id && e.folder === 'Sent' && e.fromAddress?.toLowerCase() === acc.address && e.from && e.from !== e.fromAddress) names.set(e.from, (names.get(e.from) ?? 0) + 1)
    return [...names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  /** Where an attachment of a draft is: `file` inside the archive (a phone's outbox, a mail forwarded), or `path`, a file this computer picked. */
  attachmentPath(a) {
    if (a?.file) { const f = this.inside(a.file); if (f) return f }
    if (a?.path && this.picked?.has(a.path) && fs.existsSync(a.path)) return a.path
    throw Object.assign(new Error(`${a?.name ?? 'An attachment'} is not there any more`), { reason: 'other' })
  }

  /**
   * A draft (the window's, or a phone's outbox) as MIME bytes: { account, to, cc, bcc (envelope only), subject, html,
   * inReplyTo, references, attachments: [{ name, file | path, type? }], messageId }. The text copy is made from the HTML.
   */
  async compose(acc, d) {
    const MailComposer = require('nodemailer/lib/mail-composer')
    const { convert } = require('html-to-text')
    const html = String(d.html ?? '')
    const list = x => (Array.isArray(x) ? x : []).filter(a => a?.address).map(a => ({ name: String(a.name ?? ''), address: String(a.address) }))
    const raw = await new MailComposer({
      from: { name: this.fromName(acc), address: acc.address }, to: list(d.to), cc: list(d.cc), subject: String(d.subject ?? ''),
      html, text: convert(html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }] }), messageId: d.messageId, date: new Date(),
      inReplyTo: d.inReplyTo || undefined, references: d.references?.length ? d.references : undefined,
      attachments: (d.attachments ?? []).map(a => ({ filename: String(a.name), path: this.attachmentPath(a), ...(a.type ? { contentType: a.type } : {}) })),
    }).compile().build()
    return raw
  }
  newId(acc) { return `<${crypto.randomUUID()}@${acc.address.split('@')[1]}>` }

  /** A copy of what Tetra wrote, kept here at once (green) as 'local' until the server's copy turns up (headers). */
  async keep(acc, role, raw, draft) {
    const e = {
      id: `${acc.id}/${role}/local/${draft.messageId}`, account: acc.id, folder: role, uidValidity: 'local', uid: 0, date: Date.now(),
      from: this.fromName(acc) || acc.address, fromAddress: acc.address, to: (draft.to ?? []).map(a => a.address), subject: String(draft.subject ?? ''),
      messageId: draft.messageId, seen: true, flagged: false, size: raw.length, attachments: (draft.attachments ?? []).length, snippet: '', saved: false,
    }
    this.index.put({ ...e, ...(await this.store(acc, e, raw)) })
    this.index.flush(); this.changed()
  }
  /** This draft, every version of it, here: a draft is kept as its last version only. */
  dropDraft(acc, messageId) {
    for (const e of [...this.index.all()]) if (e.account === acc.id && e.folder === 'Drafts' && e.messageId === messageId && !e.gone) {
      if (e.file) this.unlink(e.file)
      this.index.put({ ...e, gone: true, file: null })
    }
  }
  /** On the server: the draft's old versions out of Drafts, and [raw] in when there is one. */
  async serverDraft(acc, messageId, raw) {
    await this.withClient(acc, async c => {
      const box = roles(await c.list()).Drafts
      if (!box) return
      const lock = await c.getMailboxLock(box)
      try {
        const old = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || []
        if (raw) await c.append(box, raw, ['\\Draft', '\\Seen'])
        if (old.length) await c.messageDelete(old.join(','), { uid: true })
      } finally { lock.release() }
    })
  }

  /** Saved as it is typed: here at once, on the server when it can be. { messageId, server }. */
  async saveDraft(d) {
    const acc = this.account(d.account), draft = { ...d, messageId: d.messageId || this.newId(acc) }
    const raw = await this.compose(acc, draft)
    this.dropDraft(acc, draft.messageId)
    await this.keep(acc, 'Drafts', raw, draft)
    try { await this.serverDraft(acc, draft.messageId, raw); return { messageId: draft.messageId, server: true } }
    catch (e) { console.warn('[mail] draft kept here only', e.message); return { messageId: draft.messageId, server: false } }
  }
  async discardDraft(d) {
    const acc = this.account(d.account)
    if (!d.messageId) return
    this.dropDraft(acc, d.messageId); this.index.flush(); this.changed()
    await this.serverDraft(acc, d.messageId, null).catch(e => console.warn('[mail] draft left on the server', e.message))
  }

  /** The account's SMTP server: from accounts.json, or found again for an account added before Tetra could send. */
  async smtpFor(acc) {
    if (acc.smtp) return acc.smtp
    const smtp = (await detect(acc.address).catch(() => null))?.server.smtp ?? { host: acc.server.host, port: 465, secure: true }
    this.saveAccounts(this.accounts().map(a => a.id === acc.id ? { ...a, smtp } : a))
    return smtp
  }

  /**
   * Sends by SMTP with the account's own password; the same bytes are kept here in Sent (green at once) and put in the
   * server's Sent (Gmail files its own copy); the draft it came from goes. [raw]: a phone's ready .eml.
   */
  async send(d, raw = null) {
    const acc = this.account(d.account), draft = { ...d, messageId: d.messageId || this.newId(acc) }
    if (raw) {
      const { simpleParser } = require('mailparser')
      const p = await simpleParser(raw)
      const all = x => (Array.isArray(x) ? x : x ? [x] : []).flatMap(a => a.value ?? [])
      Object.assign(draft, { to: all(p.to), cc: all(p.cc), subject: p.subject ?? '', messageId: p.messageId || draft.messageId, attachments: p.attachments.filter(a => !a.related) })
    } else raw = await this.compose(acc, draft)
    const to = [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map(a => String(a?.address ?? '')).filter(a => /^[^\s@<>]+@[^\s@<>]+$/.test(a))
    if (!to.length) throw Object.assign(new Error('No one to send it to'), { reason: 'noRecipients' })
    const login = await this.login(acc), smtp = await this.smtpFor(acc)
    const transport = this.smtp({ host: smtp.host, port: smtp.port, secure: smtp.secure, connectionTimeout: 20_000,
      auth: typeof login === 'string' ? { user: acc.server.user, pass: login } : { type: 'OAuth2', user: acc.server.user, accessToken: login.accessToken } })
    try { await transport.sendMail({ envelope: { from: acc.address, to }, raw }) } catch (e) { throw failure(e) } finally { transport.close?.() }
    await this.keep(acc, 'Sent', raw, draft)
    if (acc.provider !== 'google') await this.withClient(acc, async c => {
      const box = roles(await c.list()).Sent
      if (box) await c.append(box, raw, ['\\Seen'])
    }).catch(e => console.warn('[mail] sent, but no copy in the server\'s Sent', e.message))
    if (d.messageId) await this.discardDraft({ account: acc.id, messageId: d.messageId })
    this.kick(acc.id)
    return { messageId: draft.messageId }
  }

  /** The HTML of a parsed mail, its inline pictures in it. */
  htmlOf(p) {
    let html = p.html || p.textAsHtml || ''
    for (const a of p.attachments) if (a.related && a.cid && a.size < 5e6) html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`)
    return html
  }
  signatures() { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'signatures.json'), 'utf8')) } catch { return {} } }
  /** One address's signature (MAIL_PLAN §9c): { html, newMail, replies, position: 'above' | 'below' } — the quoted text's. */
  setSignature(address, sig) {
    const all = this.signatures()
    if (!sig) delete all[address]
    else all[address] = { html: String(sig.html ?? ''), newMail: !!sig.newMail, replies: !!sig.replies, position: sig.position === 'above' ? 'above' : 'below' }
    fs.mkdirSync(this.root, { recursive: true })
    const file = path.join(this.root, 'signatures.json')
    fs.writeFileSync(part(file), JSON.stringify(all, null, 2)); fs.renameSync(part(file), file)
  }

  /**
   * A new draft: empty ('new'), or from a mail: 'reply', 'replyAll', 'forward' (inline, its attachments too),
   * 'forwardAttached' (the .eml attached), 'edit' (a draft opened again). The signature goes where the account says.
   */
  async draftFor(id, kind, accountId = null) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    const who = a => a.name ? `${esc(a.name)} &lt;${esc(a.address)}&gt;` : esc(a.address)
    const sign = (acc, reply, body, quote = '') => {
      const s = this.signatures()[acc.address]
      const sig = s?.html && (reply ? s.replies : s.newMail) ? `<div class="tetra-signature">-- <br>${s.html}</div>` : ''
      return s?.position === 'above' || !quote ? `${body}${sig}${quote}` : `${body}${quote}${sig}`
    }
    if (kind === 'new') {
      const acc = this.account(accountId ?? this.accounts()[0]?.id)
      return { account: acc.id, to: [], cc: [], bcc: [], subject: '', html: sign(acc, false, '<p><br></p>'), attachments: [], references: [] }
    }
    const e = this.entry(id)
    const file = e?.file && this.inside(e.file)
    if (!file) throw Object.assign(new Error('This mail is not on this computer yet'), { reason: 'other' })
    // a phone's own account is written from here through one of this computer's (its From can be changed in the window)
    const acc = this.accounts().find(a => a.id === e.account) ?? this.account(this.accounts()[0]?.id), me = String(e.account).toLowerCase()
    const { simpleParser } = require('mailparser')
    const p = await simpleParser(fs.readFileSync(file))
    const list = x => (Array.isArray(x) ? x : x ? [x] : []).flatMap(a => a.value ?? []).filter(a => a.address).map(a => ({ name: a.name ?? '', address: a.address }))
    const files = () => { const dir = file.slice(0, -4) + '.files'; try { return fs.readdirSync(dir).map(n => ({ name: n, file: `${e.file.slice(0, -4)}.files/${n}` })) } catch { return [] } }
    const refs = [...(Array.isArray(p.references) ? p.references : p.references ? [p.references] : []), ...(p.messageId ? [p.messageId] : [])]
    const date = (p.date ?? new Date(e.date)).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
    const from = list(p.from)[0] ?? { name: e.from, address: e.fromAddress }
    if (kind === 'edit') return { account: acc.id, to: list(p.to), cc: list(p.cc), bcc: list(p.bcc), subject: p.subject ?? '', html: p.html || p.textAsHtml || '',
      attachments: files(), messageId: p.messageId, inReplyTo: p.inReplyTo ?? '', references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [] }
    if (kind === 'reply' || kind === 'replyAll') {
      const to = list(p.replyTo).length ? list(p.replyTo) : [from]
      const seen = new Set([me, ...to.map(a => a.address.toLowerCase())])
      const cc = kind === 'replyAll' ? [...list(p.to), ...list(p.cc)].filter(a => !seen.has(a.address.toLowerCase()) && seen.add(a.address.toLowerCase())) : []
      const quote = `<p>${t('mail.wrote', { date: esc(date), from: who(from) })}</p><blockquote type="cite">${this.htmlOf(p)}</blockquote>`
      return { account: acc.id, to, cc, bcc: [], subject: /^\s*(re|απ|σχετ)\s*:/i.test(p.subject ?? '') ? p.subject : `Re: ${p.subject ?? ''}`,
        html: sign(acc, true, '<p><br></p>', quote), attachments: [], inReplyTo: p.messageId ?? '', references: refs }
    }
    if (kind === 'forward' || kind === 'forwardAttached') {
      const head = `<p>-------- ${t('mail.forwarded')} --------<br>${t('mail.hSubject')}: ${esc(p.subject)}<br>${t('mail.hDate')}: ${esc(date)}<br>` +
        `${t('mail.hFrom')}: ${who(from)}<br>${t('mail.hTo')}: ${list(p.to).map(who).join(', ')}</p>`
      return { account: acc.id, to: [], cc: [], bcc: [], subject: `Fwd: ${p.subject ?? ''}`, references: refs,
        html: sign(acc, true, '<p><br></p>', kind === 'forward' ? `${head}${this.htmlOf(p)}` : ''),
        attachments: kind === 'forward' ? files() : [{ name: `${clean(p.subject, 120) || 'mail'}.eml`, file: e.file, type: 'message/rfc822' }] }
    }
    throw new Error(`Unknown draft: ${kind}`)
  }

  /** Every address in the mail here, the most written-to and heard-from first: the address fields' suggestions. */
  addresses() {
    const seen = new Map()
    const add = (address, name) => {
      const k = String(address ?? '').toLowerCase()
      if (!k.includes('@') || /no-?reply|mailer-daemon/.test(k)) return
      const x = seen.get(k) ?? { address: k, name: '', count: 0 }
      x.count++; if (name && name !== address && !x.name) x.name = name
      seen.set(k, x)
    }
    for (const e of this.index.all()) { add(e.fromAddress, e.from); for (const a of e.to ?? []) add(a) }
    return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 3000)
  }

  /**
   * A phone's mail (MAIL_PLAN §11): `outbox/<name>.json` { account, action: 'send' | 'draft' | 'discard', draft, eml?, at }
   * — the draft as the window's, its attachments `file`s inside the archive (`outbox/<name>.files/…` for the phone's own),
   * or a ready `eml` beside it. Done, all of it is removed; one that cannot be done now waits; one that failed for good
   * becomes `<name>.failed.json` with the reason, for the phone to show.
   */
  async outbox() {
    if (this.sending) return
    this.sending = true
    try {
      const dir = path.join(this.root, 'outbox')
      let names = []
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json') && !n.endsWith('.failed.json') && !n.startsWith('.')) } catch { return }
      const jobs = []
      for (const n of names) try { jobs.push({ name: n.slice(0, -5), r: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }) } catch {}
      for (const { name, r } of jobs.sort((a, b) => (Number(a.r?.at) || 0) - (Number(b.r?.at) || 0))) {
        const base = path.join(dir, name)
        const eml = typeof r.eml === 'string' && !r.eml.includes('/') && r.eml.endsWith('.eml') ? path.join(dir, r.eml) : null
        if (eml && !fs.existsSync(eml)) continue // still arriving
        try {
          const draft = { ...(r.draft ?? {}), account: r.account }
          if (r.action === 'send') { await this.send(draft, eml ? fs.readFileSync(eml) : null); this.emit('sent', draft) }
          else if (r.action === 'draft') await this.saveDraft(draft)
          else if (r.action === 'discard') await this.discardDraft(draft)
          else throw new Error(`Unknown outbox action: ${r.action}`)
        } catch (e) {
          if (['unreachable', 'auth'].includes(e.reason)) continue
          console.warn('[mail] outbox', name, e.message)
          fs.writeFileSync(base + '.failed.json', JSON.stringify({ ...r, error: e.reason ?? 'other', detail: e.message }, null, 2))
          this.emit('failed', r, e)
        }
        fs.rmSync(base + '.json', { force: true }); fs.rmSync(base + '.files', { recursive: true, force: true })
        if (eml) fs.rmSync(eml, { force: true })
      }
    } finally { this.sending = false }
  }

  /** The unified folders: per role, each account's unread, total and orange counts, with the account's state. */
  folders() {
    const accs = this.allAccounts(), at = new Map()
    const out = ROLES.map(role => ({ role, accounts: accs.map(a => { const x = { id: a.id, unread: 0, total: 0, orange: 0 }; at.set(`${role}\n${a.id}`, x); return x }) }))
    for (const e of this.view()) {
      const x = !e.gone && at.get(`${e.folder}\n${e.account}`)
      if (!x) continue
      x.total++; if (!e.seen) x.unread++; if (!e.saved) x.orange++
    }
    return out
  }
  status() { return this.state }

  /** Every mail of the accounts here that is still on its server (the assistant's view). */
  accountsMails() { const ids = new Set(this.allAccounts().map(a => a.id)); return [...this.view()].filter(e => !e.gone && ids.has(e.account)) }

  /** A folder's mails, of one account or all; never the gone ones. */
  list(role, account = null) {
    const ids = new Set(this.allAccounts().map(a => a.id))
    return [...this.view()].filter(e => e.folder === role && !e.gone && ids.has(e.account) && (!account || e.account === account))
  }

  /** A mail to read: its text, the HTML with its inline pictures, and its attachments on disk. */
  /** [images]: load this mail's pictures from the web this once («Εμφάνιση εικόνων»); always for an allowed sender. */
  async open(id, { images = false } = {}) {
    const e = this.entry(id)
    if (!e) return null
    if (!e.file) return { ...e, missing: true }
    const { simpleParser } = require('mailparser')
    const file = path.join(this.root, e.file)
    const p = await simpleParser(fs.readFileSync(file))
    let html = this.htmlOf(p)
    const priv = this.privacy(), from = String(e.fromAddress).toLowerCase()
    const allowed = priv.images === 'always' || priv.senders.includes(from) || priv.senders.includes('@' + from.split('@')[1])
    const remote = this.remoteImages(html).length > 0
    if (remote && (images || allowed)) html = await this.inlineImages(html)
    const dir = file.slice(0, -4) + '.files'
    let attachments = []
    try { attachments = fs.readdirSync(dir).map(n => ({ name: n, size: fs.statSync(path.join(dir, n)).size, file: `${e.file.slice(0, -4)}.files/${n}` })) } catch {}
    return { ...e, to: p.to?.text ?? e.to.join(', '), cc: p.cc?.text ?? '', html, attachments, remote: remote && !images && !allowed }
  }

  /** A path inside the archive, or null for anything that would leave it. */
  inside(rel) {
    const full = path.resolve(this.root, String(rel))
    return full.startsWith(this.root + path.sep) && fs.existsSync(full) ? full : null
  }
}

module.exports = { Mail, Index, ROLES, OPS, MICROSOFT, detect, check, parseConfig, roles, places, mailName, clean, userName, reason }
