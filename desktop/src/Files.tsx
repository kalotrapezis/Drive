import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DriveItem } from './drive'
import { Icon, SYSTEM_FOLDER_ICONS, type IconName } from './Icon'
import { Confirm, Modal, TagsDialog, errorText } from './Dialogs'
import { formatBytes } from './timeline'
import { lang, t } from './i18n'

export type FilesMode = 'browse' | 'favorites' | 'recent'

// Same palette as the phone's DriveFolderColor.
export const FOLDER_COLORS: Record<string, string> = { Blue: '#4F86E8', Green: '#55A96B', Yellow: '#F2B544', Red: '#E3685F', Purple: '#AD68CF' }
const TYPE_ICON: Record<string, IconName> = {
  Folder: 'folderFill', Documents: 'fileDoc', Spreadsheets: 'fileSheet', PDF: 'filePdf', Text: 'fileText',
  Drawings: 'fileDraw', Pictures: 'fileImage', Videos: 'fileVideo', Other: 'file',
}
const TRASH = 'Trash'
const call = window.drive.files.call
const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }
const date = new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : lang(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const parentOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''

interface Props {
  mode: FilesMode; folder: string; go: (mode: FilesMode, folder: string) => void; dock?: ReactNode
  setDialog: (d: ReactNode) => void; say: (t: string) => void
}

export function Files({ mode, folder, go, setDialog, say, dock }: Props) {
  const setFolder = (f: string) => go('browse', f)
  const [items, setItems] = useState<DriveItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [view, setView] = useState(() => stored('filesView', 'list'))
  const [sort, setSort] = useState(() => stored('filesSort', 'name'))
  const [usage, setUsage] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const refresh = () => setVersion(v => v + 1)
  const close = () => setDialog(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const drag = useRef<{ add: boolean } | null>(null)
  const anchor = useRef<number | null>(null)
  const handled = useRef(false)
  const selecting = selected.size > 0

  useEffect(() => { setQuery(''); setTag(null) }, [mode, folder])
  useEffect(() => { setSelected(new Set()) }, [mode, folder, query, tag]) // leaving the list ends the selection
  useEffect(() => {
    const up = () => { drag.current = null }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(new Set()) }
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => { store('filesView', view) }, [view])
  useEffect(() => { store('filesSort', sort) }, [sort])

  useEffect(() => {
    let live = true
    const load = query.trim() ? call<DriveItem[]>('search', query) : tag ? call<DriveItem[]>('withTag', tag)
      : mode === 'favorites' ? call<DriveItem[]>('favorites') : mode === 'recent' ? call<DriveItem[]>('recents') : call<DriveItem[]>('list', folder)
    load.then(r => { if (live) { setItems(r); setError('') } }, e => { if (live) { setItems([]); setError(errorText(e)); if (folder) setFolder(parentOf(folder)) } })
    call<string[]>('tags').then(t => live && setTags(t))
    return () => { live = false }
  }, [mode, folder, query, tag, version])

  const sorted = useMemo(() => {
    if (!items) return []
    if (mode === 'recent' && !query && !tag) return items
    const byName = (a: DriveItem, b: DriveItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return [...items].sort((a, b) => Number(b.system) - Number(a.system) || Number(b.dir) - Number(a.dir) || (sort === 'date' ? b.mtime - a.mtime : byName(a, b)))
  }, [items, sort, mode, query, tag])

  async function act(fn: () => Promise<unknown>, done?: string) {
    try { await fn(); if (done) say(done) } catch (e) { say(errorText(e)) }
    refresh()
  }

  const picked = useMemo(() => sorted.filter(i => selected.has(i.path)), [sorted, selected])

  function apply(paths: string[], add: boolean) {
    const next = new Set(selected)
    for (const p of paths) add ? next.add(p) : next.delete(p)
    setSelected(next)
  }
  // The same gesture as the timeline: the check circle (or Ctrl+click) starts a selection, then click or drag
  // across rows; Shift+click takes the range.
  function pointerDown(e: React.PointerEvent, item: DriveItem) {
    if (e.button !== 0) return
    const i = sorted.indexOf(item)
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [anchor.current, i].sort((x, y) => x - y)
      apply(sorted.slice(a, b + 1).map(x => x.path), true)
    } else if (selecting || e.ctrlKey || e.metaKey || (e.target as Element).closest('.check')) {
      const add = !selected.has(item.path)
      apply([item.path], add)
      drag.current = { add }
      anchor.current = i
    } else return
    handled.current = true
    e.preventDefault()
  }
  function pointerEnter(item: DriveItem) {
    if (drag.current && selected.has(item.path) !== drag.current.add) apply([item.path], drag.current.add)
  }

  /** One action over everything picked, in one pass, with one refresh and the failures named. */
  async function actAll(items: DriveItem[], fn: (i: DriveItem) => Promise<unknown>, done: (n: number) => string) {
    const failures: string[] = []
    for (const item of items) {
      try { await fn(item) } catch (e) { failures.push(`${item.name}: ${errorText(e)}`) }
    }
    setSelected(new Set())
    say(failures.length ? failures.join(' · ') : done(items.length - failures.length))
    refresh()
  }

  function open(item: DriveItem) {
    if (item.dir) setFolder(item.path) // from Favorites, Recent or search this opens the folder in the browser
    else act(() => window.drive.files.open(item.path))
  }

  /** Send to phone (the user, 23 Oct): straight into the paired phone's Files › From computer. Files only. */
  async function sendToPhone(items: DriveItem[]) {
    const list = items.filter(i => !i.dir)
    if (!list.length) return say(t('files.sendOnlyFiles'))
    say(list.length === 1 ? t('files.sendingOne', { name: list[0].name }) : t('files.sendingMany', { count: list.length }))
    const r = await window.drive.files.sendToPhone(list.map(i => i.path)).catch(e => ({ error: errorText(e) }) as { sent?: number; device?: string; error?: string })
    setSelected(new Set())
    say(r.error ?? (r.sent === 1 ? t('files.sentOne', { name: list[0].name, device: r.device ?? '' }) : t('files.sentMany', { count: r.sent ?? 0, device: r.device ?? '' })))
  }

  function sheet(item: DriveItem) {
    const trashed = item.path === TRASH || item.path.startsWith(TRASH + '/')
    const system = item.system
    const row = (icon: IconName, label: string, fn: () => void, danger = false) =>
      <button className={`sheet-row ${danger ? 'danger' : ''}`} onClick={() => { close(); fn() }}><Icon name={icon} />{label}</button>
    setDialog(
      <Modal onClose={close}>
        <div className="sheet-head"><ItemIcon item={item} size={40} /><div><h3>{item.name}</h3><small>{parentOf(item.path) || t('files.drive')}</small></div></div>
        <div className="sheet-actions">
          <button onClick={() => { close(); pickDestination([item], 'copy') }}><span className="round"><Icon name="copy" /></span>{t('common.copy')}</button>
          {!system && <button onClick={() => { close(); pickDestination([item], 'move') }}><span className="round"><Icon name="moveTo" /></span>{trashed ? t('common.restore') : t('common.move')}</button>}
          {!system && <button onClick={() => { close(); rename(item) }}><span className="round"><Icon name="rename" /></span>{t('common.rename')}</button>}
        </div>
        {row(item.dir ? 'drive' : 'open', item.dir ? t('files.openFolder') : t('common.open'), () => open(item))}
        {row('folder', t('files.showInFileManager'), () => act(() => window.drive.files.reveal(item.path)))}
        {!item.dir && !trashed && row('device', t('files.sendToPhone'), () => sendToPhone([item]))}
        {!trashed && row(item.favorite ? 'heartFill' : 'heart', item.favorite ? t('files.removeFavorite') : t('files.addFavorite'),
          () => act(() => call('setFavorite', item.path, !item.favorite)))}
        {!trashed && row('tag', t('files.tags'), () => editTags([item]))}
        {item.dir && !trashed && row('palette', t('files.changeColour'), () => pickColor(item))}
        {row('info', t('files.properties'), () => properties(item))}
        {system && <p className="hint">{t('files.systemHint')}</p>}
        {!trashed && !system && row('trash', t('files.moveToTrash'), () => act(() => call('trash', item.path), t('files.movedToTrash', { name: item.name })), true)}
      </Modal>,
    )
  }

  async function pickDestination(items: DriveItem[], kind: 'copy' | 'move') {
    const all = await call<string[]>('destinations')
    const choices = all.filter(d => kind === 'copy' || items.every(it => !it.dir || (d !== it.path && !d.startsWith(it.path + '/'))))
    setDialog(
      <Modal onClose={close}>
        <h3>{items.length === 1 ? t(kind === 'copy' ? 'files.copyOneTo' : 'files.moveOneTo', { name: items[0].name }) : t(kind === 'copy' ? 'files.copyManyTo' : 'files.moveManyTo', { count: items.length })}</h3>
        <div className="picker">
          {choices.map(d => (
            <button key={d} className="picker-row" style={{ paddingLeft: 8 + (d ? d.split('/').length : 0) * 18 }}
              onClick={() => { close(); actAll(items, i => call(kind, i.path, d), n => n === 1 ? t(kind === 'copy' ? 'files.copiedOne' : 'files.movedOne', { name: items[0].name, dest: d || t('files.drive') }) : t(kind === 'copy' ? 'files.copiedMany' : 'files.movedMany', { count: n, dest: d || t('files.drive') })) }}>
              <Icon name={d ? 'folder' : 'drive'} />{d ? d.split('/').pop() : t('files.drive')}
            </button>
          ))}
        </div>
        <p className="hint">{t('files.neverOverwrite')}{kind === 'copy' ? ' ' + t('files.copyVerified') : ''}</p>
        <div className="dialog-actions"><button className="text-button" onClick={close}>{t('common.cancel')}</button></div>
      </Modal>,
    )
  }

  function rename(item: DriveItem) {
    setDialog(<RenameDialog item={item} onClose={close} onRename={async name => { await call('rename', item.path, name); refresh() }} />)
  }
  function editTags(items: DriveItem[]) {
    setDialog(<TagsDialog title={items.length > 1 ? t('files.tagsForMany', { count: items.length }) : t('files.tagsForOne', { name: items[0].name })}
      hint={items.length > 1 ? t('files.tagsReplace') : undefined}
      initial={items.length > 1 ? [] : items[0].tags} known={[...tags, ...items.flatMap(i => i.tags)]} onClose={close}
      onSave={async names => { await actAll(items, i => call('setTags', i.path, names), n => n === 1 ? t('files.tagsSaved') : t('files.tagsSavedMany', { count: n })) }} />)
  }
  function pickColor(item: DriveItem) {
    setDialog(
      <Modal onClose={close}>
        <h3>{t('files.folderColour')}</h3>
        <div className="swatches">
          <button className={`swatch none ${!item.color ? 'on' : ''}`} title={t('files.colourDefault')} onClick={() => { close(); act(() => call('setColor', item.path, null)) }} />
          {Object.entries(FOLDER_COLORS).map(([name, hex]) => (
            <button key={name} className={`swatch ${item.color === name ? 'on' : ''}`} title={t(`files.colour${name}`)} style={{ background: hex }}
              onClick={() => { close(); act(() => call('setColor', item.path, name)) }} />
          ))}
        </div>
        <div className="dialog-actions"><button className="text-button" onClick={close}>{t('common.cancel')}</button></div>
      </Modal>,
    )
  }
  async function properties(item: DriveItem) {
    try {
      const p = await call<DriveItem & { files: number; absolute: string }>('properties', item.path)
      setDialog(
        <Modal onClose={close}>
          <h3>{p.name}</h3>
          <dl className="props">
            <dt>{t('files.propType')}</dt><dd>{t(`files.type${p.type}`)}</dd>
            <dt>{t('files.propLocation')}</dt><dd>Drive/{p.path}</dd>
            <dt>{t('files.propSize')}</dt><dd>{formatBytes(p.size)}{p.dir ? t('files.propFiles', { count: p.files }) : ''}</dd>
            <dt>{t('files.propModified')}</dt><dd>{date.format(p.mtime)}</dd>
            {p.tags.length > 0 && <><dt>{t('files.tags')}</dt><dd>{p.tags.join(', ')}</dd></>}
          </dl>
          <div className="dialog-actions">
            <button className="text-button" onClick={close}>{t('common.close')}</button>
            <button className="filled-button" onClick={() => { close(); open(p) }}>{t('common.open')}</button>
          </div>
        </Modal>,
      )
    } catch (e) { say(errorText(e)) }
  }
  async function chooseSystemFolders() {
    try {
      const chosen = await call<string[]>('chosenFolders')
      const save = (names: string[], contents = 'out') => { close(); act(() => call('chooseSystemFolders', names, contents), t('files.systemFoldersSaved')) }
      setDialog(<SystemFoldersDialog initial={chosen} onClose={close} onSave={async names => {
        // A folder left out goes; one with something in it asks first where that goes (asked 17 Oct).
        const leftOut = chosen.filter(n => !names.includes(n))
        const full = (await Promise.all(leftOut.map(n => call<DriveItem[]>('list', n).then(l => l.length ? n : null, () => null)))).filter(n => n !== null)
        if (!full.length) return save(names)
        setDialog(
          <Modal onClose={close}>
            <h3>{full.length === 1 ? t('files.fullOne', { name: full[0] }) : t('files.fullMany', { names: full.slice(0, -1).join(', '), last: full.at(-1)! })}</h3>
            <p>{t(full.length === 1 ? 'files.fullBodyOne' : 'files.fullBodyMany')}</p>
            <div className="dialog-actions">
              <button className="text-button" onClick={close}>{t('common.cancel')}</button>
              <button className="text-button" onClick={() => save(names, 'trash')}>{t('files.moveToTrash')}</button>
              <button className="filled-button" autoFocus onClick={() => save(names, 'out')}>{t('files.moveFilesOut')}</button>
            </div>
          </Modal>,
        )
      }} />)
    } catch (e) { say(errorText(e)) }
  }
  function emptyTrash() {
    setDialog(<Confirm title={t('files.emptyTrashTitle')} action={t('files.emptyTrashAction')} danger onClose={close}
      body={t('files.emptyTrashBody')}
      onConfirm={() => act(async () => say(t('files.deletedPermanently', { count: await call<number>('emptyTrash') })))} />)
  }

  const crumbs = folder ? folder.split('/') : []
  const inTrash = mode === 'browse' && (folder === TRASH || folder.startsWith(TRASH + '/'))
  const searching = !!query.trim() || !!tag
  const title = mode === 'favorites' ? t('files.favorites') : mode === 'recent' ? t('files.recent') : null

  return (
    <div className={`timeline files ${selecting ? 'selecting' : ''}`} onContextMenu={e => e.preventDefault()}>
      <header className="topbar">
        <div className="island title-island crumbs">
          {mode === 'browse' && folder && <button className="round flat" title={t('files.up')} onClick={() => setFolder(parentOf(folder))}><Icon name="back" /></button>}
          {title ? <h1>{title}</h1> : <>
            <button className="crumb" onClick={() => setFolder('')}><h1>{t('files.drive')}</h1></button>
            {crumbs.map((c, i) => <span key={i}><span className="sep">›</span><button className="crumb" onClick={() => setFolder(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </>}
          {inTrash && folder === TRASH && <button className="round flat" title={t('files.emptyTrash')} onClick={emptyTrash}><Icon name="deleteForever" /></button>}
        </div>
        <div className="tools">
          <label className="island search">
            <Icon name="search" size={20} />
            <input placeholder={t('files.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
            {query && <button className="eraser" title={t('files.clearSearch')} onClick={() => setQuery('')}><Icon name="eraser" size={20} /></button>}
          </label>
          <details className="menu" onToggle={e => { if ((e.target as HTMLDetailsElement).open) call<Record<string, number>>('usage').then(setUsage) }}>
            <summary className="round" title={t('files.tools')}><Icon name="tune" /></summary>
            <div className="island menu-body">
              <div className="seg-row"><span>{t('files.view')}</span>
                <div className="mini-seg">{(['list', 'grid'] as const).map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={t(v === 'list' ? 'files.viewList' : 'files.viewGrid')}><Icon name={v} size={20} /></button>)}</div></div>
              <div className="seg-row"><span>{t('files.sort')}</span>
                <div className="mini-seg">{(['name', 'date'] as const).map(s => <button key={s} className={sort === s ? 'on' : ''} onClick={() => setSort(s)}>{s === 'name' ? t('common.name') : t('files.propModified')}</button>)}</div></div>
              <button className="sheet-row" onClick={() => act(() => window.drive.files.open(folder))}><Icon name="folder" />{t('files.openInFileManager')}</button>
              <button className="sheet-row" onClick={chooseSystemFolders}><Icon name="folderOthers" />{t('files.systemFolders')}</button>
              {usage && <Usage usage={usage} />}
            </div>
          </details>
          <button className="round" title={t('files.refresh')} onClick={refresh}><Icon name="refresh" size={20} /></button>
        </div>
      </header>

      {tags.length > 0 && (
        <div className="chips">
          <Icon name="tag" size={18} />
          {tags.map(t => <button key={t} className={`chip ${tag === t ? 'on' : ''}`} onClick={() => { setQuery(''); setTag(tag === t ? null : t) }}>{t}</button>)}
        </div>
      )}

      {error && <p className="hint">{error}</p>}
      {items && sorted.length === 0 && (
        <div className="empty">{searching ? t('files.noMatch') : mode === 'favorites' ? t('files.noFavorites') : mode === 'recent' ? t('files.noRecent') : inTrash ? t('files.trashEmpty') : t('files.folderEmpty')}</div>
      )}
      <div className={view === 'grid' ? 'file-grid' : 'file-list'}>
        {sorted.map(item => (
          <div key={item.path} className={`file ${selected.has(item.path) ? 'selected' : ''}`} role="button" tabIndex={0}
            onPointerDown={e => pointerDown(e, item)} onPointerEnter={() => pointerEnter(item)}
            onClick={() => { if (handled.current) handled.current = false; else open(item) }}
            onKeyDown={e => { if (e.key === 'Enter') open(item) }}
            onContextMenu={e => { e.preventDefault(); sheet(item) }}>
            {item.thumb ? <FileThumb item={item} iconSize={view === 'grid' ? 56 : 28} /> : <ItemIcon item={item} size={view === 'grid' ? 56 : 28} />}
            <span className="check" title={t('files.select')}><Icon name={selected.has(item.path) ? 'checked' : 'unchecked'} size={22} /></span>
            <div className="file-name">
              <span>{item.name}{item.favorite && <Icon name="heartFill" size={14} />}</span>
              {(searching || mode !== 'browse') && <small>{parentOf(item.path) || t('files.drive')}</small>}
              {item.tags.length > 0 && <span className="file-tags">{item.tags.map(t => <em key={t}>{t}</em>)}</span>}
            </div>
            {view === 'list' && <small className="file-meta">{date.format(item.openedAt ?? item.mtime)}</small>}
            {view === 'list' && <small className="file-meta size">{item.dir ? '' : formatBytes(item.size)}</small>}
            <button className="round flat more" title={t('files.more')} onClick={e => { e.stopPropagation(); sheet(item) }}><Icon name="more" /></button>
          </div>
        ))}
      </div>

      {picked.length === 0 && dock}
      {picked.length > 0 && (
        <div className="island selection-bar">
          <button className="round flat" title={t('files.clearSelection')} onClick={() => setSelected(new Set())}><Icon name="close" /></button>
          <strong>{t('files.selected', { count: picked.length })}</strong>
          {inTrash ? (
            <button className="round flat" title={t('files.restoreFromTrash')}
              onClick={() => actAll(picked, i => call('move', i.path, ''), n => t('files.restored', { count: n }))}><Icon name="undo" /></button>
          ) : <>
            <button className="round flat" title={t('files.copyToTitle')} onClick={() => pickDestination(picked, 'copy')}><Icon name="copy" /></button>
            <button className="round flat" title={t('files.moveToTitle')} onClick={() => pickDestination(picked, 'move')}><Icon name="moveTo" /></button>
            <button className="round flat" title={t('files.tags')} onClick={() => editTags(picked)}><Icon name="tag" /></button>
            {picked.some(i => !i.dir) && <button className="round flat" title={t('files.sendToPhone')} onClick={() => sendToPhone(picked)}><Icon name="device" /></button>}
            <button className="round flat" title={picked.every(i => i.favorite) ? t('files.removeFavorite') : t('files.addFavorite')}
              onClick={() => { const on = !picked.every(i => i.favorite); actAll(picked, i => call('setFavorite', i.path, on), n => t(on ? 'files.addedFav' : 'files.removedFav', { count: n })) }}>
              <Icon name={picked.every(i => i.favorite) ? 'heartFill' : 'heart'} /></button>
            <button className="round flat" title={t('files.moveToTrash')}
              onClick={() => actAll(picked, i => call('trash', i.path), n => t('files.movedManyToTrash', { count: n }))}><Icon name="trash" /></button>
          </>}
        </div>
      )}
    </div>
  )
}

/** Files' system folders (files.js), each with its emblem drawn into the folder; the optional ones in their own colour too. */
const SYSTEM_ICON: Record<string, IconName> = { Documents: 'folderDocuments', 'Documents/Scanned Documents': 'folderScans', Calendar: 'calendar' }
const systemLook = (item: DriveItem) => item.system ? SYSTEM_FOLDER_ICONS[item.path] : undefined

function ItemIcon({ item, size }: { item: DriveItem; size: number }) {
  // a file of a known category: its icon in its own colours (the user's tiles, 24 Oct)
  if (!item.dir && item.icon) return <span className="file-icon"><img className="kind-icon" src={`kinds/${item.icon}.png`} width={size} height={size} draggable={false} alt="" /></span>
  return <span className="file-icon" style={{ color: item.dir ? (item.color ? FOLDER_COLORS[item.color] : systemLook(item)?.[1]) : undefined }}>
    <Icon name={item.path === TRASH ? 'trash' : SYSTEM_ICON[item.path] ?? systemLook(item)?.[0] ?? TYPE_ICON[item.type] ?? 'file'} size={size} />
  </span>
}

/** A file's thumbnail (thumbs.js), with no icon over it (the user, 24 Oct); a file with none shows its icon. */
function FileThumb({ item, iconSize }: { item: DriveItem; iconSize: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [item.path, item.mtime])
  if (failed) return <ItemIcon item={item} size={iconSize} />
  return <span className="file-thumb">
    <img src={`media://filethumb/${encodeURIComponent(item.path)}?v=${item.mtime}`} loading="lazy" decoding="async" draggable={false} alt=""
      onError={() => setFailed(true)} />
  </span>
}

/** Files tools › System folders: every folder's emblem, click to choose or leave it, OK to keep the choice (the phone's sheet). */
function SystemFoldersDialog({ initial, onClose, onSave }: { initial: string[]; onClose: () => void; onSave: (names: string[]) => unknown }) {
  const [chosen, setChosen] = useState(() => new Set(initial))
  const flip = (name: string) => setChosen(c => { const n = new Set(c); n.has(name) ? n.delete(name) : n.add(name); return n })
  return (
    <Modal onClose={onClose}>
      <h3>{t('files.systemFolders')}</h3>
      <p className="hint">{t('files.systemFoldersHint')}</p>
      <div className="system-folders">
        {Object.entries(SYSTEM_FOLDER_ICONS).map(([name, [icon, tint]]) => (
          <button key={name} className={chosen.has(name) ? 'on' : ''} style={{ '--tint': tint } as React.CSSProperties}
            aria-pressed={chosen.has(name)} onClick={() => flip(name)}>
            <span className="emblem"><Icon name={icon} size={44} />{chosen.has(name) && <span className="tick"><Icon name="checked" size={20} /></span>}</span>
            {name}
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="filled-button" onClick={() => onSave([...chosen])}>{t('common.ok')}</button>
      </div>
    </Modal>
  )
}

function Usage({ usage }: { usage: Record<string, number> }) {
  const total = Object.values(usage).reduce((a, b) => a + b, 0)
  return (
    <div className="usage">
      <strong>{t('files.driveUses', { size: formatBytes(total) })}</strong>
      {Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
        <div key={k} className="usage-row"><span>{t(`files.type${k}`)}</span><div className="bar"><i style={{ width: `${(v / total) * 100}%` }} /></div><small>{formatBytes(v)}</small></div>
      ))}
    </div>
  )
}

function RenameDialog({ item, onRename, onClose }: { item: DriveItem; onRename: (n: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(item.name)
  const [error, setError] = useState('')
  return (
    <Modal onClose={onClose}>
      <form onSubmit={async e => { e.preventDefault(); try { await onRename(name); onClose() } catch (err) { setError(errorText(err)) } }}>
        <h3>{t('common.rename')}</h3>
        <input className="field" autoFocus value={name} onChange={e => { setName(e.target.value); setError('') }}
          onFocus={e => { const dot = item.dir ? -1 : item.name.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : item.name.length) }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="filled-button" disabled={!name.trim() || name === item.name}>{t('common.rename')}</button>
        </div>
      </form>
    </Modal>
  )
}

