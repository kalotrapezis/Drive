import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DriveItem } from './drive'
import { Icon, SYSTEM_FOLDER_ICONS, type IconName } from './Icon'
import { Confirm, Modal, TagsDialog, errorText } from './Dialogs'
import { formatBytes } from './timeline'

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
const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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
    if (!list.length) return say('Only files can be sent, not folders.')
    say(`Sending ${list.length === 1 ? `\u201c${list[0].name}\u201d` : `${list.length} files`} to the phone\u2026`)
    const r = await window.drive.files.sendToPhone(list.map(i => i.path)).catch(e => ({ error: errorText(e) }) as { sent?: number; device?: string; error?: string })
    setSelected(new Set())
    say(r.error ?? `Sent ${r.sent === 1 ? list[0].name : `${r.sent} files`} to ${r.device}`)
  }

  function sheet(item: DriveItem) {
    const trashed = item.path === TRASH || item.path.startsWith(TRASH + '/')
    const system = item.system
    const row = (icon: IconName, label: string, fn: () => void, danger = false) =>
      <button className={`sheet-row ${danger ? 'danger' : ''}`} onClick={() => { close(); fn() }}><Icon name={icon} />{label}</button>
    setDialog(
      <Modal onClose={close}>
        <div className="sheet-head"><ItemIcon item={item} size={40} /><div><h3>{item.name}</h3><small>{parentOf(item.path) || 'Drive'}</small></div></div>
        <div className="sheet-actions">
          <button onClick={() => { close(); pickDestination([item], 'copy') }}><span className="round"><Icon name="copy" /></span>Copy</button>
          {!system && <button onClick={() => { close(); pickDestination([item], 'move') }}><span className="round"><Icon name="moveTo" /></span>{trashed ? 'Restore' : 'Move'}</button>}
          {!system && <button onClick={() => { close(); rename(item) }}><span className="round"><Icon name="rename" /></span>Rename</button>}
        </div>
        {row(item.dir ? 'drive' : 'open', item.dir ? 'Open folder' : 'Open', () => open(item))}
        {row('folder', 'Show in file manager', () => act(() => window.drive.files.reveal(item.path)))}
        {!item.dir && !trashed && row('device', 'Send to phone', () => sendToPhone([item]))}
        {!trashed && row(item.favorite ? 'heartFill' : 'heart', item.favorite ? 'Remove from Favorites' : 'Add to Favorites',
          () => act(() => call('setFavorite', item.path, !item.favorite)))}
        {!trashed && row('tag', 'Tags', () => editTags([item]))}
        {item.dir && !trashed && row('palette', 'Change folder colour', () => pickColor(item))}
        {row('info', 'Properties', () => properties(item))}
        {system && <p className="hint">A system folder: Tetra keeps it, so it cannot be moved, renamed or deleted. Everything inside it can.</p>}
        {!trashed && !system && row('trash', 'Move to Trash', () => act(() => call('trash', item.path), `Moved “${item.name}” to Trash`), true)}
      </Modal>,
    )
  }

  async function pickDestination(items: DriveItem[], kind: 'copy' | 'move') {
    const all = await call<string[]>('destinations')
    const choices = all.filter(d => kind === 'copy' || items.every(it => !it.dir || (d !== it.path && !d.startsWith(it.path + '/'))))
    const what = items.length === 1 ? `\u201c${items[0].name}\u201d` : `${items.length} items`
    setDialog(
      <Modal onClose={close}>
        <h3>{kind === 'copy' ? 'Copy' : 'Move'} {what} to\u2026</h3>
        <div className="picker">
          {choices.map(d => (
            <button key={d} className="picker-row" style={{ paddingLeft: 8 + (d ? d.split('/').length : 0) * 18 }}
              onClick={() => { close(); actAll(items, i => call(kind, i.path, d), n => `${kind === 'copy' ? 'Copied' : 'Moved'} ${n === 1 ? items[0].name : `${n} items`} to ${d || 'Drive'}`) }}>
              <Icon name={d ? 'folder' : 'drive'} />{d ? d.split('/').pop() : 'Drive'}
            </button>
          ))}
        </div>
        <p className="hint">Existing names are never overwritten.{kind === 'copy' ? ' Every copied file is verified by SHA-256.' : ''}</p>
        <div className="dialog-actions"><button className="text-button" onClick={close}>Cancel</button></div>
      </Modal>,
    )
  }

  function rename(item: DriveItem) {
    setDialog(<RenameDialog item={item} onClose={close} onRename={async name => { await call('rename', item.path, name); refresh() }} />)
  }
  function editTags(items: DriveItem[]) {
    setDialog(<TagsDialog title={items.length > 1 ? `Tags for ${items.length} items` : `Tags for \u201c${items[0].name}\u201d`}
      hint={items.length > 1 ? 'These tags replace the tags on every selected item.' : undefined}
      initial={items.length > 1 ? [] : items[0].tags} known={[...tags, ...items.flatMap(i => i.tags)]} onClose={close}
      onSave={async names => { await actAll(items, i => call('setTags', i.path, names), n => n === 1 ? 'Tags saved' : `Tags saved on ${n} items`) }} />)
  }
  function pickColor(item: DriveItem) {
    setDialog(
      <Modal onClose={close}>
        <h3>Folder colour</h3>
        <div className="swatches">
          <button className={`swatch none ${!item.color ? 'on' : ''}`} title="Default" onClick={() => { close(); act(() => call('setColor', item.path, null)) }} />
          {Object.entries(FOLDER_COLORS).map(([name, hex]) => (
            <button key={name} className={`swatch ${item.color === name ? 'on' : ''}`} title={name} style={{ background: hex }}
              onClick={() => { close(); act(() => call('setColor', item.path, name)) }} />
          ))}
        </div>
        <div className="dialog-actions"><button className="text-button" onClick={close}>Cancel</button></div>
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
            <dt>Type</dt><dd>{p.type}</dd>
            <dt>Location</dt><dd>Drive/{p.path}</dd>
            <dt>Size</dt><dd>{formatBytes(p.size)}{p.dir ? ` · ${p.files} files` : ''}</dd>
            <dt>Modified</dt><dd>{date.format(p.mtime)}</dd>
            {p.tags.length > 0 && <><dt>Tags</dt><dd>{p.tags.join(', ')}</dd></>}
          </dl>
          <div className="dialog-actions">
            <button className="text-button" onClick={close}>Close</button>
            <button className="filled-button" onClick={() => { close(); open(p) }}>Open</button>
          </div>
        </Modal>,
      )
    } catch (e) { say(errorText(e)) }
  }
  async function chooseSystemFolders() {
    try {
      const chosen = await call<string[]>('chosenFolders')
      const save = (names: string[], contents = 'out') => { close(); act(() => call('chooseSystemFolders', names, contents), 'System folders saved') }
      setDialog(<SystemFoldersDialog initial={chosen} onClose={close} onSave={async names => {
        // A folder left out goes; one with something in it asks first where that goes (asked 17 Oct).
        const leftOut = chosen.filter(n => !names.includes(n))
        const full = (await Promise.all(leftOut.map(n => call<DriveItem[]>('list', n).then(l => l.length ? n : null, () => null)))).filter(n => n !== null)
        if (!full.length) return save(names)
        const which = full.length === 1 ? `\u201c${full[0]}\u201d has` : `${full.slice(0, -1).join(', ')} and ${full.at(-1)} have`
        setDialog(
          <Modal onClose={close}>
            <h3>{which} files in {full.length === 1 ? 'it' : 'them'}</h3>
            <p>Move what is inside to the top of Tetra, or move {full.length === 1 ? 'the folder' : 'the folders'} with everything in {full.length === 1 ? 'it' : 'them'} to Trash.
              Empty folders left out simply go.</p>
            <div className="dialog-actions">
              <button className="text-button" onClick={close}>Cancel</button>
              <button className="text-button" onClick={() => save(names, 'trash')}>Move to Trash</button>
              <button className="filled-button" autoFocus onClick={() => save(names, 'out')}>Move files out</button>
            </div>
          </Modal>,
        )
      }} />)
    } catch (e) { say(errorText(e)) }
  }
  function emptyTrash() {
    setDialog(<Confirm title="Empty Trash?" action="Empty Trash permanently" danger onClose={close}
      body="Everything in Drive › Trash is deleted permanently. This cannot be undone."
      onConfirm={() => act(async () => say(`Deleted ${await call<number>('emptyTrash')} items permanently`))} />)
  }

  const crumbs = folder ? folder.split('/') : []
  const inTrash = mode === 'browse' && (folder === TRASH || folder.startsWith(TRASH + '/'))
  const searching = !!query.trim() || !!tag
  const title = mode === 'favorites' ? 'Favorites' : mode === 'recent' ? 'Recent' : null

  return (
    <div className={`timeline files ${selecting ? 'selecting' : ''}`} onContextMenu={e => e.preventDefault()}>
      <header className="topbar">
        <div className="island title-island crumbs">
          {mode === 'browse' && folder && <button className="round flat" title="Up" onClick={() => setFolder(parentOf(folder))}><Icon name="back" /></button>}
          {title ? <h1>{title}</h1> : <>
            <button className="crumb" onClick={() => setFolder('')}><h1>Drive</h1></button>
            {crumbs.map((c, i) => <span key={i}><span className="sep">›</span><button className="crumb" onClick={() => setFolder(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </>}
          {inTrash && folder === TRASH && <button className="round flat" title="Empty Trash" onClick={emptyTrash}><Icon name="deleteForever" /></button>}
        </div>
        <div className="tools">
          <label className="island search">
            <Icon name="search" size={20} />
            <input placeholder="Search names and tags" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
            {query && <button className="eraser" title="Clear search" onClick={() => setQuery('')}><Icon name="eraser" size={20} /></button>}
          </label>
          <details className="menu" onToggle={e => { if ((e.target as HTMLDetailsElement).open) call<Record<string, number>>('usage').then(setUsage) }}>
            <summary className="round" title="Files tools"><Icon name="tune" /></summary>
            <div className="island menu-body">
              <div className="seg-row"><span>View</span>
                <div className="mini-seg">{(['list', 'grid'] as const).map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={v}><Icon name={v} size={20} /></button>)}</div></div>
              <div className="seg-row"><span>Sort</span>
                <div className="mini-seg">{(['name', 'date'] as const).map(s => <button key={s} className={sort === s ? 'on' : ''} onClick={() => setSort(s)}>{s === 'name' ? 'Name' : 'Modified'}</button>)}</div></div>
              <button className="sheet-row" onClick={() => act(() => window.drive.files.open(folder))}><Icon name="folder" />Open in file manager</button>
              <button className="sheet-row" onClick={chooseSystemFolders}><Icon name="folderOthers" />System folders</button>
              {usage && <Usage usage={usage} />}
            </div>
          </details>
          <button className="round" title="Refresh" onClick={refresh}><Icon name="refresh" size={20} /></button>
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
        <div className="empty">{searching ? 'Nothing matches.' : mode === 'favorites' ? 'No favorite files or folders yet.' : mode === 'recent' ? 'Files you open appear here.' : inTrash ? 'Trash is empty.' : 'This folder is empty.'}</div>
      )}
      <div className={view === 'grid' ? 'file-grid' : 'file-list'}>
        {sorted.map(item => (
          <div key={item.path} className={`file ${selected.has(item.path) ? 'selected' : ''}`} role="button" tabIndex={0}
            onPointerDown={e => pointerDown(e, item)} onPointerEnter={() => pointerEnter(item)}
            onClick={() => { if (handled.current) handled.current = false; else open(item) }}
            onKeyDown={e => { if (e.key === 'Enter') open(item) }}
            onContextMenu={e => { e.preventDefault(); sheet(item) }}>
            {item.thumb ? <FileThumb item={item} glyphSize={view === 'grid' ? 30 : 14} /> : <ItemIcon item={item} size={view === 'grid' ? 56 : 28} />}
            <span className="check" title="Select"><Icon name={selected.has(item.path) ? 'checked' : 'unchecked'} size={22} /></span>
            <div className="file-name">
              <span>{item.name}{item.favorite && <Icon name="heartFill" size={14} />}</span>
              {(searching || mode !== 'browse') && <small>{parentOf(item.path) || 'Drive'}</small>}
              {item.tags.length > 0 && <span className="file-tags">{item.tags.map(t => <em key={t}>{t}</em>)}</span>}
            </div>
            {view === 'list' && <small className="file-meta">{date.format(item.openedAt ?? item.mtime)}</small>}
            {view === 'list' && <small className="file-meta size">{item.dir ? '' : formatBytes(item.size)}</small>}
            <button className="round flat more" title="More" onClick={e => { e.stopPropagation(); sheet(item) }}><Icon name="more" /></button>
          </div>
        ))}
      </div>

      {picked.length === 0 && dock}
      {picked.length > 0 && (
        <div className="island selection-bar">
          <button className="round flat" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
          <strong>{picked.length} selected</strong>
          {inTrash ? (
            <button className="round flat" title="Restore from Trash"
              onClick={() => actAll(picked, i => call('move', i.path, ''), n => `Restored ${n} ${n === 1 ? 'item' : 'items'}`)}><Icon name="undo" /></button>
          ) : <>
            <button className="round flat" title="Copy to…" onClick={() => pickDestination(picked, 'copy')}><Icon name="copy" /></button>
            <button className="round flat" title="Move to…" onClick={() => pickDestination(picked, 'move')}><Icon name="moveTo" /></button>
            <button className="round flat" title="Tags" onClick={() => editTags(picked)}><Icon name="tag" /></button>
            {picked.some(i => !i.dir) && <button className="round flat" title="Send to phone" onClick={() => sendToPhone(picked)}><Icon name="device" /></button>}
            <button className="round flat" title={picked.every(i => i.favorite) ? 'Remove from Favorites' : 'Add to Favorites'}
              onClick={() => { const on = !picked.every(i => i.favorite); actAll(picked, i => call('setFavorite', i.path, on), n => `${on ? 'Added' : 'Removed'} ${n} ${n === 1 ? 'item' : 'items'}`) }}>
              <Icon name={picked.every(i => i.favorite) ? 'heartFill' : 'heart'} /></button>
            <button className="round flat" title="Move to Trash"
              onClick={() => actAll(picked, i => call('trash', i.path), n => `Moved ${n} ${n === 1 ? 'item' : 'items'} to Trash`)}><Icon name="trash" /></button>
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
  return <span className="file-icon" style={{ color: item.dir ? (item.color ? FOLDER_COLORS[item.color] : systemLook(item)?.[1]) : undefined }}>
    <Icon name={item.path === TRASH ? 'trash' : SYSTEM_ICON[item.path] ?? systemLook(item)?.[0] ?? TYPE_ICON[item.type] ?? 'file'} size={size} />
  </span>
}

/** Office's glyph over a document's thumbnail, in its app's colour (the phone's Office: Words' lines, Tables' table, Slides' play). */
const GLYPH: Record<string, [IconName, string]> = { words: ['fileText', '#185ABD'], tables: ['table', '#107C41'], slides: ['play', '#B7472A'] }

/** A file's thumbnail (thumbs.js); a document's first page with its glyph, or the glyph on a blank page when it has none. */
function FileThumb({ item, glyphSize }: { item: DriveItem; glyphSize: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [item.path, item.mtime])
  const glyph = GLYPH[item.thumb ?? '']
  if (failed && !glyph) return <ItemIcon item={item} size={glyphSize * 2} />
  return <span className={`file-thumb ${glyph ? 'page' : ''}`}>
    {!failed && <img src={`media://filethumb/${encodeURIComponent(item.path)}?v=${item.mtime}`} loading="lazy" decoding="async" draggable={false} alt=""
      onError={() => setFailed(true)} />}
    {glyph && <span className="thumb-glyph" style={{ color: glyph[1] }}><Icon name={glyph[0]} size={glyphSize} /></span>}
  </span>
}

/** Files tools › System folders: every folder's emblem, click to choose or leave it, OK to keep the choice (the phone's sheet). */
function SystemFoldersDialog({ initial, onClose, onSave }: { initial: string[]; onClose: () => void; onSave: (names: string[]) => unknown }) {
  const [chosen, setChosen] = useState(() => new Set(initial))
  const flip = (name: string) => setChosen(c => { const n = new Set(c); n.has(name) ? n.delete(name) : n.add(name); return n })
  return (
    <Modal onClose={onClose}>
      <h3>System folders</h3>
      <p className="hint">Folders Tetra keeps in Files for sorting things into, each with its own picture. Documents is always there.
        A folder left out later goes; if it has files in it, you choose where they go.</p>
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
        <button className="text-button" onClick={onClose}>Cancel</button>
        <button className="filled-button" onClick={() => onSave([...chosen])}>OK</button>
      </div>
    </Modal>
  )
}

function Usage({ usage }: { usage: Record<string, number> }) {
  const total = Object.values(usage).reduce((a, b) => a + b, 0)
  return (
    <div className="usage">
      <strong>Drive uses {formatBytes(total)}</strong>
      {Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
        <div key={k} className="usage-row"><span>{k}</span><div className="bar"><i style={{ width: `${(v / total) * 100}%` }} /></div><small>{formatBytes(v)}</small></div>
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
        <h3>Rename</h3>
        <input className="field" autoFocus value={name} onChange={e => { setName(e.target.value); setError('') }}
          onFocus={e => { const dot = item.dir ? -1 : item.name.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : item.name.length) }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button className="filled-button" disabled={!name.trim() || name === item.name}>Rename</button>
        </div>
      </form>
    </Modal>
  )
}

