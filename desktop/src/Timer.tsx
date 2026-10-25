import { useEffect, useRef, useState } from 'react'
import type { TimerAction, TimerItem } from './drive'
import { ClockFace } from './Calendar'
import { errorText } from './Dialogs'
import { Icon } from './Icon'
import { t as tr } from './i18n'

// The phone's Timer (Drive-Android TimerScreen.kt): the Calendar's clock picks hours and minutes, the recently used and
// pinned times under it, the running ones on top. Each device counts by itself from the timer's file (timer.js).

/** "5 min", "1 h 30 min", "45 s" (timer.js durationText). */
export function durationText(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return [h && tr('timer.h', { n: h }), m && tr('timer.min', { n: m }), (s || !seconds) && tr('timer.s', { n: s })].filter(Boolean).join(' ')
}
/** "4:05", "1:02:00", rounded up so 0:00 is the end. */
export function clockText(ms: number) {
  const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** The running timers, read again at each change and twice a second while any runs; the time left by this clock. */
export function useTimers() {
  const [list, setList] = useState<TimerItem[]>([])
  const [, tick] = useState(0)
  const read = () => window.drive.timer.active().then(setList, () => {})
  useEffect(() => { read(); return window.drive.onTimerChanged(read) }, [])
  useEffect(() => {
    if (!list.length) { const t = setInterval(read, 30_000); return () => clearInterval(t) } // the 30 s look, idle
    const t = setInterval(() => { tick(n => n + 1); read() }, 500)
    return () => clearInterval(t)
  }, [list.length])
  return list
}

/** A timer's card: the pin (top left) keeps it when stopped or done, ready to start again; the trash (top right) takes it away. */
function TimerCard({ t, act }: { t: TimerItem; act: (id: string, a: TimerAction) => void }) {
  return (
    <div className={`timer-card island ${t.ringing ? 'ringing' : ''}`}>
      <button className={`round flat timer-pin ${t.pinned ? 'on' : ''}`} title={t.pinned ? tr('timer.unpin') : tr('timer.pinKeep')} onClick={() => act(t.id, t.pinned ? 'unpin' : 'pin')}><Icon name="pin" size={18} /></button>
      <button className="round flat timer-trash" title={tr('common.delete')} onClick={() => act(t.id, 'trash')}><Icon name="trash" size={18} /></button>
      <div className="timer-left">{t.ringing ? tr('timer.timesUp') : clockText(t.ready ? t.seconds * 1000 : t.leftMs)}</div>
      <div className="timer-name">{t.label || durationText(t.seconds)}{t.state === 'paused' ? tr('timer.pausedSuffix') : ''}</div>
      <div className="timer-buttons">
        {t.ringing ? <button className="filled-button" onClick={() => act(t.id, 'ok')}>{tr('common.ok')}</button>
          : t.ready ? <button className="filled-button" onClick={() => act(t.id, 'restart')}><Icon name="play" size={18} /> {tr('common.start')}</button> : <>
          {t.state === 'paused'
            ? <button className="filled-button" onClick={() => act(t.id, 'resume')}><Icon name="play" size={18} /> {tr('common.resume')}</button>
            : <button className="filled-button" onClick={() => act(t.id, 'pause')}><Icon name="pause" size={18} /> {tr('common.pause')}</button>}
          <button className="outline-button" onClick={() => act(t.id, 'stop')}><Icon name="close" size={18} /> {tr('common.stop')}</button>
        </>}
      </div>
    </div>
  )
}

export function TimerPage({ say }: { say: (text: string) => void }) {
  const timers = useTimers()
  const [h, setH] = useState(0)
  const [m, setM] = useState(5)
  const [lastId, setLastId] = useState<string | null>(null)
  // the clock opens on the length last started here
  useEffect(() => { window.drive.timer.last().then(s => { if (s) { setH(Math.min(23, Math.floor(s / 3600))); setM(Math.floor(s % 3600 / 60)) } }) }, [])
  // the user, 18 Oct: "play is not needed as soon as I set a timer starts" — the minute let go (or Enter) starts it
  const start = (hh: number, mm: number) => { const s = hh * 3600 + mm * 60; if (s > 0) window.drive.timer.start(s).then(setLastId, e => say(tr('timer.notStarted', { error: errorText(e) }))) }
  const act = (id: string, a: TimerAction) => window.drive.timer.change(id, a).catch(e => say(errorText(e)))
  // Pause and Stop under the clock: the timer last started here, else the one ending first
  const live = timers.filter(t => !t.ready && !t.ringing)
  const current = live.find(t => t.id === lastId) ?? live[0]
  // the user's sketch, 18 Oct: the clock, HH and MM under it, Pause and Stop under those; the timers' cards beside, no island
  return (
    <div className="timer">
      <header className="topbar">
        <div className="island title-island"><Icon name="timer" /><h1>{tr('app.timer')}</h1></div>
        {/* the user, 19 Oct: its own settings at the top right, as the Calendar's */}
        <div className="tools">
          <details className="menu">
            <summary className="round" title={tr('timer.settings')}><Icon name="tune" /></summary>
            <div className="island menu-body cal-settings">
              <h4 className="cal-share-head">{tr('calendar.shareClaude')}</h4>
              <p className="muted">{tr('timer.shareClaudeNote')}</p>
              <div className="cal-two">
                <button className="text-button" onClick={() => window.drive.skillSave('tetra-timer').then(p => p && say(tr('calendar.savedTo', { path: p })), e => say(tr('calendar.notSaved', { error: errorText(e) })))}>{tr('calendar.saveAs')}</button>
                <button className="text-button" onClick={() => window.drive.skillInstall('tetra-timer').then(p => say(tr('calendar.installedIn', { path: p })), e => say(tr('calendar.notInstalled', { error: errorText(e) })))}>{tr('calendar.copyToSkills')}</button>
              </div>
            </div>
          </details>
        </div>
      </header>
      <div className="timer-body">
        <section className="timer-main">
          <div className="cal-clock timer-clock">
            <ClockFace h={h} m={m} setH={setH} setM={setM} below onDone={start} />
            <div className="timer-controls">
              {current?.state === 'paused'
                ? <button className="filled-button" onClick={() => act(current.id, 'resume')}><Icon name="play" size={18} /> {tr('common.resume')}</button>
                : <button className="filled-button" disabled={!current} onClick={() => current && act(current.id, 'pause')}><Icon name="pause" size={18} /> {tr('common.pause')}</button>}
              <button className="outline-button" disabled={!current} onClick={() => current && act(current.id, 'stop')}><Icon name="close" size={18} /> {tr('common.stop')}</button>
            </div>
          </div>
        </section>
        <section className="timer-cards">
          {timers.map(t => <TimerCard key={t.id} t={t} act={act} />)}
          {!timers.length && <p className="muted">{tr('timer.empty')}</p>}
        </section>
      </div>
    </div>
  )
}

/**
 * The alarm, on whichever page is open (and with the window in the tray): a ringing timer beeps until OK here, or until
 * OK or Stop on any other device reaches this one — a push at once, or the 30 s look at the latest.
 */
export function TimerBell() {
  const timers = useTimers()
  const ringing = timers.filter(t => t.ringing)
  const audio = useRef<AudioContext | null>(null)
  useEffect(() => {
    if (!ringing.length) return
    const ctx = audio.current ??= new AudioContext()
    const beep = () => [0, 0.25, 0.5].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = 880; g.gain.setValueAtTime(0.25, ctx.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.2)
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.2)
    })
    beep()
    const t = setInterval(beep, 1500)
    return () => clearInterval(t)
  }, [ringing.length])
  if (!ringing.length) return null
  return (
    <div className="timer-bell island" role="alert">
      <Icon name="timer" /><b>{tr('timer.timesUp')}</b><span>{ringing.map(t => t.label || durationText(t.seconds)).join(', ')}</span>
      <button className="filled-button" onClick={() => ringing.forEach(t => window.drive.timer.change(t.id, 'ok'))}>{tr('common.ok')}</button>
    </div>
  )
}
