import { useEffect, useState } from 'react'
import { Modal, errorText } from './Dialogs'
import { Icon } from './Icon'
import { formatBytes } from './timeline'
import { t } from './i18n'

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
  const [stopping, setStopping] = useState(false)
  useEffect(() => { window.drive.imports.drives().then(setDrives) }, [])
  useEffect(() => window.drive.imports.onProgress(setProgress), [])
  const add = (folders: boolean) => window.drive.imports.pick(folders).then(p => setSources(s => [...new Set([...s, ...p])]))
  const running = progress !== null && result === null
  async function start() {
    setError(''); setProgress({ done: 0, total: 0, imported: 0, skipped: 0 })
    try {
      const r = await window.drive.imports.run(kind, sources, to, move)
      setResult((r.stopped ? t('import.stopped') + ' ' : '') + t(move ? 'import.movedIn' : 'import.importedN', { n: r.imported.toLocaleString() }) + (r.skipped ? t('import.alreadyIn', { n: r.skipped.toLocaleString() }) : '')
        + (r.failed.length ? t('import.couldNotCopy', { count: r.failed.length, list: r.failed.slice(0, 2).join('; ') }) : '.'))
      onDone()
    } catch (e) { setError(errorText(e)); setProgress(null) }
  }
  return (
    <Modal onClose={() => { if (running) { setStopping(true); window.drive.imports.cancel() } else onClose() }}>
      <h3>{t(kind === 'photos' ? 'import.titlePhotos' : 'import.titleFiles')}</h3>
      {result ? <p>{result}</p> : running ? (
        <>
          <p>{progress.total ? t('import.progress', { done: progress.done.toLocaleString(), total: progress.total.toLocaleString(), imported: progress.imported.toLocaleString() }) : t('import.looking')}
            {to && t('import.batchChecked')}</p>
          <progress value={progress.done} max={Math.max(progress.total, 1)} style={{ width: '100%' }} />
        </>
      ) : (
        <>
          <p>{t(kind === 'photos' ? 'import.choosePhotos' : 'import.chooseFiles')}
            {kind === 'photos' && ' ' + t('import.skipKnown')}</p>
          <div className="dialog-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
            <button className="text-button" onClick={() => add(true)}><Icon name="folder" size={18} /> {t('import.addFolders')}</button>
            <button className="text-button" onClick={() => add(false)}><Icon name="file" size={18} /> {t('import.addFiles')}</button>
          </div>
          {sources.length > 0 && <ul className="import-list">{sources.map(s => <li key={s}>{s}<button className="round flat" title={t('import.leaveOut')} onClick={() => setSources(x => x.filter(y => y !== s))}><Icon name="close" size={16} /></button></li>)}</ul>}
          <h4 className="import-head">{t('import.into')}</h4>
          <label className="check-row"><input type="radio" checked={to === null} onChange={() => setTo(null)} /><span>{t('import.thisComputer', { path: `${kind === 'photos' ? 'Photos' : 'Files'} / Imported` })}</span></label>
          {drives.map(d => <label key={d.id} className="check-row"><input type="radio" checked={to === d.id} onChange={() => setTo(d.id)} />
            <span>{t(kind === 'photos' ? 'import.straightToPhotos' : 'import.straightToFiles', { name: d.name, free: formatBytes(d.free) })}</span></label>)}
          {!drives.length && <p className="hint">{t(kind === 'photos' ? 'import.plugInPhotos' : 'import.plugInFiles')}</p>}
          <h4 className="import-head">{t('import.originals')}</h4>
          <label className="check-row"><input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)} />
            <span>{t(kind === 'photos' ? 'import.moveInsteadPhotos' : 'import.moveInsteadFiles')}</span></label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {result ? <button className="filled-button" onClick={onClose}>{t('common.done')}</button> : <>
          {/* Cancel while it runs stops it: after the photo in hand, with what came in so far kept whole. */}
          <button className="text-button" disabled={stopping} onClick={() => { if (running) { setStopping(true); window.drive.imports.cancel() } else onClose() }}>{stopping ? t('import.stopping') : t('common.cancel')}</button>
          <button className="filled-button" disabled={!sources.length || running} onClick={start}>{t('common.import')}</button>
        </>}
      </div>
    </Modal>
  )
}
