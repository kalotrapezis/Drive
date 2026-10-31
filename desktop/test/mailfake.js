'use strict'
// Stand-ins for the mail tests: a raw mail, a small IMAP server in memory as imapflow sees it, an SMTP that keeps what it is given.
const raw = (subject, { attach = false } = {}) => Buffer.from([
  'From: =?UTF-8?B?zpPPgc6xzrzOvM6xz4TOtc6vzrEgzpzOoM6j?= <secretariat@nup.ac.cy>',
  'To: t@nup.ac.cy',
  `Subject: ${subject}`,
  'Date: Fri, 31 Oct 2026 09:12:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Dear students,   the deadline is 15 November.',
  ...(attach ? ['--b', 'Content-Type: application/pdf; name="Guide.pdf"', 'Content-Disposition: attachment; filename="Guide.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 x').toString('base64')] : []),
  '--b--', '',
].join('\r\n'))

/** A small IMAP server in memory, as imapflow sees it: folders of uid → { source, flags, messageId }. */
function memoryServer(folders) {
  let open = null
  const box = () => folders[open]
  const pick = range => String(range).split(',').map(Number)
  const env = m => ({ date: m.date ?? new Date('2026-10-31T07:12:00Z'), subject: m.subject, messageId: m.messageId, from: [m.from ?? { name: 'Γραμματεία', address: 's@x.gr' }], to: m.to ?? [] })
  const c = {
    calls: [],
    async connect() {}, async logout() {}, close() {}, usable: true,
    async list() { return Object.keys(folders).map(p => ({ path: p, delimiter: '/', specialUse: folders[p].use })) },
    get mailbox() { return { uidValidity: BigInt(box().validity), exists: Object.keys(box().msgs).length } },
    async mailboxOpen(p) { open = p },
    async getMailboxLock(p) { open = p; return { release() {} } },
    async search(q) { return Object.keys(box().msgs).map(Number).filter(u => !q?.header || box().msgs[u].messageId === q.header['message-id']) },
    async append(p, raw, flags) {
      c.calls.push(['append', p])
      const text = raw.toString(), head = n => new RegExp(`^${n}: (.*)$`, 'mi').exec(text)?.[1]?.trim()
      folders[p].msgs[folders[p].next++] = { subject: head('Subject'), messageId: head('Message-ID'), flags: new Set(flags), source: Buffer.from(raw) }
    },
    async *fetch(range, query) {
      for (const uid of range === '1:*' ? Object.keys(box().msgs).map(Number) : pick(range)) {
        const m = box().msgs[uid]
        yield { uid, flags: m.flags, size: m.source.length, envelope: env(m), bodyStructure: {}, internalDate: new Date('2026-10-31T07:12:00Z') }
      }
    },
    async fetchOne(uid) { c.calls.push(['fetchOne', open, uid]); return { source: box().msgs[uid].source } },
    async messageFlagsAdd(range, flags) { for (const u of pick(range)) for (const f of flags) box().msgs[u].flags.add(f) },
    async messageFlagsRemove(range, flags) { for (const u of pick(range)) for (const f of flags) box().msgs[u].flags.delete(f) },
    async mailboxCreate(p) { c.calls.push(['create', p]); folders[p] = { validity: 9, next: 1, msgs: {} } },
    async messageMove(range, dest) {
      c.calls.push(['move', open, range, dest])
      for (const u of pick(range)) { const to = folders[dest]; to.msgs[to.next++] = box().msgs[u]; delete box().msgs[u] }
    },
    async messageDelete(range) { for (const u of pick(range)) delete box().msgs[u] },
  }
  return c
}

const message = (subject, id, more = {}) => ({ subject, messageId: `<${id}@x>`, flags: new Set(), source: raw(subject, more), ...more })

const smtpSpy = () => { const sent = []; return { sent, make: o => ({ async sendMail(m) { sent.push({ ...m, auth: o.auth.user }) }, close() {} }) } }

module.exports = { raw, memoryServer, message, smtpSpy }
