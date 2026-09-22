import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { group, LEVELS, type Level, type Media } from './timeline'
import { Icon } from './Icon'

const THUMB: Record<Level, number> = { week: 240, month: 160, year: 88 }
const GAP = 4

interface Props {
  items: Media[]
  title: ReactNode
  tools?: ReactNode
  empty: ReactNode
  level: Level
  setLevel: (l: Level) => void
  selected: Set<number>
  setSelected: (s: Set<number>) => void
  onOpen: (index: number) => void
  thumbUrl?: (m: Media) => string
  banner?: ReactNode
}

const defaultThumb = (m: Media) => `media://thumb/${m.sha256}`

export function Timeline({ items, title, tools, empty, level, setLevel, selected, setSelected, onOpen, thumbUrl = defaultThumb, banner }: Props) {
  const groups = useMemo(() => group(items, level), [items, level])
  const indexOf = useMemo(() => new Map(items.map((m, i) => [m.id, i])), [items])
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [period, setPeriod] = useState('')
  const pinch = useRef(0)
  const drag = useRef<{ add: boolean } | null>(null)
  const anchor = useRef<number | null>(null)
  const handled = useRef(false)
  const selecting = selected.size > 0

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

  useEffect(() => {
    const up = () => { drag.current = null }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  function updatePeriod() {
    const el = scroller.current
    if (!el) return
    const headers = el.querySelectorAll<HTMLElement>('[data-label]')
    let label = headers[0]?.dataset.label ?? ''
    for (const h of headers) { if (h.offsetTop - el.scrollTop > 80) break; label = h.dataset.label! }
    setPeriod(label)
  }
  useEffect(updatePeriod, [groups])

  function apply(ids: number[], add: boolean) {
    const next = new Set(selected)
    for (const id of ids) add ? next.add(id) : next.delete(id)
    setSelected(next)
  }

  // Selecting: click the check circle (or Ctrl+click) to start, then click or drag across thumbnails; Shift+click selects a range.
  function pointerDown(e: React.PointerEvent, m: Media) {
    if (e.button !== 0) return
    const i = indexOf.get(m.id)!
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [anchor.current, i].sort((x, y) => x - y)
      apply(items.slice(a, b + 1).map(x => x.id), true)
    } else if (selecting || e.ctrlKey || e.metaKey || (e.target as Element).closest('.check')) {
      const add = !selected.has(m.id)
      apply([m.id], add)
      drag.current = { add }
      anchor.current = i
    } else return
    handled.current = true
    e.preventDefault()
  }
  function pointerEnter(m: Media) {
    if (drag.current && selected.has(m.id) !== drag.current.add) apply([m.id], drag.current.add)
  }
  function autoScroll(e: React.PointerEvent) {
    if (!drag.current) return
    const r = scroller.current!.getBoundingClientRect()
    if (e.clientY < r.top + 70) scroller.current!.scrollBy(0, -24)
    else if (e.clientY > r.bottom - 70) scroller.current!.scrollBy(0, 24)
  }

  const size = THUMB[level]
  const columns = Math.max(1, Math.floor((width + GAP) / (size + GAP)))
  const cell = (width - GAP * (columns - 1)) / columns

  return (
    <div className={`timeline ${selecting ? 'selecting' : ''}`} ref={scroller} onScroll={updatePeriod} onPointerMove={autoScroll}>
      <header className="topbar">
        <div className="island title-island">{title}{period && items.length > 0 && <span className="pill">{period}</span>}</div>
        <div className="tools">
          {tools}
          <div className="island segmented">
            {LEVELS.map(l => <button key={l} className={l === level ? 'on' : ''} onClick={() => setLevel(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}
          </div>
        </div>
      </header>
      {banner}
      {items.length === 0 && <div className="empty">{empty}</div>}
      {groups.map(g => (
        // content-visibility skips layout/paint of off-screen periods, so large libraries stay smooth.
        <section key={g.key} className="period" data-label={g.label}
          style={{ containIntrinsicSize: `auto ${48 + Math.ceil(g.items.length / columns) * (cell + GAP)}px` }}>
          <h2>{g.label}<span>{g.items.length}</span></h2>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: GAP }}>
            {g.items.map(m => (
              <button key={m.id} className={`thumb ${selected.has(m.id) ? 'selected' : ''}`} style={{ height: cell }} title={m.path}
                onPointerDown={e => pointerDown(e, m)} onPointerEnter={() => pointerEnter(m)}
                onClick={() => { if (handled.current) handled.current = false; else onOpen(indexOf.get(m.id)!) }}>
                {m.thumb ? <img src={thumbUrl(m)} loading="lazy" decoding="async" draggable={false} alt="" /> : <span className="no-thumb">{m.path.split('.').pop()}</span>}
                {m.is_video ? <span className="badge"><Icon name="play" size={16} /></span> : null}
                {m.favorite ? <span className="badge fav"><Icon name="heartFill" size={16} /></span> : null}
                <span className="check" title="Select"><Icon name={selected.has(m.id) ? 'checked' : 'unchecked'} size={24} /></span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
