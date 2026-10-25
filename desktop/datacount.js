'use strict'
// Data on the computer (Drive-Android Plan.md § Data): this computer's own counts from Linux's network counters, written
// as its month files in Files/Data/usage (the phone's and the tablet's come there with sync), its Wi-Fi signal for the
// phone's "Phone as hotspot", and a speed test the phone runs against it. Per program counts need root on Linux: not done.
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const run = (cmd, args) => new Promise(res => execFile(cmd, args, { timeout: 3000 }, (e, out) => res(e ? '' : String(out))))
const pad = n => String(n).padStart(2, '0')
const hourKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`
const localIso = d => { const o = -d.getTimezoneOffset(); return `${hourKey(d)}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${o >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}` }

/** "signal: -58 dBm", "tx bitrate: 433.3 MBit/s", "SSID: x", "freq: 5180" from `iw dev <if> link`. */
function parseIw(text) {
  if (!/Connected to/.test(text)) return null
  const n = re => { const m = re.exec(text); return m ? Number(m[1]) : 0 }
  return { rssi: n(/signal:\s*(-?\d+)/), speed: Math.round(n(/tx bitrate:\s*([\d.]+)/)), mhz: Math.round(n(/freq:\s*([\d.]+)/)), ssid: (/SSID:\s*(.+)/.exec(text) || [])[1]?.trim() || '' }
}

/** A month file's lines, as the phone's DataFiles writes them. */
function monthText(m) {
  const days = [...m.days.values()].sort((a, b) => a.d.localeCompare(b.d)).map(d => JSON.stringify({ d: d.d, mobile: 0, wifi: d.wifi, roam: 0, hotspot: 0, via: d.via }))
  const hours = [...m.hours.entries()].sort().map(([k, b]) => { const [h, net] = k.split('|'); return JSON.stringify({ h, net, bytes: b }) })
  const events = m.events.slice().sort((a, b) => a.at.localeCompare(b.at)).map(e => JSON.stringify({ at: e.at, event: e.event, secs: e.secs, ...(e.note ? { note: e.note } : {}) }))
  return [...days, ...hours, ...events].map(l => l + '\n').join('')
}

function parseMonth(text) {
  const m = { days: new Map(), hours: new Map(), events: [] }
  for (const l of String(text).split('\n')) {
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.event) m.events.push({ at: o.at, event: o.event, secs: o.secs || 0, note: o.note || '' })
    else if (o.h) m.hours.set(`${o.h}|${o.net}`, Number(o.bytes) || 0)
    else if (o.d && !o.app) m.days.set(o.d, { d: o.d, wifi: Number(o.wifi) || 0, via: Number(o.via) || 0 })
  }
  return m
}

class DataCounter {
  constructor(root, device) {
    this.root = root
    this.device = String(device || 'Computer').replace(/[^\p{L}\p{N}_-]/gu, '') || 'Computer'
    this.last = null // { at, ifaces: { name: { rx, tx, wireless } } }
    this.pending = new Map() // month → parsed month, written every ten minutes
    this.link = null // { iface, metered, ssid, since }
    this.lostAt = 0
  }

  /** Every interface but loopback and virtual ones: its bytes and whether it is Wi-Fi. */
  readCounters() {
    const base = '/sys/class/net'
    const out = {}
    let names = []
    try { names = fs.readdirSync(base) } catch { return out }
    for (const n of names) {
      if (n === 'lo' || /^(docker|veth|br-|virbr|tun|tap|wg)/.test(n)) continue
      try {
        const rx = Number(fs.readFileSync(path.join(base, n, 'statistics/rx_bytes'), 'utf8'))
        const tx = Number(fs.readFileSync(path.join(base, n, 'statistics/tx_bytes'), 'utf8'))
        out[n] = { rx, tx, wireless: fs.existsSync(path.join(base, n, 'wireless')) || fs.existsSync(path.join(base, n, 'phy80211')) }
      } catch {}
    }
    return out
  }

  /** NetworkManager says a Wi-Fi is metered when it is an Android hotspot (it sends that over DHCP), so: on the phone's hotspot. */
  async metered(iface) { return /yes/.test(await run('nmcli', ['-g', 'GENERAL.METERED', 'device', 'show', iface])) }

  month(key) {
    if (!this.pending.has(key)) {
      let text = ''
      try { text = fs.readFileSync(this.file(key), 'utf8') } catch {}
      this.pending.set(key, parseMonth(text))
    }
    return this.pending.get(key)
  }
  file(key) { return path.join(this.root, 'usage', `${key}.${this.device}.jsonl`) }

  /** Bytes since the last tick, added to this hour and day; a counter that went back (a restart) counts from zero. */
  add(now, deltas) {
    const m = this.month(hourKey(now).slice(0, 7))
    const day = hourKey(now).slice(0, 10)
    const d = m.days.get(day) || { d: day, wifi: 0, via: 0 }
    for (const { bytes, net, via } of deltas) {
      if (!bytes) continue
      m.hours.set(`${hourKey(now)}|${net}`, (m.hours.get(`${hourKey(now)}|${net}`) || 0) + bytes)
      if (net === 'wifi') { d.wifi += bytes; if (via) d.via += bytes }
    }
    m.days.set(day, d)
  }

  note(event) { this.month(event.at.slice(0, 7)).events.push(event) }

  /** One look (each minute): the counters, the link, and drops off the Wi-Fi or the phone's hotspot. */
  async tick(now = new Date()) {
    const ifaces = this.readCounters()
    const wifi = Object.keys(ifaces).find(n => ifaces[n].wireless)
    const link = wifi ? parseIw(await run('iw', ['dev', wifi, 'link'])) : null
    const metered = wifi ? await this.metered(wifi) : false
    if (this.last) {
      const deltas = Object.entries(ifaces).map(([n, c]) => {
        const p = this.last.ifaces[n]
        const total = c.rx + c.tx, before = p ? p.rx + p.tx : total
        return { bytes: total >= before ? total - before : total, net: c.wireless ? 'wifi' : 'wired', via: c.wireless && metered }
      })
      this.add(now, deltas)
    }
    // a drop: the Wi-Fi gone and back within ten minutes (longer is leaving)
    if (!link && this.link) this.lostAt = now.getTime()
    if (link && !this.link && this.lostAt) {
      const secs = Math.round((now.getTime() - this.lostAt) / 1000)
      if (secs >= 5 && secs <= 600) this.note({ at: localIso(new Date(this.lostAt)), event: metered ? 'left-hotspot' : 'drop-wifi', secs, note: link.ssid })
      this.lostAt = 0
    }
    this.link = link ? { ...link, iface: wifi, metered } : null
    this.last = { at: now.getTime(), ifaces }
    if (!this.flushedAt || now.getTime() - this.flushedAt >= 10 * 60_000) this.flush(now)
  }

  /** The months written (beside, then renamed over: sync never reads half of one). */
  flush(now = new Date()) {
    this.flushedAt = now.getTime()
    // nothing written until Data is set up (its plan.json, from the phone): a computer that does not use it gets no Data folder
    if (!fs.existsSync(path.join(this.root, 'plan.json'))) return
    for (const [key, m] of this.pending) {
      const f = this.file(key)
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        const text = monthText(m)
        let old = ''
        try { old = fs.readFileSync(f, 'utf8') } catch {}
        if (old !== text) { fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); this.changed?.() }
      } catch (e) { console.log('[data] not written:', e.message) }
    }
    // only this month stays in memory
    const keep = hourKey(now).slice(0, 7)
    for (const k of [...this.pending.keys()]) if (k !== keep) this.pending.delete(k)
  }

  start() { this.tick().catch(() => {}); this.timer = setInterval(() => this.tick().catch(() => {}), 60_000) }
  stop() { clearInterval(this.timer); try { this.flush() } catch {} }

  /** What this computer's Wi-Fi is now, for the phone's "Phone as hotspot". */
  async wifi() {
    const ifaces = this.readCounters()
    const w = Object.keys(ifaces).find(n => ifaces[n].wireless)
    if (!w) return { error: 'This computer has no Wi-Fi.' }
    const link = parseIw(await run('iw', ['dev', w, 'link']))
    return link || { error: 'This computer is not on Wi-Fi.' }
  }

  /** Every device's months and the plan, for the Data page. */
  all() {
    const out = { plan: null, devices: {}, me: this.device }
    try { out.plan = JSON.parse(fs.readFileSync(path.join(this.root, 'plan.json'), 'utf8')) } catch {}
    let names = []
    try { names = fs.readdirSync(path.join(this.root, 'usage')) } catch {}
    for (const n of names) {
      const m = /^(\d{4}-\d{2})\.(.+)\.jsonl$/.exec(n)
      if (!m) continue
      let text = ''
      try { text = fs.readFileSync(path.join(this.root, 'usage', n), 'utf8') } catch { continue }
      const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      ;(out.devices[m[2]] ||= []).push(...lines)
    }
    return out
  }
}

module.exports = { DataCounter, parseIw, parseMonth, monthText, hourKey }
