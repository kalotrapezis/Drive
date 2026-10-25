import { useEffect, useState, type ReactNode } from 'react'
import type { TrashedPhoto } from './drive'
import { Icon } from './Icon'
import { Confirm } from './Dialogs'
import { lang, t } from './i18n'

const when = new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : lang(), { day: 'numeric', month: 'short', year: 'numeric' })

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
    say(failed.length ? t('photos.restoredSome', { n: restored.length, reason: failed[0] }) : t('photos.restored', { count: restored.length }))
    load(); onChanged()
  }

  const empty = () => setDialog(<Confirm title={t('files.emptyTrashTitle')} action={t('files.emptyTrashAction')} danger
    onClose={() => setDialog(null)}
    body={t('photos.emptyTrashBody')}
    onConfirm={async () => { say(t('photos.deletedPermanently', { count: await window.drive.trashEmpty() })); load() }} />)

  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island">
          <button className="round flat" title={t('common.back')} onClick={onBack}><Icon name="back" /></button>
          <Icon name="trash" /><h1>{t('photos.trash')}</h1>
        </div>
        <div className="tools">
          {picked.size > 0 && <button className="filled-button" onClick={restore}><Icon name="undo" size={20} /> {t('photos.restoreN', { count: picked.size })}</button>}
          {(items?.length ?? 0) > 0 && <button className="round danger" title={t('files.emptyTrash')} onClick={empty}><Icon name="deleteForever" /></button>}
        </div>
      </header>
      {items === null ? <div className="empty">{t('photos.readingTrash')}</div>
        : items.length === 0 ? <div className="empty">{t('photos.trashEmpty')}</div>
        : <div className="grid trash-grid">
            {items.map(item => (
              <button key={item.id} className={`cell${picked.has(item.id) ? ' picked' : ''}`} onClick={() => toggle(item.id)} title={t('photos.deletedOn', { path: item.path, date: when.format(item.deletedAt) })}>
                <img src={`media://trash/${encodeURIComponent(item.id)}`} alt="" loading="lazy" />
                {picked.has(item.id) && <span className="tick"><Icon name="checked" size={22} /></span>}
              </button>
            ))}
          </div>}
    </div>
  )
}
