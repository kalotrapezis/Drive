import type { Collection } from './drive'
import { Icon, type IconName } from './Icon'
import { t } from './i18n'

export interface SystemCollection { id: string; name: string; icon: IconName; count: number }

export function Collections({ system, mine, onOpen, onNew, onDelete }: {
  system: SystemCollection[]; mine: Collection[]
  onOpen: (id: string, name: string) => void; onNew: () => void; onDelete: (c: Collection) => void
}) {
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><Icon name="collections" /><h1>{t('app.collections')}</h1></div>
        <button className="round" title={t('collections.new')} onClick={onNew}><Icon name="add" /></button>
      </header>
      <h2 className="section">{t('collections.system')}</h2>
      <div className="system-grid">
        {system.map(s => (
          <button key={s.id} className="system-card" onClick={() => onOpen(s.id, s.name)}>
            <Icon name={s.icon} /><span>{s.name}</span><small>{s.count}</small>
          </button>
        ))}
      </div>
      <h2 className="section">{t('collections.mine')}</h2>
      {mine.length === 0 && <p className="hint">{t('collections.createFirst')}</p>}
      <div className="cover-grid">
        {mine.map(c => (
          <div key={c.id} className="cover-card">
            <button className="cover" onClick={() => onOpen(c.id, c.name)}>
              {c.cover ? <img src={`media://thumb/${c.cover}`} alt="" /> : <Icon name={c.drive ? 'database' : 'collections'} size={48} />}
            </button>
            <div className="cover-label"><span>{c.name}</span><small>{c.count}</small></div>
            {!c.drive && <button className="round delete" title={t('collections.deleteNamed', { name: c.name })} onClick={() => onDelete(c)}><Icon name="trash" size={20} /></button>}
          </div>
        ))}
      </div>
      <p className="hint">{t('collections.deleteHint')}</p>
    </div>
  )
}
