import test from 'node:test'
import assert from 'node:assert/strict'
import { Undo, blocks, prefix, preview, toggleLine, wrap } from './notesEdit.ts'

test('wrap puts marks around a selection and takes them off again', () => {
  const on = wrap({ text: 'a word here', start: 2, end: 6 }, '**')
  assert.deepEqual(on, { text: 'a **word** here', start: 4, end: 8 })
  assert.deepEqual(wrap(on, '**'), { text: 'a word here', start: 2, end: 6 })
})

test('prefix marks every selected line, replaces another mark, and numbers a list', () => {
  const text = 'one\n- two\nthree'
  assert.equal(prefix({ text, start: 0, end: text.length }, '- [ ] ').text, '- [ ] one\n- [ ] two\n- [ ] three')
  assert.equal(prefix({ text: 'a\nb', start: 0, end: 3 }, '1. ').text, '1. a\n2. b')
  assert.equal(prefix({ text: '# a', start: 1, end: 1 }, '# ').text, 'a')
})

test('undo groups a burst of typing, a toolbar step stands alone, redo comes back', () => {
  const u = new Undo('')
  u.push('h', 1000); u.push('he', 1100); u.push('hel', 1200)
  u.step('**hel**')
  assert.equal(u.undo(), 'hel')
  assert.equal(u.undo(), '')
  assert.equal(u.canUndo, false)
  assert.equal(u.redo(), 'hel')
})

test('blocks read what the Notes apps write; a tick is written back to its line', () => {
  const md = '# Title\n- [ ] milk\n  - [x] eggs\n1. first\n> said\n---\n```\ncode\n```\nplain **b** and [a](https://x.y)'
  const b = blocks(md)
  assert.deepEqual(b.map(x => x.t), ['h', 'li', 'li', 'li', 'quote', 'hr', 'code', 'p'])
  assert.deepEqual(b[2], { t: 'li', depth: 1, ordered: null, check: true, line: 2, v: [{ t: 'text', v: 'eggs' }] })
  assert.equal(toggleLine(md, 1).split('\n')[1], '- [x] milk')
  assert.deepEqual(preview({ content: md }, 2), ['Title', '☐ milk'])
})
