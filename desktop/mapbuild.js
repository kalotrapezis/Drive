'use strict'
/**
 * The map builder (desktop Settings › Maps; Drive-Android Plan.md § Maps, the user, 27 Oct: "a map builder that downloads the
 * map, does the roads stuff and installs it in the app and then uploads to the android devices … not force anyone to write
 * code"). One region of Geofabrik's list — a country, or a part of a big one — becomes a pack in Files/Maps, which sync
 * carries to the phone and tablet:
 *
 *   <id>.pmtiles        the map: Protomaps' newest world build, cut to the region's border
 *   <id>-gh/            the roads: GraphHopper 10.2's graph for car, foot, bike and wheelchair (router.js's PROFILES)
 *   <id>-places.tsv, <id>-addresses.tsv, <id>-streets.tsv   search (maps-tools/maps-places.py)
 *   <id>-lanes.tsv      lane arrows (maps-tools/maps-lanes.py)
 *   <id>-phone.tsv      the country's area codes with their places, for the Phone (maps-tools/maps-phone.py, libphonenumber's data)
 *   <id>.json           {"name","region","built","bounds":[w,s,e,n],"drive":"right"|"left"}, written last: a pack without it is half there
 *   <a>_<b>-gh/         two neighbouring maps' roads joined at their border (ids sorted: greece_macedonia-gh), so a route crosses
 *                       from one into the other (the user, 27 Oct: "When we have both the neighbouring maps, it should be able to cross
 *                       the border"); one graph a pair, not one of every map, so the memory stays two countries' however many maps
 *                       there are ("Break it into pieces"). Made after the map is installed, one pair at a time, from each region's
 *                       .osm.pbf kept in ~/Tetra-maps/osm; Retry goes on at the pair it stopped at.
 *
 * Greece's pack, made by Drive-Android's tools/maps-greece.sh, is "greece" (Geofabrik's id), so it updates here too.
 * Nobody opens a terminal: pmtiles and GraphHopper are fetched into ~/Tetra-maps/bin the first time; what only the system
 * can install (Java 17, Python's osmium) the wizard explains and asks for with the system's own password window (pkexec;
 * the user, 27 Oct: "Please type your password … and a "I dont want" button"). The work is done in ~/Tetra-maps/<id> and
 * removed once the pack is installed.
 */
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { PROFILES, JAR, BIN, BUNDLED, findJava } = require('./router')
const { t } = require('./i18n')

const WORK = path.dirname(BIN)
const INDEX = 'https://download.geofabrik.de/index-v1-nogeom.json'
const PMTILES = '1.31.2'
const URLS = {
  pmtiles: `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES}/go-pmtiles_${PMTILES}_Linux_${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`,
  jar: `https://github.com/graphhopper/graphhopper/releases/download/10.2/${JAR}`,
}
/** The system's packages the builder may ask for (Debian and Ubuntu names), each with why, for the wizard's page. */
const PACKAGES = { 'openjdk-17-jre-headless': 'java', 'python3-pyosmium': 'osmium' }
/** The AppImage's own Python with osmium (scripts/bundle-tools.sh), else the system's. */
const PYTHON = [BUNDLED && path.join(BUNDLED, 'python', 'bin', 'python3'), '/usr/bin/python3'].find(p => p && fs.existsSync(p)) ?? '/usr/bin/python3'
/** The steps as the wizard shows them, in order. */
const STEPS = ['tools', 'map', 'osm', 'roads', 'search', 'phone', 'install', 'borders']
/** Each region's roads and places as downloaded, and its .poly border, kept for its neighbours' pair graphs. */
const OSM = path.join(WORK, 'osm')
/** Two neighbouring maps' joined roads: "greece_macedonia-gh" (Android's MapsFiles.pair). */
const pairDir = (a, b) => `${[a, b].sort().join('_')}-gh`
/**
 * About how many minutes a pair graph of `bytes` of .osm.pbf takes here: the merge, then GraphHopper's shortcuts for its four
 * profiles, as many at once as there are cores. Measured 27 Oct: Greece + North Macedonia, 372 MB, 3.5 min to merge, 48 min
 * for the graph with 3 threads (two rounds of profiles). shortcut: linear in size, one machine's numbers; good for "about".
 */
const minutes = (bytes, cores = os.cpus().length) => Math.max(2, Math.round(bytes / 372e6 * (3.5 + 24 * Math.ceil(4 / Math.min(4, cores)))))

/** Whether two regions' borders (GeoJSON MultiPolygons) meet: Geofabrik draws each a little beyond the line, so neighbours' overlap. */
function meet(a, b) {
  const inside = ([x, y], ring) => {
    let c = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c
    }
    return c
  }
  const rings = g => g.coordinates.map(p => p[0])
  return rings(a).some(ra => rings(b).some(rb => ra.some(p => inside(p, rb)) || rb.some(p => inside(p, ra))))
}
/** Whether the internet answers: Geofabrik's front page, within 8 s (the user, 27 Oct: "maybe an internet connection check?"). */
const online = () => fetch('https://download.geofabrik.de/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }).then(() => true, () => false)

/** `work()`, its failure told in plain words when the internet is down. */
const needsNet = work => work().catch(async e => { throw (await online()) ? e : new Error(t('mapbuild.offline')) })

/** Where traffic keeps left (ISO 3166-1); a region without a code takes its parent's (Bayern, Germany's). */
const LEFT = new Set(('GB IE IM JE GG CY MT JP AU NZ IN PK BD LK NP BT ID MY SG BN TH TL HK MO ZA NA BW ZW ZM MW MZ LS SZ KE UG TZ MU SC ' +
  'JM BS BB TT GY SR AG DM GD KN LC VC VG AI MS KY TC BM FK SH FJ PG WS TO SB KI TV NR CK NU').split(' '))

/** A Geofabrik .poly (rings of "lng lat", the sea round islands included) as GeoJSON, for pmtiles extract's --region. */
/** Today on this computer's clock, "YYYY-MM-DD". */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/**
 * A map made 3 months ago or more is old: roads, shops and hours change, and the builder remakes it from fresh downloads
 * (the user, 27 Oct). `built` and `now` "YYYY-MM-DD"; 30 Nov is due on the last of February, as Android's MapsFiles.isOld.
 */
function isOld(built, now = today()) {
  const [y, m, d] = built.split('-').map(Number)
  const last = new Date(Date.UTC(y, m + 3, 0)).getUTCDate() // the last day of the month 3 on (m is 1-based)
  return now >= new Date(Date.UTC(y, m + 2, Math.min(d, last))).toISOString().slice(0, 10)
}

function polyToGeoJson(text) {
  const rings = []
  let ring = null
  for (const line of text.split('\n').slice(1)) {
    const w = line.trim().split(/\s+/).filter(Boolean)
    if (!w.length) continue
    if (w[0] === 'END') { if (!ring) break; rings.push(ring); ring = null } else if (!ring) ring = []
    else ring.push([+w[0], +w[1]])
  }
  if (!rings.length) throw new Error('No border in the region’s .poly')
  return { type: 'MultiPolygon', coordinates: rings.map(r => [[...r, r[0]]]) }
}

/** A .pmtiles file's own bounds (its v3 header: min lng, min lat, max lng, max lat, ×10⁷ at byte 102). */
function pmtilesBounds(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(127)
    fs.readSync(fd, b, 0, 127, 0)
    if (b.toString('latin1', 0, 7) !== 'PMTiles') return null
    return [102, 106, 110, 114].map(o => b.readInt32LE(o) / 1e7)
  } finally { fs.closeSync(fd) }
}

/** A region's ISO 3166-1 code, or its parent's (Bayern has none, Germany has). */
function isoOf(region, regions) {
  let iso = null
  for (let r = region; r && !iso; r = regions.find(x => x.id === r.parent)) iso = r.iso
  return iso
}

class MapBuilder {
  /** `root` is Files/Maps; `progress({ id, step, state, done, total, error })` is told of each change. */
  constructor(root, progress = () => {}) { this.root = root; this.progress = progress; this.job = null }

  /** Geofabrik's regions, { id, name, parent, iso, pbf }, kept a week in ~/Tetra-maps. */
  regions() { return needsNet(() => this.list()) }
  async list() {
    const file = path.join(WORK, 'geofabrik-index.json')
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || Date.now() - stat.mtimeMs > 7 * 86_400_000) {
      await fsp.mkdir(WORK, { recursive: true })
      const res = await fetch(INDEX)
      if (!res.ok) throw new Error(`Geofabrik: ${res.status}`)
      await fsp.writeFile(file, await res.text())
    }
    return JSON.parse(await fsp.readFile(file, 'utf8')).features.map(f => f.properties)
      .map(p => ({ id: p.id, name: p.name, parent: p.parent ?? null, iso: p['iso3166-1:alpha2']?.[0] ?? null, pbf: p.urls?.pbf }))
      .filter(r => r.pbf)
  }

  /** What `id` asks of this computer: the download, the memory GraphHopper needs (about 12 × the OSM file) and the room. */
  async needs(id) {
    const r = (await this.regions()).find(x => x.id === id)
    if (!r) throw new Error('Not a region of the list.')
    const head = await needsNet(() => fetch(r.pbf, { method: 'HEAD' }))
    const osm = +(head.headers.get('content-length') ?? 0)
    const free = await fsp.statfs(fs.existsSync(WORK) ? WORK : os.homedir()).then(f => f.bavail * f.bsize, () => Infinity)
    // each neighbour here makes a pair graph with it: the biggest pair is the memory, all of them the time
    const pairs = []
    for (const n of await this.neighbours(r)) {
      const bytes = await fsp.stat(this.kept(n.id)).then(st => st.size, async () => +((await fetch(n.pbf, { method: 'HEAD' })).headers.get('content-length') ?? 0))
      pairs.push({ name: n.name, bytes: osm + bytes })
    }
    const biggest = Math.max(osm, ...pairs.map(p => p.bytes))
    return { osm, memory: Math.max(1e9, biggest * 12), hasMemory: os.totalmem(), disk: osm * 7 + pairs.reduce((a, p) => a + p.bytes * 5, 0) + 5e8, hasDisk: free,
      borders: pairs.map(p => p.name), minutes: pairs.reduce((a, p) => a + minutes(p.bytes), 0) }
  }

  /** Region `r`'s border, Geofabrik's .poly, kept in ~/Tetra-maps/osm. */
  async poly(r, signal) {
    const f = path.join(OSM, `${r.id}.poly`)
    if (!fs.existsSync(f)) {
      const res = await needsNet(() => fetch(r.pbf.replace(/-latest\.osm\.pbf$/, '.poly'), { signal }))
      if (!res.ok) throw new Error(`Geofabrik: ${res.status}`)
      await fsp.mkdir(OSM, { recursive: true })
      await fsp.writeFile(f, await res.text())
    }
    return polyToGeoJson(await fsp.readFile(f, 'utf8'))
  }

  /** The maps here whose region's border meets region `r`'s, as regions of the list with the map's name. */
  async neighbours(r, signal) {
    const regions = await this.regions(), mine = await this.poly(r, signal), out = []
    for (const p of await this.packs()) {
      const n = regions.find(x => x.id === p.id)
      if (n && n.id !== r.id && meet(mine, await this.poly(n, signal))) out.push({ ...n, name: p.name })
    }
    return out
  }

  /** The packs in Files/Maps: each .pmtiles with its manifest, when there. */
  async packs() {
    const out = []
    for (const n of await fsp.readdir(this.root).catch(() => [])) {
      if (!n.endsWith('.pmtiles') || n.startsWith('.')) continue
      const id = n.slice(0, -8)
      const st = await fsp.stat(path.join(this.root, n))
      const m = await fsp.readFile(path.join(this.root, `${id}.json`), 'utf8').then(JSON.parse, () => ({}))
      const gh = await fsp.readdir(path.join(this.root, `${id}-gh`)).catch(() => [])
      let bytes = st.size
      for (const f of gh) bytes += (await fsp.stat(path.join(this.root, `${id}-gh`, f)).catch(() => ({ size: 0 }))).size
      const built = typeof m.built === 'string' ? m.built : new Date(st.mtimeMs).toISOString().slice(0, 10)
      out.push({ id, name: typeof m.name === 'string' ? m.name : id[0].toUpperCase() + id.slice(1), region: m.region ?? id, built, old: isOld(built),
        bytes, roads: gh.includes('properties') })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The pack's files and its pair graphs to Tetra's Trash (`trash(rel)`, so the removal reaches the phone and tablet). */
  async remove(id, trash) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Not a map.')
    for (const n of await fsp.readdir(this.root)) {
      if (n === `${id}.pmtiles` || n === `${id}.json` || n === `${id}-gh` || (n.startsWith(`${id}-`) && n.endsWith('.tsv') && /^[a-z]+\.tsv$/.test(n.slice(id.length + 1))) ||
        (/^[a-z0-9-]+_[a-z0-9-]+-gh$/.test(n) && n.slice(0, -3).split('_').includes(id))) await trash(`Maps/${n}`)
    }
    await fsp.rm(path.join(OSM, `${id}.osm.pbf`), { force: true })
  }

  /** Where region `id`'s .osm.pbf is kept: the builder's, else tools/maps-greece.sh's (~/Tetra-maps/greece-latest.osm.pbf). */
  kept(id) {
    const own = path.join(OSM, `${id}.osm.pbf`), sh = path.join(WORK, `${id}-latest.osm.pbf`)
    return fs.existsSync(own) || !fs.existsSync(sh) ? own : sh
  }

  /** The system packages missing here; the wizard asks for them before a build. */
  missing() {
    const m = []
    if (!findJava()) m.push('openjdk-17-jre-headless')
    if (spawnSync(PYTHON, ['-I', '-c', 'import osmium'], { timeout: 20000 }).status !== 0) m.push('python3-pyosmium')
    return m
  }

  /**
   * Installs `packages` through the system's own password window (pkexec), so Tetra never sees the password. Resolves
   * 'done', or 'refused' when the window was closed or the password not given. shortcut: apt only (Debian, Ubuntu, Mint),
   * as Tetra ships as a .deb; another system gets the packages' names to install itself.
   */
  installSystem(packages) {
    if (!packages.length || packages.some(p => !(p in PACKAGES))) return Promise.reject(new Error('Not a package Maps needs.'))
    if (!fs.existsSync('/usr/bin/pkexec') || !fs.existsSync('/usr/bin/apt-get')) return Promise.reject(new Error(packages.join(', ')))
    return new Promise((resolve, reject) => {
      const c = spawn('/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '-y', ...packages], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } })
      let tail = ''
      c.stdout.on('data', d => { tail = (tail + d).slice(-1000) }); c.stderr.on('data', d => { tail = (tail + d).slice(-1000) })
      c.on('error', reject)
      // pkexec: 126 the window was dismissed, 127 not allowed
      c.on('close', code => code === 0 ? resolve('done') : code === 126 || code === 127 ? resolve('refused') : reject(new Error(tail.trim().split('\n').pop() || `apt-get: ${code}`)))
    })
  }

  /** A failed build's work folder, given up (the error page's Cancel). */
  async discard(id) {
    if (this.job?.id === id || !/^[a-z0-9-]+$/.test(id)) return
    await fsp.rm(path.join(WORK, id), { recursive: true, force: true })
  }

  cancel() { if (this.job) { this.job.cancelled = true; this.job.abort.abort(); this.job.child?.kill() } }

  /**
   * Builds region `id` into Files/Maps; one at a time. `resume` (the error page's Retry; the user, 27 Oct: "add a retry if a
   * step fails") goes on from the step that failed: each finished step leaves a mark in the work folder and is passed over.
   * Otherwise the work folder starts empty, so an update never takes last month's downloads.
   */
  async build(id, resume = false) {
    if (this.job) throw new Error('A map is being made already.')
    const job = this.job = { id, abort: new AbortController(), child: null, cancelled: false }
    const region = (await this.regions()).find(r => r.id === id)
    if (!region) { this.job = null; throw new Error('Not a region of the list.') }
    const missing = this.missing()
    if (missing.length) { this.job = null; this.progress({ id, step: 'tools', state: 'needs', packages: missing }); return }
    const dir = path.join(WORK, id)
    if (!resume) await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    const log = fs.createWriteStream(path.join(dir, 'build.log'), { flags: 'a' })
    let step = null
    let extra = {}
    const tell = (state, more = {}) => this.progress({ id, step, state, ...extra, ...more })
    const at = s => { step = s; tell('running'); log.write(`\n== ${s} ${new Date().toISOString()}\n`) }
    const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
      if (job.cancelled) return reject(new Error('cancelled'))
      log.write(`$ ${cmd} ${args.join(' ')}\n`)
      const c = job.child = spawn(cmd, args, { cwd: dir, ...opts })
      let tail = ''
      const keep = d => { log.write(d); tail = (tail + d).slice(-2000) }
      c.stdout.on('data', keep); c.stderr.on('data', keep)
      c.on('error', reject)
      c.on('close', code => { job.child = null; code === 0 ? resolve() : reject(new Error(job.cancelled ? 'cancelled' : `${path.basename(cmd)} stopped (${code}): ${tail.trim().split('\n').pop()}`)) })
    })
    const get = async (url, to, md5 = null) => {
      const res = await fetch(url, { signal: job.abort.signal, redirect: 'follow' })
      if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`)
      const total = +(res.headers.get('content-length') ?? 0)
      const out = fs.createWriteStream(to + '.part')
      const hash = crypto.createHash('md5')
      let done = 0, told = 0
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
        hash.update(chunk); done += chunk.length
        if (Date.now() - told > 500) { told = Date.now(); tell('running', { done, total }) }
      }
      await new Promise((r, e) => out.end(err => err ? e(err) : r()))
      if (md5 && hash.digest('hex') !== md5) throw new Error('The download arrived damaged; try again.')
      await fsp.rename(to + '.part', to)
    }
    /** Step `s` (its part `part`): passed over when a run before finished it; a download tried again once after a pause before it fails. */
    const stage = async (s, work, tries = 1, part = s) => {
      at(s)
      const mark = path.join(dir, `.done-${part}`)
      if (fs.existsSync(mark)) { log.write('done before\n'); return }
      for (let i = 1; ; i++) {
        try { await work(); break } catch (e) {
          if (job.cancelled || tries === 1) throw e
          // the internet gone: wait for it (half an hour at most), saying so, and try again without counting it
          if (!(await online())) {
            tell('offline'); log.write(`no internet (${e.message}); waiting\n`)
            for (let w = 0; w < 180 && !job.cancelled && !(await online()); w++) await new Promise(r => setTimeout(r, 10_000))
            if (job.cancelled) throw e
            if (!(await online())) throw new Error(t('mapbuild.offline'))
            tell('running'); i--; continue
          }
          if (i >= tries) throw e
          log.write(`try ${i} failed (${e.message}); again in 10 s\n`)
          await new Promise(r => setTimeout(r, 10_000))
        }
      }
      await fsp.writeFile(mark, new Date().toISOString())
    }
    try {
      await stage('tools', () => this.tools(get, run), 2)

      await stage('map', async () => {
        const poly = await fetch(region.pbf.replace(/-latest\.osm\.pbf$/, '.poly'), { signal: job.abort.signal }).then(r => r.ok ? r.text() : Promise.reject(new Error(`Geofabrik: ${r.status}`)))
        await fsp.writeFile(path.join(dir, 'region.geojson'), JSON.stringify(polyToGeoJson(poly)))
        const builds = await fetch('https://build-metadata.protomaps.dev/builds.json', { signal: job.abort.signal }).then(r => r.json())
        await fsp.rm(path.join(dir, `${id}.pmtiles.part`), { force: true })
        await run(path.join(BIN, 'pmtiles'), ['extract', `https://build.protomaps.com/${builds[builds.length - 1].key}`, `${id}.pmtiles.part`,
          '--region=region.geojson', '--maxzoom=15', '--download-threads=4'])
        await fsp.rename(path.join(dir, `${id}.pmtiles.part`), path.join(dir, `${id}.pmtiles`))
      }, 2)

      await stage('osm', async () => {
        const md5 = (await fetch(region.pbf + '.md5', { signal: job.abort.signal }).then(r => r.text())).trim().split(/\s+/)[0]
        await get(region.pbf, path.join(dir, 'region.osm.pbf'), md5)
      }, 2)

      /** GraphHopper's graph of `pbf` into the work folder's `gh`. */
      const graph = async (pbf, gh) => {
        const heap = Math.max(1, Math.floor(os.totalmem() / 1e9 * 0.6)), cores = os.cpus().length // every core (the user, 27 Oct)
        await fsp.rm(path.join(dir, gh), { recursive: true, force: true })
        await fsp.writeFile(path.join(dir, `${gh}.yml`), `graphhopper:\n  datareader.file: ${pbf}\n  graph.location: ${gh}\n${PROFILES}` +
          `  prepare.min_network_size: 200\n  prepare.subnetworks.threads: ${cores}\n  prepare.ch.threads: ${cores}\n  graph.dataaccess.default_type: RAM_STORE\n`)
        await run(findJava(), [`-Xmx${heap}g`, '-jar', path.join(BIN, JAR), 'import', `${gh}.yml`])
        await fsp.rm(path.join(dir, gh, 'gh.lock'), { force: true })
      }
      await stage('roads', () => graph('region.osm.pbf', `${id}-gh`))

      await stage('search', async () => {
        for (const s of ['maps-places.py', 'maps-lanes.py', 'maps-phone.py']) await fsp.writeFile(path.join(dir, s), await fsp.readFile(path.join(__dirname, 'maps-tools', s)))
        await run(PYTHON, ['-I', 'maps-places.py', 'region.osm.pbf', `${id}-places.tsv`, `${id}-addresses.tsv`, `${id}-streets.tsv`])
        await run(PYTHON, ['-I', 'maps-lanes.py', 'region.osm.pbf', `${id}-lanes.tsv`])
      })

      // a step of its own (the user, 27 Oct: "the call regions numbers make it part of that process")
      await stage('phone', async () => {
        // the Phone's places of area codes; a country libphonenumber names none for, or no GitHub, leaves the map without them
        const iso = isoOf(region, await this.regions())
        if (iso) await run(PYTHON, ['-I', 'maps-phone.py', iso, `${id}-phone.tsv`]).catch(e => { if (job.cancelled) throw e; log.write(`no phone table: ${e.message}\n`) })
      })

      await stage('install', async () => {
        await this.install(region, dir, await this.regions())
        await fsp.mkdir(OSM, { recursive: true })
        await fsp.rename(path.join(dir, 'region.osm.pbf'), path.join(OSM, `${id}.osm.pbf`))
      })

      // a pair graph with each neighbour here, one at a time, each its own mark (the user, 27 Oct: "Break it into pieces")
      at('borders')
      const near = await this.neighbours(region, job.abort.signal)
      const pairs = near.map(n => ({ name: `${region.name} + ${n.name}`, state: fs.existsSync(path.join(dir, `.done-borders-${n.id}`)) ? 'done' : 'waiting' }))
      extra = { pairs }
      for (const [i, n] of near.entries()) {
        if (pairs[i].state !== 'done') pairs[i].state = 'running'
        await stage('borders', async () => {
          if (!fs.existsSync(this.kept(n.id))) {
            const md5 = (await fetch(n.pbf + '.md5', { signal: job.abort.signal }).then(x => x.text())).trim().split(/\s+/)[0]
            await get(n.pbf, this.kept(n.id), md5)
          }
          await fsp.writeFile(path.join(dir, 'maps-merge.py'), await fsp.readFile(path.join(__dirname, 'maps-tools', 'maps-merge.py')))
          await run(PYTHON, ['-I', 'maps-merge.py', 'pair.osm.pbf', this.kept(id), this.kept(n.id)])
          const gh = pairDir(id, n.id)
          await graph('pair.osm.pbf', gh)
          await fsp.rm(path.join(dir, 'pair.osm.pbf'), { force: true })
          await this.swapIn(path.join(dir, gh), gh)
          await fsp.rm(path.join(dir, gh), { recursive: true, force: true })
        }, 2, `borders-${n.id}`)
        pairs[i].state = 'done'
      }
      await fsp.rm(dir, { recursive: true, force: true })
      step = null
      tell('done')
    } catch (e) {
      log.write(`\n!! ${e.stack ?? e}\n`)
      tell(job.cancelled ? 'cancelled' : 'error', { error: job.cancelled ? null : String(e.message ?? e) })
      if (job.cancelled) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    } finally {
      log.end()
      this.job = null
    }
  }

  /** pmtiles and GraphHopper, each fetched once into ~/Tetra-maps/bin (Java and osmium are the system's: [missing]). */
  async tools(get, run) {
    await fsp.mkdir(BIN, { recursive: true })
    const unpack = async (url, into, strip) => {
      const tgz = path.join(BIN, `${path.basename(into)}.tar.gz`)
      await get(url, tgz)
      await fsp.rm(into + '.part', { recursive: true, force: true })
      await fsp.mkdir(into + '.part', { recursive: true })
      await run('tar', ['xzf', tgz, '-C', into + '.part', ...(strip ? ['--strip-components=1'] : [])])
      await fsp.rm(tgz, { force: true })
    }
    if (!fs.existsSync(path.join(BIN, 'pmtiles'))) {
      await unpack(URLS.pmtiles, path.join(BIN, 'pmtiles-dir'), false)
      await fsp.rename(path.join(BIN, 'pmtiles-dir.part', 'pmtiles'), path.join(BIN, 'pmtiles'))
      await fsp.rm(path.join(BIN, 'pmtiles-dir.part'), { recursive: true, force: true })
    }
    if (!fs.existsSync(path.join(BIN, JAR))) await get(URLS.jar, path.join(BIN, JAR))
  }

  /** Graph folder `from` into Files/Maps as `name`: copied beside the old one, then swapped in. */
  async swapIn(from, name) {
    const gh = path.join(this.root, name), part = path.join(this.root, `.${name}.part`)
    await fsp.rm(part, { recursive: true, force: true })
    await fsp.cp(from, part, { recursive: true })
    // the same names as the old graph's, so sync carries each file as changed; a file the new one lacks goes with the old
    await fsp.rm(gh, { recursive: true, force: true })
    await fsp.rename(part, gh)
  }

  /** Into Files/Maps: each file beside its old one and renamed over it, the roads as a folder swapped in, the manifest last. */
  async install(region, dir, regions) {
    const id = region.id
    await fsp.mkdir(this.root, { recursive: true })
    for (const n of [`${id}.pmtiles`, `${id}-places.tsv`, `${id}-addresses.tsv`, `${id}-streets.tsv`, `${id}-lanes.tsv`, `${id}-phone.tsv`]) {
      if (n.endsWith('-phone.tsv') && !fs.existsSync(path.join(dir, n))) continue
      const part = path.join(this.root, `.${n}.part`)
      await fsp.copyFile(path.join(dir, n), part)
      await fsp.rename(part, path.join(this.root, n))
    }
    await this.swapIn(path.join(dir, `${id}-gh`), `${id}-gh`)
    const iso = isoOf(region, regions)
    const manifest = { name: region.name, region: id, built: new Date().toISOString().slice(0, 10), bounds: pmtilesBounds(path.join(this.root, `${id}.pmtiles`)),
      drive: LEFT.has(iso) ? 'left' : 'right' }
    await fsp.writeFile(path.join(this.root, `.${id}.json.part`), JSON.stringify(manifest, null, 1) + '\n')
    await fsp.rename(path.join(this.root, `.${id}.json.part`), path.join(this.root, `${id}.json`))
  }
}

module.exports = { MapBuilder, STEPS, PACKAGES, pairDir, meet, minutes, polyToGeoJson, pmtilesBounds, LEFT, online, isOld }
