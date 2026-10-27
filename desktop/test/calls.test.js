'use strict'
// Calls (calls.js): a call starting with the phone paired but not on this computer's Bluetooth connects it by itself, and the
// bubble says so before Answer. bluetoothctl is a fake on PATH; Electron's window a stand-in.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const load = Module._load
const win = () => new Proxy({ webContents: { send() {}, once() {} } }, { get: (t, k) => k in t ? t[k] : () => false })
Module._load = function (req, ...rest) { return req === 'electron' ? { BrowserWindow: function () { return win() }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) } } : load.call(this, req, ...rest) }
const { Calls } = require('../calls')
Module._load = load

const bt = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'))
fs.writeFileSync(path.join(bt, 'bluetoothctl'), `#!/bin/sh
case "$1" in
  devices) echo "Device AA:BB:CC:DD:EE:FF Test Phone" ;;
  info) echo "\tUUID: Handsfree Audio Gateway (0000111f-0000-1000-8000-00805f9b34fb)"; [ -e "${bt}/on" ] && echo "\tConnected: yes" || echo "\tConnected: no" ;;
  connect) if [ -e "${bt}/reachable" ]; then touch "${bt}/on"; echo "Connection successful"; else echo "Failed to connect: org.bluez.Error.Failed"; fi ;;
esac
`, { mode: 0o755 })
process.env.PATH = `${bt}:${process.env.PATH}`

function calls() {
  const c = new Calls({ contacts: { all: () => [] }, act: async () => ({}), notify: () => {}, recordings: bt })
  c.sounds = []; const show = c.show.bind(c); c.show = s => { show(s); c.sounds.push(c.state.sound) }
  return c
}
const settled = c => new Promise(r => { const t = setInterval(() => { if (!c.connecting && c.sounds.length > 1) { clearInterval(t); r() } }, 20) })

test('a call rings with the phone off Bluetooth: it is connected, and the bubble says so', async () => {
  fs.rmSync(path.join(bt, 'on'), { force: true }); fs.writeFileSync(path.join(bt, 'reachable'), '')
  const c = calls()
  c.fromPhone({ state: 'ringing', number: '2100000000' })
  await settled(c)
  assert.ok(c.sounds.includes('Connecting Test Phone by Bluetooth for the sound…'))
  assert.equal(c.state.sound, 'Sound on this computer (Bluetooth, Test Phone)')
})

test('it cannot connect: "Sound stays on the phone" before Answer', async () => {
  fs.rmSync(path.join(bt, 'on'), { force: true }); fs.rmSync(path.join(bt, 'reachable'), { force: true })
  const c = calls()
  c.outgoing('2100000000', 'Someone')
  await settled(c)
  assert.equal(c.state.sound, 'Sound stays on the phone: Test Phone did not connect by Bluetooth')
  c.fromPhone({ state: 'ended' })
  c.fromPhone({ state: 'ringing', number: '2100000000' }) // the next call tries again
  assert.equal(c.state.sound, 'Sound on the phone')
  c.close()
})

test("the phone's loudspeaker: the bubble says where the sound is, and recording is off", async () => {
  fs.writeFileSync(path.join(bt, 'on'), '')
  const c = calls()
  c.fromPhone({ state: 'active', number: '2100000000', phoneApp: true, route: 'bluetooth' })
  assert.equal(c.state.sound, 'Sound on the phone')
  c.fromPhone({ state: 'active', number: '2100000000', phoneApp: true, route: 'speaker' })
  assert.equal(c.state.sound, "Sound on the phone's loudspeaker")
  assert.equal(c.state.canRecord, false)
  c.close()
})
