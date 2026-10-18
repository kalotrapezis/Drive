import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal, errorText } from './Dialogs'
import { Icon } from './Icon'

// Tetra's Calendar on the computer (Drive-Android Plan.md § Calendar): Google Calendar on the web — a side panel with
// Create, a small month and the calendars' coloured boxes; a day, week, month or agenda view. The events are the .ics
// files in Files/Calendar (calendar.js); a change made there by Claude, another app or a sync shows as it lands.

type Cal = { id: string; name: string; color: string }
type Alarm = { days: number; seconds: number; repeat?: number; every?: number; fromEnd?: boolean; at?: number }
type Occ = {
  calendar: string; file: string; versions: number; uid: string; title: string; place: string; notes: string; allDay: boolean
  start: number; end: number; day: number; repeating: boolean; rrule: string | null; startDate: string | null; endDate: string | null
  alarms: Alarm[]; masterStart: number | null; masterDate: string | null; dayDate: string
}
type When = { date: string; time?: string }
type Draft = { title: string; place: string; notes: string; allDay: boolean; start: When; end: When; rrule: string | null; alarms: Alarm[] }
type View = 'day' | 'week' | 'month' | 'agenda'
type Scope = 'one' | 'following' | 'all'

const call = <T,>(method: string, ...args: unknown[]) => window.drive.calendar<T>(method, ...args)
const PINK = '#F41879'
const PALETTE = ['#E91E63', '#D50000', '#E67C73', '#F4511E', '#F6BF26', '#33B679', '#0B8043', '#039BE5', '#3F51B5', '#7986CB', '#8E24AA', '#616161']
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const stored = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }

// ——— dates as 'YYYY-MM-DD' in this computer's clock ———
const pad = (n: number) => String(n).padStart(2, '0')
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }
const addDays = (k: string, n: number) => { const d = parse(k); d.setDate(d.getDate() + n); return key(d) }
const addMonths = (k: string, n: number) => { const d = parse(k); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return key(d) }
const between = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000)
const weekday = (k: string) => (parse(k).getDay() + 6) % 7 // Monday 0, as Greece's weeks
const weekOf = (k: string) => { const s = addDays(k, -weekday(k)); return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(s, i)) }
const monthCells = (k: string) => { const first = k.slice(0, 8) + '01'; const s = addDays(first, -weekday(first)); return Array.from({ length: 42 }, (_, i) => addDays(s, i)) }
const fmt = (k: string, o: Intl.DateTimeFormatOptions) => parse(k).toLocaleDateString('en-GB', o)
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const hm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const length = (min: number) => min <= 0 ? '' : min % 1440 === 0 ? `${min / 1440}d` : min < 60 ? `${min}m` : min % 60 === 0 ? `${min / 60}h` : `${Math.floor(min / 60)}h ${min % 60}m`

/** The days an occurrence covers: an all-day trip each of its days, a late party the next morning too. */
function daysOf(o: Occ): string[] {
  const s = o.allDay ? o.startDate! : key(new Date(o.start))
  const e = o.allDay ? addDays(o.endDate!, -1) : key(new Date(o.end - 1))
  const out = [s]
  for (let d = s; d < e && out.length < 366;) out.push(d = addDays(d, 1))
  return out
}

// ——— words for repeats and reminders (the phone's, the same) ———
const ORD: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '5': 'fifth', '-1': 'last', '-2': 'second last' }
const dayName = (code: string) => DAY_NAMES[DAYS.indexOf(code.slice(-2))] ?? code
function repeatPresets(date: string): [string | null, string][] {
  const code = DAYS[weekday(date)], nth = Math.floor((+date.slice(8) - 1) / 7) + 1, name = DAY_NAMES[weekday(date)]
  return [[null, 'Does not repeat'], ['FREQ=DAILY', 'Daily'], [`FREQ=WEEKLY;BYDAY=${code}`, `Weekly on ${name}`],
    [`FREQ=MONTHLY;BYDAY=${nth}${code}`, `Monthly on the ${ORD[nth]} ${name}`], ['FREQ=MONTHLY', `Monthly on day ${+date.slice(8)}`],
    ['FREQ=YEARLY', `Yearly on ${fmt(date, { day: 'numeric', month: 'long' })}`], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday (Monday to Friday)']]
}
function repeatText(rule: string | null, date: string): string | null {
  if (!rule) return null
  const p = Object.fromEntries(rule.split(';').filter(x => x.includes('=')).map(x => [x.split('=')[0].toUpperCase(), x.slice(x.indexOf('=') + 1)]))
  const n = +(p.INTERVAL || 1), unit = ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as Record<string, string>)[p.FREQ]
  if (!unit) return 'Repeats'
  const byDay = (p.BYDAY || '').split(',').filter(Boolean)
  const weekdays = unit === 'week' && n === 1 && [...byDay].sort().join() === 'FR,MO,TH,TU,WE'
  const head = weekdays ? 'Every weekday' : n === 1 ? ({ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' } as Record<string, string>)[unit] : `Every ${n} ${unit}s`
  const on = weekdays ? '' : unit === 'week' ? ' on ' + (byDay.length ? byDay.map(dayName).join(', ') : DAY_NAMES[weekday(date)])
    : unit === 'month' && byDay.length ? ` on the ${ORD[byDay[0].slice(0, -2) || p.BYSETPOS] ? ORD[byDay[0].slice(0, -2) || p.BYSETPOS] + ' ' : ''}${dayName(byDay[0])}`
    : unit === 'month' ? ` on day ${p.BYMONTHDAY || +date.slice(8)}` : unit === 'year' ? ` on ${fmt(date, { day: 'numeric', month: 'long' })}` : ''
  const end = p.COUNT ? `, ${p.COUNT} times` : p.UNTIL ? `, until ${fmt(`${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}`, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''
  return head + on + end
}
function span(sec: number) {
  const s = Math.abs(sec)
  if (s && s % 604800 === 0) return `${s / 604800} week${s > 604800 ? 's' : ''}`
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60)
  return [d && `${d} day${d > 1 ? 's' : ''}`, h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`].filter(Boolean).join(' ')
}
/** "30 minutes before", "The day before at 09:00", "3 days before at 09:00 · every day, 3 times" ([start]: 'HH:MM' of the event). */
function alarmText(a: Alarm, allDay: boolean, start: string): string {
  const t = a.days * 86400 + a.seconds
  let base: string
  if (a.at != null) base = 'At ' + new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  else if (a.fromEnd) base = t === 0 ? 'At the end' : `${span(t)} ${t < 0 ? 'before' : 'after'} the end`
  else if (t <= 0 && (allDay || t <= -86400)) {
    const [h, m] = (allDay ? '00:00' : start).split(':').map(Number)
    const fire = h * 3600 + m * 60 + a.seconds // seconds into the day, a.days days on
    const before = -a.days - Math.floor(fire / 86400)
    const clock = ((fire % 86400) + 86400) % 86400
    const c = `${pad(Math.floor(clock / 3600))}:${pad(Math.floor(clock % 3600 / 60))}`
    base = before === 0 ? `On the day at ${c}` : before === 1 ? `The day before at ${c}` : before === 7 ? `A week before at ${c}` : `${before} days before at ${c}`
  } else base = t === 0 ? 'At the time' : `${span(t)} ${t < 0 ? 'before' : 'after'}`
  return a.repeat ? `${base} · every ${span(a.every || 0).replace(/^1 /, '')}, ${a.repeat + 1} times` : base
}
const toSec = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60 }
/** N days before at a clock time, counted from the start as RFC 5545 has it; daily: and each day after until the event. */
const daysBeforeAt = (start: string, days: number, at: string, daily: boolean): Alarm =>
  ({ days: -days, seconds: toSec(at) - toSec(start), repeat: daily ? Math.max(days - 1, 0) : 0, every: daily ? 86400 : 0 })
const presetAlarms = (allDay: boolean, start: string): Alarm[] => allDay
  ? [0, 1, 2, 7].map(d => daysBeforeAt('00:00', d, '09:00', false))
  : [0, 5, 10, 15, 30, 60, 1440].map(m => ({ days: 0, seconds: -m * 60 }))
const defaultAlarms = (allDay: boolean, start: string) => [allDay ? daysBeforeAt('00:00', 1, '09:00', false) : { days: 0, seconds: -1800 }]
/** A reminder "N days before at 09:00" stays at 09:00 when its event moves to another hour. */
const keepClock = (alarms: Alarm[], from: string, to: string) => from === to ? alarms : alarms.map(a => {
  if (a.at != null || a.fromEnd || a.days * 86400 + a.seconds > -86400) return a
  const fire = toSec(from) + a.seconds, before = -a.days - Math.floor(fire / 86400), clock = ((fire % 86400) + 86400) % 86400
  return { ...a, days: -before, seconds: clock - toSec(to) }
})

const onColor = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 ? '#000' : '#fff' }

export function CalendarPage({ setDialog, say }: { setDialog: (d: ReactNode) => void; say: (text: string) => void }) {
  const today = key(new Date())
  const [selected, setSelected] = useState(today)
  const [view, setView] = useState<View>((stored('calendarView') as View) || 'month')
  const [cals, setCals] = useState<Cal[]>([])
  const [occ, setOcc] = useState<Occ[]>([])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(JSON.parse(stored('calendarHidden') || '[]')))
  const [drawer, setDrawer] = useState(false)
  const [version, setVersion] = useState(0)
  const [settings, setSettings] = useState<{ reminders: boolean; autostart: boolean } | null>(null)
  const close = () => setDialog(null)
  const range = useMemo(() => {
    const days = view === 'month' ? monthCells(selected) : view === 'week' ? weekOf(selected) : view === 'day' ? [selected] : Array.from({ length: 61 }, (_, i) => addDays(selected, i))
    const mini = monthCells(selected)
    return [Math.min(parse(days[0]).getTime(), parse(mini[0]).getTime()), Math.max(parse(addDays(days[days.length - 1], 1)).getTime(), parse(addDays(mini[41], 1)).getTime())]
  }, [view, selected])
  useEffect(() => {
    let live = true
    Promise.all([call<Cal[]>('calendars'), call<Occ[]>('occurrences', range[0], range[1])]).then(([c, o]) => { if (live) { setCals(c); setOcc(o) } })
    return () => { live = false }
  }, [range, version])
  useEffect(() => window.drive.onCalendarChanged(() => setVersion(v => v + 1)), [])
  useEffect(() => { window.drive.calendarSettings().then(setSettings) }, [])
  const color = (id: string) => cals.find(c => c.id === id)?.color ?? PALETTE[0]
  const byDay = useMemo(() => {
    const m = new Map<string, Occ[]>()
    for (const o of occ) if (!hidden.has(o.calendar)) for (const d of daysOf(o)) m.set(d, [...(m.get(d) ?? []), o])
    for (const l of m.values()) l.sort((a, b) => (+!a.allDay - +!b.allDay) || a.start - b.start)
    return m
  }, [occ, hidden])
  const toggle = (id: string) => setHidden(h => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); store('calendarHidden', JSON.stringify([...n])); return n })
  const go = (v: View) => { setView(v); store('calendarView', v) }
  const step = (n: number) => setSelected(s => view === 'day' ? addDays(s, n) : view === 'month' ? addMonths(s, n) : addDays(s, 7 * n))
  const title = view === 'day' ? fmt(selected, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? ((w => w[0].slice(5, 7) === w[6].slice(5, 7) ? fmt(w[0], { month: 'long', year: 'numeric' }) : `${fmt(w[0], { month: 'short' })} – ${fmt(w[6], { month: 'short', year: 'numeric' })}`)(weekOf(selected)))
    : fmt(selected, { month: 'long', year: 'numeric' })

  async function act(work: () => Promise<unknown>, said: string) {
    try { await work(); say(said) } catch (e) { say('Not saved: ' + errorText(e)) }
    setVersion(v => v + 1)
  }
  function create(date: string, hour?: number) {
    const now = new Date()
    const h = hour ?? (date === today ? Math.min(now.getHours() + 1, 23) : 9)
    const start = `${pad(h)}:00`, end = `${pad(Math.min(h + 1, 23))}:${h + 1 > 23 ? '59' : '00'}`
    const visible = cals.filter(c => !hidden.has(c.id))
    const cal = visible.find(c => c.id === stored('calendarLast'))?.id ?? visible[0]?.id ?? cals[0]?.id ?? null
    setDialog(<EventEditor cals={cals} calendar={cal} isNew draft={{ title: '', place: '', notes: '', allDay: false, start: { date, time: start }, end: { date, time: end }, rrule: null, alarms: defaultAlarms(false, start) }}
      onClose={close} onSave={(d, to) => { close(); store('calendarLast', to ?? ''); act(async () => { await call('save', null, to ?? await call<string>('newCalendar', 'Personal', PALETTE[0]), d) }, 'Event created') }} />)
  }
  function edit(o: Occ) {
    const draft: Draft = { title: o.title, place: o.place, notes: o.notes, allDay: o.allDay, rrule: o.rrule, alarms: o.alarms,
      start: o.allDay ? { date: o.startDate! } : { date: key(new Date(o.start)), time: hm(o.start) },
      end: o.allDay ? { date: addDays(o.endDate!, -1) } : { date: key(new Date(o.end)), time: hm(o.end) } }
    const save = (d: Draft, to: string | null, scope: Scope | null) => act(async () => {
      if (!o.repeating || !scope) { await call('save', o.file, to, d); return }
      if (scope === 'one') return call('saveDay', o.file, o.day, d)
      if (scope === 'following' && o.masterStart != null && o.day > o.masterStart) {
        await call('endBefore', o.file, o.day)
        return call('save', null, to, { ...d, rrule: d.rrule?.split(';').filter(p => !/^COUNT=/i.test(p)).join(';') || null })
      }
      // all: the change of this day moved onto the series' own start
      const startDate = addDays(o.masterDate ?? d.start.date, between(o.dayDate, d.start.date))
      await call('save', o.file, to, { ...d, start: { ...d.start, date: startDate }, end: { ...d.end, date: addDays(startDate, between(d.start.date, d.end.date)) } })
    }, 'Saved')
    setDialog(<EventEditor cals={cals} calendar={o.calendar} draft={draft} onClose={close} onSave={(d, to) => {
      if (o.repeating) setDialog(<ScopeDialog deleting={false} onClose={close} onPick={s => { close(); save(d, to, s) }} />)
      else { close(); save(d, to, null) }
    }} />)
  }
  function remove(o: Occ) {
    const del = (scope: Scope | null) => act(async () => {
      if (!o.repeating || !scope || scope === 'all' || (scope === 'following' && (o.masterStart == null || o.day <= o.masterStart))) return call('trash', o.file)
      return scope === 'one' ? call('skipDay', o.file, o.day) : call('endBefore', o.file, o.day)
    }, 'Deleted')
    if (o.repeating) setDialog(<ScopeDialog deleting onClose={close} onPick={s => { close(); del(s) }} />)
    else del(null)
  }
  function open(o: Occ) {
    setDialog(<EventCard o={o} cal={cals.find(c => c.id === o.calendar)} onClose={close} onEdit={() => edit(o)} onDelete={() => { close(); remove(o) }}
      onKeep={() => { close(); act(() => call('keep', o.file), 'Kept this version; the other went to the Trash') }} />)
  }
  function editCalendar(c: Cal | null) {
    setDialog(<CalendarDialog cal={c} taken={cals.map(x => x.name)} onClose={close}
      onSave={(name, col) => { close(); act(() => c ? call('setCalendar', c.id, name, col) : call('newCalendar', name, col), c ? 'Saved' : `Calendar ${name} created`) }}
      onExport={() => { close(); window.drive.calendarExport(c!.id).then(p => p && say('Exported to ' + p)) }}
      onDelete={() => setDialog(<Modal onClose={close}><h3>Delete {c!.name}?</h3>
        <p>The calendar's folder and all its events go to Tetra's Trash, on every device after the next sync. They can be restored from the Trash.</p>
        <div className="dialog-actions"><button className="text-button" onClick={close}>Cancel</button>
          <button className="filled-button danger" onClick={() => { close(); act(() => call('deleteCalendar', c!.id), `${c!.name} moved to the Trash`) }}>Delete</button></div></Modal>)} />)
  }
  async function importFile() {
    const found = await window.drive.calendarPickImport().catch(e => { say('Could not read it: ' + errorText(e)); return null })
    if (!found) return
    if (!found.length) return say('No events in that file.')
    setDialog(<ImportDialog found={found} cals={cals} onClose={close} onImport={choices => {
      close()
      window.drive.calendarImport(choices).then(r => say(`Imported: ${r.added} new${r.updated ? `, ${r.updated} updated` : ''}`), e => say('Not imported: ' + errorText(e))).finally(() => setVersion(v => v + 1))
    }} />)
  }

  // Tetra's island at the bottom (as Notes and Files): the views, New event and Calendars, which opens the drawer with
  // the rest — the user, 18 Oct: "not hamburger menu an island that is close to the UX we are using to the rest".
  const VIEWS: [View, string, string][] = [['day', 'Day', 'tablet'], ['week', 'Week', 'grid'], ['month', 'Month', 'calendar'], ['agenda', 'Agenda', 'list']]
  return (
    <div className="cal">
      {/* Files' own top: the title in an island, the dates' controls in one beside it */}
      <header className="topbar cal-topbar">
        <div className="island title-island"><Icon name="calendar" /><h1>{title}</h1></div>
        <div className="island title-island cal-nav">
          <button className="text-button" onClick={() => setSelected(today)}>Today</button>
          <button className="round flat" title="Previous" onClick={() => step(-1)}><Icon name="back" /></button>
          <button className="round flat" title="Next" onClick={() => step(1)}><Icon name="forward" /></button>
        </div>
      </header>
      <section className="cal-main">
        {view === 'month' && <MonthGrid selected={selected} today={today} byDay={byDay} color={color} pick={d => setSelected(d)} create={create} open={open} />}
        {(view === 'week' || view === 'day') && <TimeGrid dates={view === 'week' ? weekOf(selected) : [selected]} today={today} byDay={byDay} color={color} open={open} create={create} />}
        {view === 'agenda' && <Agenda from={selected} today={today} byDay={byDay} color={color} open={open} />}
      </section>
      <div className={`notes-drawer island cal-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <MiniMonth selected={selected} today={today} busy={byDay} pick={d => { setSelected(d); setDrawer(false) }} />
        <div className="cal-drawer-list">
          <h4><Icon name="calendar" size={18} />My calendars</h4>
          {cals.length === 0 && <p className="muted">No calendars yet. Each folder in Files › Calendar is one.</p>}
          {cals.map(c => (
            <div key={c.id} className="cal-row">
              <label><input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} style={{ accentColor: c.color }} />{c.name}</label>
              <button className="round small" title={`${c.name}: colour, name, export, delete`} onClick={() => { setDrawer(false); editCalendar(c) }}><Icon name="more" size={18} /></button>
            </div>
          ))}
          <div className="cal-two">
            <button className="text-button cal-left" onClick={() => { setDrawer(false); editCalendar(null) }}><Icon name="add" size={18} />New calendar</button>
            <button className="text-button" onClick={() => { setDrawer(false); importFile() }}>Import</button>
            {cals.length > 0 && <button className="text-button" onClick={() => { setDrawer(false); window.drive.calendarExport(null).then(p => p && say('Exported to ' + p)) }}>Export all</button>}
          </div>
          {settings && <>
            <label className="cal-switch"><input type="checkbox" checked={settings.reminders} onChange={e => { const on = e.target.checked; setSettings({ ...settings, reminders: on }); window.drive.calendarSetReminders(on) }} />Reminders on this computer</label>
            <label className="cal-switch"><input type="checkbox" checked={settings.autostart} onChange={e => { const on = e.target.checked; setSettings({ ...settings, autostart: on }); window.drive.calendarSetAutostart(on) }} />Start Tetra when I log in, in the tray, so reminders ring</label>
          </>}
        </div>
      </div>
      <div className="notes-dock">
        <nav className="notes-island island">
          {VIEWS.map(([v, label, icon]) => <button key={v} className={`island-item ${view === v ? 'on' : ''}`} onClick={() => { go(v); setDrawer(false) }}><Icon name={icon as never} size={20} /><span>{label}</span></button>)}
          <span className="island-gap" />
          <button className="island-item" title="New event" onClick={() => { setDrawer(false); create(selected) }}><Icon name="add" size={20} /><span>New event</span></button>
          <button className={`island-item ${drawer ? 'on' : ''}`} aria-expanded={drawer} onClick={() => setDrawer(d => !d)}><Icon name="calendar" size={20} /><span>Calendars</span></button>
        </nav>
      </div>
    </div>
  )
}

function MiniMonth({ selected, today, busy, pick }: { selected: string; today: string; busy: Map<string, Occ[]>; pick: (d: string) => void }) {
  const [month, setMonth] = useState(selected)
  useEffect(() => setMonth(selected), [selected])
  return (
    <div className="cal-mini">
      <div className="cal-mini-head"><span>{fmt(month, { month: 'long', year: 'numeric' })}</span>
        <button className="round small" title="Previous month" onClick={() => setMonth(m => addMonths(m, -1))}><Icon name="back" size={18} /></button>
        <button className="round small" title="Next month" onClick={() => setMonth(m => addMonths(m, 1))}><Icon name="forward" size={18} /></button></div>
      <div className="cal-mini-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="muted">{d}</span>)}
        {monthCells(month).map(d => (
          <button key={d} className={`${d === selected ? 'on' : ''} ${d === today ? 'today' : ''} ${d.slice(5, 7) !== month.slice(5, 7) ? 'out' : ''} ${busy.has(d) ? 'busy' : ''}`} onClick={() => pick(d)}>{+d.slice(8)}</button>
        ))}
      </div>
    </div>
  )
}

function Chip({ o, day, color, open }: { o: Occ; day: string; color: (id: string) => string; open: (o: Occ) => void }) {
  const c = color(o.calendar)
  if (o.allDay) return <button className="cal-chip all" style={{ background: c, color: onColor(c) }} onClick={e => { e.stopPropagation(); open(o) }}>{o.title || '(No title)'}</button>
  return <button className="cal-chip" onClick={e => { e.stopPropagation(); open(o) }}><i style={{ background: c }} />{key(new Date(o.start)) === day ? time(o.start) + ' ' : ''}{o.title || '(No title)'}</button>
}

// shortcut: an event of several days is a chip on each day, not one bar across them (Google's); a bar when asked.
function MonthGrid({ selected, today, byDay, color, pick, create, open }: { selected: string; today: string; byDay: Map<string, Occ[]>; color: (id: string) => string; pick: (d: string) => void; create: (d: string) => void; open: (o: Occ) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(3)
  useEffect(() => {
    const ro = new ResizeObserver(() => { const h = ref.current!.clientHeight / 6; setFit(Math.max(0, Math.floor((h - 30) / 22))) })
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="cal-month">
      <div className="cal-weekdays">{['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(d => <span key={d}>{d}</span>)}</div>
      <div className="cal-month-grid" ref={ref}>
        {monthCells(selected).map(d => {
          const list = byDay.get(d) ?? []
          const n = list.length <= fit ? list.length : Math.max(fit - 1, 0)
          return (
            <div key={d} className={`cal-cell ${d.slice(5, 7) !== selected.slice(5, 7) ? 'out' : ''}`} onClick={() => pick(d)} onDoubleClick={() => create(d)}>
              <span className={`cal-num ${d === today ? 'today' : ''} ${d === selected ? 'on' : ''}`}>{+d.slice(8) === 1 ? fmt(d, { day: 'numeric', month: 'short' }) : +d.slice(8)}</span>
              {list.slice(0, n).map(o => <Chip key={o.file + o.start} o={o} day={d} color={color} open={open} />)}
              {list.length > n && <button className="cal-more" onClick={e => { e.stopPropagation(); pick(d) }}>{list.length - n} more</button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The day's timed events laid out as Google does, so every title stays readable: starts within a quarter of an hour
 * share the width side by side; a later one cascades over a longer one, indented; under half an hour is a small chip
 * that never takes width from a long one. (The phone's dayBlocks, the same.)
 */
function blocks(day: string, list: Occ[]) {
  const s0 = parse(day).getTime()
  const b = list.map(o => {
    const from = Math.max(0, Math.min(1440, Math.round((o.start - s0) / 60000)))
    const to = Math.max(0, Math.min(1440, Math.round((o.end - s0) / 60000)))
    return { o, from, to: Math.min(Math.max(to, from + 22), 1440), short: to - from < 30, left: 0, width: 1 }
  }).sort((a, z) => a.from - z.from || z.to - a.to)
  const groups: (typeof b)[] = []
  for (const x of b) {
    const g = groups[groups.length - 1]
    if (g && x.short === g[0].short && x.from - g[g.length - 1].from < 15 && x.from < Math.max(...g.map(y => y.to))) g.push(x)
    else groups.push([x])
  }
  groups.forEach((g, i) => {
    const depth = Math.min(3, groups.slice(0, i).filter(e => Math.max(...e.map(y => y.to)) > g[0].from).length)
    const left = depth * 0.14
    g.forEach((x, k) => { x.left = left + (1 - left) * k / g.length; x.width = (1 - left) / g.length })
  })
  return b
}

function TimeGrid({ dates, today, byDay, color, open, create }: { dates: string[]; today: string; byDay: Map<string, Occ[]>; color: (id: string) => string; open: (o: Occ) => void; create: (d: string, h?: number) => void }) {
  const HOUR = 48
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { scroll.current!.scrollTop = HOUR * 7.5 }, [])
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])
  const allDay = dates.map(d => (byDay.get(d) ?? []).filter(o => o.allDay))
  return (
    <div className="cal-time">
      <div className="cal-time-head">
        <span />
        {dates.map(d => <div key={d} className={d === today ? 'today' : ''}><small>{fmt(d, { weekday: 'short' }).toUpperCase()}</small><b>{+d.slice(8)}</b></div>)}
      </div>
      {allDay.some(l => l.length) && <div className="cal-time-all"><span />{allDay.map((l, i) => <div key={i}>{l.map(o => <Chip key={o.file + o.start} o={o} day={dates[i]} color={color} open={open} />)}</div>)}</div>}
      <div className="cal-time-scroll" ref={scroll}>
        <div className="cal-time-body" style={{ height: HOUR * 24 }}>
          <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? `${pad(h)}:00` : ''}</span>)}</div>
          {dates.map(d => (
            <div key={d} className="cal-col" style={{ backgroundSize: `100% ${HOUR}px` }} onClick={e => create(d, Math.floor((e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top) / HOUR))}>
              {blocks(d, (byDay.get(d) ?? []).filter(o => !o.allDay)).map(b => {
                const c = color(b.o.calendar)
                return (
                  <button key={b.o.file + b.o.start} className={`cal-block ${b.short ? 'short' : ''}`} onClick={e => { e.stopPropagation(); open(b.o) }} title={`${b.o.title} · ${time(b.o.start)} – ${time(b.o.end)}`}
                    style={{ top: b.from / 60 * HOUR, height: b.short ? 20 : (b.to - b.from) / 60 * HOUR - 2, left: `${b.left * 100}%`, width: `calc(${b.width * 100}% - 2px)`, background: c, color: onColor(c) }}>
                    <b>{b.o.title || '(No title)'}{b.short ? `, ${time(b.o.start)}` : ''}</b>{!b.short && b.to - b.from >= 40 && <span>{time(b.o.start)} – {time(b.o.end)}</span>}
                  </button>
                )
              })}
              {d === today && <i className="cal-now" style={{ top: (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Agenda({ from, today, byDay, color, open }: { from: string; today: string; byDay: Map<string, Occ[]>; color: (id: string) => string; open: (o: Occ) => void }) {
  const days = Array.from({ length: 60 }, (_, i) => addDays(from, i)).filter(d => byDay.has(d))
  return (
    <div className="cal-agenda page-scroll">
      {days.length === 0 && <p className="muted">Nothing in the next two months.</p>}
      {days.map(d => (
        <div key={d} className="cal-agenda-day">
          <h4 className={d === today ? 'today' : ''}>{d === today ? 'Today · ' : d === addDays(today, 1) ? 'Tomorrow · ' : ''}{fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
          {byDay.get(d)!.map(o => (
            <button key={o.file + o.start} className="cal-agenda-row" onClick={() => open(o)}>
              <span className="cal-agenda-time">{o.allDay ? 'All day' : key(new Date(o.start)) === d ? <>{time(o.start)}<small>{length(Math.round((o.end - o.start) / 60000))}</small></> : '…'}</span>
              <i style={{ background: color(o.calendar) }} />
              <span className="cal-agenda-what"><b>{o.title || '(No title)'}</b>{o.place && <small>{o.place}</small>}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function EventCard({ o, cal, onClose, onEdit, onDelete, onKeep }: { o: Occ; cal?: Cal; onClose: () => void; onEdit: () => void; onDelete: () => void; onKeep: () => void }) {
  const when = o.allDay
    ? (o.endDate && addDays(o.endDate, -1) > o.startDate! ? `${fmt(o.startDate!, { weekday: 'long', day: 'numeric', month: 'long' })} – ${fmt(addDays(o.endDate, -1), { weekday: 'long', day: 'numeric', month: 'long' })}` : fmt(o.startDate!, { weekday: 'long', day: 'numeric', month: 'long' }))
    : `${fmt(key(new Date(o.start)), { weekday: 'long', day: 'numeric', month: 'long' })} · ${time(o.start)} – ${key(new Date(o.end)) !== key(new Date(o.start)) ? fmt(key(new Date(o.end)), { day: 'numeric', month: 'short' }) + ' ' : ''}${time(o.end)}`
  return (
    <Modal onClose={onClose}>
      <div className="cal-card-head">
        <i style={{ background: cal?.color }} /><h3>{o.title || '(No title)'}</h3>
        <button className="round small" title="Edit" onClick={onEdit}><Icon name="edit" size={18} /></button>
        <button className="round small" title="Delete" onClick={onDelete}><Icon name="trash" size={18} /></button>
        <button className="round small" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      <p className="cal-card-when">{when}</p>
      {o.rrule && <p>{repeatText(o.rrule, o.masterDate ?? o.dayDate)}</p>}
      {o.place && <p>{o.place}</p>}
      <p>{cal?.name ?? o.calendar}</p>
      {o.alarms.map((a, i) => <p key={i}>🔔 {alarmText(a, o.allDay, o.allDay ? '00:00' : hm(o.start))}</p>)}
      {o.notes && <p className="cal-notes">{o.notes}</p>}
      {o.versions > 1 && <><p className="error">{o.versions} versions of this event came from a sync (changed on two devices); the newest is shown.</p>
        <button className="text-button" onClick={onKeep}>Keep this one</button></>}
      <p className="cal-file">{o.file}</p>
    </Modal>
  )
}

function ScopeDialog({ deleting, onClose, onPick }: { deleting: boolean; onClose: () => void; onPick: (s: Scope) => void }) {
  const [s, setS] = useState<Scope>('one')
  return (
    <Modal onClose={onClose}>
      <h3>{deleting ? 'Delete a repeating event' : 'Change a repeating event'}</h3>
      {([['one', 'This event'], ['following', 'This and following events'], ['all', 'All events']] as [Scope, string][]).map(([v, l]) =>
        <label key={v} className="cal-radio"><input type="radio" checked={s === v} onChange={() => setS(v)} />{l}</label>)}
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" autoFocus onClick={() => onPick(s)}>OK</button></div>
    </Modal>
  )
}

function EventEditor({ draft, cals, calendar, isNew, onClose, onSave }: { draft: Draft; cals: Cal[]; calendar: string | null; isNew?: boolean; onClose: () => void; onSave: (d: Draft, calendar: string | null) => void }) {
  const [d, setD] = useState<Draft>(draft)
  const [cal, setCal] = useState(calendar)
  const [custom, setCustom] = useState<'repeat' | 'alarm' | null>(null)
  const startTime = d.allDay ? '00:00' : d.start.time ?? '09:00'
  const set = (patch: Partial<Draft>) => setD(x => ({ ...x, ...patch }))
  function setStart(s: When) {
    const presets = repeatPresets(d.start.date).map(p => p[0]), k = presets.indexOf(d.rrule)
    const shift = between(d.start.date, s.date)
    const mins = !d.allDay && s.time && d.start.time && d.end.time ? toSec(s.time) / 60 - toSec(d.start.time) / 60 : 0
    let end = { ...d.end, date: addDays(d.end.date, shift) }
    if (!d.allDay && end.time) { const t = toSec(end.time) / 60 + mins; const extra = Math.floor(t / 1440); end = { date: addDays(end.date, extra), time: `${pad(Math.floor(((t % 1440) + 1440) % 1440 / 60))}:${pad(((t % 60) + 60) % 60)}` } }
    set({ start: s, end, rrule: k > 0 ? repeatPresets(s.date)[k][0] : d.rrule }) // "Weekly on Tuesday" follows the date
  }
  function save() {
    const out = { ...d, title: d.title.trim(), place: d.place.trim(), notes: d.notes.trim(), alarms: d.allDay === draft.allDay && !d.allDay ? keepClock(d.alarms, draft.start.time ?? '00:00', startTime) : d.alarms }
    onSave(out, cal)
  }
  const presets = repeatPresets(d.start.date)
  const late = !d.allDay && (d.end.date < d.start.date || (d.end.date === d.start.date && (d.end.time ?? '') <= (d.start.time ?? '')))
  return (
    <Modal onClose={onClose}>
      <div className="cal-editor">
        <div className="cal-editor-head"><h3>{isNew ? 'New event' : 'Edit event'}</h3><button className="filled-button" onClick={save}>Save</button></div>
        <input className="field cal-title" autoFocus placeholder="Title" value={d.title} onChange={e => set({ title: e.target.value })} onKeyDown={e => e.key === 'Enter' && save()} />
        <label className="cal-line"><i style={{ background: cals.find(c => c.id === cal)?.color ?? PALETTE[0] }} />
          <select className="field" value={cal ?? ''} onChange={e => setCal(e.target.value)}>
            {cals.length === 0 && <option value="">Personal (new)</option>}
            {cals.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="cal-switch"><input type="checkbox" checked={d.allDay} onChange={e => set({ allDay: e.target.checked, alarms: defaultAlarms(e.target.checked, startTime), start: { date: d.start.date, time: d.start.time ?? '09:00' }, end: { date: d.end.date, time: d.end.time ?? '10:00' } })} />All day</label>
        <div className="cal-when">
          <span>Starts</span><input type="date" className="field" value={d.start.date} onChange={e => e.target.value && setStart({ ...d.start, date: e.target.value })} />
          {!d.allDay && <TimeSelect value={d.start.time!} set={t => setStart({ ...d.start, time: t })} />}
          <span>Ends</span><input type="date" className="field" value={d.end.date} onChange={e => e.target.value && set({ end: { ...d.end, date: e.target.value } })} />
          {!d.allDay && <TimeSelect value={d.end.time!} set={t => set({ end: { ...d.end, time: t } })} />}
        </div>
        {late && <p className="error">The end is before the start; it will be an hour long.</p>}
        <select className="field" value={presets.some(p => p[0] === d.rrule) ? d.rrule ?? '' : 'custom'} onChange={e => e.target.value === 'custom!' ? setCustom('repeat') : set({ rrule: e.target.value || null })}>
          {presets.map(([r, words]) => <option key={words} value={r ?? ''}>{words}</option>)}
          {!presets.some(p => p[0] === d.rrule) && <option value="custom">{repeatText(d.rrule, d.start.date)}</option>}
          <option value="custom!">Custom…</option>
        </select>
        {custom === 'repeat' && <CustomRepeat rule={d.rrule} date={d.start.date} onCancel={() => setCustom(null)} onSet={r => { set({ rrule: r }); setCustom(null) }} />}
        <div className="cal-alarms">
          {d.alarms.map((a, i) => <div key={i} className="cal-alarm"><Icon name="bell" size={18} /><span>{alarmText(a, d.allDay, startTime)}</span>
            <button className="round small" title="Remove this reminder" onClick={() => set({ alarms: d.alarms.filter((_, j) => j !== i) })}><Icon name="close" size={16} /></button></div>)}
          <select className="field" value="" onChange={e => { const v = e.target.value; if (v === 'custom') setCustom('alarm'); else if (v) { const a = presetAlarms(d.allDay, startTime)[+v]; if (!d.alarms.some(x => x.days === a.days && x.seconds === a.seconds)) set({ alarms: [...d.alarms, a] }) } }}>
            <option value="">Add a reminder…</option>
            {presetAlarms(d.allDay, startTime).map((a, i) => <option key={i} value={i}>{alarmText(a, d.allDay, startTime)}</option>)}
            <option value="custom">Custom…</option>
          </select>
          {custom === 'alarm' && <CustomAlarm allDay={d.allDay} start={startTime} onCancel={() => setCustom(null)} onAdd={a => { set({ alarms: [...d.alarms, a] }); setCustom(null) }} />}
        </div>
        <input className="field" placeholder="Place" value={d.place} onChange={e => set({ place: e.target.value })} />
        <textarea className="field" rows={4} placeholder="Notes" value={d.notes} onChange={e => set({ notes: e.target.value })} />
        <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" onClick={save}>Save</button></div>
      </div>
    </Modal>
  )
}

function CustomRepeat({ rule, date, onCancel, onSet }: { rule: string | null; date: string; onCancel: () => void; onSet: (r: string) => void }) {
  const p = Object.fromEntries((rule ?? '').split(';').filter(x => x.includes('=')).map(x => [x.split('=')[0].toUpperCase(), x.slice(x.indexOf('=') + 1)]))
  const [every, setEvery] = useState(p.INTERVAL ?? '1')
  const [unit, setUnit] = useState(p.FREQ ?? 'WEEKLY')
  const [days, setDays] = useState<Set<string>>(new Set((p.BYDAY ?? '').split(',').filter((x: string) => x.length === 2).concat(p.BYDAY ? [] : [DAYS[weekday(date)]])))
  const [ends, setEnds] = useState(p.COUNT ? 'count' : p.UNTIL ? 'until' : 'never')
  const [count, setCount] = useState(p.COUNT ?? '10')
  const [until, setUntil] = useState(p.UNTIL ? `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}` : addMonths(date, 3))
  function ok() {
    const parts = [`FREQ=${unit}`]
    if (+every > 1) parts.push(`INTERVAL=${+every}`)
    if (unit === 'WEEKLY' && days.size) parts.push('BYDAY=' + DAYS.filter(x => days.has(x)).join(','))
    if (p.FREQ === unit) for (const [k, v] of Object.entries(p)) if (!['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL'].includes(k)) parts.push(`${k}=${v}`)
    if (unit !== 'WEEKLY' && p.BYDAY && p.FREQ === unit) parts.push(`BYDAY=${p.BYDAY}`)
    if (ends === 'count') parts.push(`COUNT=${Math.max(1, +count || 1)}`)
    if (ends === 'until') parts.push(`UNTIL=${until.replace(/-/g, '')}`)
    onSet(parts.join(';'))
  }
  return (
    <div className="cal-custom">
      <div className="cal-inline">Every <input className="field num" type="number" min={1} value={every} onChange={e => setEvery(e.target.value)} />
        <select className="field" value={unit} onChange={e => setUnit(e.target.value)}>{[['DAILY', 'days'], ['WEEKLY', 'weeks'], ['MONTHLY', 'months'], ['YEARLY', 'years']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      {unit === 'WEEKLY' && <div className="cal-days">{DAYS.map((x, i) => <button key={x} className={days.has(x) ? 'on' : ''} onClick={() => setDays(s => { const n = new Set(s); n.has(x) ? n.delete(x) : n.add(x); return n })}>{DAY_NAMES[i][0]}</button>)}</div>}
      <label className="cal-radio"><input type="radio" checked={ends === 'never'} onChange={() => setEnds('never')} />Never ends</label>
      <label className="cal-radio"><input type="radio" checked={ends === 'until'} onChange={() => setEnds('until')} />Ends on <input type="date" className="field" value={until} onChange={e => { setUntil(e.target.value); setEnds('until') }} /></label>
      <label className="cal-radio"><input type="radio" checked={ends === 'count'} onChange={() => setEnds('count')} />After <input className="field num" type="number" min={1} value={count} onChange={e => { setCount(e.target.value); setEnds('count') }} /> times</label>
      <div className="dialog-actions"><button className="text-button" onClick={onCancel}>Cancel</button><button className="filled-button" onClick={ok}>OK</button></div>
    </div>
  )
}

function CustomAlarm({ allDay, start, onCancel, onAdd }: { allDay: boolean; start: string; onCancel: () => void; onAdd: (a: Alarm) => void }) {
  const [n, setN] = useState('3')
  const [unit, setUnit] = useState('days')
  const [at, setAt] = useState(allDay ? '09:00' : start)
  const [daily, setDaily] = useState(false)
  const k = Math.max(0, +n || 0)
  const add = () => onAdd(unit === 'minutes' ? { days: 0, seconds: -k * 60 } : unit === 'hours' ? { days: 0, seconds: -k * 3600 } : daysBeforeAt(allDay ? '00:00' : start, unit === 'weeks' ? k * 7 : k, at, daily))
  return (
    <div className="cal-custom">
      <div className="cal-inline"><input className="field num" type="number" min={0} value={n} onChange={e => setN(e.target.value)} />
        <select className="field" value={unit} onChange={e => setUnit(e.target.value)}>{(allDay ? ['days', 'weeks'] : ['minutes', 'hours', 'days', 'weeks']).map(u => <option key={u}>{u}</option>)}</select> before
        {(unit === 'days' || unit === 'weeks') && <> at <TimeSelect value={at} set={setAt} /></>}</div>
      {(unit === 'days' || unit === 'weeks') && <label className="cal-switch"><input type="checkbox" checked={daily} onChange={e => setDaily(e.target.checked)} />And every day after it, until the event</label>}
      <div className="dialog-actions"><button className="text-button" onClick={onCancel}>Cancel</button><button className="filled-button" onClick={add}>Add</button></div>
    </div>
  )
}

function CalendarDialog({ cal, taken, onClose, onSave, onExport, onDelete }: { cal: Cal | null; taken: string[]; onClose: () => void; onSave: (name: string, color: string) => void; onExport: () => void; onDelete: () => void }) {
  const [name, setName] = useState(cal?.name ?? '')
  const [color, setColor] = useState(cal?.color ?? PALETTE[taken.length % PALETTE.length])
  const clash = name.trim() !== cal?.name && taken.some(t => t.toLowerCase() === name.trim().toLowerCase())
  return (
    <Modal onClose={onClose}>
      <h3>{cal ? 'Calendar' : 'New calendar'}</h3>
      <input className="field" autoFocus placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
      {clash && <p className="error">A calendar has this name.</p>}
      <div className="cal-palette">{PALETTE.map(c => <button key={c} title={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} />)}</div>
      <div className="dialog-actions">
        {cal && <button className="text-button danger-text" onClick={onDelete}>Delete</button>}
        {cal && <button className="text-button" onClick={onExport}>Export</button>}
        <span style={{ flex: 1 }} />
        <button className="text-button" onClick={onClose}>Cancel</button>
        <button className="filled-button" disabled={!name.trim() || clash} onClick={() => onSave(name.trim(), color)}>{cal ? 'Save' : 'Create'}</button>
      </div>
    </Modal>
  )
}

function ImportDialog({ found, cals, onClose, onImport }: { found: { index: number; name: string; count: number }[]; cals: Cal[]; onClose: () => void; onImport: (c: { index: number; into: string }[]) => void }) {
  const single = found.length === 1 ? found[0] : null
  const [into, setInto] = useState(single ? (cals.find(c => c.name.toLowerCase() === single.name.toLowerCase())?.id ?? '') : '')
  const byName = (n: string) => cals.find(c => c.name.toLowerCase() === n.toLowerCase())?.id ?? n.replace(/[/\\:*?"<>|]/g, '-')
  return (
    <Modal onClose={onClose}>
      <h3>Import</h3>
      {single ? <>
        <p>{single.count} events from “{single.name}”, into:</p>
        <select className="field" value={into} onChange={e => setInto(e.target.value)}>
          <option value="">A new calendar “{single.name}”</option>
          {cals.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <p className="muted">An event already there (the same one, imported before) is updated, not doubled.</p>
      </> : <>
        <p>{found.length} calendars, each into the calendar of its name (made if there is none):</p>
        {found.map(f => <p key={f.index}>• {f.name} — {f.count} events</p>)}
      </>}
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button>
        <button className="filled-button" onClick={() => onImport(single ? [{ index: single.index, into: into || byName(single.name) }] : found.map(f => ({ index: f.index, into: byName(f.name) })))}>Import</button></div>
    </Modal>
  )
}

/** A time of day as Google offers it: every quarter of an hour, in English whatever the system's language; the event's own if between. */
function TimeSelect({ value, set }: { value: string; set: (t: string) => void }) {
  const times = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad(i % 4 * 15)}`)
  if (!times.includes(value)) times.push(value), times.sort()
  return <select className="field cal-time-pick" value={value} onChange={e => set(e.target.value)}>{times.map(t => <option key={t} value={t}>{t}</option>)}</select>
}
