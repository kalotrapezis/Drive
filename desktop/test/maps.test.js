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

test("a sync's copies of the parked car leave one car, the newest; deleting a place takes its copies (23 Oct)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-car-'))
  fs.mkdirSync(path.join(root, 'Places'))
  const car = (f, lat, at) => {
    fs.writeFileSync(path.join(root, 'Places', f), JSON.stringify({ id: 'parking', name: 'My car', lat, lng: 23.5, icon: 'parking' }))
    fs.utimesSync(path.join(root, 'Places', f), at, at)
  }
  car('parking (2).json', 38.1, 1000); car('parking (3).json', 38.3, 3000); car('parking.json', 38.2, 2000)
  fs.writeFileSync(path.join(root, 'Places', 'home.json'), JSON.stringify({ id: 'home', name: 'Home', lat: 38, lng: 23 }))
  const trashed = []
  const m = new Maps(root, async rel => { trashed.push(rel); fs.unlinkSync(path.join(root, rel.replace(/^Maps\//, ''))) })
  const places = await m.places()
  assert.deepEqual(places.map(p => p.name), ['Home', 'My car'])
  assert.equal(places.find(p => p.id === 'parking').lat, 38.3)
  assert.deepEqual(trashed.sort(), ['Maps/Places/parking (2).json', 'Maps/Places/parking.json'])
  await m.deletePlace('parking')
  assert.deepEqual(fs.readdirSync(path.join(root, 'Places')), ['home.json'])
})

test('two devices put a place into one slot while apart: the newer keeps it, the other the first free slot (23 Oct)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-slots-'))
  fs.mkdirSync(path.join(root, 'Places'))
  const put = (f, id, slot, at) => {
    fs.writeFileSync(path.join(root, 'Places', f), JSON.stringify({ id, name: id, lat: 38, lng: 23.5, slot }))
    fs.utimesSync(path.join(root, 'Places', f), at, at)
  }
  for (let i = 1; i <= 5; i++) put(`s${i}.json`, `s${i}`, i, 1000)
  put('market.json', 'market', 7, 2000); put('home.json', 'home', 7, 3000); put('home (2).json', 'home', 6, 1000)
  const m = new Maps(root, async rel => fs.unlinkSync(path.join(root, rel.replace(/^Maps\//, ''))))
  const slot = id => m.places().then(ps => ps.find(p => p.id === id).slot)
  assert.equal(await slot('home'), 7)
  assert.equal(await slot('market'), 6)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'Places', 'market.json'), 'utf8')).slot, 7) // nothing written
  assert.ok(!fs.existsSync(path.join(root, 'Places', 'home (2).json'))) // the older copy to the Trash
  // a save is the place, whatever an older copy's date: its copies go
  put('market (2).json', 'market', 9, Date.now() / 1000 + 60)
  await m.savePlace({ id: 'market', name: 'market', lat: 38, lng: 23.5, slot: 8 })
  assert.equal(await slot('market'), 8)
  assert.deepEqual(fs.readdirSync(path.join(root, 'Places')).filter(n => n.startsWith('market')), ['market.json'])
})

test("an address where no house has a number: the street and the village's postcode (the user's house, 23 Oct)", async t => {
  const root = path.join(os.homedir(), 'Tetra-maps')
  if (!fs.existsSync(path.join(root, 'greece-streets.tsv'))) return t.skip('no map files on this computer')
  const m = new Maps(root, async () => {})
  assert.equal(await m.describe(37.27642, 22.58903), 'Οδός Παραδείγματος, 12345 Άγιος Λουκάς')
  assert.equal(await m.describe(37.27642, 22.58903, 'Πλατάνι'), 'Πλατάνι, 12345 Άγιος Λουκάς')
})
