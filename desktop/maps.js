'use strict'
/**
 * Tetra's Maps on the computer (Drive-Android Plan.md § Maps; Maps.kt is the phone's twin, the same files and rules).
 * Everything is a file in ~/Tetra/Files/Maps, synced as files are, hidden from Files' lists like the Calendar and the Timer:
 *
 *   greece.pmtiles     the offline map (Protomaps' basemap cut to Greece), served to the window as tiles
 *   greece-*.tsv       the search lists (tools/maps-places.py and friends): kind, lat, lng, name, name in English, …
 *   added-places.tsv   places put into the map's own data by hand
 *   Places/<id>.json   {"id":"k3f9a2","name":"Home","lat":37.97,"lng":23.72,"icon":"home","slot":1,"mode":"car","lists":["fav"]}
 *   Lists/<id>.json    {"id":"fav","name":"Favourites","emoji":"❤️"}
 *   Trips/<id>.json    {"id":"…","name":"A → B","stops":[{"name":"A","lat":…,"lng":…},…]}
 */
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { t } = require('./i18n')

const MAP = 'greece.pmtiles', PLACES = 'Places', LISTS = 'Lists', TRIPS = 'Trips', SLOTS = 12
const ICONS = ['pin', 'star', 'heart', 'accessible', 'home', 'work', 'school', 'family', 'friend', 'pharmacy', 'hospital', 'doctor', 'travel',
  'hotel', 'food', 'tavern', 'cafe', 'shop', 'fuel', 'parking', 'beach', 'waterfall', 'river', 'lake', 'mountain', 'forest', 'camping']
const MODES = ['car', 'foot', 'bike']
const SEARCH_FILES = ['greece-places.tsv', 'greece-eopyy.tsv', 'greece-amea.tsv', 'greece-amea-diavgeia.tsv', 'added-places.tsv']
const SETTLEMENTS = new Set(['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet', 'island', 'islet', 'locality'])

const newId = () => crypto.randomBytes(3).toString('hex')
const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

/** Lower case, no accents, final sigma as sigma: "Ξάνθη" and "ξανθη" are the same (MapsSearch.fold). */
const fold = s => String(s).toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').replace(/ς/g, 'σ')

const GREEK = { α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'ks', ο: 'o', π: 'p', ρ: 'r',
  σ: 's', τ: 't', υ: 'i', φ: 'f', χ: 'x', ψ: 'ps', ω: 'o' }
/** Greek and Greeklish to one spelling, so "krewnas", "kreonas" and "Κρεώνας" meet (MapsSearch.latin). */
function latin(folded) {
  const g = folded.replace(/ου/g, '\u0001').replace(/ει/g, 'ι').replace(/οι/g, 'ι').replace(/αι/g, 'ε')
  let b = ''
  for (const c of g) b += c === '\u0001' ? 'ou' : GREEK[c] ?? c
  return b.replace(/8/g, 'th').replace(/w/g, 'o').replace(/y/g, 'i').replace(/(?<![tcp])h/g, 'i').replace(/ch/g, 'x')
}

function metres(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lng2 - lng1) * Math.PI / 360) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}

/** A search list's line (MapsSearch.parse): kind, lat, lng, name, English name, more, hours, phone, web, wheelchair, note. */
function parsePoi(line) {
  const c = line.split('\t')
  if (c.length < 4) return null
  const lat = Number(c[1]), lng = Number(c[2])
  if (!c[1] || !c[2] || !inRange(lat, lng)) return null
  const [kind, , , name, nameEn = '', more = '', hours = '', phone = '', web = '', wheelchair = '', note = ''] = c
  const key = fold(`${name} ${nameEn}`)
  return { kind, lat, lng, name, nameEn, more, hours, phone, web, wheelchair, note, key: `${key} ${latin(fold(name))}` }
}

/** A file's place (Place.parse); anything that is not one — a stray file, half a write — is null, never an error. */
function parsePlace(text, file) {
  try {
    const o = JSON.parse(text)
    const lat = Number(o.lat), lng = Number(o.lng)
    if (!inRange(lat, lng)) return null
    const id = typeof o.id === 'string' && o.id ? o.id : file ? path.basename(file, '.json') : null
    if (!id) return null
    const slot = Number.isInteger(o.slot) && o.slot >= 0 && o.slot <= SLOTS ? o.slot : 0
    return { id, name: typeof o.name === 'string' && o.name ? o.name : 'Place', lat, lng, icon: ICONS.includes(o.icon) ? o.icon : 'pin', slot,
      mode: MODES.includes(o.mode) ? o.mode : 'car', lists: Array.isArray(o.lists) ? o.lists.filter(l => typeof l === 'string' && l) : [],
      label: typeof o.label === 'string' ? o.label : '' }
  } catch { return null }
}

function parseTrip(text, file) {
  try {
    const o = JSON.parse(text)
    const stops = (Array.isArray(o.stops) ? o.stops : []).map((s, i) => s && inRange(Number(s.lat), Number(s.lng))
      ? { name: typeof s.name === 'string' && s.name ? s.name : `Stop ${String.fromCharCode(65 + i % 26)}`, lat: Number(s.lat), lng: Number(s.lng) } : null).filter(Boolean)
    const id = typeof o.id === 'string' && o.id ? o.id : file ? path.basename(file, '.json') : null
    return stops.length && id ? { id, name: typeof o.name === 'string' && o.name ? o.name : 'Trip', stops } : null
  } catch { return null }
}

function parseList(text, file) {
  try {
    const o = JSON.parse(text)
    const id = typeof o.id === 'string' && o.id ? o.id : file ? path.basename(file, '.json') : null
    return id ? { id, name: typeof o.name === 'string' && o.name ? o.name : 'List', emoji: typeof o.emoji === 'string' ? o.emoji : '' } : null
  } catch { return null }
}

/** The pmtiles reader's source: byte ranges of the map file. */
class FileSource {
  constructor(file) { this.file = file; this.fd = fs.openSync(file, 'r') }
  getKey() { return this.file }
  async getBytes(offset, length) {
    const b = Buffer.alloc(length)
    const { bytesRead } = await new Promise((resolve, reject) => fs.read(this.fd, b, 0, length, offset, (e, n) => e ? reject(e) : resolve({ bytesRead: n })))
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + bytesRead) }
  }
  close() { fs.close(this.fd, () => {}) }
}

class Maps {
  /** `trash(rel)` moves a file of Files into its Trash, so a deletion reaches the other devices. */
  constructor(root, trash) { this.root = root; this.trash = trash }

  // ---- the map ----

  /** A vector tile, unpacked; null where the map has none. The file is reopened when sync brings a new one. */
  async tile(z, x, y) {
    const file = path.join(this.root, MAP)
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat) return null
    if (!this.pm || this.pmStamp !== stat.mtimeMs) {
      this.pmSource?.close()
      const { PMTiles } = require('pmtiles')
      this.pmSource = new FileSource(file)
      this.pm = new PMTiles(this.pmSource)
      this.pmStamp = stat.mtimeMs
    }
    const t = await this.pm.getZxy(z, x, y)
    return t ? Buffer.from(t.data) : null
  }

  async info() {
    const stat = await fsp.stat(path.join(this.root, MAP)).catch(() => null)
    return { root: this.root, map: stat ? { bytes: stat.size, at: stat.mtimeMs } : null }
  }

  // ---- saved places, lists, trips ----

  async read(dir, parse) {
    const full = path.join(this.root, dir)
    const names = await fsp.readdir(full).catch(() => [])
    const out = []
    for (const n of names) if (!n.startsWith('.') && n.toLowerCase().endsWith('.json')) {
      const f = path.join(full, n)
      const v = parse(await fsp.readFile(f, 'utf8').catch(() => ''), f)
      if (v) out.push(v)
    }
    return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
  /**
   * The saved places, one per id: a sync that found a place changed on both sides keeps both files ("parking (2).json"),
   * so the newest file is the place and its older copies go to the Trash (the user, 23 Oct: "it had 3 parkings, keep only
   * the latest"; home in three files on the phone, where a save into an empty slot lost to an older copy) — MapsFiles.places.
   */
  async places() {
    const full = path.join(this.root, PLACES)
    const byId = new Map()
    for (const n of await fsp.readdir(full).catch(() => [])) if (!n.startsWith('.') && n.toLowerCase().endsWith('.json')) {
      const f = path.join(full, n)
      const p = parsePlace(await fsp.readFile(f, 'utf8').catch(() => ''), f)
      if (!p) continue
      const at = (await fsp.stat(f).catch(() => null))?.mtimeMs ?? 0
      const was = byId.get(p.id)
      const [keep, drop] = !was || at > was.at ? [{ p, at, n }, was] : [was, { p, at, n }]
      byId.set(p.id, keep)
      if (drop) await this.trash(`Maps/${PLACES}/${drop.n}`).catch(() => {})
    }
    return settle([...byId.values()]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
  lists() { return this.read(LISTS, parseList) }
  trips() { return this.read(TRIPS, parseTrip) }

  /** Written beside, then renamed over, so a sync never reads half a file (MapsFiles.write). */
  async write(dir, id, body) {
    const full = path.join(this.root, dir)
    await fsp.mkdir(full, { recursive: true })
    const to = path.join(full, `${id}.json`), part = path.join(full, `.${id}.json.part`)
    await fsp.writeFile(part, JSON.stringify(body, null, 1) + '\n')
    await fsp.rename(part, to)
  }

  /** Taking a Home slot frees it on any other place (MapsFiles.save). */
  async savePlace(raw) {
    const p = parsePlace(JSON.stringify({ ...raw, id: raw.id || newId() }))
    if (!p) throw new Error(t('maps.noPosition'))
    if (p.slot > 0) for (const o of await this.places()) if (o.slot === p.slot && o.id !== p.id) await this.write(PLACES, o.id, placeJson({ ...o, slot: 0 }))
    await this.write(PLACES, p.id, placeJson(p))
    await this.remove(PLACES, p.id, `${p.id}.json`) // its sync copies: this save is the place
    return p
  }
  async deletePlace(id) { await this.remove(PLACES, id) }

  async saveList(raw) {
    const l = { id: raw.id || newId(), name: String(raw.name || 'List').trim() || 'List', emoji: String(raw.emoji ?? '') }
    await this.write(LISTS, l.id, l)
    return l
  }
  /** The list goes; its places keep its id, which no longer names a list and is passed over (MapsFiles.deleteList). */
  async deleteList(id) { await this.remove(LISTS, id) }

  async saveTrip(raw) {
    const trip = parseTrip(JSON.stringify({ ...raw, id: raw.id || newId() }))
    if (!trip) throw new Error(t('maps.tripNeedsStop'))
    await this.write(TRIPS, trip.id, { id: trip.id, name: trip.name, stops: trip.stops })
    return trip
  }
  async deleteTrip(id) { await this.remove(TRIPS, id) }

  /** Every file of `id` to the Trash: its own and any copy a sync made of it under another name ("parking (2).json"). */
  async remove(dir, id, keep = null) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('Not a place of the map.')
    const full = path.join(this.root, dir)
    for (const n of await fsp.readdir(full).catch(() => [])) if (n.toLowerCase().endsWith('.json') && n !== keep) {
      const own = n === `${id}.json` || (() => { try { return JSON.parse(fs.readFileSync(path.join(full, n), 'utf8')).id === id } catch { return false } })()
      if (own) await this.trash(`Maps/${dir}/${n}`)
    }
  }

  // ---- search and addresses ----

  /** The search lists, read once (about 130 000 places) and kept while the files are the same (MapsSearch.load). */
  async pois() {
    const stats = await Promise.all(SEARCH_FILES.map(f => fsp.stat(path.join(this.root, f)).catch(() => null)))
    const stamp = stats.map(s => s ? s.mtimeMs : 0).join('|')
    if (this.poiCache?.stamp === stamp) return this.poiCache.all
    const all = []
    for (const [i, f] of SEARCH_FILES.entries()) if (stats[i]) {
      for (const line of (await fsp.readFile(path.join(this.root, f), 'utf8')).split('\n')) { const p = parsePoi(line); if (p) all.push(p) }
    }
    this.poiCache = { stamp, all }
    return all
  }

  /**
   * What `query` finds, of `kind` when one is given, nearest the map's middle first; a name that starts with the query
   * before one that has it inside, towns before shops when only words are given (MapsSearch.search).
   */
  async search({ query = '', kind = null, lat, lng, limit = 60, nearby = false, within = null }) {
    return search(await this.pois(), { query, kind, lat, lng, limit, nearby, within })
  }

  async addresses() {
    const file = path.join(this.root, 'greece-addresses.tsv')
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat) return null
    if (this.addrCache?.at === stat.mtimeMs) return this.addrCache
    const lat = [], lng = [], rest = []
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      const c = line.split('\t')
      if (c.length < 3) continue
      const a = Number(c[0]), b = Number(c[1])
      if (!inRange(a, b) || !c[0]) continue
      lat.push(a); lng.push(b); rest.push(c.slice(2))
    }
    this.addrCache = { at: stat.mtimeMs, lat: Float64Array.from(lat), lng: Float64Array.from(lng), rest }
    return this.addrCache
  }

  /** The named roads: a name and the middle of each road piece (greece-streets.tsv), read once (MapsStreets). */
  async streets() {
    const file = path.join(this.root, 'greece-streets.tsv')
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat) return null
    if (this.streetCache?.at === stat.mtimeMs) return this.streetCache
    const lat = [], lng = [], name = []
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      const c = line.split('\t')
      if (c.length < 3) continue
      const a = Number(c[1]), b = Number(c[2])
      if (!c[1] || !inRange(a, b)) continue
      lat.push(a); lng.push(b); name.push(c[0])
    }
    this.streetCache = { at: stat.mtimeMs, lat: Float64Array.from(lat), lng: Float64Array.from(lng), name }
    return this.streetCache
  }

  /**
   * "Οδός 12, 67100 Ξάνθη": the nearest address within 60 m; where no house near has a number (most villages), the street —
   * `road`, the one tapped, or the nearest road piece within 80 m — with the nearest postcode within 1.5 km or the town's
   * own (MapsAddresses.describe; the user, 23 Oct: "address, number, postcode"; "when I tap on the road give the address").
   */
  async describe(lat, lng, road = null) {
    const a = await this.addresses(), pois = await this.pois()
    let best = -1, bestD = 60, post = '', postD = 1500
    if (a) for (let i = 0; i < a.lat.length; i++) {
      if (Math.abs(a.lat[i] - lat) > 0.014 || Math.abs(a.lng[i] - lng) > 0.018) continue
      const d = metres(lat, lng, a.lat[i], a.lng[i])
      if (d < bestD) { bestD = d; best = i }
      if (d < postD && a.rest[i][2]) { post = a.rest[i][2]; postD = d }
    }
    let town = null, townD = Infinity
    for (const p of pois) if (['city', 'town', 'village', 'suburb'].includes(p.kind) && Math.abs(p.lat - lat) < 0.1 && Math.abs(p.lng - lng) < 0.13) {
      const d = metres(lat, lng, p.lat, p.lng)
      if (d < townD) { townD = d; town = p }
    }
    const r = best >= 0 ? a.rest[best] : null
    let street = r ? `${r[0]} ${r[1] ?? ''}`.trim() : (typeof road === 'string' && road.trim()) || ''
    if (!street) {
      const s = await this.streets()
      let d0 = 80
      if (s) for (let i = 0; i < s.lat.length; i++) {
        if (Math.abs(s.lat[i] - lat) > 0.002 || Math.abs(s.lng[i] - lng) > 0.0025) continue
        const d = metres(lat, lng, s.lat[i], s.lng[i])
        if (d < d0) { d0 = d; street = s.name[i] }
      }
    }
    const code = (r && r[2]) || post || (town && /^\d{3} ?\d{2}$/.test(town.more) ? town.more : '')
    const place = (r && r[3]) || (town ? town.name || town.nameEn : '')
    return [street, `${code} ${place}`.trim()].filter(Boolean).join(', ') || null
  }

  /** The list's own entry for something on the map: the same name, or the nearest, within `within` metres (MapsSearch.near). */
  async near(lat, lng, name = '', within = 40) {
    const n = fold(name)
    let best = null, bestRank = [2, Infinity]
    for (const p of await this.pois()) {
      if (Math.abs(p.lat - lat) > 0.001 || Math.abs(p.lng - lng) > 0.0013) continue
      const d = metres(lat, lng, p.lat, p.lng)
      if (d > within) continue
      const rank = [n && fold(p.name) === n ? 0 : 1, d]
      if (rank[0] < bestRank[0] || (rank[0] === bestRank[0] && rank[1] < bestRank[1])) { best = p; bestRank = rank }
    }
    return best ? strip(best) : null
  }
}

const strip = ({ key, ...p }) => p
/**
 * One place a slot, both kept: two devices that each put a place into one slot while apart — the newest file keeps it, the
 * other takes the first free slot (none free: off Home, still saved). From the files alone, by second, so every device shows
 * the same card without a write (MapsFiles.settle on the phone). `vs` are { p, at } with `at` the file's mtimeMs.
 */
const settle = vs => {
  const taken = new Set()
  const late = vs.filter(v => v.p.slot > 0)
    .sort((a, b) => Math.floor(b.at / 1000) - Math.floor(a.at / 1000) || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
    .filter(v => taken.has(v.p.slot) ? true : (taken.add(v.p.slot), false))
  const moved = new Map(late.map(v => {
    let n = 0
    for (let i = 1; i <= SLOTS; i++) if (!taken.has(i)) { n = i; taken.add(i); break }
    return [v.p.id, n]
  }))
  return vs.map(v => moved.has(v.p.id) ? { ...v.p, slot: moved.get(v.p.id) } : v.p)
}

const placeJson = p => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, icon: p.icon, slot: p.slot, mode: p.mode, lists: p.lists, ...(p.label ? { label: p.label } : {}) })

function search(all, { query = '', kind = null, lat, lng, limit = 60, nearby = false, within = null }) {
  const q = fold(String(query).trim())
  // a box (the map's screen and half of it round) when Search's OK keeps what is in view (the user, 21 Oct)
  const inBox = within ? p => p.lat >= within.south && p.lat <= within.north && p.lng >= within.west && p.lng <= within.east : () => true
  if (!q && !kind) {
    if (!nearby) return []
    return all.filter(p => !SETTLEMENTS.has(p.kind) && Math.abs(p.lat - lat) < 0.05 && Math.abs(p.lng - lng) < 0.065)
      .map(p => [p, metres(lat, lng, p.lat, p.lng)]).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([p]) => strip(p))
  }
  const words = q.split(' ').filter(Boolean), greeklish = latin(q).split(' ').filter(Boolean)
  const has = p => words.every(w => p.key.includes(w)) || greeklish.every(w => p.key.includes(w))
  // a kind with words that name a town: that kind in and around it (the user, 21 Oct: "agios loukas" + Supermarkets)
  if (kind && words.length) {
    let town = null, townD = Infinity
    for (const p of all) if (SETTLEMENTS.has(p.kind) && (p.key.startsWith(q) || p.key.includes(` ${q}`) || has(p))) {
      const d = metres(lat, lng, p.lat, p.lng)
      if (d < townD) { townD = d; town = p }
    }
    if (town) return search(all, { query: '', kind, lat: town.lat, lng: town.lng, limit, nearby: true, within })
  }
  return all.filter(p => (!kind || p.kind === kind) && has(p) && inBox(p))
    .map(p => [p, metres(lat, lng, p.lat, p.lng), !q || p.key.startsWith(q) || p.key.includes(` ${q}`) ? 0 : 1, !kind && q && !SETTLEMENTS.has(p.kind) ? 1 : 0])
    .sort((a, b) => a[2] - b[2] || a[3] - b[3] || a[1] - b[1]).slice(0, limit).map(([p]) => strip(p))
}

module.exports = { Maps, fold, latin, metres, parsePoi, parsePlace, parseTrip, search, SETTLEMENTS }
