'use strict'
// Data's counter on the computer (datacount.js): the deltas, a counter that went back, the files the phone reads.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DataCounter, parseIw, parseMonth, monthText, reach } = require('../datacount')

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
  assert.deepEqual(m.days.get('2026-10-25'), { d: '2026-10-25', wifi: 5800, via: 300, eth: 40 }) // the cable counted apart
  assert.equal(m.hours.get('2026-10-25T10|wifi'), 5500)
  assert.equal(m.hours.get('2026-10-25T10|wired'), 40)
})

test("Tetra's own sync over the hotspot is not counted as using it", async () => {
  const { c, root, set } = counter()
  c.onHotspot = true
  const t = new Date(2026, 9, 25, 12, 0, 0)
  set({ wlan0: { rx: 0, tx: 0, wireless: true } }); await c.tick(t)
  c.own(4000) // a sync with the phone closed
  set({ wlan0: { rx: 9000, tx: 1000, wireless: true } }); await c.tick(t)
  c.flush(t)
  const m = parseMonth(fs.readFileSync(path.join(root, 'usage', '2026-10.my-pc.jsonl'), 'utf8'))
  assert.deepEqual(m.days.get('2026-10-25'), { d: '2026-10-25', wifi: 10000, via: 6000 })
  assert.match(fs.readFileSync(path.join(root, 'usage', '2026-10.my-pc.jsonl'), 'utf8'), /^\{"deviceName":"my-pc"\}/)
})

test('no Data folder until Data is set up', async () => {
  const { c, root, set } = counter(false)
  set({ wlan0: { rx: 1, tx: 0, wireless: true } }); await c.tick(); await c.tick(); c.flush()
  assert.equal(fs.existsSync(path.join(root, 'usage')), false)
})

test('a month reads back as written', () => {
  const m = { days: new Map([['2026-10-25', { d: '2026-10-25', wifi: 7, via: 3 }]]), hours: new Map([['2026-10-25T10|wifi', 7]]), events: [{ at: '2026-10-25T10:00:00+03:00', event: 'drop-wifi', secs: 40, note: 'Home' }], apps: new Map([['2026-10-25|Chrome|wifi', 5]]) }
  assert.deepEqual(parseMonth(monthText(m)), m)
})

test('each program\'s bytes from ss, and what TCP did not show as Other', async () => {
  const { c, root, set } = counter()
  c.onHotspot = true
  const ss = (a, b) => `0 0 10.0.0.2:5000 1.2.3.4:443 users:(("chrome",pid=10,fd=3))\n\t cubic bytes_acked:${a} bytes_received:${b} segs_out:1\n` +
    `0 0 10.0.0.2:5001 5.6.7.8:443 users:(("Viber",pid=11,fd=4))\n\t cubic bytes_acked:100 bytes_received:900\n`
  const t = new Date(2026, 9, 25, 12, 0, 0)
  set({ wlan0: { rx: 0, tx: 0, wireless: true } }); await c.sampleApps(ss(0, 0)); await c.tick(t)
  await c.sampleApps(ss(1000, 4000)) // Chrome: 5000 since; Viber: the 1000 its first look found
  set({ wlan0: { rx: 9000, tx: 1000, wireless: true } }); await c.tick(t)
  c.flush(t)
  const text = fs.readFileSync(path.join(root, 'usage', '2026-10.my-pc.jsonl'), 'utf8')
  const apps = text.split('\n').filter(l => l.includes('"app"')).map(l => JSON.parse(l))
  assert.deepEqual(apps.map(a => [a.app, a.net, a.fg]).sort(), [['Chrome', 'hotspot', 5000], ['Viber', 'hotspot', 1000], ['other', 'hotspot', 4000]])
  assert.equal(apps.find(a => a.app === 'other').name, 'Other (calls, video, UDP)')
})

test('this computer, the local network, the internet', () => {
  assert.equal(reach('127.0.0.1:5037'), 'self'); assert.equal(reach('[::1]:5277'), 'self')
  assert.equal(reach('10.71.129.171:43180'), 'lan'); assert.equal(reach('192.168.1.19:443'), 'lan'); assert.equal(reach('[fe80::1%wlan0]:80'), 'lan')
  assert.equal(reach('172.217.168.129:443'), 'internet'); assert.equal(reach('[2a00:1450::1]:443'), 'internet')
})

test('the cleanup: sync copies, half-written files, and the detail of old months go', () => {
  const { c, root } = counter()
  const dir = path.join(root, 'usage'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-10.phone (2).jsonl'), 'x'); fs.writeFileSync(path.join(dir, '.2026-10.my-pc.jsonl.tmp'), 'x')
  fs.writeFileSync(path.join(dir, '2024-01.my-pc.jsonl'), '{"d":"2024-01-02","mobile":0,"wifi":5,"roam":0,"hotspot":0,"via":0}\n{"h":"2024-01-02T10","net":"wifi","bytes":5}\n{"d":"2024-01-02","app":"Chrome","name":"Chrome","net":"wifi","fg":5,"bg":0,"roam":0}\n')
  fs.writeFileSync(path.join(dir, '2026-10.phone.jsonl'), 'kept')
  c.clean(new Date(2026, 9, 25))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2024-01.my-pc.jsonl', '2026-10.phone.jsonl'])
  assert.equal(fs.readFileSync(path.join(dir, '2024-01.my-pc.jsonl'), 'utf8'), '{"deviceName":"my-pc"}\n{"d":"2024-01-02","mobile":0,"wifi":5,"roam":0,"hotspot":0,"via":0}\n')
})

test('the newest of a month and sync\'s copies of it is read, and only older copies go', () => {
  const { c, root } = counter()
  const dir = path.join(root, 'usage'); fs.mkdirSync(dir, { recursive: true })
  const month = (today, counted) => `{"deviceName":"Phone"${counted ? `,"counted":${counted}` : ''}}\n{"d":"2026-10-24","mobile":9,"wifi":0}\n{"d":"2026-10-25","mobile":${today},"wifi":0}\n`
  // 25 Oct: the phone's month stuck at 10:00 here, every newer one a copy ("(2)", "(2) (3)")
  fs.writeFileSync(path.join(dir, '2026-10.phone.jsonl'), month(1)); fs.writeFileSync(path.join(dir, '2026-10.phone (2).jsonl'), month(3))
  fs.writeFileSync(path.join(dir, '2026-10.phone (2) (3).jsonl'), month(4))
  const today = () => c.all().devices.phone.find(l => l.d === '2026-10-25').mobile
  assert.equal(today(), 4)
  c.clean(new Date(2026, 9, 25))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10.phone (2) (3).jsonl', '2026-10.phone.jsonl']) // the newest copy waits for its month
  fs.writeFileSync(path.join(dir, '2026-10.phone.jsonl'), month(4, 2000)) // the month arrives, stamped
  assert.equal(c.all().devices.phone.find(l => l.counted).counted, 2000)
  c.clean(new Date(2026, 9, 25))
  assert.deepEqual(fs.readdirSync(dir), ['2026-10.phone.jsonl'])
})

test('of two plans with one rev, the phone\'s wins, and takes plan.json\'s place', () => {
  const { c, root } = counter(false)
  const dir = path.join(root, 'usage'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-10.PHONE.jsonl'), '{"d":"2026-10-25","mobile":5,"wifi":0}\n')
  fs.writeFileSync(path.join(dir, '2026-10.TABLET.jsonl'), '{"d":"2026-10-25","mobile":0,"wifi":9}\n')
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ rev: 1, by: 'TABLET', carrier: { offset: 121 } }))
  fs.writeFileSync(path.join(root, 'plan (2) (2).json'), JSON.stringify({ rev: 1, by: 'PHONE', carrier: { offset: -7 } }))
  assert.equal(c.all().plan.by, 'PHONE')
  c.clean(new Date(2026, 9, 25))
  assert.deepEqual(fs.readdirSync(root).sort(), ['plan.json', 'usage'])
  assert.equal(c.all().plan.carrier.offset, -7)
})
