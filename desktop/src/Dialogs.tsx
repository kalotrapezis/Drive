import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Collection, PhotoPlace } from './drive'
import { Icon } from './Icon'

/** Native modal <dialog>: focus trap, Esc and backdrop come from the platform. */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current!.showModal() }, [])
  return (
    <dialog ref={ref} className="island dialog" onCancel={e => { e.preventDefault(); onClose() }}
      onClick={e => { if (e.target === ref.current) onClose() }}>
      {children}
    </dialog>
  )
}

export function Confirm({ title, body, action, danger, onConfirm, onClose }:
  { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>Cancel</button>
        <button className={`filled-button ${danger ? 'danger' : ''}`} autoFocus onClick={() => { onClose(); onConfirm() }}>{action}</button>
      </div>
    </Modal>
  )
}

/** Name a new collection; the backend's error (empty, too long, duplicate) is shown inline. */
export function NewCollection({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try { await onCreate(name); onClose() } catch (err) { setError(errorText(err)) }
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit}>
        <h3>New collection</h3>
        <input className="field" autoFocus maxLength={60} placeholder="Collection name" value={name} onChange={e => { setName(e.target.value); setError('') }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button className="filled-button" disabled={!name.trim()}>Create</button>
        </div>
      </form>
    </Modal>
  )
}

export function CollectionPicker({ collections, count, onPick, onNew, onClose }:
  { collections: Collection[]; count: number; onPick: (c: Collection) => void; onNew: () => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>Add {count === 1 ? 'item' : `${count} items`} to collection</h3>
      <div className="picker">
        <button className="picker-row" onClick={onNew}><span className="picker-cover"><Icon name="add" /></span>New collection</button>
        {collections.map(c => (
          <button key={c.id} className="picker-row" onClick={() => { onClose(); onPick(c) }}>
            <span className="picker-cover">{c.cover ? <img src={`media://thumb/${c.cover}`} alt="" /> : <Icon name="collections" />}</span>
            <span>{c.name}<small>{c.count}</small></span>
          </button>
        ))}
      </div>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button></div>
    </Modal>
  )
}

/**
 * Where to move photos: a real folder under Photos, not a collection. `leaving` is the folder album they are
 * being taken out of, which is not offered as a destination.
 */
export function FolderPicker({ count, leaving, onPick, onClose }: { count: number; leaving?: string; onPick: (dest: string) => void; onClose: () => void }) {
  const [places, setPlaces] = useState<PhotoPlace[] | null>(null)
  const [name, setName] = useState('')
  useEffect(() => { window.drive.places().then(setPlaces) }, [])
  const what = count === 1 ? 'this photo' : `${count} photos`
  const shown = places?.filter(p => !leaving || p.name.toLowerCase() !== leaving.toLowerCase())
  return (
    <Modal onClose={onClose}>
      <h3>{leaving ? `Move ${what} out of “${leaving}”` : `Move ${what} to a folder`}</h3>
      <p className="rule-hint">The file really moves, on this computer. Favorites, collections and people stay with it.</p>
      <div className="picker">
        {!shown ? <span className="spinner" /> : shown.map(p => (
          <button key={p.path} className="picker-row" onClick={() => { onClose(); onPick(p.path) }}>
            <span className="picker-cover"><Icon name="folder" /></span>
            <span>{p.name}<small>{p.path} · {p.count}</small></span>
          </button>
        ))}
      </div>
      <form className="new-folder" onSubmit={e => { e.preventDefault(); if (name.trim()) { onClose(); onPick(`Pictures/${name.trim()}`) } }}>
        <input className="field" maxLength={60} placeholder="New folder in Pictures" value={name} onChange={e => setName(e.target.value.replace(/[\\/]/g, ''))} />
        <button className="filled-button" disabled={!name.trim()}>Move</button>
      </form>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button></div>
    </Modal>
  )
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". */
export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** Choose tags or create one (Files, and Notes' labels): a set replaces what was there on Save. */
export function TagsDialog({ title, hint, initial, known, onSave, onClose }: { title: string; hint?: string; initial: string[]; known: string[]; onSave: (t: string[]) => Promise<void>; onClose: () => void }) {
  const [chosen, setChosen] = useState(new Set(initial))
  const [all, setAll] = useState([...new Set([...known, ...initial])].sort((a, b) => a.localeCompare(b)))
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const toggle = (t: string) => setChosen(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n })
  function add(e: React.FormEvent) {
    e.preventDefault()
    const t = draft.trim()
    if (!t || t.length > 32 || t.includes(',')) return setError('Tags must be 1\u201332 characters and cannot contain commas.')
    const existing = all.find(x => x.toLowerCase() === t.toLowerCase())
    if (!existing) setAll(a => [...a, t])
    setChosen(s => new Set(s).add(existing ?? t)); setDraft(''); setError('')
  }
  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      <div className="chips wrap">{all.map(t => <button key={t} className={`chip ${chosen.has(t) ? 'on' : ''}`} onClick={() => toggle(t)}>{t}</button>)}</div>
      <form onSubmit={add} className="tag-add">
        <input className="field" placeholder="New tag" maxLength={32} value={draft} onChange={e => { setDraft(e.target.value); setError('') }} />
        <button className="round" title="Add tag" disabled={!draft.trim()}><Icon name="add" /></button>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>Cancel</button>
        <button className="filled-button" onClick={async () => { try { await onSave([...chosen]); onClose() } catch (e) { setError(errorText(e)) } }}>Save</button>
      </div>
    </Modal>
  )
}
