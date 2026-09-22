import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isScreenshot, matches, type Level, type Media } from './timeline'
import type { Analysis, Collection, MergeUndo, Person, VaultStatus } from './drive'
import { Icon, type IconName } from './Icon'
import { Timeline } from './Timeline'
import { Viewer } from './Viewer'
import { Collections } from './Collections'
import { CollectionPicker, Confirm, NewCollection, errorText } from './Dialogs'
import { Files, type FilesMode } from './Files'
import { AnalysisBar, CombinePicker, PeoplePage, RenamePerson, ReviewPage } from './People'
import { MapView } from './MapView'
import { HiddenPage, VaultGate } from './Hidden'
import { Editor } from './Editor'

type Page = { kind: 'photos' } | { kind: 'collections' } | { kind: 'collection'; id: string; name: string } | { kind: 'files'; mode: FilesMode; folder: string }
  | { kind: 'people' } | { kind: 'person'; id: string; name: string } | { kind: 'review' } | { kind: 'map'; focus?: string } | { kind: 'hidden' }

const SYSTEM: { id: string; name: string; icon: IconName; test: (m: Media) => boolean }[] = [
  { id: 'favorites', name: 'Favorites', icon: 'heart', test: m => !!m.favorite },
  { id: 'videos', name: 'Videos', icon: 'video', test: m => !!m.is_video },
  { id: 'screenshots', name: 'Screenshots', icon: 'screenshot', test: m => isScreenshot(m.path) },
  { id: 'documents', name: 'Documents', icon: 'document', test: m => !!m.document },
]

const stored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch {} }

export function App() {
  const [media, setMedia] = useState<Media[] | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Set<string> | null>(null)
  const [root, setRoot] = useState('')
  const [scan, setScan] = useState<string | null>('Looking for photos…')
  const [page, setPage] = useState<Page>({ kind: 'photos' })
  const [level, setLevel] = useState<Level>(() => (stored('level') as Level) || 'month')
  const [query, setQuery] = useState('')
  const [hideScreenshots, setHideScreenshots] = useState(() => stored('hideScreenshots') === '1')
  const [hideDocuments, setHideDocuments] = useState(() => stored('hideDocuments') === '1')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [names, setNames] = useState<Record<string, string[]>>({})
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [editing, setEditing] = useState<Media | null>(null)

  const custom = page.kind === 'collection' && !SYSTEM.some(s => s.id === page.id) ? page.id : null
  const memberSource = custom ? () => window.drive.members(custom) : page.kind === 'person' ? () => window.drive.people.shas(page.id) : null

  async function reload() {
    const [m, c, p, n, a, v] = await Promise.all([window.drive.list(), window.drive.collections(), window.drive.people.list(), window.drive.people.names(), window.drive.people.status(), window.drive.vault.status()])
    setMedia(m); setCollections(c); setPeople(p); setNames(n); setAnalysis(a); setVault(v)
    if (memberSource) setMembers(new Set(await memberSource()))
  }

  async function rescan() {
    setScan('Looking for photos…')
    try { await window.drive.scan() } catch (e) { say(errorText(e)) }
    await reload()
    setScan(null)
  }

  useEffect(() => {
    window.drive.info().then(i => setRoot(i.photosRoot))
    reload()
    const off = window.drive.onScanProgress(p => setScan(p.changed ? `Adding photos… ${p.changed} new` : `Checking… ${p.done}`))
    let wasRunning = false
    const offPeople = window.drive.people.onProgress(a => {
      setAnalysis(s => ({ ...s, ...a }))
      if (a.running) window.drive.people.list().then(setPeople) // people appear while analysis runs
      if (wasRunning && !a.running) reloadRef.current()
      wasRunning = a.running
    })
    rescan()
    return () => { off(); offPeople() }
  }, [])

  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => { store('level', level) }, [level])
  useEffect(() => { store('hideScreenshots', hideScreenshots ? '1' : '0') }, [hideScreenshots])
  useEffect(() => { store('hideDocuments', hideDocuments ? '1' : '0') }, [hideDocuments])
  useEffect(() => {
    setSelected(new Set()); setOpen(null); setMembers(null)
    if (memberSource) memberSource().then(m => setMembers(new Set(m)))
  }, [page])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.undo ? 8000 : 4000); return () => clearTimeout(t) }, [toast])

  const items = useMemo(() => {
    if (!media) return []
    if (page.kind === 'photos') return query.trim() ? media.filter(m => matches({ path: `${m.path} ${(names[m.sha256] ?? []).join(' ')} ${m.place_names ?? ''} ${m.labels ?? ''}` }, query)) : media.filter(m => !(hideScreenshots && isScreenshot(m.path)) && !(hideDocuments && m.document))
    if (page.kind === 'collection') {
      const system = SYSTEM.find(s => s.id === page.id)
      return system ? media.filter(system.test) : members ? media.filter(m => members.has(m.sha256)) : []
    }
    if (page.kind === 'person') return members ? media.filter(m => members.has(m.sha256)) : []
    if (page.kind === 'map') return media.filter(m => m.latitude != null && m.longitude != null)
    return []
  }, [media, page, query, hideScreenshots, hideDocuments, members, names])

  // Keep the viewer on a valid item when the list shrinks (trash, unfavorite in Favorites, remove from collection).
  useEffect(() => { if (open !== null && open >= items.length) setOpen(items.length ? items.length - 1 : null) }, [items, open])

  const picked = items.filter(m => selected.has(m.id))
  const say = (text: string, undo?: () => void) => setToast({ text, undo })
  const count = (n: number) => n === 1 ? '1 item' : `${n} items`
  const close = () => setDialog(null)

  async function run(fn: () => Promise<unknown>, done?: string) {
    try { await fn(); if (done) say(done) } catch (e) { say(errorText(e)) }
    await reload()
  }

  const favorite = (list: Media[]) => {
    const on = !list.every(m => m.favorite)
    return run(() => window.drive.favorite(list.map(m => m.sha256), on), list.length > 1 ? `${on ? 'Added' : 'Removed'} ${count(list.length)} ${on ? 'to' : 'from'} Favorites` : undefined)
  }

  function newCollection(then?: (c: Collection) => void) {
    setDialog(<NewCollection onClose={close} onCreate={async name => {
      const c = await window.drive.createCollection(name)
      await reload()
      if (then) then(c); else say(`Created “${c.name}”`)
    }} />)
  }

  function collect(list: Media[]) {
    const add = (c: Collection) => run(() => window.drive.setMembership(c.id, list.map(m => m.sha256), true), `Added ${count(list.length)} to “${c.name}”`)
    setDialog(<CollectionPicker collections={collections} count={list.length} onClose={close} onPick={add} onNew={() => newCollection(add)} />)
  }

  const uncollect = (list: Media[]) => custom && page.kind === 'collection' &&
    run(() => window.drive.setMembership(custom, list.map(m => m.sha256), false), `Removed ${count(list.length)} from “${page.name}”`)
      .then(() => setSelected(new Set()))

  function trash(list: Media[]) {
    setDialog(<Confirm title={`Move ${count(list.length)} to Trash?`} action="Move to Trash" danger onClose={close}
      body="They go to the system Trash and can be restored from your file manager. Favorites and collections come back with them."
      onConfirm={() => run(async () => {
        const r = await window.drive.trash(list.map(m => m.id))
        setSelected(new Set())
        say(r.failed.length ? `Moved ${r.trashed}; could not move ${r.failed.length}: ${r.failed.slice(0, 3).join(', ')}` : `Moved ${count(r.trashed)} to Trash`)
      })} />)
  }

  // Hidden needs the vault open: set it up or unlock it first, then encrypt, verify and remove the originals.
  function hide(list: Media[]) {
    const go = () => setDialog(<Confirm title={`Move ${count(list.length)} to Hidden?`} action="Move to Hidden" onClose={close}
      body="Each item is encrypted and checked, then removed from Photos. Only your passphrase can open Hidden."
      onConfirm={() => run(async () => {
        const r = await window.drive.vault.hide(list.map(m => m.id))
        setSelected(new Set())
        say(r.failed.length ? `Hid ${r.hidden}; ${r.failed.length} stayed in Photos: ${r.failed[0]}` : `Moved ${count(r.hidden)} to Hidden`)
      })} />)
    if (vault?.unlocked) go()
    else if (vault) setDialog(<VaultGate status={vault} onClose={close} onOpen={async () => { setVault(await window.drive.vault.status()); go() }} />)
  }

  function deleteCollection(c: Collection) {
    setDialog(<Confirm title={`Delete “${c.name}”?`} action="Delete collection" danger onClose={close}
      body="Only the collection is removed. Its photos and videos stay in Photos." onConfirm={() => run(() => window.drive.deleteCollection(c.id), `Deleted “${c.name}”`)} />)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open !== null || dialog || editing || (e.target as Element).closest?.('input')) return
      if (e.key === 'Escape' && selected.size) setSelected(new Set())
      else if ((e.ctrlKey || e.metaKey) && e.key === 'a' && items.length) { e.preventDefault(); setSelected(new Set(items.map(m => m.id))) }
      else if (e.key === 'Delete' && picked.length) trash(picked)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const person = page.kind === 'person' ? people.find(p => p.id === page.id) : undefined
  function renamePerson(p: Person) {
    setDialog(<RenamePerson person={p} onClose={close} onDone={name => { setPage({ kind: 'person', id: p.id, name }); reload() }} />)
  }
  function combine(p: Person) {
    setDialog(<CombinePicker person={p} people={people} onClose={close} onPick={other => run(async () => {
      const undo: MergeUndo = await window.drive.people.merge(other.id, p.id)
      say(`Combined ${other.name} into ${p.name}`, () => run(() => window.drive.people.undoMerge(undo), 'Combine undone'))
    })} />)
  }

  const nav = (target: Page, active: boolean, icon: IconName, label: string) => (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={() => setPage(target)}><Icon name={icon} />{label}</button>
  )
  const filesMode = page.kind === 'files' ? page.mode : null

  const loading = !media || (media.length === 0 && scan)
  let content: ReactNode
  if (page.kind === 'files') content = <Files mode={page.mode} folder={page.folder} go={(mode, folder) => setPage({ kind: 'files', mode, folder })} setDialog={setDialog} say={say} />
  else if (loading) content = <div className="empty">Loading…</div>
  else if (media.length === 0) content = <div className="empty"><p>No photos or videos in <code>{root}</code></p></div>
  else if (page.kind === 'people') content = <PeoplePage people={people} status={analysis} onBack={() => setPage({ kind: 'collections' })} onOpen={p => setPage({ kind: 'person', id: p.id, name: p.name })} />
  else if (page.kind === 'hidden') content = <HiddenPage onBack={() => setPage({ kind: 'collections' })} setDialog={setDialog} say={say} onChanged={reload} />
  else if (page.kind === 'map') content = <MapView items={items} focus={page.focus} onOpen={setOpen} onBack={() => setPage({ kind: 'collections' })} />
  else if (page.kind === 'review') content = <ReviewPage onBack={() => setPage({ kind: 'collections' })} onChanged={reload} />
  else if (page.kind === 'collections') {
    content = <Collections mine={collections} onNew={() => newCollection()} onDelete={deleteCollection}
      system={[
        { id: 'people', name: 'People', icon: 'person' as IconName, count: people.length },
        ...SYSTEM.map(s => ({ ...s, count: media.filter(s.test).length })),
        { id: 'hidden', name: 'Hidden', icon: 'lock' as IconName, count: vault?.count ?? 0 },
        { id: 'map', name: 'Map', icon: 'map' as IconName, count: media.filter(m => m.latitude != null).length },
        { id: 'review', name: 'Help organize', icon: 'tag' as IconName, count: analysis?.reviews ?? 0 },
      ]}
      onOpen={(id, name) => setPage(id === 'people' ? { kind: 'people' } : id === 'review' ? { kind: 'review' } : id === 'map' ? { kind: 'map' } : id === 'hidden' ? { kind: 'hidden' } : { kind: 'collection', id, name })} />
  } else {
    const inCollection = page.kind === 'collection' || page.kind === 'person'
    content = (
      <Timeline items={items} level={level} setLevel={setLevel} selected={selected} setSelected={setSelected} onOpen={setOpen}
        title={page.kind === 'person'
          ? <><button className="round flat" title="Back to People" onClick={() => setPage({ kind: 'people' })}><Icon name="back" /></button><h1>{page.name}</h1>
              {person && <><button className="round flat" title="Rename" onClick={() => renamePerson(person)}><Icon name="rename" size={20} /></button>
                <button className="round flat" title="Combine with another person" onClick={() => combine(person)}><Icon name="merge" size={20} /></button></>}</>
          : inCollection
          ? <><button className="round flat" title="Back to Collections" onClick={() => setPage({ kind: 'collections' })}><Icon name="back" /></button><h1>{page.name}</h1></>
          : <h1>Photos</h1>}
        banner={page.kind === 'collection' && page.id === 'documents' ? <AnalysisBar status={analysis} kind="documents" /> : undefined}
        empty={query ? `Nothing matches “${query}”.` : inCollection ? 'Nothing here yet.' : 'Every item is hidden by Photos tools.'}
        tools={!inCollection && <>
          <label className="island search">
            <Icon name="search" size={20} />
            <input placeholder="Search names and folders" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
            {query && <button className="eraser" title="Clear search" onClick={() => setQuery('')}><Icon name="eraser" size={20} /></button>}
          </label>
          <details className="menu">
            <summary className="round" title="Photos tools"><Icon name="tune" /></summary>
            <div className="island menu-body">
              <label><input type="checkbox" checked={hideScreenshots} onChange={e => setHideScreenshots(e.target.checked)} /> Hide screenshots in Photos</label>
              <label><input type="checkbox" checked={hideDocuments} onChange={e => setHideDocuments(e.target.checked)} /> Hide documents in Photos</label>
              <small>They stay in their collections and on disk.</small>
            </div>
          </details>
        </>} />
    )
  }

  return (
    <div className="app">
      <nav className="rail island">
        <div className="brand"><img src="./icon.png" alt="" />Local Drive</div>
        <small className="rail-head">Photos</small>
        {nav({ kind: 'photos' }, page.kind === 'photos', 'photos', 'Photos')}
        {nav({ kind: 'collections' }, ['collections', 'collection', 'people', 'person', 'review', 'map', 'hidden'].includes(page.kind), 'collections', 'Collections')}
        <small className="rail-head">Files</small>
        {nav({ kind: 'files', mode: 'browse', folder: '' }, filesMode === 'browse', 'drive', 'Drive')}
        {nav({ kind: 'files', mode: 'favorites', folder: '' }, filesMode === 'favorites', 'heart', 'Favorites')}
        {nav({ kind: 'files', mode: 'recent', folder: '' }, filesMode === 'recent', 'recent', 'Recent')}
        <div className="rail-foot">
          <span>{scan ?? `${media?.length ?? 0} items`}</span>
          <button className="round" title="Rescan library" disabled={!!scan} onClick={rescan}><Icon name="refresh" size={20} /></button>
        </div>
      </nav>
      <main className="content">
        {content}
        {picked.length > 0 && (
          <div className="island selection-bar">
            <button className="round flat" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
            <strong>{picked.length} selected</strong>
            <button className="round flat" title={picked.every(m => m.favorite) ? 'Remove from Favorites' : 'Add to Favorites'} onClick={() => favorite(picked)}>
              <Icon name={picked.every(m => m.favorite) ? 'heartFill' : 'heart'} /></button>
            {custom
              ? <button className="round flat" title="Remove from this collection" onClick={() => uncollect(picked)}><Icon name="uncollect" /></button>
              : <button className="round flat" title="Add to collection" onClick={() => collect(picked)}><Icon name="collect" /></button>}
            <button className="round flat" title="Move to Hidden" onClick={() => hide(picked)}><Icon name="lock" /></button>
            <button className="round flat" title="Move to Trash (Delete)" onClick={() => trash(picked)}><Icon name="trash" /></button>
          </div>
        )}
      </main>
      {open !== null && items[open] && (
        <Viewer media={items} index={open} setIndex={setOpen} onClose={() => setOpen(null)} people={names[items[open].sha256] ?? []}
          onShowOnMap={m => { setOpen(null); setPage({ kind: 'map', focus: m.sha256 }) }}
          onDocument={(m, on) => run(() => window.drive.documents.set(m.sha256, on), on ? 'Marked as a document' : 'No longer a document')}
          onFavorite={m => favorite([m])} onTrash={m => trash([m])} onHide={m => hide([m])} onEdit={setEditing}
          onCollect={custom ? undefined : m => collect([m])} onUncollect={custom ? m => uncollect([m]) : undefined} />
      )}
      {editing && <Editor item={editing} onClose={() => setEditing(null)} onSaved={msg => { setEditing(null); say(msg); reload() }} />}
      {dialog}
      {toast && <div className="island toast" role="status">{toast.text}
        {toast.undo && <button className="text-button" onClick={() => { const u = toast.undo!; setToast(null); u() }}>Undo</button>}</div>}
    </div>
  )
}
