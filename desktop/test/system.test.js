const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// a home of its own before anything reads it: mapbuild.js and router.js take their folders from it when loaded
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-system-'))
process.env.HOME = home
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }))
const system = require('../system')
const { MapBuilder } = require('../mapbuild')
const put = (f, text = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }

test('every folder of .System is ~/Tetra/.System/<App>/<Kind>, and no other name is made', () => {
  assert.equal(system.root(), path.join(home, 'Tetra', '.System'))
  assert.equal(system.dir('Maps', 'Tools'), path.join(home, 'Tetra', '.System', 'Maps', 'Tools'))
  assert.equal(require('../router').BIN, system.dir('Maps', 'Tools'))
  assert.throws(() => system.dir('Maps', 'bin'))
  assert.throws(() => system.dir('Tetra-maps', 'Data'))
})

test('~/Tetra-maps and ~/Tetra-backups move into .System by renaming, every file where it was, once', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-move-')), base = system.root(h)
  put(path.join(h, 'Tetra-maps', 'bin', 'graphhopper-web-10.2.jar'), 'jar')
  put(path.join(h, 'Tetra-maps', 'osm', 'testland.osm.pbf'), 'roads')
  put(path.join(h, 'Tetra-maps', 'traces', 'drive-1.csv'), 'fixes')
  put(path.join(h, 'Tetra-maps', 'testland-latest.osm.pbf'), 'script')
  put(path.join(h, 'Tetra-maps', 'geofabrik-index.json'), '{}')
  put(path.join(h, 'Tetra-backups', 'phone-before-x.tar'), 'tar')
  const ino = fs.statSync(path.join(h, 'Tetra-maps', 'osm', 'testland.osm.pbf')).ino
  const r = system.migrate(h, base)
  assert.equal(r.failed.length, 0)
  const read = (...p) => fs.readFileSync(path.join(base, ...p), 'utf8')
  assert.equal(read('Maps', 'Tools', 'graphhopper-web-10.2.jar'), 'jar')
  assert.equal(read('Maps', 'Data', 'osm', 'testland.osm.pbf'), 'roads')
  assert.equal(fs.statSync(path.join(base, 'Maps', 'Data', 'osm', 'testland.osm.pbf')).ino, ino, 'renamed, not copied')
  assert.equal(read('Maps', 'Data', 'traces', 'drive-1.csv'), 'fixes')
  assert.equal(read('Maps', 'Data', 'testland-latest.osm.pbf'), 'script')
  assert.equal(read('Maps', 'Cache', 'geofabrik-index.json'), '{}')
  assert.equal(read('Backups', 'Data', 'phone-before-x.tar'), 'tar')
  assert.ok(!fs.existsSync(path.join(h, 'Tetra-maps')) && !fs.existsSync(path.join(h, 'Tetra-backups')))
  assert.deepEqual(system.migrate(h, base), { moved: [], failed: [] }, 'and only once')
  fs.rmSync(h, { recursive: true })
})

test('a move that cannot happen leaves both folders as they were and says why', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-move-')), base = system.root(h)
  put(path.join(h, 'Tetra-backups', 'old.tar'), 'old')
  put(path.join(base, 'Backups', 'Data', 'new.tar'), 'new')
  const r = system.migrate(h, base)
  assert.equal(r.moved.length, 0)
  assert.match(r.failed[0], /Tetra-backups/)
  assert.equal(fs.readFileSync(path.join(h, 'Tetra-backups', 'old.tar'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(base, 'Backups', 'Data', 'new.tar'), 'utf8'), 'new')
  fs.rmSync(h, { recursive: true })
})

test("the start's cleaner empties every Temp and nothing else", () => {
  const base = system.root(path.join(home, 'clean'))
  for (const kind of system.KINDS) put(path.join(system.dir('Maps', kind, base), 'f'))
  put(path.join(system.dir('Sync', 'Temp', base), 'half.part'))
  system.cleanTemp(base)
  assert.ok(!fs.existsSync(system.dir('Maps', 'Temp', base)) && !fs.existsSync(system.dir('Sync', 'Temp', base)))
  for (const kind of ['Data', 'Tools', 'Cache']) assert.ok(fs.existsSync(path.join(system.dir('Maps', kind, base), 'f')), kind)
})

test('a cancelled build cleans up after itself: only Tools and Data stay, and a sync\'s .part is not touched', async () => {
  const maps = path.join(home, 'Tetra', 'Files', 'Maps')
  const tools = path.join(system.dir('Maps', 'Tools'), 'pmtiles'), kept = path.join(system.dir('Maps', 'Data'), 'osm', 'testland.osm.pbf')
  put(tools, 'tool'); put(kept, 'roads')
  put(path.join(maps, '.testland.pmtiles.0b5e-sync.part'), 'a sync arriving')
  put(path.join(maps, '.testland-gh.part', 'nodes'), 'a crash in the middle of an install')
  put(path.join(maps, '.otherland_testland-crossings.tsv.part'), 'and of a crossing')
  const b = new MapBuilder(maps)
  b.regions = async () => [{ id: 'testland', name: 'Testland', parent: null, iso: null, pbf: 'http://127.0.0.1:9/testland-latest.osm.pbf' }]
  b.missing = () => []
  b.tools = async (get, run, dir) => { put(path.join(dir, 'pmtiles.tar.gz.part'), 'half'); b.cancel(); throw new Error('cancelled') }
  const told = []
  b.progress = p => told.push(p.state)
  await b.build('testland')
  assert.equal(told.at(-1), 'cancelled')
  assert.ok(!fs.existsSync(path.join(system.dir('Maps', 'Temp'), 'testland')), 'the work folder is gone')
  assert.deepEqual(fs.readdirSync(maps), ['.testland.pmtiles.0b5e-sync.part'])
  assert.equal(fs.readFileSync(tools, 'utf8'), 'tool')
  assert.equal(fs.readFileSync(kept, 'utf8'), 'roads')
  assert.equal(b.job, null)
})
