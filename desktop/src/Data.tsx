import { useEffect, useMemo, useState } from 'react'

// Data on the computer (Drive-Android Plan.md § Data), laid out as the phone's: the plan's ring, the days as bars (by kind or by
// app, the days to come faint), the cycle against the limit, the numbers and tips, the apps (the hotspot opening into each device's),
// the devices, this computer's connection and the drops. Read only: the plan is set on the phone; this computer adds its own counts
// (datacount.js). The rules (cycle, forecast, tips) are the phone's DataRules/DataInsights, the same here.

type Line = { deviceName?: string; d?: string; h?: string; app?: string; name?: string; net?: string; fg?: number; bg?: number; mobile?: number; wifi?: number; roam?: number;
  hotspot?: number; via?: number; eth?: number; bytes?: number; at?: string; event?: string; secs?: number; note?: string; outsideEu?: boolean }
type Plan = { kind: string; size: number; every: string; day: number; days: number; from: string; warn: number[]; euCounts?: boolean; daily?: number; carrier?: { cycle: string; offset: number } }
type All = { plan: Plan | null; devices: Record<string, Line[]>; me: string }
type Wifi = { rssi?: number; speed?: number; mhz?: number; ssid?: string; ethernet?: { iface: string; speed: number }; error?: string }

const LIME = '#7cc417', HOTSPOT = '#ff9f1c', WIFI = '#4f86e8', CAR = '#26c6da'
const APP_COLORS = ['#ff9f1c', '#4f86e8', '#e91e63', '#26c6da', '#ab47bc', '#ffca28']
const DAY = 86_400_000

export const bytes = (b: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = Math.max(0, b), i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return i === 0 || v >= 10 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const parseDay = (s: string) => new Date(s + 'T00:00')
const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** The plan's cycle today, as the phone's DataRules.cycle. */
export function cycle(p: Plan | null, today: Date): [Date, Date] {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (p?.every === 'week') { const back = (t.getDay() + 7 - (p.day % 7)) % 7; const s = addDays(t, -back); return [s, addDays(s, 7)] }
  if (p?.every === 'days') {
    const from = parseDay(p.from), n = Math.max(1, p.days)
    const k = Math.floor(Math.round((t.getTime() - from.getTime()) / DAY) / n)
    const s = addDays(from, k * n); return [s, addDays(s, n)]
  }
  const day = p?.day ?? 1
  const on = (y: number, m: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()))
  const here = on(t.getFullYear(), t.getMonth())
  const s = t < here ? on(t.getFullYear(), t.getMonth() - 1) : here
  return [s, on(s.getFullYear(), s.getMonth() + 1)]
}

const median = (l: number[]) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/** A day's likely use: the median of the same weekday over the last three weeks, else of the last two weeks (the phone's forecast). */
export function forecast(history: Map<string, number>, day: Date, before: Date): number {
  const past = [...history.entries()].map(([k, v]) => [parseDay(k), v] as const).filter(([d]) => d < before && d >= addDays(before, -21))
  const same = past.filter(([d]) => d.getDay() === day.getDay()).map(([, v]) => v)
  return median(same.length >= 2 ? same : past.filter(([d]) => d >= addDays(before, -14)).map(([, v]) => v))
}

type Kinds = { mobile: number; hotspot: number; wifi: number; car: number; eth: number }
/** On the phone the hotspot is what it shared and its metered Wi-Fi the car's (Android Auto); elsewhere the hotspot is what was used through the phone. */
const kinds = (l: Line | undefined, isPhone: boolean): Kinds => !l ? { mobile: 0, hotspot: 0, wifi: 0, car: 0, eth: 0 }
  : isPhone ? { mobile: (l.mobile || 0) - (l.hotspot || 0), hotspot: l.hotspot || 0, wifi: (l.wifi || 0) - (l.via || 0), car: l.via || 0, eth: 0 }
    : { mobile: l.mobile || 0, hotspot: l.via || 0, wifi: (l.wifi || 0) - (l.via || 0), car: 0, eth: l.eth || 0 }
const total = (k: Kinds) => k.mobile + k.hotspot + k.wifi + k.car + k.eth
const counted = (p: Plan | null, l: Line) => (l.mobile || 0) - (l.outsideEu ? (l.roam || 0) : p && p.euCounts === false ? (l.roam || 0) : 0)

const DROPS: Record<string, string> = { 'drop-mobile': 'mobile data lost', 'drop-wifi': 'Wi-Fi lost', 'no-service': 'no service', 'weak-mobile': 'no mobile signal', 'weak-wifi': 'Wi-Fi very weak', 'left-hotspot': "off the phone's hotspot", 'fell-to-3G': 'fell to 3G', 'fell-to-2G': 'fell to 2G' }
const quality = (r: number) => (r >= -55 ? 'Excellent' : r >= -67 ? 'Good: calls and video' : r >= -75 ? 'Fair: the web' : r >= -85 ? 'Poor: it may drop' : 'Almost none')

function Info({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return <span style={{ position: 'relative' }}>
    <button className="round flat" title={text} onClick={() => setOpen(!open)} style={{ width: 24, height: 24, fontSize: 14, opacity: 0.7 }}>ⓘ</button>
    {open && <span onClick={() => setOpen(false)} style={{ position: 'absolute', right: 0, top: 26, zIndex: 5, width: 340, padding: 12, borderRadius: 12, background: 'var(--card, #2a2d30)', color: 'var(--text)', boxShadow: '0 4px 16px #0006', fontSize: 13, lineHeight: 1.4 }}>{text}</span>}
  </span>
}

const card: React.CSSProperties = { background: 'var(--thumb-bg)', borderRadius: 16, padding: 16 }
const h3: React.CSSProperties = { margin: 0, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }

export function DataPage() {
  const [all, setAll] = useState<All | null>(null)
  const [wifi, setWifi] = useState<Wifi | null>(null)
  const [byApp, setByApp] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [allApps, setAllApps] = useState(false)
  const [openHotspot, setOpenHotspot] = useState(false)
  useEffect(() => { window.drive.dataAll().then(a => setAll(a as All)).catch(() => setAll({ plan: null, devices: {}, me: '' })) }, [])
  useEffect(() => { const look = () => window.drive.dataWifi().then(setWifi).catch(() => {}); look(); const t = setInterval(look, 3000); return () => clearInterval(t) }, [])
  const today = new Date(); const todayIso = iso(today)
  const plan = all?.plan ?? null
  const [start, end] = cycle(plan, today)

  const view = useMemo(() => {
    if (!all) return null
    const devices = Object.entries(all.devices).map(([id, lines]) => {
      const days = new Map<string, Line>(); for (const l of lines) if (l.d && !l.app && l.mobile !== undefined) days.set(l.d, l)
      return { id, name: lines.find(l => l.deviceName)?.deviceName || id, days, apps: lines.filter(l => l.app && l.d), drops: lines.filter(l => l.event && DROPS[l.event]) }
    })
    const mobileOf = (d: typeof devices[number]) => [...d.days.values()].reduce((s, l) => s + (l.mobile || 0), 0)
    const phone = devices.slice().sort((a, b) => mobileOf(b) - mobileOf(a))[0]
    return { devices, phone }
  }, [all])
  if (!all || !view) return <main className="page"><p className="muted">Reading…</p></main>
  const { devices, phone } = view

  // the plan's status, as the phone's DataRules.status
  const cycleDays: string[] = []; for (let d = start; d < end; d = addDays(d, 1)) cycleDays.push(iso(d))
  const phoneHistory = new Map<string, number>(); phone?.days.forEach((l, k) => phoneHistory.set(k, counted(plan, l)))
  const perDay = cycleDays.filter(k => k <= todayIso).map(k => phoneHistory.get(k) ?? 0)
  const offset = plan?.carrier && plan.carrier.cycle >= iso(start) && plan.carrier.cycle < iso(end) ? plan.carrier.offset : 0
  const used = Math.max(0, perDay.reduce((a, b) => a + b, 0) + offset)
  const limited = !!plan && plan.kind !== 'unlimited'
  const size = plan?.size ?? 0
  const daysLeft = Math.round((end.getTime() - parseDay(todayIso).getTime()) / DAY)
  const budget = plan?.daily ? plan.daily : Math.max(0, size - used) / Math.max(1, daysLeft)
  const todayUse = perDay[perDay.length - 1] ?? 0
  const ahead = cycleDays.filter(k => k > todayIso).map(k => forecast(phoneHistory, parseDay(k), parseDay(todayIso)))
  const projection = used - todayUse + Math.max(todayUse, forecast(phoneHistory, parseDay(todayIso), parseDay(todayIso))) + ahead.reduce((a, b) => a + b, 0)

  // the bars: the cycle's days, the phone's kinds (or by app across the devices), the days to come faint
  const isPhone = (id: string) => id === phone?.id
  const kindHistory = (f: (k: Kinds) => number) => { const m = new Map<string, number>(); phone?.days.forEach((l, k) => m.set(k, f(kinds(l, true)))); return m }
  const histories = (['mobile', 'hotspot', 'wifi', 'car'] as const).map(n => [n, kindHistory(k => k[n])] as const)
  const bars = cycleDays.map(k => {
    const future = k > todayIso
    const kd: Kinds = future ? { ...Object.fromEntries(histories.map(([n, h]) => [n, forecast(h, parseDay(k), parseDay(todayIso))])), eth: 0 } as Kinds : kinds(phone?.days.get(k), true)
    return { day: k, future, kd }
  })
  // by app: the phone's own apps on mobile and what the others' apps took through its hotspot
  const appRows = devices.flatMap(dev => dev.apps.filter(a => isPhone(dev.id) ? a.net === 'mobile' && a.app !== 'hotspot' : a.net === 'hotspot')
    .map(a => ({ day: a.d!, name: a.name || a.app!, bytes: (a.fg || 0) + (a.bg || 0) })))
  const inCycleApps = appRows.filter(a => a.day >= iso(start) && a.day < iso(end))
  const topApps = Object.entries(inCycleApps.reduce<Record<string, number>>((m, a) => ({ ...m, [a.name]: (m[a.name] || 0) + a.bytes }), {})).sort((a, b) => b[1] - a[1])
  const top6 = topApps.slice(0, 6).map(([n]) => n)
  const stack = (b: typeof bars[number]): [string, number, string][] => byApp
    ? b.future ? [] : [...top6.map((n, i) => [APP_COLORS[i], inCycleApps.filter(a => a.day === b.day && a.name === n).reduce((s, a) => s + a.bytes, 0), n] as [string, number, string]),
      ['#8a8f94', inCycleApps.filter(a => a.day === b.day && !top6.includes(a.name)).reduce((s, a) => s + a.bytes, 0), 'Other apps']]
    : [[LIME, b.kd.mobile, 'Mobile'], [HOTSPOT, b.kd.hotspot, 'Hotspot'], [WIFI, b.kd.wifi, 'Wi-Fi'], [CAR, b.kd.car, 'Android Auto']]
  const sumOf = (b: typeof bars[number]) => stack(b).reduce((s, [, v]) => s + v, 0)
  const maxBar = Math.max(1, ...bars.map(sumOf))
  const step = (() => { const raw = maxBar / 4, p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].find(m => m * p >= raw)! * p })()
  const top = Math.ceil(maxBar / step) * step
  const done = bars.filter(b => !b.future && b.day !== todayIso && sumOf(b) > 0)
  const average = done.length ? done.reduce((s, b) => s + sumOf(b), 0) / done.length : 0

  // the numbers and the tips (the phone's DataInsights)
  const recent = [...phoneHistory.entries()].filter(([k]) => k < todayIso && parseDay(k) >= addDays(parseDay(todayIso), -21))
  const workdays = median(recent.filter(([k]) => ![0, 6].includes(parseDay(k).getDay())).map(([, v]) => v))
  const weekends = median(recent.filter(([k]) => [0, 6].includes(parseDay(k).getDay())).map(([, v]) => v))
  const inCycle = cycleDays.filter(k => k <= todayIso).map(k => phone?.days.get(k)).filter(Boolean) as Line[]
  const mobileSum = inCycle.reduce((s, l) => s + (l.mobile || 0), 0), hotspotSum = inCycle.reduce((s, l) => s + (l.hotspot || 0), 0)
  const hotspotShare = mobileSum ? Math.round(hotspotSum * 100 / mobileSum) : 0
  const busiest = cycleDays.filter(k => k <= todayIso).map(k => [k, phoneHistory.get(k) ?? 0] as const).sort((a, b) => b[1] - a[1])[0]
  const avgDay = perDay.length > 1 ? perDay.slice(0, -1).reduce((a, b) => a + b, 0) / (perDay.length - 1) : 0
  let acc = used - todayUse + Math.max(todayUse, forecast(phoneHistory, parseDay(todayIso), parseDay(todayIso)))
  let runsOut: string | null = limited && acc > size ? todayIso : null
  cycleDays.filter(k => k > todayIso).forEach((k, i) => { acc += ahead[i]; if (limited && !runsOut && acc > size) runsOut = k })
  const tips: [string, string][] = []
  if (limited) {
    if (used >= size) tips.push(['The limit is reached', `${bytes(used)} of ${bytes(size)} used, ${daysLeft} days before the renewal.`])
    else if (runsOut) tips.push([`The limit comes ${fmt(parseDay(runsOut))}`, `At your usual pace the ${bytes(size)} run out before ${fmt(end)}. To last, stay near ${bytes(budget)} a day.`])
    else tips.push([`About ${Math.round(projection * 100 / size)} % of the limit`, `At your usual pace you will use about ${bytes(projection)} of ${bytes(size)}: ${bytes(size - projection)} to spare. Up to ${bytes(budget)} a day still makes it.`])
  }
  if (hotspotShare >= 40) tips.push([`${hotspotShare} % went through the hotspot`, 'Most of the plan goes to the tablet and this computer. Their updates, downloads, backups and video fill it fastest: leave those for a Wi-Fi that is not the phone\'s, or set them to pause on metered networks (NetworkManager marks the phone\'s hotspot as metered).'])
  if (weekends && workdays && weekends / workdays >= 1.3) tips.push(['Weekends use more', `A weekend day ${bytes(weekends)}, a workday ${bytes(workdays)}: with no Wi-Fi at work to lean on, weekends are where a Wi-Fi saves the most.`])
  const topNamed = topApps.find(([n]) => n !== 'Other (calls, video, UDP)')
  if (topNamed && topNamed[1] > 500_000_000) tips.push([`${topNamed[0]}: ${bytes(topNamed[1])}`, 'The app using the most of the plan this cycle, on any of your devices. Its own settings may have a data saver, a lower video quality, or updates on Wi-Fi only.'])

  // the apps of the picked day or of the cycle, on the phone's side (its own and the hotspot), by name
  const listFrom = picked ?? iso(start), listUntil = picked ? iso(addDays(parseDay(picked), 1)) : iso(end)
  const phoneApps = (phone?.apps ?? []).filter(a => a.d! >= listFrom && a.d! < listUntil)
  const appList = Object.values(phoneApps.reduce<Record<string, { key: string; name: string; mobile: number; hotspot: number; wifi: number }>>((m, a) => {
    const key = a.app!; const r = m[key] ||= { key, name: a.name || key, mobile: 0, hotspot: 0, wifi: 0 }; const v = (a.fg || 0) + (a.bg || 0)
    if (key === 'hotspot') r.hotspot += a.net === 'mobile' ? v : 0; else if (a.net === 'mobile') r.mobile += v; else r.wifi += v
    return m
  }, {})).filter(r => r.mobile + r.hotspot + r.wifi > 0).sort((a, b) => (b.mobile * 4 + b.hotspot * 2 + b.wifi) - (a.mobile * 4 + a.hotspot * 2 + a.wifi))
  const most = Math.max(1, ...appList.map(r => r.mobile + r.hotspot + r.wifi))
  const clients = devices.filter(d => !isPhone(d.id)).map(d => {
    const apps = Object.entries(d.apps.filter(a => a.net === 'hotspot' && a.d! >= listFrom && a.d! < listUntil).reduce<Record<string, number>>((m, a) => ({ ...m, [a.name || a.app!]: (m[a.name || a.app!] || 0) + (a.fg || 0) + (a.bg || 0) }), {})).sort((a, b) => b[1] - a[1])
    return { name: d.name + (d.id === all.me ? ' (this computer)' : ''), total: apps.reduce((s, [, v]) => s + v, 0), apps }
  }).filter(c => c.total > 0)
  const drops = devices.flatMap(d => d.drops.map(e => ({ ...e, device: d.name }))).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 30)
  const W = 640, H = 200, slot = W / bars.length

  return (
    <main className="page" style={{ overflow: 'auto', padding: '24px 32px', display: 'grid', gap: 18, alignContent: 'start', maxWidth: 1100 }}>
      <section style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
        <svg width={120} height={120} viewBox="0 0 120 120">
          <circle cx={60} cy={60} r={50} fill="none" stroke="var(--thumb-bg)" strokeWidth={12} />
          {limited && <circle cx={60} cy={60} r={50} fill="none" stroke={used > size ? '#e53935' : LIME} strokeWidth={12} strokeLinecap="round"
            strokeDasharray={`${Math.min(1, used / Math.max(1, size)) * 314} 314`} transform="rotate(-90 60 60)" />}
          <text x={60} y={68} textAnchor="middle" fontSize={24} fontWeight={700} fill="currentColor">{limited ? `${Math.round(used * 100 / Math.max(1, size))} %` : '∞'}</text>
        </svg>
        <div style={{ display: 'grid', gap: 2 }}>
          <h2 style={h3}>{plan ? `${bytes(used)} ${plan.kind === 'unlimited' ? 'this cycle' : `of ${bytes(size)}${plan.kind === 'fair-use' ? ' fair use' : ''}`}` : 'Data'}
            <Info text="The ring: how much of the limit the phone's plan has used this cycle (counting from what you typed from the carrier, if you did). Budget: what is left shared over the days left. Forecast: where your usual days take you by the renewal." /></h2>
          {plan ? <>
            <span>{daysLeft} days left · renews {fmt(end)}</span>
            <span>Today {bytes(todayUse)}{limited ? ` · budget ${bytes(budget)}/day` : ''}</span>
            {limited && <span style={{ color: projection > size ? '#e53935' : undefined }}>Forecast: {bytes(projection)} by {fmt(addDays(end, -1))} {projection > size ? '⚠' : '✓'}</span>}
          </> : <span className="muted">Set Data up on the phone (Data › Setup); its plan and counts come here with sync.</span>}
        </div>
      </section>

      <section style={card}>
        <div style={h3}>
          <span><b>{fmt(start)} – {fmt(addDays(end, -1))}</b>{' '}
            <span className="segmented" style={{ marginLeft: 12 }}>{[false, true].map(a => <button key={String(a)} className={a === byApp ? 'on' : ''} onClick={() => setByApp(a)}>{a ? 'Apps' : 'Kinds'}</button>)}</span></span>
          <Info text="Each bar is a day of the phone's plan: its own mobile data (lime), what its hotspot shared (orange), Wi-Fi (blue) and Android Auto's link to the car (teal). Apps: the same days by app — the phone's own on mobile and what the tablet's and this computer's took through the hotspot. Faint bars: the days to come, each the median of the same weekday over the last three weeks. Dashed: your average day. Click a bar for its apps." />
        </div>
        <svg viewBox={`0 -12 ${W + 50} ${H + 32}`} style={{ width: '100%', height: 270 }}>
          {[0, 1, 2, 3, 4].filter(i => i * step <= top).map(i => <g key={i}><line x1={50} x2={W + 50} y1={H - H * i * step / top} y2={H - H * i * step / top} stroke="currentColor" opacity={0.12} />
            <text x={44} y={H - H * i * step / top + 4} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.6}>{bytes(i * step)}</text></g>)}
          {bars.map((b, i) => { let y = H; return <g key={b.day} onClick={() => !b.future && setPicked(picked === b.day ? null : b.day)} style={{ cursor: b.future ? 'default' : 'pointer' }}>
            {stack(b).map(([color, v], j) => { const h = H * v / top; y -= h; return v > 0 && <rect key={j} x={50 + i * slot + slot * 0.15} y={y} width={slot * 0.7} height={h} fill={color}
              opacity={b.future ? 0.25 : picked && picked !== b.day ? 0.35 : 1} stroke={b.future ? color : undefined} /> })}
            <title>{fmt(parseDay(b.day))}{b.future ? ' (forecast)' : ''}: {stack(b).filter(([, v]) => v > 0).map(([, v, n]) => `${n} ${bytes(v)}`).join(' · ')}</title>
            {i % Math.max(1, Math.round(bars.length / 10)) === 0 && <text x={50 + i * slot + slot / 2} y={H + 14} fontSize={10} textAnchor="middle" fill="currentColor" opacity={0.6}>{parseDay(b.day).getDate()}</text>}
          </g> })}
          {average > 0 && <line x1={50} x2={W + 50} y1={H - H * average / top} y2={H - H * average / top} stroke="currentColor" strokeDasharray="8 6" opacity={0.7} />}
        </svg>
        <p className="muted" style={{ margin: 0, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {(byApp ? [...top6.map((n, i) => [n, APP_COLORS[i]]), ['Other apps', '#8a8f94']] : [['Mobile', LIME], ['Hotspot', HOTSPOT], ['Wi-Fi', WIFI], ['Android Auto', CAR]]).map(([n, c]) => <span key={n}><span style={{ color: c }}>●</span> {n}</span>)}
          <span>· dashed: the average, {bytes(average)} a day · faint: the days to come{byApp ? ' (by kind only)' : ''}</span>
        </p>
      </section>

      {limited && <section style={card}>
        <div style={h3}><b>The cycle so far</b><Info text="The solid line adds up the plan's data day by day; the dashed one carries it on with your usual days to the renewal; the top line is the limit. If the dashed line crosses it, the limit comes before the renewal." /></div>
        {(() => { const t2 = Math.max(size, projection), xs = (i: number) => 50 + (W * i) / cycleDays.length, ys = (v: number) => 130 - 130 * v / t2; let a = 0
          const solid = perDay.map((v, i) => { a += v; return `${xs(i + 1)},${ys(a)}` }); let f = used; const dashed = ahead.map((v, i) => { f += v; return `${xs(perDay.length + i + 1)},${ys(f)}` })
          return <svg viewBox={`0 -10 ${W + 50} 150`} style={{ width: '100%', height: 160 }}>
            <line x1={50} x2={W + 50} y1={ys(size)} y2={ys(size)} stroke="currentColor" opacity={0.5} /><text x={44} y={ys(size) + 4} fontSize={10} textAnchor="end" fill="currentColor">{bytes(size)}</text>
            <text x={44} y={134} fontSize={10} textAnchor="end" fill="currentColor">0</text>
            <polyline points={`50,130 ${solid.join(' ')}`} fill="none" stroke={LIME} strokeWidth={3} />
            <polyline points={`${solid[solid.length - 1] ?? '50,130'} ${dashed.join(' ')}`} fill="none" stroke={LIME} strokeWidth={2} strokeDasharray="8 6" opacity={0.7} />
          </svg> })()}
        <p className="muted" style={{ margin: 0 }}>{bytes(used)} so far · about {bytes(projection)} by {fmt(addDays(end, -1))} · limit {bytes(size)}</p>
      </section>}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
        <div style={card}>
          <div style={h3}><b>This cycle in numbers</b><Info text="The phone's mobile data, as the plan counts it. A day: the days so far, today left out. Workdays and weekends: the typical (median) day of each over the last three weeks. Through the hotspot: the share of the mobile data the phone gave to other devices." /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            {[['Mobile data a day', bytes(avgDay)], ['Workdays · weekends', `${bytes(workdays)} · ${bytes(weekends)}`], ['Busiest day', busiest ? `${fmt(parseDay(busiest[0]))} · ${bytes(busiest[1])}` : '—'], ['Through the hotspot', `${hotspotShare} %`]]
              .map(([k, v]) => <div key={k}><div className="muted" style={{ fontSize: 12 }}>{k}</div><div style={{ fontSize: 18, fontWeight: 600 }}>{v}</div></div>)}
          </div>
        </div>
        {tips.length > 0 && <div style={{ ...card, background: 'color-mix(in srgb, #7cc417 14%, transparent)' }}>
          <div style={h3}><b style={{ color: LIME }}>For your plan</b><Info text="Worked out from your own days: the pace, where the data goes, the weekdays and the apps. Only information — Data changes nothing; each line says where you could change it yourself." /></div>
          {tips.map(([t, x]) => <p key={t} style={{ margin: '10px 0 0' }}><b>{t}</b><br />{x}</p>)}
        </div>}
      </section>

      <section style={card}>
        <div style={h3}><b>Apps{picked ? ` · ${fmt(parseDay(picked))}` : ''}</b>{picked && <button className="chip" onClick={() => setPicked(null)}>All the cycle</button>}</div>
        {(allApps ? appList : appList.slice(0, 10)).map(r => <div key={r.key} style={{ margin: '10px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', cursor: r.key === 'hotspot' ? 'pointer' : 'default' }} onClick={() => r.key === 'hotspot' && setOpenHotspot(!openHotspot)}>
            <span>{r.name}{r.key === 'hotspot' ? (openHotspot ? ' ▴' : ' ▾') : ''}</span>
            <span className="muted">{[r.mobile ? `Mobile ${bytes(r.mobile)}` : '', r.hotspot ? `Hotspot ${bytes(r.hotspot)}` : '', r.wifi ? `Wi-Fi ${bytes(r.wifi)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
            {([[r.mobile, LIME], [r.hotspot, HOTSPOT], [r.wifi, WIFI]] as [number, string][]).map(([v, c], i) => <div key={i} style={{ width: `${v * 100 / most}%`, background: c }} />)}
          </div>
          {r.key === 'hotspot' && openHotspot && <div style={{ margin: '8px 0 0 20px' }}>
            {clients.length === 0 && <p className="muted">The tablet's and this computer's counts have not come yet.</p>}
            {clients.map(c => <div key={c.name} style={{ marginBottom: 8 }}><b>{c.name} · {bytes(c.total)}</b>
              {c.apps.slice(0, 8).map(([n, v]) => <div key={n} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 12 }}><span>{n}</span><span className="muted">{bytes(v)}</span></div>)}</div>)}
            {clients.length > 0 && r.hotspot > clients.reduce((s, c) => s + c.total, 0) && <p className="muted" style={{ margin: 0 }}>Not counted by them: {bytes(r.hotspot - clients.reduce((s, c) => s + c.total, 0))} (a guest, hours they were off, overheads)</p>}
          </div>}
        </div>)}
        {appList.length > 10 && <button className="chip" onClick={() => setAllApps(!allApps)}>{allApps ? 'The top ten' : `All apps and services (${appList.length})`}</button>}
      </section>

      <section style={card}>
        <div style={h3}><b>The devices this cycle</b><Info text="Each device's own count: the phone's mobile data (its own and what its hotspot shared) and Android Auto's link, the tablet's and this computer's Wi-Fi and what of it went through the phone's hotspot; Ethernet when this computer was on a cable." /></div>
        {devices.map(d => { const k = cycleDays.filter(x => x <= todayIso).map(x => kinds(d.days.get(x), isPhone(d.id))).reduce((a, b) => ({ mobile: a.mobile + b.mobile, hotspot: a.hotspot + b.hotspot, wifi: a.wifi + b.wifi, car: a.car + b.car, eth: a.eth + b.eth }), { mobile: 0, hotspot: 0, wifi: 0, car: 0, eth: 0 })
          return total(k) > 0 && <p key={d.id} style={{ margin: '8px 0' }}><b>{d.name}{d.id === all.me ? ' (this computer)' : ''}</b>: {[k.mobile ? `Mobile ${bytes(k.mobile)}` : '', k.hotspot ? `Hotspot ${bytes(k.hotspot)}` : '', `Wi-Fi ${bytes(k.wifi)}`, k.car ? `Android Auto ${bytes(k.car)}` : '', k.eth ? `Ethernet ${bytes(k.eth)}` : ''].filter(Boolean).join(' · ')}</p> })}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
        <div style={card}>
          <b>This computer's connection now</b>
          {wifi?.ethernet && <p style={{ margin: '8px 0 0' }}><b style={{ fontSize: 22 }}>Ethernet</b> · {wifi.ethernet.speed ? `${wifi.ethernet.speed} Mb/s` : 'connected'} ({wifi.ethernet.iface})</p>}
          {wifi?.rssi !== undefined ? <p style={{ margin: '8px 0 0' }}><b style={{ fontSize: 22 }}>Wi-Fi {wifi.rssi < 0 ? `${wifi.rssi} dBm` : ''}</b> · {wifi.rssi < 0 ? quality(wifi.rssi) + ' · ' : ''}{wifi.speed} Mb/s · {wifi.ssid} · {wifi.mhz && wifi.mhz >= 4900 ? '5 GHz' : '2.4 GHz'}</p>
            : !wifi?.ethernet && <p className="muted">{wifi?.error ?? 'Reading…'}</p>}
        </div>
        <div style={card}>
          <b>Drops</b>
          {drops.length === 0 && <p className="muted">None recorded yet.</p>}
          {drops.map((e, i) => <p key={i} style={{ margin: '4px 0' }}>{new Date(e.at!).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {e.device} · {DROPS[e.event!]} {e.secs ? `${e.secs >= 60 ? `${Math.floor(e.secs / 60)} min ` : ''}${e.secs % 60} s` : ''}{e.note ? ` (${e.note})` : ''}</p>)}
        </div>
      </section>
    </main>
  )
}
