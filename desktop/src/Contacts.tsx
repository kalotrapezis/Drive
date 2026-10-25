import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { Modal } from './Dialogs'
import { CallBadge, DIR, key, length, when } from './Phone'
import { lang, t } from './i18n'

// Contacts on the computer (Drive-Android Plan.md § Contacts): the same files as the phone's, read on every look and
// watched; laid out as the tablet's — the list at the left, the open contact at the right, Notes' island and drawer.

type Field = { label: string; value: string }
type Address = { label: string; parts: string[] }
type VDate = { year: number | null; month: number; day: number }
export type Contact = {
  uid: string; name: string; prefix: string; given: string; middle: string; family: string; suffix: string; formatted: string; nickname: string
  org: string; department: string; title: string; phones: Field[]; emails: Field[]; addresses: Address[]; urls: Field[]; birthday: VDate | null
  dates: Field[]; related: Field[]; note: string; categories: string[]; photo: string | null; photoUrl: string | null; person: string | null; face?: string | null; defaultPhone?: string | null
  favourite: boolean; labels: string[]; versions?: number; key?: string
}
type Tab = 'all' | 'favourites' | 'labels'

const call = <T,>(method: string, ...args: unknown[]) => window.drive.contacts<T>(method, ...args)
// The list read once when Tetra opens and kept between visits (the user, 24 Oct: "load faster"): shown at once, then read again
let cached: Contact[] | null = null
export function preloadContacts() { if (!cached) call<Contact[]>('list', false).then(l => { cached ??= l }).catch(() => {}) }
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').trim()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthName = (m: number) => lang() === 'en' ? MONTHS[m - 1] : new Intl.DateTimeFormat(lang(), { month: 'short' }).format(new Date(2000, m - 1, 1))
/** A field's label as written in the file (Mobile, Home, Work…): the language's word for the ones Tetra offers, the rest as they are. */
const LABEL_KEYS: Record<string, string> = Object.fromEntries(['Mobile', 'Home', 'Work', 'Main', 'Other', 'Custom', 'Work fax', 'Home fax', 'Pager', 'Anniversary', 'Date',
  'Spouse', 'Partner', 'Mother', 'Father', 'Parent', 'Brother', 'Sister', 'Child', 'Friend', 'Assistant', 'Manager'].map(l => [l, `contacts.label${l.replace(' ', '')}`]))
const labelText = (l: string) => LABEL_KEYS[l] ? t(LABEL_KEYS[l]) : l
const parseDate = (s: string): VDate | null => {
  let m = /^--(\d{2})-?(\d{2})/.exec(s); if (m) return { year: null, month: +m[1], day: +m[2] }
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s); return m ? { year: +m[1] === 1604 ? null : +m[1], month: +m[2], day: +m[3] } : null
}
/** "23 Oct · turns 41", "12 Jun 2015", "23 Oct". */
function dateText(d: VDate, birthday: boolean) {
  const day = `${d.day} ${monthName(d.month)}`
  if (d.year == null) return day
  const now = new Date(), thisYear = new Date(now.getFullYear(), d.month - 1, d.day)
  const next = thisYear < new Date(now.getFullYear(), now.getMonth(), now.getDate()) ? now.getFullYear() + 1 : now.getFullYear()
  const age = next - d.year
  return birthday && age > 0 && age < 131 ? `${day} · ${next === now.getFullYear() && thisYear.getMonth() === now.getMonth() && thisYear.getDate() === now.getDate() ? t('contacts.ageToday', { age }) : t('contacts.turns', { age })}` : `${day} ${d.year}`
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
  return c.photo ? <img className="ct-face" src={`data:image/jpeg;base64,${c.photo}`} style={{ width: size, height: size }} alt="" loading="lazy" decoding="async" />
    : <span className="ct-face ct-initial" style={{ width: size, height: size, fontSize: size * 0.42 }}>{first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : <Icon name="person" size={size * 0.55} />}</span>
}

export function ContactsPage({ setDialog, say, openPerson }: { setDialog: (d: ReactNode) => void; say: (text: string) => void; openPerson: (id: string, name: string) => void }) {
  const [loaded, setLoaded] = useState<Contact[] | null>(cached)
  const list = loaded ?? []
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
    call<Contact[]>('list', settings?.byLast ?? false).then(l => { cached = l; setLoaded(l) }).catch(e => { setLoaded(l => l ?? []); say(t('contacts.couldNotRead', { error: errorText(e) })) })
    call<[Contact, Contact][]>('pairs').then(setPairs).catch(() => {})
  }, [version, settings?.byLast])
  // a narrow window (the user, 24 Oct): one column as the phone's — the list, then the contact over it with a back button
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const ro = new ResizeObserver(() => setNarrow((root.current?.clientWidth ?? 1200) < 880))
    ro.observe(root.current!)
    return () => ro.disconnect()
  }, [])
  // two columns always show a contact; one column opens one only when it is chosen
  const autoOpened = useRef(false) // the first contact, opened by the two columns, not by the person
  useEffect(() => { if (!narrow && !open && list.length) { setOpen(list[0].uid); autoOpened.current = true } }, [list, narrow])
  useEffect(() => { if (narrow && autoOpened.current) { setOpen(null); autoOpened.current = false } }, [narrow])
  const onPage = narrow && (!!editing || !!open)
  const back = () => { setEditing(null); setOpen(null) }
  const act = async (work: () => Promise<unknown>, said: string) => {
    try { await work(); say(said) } catch (e) { say(t('contacts.notDone', { error: errorText(e) })) }
    setVersion(v => v + 1)
  }
  const shown = useMemo(() => list.filter(c => {
    const q = plain(query), digits = query.replace(/\D/g, '')
    const hit = !q || plain([c.name, c.nickname, c.org].join(' ')).includes(q) || c.emails.some(e => plain(e.value).includes(q)) || (digits.length >= 3 && c.phones.some(p => p.value.replace(/\D/g, '').includes(digits)))
    return hit && (tab === 'favourites' ? c.favourite : tab === 'labels' && label ? c.labels.some(l => l.toLowerCase() === label.toLowerCase()) : true)
  }), [list, query, tab, label])
  const contact = list.find(c => c.uid === open) || null
  // the favourites: a grid of two rows, not a row to scroll (the user, 25 Oct); more than fit: the last cell opens Favourites
  const favs = useMemo(() => list.filter(c => c.favourite), [list])
  const favsBox = useRef<HTMLDivElement>(null)
  const [favCols, setFavCols] = useState(4)
  useEffect(() => {
    const el = favsBox.current
    if (!el) return
    const ro = new ResizeObserver(() => setFavCols(Math.max(1, Math.floor((el.clientWidth - 24 + 14) / (64 + 14)))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [favs.length > 0, tab, query, label])
  const favRoom = favCols * 2
  const allLabels = useMemo(() => [...new Set(list.flatMap(c => c.labels))].sort((a, b) => a.localeCompare(b)), [list])
  const save = (was: Contact | null, c: Contact) => act(async () => { const uid = await call<string>('save', was?.uid ?? null, c); setOpen(uid); setEditing(null) }, was ? t('contacts.saved') : t('contacts.created'))
  const toggle = (uid: string) => setPicked(p => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n })

  const listPane = (
    <aside className="ct-list">
      {tab === 'labels' && !label && !query ? <>
        {allLabels.length === 0 && <p className="hint ct-hint">{t('contacts.noLabels')}</p>}
        {allLabels.map(l => <button key={l} className="ct-row" onClick={() => setLabel(l)}><Icon name="tag" /><span className="ct-name">{l}</span><small>{list.filter(c => c.labels.includes(l)).length}</small></button>)}
      </> : <>
        {label && <div className="chips"><button className="chip on" onClick={() => setLabel(null)}>{label} ✕</button></div>}
        {tab === 'all' && !query && !label && favs.length > 0 && <div className="ct-favs" ref={favsBox}>
          {(favs.length > favRoom ? favs.slice(0, favRoom - 1) : favs).map(c => <button key={c.uid} className="ct-fav" onClick={() => { setOpen(c.uid); autoOpened.current = false }} title={c.name}><Face c={c} size={52} /><small>{c.given || c.name}</small></button>)}
          {favs.length > favRoom && <button className="ct-fav" onClick={() => setTab('favourites')} title={t('contacts.allFavourites')}><span className="ct-face ct-more" style={{ width: 52, height: 52 }}>+{favs.length - favRoom + 1}</span><small>{t('common.all')}</small></button>}
        </div>}
        {loaded === null && <div className="ct-loading"><span className="spinner" />{t('contacts.reading')}</div>}
        {loaded !== null && shown.length === 0 && <p className="hint ct-hint">{list.length === 0 ? t('contacts.empty') : query ? t('contacts.noMatch', { query }) : tab === 'favourites' ? t('contacts.noFavourites') : t('contacts.noOneHere')}</p>}
        {shown.map((c, k) => <div key={c.uid}>
          {!query && (k === 0 || letter(shown[k - 1]) !== letter(c)) && <h4 className="ct-letter">{letter(c)}</h4>}
          <button className={`ct-row ${c.uid === open && !picked.size ? 'on' : ''} ${picked.has(c.uid) ? 'picked' : ''}`}
            onClick={e => { if (e.ctrlKey || e.metaKey || picked.size) toggle(c.uid); else { setOpen(c.uid); setEditing(null); autoOpened.current = false } }}
            onContextMenu={e => { e.preventDefault(); toggle(c.uid) }}>
            {picked.has(c.uid) ? <span className="ct-face ct-check" style={{ width: 40, height: 40 }}><Icon name="checked" /></span> : <Face c={c} size={40} />}
            <span className="ct-name">{c.name}<small>{c.phones[0]?.value || c.emails[0]?.value || c.org}</small></span>
          </button>
        </div>)}
      </>}
    </aside>
  )

  const many = list.filter(c => picked.has(c.uid))
  return (
    <div className={`ct ${narrow ? 'narrow' : ''} ${onPage ? 'on-page' : ''}`} ref={root}>
      <header className="topbar ct-topbar">
        {onPage ? <div className="island title-island ct-search">
          <button className="round flat" title={t('app.contacts')} onClick={back}><Icon name="back" /></button>
          <h1>{editing ? (editing === 'new' ? t('contacts.new') : t('contacts.edit')) : contact?.name}</h1>
        </div> : picked.size ? <div className="island title-island ct-search">
          <button className="round flat" title={t('contacts.doneChoosing')} onClick={() => setPicked(new Set())}><Icon name="close" /></button>
          <h1>{t('contacts.selected', { count: picked.size })}</h1>
          <button className="text-button" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map(c => c.uid)))}>{picked.size === shown.length ? t('common.none') : t('contacts.allN', { n: shown.length })}</button>
        </div> : <div className="island title-island ct-search">
          <Icon name="search" />
          <input placeholder={list.length ? t('contacts.searchN', { count: list.length }) : t('app.contacts')} value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="round flat" title={t('common.clear')} onClick={() => setQuery('')}><Icon name="close" /></button>}
        </div>}
        <div className="tools">
          <button className="round" title={t('contacts.syncNow')} onClick={() => window.drive.calendarRefresh().then(n => say(n ? t('contacts.syncing', { count: n }) : t('contacts.noAnswer')), () => {})}><Icon name="refresh" /></button>
        </div>
      </header>
      <div className="ct-body">
        {!onPage && listPane}
        {(!narrow || onPage) && <section className="ct-page">
          {editing ? <Editor start={editing === 'new' ? null : editing} labels={allLabels} setDialog={setDialog} say={say} cancel={() => setEditing(null)} save={c => save(editing === 'new' ? null : editing, c)}
            remove={editing === 'new' ? undefined : () => { const c = editing; setDialog(<Modal onClose={close}><h3>{t('contacts.deleteOne', { name: c.name })}</h3><p>{t('contacts.deleteOneBody')}</p>
              <div className="dialog-actions"><button className="text-button" onClick={close}>{t('common.cancel')}</button><button className="filled-button danger" onClick={() => { close(); setEditing(null); setOpen(null); act(() => call('trash', c.uid), t('contacts.movedToTrash', { name: c.name })) }}>{t('common.delete')}</button></div></Modal>) }} />
            : contact ? <Page c={contact} all={list} edit={() => setEditing(contact)} openUid={setOpen} openPerson={openPerson} setDialog={setDialog}
              setDefault={n => act(() => call('save', contact.uid, { ...contact, defaultPhone: n }), n ? t('contacts.defaultSet') : t('contacts.noDefault'))} star={() => act(() => call('save', contact.uid, { ...contact, categories: contact.favourite ? contact.categories.filter(x => x.toLowerCase() !== 'starred') : [...contact.categories, 'starred'] }), contact.favourite ? t('contacts.notFavourite') : t('contacts.addedToFavourites'))}
              keep={() => act(() => call('keep', contact.uid), t('contacts.keptVersion'))} say={say} />
            : <p className="hint ct-hint">{t('contacts.choose')}</p>}
        </section>}
      </div>
      <div className={`notes-drawer island ct-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <h4><Icon name="add" />{t('contacts.importExport')}</h4>
        <div className="chips wrap">
          <button className="chip" onClick={() => window.drive.contactsPickImport().then(r => { if (r) { say(t('contacts.imported', { added: r.added }) + (r.same ? t('contacts.importedSame', { same: r.same }) : '')); setVersion(v => v + 1) } }, e => say(t('contacts.couldNotReadFile', { error: errorText(e) })))}>{t('contacts.importFile')}</button>
          <button className="chip" onClick={() => window.drive.contactsExport(null, t('contacts.exportAllName')).then(p => p && say(t('contacts.exportedTo', { path: p })))}>{t('contacts.exportAll')}</button>
          <button className="chip" onClick={() => window.drive.contactsExport(list.filter(c => c.favourite).map(c => c.uid), t('contacts.favouritesName')).then(p => p && say(t('contacts.exportedTo', { path: p })))}>{t('contacts.exportFavourites')}</button>
          {allLabels.map(l => <button key={l} className="chip" onClick={() => window.drive.contactsExport(list.filter(c => c.labels.includes(l)).map(c => c.uid), l).then(p => p && say(t('contacts.exportedTo', { path: p })))}>{t('contacts.exportLabel', { label: l })}</button>)}
        </div>
        <h4><Icon name="merge" />{t('contacts.tidy')}</h4>
        <div className="chips wrap">
          <button className="chip" onClick={() => { setDrawer(false); setDialog(<MergeDialog pairs={pairs} onClose={close} merge={(a, b) => act(() => call('merge', a, b), t('contacts.merged'))} notSame={(a, b) => act(() => call('notTheSame', a, b), t('contacts.keptApart'))} />) }}>{t('contacts.mergeFix')}{pairs.length ? ` (${pairs.length})` : ''}</button>
          <button className="chip" onClick={() => { setDrawer(false); setDialog(<FacesForMany list={list} onClose={close} done={n => { say(t('contacts.photosFromPhotos', { count: n })); setVersion(v => v + 1) }} />) }}>{t('contacts.facesFromPhotos')}</button>
          <button className="chip" onClick={() => { setDrawer(false); setDialog(<TrashDialog onClose={close} restore={n => act(() => call('restore', n), t('contacts.restored'))} />) }}>{t('contacts.trash')}</button>
          <button className={`chip ${settings?.byLast ? 'on' : ''}`} onClick={() => { window.drive.contactsSetByLast(!settings?.byLast); setSettings(s => s && { ...s, byLast: !s.byLast }) }}>{t('contacts.sortByLast')}</button>
        </div>
        <h4><Icon name="calendar" />{t('contacts.birthdaysInto')}</h4>
        <div className="chips wrap">
          {settings?.calendars.map(c => <button key={c.id} className={`chip ${settings.birthdays === c.id ? 'on' : ''}`} onClick={() => window.drive.contactsSetBirthdays(c.id).then(() => setSettings(s => s && { ...s, birthdays: c.id }))}>{c.name}</button>)}
        </div>
        <p className="hint">{t('contacts.birthdaysHint')}</p>
      </div>
      {!onPage && <div className="ct-dock">
        {picked.size ? <nav className="notes-island island">
          <button className="island-item" onClick={() => setDialog(<LabelDialog labels={allLabels} many={many} onClose={close} pick={l => {
            close(); const off = many.every(c => c.labels.some(x => x.toLowerCase() === l.toLowerCase()))
            act(async () => { for (const c of many) await call('save', c.uid, { ...c, categories: off ? c.categories.filter(x => x.toLowerCase() !== l.toLowerCase()) : [...c.categories, l] }) }, off ? t('contacts.labelTakenOff', { label: l, n: many.length }) : t('contacts.labelGiven', { label: l, n: many.length }))
          }} />)}><Icon name="tag" size={20} /><span>{t('contacts.label')}</span></button>
          <button className="island-item" onClick={() => { const on = !many.every(c => c.favourite); act(async () => { for (const c of many) await call('save', c.uid, { ...c, categories: on ? [...c.categories.filter(x => x !== 'starred'), 'starred'] : c.categories.filter(x => x.toLowerCase() !== 'starred') }) }, on ? t('contacts.manyFavourited', { n: many.length }) : t('contacts.manyUnfavourited', { n: many.length })) }}><Icon name="heart" size={20} /><span>{t('contacts.favourite')}</span></button>
          <button className="island-item" onClick={() => window.drive.contactsExport(many.map(c => c.uid), t('contacts.nContactsName', { count: many.length })).then(p => p && say(t('contacts.exportedTo', { path: p })))}><Icon name="save" size={20} /><span>{t('common.export')}</span></button>
          {many.length === 2 && <button className="island-item" onClick={() => { const [a, b] = many; setPicked(new Set()); act(() => call('merge', a.uid, b.uid), t('contacts.merged')) }}><Icon name="merge" size={20} /><span>{t('contacts.merge')}</span></button>}
          <button className="island-item" onClick={() => setDialog(<Modal onClose={close}><h3>{t('contacts.deleteMany', { count: many.length })}</h3><p>{t('contacts.deleteManyBody')}</p>
            <div className="dialog-actions"><button className="text-button" onClick={close}>{t('common.cancel')}</button><button className="filled-button danger" onClick={() => { close(); setPicked(new Set()); act(async () => { for (const c of many) await call('trash', c.uid) }, t('contacts.manyToTrash', { count: many.length })) }}>{t('common.delete')}</button></div></Modal>)}>
            <Icon name="trash" size={20} /><span>{t('common.delete')}</span></button>
        </nav> : <nav className="notes-island island">
          {([['all', 'common.all', 'person'], ['favourites', 'contacts.favourites', 'heart'], ['labels', 'contacts.labels', 'tag']] as const).map(([id, l, icon]) =>
            <button key={id} className={`island-item ${tab === id ? 'on' : ''}`} onClick={() => { setTab(id); setLabel(null); setDrawer(false) }}><Icon name={icon} size={20} /><span>{t(l)}</span></button>)}
          <span className="island-gap" />
          <button className="island-item" title={t('contacts.new')} onClick={() => { setDrawer(false); setEditing('new') }}><Icon name="add" size={20} /><span>{t('common.new')}</span></button>
          <button className={`island-item ${drawer ? 'on' : ''}`} aria-expanded={drawer} onClick={() => setDrawer(d => !d)}><Icon name="more" size={20} /><span>{t('contacts.more')}</span></button>
        </nav>}
      </div>}
    </div>
  )
}

/** A contact's page: its island in the middle (the round face, the name, Call · Mail · WhatsApp · Viber), ♥ and Edit in an
 * island of their own at the right (the user, 24 Oct), the details in cards under it. */
function Page({ c, all, edit, openUid, openPerson, setDialog, setDefault, star, keep, say }: { c: Contact; all: Contact[]; edit: () => void; openUid: (uid: string) => void; setDefault: (n: string | null) => void
  openPerson: (id: string, name: string) => void; setDialog: (d: ReactNode) => void; star: () => void; keep: () => void; say: (t: string) => void }) {
  const open = (how: 'mail' | 'whatsapp' | 'viber' | 'web', v: string) => window.drive.contactsOpen(how, v).catch(e => say(errorText(e)))
  const phone = c.phones[0]?.value, mail = c.emails[0]?.value
  // a number starred as the default (the user, 24 Oct; TYPE=PREF in the file): Call, WhatsApp and Viber go to it at once
  const nums = (c.defaultPhone && c.phones.filter(p => p.value === c.defaultPhone).length ? c.phones.filter(p => p.value === c.defaultPhone) : c.phones)
  const job = [c.title, [c.org, c.department].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  // a call is placed by the paired phone (sync.js callOnPhone): at once, or as a notification to tap there
  const dial = (number: string) => window.drive.contactsCall(number, c.name).then(r => say(r.error ?? (r.how === 'calling' ? t('contacts.callingOn', { name: c.name, device: r.device ?? '' }) : t('contacts.tapToCall', { name: c.name, device: r.device ?? '' }))), e => say(errorText(e)))
  const choose = (title: string, ways: [string, () => void][]) => ways.length === 1 ? ways[0][1]() : setDialog(<Modal onClose={() => setDialog(null)}><h3>{title}</h3>
    <div className="ct-ways">{ways.map(([label, go]) => <button key={label} className="ct-way" onClick={() => { setDialog(null); go() }}>{label}</button>)}</div>
    <div className="dialog-actions"><button className="text-button" onClick={() => setDialog(null)}>{t('common.cancel')}</button></div></Modal>)
  // at the end, the calls with them and their recordings (the user, 25 Oct): the phone's call history (Phone/calls-*.jsonl)
  // by contact or number, the last 50; recordings named "2026-10-25 12.04 <name or number>.ogg" (calls.js)
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof window.drive.phoneHistory>>>([])
  const [recordings, setRecordings] = useState<Awaited<ReturnType<typeof window.drive.phoneRecordings>>>([])
  useEffect(() => {
    const keys = new Set(c.phones.map(p => key(p.value)).filter(k => k.length >= 5))
    const named = (title: string) => plain(title) === plain(c.name.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60)) || keys.has(key(title))
    window.drive.phoneHistory().then(h => setCalls(h.filter(l => l.contact === c.uid || keys.has(key(l.number))).slice(0, 50)), () => setCalls([]))
    window.drive.phoneRecordings().then(r => setRecordings(r.filter(x => named(x.name.replace(/\.[^.]+$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} /, '')))), () => setRecordings([]))
  }, [c.uid, c.name, c.phones.map(p => p.value).join()])
  const callRow = (l: (typeof calls)[number], k: number) => <div key={k} className="ct-detail"><CallBadge dir={l.dir} size={28} />
    <div><small>{`${DIR[l.dir]?.[1] ?? l.dir}${l.secs > 0 ? ' · ' + length(l.secs) : ''}${c.phones.length > 1 ? ' · ' + l.number : ''}`}</small><span style={l.dir === 'missed' ? { color: '#D93A3A' } : undefined}>{when(l.at)}</span></div></div>
  const recordingRow = (r: (typeof recordings)[number]) => <div key={r.name} className="ct-detail"><Icon name="mic" size={20} />
    <div><small>{t('contacts.kb', { n: Math.round(r.size / 1024) })}</small><button className="ct-link" onClick={() => window.drive.phoneOpenRecording(r.name).catch(e => say(errorText(e)))}>{r.name.slice(0, 16).replace('.', ':')}</button></div></div>
  const seeAll = (what: 'History' | 'Recordings') => setDialog(<Modal onClose={() => setDialog(null)}><h3>{what === 'History' ? t('contacts.history') : t('contacts.recordings')} · {c.name}</h3>
    <div className="ct-card ct-all">{what === 'History' ? calls.map(callRow) : recordings.map(recordingRow)}</div>
    <div className="dialog-actions"><button className="text-button" onClick={() => setDialog(null)}>{t('common.close')}</button></div></Modal>)
  const [person, setPerson] = useState<{ name: string; count: number } | null>(null)
  useEffect(() => { setPerson(null); if (c.person) window.drive.people.list().then(ps => { const p = ps.find(x => x.id === c.person); setPerson(p ? { name: p.name, count: p.count } : null) }).catch(() => {}) }, [c.uid, c.person])
  const Row = ({ icon, label, value, onClick, action }: { icon: IconName; label: string; value: string; onClick?: () => void; action?: ReactNode }) =>
    <div className="ct-detail"><Icon name={icon} size={20} /><div><small>{label}</small>{onClick ? <button className="ct-link" onClick={onClick}>{value}</button> : <span>{value}</span>}</div>{action}</div>
  return (
    <div className="ct-contact">
      <Face c={c} size={128} />
      <div className="ct-head">
        <div className="island ct-hero">
          <h2>{c.name}</h2>
          {job && <p className="hint">{job}</p>}
          <div className="ct-actions">
            <button className="ct-action" disabled={!phone} onClick={() => choose(t('contacts.call'), nums.map(p => [`${labelText(p.label) || t('app.phone')} · ${p.value}`, () => dial(p.value)]))}><span><Icon name="call" /></span><small>{t('contacts.call')}</small></button>
            <button className="ct-action" disabled={!mail} onClick={() => choose(t('contacts.mail'), c.emails.map(e => [e.value, () => open('mail', e.value)]))}><span><Icon name="mail" /></span><small>{t('contacts.mail')}</small></button>
            <button className="ct-action" disabled={!phone} onClick={() => choose('WhatsApp', nums.map(p => [`${labelText(p.label) || t('app.phone')} · ${p.value}`, () => open('whatsapp', p.value)]))}><span className="ct-mark"><WhatsAppMark size={56} /></span><small>WhatsApp</small></button>
            <button className="ct-action" disabled={!phone} onClick={() => choose('Viber', nums.map(p => [`${labelText(p.label) || t('app.phone')} · ${p.value}`, () => open('viber', p.value)]))}><span className="ct-mark"><ViberMark size={56} /></span><small>Viber</small></button>
          </div>
        </div>
      </div>
      {/* the user, 24 Oct (with a sketch): the contact's own buttons in an island at the bottom right, the main island in the middle */}
      <nav className="notes-island island ct-corner">
        <button className={`island-item ${c.favourite ? 'ct-faved' : ''}`} onClick={star}><Icon name="heart" size={20} /><span>{c.favourite ? t('contacts.favourite') : t('contacts.addToFavourites')}</span></button>
        <button className="island-item" onClick={edit}><Icon name="edit" size={20} /><span>{t('common.edit')}</span></button>
      </nav>
      {(c.versions ?? 1) > 1 && <div className="ct-card"><Row icon="warning" label={t('contacts.versions', { n: c.versions ?? 1 })} value={t('contacts.thisIsNewer')} action={<button className="text-button" onClick={keep}>{t('contacts.keepThis')}</button>} /></div>}
      {c.phones.length > 0 && <div className="ct-card">{c.phones.map((p, k) => { const isDefault = c.phones.length > 1 && p.value === c.defaultPhone
        return <Row key={k} icon="call" label={(labelText(p.label) || t('app.phone')) + (isDefault ? t('contacts.defaultSuffix') : '')} value={p.value} onClick={() => dial(p.value)}
          action={<span className="ct-marks">
            {c.phones.length > 1 && <button className={`round flat ct-default ${isDefault ? 'on' : ''}`} title={isDefault ? t('contacts.defaultNumber') : t('contacts.makeDefault')} onClick={() => setDefault(isDefault ? null : p.value)}>{isDefault ? '★' : '☆'}</button>}
            <button className="round flat" title={`WhatsApp ${p.value}`} onClick={() => open('whatsapp', p.value)}><WhatsAppMark size={26} /></button>
            <button className="round flat" title={`Viber ${p.value}`} onClick={() => open('viber', p.value)}><ViberMark size={26} /></button>
          </span>} /> })}</div>}
      {c.emails.length > 0 && <div className="ct-card">{c.emails.map((e, k) => <Row key={k} icon="mail" label={labelText(e.label) || t('contacts.email')} value={e.value} onClick={() => open('mail', e.value)} />)}</div>}
      {(c.birthday || c.dates.length > 0) && <div className="ct-card">
        {c.birthday && <Row icon="cake" label={t('contacts.birthday')} value={dateText(c.birthday, true)} />}
        {c.dates.map((d, k) => { const x = parseDate(d.value); return x && <Row key={k} icon="calendar" label={labelText(d.label)} value={dateText(x, false)} /> })}
      </div>}
      {c.addresses.length > 0 && <div className="ct-card">{c.addresses.map((a, k) => <Row key={k} icon="place" label={labelText(a.label) || t('contacts.address')} value={addressText(a)}
        action={<button className="text-button" onClick={() => window.drive.mapsGoogle(addressText(a))}>{t('contacts.map')}</button>} />)}</div>}
      {c.urls.length > 0 && <div className="ct-card">{c.urls.map((u, k) => <Row key={k} icon="external" label={labelText(u.label) || t('contacts.website')} value={u.value}
        onClick={() => open('web', u.label === 'Revolut' ? `https://revolut.me/${u.value}` : /:\/\//.test(u.value) ? u.value : 'https://' + u.value)} />)}</div>}
      {c.related.length > 0 && <div className="ct-card">{c.related.map((r, k) => { const o = all.find(x => x.uid !== c.uid && plain(x.name) === plain(r.value)); return <Row key={k} icon="person" label={labelText(r.label) || t('contacts.related')} value={r.value} onClick={o ? () => openUid(o.uid) : undefined} /> })}</div>}
      {person && c.person && <div className="ct-card"><Row icon="photos" label={t('contacts.inPhotos')} value={`${person.name} · ${t('contacts.photoCount', { count: person.count })}`} onClick={() => openPerson(c.person!, person.name)} /></div>}
      {(c.nickname || c.labels.length > 0 || c.note) && <div className="ct-card">
        {c.nickname && <Row icon="person" label={t('contacts.nickname')} value={c.nickname} />}
        {c.labels.length > 0 && <Row icon="tag" label={t('contacts.labels')} value={c.labels.join(' · ')} />}
        {c.note && <Row icon="notes" label={t('app.notes')} value={c.note} />}
      </div>}
      {/* the latest three of each, See all on its own page; "No recordings so far" (the user, 25 Oct) */}
      {c.phones.length > 0 && <div className="ct-section"><h3>{t('contacts.history')}</h3>{calls.length > 3 && <button className="text-button" onClick={() => seeAll('History')}>{t('contacts.seeAll', { n: calls.length })}</button>}</div>}
      {c.phones.length > 0 && <div className="ct-card">{calls.length ? calls.slice(0, 3).map(callRow) : <p className="hint ct-none">{t('contacts.noCalls')}</p>}</div>}
      <div className="ct-section"><h3>{t('contacts.recordings')}</h3>{recordings.length > 3 && <button className="text-button" onClick={() => seeAll('Recordings')}>{t('contacts.seeAll', { n: recordings.length })}</button>}</div>
      <div className="ct-card">{recordings.length ? recordings.slice(0, 3).map(recordingRow) : <p className="hint ct-none">{t('contacts.noRecordings')}</p>}</div>
    </div>
  )
}

/**
 * A face from Photos as a contact's photo: the face cropped as the phone does (box × 1.8, 512 px), and the contact's name
 * given to a person Photos only knew as "Person 12" (the user, 24 Oct: faces and names both ways).
 */
async function photoFromFace(personId: string, personName: string, faceId: string, contactName: string) {
  const got = await window.drive.contactsFacePhoto(faceId)
  if (/^Person \d+$/.test(personName) && contactName.trim()) await window.drive.people.rename(personId, contactName.trim()).catch(() => {})
  return got
}

/** From Photos: the people Photos knows (those named like the contact first, then the unnamed), then a person's faces. */
function FacePicker({ name, onClose, pick }: { name: string; onClose: () => void; pick: (personId: string, personName: string, faceId: string) => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; count: number; cover: string | null }[] | null>(null)
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null)
  const [faces, setFaces] = useState<{ id: string }[] | null>(null)
  useEffect(() => { window.drive.people.list().then(ps => {
    const first = plain(name).split(' ')[0], score = (p: string) => plain(p) === plain(name) ? 2 : plain(p).split(' ')[0] === first ? 1 : 0
    setPeople([...ps].sort((a, b) => score(b.name) - score(a.name)))
  }).catch(() => setPeople([])) }, [])
  useEffect(() => { if (person) window.drive.people.faces(person.id).then(f => setFaces([...f].sort((a, b) => Number(b.chosen) - Number(a.chosen)).slice(0, 60))) }, [person])
  return <Modal onClose={onClose}>
    {!person ? <>
      <h3>{t('contacts.fromPhotos')}</h3>
      {people === null && <div className="ct-loading"><span className="spinner" />{t('contacts.readingPeople')}</div>}
      {people?.length === 0 && <p>{t('contacts.noFaces')}</p>}
      <div className="ct-faces">{people?.map(p => <button key={p.id} className="ct-fav" onClick={() => setPerson(p)} title={p.name}>
        {p.cover ? <img className="ct-face" src={`media://face/${p.cover}`} style={{ width: 64, height: 64 }} alt="" /> : <span className="ct-face ct-initial" style={{ width: 64, height: 64 }} />}<small>{p.name}</small></button>)}</div>
    </> : <>
      <h3><button className="round flat" title={t('contacts.people')} onClick={() => { setPerson(null); setFaces(null) }}><Icon name="back" /></button>{person.name}</h3>
      {faces === null && <div className="ct-loading"><span className="spinner" /></div>}
      <div className="ct-faces">{faces?.map(f => <button key={f.id} onClick={() => pick(person.id, person.name, f.id)}><img className="ct-face" src={`media://face/${f.id}`} style={{ width: 72, height: 72 }} alt="" /></button>)}</div>
    </>}
    <div className="dialog-actions"><button className="text-button" onClick={onClose}>{t('common.cancel')}</button></div>
  </Modal>
}

/** "Photos knows N of these people": contacts with no photo whose name a named person in Photos has (or a first name only one shares). */
function FacesForMany({ list, onClose, done }: { list: Contact[]; onClose: () => void; done: (n: number) => void }) {
  const [pairs, setPairs] = useState<{ c: Contact; p: { id: string; name: string; cover: string | null } }[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  useEffect(() => { window.drive.people.list().then(ps => {
    const named = ps.filter(p => !/^Person \d+$/.test(p.name) && p.cover)
    const first = (s: string) => plain(s).split(' ')[0]
    const out = list.filter(c => !c.photo).flatMap(c => {
      const same = named.find(p => plain(p.name) === plain(c.name))
      if (same) return [{ c, p: same }]
      const one = named.filter(p => first(p.name) === first(c.name))
      return one.length === 1 && list.filter(x => first(x.name) === first(c.name)).length === 1 ? [{ c, p: one[0] }] : []
    }).filter((x, k, all) => all.findIndex(y => y.p.id === x.p.id) === k)
    setPairs(out); setPicked(new Set(out.map(x => x.c.uid)))
  }).catch(() => setPairs([])) }, [])
  const go = async () => {
    setWorking(true)
    let n = 0
    for (const { c, p } of pairs!.filter(x => picked.has(x.c.uid))) {
      try { const g = await window.drive.contactsFacePhoto(p.cover!); await call('save', c.uid, { ...c, photo: g.photo, face: g.face, photoUrl: null, person: p.id }); n++ } catch {}
    }
    onClose(); done(n)
  }
  return <Modal onClose={onClose}>
    <h3>{pairs === null ? t('contacts.facesFromPhotos') : t('contacts.photosKnows', { count: pairs.length })}</h3>
    {pairs === null && <div className="ct-loading"><span className="spinner" /></div>}
    {pairs?.length === 0 && <p>{t('contacts.noKnownNames')}</p>}
    <div className="ct-merge">{pairs?.map(({ c, p }) => <label key={c.uid} className="ct-line ct-who">
      <input type="checkbox" checked={picked.has(c.uid)} onChange={() => setPicked(s => { const n = new Set(s); if (n.has(c.uid)) n.delete(c.uid); else n.add(c.uid); return n })} />
      <img className="ct-face" src={`media://face/${p.cover}`} style={{ width: 36, height: 36 }} alt="" /><span className="ct-name">{c.name}</span></label>)}</div>
    <div className="dialog-actions"><button className="text-button" onClick={onClose}>{t('contacts.notNow')}</button>
      <button className="filled-button" disabled={working || !picked.size} onClick={go}>{working ? t('contacts.makingPhotos') : t('contacts.useN', { n: picked.size })}</button></div>
  </Modal>
}

const PHONE_LABELS = ['Mobile', 'Home', 'Work', 'Main', 'Other']
const PLACE_LABELS = ['Home', 'Work', 'Other']

/** Edit and New: one page, the fields grouped (the phone's), the rest of the file kept as it is. */
function Editor({ start, labels, cancel, save, remove, setDialog, say }: { start: Contact | null; labels: string[]; cancel: () => void; save: (c: Contact) => void; remove?: () => void; setDialog: (d: ReactNode) => void; say: (t: string) => void }) {
  const blank: Contact = { uid: '', name: '', prefix: '', given: '', middle: '', family: '', suffix: '', formatted: '', nickname: '', org: '', department: '', title: '',
    phones: [{ label: 'Mobile', value: '' }], emails: [], addresses: [], urls: [], birthday: null, dates: [], related: [], note: '', categories: [], photo: null, photoUrl: null, person: null, favourite: false, labels: [] }
  const [c, setC] = useState<Contact>(start ?? blank)
  const [birthday, setBirthday] = useState(toText(start?.birthday ?? null))
  const [newLabel, setNewLabel] = useState('')
  const [problem, setProblem] = useState('')
  const set = (x: Partial<Contact>) => setC(o => ({ ...o, ...x }))
  const done = () => {
    const b = birthday.trim() ? fromText(birthday) : null
    if (birthday.trim() && !b) return setProblem(t('contacts.badBirthday'))
    const names = [c.prefix, c.given, c.middle, c.family, c.suffix]
    const changed = !start || names.join('|') !== [start.prefix, start.given, start.middle, start.family, start.suffix].join('|')
    const out = { ...c, birthday: b, formatted: changed || !c.formatted ? names.filter(Boolean).join(' ') : c.formatted,
      phones: c.phones.filter(p => p.value.trim()), emails: c.emails.filter(e => e.value.trim()), urls: c.urls.filter(u => u.value.trim()), addresses: c.addresses.filter(a => a.parts.some(Boolean)) }
    if (!out.formatted && !out.org && !out.phones.length && !out.emails.length) return setProblem(t('contacts.needSomething'))
    save(out)
  }
  const list = (key: 'phones' | 'emails' | 'urls', choices: string[], placeholder: string, addText: string) => <>
    {c[key].map((f, k) => <div key={k} className="ct-line">
      <select className="field ct-label" value={choices.includes(f.label) ? f.label : f.label ? '…' : ''} onChange={e => { const v = e.target.value; set({ [key]: c[key].map((x, j) => j === k ? { ...x, label: v === '…' ? x.label || 'Custom' : v } : x) }) }}>
        <option value="">—</option>{choices.map(l => <option key={l} value={l}>{labelText(l)}</option>)}{f.label && !choices.includes(f.label) && <option value="…">{labelText(f.label)}</option>}
      </select>
      <input className="field" placeholder={placeholder} value={f.value} onChange={e => set({ [key]: c[key].map((x, j) => j === k ? { ...x, value: e.target.value } : x) })} />
      <button className="round flat" title={t('common.remove')} onClick={() => set({ [key]: c[key].filter((_, j) => j !== k) })}><Icon name="close" /></button>
    </div>)}
    <button className="text-button" onClick={() => set({ [key]: [...c[key], { label: choices[0] ?? '', value: '' }] })}>{addText}</button>
  </>
  return (
    <div className="ct-contact ct-edit">
      <h3 className="ct-edit-title">{start ? t('contacts.edit') : t('contacts.new')}</h3>
      <nav className="notes-island island ct-corner">
        <button className="island-item" onClick={cancel}><Icon name="close" size={20} /><span>{t('common.cancel')}</span></button>
        <button className="island-item on" onClick={done}><Icon name="checked" size={20} /><span>{t('common.save')}</span></button>
      </nav>
      <Face c={{ ...c, name: [c.given, c.family].filter(Boolean).join(' ') || c.org }} size={96} />
      <div className="ct-photo-tools">
        <button className="text-button" onClick={() => setDialog(<FacePicker name={[c.given, c.family].filter(Boolean).join(' ')} onClose={() => setDialog(null)} pick={(pid, pname, fid) => {
          setDialog(null)
          photoFromFace(pid, pname, fid, [c.given, c.family].filter(Boolean).join(' ') || c.formatted).then(g => set({ photo: g.photo, face: g.face, photoUrl: null, person: pid }), e => say(t('contacts.noPhoto', { error: errorText(e) })))
        }} />)}>{t('contacts.fromPhotos')}</button>
        <label className="text-button">{t('contacts.choosePicture')}<input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) squarePicture(f).then(g => set({ photo: g.photo, face: g.face, photoUrl: null, person: c.person || crypto.randomUUID() }), () => say(t('contacts.pictureUnreadable'))) }} /></label>
        {(c.photo || c.photoUrl) && <button className="text-button" onClick={() => set({ photo: null, photoUrl: null, face: null })}>{t('common.remove')}</button>}
      </div>
      <div className="ct-card ct-form">
        <small>{t('common.name')}</small>
        <div className="ct-line"><input className="field" placeholder={t('contacts.firstName')} value={c.given} onChange={e => set({ given: e.target.value })} /><input className="field" placeholder={t('contacts.lastName')} value={c.family} onChange={e => set({ family: e.target.value })} /></div>
        <div className="ct-line"><input className="field" placeholder={t('contacts.prefix')} value={c.prefix} onChange={e => set({ prefix: e.target.value })} /><input className="field" placeholder={t('contacts.middleName')} value={c.middle} onChange={e => set({ middle: e.target.value })} /><input className="field" placeholder={t('contacts.suffix')} value={c.suffix} onChange={e => set({ suffix: e.target.value })} /></div>
        <input className="field" placeholder={t('contacts.nickname')} value={c.nickname} onChange={e => set({ nickname: e.target.value })} />
        <small>{t('contacts.work')}</small>
        <div className="ct-line"><input className="field" placeholder={t('contacts.company')} value={c.org} onChange={e => set({ org: e.target.value })} /><input className="field" placeholder={t('contacts.department')} value={c.department} onChange={e => set({ department: e.target.value })} /><input className="field" placeholder={t('contacts.jobTitle')} value={c.title} onChange={e => set({ title: e.target.value })} /></div>
        <small>{t('app.phone')}</small>{list('phones', PHONE_LABELS, t('app.phone'), t('contacts.addPhone'))}
        <small>{t('contacts.email')}</small>{list('emails', PLACE_LABELS, t('contacts.email'), t('contacts.addEmail'))}
        <small>{t('contacts.birthday')}</small><input className="field" placeholder={t('contacts.birthdayPlaceholder')} value={birthday} onChange={e => setBirthday(e.target.value)} />
        <small>{t('contacts.address')}</small>
        {c.addresses.map((a, k) => { const setPart = (i: number, v: string) => set({ addresses: c.addresses.map((x, j) => j === k ? { ...x, parts: x.parts.map((p, n) => n === i ? v : p) } : x) })
          return <div key={k} className="ct-line ct-address">
            <select className="field ct-label" value={a.label} onChange={e => set({ addresses: c.addresses.map((x, j) => j === k ? { ...x, label: e.target.value } : x) })}>{PLACE_LABELS.map(l => <option key={l} value={l}>{labelText(l)}</option>)}</select>
            <input className="field" placeholder={t('contacts.street')} value={a.parts[2]} onChange={e => setPart(2, e.target.value)} />
            <input className="field ct-short" placeholder={t('contacts.postcode')} value={a.parts[5]} onChange={e => setPart(5, e.target.value)} />
            <input className="field" placeholder={t('contacts.city')} value={a.parts[3]} onChange={e => setPart(3, e.target.value)} />
            <button className="round flat" title={t('common.remove')} onClick={() => set({ addresses: c.addresses.filter((_, j) => j !== k) })}><Icon name="close" /></button>
          </div> })}
        <button className="text-button" onClick={() => set({ addresses: [...c.addresses, { label: 'Home', parts: ['', '', '', '', '', '', ''] }] })}>{t('contacts.addAddress')}</button>
        <small>{t('contacts.website')}</small>{list('urls', ['', 'Revolut'], t('contacts.website'), t('contacts.addWebsite'))}
        <small>{t('contacts.labels')}</small>
        <div className="chips wrap">
          <button className={`chip ${c.favourite ? 'on' : ''}`} onClick={() => set({ favourite: !c.favourite, categories: c.favourite ? c.categories.filter(x => x.toLowerCase() !== 'starred') : [...c.categories, 'starred'] })}>★ {t('contacts.favourite')}</button>
          {[...new Set([...labels, ...c.labels])].map(l => { const on = c.categories.some(x => x.toLowerCase() === l.toLowerCase())
            return <button key={l} className={`chip ${on ? 'on' : ''}`} onClick={() => set({ categories: on ? c.categories.filter(x => x.toLowerCase() !== l.toLowerCase()) : [...c.categories, l], labels: on ? c.labels.filter(x => x !== l) : [...c.labels, l] })}>{l}</button> })}
          <input className="field ct-short" placeholder={t('contacts.newLabel')} value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newLabel.trim()) { set({ categories: [...c.categories, newLabel.trim()], labels: [...c.labels, newLabel.trim()] }); setNewLabel('') } }} />
        </div>
        <small>{t('app.notes')}</small><textarea className="field" rows={3} value={c.note} onChange={e => set({ note: e.target.value })} />
        {problem && <p className="error">{problem}</p>}
      </div>
      {remove && <button className="text-button ct-delete" onClick={remove}>{t('contacts.delete')}</button>}
    </div>
  )
}

function MergeDialog({ pairs, onClose, merge, notSame }: { pairs: [Contact, Contact][]; onClose: () => void; merge: (a: string, b: string) => void; notSame: (a: string, b: string) => void }) {
  const [gone, setGone] = useState<Set<number>>(new Set())
  const left = pairs.map((p, k) => [p, k] as const).filter(([, k]) => !gone.has(k))
  return <Modal onClose={onClose}>
    <h3>{t('contacts.mergeFix')}</h3>
    {left.length === 0 && <p>{t('contacts.noTwice')}</p>}
    <div className="ct-merge">{left.map(([[a, b], k]) => <div key={k} className="ct-card ct-pair">
      <div className="ct-line">{[a, b].map(c => <span key={c.uid} className="ct-who"><Face c={c} size={32} /><span>{c.name}<small>{[...c.phones.map(p => p.value), ...c.emails.map(e => e.value)].slice(0, 2).join(' · ')}</small></span></span>)}</div>
      <div className="dialog-actions"><button className="text-button" onClick={() => { notSame(a.uid, b.uid); setGone(g => new Set(g).add(k)) }}>{t('contacts.notTheSame')}</button>
        <button className="filled-button" onClick={() => { merge(a.uid, b.uid); setGone(g => new Set(g).add(k)) }}>{t('contacts.merge')}</button></div>
    </div>)}</div>
    <div className="dialog-actions">{left.length > 1 && <button className="text-button" onClick={() => { for (const [[a, b]] of left) merge(a.uid, b.uid); onClose() }}>{t('contacts.mergeAll', { n: left.length })}</button>}<button className="filled-button" onClick={onClose}>{t('common.done')}</button></div>
  </Modal>
}

function TrashDialog({ onClose, restore }: { onClose: () => void; restore: (name: string) => void }) {
  const [items, setItems] = useState<{ name: string; contact: Contact }[] | null>(null)
  useEffect(() => { call<{ name: string; contact: Contact }[]>('trashed').then(setItems) }, [])
  return <Modal onClose={onClose}>
    <h3>{t('contacts.trash')}</h3>
    {items?.length === 0 && <p>{t('contacts.trashEmpty')}</p>}
    <div className="ct-merge">{items?.map(it => <div key={it.name} className="ct-line ct-who"><Face c={it.contact} size={32} /><span className="ct-name">{it.contact.name}</span>
      <button className="text-button" onClick={() => { restore(it.name); setItems(i => i && i.filter(x => x.name !== it.name)) }}>{t('common.restore')}</button></div>)}</div>
    <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.done')}</button></div>
  </Modal>
}

function LabelDialog({ labels, many, onClose, pick }: { labels: string[]; many: Contact[]; onClose: () => void; pick: (l: string) => void }) {
  const [name, setName] = useState('')
  return <Modal onClose={onClose}>
    <h3>{t('contacts.labelMany', { count: many.length })}</h3>
    <div className="chips wrap">{labels.map(l => <button key={l} className={`chip ${many.every(c => c.labels.some(x => x.toLowerCase() === l.toLowerCase())) ? 'on' : ''}`} onClick={() => pick(l)}>{l}</button>)}</div>
    <input className="field" placeholder={t('contacts.newLabel')} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && pick(name.trim())} />
    <div className="dialog-actions"><button className="text-button" onClick={onClose}>{t('common.cancel')}</button><button className="filled-button" disabled={!name.trim()} onClick={() => pick(name.trim())}>{t('common.add')}</button></div>
  </Modal>
}

/**
 * Any picture as a contact's photo: its middle square, 512 px, a JPEG in base64 (the phone's "Choose a picture"), and its
 * X-TETRA-FACE — the picture's SHA-256 and that square — so the face in it can join Photos under this contact (contactfaces.js).
 */
async function squarePicture(file: File): Promise<{ photo: string; face: string }> {
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('')
  const img = new Image()
  img.src = URL.createObjectURL(file)
  await img.decode()
  const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h), out = Math.min(512, side)
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = out
  canvas.getContext('2d')!.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out)
  URL.revokeObjectURL(img.src)
  const r4 = (n: number) => Math.round(n * 10000) / 10000
  return { photo: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], face: `${sha};${[(w - side) / 2 / w, (h - side) / 2 / h, (w + side) / 2 / w, (h + side) / 2 / h].map(r4).join(',')}` }
}

/** WhatsApp's and Viber's marks, plain drawings of Tetra's own in their colours (the phone draws the same: ic_whatsapp, ic_viber). */
function WhatsAppMark({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#25D366" d="M12 2C6.5 2 2 6.4 2 11.9c0 1.9.5 3.7 1.5 5.2L2 22l5-1.4c1.5.8 3.2 1.2 5 1.2 5.5 0 10-4.4 10-9.9S17.5 2 12 2z" />
    <path fill="#fff" d="M8.7 7.3c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.6 1.1 2.7c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.7 3.2.7.5-.1 1.6-.7 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.2-.2-.5-.3l-1.7-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.2-.3 0-.4.1-.5l.4-.4.2-.4c.1-.1 0-.3 0-.4l-.7-1.9z" />
  </svg>
}
function ViberMark({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#7360F2" d="M6 2h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-5l-4.5 3.5V18H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" />
    <path fill="#fff" transform="translate(6 15.2) scale(0.0098)" d="M798-120q-125 0-247-54.5T329-329Q229-429 174.5-551T120-798q0-18 12-30t30-12h162q14 0 25 9.5t13 22.5l26 140q2 16-1 27t-11 19l-97 98q20 37 47.5 71.5T387-386q31 31 65 57.5t72 48.5l94-94q9-9 23.5-13.5T670-390l138 28q14 4 23 14.5t9 23.5v162q0 18-12 30t-30 12Z" />
    <path fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" d="M13.6 6.4a3.2 3.2 0 0 1 2.6 2.6M13.6 4.4a5.2 5.2 0 0 1 4.6 4.6" />
  </svg>
}
