import test from 'node:test'
import assert from 'node:assert/strict'
import { international } from './phonecountry.ts'

test('a number without + or 00 is read in the phone\'s country', () => {
  assert.equal(international('6980012345', 'GR'), '+306980012345')
  assert.equal(international('0030 698 001 2345', 'GR'), '+306980012345')
  assert.equal(international('69800', 'GR'), '+3069800') // a range's start
  assert.equal(international('0171', 'DE'), '+49171') // Germany's trunk 0 comes off
  assert.equal(international('0171 1234567', 'DE'), '+491711234567')
  assert.equal(international('02 3123456', 'MK'), '+38923123456')
  assert.equal(international('06 1234 5678', 'IT'), '+390612345678') // Italy keeps its 0
  assert.equal(international('+44 20 7946 0000', 'GR'), '+442079460000') // abroad: its own code
  assert.equal(international('011 44 20', 'US'), '+4420') // the US's way out
  assert.equal(international('6980012345', ''), '6980012345') // no country known: the digits
})
