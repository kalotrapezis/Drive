'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Notes } = require('../notes')

test('notes: save keeps unknown fields, history is numbered, a version comes back as an edit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'))
  try {
    const notes = new Notes(path.join(tmp, '.notes'))
    const n = notes.create()
    notes.write({ ...notes.get(n.id), future: 'kept' })
    notes.save(n.id, { title: 'Shopping', content: 'milk' })
    assert.match(notes.snapshot(n.id), /^Shopping-\d{4}-\d\d-\d\d-\d\d-\d\d-1\.json$/)
    assert.equal(notes.snapshot(n.id), null, 'the same text is not kept twice')
    notes.save(n.id, { content: 'milk, eggs' })
    assert.match(notes.snapshot(n.id), /-2\.json$/)
    const first = notes.history(n.id).find(v => v.content === 'milk')
    notes.restoreVersion(n.id, first.name)
    assert.equal(notes.get(n.id).content, 'milk')
    assert.equal(notes.get(n.id).future, 'kept')
    notes.snapshot(n.id)
    notes.save(n.id, { content: 'bread' }); notes.snapshot(n.id)
    assert.deepEqual(notes.history(n.id).map(v => v.content), ['bread', 'milk', 'milk, eggs'], 'the newest three')
    assert.throws(() => notes.restoreVersion(n.id, '../x.json'))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('notes: merge keeps the newer of each, a deletion beats an edit, and says what the device lacks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'))
  try {
    const notes = new Notes(path.join(tmp, '.notes'))
    const a = notes.write({ id: 'a', title: 'mine newer', updatedAt: 20 })
    notes.write({ id: 'b', title: 'mine older', updatedAt: 10 })
    notes.write({ id: 'c', title: 'only here', updatedAt: 5 })
    notes.write({ id: 'd', title: 'deleted there', updatedAt: 99 })
    const r = notes.merge({
      notes: [{ id: 'a', title: 'theirs older', updatedAt: 15 }, { id: 'b', title: 'theirs newer', updatedAt: 30 }, { id: 'e', title: 'only there', updatedAt: 1 }],
      deletions: [{ id: 'd', deletedAt: 50 }],
    })
    assert.equal(notes.get('a').title, a.title)
    assert.equal(notes.get('b').title, 'theirs newer')
    assert.equal(notes.get('e').title, 'only there')
    assert.equal(notes.get('d'), null)
    assert.deepEqual(r.notes.map(n => n.id).sort(), ['a', 'c'])
    assert.deepEqual(r.deletions.map(d => d.id), ['d'])
    assert.equal(r.changed, 3, 'b newer, e new, d deleted: what an open Notes page must show')
    notes.remove('c')
    assert.ok(!notes.merge({ notes: [{ id: 'c', updatedAt: 1e15 }] }).notes.some(n => n.id === 'c'), 'a deleted note never comes back')
    assert.equal(notes.get('c'), null)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('notes: the old vault moves in once, each folder a label; trash goes after 30 days', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'))
  try {
    const vault = path.join(tmp, 'vault'); fs.mkdirSync(path.join(vault, 'Συνταγές 🍴'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'x.json'), JSON.stringify({ id: 'x', title: 'loose', labels: ['keep'] }))
    fs.writeFileSync(path.join(vault, 'Συνταγές 🍴', 'y.json'), JSON.stringify({ id: 'y', title: 'pie', folderName: 'Συνταγές 🍴' }))
    fs.writeFileSync(path.join(vault, 'deletions.json'), '[]')
    const notes = new Notes(path.join(tmp, '.notes'))
    assert.equal(notes.importVault(vault), 2)
    assert.equal(notes.importVault(vault), 0)
    assert.deepEqual(notes.get('y').labels, ['Συνταγές 🍴'])
    assert.equal(notes.get('y').folderName, undefined)
    assert.deepEqual(notes.get('x').labels, ['keep'])
    fs.writeFileSync(path.join(vault, 'z.json'), JSON.stringify({ id: 'z', title: 'trashed long ago', trashedAt: 1 }))
    assert.equal(notes.importVault(vault), 1)
    assert.equal(notes.sweep(), 0, 'a trashed note that moved in gets its 30 days from now')
    notes.write({ ...notes.get('x'), trashedAt: 1 })
    assert.equal(notes.sweep(), 1)
    assert.equal(notes.get('x'), null)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('notes: a new note is not saved or sent until something is written, and leaves no trace when left empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'))
  try {
    const notes = new Notes(path.join(tmp, '.notes'))
    const n = notes.create()
    assert.equal(notes.list().length, 0)
    notes.remove(n.id)
    assert.deepEqual(notes.deletions(), [])
    const m = notes.create()
    assert.equal(notes.snapshot(m.id), null, 'an empty note has no version worth keeping')
    notes.save(m.id, { title: 'Hi' })
    assert.equal(notes.list().length, 1)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
