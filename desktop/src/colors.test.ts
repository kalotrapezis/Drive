import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copiesColor } from './colors.ts'

const hue = (n: number) => Number(/hsl\((\d+)/.exec(copiesColor(n))![1])

test('every number of places has its own colour, found by halving', () => {
  assert.deepEqual([3, 4, 5, 6, 7].map(hue), [125, 220, 173, 268, 149])
  const hues = Array.from({ length: 30 }, (_, i) => hue(i + 3))
  assert.equal(new Set(hues).size, hues.length, 'no two counts share a colour')
  assert.ok(hues.every(h => h >= 125 && h <= 315), 'never red or yellow, which mean risk')
})
