import { useEffect, useState } from 'react'
import type { Analysis, Person, Review } from './drive'
import { Icon } from './Icon'
import { Modal, errorText } from './Dialogs'

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
      <span>Analysing photos… {status.done.toLocaleString()} / {status.total.toLocaleString()}</span>
      <button className="text-button" onClick={() => window.drive.people.pause()}>Pause</button>
    </div>
  )
  return (
    <div className="island analysis">
      <Icon name="info" />
      <span>{status.error ? `Analysis stopped: ${status.error}` : enabled
        ? status.paused ? `Paused at ${status.done} of ${status.total}.` : 'New photos are analysed after each rescan.'
        : `${kind === 'people' ? 'Find people' : 'Find documents'} runs on this computer only. Nothing is uploaded.`}</span>
      <button className="filled-button" onClick={start}>{enabled ? (status.paused ? 'Resume' : 'Check again') : kind === 'people' ? 'Find people' : 'Find documents'}</button>
    </div>
  )
}

export function PeoplePage({ people, status, onOpen, onBack }: { people: Person[]; status: Analysis | null; onOpen: (p: Person) => void; onBack: () => void }) {
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>People</h1></div>
      </header>
      <AnalysisBar status={status} />
      {people.length === 0 && <p className="hint">{status?.enabled ? 'No people found yet.' : 'Start Find people to group the faces in your photos.'}</p>}
      <div className="people-grid">
        {people.map(p => (
          <button key={p.id} className="person" onClick={() => onOpen(p)}>
            <FaceCircle face={p.cover} />
            <strong>{p.name}</strong><small>{p.count}</small>
          </button>
        ))}
      </div>
    </div>
  )
}

export function RenamePerson({ person, onClose, onDone }: { person: Person; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(/^Person \d+$/.test(person.name) ? '' : person.name)
  const [error, setError] = useState('')
  return (
    <Modal onClose={onClose}>
      <form onSubmit={async e => { e.preventDefault(); try { onDone(await window.drive.people.rename(person.id, name)); onClose() } catch (err) { setError(errorText(err)) } }}>
        <div className="sheet-head"><FaceCircle face={person.cover} size={56} /><h3>Name this person</h3></div>
        <input className="field" autoFocus maxLength={60} placeholder={person.name} value={name} onChange={e => { setName(e.target.value); setError('') }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button className="filled-button" disabled={!name.trim()}>Save</button>
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
      <h3>Combine with {person.name}</h3>
      <p>Pick the same person shown more than once. Their photos move into {person.name}.</p>
      <input className="field" autoFocus placeholder="Find a person" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="picker">
        {choices.length === 0 && <p className="hint">{people.length > 1 ? 'No people match this name.' : 'There are no other people yet.'}</p>}
        {choices.map(p => (
          <button key={p.id} className={`picker-row ${chosen.has(p.id) ? 'on' : ''}`} onClick={() => toggle(p.id)}>
            <FaceCircle face={p.cover} size={44} /><span>{p.name}<small>{p.count}</small></span>
            <Icon name={chosen.has(p.id) ? 'checked' : 'unchecked'} size={22} />
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>Cancel</button>
        <button className="filled-button" disabled={picked.length === 0} onClick={() => { onClose(); onPick(picked) }}>
          {picked.length > 1 ? `Combine ${picked.length} people` : 'Combine'}
        </button>
      </div>
    </Modal>
  )
}

export function ReviewPage({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [review, setReview] = useState<Review | null | undefined>(undefined)
  const [doc, setDoc] = useState<{ sha256: string } | null>(null)
  // Phone order: document questions first, then faces.
  async function load() {
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
        <div className="island title-island"><button className="round flat" title="Back to Collections" onClick={onBack}><Icon name="back" /></button><h1>Help organize</h1></div>
      </header>
      {review === null && !doc && <div className="empty">Nothing needs a review right now.</div>}
      {doc && (
        <div className="island review">
          <h2>Is this a document?</h2>
          <img className="review-photo large" src={`media://thumb/${doc.sha256}`} alt="" />
          <div className="dialog-actions center">
            <button className="text-button" onClick={() => answer('skip')}>Skip</button>
            <button className="filled-button secondary" onClick={() => answer('no')}>No</button>
            <button className="filled-button" onClick={() => answer('yes')}>Yes, a document</button>
          </div>
        </div>
      )}
      {review && (
        <div className="island review">
          <h2>Is this the same person?</h2>
          <div className="review-faces">
            <div><FaceCircle face={review.faceId} size={160} /><small>This photo</small></div>
            <div><FaceCircle face={review.personFace} size={160} /><small>{review.name}</small></div>
          </div>
          <img className="review-photo" src={`media://thumb/${review.sha256}`} alt="" />
          <div className="dialog-actions center">
            <button className="text-button" onClick={() => answer('skip')}>Skip</button>
            <button className="filled-button secondary" onClick={() => answer('no')}>No</button>
            <button className="filled-button" onClick={() => answer('yes')}>Yes, same person</button>
          </div>
        </div>
      )}
    </div>
  )
}
