import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import type { Contact } from './Contacts'

// The Phone on the computer (Drive-Android Plan.md § Phone): the phone's call history as it sends it (Phone/calls-*.jsonl,
// written while Tetra is the phone's phone app), the contacts with a number, the recordings, and a keypad — a call is
// placed by the phone (the same way as Contacts' Call). Laid out as Contacts: the list at the left, the keypad at the right,
// the island in the middle at the bottom.

type Logged = { at: string; number: string; dir: 'in' | 'out' | 'missed' | 'declined' | 'blocked' | 'voicemail'; secs: number; contact?: string; name?: string; note?: string }
type Recording = { name: string; size: number; at: number }
type Tab = 'recents' | 'favourites' | 'contacts' | 'recordings'
const PHONE = '#168C93'
const key = (n: string) => n.replace(/\D/g, '').slice(-9)
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const KEYS: [string, string][] = [['1', ''], ['2', 'ABC ΑΒΓ'], ['3', 'DEF ΔΕΖ'], ['4', 'GHI ΗΘΙ'], ['5', 'JKL ΚΛΜ'], ['6', 'MNO ΝΞΟ'], ['7', 'PQRS ΠΡΣ'], ['8', 'TUV ΤΥΦ'], ['9', 'WXYZ ΧΨΩ'], ['*', ''], ['0', '+'], ['#', '']]
const DIR = { in: ['callReceived', 'Incoming'], out: ['callMade', 'Outgoing'], missed: ['callMissed', 'Missed'], declined: ['callEnd', 'Declined'], blocked: ['block', 'Blocked'], voicemail: ['callReceived', 'Voicemail'] } as const
const when = (iso: string) => {
  const d = new Date(iso), now = new Date(), day = 86_400_000
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const ago = (startOf(now) - startOf(d)) / day
  return ago === 0 ? time : ago === 1 ? `Yesterday ${time}` : ago < 7 ? `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
const length = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)

function Face({ c, size }: { c?: Pick<Contact, 'photo' | 'name'>; size: number }) {
  const first = c?.name.trim()[0]
  return c?.photo ? <img className="ct-face" src={`data:image/jpeg;base64,${c.photo}`} style={{ width: size, height: size }} alt="" />
    : <span className="ct-face ct-initial" style={{ width: size, height: size, fontSize: size * 0.42 }}>{first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : <Icon name="person" size={size * 0.55} />}</span>
}

export function PhonePage({ say }: { say: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>('recents')
  const [query, setQuery] = useState('')
  const [calls, setCalls] = useState<Logged[] | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [number, setNumber] = useState('')
  const [missedOnly, setMissedOnly] = useState(false)
  useEffect(() => {
    const look = () => {
      window.drive.phoneHistory().then(setCalls, () => setCalls([]))
      window.drive.phoneRecordings().then(setRecordings, () => {})
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
    window.drive.contactsCall(n, name || who(n)?.name || '').then(r => say(r.error ? r.error : r.how === 'notification' ? 'The phone shows it: tap to call' : `Calling on ${r.device || 'the phone'}`), e => say(errorText(e)))
  }
  const shownCalls = (calls || []).filter(l => (!missedOnly || l.dir === 'missed') && matches(who(l.number)?.name || l.name, [l.number]))
  const people = contacts.filter(c => c.phones.length && (tab !== 'favourites' || c.favourite) && matches(c.name, c.phones.map(p => p.value)))
  const typed = number.replace(/[^\d+*#]/g, '')
  const found = typed.replace(/\D/g, '').length >= 3 ? contacts.filter(c => c.phones.some(p => p.value.replace(/\D/g, '').includes(typed.replace(/\D/g, '')))).slice(0, 4) : []

  return (
    <div className="ct" style={{ ['--ct' as string]: PHONE }}>
      <header className="topbar ct-topbar">
        <div className="island title-island ct-search">
          <Icon name="search" />
          <input placeholder={`Search ${tab}`} value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="round flat" title="Clear" onClick={() => setQuery('')}><Icon name="close" /></button>}
        </div>
      </header>
      <div className="ct-body">
        <section className="ct-list">
          {tab === 'recents' && <>
            <div className="chips"><button className={`chip ${!missedOnly ? 'on' : ''}`} onClick={() => setMissedOnly(false)}>All</button><button className={`chip ${missedOnly ? 'on' : ''}`} onClick={() => setMissedOnly(true)}>Missed</button></div>
            {calls && !calls.length && <p className="hint ct-hint">The phone's calls show here once Tetra is the phone's phone app (Settings › Phone on the phone).</p>}
            {shownCalls.map((l, i) => {
              const c = who(l.number), [icon, what] = DIR[l.dir] || DIR.in
              return <div key={l.at + i} className="ct-row" title={l.note || undefined}>
                <Face c={c} size={40} />
                <span className="ct-name"><span style={l.dir === 'missed' ? { color: '#d93a3a' } : undefined}>{c?.name || l.name || l.number || 'Hidden number'}</span>
                  <small><span style={{ verticalAlign: 'middle', color: l.dir === 'missed' ? '#d93a3a' : 'var(--ct)' }}><Icon name={icon} size={14} /></span> {what} · {when(l.at)}{l.secs > 0 ? ` · ${length(l.secs)}` : ''}{l.note ? ` · ${l.note}` : ''}</small></span>
                {l.number && <button className="round flat" title="Call" onClick={() => callNow(l.number, c?.name)}><Icon name="call" /></button>}
              </div>
            })}
          </>}
          {(tab === 'favourites' || tab === 'contacts') && <>
            {!people.length && <p className="hint ct-hint">{tab === 'favourites' ? 'Star people in Contacts and they show here.' : 'No contacts with a number.'}</p>}
            {people.map(c => <div key={c.uid} className="ct-row">
              <Face c={c} size={40} />
              <span className="ct-name">{c.name}<small>{c.defaultPhone || c.phones[0].value}</small></span>
              <button className="round flat" title="Call" onClick={() => callNow(c.defaultPhone || c.phones[0].value, c.name)}><Icon name="call" /></button>
            </div>)}
          </>}
          {tab === 'recordings' && <>
            {!recordings.length && <p className="hint ct-hint">Calls recorded on this computer show here.</p>}
            {recordings.filter(r => matches(r.name, [])).map(r => <button key={r.name} className="ct-row" onClick={() => window.drive.phoneOpenRecording(r.name).catch(e => say(errorText(e)))}>
              <span className="ct-face ct-initial" style={{ width: 40, height: 40 }}><Icon name="mic" size={22} /></span>
              <span className="ct-name">{r.name.replace(/\.[^.]+$/, '')}<small>{Math.round(r.size / 1024)} KB</small></span>
            </button>)}
          </>}
        </section>
        <section className="ct-page">
          <div className="ph-pad">
            <input className="ph-number" value={number} placeholder="Number" onChange={e => setNumber(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') callNow(typed) }} />
            <div className="ph-found">{found.map(c => <button key={c.uid} className="chip" onClick={() => setNumber(c.phones.find(p => p.value.replace(/\D/g, '').includes(typed.replace(/\D/g, '')))?.value || '')}>{c.name}</button>)}</div>
            <div className="ph-keys">{KEYS.map(([d, l]) => <button key={d} onClick={() => setNumber(n => n + d)}><b>{d}</b><small>{l}</small></button>)}</div>
            <div className="ph-call">
              <span />
              <button className="ph-dial" title="Call on the phone" disabled={!typed} onClick={() => callNow(typed)}><Icon name="call" size={28} /></button>
              <button className="round flat" title="Delete" onClick={() => setNumber(n => n.slice(0, -1))}><Icon name="back" /></button>
            </div>
            <p className="hint">The phone places the call; its sound is on this computer when the phone is connected by Bluetooth (Settings › Calls).</p>
          </div>
        </section>
      </div>
      <div className="ct-dock ph-dock">
        <nav className="notes-island island">
          {([['recents', 'Recents', 'history'], ['favourites', 'Favourites', 'heart'], ['contacts', 'Contacts', 'person'], ['recordings', 'Recordings', 'mic']] as const).map(([t, l, icon]) =>
            <button key={t} className={`island-item ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}><Icon name={icon} size={20} /><span>{l}</span></button>)}
        </nav>
      </div>
    </div>
  )
}
