import { useEffect, useRef, useState } from 'react'
import { formatBytes, type Media } from './timeline'
import { Icon } from './Icon'

const MAX_ZOOM = 5
const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })

interface View { scale: number; x: number; y: number }
const RESET: View = { scale: 1, x: 0, y: 0 }

interface Props {
  media: Media[]; index: number; setIndex: (i: number) => void; onClose: () => void
  onFavorite?: (m: Media) => void; onTrash?: (m: Media) => void; onHide?: (m: Media) => void; onRestore?: (m: Media) => void
  onCollect?: (m: Media) => void; onUncollect?: (m: Media) => void
  people: string[]
  onShowOnMap?: (m: Media) => void
  fileUrl?: (m: Media) => string
  thumbUrl?: (m: Media) => string
}

export function Viewer({ media, index, setIndex, onClose, onFavorite, onTrash, onCollect, onUncollect, people, onShowOnMap, onHide, onRestore,
  fileUrl = m => `media://file/${m.id}`, thumbUrl = m => `media://thumb/${m.sha256}` }: Props) {
  const item = media[index]
  const [view, setView] = useState<View>(RESET)
  const [details, setDetails] = useState(false)
  const [failed, setFailed] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  const go = (i: number) => { if (i >= 0 && i < media.length) setIndex(i) }
  useEffect(() => { setView(RESET); setFailed(false) }, [index])
  useEffect(() => {
    strip.current?.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [index])

  // Zoom around a point given in stage coordinates relative to its centre.
  function zoomAt(scale: number, px = 0, py = 0) {
    setView(v => {
      const s = Math.min(MAX_ZOOM, Math.max(1, scale))
      if (s === 1) return RESET
      const k = s / v.scale
      return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }
  function centreOffset(e: { clientX: number; clientY: number }) {
    const r = stage.current!.getBoundingClientRect()
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (e.key === 'Escape') view.scale > 1 ? setView(RESET) : onClose() // Esc resets zoom before leaving, like Back on the phone
      else if (e.key === 'ArrowLeft') go(index - 1)
      else if (e.key === 'ArrowRight') go(index + 1)
      else if (e.key === 'i') setDetails(d => !d)
      else if (e.key === '+' || e.key === '=') zoomAt(view.scale * 1.5)
      else if (e.key === '-') zoomAt(view.scale / 1.5)
      else if (e.key === '0') setView(RESET)
      else if (e.key === 'f') onFavorite?.(item)
      else if (e.key === 'Delete') onTrash?.(item)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    const el = stage.current!
    const onWheel = (e: WheelEvent) => {
      if (item.is_video) return
      e.preventDefault()
      const [px, py] = centreOffset(e)
      setView(v => {
        const s = Math.min(MAX_ZOOM, Math.max(1, v.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))))
        if (s === 1) return RESET
        const k = s / v.scale
        return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [item])

  const name = item.path.split('/').pop()!
  const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Photos'

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <button className="round" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
        <div className="island viewer-title"><strong>{name}</strong><span>{when.format(item.taken_at)}</span></div>
        <div className="island viewer-actions">
          {!item.is_video && <>
            <button className="round flat" title="Zoom out (−)" onClick={() => zoomAt(view.scale / 1.5)}><Icon name="zoomOut" /></button>
            <button className="round flat" title="Zoom in (+)" onClick={() => zoomAt(view.scale * 1.5)}><Icon name="zoomIn" /></button>
          </>}
          {onFavorite && <button className="round flat" title={item.favorite ? 'Remove from Favorites (F)' : 'Add to Favorites (F)'} onClick={() => onFavorite(item)}>
            <Icon name={item.favorite ? 'heartFill' : 'heart'} /></button>}
          {onCollect && <button className="round flat" title="Add to collection" onClick={() => onCollect(item)}><Icon name="collect" /></button>}
          {onUncollect && <button className="round flat" title="Remove from this collection" onClick={() => onUncollect(item)}><Icon name="uncollect" /></button>}
          {onHide && <button className="round flat" title="Move to Hidden" onClick={() => onHide(item)}><Icon name="lock" /></button>}
          {onRestore && <button className="round flat" title="Restore to Photos" onClick={() => onRestore(item)}><Icon name="lockOpen" /></button>}
          {onTrash && <button className="round flat" title="Move to Trash (Delete)" onClick={() => onTrash(item)}><Icon name="trash" /></button>}
          {onTrash && <button className="round flat" title="Show in folder" onClick={() => window.drive.show(item.id)}><Icon name="folder" /></button>}
          <button className={`round flat ${details ? 'on' : ''}`} title="Details (i)" onClick={() => setDetails(d => !d)}><Icon name="info" /></button>
        </div>
      </div>

      <div className="viewer-body">
        <div className={`stage ${view.scale > 1 ? 'zoomed' : ''}`} ref={stage}
          onDoubleClick={e => { if (!item.is_video) view.scale > 1 ? setView(RESET) : zoomAt(2, ...centreOffset(e)) }}
          onPointerDown={e => { if (view.scale > 1) { drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }; (e.target as Element).setPointerCapture(e.pointerId) } }}
          onPointerMove={e => { if (drag.current) { const d = drag.current; setView(v => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y })) } }}
          onPointerUp={() => { drag.current = null }}>
          {item.is_video
            ? <video key={item.id} src={fileUrl(item)} controls autoPlay />
            : <img key={item.id} draggable={false} alt={name}
                src={failed ? thumbUrl(item) : fileUrl(item)}
                onError={() => setFailed(true)} // formats Chromium cannot draw (HEIC) fall back to the thumbnail
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />}
          {index > 0 && <button className="round nav prev" title="Previous (←)" onClick={() => go(index - 1)}><Icon name="back" /></button>}
          {index < media.length - 1 && <button className="round nav next" title="Next (→)" onClick={() => go(index + 1)}><Icon name="forward" /></button>}
        </div>
        {details && (
          <aside className="island details">
            <h3>Details</h3>
            <dl>
              <dt>Date</dt><dd>{when.format(item.taken_at)}</dd>
              <dt>Name</dt><dd>{name}</dd>
              <dt>Folder</dt><dd>{folder}</dd>
              <dt>Size</dt><dd>{formatBytes(item.size)}{item.width ? ` · ${item.width} × ${item.height}` : ''}</dd>
              {people.length > 0 && <><dt>People</dt><dd>{people.join(', ')}</dd></>}
              {item.camera && <><dt>Camera</dt><dd>{item.camera}</dd></>}
              {item.latitude != null && <><dt>Location</dt>
                <dd><Icon name="place" size={16} /> {item.place || 'Not named'}</dd>
                <dd className="mono">{item.latitude.toFixed(5)}, {item.longitude!.toFixed(5)}</dd>
                <dd><button className="text-button" onClick={() => onShowOnMap?.(item)}><Icon name="map" size={18} /> Show on map</button></dd></>}
              <dt>SHA-256</dt><dd className="mono">{item.sha256}</dd>
            </dl>
          </aside>
        )}
      </div>

      <div className="filmstrip" ref={strip}>
        {media.map((m, i) => (
          // ponytail: renders every item; window it if libraries above ~20k feel slow here.
          <button key={m.id} className={i === index ? 'current' : ''} onClick={() => setIndex(i)}>
            {m.thumb ? <img src={thumbUrl(m)} loading="lazy" alt="" /> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
