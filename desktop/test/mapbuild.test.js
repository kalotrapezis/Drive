'use strict'
// The map builder (mapbuild.js) and Maps with several countries' maps (maps.js), on made-up files.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MapBuilder, STEPS, ALL, polyToGeoJson, pmtilesBounds } = require('../mapbuild')
const { Maps } = require('../maps')

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

test('the roads of every map (all-gh) go with the last but one map', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-')), 'Maps')
  fs.mkdirSync(path.join(root, ALL), { recursive: true })
  fs.writeFileSync(path.join(root, ALL, 'maps.txt'), 'greece\nmacedonia\ncyprus\n')
  for (const id of ['greece', 'macedonia', 'cyprus']) pmtiles(path.join(root, `${id}.pmtiles`), 20, 40, 23, 42)
  const trashed = []
  const b = new MapBuilder(root)
  const trash = async rel => { trashed.push(rel); fs.rmSync(path.join(root, '..', rel), { recursive: true }) }
  await b.remove('cyprus', trash)
  assert.ok(fs.existsSync(path.join(root, ALL)))
  await b.remove('macedonia', trash)
  assert.deepStrictEqual(trashed, ['Maps/cyprus.pmtiles', 'Maps/macedonia.pmtiles', `Maps/${ALL}`])
  assert.ok(STEPS.indexOf('borders') > STEPS.indexOf('roads') && STEPS.indexOf('borders') < STEPS.indexOf('install'))
})
