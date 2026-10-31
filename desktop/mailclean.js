'use strict'
/**
 * Tetra Mail, step 6 (Tetra-mobile's MAIL_PLAN.md §3, §5, §6): keeping the archive and the mailboxes tidy.
 *
 * - Clean-up by age, on the server and in the archive here, each with its own ages (accounts.json `serverClean`,
 *   `localClean`). The server only ever loses mail that is green: saved here and checked byte for byte.
 * - The first-run check (the user, 31 Oct): nothing is cleaned for an account until the user has seen what would be done
 *   and pressed «Εκτέλεση» once (`cleanConfirmed`); after that it runs by itself once a day.
 * - The garbage scan: what in the folder is not what the index says, and its clean-up.
 * - Filters (filters.json) on new mail and on demand, and the local spam filter (junk.json, naive Bayes).
 */
const fs = require('node:fs')
const path = require('node:path')

const MONTH = 30.44 * 86_400_000
const DAY = 86_400_000

/** An account's clean-up settings with the plan's defaults: the server on, 3 years with attachments, 2 without; here off. */
const cleanOf = acc => ({
  server: { on: true, attachmentsMonths: 36, otherMonths: 24, ...acc.serverClean },
  local: { on: false, attachmentsMonths: 120, otherMonths: 120, ...acc.localClean },
  keepFavorites: acc.keepFavorites !== false,
})

/** A mail that is safe to delete on the server: its .eml is here and has as many bytes as the server's. */
function checked(mail, e) {
  if (!e.saved || !e.file) return false
  try { return fs.statSync(path.join(mail.root, e.file)).size === e.size } catch { return false }
}
const sizeOf = (mail, e) => { try { return e.file ? fs.statSync(path.join(mail.root, e.file)).size : e.size ?? 0 } catch { return e.size ?? 0 } }

/**
 * What a clean-up would do now, nothing done: { archive (mails in the Archive not yet in their year or month folder),
 * server (to delete there), local (to delete here), unsafe (old enough for the server, but no checked copy here: kept),
 * warn (both on and the archive here would go before the server: no copy left anywhere) }.
 */
function plan(mail, acc, now = Date.now()) {
  const c = cleanOf(acc), out = { archive: [], server: [], local: [], unsafe: [], warn: false }
  const old = (e, s) => !!e.date && now - e.date > (e.attachments > 0 ? s.attachmentsMonths : s.otherMonths) * MONTH
  const by = acc.archiveBy ?? 'year'
  for (const e of mail.index.all()) {
    if (e.account !== acc.id || e.folder === 'Drafts' || (c.keepFavorites && e.flagged)) continue
    const onServer = !e.gone && e.uidValidity !== 'local'
    if (onServer && c.server.on && old(e, c.server)) (checked(mail, e) ? out.server : out.unsafe).push(e)
    else if (onServer && e.folder === 'Archive' && by !== 'none' && e.date) {
      const d = new Date(e.date), want = by === 'month' ? `${d.getFullYear()}[/.]${String(d.getMonth() + 1).padStart(2, '0')}` : `${d.getFullYear()}`
      if (!new RegExp(`[/.]${want}$`).test(e.box ?? '')) out.archive.push(e)
    }
    if (c.local.on && e.file && old(e, c.local)) out.local.push(e)
  }
  out.warn = c.local.on && c.server.on && (c.local.attachmentsMonths < c.server.attachmentsMonths || c.local.otherMonths < c.server.otherMonths)
  return out
}

/** Counts and sizes, and a few examples, for the window. */
function summary(mail, p) {
  const part = list => ({ count: list.length, bytes: list.reduce((n, e) => n + sizeOf(mail, e), 0),
    sample: list.slice(0, 30).map(e => ({ id: e.id, subject: e.subject, from: e.from || e.fromAddress, date: e.date, folder: e.folder })) })
  return { archive: part(p.archive), server: part(p.server), local: part(p.local), unsafe: part(p.unsafe), warn: p.warn }
}

/** Carries out a plan: archive into year/month folders, delete for good on the server (the copy here stays), delete here. */
async function run(mail, acc, p) {
  const done = { archive: 0, server: 0, local: 0, bytes: 0, errors: [] }
  if (p.archive.length) try { await mail.act({ op: 'archive', ids: p.archive.map(e => e.id) }); done.archive = p.archive.length } catch (e) { done.errors.push(e.message) }
  const server = p.server.filter(e => checked(mail, e)) // checked again, at the moment it counts
  if (server.length) try {
    await mail.withClient(acc, async c => {
      const byBox = new Map()
      for (const e of server) { const box = e.box ?? (await mail.boxOf(c, e)); if (box) byBox.set(box, [...(byBox.get(box) ?? []), e]) }
      for (const [box, list] of byBox) {
        const lock = await c.getMailboxLock(box)
        try {
          const es = list.filter(e => e.uidValidity === String(c.mailbox.uidValidity))
          if (!es.length) continue
          await c.messageDelete(es.map(e => e.uid).join(','), { uid: true })
          for (const e of es) { mail.index.put({ ...mail.index.get(e.id), gone: true, cleaned: Date.now() }); done.server++ }
        } finally { lock.release() }
      }
    })
  } catch (e) { done.errors.push(e.message) }
  for (const e of p.local) {
    const now = mail.index.get(e.id)
    if (!now?.file) continue
    done.bytes += sizeOf(mail, now)
    mail.unlink(now.file)
    mail.index.put({ ...now, file: null, pruned: true }) // not fetched again: the user let it go
    done.local++
  }
  mail.saveAccounts(mail.accounts().map(a => a.id === acc.id ? { ...a, cleanConfirmed: true, cleanedAt: Date.now() } : a))
  mail.index.flush(); mail.changed()
  return done
}

/** Once a day, for an account whose first clean-up the user has seen and run. */
async function daily(mail, acc, now = Date.now()) {
  if (!acc.cleanConfirmed || now - (acc.cleanedAt ?? 0) < DAY) return null
  return run(mail, acc, plan(mail, acc, now))
}

// ── The garbage scan

/**
 * What in the folder is not what the index says: { orphans (.eml no line knows), missing (lines whose file is not
 * there), lonely (.files folders without their .eml), partial (.part downloads), empty (folders), leftovers (requests
 * and outbox files older than a day, failed ones older than a month), duplicates (a second file of one mail) }.
 */
function garbage(mail, now = Date.now()) {
  const known = new Set(), out = { orphans: [], missing: [], lonely: [], partial: [], empty: [], leftovers: [], duplicates: [], bytes: 0 }
  const size = rel => { try { return fs.statSync(path.join(mail.root, rel)).size } catch { return 0 } }
  for (const e of mail.index.all()) if (e.file) {
    known.add(e.file)
    if (!fs.existsSync(path.join(mail.root, e.file))) out.missing.push(e.id)
  }
  const walk = rel => {
    let entries = []
    try { entries = fs.readdirSync(path.join(mail.root, rel), { withFileTypes: true }) } catch { return 0 }
    let count = 0
    for (const d of entries) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink()) { count++; continue }
      if (d.isDirectory()) {
        if (!rel && ['requests', 'outbox'].includes(d.name)) { count++; continue }
        if (d.name.endsWith('.files') && !fs.existsSync(path.join(mail.root, r.slice(0, -6) + '.eml'))) { out.lonely.push(r); count++; continue }
        if (d.name.endsWith('.files')) { count++; continue }
        if (walk(r) === 0) out.empty.push(r); else count++
        continue
      }
      count++
      if (d.name.startsWith('.') && d.name.endsWith('.part')) { out.partial.push(r); out.bytes += size(r) }
      else if (rel && d.name.endsWith('.eml') && !known.has(r)) out.orphans.push(r)
    }
    return count
  }
  walk('')
  for (const [dir, days] of [['requests', 1], ['outbox', 1]]) {
    let names = []
    try { names = fs.readdirSync(path.join(mail.root, dir)) } catch {}
    for (const n of names) {
      const r = `${dir}/${n}`, age = now - (fs.statSync(path.join(mail.root, r)).mtimeMs || now)
      if (age > (n.endsWith('.failed.json') ? 30 : days) * DAY) { out.leftovers.push(r); out.bytes += size(r) }
    }
  }
  // one mail, two files: the line still on the server keeps its file, the others' copies of the same size go
  const groups = new Map()
  for (const e of mail.index.all()) if (e.file && e.messageId) {
    const k = `${e.account}\n${e.folder}\n${e.messageId}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  for (const list of groups.values()) if (list.length > 1) {
    const keep = list.find(e => !e.gone && e.uidValidity !== 'local') ?? list.find(e => !e.gone) ?? list[0]
    for (const e of list) if (e !== keep && e.file !== keep.file && size(e.file) === size(keep.file)) { out.duplicates.push({ keep: keep.id, drop: e.id }); out.bytes += size(e.file) }
  }
  for (const r of out.lonely) out.bytes += dirSize(path.join(mail.root, r))
  return out
}
function dirSize(dir) { let n = 0; try { for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size } catch {} return n }

/**
 * Tidies what garbage() found. Nothing that is someone's mail is lost: an .eml no line knows is taken into the index
 * (as not on the server), a missing file's line is cleared so the sync can fetch it again; only copies, half-downloads,
 * empty folders, attachments without their mail and old leftovers are deleted.
 */
async function sweep(mail, g = garbage(mail)) {
  const { simpleParser } = require('mailparser')
  const done = { adopted: 0, cleared: 0, deleted: 0 }
  for (const rel of g.orphans) {
    const [account, folder] = rel.split('/')
    try {
      const raw = fs.readFileSync(path.join(mail.root, rel)), p = await simpleParser(raw)
      const from = p.from?.value?.[0] ?? {}
      mail.index.put({ id: `${account}/${folder}/orphan/${rel}`, account, folder, uidValidity: 'orphan', uid: 0, date: +(p.date ?? 0),
        from: from.name || from.address || '', fromAddress: from.address || '', to: (p.to?.value ?? []).map(a => a.address), subject: p.subject ?? '',
        messageId: p.messageId ?? '', seen: true, flagged: false, size: raw.length, attachments: p.attachments.filter(a => !a.related).length,
        snippet: (p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), saved: true, file: rel, gone: true })
      done.adopted++
    } catch (e) { console.warn('[mail] orphan not read', rel, e.message) }
  }
  for (const id of g.missing) { const e = mail.index.get(id); if (e) { mail.index.put({ ...e, file: null, saved: false }); done.cleared++ } }
  for (const { drop } of g.duplicates) { const e = mail.index.get(drop); if (e?.file) { mail.unlink(e.file); mail.index.put({ ...e, file: null, gone: true }); done.deleted++ } }
  for (const rel of [...g.lonely, ...g.partial, ...g.leftovers]) { fs.rmSync(path.join(mail.root, rel), { recursive: true, force: true }); done.deleted++ }
  for (const rel of [...g.empty].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(mail.root, rel)); done.deleted++ } catch {} }
  mail.index.flush(); mail.changed()
  return done
}

// ── Filters (MAIL_PLAN §6)

const FIELDS = ['from', 'to', 'subject', 'body', 'account', 'hasAttachment', 'size', 'age']
const ACTIONS = ['move', 'archive', 'delete', 'spam', 'read', 'favorite', 'saveAttachments']
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const part = path.join(path.dirname(file), `.${path.basename(file)}.part`)
  fs.writeFileSync(part, JSON.stringify(value, null, 2)); fs.renameSync(part, file)
}

/** filters.json: [{ id, name, on, match: 'all' | 'any', conditions: [{ field, op, value }], actions: [{ type, to?, folder? }] }]. */
function filters(mail) { return readJson(path.join(mail.root, 'filters.json'), []) }
function setFilters(mail, list) {
  const clean = (Array.isArray(list) ? list : []).slice(0, 200).map((r, i) => ({
    id: String(r.id || `f${Date.now()}${i}`), name: String(r.name ?? '').slice(0, 100), on: r.on !== false, match: r.match === 'any' ? 'any' : 'all',
    conditions: (r.conditions ?? []).filter(c => FIELDS.includes(c.field)).map(c => ({ field: c.field, op: String(c.op ?? 'contains'), value: c.value })),
    actions: (r.actions ?? []).filter(a => ACTIONS.includes(a.type)).map(a => ({ type: a.type, ...(a.to ? { to: String(a.to) } : {}), ...(a.folder ? { folder: String(a.folder) } : {}) })),
  }))
  writeJson(path.join(mail.root, 'filters.json'), clean)
  return clean
}

/** Whether a mail meets a filter's conditions; the text of the mail is read only when a condition asks about it. */
async function matches(mail, rule, e) {
  let text = null
  const body = async () => {
    if (text != null) return text
    text = e.snippet ?? ''
    if (e.file) try { text = (await require('mailparser').simpleParser(fs.readFileSync(path.join(mail.root, e.file)))).text ?? text } catch {}
    return text
  }
  const test = async c => {
    const v = String(c.value ?? '').toLowerCase()
    if (c.field === 'hasAttachment') return (e.attachments > 0) === !(c.value === false || c.value === 'false')
    if (c.field === 'size') return c.op === 'lt' ? e.size < Number(c.value) * 1000 : e.size > Number(c.value) * 1000
    if (c.field === 'age') return c.op === 'lt' ? Date.now() - e.date < Number(c.value) * DAY : Date.now() - e.date > Number(c.value) * DAY
    const f = String({ from: `${e.from} ${e.fromAddress}`, to: (e.to ?? []).join(' '), subject: e.subject, account: e.account }[c.field] ?? (c.field === 'body' ? await body() : '')).toLowerCase()
    return c.op === 'is' ? f.trim() === v || f.split(/[\s<>,]+/).includes(v) : c.op === 'not' ? !f.includes(v) : c.op === 'starts' ? f.startsWith(v) : f.includes(v)
  }
  if (!rule.conditions.length) return false
  const results = []
  for (const c of rule.conditions) results.push(await test(c))
  return rule.match === 'any' ? results.some(Boolean) : results.every(Boolean)
}

/** A Files folder by its name ("Τιμολόγια", "Σχολείο/2026"): always inside [filesRoot]. */
function filesFolder(filesRoot, folder) {
  const parts = String(folder ?? '').split('/').map(p => p.replace(/[\\\0:*?"<>|]/g, ' ').trim()).filter(p => p && p !== '.' && p !== '..')
  return parts.length ? path.join(filesRoot, ...parts) : null
}

/** Runs the filters that are on over [entries]; { matched, actions } as counts. */
async function applyFilters(mail, entries, { filesRoot = null, list = filters(mail) } = {}) {
  const out = { matched: 0, actions: 0 }, ops = new Map()
  for (const e of entries) {
    for (const rule of list.filter(r => r.on)) {
      if (!(await matches(mail, rule, e))) continue
      out.matched++
      for (const a of rule.actions) {
        if (a.type === 'saveAttachments') {
          const to = filesRoot && filesFolder(filesRoot, a.folder), dir = e.file && path.join(mail.root, e.file.slice(0, -4) + '.files')
          if (!to || !dir || !fs.existsSync(dir)) continue
          fs.mkdirSync(to, { recursive: true })
          for (const n of fs.readdirSync(dir)) {
            const dot = n.lastIndexOf('.')
            let name = n
            for (let i = 2; fs.existsSync(path.join(to, name)); i++) name = dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`
            fs.copyFileSync(path.join(dir, n), path.join(to, name))
          }
          out.actions++
          continue
        }
        const key = a.type === 'move' ? `move:${a.to}` : a.type
        ops.set(key, [...(ops.get(key) ?? []), e.id]); out.actions++
      }
    }
  }
  // flags first, moves last, so a mail is marked before it leaves its folder
  for (const [key, ids] of [...ops].sort(([a], [b]) => Number(/^(move|archive|delete|spam)/.test(a)) - Number(/^(move|archive|delete|spam)/.test(b)))) {
    const [op, to] = key.split(':')
    await mail.act({ op, ids, to }).catch(e => console.warn('[mail] filter', key, e.message))
  }
  return out
}

// ── The local spam filter (MAIL_PLAN §5): naive Bayes, trained by Spam and Not spam

class Junk {
  constructor(file) { this.file = file; Object.assign(this, { on: true, spam: {}, ham: {}, nSpam: 0, nHam: 0 }, readJson(file, {})) }
  static words(text) { return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]{2,30}/gu) ?? []).slice(0, 1500))] }
  train(text, spam) {
    const table = spam ? this.spam : this.ham
    for (const w of Junk.words(text)) table[w] = (table[w] ?? 0) + 1
    if (spam) this.nSpam++; else this.nHam++
  }
  /** Enough examples of both to judge: ten of each. */
  ready() { return this.on && this.nSpam >= 10 && this.nHam >= 10 }
  /** The chance a text is spam, from the words seen in each (Laplace-smoothed, in logs). */
  score(text) {
    let log = Math.log((this.nSpam + 1) / (this.nHam + 1))
    for (const w of Junk.words(text)) {
      const s = this.spam[w] ?? 0, h = this.ham[w] ?? 0
      if (!s && !h) continue
      log += Math.log((s + 1) / (this.nSpam + 2)) - Math.log((h + 1) / (this.nHam + 2))
    }
    return 1 / (1 + Math.exp(-log))
  }
  save() { writeJson(this.file, { on: this.on, spam: this.spam, ham: this.ham, nSpam: this.nSpam, nHam: this.nHam }) }
}

/** The text a mail is judged by: who sent it, its subject and its words. */
async function mailText(mail, e) {
  let text = e.snippet ?? ''
  if (e.file) try { text = (await require('mailparser').simpleParser(fs.readFileSync(path.join(mail.root, e.file)))).text ?? text } catch {}
  return `${e.fromAddress} ${String(e.fromAddress).split('@')[1] ?? ''} ${e.subject} ${text}`
}

/** Everyone the user has written to: never spam (§5). */
function writtenTo(mail) {
  const out = new Set()
  for (const e of mail.index.all()) if (e.folder === 'Sent') for (const a of e.to ?? []) out.add(String(a).toLowerCase())
  return out
}

/** New mail: the filters, then the spam filter on what is still in the Inbox. */
async function onNew(mail, entries, { filesRoot = null } = {}) {
  if (!entries.length) return
  await applyFilters(mail, entries, { filesRoot }).catch(e => console.warn('[mail] filters', e.message))
  const junk = mail.junk()
  if (!junk.ready()) return
  const friends = writtenTo(mail), spam = []
  for (const e of entries.map(x => mail.index.get(x.id)).filter(e => e && !e.gone && e.folder === 'Inbox')) {
    if (friends.has(String(e.fromAddress).toLowerCase())) continue
    if (junk.score(await mailText(mail, e)) > 0.97) spam.push(e.id)
  }
  if (spam.length) await mail.act({ op: 'spam', ids: spam, learn: false }).catch(e => console.warn('[mail] spam', e.message))
}

module.exports = { cleanOf, checked, plan, summary, run, daily, garbage, sweep, filters, setFilters, matches, applyFilters, filesFolder, Junk, mailText, writtenTo, onNew, FIELDS, ACTIONS }
