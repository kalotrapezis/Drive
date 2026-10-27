import { useEffect, useState } from 'react'
import type { AppNotification, CleanItem } from './drive'
import { Icon, type IconName } from './Icon'
import { locale, t } from './i18n'
import { ResetCard } from './Role'
import { MapsCard } from './MapBuilder'
import { formatBytes } from './timeline'
import { errorText } from './Dialogs'

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

/** Settings' pages, as the phone's (SettingsScreen.SettingsPage): the general ones, then one an app in its colour. */
type SettingsTab = 'appearance' | 'computer' | 'cleanUp' | 'photos' | 'maps' | 'phone'
const GENERAL: { id: SettingsTab; icon: IconName; title: string; summary: string }[] = [
  { id: 'appearance', icon: 'palette', title: 'settings.appearance', summary: 'settings.sum.appearance' },
  { id: 'computer', icon: 'server', title: 'reset.title', summary: 'settings.sum.computer' },
  { id: 'cleanUp', icon: 'storage', title: 'clean.title', summary: 'settings.sum.cleanUp' },
]
const APPS: { id: SettingsTab; icon: IconName; cat: string; title: string; summary: string }[] = [
  { id: 'photos', icon: 'photos', cat: 'photos', title: 'app.photos', summary: 'settings.sum.photos' },
  { id: 'maps', icon: 'map', cat: 'maps', title: 'app.maps', summary: 'settings.sum.maps' },
  { id: 'phone', icon: 'call', cat: 'phone', title: 'app.phone', summary: 'settings.sum.phone' },
]
const TABS: SettingsTab[] = [...GENERAL, ...APPS].map(x => x.id)

/**
 * Settings (the user, 27 Oct: "it needs a bit restructuring, some elements overflow, and the Android now has a dual pane
 * view with categories and colours"): the pages on the left — the Guide, General, then each app with its colour, as on
 * the phone — and the page chosen on the right; one column in a narrow window.
 */
/** [start]: the page a notification opens (an old map: 'maps'). */
export function SettingsPage({ onGuide, start }: { onGuide: () => void; start?: string }) {
  const [tab, setTab] = useState<SettingsTab>(() => {
    if (TABS.includes(start as SettingsTab)) return start as SettingsTab
    try { const v = localStorage.getItem('settingsTab') as SettingsTab; return TABS.includes(v) ? v : 'appearance' } catch { return 'appearance' }
  })
  // a narrow window shows the list or the page, as the phone does (the user, 27 Oct: "add the back button … a two-page thing")
  const [picked, setPicked] = useState(!!start)
  const open = (id: SettingsTab) => { setTab(id); setPicked(true); try { localStorage.setItem('settingsTab', id) } catch {} }
  const row = (x: { id: SettingsTab; icon: IconName; cat?: string; title: string; summary: string }) =>
    <button key={x.id} className={`settings-row ${tab === x.id ? 'on' : ''}`} onClick={() => open(x.id)}>
      <span className={`settings-icon ${x.cat ?? ''}`}><Icon name={x.icon} size={20} /></span>
      <span><strong>{t(x.title)}</strong><small>{t(x.summary)}</small></span>
    </button>
  return (
    <div className="page-scroll">
      <header className="page-head"><h1>{t('app.settings')}</h1></header>
      <div className={`settings-split ${picked ? 'picked' : ''}`}>
        <nav className="settings-nav">
          <button className="settings-row" onClick={onGuide}>
            <span className="settings-icon"><Icon name="info" size={20} /></span>
            <span><strong>{t('guide.title')}</strong><small>{t('settings.sum.guide')}</small></span>
          </button>
          <h4>{t('settings.general')}</h4>
          {GENERAL.map(row)}
          <h4>{t('settings.apps')}</h4>
          {APPS.map(row)}
        </nav>
        <div className="settings-pane">
          <button className="text-button settings-back" onClick={() => setPicked(false)}><Icon name="back" size={20} />{t('common.back')}</button>
          {tab === 'appearance' && <><ThemeCard /><LanguageCard /></>}
          {tab === 'computer' && <ResetCard />}
          {tab === 'cleanUp' && <CleanCard />}
          {tab === 'photos' && <MotionCard />}
          {tab === 'maps' && <><MapsCard /><LocationCard /></>}
          {tab === 'phone' && <CallsCard />}
        </div>
      </div>
    </div>
  )
}

function ThemeCard() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | null>(null)
  useEffect(() => { window.drive.theme().then(setTheme) }, [])
  const pick = (t: 'system' | 'light' | 'dark') => { setTheme(t); window.drive.setTheme(t) }
  return (
    <section className="settings-card island">
      <h3>{t('settings.appearance')}</h3>
      <div className="segmented">
        {([['system', 'settings.themeAuto'], ['light', 'settings.themeLight'], ['dark', 'settings.themeDark']] as const).map(([id, name]) =>
          <button key={id} className={theme === id ? 'on' : ''} onClick={() => pick(id)}>{t(name)}</button>)}
      </div>
      <p className="muted">{t('settings.themeAutoNote')}</p>
    </section>
  )
}

function MotionCard() {
  const [motion, setMotion] = useState<'one' | 'remove' | null>(null)
  useEffect(() => { window.drive.motionSetting().then(setMotion) }, [])
  const pickMotion = (v: 'one' | 'remove') => { setMotion(v); window.drive.setMotionSetting(v) }
  const [autoplay, setAutoplay] = useState(false)
  useEffect(() => { window.drive.motionAutoplay().then(setAutoplay) }, [])
  const pickAutoplay = (on: boolean) => { setAutoplay(on); window.drive.setMotionAutoplay(on) }
  return (
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

/** The app names Tetra has words for; .System's other folders (Office, Sync, Backups) show as they are named on disk. */
const APP_WORDS: Record<string, string> = { Photos: 'app.photos', Files: 'app.files', Notes: 'app.notes', Calendar: 'app.calendar', Timer: 'app.timer', Contacts: 'app.contacts', Phone: 'app.phone', Maps: 'app.maps' }

/**
 * Settings › Clean up (the user, 27 Oct: "Tetra should have a cleaner"; cleaner.js): each thing Tetra made for itself and
 * no longer needs, its size now and its own Clean, then what runs by itself and when it last did.
 */
function CleanCard() {
  const [now, setNow] = useState<Awaited<ReturnType<typeof window.drive.cleaner.items>> | null>(null)
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')
  const load = () => window.drive.cleaner.items().then(setNow, e => setSaid(errorText(e)))
  useEffect(() => { load() }, [])
  const clean = async (id: string) => {
    setBusy(id); setSaid('')
    try { await window.drive.cleaner.clean(id) } catch (e) { setSaid(errorText(e)) }
    setBusy(''); load()
  }
  const name = (i: CleanItem) => i.app ? t('clean.system', { app: APP_WORDS[i.app] ? t(APP_WORDS[i.app]) : i.app }) : t(`clean.${i.id}`)
  const note = (i: CleanItem) => !i.ready ? t('clean.thumbsWait') : t(i.app ? 'clean.systemNote' : `clean.${i.id}Note`)
  const when = (at?: number) => at ? new Date(at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('clean.never')
  const any = now?.items.some(i => i.ready && i.files)
  return (
    <section className="settings-card island">
      <h3><Icon name="storage" size={20} />{t('clean.title')}</h3>
      <p className="muted">{t('clean.intro')}</p>
      <div className="clean-list">
        {now?.items.map(i => <div key={i.id} className="clean-row">
          <span><strong>{name(i)}</strong><small>{note(i)}</small></span>
          <span className="clean-size">{i.files ? formatBytes(i.bytes) : t('clean.nothing')}</span>
          <button className="text-button" disabled={!i.ready || !i.files || !!busy} onClick={() => clean(i.id)}>{busy === i.id ? '…' : t('clean.clean')}</button>
        </div>)}
      </div>
      <div className="reset-actions"><button className="filled-button secondary" disabled={!any || !!busy} onClick={() => clean('all')}>{busy === 'all' ? '…' : t('clean.cleanAll')}</button></div>
      {said && <p className="muted">{said}</p>}
      <h4>{t('clean.byItself')}</h4>
      <p className="muted">{t('clean.lastStart', { when: when(now?.last.start) })}<br />{t('clean.lastBuild', { when: when(now?.last.build) })}<br />
        {t('clean.lastHistory', { when: when(now?.last.history) })}<br />{t('clean.lastManual', { when: when(now?.last.manual) })}</p>
    </section>
  )
}
