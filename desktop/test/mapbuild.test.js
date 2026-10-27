'use strict'
// The map builder (mapbuild.js) and Maps with several countries' maps (maps.js), on made-up files.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MapBuilder, STEPS, crossingsFile, meet, polyToGeoJson, pmtilesBounds, isOld } = require('../mapbuild')
const { Maps, labelsIn } = require('../maps')
const { join } = require('../router')

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

test('across borders: each map\'s own roads to a crossing and on from there, the fastest crossing; Remove takes its crossings', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-')), 'Maps')
  fs.mkdirSync(root, { recursive: true })
  pmtiles(path.join(root, 'greece.pmtiles'), 18.97, 34.59, 29.66, 41.75)
  pmtiles(path.join(root, 'macedonia.pmtiles'), 20.45, 40.85, 23.04, 42.37)
  pmtiles(path.join(root, 'serbia.pmtiles'), 18.8, 42.2, 23.0, 46.2)
  pmtiles(path.join(root, 'cyprus.pmtiles'), 31, 34, 35, 36)
  fs.writeFileSync(path.join(root, 'macedonia.json'), JSON.stringify({ name: 'North Macedonia', bounds: [20.45, 40.85, 23.04, 42.37] }))
  assert.strictEqual(crossingsFile('macedonia', 'greece'), 'greece_macedonia-crossings.tsv')
  const maps = new Maps(root, async () => {})
  const gh = id => path.join(root, `${id}-gh`)
  // made-up times: a straight line at 1 km a minute, a slow crossing at Niki, nothing across the sea
  const km = (p, q) => Math.hypot(p.lat - q.lat, (p.lng - q.lng) * Math.cos(p.lat * Math.PI / 180)) * 111
  const asked = []
  const seconds = async (dir, a, b) => { asked.push(path.basename(dir)); return b.lat > 35.5 && b.lat < 35.6 ? null : km(a, b) * 60 + (Math.abs(b.lng - 21.418) < 0.01 ? 3600 : 0) }
  const thess = { lat: 40.64, lng: 22.94 }, skopje = { lat: 41.99, lng: 21.43 }, athens = { lat: 37.98, lng: 23.73 }, belgrade = { lat: 44.79, lng: 20.45 }
  assert.deepStrictEqual(await maps.legs(thess, athens, seconds), [{ dir: gh('greece'), from: thess, to: athens }]) // as before
  assert.deepStrictEqual(asked, [])
  await assert.rejects(maps.legs(thess, skopje, seconds), /Tetra knows no way from Greece to North Macedonia/) // no crossings yet
  fs.writeFileSync(path.join(root, 'greece_macedonia-crossings.tsv'), '41.133893\t22.548533\t\tmotorway\n40.916274\t21.418159\t\ttrunk\n41.170555\t22.745243\t\tsecondary\n')
  const evzonoi = { lat: 41.133893, lng: 22.548533, name: '', n: -1 }
  assert.deepStrictEqual(await maps.legs(thess, skopje, seconds), [{ dir: gh('greece'), from: thess, to: evzonoi }, { dir: gh('macedonia'), from: evzonoi, to: skopje }])
  // three countries: Thessaloniki to Belgrade through North Macedonia
  await assert.rejects(maps.legs(thess, belgrade, seconds), /Greece to Serbia/)
  fs.writeFileSync(path.join(root, 'macedonia_serbia-crossings.tsv'), '42.234902\t21.703802\t\tmotorway\n42.326463\t22.331514\tГолеш\ttertiary\n')
  const legs = await maps.legs(thess, belgrade, seconds)
  assert.deepStrictEqual(legs.map(l => [path.basename(l.dir), l.to.lat]), [['greece-gh', 41.133893], ['macedonia-gh', 42.234902], ['serbia-gh', 44.79]])
  await assert.rejects(maps.legs(thess, { lat: 35.17, lng: 33.36 }, seconds), /Cyprus/)
  const trashed = []
  await new MapBuilder(root).remove('macedonia', async rel => { trashed.push(rel); fs.rmSync(path.join(root, '..', rel), { recursive: true }) })
  assert.deepStrictEqual(trashed.sort(), ['Maps/greece_macedonia-crossings.tsv', 'Maps/macedonia.json', 'Maps/macedonia.pmtiles', 'Maps/macedonia_serbia-crossings.tsv'])
  assert.ok(STEPS.indexOf('borders') > STEPS.indexOf('install'))
})

test('legs joined into one route: the crossing said once, a stop kept', () => {
  const leg = (m, n) => ({ metres: m, seconds: m / 10, line: [[0, n], [1, n + 1]], steps: [{ text: 'go', metres: m, seconds: m / 10, sign: 0 }, { text: 'arrive', metres: 0, seconds: 0, sign: 4 }] })
  const r = join([leg(100, 0), leg(50, 1), leg(20, 2)], [false, true, true])
  assert.deepStrictEqual([r.metres, r.seconds, r.line.length], [170, 17, 4])
  assert.deepStrictEqual(r.steps.map(s => s.sign), [0, 0, 4, 0, 4])
})

test('neighbours by their Geofabrik borders: they overlap a little', () => {
  const box = (w, s, e, n) => ({ type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] })
  assert.ok(meet(box(20, 39, 26, 41.1), box(20.4, 40.8, 23, 42.4)))
  assert.ok(!meet(box(20, 39, 26, 41.1), box(32, 34.5, 34.7, 35.8)))
  assert.ok(meet(box(0, 0, 10, 10), box(2, 2, 3, 3))) // one inside the other
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
