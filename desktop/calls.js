'use strict'
// Calls on the computer (the user, 24 Oct: "a bubble with the face and name, and answer or end call"). A PC cannot place
// or take a phone call; the paired phone does, and tells this computer each call's state (its SyncServer /call/state →
// sync.js onCall). Here: the call bubble — a small window on top of the others with the contact's face, name and
// number, Calling… / Ringing / the call's time / Ended, and Answer · Decline · End (sync.js callAction → the phone). The
// voice is the phone's unless the phone is connected to this computer by Bluetooth as a hands-free kit: that is said in
// the bubble, shown in Settings › Calls, and a notification says when it connects or drops. A call starting with the phone
// paired but not connected: connected by itself, and the bubble says before Answer if it could not (the user, 25 Oct: answered
// here with the phone off this computer's Bluetooth, and the sound had nowhere to go).
const { BrowserWindow, screen } = require('electron')
const { execFile, execFileSync, spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { t } = require('./i18n')

const run = (args, timeout = 4000) => new Promise(r => execFile('bluetoothctl', args, { timeout }, (e, out) => r(e ? null : String(out))))
const pactl = args => new Promise(r => execFile('pactl', args, { timeout: 4000 }, (e, out) => r(e ? null : String(out).trim())))

/**
 * Echo cancellation while a call's sound is on this computer (the user, 24 Oct: "the other side hears their voice two
 * times"): the speakers play the caller, the microphone hears them and sends them back. PipeWire's webrtc echo canceller
 * goes between the two for the call — its speaker and microphone the defaults, the phone's Bluetooth streams moved onto
 * them — and the old defaults come back after.
 */
const echo = {
  module: null, was: null, chain: Promise.resolve(),
  queue(fn) { this.chain = this.chain.then(fn).catch(e => console.log('[calls] echo cancel:', e.message)); return this.chain },
  on() {
    return this.queue(async () => {
      if (!this.module) {
        const sink = await pactl(['get-default-sink']), source = await pactl(['get-default-source'])
        if (!sink || !source || sink.startsWith('tetra_call')) return
        const id = await pactl(['load-module', 'module-echo-cancel', 'aec_method=webrtc', `sink_master=${sink}`, `source_master=${source}`,
          'sink_name=tetra_call_speaker', 'source_name=tetra_call_mic'])
        if (!id) return console.log('[calls] echo cancel: PipeWire would not load module-echo-cancel')
        Object.assign(this, { module: id, was: { sink, source } })
        await pactl(['set-default-sink', 'tetra_call_speaker']); await pactl(['set-default-source', 'tetra_call_mic'])
      }
      // the phone's voice streams (they appear when the call's audio starts, so this runs again on each state)
      const bluez = p => /^bluez_/.test(p['node.name'] || '') || p['device.api'] === 'bluez5' || 'api.bluez5.address' in p
      for (const [kind, to] of [['sink-inputs', 'tetra_call_speaker'], ['source-outputs', 'tetra_call_mic']]) {
        const list = JSON.parse(await pactl(['-f', 'json', 'list', kind]) || '[]')
        for (const x of list.filter(x => bluez(x.properties || {}))) await pactl([kind === 'sink-inputs' ? 'move-sink-input' : 'move-source-output', String(x.index), to])
      }
    })
  },
  off() {
    return this.queue(async () => {
      if (!this.module) return
      const { was } = this
      if (await pactl(['get-default-sink']) === 'tetra_call_speaker') await pactl(['set-default-sink', was.sink])
      if (await pactl(['get-default-source']) === 'tetra_call_mic') await pactl(['set-default-source', was.source])
      await pactl(['unload-module', this.module]); this.module = null
    })
  },
  /** On quit (nothing async gets to run then), and at start for one a crash left behind. */
  offNow() {
    try {
      if (this.module) { execFileSync('pactl', ['set-default-sink', this.was.sink], { timeout: 2000 }); execFileSync('pactl', ['set-default-source', this.was.source], { timeout: 2000 }) }
      const mods = String(execFileSync('pactl', ['list', 'short', 'modules'], { timeout: 2000 }))
      for (const m of mods.matchAll(/^(\d+)\s+module-echo-cancel\s+.*sink_name=tetra_call_speaker/gm)) execFileSync('pactl', ['unload-module', m[1]], { timeout: 2000 })
    } catch {}
    this.module = null
  },
}

/**
 * Recording a call whose sound is on this computer (Drive-Android Plan.md § Phone, step 9): a phone app cannot record
 * the other side on Android, but here both are clean — the phone's voice on the echo canceller's speaker (its monitor)
 * and the user's on its microphone — mixed by ffmpeg into one Opus file in Phone/Recordings, which syncs to the phone.
 * Only after the bubble's "They agreed" (Greek law, art. 370A: the other person's explicit yes).
 */
const recorder = {
  proc: null, file: null,
  start(dir, title) {
    if (this.proc) return this.file
    fs.mkdirSync(dir, { recursive: true })
    const d = new Date(), p = n => String(n).padStart(2, '0')
    const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())} ${String(title || 'Call').replace(/[/\\:*?"<>|]/g, '-').slice(0, 60)}.ogg`
    this.file = path.join(dir, name)
    this.proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', 'tetra_call_speaker.monitor', '-f', 'pulse', '-i', 'tetra_call_mic',
      '-filter_complex', 'amix=inputs=2:duration=longest', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-y', this.file], { stdio: ['pipe', 'ignore', 'pipe'] })
    this.proc.stderr.on('data', b => console.log('[calls] recording:', String(b).trim()))
    this.proc.on('exit', () => { this.proc = null })
    this.proc.on('error', e => { console.log('[calls] recording:', e.message); this.proc = null })
    return this.file
  },
  /** ffmpeg finishes the file on "q"; a kill after five seconds if it does not. */
  stop() { const p = this.proc; if (!p) return; try { p.stdin.write('q') } catch {} setTimeout(() => { try { p.kill() } catch {} }, 5000); this.proc = null },
}

/**
 * The phones paired with this computer's Bluetooth that can carry calls (they offer the Handsfree Audio Gateway), and
 * whether one is connected now. { available: bluetoothctl here, phones: [{ mac, name, connected }] }.
 */
async function bluetooth() {
  const paired = await run(['devices', 'Paired'])
  if (paired == null) return { available: false, phones: [] }
  const phones = []
  for (const m of paired.matchAll(/^Device ([0-9A-F:]{17}) (.+)$/gmi)) {
    const info = await run(['info', m[1]]) || ''
    if (/Handsfree Audio Gateway|0000111f-/i.test(info)) phones.push({ mac: m[1], name: m[2].trim(), connected: /^\s*Connected: yes/m.test(info) })
  }
  return { available: true, phones }
}

class Calls {
  /**
   * [contacts]: for a number's face and name; [act](what) → the phone; [notify](title, body); [me]() this computer as the
   * server names who took a call ('server' or its id there); [early]() whether to bring the phone onto this computer's
   * Bluetooth as soon as a call starts — only a server with no other computer, or every computer would reach for it.
   */
  constructor({ contacts, act, notify, recordings, me = () => 'server', early = () => true, relayable = async () => false, relay = null }) {
    // relayable(): the server can carry the sound here (the phone on its Bluetooth); relay() → stop: that sound, both ways
    Object.assign(this, { contacts, act, notify, recordings, me, early, relayable, relay, relayStop: null, win: null, state: null, bt: { available: false, phones: [] }, closer: null })
  }

  /** The contact a number belongs to (its last nine digits), for the bubble. */
  who(number) {
    const key = String(number || '').replace(/\D/g, '').slice(-9)
    if (key.length < 5) return null
    const c = this.contacts.all().find(x => x.info.phones.some(p => p.value.replace(/\D/g, '').slice(-9) === key))
    return c ? { name: c.info.formatted || [c.info.given, c.info.family].filter(Boolean).join(' '), photo: c.info.photo } : null
  }

  sound() {
    if (this.relayStop) return `${t('calls.soundRelayed')} · ${t('release.alpha')}` // not yet tried with two computers
    const on = this.bt.phones.find(p => p.connected)
    if (on) return t('calls.soundHere', { name: on.name })
    if (this.connecting) return t('calls.soundConnecting', { name: this.connecting })
    return this.unreached ? t('calls.soundUnreached', { name: this.unreached }) : t('calls.soundPhone')
  }

  /** A call starting with no phone connected for calls: Settings › Calls' "Connect", done by itself, each paired phone in turn. */
  async reconnect() {
    this.bt = await bluetooth().catch(() => this.bt)
    if (!this.bt.available || !this.bt.phones.length || this.bt.phones.some(p => p.connected)) return
    for (const p of this.bt.phones) {
      this.connecting = p.name; if (this.state) this.show(this.state)
      const ok = await this.connect(p.mac).then(() => true, () => false)
      this.connecting = null
      if (ok) break
    }
    this.unreached = this.bt.phones.some(p => p.connected) ? null : this.bt.phones.map(p => p.name).join(' / ')
    if (this.state) this.show(this.state)
  }

  /** A call this computer asked the phone to place. */
  outgoing(number, name, device) { this.show({ direction: 'out', state: 'calling', number, name: name || this.who(number)?.name || '', photo: this.who(number)?.photo ?? null, device, since: Date.now() }) }

  /** A state the phone told: ringing (with the number), active, ended. */
  fromPhone({ state, direction, number, missed, device, muted, phoneApp, takenBy }) {
    // calling (dialled, not answered yet) and held: only from a phone where Tetra is the phone app, as are muted and phoneApp
    if (!['ringing', 'calling', 'active', 'held', 'ended'].includes(state)) return
    // taken on another computer, "like a switch" (the user, 26 Oct): this bubble goes, and the call stays there
    if (takenBy && takenBy !== this.me()) { if (this.state) this.close(); return }
    const was = this.state
    if (state === 'ended' && !was) return // nothing on the screen to end
    const c = this.who(number || was?.number)
    const next = { ...was, direction: direction === 'out' ? 'out' : 'in', state, number: number || was?.number || '', name: c?.name || was?.name || '', photo: c?.photo ?? was?.photo ?? null, device: device || was?.device,
      since: state === 'active' && !['active', 'held'].includes(was?.state) ? Date.now() : was?.since ?? Date.now(), missed: !!missed, muted: !!muted, phoneApp: !!phoneApp }
    if (state === 'ringing' && was?.state !== 'ringing') this.notify(t('calls.calling', { name: next.name || next.number || t('calls.someone') }), next.device ? t('calls.callingOn', { device: next.device }) : t('calls.callingOnPhone'))
    if (state === 'ended' && missed) this.notify(t('calls.missed', { name: next.name || next.number }), null)
    this.show(next)
  }

  show(s) {
    clearTimeout(this.closer)
    // a call begins (it rings, or the phone dials): its sound needs the phone on this computer's Bluetooth
    if (['ringing', 'calling'].includes(s.state) && !['ringing', 'calling', 'active', 'held'].includes(this.state?.state)) { this.unreached = null; if (this.early()) this.reconnect() }
    if (s.state === 'ended' && recorder.proc) { recorder.stop(); this.notify(t('calls.recorded'), path.basename(recorder.file || '')) }
    this.state = { ...s, sound: this.sound(), canRecord: !!echo.module && ['active', 'held'].includes(s.state), recording: !!recorder.proc }
    if (!this.win || this.win.isDestroyed()) {
      const { workArea } = screen.getPrimaryDisplay()
      this.win = new BrowserWindow({ width: 360, height: 150, x: workArea.x + workArea.width - 376, y: workArea.y + workArea.height - 166, frame: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, show: false, title: t('calls.windowTitle'), backgroundColor: '#1e2124',
        webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), contextIsolation: true } })
      this.win.setAlwaysOnTop(true, 'screen-saver')
      this.win.loadFile(path.join(__dirname, 'bubble.html'))
      this.win.webContents.once('did-finish-load', () => { this.win?.webContents.send('call', this.state); this.win?.show() })
      this.win.on('closed', () => { this.win = null })
    } else {
      this.win.webContents.send('call', this.state)
      if (s.state === 'ringing') { this.win.show(); this.win.focus() } else this.win.showInactive()
    }
    if (s.state === 'ended') { this.relayStop?.(); this.relayStop = null; echo.off(); this.closer = setTimeout(() => this.close(), 6000) }
    else if (['calling', 'active', 'held'].includes(s.state) && this.bt.phones.some(p => p.connected)) echo.on()
  }

  /** The bubble's keypad open or shut: its window grows to hold it. */
  height(h) { if (this.win && !this.win.isDestroyed()) { const [x, y] = this.win.getPosition(), [, was] = this.win.getSize(); this.win.setBounds({ x, y: y + was - h, width: 360, height: h }) } }

  close() { clearTimeout(this.closer); this.state = null; this.relayStop?.(); this.relayStop = null; echo.off(); if (this.win && !this.win.isDestroyed()) this.win.close() }

  /** The app quitting: the echo canceller goes and the speaker and microphone are as they were. */
  quit() { recorder.stop(); echo.offNow() }

  /** The bubble's buttons: answer, decline, end on the phone; close the bubble. */
  async press(what) {
    if (what === 'close') return this.close()
    // recording happens here, not on the phone; the bubble asked "They agreed?" before sending it
    if (what === 'record' && echo.module) { recorder.start(this.recordings, this.state?.name || this.state?.number); return this.show(this.state) }
    if (what === 'stoprec') { recorder.stop(); this.notify(t('calls.recorded'), path.basename(recorder.file || '')); return this.show(this.state) }
    // with other computers about, the sound comes here only where the call is answered (the user, 26 Oct): the phone on this
    // computer's Bluetooth already, or through the server when it has the phone ("Bluetooth > Wi-Fi > speaker"), or else
    // the phone comes onto this one's Bluetooth
    let relayed = false
    if (what === 'answer' && !this.early()) {
      this.bt = await bluetooth().catch(() => this.bt)
      if (!this.bt.phones.some(p => p.connected)) relayed = await this.relayable().catch(() => false)
      if (!relayed) await this.reconnect()
    }
    const r = await this.act(what).catch(e => ({ error: e.message }))
    if (r?.error) { this.win?.webContents.send('said', r.error); return r }
    if (relayed && this.relay) {
      await echo.on() // the speaker and microphone through the echo canceller, as for Bluetooth
      this.relayStop = await this.relay().catch(e => { this.win?.webContents.send('said', e.message); return null })
      if (this.state) this.show(this.state)
    }
    if (what === 'end' || what === 'decline') this.show({ ...this.state, state: 'ended', missed: false })
    return r
  }

  /** Bluetooth looked at now and every half minute; a phone connecting or dropping for calls is said. */
  watch() {
    const look = async () => {
      const before = this.bt.phones.find(p => p.connected)?.mac
      this.bt = await bluetooth().catch(() => this.bt)
      const now = this.bt.phones.find(p => p.connected)
      if (before !== undefined && before !== now?.mac) this.notify(now ? t('calls.btConnected', { name: now.name }) : t('calls.btDropped'), now ? t('calls.btConnectedBody') : t('calls.btDroppedBody'))
      if (this.state) this.show(this.state)
    }
    this.bt.phones = this.bt.phones ?? []
    echo.offNow() // one a crash left behind
    look(); setInterval(look, 30_000)
  }

  /** Connect a phone already paired with this computer's Bluetooth. */
  async connect(mac) {
    if (!/^[0-9A-F:]{17}$/i.test(String(mac))) throw new Error('Not a Bluetooth address.')
    const out = await run(['connect', mac], 15_000) // a phone takes a few seconds to answer
    this.bt = await bluetooth()
    if (!this.bt.phones.find(p => p.mac === mac)?.connected) throw new Error(out?.match(/Failed to connect: (.+)/)?.[1] || t('calls.errNoConnect'))
    return this.bt
  }

  /** The system's own Bluetooth settings, to pair the phone (KDE, GNOME, or Blueman). */
  openSystemBluetooth() {
    for (const [cmd, args] of [['systemsettings', ['kcm_bluetooth']], ['gnome-control-center', ['bluetooth']], ['blueman-manager', []]]) {
      try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); if (p.pid) return true } catch {}
    }
    return false
  }
}

module.exports = { Calls, bluetooth }
