import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampRect, coverScale, turnPoint, turnRect } from './edit.ts'

test('turning keeps crop and markup on the same part of the photo', () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
  const near = (a: typeof r, b: typeof r) => { for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(a[k] - b[k]) < 1e-12, k) }
  near(turnRect(turnRect(r, 'right'), 'left'), r)
  near([0, 1, 2, 3].reduce(x => turnRect(x, 'right'), r), r)
  assert.deepEqual(turnPoint([0.1, 0.2], 'right'), [0.8, 0.1]) // top-left area moves to top-right
  const back = turnPoint(turnPoint([0.1, 0.2], 'right'), 'left')
  assert.ok(Math.abs(back[0] - 0.1) < 1e-12 && Math.abs(back[1] - 0.2) < 1e-12)
})

test('straighten zooms just enough to hide empty corners', () => {
  assert.equal(coverScale(400, 300, 0), 1)
  const s = coverScale(400, 300, 10)
  assert.ok(s > 1.2 && s < 1.25)
  assert.equal(coverScale(400, 300, -10), s)
})

test('crop stays inside the frame', () => {
  assert.deepEqual(clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 2 }), { x: 0.7, y: 0, w: 0.3, h: 1 })
  assert.deepEqual(clampRect({ x: 0.5, y: 0.5, w: 0, h: 0.01 }), { x: 0.5, y: 0.5, w: 0.05, h: 0.05 })
})
