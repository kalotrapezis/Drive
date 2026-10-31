import type { MailEntry } from './drive'

// The Filter modal's choices (MAIL_PLAN §9): quick filters on top, sorting and grouping below; kept per folder.
export type MailSort = 'date' | 'from' | 'subject' | 'size' | 'account'
export type MailGroup = 'day' | 'from' | 'account' | 'none'
export interface MailView {
  unread: boolean; favorites: boolean; attachments: boolean; orange: boolean; accounts: string[]
  sort: MailSort; descending: boolean; group: MailGroup; unreadFirst: boolean; favoritesFirst: boolean; attachmentsFirst: boolean
}
export const DEFAULT_VIEW: MailView = {
  unread: false, favorites: false, attachments: false, orange: false, accounts: [],
  sort: 'date', descending: true, group: 'day', unreadFirst: false, favoritesFirst: false, attachmentsFirst: false,
}

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
/** "Re: Fwd: Θέμα" sorts as "Θέμα". */
const bare = (s: string) => s.replace(/^\s*((re|fwd?|aw|απ|σχετ|προωθ)\s*:\s*)+/i, '').toLowerCase()

/** The mails the view keeps, sorted, in groups (in the order their first mail comes). */
export function arrange(mails: MailEntry[], v: MailView, query = ''): { key: string; mails: MailEntry[] }[] {
  const q = query.trim().toLowerCase()
  const kept = mails.filter(m => (!v.unread || !m.seen) && (!v.favorites || m.flagged) && (!v.attachments || m.attachments > 0) && (!v.orange || !m.saved)
    && (!v.accounts.length || v.accounts.includes(m.account)) && (!q || `${m.from} ${m.fromAddress} ${m.subject} ${m.snippet}`.toLowerCase().includes(q)))
  const key: (m: MailEntry) => string | number = { date: (m: MailEntry) => m.date, from: (m: MailEntry) => (m.from || m.fromAddress).toLowerCase(),
    subject: (m: MailEntry) => bare(m.subject), size: (m: MailEntry) => m.size, account: (m: MailEntry) => m.account }[v.sort]
  const order = (a: string | number, b: string | number) => typeof a === 'number' ? a - (b as number) : a.localeCompare(b as string)
  kept.sort((a, b) => (v.unreadFirst ? +a.seen - +b.seen : 0) || (v.favoritesFirst ? +b.flagged - +a.flagged : 0)
    || (v.attachmentsFirst ? +(b.attachments > 0) - +(a.attachments > 0) : 0) || order(key(a), key(b)) * (v.descending ? -1 : 1) || b.date - a.date)
  const group = { day: (m: MailEntry) => dayKey(m.date), from: (m: MailEntry) => m.from || m.fromAddress, account: (m: MailEntry) => m.account, none: () => '' }[v.group]
  const groups = new Map<string, MailEntry[]>()
  for (const m of kept) { const k = group(m); groups.set(k, [...(groups.get(k) ?? []), m]) }
  return [...groups].map(([key, mails]) => ({ key, mails }))
}
