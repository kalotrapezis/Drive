import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VaultItem, VaultStatus } from './drive'
import type { Level, Media } from './timeline'
import { Icon } from './Icon'
import { Timeline } from './Timeline'
import { Viewer } from './Viewer'
import { Confirm, Modal, errorText } from './Dialogs'

/** Setup (first time) or unlock. Resolves when the vault is open. */
export function VaultGate({ status, onOpen, onClose }: { status: VaultStatus; onOpen: () => void; onClose?: () => void }) {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setup = !status.configured
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (setup && pass !== again) return setError('The two passphrases are different.')
    setBusy(true)
    try { await (setup ? window.drive.vault.setup(pass) : window.drive.vault.unlock(pass)); onOpen() } catch (err) { setError(errorText(err)) }
    setBusy(false)
  }
  const form = (
    <form onSubmit={submit} className="gate">
      <Icon name="lock" size={40} />
      <h3>{setup ? 'Set up Hidden' : 'Hidden is locked'}</h3>
      <p>{setup
        ? 'Hidden photos are encrypted on this computer with a passphrase. There is no reset: if you forget it, hidden items cannot be recovered.'
        : 'Enter your passphrase. Hidden locks again when Local Drive closes.'}</p>
      <input className="field" type="password" autoFocus placeholder="Passphrase" value={pass} onChange={e => { setPass(e.target.value); setError('') }} />
      {setup && <input className="field" type="password" placeholder="Repeat passphrase" value={again} onChange={e => { setAgain(e.target.value); setError('') }} />}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {onClose && <button type="button" className="text-button" onClick={onClose}>Cancel</button>}
        <button className="filled-button" disabled={busy || !pass}>{busy ? 'Working…' : setup ? 'Set passphrase' : 'Unlock'}</button>
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
    setDialog(<Confirm title={`Restore ${list.length === 1 ? '1 item' : `${list.length} items`} to Photos?`} action="Restore" onClose={close}
      body="They are decrypted back to their original folder in Photos and removed from Hidden."
      onConfirm={async () => {
        try { await window.drive.vault.restore(list.map(vaultId)); say(`Restored ${list.length} to Photos`) } catch (e) { say(errorText(e)) }
        setSelected(new Set()); setOpen(null); await load(); onChanged()
      }} />)
  }

  if (!status) return null
  if (!status.unlocked) return (
    <div className="timeline">
      <header className="topbar"><div className="island title-island"><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>Hidden</h1></div></header>
      <VaultGate status={status} onOpen={load} />
    </div>
  )
  const picked = media.filter(m => selected.has(m.id))
  return (
    <>
      <Timeline items={media} level={level} setLevel={setLevel} selected={selected} setSelected={setSelected} onOpen={setOpen}
        thumbUrl={m => `media://vault-thumb/${vaultId(m)}`}
        title={<><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>Hidden</h1></>}
        tools={<button className="island lock-button" onClick={async () => { await window.drive.vault.lock(); load() }}><Icon name="lock" size={20} />Lock</button>}
        empty="Nothing is hidden. Select photos in Photos and choose Move to Hidden." />
      {picked.length > 0 && (
        <div className="island selection-bar">
          <button className="round flat" title="Clear selection" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
          <strong>{picked.length} selected</strong>
          <button className="round flat" title="Restore to Photos" onClick={() => restore(picked)}><Icon name="lockOpen" /></button>
        </div>
      )}
      {open !== null && media[open] && (
        <Viewer media={media} index={open} setIndex={setOpen} onClose={() => setOpen(null)} people={[]}
          fileUrl={m => `media://vault/${vaultId(m)}`} thumbUrl={m => `media://vault-thumb/${vaultId(m)}`} onRestore={m => restore([m])} />
      )}
    </>
  )
}
