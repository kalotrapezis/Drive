import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VaultItem, VaultStatus } from './drive'
import type { Level, Media } from './timeline'
import { Icon } from './Icon'
import { Timeline } from './Timeline'
import { Viewer } from './Viewer'
import { Confirm, Modal, errorText } from './Dialogs'
import { t } from './i18n'

/** Setup (first time) or unlock. Resolves when the vault is open. */
export function VaultGate({ status, onOpen, onClose }: { status: VaultStatus; onOpen: () => void; onClose?: () => void }) {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setup = !status.configured
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (setup && pass !== again) return setError(t('hidden.mismatch'))
    setBusy(true)
    try { await (setup ? window.drive.vault.setup(pass) : window.drive.vault.unlock(pass)); onOpen() } catch (err) { setError(errorText(err)) }
    setBusy(false)
  }
  const form = (
    <form onSubmit={submit} className="gate">
      <Icon name="lock" size={40} />
      <h3>{setup ? t('hidden.setUp') : t('hidden.locked')}</h3>
      <p>{setup ? t('hidden.setupText') : t('hidden.unlockText')}</p>
      <input className="field" type="password" autoFocus placeholder={t('hidden.passphrase')} value={pass} onChange={e => { setPass(e.target.value); setError('') }} />
      {setup && <input className="field" type="password" placeholder={t('hidden.repeat')} value={again} onChange={e => { setAgain(e.target.value); setError('') }} />}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {onClose && <button type="button" className="text-button" onClick={onClose}>{t('common.cancel')}</button>}
        <button className="filled-button" disabled={busy || !pass}>{busy ? t('hidden.working') : setup ? t('hidden.setPassphrase') : t('hidden.unlock')}</button>
      </div>
    </form>
  )
  return onClose ? <Modal onClose={onClose}>{form}</Modal> : <div className="island gate-page">{form}</div>
}

export function HiddenPage({ onBack, setDialog, say, onChanged }: {
  onBack: () => void; setDialog: (d: ReactNode) => void; say: (t: string) => void; onChanged: () => void
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [items, setItems] = useState<VaultItem[]>([])
  const [level, setLevel] = useState<Level>('month')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const close = () => setDialog(null)

  async function load() {
    const s = await window.drive.vault.status()
    setStatus(s)
    setItems(s.unlocked ? await window.drive.vault.list() : [])
  }
  useEffect(() => { load() }, [])

  // Vault items shown through the normal timeline and viewer; ids are list positions.
  const media: Media[] = useMemo(() => items.map((v, i) => ({
    id: i + 1, path: v.rel_path, sha256: v.sha256, mime: v.mime, is_video: v.is_video, size: v.size, taken_at: v.taken_at,
    width: null, height: null, latitude: null, longitude: null, camera: null, thumb: v.has_thumb, favorite: 0, place: null, place_names: null,
  })), [items])
  const vaultId = (m: Media) => items[m.id - 1].id

  function restore(list: Media[]) {
    setDialog(<Confirm title={t('hidden.restoreTitle', { count: list.length })} action={t('common.restore')} onClose={close}
      body={t('hidden.restoreBody')}
      onConfirm={async () => {
        try { await window.drive.vault.restore(list.map(vaultId)); say(t('hidden.restored', { count: list.length })) } catch (e) { say(errorText(e)) }
        setSelected(new Set()); setOpen(null); await load(); onChanged()
      }} />)
  }

  if (!status) return null
  if (!status.unlocked) return (
    <div className="timeline">
      <header className="topbar"><div className="island title-island"><button className="round flat" title={t('collections.backTo')} onClick={onBack}><Icon name="back" /></button><h1>{t('hidden.title')}</h1></div></header>
      <VaultGate status={status} onOpen={load} />
    </div>
  )
  const picked = media.filter(m => selected.has(m.id))
  return (
    <>
      <Timeline items={media} level={level} setLevel={setLevel} selected={selected} setSelected={setSelected} onOpen={setOpen}
        thumbUrl={m => `media://vault-thumb/${vaultId(m)}`}
        title={<><button className="round flat" title={t('collections.backTo')} onClick={onBack}><Icon name="back" /></button><h1>{t('hidden.title')}</h1></>}
        tools={<button className="island lock-button" onClick={async () => { await window.drive.vault.lock(); load() }}><Icon name="lock" size={20} />{t('hidden.lock')}</button>}
        empty={t('hidden.empty')} />
      {picked.length > 0 && (
        <div className="island selection-bar">
          <button className="round flat" title={t('hidden.clearSelection')} onClick={() => setSelected(new Set())}><Icon name="close" /></button>
          <strong>{t('files.selected', { count: picked.length })}</strong>
          <button className="round flat" title={t('hidden.restoreToPhotos')} onClick={() => restore(picked)}><Icon name="lockOpen" /></button>
        </div>
      )}
      {open !== null && media[open] && (
        <Viewer media={media} index={open} setIndex={setOpen} onClose={() => setOpen(null)} people={[]}
          fileUrl={m => `media://vault/${vaultId(m)}`} thumbUrl={m => `media://vault-thumb/${vaultId(m)}`} onRestore={m => restore([m])} />
      )}
    </>
  )
}
