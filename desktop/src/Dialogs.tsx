import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Collection } from './drive'
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

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". */
export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
