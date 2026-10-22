'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Maps, fold, latin, parsePoi, parsePlace, search } = require('../maps')

test('search folds accents and Greeklish as the phone does', () => {
  assert.equal(fold('Ξάνθη'), 'ξανθη')
  assert.equal(fold('Άγιος'), 'αγιοσ')
  assert.equal(latin(fold('Κρεώνας')), latin('krewnas'))
  assert.equal(latin(fold('Θήβα')), latin('thiva'))
})

test('a place file that is not one is left out, never an error', () => {
  assert.equal(parsePlace('{"name":"x"}'), null)
  assert.equal(parsePlace('{"lat":95,"lng":1,"id":"a"}'), null)
  assert.equal(parsePlace('not json'), null)
  const p = parsePlace('{"lat":38.2,"lng":23.5,"icon":"rocket","slot":40}', '/x/Places/ab12cd.json')
  assert.deepEqual([p.id, p.icon, p.slot, p.mode], ['ab12cd', 'pin', 0, 'car'])
})

test('towns before shops for words; a kind with a town\'s name is searched in that town', () => {
  const all = [
    'village\t38.27\t23.59\tΆγιος Λουκάς\tAgios Loukas',
    'supermarket\t38.271\t23.591\tΜασούτης\t',
    'supermarket\t37.97\t23.72\tΑγιος Λουκάς Market\t', // has the words, far away
    'cafe\t38.27\t23.59\tΆγιος Καφές\t',
  ].map(parsePoi)
  const words = search(all, { query: 'agios', lat: 38, lng: 23.6 })
  assert.equal(words[0].kind, 'village')
  const inTown = search(all, { query: 'αγιος λουκας', kind: 'supermarket', lat: 37.97, lng: 23.72 })
  assert.equal(inTown[0].name, 'Μασούτης')
})

test('places: a Home slot is one place\'s; deleting goes to the trash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-'))
  const trashed = []
  const m = new Maps(root, async rel => { trashed.push(rel); fs.rmSync(path.join(root, rel.replace(/^Maps\//, ''))) })
  const a = await m.savePlace({ name: 'Home', lat: 38, lng: 23, slot: 1 })
  const b = await m.savePlace({ name: 'Work', lat: 38.1, lng: 23.1, slot: 1 })
  const places = await m.places()
  assert.equal(places.find(p => p.id === a.id).slot, 0)
  assert.equal(places.find(p => p.id === b.id).slot, 1)
  await m.deletePlace(a.id)
  assert.deepEqual(trashed, [`Maps/Places/${a.id}.json`])
  assert.equal((await m.places()).length, 1)
  await assert.rejects(m.deletePlace('../x'))
})
