const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { Cleaner } = require('../cleaner')
const system = require('../system')

const put = (f, text = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 27)
const sha = c => c.repeat(64)

/** A computer of its own: the data dir, .System, Files/Maps, the person's own files beside them, and a library of one photo. */
const made = []
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
function computer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-clean-'))
  made.push(tmp)
  const dataDir = path.join(tmp, 'data'), base = path.join(tmp, 'Tetra', '.System'), mapsRoot = path.join(tmp, 'Tetra', 'Files', 'Maps')
  put(path.join(tmp, 'Tetra', 'Files', 'Work', 'plan.txt'), 'the person\'s own')
  put(path.join(tmp, 'Tetra', 'Photos', 'a.jpg'), 'a photo')
  put(path.join(dataDir, 'library.db.keep'), 'not a safety copy')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE media (sha256 TEXT)')
  db.prepare('INSERT INTO media VALUES (?)').run(sha('a'))
  return { tmp, dataDir, base, mapsRoot, db }
}
/** Every file under `dir`, relative. */
const files = dir => fs.readdirSync(dir, { recursive: true }).filter(n => !fs.statSync(path.join(dir, n)).isDirectory()).sort()

test("each app's Temp and Cache: sized, cleaned, Data and Tools and a running job's Temp kept", async () => {
  const c = computer()
  put(path.join(system.dir('Maps', 'Temp', c.base), 'testland', 'half.pmtiles.part'), '12345')
  put(path.join(system.dir('Maps', 'Cache', c.base), 'geofabrik-index.json'), '123')
  put(path.join(system.dir('Maps', 'Data', c.base), 'osm', 'testland.osm.pbf'), 'kept')
  put(path.join(system.dir('Maps', 'Tools', c.base), 'pmtiles'), 'tool')
  put(path.join(system.dir('Office', 'Temp', c.base), 'preview.pdf'), '1')
  let building = true
  const cl = new Cleaner({ ...c, busy: app => app === 'Maps' && building })
  const items = await cl.items(NOW)
  assert.deepEqual(items.find(i => i.id === 'system:Maps'), { id: 'system:Maps', app: 'Maps', bytes: 3, files: 1, ready: true }, 'a build running: only its Cache')
  assert.equal(items.find(i => i.id === 'system:Office').bytes, 1)
  assert.ok(!items.some(i => i.id === 'system:Photos'), 'an app with nothing is not listed')
  building = false
  assert.deepEqual(await cl.clean('system:Maps', NOW), { bytes: 8, files: 2 })
  assert.deepEqual(files(c.base), ['Maps/Data/osm/testland.osm.pbf', 'Maps/Tools/pmtiles', 'Office/Temp/preview.pdf'])
})

test('Files history: only what is older than 30 days, by the time its folder is named for', async () => {
  const c = computer(), h = path.join(c.dataDir, 'Files history')
  put(path.join(h, String(NOW - 31 * DAY), 'Work', 'plan.txt'), 'old one')
  put(path.join(h, String(NOW - 2 * DAY), 'Work', 'plan.txt'), 'new')
  const cl = new Cleaner(c)
  assert.deepEqual((await cl.items(NOW)).find(i => i.id === 'history'), { id: 'history', bytes: 7, files: 1, ready: true })
  await cl.clean('history', NOW)
  assert.deepEqual(fs.readdirSync(h), [String(NOW - 2 * DAY)])
  assert.equal(fs.readFileSync(path.join(c.tmp, 'Tetra', 'Files', 'Work', 'plan.txt'), 'utf8'), 'the person\'s own')
})

test('thumbnails without a photo: on a server after a scan only, never a face or a known photo\'s', async () => {
  const c = computer(), t = path.join(c.dataDir, 'thumbs')
  put(path.join(t, `${sha('a')}.webp`), 'known'); put(path.join(t, `${sha('b')}.webp`), 'gone'); put(path.join(t, `${sha('b')}.preview.jpg`), 'gone')
  put(path.join(t, 'faces', '7.webp'), 'a face')
  let server = false, scanned = false
  const cl = new Cleaner({ ...c, isServer: () => server, scanned: () => scanned })
  assert.deepEqual((await cl.items(NOW)).find(i => i.id === 'thumbs'), { id: 'thumbs', bytes: 0, files: 0, ready: false }, 'a client keeps the server\'s')
  server = true
  assert.equal((await cl.items(NOW)).find(i => i.id === 'thumbs').ready, false, 'not before a scan')
  await cl.clean('thumbs', NOW)
  assert.equal(files(t).length, 4, 'and a clean then does nothing')
  scanned = true
  assert.deepEqual(await cl.clean('thumbs', NOW), { bytes: 8, files: 2 })
  assert.deepEqual(files(t), [`${sha('a')}.webp`, 'faces/7.webp'])
})

test('the old safety copies are moved into .System/Backups/Data, never deleted', async () => {
  const c = computer()
  put(path.join(c.dataDir, 'library.db.before-tetra-folder'), 'db copy')
  put(path.join(c.dataDir, 'date-repair-20260924.json'), '{}'); put(path.join(c.dataDir, 'phone-date-repair-20260924.json'), '{}')
  put(path.join(c.dataDir, 'library.db'), 'the live one')
  const cl = new Cleaner(c)
  assert.equal((await cl.items(NOW)).find(i => i.id === 'copies').files, 3)
  await cl.clean('copies', NOW)
  assert.deepEqual(files(system.dir('Backups', 'Data', c.base)), ['date-repair-20260924.json', 'library.db.before-tetra-folder', 'phone-date-repair-20260924.json'])
  assert.deepEqual(files(c.dataDir), ['library.db', 'library.db.keep'])
})

test("routing work of a removed map goes; a map's own and one in use stay, and a link's target is never followed", async () => {
  const c = computer(), r = path.join(c.dataDir, 'routing')
  put(path.join(c.mapsRoot, 'testland-gh', 'nodes'), 'the graph')
  for (const n of ['testland-gh', 'gone-gh', 'busy-gh']) put(path.join(r, n, 'config.yml'), 'yml')
  // a link in the removed map's work folder (router.js links each graph file): it goes, what it points at stays
  put(path.join(c.tmp, 'elsewhere', 'nodes'), 'what a link points at')
  fs.mkdirSync(path.join(r, 'gone-gh', 'graph'))
  fs.symlinkSync(path.join(c.tmp, 'elsewhere', 'nodes'), path.join(r, 'gone-gh', 'graph', 'nodes'))
  const cl = new Cleaner({ ...c, routing: () => [path.join(c.mapsRoot, 'busy-gh')] })
  assert.equal((await cl.items(NOW)).find(i => i.id === 'routing').files, 2)
  await cl.clean('routing', NOW)
  assert.deepEqual(fs.readdirSync(r).sort(), ['busy-gh', 'testland-gh'])
  assert.equal(fs.readFileSync(path.join(c.mapsRoot, 'testland-gh', 'nodes'), 'utf8'), 'the graph')
  assert.equal(fs.readFileSync(path.join(c.tmp, 'elsewhere', 'nodes'), 'utf8'), 'what a link points at')
})

test('nothing but its own: an unknown item is refused', async () => {
  const c = computer()
  await assert.rejects(new Cleaner(c).clean('../Files', NOW))
  await assert.rejects(new Cleaner(c).clean('system:Tetra', NOW))
})
