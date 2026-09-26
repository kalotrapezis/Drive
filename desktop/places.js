// Offline place names: nearest populated place (GeoNames cities1000) within 50 km.
// The phone asks Android's Geocoder; here nothing leaves the computer.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const MAX_KM = 50
let grid = null

function load() {
  if (grid) return grid
  grid = new Map()
  const text = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'places.tsv.gz'))).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [name, lat, lon, greek] = line.split('\t')
    const place = { name, lat: +lat, lon: +lon, greek }
    const key = `${Math.floor(place.lat)},${Math.floor(place.lon)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(place)
  }
  return grid
}

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

/** { name, names } for display and search (names adds the Greek spellings), or null far from any place. */
function nearest(lat, lon) {
  const g = load()
  let best = null, dist = Infinity
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const p of g.get(`${Math.floor(lat) + dy},${Math.floor(lon) + dx}`) ?? []) {
      const d = km(lat, lon, p.lat, p.lon)
      if (d < dist) { dist = d; best = p }
    }
  }
  return best && dist <= MAX_KM ? { name: best.name, names: [best.name, best.greek].filter(Boolean).join(',') } : null
}

/** Names every located photo that has none yet. Cheap: runs after each scan. */
function fill(db) {
  const rows = db.prepare('SELECT id, latitude, longitude FROM media WHERE latitude IS NOT NULL AND place IS NULL').all()
  const set = db.prepare('UPDATE media SET place = ?, place_names = ? WHERE id = ?')
  for (const r of rows) { const p = nearest(r.latitude, r.longitude); set.run(p?.name ?? '', p?.names ?? '', r.id) }
  return rows.length
}

module.exports = { nearest, fill, km }
