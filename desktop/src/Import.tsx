import { useEffect, useState } from 'react'
import { Modal, errorText } from './Dialogs'
import { Icon } from './Icon'
import { formatBytes } from './timeline'

/**
 * Import photos or files (importer.js): choose folders or files, then where they go — this computer, or straight to
 * a plugged-in drive when this disk has no room (asked 2026-09-26).
 */
export function ImportDialog({ kind, onClose, onDone }: { kind: 'photos' | 'files'; onClose: () => void; onDone: () => void }) {
  const [sources, setSources] = useState<string[]>([])
  const [drives, setDrives] = useState<{ id: string; name: string; free: number }[]>([])
  const [to, setTo] = useState<string | null>(null)
  const [move, setMove] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; imported: number; skipped: number } | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { window.drive.imports.drives().then(setDrives) }, [])
  useEffect(() => window.drive.imports.onProgress(setProgress), [])
  const add = (folders: boolean) => window.drive.imports.pick(folders).then(p => setSources(s => [...new Set([...s, ...p])]))
  const running = progress !== null && result === null
  async function start() {
    setError(''); setProgress({ done: 0, total: 0, imported: 0, skipped: 0 })
    try {
      const r = await window.drive.imports.run(kind, sources, to, move)
      setResult(`${move ? 'Moved in' : 'Imported'} ${r.imported.toLocaleString()}` + (r.skipped ? `, ${r.skipped.toLocaleString()} already in the library` : '')
        + (r.failed.length ? `. ${r.failed.length} could not be copied: ${r.failed.slice(0, 2).join('; ')}` : '.'))
      onDone()
    } catch (e) { setError(errorText(e)); setProgress(null) }
  }
  const what = kind === 'photos' ? 'photos and videos' : 'files'
  return (
    <Modal onClose={() => { if (!running) onClose() }}>
      <h3>Import {kind}</h3>
      {result ? <p>{result}</p> : running ? (
        <>
          <p>{progress.total ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} · ${progress.imported.toLocaleString()} imported` : 'Looking…'}
            {to && ' — each batch is checked on the drive before this computer lets it go.'}</p>
          <progress value={progress.done} max={Math.max(progress.total, 1)} style={{ width: '100%' }} />
        </>
      ) : (
        <>
          <p>Choose folders or single files; every {kind === 'photos' ? 'photo' : 'file'} is copied and checked.
            {kind === 'photos' && ' Photos the library already has are skipped.'}</p>
          <div className="dialog-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
            <button className="text-button" onClick={() => add(true)}><Icon name="folder" size={18} /> Add folders…</button>
            <button className="text-button" onClick={() => add(false)}><Icon name="file" size={18} /> Add files…</button>
          </div>
          {sources.length > 0 && <ul className="import-list">{sources.map(s => <li key={s}>{s}<button className="round flat" title="Leave out" onClick={() => setSources(x => x.filter(y => y !== s))}><Icon name="close" size={16} /></button></li>)}</ul>}
          <h4 className="import-head">Into</h4>
          <label className="check-row"><input type="radio" checked={to === null} onChange={() => setTo(null)} /><span>This computer — {kind === 'photos' ? 'Photos' : 'Files'} / Imported</span></label>
          {drives.map(d => <label key={d.id} className="check-row"><input type="radio" checked={to === d.id} onChange={() => setTo(d.id)} />
            <span>Straight to {d.name} ({formatBytes(d.free)} free) — {kind === 'photos' ? 'the photos live on the drive, and show here like moved ones' : 'into its Tetra / Files / Imported'}</span></label>)}
          {!drives.length && <p className="hint">Plug in a set-up drive to import {what} straight to it.</p>}
          <h4 className="import-head">Originals</h4>
          <label className="check-row"><input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)} />
            <span>Move instead of copy — each original is deleted once its copy reads back the same{kind === 'photos' ? '; ones the library already has go too' : ''}. Emptied folders go.</span></label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {result ? <button className="filled-button" onClick={onClose}>Done</button> : <>
          <button className="text-button" disabled={running} onClick={onClose}>Cancel</button>
          <button className="filled-button" disabled={!sources.length || running} onClick={start}>Import</button>
        </>}
      </div>
    </Modal>
  )
}
