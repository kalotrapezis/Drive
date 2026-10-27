'use strict'
// The map builder (mapbuild.js) and Maps with several countries' maps (maps.js), on made-up files.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MapBuilder, STEPS, pairDir, meet, minutes, polyToGeoJson, pmtilesBounds, isOld } = require('../mapbuild')
const { Maps, labelsIn } = require('../maps')

/** A .pmtiles file holding only its header, with bounds west, south, east, north. */
function pmtiles(file, ...b) {
  const h = Buffer.alloc(127)
  h.write('PMTiles', 0, 'latin1'); h[7] = 3
  b.forEach((v, i) => h.writeInt32LE(Math.round(v * 1e7), 102 + 4 * i))
  fs.writeFileSync(file, h)
}

test('a Geofabrik .poly becomes the region pmtiles cuts by, each ring closed', () => {
  const g = polyToGeoJson('cyprus\n1\n   3.2E+01   3.4E+01\n   3.5E+01   3.4E+01\n   3.5E+01   3.6E+01\nEND\n!2\n 33 35\n 33.1 35\n 33.1 35.1\nEND\nEND\n')
  assert.strictEqual(g.type, 'MultiPolygon')
  assert.deepStrictEqual(g.coordinates[0][0], [[32, 34], [35, 34], [35, 36], [32, 34]])
  assert.strictEqual(g.coordinates.length, 2)
  assert.throws(() => polyToGeoJson('empty\nEND\n'))
})

test('two countries: each map read, routed and searched by where it is; a removed map goes to the Trash whole', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-')), 'Maps')
  fs.mkdirSync(path.join(root, 'cyprus-gh'), { recursive: true })
  pmtiles(path.join(root, 'greece.pmtiles'), 18.97, 34.59, 29.66, 41.75)
  pmtiles(path.join(root, 'cyprus.pmtiles'), 31, 34, 35, 36)
  fs.writeFileSync(path.join(root, 'cyprus.json'), JSON.stringify({ name: 'Cyprus', region: 'cyprus', built: '2026-10-27', bounds: [32.2, 34.5, 34.7, 35.8], drive: 'left' }))
  fs.writeFileSync(path.join(root, 'cyprus-gh', 'properties'), 'x')
  fs.writeFileSync(path.join(root, 'greece-places.tsv'), 'city\t37.98\t23.73\tΑθήνα\tAthens\n')
  fs.writeFileSync(path.join(root, 'cyprus-places.tsv'), 'city\t35.17\t33.36\tΛευκωσία\tNicosia\n')
  fs.writeFileSync(path.join(root, 'greece-eopyy.tsv'), 'eopyy\t40.64\t22.94\tΕΟΠΥΥ\t\n')
  assert.deepStrictEqual(pmtilesBounds(path.join(root, 'greece.pmtiles')), [18.97, 34.59, 29.66, 41.75])

  const trashed = []
  const maps = new Maps(root, async rel => { trashed.push(rel); fs.renameSync(path.join(root, '..', rel), path.join(root, '..', path.basename(rel) + '.trashed')) })
  const info = await maps.info()
  assert.deepStrictEqual(info.maps.map(m => [m.id, m.name, m.drive]), [['cyprus', 'Cyprus', 'left'], ['greece', 'greece', 'right']])
  assert.strictEqual((await maps.mapAt(35.17, 33.36)).id, 'cyprus')
  assert.strictEqual((await maps.mapAt(37.98, 23.73)).id, 'greece')
  assert.deepStrictEqual((await maps.pois()).map(p => p.name).sort(), ['Αθήνα', 'ΕΟΠΥΥ', 'Λευκωσία'])

  const b = new MapBuilder(root)
  const packs = await b.packs()
  assert.deepStrictEqual(packs.map(p => [p.id, p.name, p.region, p.built, p.roads]), [['cyprus', 'Cyprus', 'cyprus', '2026-10-27', true], ['greece', 'Greece', 'greece', packs[1].built, false]])
  await b.remove('cyprus', rel => maps.trash(rel))
  assert.deepStrictEqual(trashed.sort(), ['Maps/cyprus-gh', 'Maps/cyprus-places.tsv', 'Maps/cyprus.json', 'Maps/cyprus.pmtiles'])
  assert.deepStrictEqual((await maps.info()).maps.map(m => m.id), ['greece'])
  await assert.rejects(b.remove('../x', () => {}))
})

test('two neighbours joined: their pair graph for a route from one into the other, their own within one; Remove takes the pair', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-')), 'Maps')
  fs.mkdirSync(root, { recursive: true })
  pmtiles(path.join(root, 'greece.pmtiles'), 18.97, 34.59, 29.66, 41.75)
  pmtiles(path.join(root, 'macedonia.pmtiles'), 20.45, 40.85, 23.04, 42.37)
  pmtiles(path.join(root, 'cyprus.pmtiles'), 31, 34, 35, 36)
  fs.writeFileSync(path.join(root, 'macedonia.json'), JSON.stringify({ name: 'North Macedonia', bounds: [20.45, 40.85, 23.04, 42.37] }))
  const pair = path.join(root, pairDir('macedonia', 'greece'))
  assert.strictEqual(path.basename(pair), 'greece_macedonia-gh')
  const maps = new Maps(root, async () => {})
  const thess = { lat: 40.64, lng: 22.94 }, skopje = { lat: 41.99, lng: 21.43 }, athens = { lat: 37.98, lng: 23.73 }
  await assert.rejects(maps.graphFor([thess, skopje]), /North Macedonia/) // not joined yet
  fs.mkdirSync(pair); fs.writeFileSync(path.join(pair, 'properties'), 'x')
  assert.strictEqual(await maps.graphFor([thess, skopje]), pair)
  assert.strictEqual(await maps.graphFor([skopje, athens]), pair)
  assert.strictEqual(await maps.graphFor([thess, athens]), path.join(root, 'greece-gh')) // as before
  await assert.rejects(maps.graphFor([thess, { lat: 35.17, lng: 33.36 }]), /cyprus/i)
  await assert.rejects(maps.graphFor([skopje, thess, { lat: 35.17, lng: 33.36 }]), /cyprus/i) // a third country
  const trashed = []
  await new MapBuilder(root).remove('macedonia', async rel => { trashed.push(rel); fs.rmSync(path.join(root, '..', rel), { recursive: true }) })
  assert.deepStrictEqual(trashed.sort(), ['Maps/greece_macedonia-gh', 'Maps/macedonia.json', 'Maps/macedonia.pmtiles'])
  assert.ok(STEPS.indexOf('borders') > STEPS.indexOf('install'))
})

test('neighbours by their Geofabrik borders: they overlap a little; a pair takes about its size in time', () => {
  const box = (w, s, e, n) => ({ type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] })
  assert.ok(meet(box(20, 39, 26, 41.1), box(20.4, 40.8, 23, 42.4)))
  assert.ok(!meet(box(20, 39, 26, 41.1), box(32, 34.5, 34.7, 35.8)))
  assert.ok(meet(box(0, 0, 10, 10), box(2, 2, 3, 3))) // one inside the other
  assert.strictEqual(minutes(372e6, 3), 52) // as measured: 48 min with 3 threads, and the merge
  assert.ok(minutes(372e6, 16) < 30 && minutes(1e6, 16) === 2)
})

test('a map is old 3 months after it was made (30 Nov: the last of February), Greece\'s older pack by its file date', async () => {
  assert.strictEqual(isOld('2026-07-27', '2026-10-26'), false)
  assert.strictEqual(isOld('2026-07-27', '2026-10-27'), true)
  assert.strictEqual(isOld('2026-11-30', '2027-02-27'), false)
  assert.strictEqual(isOld('2026-11-30', '2027-02-28'), true)
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-')), 'Maps')
  fs.mkdirSync(root, { recursive: true })
  pmtiles(path.join(root, 'greece.pmtiles'), 18.97, 34.59, 29.66, 41.75)
  fs.utimesSync(path.join(root, 'greece.pmtiles'), new Date('2026-01-10T12:00:00Z'), new Date('2026-01-10T12:00:00Z'))
  pmtiles(path.join(root, 'cyprus.pmtiles'), 32.2, 34.5, 34.7, 35.8)
  fs.writeFileSync(path.join(root, 'cyprus.json'), JSON.stringify({ name: 'Cyprus', built: new Date().toISOString().slice(0, 10), drive: 'left' }))
  const packs = await new MapBuilder(root, () => {}).packs()
  assert.deepStrictEqual(packs.map(p => [p.id, p.built.slice(0, 7), p.old]), [['cyprus', new Date().toISOString().slice(0, 7), false], ['greece', '2026-01', true]])
})

test('the map\'s names follow Tetra\'s language; Greek unchanged', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'public', 'maps', 'light.json'), 'utf8')
  assert.strictEqual(labelsIn(style, 'el'), style)
  const de = labelsIn(style, 'de')
  assert.ok(!de.includes('name:el') && !de.includes('"Greek"') && de.includes('["get","name:de"]') && de.includes('"Latin"'))
  assert.ok(labelsIn(style, 'bg').includes('"Cyrillic"'))
  JSON.parse(de)
})
