'use strict'
// Data's counter on the computer (datacount.js): the deltas, a counter that went back, the files the phone reads.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DataCounter, parseIw, parseMonth, monthText } = require('../datacount')

function counter(withPlan = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'))
  if (withPlan) fs.writeFileSync(path.join(root, 'plan.json'), '{}')
  const c = new DataCounter(root, 'my-pc')
  let state = {}
  c.readCounters = () => JSON.parse(JSON.stringify(state))
  c.metered = async () => c.onHotspot
  return { c, root, set: s => { state = s } }
}

test('iw link is read', () => {
  const r = parseIw('Connected to 11:22:33:44:55:66 (on wlp2s0)\n\tSSID: Home 5G\n\tfreq: 5180.0\n\tsignal: -58 dBm\n\ttx bitrate: 433.3 MBit/s VHT-MCS 9 80MHz short GI VHT-NSS 1\n')
  assert.deepEqual(r, { rssi: -58, speed: 433, mhz: 5180, ssid: 'Home 5G' })
  assert.equal(parseIw('Not connected.'), null)
})

test('each minute adds what the counters moved; a counter that went back counts from zero', async () => {
  const { c, root, set } = counter()
  c.onHotspot = false
  const t = h => new Date(2026, 9, 25, h, 0, 0)
  set({ wlan0: { rx: 1000, tx: 0, wireless: true }, eth0: { rx: 0, tx: 0, wireless: false } }); await c.tick(t(10))
  set({ wlan0: { rx: 6000, tx: 500, wireless: true }, eth0: { rx: 40, tx: 0, wireless: false } }); await c.tick(t(10))
  c.onHotspot = true
  set({ wlan0: { rx: 300, tx: 0, wireless: true }, eth0: { rx: 40, tx: 0, wireless: false } }); await c.tick(t(11)) // a restart: 300 new
  c.flush(t(11))
  const m = parseMonth(fs.readFileSync(path.join(root, 'usage', '2026-10.my-pc.jsonl'), 'utf8'))
  assert.deepEqual(m.days.get('2026-10-25'), { d: '2026-10-25', wifi: 5800, via: 300 })
  assert.equal(m.hours.get('2026-10-25T10|wifi'), 5500)
  assert.equal(m.hours.get('2026-10-25T10|wired'), 40)
})

test('no Data folder until Data is set up', async () => {
  const { c, root, set } = counter(false)
  set({ wlan0: { rx: 1, tx: 0, wireless: true } }); await c.tick(); await c.tick(); c.flush()
  assert.equal(fs.existsSync(path.join(root, 'usage')), false)
})

test('a month reads back as written', () => {
  const m = { days: new Map([['2026-10-25', { d: '2026-10-25', wifi: 7, via: 3 }]]), hours: new Map([['2026-10-25T10|wifi', 7]]), events: [{ at: '2026-10-25T10:00:00+03:00', event: 'drop-wifi', secs: 40, note: 'Home' }] }
  assert.deepEqual(parseMonth(monthText(m)), m)
})
