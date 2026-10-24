'use strict'
// Calls on the computer (the user, 24 Oct: "a bubble with the face and name, and answer or end call"). A PC cannot place
// or take a phone call; the paired phone does, and tells this computer each call's state (its SyncServer /call/state →
// sync.js onCall). Here: the call bubble — a small window on top of the others with the contact's face, name and
// number, Calling… / Ringing / the call's time / Ended, and Answer · Decline · End (sync.js callAction → the phone). The
// voice is the phone's unless the phone is connected to this computer by Bluetooth as a hands-free kit: that is said in
// the bubble, shown in Settings › Calls, and a notification says when it connects or drops.
const { BrowserWindow, screen } = require('electron')
const { execFile, execFileSync, spawn } = require('node:child_process')
const path = require('node:path')

const run = args => new Promise(r => execFile('bluetoothctl', args, { timeout: 4000 }, (e, out) => r(e ? null : String(out))))
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
  /** [contacts]: for a number's face and name; [act](what) → the phone; [notify](title, body). */
  constructor({ contacts, act, notify }) { Object.assign(this, { contacts, act, notify, win: null, state: null, bt: { available: false, phones: [] }, closer: null }) }

  /** The contact a number belongs to (its last nine digits), for the bubble. */
  who(number) {
    const key = String(number || '').replace(/\D/g, '').slice(-9)
    if (key.length < 5) return null
    const c = this.contacts.all().find(x => x.info.phones.some(p => p.value.replace(/\D/g, '').slice(-9) === key))
    return c ? { name: c.info.formatted || [c.info.given, c.info.family].filter(Boolean).join(' '), photo: c.info.photo } : null
  }

  sound() { const on = this.bt.phones.find(p => p.connected); return on ? `Sound on this computer (Bluetooth, ${on.name})` : 'Sound on the phone' }

  /** A call this computer asked the phone to place. */
  outgoing(number, name, device) { this.show({ direction: 'out', state: 'calling', number, name: name || this.who(number)?.name || '', photo: this.who(number)?.photo ?? null, device, since: Date.now() }) }

  /** A state the phone told: ringing (with the number), active, ended. */
  fromPhone({ state, direction, number, missed, device, muted, phoneApp }) {
    // calling (dialled, not answered yet) and held: only from a phone where Tetra is the phone app, as are muted and phoneApp
    if (!['ringing', 'calling', 'active', 'held', 'ended'].includes(state)) return
    const was = this.state
    if (state === 'ended' && !was) return // nothing on the screen to end
    const c = this.who(number || was?.number)
    const next = { ...was, direction: direction === 'out' ? 'out' : 'in', state, number: number || was?.number || '', name: c?.name || was?.name || '', photo: c?.photo ?? was?.photo ?? null, device: device || was?.device,
      since: state === 'active' && !['active', 'held'].includes(was?.state) ? Date.now() : was?.since ?? Date.now(), missed: !!missed, muted: !!muted, phoneApp: !!phoneApp }
    if (state === 'ringing' && was?.state !== 'ringing') this.notify(`${next.name || next.number || 'Someone'} is calling`, `On ${next.device || 'the phone'} — answer or decline in the call bubble`)
    if (state === 'ended' && missed) this.notify(`Missed call: ${next.name || next.number}`, null)
    this.show(next)
  }

  show(s) {
    clearTimeout(this.closer)
    this.state = { ...s, sound: this.sound() }
    if (!this.win || this.win.isDestroyed()) {
      const { workArea } = screen.getPrimaryDisplay()
      this.win = new BrowserWindow({ width: 360, height: 150, x: workArea.x + workArea.width - 376, y: workArea.y + workArea.height - 166, frame: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Call', backgroundColor: '#1e2124',
        webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), contextIsolation: true } })
      this.win.setAlwaysOnTop(true, 'screen-saver')
      this.win.loadFile(path.join(__dirname, 'bubble.html'))
      this.win.webContents.once('did-finish-load', () => { this.win?.webContents.send('call', this.state); this.win?.show() })
      this.win.on('closed', () => { this.win = null })
    } else {
      this.win.webContents.send('call', this.state)
      if (s.state === 'ringing') { this.win.show(); this.win.focus() } else this.win.showInactive()
    }
    if (s.state === 'ended') { echo.off(); this.closer = setTimeout(() => this.close(), 6000) }
    else if (['calling', 'active', 'held'].includes(s.state) && this.bt.phones.some(p => p.connected)) echo.on()
  }

  /** The bubble's keypad open or shut: its window grows to hold it. */
  height(h) { if (this.win && !this.win.isDestroyed()) { const [x, y] = this.win.getPosition(), [, was] = this.win.getSize(); this.win.setBounds({ x, y: y + was - h, width: 360, height: h }) } }

  close() { clearTimeout(this.closer); this.state = null; echo.off(); if (this.win && !this.win.isDestroyed()) this.win.close() }

  /** The app quitting: the echo canceller goes and the speaker and microphone are as they were. */
  quit() { echo.offNow() }

  /** The bubble's buttons: answer, decline, end on the phone; close the bubble. */
  async press(what) {
    if (what === 'close') return this.close()
    const r = await this.act(what).catch(e => ({ error: e.message }))
    if (r?.error) { this.win?.webContents.send('said', r.error); return r }
    if (what === 'end' || what === 'decline') this.show({ ...this.state, state: 'ended', missed: false })
    return r
  }

  /** Bluetooth looked at now and every half minute; a phone connecting or dropping for calls is said. */
  watch() {
    const look = async () => {
      const before = this.bt.phones.find(p => p.connected)?.mac
      this.bt = await bluetooth().catch(() => this.bt)
      const now = this.bt.phones.find(p => p.connected)
      if (before !== undefined && before !== now?.mac) this.notify(now ? `${now.name} connected for calls` : 'Phone disconnected from Bluetooth', now ? 'A call\'s sound is on this computer now.' : 'A call\'s sound stays on the phone.')
      if (this.state) this.show(this.state)
    }
    this.bt.phones = this.bt.phones ?? []
    echo.offNow() // one a crash left behind
    look(); setInterval(look, 30_000)
  }

  /** Connect a phone already paired with this computer's Bluetooth. */
  async connect(mac) {
    if (!/^[0-9A-F:]{17}$/i.test(String(mac))) throw new Error('Not a Bluetooth address.')
    const out = await run(['connect', mac])
    this.bt = await bluetooth()
    if (!this.bt.phones.find(p => p.mac === mac)?.connected) throw new Error(out?.match(/Failed to connect: (.+)/)?.[1] || 'The phone did not connect. Is its Bluetooth on, and "Phone calls" allowed for this computer there?')
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
