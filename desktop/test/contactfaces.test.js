'use strict'
// Contacts ↔ Photos' people (contactfaces.js): one link, kept by this computer whichever device changed it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const { People } = require('../faces')
const { Contacts } = require('../contacts')
const { linkFaces, parseFace } = require('../contactfaces')

const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64)
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contactfaces-'))
  const db = library.open(tmp)
  const people = new People(db, tmp)
  const contacts = new Contacts(path.join(tmp, 'Contacts'), path.join(tmp, 'Trash'))
  const face = (id, sha, box, person = null) => db.prepare(`INSERT INTO faces(id, sha256, box_left, box_top, box_right, box_bottom, embedding, model, quality, person_id, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, sha, ...box, Buffer.alloc(8), 'm', 0.9, person, 1)
  const facePhoto = async id => ({ photo: 'PHOTO-OF-' + id, face: `${OTHER};0.1,0.1,0.5,0.5` })
  const run = () => linkFaces({ db, people, contacts, facePhoto })
  return { tmp, db, people, contacts, face, run }
}
const person = (db, id) => db.prepare('SELECT * FROM people WHERE id = ?').get(id)

test('contactfaces: a portrait picked on the phone from an ordinary photo joins Photos as that named person', async () => {
  const { tmp, db, contacts, face, run } = setup()
  try {
    face('f-mine', SHA, [0.3, 0.2, 0.5, 0.45]) // found by this computer's analysis, nobody yet
    face('f-else', SHA, [0.8, 0.8, 0.9, 0.9]) // someone in the background, outside the portrait's square
    const uid = contacts.save(null, { given: 'Νέα', family: 'Επαφή', person: 'p-new', face: `${SHA};0.2,0.1,0.6,0.6` })
    assert.ok(await run() > 0)
    const p = person(db, 'p-new')
    assert.equal(p.name, 'Νέα Επαφή')
    assert.equal(p.cover_face_id, 'f-mine')
    assert.equal(db.prepare('SELECT person_id FROM faces WHERE id = ?').get('f-mine').person_id, 'p-new')
    assert.equal(db.prepare('SELECT person_id FROM faces WHERE id = ?').get('f-else').person_id, null)
    assert.equal(contacts.byUid(uid).info.person, 'p-new')
    assert.equal(await run(), 0) // agreed: nothing more
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('contactfaces: a face Photos already grouped ("Person 7") — the contact links to them and they take its name', async () => {
  const { tmp, db, people, contacts, face, run } = setup()
  try {
    people.applyPerson('p7', 'Person 7', 1)
    face('f7', SHA, [0.3, 0.2, 0.5, 0.45], 'p7')
    const uid = contacts.save(null, { formatted: 'Μαρία Δοκιμή', person: 'p-made-on-phone', face: `${SHA};0.2,0.1,0.6,0.6` })
    await run()
    assert.equal(contacts.byUid(uid).info.person, 'p7')
    assert.equal(person(db, 'p7').name, 'Μαρία Δοκιμή')
    assert.equal(person(db, 'p-made-on-phone'), undefined)
    assert.equal(await run(), 0)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('contactfaces: a name or portrait changed in Photos afterwards reaches the contact', async () => {
  const { tmp, db, people, contacts, face, run } = setup()
  try {
    face('f1', SHA, [0.3, 0.2, 0.5, 0.45])
    face('f2', OTHER, [0.1, 0.1, 0.5, 0.5])
    const uid = contacts.save(null, { formatted: 'Νίκος', person: 'pn', face: `${SHA};0.2,0.1,0.6,0.6` }, Date.now() - 60_000)
    await run()
    db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run('pn', 'f2')
    people.rename('pn', 'Νίκος Παππάς') // renamed in Photos later
    await run()
    assert.equal(contacts.byUid(uid).info.name ?? contacts.byUid(uid).info.formatted, 'Νίκος Παππάς')
    people.setCover('pn', 'f2') // another portrait chosen in Photos
    await new Promise(r => setTimeout(r, 5))
    await run()
    const i = contacts.byUid(uid).info
    assert.equal(i.photo, 'PHOTO-OF-f2')
    assert.equal(parseFace(i.face).sha, OTHER)
    assert.equal(await run(), 0)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
