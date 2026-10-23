import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { MapList, MapPlace, MapStop, MapTrip, Poi } from './drive'
import { Icon } from './Icon'
import { errorText } from './Dialogs'
import { CATEGORIES, EMBLEMS } from './emblems'

maplibregl.setWorkerUrl(workerUrl) // the page loads from file://, where MapLibre cannot find its worker by itself

// Tetra's Maps on the computer (Drive-Android Plan.md § Maps; MapsScreen.kt and MapsPanels.kt are the phone's): the offline
// map of Greece from Files/Maps/greece.pmtiles, Search with the phone's pills, saved places and lists, trips planned here
// and driven with the phone. The files are the phone's own (maps.js); sync carries every change both ways.

const GREECE: [[number, number], [number, number]] = [[18.6, 34.2], [30.2, 42.2]]
const MAPS_COLOR = '#5c6bc0'
const FONT = ['Noto Sans Regular']

/** Search's pills, in the phone's order (MapsSearch.PILLS). */
const PILLS: [key: string, label: string, emoji: string][] = [
  ['restaurant', 'Restaurants', '🍽️'], ['cafe', 'Cafés', '☕'], ['supermarket', 'Supermarkets', '🛒'], ['pharmacy', 'Pharmacies', '💊'],
  ['eopyy', 'EOPYY pharmacies', '⚕️'], ['fuel', 'Fuel', '⛽'], ['charging', 'EV charging', '🔌'], ['disabled_parking', 'Disabled parking', '♿'],
  ['parking', 'Parking', '🅿️'], ['hospital', 'Hospitals', '🏥'], ['bakery', 'Bakeries', '🥖'], ['fast_food', 'Fast food', '🍔'], ['atm', 'ATMs', '🏧'],
  ['hotel', 'Hotels', '🛏️'], ['beach', 'Beaches', '🏖️'], ['museum', 'Museums', '🏛️'], ['toilets', 'Toilets', '🚻'], ['toll', 'Tolls', '💶'],
  ['kindergarten', 'Kindergartens', '🧸'], ['primary_school', 'Primary schools', '🎒'], ['secondary_school', 'High schools', '🏫'],
  ['school', 'Other schools', '🏫'], ['university', 'Universities', '🎓'],
]
const SETTLEMENTS: Record<string, string> = { city: 'City', town: 'Town', village: 'Village', suburb: 'Suburb', neighbourhood: 'Neighbourhood', hamlet: 'Hamlet', island: 'Island', islet: 'Islet', locality: 'Place' }
const ONE: Record<string, string> = { toll: 'Toll', eopyy: 'EOPYY pharmacy', university: 'University', school: 'School', pharmacy: 'Pharmacy', charging: 'EV charging', disabled_parking: 'Disabled parking', fast_food: 'Fast food' }
const kindLabel = (k: string) => ONE[k] ?? PILLS.find(p => p[0] === k)?.[1].replace(/s$/, '') ?? SETTLEMENTS[k] ?? k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
const kindEmoji = (k: string) => PILLS.find(p => p[0] === k)?.[2] ?? (SETTLEMENTS[k] ? '🏘️' : '📍')
const poiTitle = (p: Poi) => p.name || p.nameEn || kindLabel(p.kind)
const NO_STOPS: MapStop[] = []
const letter = (i: number) => String.fromCharCode(65 + i % 26)

/** "350 m", "1.4 km", "12 km" (Maps.kt metresText). */
function metresText(m: number) {
  return m < 950 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`
}
function metres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lng2 - lng1) * Math.PI / 360) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}

export function Emblem({ icon, size = 18 }: { icon: string; size?: number }) {
  const e = EMBLEMS[icon] ?? EMBLEMS.pin
  return <svg width={size} height={size} viewBox={e.vb} fill="currentColor" aria-hidden="true">{e.d.map((d, i) => <path key={i} d={d} />)}</svg>
}

type Card = { kind: 'poi'; poi: Poi } | { kind: 'place'; place: MapPlace } | { kind: 'pin'; lat: number; lng: number }
  | { kind: 'me'; lat: number; lng: number; accuracy: number; device: string }
const ME = 'My location' // the phone's fix as a trip's stop
type Draft = { id?: string; name: string; stops: MapStop[] }
const cardSpot = (c: Card) => c.kind === 'poi' ? c.poi : c.kind === 'place' ? c.place : c

export function MapsPage({ say }: { say: (message: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const tripMarkers = useRef<maplibregl.Marker[]>([])
  const pin = useRef<maplibregl.Marker | null>(null)
  const meMarker = useRef<maplibregl.Marker | null>(null)
  const [asking, setAsking] = useState(false) // waiting for the phone's fix
  const [ready, setReady] = useState(false)
  const [missing, setMissing] = useState(false)
  const [places, setPlaces] = useState<MapPlace[]>([])
  const [lists, setLists] = useState<MapList[]>([])
  const [trips, setTrips] = useState<MapTrip[]>([])
  const [tab, setTab] = useState<'saved' | 'trips'>('saved')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string | null>(null)
  const [allPills, setAllPills] = useState(false)
  const [results, setResults] = useState<Poi[] | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [edit, setEdit] = useState<MapPlace | null>(null)
  const [shown, setShown] = useState<MapTrip | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  // directions for the trip shown or planned (router.js on this computer): each leg's length and time, the roads' line
  const [mode, setMode] = useState<'car' | 'foot' | 'bike'>('car')
  const [legs, setLegs] = useState<{ metres: number; seconds: number }[] | null>(null)
  const [routeLine, setRouteLine] = useState<[number, number][] | null>(null)
  const [routeNote, setRouteNote] = useState('')
  // the latest handlers for the map's own listeners, made once
  const onMapClick = useRef<(e: maplibregl.MapMouseEvent) => void>(() => {})

  const reload = () => Promise.all([window.drive.mapsPlaces(), window.drive.mapsLists(), window.drive.mapsTrips()])
    .then(([p, l, t]) => { setPlaces(p); setLists(l); setTrips(t) }, e => say(errorText(e)))
  useEffect(() => { reload(); return window.drive.onMapsChanged(reload) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.drive.mapsInfo().then(i => setMissing(!i.map)).catch(() => {})
    const m = new maplibregl.Map({ container: box.current!, style: 'media://maps/style/light', center: [23.7, 38.4], zoom: 6.2, maxBounds: GREECE,
      attributionControl: { compact: true } })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    m.on('load', () => {
      m.addSource('results', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      m.addLayer({ id: 'results-dot', type: 'circle', source: 'results', paint: { 'circle-radius': 7, 'circle-color': '#e5484d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      m.addLayer({ id: 'results-label', type: 'symbol', source: 'results', minzoom: 12,
        layout: { 'text-field': ['get', 'title'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#b3262b', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } })
      m.addSource('trip', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      m.addLayer({ id: 'trip-line', type: 'line', source: 'trip', filter: ['==', ['get', 'roads'], false], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': MAPS_COLOR, 'line-width': 4, 'line-dasharray': [1.5, 1.5] } })
      m.addLayer({ id: 'trip-route', type: 'line', source: 'trip', filter: ['==', ['get', 'roads'], true], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': MAPS_COLOR, 'line-width': 6, 'line-opacity': 0.85 } }, 'results-dot')
      m.on('mouseenter', 'results-dot', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'results-dot', () => { m.getCanvas().style.cursor = '' })
      setReady(true)
    })
    m.on('click', e => onMapClick.current(e))
    return () => m.remove()
  }, [])

  // ---- what the map shows ----

  // saved places: Maps' indigo circle with their emblem (the phone: "my personal keep our style")
  useEffect(() => {
    const m = map.current
    if (!m) return
    markers.current.forEach(k => k.remove())
    markers.current = places.map(p => {
      const el = document.createElement('button')
      el.className = 'map-place'
      el.title = p.name
      el.innerHTML = emblemSvg(p.icon)
      el.addEventListener('click', ev => { ev.stopPropagation(); open({ kind: 'place', place: p }) })
      return new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(m)
    })
  }, [places]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const src = map.current?.getSource('results') as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: (results ?? []).map((p, i) => ({ type: 'Feature', properties: { i, title: poiTitle(p) }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })) })
  }, [results, ready])

  // a trip shown or being planned: its stops lettered, joined in order (straight: the turns are the phone's to find)
  const tripStops = draft?.stops ?? shown?.stops ?? NO_STOPS
  useEffect(() => {
    const m = map.current
    if (!m) return
    tripMarkers.current.forEach(k => k.remove())
    tripMarkers.current = tripStops.map((s, i) => {
      const el = document.createElement('div')
      el.className = 'map-stop'
      el.textContent = letter(i)
      el.title = s.name
      return new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(m)
    })
    const src = m.getSource('trip') as maplibregl.GeoJSONSource | undefined
    // the roads when this computer can route, else straight lines from stop to stop
    const line = routeLine ?? (tripStops.length > 1 ? tripStops.map(s => [s.lng, s.lat] as [number, number]) : null)
    src?.setData({ type: 'FeatureCollection', features: line ? [{ type: 'Feature', properties: { roads: !!routeLine }, geometry: { type: 'LineString', coordinates: line } }] : [] })
  }, [tripStops, routeLine, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLegs(null); setRouteLine(null); setRouteNote('')
    if (tripStops.length < 2) return
    let live = true
    setRouteNote('Finding the roads…')
    Promise.all(tripStops.slice(1).map((s, i) => window.drive.mapsRoute([tripStops[i], s], mode)))
      .then(rs => { if (!live) return; setLegs(rs.map(r => ({ metres: r.metres, seconds: r.seconds }))); setRouteLine(rs.flatMap(r => r.line)); setRouteNote('') },
        e => { if (live) setRouteNote(errorText(e)) })
    return () => { live = false }
  }, [tripStops, mode])

  // ---- cards ----

  function open(c: Card, fly = true) {
    setCard(c); setEdit(null); setAddress(null)
    const s = cardSpot(c)
    if (fly) map.current?.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.current.getZoom(), 15) })
    pin.current?.remove(); pin.current = null
    if (c.kind === 'pin') pin.current = new maplibregl.Marker({ color: '#e5484d' }).setLngLat([c.lng, c.lat]).addTo(map.current!)
    window.drive.mapsDescribe(s.lat, s.lng).then(setAddress, () => {})
  }
  /** Where I am: this computer has no GPS, so the paired phone is asked for one fix (sync.js phoneLocation). */
  async function whereAmI() {
    if (asking) return null
    setAsking(true)
    const r = await window.drive.mapsPhoneLocation().catch(e => ({ error: errorText(e) }))
    setAsking(false)
    if (r.error !== undefined) { say(r.error); return null }
    const el = document.createElement('div')
    el.className = 'map-me'
    el.title = `${ME} (${r.device})`
    meMarker.current?.remove()
    meMarker.current = new maplibregl.Marker({ element: el }).setLngLat([r.lng, r.lat]).addTo(map.current!)
    return { kind: 'me' as const, lat: r.lat, lng: r.lng, accuracy: r.accuracy, device: r.device }
  }
  async function showMe() { const me = await whereAmI(); if (me) open(me) }
  async function startHere() { const me = await whereAmI(); if (me) addStop(me) }
  function closeCard() { setCard(null); setEdit(null); pin.current?.remove(); pin.current = null }

  onMapClick.current = async e => {
    const m = map.current!
    const hit = m.queryRenderedFeatures(e.point, { layers: ['results-dot'] })[0]
    if (hit && results) { open({ kind: 'poi', poi: results[hit.properties.i as number] }, false); return }
    // a place of the map's own (its name drawn on the map): its page from the search list
    const own = m.queryRenderedFeatures(e.point).find(f => f.layer.id === 'pois' && f.properties?.name)
    if (own) {
      const [lng, lat] = (own.geometry as { coordinates: number[] }).coordinates
      const found = await window.drive.mapsNear(lat, lng, String(own.properties.name)).catch(() => null)
      if (found) { open({ kind: 'poi', poi: found }, false); return }
    }
    open({ kind: 'pin', lat: e.lngLat.lat, lng: e.lngLat.lng }, false)
  }

  // ---- search ----

  const centre = () => { const c = map.current?.getCenter(); return { lat: c?.lat ?? 38.4, lng: c?.lng ?? 23.7 } }

  /** OK (Enter, or a pill): what is on the screen and half a screen round it stays on the map; none there: the nearest 20. */
  async function searchHere(q = query, k = kind) {
    if (!q.trim() && !k) { setResults(null); return }
    const m = map.current!, b = m.getBounds(), h = (b.getNorth() - b.getSouth()) / 2, w = (b.getEast() - b.getWest()) / 2
    try {
      let found = await window.drive.mapsSearch({ query: q, kind: k, ...centre(), limit: 300, within: { south: b.getSouth() - h, north: b.getNorth() + h, west: b.getWest() - w, east: b.getEast() + w } })
      if (!found.length) {
        found = await window.drive.mapsSearch({ query: q, kind: k, ...centre(), limit: 20 })
        if (found.length) {
          const bounds = new maplibregl.LngLatBounds()
          found.forEach(p => bounds.extend([p.lng, p.lat]))
          m.fitBounds(bounds, { padding: 80, maxZoom: 15 })
        }
      }
      setResults(found)
      if (!found.length) say('Nothing found.')
    } catch (e) { say(errorText(e)) }
  }
  // as you type: the nearest names first
  useEffect(() => {
    if (!query.trim()) { if (!kind) setResults(null); return }
    let live = true
    const t = setTimeout(() => window.drive.mapsSearch({ query, kind, ...centre(), limit: 60 }).then(r => { if (live) setResults(r) }, () => {}), 200)
    return () => { live = false; clearTimeout(t) }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  function pill(k: string) {
    const next = kind === k ? null : k
    setKind(next)
    if (next) searchHere(query, next); else if (!query.trim()) setResults(null)
  }
  async function nearby(lat: number, lng: number) {
    setQuery(''); setKind(null)
    setResults(await window.drive.mapsSearch({ query: '', kind: null, lat, lng, limit: 60, nearby: true }).catch(() => []))
  }
  function clearSearch() { setQuery(''); setKind(null); setResults(null) }

  // ---- saving ----

  async function savePlace(p: MapPlace) {
    try {
      const saved = await window.drive.mapsSavePlace(p)
      say(`Saved: ${saved.name}`)
      setEdit(null)
      await reload()
      open({ kind: 'place', place: saved }, false)
    } catch (e) { say(errorText(e)) }
  }
  async function deletePlace(p: MapPlace) {
    try { await window.drive.mapsDeletePlace(p.id); say(`${p.name} is in Files' Trash.`); closeCard(); reload() } catch (e) { say(errorText(e)) }
  }
  function startSave(c: Card) {
    if (c.kind === 'place') { setEdit(c.place); return }
    const s = cardSpot(c)
    const name = c.kind === 'poi' ? poiTitle(c.poi) : address?.split(',')[0] || 'Place'
    const icon = c.kind === 'poi' ? (PILLS.find(p => p[0] === c.poi.kind) ? emblemOf(c.poi.kind) : 'pin') : 'pin'
    setEdit({ id: '', name, lat: s.lat, lng: s.lng, icon, slot: 0, mode: 'car', lists: [], label: '' })
  }

  // ---- trips ----

  function addStop(c: Card) {
    const s = cardSpot(c)
    const name = c.kind === 'me' ? ME : c.kind === 'poi' ? poiTitle(c.poi) : c.kind === 'place' ? c.place.name : address?.split(',')[0] || `Stop ${letter(draft?.stops.length ?? 0)}`
    // where I am is where the trip starts: A, in place of an older fix
    const stops = c.kind === 'me' ? [{ name, lat: s.lat, lng: s.lng }, ...(draft?.stops ?? []).filter(x => x.name !== ME)] : [...(draft?.stops ?? []), { name, lat: s.lat, lng: s.lng }]
    setDraft({ name: draft?.name ?? '', id: draft?.id, stops })
    setShown(null); setTab('trips'); closeCard()
    if (stops.length > 1) fitStops(stops)
  }
  async function saveDraft() {
    if (!draft || !draft.stops.length) return
    const name = draft.name.trim() || draft.stops.map(s => s.name).join(' → ')
    try {
      const t = await window.drive.mapsSaveTrip({ id: draft.id, name, stops: draft.stops })
      say(`Trip saved: ${t.name}. It is on the phone at the next sync.`)
      setDraft(null); setShown(t); reload()
    } catch (e) { say(errorText(e)) }
  }
  function fitStops(stops: MapStop[]) {
    const bounds = new maplibregl.LngLatBounds()
    stops.forEach(s => bounds.extend([s.lng, s.lat]))
    map.current?.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 460, right: 80 }, maxZoom: 15 })
  }
  function showTrip(t: MapTrip) { setShown(t); setDraft(null); fitStops(t.stops) }
  async function deleteTrip(t: MapTrip) {
    try { await window.drive.mapsDeleteTrip(t.id); say(`${t.name} is in Files' Trash.`); setShown(null); reload() } catch (e) { say(errorText(e)) }
  }
  const moveStop = (i: number, by: number) => setDraft(d => {
    if (!d || i + by < 0 || i + by >= d.stops.length) return d
    const stops = [...d.stops];[stops[i], stops[i + by]] = [stops[i + by], stops[i]]
    return { ...d, stops }
  })

  // ---- the panel ----

  const here = centre()
  const slots = Array.from({ length: 12 }, (_, i) => places.find(p => p.slot === i + 1) ?? null)
  const listed = new Set(places.flatMap(p => p.lists.filter(l => lists.some(x => x.id === l)).length ? [p.id] : []))

  return (
    <div className="maps-page">
      <div ref={box} className="maps-canvas" />
      <button className="round maps-here" title="Where I am (asks the phone)" disabled={asking} onClick={showMe}><Icon name="myLocation" size={22} /></button>
      {asking && <div className="island maps-waiting">Waiting for the phone's location…<small>Tetra in the background there? Tap its notification.</small></div>}
      {missing && <div className="island maps-missing">The map is not on this computer yet: <code>Files/Maps/greece.pmtiles</code> comes from <code>tools/maps-greece.sh</code> or from the phone by sync.</div>}
      <aside className="island maps-panel">
        <div className="maps-search">
          <Icon name="search" size={20} />
          <input className="maps-query" placeholder="Search places, addresses, towns" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') searchHere(); if (e.key === 'Escape') clearSearch() }} />
          {(query || kind || results) && <button className="round flat" title="Clear" onClick={clearSearch}><Icon name="close" size={18} /></button>}
        </div>
        <div className="chips wrap maps-pills">
          {PILLS.filter(([k], i) => allPills || i < 8 || k === kind).map(([k, label, emoji]) => <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => pill(k)}>{emoji} {label}</button>)}
          <button className="chip" onClick={() => setAllPills(a => !a)}>{allPills ? 'Fewer' : `More… (${PILLS.length - 8})`}</button>
        </div>

        {edit ? <PlaceForm place={edit} lists={lists} onCancel={() => setEdit(null)} onSave={savePlace} onListsChanged={reload} say={say} />
          : card ? <PlaceCard card={card} address={address} places={places} draft={draft}
              onClose={closeCard} onSave={() => startSave(card)} onDelete={deletePlace} onStop={() => addStop(card)}
              onNearby={() => { const s = cardSpot(card); nearby(s.lat, s.lng); setCard(null) }} />
          : results ? (
            <section className="maps-results">
              <h3>{kind ? `${kindEmoji(kind)} ${PILLS.find(p => p[0] === kind)?.[1]}` : 'Results'} · {results.length}</h3>
              {results.map((p, i) => (
                <button key={i} className="maps-row" onClick={() => open({ kind: 'poi', poi: p })}>
                  <span className="maps-row-icon">{kindEmoji(p.kind)}</span>
                  <span className="maps-row-text"><b>{poiTitle(p)}</b><small>{kindLabel(p.kind)}{p.more ? ` · ${p.more}` : ''}</small></span>
                  <small>{metresText(metres(here.lat, here.lng, p.lat, p.lng))}</small>
                </button>
              ))}
            </section>)
          : <>
            <div className="segmented maps-tabs">
              <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>Saved</button>
              <button className={tab === 'trips' ? 'on' : ''} onClick={() => setTab('trips')}>Trips</button>
            </div>
            {tab === 'saved' ? (
              <section>
                <h3>Home</h3>
                <div className="maps-slots">
                  {slots.map((p, i) => p
                    ? <button key={i} className="maps-slot" title={p.name} onClick={() => open({ kind: 'place', place: p })}><span className="map-place static"><Emblem icon={p.icon} /></span><span>{p.label || p.name}</span></button>
                    : <div key={i} className="maps-slot empty">{i + 1}</div>)}
                </div>
                {lists.map(l => {
                  const inList = places.filter(p => p.lists.includes(l.id))
                  return inList.length ? <div key={l.id}><h3>{l.emoji} {l.name} · {inList.length}</h3>{inList.map(p => <PlaceRow key={p.id} p={p} onOpen={() => open({ kind: 'place', place: p })} />)}</div> : null
                })}
                {places.some(p => !listed.has(p.id)) && <><h3>Other places</h3>{places.filter(p => !listed.has(p.id)).map(p => <PlaceRow key={p.id} p={p} onOpen={() => open({ kind: 'place', place: p })} />)}</>}
                {!places.length && <p className="hint">Click anywhere on the map, or search, then Save. Places saved on the phone show here too.</p>}
              </section>
            ) : (
              <section>
                {draft ? <>
                  <h3>Plan a trip</h3>
                  <input className="field" placeholder="Name (A → B when empty)" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
                  {draft.stops.map((s, i) => (
                    <div key={i} className="maps-row static">
                      <span className="map-stop static">{letter(i)}</span>
                      <span className="maps-row-text"><b>{s.name}</b></span>
                      <button className="round flat" title="Earlier" disabled={!i} onClick={() => moveStop(i, -1)}><Icon name="arrowUp" size={18} /></button>
                      <button className="round flat" title="Remove" onClick={() => setDraft({ ...draft, stops: draft.stops.filter((_, j) => j !== i) })}><Icon name="close" size={18} /></button>
                    </div>
                  ))}
                  {draft.stops[0]?.name !== ME && <button className="text-button" disabled={asking} onClick={startHere}><Icon name="myLocation" size={18} /> Start from where I am</button>}
                  <RouteSummary stops={draft.stops} legs={legs} note={routeNote} mode={mode} setMode={setMode} />
                  <p className="hint">Add stop {letter(draft.stops.length)}: click the map, a search result or a saved place, then <b>Add as stop</b>.</p>
                  <div className="maps-actions">
                    <button className="filled-button" disabled={!draft.stops.length} onClick={saveDraft}>Save trip</button>
                    <button className="text-button" onClick={() => setDraft(null)}>Cancel</button>
                  </div>
                </> : <>
                  <button className="filled-button big" onClick={() => { setDraft({ name: '', stops: [] }); setShown(null) }}><Icon name="add" size={20} /> Plan a trip</button>
                  <p className="hint">A trip saved here is on the phone at the next sync: Directions › its name, and each next stop starts by itself.</p>
                  {shown && <RouteSummary stops={shown.stops} legs={legs} note={routeNote} mode={mode} setMode={setMode} />}
                  {trips.map(t => (
                    <div key={t.id} className={`maps-row ${shown?.id === t.id ? 'on' : ''}`} onClick={() => showTrip(t)}>
                      <span className="maps-row-icon">🧭</span>
                      <span className="maps-row-text"><b>{t.name}</b><small>{t.stops.map((s, i) => `${letter(i)} ${s.name}`).join(' · ')}</small></span>
                      <button className="round flat" title="Change" onClick={e => { e.stopPropagation(); setDraft({ id: t.id, name: t.name, stops: t.stops }); setShown(null) }}><Icon name="edit" size={18} /></button>
                      <button className="round flat" title="Delete" onClick={e => { e.stopPropagation(); deleteTrip(t) }}><Icon name="trash" size={18} /></button>
                    </div>
                  ))}
                </>}
              </section>
            )}
          </>}
      </aside>
    </div>
  )
}

const emblemOf = (k: string) => ({ restaurant: 'food', cafe: 'cafe', supermarket: 'shop', pharmacy: 'pharmacy', eopyy: 'pharmacy', fuel: 'fuel', charging: 'fuel',
  disabled_parking: 'accessible', parking: 'parking', hospital: 'hospital', bakery: 'food', fast_food: 'food', hotel: 'hotel', beach: 'beach', museum: 'star',
  kindergarten: 'school', primary_school: 'school', secondary_school: 'school', school: 'school', university: 'school' } as Record<string, string>)[k] ?? 'pin'

function emblemSvg(icon: string) {
  const e = EMBLEMS[icon] ?? EMBLEMS.pin
  return `<svg width="16" height="16" viewBox="${e.vb}" fill="currentColor" aria-hidden="true">${e.d.map(d => `<path d="${d}"/>`).join('')}</svg>`
}

/** "1 h 25 min", "12 min" (the phone's way). */
function minutesText(seconds: number) {
  const m = Math.max(1, Math.round(seconds / 60)), h = Math.floor(m / 60)
  return h ? `${h} h ${m % 60} min` : `${m} min`
}

/** The trip's legs by road: A → B, each with its length and time, then the whole; Car / Walk / Bike as the phone's directions. */
function RouteSummary({ stops, legs, note, mode, setMode }: {
  stops: MapStop[]; legs: { metres: number; seconds: number }[] | null; note: string; mode: 'car' | 'foot' | 'bike'; setMode: (m: 'car' | 'foot' | 'bike') => void
}) {
  if (stops.length < 2) return null
  return (
    <div className="maps-route">
      <div className="segmented small">{(['car', 'foot', 'bike'] as const).map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'car' ? 'Car' : m === 'foot' ? 'Walk' : 'Bike'}</button>)}</div>
      {legs ? <>
        {legs.map((l, i) => <div key={i} className="maps-leg"><span>{letter(i)} → {letter(i + 1)}</span><span>{metresText(l.metres)} · {minutesText(l.seconds)}</span></div>)}
        {legs.length > 1 && <div className="maps-leg total"><span>All of it</span><span>{metresText(legs.reduce((a, l) => a + l.metres, 0))} · {minutesText(legs.reduce((a, l) => a + l.seconds, 0))}</span></div>}
      </> : <p className="hint">{note}</p>}
    </div>
  )
}

function PlaceRow({ p, onOpen }: { p: MapPlace; onOpen: () => void }) {
  return <button className="maps-row" onClick={onOpen}><span className="map-place static"><Emblem icon={p.icon} /></span><span className="maps-row-text"><b>{p.name}</b></span></button>
}

function PlaceCard({ card, address, places, draft, onClose, onSave, onDelete, onStop, onNearby }: {
  card: Card; address: string | null; places: MapPlace[]; draft: Draft | null
  onClose: () => void; onSave: () => void; onDelete: (p: MapPlace) => void; onStop: () => void; onNearby: () => void
}) {
  const s = cardSpot(card)
  const poi = card.kind === 'poi' ? card.poi : null
  const saved = card.kind === 'place' ? card.place : places.find(p => Math.abs(p.lat - s.lat) < 1e-5 && Math.abs(p.lng - s.lng) < 1e-5) ?? null
  const me = card.kind === 'me' ? card : null
  const title = me ? ME : saved?.name ?? (poi ? poiTitle(poi) : address?.split(',')[0] ?? 'Dropped pin')
  const google = poi && poi.name ? `${poi.name}, ${poi.more || `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`}` : `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`
  return (
    <section className="maps-card">
      <div className="maps-card-head">
        {me ? <span className="maps-row-icon big"><span className="map-me" /></span> : saved ? <span className="map-place static big"><Emblem icon={saved.icon} size={22} /></span> : <span className="maps-row-icon big">{poi ? kindEmoji(poi.kind) : '📍'}</span>}
        <div><h2>{title}</h2><small>{me ? `From ${me.device} · ±${metresText(me.accuracy)}` : poi ? kindLabel(poi.kind) : saved ? 'Saved place' : 'A spot on the map'}</small></div>
        <button className="round flat" title="Close" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      <dl>
        {address && <><dt>Address</dt><dd>{address}</dd></>}
        {poi?.more && <><dt>Where</dt><dd>{poi.more}</dd></>}
        {poi?.hours && <><dt>Hours</dt><dd>{poi.hours}</dd></>}
        {poi?.phone && <><dt>Phone</dt><dd>{poi.phone}</dd></>}
        {poi?.web && <><dt>Website</dt><dd><button className="link-button" onClick={() => window.drive.mapsWeb(/^https?:/i.test(poi.web) ? poi.web : `https://${poi.web}`)}>{poi.web.replace(/^https?:\/\//i, '')}</button></dd></>}
        {poi?.wheelchair && <><dt>Wheelchair</dt><dd>{poi.wheelchair === 'yes' ? '♿ Yes' : poi.wheelchair === 'limited' ? '♿ Limited' : poi.wheelchair === 'no' ? 'No' : poi.wheelchair}</dd></>}
        {poi?.note && <><dt>Note</dt><dd>{poi.note}</dd></>}
        <dt>Coordinates</dt><dd className="mono">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</dd>
      </dl>
      <div className="maps-actions">
        <button className="filled-button" onClick={onStop}>{me ? 'Start a trip here (A)' : draft ? `Add as stop ${letter(draft.stops.length)}` : 'Add to a trip'}</button>
        <button className="text-button" onClick={onSave}><Icon name={saved ? 'edit' : 'add'} size={18} /> {saved ? 'Change' : 'Save'}</button>
        <button className="text-button" onClick={onNearby}><Icon name="place" size={18} /> Nearby</button>
        <button className="text-button" onClick={() => window.drive.mapsGoogle(google)}><Icon name="external" size={18} /> Google Maps</button>
        {saved && card.kind === 'place' && <button className="text-button danger" onClick={() => onDelete(saved)}><Icon name="trash" size={18} /> Delete</button>}
      </div>
    </section>
  )
}

/** Save or change a place: its name, emblem (the phone's tabs), Home slot, how Home's one tap goes, its lists. */
function PlaceForm({ place, lists, onCancel, onSave, onListsChanged, say }: {
  place: MapPlace; lists: MapList[]; onCancel: () => void; onSave: (p: MapPlace) => void; onListsChanged: () => void; say: (m: string) => void
}) {
  const [p, setP] = useState(place)
  const [cat, setCat] = useState(CATEGORIES.find(([, icons]) => icons.includes(place.icon))?.[0] ?? 'General')
  const [newList, setNewList] = useState('')
  async function addList() {
    const m = /^(\p{Extended_Pictographic}️?)\s*(.*)$/u.exec(newList.trim())
    const name = (m ? m[2] : newList).trim()
    if (!name) return
    try {
      const l = await window.drive.mapsSaveList({ name, emoji: m ? m[1] : '📍' })
      setP(x => ({ ...x, lists: [...x.lists, l.id] })); setNewList(''); onListsChanged()
    } catch (e) { say(errorText(e)) }
  }
  return (
    <section className="maps-card">
      <h2>{place.id ? 'Change the place' : 'Save this place'}</h2>
      <label className="editor-label">Name</label>
      <input className="field" value={p.name} onChange={e => setP({ ...p, name: e.target.value })} />
      <label className="editor-label">On Home's card as (optional)</label>
      <input className="field" value={p.label} placeholder={p.name} onChange={e => setP({ ...p, label: e.target.value })} />
      <label className="editor-label">Emblem</label>
      <div className="chips wrap">{CATEGORIES.map(([c]) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div>
      <div className="maps-emblems">
        {CATEGORIES.find(([c]) => c === cat)![1].map(icon => (
          <button key={icon} className={`map-place static big ${p.icon === icon ? 'on' : ''}`} title={icon} onClick={() => setP({ ...p, icon })}><Emblem icon={icon} size={22} /></button>
        ))}
      </div>
      <label className="editor-label">Home slot</label>
      <div className="maps-slot-pick">
        <button className={`chip ${!p.slot ? 'on' : ''}`} onClick={() => setP({ ...p, slot: 0 })}>None</button>
        {Array.from({ length: 12 }, (_, i) => <button key={i} className={`chip ${p.slot === i + 1 ? 'on' : ''}`} onClick={() => setP({ ...p, slot: i + 1 })}>{i + 1}</button>)}
      </div>
      <label className="editor-label">Home's one tap goes by</label>
      <div className="segmented small">{(['car', 'foot', 'bike'] as const).map(m => <button key={m} className={p.mode === m ? 'on' : ''} onClick={() => setP({ ...p, mode: m })}>{m === 'car' ? 'Car' : m === 'foot' ? 'Walk' : 'Bike'}</button>)}</div>
      <label className="editor-label">Lists</label>
      <div className="chips wrap">
        {lists.map(l => <button key={l.id} className={`chip ${p.lists.includes(l.id) ? 'on' : ''}`}
          onClick={() => setP({ ...p, lists: p.lists.includes(l.id) ? p.lists.filter(x => x !== l.id) : [...p.lists, l.id] })}>{l.emoji} {l.name}</button>)}
        <input className="chip-input" placeholder="+ New list" value={newList} onChange={e => setNewList(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addList() }} />
      </div>
      <div className="maps-actions">
        <button className="filled-button" disabled={!p.name.trim()} onClick={() => onSave({ ...p, name: p.name.trim() })}>Save</button>
        <button className="text-button" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}
