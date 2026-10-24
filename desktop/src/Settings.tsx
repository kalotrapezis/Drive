import { useEffect, useState } from 'react'
import type { AppNotification } from './drive'
import { Icon } from './Icon'

// The foot of the sidebar (asked 2026-09-26): what Tetra said, kept — a notification goes by in seconds — and Settings.

export function NotificationsPage() {
  const [list, setList] = useState<AppNotification[] | null>(null)
  const load = () => window.drive.notifications.list().then(l => { setList(l); window.drive.notifications.read() })
  useEffect(() => { load(); return window.drive.notifications.onChange(load) }, [])
  const day = (at: number) => new Date(at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1>Notifications</h1>
        {!!list?.length && <button className="text-button" onClick={() => window.drive.notifications.clear().then(load)}>Clear all</button>}
      </header>
      {list?.length === 0 && <div className="empty"><p>Nothing yet. What Tetra tells you — space freed, a disk filling up, a drive backed up — is kept here.</p></div>}
      <div className="notice-list">
        {list?.map((n, i) => <div key={n.id}>
          {(i === 0 || day(list[i - 1].at) !== day(n.at)) && <h4 className="notice-day">{day(n.at)}</h4>}
          <div className={`notice island ${n.read ? '' : 'unread'}`}>
            <Icon name="bell" size={20} />
            <div><strong>{n.title}</strong>{n.body && <p>{n.body}</p>}</div>
            <small>{new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
          </div>
        </div>)}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | null>(null)
  useEffect(() => { window.drive.theme().then(setTheme) }, [])
  const pick = (t: 'system' | 'light' | 'dark') => { setTheme(t); window.drive.setTheme(t) }
  const [motion, setMotion] = useState<'one' | 'remove' | null>(null)
  useEffect(() => { window.drive.motionSetting().then(setMotion) }, [])
  const pickMotion = (v: 'one' | 'remove') => { setMotion(v); window.drive.setMotionSetting(v) }
  const [autoplay, setAutoplay] = useState(false)
  useEffect(() => { window.drive.motionAutoplay().then(setAutoplay) }, [])
  const pickAutoplay = (on: boolean) => { setAutoplay(on); window.drive.setMotionAutoplay(on) }
  return (
    <div className="page-scroll">
      <header className="page-head"><h1>Settings</h1></header>
      <section className="settings-card island">
        <h3>Appearance</h3>
        <div className="segmented">
          {([['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([id, name]) =>
            <button key={id} className={theme === id ? 'on' : ''} onClick={() => pick(id)}>{name}</button>)}
        </div>
        <p className="muted">Auto follows the system's light or dark setting.</p>
      </section>
      <CallsCard />
      <section className="settings-card island">
        <h3><span className="cat photos"><Icon name="photos" size={20} /></span>Motion photos</h3>
        <div className="segmented">
          {([['one', 'Show as one'], ['remove', 'Remove on import']] as const).map(([id, name]) =>
            <button key={id} className={motion === id ? 'on' : ''} onClick={() => pickMotion(id)}>{name}</button>)}
        </div>
        <p className="muted">{motion === 'remove'
          ? 'An import leaves out the few seconds of video beside a picture (MVIMG_….MP4 next to MVIMG_….jpg). The picture comes in on its own.'
          : 'A picture and its few seconds of video show as one photo; the Motion button in the viewer plays them. Pictures with the video inside (Pixel, Samsung) play too.'}</p>
        <h4>Autoplay motion photos</h4>
        <div className="segmented">
          {([[false, 'Off'], [true, 'On']] as const).map(([on, name]) =>
            <button key={name} className={autoplay === on ? 'on' : ''} onClick={() => pickAutoplay(on)}>{name}</button>)}
        </div>
        <p className="muted">{autoplay ? 'A motion photo plays its few seconds as soon as it opens.' : 'Motion photos open still; the Motion button plays them.'}</p>
      </section>
    </div>
  )
}

/**
 * Settings › Calls (the user, 24 Oct: "how do I know the PC and phone are connected by Bluetooth?"): a call is placed and
 * answered by the phone; its sound is on this computer only while the phone is connected to it by Bluetooth as a
 * hands-free kit — paired in the system's Bluetooth settings, "Phone calls" allowed for this computer on the phone.
 */
function CallsCard() {
  const [bt, setBt] = useState<Awaited<ReturnType<typeof window.drive.callsBluetooth>> | null>(null)
  const [said, setSaid] = useState('')
  const load = () => window.drive.callsBluetooth().then(setBt)
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t) }, [])
  const on = bt?.phones.find(p => p.connected)
  return (
    <section className="settings-card island">
      <h3><Icon name="call" size={20} />Calls</h3>
      <p><strong>{bt === null ? 'Looking at Bluetooth…' : on ? `Connected for calls: ${on.name}` : bt.phones.length ? 'Paired, not connected' : 'No phone paired by Bluetooth'}</strong></p>
      <p className="muted">{on ? "A call's sound is on this computer: its speakers and microphone." : "A call's sound stays on the phone. Call, Answer and End in Contacts and the call bubble work either way."}</p>
      {bt?.phones.filter(p => !p.connected).map(p => <button key={p.mac} className="filled-button secondary" onClick={() => { setSaid('Connecting…'); window.drive.callsConnect(p.mac).then(() => { setSaid(''); load() }, e => setSaid(String(e.message ?? e).replace(/^.*?Error: /, ''))) }}>Connect {p.name}</button>)}
      {!on && <>
        <p className="muted">To hear calls here: pair the phone with this computer in the system's Bluetooth settings, then on the phone open Bluetooth › this computer › and allow "Phone calls". Tetra then shows it connected here, and says so when it connects or drops.</p>
        <button className="text-button" onClick={() => window.drive.callsSystemBluetooth()}>Open Bluetooth settings</button>
      </>}
      {said && <p className="muted">{said}</p>}
      {bt && !bt.available && <p className="muted">bluetoothctl is not installed, so Tetra cannot see Bluetooth here.</p>}
    </section>
  )
}
