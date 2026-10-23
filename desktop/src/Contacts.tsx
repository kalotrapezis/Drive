import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Modal } from './Dialogs'

// Contacts on the computer (Drive-Android Plan.md § Contacts): the same files as the phone's, read on every look and
// watched; laid out as the tablet's — the list at the left, the open contact at the right, Notes' island and drawer.

type Field = { label: string; value: string }
type Address = { label: string; parts: string[] }
type VDate = { year: number | null; month: number; day: number }
export type Contact = {
  uid: string; name: string; prefix: string; given: string; middle: string; family: string; suffix: string; formatted: string; nickname: string
  org: string; department: string; title: string; phones: Field[]; emails: Field[]; addresses: Address[]; urls: Field[]; birthday: VDate | null
  dates: Field[]; related: Field[]; note: string; categories: string[]; photo: string | null; photoUrl: string | null; person: string | null
  favourite: boolean; labels: string[]; versions?: number; key?: string
}
type Tab = 'all' | 'favourites' | 'labels'

const call = <T,>(method: string, ...args: unknown[]) => window.drive.contacts<T>(method, ...args)
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').trim()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parseDate = (s: string): VDate | null => {
  let m = /^--(\d{2})-?(\d{2})/.exec(s); if (m) return { year: null, month: +m[1], day: +m[2] }
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s); return m ? { year: +m[1] === 1604 ? null : +m[1], month: +m[2], day: +m[3] } : null
}
/** "23 Oct · turns 41", "12 Jun 2015", "23 Oct". */
function dateText(d: VDate, birthday: boolean) {
  const day = `${d.day} ${MONTHS[d.month - 1]}`
  if (d.year == null) return day
  const now = new Date(), thisYear = new Date(now.getFullYear(), d.month - 1, d.day)
  const next = thisYear < new Date(now.getFullYear(), now.getMonth(), now.getDate()) ? now.getFullYear() + 1 : now.getFullYear()
  const age = next - d.year
  return birthday && age > 0 && age < 131 ? `${day} · ${next === now.getFullYear() && thisYear.getMonth() === now.getMonth() && thisYear.getDate() === now.getDate() ? `${age} today` : `turns ${age}`}` : `${day} ${d.year}`
}
/** "23/10/1985", "23/10" → a date; null when it is not one. The phone's editor reads the same. */
function fromText(s: string): VDate | null {
  const p = s.trim().split(/[/.\- ]+/).filter(Boolean).map(Number)
  if (p.length < 2 || p.length > 3 || p.some(isNaN)) return null
  let y: number | null = p[2] ?? null
  if (y != null && y < 100) y = y + 2000 > new Date().getFullYear() ? 1900 + y : 2000 + y
  return p[1] >= 1 && p[1] <= 12 && p[0] >= 1 && p[0] <= 31 ? { year: y, month: p[1], day: p[0] } : null
}
const toText = (d: VDate | null) => (d ? (d.year != null ? `${d.day}/${d.month}/${d.year}` : `${d.day}/${d.month}`) : '')
const addressText = (a: Address) => [[a.parts[0], a.parts[1], a.parts[2]].filter(Boolean).join(' '), [a.parts[5], a.parts[3]].filter(Boolean).join(' '), a.parts[4], a.parts[6]]
  .map(s => (s || '').trim()).filter(Boolean).join(', ')
const letter = (c: Contact) => { const ch = (c.key || '')[0]; return ch && /\p{L}/u.test(ch) ? ch.toUpperCase() : '#' }

/** A contact's round face: the photo, or the initial on the soft brown. */
function Face({ c, size }: { c: Pick<Contact, 'photo' | 'name'>; size: number }) {
  const first = c.name.trim()[0]
  return c.photo ? <img className="ct-face" src={`data:image/jpeg;base64,${c.photo}`} style={{ width: size, height: size }} alt="" />
    : <span className="ct-face ct-initial" style={{ width: size, height: size, fontSize: size * 0.42 }}>{first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : <Icon name="person" size={size * 0.55} />}</span>
}

export function ContactsPage({ setDialog, say }: { setDialog: (d: ReactNode) => void; say: (text: string) => void }) {
  const [list, setList] = useState<Contact[]>([])
  const [version, setVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [label, setLabel] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof window.drive.contactsSettings>> | null>(null)
  const [pairs, setPairs] = useState<[Contact, Contact][]>([])
  const close = () => setDialog(null)
  useEffect(() => window.drive.onContactsChanged(() => setVersion(v => v + 1)), [])
  useEffect(() => { window.drive.contactsSettings().then(setSettings) }, [version])
  useEffect(() => {
    call<Contact[]>('list', settings?.byLast ?? false).then(setList).catch(e => say('Contacts could not be read: ' + errorText(e)))
    call<[Contact, Contact][]>('pairs').then(setPairs).catch(() => {})
  }, [version, settings?.byLast])
  useEffect(() => { if (!open && list.length) setOpen(list[0].uid) }, [list])
  const act = async (work: () => Promise<unknown>, said: string) => {
    try { await work(); say(said) } catch (e) { say('Not done: ' + errorText(e)) }
    setVersion(v => v + 1)
  }
  const shown = useMemo(() => list.filter(c => {
    const q = plain(query), digits = query.replace(/\D/g, '')
    const hit = !q || plain([c.name, c.nickname, c.org].join(' ')).includes(q) || c.emails.some(e => plain(e.value).includes(q)) || (digits.length >= 3 && c.phones.some(p => p.value.replace(/\D/g, '').includes(digits)))
    return hit && (tab === 'favourites' ? c.favourite : tab === 'labels' && label ? c.labels.some(l => l.toLowerCase() === label.toLowerCase()) : true)
  }), [list, query, tab, label])
  const contact = list.find(c => c.uid === open) || null
  const allLabels = useMemo(() => [...new Set(list.flatMap(c => c.labels))].sort((a, b) => a.localeCompare(b)), [list])
  const save = (was: Contact | null, c: Contact) => act(async () => { const uid = await call<string>('save', was?.uid ?? null, c); setOpen(uid); setEditing(null) }, was ? 'Saved' : 'Contact created')
  const toggle = (uid: string) => setPicked(p => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n })

  const listPane = (
    <aside className="ct-list">
      {tab === 'labels' && !label && !query ? <>
        {allLabels.length === 0 && <p className="hint ct-hint">No labels yet: a contact's labels (Family, School…) come with an import, or are added in Edit.</p>}
        {allLabels.map(l => <button key={l} className="ct-row" onClick={() => setLabel(l)}><Icon name="tag" /><span className="ct-name">{l}</span><small>{list.filter(c => c.labels.includes(l)).length}</small></button>)}
      </> : <>
        {label && <div className="chips"><button className="chip on" onClick={() => setLabel(null)}>{label} ✕</button></div>}
        {tab === 'all' && !query && !label && list.some(c => c.favourite) && <div className="ct-favs">
          {list.filter(c => c.favourite).map(c => <button key={c.uid} className="ct-fav" onClick={() => setOpen(c.uid)} title={c.name}><Face c={c} size={52} /><small>{c.given || c.name}</small></button>)}
        </div>}
        {shown.length === 0 && <p className="hint ct-hint">{list.length === 0 ? 'No contacts yet. The phone\'s come with sync; Import in the drawer takes a .vcf, Google\'s CSV or Takeout\'s zip.' : query ? `No one matches "${query}".` : tab === 'favourites' ? 'No favourites yet: the star on a contact adds one.' : 'No one here.'}</p>}
        {shown.map((c, k) => <div key={c.uid}>
          {!query && (k === 0 || letter(shown[k - 1]) !== letter(c)) && <h4 className="ct-letter">{letter(c)}</h4>}
          <button className={`ct-row ${c.uid === open && !picked.size ? 'on' : ''} ${picked.has(c.uid) ? 'picked' : ''}`}
            onClick={e => { if (e.ctrlKey || e.metaKey || picked.size) toggle(c.uid); else { setOpen(c.uid); setEditing(null) } }}
            onContextMenu={e => { e.preventDefault(); toggle(c.uid) }}>
            {picked.has(c.uid) ? <span className="ct-face ct-check" style={{ width: 40, height: 40 }}><Icon name="checked" /></span> : <Face c={c} size={40} />}
            <span className="ct-name">{c.name}{query && <small>{c.phones[0]?.value || c.emails[0]?.value}</small>}</span>
          </button>
        </div>)}
      </>}
    </aside>
  )

  const many = list.filter(c => picked.has(c.uid))
  return (
    <div className="ct">
      <header className="topbar ct-topbar">
        {picked.size ? <div className="island title-island ct-search">
          <button className="round flat" title="Done choosing" onClick={() => setPicked(new Set())}><Icon name="close" /></button>
          <h1>{picked.size} selected</h1>
          <button className="text-button" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map(c => c.uid)))}>{picked.size === shown.length ? 'None' : `All ${shown.length}`}</button>
        </div> : <div className="island title-island ct-search">
          <Icon name="search" />
          <input placeholder={list.length ? `Search ${list.length} contacts` : 'Contacts'} value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="round flat" title="Clear" onClick={() => setQuery('')}><Icon name="close" /></button>}
        </div>}
        <div className="tools">
          <button className="round" title="Sync now" onClick={() => window.drive.calendarRefresh().then(n => say(n ? `Syncing with ${n} device${n === 1 ? '' : 's'}` : 'No phone or tablet answered'), () => {})}><Icon name="refresh" /></button>
        </div>
      </header>
      <div className="ct-body">
        {listPane}
        <section className="ct-page">
          {editing ? <Editor start={editing === 'new' ? null : editing} labels={allLabels} cancel={() => setEditing(null)} save={c => save(editing === 'new' ? null : editing, c)}
            remove={editing === 'new' ? undefined : () => { const c = editing; setDialog(<Modal onClose={close}><h3>Delete {c.name}?</h3><p>The contact goes to the Trash, with its birthday's event, and can be restored from there.</p>
              <div className="dialog-actions"><button className="text-button" onClick={close}>Cancel</button><button className="filled-button danger" onClick={() => { close(); setEditing(null); setOpen(null); act(() => call('trash', c.uid), `${c.name} moved to the Trash`) }}>Delete</button></div></Modal>) }} />
            : contact ? <Page c={contact} all={list} edit={() => setEditing(contact)} openUid={setOpen} star={() => act(() => call('save', contact.uid, { ...contact, categories: contact.favourite ? contact.categories.filter(x => x.toLowerCase() !== 'starred') : [...contact.categories, 'starred'] }), contact.favourite ? 'Not a favourite' : 'Added to favourites')}
              keep={() => act(() => call('keep', contact.uid), 'Kept this version; the other went to the Trash')} say={say} />
            : <p className="hint ct-hint">Choose a contact.</p>}
        </section>
      </div>
      <div className={`notes-drawer island ct-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <h4><Icon name="add" />Import and export</h4>
        <div className="chips wrap">
          <button className="chip" onClick={() => window.drive.contactsPickImport().then(r => { if (r) { say(`Imported: ${r.added} new` + (r.same ? `, ${r.same} already here` : '')); setVersion(v => v + 1) } }, e => say('Could not read it: ' + errorText(e)))}>Import a file…</button>
          <button className="chip" onClick={() => window.drive.contactsExport(null, 'All contacts').then(p => p && say('Exported to ' + p))}>Export all</button>
          <button className="chip" onClick={() => window.drive.contactsExport(list.filter(c => c.favourite).map(c => c.uid), 'Favourites').then(p => p && say('Exported to ' + p))}>Export favourites</button>
          {allLabels.map(l => <button key={l} className="chip" onClick={() => window.drive.contactsExport(list.filter(c => c.labels.includes(l)).map(c => c.uid), l).then(p => p && say('Exported to ' + p))}>Export {l}</button>)}
        </div>
        <h4><Icon name="merge" />Tidy</h4>
        <div className="chips wrap">
          <button className="chip" onClick={() => { setDrawer(false); setDialog(<MergeDialog pairs={pairs} onClose={close} merge={(a, b) => act(() => call('merge', a, b), 'Merged')} notSame={(a, b) => act(() => call('notTheSame', a, b), 'Kept apart')} />) }}>Merge & fix{pairs.length ? ` (${pairs.length})` : ''}</button>
          <button className="chip" onClick={() => { setDrawer(false); setDialog(<TrashDialog onClose={close} restore={n => act(() => call('restore', n), 'Restored')} />) }}>Trash</button>
          <button className={`chip ${settings?.byLast ? 'on' : ''}`} onClick={() => { window.drive.contactsSetByLast(!settings?.byLast); setSettings(s => s && { ...s, byLast: !s.byLast }) }}>Sort by last name</button>
        </div>
        <h4><Icon name="calendar" />Birthdays go into</h4>
        <div className="chips wrap">
          {settings?.calendars.map(c => <button key={c.id} className={`chip ${settings.birthdays === c.id ? 'on' : ''}`} onClick={() => window.drive.contactsSetBirthdays(c.id).then(() => setSettings(s => s && { ...s, birthdays: c.id }))}>{c.name}</button>)}
        </div>
        <p className="hint">Each birthday and date is a yearly event there, reminded at 9:00 on the day and the day before; change it on the contact and the event follows.</p>
      </div>
      <div className="ct-dock">
        {picked.size ? <nav className="notes-island island">
          <button className="island-item" onClick={() => setDialog(<LabelDialog labels={allLabels} many={many} onClose={close} pick={l => {
            close(); const off = many.every(c => c.labels.some(x => x.toLowerCase() === l.toLowerCase()))
            act(async () => { for (const c of many) await call('save', c.uid, { ...c, categories: off ? c.categories.filter(x => x.toLowerCase() !== l.toLowerCase()) : [...c.categories, l] }) }, off ? `${l} taken off ${many.length}` : `${l} given to ${many.length}`)
          }} />)}><Icon name="tag" size={20} /><span>Label</span></button>
          <button className="island-item" onClick={() => { const on = !many.every(c => c.favourite); act(async () => { for (const c of many) await call('save', c.uid, { ...c, categories: on ? [...c.categories.filter(x => x !== 'starred'), 'starred'] : c.categories.filter(x => x.toLowerCase() !== 'starred') }) }, on ? `${many.length} added to favourites` : `${many.length} not favourites`) }}><Icon name="heart" size={20} /><span>Favourite</span></button>
          <button className="island-item" onClick={() => window.drive.contactsExport(many.map(c => c.uid), `${many.length} contacts`).then(p => p && say('Exported to ' + p))}><Icon name="save" size={20} /><span>Export</span></button>
          {many.length === 2 && <button className="island-item" onClick={() => { const [a, b] = many; setPicked(new Set()); act(() => call('merge', a.uid, b.uid), 'Merged') }}><Icon name="merge" size={20} /><span>Merge</span></button>}
          <button className="island-item" onClick={() => setDialog(<Modal onClose={close}><h3>Delete {many.length} contacts?</h3><p>They go to the Trash, with their birthdays' events, and can be restored from there.</p>
            <div className="dialog-actions"><button className="text-button" onClick={close}>Cancel</button><button className="filled-button danger" onClick={() => { close(); setPicked(new Set()); act(async () => { for (const c of many) await call('trash', c.uid) }, `${many.length} moved to the Trash`) }}>Delete</button></div></Modal>)}>
            <Icon name="trash" size={20} /><span>Delete</span></button>
        </nav> : <nav className="notes-island island">
          {([['all', 'All', 'person'], ['favourites', 'Favourites', 'heart'], ['labels', 'Labels', 'tag']] as const).map(([t, l, icon]) =>
            <button key={t} className={`island-item ${tab === t ? 'on' : ''}`} onClick={() => { setTab(t); setLabel(null); setDrawer(false) }}><Icon name={icon} size={20} /><span>{l}</span></button>)}
          <span className="island-gap" />
          <button className="island-item" title="New contact" onClick={() => { setDrawer(false); setEditing('new') }}><Icon name="add" size={20} /><span>New</span></button>
          <button className={`island-item ${drawer ? 'on' : ''}`} aria-expanded={drawer} onClick={() => setDrawer(d => !d)}><Icon name="more" size={20} /><span>More</span></button>
        </nav>}
      </div>
    </div>
  )
}

/** A contact's page: the round face, name and job, Mail · WhatsApp · Viber, the details in cards. */
function Page({ c, all, edit, openUid, star, keep, say }: { c: Contact; all: Contact[]; edit: () => void; openUid: (uid: string) => void; star: () => void; keep: () => void; say: (t: string) => void }) {
  const open = (how: 'mail' | 'whatsapp' | 'viber' | 'web', v: string) => window.drive.contactsOpen(how, v).catch(e => say(errorText(e)))
  const phone = c.phones[0]?.value, mail = c.emails[0]?.value
  const job = [c.title, [c.org, c.department].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  const Row = ({ label, value, onClick, action }: { label: string; value: string; onClick?: () => void; action?: ReactNode }) =>
    <div className="ct-detail"><div><small>{label}</small>{onClick ? <button className="ct-link" onClick={onClick}>{value}</button> : <span>{value}</span>}</div>{action}</div>
  return (
    <div className="ct-contact">
      <div className="ct-top">
        <button className="round" title={c.favourite ? 'Remove from favourites' : 'Add to favourites'} onClick={star}><Icon name="heart" /></button>
        <button className="text-button" onClick={edit}>Edit</button>
      </div>
      <Face c={c} size={120} />
      <h2>{c.name}{c.favourite && <span className="ct-star"> ★</span>}</h2>
      {job && <p className="hint">{job}</p>}
      <div className="ct-actions">
        <button className="ct-action" disabled={!mail} onClick={() => mail && open('mail', mail)}><Icon name="mail" /><small>Mail</small></button>
        <button className="ct-action" disabled={!phone} onClick={() => phone && open('whatsapp', phone)}><Icon name="chat" /><small>WhatsApp</small></button>
        <button className="ct-action" disabled={!phone} onClick={() => phone && open('viber', phone)}><Icon name="device" /><small>Viber</small></button>
      </div>
      <p className="hint ct-hint">A computer cannot place a phone call itself; calls are made on the phone.</p>
      {(c.versions ?? 1) > 1 && <div className="ct-card"><Row label={`${c.versions} versions (a change on two devices)`} value="This is the newer." action={<button className="text-button" onClick={keep}>Keep this one</button>} /></div>}
      {c.phones.length > 0 && <div className="ct-card">{c.phones.map((p, k) => <Row key={k} label={p.label || 'Phone'} value={p.value}
        action={<span className="chips"><button className="chip" onClick={() => open('whatsapp', p.value)}>WhatsApp</button><button className="chip" onClick={() => open('viber', p.value)}>Viber</button></span>} />)}</div>}
      {c.emails.length > 0 && <div className="ct-card">{c.emails.map((e, k) => <Row key={k} label={e.label || 'Email'} value={e.value} onClick={() => open('mail', e.value)} />)}</div>}
      {(c.birthday || c.dates.length > 0) && <div className="ct-card">
        {c.birthday && <Row label="Birthday" value={dateText(c.birthday, true)} />}
        {c.dates.map((d, k) => { const x = parseDate(d.value); return x && <Row key={k} label={d.label} value={dateText(x, false)} /> })}
      </div>}
      {c.addresses.length > 0 && <div className="ct-card">{c.addresses.map((a, k) => <Row key={k} label={a.label || 'Address'} value={addressText(a)}
        action={<button className="text-button" onClick={() => window.drive.mapsGoogle?.(addressText(a))}>Map</button>} />)}</div>}
      {c.urls.length > 0 && <div className="ct-card">{c.urls.map((u, k) => <Row key={k} label={u.label || 'Website'} value={u.value}
        onClick={() => open('web', u.label === 'Revolut' ? `https://revolut.me/${u.value}` : /:\/\//.test(u.value) ? u.value : 'https://' + u.value)} />)}</div>}
      {c.related.length > 0 && <div className="ct-card">{c.related.map((r, k) => { const o = all.find(x => x.uid !== c.uid && plain(x.name) === plain(r.value)); return <Row key={k} label={r.label || 'Related'} value={r.value} onClick={o ? () => openUid(o.uid) : undefined} /> })}</div>}
      {(c.nickname || c.labels.length > 0 || c.note) && <div className="ct-card">
        {c.nickname && <Row label="Nickname" value={c.nickname} />}
        {c.labels.length > 0 && <Row label="Labels" value={c.labels.join(' · ')} />}
        {c.note && <Row label="Notes" value={c.note} />}
      </div>}
    </div>
  )
}

const PHONE_LABELS = ['Mobile', 'Home', 'Work', 'Main', 'Other']
const PLACE_LABELS = ['Home', 'Work', 'Other']

/** Edit and New: one page, the fields grouped (the phone's), the rest of the file kept as it is. */
function Editor({ start, labels, cancel, save, remove }: { start: Contact | null; labels: string[]; cancel: () => void; save: (c: Contact) => void; remove?: () => void }) {
  const blank: Contact = { uid: '', name: '', prefix: '', given: '', middle: '', family: '', suffix: '', formatted: '', nickname: '', org: '', department: '', title: '',
    phones: [{ label: 'Mobile', value: '' }], emails: [], addresses: [], urls: [], birthday: null, dates: [], related: [], note: '', categories: [], photo: null, photoUrl: null, person: null, favourite: false, labels: [] }
  const [c, setC] = useState<Contact>(start ?? blank)
  const [birthday, setBirthday] = useState(toText(start?.birthday ?? null))
  const [newLabel, setNewLabel] = useState('')
  const [problem, setProblem] = useState('')
  const set = (x: Partial<Contact>) => setC(o => ({ ...o, ...x }))
  const done = () => {
    const b = birthday.trim() ? fromText(birthday) : null
    if (birthday.trim() && !b) return setProblem('The birthday is not a date: write it as 23/10/1985, or 23/10 without the year.')
    const names = [c.prefix, c.given, c.middle, c.family, c.suffix]
    const changed = !start || names.join('|') !== [start.prefix, start.given, start.middle, start.family, start.suffix].join('|')
    const out = { ...c, birthday: b, formatted: changed || !c.formatted ? names.filter(Boolean).join(' ') : c.formatted,
      phones: c.phones.filter(p => p.value.trim()), emails: c.emails.filter(e => e.value.trim()), urls: c.urls.filter(u => u.value.trim()), addresses: c.addresses.filter(a => a.parts.some(Boolean)) }
    if (!out.formatted && !out.org && !out.phones.length && !out.emails.length) return setProblem('Give a name, a company, a phone or an e-mail.')
    save(out)
  }
  const list = (key: 'phones' | 'emails' | 'urls', choices: string[], placeholder: string) => <>
    {c[key].map((f, k) => <div key={k} className="ct-line">
      <select className="field ct-label" value={choices.includes(f.label) ? f.label : f.label ? '…' : ''} onChange={e => { const v = e.target.value; set({ [key]: c[key].map((x, j) => j === k ? { ...x, label: v === '…' ? x.label || 'Custom' : v } : x) }) }}>
        <option value="">—</option>{choices.map(l => <option key={l}>{l}</option>)}{f.label && !choices.includes(f.label) && <option value="…">{f.label}</option>}
      </select>
      <input className="field" placeholder={placeholder} value={f.value} onChange={e => set({ [key]: c[key].map((x, j) => j === k ? { ...x, value: e.target.value } : x) })} />
      <button className="round flat" title="Remove" onClick={() => set({ [key]: c[key].filter((_, j) => j !== k) })}><Icon name="close" /></button>
    </div>)}
    <button className="text-button" onClick={() => set({ [key]: [...c[key], { label: choices[0] ?? '', value: '' }] })}>Add {placeholder.toLowerCase()}</button>
  </>
  return (
    <div className="ct-contact ct-edit">
      <div className="ct-top"><button className="text-button" onClick={cancel}>Cancel</button><h3>{start ? 'Edit contact' : 'New contact'}</h3><button className="filled-button" onClick={done}>Save</button></div>
      <Face c={{ ...c, name: [c.given, c.family].filter(Boolean).join(' ') || c.org }} size={96} />
      <div className="ct-card ct-form">
        <small>Name</small>
        <div className="ct-line"><input className="field" placeholder="First name" value={c.given} onChange={e => set({ given: e.target.value })} /><input className="field" placeholder="Last name" value={c.family} onChange={e => set({ family: e.target.value })} /></div>
        <div className="ct-line"><input className="field" placeholder="Prefix" value={c.prefix} onChange={e => set({ prefix: e.target.value })} /><input className="field" placeholder="Middle name" value={c.middle} onChange={e => set({ middle: e.target.value })} /><input className="field" placeholder="Suffix" value={c.suffix} onChange={e => set({ suffix: e.target.value })} /></div>
        <input className="field" placeholder="Nickname" value={c.nickname} onChange={e => set({ nickname: e.target.value })} />
        <small>Work</small>
        <div className="ct-line"><input className="field" placeholder="Company" value={c.org} onChange={e => set({ org: e.target.value })} /><input className="field" placeholder="Department" value={c.department} onChange={e => set({ department: e.target.value })} /><input className="field" placeholder="Job title" value={c.title} onChange={e => set({ title: e.target.value })} /></div>
        <small>Phone</small>{list('phones', PHONE_LABELS, 'Phone')}
        <small>Email</small>{list('emails', PLACE_LABELS, 'Email')}
        <small>Birthday</small><input className="field" placeholder="23/10/1985, or 23/10" value={birthday} onChange={e => setBirthday(e.target.value)} />
        <small>Address</small>
        {c.addresses.map((a, k) => { const setPart = (i: number, v: string) => set({ addresses: c.addresses.map((x, j) => j === k ? { ...x, parts: x.parts.map((p, n) => n === i ? v : p) } : x) })
          return <div key={k} className="ct-line ct-address">
            <select className="field ct-label" value={a.label} onChange={e => set({ addresses: c.addresses.map((x, j) => j === k ? { ...x, label: e.target.value } : x) })}>{PLACE_LABELS.map(l => <option key={l}>{l}</option>)}</select>
            <input className="field" placeholder="Street" value={a.parts[2]} onChange={e => setPart(2, e.target.value)} />
            <input className="field ct-short" placeholder="Postcode" value={a.parts[5]} onChange={e => setPart(5, e.target.value)} />
            <input className="field" placeholder="City" value={a.parts[3]} onChange={e => setPart(3, e.target.value)} />
            <button className="round flat" title="Remove" onClick={() => set({ addresses: c.addresses.filter((_, j) => j !== k) })}><Icon name="close" /></button>
          </div> })}
        <button className="text-button" onClick={() => set({ addresses: [...c.addresses, { label: 'Home', parts: ['', '', '', '', '', '', ''] }] })}>Add address</button>
        <small>Website</small>{list('urls', ['', 'Revolut'], 'Website')}
        <small>Labels</small>
        <div className="chips wrap">
          <button className={`chip ${c.favourite ? 'on' : ''}`} onClick={() => set({ favourite: !c.favourite, categories: c.favourite ? c.categories.filter(x => x.toLowerCase() !== 'starred') : [...c.categories, 'starred'] })}>★ Favourite</button>
          {[...new Set([...labels, ...c.labels])].map(l => { const on = c.categories.some(x => x.toLowerCase() === l.toLowerCase())
            return <button key={l} className={`chip ${on ? 'on' : ''}`} onClick={() => set({ categories: on ? c.categories.filter(x => x.toLowerCase() !== l.toLowerCase()) : [...c.categories, l], labels: on ? c.labels.filter(x => x !== l) : [...c.labels, l] })}>{l}</button> })}
          <input className="field ct-short" placeholder="New label" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newLabel.trim()) { set({ categories: [...c.categories, newLabel.trim()], labels: [...c.labels, newLabel.trim()] }); setNewLabel('') } }} />
        </div>
        <small>Notes</small><textarea className="field" rows={3} value={c.note} onChange={e => set({ note: e.target.value })} />
        {problem && <p className="error">{problem}</p>}
      </div>
      {remove && <button className="text-button ct-delete" onClick={remove}>Delete contact</button>}
    </div>
  )
}

function MergeDialog({ pairs, onClose, merge, notSame }: { pairs: [Contact, Contact][]; onClose: () => void; merge: (a: string, b: string) => void; notSame: (a: string, b: string) => void }) {
  const [gone, setGone] = useState<Set<number>>(new Set())
  const left = pairs.map((p, k) => [p, k] as const).filter(([, k]) => !gone.has(k))
  return <Modal onClose={onClose}>
    <h3>Merge & fix</h3>
    {left.length === 0 && <p>No one is here twice.</p>}
    <div className="ct-merge">{left.map(([[a, b], k]) => <div key={k} className="ct-card ct-pair">
      <div className="ct-line">{[a, b].map(c => <span key={c.uid} className="ct-who"><Face c={c} size={32} /><span>{c.name}<small>{[...c.phones.map(p => p.value), ...c.emails.map(e => e.value)].slice(0, 2).join(' · ')}</small></span></span>)}</div>
      <div className="dialog-actions"><button className="text-button" onClick={() => { notSame(a.uid, b.uid); setGone(g => new Set(g).add(k)) }}>Not the same</button>
        <button className="filled-button" onClick={() => { merge(a.uid, b.uid); setGone(g => new Set(g).add(k)) }}>Merge</button></div>
    </div>)}</div>
    <div className="dialog-actions">{left.length > 1 && <button className="text-button" onClick={() => { for (const [[a, b]] of left) merge(a.uid, b.uid); onClose() }}>Merge all {left.length}</button>}<button className="filled-button" onClick={onClose}>Done</button></div>
  </Modal>
}

function TrashDialog({ onClose, restore }: { onClose: () => void; restore: (name: string) => void }) {
  const [items, setItems] = useState<{ name: string; contact: Contact }[] | null>(null)
  useEffect(() => { call<{ name: string; contact: Contact }[]>('trashed').then(setItems) }, [])
  return <Modal onClose={onClose}>
    <h3>Trash</h3>
    {items?.length === 0 && <p>No contacts in the Trash.</p>}
    <div className="ct-merge">{items?.map(t => <div key={t.name} className="ct-line ct-who"><Face c={t.contact} size={32} /><span className="ct-name">{t.contact.name}</span>
      <button className="text-button" onClick={() => { restore(t.name); setItems(i => i && i.filter(x => x.name !== t.name)) }}>Restore</button></div>)}</div>
    <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Done</button></div>
  </Modal>
}

function LabelDialog({ labels, many, onClose, pick }: { labels: string[]; many: Contact[]; onClose: () => void; pick: (l: string) => void }) {
  const [name, setName] = useState('')
  return <Modal onClose={onClose}>
    <h3>Label {many.length} contacts</h3>
    <div className="chips wrap">{labels.map(l => <button key={l} className={`chip ${many.every(c => c.labels.some(x => x.toLowerCase() === l.toLowerCase())) ? 'on' : ''}`} onClick={() => pick(l)}>{l}</button>)}</div>
    <input className="field" placeholder="New label" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && pick(name.trim())} />
    <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" disabled={!name.trim()} onClick={() => pick(name.trim())}>Add</button></div>
  </Modal>
}
