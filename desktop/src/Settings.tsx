import { useEffect, useState } from 'react'
import type { AppNotification } from './drive'
import { Icon } from './Icon'
import { locale, t } from './i18n'
import { ResetCard } from './Role'
import { MapsCard } from './MapBuilder'

// The foot of the sidebar (asked 2026-09-26): what Tetra said, kept — a notification goes by in seconds — and Settings.

export function NotificationsPage() {
  const [list, setList] = useState<AppNotification[] | null>(null)
  const load = () => window.drive.notifications.list().then(l => { setList(l); window.drive.notifications.read() })
  useEffect(() => { load(); return window.drive.notifications.onChange(load) }, [])
  const day = (at: number) => new Date(at).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1>{t('app.notifications')}</h1>
        {!!list?.length && <button className="text-button" onClick={() => window.drive.notifications.clear().then(load)}>{t('notifications.clearAll')}</button>}
      </header>
      {list?.length === 0 && <div className="empty"><p>{t('notifications.empty')}</p></div>}
      <div className="notice-list">
        {list?.map((n, i) => <div key={n.id}>
          {(i === 0 || day(list[i - 1].at) !== day(n.at)) && <h4 className="notice-day">{day(n.at)}</h4>}
          <div className={`notice island ${n.read ? '' : 'unread'}`}>
            <Icon name="bell" size={20} />
            <div><strong>{n.title}</strong>{n.body && <p>{n.body}</p>}</div>
            <small>{new Date(n.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</small>
          </div>
        </div>)}
      </div>
    </div>
  )
}

export function SettingsPage({ onGuide }: { onGuide: () => void }) {
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
      <header className="page-head"><h1>{t('app.settings')}</h1></header>
      <section className="settings-card island">
        <h3><Icon name="info" size={20} />{t('guide.title')}</h3>
        <p className="muted">{t('guide.note')}</p>
        <button className="filled-button secondary" onClick={onGuide}>{t('guide.open')}</button>
      </section>
      <section className="settings-card island">
        <h3>{t('settings.appearance')}</h3>
        <div className="segmented">
          {([['system', 'settings.themeAuto'], ['light', 'settings.themeLight'], ['dark', 'settings.themeDark']] as const).map(([id, name]) =>
            <button key={id} className={theme === id ? 'on' : ''} onClick={() => pick(id)}>{t(name)}</button>)}
        </div>
        <p className="muted">{t('settings.themeAutoNote')}</p>
      </section>
      <LanguageCard />
      <CallsCard />
      <section className="settings-card island">
        <h3><span className="cat photos"><Icon name="photos" size={20} /></span>{t('settings.motionPhotos')}</h3>
        <div className="segmented">
          {([['one', 'settings.motionAsOne'], ['remove', 'settings.motionRemove']] as const).map(([id, name]) =>
            <button key={id} className={motion === id ? 'on' : ''} onClick={() => pickMotion(id)}>{t(name)}</button>)}
        </div>
        <p className="muted">{motion === 'remove'
          ? t('settings.motionRemoveNote')
          : t('settings.motionAsOneNote')}</p>
        <h4>{t('settings.motionAutoplay')}</h4>
        <div className="segmented">
          {([[false, 'common.off'], [true, 'common.on']] as const).map(([on, name]) =>
            <button key={name} className={autoplay === on ? 'on' : ''} onClick={() => pickAutoplay(on)}>{t(name)}</button>)}
        </div>
        <p className="muted">{autoplay ? t('settings.motionAutoplayOn') : t('settings.motionAutoplayOff')}</p>
      </section>
      <MapsCard />
      <LocationCard />
      <ResetCard />
    </div>
  )
}

/**
 * Settings › Location (the user, 26 Oct: "PCs and laptops in general don't move much"): how long Maps keeps using the
 * phone's last fix before asking it again. Off, by default: until Where I am is pressed.
 */
function LocationCard() {
  const [every, setEvery] = useState<'off' | '30m' | '1d' | '1w' | null>(null)
  useEffect(() => { window.drive.locationEvery().then(setEvery) }, [])
  const pick = (v: 'off' | '30m' | '1d' | '1w') => { setEvery(v); window.drive.setLocationEvery(v) }
  return (
    <section className="settings-card island">
      <h3><Icon name="myLocation" size={20} />{t('settings.location')}</h3>
      <h4>{t('settings.locationEvery')}</h4>
      <div className="segmented">
        {([['off', 'settings.locationOff'], ['30m', 'settings.every30m'], ['1d', 'settings.everyDay'], ['1w', 'settings.everyWeek']] as const).map(([id, name]) =>
          <button key={id} className={every === id ? 'on' : ''} onClick={() => pick(id)}>{t(name)}</button>)}
      </div>
      <p className="muted">{t('settings.locationNote')}</p>
    </section>
  )
}

/**
 * Settings › Language (the user, 25 Oct): System default, then every language there is a file for in locales/, each
 * by its own name. Kept with the other settings (main: settings table, "language"); the page reloads to show it, and
 * comes back here.
 */
function LanguageCard() {
  const [now, setNow] = useState<{ choice: string; system: string; languages: string[] } | null>(null)
  useEffect(() => { window.drive.languages().then(setNow) }, [])
  const own = (tag: string) => { const n = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; return n.charAt(0).toLocaleUpperCase(tag) + n.slice(1) }
  const pick = async (choice: string) => {
    if (choice === now?.choice) return
    await window.drive.setLanguage(choice)
    try { sessionStorage.setItem('reopen', 'settings') } catch {}
    location.reload()
  }
  return (
    <section className="settings-card island">
      <h3>{t('settings.language')}</h3>
      {/* a list, not buttons: every EU language is too many for one row */}
      {now && <select className="field" value={now.choice} onChange={e => pick(e.target.value)}>
        {['system', ...now.languages].map(id => <option key={id} value={id}>{id === 'system' ? `${t('settings.languageSystem')} (${own(now.system)})` : own(id)}</option>)}
      </select>}
      <p className="muted">{t('settings.languageNote')}</p>
    </section>
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
      <h3><Icon name="call" size={20} />{t('settings.calls')}</h3>
      <p><strong>{bt === null ? t('settings.btLooking') : on ? t('settings.btConnected', { name: on.name }) : bt.phones.length ? t('settings.btPaired') : t('settings.btNone')}</strong></p>
      <p className="muted">{on ? t('settings.callSoundHere') : t('settings.callSoundPhone')}</p>
      {bt?.phones.filter(p => !p.connected).map(p => <button key={p.mac} className="filled-button secondary" onClick={() => { setSaid(t('settings.btConnecting')); window.drive.callsConnect(p.mac).then(() => { setSaid(''); load() }, e => setSaid(String(e.message ?? e).replace(/^.*?Error: /, ''))) }}>{t('settings.btConnect', { name: p.name })}</button>)}
      {!on && <>
        <p className="muted">{t('settings.btHowTo')}</p>
        <button className="text-button" onClick={() => window.drive.callsSystemBluetooth()}>{t('settings.btOpenSettings')}</button>
      </>}
      {said && <p className="muted">{said}</p>}
      {bt && !bt.available && <p className="muted">{t('settings.btMissing')}</p>}
    </section>
  )
}
