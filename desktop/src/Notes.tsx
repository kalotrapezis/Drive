import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { Confirm, Modal, errorText } from './Dialogs'
import { Undo, blocks, endsWord, indent, prefix, preview, sortItems, toggleLine, wrap, type Edit, type Inline, type Item } from './notesEdit'

// Notes (asked 2026-09-26): kept in Files' hidden .notes folder (notes.js). No sidebar of folders — labels only, a
// bottom island for the views and a drawer pulled up from it for the pins and labels.

export interface Note {
  id: string; title: string; content: string; noteType: 'TEXT' | 'CHECKLIST'; checklistItems?: Item[]; labels?: string[]
  color?: string; isPinned?: boolean; archivedAt?: number; trashedAt?: number; createdAt: number; updatedAt: number
}
interface Version { name: string; at: number; title: string; content: string; checklistItems?: Item[] }
type View = 'home' | 'archived' | 'trash'

const call = <T,>(method: string, ...args: unknown[]) => window.drive.notes<T>(method, ...args)
const VIEWS: { id: View; name: string; icon: IconName }[] = [
  { id: 'home', name: 'Notes', icon: 'home' }, { id: 'archived', name: 'Archived', icon: 'archive' }, { id: 'trash', name: 'Trash', icon: 'trash' },
]
// Keep's palette, which the imported notes already use.
const COLORS = ['#F28B82', '#FBBC04', '#FFF475', '#CCFF90', '#A7FFEB', '#CBF0F8', '#AECBFA', '#D7AEFB', '#FDCFE8', '#E6C9A8', '#E8EAED']
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const inView = (n: Note, v: View) => v === 'trash' ? !!n.trashedAt : !n.trashedAt && (v === 'archived' ? !!n.archivedAt : !n.archivedAt)
const newItem = (order: number): Item => ({ id: crypto.randomUUID(), text: '', isChecked: false, order, originalOrder: order, createdAt: Date.now(), indentationLevel: 0 })

export function NotesPage({ setDialog, say }: { setDialog: (d: ReactNode) => void; say: (text: string, undo?: () => void) => void }) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [view, setView] = useState<View>('home')
  const [label, setLabel] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Note | null>(null)
  const [drawer, setDrawer] = useState(false)
  useEffect(() => setSelected(new Set()), [view, label])
  const reload = () => call<Note[]>('list').then(setNotes)
  useEffect(() => { reload() }, [])
  const close = () => setDialog(null)

  const labels = useMemo(() => {
    const count = new Map<string, number>()
    for (const n of notes ?? []) if (!n.trashedAt) for (const l of n.labels ?? []) count.set(l, (count.get(l) ?? 0) + 1)
    return [...count].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes])
  const shown = useMemo(() => {
    const q = fold(query.trim())
    return (notes ?? []).filter(n => inView(n, view) && (!label || n.labels?.includes(label))
      && (!q || fold([n.title, n.content, ...(n.labels ?? []), ...(n.checklistItems ?? []).map(i => i.text)].join(' ')).includes(q)))
      .sort((a, b) => view === 'trash' ? (b.trashedAt ?? 0) - (a.trashedAt ?? 0) : b.updatedAt - a.updatedAt)
  }, [notes, view, label, query])
  // Pinned on top of Home, the rest below (asked 2026-09-26).
  const pinned = view === 'home' ? shown.filter(n => n.isPinned) : []
  const others = shown.filter(n => !pinned.includes(n))
  // Long press (or Ctrl+click) selects; then a click adds or takes away.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const picked = shown.filter(n => selected.has(n.id))
  const act = async (said: string, change: Record<string, unknown>) => { for (const n of picked) await call('save', n.id, change); setSelected(new Set()); reload(); say(said) }
  const cards = (list: Note[]) => list.map(n => <NoteCard key={n.id} note={n} selected={selected.has(n.id)}
    onSelect={() => toggle(n.id)} onOpen={() => selected.size ? toggle(n.id) : setOpen(n)} />)

  async function create(noteType: 'TEXT' | 'CHECKLIST') {
    const n = await call<Note>('create', { noteType, labels: label ? [label] : [] })
    if (noteType === 'CHECKLIST') n.checklistItems = []
    setDrawer(false); setOpen(n)
  }
  function closed(n: Note | null, message?: string, undo?: () => Promise<unknown>) {
    setOpen(null); reload()
    if (message) say(message, undo && (() => { undo().then(reload) }))
    else if (n && !n.title.trim() && !n.content.trim() && !(n.checklistItems ?? []).some(i => i.text.trim())) call('remove', n.id).then(reload) // nothing written: no note
  }
  const emptyTrash = () => setDialog(<Confirm title="Empty the notes Trash?" action="Delete for good" danger onClose={close}
    body="Every note in the Trash is deleted. Their saved versions stay in the notes' history folder."
    onConfirm={async () => { for (const n of shown) await call('remove', n.id); reload(); say('Notes Trash emptied') }} />)

  // Ctrl+N a note, Ctrl+Shift+N a checklist, from anywhere on the page but the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open && e.key === 'Escape' && selected.size) { setSelected(new Set()); return }
      if (open || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'n') return
      e.preventDefault(); create(e.shiftKey ? 'CHECKLIST' : 'TEXT')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (open) return <NoteEditor key={open.id} initial={open} setDialog={setDialog} onClose={closed} />
  return (
    <div className="notes">
      <header className="notes-top">
        <h1>{label ?? VIEWS.find(v => v.id === view)!.name}</h1>
        {label && <button className="chip on" title="Show every label" onClick={() => setLabel(null)}>{label} ✕</button>}
        <label className="notes-search island"><Icon name="search" size={20} />
          <input placeholder="Search notes" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {view === 'trash' && shown.length > 0 && <button className="text-button" onClick={emptyTrash}>Empty Trash</button>}
      </header>
      {!notes ? <div className="empty">Loading…</div> : shown.length === 0 ? (
        <div className="empty"><p>{query ? 'No note matches.' : view === 'trash' ? 'The Trash is empty. Notes stay here 30 days.' : view === 'archived' ? 'Nothing archived.' : 'No notes yet. Start one below.'}</p></div>
      ) : (
        <div className="notes-scroll">
          {pinned.length > 0 && <><h4 className="notes-section">Pinned</h4><div className="notes-grid">{cards(pinned)}</div>{others.length > 0 && <h4 className="notes-section">Others</h4>}</>}
          <div className="notes-grid">{cards(others)}</div>
        </div>
      )}

      <div className={`notes-drawer island ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <h4><Icon name="label" size={18} />Labels</h4>
        <div className="chips wrap">
          <button className={`chip ${label ? '' : 'on'}`} onClick={() => { setLabel(null); setDrawer(false) }}>All</button>
          {labels.map(([l, n]) => <button key={l} className={`chip ${label === l ? 'on' : ''}`} onClick={() => { setLabel(l); setDrawer(false) }}>{l} <small>{n}</small></button>)}
        </div>
      </div>
      <div className="notes-dock">
        <Handle open={drawer} setOpen={setDrawer} />
        {selected.size > 0 ? (
          <nav className="notes-island island">
            <button className="round flat" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
            <strong className="island-count">{selected.size}</strong>
            {view === 'trash' ? <>
              <button className="island-item" onClick={() => act('Restored', { trashedAt: null })}><Icon name="undo" size={20} /><span>Restore</span></button>
              <button className="island-item" onClick={() => setDialog(<Confirm title={`Delete ${picked.length} for good?`} action="Delete" danger onClose={close}
                body="Their saved versions stay in the history folder." onConfirm={async () => { for (const n of picked) await call('remove', n.id); setSelected(new Set()); reload(); say('Deleted') }} />)}><Icon name="deleteForever" size={20} /><span>Delete</span></button>
            </> : <>
              <button className="island-item" onClick={() => { const all = picked.every(n => n.isPinned); act(all ? 'Unpinned' : 'Pinned', { isPinned: !all }) }}><Icon name="pin" size={20} /><span>{picked.every(n => n.isPinned) ? 'Unpin' : 'Pin'}</span></button>
              {view === 'archived' ? <button className="island-item" onClick={() => act('Unarchived', { archivedAt: null })}><Icon name="unarchive" size={20} /><span>Unarchive</span></button>
                : <button className="island-item" onClick={() => act('Archived', { archivedAt: Date.now() })}><Icon name="archive" size={20} /><span>Archive</span></button>}
              <button className="island-item" onClick={() => act('Moved to Trash', { trashedAt: Date.now() })}><Icon name="trash" size={20} /><span>Trash</span></button>
            </>}
          </nav>
        ) : (
          <nav className="notes-island island">
            {/* Home, the two ways to start, then Archived and Trash; pulled up, the labels. */}
            <button className={`island-item ${view === 'home' ? 'on' : ''}`} onClick={() => { setView('home'); setDrawer(false) }}><Icon name="home" size={20} /><span>Home</span></button>
            <button className="island-item" title="New note (Ctrl+N)" onClick={() => create('TEXT')}><Icon name="noteAdd" size={20} /><span>New note</span></button>
            <button className="island-item" title="New checklist (Ctrl+Shift+N)" onClick={() => create('CHECKLIST')}><Icon name="checklist" size={20} /><span>Checklist</span></button>
            <span className="island-gap" />
            {VIEWS.filter(v => v.id !== 'home').map(v => <button key={v.id} className={`island-item ${view === v.id ? 'on' : ''}`} onClick={() => { setView(v.id); setDrawer(false) }}>
              <Icon name={v.icon} size={20} /><span>{v.name}</span></button>)}
          </nav>
        )}
      </div>
    </div>
  )
}

/** The grip above the island: click, or pull up (down) to open (close) the drawer. */
function Handle({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const start = useRef<number | null>(null)
  return (
    <button className="notes-handle" title={open ? 'Close pins and labels' : 'Pull up for pins and labels'} aria-expanded={open}
      onPointerDown={e => { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerUp={e => { const dy = e.clientY - (start.current ?? e.clientY); start.current = null; setOpen(Math.abs(dy) < 8 ? !open : dy < 0) }}>
      <span />
    </button>
  )
}

function NoteCard({ note, small, selected, onSelect, onOpen }: { note: Note; small?: boolean; selected?: boolean; onSelect?: () => void; onOpen: () => void }) {
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined)
  const held = useRef(false)
  return (
    <button className={`note-card ${note.color ? 'tinted' : ''} ${small ? 'small' : ''} ${selected ? 'selected' : ''}`} style={note.color ? { background: note.color } : undefined}
      onPointerDown={() => { held.current = false; if (onSelect) hold.current = setTimeout(() => { held.current = true; onSelect() }, 500) }}
      onPointerUp={() => clearTimeout(hold.current)} onPointerLeave={() => clearTimeout(hold.current)}
      onClick={e => { if (held.current) return; if ((e.ctrlKey || e.metaKey) && onSelect) onSelect(); else onOpen() }}>
      {note.isPinned && !small && <span className="note-pin"><Icon name="pin" size={16} /></span>}
      {note.title && <strong>{note.title}</strong>}
      {preview(note, small ? 3 : 8).map((l, i) => <span key={i} className="note-line">{l}</span>)}
      {!small && !!note.labels?.length && <span className="note-labels">{note.labels.map(l => <small key={l}>{l}</small>)}</span>}
    </button>
  )
}

interface Snap { title: string; content: string; items: Item[] }

function NoteEditor({ initial, setDialog, onClose }: {
  initial: Note; setDialog: (d: ReactNode) => void; onClose: (n: Note | null, message?: string, undo?: () => Promise<unknown>) => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [content, setContent] = useState(initial.content ?? '')
  const [items, setItems] = useState<Item[]>(initial.checklistItems ?? [])
  const [meta, setMeta] = useState({ labels: initial.labels ?? [], color: initial.color, isPinned: !!initial.isPinned, archivedAt: initial.archivedAt })
  const [reading, setReading] = useState(false)
  const [tools, setTools] = useState(false)
  const [, redraw] = useState(0)
  const undo = useRef(new Undo<Snap>({ title, content, items }))
  const changed = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const checklist = initial.noteType === 'CHECKLIST'
  // The text box is as tall as the note, so the page scrolls, not a box inside it.
  useLayoutEffect(() => { const ta = area.current; if (ta) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px` } }, [content, reading])
  const trashed = !!initial.trashedAt
  const close = () => setDialog(null)

  // Saved as you type (a short pause), the whole note each time.
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = useRef<() => Promise<unknown>>(() => Promise.resolve())
  useEffect(() => {
    if (!changed.current) return
    flush.current = () => { clearTimeout(saving.current); flush.current = () => Promise.resolve(); return call('save', initial.id, { title, content, ...(checklist ? { checklistItems: items } : {}) }) }
    clearTimeout(saving.current)
    saving.current = setTimeout(() => flush.current(), 400)
  }, [title, content, items])
  const edit = (next: Partial<Snap>, step = false, wordDone = false) => {
    const snap = { title, content, items, ...next }
    changed.current = true
    step ? undo.current.step(snap) : undo.current.push(snap, Date.now(), wordDone)
    if (next.title !== undefined) setTitle(next.title)
    if (next.content !== undefined) setContent(next.content)
    if (next.items !== undefined) setItems(next.items)
    redraw(x => x + 1)
  }
  const apply = (s: Snap | null) => { if (!s) return; changed.current = true; setTitle(s.title); setContent(s.content); setItems(s.items); redraw(x => x + 1) }
  const setMetaNow = (change: Partial<typeof meta>) => {
    setMeta(m => ({ ...m, ...change })); changed.current = true
    return call('save', initial.id, Object.fromEntries(Object.entries(change).map(([k, v]) => [k, v ?? null])))
  }

  // Leaving: save what is pending, and the note as it now is goes to its history, if anything changed.
  async function leave(message?: string, undoIt?: () => Promise<unknown>) {
    await flush.current()
    if (changed.current) await call('snapshot', initial.id)
    onClose({ ...initial, title, content, checklistItems: items }, message, undoIt)
  }

  // A toolbar action on the text: the selection is kept, and the change is one undo step of its own.
  function format(fn: (e: Edit) => Edit) {
    const ta = area.current
    if (!ta || reading) return
    const next = fn({ text: content, start: ta.selectionStart, end: ta.selectionEnd })
    edit({ content: next.text }, true)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(next.start, next.end) })
  }
  const link = () => format(e => {
    const text = e.text.slice(e.start, e.end) || 'link'
    const md = `[${text}](https://)`
    return { text: e.text.slice(0, e.start) + md + e.text.slice(e.end), start: e.start + text.length + 3, end: e.start + md.length - 1 }
  })

  function onKey(e: React.KeyboardEvent) {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape') { e.preventDefault(); tools ? setTools(false) : leave() }
    else if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); apply(undo.current.undo()) }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); apply(undo.current.redo()) }
    else if (mod && k === 'b' && !checklist) { e.preventDefault(); format(x => wrap(x, '**')) }
    else if (mod && k === 'i' && !checklist) { e.preventDefault(); format(x => wrap(x, '*')) }
  }

  const history = () => setDialog(<HistoryDialog id={initial.id} onClose={close} onRestore={n => edit({ title: n.title, content: n.content ?? '', items: n.checklistItems ?? [] }, true)} />)
  const toTrash = () => { changed.current = true; flush.current().then(() => call('save', initial.id, { trashedAt: Date.now() })).then(() => leave('Note moved to Trash', () => call('save', initial.id, { trashedAt: null }))) }
  const archive = () => {
    const on = !meta.archivedAt
    setMetaNow({ archivedAt: on ? Date.now() : undefined }).then(() => on ? leave('Note archived', () => call('save', initial.id, { archivedAt: null })) : undefined)
  }
  const tool = (icon: IconName, label: string, run: () => void, on = false) => (
    <button className={`round flat ${on ? 'on' : ''}`} title={label} aria-label={label} onClick={run} disabled={trashed}><Icon name={icon} size={20} /></button>
  )

  return (
    <div className="notes note-editor" onKeyDown={onKey} style={meta.color ? { ['--note' as string]: meta.color } : undefined}>
      {/* One line of the basics; everything else slides up from the bottom. */}
      <header className="editor-bar island">
        <button className="round flat" title="Back (Esc)" onClick={() => leave()}><Icon name="back" /></button>
        {tool('undo', 'Undo (Ctrl+Z)', () => apply(undo.current.undo()))}
        {tool('redo', 'Redo (Ctrl+Y)', () => apply(undo.current.redo()))}
        <span className="bar-gap" />
        {!checklist && !reading && <>
          {tool('bold', 'Bold (Ctrl+B)', () => format(x => wrap(x, '**')))}
          {tool('italic', 'Italic (Ctrl+I)', () => format(x => wrap(x, '*')))}
          {tool('checkBox', 'Checkbox list', () => format(x => prefix(x, '- [ ] ')))}
          {tool('bullets', 'Bulleted list', () => format(x => prefix(x, '- ')))}
          <span className="bar-gap" />
        </>}
        <span className="bar-fill" />
        {trashed ? <>
          <button className="text-button" onClick={() => call('save', initial.id, { trashedAt: null }).then(() => leave('Note restored'))}>Restore</button>
          <button className="text-button danger" onClick={() => setDialog(<Confirm title="Delete this note for good?" action="Delete" danger onClose={close}
            body="Its saved versions stay in the history folder." onConfirm={() => call('remove', initial.id).then(() => onClose(null, 'Note deleted'))} />)}>Delete for good</button>
        </> : <>
          {!checklist && tool(reading ? 'editNote' : 'visibility', reading ? 'Edit' : 'Read', () => setReading(r => !r), reading)}
          {tool('pin', meta.isPinned ? 'Unpin' : 'Pin', () => setMetaNow({ isPinned: !meta.isPinned }), meta.isPinned)}
          <button className={`round flat ${tools ? 'on' : ''}`} title="More tools" aria-expanded={tools} onClick={() => setTools(t => !t)}><Icon name="arrowUp" size={20} /></button>
        </>}
      </header>

      <div className={`editor-page ${meta.color ? 'tinted' : ''}`}>
        <input className="editor-title" placeholder="Title" value={title} readOnly={trashed} onChange={e => edit({ title: e.target.value }, false, endsWord(title, e.target.value, e.target.selectionStart ?? 0))} />
        {checklist ? <Checklist items={items} readOnly={trashed} onChange={(next, step) => edit({ items: next }, step)} />
          : reading ? <Rendered md={content} onToggle={line => edit({ content: toggleLine(content, line) }, true)} />
          : <textarea ref={area} className="editor-body" placeholder="Write here. **bold**, *italic*, - [ ] a checkbox…" value={content} readOnly={trashed}
              autoFocus={!initial.content && !!initial.title} onChange={e => edit({ content: e.target.value }, false, endsWord(content, e.target.value, e.target.selectionStart ?? 0))} />}
        {!!meta.labels.length && <div className="note-labels">{meta.labels.map(l => <small key={l}>{l}</small>)}</div>}
      </div>

      <div className={`note-tools island ${tools ? 'open' : ''}`} aria-hidden={!tools}>
        <Handle open={tools} setOpen={setTools} />
        {!checklist && !reading && <section>
          <h4>Text</h4>
          <div className="tool-row">
            {tool('heading', 'Heading', () => format(x => prefix(x, '# ')))}
            <button className="round flat" title="Subheading" onClick={() => format(x => prefix(x, '## '))}><b>H2</b></button>
            {tool('bold', 'Bold', () => format(x => wrap(x, '**')))}
            {tool('italic', 'Italic', () => format(x => wrap(x, '*')))}
            {tool('strike', 'Strikethrough', () => format(x => wrap(x, '~~')))}
            {tool('code', 'Code', () => format(x => wrap(x, '`')))}
            {tool('bullets', 'Bulleted list', () => format(x => prefix(x, '- ')))}
            {tool('numbered', 'Numbered list', () => format(x => prefix(x, '1. ')))}
            {tool('checkBox', 'Checkbox list', () => format(x => prefix(x, '- [ ] ')))}
            {tool('quote', 'Quote', () => format(x => prefix(x, '> ')))}
            {tool('link', 'Link', link)}
            {tool('rule', 'Divider', () => format(x => ({ text: x.text.slice(0, x.end) + '\n\n---\n' + x.text.slice(x.end), start: x.end + 6, end: x.end + 6 })))}
            {tool('indent', 'Indent', () => format(x => indent(x, false)))}
            {tool('outdent', 'Outdent', () => format(x => indent(x, true)))}
          </div>
        </section>}
        <section>
          <h4>Colour</h4>
          <div className="tool-row">
            <button className={`swatch none ${meta.color ? '' : 'on'}`} title="No colour" onClick={() => setMetaNow({ color: undefined })} />
            {COLORS.map(c => <button key={c} className={`swatch ${meta.color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setMetaNow({ color: c })} />)}
          </div>
        </section>
        <section>
          <h4>Labels</h4>
          <LabelEditor labels={meta.labels} onChange={labels => setMetaNow({ labels })} />
        </section>
        <section className="tool-row">
          <button className="text-button" onClick={history}><Icon name="history" size={18} /> History</button>
          <button className="text-button" onClick={archive}><Icon name={meta.archivedAt ? 'unarchive' : 'archive'} size={18} /> {meta.archivedAt ? 'Unarchive' : 'Archive'}</button>
          <button className="text-button" onClick={toTrash}><Icon name="trash" size={18} /> Move to Trash</button>
        </section>
      </div>
    </div>
  )
}

function Checklist({ items, readOnly, onChange }: { items: Item[]; readOnly: boolean; onChange: (items: Item[], step?: boolean) => void }) {
  const sorted = sortItems(items)
  const open = sorted.filter(i => !i.isChecked), done = sorted.filter(i => i.isChecked)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => { if (focus) { inputs.current.get(focus)?.focus(); setFocus(null) } }, [focus, items])
  // New items go right after the one you pressed Enter in; the open ones are numbered again in their order.
  const insertAfter = (id: string | null) => {
    const at = id ? open.findIndex(i => i.id === id) + 1 : open.length
    const added = newItem(at)
    const list = [...open.slice(0, at), added, ...open.slice(at)].map((i, n) => ({ ...i, order: n }))
    onChange([...list, ...done], true); setFocus(added.id)
  }
  const set = (id: string, change: Partial<Item>, step = false) => onChange(items.map(i => i.id === id ? { ...i, ...change } : i), step)
  const remove = (id: string) => {
    const at = open.findIndex(i => i.id === id)
    onChange(items.filter(i => i.id !== id), true)
    if (at > 0) setFocus(open[at - 1].id)
  }
  const row = (i: Item) => (
    <div key={i.id} className={`check-item ${i.isChecked ? 'done' : ''}`}>
      <button className="round flat" title={i.isChecked ? 'Not done' : 'Done'} disabled={readOnly}
        onClick={() => set(i.id, { isChecked: !i.isChecked, ...(i.isChecked ? { order: open.length } : {}) }, true)}><Icon name={i.isChecked ? 'checkBox' : 'checkBoxBlank'} size={20} /></button>
      <input ref={el => { if (el) inputs.current.set(i.id, el); else inputs.current.delete(i.id) }} value={i.text} readOnly={readOnly} placeholder="Item"
        onChange={e => set(i.id, { text: e.target.value })}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); insertAfter(i.id) }
          else if (e.key === 'Backspace' && !i.text) { e.preventDefault(); remove(i.id) }
        }} />
      {!readOnly && <button className="round flat item-x" title="Remove item" onClick={() => remove(i.id)}><Icon name="close" size={18} /></button>}
    </div>
  )
  return (
    <div className="checklist">
      {open.map(row)}
      {!readOnly && <button className="text-button add-item" onClick={() => insertAfter(null)}><Icon name="add" size={18} /> Add item</button>}
      {done.length > 0 && <><div className="check-divider">{done.length} done</div>{done.map(row)}</>}
    </div>
  )
}

function Rendered({ md, onToggle }: { md: string; onToggle: (line: number) => void }) {
  const text = (v: Inline[]) => v.map((x, i) => x.t === 'b' ? <b key={i}>{x.v}</b> : x.t === 'i' ? <i key={i}>{x.v}</i> : x.t === 's' ? <s key={i}>{x.v}</s>
    : x.t === 'code' ? <code key={i}>{x.v}</code> : x.t === 'link' ? <u key={i} title={x.href}>{x.v}</u> : <span key={i}>{x.v}</span>)
  return (
    <div className="editor-read">
      {blocks(md).map((b, i) => b.t === 'h' ? (b.level === 1 ? <h2 key={i}>{text(b.v)}</h2> : b.level === 2 ? <h3 key={i}>{text(b.v)}</h3> : <h4 key={i}>{text(b.v)}</h4>)
        : b.t === 'hr' ? <hr key={i} /> : b.t === 'quote' ? <blockquote key={i}>{text(b.v)}</blockquote> : b.t === 'code' ? <pre key={i}>{b.v}</pre>
        : b.t === 'li' ? (
          <div key={i} className="read-li" style={{ paddingLeft: 8 + b.depth * 22 }}>
            {b.check !== null ? <button className="read-check" onClick={() => onToggle(b.line)}><Icon name={b.check ? 'checkBox' : 'checkBoxBlank'} size={20} /></button>
              : <span className="read-mark">{b.ordered ? `${b.ordered}.` : '•'}</span>}
            <span className={b.check ? 'done' : ''}>{text(b.v)}</span>
          </div>
        ) : <p key={i}>{text(b.v)}</p>)}
    </div>
  )
}

function LabelEditor({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
  const [all, setAll] = useState<string[]>([])
  const [name, setName] = useState('')
  useEffect(() => { call<Note[]>('list').then(ns => setAll([...new Set(ns.flatMap(n => n.labels ?? []))].sort((a, b) => a.localeCompare(b)))) }, [])
  const toggle = (l: string) => onChange(labels.includes(l) ? labels.filter(x => x !== l) : [...labels, l])
  return (
    <div className="chips wrap">
      {[...new Set([...all, ...labels])].map(l => <button key={l} className={`chip ${labels.includes(l) ? 'on' : ''}`} onClick={() => toggle(l)}>{l}</button>)}
      <form onSubmit={e => { e.preventDefault(); const l = name.trim(); if (l && !labels.includes(l)) onChange([...labels, l]); setName('') }}>
        <input className="chip-input" placeholder="New label" value={name} onChange={e => setName(e.target.value)} />
      </form>
    </div>
  )
}

function HistoryDialog({ id, onClose, onRestore }: { id: string; onClose: () => void; onRestore: (n: Note) => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { call<Version[]>('history', id).then(setVersions, e => setError(errorText(e))) }, [id])
  return (
    <Modal onClose={onClose}>
      <h3>History</h3>
      <p>A version is kept each time you leave the note with changes. Restoring keeps the current one too.</p>
      {error && <p className="error">{error}</p>}
      <div className="versions">
        {versions?.length === 0 && <p>No versions yet.</p>}
        {versions?.map(v => (
          <div key={v.name} className="version">
            <div><strong>{new Date(v.at).toLocaleString()}</strong><small>{v.title || 'Untitled'} · {preview({ content: v.content, checklistItems: v.checklistItems, noteType: v.checklistItems ? 'CHECKLIST' : 'TEXT' }, 2).join(' · ')}</small></div>
            <button className="text-button" onClick={() => call<Note>('restoreVersion', id, v.name).then(n => { onRestore(n); onClose() }, e => setError(errorText(e)))}>Restore</button>
          </div>
        ))}
      </div>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Close</button></div>
    </Modal>
  )
}
