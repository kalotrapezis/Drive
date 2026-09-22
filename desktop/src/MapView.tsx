import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// The page loads from file://, where MapLibre cannot find its worker by itself: ship it as a bundled asset.
maplibregl.setWorkerUrl(workerUrl)
import type { Media } from './timeline'
import { Icon } from './Icon'

// Same style as the phone (OpenFreeMap). Tiles need internet; coordinates and place names stay local.
const STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function MapView({ items, focus, onOpen, onBack }: { items: Media[]; focus?: string; onOpen: (index: number) => void; onBack: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
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
      // An invisible layer keeps the source's tiles loaded; what you see are the photo markers below.
      m.addLayer({ id: 'photos-hit', type: 'circle', source: 'photos', paint: { 'circle-radius': 1, 'circle-opacity': 0 } })

      // Photo thumbnails as markers: a cluster shows its newest photo and a count; zooming in splits it.
      const markers = new Map<string, maplibregl.Marker>()
      const update = () => {
        const seen = new Set<string>()
        // Only what is drawn now (not tiles still cached from the previous zoom), deduplicated across tile edges.
        for (const f of m.queryRenderedFeatures({ layers: ['photos-hit'] })) {
          const p = f.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; newest?: number; i?: number }
          const key = p.cluster ? `c${p.cluster_id}` : `p${p.i}`
          if (seen.has(key)) continue // features repeat across tiles
          seen.add(key)
          if (markers.has(key)) continue
          const index = p.cluster ? p.newest! : p.i!
          const el = document.createElement('button')
          el.className = 'map-thumb'
          el.title = items[index].place || items[index].path
          el.innerHTML = `<img src="media://thumb/${items[index].sha256}" alt="">${p.cluster ? `<span>${p.point_count}</span>` : ''}`
          const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
          el.addEventListener('click', async e => {
            e.stopPropagation()
            if (!p.cluster) return setSelected(index)
            const zoom = await (m.getSource('photos') as maplibregl.GeoJSONSource).getClusterExpansionZoom(p.cluster_id!)
            m.easeTo({ center: coords, zoom })
          })
          markers.set(key, new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(m))
        }
        for (const [key, marker] of markers) if (!seen.has(key)) { marker.remove(); markers.delete(key) }
      }
      m.on('idle', update) // after every move/zoom once tiles and fades are done
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
  return (
    <div className="map-page">
      <div ref={box} className="map" />
      <header className="map-bar">
        <div className="island title-island"><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>Map</h1><span className="pill">{items.length} located</span></div>
      </header>
      {state === 'loading' && <div className="island map-note"><span className="spinner" /> Loading the map…</div>}
      {state === 'offline' && <div className="island map-note">The map background needs internet. Locations are still in each photo’s Details.</div>}
      {items.length === 0 && state === 'ready' && <div className="island map-note">No photos with a location yet.</div>}
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
