import { useEffect, useState, type ReactNode } from 'react'
import type { TrashedPhoto } from './drive'
import { Icon } from './Icon'
import { Confirm } from './Dialogs'

const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Photos this app put in the system's trash. It offers the same two answers the phone does — put it back, or
 * finish the delete — and touches nothing else in the user's trash.
 */
export function TrashPage({ onBack, setDialog, say, onChanged }: {
  onBack: () => void
  setDialog: (d: ReactNode) => void
  say: (message: string) => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<TrashedPhoto[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const load = () => window.drive.trashList().then(list => { setItems(list); setPicked(new Set()) })
  useEffect(() => { load() }, [])

  const toggle = (id: string) => setPicked(p => { const next = new Set(p); next.has(id) ? next.delete(id) : next.add(id); return next })

  async function restore() {
    const { restored, failed } = await window.drive.trashRestore([...picked])
    say(failed.length ? `Restored ${restored.length}; ${failed[0]}` : `Restored ${restored.length} ${restored.length === 1 ? 'photo' : 'photos'}`)
    load(); onChanged()
  }

  const empty = () => setDialog(<Confirm title="Empty Trash?" action="Empty Trash permanently" danger
    onClose={() => setDialog(null)}
    body="Every photo this app put in the trash is deleted permanently. This cannot be undone, and the rest of your trash is left alone."
    onConfirm={async () => { say(`Deleted ${await window.drive.trashEmpty()} permanently`); load() }} />)

  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island">
          <button className="round flat" title="Back" onClick={onBack}><Icon name="back" /></button>
          <Icon name="trash" /><h1>Trash</h1>
        </div>
        <div className="tools">
          {picked.size > 0 && <button className="filled-button" onClick={restore}><Icon name="undo" size={20} /> Restore {picked.size}</button>}
          {(items?.length ?? 0) > 0 && <button className="round danger" title="Empty Trash" onClick={empty}><Icon name="deleteForever" /></button>}
        </div>
      </header>
      {items === null ? <div className="empty">Reading the trash…</div>
        : items.length === 0 ? <div className="empty">Trash is empty. Photos you delete wait here until you empty it.</div>
        : <div className="grid trash-grid">
            {items.map(item => (
              <button key={item.id} className={`cell${picked.has(item.id) ? ' picked' : ''}`} onClick={() => toggle(item.id)} title={`${item.path} · deleted ${when.format(item.deletedAt)}`}>
                <img src={`media://trash/${encodeURIComponent(item.id)}`} alt="" loading="lazy" />
                {picked.has(item.id) && <span className="tick"><Icon name="checked" size={22} /></span>}
              </button>
            ))}
          </div>}
    </div>
  )
}
