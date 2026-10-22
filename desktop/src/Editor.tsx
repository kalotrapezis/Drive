import { useEffect, useRef, useState } from 'react'
import type { Media } from './timeline'
import { Icon, type IconName } from './Icon'
import { Modal, errorText } from './Dialogs'
import { FULL, clampRect, coverHas, coverScale, drawCover, eyeCovers, frameSize, turnPoint, turnRect, type Cover, type Eyes, type Rect, type Stroke, type Turn } from './edit'

// Phone editor: crop & straighten, rotate, markup, hide eyes or text; Save / Save as copy / Discard. Full resolution up to 8192 px.
const MAX_OUTPUT = 8192
const SWATCHES = ['#ffffff', '#000000', '#e3685f', '#f2b544', '#55a96b', '#4f86e8', '#ad68cf']
type Mode = 'crop' | 'markup' | 'hide' | null
export type Hide = 'eyes' | 'text'

export function Editor({ item, onClose, onSaved, hide }: { item: Media; onClose: () => void; onSaved: (message: string) => void; hide?: Hide }) {
  const [image, setImage] = useState<ImageBitmap | null>(null)
  const [error, setError] = useState('')
  const [rotation, setRotation] = useState(0)
  const [angle, setAngle] = useState(0)
  const [crop, setCrop] = useState<Rect>(FULL)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [mode, setMode] = useState<Mode>(hide ? 'hide' : null)
  // Hide: covers burned into the photo before turn and crop; the eyes and words found to place them (phone: PhotoEditor's Hide)
  const [covers, setCovers] = useState<Cover[]>([])
  const [stars, setStars] = useState(false)
  const [eyes, setEyes] = useState<{ eyes: Eyes; width: number; height: number } | null>(null)
  const [words, setWords] = useState<Rect[]>([])
  const [finding, setFinding] = useState(false)
  const [note, setNote] = useState('')
  const box = useRef<{ start: [number, number]; end: [number, number] } | null>(null)
  const [color, setColor] = useState('#e3685f')
  const [brush, setBrush] = useState(8)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drawing = useRef<Stroke | null>(null)
  const dragging = useRef<{ kind: string; start: [number, number]; rect: Rect } | null>(null)
  const changed = rotation !== 0 || angle !== 0 || strokes.length > 0 || covers.length > 0 || crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1

  useEffect(() => {
    window.drive.editorLoad(item.id)
      .then(bytes => createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' }))
      .then(setImage, e => setError(errorText(e)))
  }, [item.id])

  /** The photo rotated + straightened (covering the frame), with markup on top. */
  function renderFrame(maxSide: number) {
    const img = image!
    const f = frameSize(img.width, img.height, rotation)
    const k = Math.min(1, maxSide / Math.max(f.w, f.h))
    const c = document.createElement('canvas')
    c.width = Math.round(f.w * k); c.height = Math.round(f.h * k)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.save()
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate((rotation + angle) * Math.PI / 180)
    const s = coverScale(f.w, f.h, angle) * k
    ctx.scale(s, s)
    ctx.drawImage(img, -img.width / 2, -img.height / 2)
    for (const c of covers) drawCover(ctx, -img.width / 2 + c.x * img.width, -img.height / 2 + c.y * img.height, c.w * img.width, c.h * img.height, c.stars)
    ctx.restore()
    ctx.lineCap = ctx.lineJoin = 'round'
    for (const st of [...strokes, ...(drawing.current ? [drawing.current] : [])]) {
      ctx.strokeStyle = st.color; ctx.lineWidth = st.size * c.width
      ctx.beginPath()
      st.points.forEach(([x, y], i) => i ? ctx.lineTo(x * c.width, y * c.height) : ctx.moveTo(x * c.width, y * c.height))
      if (st.points.length === 1) ctx.lineTo(st.points[0][0] * c.width + 0.01, st.points[0][1] * c.height)
      ctx.stroke()
    }
    return c
  }

  function renderOutput(maxSide: number) {
    const frame = renderFrame(maxSide / Math.max(crop.w, crop.h)) // crop keeps full resolution where possible
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(frame.width * crop.w)); out.height = Math.max(1, Math.round(frame.height * crop.h))
    out.getContext('2d')!.drawImage(frame, crop.x * frame.width, crop.y * frame.height, out.width, out.height, 0, 0, out.width, out.height)
    return out
  }

  /** Hiding works on the whole upright photo the covers are measured on: the covers, the found words to click, a box being dragged. */
  function renderPlain(maxSide: number) {
    const img = image!, k = Math.min(1, maxSide / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    for (const v of covers) drawCover(ctx, v.x * c.width, v.y * c.height, v.w * c.width, v.h * c.height, v.stars)
    ctx.strokeStyle = '#4f86e8'; ctx.lineWidth = 2
    for (const w of words) if (!covers.some(v => v.x === w.x && v.y === w.y)) ctx.strokeRect(w.x * c.width, w.y * c.height, w.w * c.width, w.h * c.height)
    const b = box.current
    if (b) ctx.strokeRect(Math.min(b.start[0], b.end[0]) * c.width, Math.min(b.start[1], b.end[1]) * c.height, Math.abs(b.end[0] - b.start[0]) * c.width, Math.abs(b.end[1] - b.start[1]) * c.height)
    return c
  }

  // Preview: the whole frame while cropping, the plain photo while hiding, the cropped result otherwise.
  function paint() {
    if (!image || !canvas.current || !stage.current) return
    const box = stage.current.getBoundingClientRect()
    const src = mode === 'crop' ? renderFrame(1600) : mode === 'hide' ? renderPlain(1600) : renderOutput(1600)
    const k = Math.min(box.width / src.width, box.height / src.height)
    const c = canvas.current
    c.width = src.width; c.height = src.height
    c.style.width = `${src.width * k}px`; c.style.height = `${src.height * k}px`
    c.getContext('2d')!.drawImage(src, 0, 0)
  }
  useEffect(paint, [image, rotation, angle, crop, strokes, mode, covers, words])
  useEffect(() => { const ro = new ResizeObserver(paint); if (stage.current) ro.observe(stage.current); return () => ro.disconnect() })

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
  }

  // Markup is drawn on the cropped view but stored in frame coordinates, so later crops keep it in place.
  function markDown(e: React.PointerEvent) {
    if (mode !== 'markup') return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const [x, y] = pos(e)
    const width = canvas.current!.getBoundingClientRect().width
    drawing.current = { color, size: (brush / width) * crop.w, points: [[crop.x + x * crop.w, crop.y + y * crop.h]] }
    paint()
  }
  function markMove(e: React.PointerEvent) {
    if (!drawing.current) return
    const [x, y] = pos(e)
    drawing.current.points.push([crop.x + x * crop.w, crop.y + y * crop.h])
    paint()
  }
  async function find(what: Hide) {
    setFinding(true); setNote('')
    try {
      if (what === 'eyes') {
        const found = await window.drive.photoAsk(item.id, 'eyes')
        setEyes(found)
        setCovers(list => [...list.filter(c => !c.eye), ...eyeCovers(found.eyes, found.width, found.height, stars)])
        if (!found.eyes.length) setNote('No faces found. Drag over the eyes to hide them.')
      } else {
        const found = await window.drive.photoAsk(item.id, 'text')
        setWords(found.words)
        if (!found.words.length) setNote('No words found. Drag over the text to hide it.')
      }
    } catch (e) { setNote(errorText(e)) }
    setFinding(false)
  }
  useEffect(() => { if (image && hide) find(hide) }, [image]) // eslint-disable-line react-hooks/exhaustive-deps
  function setStyle(next: boolean) {
    setStars(next)
    if (eyes) setCovers(list => [...list.filter(c => !c.eye), ...eyeCovers(eyes.eyes, eyes.width, eyes.height, next)])
  }
  // Click: a cover shows its part again, a found word is hidden; drag: hide any part.
  function hideDown(e: React.PointerEvent) { ;(e.target as Element).setPointerCapture(e.pointerId); const p = pos(e); box.current = { start: p, end: p } }
  function hideMove(e: React.PointerEvent) { if (box.current) { box.current.end = pos(e); paint() } }
  function hideUp() {
    const b = box.current
    box.current = null
    if (!b) return
    const [x0, y0] = b.start, [x1, y1] = b.end
    if (Math.abs(x1 - x0) < 0.005 || Math.abs(y1 - y0) < 0.005) {
      const hit = [...covers].reverse().find(c => coverHas(c, x0, y0))
      if (hit) setCovers(list => list.filter(c => c !== hit))
      else { const w = words.find(c => coverHas(c, x0, y0)); if (w) setCovers(list => [...list, { ...w, stars: false }]) }
      paint()
    } else setCovers(list => [...list, { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), stars }])
  }

  function markUp() { if (drawing.current) { const s = drawing.current; drawing.current = null; setStrokes(list => [...list, s]) } }

  function cropDown(e: React.PointerEvent, kind: string) {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragging.current = { kind, start: pos(e), rect: crop }
  }
  function cropMove(e: React.PointerEvent) {
    const d = dragging.current
    if (!d) return
    const [x, y] = pos(e), dx = x - d.start[0], dy = y - d.start[1], r = d.rect
    let next = r
    if (d.kind === 'move') next = { ...r, x: r.x + dx, y: r.y + dy }
    if (d.kind.includes('l')) next = { ...next, x: Math.min(r.x + dx, r.x + r.w - 0.05), w: r.w - Math.min(dx, r.w - 0.05) }
    if (d.kind.includes('r')) next = { ...next, w: r.w + dx }
    if (d.kind.includes('t')) next = { ...next, y: Math.min(r.y + dy, r.y + r.h - 0.05), h: r.h - Math.min(dy, r.h - 0.05) }
    if (d.kind.includes('b')) next = { ...next, h: r.h + dy }
    setCrop(clampRect({ ...next, x: Math.max(0, next.x), y: Math.max(0, next.y), w: Math.min(next.w, 1 - Math.max(0, next.x)), h: Math.min(next.h, 1 - Math.max(0, next.y)) }))
  }

  function turn(t: Turn) {
    setRotation(r => (r + (t === 'right' ? 90 : 270)) % 360)
    setCrop(c => turnRect(c, t))
    setStrokes(list => list.map(s => ({ ...s, points: s.points.map(p => turnPoint(p, t)) })))
  }

  async function save(kind: 'copy' | 'replace') {
    setBusy(true)
    try {
      const out = renderOutput(MAX_OUTPUT)
      const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/jpeg', 0.92))
      if (!blob) throw new Error('Could not encode the edited photo.')
      const saved = await window.drive.editorSave(item.id, new Uint8Array(await blob.arrayBuffer()), kind)
      onSaved(kind === 'copy' ? `Saved a copy: ${saved.split('/').pop()}` : 'Saved. The original is in the system Trash.')
    } catch (e) { setError(errorText(e)); setBusy(false); setSheet(false) }
  }

  const tool = (icon: IconName, title: string, fn: () => void, on = false, disabled = false) =>
    <button className={`round flat ${on ? 'on' : ''}`} title={title} disabled={disabled} onClick={fn}><Icon name={icon} /></button>
  const handles = ['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r']

  return (
    <div className="editor">
      <div className="viewer-bar">
        <button className="round" title="Close" onClick={() => changed ? setSheet(true) : onClose()}><Icon name="close" /></button>
        <div className="island viewer-title"><strong>Edit · {item.path.split('/').pop()}</strong><span>{changed ? 'Edited' : 'No changes yet'}</span></div>
      </div>
      <div className="editor-stage" ref={stage}>
        {!image && !error && <span className="spinner" />}
        {error && <p className="error">{error}</p>}
        <div className="editor-canvas">
          <canvas ref={canvas} className={mode === 'markup' || mode === 'hide' ? 'drawing' : ''}
            onPointerDown={e => mode === 'hide' ? hideDown(e) : markDown(e)} onPointerMove={e => mode === 'hide' ? hideMove(e) : markMove(e)} onPointerUp={() => mode === 'hide' ? hideUp() : markUp()} />
          {mode === 'crop' && image && (
            <div className="crop-layer" onPointerMove={cropMove} onPointerUp={() => { dragging.current = null }}>
              <div className="crop-rect" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
                onPointerDown={e => cropDown(e, 'move')}>
                {handles.map(h => <span key={h} className={`handle ${h}`} onPointerDown={e => cropDown(e, h)} />)}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="editor-tools">
        {mode === 'crop' && (
          <div className="island tool-panel">
            <label>Straighten <input type="range" min={-45} max={45} step={0.5} value={angle} onChange={e => setAngle(Number(e.target.value))} /> <span>{angle.toFixed(1)}°</span></label>
            <button className="text-button" onClick={() => { setCrop(FULL); setAngle(0) }}>Reset crop</button>
          </div>
        )}
        {mode === 'markup' && (
          <div className="island tool-panel">
            {SWATCHES.map(c => <button key={c} className={`swatch small ${color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />)}
            <label className="swatch small custom" title="Custom colour"><Icon name="palette" size={18} /><input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
            <label>Size <input type="range" min={2} max={48} value={brush} onChange={e => setBrush(Number(e.target.value))} /></label>
            <button className="text-button" disabled={!strokes.length} onClick={() => setStrokes(s => s.slice(0, -1))}><Icon name="undo" size={18} /> Undo</button>
          </div>
        )}
        {mode === 'hide' && (
          <div className="island tool-panel">
            <button className="text-button" disabled={finding} onClick={() => find('eyes')}><Icon name="visibilityOff" size={18} /> Find eyes</button>
            <button className="text-button" disabled={finding} onClick={() => find('text')}><Icon name="textFields" size={18} /> Find text</button>
            {words.length > 0 && <button className="text-button" onClick={() => setCovers(list => [...list, ...words.filter(w => !list.some(c => c.x === w.x && c.y === w.y)).map(w => ({ ...w, stars: false }))])}>
              <Icon name="textFields" size={18} /> Hide all the text</button>}
            <button className={`text-button ${!stars ? 'on' : ''}`} onClick={() => setStyle(false)}><Icon name="square" size={18} /> Black bar</button>
            <button className={`text-button ${stars ? 'on' : ''}`} onClick={() => setStyle(true)}><Icon name="star" size={18} /> Stars</button>
            <button className="text-button" disabled={!covers.length} onClick={() => setCovers(c => c.slice(0, -1))}><Icon name="undo" size={18} /> Undo</button>
            {finding ? <span className="spinner" /> : <span className="hint">{note || (words.length ? 'Click words to hide them, a cover to show it again; drag to hide any part.' : 'Click a cover to show it again; drag to hide any part.')}</span>}
          </div>
        )}
        <div className="island tool-bar">
          {tool('crop', 'Crop & straighten', () => setMode(m => m === 'crop' ? null : 'crop'), mode === 'crop', !image)}
          {tool('rotateLeft', 'Rotate left', () => turn('left'), false, !image)}
          {tool('rotateRight', 'Rotate right', () => turn('right'), false, !image)}
          {tool('edit', 'Markup', () => setMode(m => m === 'markup' ? null : 'markup'), mode === 'markup', !image)}
          {tool('visibilityOff', 'Hide eyes or text', () => setMode(m => m === 'hide' ? null : 'hide'), mode === 'hide', !image)}
          {tool('save', 'Save…', () => setSheet(true), false, !changed)}
        </div>
      </div>
      {sheet && (
        <Modal onClose={() => !busy && setSheet(false)}>
          <h3>{changed ? 'Save your edit?' : 'Leave the editor?'}</h3>
          {changed && <>
            <button className="sheet-row" disabled={busy} onClick={() => save('copy')}><Icon name="copy" />Save as copy<small>&nbsp;· new file beside the original</small></button>
            <button className="sheet-row" disabled={busy} onClick={() => save('replace')}><Icon name="save" />Save<small>&nbsp;· replaces the original; it goes to the system Trash</small></button>
          </>}
          <button className="sheet-row danger" disabled={busy} onClick={onClose}><Icon name="trash" />Discard changes</button>
          {busy && <p className="hint">Saving at full resolution…</p>}
        </Modal>
      )}
    </div>
  )
}
