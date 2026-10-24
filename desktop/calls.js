'use strict'
// Calls on the computer (the user, 24 Oct: "a bubble with the face and name, and answer or end call"). A PC cannot place
// or take a phone call; the paired phone does, and tells this computer each call's state (its SyncServer /call/state →
// sync.js onCall). Here: the call bubble — a small window on top of the others with the contact's face, name and
// number, Calling… / Ringing / the call's time / Ended, and Answer · Decline · End (sync.js callAction → the phone). The
// voice is the phone's unless the phone is connected to this computer by Bluetooth as a hands-free kit: that is said in
// the bubble, shown in Settings › Calls, and a notification says when it connects or drops.
const { BrowserWindow, screen } = require('electron')
const { execFile, spawn } = require('node:child_process')
const path = require('node:path')

const run = args => new Promise(r => execFile('bluetoothctl', args, { timeout: 4000 }, (e, out) => r(e ? null : String(out))))

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
  fromPhone({ state, direction, number, missed, device }) {
    if (!['ringing', 'active', 'ended'].includes(state)) return
    const was = this.state
    if (state === 'ended' && !was) return // nothing on the screen to end
    const c = this.who(number || was?.number)
    const next = { ...was, direction: direction === 'out' ? 'out' : 'in', state, number: number || was?.number || '', name: c?.name || was?.name || '', photo: c?.photo ?? was?.photo ?? null, device: device || was?.device,
      since: state === 'active' && was?.state !== 'active' ? Date.now() : was?.since ?? Date.now(), missed: !!missed }
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
    if (s.state === 'ended') this.closer = setTimeout(() => this.close(), 6000)
  }

  close() { clearTimeout(this.closer); this.state = null; if (this.win && !this.win.isDestroyed()) this.win.close() }

  /** The bubble's buttons: answer, decline, end on the phone; close the bubble. */
  async press(what) {
    if (what === 'close') return this.close()
    const r = await this.act(what).catch(e => ({ error: e.message }))
    if (r?.error) { this.win?.webContents.send('said', r.error); return r }
    if (what !== 'answer') this.show({ ...this.state, state: 'ended', missed: false })
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
