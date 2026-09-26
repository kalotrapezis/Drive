import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isScreenshot, matches, type Level, type Media } from './timeline'
import type { Analysis, Collection, DeviceFolder, MergeUndo, Person, VaultStatus } from './drive'
import { Icon, type IconName } from './Icon'
import { Timeline } from './Timeline'
import { Viewer } from './Viewer'
import { Collections } from './Collections'
import { CollectionPicker, Confirm, FolderPicker, NewCollection, errorText } from './Dialogs'
import { Files, type FilesMode } from './Files'
import { TrashPage } from './TrashPage'
import { AnalysisBar, ChooseCover, CombinePicker, MergeHistory, PeopleHistory, PeoplePage, RenamePerson, ReviewPage } from './People'
import { MapView } from './MapView'
import { HiddenPage, VaultGate } from './Hidden'
import { Editor } from './Editor'
import { OffloadDialog, SyncPage } from './Sync'
import { NotesPage } from './Notes'
import { NotificationsPage, SettingsPage } from './Settings'
import { ImportDialog } from './Import'

type Page = { kind: 'photos' } | { kind: 'collections' } | { kind: 'collection'; id: string; name: string } | { kind: 'files'; mode: FilesMode; folder: string } | { kind: 'photoTrash' }
  | { kind: 'people' } | { kind: 'person'; id: string; name: string } | { kind: 'review' } | { kind: 'map'; focus?: string } | { kind: 'hidden' } | { kind: 'sync' } | { kind: 'notes' } | { kind: 'notifications' } | { kind: 'settings' }

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
  const [folders, setFolders] = useState<DeviceFolder[]>([])
  const [members, setMembers] = useState<Set<string> | null>(null)
  const [root, setRoot] = useState('')
  const [scan, setScan] = useState<string | null>('Looking for photos…')
  const [page, setPage] = useState<Page>({ kind: 'photos' })
  const [level, setLevel] = useState<Level>(() => (stored('level') as Level) || 'month')
  const [query, setQuery] = useState('')
  // These three describe the library, not this computer, so they come from the database and sync with the phone.
  const [hideScreenshots, setHideScreenshots] = useState(false)
  const [hideDocuments, setHideDocuments] = useState(false)
  const hiddenAlbums = collections.filter(c => c.hidden).map(c => c.id)
  const [hiddenAlbumShas, setHiddenAlbumShas] = useState<Set<string>>(new Set())
  const [trashCount, setTrashCount] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  // The photos the viewer pages through when it was opened from a map group; null is every item.
  const [scope, setScope] = useState<string[] | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [names, setNames] = useState<Record<string, string[]>>({})
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [editing, setEditing] = useState<Media | null>(null)
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    const count = () => window.drive.notifications.list().then(l => setUnread(l.filter(n => !n.read).length))
    count(); return window.drive.notifications.onChange(count)
  }, [page])

  // A drive is a collection of what is on it (sync.js driveMembers), on this PC only: photos leave it only by Remove.
  // In the sidebar under Drives, with its own Screenshots and Documents (drive:<id>:screenshots), to see what to delete.
  const [, driveId = null, driveFilter = null] = page.kind === 'collection' && page.id.startsWith('drive:') ? page.id.split(':') : []
  const custom = page.kind === 'collection' && !SYSTEM.some(s => s.id === page.id) ? (driveId ? `drive:${driveId}` : page.id) : null
  const driveName = driveId ? collections.find(c => c.id === custom)?.name ?? 'the drive' : ''
  const memberSource = custom ? () => window.drive.members(custom) : page.kind === 'person' ? () => window.drive.people.shas(page.id) : null

  async function reload() {
    const [m, c, p, n, a, v, f] = await Promise.all([window.drive.list(), window.drive.collections(), window.drive.people.list(), window.drive.people.names(), window.drive.people.status(), window.drive.vault.status(), window.drive.folders.list()])
    setMedia(m); setCollections(c); setPeople(p); setNames(n); setAnalysis(a); setVault(v); setFolders(f)
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
    const offSync = window.drive.sync.onReceived(() => reloadRef.current())
    const off = window.drive.onScanProgress(p => setScan(p.changed ? `Adding photos… ${p.changed} new` : `Checking… ${p.done}`))
    let wasRunning = false
    const offPeople = window.drive.people.onProgress(a => {
      setAnalysis(s => ({ ...s, ...a }))
      if (a.running) window.drive.people.list().then(setPeople) // people appear while analysis runs
      if (wasRunning && !a.running) reloadRef.current()
      wasRunning = a.running
    })
    rescan()
    return () => { off(); offPeople(); offSync() }
  }, [])

  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => { store('level', level) }, [level])
  // "Free 22 GB?" from the tray or a notification opens here, whatever page is showing (SYNC_PLAN.md D3).
  useEffect(() => window.drive.sync.onOffer(id => setDialog(<OffloadDialog deviceId={id} onClose={() => setDialog(null)} />)), [])
  useEffect(() => { window.drive.viewSettings().then(v => { setHideScreenshots(v.hideScreenshots); setHideDocuments(v.hideDocuments) }) }, [])
  useEffect(() => { window.drive.trashList().then(t => setTrashCount(t.length)).catch(() => {}) }, [page])
  useEffect(() => {
    Promise.all(hiddenAlbums.map(id => window.drive.members(id).catch(() => []))).then(lists => setHiddenAlbumShas(new Set(lists.flat())))
  }, [collections])
  useEffect(() => {
    setSelected(new Set()); setOpen(null); setScope(null); setMembers(null)
    if (memberSource) memberSource().then(m => setMembers(new Set(m)))
  }, [page])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.undo ? 8000 : 4000); return () => clearTimeout(t) }, [toast])

  const items = useMemo(() => {
    if (!media) return []
    if (page.kind === 'photos') return query.trim() ? media.filter(m => matches({ path: `${m.path} ${(names[m.sha256] ?? []).join(' ')} ${m.place_names ?? ''} ${m.labels ?? ''}` }, query)) : media.filter(m => !(hideScreenshots && isScreenshot(m.path)) && !(hideDocuments && m.document) && !hiddenAlbumShas.has(m.sha256))
    if (page.kind === 'collection') {
      const system = SYSTEM.find(s => s.id === page.id)
      const test = driveFilter === 'screenshots' ? (m: Media) => isScreenshot(m.path) : driveFilter === 'documents' ? (m: Media) => !!m.document : () => true
      return system ? media.filter(system.test) : members ? media.filter(m => members.has(m.sha256) && test(m)) : []
    }
    if (page.kind === 'person') return members ? media.filter(m => members.has(m.sha256)) : []
    if (page.kind === 'map') return media.filter(m => m.latitude != null && m.longitude != null)
    return []
  }, [media, page, query, hideScreenshots, hideDocuments, hiddenAlbumShas, members, names, driveFilter])

  // Keep the viewer on a valid item when the list shrinks (trash, unfavorite in Favorites, remove from collection).
  useEffect(() => { if (open !== null && open >= items.length) setOpen(items.length ? items.length - 1 : null) }, [items, open])
  // By hash, so trashing one from the viewer does not shift the rest; mapped back to indices into items.
  const scoped = useMemo(() => {
    if (!scope) return null
    const at = new Map(items.map((m, i) => [m.sha256, i]))
    return scope.map(h => at.get(h)).filter((i): i is number => i !== undefined)
  }, [scope, items])
  useEffect(() => { if (scoped?.length === 0) { setOpen(null); setScope(null) } }, [scoped])

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

  // A collection that is a folder is not a grouping: taking a photo out of it moves the file (asked 2026-09-25).
  const folderAlbum = custom && page.kind === 'collection' && collections.find(c => c.id === custom)?.folder ? page.name : null
  function moveTo(list: Media[], leaving?: string) {
    setDialog(<FolderPicker count={list.length} leaving={leaving} onClose={close} onPick={dest => run(async () => {
      const r = await window.drive.moveTo(list.map(m => m.id), dest)
      setSelected(new Set())
      say(r.failed.length ? `Moved ${r.moved}; ${r.failed.length} stayed: ${r.failed.slice(0, 2).join(', ')}` : `Moved ${count(r.moved)} to ${dest}`)
    })} />)
  }
  const uncollect = (list: Media[]) => driveId && page.kind === 'collection' ? setDialog(
    <Confirm title={`Take ${count(list.length)} off ${driveName}?`} action="Take off the drive" danger onClose={close}
      body={`Any that live only on ${driveName} come back to this PC first, checked. Copies of ones this PC has are deleted from the drive, and backup will not put them back unless you add them again.`}
      onConfirm={() => run(() => window.drive.setMembership(custom!, list.map(m => m.sha256), false), `Took ${count(list.length)} off ${driveName}`).then(() => setSelected(new Set()))} />)
    : folderAlbum ? moveTo(list, folderAlbum) : custom && page.kind === 'collection' &&
    run(() => window.drive.setMembership(custom, list.map(m => m.sha256), false), `Removed ${count(list.length)} from “${page.name}”`)
      .then(() => setSelected(new Set()))

  function trash(list: Media[]) {
    // In a drive's collection Delete is by hand and final for the library: to the purgatory, where it waits its days.
    if (driveId) return setDialog(<Confirm title={`Delete ${count(list.length)}?`} action="Delete" danger onClose={close}
      body={`They leave the library, from ${driveName} and from this PC. One copy waits in the purgatory for its days (Devices → Deleted items), then it is gone.`}
      onConfirm={() => run(async () => {
        const r = await window.drive.deleteFromDrive(driveId, list.map(m => m.sha256))
        setSelected(new Set())
        say(r.failed.length ? `Deleted ${r.deleted}; ${r.failed.length} stayed: ${r.failed.slice(0, 2).join(', ')}` : `Deleted ${count(r.deleted)} to the purgatory`)
      })} />)
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
    // Undo takes them back in the order they went in, so a face never lands in the wrong group on the way out.
    setDialog(<CombinePicker person={p} people={people} onClose={close} onPick={others => run(async () => {
      const undos: MergeUndo[] = []
      for (const other of others) undos.push(await window.drive.people.merge(other.id, p.id))
      const what = others.length === 1 ? others[0].name : `${others.length} people`
      say(`Combined ${what} into ${p.name}`, () => run(async () => {
        for (const undo of undos.reverse()) await window.drive.people.undoMerge(undo)
      }, 'Combine undone'))
    })} />)
  }

  const nav = (target: Page, active: boolean, icon: IconName, label: string) => (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={() => setPage(target)}><Icon name={icon} />{label}</button>
  )
  const filesMode = page.kind === 'files' && !(page.mode === 'browse' && page.folder.startsWith('Trash')) ? page.mode : null
  const inFilesTrash = page.kind === 'files' && page.mode === 'browse' && page.folder.startsWith('Trash')
  const section = page.kind === 'files' ? 'files' : driveId ? 'drive' : ['photos', 'collections', 'collection', 'people', 'person', 'review', 'map', 'hidden', 'photoTrash'].includes(page.kind) ? 'photos' : null
  const item = (target: Page, on: boolean, icon: IconName, label: string) => (
    <button className={`island-item ${on ? 'on' : ''}`} onClick={() => setPage(target)}><Icon name={icon} size={20} /><span>{label}</span></button>
  )
  const dock = section && (
    <div className="notes-dock"><nav className="notes-island island">
      {section === 'photos' && <>
        {item({ kind: 'photos' }, page.kind === 'photos', 'photos', 'Gallery')}
        {item({ kind: 'collections' }, page.kind !== 'photos', 'collections', 'Collections')}
        <span className="island-gap" />
        <button className="island-item" onClick={() => setDialog(<ImportDialog kind="photos" onClose={close} onDone={reload} />)}><Icon name="add" size={20} /><span>Import</span></button>
      </>}
      {section === 'files' && <>
        {item({ kind: 'files', mode: 'browse', folder: '' }, filesMode === 'browse', 'drive', 'Drive')}
        {item({ kind: 'files', mode: 'favorites', folder: '' }, filesMode === 'favorites', 'heart', 'Favorites')}
        {item({ kind: 'files', mode: 'recent', folder: '' }, filesMode === 'recent', 'recent', 'Recent')}
        {item({ kind: 'files', mode: 'browse', folder: 'Trash' }, inFilesTrash, 'trash', 'Trash')}
        <span className="island-gap" />
        <button className="island-item" onClick={() => setDialog(<ImportDialog kind="files" onClose={close} onDone={() => setPage({ kind: 'files', mode: 'browse', folder: '' })} />)}><Icon name="add" size={20} /><span>Import</span></button>
      </>}
      {section === 'drive' && <>
        {item({ kind: 'collection', id: `drive:${driveId}`, name: driveName }, !driveFilter, 'photos', 'Gallery')}
        {item({ kind: 'collection', id: `drive:${driveId}:screenshots`, name: `${driveName} · Screenshots` }, driveFilter === 'screenshots', 'screenshot', 'Screenshots')}
        {item({ kind: 'collection', id: `drive:${driveId}:documents`, name: `${driveName} · Documents` }, driveFilter === 'documents', 'document', 'Documents')}
      </>}
    </nav></div>
  )

  const loading = !media || (media.length === 0 && scan)
  let content: ReactNode
  // Pages that do not depend on the photo library come first: an empty library must not hide Devices, Files or Hidden.
  if (page.kind === 'files') content = <Files mode={page.mode} folder={page.folder} go={(mode, folder) => setPage({ kind: 'files', mode, folder })} setDialog={setDialog} say={say} dock={dock} />
  else if (page.kind === 'sync') content = <SyncPage setDialog={setDialog} />
  else if (page.kind === 'notes') content = <NotesPage setDialog={setDialog} say={say} />
  else if (page.kind === 'notifications') content = <NotificationsPage />
  else if (page.kind === 'settings') content = <SettingsPage />
  else if (page.kind === 'photoTrash') content = <TrashPage onBack={() => setPage({ kind: 'collections' })} setDialog={setDialog} say={say} onChanged={reload} />
  else if (page.kind === 'hidden') content = <HiddenPage onBack={() => setPage({ kind: 'collections' })} setDialog={setDialog} say={say} onChanged={reload} />
  else if (loading) content = <div className="empty">Loading…</div>
  else if (media.length === 0) content = <div className="empty"><p>No photos or videos in <code>{root}</code> yet. Pair your phone in <b>Devices</b> to back it up here.</p></div>
  else if (page.kind === 'people') content = <PeoplePage people={people} status={analysis} onBack={() => setPage({ kind: 'collections' })}
    onOpen={p => setPage({ kind: 'person', id: p.id, name: p.name })}
    onRename={p => setDialog(<RenamePerson person={p} onClose={close} onDone={reload} />)}
    onChooseCover={p => setDialog(<ChooseCover person={p} onClose={close} onDone={reload} />)}
    onForget={p => run(() => window.drive.people.setHidden(p.id, true), `${p.name} is forgotten`)}
    onHistory={() => setDialog(<PeopleHistory onClose={close} onChanged={reload} />)} />
  else if (page.kind === 'map') content = <MapView items={items} focus={page.focus} onOpen={(i, group) => { setScope(group ? group.map(g => items[g].sha256) : null); setOpen(i) }} onBack={() => setPage({ kind: 'collections' })} />
  else if (page.kind === 'review') content = <ReviewPage left={analysis?.reviews ?? 0} onBack={() => setPage({ kind: 'collections' })} onChanged={reload} />
  else if (page.kind === 'collections') {
    content = <Collections mine={collections} onNew={() => newCollection()} onDelete={deleteCollection}
      system={[
        { id: 'people', name: 'People', icon: 'person' as IconName, count: people.length },
        ...SYSTEM.map(s => ({ ...s, count: media.filter(s.test).length })),
        { id: 'hidden', name: 'Hidden', icon: 'lock' as IconName, count: vault?.count ?? 0 },
        { id: 'map', name: 'Map', icon: 'map' as IconName, count: media.filter(m => m.latitude != null).length },
        { id: 'review', name: 'Help organize', icon: 'tag' as IconName, count: analysis?.reviews ?? 0 },
        { id: 'photoTrash', name: 'Trash', icon: 'trash' as IconName, count: trashCount },
      ]}
      onOpen={(id, name) => setPage(id === 'people' ? { kind: 'people' } : id === 'review' ? { kind: 'review' } : id === 'map' ? { kind: 'map' } : id === 'hidden' ? { kind: 'hidden' } : id === 'photoTrash' ? { kind: 'photoTrash' } : { kind: 'collection', id, name })} />
  } else {
    const inCollection = page.kind === 'collection' || page.kind === 'person'
    content = (
      <Timeline items={items} level={level} setLevel={setLevel} selected={selected} setSelected={setSelected} onOpen={setOpen}
        title={page.kind === 'person'
          ? <><button className="round flat" title="Back to People" onClick={() => setPage({ kind: 'people' })}><Icon name="back" /></button><h1>{page.name}</h1></>
          : inCollection
          ? <>{!driveId && <button className="round flat" title="Back to Collections" onClick={() => setPage({ kind: 'collections' })}><Icon name="back" /></button>}<h1>{driveId ? driveName : page.name}</h1></>
          : <h1>Photos</h1>}
        banner={undefined /* "Find documents" hidden for now: desktop increasingly just receives the phone's classification via sync, SYNC_PLAN.md phase 6a */}
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
              <strong>Hide from Photos</strong>
              <small>Hidden albums stay in Collections and on disk; only the Photos view skips them.</small>
              <span className="menu-head">System albums</span>
              <label><input type="checkbox" checked={hideScreenshots} onChange={e => { setHideScreenshots(e.target.checked); window.drive.setViewSetting('hideScreenshots', e.target.checked) }} /> Screenshots</label>
              <label><input type="checkbox" checked={hideDocuments} onChange={e => { setHideDocuments(e.target.checked); window.drive.setViewSetting('hideDocuments', e.target.checked) }} /> Documents</label>
              <span className="menu-head">My albums</span>
              {collections.length === 0 && <small>No albums yet. Create one in Collections with +.</small>}
              {collections.filter(c => !c.drive).map(c => (
                <label key={c.id}><input type="checkbox" checked={c.hidden}
                  onChange={e => window.drive.setCollectionHidden(c.id, e.target.checked).then(reload)} /> {c.name}<small className="count">{c.count}</small></label>
              ))}
              <span className="menu-head">Folders</span>
              <small>Camera, Screenshots and loose photos are always shown. An included folder shows here and is kept as a collection; new ones are asked about in Help organize.</small>
              {folders.filter(f => f.included !== null).map(f => (
                <label key={f.name}><input type="checkbox" checked={!!f.included}
                  onChange={e => window.drive.folders.set(f.name, e.target.checked).then(reload)} /> {f.name}<small className="count">{f.count}</small></label>
              ))}
              <span className="menu-head">Look again</span>
              <small>Reads every photo again with the rules as they are now. People you have named keep their faces;
                only the groups nobody named are worked out afresh.</small>
              <button className="sheet-row" disabled={!!analysis?.running}
                onClick={() => run(() => window.drive.people.rescan(), 'Reading every photo again')}><Icon name="person" />Rescan faces</button>
              <button className="sheet-row" disabled={!!analysis?.running}
                onClick={() => run(() => window.drive.documents.rescan(), 'Reading every photo again')}><Icon name="fileDoc" />Rescan documents</button>
            </div>
          </details>
        </>} />
    )
  }

  return (
    <div className="app">
      <nav className="rail island">
        <div className="brand"><img src="./icon.png" alt="" />Tetra</div>
        {/* One entry each; their parts are an island at the bottom of the page (asked 2026-09-26). */}
        {nav({ kind: 'photos' }, section === 'photos', 'photos', 'Photos')}
        {nav({ kind: 'files', mode: 'browse', folder: '' }, section === 'files', 'drive', 'Files')}
        {nav({ kind: 'notes' }, page.kind === 'notes', 'notes', 'Notes')}
        {nav({ kind: 'sync' }, page.kind === 'sync', 'refresh', 'Devices')}
        {/* A drive is a device: its photos sit under Devices (asked 2026-09-26). */}
        {collections.filter(c => c.drive).map(c => <div key={c.id} className="rail-group">{nav({ kind: 'collection', id: c.id, name: c.name }, driveId === c.id.slice(6), 'database', c.name)}</div>)}
        {analysis?.running && (
          <div className="rail-progress">
            <span>Analysing… {analysis.done.toLocaleString()}/{analysis.total.toLocaleString()}</span>
            <progress value={analysis.done} max={Math.max(analysis.total, 1)} />
          </div>
        )}
        <div className="rail-bottom">
          <button className={`nav-item ${page.kind === 'notifications' ? 'active' : ''}`} onClick={() => setPage({ kind: 'notifications' })}>
            <Icon name="bell" />Notifications{unread > 0 && <span className="badge-count">{unread}</span>}</button>
          {nav({ kind: 'settings' }, page.kind === 'settings', 'settings', 'Settings')}
        </div>
        <div className="rail-foot">
          <span>{scan ?? `${media?.length ?? 0} items`}</span>
          <button className="round" title="Rescan library" disabled={!!scan} onClick={rescan}><Icon name="refresh" size={20} /></button>
        </div>
      </nav>
      <main className="content">
        {content}
        {section && section !== 'files' && ['photos', 'collections', 'collection'].includes(page.kind) && picked.length === 0 && dock}
        {page.kind === 'person' && person && picked.length === 0 && (
          <div className="island selection-bar person-bar">
            <button className="text-button" onClick={() => combine(person)}><Icon name="merge" size={20} />Combine</button>
            <button className="text-button" onClick={() => renamePerson(person)}><Icon name="rename" size={20} />Rename</button>
            <button className="text-button" onClick={() => setDialog(
              <MergeHistory person={person} onClose={close} onRestore={m => run(() => window.drive.people.restoreMerge(m.id), `${m.name} is back`)} />,
            )}><Icon name="undo" size={20} />History</button>
          </div>
        )}
        {picked.length > 0 && (
          <div className="island selection-bar">
            <button className="round flat" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
            <strong>{picked.length} selected</strong>
            <button className="round flat" title={picked.every(m => m.favorite) ? 'Remove from Favorites' : 'Add to Favorites'} onClick={() => favorite(picked)}>
              <Icon name={picked.every(m => m.favorite) ? 'heartFill' : 'heart'} /></button>
            {custom
              ? <button className="round flat" title={folderAlbum ? `Move out of the ${folderAlbum} folder` : 'Remove from this collection'} onClick={() => uncollect(picked)}><Icon name="uncollect" /></button>
              : <button className="round flat" title="Add to collection" onClick={() => collect(picked)}><Icon name="collect" /></button>}
            {!driveId && <>
              <button className="round flat" title="Move to folder…" onClick={() => moveTo(picked)}><Icon name="moveTo" /></button>
              <button className="round flat" title="Move to Hidden" onClick={() => hide(picked)}><Icon name="lock" /></button>
            </>}
            <button className="round flat" title={driveId ? 'Delete to the purgatory (Delete)' : 'Move to Trash (Delete)'} onClick={() => trash(picked)}><Icon name="trash" /></button>
            {page.kind === 'person' && person && (
              <button className="text-button" title="These are not this person" onClick={() => run(async () => {
                const r = await window.drive.people.detach(person.id, picked.map(m => m.sha256))
                setSelected(new Set())
                say(`${r.faces === 1 ? 'One face' : `${r.faces} faces`} taken out of ${person.name}`)
              })}><Icon name="uncollect" size={20} />Not this person</button>
            )}
          </div>
        )}
      </main>
      {open !== null && items[open] && (
        <Viewer media={scoped ? scoped.map(i => items[i]) : items} index={scoped ? Math.max(0, scoped.indexOf(open)) : open}
          setIndex={i => setOpen(scoped ? scoped[i] : i)} onClose={() => { setOpen(null); setScope(null) }} people={names[items[open].sha256] ?? []}
          onShowOnMap={m => { setOpen(null); setPage({ kind: 'map', focus: m.sha256 }) }}
          onDocument={(m, on) => run(() => window.drive.documents.set(m.sha256, on), on ? 'Marked as a document' : 'No longer a document')}
          onFavorite={m => favorite([m])} onTrash={m => trash([m])} onHide={driveId ? undefined : m => hide([m])} onEdit={driveId ? undefined : setEditing}
          onCollect={custom ? undefined : m => collect([m])} onUncollect={custom ? m => uncollect([m]) : undefined} onMove={driveId ? undefined : m => moveTo([m])}
          uncollectTitle={folderAlbum ? `Move out of the ${folderAlbum} folder` : undefined} />
      )}
      {editing && <Editor item={editing} onClose={() => setEditing(null)} onSaved={msg => { setEditing(null); say(msg); reload() }} />}
      {dialog}
      {toast && <div className="island toast" role="status">{toast.text}
        {toast.undo && <button className="text-button" onClick={() => { const u = toast.undo!; setToast(null); u() }}>Undo</button>}</div>}
    </div>
  )
}
