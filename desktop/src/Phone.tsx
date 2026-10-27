import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { Contact } from './Contacts'
import { lang, t } from './i18n'
import { international } from './phonecountry'

// The Phone on the computer (Drive-Android Plan.md § Phone): the phone's call history as it sends it (Phone/calls-*.jsonl,
// written while Tetra is the phone's phone app), the contacts with a number, the recordings, and a keypad — a call is
// placed by the phone (the same way as Contacts' Call). Laid out as Contacts: the list at the left, the keypad at the right,
// the island in the middle at the bottom.

type Logged = { at: string; number: string; dir: 'in' | 'out' | 'missed' | 'declined' | 'blocked' | 'voicemail'; secs: number; contact?: string; name?: string; note?: string }
type Recording = { name: string; size: number; at: number }
type Tab = 'recents' | 'favourites' | 'contacts' | 'recordings'
const PHONE = '#168C93'
export const key = (n: string) => n.replace(/\D/g, '').slice(-9)
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const KEYS: [string, string][] = [['1', ''], ['2', 'ABC ΑΒΓ'], ['3', 'DEF ΔΕΖ'], ['4', 'GHI ΗΘΙ'], ['5', 'JKL ΚΛΜ'], ['6', 'MNO ΝΞΟ'], ['7', 'PQRS ΠΡΣ'], ['8', 'TUV ΤΥΦ'], ['9', 'WXYZ ΧΨΩ'], ['*', ''], ['0', '+'], ['#', '']]
// the words are read once, as the module loads: a change of language reloads the page
export const DIR = { in: ['callReceived', t('phone.dirIn')], out: ['callMade', t('phone.dirOut')], missed: ['callMissed', t('phone.dirMissed')], declined: ['callEnd', t('phone.dirDeclined')], blocked: ['block', t('phone.dirBlocked')], voicemail: ['callReceived', t('phone.dirVoicemail')] } as const
const LOCALE = lang() === 'en' ? 'en-GB' : lang()
// a white arrow on a coloured round (the user, 25 Oct: "barely noticeable what is what"): in green, out blue, missed and declined red
const DIR_COLOR = { in: '#2E9E5B', out: '#2F7DD9', missed: '#D93A3A', declined: '#D93A3A', blocked: '#7A7F84', voicemail: '#2E9E5B' } as const
export function CallBadge({ dir, size }: { dir: Logged['dir']; size: number }) {
  return <span className="call-badge" style={{ width: size, height: size, background: DIR_COLOR[dir] ?? DIR_COLOR.in }} title={(DIR[dir] || DIR.in)[1]}><Icon name={(DIR[dir] || DIR.in)[0]} size={Math.round(size * 0.68)} /></span>
}
export const when = (iso: string) => {
  const d = new Date(iso), now = new Date(), day = 86_400_000
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
  const ago = (startOf(now) - startOf(d)) / day
  return ago === 0 ? time : ago === 1 ? `${t('common.yesterday')} ${time}` : ago < 7 ? `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${time}` : d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
export const length = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)

function Face({ c, size }: { c?: Pick<Contact, 'photo' | 'name'>; size: number }) {
  const first = c?.name.trim()[0]
  return c?.photo ? <img className="ct-face" src={`data:image/jpeg;base64,${c.photo}`} style={{ width: size, height: size }} alt="" />
    : <span className="ct-face ct-initial" style={{ width: size, height: size, fontSize: size * 0.42 }}>{first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : <Icon name="person" size={size * 0.55} />}</span>
}

/**
 * The first [step] of a long list, and more as its end nears: the phone's thousand calls made at once kept the window busy
 * 0.3 s each time the Phone opened (25 Oct). [more] goes on an empty element after the rows.
 */
function useFirst<T>(all: T[], step = 60): [T[], (el: HTMLElement | null) => void] {
  const [n, setN] = useState(step)
  const io = useRef<IntersectionObserver | null>(null)
  const more = useCallback((el: HTMLElement | null) => {
    io.current?.disconnect()
    if (!el) return
    io.current = new IntersectionObserver(([e]) => { if (e.isIntersecting) setN(x => x + step) }, { rootMargin: '600px' })
    io.current.observe(el)
  }, [step])
  return [all.slice(0, n), more]
}

export function PhonePage({ say }: { say: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>('recents')
  const [query, setQuery] = useState('')
  const [calls, setCalls] = useState<Logged[] | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [number, setNumber] = useState('')
  const [filter, setFilter] = useState<'all' | 'missed' | 'spam'>('all')
  const [spam, setSpam] = useState<{ number: string; note: string }[]>([])
  const [country, setCountry] = useState('') // the paired phone's, else this computer's (main.js phoneCountry)
  const [adding, setAdding] = useState('')
  useEffect(() => {
    const look = () => {
      window.drive.phoneHistory().then(setCalls, () => setCalls([]))
      window.drive.phoneRecordings().then(setRecordings, () => {})
      window.drive.phoneSpam().then(setSpam, () => {})
      window.drive.phoneCountry().then(setCountry, () => {})
      window.drive.contacts<Contact[]>('list', false).then(setContacts, () => {})
    }
    look()
    const t = setInterval(look, 20_000) // the phone's copy arrives by sync; a look now and then is enough here
    return () => clearInterval(t)
  }, [])
  const byKey = useMemo(() => new Map(contacts.flatMap(c => c.phones.map(p => [key(p.value), c] as const)).filter(([k]) => k.length >= 5)), [contacts])
  const who = (n: string) => byKey.get(key(n))
  const q = query.trim().toLowerCase(), qd = query.replace(/\D/g, '')
  const matches = (name: string | undefined, numbers: string[]) => !q || (name || '').toLowerCase().includes(q) || (qd.length > 0 && numbers.some(n => n.replace(/\D/g, '').includes(qd)))
  const callNow = (n: string, name?: string) => {
    if (!n.trim()) return
    window.drive.contactsCall(n, name || who(n)?.name || '').then(r => say(r.error ? r.error : r.how === 'notification' ? t('phone.tapToCall') : t('phone.callingOn', { device: r.device || t('phone.thePhone') })), e => say(errorText(e)))
  }
  const shownCalls = (calls || []).filter(l => (filter !== 'missed' || l.dir === 'missed') && matches(who(l.number)?.name || l.name, [l.number]))
  const [firstCalls, moreCalls] = useFirst(shownCalls)
  // the same rule as the phone's (PhoneSpam.matches): the last nine digits, or a range's start
  const national = (n: string) => international(n, country)
  const isSpam = (n: string) => spam.some(e => e.number.endsWith('*') ? national(n).startsWith(national(e.number.slice(0, -1))) && e.number.replace(/\D/g, '').length >= 2 : key(e.number).length >= 5 && key(e.number) === key(n))
  // a number caught by a range (69800*): the range's line is changed in the Spam list, not from the number
  const inRange = (n: string) => spam.some(e => e.number.endsWith('*') && national(n).startsWith(national(e.number.slice(0, -1))) && e.number.replace(/\D/g, '').length >= 2)
  const markSpam = (n: string, on: boolean) => window.drive.phoneSetSpam(n, on).then(l => { setSpam(l); say(on ? t('phone.spamOn') : t('phone.spamOff')) }, e => say(errorText(e)))
  const lookUp = (n: string) => { const d = national(n); return d.startsWith('+30') && d.length === 13 ? `https://www.callinsider.gr/gr/${d.slice(3)}` : null }
  const people = contacts.filter(c => c.phones.length && (tab !== 'favourites' || c.favourite) && matches(c.name, c.phones.map(p => p.value)))
  const typed = number.replace(/[^\d+*#]/g, '')
  const found = typed.replace(/\D/g, '').length >= 3 ? contacts.filter(c => c.phones.some(p => p.value.replace(/\D/g, '').includes(typed.replace(/\D/g, '')))).slice(0, 4) : []

  return (
    <div className="ct" style={{ ['--ct' as string]: PHONE }}>
      <header className="topbar ct-topbar">
        <div className="island title-island ct-search">
          <Icon name="search" />
          <input placeholder={t(`phone.search_${tab}`)} value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="round flat" title={t('common.clear')} onClick={() => setQuery('')}><Icon name="close" /></button>}
        </div>
      </header>
      <div className="ct-body">
        <section className="ct-list">
          {tab === 'recents' && <>
            <div className="chips">{(['all', 'missed', 'spam'] as const).map(f => <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? t('common.all') : f === 'missed' ? t('phone.missed') : t('phone.spamN', { n: spam.length })}</button>)}</div>
            {filter === 'spam' ? <>
              <p className="hint ct-hint">{t('phone.spamHint')}</p>
              {spam.map(e => <div key={e.number} className="ct-row">
                <span className="ct-face ct-initial" style={{ width: 40, height: 40, background: '#d93a3a' }}><Icon name="block" size={22} /></span>
                <span className="ct-name">{e.number}{e.note && <small>{e.note}</small>}</span>
                <button className="text-button" onClick={() => markSpam(e.number, false)}>{t('common.remove')}</button>
              </div>)}
              <div className="ct-row"><input className="ph-number" style={{ fontSize: 16, textAlign: 'left' }} placeholder={t('phone.spamPlaceholder')} value={adding} onChange={e => setAdding(e.target.value.replace(/[^\d+* ]/g, ''))} />
                <button className="text-button" disabled={!/\d/.test(adding)} onClick={() => { markSpam(adding.replace(/ /g, ''), true); setAdding('') }}>{t('common.add')}</button></div>
            </> : <>
            {calls && !calls.length && <p className="hint ct-hint">{t('phone.noCalls')}</p>}
            {firstCalls.map((l, i) => {
              const c = who(l.number), [, what] = DIR[l.dir] || DIR.in
              return <div key={l.at + i} className="ct-row" title={l.note || undefined}>
                <Face c={c} size={40} />
                <span className="ct-name"><span style={l.dir === 'missed' ? { color: '#d93a3a' } : undefined}>{c?.name || l.name || l.number || t('phone.hiddenNumber')}</span>
                  <small>{l.number && isSpam(l.number) && <b style={{ color: '#d93a3a' }}>{t('phone.spam')} · </b>}<CallBadge dir={l.dir} size={18} /> {what} · {when(l.at)}{l.secs > 0 ? ` · ${length(l.secs)}` : ''}{l.note ? ` · ${l.note}` : ''}</small></span>
                {l.number && !c && lookUp(l.number) && <button className="round flat" title={t('phone.lookUp')} onClick={() => window.drive.contactsOpen('web', lookUp(l.number)!)}><Icon name="search" /></button>}
                {l.number && !c && !inRange(l.number) && <button className="round flat" title={isSpam(l.number) ? t('phone.notSpam') : t('phone.markSpam')} onClick={() => markSpam(l.number, !isSpam(l.number))}><span style={{ color: isSpam(l.number) ? 'var(--muted)' : '#d93a3a', display: 'grid' }}><Icon name="block" /></span></button>}
                {l.number && <button className="round flat" title={t('phone.call')} onClick={() => callNow(l.number, c?.name)}><Icon name="call" /></button>}
              </div>
            })}
            {firstCalls.length < shownCalls.length && <div ref={moreCalls} />}
            </>}
          </>}
          {(tab === 'favourites' || tab === 'contacts') && <>
            {!people.length && <p className="hint ct-hint">{tab === 'favourites' ? t('phone.noFavourites') : t('phone.noContacts')}</p>}
            {people.map(c => <div key={c.uid} className="ct-row">
              <Face c={c} size={40} />
              <span className="ct-name">{c.name}<small>{c.defaultPhone || c.phones[0].value}</small></span>
              <button className="round flat" title={t('phone.call')} onClick={() => callNow(c.defaultPhone || c.phones[0].value, c.name)}><Icon name="call" /></button>
            </div>)}
          </>}
          {tab === 'recordings' && <>
            {!recordings.length && <p className="hint ct-hint">{t('phone.noRecordings')}</p>}
            {recordings.filter(r => matches(r.name, [])).map(r => <button key={r.name} className="ct-row" onClick={() => window.drive.phoneOpenRecording(r.name).catch(e => say(errorText(e)))}>
              <span className="ct-face ct-initial" style={{ width: 40, height: 40 }}><Icon name="mic" size={22} /></span>
              <span className="ct-name">{r.name.replace(/\.[^.]+$/, '')}<small>{Math.round(r.size / 1024)} KB</small></span>
            </button>)}
          </>}
        </section>
        <section className="ct-page">
          <div className="ph-pad">
            <input className="ph-number" value={number} placeholder={t('phone.number')} onChange={e => setNumber(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') callNow(typed) }} />
            <div className="ph-found">{found.map(c => <button key={c.uid} className="chip" onClick={() => setNumber(c.phones.find(p => p.value.replace(/\D/g, '').includes(typed.replace(/\D/g, '')))?.value || '')}>{c.name}</button>)}</div>
            <div className="ph-keys">{KEYS.map(([d, l]) => <button key={d} onClick={() => setNumber(n => n + d)}><b>{d}</b><small>{l}</small></button>)}</div>
            <div className="ph-call">
              <span />
              <button className="ph-dial" title={t('phone.callOnPhone')} disabled={!typed} onClick={() => callNow(typed)}><Icon name="call" size={28} /></button>
              <button className="round flat" title={t('common.delete')} onClick={() => setNumber(n => n.slice(0, -1))}><Icon name="back" /></button>
            </div>
            <p className="hint">{t('phone.padHint')}</p>
          </div>
        </section>
      </div>
      <div className="ct-dock ph-dock">
        <nav className="notes-island island">
          {([['recents', 'phone.recents', 'history'], ['favourites', 'phone.favourites', 'heart'], ['contacts', 'app.contacts', 'person'], ['recordings', 'phone.recordings', 'mic']] as const).map(([id, l, icon]) =>
            <button key={id} className={`island-item ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}><Icon name={icon} size={20} /><span>{t(l)}</span></button>)}
        </nav>
      </div>
    </div>
  )
}
