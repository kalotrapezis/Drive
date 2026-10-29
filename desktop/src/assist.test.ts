import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vad, FRAME, yesNo, accelerator, clock } from './assist.ts'

const frame = (amp: number) => Int16Array.from({ length: FRAME }, (_, i) => Math.round(amp * Math.sin(i / 3)))

test('the VAD hears a phrase between silences and ends it at the pause', () => {
  const vad = new Vad(10)
  let done = false, frames = 0
  for (let i = 0; i < 20; i++) assert.equal(vad.push(frame(30)), false) // calibrating, then quiet
  for (let i = 0; i < 30; i++) vad.push(frame(4000))
  assert.ok(vad.speaking)
  while (!done && frames < 50) { done = vad.push(frame(30)); frames++ }
  assert.ok(done)
  assert.equal(frames, 10)
  assert.ok(vad.phrase().length >= 30 * FRAME)
})

test('a cough is not a phrase', () => {
  const vad = new Vad(10)
  for (let i = 0; i < 20; i++) vad.push(frame(30))
  for (let i = 0; i < 3; i++) vad.push(frame(4000))
  for (let i = 0; i < 40; i++) assert.equal(vad.push(frame(30)), false)
  assert.equal(vad.phrase().length, 0)
})

test('a spoken yes or no to a waiting call; anything else is not an answer', () => {
  assert.equal(yesNo('Ναι, πάρε την'), true)
  assert.equal(yesNo('οχι'), false)
  assert.equal(yesNo('ποια Μαρία;'), null)
  assert.equal(yesNo(''), null)
})

test('a shortcut by the keys\' places, whatever the keyboard\'s language', () => {
  const k = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    accelerator({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  assert.equal(k('α', 'KeyA', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+A')
  assert.equal(k(' ', 'Space', { metaKey: true }), 'Super+Space')
  assert.equal(k('Control', 'ControlLeft', { ctrlKey: true }), null)
  assert.equal(clock(65_000), '0:01:05')
})
