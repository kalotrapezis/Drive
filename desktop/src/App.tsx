import { useEffect, useMemo, useRef, useState } from 'react'
import { group, LEVELS, type Level, type Media } from './timeline'
import { Icon } from './Icon'
import { Viewer } from './Viewer'

const THUMB: Record<Level, number> = { week: 240, month: 160, year: 88 }
const GAP = 4

export function App() {
  const [media, setMedia] = useState<Media[] | null>(null)
  const [root, setRoot] = useState('')
  const [scan, setScan] = useState<string | null>('Looking for photos…')
  const [level, setLevel] = useState<Level>('month')
  const [open, setOpen] = useState<number | null>(null)

  async function rescan() {
    setScan('Looking for photos…')
    try { await window.drive.scan() } catch (e) { console.error(e) }
    setMedia(await window.drive.list())
    setScan(null)
  }

  useEffect(() => {
    window.drive.info().then(i => setRoot(i.photosRoot))
    window.drive.list().then(setMedia)
    const off = window.drive.onScanProgress(p => setScan(p.changed ? `Adding photos… ${p.changed} new` : `Checking… ${p.done}`))
    rescan()
    return off
  }, [])

  return (
    <div className="app">
      <nav className="rail island">
        <div className="brand"><img src="./icon.png" alt="" />Local Drive</div>
        <button className="nav-item active"><Icon name="photos" />Photos</button>
        <div className="rail-foot">
          <span>{scan ?? `${media?.length ?? 0} items`}</span>
          <button className="round" title="Rescan library" disabled={!!scan} onClick={rescan}><Icon name="refresh" size={20} /></button>
        </div>
      </nav>
      <main className="content">
        {media && media.length > 0
          ? <Timeline media={media} level={level} setLevel={setLevel} onOpen={setOpen} />
          : <div className="empty">{media && !scan ? <>No photos or videos in <code>{root}</code></> : 'Loading…'}</div>}
      </main>
      {open !== null && media && <Viewer media={media} index={open} setIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Timeline({ media, level, setLevel, onOpen }: { media: Media[]; level: Level; setLevel: (l: Level) => void; onOpen: (i: number) => void }) {
  const groups = useMemo(() => group(media, level), [media, level])
  const indexOf = useMemo(() => new Map(media.map((m, i) => [m.id, i])), [media])
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [period, setPeriod] = useState('')
  const pinch = useRef(0)

  useEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 48))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Touchpad pinch arrives as ctrl+wheel: pinch out = broader periods and smaller thumbnails, like the phone.
  useEffect(() => {
    const el = scroller.current!
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      pinch.current += e.deltaY
      if (Math.abs(pinch.current) < 40) return
      const i = LEVELS.indexOf(level) + (pinch.current > 0 ? 1 : -1)
      pinch.current = 0
      if (LEVELS[i]) setLevel(LEVELS[i])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [level, setLevel])

  function updatePeriod() {
    const el = scroller.current!
    const headers = el.querySelectorAll<HTMLElement>('[data-label]')
    let label = headers[0]?.dataset.label ?? ''
    for (const h of headers) { if (h.offsetTop - el.scrollTop > 80) break; label = h.dataset.label! }
    setPeriod(label)
  }
  useEffect(updatePeriod, [groups])

  const size = THUMB[level]
  const columns = Math.max(1, Math.floor((width + GAP) / (size + GAP)))
  const cell = (width - GAP * (columns - 1)) / columns

  return (
    <div className="timeline" ref={scroller} onScroll={updatePeriod}>
      <header className="topbar">
        <div className="island title-island"><h1>Photos</h1>{period && <span className="pill">{period}</span>}</div>
        <div className="island segmented">
          {LEVELS.map(l => <button key={l} className={l === level ? 'on' : ''} onClick={() => setLevel(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}
        </div>
      </header>
      {groups.map(g => (
        // content-visibility skips layout/paint of off-screen periods, so large libraries stay smooth.
        <section key={g.key} className="period" data-label={g.label}
          style={{ containIntrinsicSize: `auto ${48 + Math.ceil(g.items.length / columns) * (cell + GAP)}px` }}>
          <h2>{g.label}<span>{g.items.length}</span></h2>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: GAP }}>
            {g.items.map(m => (
              <button key={m.id} className="thumb" style={{ height: cell }} onClick={() => onOpen(indexOf.get(m.id)!)} title={m.path}>
                {m.thumb ? <img src={`media://thumb/${m.sha256}`} loading="lazy" decoding="async" alt="" /> : <span className="no-thumb">{m.path.split('.').pop()}</span>}
                {m.is_video ? <span className="badge"><Icon name="play" size={16} /></span> : null}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
