'use strict'
// Data on the computer (Drive-Android Plan.md § Data): this computer's own counts from Linux's network counters, written
// as its month files in .System/Data/Shared/usage (the phone's and the tablet's come there with sync), its Wi-Fi signal for the
// phone's "Phone as hotspot", and a speed test the phone runs against it. Per program: each TCP connection's bytes as `ss` shows
// them for this user's programs (no root); what TCP does not carry (calls, video over UDP, QUIC) is "Other".
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

/** A program's name as people know it (ss gives the process's). */
const PROGRAMS = { chrome: 'Chrome', chromium: 'Chromium', 'firefox-bin': 'Firefox', firefox: 'Firefox', claude: 'Claude', 'claude-desktop': 'Claude', 'thunderbird-bin': 'Thunderbird',
  thunderbird: 'Thunderbird', Viber: 'Viber', megasync: 'MEGA', teams: 'Teams', 'teams-for-linux': 'Teams', zoom: 'Zoom', spotify: 'Spotify', 'local-drive-des': 'Tetra', code: 'VS Code' }
const programName = raw => PROGRAMS[raw] || raw.replace(/-bin$/, '').replace(/^./, c => c.toUpperCase())

/** `ss -tinpH`: each connection (its two ends and its process) with the bytes it carried, both ways, so far. */
function parseSs(text) {
  const out = new Map()
  let head = null
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('\t') && !line.startsWith(' ') && line.trim()) {
      const m = /^\S+\s+\S+\s+(\S+)\s+(\S+)\s+users:\(\("([^"]+)",pid=(\d+)/.exec(line.trim())
      head = m ? { key: `${m[1]}|${m[2]}|${m[4]}`, name: m[3], peer: m[2] } : null
    } else if (head) {
      const acked = /bytes_acked:(\d+)/.exec(line), received = /bytes_received:(\d+)/.exec(line)
      out.set(head.key, { name: head.name, peer: head.peer, bytes: (acked ? Number(acked[1]) : 0) + (received ? Number(received[1]) : 0) })
      head = null
    }
  }
  return out
}

/** Where a connection goes: this computer itself (adb, the head unit: not on any network), the local network (the phone, the
 * tablet, a printer: never on the mobile data), or the internet. */
function reach(peer) {
  const p = String(peer) // "1.2.3.4:443", "[2a00::1]:443"
  const host = (p.startsWith('[') ? p.slice(1, p.indexOf(']')) : p.replace(/:\d+$/, '')).replace(/^::ffff:/, '').replace(/%.*$/, '')
  if (/^127\./.test(host) || host === '::1') return 'self'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || /^f[cde]/i.test(host)) return 'lan'
  return 'internet'
}

/** A month file's lines, as the phone's DataFiles writes them. */
function monthText(m, name = '') {
  const days = [...m.days.values()].sort((a, b) => a.d.localeCompare(b.d)).map(d => JSON.stringify({ d: d.d, mobile: 0, wifi: d.wifi, roam: 0, hotspot: 0, via: d.via, ...(d.eth ? { eth: d.eth } : {}) }))
  const hours = [...m.hours.entries()].sort().map(([k, b]) => { const [h, net] = k.split('|'); return JSON.stringify({ h, net, bytes: b }) })
  const events = m.events.slice().sort((a, b) => a.at.localeCompare(b.at)).map(e => JSON.stringify({ at: e.at, event: e.event, secs: e.secs, ...(e.note ? { note: e.note } : {}) }))
  const apps = [...(m.apps || new Map()).entries()].sort().map(([k, b]) => { const [d, app, net] = k.split('|'); return JSON.stringify({ d, app, name: app === 'other' ? 'Other (calls, video, UDP)' : app, net, fg: b, bg: 0, roam: 0 }) })
  return [...(name ? [JSON.stringify({ deviceName: name })] : []), ...days, ...hours, ...apps, ...events].map(l => l + '\n').join('')
}

function parseMonth(text) {
  const m = { days: new Map(), hours: new Map(), events: [], apps: new Map() }
  for (const l of String(text).split('\n')) {
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.event) m.events.push({ at: o.at, event: o.event, secs: o.secs || 0, note: o.note || '' })
    else if (o.deviceName) continue
    else if (o.app) m.apps.set(`${o.d}|${o.app}|${o.net}`, (Number(o.fg) || 0) + (Number(o.bg) || 0))
    else if (o.h) m.hours.set(`${o.h}|${o.net}`, Number(o.bytes) || 0)
    else if (o.d && !o.app) m.days.set(o.d, { d: o.d, wifi: Number(o.wifi) || 0, via: Number(o.via) || 0, ...(o.eth ? { eth: Number(o.eth) } : {}) })
  }
  return m
}

// a device's month, "2026-10.24129PN74G.jsonl", and sync's copies of one changed on both sides at once ("… (2).jsonl", "… (2) (3).jsonl")
const MONTH = /^(\d{4}-\d{2})\.([^ ()]+)((?: \(\d+\))*)\.jsonl$/

/** How far a version of a month goes: when it was counted, else its last day and that day's counts, then its last hour. */
function reachOf(lines) {
  const days = lines.filter(l => l.d && !l.app && !l.event), last = days.reduce((a, l) => (!a || l.d > a.d ? l : a), null)
  return [Math.max(0, ...lines.filter(l => l.deviceName !== undefined).map(l => Number(l.counted) || 0)), last?.d || '',
    last ? (Number(last.mobile) || 0) + (Number(last.wifi) || 0) + (Number(last.eth) || 0) : 0, lines.reduce((a, l) => (l.h && l.h > a ? l.h : a), '')]
}
/** [a] is a newer version of a device's month than [b] (the phone's DataFiles.newer). */
const newer = (a, b) => { const x = reachOf(a), y = reachOf(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }

/**
 * Each device's months, the newest version of each (the file itself or one of sync's copies of it) and the other versions. Not
 * always the file: on 25 Oct this computer's copy of the phone's month stayed at 10:00 while every newer one came as "(2)",
 * "(2) (3)"… (41 % on the phone, 40 here), and the copies were removed unread.
 */
function versions(dir) {
  const groups = new Map()
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  for (const n of names) {
    const m = MONTH.exec(n)
    if (m) { const k = `${m[1]}.${m[2]}`; if (!groups.has(k)) groups.set(k, { device: m[2], files: [] }); groups.get(k).files.push(n) }
  }
  return [...groups.values()].map(({ device, files }) => {
    let best = null
    for (const n of files.sort((a, b) => a.length - b.length)) { // the month itself first: it stays on a tie
      let lines
      try { lines = fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { continue }
      if (!best || newer(lines, best.lines)) best = { n, lines }
    }
    return { device, lines: best?.lines ?? [], others: files.filter(n => n !== best?.n) }
  })
}

/**
 * The plan: plan.json or one of sync's copies of it, the highest `rev`; on a tie the one written by the device with mobile data
 * (25 Oct: the tablet's own Setup, rev 1 like the phone's, with the carrier's figure as its offset — 83 % there, 41 % on the phone).
 */
function plans(root, months) {
  let names = []
  try { names = fs.readdirSync(root).filter(n => /^plan((?: \(\d+\))*)\.json$/.test(n)).sort((a, b) => a.length - b.length) } catch {}
  const found = names.map(n => { try { return { n, plan: JSON.parse(fs.readFileSync(path.join(root, n), 'utf8')) } } catch { return null } }).filter(Boolean)
  if (new Set(found.map(f => `${f.plan.rev}|${f.plan.by}`)).size <= 1) return found
  const mobile = {}
  for (const v of months ?? versions(path.join(root, 'usage'))) mobile[v.device] = (mobile[v.device] || 0) + v.lines.reduce((s, l) => s + (l.d && !l.app ? Number(l.mobile) || 0 : 0), 0)
  return found.sort((a, b) => (b.plan.rev || 0) - (a.plan.rev || 0) || (mobile[b.plan.by] || 0) - (mobile[a.plan.by] || 0)) // stable: plan.json first on a tie
}

class DataCounter {
  constructor(root, device) {
    this.root = root
    this.name = String(device || 'Computer')
    this.device = this.name.replace(/[^\p{L}\p{N}_-]/gu, '') || 'Computer'
    this.last = null // { at, ifaces: { name: { rx, tx, wireless } } }
    this.pending = new Map() // month → parsed month, written every ten minutes
    this.link = null // { iface, metered, ssid, since }
    this.lostAt = 0
    this.ownBytes = 0 // Tetra's own sync with the phone over its hotspot: on the LAN, never on the mobile network
    this.sockets = new Map() // each TCP connection's bytes at the last look
    this.appBytes = new Map() // program → bytes since the last minute
  }

  /** A look at the connections (every 15 s: a short one is caught before it closes): what each program carried since. */
  async sampleApps(text) {
    const now = parseSs(text ?? await run('ss', ['-tinpH', 'state', 'established']))
    for (const [key, s] of now) {
      const before = this.sockets.get(key)?.bytes ?? 0
      const delta = s.bytes >= before ? s.bytes - before : s.bytes
      const where = reach(s.peer)
      if (delta <= 0 || where === 'self') continue
      // to the local network (the phone, the tablet): never through the mobile data, so Wi-Fi even over the hotspot
      const slot = `${programName(s.name)}${where === 'lan' ? '|lan' : ''}`
      this.appBytes.set(slot, (this.appBytes.get(slot) || 0) + delta)
    }
    this.sockets = now
  }

  /** A sync connection closed: its bytes are Tetra's own, left out of what this computer used over the phone's hotspot. */
  own(n) { this.ownBytes += n }

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

  /** A cable plugged in: the first wired, physical interface that is up, and its speed (Mb/s) as the card says it. */
  ethernet() {
    const base = '/sys/class/net'
    let names = []
    try { names = fs.readdirSync(base) } catch { return null }
    for (const n of names) {
      if (n === 'lo' || /^(docker|veth|br-|virbr|tun|tap|wg)/.test(n)) continue
      const p = f => { try { return fs.readFileSync(path.join(base, n, f), 'utf8').trim() } catch { return '' } }
      if (fs.existsSync(path.join(base, n, 'wireless')) || fs.existsSync(path.join(base, n, 'phy80211')) || !fs.existsSync(path.join(base, n, 'device'))) continue
      if (p('operstate') === 'up' && p('carrier') === '1') return { iface: n, speed: Math.max(0, Number(p('speed')) || 0) }
    }
    return null
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
    for (const { bytes, net, via, viaBytes } of deltas) {
      if (!bytes) continue
      m.hours.set(`${hourKey(now)}|${net}`, (m.hours.get(`${hourKey(now)}|${net}`) || 0) + bytes)
      if (net === 'wifi') { d.wifi += bytes; if (via) d.via += viaBytes ?? bytes }
      else d.eth = (d.eth || 0) + bytes // the cable: counted apart (the user, 25 Oct: "recognize when I connect ethernet")
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
      // over the hotspot, Tetra's own sync (to the phone itself) is taken off what went through it
      for (const d of deltas) if (d.via) { const own = Math.min(this.ownBytes, d.bytes); d.viaBytes = d.bytes - own; this.ownBytes -= own }
      this.ownBytes = 0
      this.add(now, deltas)
      // the programs' share of this minute, on the link it went over; what TCP did not show is "other"
      const kind = metered ? 'hotspot' : link ? 'wifi' : this.ethernet() ? 'wired' : 'wifi'
      const total = deltas.reduce((s, d) => s + d.bytes, 0)
      let named = 0
      const m = this.month(hourKey(now).slice(0, 7)); m.apps ||= new Map()
      const day = hourKey(now).slice(0, 10)
      for (const [key, b] of this.appBytes) {
        const [app, lan] = key.split('|')
        const net = lan ? (kind === 'wired' ? 'wired' : 'wifi') : kind
        m.apps.set(`${day}|${app}|${net}`, (m.apps.get(`${day}|${app}|${net}`) || 0) + b); named += b
      }
      if (total > named) m.apps.set(`${day}|other|${kind}`, (m.apps.get(`${day}|other|${kind}`) || 0) + total - named)
      this.appBytes.clear()
    }
    // a drop: the Wi-Fi gone and back within ten minutes (longer is leaving)
    if (!link && this.link) this.lostAt = now.getTime()
    if (link && !this.link && this.lostAt) {
      const secs = Math.round((now.getTime() - this.lostAt) / 1000)
      if (secs >= 5 && secs <= 600) this.note({ at: localIso(new Date(this.lostAt)), event: metered ? 'left-hotspot' : 'drop-wifi', secs, note: link.ssid })
      this.lostAt = 0
    }
    this.link = link ? { ...link, iface: wifi, metered } : null
    // a cable plugged in or out: a line in the month (not a drop), so the page can say when the computer was on Ethernet
    const eth = this.ethernet()
    if (this.started && !!eth !== !!this.eth) this.note({ at: localIso(now), event: eth ? 'ethernet-on' : 'ethernet-off', secs: 0, note: eth ? `${eth.speed} Mb/s` : '' })
    this.eth = eth; this.started = true
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
        const text = monthText(m, this.name)
        let old = ''
        try { old = fs.readFileSync(f, 'utf8') } catch {}
        // beside it under a dot name (sync passes those by), then renamed over
        const tmp = path.join(path.dirname(f), `.${path.basename(f)}.tmp`)
        if (old !== text) { fs.writeFileSync(tmp, text); fs.renameSync(tmp, f); this.changed?.() }
      } catch (e) { console.log('[data] not written:', e.message) }
    }
    // only this month stays in memory
    const keep = hourKey(now).slice(0, 7)
    for (const k of [...this.pending.keys()]) if (k !== keep) this.pending.delete(k)
  }

  /**
   * Nothing left behind (the user, 25 Oct): sync's copies of the months (but one newer than its month, until the month catches up),
   * half-written files of an interrupted write, and — after
   * 13 months — this computer's per-program and hourly detail of a month (its days stay).
   */
  clean(now = new Date()) {
    const dir = path.join(this.root, 'usage')
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    const old = hourKey(new Date(now.getFullYear(), now.getMonth() - 13, 1)).slice(0, 7)
    for (const v of versions(dir)) for (const n of v.others) if (MONTH.exec(n)[3]) try { fs.unlinkSync(path.join(dir, n)) } catch {}
    // the plan's copies: the winning plan in plan.json's place (any device may change the plan, so all agree after)
    const p = plans(this.root)
    try { if (p[0] && p[0].n !== 'plan.json') fs.copyFileSync(path.join(this.root, p[0].n), path.join(this.root, 'plan.json')) } catch {}
    for (const { n } of p) if (n !== 'plan.json') try { fs.unlinkSync(path.join(this.root, n)) } catch {}
    for (const n of names) {
      const f = path.join(dir, n)
      try {
        if (/\.tmp$/.test(n)) fs.unlinkSync(f)
        else if (n.endsWith(`.${this.device}.jsonl`) && n.slice(0, 7) < old) {
          const m = parseMonth(fs.readFileSync(f, 'utf8'))
          if (m.apps.size || m.hours.size) { m.apps.clear(); m.hours.clear(); fs.writeFileSync(f, monthText(m, this.name)) }
        }
      } catch {}
    }
  }

  start() {
    this.clean()
    this.tick().catch(() => {}); this.timer = setInterval(() => this.tick().catch(() => {}), 60_000)
    this.sampleApps().catch(() => {}); this.appTimer = setInterval(() => this.sampleApps().catch(() => {}), 15_000)
  }
  stop() { clearInterval(this.timer); clearInterval(this.appTimer); try { this.flush() } catch {} }

  /** What this computer's Wi-Fi is now, for the phone's "Phone as hotspot". */
  async wifi() {
    const ifaces = this.readCounters()
    const w = Object.keys(ifaces).find(n => ifaces[n].wireless)
    const link = w ? parseIw(await run('iw', ['dev', w, 'link'])) : null
    const ethernet = this.ethernet()
    if (!link && !ethernet) return { error: 'This computer is on neither Wi-Fi nor a cable.' }
    return { ...(link || {}), ...(ethernet ? { ethernet } : {}) }
  }

  /** Every device's months and the plan, for the Data page. */
  all() {
    const out = { plan: null, devices: {}, me: this.device }
    const months = versions(path.join(this.root, 'usage'))
    for (const v of months) (out.devices[v.device] ||= []).push(...v.lines)
    out.plan = plans(this.root, months)[0]?.plan ?? null
    return out
  }
}

module.exports = { DataCounter, versions, plans, parseIw, parseMonth, monthText, hourKey, parseSs, programName, reach }
