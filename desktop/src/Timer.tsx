import { useEffect, useRef, useState } from 'react'
import type { TimerAction, TimerItem } from './drive'
import { ClockFace } from './Calendar'
import { errorText } from './Dialogs'
import { Icon } from './Icon'

// The phone's Timer (Drive-Android TimerScreen.kt): the Calendar's clock picks hours and minutes, the recently used and
// pinned times under it, the running ones on top. Each device counts by itself from the timer's file (timer.js).

/** "5 min", "1 h 30 min", "45 s" (timer.js durationText). */
export function durationText(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return [h && `${h} h`, m && `${m} min`, (s || !seconds) && `${s} s`].filter(Boolean).join(' ')
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
      <button className={`round flat timer-pin ${t.pinned ? 'on' : ''}`} title={t.pinned ? 'Unpin' : 'Pin: keep this timer'} onClick={() => act(t.id, t.pinned ? 'unpin' : 'pin')}><Icon name="pin" size={18} /></button>
      <button className="round flat timer-trash" title="Delete" onClick={() => act(t.id, 'trash')}><Icon name="trash" size={18} /></button>
      <div className="timer-left">{t.ringing ? "Time's up" : clockText(t.ready ? t.seconds * 1000 : t.leftMs)}</div>
      <div className="timer-name">{t.label || durationText(t.seconds)}{t.state === 'paused' ? ' · paused' : ''}</div>
      <div className="timer-buttons">
        {t.ringing ? <button className="filled-button" onClick={() => act(t.id, 'ok')}>OK</button>
          : t.ready ? <button className="filled-button" onClick={() => act(t.id, 'restart')}><Icon name="play" size={18} /> Start</button> : <>
          {t.state === 'paused'
            ? <button className="filled-button" onClick={() => act(t.id, 'resume')}><Icon name="play" size={18} /> Resume</button>
            : <button className="filled-button" onClick={() => act(t.id, 'pause')}><Icon name="pause" size={18} /> Pause</button>}
          <button className="outline-button" onClick={() => act(t.id, 'stop')}><Icon name="close" size={18} /> Stop</button>
        </>}
      </div>
    </div>
  )
}

export function TimerPage({ say }: { say: (text: string) => void }) {
  const timers = useTimers()
  const [h, setH] = useState(0)
  const [m, setM] = useState(5)
  const [drawer, setDrawer] = useState(false)
  // the clock opens on the length last started here
  useEffect(() => { window.drive.timer.last().then(s => { if (s) { setH(Math.min(23, Math.floor(s / 3600))); setM(Math.floor(s % 3600 / 60)) } }) }, [])
  const chosen = h * 3600 + m * 60
  const start = (s: number) => s > 0 && window.drive.timer.start(s).catch(e => say('Not started: ' + errorText(e)))
  const act = (id: string, a: TimerAction) => window.drive.timer.change(id, a).catch(e => say(errorText(e)))
  // the user, 18 Oct: "a clock with hands and the timer with play pause stop" — the clock, and the cards beside it
  return (
    <div className="timer">
      <header className="topbar"><div className="island title-island"><Icon name="timer" /><h1>Timer</h1></div></header>
      <div className="timer-body">
        <section className="timer-main">
          <div className="cal-clock timer-clock">
            <p className="muted">Hours and minutes</p>
            <ClockFace h={h} m={m} setH={setH} setM={setM} />
            <button className="filled-button timer-start" disabled={!chosen} onClick={() => start(chosen)}><Icon name="play" size={20} /> Start {chosen ? durationText(chosen) : ''}</button>
          </div>
        </section>
        {/* the user, 18 Oct: small cards, three to a row, fewer as the window narrows; nine at most */}
        <section className="timer-cards">
          {timers.map(t => <TimerCard key={t.id} t={t} act={act} />)}
          {!timers.length && <p className="muted">Pick a length on the clock and Start. Pin a timer to keep it here, ready to start again.</p>}
        </section>
      </div>
      <div className={`notes-drawer island ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <p>A timer runs on every device you sync with: started, paused or stopped on one, it is on all of them at once, and OK on one stops the alarm everywhere. A pinned one stays, ready to start again. Each is a small file in Tetra/Files/Timer, so Claude can start one too.</p>
      </div>
      {/* Tetra's island at the bottom, Start in it; the handle opens the drawer */}
      <div className="notes-dock">
        <button className="notes-handle" title={drawer ? 'Close' : 'More'} onClick={() => setDrawer(d => !d)}><span /></button>
        <nav className="notes-island island">
          <button className="island-item on"><Icon name="timer" size={20} /><span>Timer</span></button>
          <span className="island-gap" />
          <button className="island-item" disabled={!chosen} onClick={() => start(chosen)}><Icon name="play" size={20} /><span>Start</span></button>
        </nav>
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
      <Icon name="timer" /><b>Time's up</b><span>{ringing.map(t => t.label || durationText(t.seconds)).join(', ')}</span>
      <button className="filled-button" onClick={() => ringing.forEach(t => window.drive.timer.change(t.id, 'ok'))}>OK</button>
    </div>
  )
}
