import { useEffect, useState } from 'react'
import type { Analysis, DeviceFolder, Person, PersonFace, PersonMerge, Review } from './drive'
import { Icon } from './Icon'
import { Modal, errorText } from './Dialogs'
import { locale, t } from './i18n'

/** A name the analysis made up ("Person 41", kept as it is: devices match on it) in the window's language. */
export const shownName = (name: string) => { const n = /^Person (\d+)$/.exec(name); return n ? t('people.generatedName', { n: n[1] }) : name }

export const FaceCircle = ({ face, size = 96 }: { face: string | null; size?: number }) => (
  <span className="face" style={{ width: size, height: size }}>{face ? <img src={`media://face/${face}`} alt="" /> : <Icon name="photos" size={size / 2.5} />}</span>
)

/** Shared analysis control: explicit start, progress, pause. People and Documents are started separately, like the phone. */
export function AnalysisBar({ status, kind = 'people' }: { status: Analysis | null; kind?: 'people' | 'documents' }) {
  if (!status) return null
  const enabled = kind === 'people' ? status.enabled : status.documentsEnabled
  const start = () => kind === 'people' ? window.drive.people.start() : window.drive.documents.start()
  if (status.running) return (
    <div className="island analysis">
      <span className="spinner" />
      <span>{t('people.analysing', { done: status.done.toLocaleString(), total: status.total.toLocaleString() })}</span>
      <button className="text-button" onClick={() => window.drive.people.pause()}>{t('common.pause')}</button>
    </div>
  )
  return (
    <div className="island analysis">
      <Icon name="info" />
      <span>{status.error ? t('people.analysisStopped', { error: status.error }) : enabled
        ? status.paused ? t('people.pausedAt', { done: status.done, total: status.total }) : t('people.analysedAfterRescan')
        : kind === 'people' ? t('people.findPeopleRuns') : t('people.findDocumentsRuns')}</span>
      <button className="filled-button" onClick={start}>{enabled ? (status.paused ? t('common.resume') : t('people.checkAgain')) : kind === 'people' ? t('people.findPeople') : t('people.findDocuments')}</button>
    </div>
  )
}

/**
 * Which face a person is shown by. The best face the scores can find is a guess, and it is often not the one
 * you would have picked — a good photo of someone is not the sharpest crop of them. Hold a person to open this;
 * the choice is kept and travels to the phone, like their name.
 */
export function ChooseCover({ person, onClose, onDone }: { person: Person; onClose: () => void; onDone: () => void }) {
  const [faces, setFaces] = useState<PersonFace[] | null>(null)
  useEffect(() => { window.drive.people.faces(person.id).then(setFaces, () => setFaces([])) }, [person.id])
  const choose = async (faceId: string | null) => { await window.drive.people.setCover(person.id, faceId); onDone(); onClose() }
  return (
    <Modal onClose={onClose}>
      <h3>{t('people.showBy', { name: shownName(person.name) })}</h3>
      {faces === null && <p className="hint">{t('people.looking')}</p>}
      {faces?.length === 0 && <p className="hint">{t('people.noFacesYet')}</p>}
      {!!faces?.length && <p>{t('people.pickFace')}</p>}
      <div className="cover-choices">
        {faces?.map(f => (
          <button key={f.id} className={`cover-choice${f.chosen ? ' on' : ''}`} onClick={() => choose(f.id)} title={new Date(f.takenAt).toLocaleDateString(locale())}>
            <FaceCircle face={f.id} size={84} />
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        {faces?.some(f => f.chosen) && <button className="text-button" onClick={() => choose(null)}>{t('people.useBest')}</button>}
        <button className="filled-button" onClick={onClose}>{t('common.done')}</button>
      </div>
    </Modal>
  )
}

export function PeoplePage({ people, status, onOpen, onRename, onChooseCover, onForget, onHistory, onBack }: {
  people: Person[]; status: Analysis | null; onOpen: (p: Person) => void; onRename: (p: Person) => void
  onChooseCover: (p: Person) => void; onForget: (p: Person) => void; onHistory: () => void; onBack: () => void
}) {
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><button className="round flat" title={t('people.backToCollections')} onClick={onBack}><Icon name="back" /></button><h1>{t('people.title')}</h1></div>
        <button className="round island" title={t('people.historyTitle')} onClick={onHistory}><Icon name="recent" /></button>
      </header>
      <AnalysisBar status={status} />
      {people.length === 0 && <p className="hint">{status?.enabled ? t('people.noneFound') : t('people.startFind')}</p>}
      <div className="people-grid">
        {people.map(p => (
          <div key={p.id} className="person-wrap">
            <button className="person" onClick={() => onOpen(p)}
              onContextMenu={e => { e.preventDefault(); onChooseCover(p) }}
              title={t('people.personTitle', { name: shownName(p.name) })}>
              <FaceCircle face={p.cover} />
              <strong>{shownName(p.name)}</strong><small>{p.count}</small>
            </button>
            <details className="menu person-edit">
              <summary className="round" title={t('people.editPerson', { name: shownName(p.name) })}><Icon name="edit" size={18} /></summary>
              <div className="island menu-body" onClick={e => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
                <button className="sheet-row" onClick={() => onRename(p)}><Icon name="rename" />{t('common.rename')}</button>
                <button className="sheet-row" onClick={() => onChooseCover(p)}><Icon name="person" />{t('people.chooseFace')}</button>
                <button className="sheet-row" onClick={() => onForget(p)}><Icon name="visibilityOff" />{t('people.forget')}</button>
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Everything taken out of People, in one place: people forgotten, and groups combined into someone else.
 * Neither is lost, and putting one back is one click.
 */
export function PeopleHistory({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [forgotten, setForgotten] = useState<Person[] | null>(null)
  const [merges, setMerges] = useState<PersonMerge[] | null>(null)
  const load = () => {
    window.drive.people.forgotten().then(setForgotten, () => setForgotten([]))
    window.drive.people.mergeHistory().then(setMerges, () => setMerges([]))
  }
  useEffect(load, [])
  const when = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const back = async (fn: () => Promise<unknown>) => { await fn(); load(); onChanged() }
  return (
    <Modal onClose={onClose}>
      <h3>{t('people.history')}</h3>
      <span className="menu-head">{t('people.forgotten')}</span>
      {forgotten?.length === 0 && <p className="hint">{t('people.nobodyForgotten')}</p>}
      <div className="picker">
        {forgotten?.map(p => (
          <div key={p.id} className="picker-row">
            <FaceCircle face={p.cover} size={44} />
            <span>{shownName(p.name)}<small>{t('people.photos', { count: p.count })}</small></span>
            <button className="filled-button" onClick={() => back(() => window.drive.people.setHidden(p.id, false))}>{t('common.restore')}</button>
          </div>
        ))}
      </div>
      <span className="menu-head">{t('people.combined')}</span>
      {merges?.length === 0 && <p className="hint">{t('people.nothingCombined')}</p>}
      <div className="picker">
        {merges?.map(m => (
          <div key={m.id} className="picker-row">
            <FaceCircle face={m.cover} size={44} />
            <span>{shownName(m.name)}<small>{t('people.faces', { count: m.count })} · {when.format(m.mergedAt)}</small></span>
            <button className="filled-button" onClick={() => back(() => window.drive.people.restoreMerge(m.id))}>{t('common.restore')}</button>
          </div>
        ))}
      </div>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
}

export function RenamePerson({ person, onClose, onDone }: { person: Person; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(/^Person \d+$/.test(person.name) ? '' : person.name)
  const [error, setError] = useState('')
  return (
    <Modal onClose={onClose}>
      <form onSubmit={async e => { e.preventDefault(); try { onDone(await window.drive.people.rename(person.id, name)); onClose() } catch (err) { setError(errorText(err)) } }}>
        <div className="sheet-head"><FaceCircle face={person.cover} size={56} /><h3>{t('people.nameThis')}</h3></div>
        <input className="field" autoFocus maxLength={60} placeholder={shownName(person.name)} value={name} onChange={e => { setName(e.target.value); setError('') }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="filled-button" disabled={!name.trim()}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Phone: combine keeps the open person and moves the chosen duplicates into it. One face group is rarely the
 * only duplicate of a person, so this takes as many as are picked — searchable, because a library has hundreds.
 */
export function CombinePicker({ person, people, onClose, onPick }: { person: Person; people: Person[]; onClose: () => void; onPick: (others: Person[]) => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const choices = people.filter(p => p.id !== person.id && p.name.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (id: string) => setChosen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const picked = people.filter(p => chosen.has(p.id))
  return (
    <Modal onClose={onClose}>
      <h3>{t('people.combineWith', { name: shownName(person.name) })}</h3>
      <p>{t('people.combineHint', { name: shownName(person.name) })}</p>
      <input className="field" autoFocus placeholder={t('people.findPerson')} value={query} onChange={e => setQuery(e.target.value)} />
      <div className="picker">
        {choices.length === 0 && <p className="hint">{people.length > 1 ? t('people.noMatch') : t('people.noOthers')}</p>}
        {choices.map(p => (
          <button key={p.id} className={`picker-row ${chosen.has(p.id) ? 'on' : ''}`} onClick={() => toggle(p.id)}>
            <FaceCircle face={p.cover} size={44} /><span>{shownName(p.name)}<small>{p.count}</small></span>
            <Icon name={chosen.has(p.id) ? 'checked' : 'unchecked'} size={22} />
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="filled-button" disabled={picked.length === 0} onClick={() => { onClose(); onPick(picked) }}>
          {picked.length > 1 ? t('people.combineMany', { n: picked.length }) : t('people.combine')}
        </button>
      </div>
    </Modal>
  )
}

export function ReviewPage({ left, onBack, onChanged }: { left: number; onBack: () => void; onChanged: () => void }) {
  const [review, setReview] = useState<Review | null | undefined>(undefined)
  const [doc, setDoc] = useState<{ sha256: string } | null>(null)
  const [folders, setFolders] = useState<DeviceFolder[]>([])
  // Phone order: folders first, then documents, then faces.
  async function load() {
    setFolders((await window.drive.folders.list()).filter(f => f.included === null))
    const d = await window.drive.documents.nextReview()
    setDoc(d)
    setReview(d ? undefined : await window.drive.people.nextReview())
  }
  useEffect(() => { load() }, [])
  async function answer(a: 'yes' | 'no' | 'skip') {
    if (doc) await window.drive.documents.answer(doc.sha256, a)
    else await window.drive.people.answer(review!.faceId, review!.personId, a)
    onChanged(); load()
  }
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><button className="round flat" title={t('people.backToCollections')} onClick={onBack}><Icon name="back" /></button><h1>{t('people.helpOrganize')}</h1></div>
      </header>
      {folders.map(f => (
        <div key={f.name} className="island review">
          <h2>{t('people.includeFolder', { name: f.name })}</h2>
          <p className="hint center">{t('people.includeFolderHint', { count: f.count, name: f.name })}</p>
          <div className="folder-samples">{f.samples.map(s => <img key={s} src={`media://thumb/${s}`} alt="" />)}</div>
          <div className="dialog-actions center">
            <button className="filled-button secondary" onClick={() => window.drive.folders.set(f.name, false).then(() => { onChanged(); load() })}>{t('common.no')}</button>
            <button className="filled-button" onClick={() => window.drive.folders.set(f.name, true).then(() => { onChanged(); load() })}>{t('common.yes')}</button>
          </div>
        </div>
      ))}
      {review === null && !doc && folders.length === 0 && <div className="empty">{t('people.noMoreQuestions')}</div>}
      {doc && (
        <div className="island review">
          <h2>{t('people.isDocument')}</h2>
          <img className="review-photo large" src={`media://thumb/${doc.sha256}`} alt="" />
          <div className="dialog-actions center">
            <button className="text-button" onClick={() => answer('skip')}>{t('people.skip')}</button>
            <button className="filled-button secondary" onClick={() => answer('no')}>{t('common.no')}</button>
            <button className="filled-button" onClick={() => answer('yes')}>{t('people.yesDocument')}</button>
          </div>
        </div>
      )}
      {review && (
        <div className="island review">
          <h2>{t('people.samePerson')}</h2>
          <div className="review-faces">
            <div><FaceCircle face={review.faceId} size={160} /><small>{t('people.thisPhoto')}</small></div>
            <div><FaceCircle face={review.personFace} size={160} /><small>{shownName(review.name)}</small></div>
          </div>
          <img className="review-photo" src={`media://thumb/${review.sha256}`} alt="" />
          <div className="dialog-actions center">
            <button className="text-button" onClick={() => answer('skip')}>{t('people.skip')}</button>
            <button className="filled-button secondary" onClick={() => answer('no')}>{t('common.no')}</button>
            <button className="filled-button" onClick={() => answer('yes')}>{t('people.yesSame')}</button>
          </div>
        </div>
      )}
      {(doc || review || folders.length > 0) && left > 0 && <p className="hint center">{t('people.questionsLeft', { count: left })}</p>}
    </div>
  )
}

/**
 * Every group combined into this person, with the head and the number it had at the time. Combining is the one
 * action here that throws a grouping away, and the person it was wrong about cannot be reached afterwards — so
 * they are kept, and putting one back is a click rather than an undo you had to catch.
 */
export function MergeHistory({ person, onClose, onRestore }: { person: Person; onClose: () => void; onRestore: (m: PersonMerge) => void }) {
  const [merges, setMerges] = useState<PersonMerge[] | null>(null)
  useEffect(() => { window.drive.people.mergeHistory(person.id).then(setMerges, () => setMerges([])) }, [person.id])
  const when = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <Modal onClose={onClose}>
      <h3>{t('people.combinedInto', { name: shownName(person.name) })}</h3>
      {merges === null && <p className="hint">{t('people.looking')}</p>}
      {merges?.length === 0 && <p className="hint">{t('people.nothingCombinedInto')}</p>}
      {!!merges?.length && <p>{t('people.restoreHint')}</p>}
      <div className="picker">
        {merges?.map(m => (
          <div key={m.id} className="picker-row">
            <FaceCircle face={m.cover} size={44} />
            <span>{shownName(m.name)}<small>{t('people.faces', { count: m.count })} · {when.format(m.mergedAt)}</small></span>
            <button className="filled-button" onClick={() => { onClose(); onRestore(m) }}>{t('common.restore')}</button>
          </div>
        ))}
      </div>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
}
