import { test } from 'node:test'
import assert from 'node:assert/strict'
import { group, periodKey, weekStart } from './timeline.ts'

const at = (s: string) => new Date(s).getTime()

test('weeks start on Monday', () => {
  assert.equal(weekStart(at('2026-09-20T23:00')).getDay(), 1) // Sunday belongs to the week before
  assert.equal(periodKey(at('2026-09-20T23:00'), 'week'), '2026-09-14')
  assert.equal(periodKey(at('2026-09-21T00:30'), 'week'), '2026-09-21')
})

test('groups keep order and split by period', () => {
  const items = ['2026-09-22', '2026-09-21', '2026-09-20', '2026-08-31', '2025-12-31'].map(d => ({ taken_at: at(d + 'T12:00') }))
  assert.deepEqual(group(items, 'week').map(g => g.items.length), [2, 1, 1, 1])
  assert.deepEqual(group(items, 'month').map(g => g.key), ['2026-09', '2026-08', '2025-12'])
  assert.deepEqual(group(items, 'year').map(g => g.items.length), [4, 1])
})
