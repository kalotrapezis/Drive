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
    </div>
  )
}
