import { useEffect, useMemo, useState } from 'react'

// Data on the computer (Drive-Android Plan.md § Data): the phone's plan, the three devices' counts as their files in
// Files/Data/usage say, the phone's hotspot split, the drops, and this computer's own Wi-Fi now. Read only: the plan is
// set up on the phone (Setup there); this computer adds its own counts (datacount.js).

type Line = { deviceName?: string; d?: string; h?: string; app?: string; net?: string; mobile?: number; wifi?: number; roam?: number; hotspot?: number; via?: number; bytes?: number; at?: string; event?: string; secs?: number; note?: string }
type Plan = { kind: string; size: number; every: string; day: number; days: number; from: string; warn: number[] }
type All = { plan: Plan | null; devices: Record<string, Line[]>; me: string }
type Wifi = { rssi?: number; speed?: number; mhz?: number; ssid?: string; error?: string }
const LIME = '#7cc417'
const WIFI = '#4f86e8'

export const bytes = (b: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = b, i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return i === 0 || v >= 10 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** The plan's cycle today, as the phone's DataRules.cycle. */
export function cycle(p: Plan | null, today: Date): [Date, Date] {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (p?.every === 'week') { const back = (t.getDay() + 7 - (p.day % 7)) % 7; const s = addDays(t, -back); return [s, addDays(s, 7)] }
  if (p?.every === 'days') {
    const from = new Date(p.from + 'T00:00'), n = Math.max(1, p.days)
    const k = Math.floor(Math.round((t.getTime() - from.getTime()) / 86_400_000) / n)
    const s = addDays(from, k * n); return [s, addDays(s, n)]
  }
  const day = p?.day ?? 1
  const on = (y: number, m: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()))
  const here = on(t.getFullYear(), t.getMonth())
  const s = t < here ? on(t.getFullYear(), t.getMonth() - 1) : here
  return [s, on(s.getFullYear(), s.getMonth() + 1)]
}

const DROPS: Record<string, string> = { 'drop-mobile': 'mobile data lost', 'drop-wifi': 'Wi-Fi lost', 'no-service': 'no service', 'weak-mobile': 'no mobile signal', 'weak-wifi': 'Wi-Fi very weak', 'left-hotspot': "off the phone's hotspot", 'fell-to-3G': 'fell to 3G', 'fell-to-2G': 'fell to 2G' }
const quality = (r: number) => (r >= -55 ? 'Excellent' : r >= -67 ? 'Good: calls and video' : r >= -75 ? 'Fair: the web' : r >= -85 ? 'Poor: it may drop' : 'Almost none')

export function DataPage() {
  const [all, setAll] = useState<All | null>(null)
  const [wifi, setWifi] = useState<Wifi | null>(null)
  useEffect(() => { window.drive.dataAll().then(setAll).catch(() => setAll({ plan: null, devices: {}, me: '' })) }, [])
  useEffect(() => {
    const look = () => window.drive.dataWifi().then(setWifi).catch(() => {})
    look(); const t = setInterval(look, 3000); return () => clearInterval(t)
  }, [])
  const today = new Date()
  const [start, end] = cycle(all?.plan ?? null, today)
  const view = useMemo(() => {
    if (!all) return null
    const days = (lines: Line[]) => { const m = new Map<string, Line>(); for (const l of lines) if (l.d && !l.app && l.mobile !== undefined) m.set(l.d, l); return m }
    const inCycle = (d: string) => d >= iso(start) && d < iso(end)
    const devices = Object.entries(all.devices).map(([name, lines]) => {
      const m = days(lines)
      const cyc = [...m.values()].filter(l => inCycle(l.d!))
      return { name: lines.find(l => l.deviceName)?.deviceName || name, id: name, days: m, mobile: cyc.reduce((s, l) => s + (l.mobile || 0), 0), wifi: cyc.reduce((s, l) => s + (l.wifi || 0), 0),
        hotspot: cyc.reduce((s, l) => s + (l.hotspot || 0), 0), via: cyc.reduce((s, l) => s + (l.via || 0), 0),
        drops: lines.filter(l => l.event && DROPS[l.event]).map(l => ({ ...l, device: name })) }
    }).filter(d => d.mobile + d.wifi > 0 || d.drops.length)
    const phone = devices.slice().sort((a, b) => b.mobile - a.mobile)[0]
    return { devices, phone }
  }, [all, start.getTime()])
  if (!all || !view) return <main className="page"><p className="muted">Reading…</p></main>
  const { devices, phone } = view
  const plan = all.plan
  const used = phone?.mobile ?? 0
  const clients = devices.filter(d => d !== phone && d.via > 0).sort((a, b) => b.via - a.via)
  const hotspot = phone?.hotspot ?? 0
  const last30 = Array.from({ length: 30 }, (_, i) => iso(addDays(today, i - 29)))
  const top = Math.max(1, ...last30.map(d => devices.reduce((s, dev) => s + ((dev.days.get(d)?.mobile || 0) + (dev.days.get(d)?.wifi || 0)), 0)))
  const drops = devices.flatMap(d => d.drops).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 40)
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <main className="page" style={{ overflow: 'auto', padding: '24px 32px', display: 'grid', gap: 24, alignContent: 'start' }}>
      <section>
        <h2 style={{ margin: 0 }}>{plan ? (plan.kind === 'unlimited' ? `${bytes(used)} this cycle` : `${bytes(used)} of ${bytes(plan.size)}${plan.kind === 'fair-use' ? ' fair use' : ''}`) : 'Data'}</h2>
        <p className="muted" style={{ margin: '4px 0' }}>{plan ? `The phone's plan · ${fmt(start)} – ${fmt(addDays(end, -1))} · ${Math.round((end.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)} days left` : 'Set Data up on the phone (Data › Setup); its plan and counts come here with sync.'}</p>
        {plan && plan.kind !== 'unlimited' && <div style={{ height: 10, borderRadius: 5, background: 'var(--thumb-bg)', overflow: 'hidden', maxWidth: 520 }}><div style={{ width: `${Math.min(100, (used * 100) / plan.size)}%`, height: '100%', background: LIME }} /></div>}
      </section>

      <section>
        <h3>The last 30 days, all devices</h3>
        <svg viewBox="0 0 600 160" style={{ width: '100%', maxWidth: 900, height: 180 }}>
          {last30.map((d, i) => {
            let y = 150
            return <g key={d}>{devices.flatMap(dev => [['m', dev.days.get(d)?.mobile || 0], ['w', dev.days.get(d)?.wifi || 0]] as const).map(([k, v], j) => {
              const h = (v / top) * 140; y -= h
              return <rect key={j} x={i * 20 + 3} y={y} width={14} height={h} fill={k === 'm' ? LIME : WIFI} opacity={0.6 + 0.4 * ((j >> 1) % 2)} />
            })}{i % 5 === 0 && <text x={i * 20 + 10} y={159} fontSize={8} textAnchor="middle" fill="currentColor">{Number(d.slice(8))}</text>}</g>
          })}
          <text x={0} y={8} fontSize={8} fill="currentColor">{bytes(top)}</text>
        </svg>
        <p className="muted" style={{ margin: 0 }}><span style={{ color: LIME }}>■</span> mobile · <span style={{ color: WIFI }}>■</span> Wi-Fi · darker: the second device</p>
      </section>

      <section>
        <h3>This cycle, by device</h3>
        {devices.length === 0 && <p className="muted">Nothing counted yet.</p>}
        {devices.map(d => <p key={d.name} style={{ margin: '4px 0' }}><b>{d.name}{d.id === all.me ? ' (this computer)' : ''}</b>: {[d.mobile ? `mobile ${bytes(d.mobile)}` : '', `Wi-Fi ${bytes(d.wifi)}`, d.via ? `over the phone's hotspot ${bytes(d.via)}` : ''].filter(Boolean).join(' · ')}</p>)}
      </section>

      {(hotspot > 0 || clients.length > 0) && <section>
        <h3>The phone's hotspot: {bytes(hotspot)}</h3>
        {[...clients.map(c => [c.name, c.via] as const), ['Difference', hotspot - clients.reduce((s, c) => s + c.via, 0)] as const].map(([who, b], i) =>
          <p key={who} style={{ margin: '4px 0' }}>{who}{i === 0 && who !== 'Difference' ? ' · the most' : ''}: {bytes(Math.max(0, b))}{b < 0 ? ` (−${bytes(-b)})` : ''} · {hotspot ? Math.round((b * 100) / hotspot) : 0} %</p>)}
        <p className="muted">The phone counts all its hotspot carried; the tablet and this computer each count what they used over it. The difference: another device on the hotspot, hours they were off or not counting, and the network's own overheads.</p>
      </section>}

      <section>
        <h3>This computer's Wi-Fi now</h3>
        {wifi?.rssi !== undefined ? <p style={{ margin: 0 }}><b style={{ fontSize: 28 }}>{wifi.rssi} dBm</b> · {quality(wifi.rssi)} · {wifi.speed} Mb/s · {wifi.ssid} · {wifi.mhz && wifi.mhz >= 4900 ? '5 GHz' : '2.4 GHz'}</p> : <p className="muted">{wifi?.error ?? 'Reading…'}</p>}
      </section>

      <section>
        <h3>Drops</h3>
        {drops.length === 0 && <p className="muted">None recorded yet.</p>}
        {drops.map((e, i) => <p key={i} style={{ margin: '2px 0' }}>{new Date(e.at!).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {e.device} · {DROPS[e.event!]} {e.secs ? `${e.secs >= 60 ? `${Math.floor(e.secs / 60)} min ` : ''}${e.secs % 60} s` : ''}{e.note ? ` (${e.note})` : ''}</p>)}
      </section>
    </main>
  )
}
