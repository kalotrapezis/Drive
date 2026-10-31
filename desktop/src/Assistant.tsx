import { useEffect, useRef, useState } from 'react'
import type { AssistCall, AssistChoice, AssistGo, AssistSend, AssistSettings } from './drive'
import { Icon } from './Icon'
import { t } from './i18n'
import { errorText } from './Dialogs'
import { FRAME, RATE, Vad, clock, money, yesNo } from './assist'

// AI Assist (the phone's AssistantScreen.kt, ported; assistant.js has the why): the chat, walkie-talkie on the mic button,
// live on the waveform one. Mistral and Tetra's tools run in main; the microphone, the voice and the record here.

type Bubble = { mine: boolean; text: string; choices?: AssistChoice[]; call?: AssistCall | null; send?: AssistSend | null; images?: string[]; error?: boolean }
type Phase = 'idle' | 'listening' | 'thinking'
type LivePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopping'
const TURN: Record<LivePhase, number> = { connecting: 20, listening: 40, thinking: 90, speaking: 200, stopping: 0 } // the record's degrees a second
const ORANGE = '#FD6A04'
const LIVE_MAX_MS = 5 * 60_000
const LIVE_SILENCE_MS = 20_000

// kept while the page is away (another page, the window closed to the tray): the conversation itself is main's
let kept: Bubble[] = []

/** The microphone at 16 kHz, in 30 ms frames to [each]; answers how to close it. */
async function openMic(each: (f: Int16Array) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const ctx = new AudioContext({ sampleRate: RATE })
  const src = ctx.createMediaStreamSource(stream)
  // shortcut: ScriptProcessor (deprecated, still in Chromium) instead of an AudioWorklet's own file; move when Chromium drops it
  const proc = ctx.createScriptProcessor(2048, 1, 1)
  let rest = new Int16Array(0)
  proc.onaudioprocess = e => {
    const f = e.inputBuffer.getChannelData(0), all = new Int16Array(rest.length + f.length)
    all.set(rest)
    for (let i = 0; i < f.length; i++) all[rest.length + i] = Math.max(-1, Math.min(1, f[i])) * 32767
    let n = 0
    for (; n + FRAME <= all.length; n += FRAME) each(all.slice(n, n + FRAME))
    rest = all.slice(n)
  }
  src.connect(proc); proc.connect(ctx.destination)
  return () => { proc.onaudioprocess = null; proc.disconnect(); src.disconnect(); stream.getTracks().forEach(x => x.stop()); ctx.close().catch(() => {}) }
}

/**
 * Records until the speaker pauses ([pauseMs]), stop.current says so, or nobody spoke for [waitMs]; null when nothing was
 * said. [hold]: push-to-talk, only stop ends it.
 */
function listen(waitMs: number, pauseMs: number, hold: boolean, stop: { current: boolean }, heard: (speaking: boolean) => void): Promise<Int16Array | null> {
  return new Promise((resolve, reject) => {
    const vad = new Vad(Math.round(pauseMs / 30)), started = Date.now()
    let close: (() => void) | null = null, over = false
    const finish = (pcm: Int16Array | null) => { if (over) return; over = true; close?.(); resolve(pcm?.length ? pcm : null) }
    openMic(f => {
      if (over) return
      const done = vad.push(f)
      heard(vad.speaking)
      if ((done && !hold) || stop.current) finish(vad.phrase())
      else if (!hold && !vad.speaking && Date.now() - started > waitMs) finish(null)
    }).then(c => { close = c; if (over) c() }, reject)
  })
}

/** Mistral's voice: 24 kHz pieces played one after the other, as they come. */
class Player {
  private ctx: AudioContext | null = null
  private at = 0
  private playing = new Set<AudioBufferSourceNode>()
  push(pcm: Float32Array) {
    const ctx = this.ctx ??= new AudioContext({ sampleRate: 24000 })
    const b = ctx.createBuffer(1, pcm.length, 24000)
    b.copyToChannel(new Float32Array(pcm), 0)
    const s = ctx.createBufferSource()
    s.buffer = b; s.connect(ctx.destination)
    this.at = Math.max(this.at, ctx.currentTime + 0.05)
    s.start(this.at); this.at += b.duration
    this.playing.add(s); s.onended = () => this.playing.delete(s)
  }
  /** Seconds still to play. */
  left() { return this.ctx ? Math.max(0, this.at - this.ctx.currentTime) : 0 }
  stop() { for (const s of this.playing) try { s.stop() } catch { /* already over */ } this.playing.clear(); this.at = 0 }
}
const player = new Player()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Until what Mistral's voice reads has been heard (the computer's own voice is over when the answer comes: main waits for it). */
async function heardOut() { while (player.left() > 0.05) await sleep(150) }
function hush() { player.stop(); window.drive.assistant.hush() }

export function AssistantPage({ go, command }: { go: (g: AssistGo) => void; command: { what: string; at: number } | null }) {
  const [s, setS] = useState<AssistSettings | null>(null)
  const [bubbles, setBubblesState] = useState<Bubble[]>(kept)
  const setBubbles = (f: (b: Bubble[]) => Bubble[]) => setBubblesState(b => (kept = f(b)))
  const [draft, setDraft] = useState<string | null>(null) // the answer as it comes
  const [phase, setPhase] = useState<Phase>('idle')
  const [hearing, setHearing] = useState(false)
  const [pending, setPending] = useState<AssistCall | null>(null)
  const [pendingMail, setPendingMail] = useState<AssistSend | null>(null) // a mail written, waiting for the user's Send
  const [spent, setSpent] = useState(0)
  const [typed, setTyped] = useState('')
  const [keyText, setKeyText] = useState('')
  const stopNow = useRef(false)
  // live
  const [liveShown, setLiveShown] = useState(false)
  const [livePhase, setLivePhase] = useState<LivePhase>('connecting')
  const [liveYou, setLiveYou] = useState('')
  const [liveAi, setLiveAi] = useState('')
  const [now, setNow] = useState(0)
  const live = useRef<{ close: (() => void) | null; start: number; last: number; muted: boolean; level: number } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // the latest functions for listeners made once
  const fns = useRef({ send: (_: string) => {}, endLive: (_?: string) => {}, mic: () => {}, toggleLive: () => {}, hold: (_: boolean) => {} })

  const load = () => window.drive.assistant.settings().then(x => { setS(x); setSpent(x.spent) })
  useEffect(() => { load() }, [])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [bubbles.length, draft])
  useEffect(() => () => { if (live.current) fns.current.endLive() }, [])

  const say = (text: string, error = false) => setBubbles(b => [...b, { mine: false, text, error }])
  const setPendingCall = (c: AssistCall | null) => { setPending(c) }

  async function call(c: AssistCall) {
    setPendingCall(null)
    endLive()
    const r = await window.drive.contactsCall(c.number, c.name).catch(e => ({ error: errorText(e) }))
    say(r.error ?? t('assistant.calling', { name: c.name }), !!r.error)
  }
  function cancelCall() { setPendingCall(null); say(t('assistant.callCancelled')) }
  async function sendMail(m: AssistSend) {
    setPendingMail(null)
    const error = await window.drive.mail.send(m.draft).then(() => null, e => errorText(e))
    say(error ?? t('assistant.mailSent', { to: m.to }), !!error)
  }
  function keepMail() { setPendingMail(null); say(t('assistant.mailKept')) }
  function choose(c: AssistChoice) {
    if (c.call) call(c.call)
    if (c.open) window.drive.files.open(c.open).catch(() => say(t('assistant.cannotOpen'), true))
    if (c.go) goTo(c.go)
  }
  function goTo(g: AssistGo) { if (g.youtube != null) window.drive.assistant.youtube(g.youtube); else go(g) }

  async function send(text: string) {
    if (!text.trim() || !s) return
    setBubbles(b => [...b, { mine: true, text }])
    const inLive = !!live.current
    if (inLive) { setLiveYou(text); setLiveAi('') }
    // a yes or no to a waiting call is heard by Tetra, never decided by the model
    if (pending) { const yes = yesNo(text); if (yes != null) { if (yes) call(pending); else cancelCall(); if (inLive) listenAgain(); return } }
    // and to a mail waiting to be sent, the same way
    // (a short yes only: "ναι, αλλά άλλαξε το θέμα" goes to the model, which writes it again)
    if (pendingMail) { const yes = text.trim().split(/\s+/).length <= 3 ? yesNo(text) : null; if (yes != null) { if (yes) sendMail(pendingMail); else keepMail(); if (inLive) listenAgain(); return } }
    setPhase('thinking')
    if (inLive) { live.current!.muted = true; window.drive.assistant.liveMute(true); setLivePhase('thinking') }
    hush()
    setDraft('')
    const offWords = window.drive.assistant.onWords(w => { setDraft(d => (d ?? '') + w); if (inLive) setLiveAi(a => a + w) })
    try {
      const r = await window.drive.assistant.ask(text, s.aloud || inLive)
      setBubbles(b => [...b, { mine: false, text: r.text, choices: r.choices, call: r.call, send: r.send, images: r.images }])
      setPendingCall(r.call)
      setPendingMail(r.send)
      if (inLive && r.text) setLiveAi(r.text)
      setSpent(r.spent)
      if (r.open) window.drive.files.open(r.open).catch(() => say(t('assistant.cannotOpen'), true))
      await heardOut()
      // Maps, a note, YouTube: once the answer is said, there (live ends: it is paid by the minute)
      if (r.go) { if (live.current) endLive(); goTo(r.go) }
    } catch (e) { say(errorText(e), true) }
    finally { offWords(); setDraft(null); setPhase('idle'); listenAgain() }
  }
  function listenAgain() {
    const l = live.current
    if (!l) return
    l.muted = false; l.last = Date.now(); window.drive.assistant.liveMute(false); setLivePhase('listening')
  }

  async function hear(waitMs: number, hold = false) {
    if (!s?.hasKey || phase !== 'idle' || live.current) return
    hush(); stopNow.current = false; setPhase('listening')
    let pcm: Int16Array | null = null
    try { pcm = await listen(waitMs, s.pause, hold, stopNow, setHearing) } catch { say(t('assistant.micNeeded'), true) }
    setHearing(false)
    if (!pcm) { setPhase('idle'); return }
    setPhase('thinking')
    try {
      const r = await window.drive.assistant.transcribe(pcm)
      setSpent(r.spent); setPhase('idle')
      if (r.text) fns.current.send(r.text); else say(t('assistant.heardNothing'))
    } catch (e) { setPhase('idle'); say(errorText(e), true) }
  }
  const mic = () => { if (phase === 'idle') hear(10_000); else if (phase === 'listening') stopNow.current = true }

  async function startLive() {
    if (!s?.hasKey || live.current || phase !== 'idle') return
    hush()
    setLiveYou(''); setLiveAi(''); setLivePhase('connecting'); setLiveShown(true)
    const l = live.current = { close: null as (() => void) | null, start: Date.now(), last: Date.now(), muted: false, level: 0 }
    setNow(l.start)
    try {
      await window.drive.assistant.liveStart()
      let chunk: Int16Array[] = []
      l.close = await openMic(f => {
        let sum = 0
        for (const x of f) sum += x * x
        l.level = Math.min(1, Math.sqrt(sum / f.length) / 3000)
        chunk.push(l.muted ? new Int16Array(f.length) : f) // silence while thinking and speaking: Tetra does not hear itself
        if (chunk.length < 4) return // 120 ms a message
        const all = new Int16Array(chunk.length * FRAME)
        chunk.forEach((c, i) => all.set(c, i * FRAME)); chunk = []
        window.drive.assistant.liveAudio(new Uint8Array(all.buffer))
      })
      if (live.current !== l) l.close()
      else setLivePhase(p => p === 'connecting' ? 'listening' : p)
    } catch (e) { say(e instanceof DOMException ? t('assistant.micNeeded') : errorText(e), true); endLive() }
  }
  function endLive(why?: string) {
    const l = live.current
    if (!l) return
    live.current = null
    l.close?.()
    hush()
    window.drive.assistant.liveEnd().then(setSpent)
    if (why) say(why)
    setLivePhase('stopping')
    setTimeout(() => { if (!live.current) setLiveShown(false) }, 1500) // the record slows to a stop first
  }
  fns.current = { send, endLive, mic, toggleLive: () => live.current ? endLive() : startLive(),
    hold: down => { if (down) hear(60_000, true); else stopNow.current = true } }

  useEffect(() => window.drive.assistant.onAudio(pcm => { player.push(pcm); if (live.current) setLivePhase('speaking') }), [])
  useEffect(() => window.drive.assistant.onSay(() => { if (live.current) setLivePhase('speaking') }), [])
  useEffect(() => window.drive.assistant.onLive(e => {
    const l = live.current
    if (!l) return
    if (e.type === 'heard') { setLiveYou(e.text ?? ''); setLiveAi(''); l.last = Date.now(); setLivePhase(p => p === 'connecting' ? 'listening' : p) }
    else if (e.type === 'turn') fns.current.send(e.text ?? '')
    else { say(e.message ?? '', true); fns.current.endLive() }
  }), [])
  // the bill guard (live is paid by the minute): 20 s with nobody talking, or 5 minutes, and it ends by itself
  useEffect(() => {
    if (!liveShown) return
    const timer = setInterval(() => {
      const l = live.current, at = Date.now()
      setNow(at)
      if (!l) return
      if (at - l.start >= LIVE_MAX_MS) fns.current.endLive(t('assistant.liveCap'))
      else if (!l.muted && at - l.last >= LIVE_SILENCE_MS) fns.current.endLive(t('assistant.liveSilence'))
    }, 250)
    return () => clearInterval(timer)
  }, [liveShown])

  // in the window: Space held to talk (outside a text field), Esc ends live or stops listening
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (live.current) fns.current.endLive(); else stopNow.current = true; return }
      if (e.code === 'Space' && !e.repeat && !typing(e) && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); fns.current.hold(true) }
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e)) { e.preventDefault(); fns.current.hold(false) } } // not also a click on the focused button
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])
  // a shortcut from anywhere, or `tetra --talk` / `--live`
  useEffect(() => {
    if (!command || !s) return
    if (command.what === 'talk') fns.current.mic()
    if (command.what === 'live') fns.current.toggleLive()
  }, [command?.at, !!s]) // eslint-disable-line react-hooks/exhaustive-deps

  const status = phase === 'listening' ? t(hearing ? 'assistant.hearing' : 'assistant.listening') : phase === 'thinking' ? t('assistant.thinking') : null
  const setAloud = (on: boolean) => { if (!s) return; setS({ ...s, aloud: on }); window.drive.assistant.set({ aloud: on }); if (!on) hush() }
  const newChat = () => { hush(); window.drive.assistant.clear(); setBubbles(() => []); setPendingCall(null); setSpent(0) }
  const saveKey = async () => {
    try { await window.drive.assistant.setKey(keyText); setKeyText(''); load() } catch (e) { say(errorText(e), true) }
  }
  const sendTyped = () => { const x = typed.trim(); setTyped(''); send(x) }
  const lastChoices = bubbles.at(-1)?.choices ?? []

  return (
    <div className="assist">
      <header className="page-head assist-head">
        <img className="assist-art" src="./assistant.png" alt="" />
        <h1>{t('app.assistant')}</h1>
        <span className="assist-cost" title={t('assistant.costNote')}>{money(spent)}</span>
        <button className="round flat" title={t('assistant.readAloud')} onClick={() => setAloud(!s?.aloud)}><Icon name={s?.aloud ? 'volumeUp' : 'volumeOff'} /></button>
        <button className="round flat" title={t('assistant.newChat')} onClick={newChat}><Icon name="add" /></button>
      </header>
      <div className="assist-list" ref={list}>
        {s && !s.hasKey && <section className="settings-card island">
          <h3><Icon name="key" size={20} />{t('assistant.key')}</h3>
          <p className="muted">{t('assistant.keyNote')}</p>
          <input className="field" type="password" placeholder={t('assistant.keyHint')} value={keyText} onChange={e => setKeyText(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveKey()} />
          <div className="reset-actions"><button className="filled-button" disabled={!keyText.trim()} onClick={saveKey}>{t('common.save')}</button></div>
        </section>}
        {s?.hasKey && !bubbles.length && <div className="assist-hello muted">{t('assistant.hello')}</div>}
        {bubbles.map((b, i) => <BubbleView key={i} b={b} pending={i === bubbles.length - 1 ? pending : null} choose={choose} call={call} cancel={cancelCall}
          mail={i === bubbles.length - 1 ? pendingMail : null} sendMail={sendMail} keepMail={keepMail} />)}
        {draft != null && <div className="assist-bubble">{draft || '…'}</div>}
      </div>
      {status && <p className="assist-status">{status}</p>}
      <div className="assist-bar">
        <textarea className="field assist-input" rows={1} placeholder={t('assistant.hint')} value={typed} disabled={!s?.hasKey}
          onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (phase === 'idle') sendTyped() } }} />
        {typed.trim() ? <button className="round assist-go" disabled={phase !== 'idle'} title={t('common.send')} onClick={sendTyped}><Icon name="arrowUp" /></button> : <>
          <button className={`round assist-mic ${phase === 'listening' ? (hearing ? 'hearing' : 'on') : ''}`} disabled={!s?.hasKey || phase === 'thinking'}
            title={phase === 'listening' ? t('common.stop') : t('assistant.tapToTalk')} onClick={mic}>
            {phase === 'thinking' ? <span className="spinner" /> : <Icon name="mic" />}
          </button>
          <button className="round assist-live" disabled={!s?.hasKey || phase !== 'idle'} title={t('assistant.live')} onClick={startLive}><Icon name="graphicEq" /></button>
        </>}
      </div>
      {liveShown && <div className="assist-livescreen">
        <h2>{t('app.assistant')}</h2>
        <LivePlayer phase={livePhase} level={() => live.current?.level ?? 0} cassette={!!s?.cassette}
          toggle={() => { if (!s) return; setS({ ...s, cassette: !s.cassette }); window.drive.assistant.set({ cassette: !s.cassette }) }} />
        <div className="assist-captions island">
          <p><strong>{s?.meName || t('assistant.you')}: </strong>{liveYou || (livePhase === 'connecting' ? t('assistant.liveConnecting') : '…')}</p>
          {(liveAi || livePhase === 'thinking') && <p className="assist-ai"><strong>{t('assistant.ai')}: </strong>{liveAi || t('assistant.thinking')}</p>}
          {lastChoices.slice(0, 5).map((c, i) => <button key={i} className="text-button" onClick={() => choose(c)}>{i + 1}. {c.label}</button>)}
          {pending && <div className="reset-actions">
            <button className="filled-button" onClick={() => call(pending)}>{t('assistant.call', { name: pending.name })}</button>
            <button className="text-button" onClick={cancelCall}>{t('common.cancel')}</button>
          </div>}
          {pendingMail && <div className="reset-actions">
            <button className="filled-button" onClick={() => sendMail(pendingMail)}>{t('assistant.mailSend', { to: pendingMail.to })}</button>
            <button className="text-button" onClick={keepMail}>{t('common.cancel')}</button>
          </div>}
        </div>
        <div className="assist-livebar">
          <button className="round assist-end" disabled={livePhase === 'stopping'} title={t('assistant.liveEnd')} onClick={() => endLive()}><Icon name="close" size={28} /></button>
          <span className="assist-livecost">{money(spent + (s?.perMinute ?? 0) * Math.max(0, now - (live.current?.start ?? now)) / 60_000)} / {clock(now - (live.current?.start ?? now))}</span>
        </div>
      </div>}
    </div>
  )
}

function BubbleView({ b, pending, choose, call, cancel, mail, sendMail, keepMail }: { b: Bubble; pending: AssistCall | null; choose: (c: AssistChoice) => void; call: (c: AssistCall) => void; cancel: () => void
  mail: AssistSend | null; sendMail: (m: AssistSend) => void; keepMail: () => void }) {
  return (
    <div className={`assist-bubble ${b.mine ? 'mine' : ''} ${b.error ? 'error' : ''}`}>
      {b.text && <p>{b.text}</p>}
      {b.images?.map((src, i) => <img key={i} src={src} alt="" />)}
      {!!b.choices?.length && <div className="assist-choices">{b.choices.map((c, i) => <button key={i} className="chip" onClick={() => choose(c)}>{i + 1}. {c.label}</button>)}</div>}
      {pending && <div className="reset-actions">
        <button className="filled-button" onClick={() => call(pending)}><Icon name="call" size={18} /> {t('assistant.call', { name: pending.name })}</button>
        <button className="text-button" onClick={cancel}>{t('common.cancel')}</button>
      </div>}
      {mail && <div className="assist-mail">
        <small>{t('mail.toField')}: {mail.to} · {mail.subject}</small>
        <p>{mail.preview}</p>
        <div className="reset-actions">
          <button className="filled-button" onClick={() => sendMail(mail)}><Icon name="send" size={18} /> {t('assistant.mailSend', { to: mail.to })}</button>
          <button className="text-button" onClick={keepMail}>{t('common.cancel')}</button>
        </div>
      </div>}
    </div>
  )
}

const label = new Image()
label.src = './assistant.png'

/**
 * Live, as the user drew it on the phone: a record (or a cassette, a click away) that turns with the talk (steady while the AI
 * speaks, slowly with its grooves glowing to the voice while it listens, a half-turn while it thinks, slowing to a stop at X).
 */
function LivePlayer({ phase, level, cassette, toggle }: { phase: LivePhase; level: () => number; cassette: boolean; toggle: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const state = useRef({ phase, cassette })
  state.current = { phase, cassette }
  useEffect(() => {
    let raf = 0, last = 0, speed = 0, angle = 0, wound = 0, pulse = 0, needle = 1.14
    const frame = (time: number) => {
      raf = requestAnimationFrame(frame)
      const c = canvas.current
      if (!c) return
      const dt = last ? Math.min(0.1, (time - last) / 1000) : 0
      last = time
      const { phase: ph, cassette: tape } = state.current
      speed += (TURN[ph] - speed) * Math.min(1, dt * 1.5)
      angle = (angle + speed * dt) % 360
      wound += (ph === 'listening' ? 1 : -1) * speed * dt // the user winds one way, the AI the other
      pulse += ((ph === 'listening' ? level() : 0) - pulse) * Math.min(1, dt * 10)
      const target = ph === 'listening' ? 0.86 : ph === 'thinking' || ph === 'speaking' ? 0.6 : 1.14
      needle += (target - needle) * Math.min(1, dt * 3)
      const dpr = devicePixelRatio || 1, w = c.clientWidth * dpr, h = c.clientHeight * dpr
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      const g = c.getContext('2d')!
      g.clearRect(0, 0, w, h)
      if (tape) drawCassette(g, w, h, wound, pulse); else drawVinyl(g, w, h, angle, pulse, needle)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={canvas} className={`assist-player ${cassette ? 'tape' : ''}`} onClick={toggle} title={t('assistant.playerSwitch')} />
}

const circle = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => { g.beginPath(); g.arc(x, y, Math.max(0, r), 0, Math.PI * 2) }
const DEG = Math.PI / 180

/** The record, with its tonearm: the needle on one track while the user talks, another when the AI answers, off it at rest. */
function drawVinyl(g: CanvasRenderingContext2D, w: number, h: number, angle: number, pulse: number, needle: number) {
  const side = Math.min(w, h), ox = (w - side) / 2, oy = (h - side) / 2
  const r = side * 0.42, cx = ox + side * 0.45, cy = oy + side * 0.52
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r)
  grad.addColorStop(0, '#2C2C31'); grad.addColorStop(1, '#0E0E10')
  g.fillStyle = grad; circle(g, cx, cy, r); g.fill()
  for (let i = 0; i < 26; i++) {
    const wave = 0.5 + 0.5 * Math.sin(i * 0.9 + angle / 25), gap = i === 10 || i === 19 // the quiet rings between songs
    circle(g, cx, cy, r * (0.40 + i * 0.022))
    if (gap) { g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; g.stroke(); continue }
    g.lineWidth = 1.2
    const a = Math.min(0.6, Math.max(0, pulse * 0.6 * wave))
    if (a > 0.01) { g.strokeStyle = `rgba(255,183,77,${a})`; g.stroke() }
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.stroke()
  }
  g.save(); g.translate(cx, cy); g.rotate(angle * DEG)
  g.fillStyle = 'rgba(255,255,255,0.07)'
  for (const from of [-100, 80]) { g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, from * DEG, (from + 30) * DEG); g.closePath(); g.fill() }
  const lr = r * 0.36
  g.save(); circle(g, 0, 0, lr); g.clip()
  // the icon's middle (its robot) fills the label
  if (label.complete && label.naturalWidth) g.drawImage(label, label.naturalWidth * 0.12, label.naturalHeight * 0.12, label.naturalWidth * 0.76, label.naturalHeight * 0.76, -lr, -lr, lr * 2, lr * 2)
  else { g.fillStyle = ORANGE; g.fill() }
  g.restore()
  g.fillStyle = '#0E0E10'; circle(g, 0, 0, r * 0.025); g.fill() // the spindle hole
  g.restore()
  // the tonearm, from its pivot at the top right: the angle that puts the needle needle·r from the middle (law of cosines)
  const px = ox + side * 0.9, py = oy + side * 0.1, mx = cx - px, my = cy - py
  const d = Math.hypot(mx, my), arm = d * 0.97, rho = needle * r
  const bend = Math.acos(Math.max(-1, Math.min(1, (arm * arm + d * d - rho * rho) / (2 * arm * d))))
  const a = Math.atan2(my, mx) - bend, dx = Math.cos(a), dy = Math.sin(a)
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number) => { g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke() }
  g.fillStyle = '#3A3D42'; circle(g, px, py, r * 0.11); g.fill()
  line(px - dx * r * 0.16, py - dy * r * 0.16, px + dx * arm * 0.86, py + dy * arm * 0.86, '#B0B4BA', r * 0.035)
  g.fillStyle = '#55595F'; circle(g, px - dx * r * 0.16, py - dy * r * 0.16, r * 0.075); g.fill() // the counterweight
  g.fillStyle = '#B0B4BA'; circle(g, px, py, r * 0.05); g.fill()
  // the headshell, bent a little inwards, and the needle on the record
  const hx = Math.cos(a + 0.35), hy = Math.sin(a + 0.35), sx = px + dx * arm * 0.86, sy = py + dy * arm * 0.86
  line(sx, sy, sx + hx * arm * 0.16, sy + hy * arm * 0.16, '#E0E0E0', r * 0.07)
  g.fillStyle = ORANGE; circle(g, sx + hx * arm * 0.15, sy + hy * arm * 0.15, r * 0.02); g.fill()
}

const SIDE_DEGREES = 360 * 8 // a side's worth of turning: a few sentences of the AI, half a minute of the user

/** The cassette: two reels turning with the talk, the tape going left to right while the user talks, back while the AI does. */
function drawCassette(g: CanvasRenderingContext2D, cw: number, ch: number, wound: number, pulse: number) {
  const w = Math.min(cw, ch * 1.58), h = w / 1.58
  g.save(); g.translate((cw - w) / 2, (ch - h) / 2)
  const round = (x: number, y: number, rw: number, rh: number, r: number) => { g.beginPath(); g.roundRect(x, y, rw, rh, r) }
  g.fillStyle = 'rgba(42,44,48,0.92)'; round(0, 0, w, h, w * 0.04); g.fill()
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3; g.stroke()
  // the label strip and the window
  g.fillStyle = '#F4F1EA'; round(w * 0.08, h * 0.08, w * 0.84, h * 0.17, 6); g.fill()
  g.fillStyle = ORANGE; g.fillRect(w * 0.08, h * 0.22, w * 0.84, h * 0.03)
  if (label.complete && label.naturalWidth) g.drawImage(label, w * 0.1, h * 0.09, h * 0.15, h * 0.15)
  round(w * 0.14, h * 0.32, w * 0.72, h * 0.40, h * 0.2)
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill()
  g.strokeStyle = `rgba(253,106,4,${Math.min(0.8, Math.max(0, pulse * 0.8))})`; g.lineWidth = 4; g.stroke() // glows with the user's voice
  // the reels: tape wound on each as the minutes go, turning round at either end as an auto-reverse deck does
  const hub = h * 0.1, full = h * 0.19, sideNo = wound / SIDE_DEGREES
  let p = sideNo - 2 * Math.floor(sideNo / 2); if (p > 1) p = 2 - p
  for (const [x, share] of [[w * 0.32, 1 - p], [w * 0.68, p]] as const) {
    const y = h * 0.52
    g.fillStyle = '#4A3426'; circle(g, x, y, hub + (full - hub) * share); g.fill()
    g.save(); g.translate(x, y); g.rotate(wound * 2 * DEG)
    g.fillStyle = '#F4F1EA'; circle(g, 0, 0, hub); g.fill()
    g.fillStyle = '#2A2C30'; circle(g, 0, 0, hub * 0.45); g.fill()
    g.strokeStyle = '#F4F1EA'; g.lineWidth = hub * 0.18
    for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(k * 60 * DEG) * hub * 0.62, Math.sin(k * 60 * DEG) * hub * 0.62); g.stroke() } // the hub's teeth
    g.fillStyle = '#2A2C30'; circle(g, 0, 0, hub * 0.22); g.fill()
    g.restore()
  }
  // the tape past the heads at the bottom, and the shell's lower part
  g.strokeStyle = '#4A3426'; g.lineWidth = 4; g.beginPath(); g.moveTo(w * 0.2, h * 0.84); g.lineTo(w * 0.8, h * 0.84); g.stroke()
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.moveTo(w * 0.18, h * 0.98); g.lineTo(w * 0.24, h * 0.78); g.lineTo(w * 0.76, h * 0.78); g.lineTo(w * 0.82, h * 0.98); g.closePath(); g.fill()
  g.fillStyle = 'rgba(0,0,0,0.5)'
  for (const x of [0.3, 0.5, 0.7]) { circle(g, w * x, h * 0.9, h * 0.03); g.fill() }
  g.restore()
}
