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
  alarms: Alarm[]; masterStart: number | null; masterDate: string | null; dayDate: string; birthYear: number | null
}
type When = { date: string; time?: string }
type Draft = { title: string; place: string; notes: string; allDay: boolean; start: When; end: When; rrule: string | null; alarms: Alarm[] }
type View = 'day' | 'three' | 'week' | 'month' | 'year' | 'agenda'
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
  const [kinds, setKinds] = useState(false)
  const [version, setVersion] = useState(0)
  const [settings, setSettings] = useState<{ reminders: boolean; autostart: boolean } | null>(null)
  const close = () => setDialog(null)
  // Refresh (the user, 18 Oct): the phones and tablets are asked to sync now; what they bring arrives through the watcher
  const [syncing, setSyncing] = useState(false)
  const [said, setSaid] = useState('')
  const refresh = async () => {
    if (syncing) return
    setSyncing(true)
    const n = await window.drive.calendarRefresh().catch(() => 0)
    setSyncing(false)
    setSaid(n ? `Syncing with ${n} device${n === 1 ? '' : 's'}` : 'No phone or tablet answered')
    setTimeout(() => setSaid(''), 4000)
  }
  // the user, 18 Oct: a wide window keeps the small month and the calendars in sight and its island holds Day · Week ·
  // Month · Year; a narrow one has the events on top and a small calendar at the bottom (the phone's way)
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const ro = new ResizeObserver(() => setWide((root.current?.clientWidth ?? 1000) >= 700))
    ro.observe(root.current!)
    return () => ro.disconnect()
  }, [])
  const views: [View, string, string][] = wide
    ? [['day', 'Day', 'tablet'], ['week', 'Week', 'grid'], ['month', 'Month', 'calendar'], ['year', 'Year', 'collections']]
    : [['agenda', 'Agenda', 'list'], ['day', 'Day', 'tablet'], ['three', '3 days', 'grid'], ['month', 'Month', 'calendar']]
  // each width keeps its own view (as the phone and tablet do)
  const viewKey = wide ? 'calendarViewWide' : 'calendarView'
  useEffect(() => { const v = stored(viewKey) as View; setView(views.some(([x]) => x === v) ? v : views[0][0]) }, [wide])
  const [strip, setStrip] = useState(() => +(stored('calendarStrip') || 1))
  const range = useMemo(() => {
    const days = view === 'month' ? monthCells(selected) : view === 'week' ? weekOf(selected) : view === 'day' ? [selected]
      : view === 'three' ? [selected, addDays(selected, 2)] : view === 'year' ? [selected.slice(0, 4) + '-01-01', selected.slice(0, 4) + '-12-31']
      : Array.from({ length: 61 }, (_, i) => addDays(selected, i))
    const mini = monthCells(selected).concat([addDays(weekOf(selected)[0], 27)])
    return [Math.min(parse(days[0]).getTime(), parse(mini[0]).getTime()), Math.max(parse(addDays(days[days.length - 1], 1)).getTime(), parse(addDays(mini[mini.length - 1], 1)).getTime())]
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
  const go = (v: View) => { setView(v); store(viewKey, v) }
  const step = (n: number) => setSelected(s => view === 'day' ? addDays(s, n) : view === 'three' ? addDays(s, 3 * n) : view === 'month' ? addMonths(s, n) : view === 'year' ? addMonths(s, 12 * n) : addDays(s, 7 * n))
  const spanTitle = (a: string, b: string) => a.slice(5, 7) === b.slice(5, 7) ? fmt(a, { month: 'long', year: 'numeric' }) : `${fmt(a, { month: 'short' })} – ${fmt(b, { month: 'short', year: 'numeric' })}`
  const title = view === 'day' ? fmt(selected, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? spanTitle(weekOf(selected)[0], weekOf(selected)[6]) : view === 'three' ? spanTitle(selected, addDays(selected, 2))
    : view === 'year' ? selected.slice(0, 4) : fmt(selected, { month: 'long', year: 'numeric' })

  async function act(work: () => Promise<unknown>, said: string) {
    try { await work(); say(said) } catch (e) { say('Not saved: ' + errorText(e)) }
    setVersion(v => v + 1)
  }
  function create(date: string, hour?: number, kind: 'event' | 'reminder' = 'event') {
    const now = new Date()
    const h = hour ?? (date === today ? Math.min(now.getHours() + 1, 23) : 9)
    const start = `${pad(h)}:00`, end = `${pad(Math.min(h + 1, 23))}:${h + 1 > 23 ? '59' : '00'}`
    const visible = cals.filter(c => !hidden.has(c.id))
    const cal = visible.find(c => c.id === stored('calendarLast'))?.id ?? visible[0]?.id ?? cals[0]?.id ?? null
    const reminder = kind === 'reminder' // one event, its notifications a list (the user, 18 Oct)
    setDialog(<EventEditor cals={cals} calendar={cal} isNew heading={reminder ? 'New reminder' : undefined}
      draft={{ title: '', place: '', notes: '', allDay: false, start: { date, time: start }, end: { date, time: reminder ? `${start.slice(0, 3)}15` : end }, rrule: null, alarms: reminder ? [{ days: 0, seconds: 0 }] : defaultAlarms(false, start) }}
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
        return call('split', o.file, o.day, to, { ...d, rrule: d.rrule?.split(';').filter(p => !/^COUNT=/i.test(p)).join(';') || null })
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
  // + and its four kinds (the user, 18 Oct: "New : Shedule : burthday : reminder")
  function start(k: Kind) {
    setKinds(false)
    if (k === 'new') return create(selected)
    if (k === 'reminder') return create(selected, undefined, 'reminder')
    if (k === 'birthday') return setDialog(<BirthdayDialog onClose={close} onSave={(name, date, yearKnown) => {
      close()
      act(async () => {
        const birthdays = cals.find(c => c.name.toLowerCase() === 'birthdays')?.id ?? await call<string>('newCalendar', 'Birthdays', '#8E24AA')
        const day = yearKnown ? date : `${today.slice(0, 4)}${date.slice(4)}`
        await call('save', null, birthdays, { title: `${name}'s birthday`, place: '', notes: '', allDay: true, start: { date: day }, end: { date: day }, rrule: 'FREQ=YEARLY',
          alarms: [daysBeforeAt('00:00', 0, '09:00', false)], extra: yearKnown ? { 'X-TETRA-BIRTH-YEAR': date.slice(0, 4) } : undefined })
      }, `${name}'s birthday saved`)
    }} />)
    const holidays = cals.find(c => c.name.toLowerCase() === 'holidays')
    setDialog(<ScheduleDialog cals={cals} calendar={cals.find(c => c.id === stored('calendarLast'))?.id ?? cals[0]?.id ?? null} holidays={!!holidays} today={today} onClose={close}
      onSave={(a, to, skip) => {
        close()
        act(async () => {
          // the Holidays calendar's days between the two dates, as exceptions
          const off = skip && holidays ? (await call<Occ[]>('occurrences', parse(a.from).getTime(), parse(addDays(a.to, 1)).getTime())).filter(o => o.calendar === holidays.id && o.allDay).flatMap(daysOf) : []
          const ev = await call<Draft>('scheduleEvent', { ...a, skip: off })
          await call('save', null, to ?? await call<string>('newCalendar', 'Personal', PALETTE[0]), ev)
        }, 'Schedule saved')
      }} />)
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

  const calendarList = <>
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
  </>
  const settingsList = settings && <>
    <label className="cal-switch"><input type="checkbox" checked={settings.reminders} onChange={e => { const on = e.target.checked; setSettings({ ...settings, reminders: on }); window.drive.calendarSetReminders(on) }} />Reminders on this computer</label>
    <label className="cal-switch"><input type="checkbox" checked={settings.autostart} onChange={e => { const on = e.target.checked; setSettings({ ...settings, autostart: on }); window.drive.calendarSetAutostart(on) }} />Start Tetra when I log in, in the tray, so reminders ring</label>
    {/* Share with Claude (asked 18 Oct): the skill the app was built with */}
    <h4 className="cal-share-head">Share with Claude</h4>
    <p className="muted">Lets Claude read and change this calendar by editing its files.</p>
    <div className="cal-two">
      <button className="text-button" onClick={() => window.drive.calendarSkillSave().then(p => p && say('Saved to ' + p), e => say('Not saved: ' + errorText(e)))}>Save as…</button>
      <button className="text-button" onClick={() => window.drive.calendarSkillInstall().then(p => say('Installed for Claude Code in ' + p), e => say('Not installed: ' + errorText(e)))}>Copy to ~/.claude/skills</button>
    </div>
  </>
  const nav = <div className="island title-island cal-nav">
    <button className="round flat" title="Previous" onClick={() => step(-1)}><Icon name="back" /></button>
    <button className="text-button" onClick={() => setSelected(today)}>Today</button>
    <button className="round flat" title="Next" onClick={() => step(1)}><Icon name="forward" /></button>
  </div>
  const main = <>
    {view === 'month' && <MonthGrid selected={selected} today={today} byDay={byDay} color={color} pick={d => setSelected(d)} create={create} open={open} />}
    {(view === 'week' || view === 'day' || view === 'three') && <TimeGrid dates={view === 'week' ? weekOf(selected) : view === 'three' ? [0, 1, 2].map(i => addDays(selected, i)) : [selected]} today={today} byDay={byDay} color={color} open={open} create={create} />}
    {view === 'agenda' && <Agenda from={selected} today={today} byDay={byDay} color={color} open={open} />}
    {view === 'year' && <YearGrid selected={selected} today={today} busy={byDay} pick={d => { setSelected(d); go('day') }} />}
  </>
  return (
    <div className={`cal ${wide ? 'wide' : 'narrow'}`} ref={root}>
      {/* Files' own top: the title in an island, the dates' controls in one beside it */}
      <header className="topbar cal-topbar">
        <div className="island title-island"><Icon name="calendar" /><h1>{title}</h1></div>
        {!wide && nav}
        <div className="tools cal-tools">
          {said && <div className="island cal-said" role="status">{said}</div>}
          {/* the user, 18 Oct: the Trash beside sync, and Settings at the top like Gallery's */}
          <button className="round" title="Trash" onClick={() => setDialog(<CalendarTrash cals={cals} onClose={close} restore={(name, to) => act(() => call('restore', name, to.id), `Restored to ${to.name}`)} />)}><Icon name="trash" /></button>
          <button className="round cal-refresh" title="Sync now" aria-busy={syncing} onClick={refresh}><Icon name="refresh" /></button>
          <details className="menu">
            <summary className="round" title="Calendar settings"><Icon name="tune" /></summary>
            <div className="island menu-body cal-settings">{settingsList}</div>
          </details>
        </div>
      </header>
      {wide ? <div className="cal-body">
        <aside className="cal-side">
          <MiniMonth selected={selected} today={today} busy={byDay} pick={setSelected} />
          {calendarList}
        </aside>
        <section className="cal-main">{main}</section>
      </div> : <>
        <section className="cal-main">{main}</section>
        {view !== 'month' && <BottomStrip selected={selected} today={today} busy={byDay} weeks={strip} setWeeks={n => { setStrip(n); store('calendarStrip', String(n)) }} pick={setSelected} />}
      </>}
      <div className={`notes-drawer island cal-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <div className="cal-drawer-list">{calendarList}</div>
      </div>
      {/* the user, 18 Oct: a wide window has Today and ‹ › at the bottom, in their own island next to the + */}
      {wide ? <div className="cal-dock">
        <nav className="notes-island island">
          {views.map(([v, label, icon]) => <button key={v} className={`island-item ${view === v ? 'on' : ''}`} onClick={() => { go(v); setDrawer(false) }}><Icon name={icon as never} size={20} /><span>{label}</span></button>)}
        </nav>
        <div className="cal-dock-right">
          {nav}
          <div className="cal-plus">
            {kinds && <div className="island cal-kinds">
              {KINDS.map(([k, label, icon]) => <button key={k} className="island-item" onClick={() => start(k)}><Icon name={icon as never} size={20} /><span>{label}</span></button>)}
            </div>}
            <button className={`island cal-plus-button ${kinds ? 'on' : ''}`} title="New event, schedule, birthday or reminder" onClick={() => { setDrawer(false); setKinds(k => !k) }}><Icon name="add" /></button>
          </div>
        </div>
      </div> : <div className="notes-dock">
        {kinds && <div className="island cal-kinds">
          {KINDS.map(([k, label, icon]) => <button key={k} className="island-item" onClick={() => start(k)}><Icon name={icon as never} size={20} /><span>{label}</span></button>)}
        </div>}
        <nav className="notes-island island">
          {views.map(([v, label, icon]) => <button key={v} className={`island-item ${view === v ? 'on' : ''}`} onClick={() => { go(v); setDrawer(false) }}><Icon name={icon as never} size={20} /><span>{label}</span></button>)}
          <span className="island-gap" />
          <button className={`island-item ${kinds ? 'on' : ''}`} title="New event, schedule, birthday or reminder" onClick={() => { setDrawer(false); setKinds(k => !k) }}><Icon name="add" size={20} /><span>New</span></button>
          <button className={`island-item ${drawer ? 'on' : ''}`} aria-expanded={drawer} onClick={() => { setKinds(false); setDrawer(d => !d) }}>
            <Icon name="calendar" size={20} /><span>Calendars</span></button>
        </nav>
      </div>}
    </div>
  )
}

type Kind = 'new' | 'schedule' | 'birthday' | 'reminder'
const KINDS: [Kind, string, string][] = [['new', 'Event', 'add'], ['schedule', 'Schedule', 'recent'], ['birthday', 'Birthday', 'person'], ['reminder', 'Reminder', 'bell']]

/** The Year view: the twelve months small; a day clicked opens it. */
function YearGrid({ selected, today, busy, pick }: { selected: string; today: string; busy: Map<string, Occ[]>; pick: (d: string) => void }) {
  const y = selected.slice(0, 4)
  return (
    <div className="cal-year">
      {Array.from({ length: 12 }, (_, m) => {
        const first = `${y}-${pad(m + 1)}-01`
        return (
          <div key={m} className="cal-mini">
            <div className={`cal-year-name ${today.slice(0, 7) === first.slice(0, 7) ? 'today' : ''}`}>{fmt(first, { month: 'long' })}</div>
            <div className="cal-mini-grid">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="muted">{d}</span>)}
              {monthCells(first).map(d => d.slice(5, 7) !== first.slice(5, 7) ? <span key={d} /> :
                <button key={d} className={`${d === selected ? 'on' : ''} ${d === today ? 'today' : ''} ${busy.has(d) ? 'busy' : ''}`} onClick={() => pick(d)}>{+d.slice(8)}</button>)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A narrow window's small calendar at the bottom, above the island (the user, 18 Oct): 1, 2 or 3 weeks from the chosen
 * day's, or its month; the handle dragged up for more, down for fewer (or clicked), the choice kept.
 */
function BottomStrip({ selected, today, busy, weeks, setWeeks, pick }: { selected: string; today: string; busy: Map<string, Occ[]>; weeks: number; setWeeks: (n: number) => void; pick: (d: string) => void }) {
  const sizes = [1, 2, 3, 6]
  const y0 = useRef<number | null>(null)
  const more = (n: number) => setWeeks(sizes[Math.max(0, Math.min(sizes.length - 1, sizes.indexOf(weeks) + n))])
  const month = weeks === 6
  const rows = month ? monthCells(selected).reduce<string[][]>((a, d, i) => (i % 7 ? a[a.length - 1].push(d) : a.push([d]), a), []).filter(w => w.some(d => d.slice(5, 7) === selected.slice(5, 7)))
    : Array.from({ length: weeks }, (_, i) => weekOf(addDays(selected, 7 * i)))
  return (
    <div className="cal-strip">
      <button className="cal-strip-handle" title="Drag up for more weeks, down for fewer"
        onPointerDown={e => { y0.current = e.clientY; (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
        onPointerUp={e => { const dy = y0.current == null ? 0 : e.clientY - y0.current; y0.current = null; if (dy < -20) more(1); else if (dy > 20) more(-1); else setWeeks(sizes[(sizes.indexOf(weeks) + 1) % sizes.length]) }}><span /></button>
      {month && <div className="cal-strip-month">{fmt(selected, { month: 'long', year: 'numeric' })}</div>}
      <div className="cal-mini-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d} className="muted">{d}</span>)}
        {rows.flat().map(d => <button key={d} className={`${d === selected ? 'on' : ''} ${d === today ? 'today' : ''} ${month && d.slice(5, 7) !== selected.slice(5, 7) ? 'out' : ''} ${busy.has(d) ? 'busy' : ''}`} onClick={() => pick(d)}>{+d.slice(8)}</button>)}
      </div>
    </div>
  )
}

/** A birthday: a name and a date, the year if known (then the age shows). In Birthdays, all day, every year. */
function BirthdayDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, date: string, yearKnown: boolean) => void }) {
  const [name, setName] = useState('')
  const [date, setDate] = useState(key(new Date()))
  const [yearKnown, setYearKnown] = useState(false)
  return (
    <Modal onClose={onClose}>
      <h3>Birthday</h3>
      <input className="field" autoFocus placeholder="Whose birthday" value={name} onChange={e => setName(e.target.value)} />
      <div className="cal-inline" style={{ marginTop: 10 }}>Date <DateField value={date} set={setDate} /></div>
      <label className="cal-switch"><input type="checkbox" checked={yearKnown} onChange={e => setYearKnown(e.target.checked)} />I know the year (to show the age)</label>
      <p className="muted">All day, every year, in the Birthdays calendar; reminded on the day at 9:00.</p>
      <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" disabled={!name.trim()} onClick={() => onSave(name.trim(), date, yearKnown)}>Save</button></div>
    </Modal>
  )
}

/** A school year's dates (the user, 18 Oct); the high school's end is a guess until the user says. */
const TEMPLATES: [string, string, string][] = [['Elementary school year', '09-01', '06-26'], ['High school year', '09-01', '06-15']]
type ScheduleArgs = { title: string; place: string; days: string[]; at: string; until: string; from: string; to: string }

/** A schedule (a timetable, a weekly class): weekdays, a time, a start and an end — one repeating event. */
function ScheduleDialog({ cals, calendar, holidays, today, onClose, onSave }: { cals: Cal[]; calendar: string | null; holidays: boolean; today: string; onClose: () => void; onSave: (a: ScheduleArgs, calendar: string | null, skipHolidays: boolean) => void }) {
  const [a, setA] = useState<ScheduleArgs>({ title: '', place: '', days: ['MO', 'TU', 'WE', 'TH', 'FR'], at: '08:15', until: '13:30', from: today, to: addMonths(today, 3) })
  const [template, setTemplate] = useState<number | null>(null)
  const [skip, setSkip] = useState(holidays)
  const [cal, setCal] = useState(calendar)
  const set = (p: Partial<ScheduleArgs>) => setA(x => ({ ...x, ...p }))
  const y = +today.slice(0, 4) - (+today.slice(5, 7) >= 8 ? 0 : 1) // the school year a day falls in, from September
  return (
    <Modal onClose={onClose}>
      <div className="cal-editor">
        <h3>Schedule</h3>
        <input className="field" autoFocus placeholder="What (e.g. Lessons)" value={a.title} onChange={e => set({ title: e.target.value })} />
        <div className="cal-chips">{TEMPLATES.map(([label, s, e], i) => <button key={label} className={template === i ? 'on' : ''} onClick={() => { setTemplate(i); set({ from: `${y}-${s}`, to: `${y + 1}-${e}` }) }}>{label}</button>)}</div>
        <div className="cal-days">{DAYS.map((d, i) => <button key={d} className={a.days.includes(d) ? 'on' : ''} onClick={() => set({ days: a.days.includes(d) ? a.days.filter(x => x !== d) : [...a.days, d] })}>{DAY_NAMES[i][0]}</button>)}</div>
        <div className="cal-inline">From <TimeField value={a.at} set={t => set({ at: t })} /> to <TimeField value={a.until} set={t => set({ until: t })} /></div>
        <div className="cal-inline">Starts <DateField value={a.from} set={d => set({ from: d })} /> Ends <DateField value={a.to} set={d => set({ to: d })} /></div>
        {template === 1 && <p className="error">The high school year's end is a guess (15 June): set the right date.</p>}
        {holidays && <label className="cal-switch"><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} />Skip the days in the Holidays calendar</label>}
        <input className="field" placeholder="Place" value={a.place} onChange={e => set({ place: e.target.value })} />
        <select className="field" value={cal ?? ''} onChange={e => setCal(e.target.value)}>
          {cals.length === 0 && <option value="">Personal (new)</option>}
          {cals.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button>
          <button className="filled-button" disabled={!a.title.trim() || !a.days.length || a.to < a.from} onClick={() => onSave({ ...a, title: a.title.trim(), place: a.place.trim() }, cal || null, skip)}>Save</button></div>
      </div>
    </Modal>
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
      {o.birthYear && o.startDate && +o.startDate.slice(0, 4) > o.birthYear && <p>Turns {+o.startDate.slice(0, 4) - o.birthYear}</p>}
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

function EventEditor({ draft, cals, calendar, isNew, heading, onClose, onSave }: { draft: Draft; cals: Cal[]; calendar: string | null; isNew?: boolean; heading?: string; onClose: () => void; onSave: (d: Draft, calendar: string | null) => void }) {
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
        <div className="cal-editor-head"><h3>{heading ?? (isNew ? 'New event' : 'Edit event')}</h3><button className="filled-button" onClick={save}>Save</button></div>
        <input className="field cal-title" autoFocus placeholder="Title" value={d.title} onChange={e => set({ title: e.target.value })} onKeyDown={e => e.key === 'Enter' && save()} />
        <label className="cal-line"><i style={{ background: cals.find(c => c.id === cal)?.color ?? PALETTE[0] }} />
          <select className="field" value={cal ?? ''} onChange={e => setCal(e.target.value)}>
            {cals.length === 0 && <option value="">Personal (new)</option>}
            {cals.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="cal-switch"><input type="checkbox" checked={d.allDay} onChange={e => set({ allDay: e.target.checked, alarms: defaultAlarms(e.target.checked, startTime), start: { date: d.start.date, time: d.start.time ?? '09:00' }, end: { date: d.end.date, time: d.end.time ?? '10:00' } })} />All day</label>
        <div className="cal-when">
          <span>Starts</span><DateField value={d.start.date} set={x => setStart({ ...d.start, date: x })} />
          {!d.allDay && <TimeField value={d.start.time!} set={t => setStart({ ...d.start, time: t })} />}
          <span>Ends</span><DateField value={d.end.date} set={x => set({ end: { ...d.end, date: x } })} />
          {!d.allDay && <TimeField value={d.end.time!} set={t => set({ end: { ...d.end, time: t } })} />}
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
      <label className="cal-radio"><input type="radio" checked={ends === 'until'} onChange={() => setEnds('until')} />Ends on <DateField value={until} set={x => { setUntil(x); setEnds('until') }} /></label>
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
        {(unit === 'days' || unit === 'weeks') && <> at <TimeField value={at} set={setAt} /></>}</div>
      {(unit === 'days' || unit === 'weeks') && <label className="cal-switch"><input type="checkbox" checked={daily} onChange={e => setDaily(e.target.checked)} />And every day after it, until the event</label>}
      <div className="dialog-actions"><button className="text-button" onClick={onCancel}>Cancel</button><button className="filled-button" onClick={add}>Add</button></div>
    </div>
  )
}

/** Deleted events (asked 18 Oct): each with its day and days left, and Restore into the calendar chosen. */
function CalendarTrash({ cals, onClose, restore }: { cals: Cal[]; onClose: () => void; restore: (name: string, to: Cal) => Promise<void> }) {
  type Item = { name: string; title: string; start: number | null; allDay: boolean; at: number }
  const [items, setItems] = useState<Item[] | null>(null)
  const [to, setTo] = useState(cals[0]?.id ?? '')
  const load = () => call<Item[]>('trashed').then(setItems, () => setItems([]))
  useEffect(() => { load() }, [])
  const when = (i: Item) => i.start == null ? '' : new Date(i.start).toLocaleString('en-GB', i.allDay
    ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const left = (i: Item) => { const n = Math.max(0, 30 - Math.floor((Date.now() - i.at) / 86_400_000)); return n === 1 ? '1 day left' : `${n} days left` }
  return <Modal onClose={onClose}>
    <h3>Trash</h3>
    <p className="muted">Deleted events stay here 30 days, then they are deleted for good.</p>
    {cals.length > 1 && <label className="cal-trash-to">Restore into <select className="field" value={to} onChange={e => setTo(e.target.value)}>{cals.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    <div className="cal-trash">
      {items?.length === 0 && <p>The Trash has no events.</p>}
      {items?.map(i => <div key={i.name} className="cal-trash-row">
        <div><strong>{i.title || '(No title)'}</strong><small className="muted">{[when(i), left(i)].filter(Boolean).join(' · ')}</small></div>
        <button className="text-button" disabled={!to} onClick={() => restore(i.name, cals.find(c => c.id === to)!).then(load)}>Restore</button>
      </div>)}
    </div>
    <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
  </Modal>
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

/** "12:25", "12.25", "1225", "925" or "9" as "HH:MM"; null when it is not a time. */
function typedTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:\s*[:.\s]?\s*(\d{2}))?\s*$/.exec(text)
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59) return null
  return `${pad(+m[1])}:${pad(+(m[2] ?? 0))}`
}

/** A time of day, any minute (the user, 18 Oct: "why a list and not a clock"): typed, or picked on the clock as the phone's. */
function TimeField({ value, set }: { value: string; set: (t: string) => void }) {
  const [text, setText] = useState(value)
  const [clock, setClock] = useState(false)
  useEffect(() => setText(value), [value])
  const commit = () => { const t = typedTime(text); if (t && t !== value) set(t); else setText(value) }
  return (
    <span className="cal-pick">
      <input className="field" aria-label="Time" inputMode="numeric" value={text} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit() } }} />
      <button className="round small flat" title="Pick on the clock" onClick={() => setClock(true)}><Icon name="recent" size={20} /></button>
      {clock && <ClockDialog value={value} onClose={() => setClock(false)} onSet={t => { setClock(false); set(t) }} />}
    </span>
  )
}

/** Material's clock, as the phone's TimePicker: hours (00–11 outside, 12–23 inside), then minutes, any of them. */
function ClockDialog({ value, onClose, onSet }: { value: string; onClose: () => void; onSet: (t: string) => void }) {
  const [h, setH] = useState(+value.slice(0, 2))
  const [m, setM] = useState(+value.slice(3, 5))
  const [hours, setHours] = useState(true)
  const R = 100, IN = 66
  const spot = (i: number, of: number, r: number) => { const a = i / of * 2 * Math.PI; return [128 + r * Math.sin(a), 128 - r * Math.cos(a)] }
  function pick(e: React.PointerEvent<SVGSVGElement>, done: boolean) {
    if (e.type === 'pointermove' && !e.buttons) return
    const b = e.currentTarget.getBoundingClientRect(), k = 256 / b.width
    const x = (e.clientX - b.left) * k - 128, y = (e.clientY - b.top) * k - 128
    const a = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI)
    if (hours) { const i = Math.round(a / (Math.PI / 6)) % 12; setH(Math.hypot(x, y) < (R + IN) / 2 ? i + 12 : i); if (done) setHours(false) }
    else setM(Math.round(a / (Math.PI / 30)) % 60)
  }
  const [hx, hy] = hours ? spot(h % 12, 12, h >= 12 ? IN : R) : spot(m, 60, R)
  const num = (v: number, max: number, setV: (n: number) => void, on: boolean, onFocus: () => void) =>
    <input className={on ? 'on' : ''} inputMode="numeric" value={pad(v)} onFocus={e => { onFocus(); e.target.select() }}
      onChange={e => { const d = e.target.value.replace(/\D/g, '').slice(-2); setV(+d <= max ? +d : +d.slice(-1)) }} />
  return (
    <Modal onClose={onClose}>
      <div className="cal-clock">
        <h3>Time</h3>
        <div className="cal-clock-head">{num(h, 23, setH, hours, () => setHours(true))}<span>:</span>{num(m, 59, setM, !hours, () => setHours(false))}</div>
        <svg viewBox="0 0 256 256" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pick(e, false) }} onPointerMove={e => pick(e, false)} onPointerUp={e => pick(e, true)}>
          <circle cx="128" cy="128" r="124" className="face" />
          <line x1="128" y1="128" x2={hx} y2={hy} className="hand" /><circle cx="128" cy="128" r="4" className="hub" /><circle cx={hx} cy={hy} r="18" className="hub" />
          {hours
            ? Array.from({ length: 24 }, (_, i) => { const [x, y] = spot(i % 12, 12, i >= 12 ? IN : R); return <text key={i} x={x} y={y} className={`${i >= 12 ? 'inner' : ''} ${i === h ? 'on' : ''}`}>{pad(i)}</text> })
            : Array.from({ length: 12 }, (_, i) => { const [x, y] = spot(i * 5, 60, R); return <text key={i} x={x} y={y} className={i * 5 === m ? 'on' : ''}>{pad(i * 5)}</text> })}
        </svg>
        <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" onClick={() => onSet(`${pad(h)}:${pad(m)}`)}>OK</button></div>
      </div>
    </Modal>
  )
}

/** A date, picked on a month as the phone's DatePicker (the user, 18 Oct: "why is the date not a calendar"); the year jumps for birthdays. */
function DateField({ value, set }: { value: string; set: (d: string) => void }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="field cal-date" onClick={() => setOpen(true)}><Icon name="calendar" size={18} />{fmt(value, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</button>
    {open && <DateDialog value={value} onClose={() => setOpen(false)} onSet={d => { setOpen(false); set(d) }} />}
  </>
}

function DateDialog({ value, onClose, onSet }: { value: string; onClose: () => void; onSet: (d: string) => void }) {
  const [day, setDay] = useState(value)
  const [month, setMonth] = useState(value) // the page shown: its month, year or decade
  const [page, setPage] = useState<'days' | 'months' | 'years'>('days') // the user, 18 Oct: the month or the year clicked shows its own calendar
  const today = key(new Date())
  const year = +month.slice(0, 4), decade = Math.floor(year / 10) * 10
  const jump = (y: number, mo: number) => { const d = `${y}-${pad(mo)}-${pad(Math.min(+day.slice(8), new Date(y, mo, 0).getDate()))}`; setDay(d); setMonth(d) }
  const step = { days: 1, months: 12, years: 120 }[page]
  const head = (label: string, to: 'months' | 'years') => <button className="text-button" onClick={() => setPage(to)}>{label} ▾</button>
  return (
    <Modal onClose={onClose}>
      <div className="cal-datepick">
        <p className="muted">Date</p>
        <h3>{fmt(day, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
        <div className="cal-mini">
          <div className="cal-mini-head">
            {page === 'days' && <>{head(fmt(month, { month: 'long' }), 'months')}{head(String(year), 'years')}</>}
            {page === 'months' && head(String(year), 'years')}
            {page === 'years' && <b className="cal-decade">{decade}–{decade + 9}</b>}
            <span />
            <button className="round small" title="Back" onClick={() => setMonth(x => addMonths(x, -step))}><Icon name="back" size={18} /></button>
            <button className="round small" title="Forward" onClick={() => setMonth(x => addMonths(x, step))}><Icon name="forward" size={18} /></button></div>
          {page === 'years' && <div className="cal-years">{Array.from({ length: 10 }, (_, i) => decade + i).map(y =>
            <button key={y} title={String(y)} className={`${y === +day.slice(0, 4) ? 'on' : ''} ${y === +today.slice(0, 4) ? 'today' : ''}`} onClick={() => { jump(y, +month.slice(5, 7)); setPage('months') }}>{pad(y % 100)}</button>)}</div>}
          {page === 'months' && <div className="cal-years cal-months">{Array.from({ length: 12 }, (_, i) => i + 1).map(mo =>
            <button key={mo} className={`${day.slice(0, 7) === `${year}-${pad(mo)}` ? 'on' : ''} ${today.slice(0, 7) === `${year}-${pad(mo)}` ? 'today' : ''}`} onClick={() => { jump(year, mo); setPage('days') }}>{fmt(`${year}-${pad(mo)}-01`, { month: 'short' })}</button>)}</div>}
          {page === 'days' && <div className="cal-mini-grid">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="muted">{d}</span>)}
            {monthCells(month).map(d => <button key={d} className={`${d === day ? 'on' : ''} ${d === today ? 'today' : ''} ${d.slice(5, 7) !== month.slice(5, 7) ? 'out' : ''}`} onClick={() => { setDay(d); setMonth(d) }} onDoubleClick={() => onSet(d)}>{+d.slice(8)}</button>)}
          </div>}
        </div>
        <div className="dialog-actions"><button className="text-button" onClick={() => { setDay(today); setMonth(today); setPage('days') }}>Today</button><span style={{ flex: 1 }} />
          <button className="text-button" onClick={onClose}>Cancel</button><button className="filled-button" onClick={() => onSet(day)}>OK</button></div>
      </div>
    </Modal>
  )
}
