import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrange, DEFAULT_VIEW } from './mailView.ts'
import type { MailEntry } from './drive'

const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime()
const m = (id: string, x: Partial<MailEntry>): MailEntry => ({ id, account: 'g', folder: 'Inbox', uid: 1, date: 0, from: '', fromAddress: '', to: [], subject: '',
  seen: true, flagged: false, size: 1, attachments: 0, snippet: '', saved: true, ...x })
const mails = [
  m('a', { date: at(31, 9), from: 'Γραμματεία', subject: 'Re: Προθεσμία', seen: false, attachments: 2, saved: false }),
  m('b', { date: at(31, 8), from: 'Διεύθυνση', subject: 'Σύλλογος', account: 's', flagged: true }),
  m('c', { date: at(30, 20), from: 'GitHub', subject: 'Release', size: 900 }),
]
const ids = (g: ReturnType<typeof arrange>) => g.map(x => `${x.key}:${x.mails.map(m => m.id).join('')}`)

test('mail list: newest first by day, the quick filters, search', () => {
  assert.deepEqual(ids(arrange(mails, DEFAULT_VIEW)), ['2026-10-31:ab', '2026-10-30:c'])
  assert.deepEqual(ids(arrange(mails, { ...DEFAULT_VIEW, unread: true })), ['2026-10-31:a'])
  assert.deepEqual(ids(arrange(mails, { ...DEFAULT_VIEW, orange: true, attachments: true })), ['2026-10-31:a'])
  assert.deepEqual(ids(arrange(mails, { ...DEFAULT_VIEW, accounts: ['s'] })), ['2026-10-31:b'])
  assert.deepEqual(ids(arrange(mails, DEFAULT_VIEW, 'release')), ['2026-10-30:c'])
})

test('mail list: sorting ignores "Re:", favourites first, groups by sender or none', () => {
  const flat = { ...DEFAULT_VIEW, group: 'none' as const }
  const two = [m('x', { subject: 'Re: Alpha' }), m('y', { subject: 'Beta' })]
  assert.deepEqual(ids(arrange(two, { ...flat, sort: 'subject', descending: false })), [':xy'])
  assert.deepEqual(ids(arrange(mails, { ...flat, favoritesFirst: true })), [':bac'])
  assert.deepEqual(ids(arrange(mails, { ...flat, sort: 'size' })), [':cab'])
  assert.deepEqual(ids(arrange(mails, { ...DEFAULT_VIEW, group: 'account' })), ['g:ac', 's:b'])
})
