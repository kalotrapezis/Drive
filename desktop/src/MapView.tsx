import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// The page loads from file://, where MapLibre cannot find its worker by itself: ship it as a bundled asset.
maplibregl.setWorkerUrl(workerUrl)
import type { Media } from './timeline'
import { Icon } from './Icon'

// OpenFreeMap, as on the phone. Tiles need internet; coordinates and place names stay local.
const STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** `group` is the indices the viewer may page through: a group's photos, not every located photo. */
export function MapView({ items, focus, onOpen, onBack }: { items: Media[]; focus?: string; onOpen: (index: number, group?: number[]) => void; onBack: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  // A group opens as a panel from the bottom, a grid of its photos, newest first (asked 2026-09-25).
  const [group, setGroup] = useState<{ indices: number[]; center: [number, number]; zoom: number } | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')

  useEffect(() => {
    const m = new maplibregl.Map({ container: box.current!, style: STYLE, attributionControl: { compact: true }, center: [22.9, 40.6], zoom: 3 })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    const timer = setTimeout(() => setState(s => s === 'loading' ? 'offline' : s), 12000)
    m.on('error', () => setState(s => s === 'loading' ? 'offline' : s))
    m.on('load', () => {
      clearTimeout(timer)
      setState('ready')
      m.addSource('photos', {
        type: 'geojson', cluster: true, clusterRadius: 60, clusterMaxZoom: 17,
        clusterProperties: { newest: ['min', ['get', 'i']] }, // items are newest first, so the smallest index is the newest photo
        data: { type: 'FeatureCollection', features: items.map((it, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [it.longitude!, it.latitude!] } })) },
      })
      // Red pins drawn by the map itself: photo thumbnails as DOM markers were rebuilt after every move and made
      // panning unusable (2026-09-25). A cluster is a bigger pin with its count; clicking splits it.
      const RED = '#e5484d'
      m.addLayer({ id: 'clusters', type: 'circle', source: 'photos', filter: ['has', 'point_count'], paint: {
        'circle-color': RED, 'circle-stroke-color': '#7a1d20', 'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 100, 23, 1000, 28] } })
      m.addLayer({ id: 'cluster-count', type: 'symbol', source: 'photos', filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': '#fff' } })
      m.addLayer({ id: 'pins', type: 'circle', source: 'photos', filter: ['!', ['has', 'point_count']], paint: {
        'circle-color': RED, 'circle-radius': 7, 'circle-stroke-color': '#7a1d20', 'circle-stroke-width': 2 } })
      m.on('click', 'clusters', async e => {
        const f = e.features![0], p = f.properties as { cluster_id: number; point_count: number }
        const source = m.getSource('photos') as maplibregl.GeoJSONSource
        const [zoom, leaves] = await Promise.all([source.getClusterExpansionZoom(p.cluster_id), source.getClusterLeaves(p.cluster_id, p.point_count, 0)])
        setSelected(null)
        setGroup({ indices: leaves.map(l => (l.properties as { i: number }).i).sort((a, b) => a - b), zoom,
          center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates })
      })
      m.on('click', 'pins', e => { setGroup(null); setSelected((e.features![0].properties as { i: number }).i) })
      for (const layer of ['clusters', 'pins']) {
        m.on('mouseenter', layer, () => { m.getCanvas().style.cursor = 'pointer' })
        m.on('mouseleave', layer, () => { m.getCanvas().style.cursor = '' })
      }
      m.resize() // the container may have been laid out after the map measured it
      const focused = focus ? items.findIndex(it => it.sha256 === focus) : -1
      if (focused >= 0) { m.jumpTo({ center: [items[focused].longitude!, items[focused].latitude!], zoom: 14 }); setSelected(focused) }
      else if (items.length) {
        const bounds = new maplibregl.LngLatBounds()
        for (const it of items) bounds.extend([it.longitude!, it.latitude!])
        m.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 })
      }
    })
    return () => { clearTimeout(timer); m.remove() }
  }, [items, focus])

  const it = selected !== null ? items[selected] : null
  const places = group && [...new Set(group.indices.map(i => items[i].place).filter(Boolean))]
  return (
    <div className="map-page">
      <div ref={box} className="map" />
      <header className="map-bar">
        <div className="island title-island"><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>Map</h1><span className="pill">{items.length} located</span></div>
      </header>
      {state === 'loading' && <div className="island map-note"><span className="spinner" /> Loading the map…</div>}
      {state === 'offline' && <div className="island map-note">The map background needs internet. Locations are still in each photo’s Details.</div>}
      {items.length === 0 && state === 'ready' && <div className="island map-note">No photos with a location yet.</div>}
      {group && (
        <div className="island map-sheet">
          <header>
            <strong>{group.indices.length.toLocaleString()} photos</strong>
            {places && places.length > 0 && <small>{places.slice(0, 3).join(' · ')}{places.length > 3 ? ` · +${places.length - 3}` : ''}</small>}
            <button className="text-button" onClick={() => { map.current?.easeTo({ center: group.center, zoom: group.zoom }); setGroup(null) }}>
              <Icon name="zoomIn" size={18} /> Zoom in</button>
            <button className="round flat" title="Close" onClick={() => setGroup(null)}><Icon name="close" /></button>
          </header>
          <div className="map-sheet-grid">
            {group.indices.map(i => (
              <button key={i} title={items[i].place || items[i].path} onClick={() => onOpen(i, group.indices)}>
                <img src={`media://thumb/${items[i].sha256}`} loading="lazy" alt="" />
              </button>
            ))}
          </div>
        </div>
      )}
      {it && (
        <div className="island map-card">
          <img src={`media://thumb/${it.sha256}`} alt="" onClick={() => onOpen(selected!)} />
          <div>
            <strong>{it.place || it.path.split('/').pop()}</strong>
            <small>{when.format(it.taken_at)} · {it.latitude!.toFixed(5)}, {it.longitude!.toFixed(5)}</small>
            <div className="map-card-actions">
              <button className="filled-button" onClick={() => onOpen(selected!)}>Open</button>
              <button className="text-button" onClick={() => window.drive.openMap(it.latitude!, it.longitude!)}><Icon name="external" size={18} /> OpenStreetMap</button>
            </div>
          </div>
          <button className="round flat" title="Close" onClick={() => setSelected(null)}><Icon name="close" /></button>
        </div>
      )}
    </div>
  )
}
