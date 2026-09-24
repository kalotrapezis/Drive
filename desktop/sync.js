// Phone → desktop sync server (SYNC_PLAN.md phase 6). HTTPS with a self-signed certificate that the phone pins by
// its SHA-256 fingerprint (from the pairing QR); a one-time pairing code becomes a per-phone bearer token.
// Photos arrive as a stream, are hashed while written to a .part file, and only a matching SHA-256 becomes a file
// and a receipt. Nothing here ever deletes or overwrites.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const dgram = require('node:dgram')
const crypto = require('node:crypto')
const library = require('./library')
const drives = require('./drives')

const PORT = 43180
const BEACON_PORT = 43181
/** The pictures a device may be drawn with. `device` is a phone; the rest are for what this app will meet later. */
const DEVICE_KINDS = ['device', 'tablet', 'computer', 'server', 'database']
/** What to call this machine in a sentence, once it has said what it is. */
const SELF_LABEL = { device: 'this phone', tablet: 'this tablet', computer: 'this PC', server: 'this server', database: 'this storage' }

const PAIRING_MS = 10 * 60 * 1000
const MAX_HAVE = 5000
const MAX_KNOWN = 50000 // the phone's whole library in one question; chunking it would change the answer
const MAX_SEND = 2000 // one answer's worth; the next sync continues where this one stopped
const CONTENTS = ['photos', 'files']
const DIRECTIONS = ['off', 'send', 'receive', 'both']
const KEEPS = ['everything', 'nothing']
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const isHash = h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)
const safeRel = rel => typeof rel === 'string' && rel.length < 512 && !rel.startsWith('/') && rel.split('/').every(p => p !== '.' && p !== '..') && !/[\\\0]/.test(rel)
const safeName = n => typeof n === 'string' && n.length > 0 && n.length < 256 && !/[/\\\0]/.test(n) && n !== '.' && n !== '..'

async function identity(dir) {
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem')
  if (!fs.existsSync(keyFile)) {
    const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'Tetra' }], { keySize: 2048, days: 3650, algorithm: 'sha256' })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 })
    fs.writeFileSync(certFile, pems.cert)
  }
  const cert = fs.readFileSync(certFile, 'utf8')
  return { key: fs.readFileSync(keyFile, 'utf8'), cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase() }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address)
}

class SyncServer {
  /** onReceived(receipt) runs after each verified file (e.g. to schedule a rescan). */
  constructor({ db, documents, people, files, dataDir, photosRoot, onReceived = () => {}, port = PORT, beaconPort = BEACON_PORT }) {
    Object.assign(this, { db, documents, people, files, dataDir, photosRoot, onReceived, port, beaconPort })
    this.codes = new Map() // every code on screen stays valid until used or expired
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sync_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER);
      -- Who still HOLDS what, as opposed to who once sent it (sync_receipts). Every sync already tells this
      -- computer the answer — /have and /library/manifest are a device listing what it has — and until now it
      -- was read once and thrown away. Without it there is no way to ask "how many copies of this exist",
      -- which is the whole safety of releasing a file (SYNC_PLAN.md 6ac condition 2).
      CREATE TABLE IF NOT EXISTS device_holdings (device_id TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
        seen_at INTEGER NOT NULL, PRIMARY KEY(device_id, kind, sha256));
      -- "Who else holds this photo" is asked per photo by the Devices overview; without this it scanned every
      -- holding for every photo, 1.2 s a call at 4,000 photos, and the page asks every 3 s — the window froze.
      CREATE INDEX IF NOT EXISTS device_holdings_sha ON device_holdings(sha256, kind);
      CREATE TABLE IF NOT EXISTS sync_receipts (device_id TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(device_id, sha256));`)
    // Drive files are received too now, and the Devices page counts them apart from photos.
    if (!db.prepare('PRAGMA table_info(sync_receipts)').all().some(c => c.name === 'kind')) db.exec("ALTER TABLE sync_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'")
    // What each device does with each kind of content, and in which direction (SYNC_PLAN.md 6j). The computer
    // owns this table because it is the one device every other one reaches; a phone reads its rows at sync time
    // and obeys them. Direction is written from the *device's* point of view, because the device is the reader:
    // 'send' is phone → computer, 'receive' is computer → phone, 'both' is both.
    db.exec(`CREATE TABLE IF NOT EXISTS sync_connections (device_id TEXT NOT NULL, content TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'both', keep TEXT NOT NULL DEFAULT 'everything', updated_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, content));`)
    // A phone now says who it is when it pairs — its own certificate, port and a token to send it — so that this
    // computer can one day start a sync instead of only answering one. Older pairings simply leave these null.
    const columns = db.prepare('PRAGMA table_info(sync_devices)').all().map(c => c.name)
    for (const [name, type] of [['peer_fp', 'TEXT'], ['peer_hosts', 'TEXT'], ['peer_port', 'INTEGER'], ['peer_token', 'TEXT']]) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE sync_devices ADD COLUMN ${name} ${type}`)
    }
    // What a device says about the files it holds. A hash cannot be read, sized or drawn on a chart, and for a
    // file this computer has never been given the hash is all it had (SYNC_PLAN.md 6ae). Null for an older
    // device, or for one that has not synced since this arrived.
    // What picture to draw for a device, and what to call it. Both are the person's to change (6af); `kind`
    // starts from the width the device reported when it paired, because Android already answers phone-or-tablet.
    if (!columns.includes('kind')) db.exec('ALTER TABLE sync_devices ADD COLUMN kind TEXT')
    // A drive is not reached over a network, so it has none of the peer columns: it is known by the UUID of
    // its filesystem, because a mount point moves and a disk does not (SYNC_PLAN.md D5).
    if (!columns.includes('volume_uuid')) db.exec('ALTER TABLE sync_devices ADD COLUMN volume_uuid TEXT')
    // Nothing crosses until someone has said what should cross. A device paired straight into "Send & receive"
    // and started uploading its whole camera roll before anyone could stop it (24 September, the tablet), so a
    // new device now waits here, with every row Off, until the rules are answered (SYNC_PLAN.md 6aj).
    if (!columns.includes('set_up_at')) {
      db.exec('ALTER TABLE sync_devices ADD COLUMN set_up_at INTEGER')
      db.exec('UPDATE sync_devices SET set_up_at = paired_at')  // everything paired before this was set up by hand
    }
    const held = db.prepare('PRAGMA table_info(device_holdings)').all().map(c => c.name)
    for (const [name, type] of [['name', 'TEXT'], ['size', 'INTEGER'], ['is_video', 'INTEGER'], ['taken_at', 'INTEGER']]) {
      if (!held.includes(name)) db.exec(`ALTER TABLE device_holdings ADD COLUMN ${name} ${type}`)
    }
  }

  async start() {
    const id = await identity(path.join(this.dataDir, 'sync'))
    this.fingerprint = id.fingerprint
    this.server = https.createServer({ key: id.key, cert: id.cert }, (req, res) => this.handle(req, res).catch(e => {
      // A request that fails for a reason the phone is not told about is worth saying out loud here, or a sync
      // that quietly transfers nothing has no way of being explained.
      if (!e.expose) console.error(`[sync] ${req.method} ${req.url} failed:`, e)
      this.send(res, e.status ?? 500, { error: e.expose ? e.message : 'Server error' })
    }))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '0.0.0.0', resolve) })
    this.port = this.server.address().port
    await this.listenForProbes(this.beaconPort)
    return this
  }

  /**
   * The paired phone finds this computer again after its address changes by asking out loud (SYNC_PLAN.md 6k).
   * The probe names the fingerprint it is looking for and we answer only if it is ours, so the datagram tells
   * the asker what it already knew and a stranger on the network learns nothing. No token ever rides on UDP,
   * and an answer is only a hint: the pinned certificate still decides whether a sync happens.
   */
  async listenForProbes(port = BEACON_PORT) {
    const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    beacon.on('error', e => console.warn('[sync] beacon:', e.message)) // a busy port costs discovery, not syncing
    beacon.on('message', (msg, from) => {
      if (msg.length > 256) return
      let ask
      try { ask = JSON.parse(msg.toString('utf8')) } catch { return }
      if (ask?.v !== 1 || ask.fp !== this.fingerprint) return
      beacon.send(Buffer.from(JSON.stringify({ v: 1, name: os.hostname(), port: this.port })), from.port, from.address)
    })
    await new Promise(resolve => { beacon.once('error', resolve); beacon.bind(port, '0.0.0.0', resolve) })
    this.beacon = beacon
    this.beaconPort = beacon.address?.()?.port ?? port
  }

  stop() {
    this.beacon?.close()
    this.beacon = null
    return new Promise(r => this.server ? this.server.close(r) : r())
  }

  /** A fresh one-time code for the QR; valid 10 minutes or until used. */
  startPairing() {
    const code = crypto.randomBytes(16).toString('base64url')
    this.codes.set(code, Date.now() + PAIRING_MS)
    return { v: 1, name: os.hostname(), hosts: lanAddresses(), port: this.port, fp: this.fingerprint, code }
  }

  /**
   * Every drive plugged in right now, and whether this app already knows it. A drive already added is shown
   * with the name it was given here, because that is the one the person chose.
   */
  async drives() {
    const known = this.db.prepare('SELECT id, name, volume_uuid FROM sync_devices WHERE volume_uuid IS NOT NULL').all()
    const plugged = await drives.list()
    return plugged.map(d => ({ ...d, device: known.find(k => k.volume_uuid === d.uuid) ?? null }))
  }

  /**
   * Add a drive as a device. It starts as a **backup target** — this machine sends, the drive receives —
   * because that is what a drive plugged in for the evening is for; the same card can be turned round
   * afterwards if the drive has something of its own to contribute.
   */
  addDrive({ uuid, label }) {
    if (!/^[A-Za-z0-9-]{4,64}$/.test(String(uuid ?? ''))) throw new Error('That is not a drive this app can name.')
    const already = this.db.prepare('SELECT id FROM sync_devices WHERE volume_uuid = ?').get(uuid)
    if (already) return this.devices().find(d => d.id === already.id)
    const id = crypto.randomUUID()
    this.db.prepare(`INSERT INTO sync_devices(id, name, token_hash, paired_at, kind, volume_uuid)
      VALUES(?,?,?,?,'database',?)`).run(id, String(label || 'Drive').slice(0, 80), 'drive:' + uuid, Date.now(), uuid)
    const put = this.db.prepare('INSERT INTO sync_connections(device_id, content, direction, keep, updated_at) VALUES(?,?,?,?,?)')
    // A drive is a backup target by default, but still nothing happens until the guide is finished.
    for (const content of CONTENTS) put.run(id, content, 'receive', 'everything', Date.now())
    return this.devices().find(d => d.id === id)
  }

  /**
   * Look at a drive and say what would happen, before anything does (asked 2026-09-24: select, scan, copy).
   *
   * It counts what is already on the drive by **looking at the drive**, not by trusting the ledger — a drive
   * that was backed up on another machine, or by an older version of this one, is recognised and not copied
   * again. It also answers the two questions that stop a copy dead: is there room, and may this app write here.
   */
  async inspectDrive(uuid) {
    const found = (await drives.list()).find(d => d.uuid === uuid)
    if (!found) return { plugged: false }
    const root = path.join(found.mount, 'Tetra', 'Photos')
    const rows = this.db.prepare('SELECT path, sha256, size FROM media').all()
    let have = 0, haveBytes = 0, need = 0, needBytes = 0
    for (const r of rows) {
      const target = path.join(root, r.path)
      let there = false
      try { there = fs.statSync(target).size === r.size } catch { there = false }
      if (there) { have++; haveBytes += r.size } else { need++; needBytes += r.size }
    }
    const files = await this.driveFiles(found.mount)
    const filesNeed = files.filter(f => !f.there)
    let writable = true
    try { await fsp.mkdir(path.join(found.mount, 'Tetra'), { recursive: true }) } catch { writable = false }
    const filesNeedBytes = filesNeed.reduce((a, f) => a + f.size, 0)
    return {
      plugged: true, mount: found.mount, label: found.label, fstype: found.fstype,
      free: found.freeBytes, size: found.sizeBytes,
      total: rows.length, have, haveBytes, need, needBytes,
      files: { total: files.length, have: files.length - filesNeed.length, need: filesNeed.length, needBytes: filesNeedBytes },
      writable, enough: found.freeBytes >= needBytes + filesNeedBytes + 64 * 1024 * 1024,
    }
  }

  /**
   * Copy to a drive what it does not already hold. The same rules as everything else in this file: written to
   * a `.part`, hashed as it is written, kept only if the hash is the one that was asked for, never overwriting
   * anything, and never deleting anything on either side. Everything goes under one folder — `Tetra/` — so a
   * drive full of someone's own files is never rearranged around it.
   *
   * ponytail: photos only, and no resume of a half-copied huge file (it restarts). Drive files next.
   */
  async backUpToDrive(deviceId, onProgress = () => {}) {
    const device = this.db.prepare('SELECT id, name, volume_uuid FROM sync_devices WHERE id = ?').get(String(deviceId))
    if (!device?.volume_uuid) throw new Error('That device is not a drive.')
    const mount = await drives.mountOf(device.volume_uuid)
    if (!mount) throw new Error(`${device.name} is not plugged in.`)
    const root = path.join(mount, 'Tetra', 'Photos')
    // The drive's own rules decide what goes: photos, Drive files, or both (the Add-a-drive guide sets them).
    const on = content => ['receive', 'both'].includes(this.db.prepare('SELECT direction FROM sync_connections WHERE device_id = ? AND content = ?').get(device.id, content)?.direction)
    const rows = on('photos') ? this.db.prepare('SELECT path, sha256, size FROM media ORDER BY size').all() : []
    const files = on('files') ? (await this.driveFiles(mount)).filter(f => !f.there) : []
    const total = rows.length + files.length
    const held = this.db.prepare("SELECT 1 FROM device_holdings WHERE device_id = ? AND kind = 'photo' AND sha256 = ?")
    let copied = 0, already = 0, failed = []
    for (const [i, row] of rows.entries()) {
      onProgress({ done: i, total, copied, already })
      const target = path.join(root, row.path)
      // Already there is two questions, not one: the ledger says so *and* the file is still that size. The
      // lesson of 6ag, applied before it can happen here.
      if (held.get(device.id, row.sha256) && fs.existsSync(target) && fs.statSync(target).size === row.size) { already++; continue }
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        const part = target + '.part'
        const hash = crypto.createHash('sha256')
        await new Promise((resolve, reject) => {
          const read = fs.createReadStream(path.join(this.photosRoot, row.path))
          const write = fs.createWriteStream(part)
          read.on('data', chunk => hash.update(chunk))
          read.on('error', reject); write.on('error', reject); write.on('finish', resolve)
          read.pipe(write)
        })
        if (hash.digest('hex') !== row.sha256) { await fsp.rm(part, { force: true }); throw new Error('It changed on the way; nothing was kept.') }
        await fsp.rename(part, target)
        this.db.prepare(`INSERT OR IGNORE INTO sync_receipts(device_id, sha256, path, size, received_at, kind)
          VALUES(?,?,?,?,?,'photo')`).run(device.id, row.sha256, row.path, row.size, Date.now())
        this.holds(device.id, 'photo', [row.sha256])
        copied++
      } catch (e) {
        failed.push(`${row.path}: ${e.message}`)
        if (failed.length > 50) break
      }
    }
    for (const [i, f] of files.entries()) {
      onProgress({ done: rows.length + i, total, copied, already })
      try { await this.copyFileToDrive(f, mount); copied++ } catch (e) { failed.push(`${f.path}: ${e.message}`); if (failed.length > 50) break }
    }
    this.db.prepare('UPDATE sync_devices SET last_seen = ? WHERE id = ?').run(Date.now(), device.id)
    onProgress({ done: total, total, copied, already })
    return { copied, already, failed, total }
  }

  /**
   * Drive files as they stand on a drive: each with whether the drive's copy is this version (same size and
   * modification time — the copy is stamped with the original's time, so that is enough to tell).
   */
  async driveFiles(mount) {
    if (!this.files) return []
    const root = path.join(mount, 'Tetra', 'Files')
    return (await this.files.all()).filter(i => !i.dir).map(i => {
      const st = fs.statSync(path.join(this.files.root, i.path))
      let there = false
      try { const d = fs.statSync(path.join(root, i.path)); there = d.size === st.size && Math.abs(d.mtimeMs - st.mtimeMs) < 2 } catch {}
      // (within 2 ms: the stamp goes through floating-point seconds and can come back a hair early, which made the
      // same file look changed on some runs and would have copied it again on every backup)
      return { path: i.path, size: st.size, mtimeMs: st.mtimeMs, there }
    })
  }

  /**
   * One Drive file to a drive. Unlike a photo, a document changes — so a newer version does replace the drive's
   * copy, but the one it replaces is never lost: it moves to Tetra/Files history/<time>/, and nothing on the drive
   * is ever deleted. Hashed while it is read, then read back from the drive and hashed again before it counts.
   */
  async copyFileToDrive(f, mount) {
    const src = path.join(this.files.root, f.path)
    const target = path.join(mount, 'Tetra', 'Files', f.path)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const part = target + '.part'
    const read = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const r = fs.createReadStream(src), w = fs.createWriteStream(part)
      r.on('data', c => read.update(c)); r.on('error', reject); w.on('error', reject); w.on('finish', resolve)
      r.pipe(w)
    })
    const back = crypto.createHash('sha256')
    for await (const c of fs.createReadStream(part)) back.update(c)
    if (read.digest('hex') !== back.digest('hex')) { await fsp.rm(part, { force: true }); throw new Error('The copy on the drive did not read back the same; nothing was kept.') }
    if (fs.existsSync(target)) {
      const history = path.join(mount, 'Tetra', 'Files history', new Date().toISOString().replace(/[:.]/g, '-'), f.path)
      await fsp.mkdir(path.dirname(history), { recursive: true })
      await fsp.rename(target, history)
    }
    await fsp.rename(part, target)
    await fsp.utimes(target, new Date(), new Date(f.mtimeMs))
  }

  /** Rename a device, or change the picture it is drawn with. Both are the person's choice and nothing else reads them. */
  setDevice(id, { name, kind } = {}) {
    if (typeof name === 'string' && name.trim()) this.db.prepare('UPDATE sync_devices SET name = ? WHERE id = ?').run(name.trim().slice(0, 80), String(id))
    if (typeof kind === 'string' && DEVICE_KINDS.includes(kind)) this.db.prepare('UPDATE sync_devices SET kind = ? WHERE id = ?').run(kind, String(id))
    return this.devices().find(d => d.id === String(id)) ?? null
  }

  devices() {
    return this.db.prepare(`SELECT d.id, d.name, d.paired_at, d.last_seen, d.kind, d.volume_uuid, d.set_up_at,
        (SELECT COUNT(*) FROM sync_receipts r WHERE r.device_id = d.id AND r.kind = 'photo') AS received,
        (SELECT COUNT(*) FROM sync_receipts r WHERE r.device_id = d.id AND r.kind = 'file') AS filesReceived
      FROM sync_devices d ORDER BY d.paired_at`).all().map(d => ({ ...d, connections: this.connections(d.id) }))
  }
  forget(id) { this.db.prepare('DELETE FROM sync_devices WHERE id = ?').run(String(id)) }

  /**
   * "There is something new here." (SYNC_PLAN.md 6i.)
   *
   * This computer cannot put a photo on a phone by itself — the phone is the one that decides what it accepts,
   * and it is not listening when nobody is using it. So the other direction is made automatic the only honest
   * way: when this library gains something, every paired device that *is* listening is told, and it then runs
   * its own sync, under its own rules. It carries nothing and proves nothing, so a device that does not answer
   * costs one refused connection and nothing else.
   *
   * The device's own certificate, from pairing, is pinned exactly as the phone pins ours.
   */
  async nudge() {
    const devices = this.db.prepare('SELECT id, peer_fp, peer_hosts, peer_port, peer_token FROM sync_devices WHERE peer_fp IS NOT NULL AND peer_token IS NOT NULL').all()
    await Promise.all(devices.map(async d => {
      const ways = [this.connection(d.id, 'photos').direction, this.connection(d.id, 'files').direction]
      if (ways.every(w => w === 'send' || w === 'off')) return // nothing here is for that device
      for (const host of String(d.peer_hosts ?? '').split(',').filter(Boolean)) {
        const reached = await this.ask(host, d).catch(() => false)
        if (reached) return
      }
    }))
  }

  ask(host, device) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host, port: device.peer_port || PORT, method: 'POST', path: '/sync', timeout: 3000, rejectUnauthorized: false,
        headers: { authorization: `Bearer ${device.peer_token}`, 'content-length': 0 },
      }, res => {
        const got = res.socket.getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase()
        res.resume()
        if (got !== device.peer_fp) return reject(new Error('That is not the paired device.'))
        resolve(res.statusCode === 200)
      })
      req.on('timeout', () => req.destroy(new Error('No answer.')))
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * Once a file has started streaming the answer is already on the wire, so there is no status left to send: a
   * phone that walks out of Wi-Fi mid-photo must close the connection here, not throw where nothing catches it.
   * That throw used to reach the top as an unhandled rejection, which on this app is the whole window closing.
   */
  send(res, status, body) {
    if (res.headersSent || res.writableEnded) return void res.destroy()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async json(req, limit = 1 << 20) {
    let size = 0
    const parts = []
    for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413, expose: true }); parts.push(c) }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400, expose: true }) }
  }

  device(req) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const d = token && this.db.prepare('SELECT id, name, peer_hosts FROM sync_devices WHERE token_hash = ?').get(sha(token))
    if (!d) throw Object.assign(new Error('Not paired.'), { status: 401, expose: true })
    // The address a device calls from is the address it can be called back on, and it is the only reliable one:
    // the phone finds this computer again by beacon (6k), but nothing told this computer that the phone had
    // moved. "There is something new" (6f) then went to an address nobody was on — which is what an extender
    // handing over to the main router did on 24 September. Newest first, the old ones kept behind it.
    const from = d.peer_hosts != null ? req.socket?.remoteAddress?.replace(/^::ffff:/, '') : null
    if (from && /^[0-9]+(\.[0-9]+){3}$/.test(from)) {
      const hosts = [...new Set([from, ...String(d.peer_hosts).split(',').filter(Boolean)])].slice(0, 4).join(',')
      this.db.prepare('UPDATE sync_devices SET last_seen = ?, peer_hosts = ? WHERE id = ?').run(Date.now(), hosts, d.id)
    } else {
      this.db.prepare('UPDATE sync_devices SET last_seen = ? WHERE id = ?').run(Date.now(), d.id)
    }
    return d
  }

  /**
   * The rules for one device and one kind of content, created with the defaults the plan asks for the first
   * time they are needed: **Send & receive, Keep Everything**. Two-way and "delete after sending" cannot both
   * be true, so Keep is forced back to everything whenever the direction is 'both' (SYNC_PLAN.md 6j).
   */
  connection(deviceId, content) {
    const row = this.db.prepare('SELECT direction, keep FROM sync_connections WHERE device_id = ? AND content = ?').get(deviceId, content)
    if (row) return { content, direction: row.direction, keep: row.direction === 'both' ? 'everything' : row.keep }
    // A device that has not been set up yet gets Off, not Send & receive: the answer to "what should cross"
    // is the person's, and until it is given the honest default is "nothing".
    const setUp = this.db.prepare('SELECT set_up_at FROM sync_devices WHERE id = ?').get(deviceId)?.set_up_at
    const direction = setUp ? 'both' : 'off'
    this.db.prepare('INSERT INTO sync_connections(device_id, content, direction, keep, updated_at) VALUES(?,?,?,?,?)')
      .run(deviceId, content, direction, 'everything', Date.now())
    return { content, direction, keep: 'everything' }
  }

  /** The rules have been answered: the device may sync from now on. */
  completeSetup(deviceId) {
    this.db.prepare('UPDATE sync_devices SET set_up_at = ? WHERE id = ? AND set_up_at IS NULL').run(Date.now(), String(deviceId))
    return this.devices().find(d => d.id === String(deviceId)) ?? null
  }

  connections(deviceId) { return CONTENTS.map(c => this.connection(deviceId, c)) }

  setConnection(deviceId, content, { direction, keep }) {
    if (!CONTENTS.includes(content)) throw new Error('Unknown content.')
    if (!DIRECTIONS.includes(direction)) throw new Error('Unknown direction.')
    const kept = direction === 'both' ? 'everything' : (KEEPS.includes(keep) ? keep : 'everything')
    this.db.prepare(`INSERT INTO sync_connections(device_id, content, direction, keep, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(device_id, content) DO UPDATE SET direction = excluded.direction, keep = excluded.keep, updated_at = excluded.updated_at`)
      .run(String(deviceId), content, direction, kept, Date.now())
    return { content, direction, keep: kept }
  }

  /** Photos this computer holds that the device says it has not got: the other half of /have. */
  toSend(hashes, limit = MAX_SEND) {
    const known = new Set(hashes)
    const out = []
    for (const m of this.db.prepare('SELECT sha256, path, size, taken_at FROM media ORDER BY taken_at DESC').all()) {
      if (known.has(m.sha256) || out.length >= limit) continue
      const parsed = path.parse(m.path)
      out.push({ sha256: m.sha256, path: parsed.dir.split(path.sep).join('/'), name: parsed.base, size: m.size, modified: m.taken_at })
      known.add(m.sha256) // two copies of one photo are one photo to send
    }
    return out
  }

  /**
   * Streams a file out, once its hash is confirmed to be what was asked for. Nothing else may be read.
   *
   * A transfer that stops half way is not an error worth reporting: the phone keeps nothing it cannot verify,
   * and it will ask again on its next sync. So a dropped connection closes both ends and says nothing.
   */
  async sendFile(res, absolute, expected) {
    const st = await fsp.stat(absolute).catch(() => null)
    if (!st?.isFile()) throw Object.assign(new Error('Not here any more.'), { status: 404, expose: true })
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size) })
    const file = fs.createReadStream(absolute)
    await new Promise(resolve => {
      const done = () => { file.destroy(); resolve() }
      file.on('error', done).on('end', done)
      res.on('close', done).on('error', done)
      file.pipe(res, { end: true })
    })
  }

  /**
   * A hash is not an answer to "what is it". For a file this computer has never been given, the hash was all it
   * had — so the device says, once per sync, what each of its files is called, how big it is and what kind of
   * thing it is (SYNC_PLAN.md 6ae). Every field is optional: a device that only sends hashes still syncs, it
   * just cannot be asked what its files are.
   */
  describes(deviceId, items) {
    const set = this.db.prepare(`UPDATE device_holdings SET name = ?, size = ?, is_video = ?, taken_at = ?
      WHERE device_id = ? AND kind = 'photo' AND sha256 = ?`)
    this.db.exec('BEGIN')
    try {
      for (const it of items) {
        if (!it || !isHash(it.sha256)) continue
        set.run(String(it.name ?? '').slice(0, 300) || null, Number(it.size) || null,
          it.video ? 1 : 0, Number(it.takenAt) || null, deviceId, it.sha256)
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /**
   * What a device just said it holds. Additive, because a phone lists its photos 500 at a time; anything not
   * mentioned for a day is dropped, so a device that keeps syncing keeps an accurate picture and one that has
   * been away keeps its last, next to the date it was last seen.
   *
   * ponytail: a day is a guess, and a stale row overcounts copies. Good enough to *show* — each device's
   * numbers are displayed "as of" its last sync — but a release (6ac) must demand a sweep newer than itself.
   */
  holds(deviceId, kind, hashes) {
    if (!hashes.length) return
    const now = Date.now()
    const add = this.db.prepare('INSERT INTO device_holdings(device_id, kind, sha256, seen_at) VALUES(?,?,?,?) ON CONFLICT(device_id, kind, sha256) DO UPDATE SET seen_at = excluded.seen_at')
    this.db.exec('BEGIN')
    try {
      for (const h of hashes) add.run(deviceId, kind, h, now)
      this.db.prepare('DELETE FROM device_holdings WHERE device_id = ? AND kind = ? AND seen_at < ?').run(deviceId, kind, now - 86_400_000)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /**
   * What this computer really holds, which is not the same as what its library lists (SYNC_PLAN.md 6ag).
   *
   * Two things turned out to be true the first time anyone counted: a photo can be here, verified, and absent
   * from `media` — the scanner does not index raw files, so 83 .NEF sat on disk while every count called them
   * missing — and a receipt can outlive its file, which 7 had. A receipt is the permission to offer a Move, so
   * "I issued one once" is not good enough: the file has to still be there. Refreshed at most once a minute,
   * and it only stats the receipts the library does not already account for.
   */
  refreshHere() {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS here_now (sha256 TEXT PRIMARY KEY)')
    if (this.hereAt && Date.now() - this.hereAt < 60_000) return
    const add = this.db.prepare('INSERT OR IGNORE INTO here_now(sha256) VALUES(?)')
    const known = this.db.prepare('SELECT 1 FROM here_now WHERE sha256 = ?')
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM here_now')
      for (const r of this.db.prepare('SELECT DISTINCT sha256 FROM media').all()) add.run(r.sha256)
      let stale = 0
      for (const r of this.db.prepare("SELECT sha256, path FROM sync_receipts WHERE kind = 'photo'").all()) {
        if (known.get(r.sha256)) continue
        if (this.photosRoot && fs.existsSync(path.join(this.photosRoot, r.path))) add.run(r.sha256)
        else stale++
      }
      this.staleReceipts = stale
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.hereAt = Date.now()
  }

  /**
   * The library, and where it actually is (SYNC_PLAN.md 6ad). **Photos**: the Drive folder is a second library
   * with its own manifest and its own idea of what "here" means, and counting the two together made every
   * number ambiguous — a Drive file the computer holds is not in `media`, so it looked missing.
   *
   * Counted over **everything known anywhere** — this computer's library and every file a device has said it
   * holds — because the first version counted only what was here, and a photo that exists on one phone and
   * nowhere else was therefore missing from the very picture meant to warn about it (24 September).
   *
   * "Copies" is how many machines hold the bytes, this computer included. One copy is one copy whether it is
   * here or on a phone. Sizes are only known for what is here, so a file that is only on a device is counted
   * and never weighed.
   */
  overview() {
    this.refreshHere()
    const mine = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM media').get()
    const copies = this.db.prepare(`SELECT copies, COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes, SUM(here) AS here FROM (
        SELECT s.sha AS sha,
          (CASE WHEN EXISTS(SELECT 1 FROM here_now n WHERE n.sha256 = s.sha) THEN 1 ELSE 0 END)
            + (SELECT COUNT(DISTINCT h.device_id) FROM device_holdings h WHERE h.sha256 = s.sha AND h.kind = 'photo') AS copies,
          (CASE WHEN EXISTS(SELECT 1 FROM here_now n WHERE n.sha256 = s.sha) THEN 1 ELSE 0 END) AS here,
          (SELECT MIN(m.size) FROM media m WHERE m.sha256 = s.sha) AS bytes
        FROM (SELECT sha256 AS sha FROM here_now UNION SELECT sha256 FROM device_holdings WHERE kind = 'photo') s
      ) GROUP BY copies ORDER BY copies`).all()
    const devices = this.db.prepare(`SELECT d.id, d.name, d.last_seen,
        (SELECT COUNT(*) FROM device_holdings h WHERE h.device_id = d.id AND h.kind = 'photo') AS holds,
        (SELECT COUNT(*) FROM device_holdings h WHERE h.device_id = d.id AND h.kind = 'photo'
           AND EXISTS(SELECT 1 FROM here_now n WHERE n.sha256 = h.sha256)) AS alsoHere,
        (SELECT COALESCE(SUM(m.size), 0) FROM device_holdings h JOIN media m ON m.sha256 = h.sha256
           WHERE h.device_id = d.id AND h.kind = 'photo') AS freeable
      FROM sync_devices d ORDER BY d.paired_at`).all()
    const known = copies.reduce((a, c) => a + c.files, 0)
    return {
      here: { files: mine.n, bytes: mine.bytes },
      known,
      /** One row per number of machines holding it, this computer included. `here` is how many of them are here. */
      copies: copies.map(c => ({ copies: c.copies, files: c.files, bytes: c.bytes, here: c.here })),
      devices: devices.map(d => ({ ...d, onlyThere: d.holds - d.alsoHere })),
      kinds: this.kinds(),
      /** Receipts whose file is no longer on disk: this computer once promised to hold these and does not. */
      staleReceipts: this.staleReceipts ?? 0,
    }
  }

  /** What the library is made of, by weight rather than by count: videos are 6% of the files and most of the disk. */
  kinds() {
    const rows = this.db.prepare(`SELECT CASE WHEN m.is_video = 1 THEN 'video'
        WHEN EXISTS(SELECT 1 FROM photo_ai a WHERE a.sha256 = m.sha256 AND a.type = 'document') THEN 'document'
        ELSE 'image' END AS kind, COUNT(*) AS files, COALESCE(SUM(m.size), 0) AS bytes
      FROM media m GROUP BY kind ORDER BY bytes DESC`).all()
    return rows
  }

  /**
   * The files behind one number on the overview, so it can be clicked (SYNC_PLAN.md 6ae).
   *
   * `what` is 'onlyThere' (a device holds it and this computer never got it — with `deviceId` to narrow it),
   * 'alone' (one copy in the world, wherever that is) or 'largest' (this computer's biggest files). What a
   * device could tell us about its own files it did; what it never said comes back null and is shown as such.
   */
  fileList(what, { deviceId = null, limit = 200 } = {}) {
    this.refreshHere()
    const mine = `SELECT m.path AS name, m.size, m.is_video AS isVideo, m.taken_at AS takenAt, m.sha256, NULL AS device, 1 AS here`
    if (what === 'largest') {
      return this.db.prepare(`${mine} FROM media m ORDER BY m.size DESC LIMIT ?`).all(limit)
    }
    const theirs = `SELECT h.name, h.size, h.is_video AS isVideo, h.taken_at AS takenAt, h.sha256, d.name AS device, 0 AS here
      FROM device_holdings h JOIN sync_devices d ON d.id = h.device_id
      WHERE h.kind = 'photo' AND NOT EXISTS(SELECT 1 FROM here_now n WHERE n.sha256 = h.sha256)`
    if (what === 'onlyThere') {
      return this.db.prepare(`${theirs} ${deviceId ? 'AND h.device_id = ?' : ''} ORDER BY h.size DESC NULLS LAST, h.name LIMIT ?`)
        .all(...(deviceId ? [deviceId, limit] : [limit]))
    }
    if (what === 'alone') {
      // One copy in the world: either only here, or on exactly one device and nowhere else.
      const here = this.db.prepare(`${mine} FROM media m WHERE NOT EXISTS(SELECT 1 FROM device_holdings h WHERE h.sha256 = m.sha256 AND h.kind = 'photo')
        ORDER BY m.size DESC LIMIT ?`).all(limit)
      const away = this.db.prepare(`${theirs} AND (SELECT COUNT(DISTINCT h2.device_id) FROM device_holdings h2 WHERE h2.sha256 = h.sha256) = 1
        ORDER BY h.size DESC NULLS LAST, h.name LIMIT ?`).all(limit)
      return [...here, ...away].slice(0, limit)
    }
    return []
  }

  /**
   * "Do not send me that, I have it." A receipt used to be enough on its own, and that turned a lost file into
   * a permanent hole: seven photos were received, verified, receipted and then went missing from disk, and
   * because the receipt remained this computer never asked for them again (SYNC_PLAN.md 6ag). It now asks the
   * same question the rest of the overview asks — is it actually here — so a file that went missing comes back
   * on the next sync.
   */
  have(hash) {
    this.refreshHere()
    return !!this.db.prepare('SELECT 1 FROM here_now WHERE sha256 = ?').get(hash)
  }

  async handle(req, res) {
    const url = new URL(req.url, 'https://x')
    if (req.method === 'POST' && url.pathname === '/pair') {
      const body = await this.json(req)
      for (const [c, until] of this.codes) if (Date.now() > until) this.codes.delete(c)
      const code = typeof body.code === 'string' ? [...this.codes.keys()].find(c => c.length === body.code.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(body.code))) : null
      if (!code) {
        console.warn(`[sync] pairing refused from ${req.socket.remoteAddress}: ${this.codes.size ? 'unknown or expired code' : 'no code is being shown'}`)
        return this.send(res, 403, { error: 'Pairing code is not valid. Show a new QR code on the computer.' })
      }
      this.codes.delete(code) // one use
      const token = crypto.randomBytes(32).toString('base64url'), id = crypto.randomUUID()
      const peerFp = typeof body.fp === 'string' && isHash(body.fp) ? body.fp : null
      const peerHosts = Array.isArray(body.hosts) ? body.hosts.filter(h => typeof h === 'string').slice(0, 8).join(',') : null
      // 600dp is where Android itself draws the line between a phone and a tablet, so nobody has to be asked.
      const width = Number(body.widthDp) || 0
      const kind = width >= 600 ? 'tablet' : width > 0 ? 'device' : null
      this.db.prepare(`INSERT INTO sync_devices(id, name, token_hash, paired_at, peer_fp, peer_hosts, peer_port, peer_token, kind)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, String(body.name ?? 'Phone').slice(0, 80), sha(token), Date.now(),
        peerFp, peerHosts, Number(body.port) || null, typeof body.token === 'string' ? body.token.slice(0, 128) : null, kind)
      return this.send(res, 200, { deviceId: id, token, name: os.hostname(), fp: this.fingerprint, port: this.port })
    }
    const device = this.device(req)
    if (req.method === 'POST' && url.pathname === '/have') {
      const { hashes } = await this.json(req, 1 << 22)
      if (!Array.isArray(hashes) || hashes.length > MAX_HAVE || !hashes.every(isHash)) return this.send(res, 400, { error: `Send up to ${MAX_HAVE} SHA-256 hashes.` })
      this.holds(device.id, 'photo', hashes)
      return this.send(res, 200, { missing: hashes.filter(h => !this.have(h)) })
    }
    if (req.method === 'POST' && url.pathname === '/inventory') {
      const { items } = await this.json(req, 1 << 23)
      if (!Array.isArray(items)) return this.send(res, 400, { error: 'Send a list of items.' })
      this.holds(device.id, 'photo', items.map(i => i && i.sha256).filter(isHash))
      this.describes(device.id, items)
      return this.send(res, 200, { ok: true, described: items.length })
    }
    if (req.method === 'GET' && url.pathname === '/connections') {
      return this.send(res, 200, { name: os.hostname(), connections: this.connections(device.id) })
    }
    // The other direction of /have: the phone says what it holds, the computer answers with what it could send.
    if (req.method === 'POST' && url.pathname === '/library/manifest') {
      const { hashes } = await this.json(req, 1 << 23)
      if (!Array.isArray(hashes) || hashes.length > MAX_KNOWN || !hashes.every(isHash)) return this.send(res, 400, { error: `Send up to ${MAX_KNOWN} SHA-256 hashes.` })
      this.holds(device.id, 'photo', hashes)
      const photos = this.connection(device.id, 'photos').direction
      if (photos === 'send' || photos === 'off') return this.send(res, 200, { send: [] }) // nothing goes that way
      return this.send(res, 200, { send: this.toSend(hashes) })
    }
    const blob = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname)
    if (req.method === 'GET' && blob) {
      const row = this.db.prepare('SELECT path FROM media WHERE sha256 = ?').get(blob[1])
      if (!row) return this.send(res, 404, { error: 'No such photo here.' })
      return this.sendFile(res, path.join(this.photosRoot, row.path), blob[1])
    }
    if (req.method === 'PUT' && blob) return this.send(res, 200, await this.receive(req, device, blob[1], url.searchParams))
    if (req.method === 'POST' && url.pathname === '/files/manifest') {
      if (!this.files) return this.send(res, 200, { want: [], moved: [], have: [], moveTo: [] })
      const { files: offered } = await this.json(req, 1 << 24)
      const list = Array.isArray(offered) ? offered : []
      this.holds(device.id, 'file', list.map(f => f && f.sha256).filter(isHash))
      const answer = await this.files.reconcile(list, device.id)
      // 'want' and 'moved' are what this computer does; 'have' and 'moveTo' are what it offers the device.
      const direction = this.connection(device.id, 'files').direction
      return this.send(res, 200, direction === 'send' || direction === 'off' ? { ...answer, have: [], moveTo: [] } : answer)
    }
    const file = /^\/file\/([0-9a-f]{64})$/.exec(url.pathname)
    if (req.method === 'GET' && file) {
      const rel = url.searchParams.get('path') ?? ''
      if (!this.files || !safeRel(rel) || rel === '') return this.send(res, 400, { error: 'Invalid path.' })
      const absolute = this.files.resolve(rel, false)
      if (await this.files.hash(rel) !== file[1]) return this.send(res, 404, { error: 'That is not what is here any more.' })
      return this.sendFile(res, absolute, file[1])
    }
    if (req.method === 'PUT' && file) return this.send(res, 200, await this.receiveFile(req, device, file[1], url.searchParams))
    if (req.method === 'POST' && url.pathname === '/metadata') return this.send(res, 200, this.applyMetadata(await this.json(req, 1 << 24)))
    if (req.method === 'GET' && url.pathname === '/metadata') {
      const since = Number(url.searchParams.get('since')) || 0
      return this.send(res, 200, {
        documents: this.documents.changedSince(since), ...library.metadataSince(this.db, since), ...this.people.changedSince(since),
        files: this.files?.metadataSince(since) ?? [], fileRecents: this.files?.recentsAll() ?? [],
        viewSettings: this.viewSettings(),
      })
    }
    this.send(res, 404, { error: 'Unknown request.' })
  }

  /**
   * Everything the phone's user made (SYNC_PLAN.md phases 6a–6c). Each record is independent and applied on its
   * own: a record this library cannot place yet (an unknown collection, a photo that has not arrived) is skipped
   * rather than failing the sync, and the phone re-sends the whole set next time, so nothing is lost by skipping.
   */
  applyMetadata(body) {
    const at = r => Number(r.updatedAt) || Date.now()
    const skipped = []
    const pendingBefore = this.people.reviewCount()
    let reviewChanged = false
    const each = (name, fn) => { for (const r of Array.isArray(body?.[name]) ? body[name] : []) try { fn(r) } catch (e) { skipped.push(`${name}: ${e.message}`) } }
    const forPhoto = fn => r => { if (isHash(r.sha256)) fn(r) }

    each('documents', forPhoto(d => this.documents.applyFromPhone(d.sha256, d.type ?? null, Number(d.confidence) || 0, !!d.userVerified, at(d))))
    each('favorites', forPhoto(f => library.applyFavorite(this.db, f.sha256, !!f.favorite, at(f))))
    each('collections', c => library.applyCollection(this.db, String(c.uuid), String(c.name ?? ''), !!c.deleted, at(c), !!c.hidden))
    each('collectionItems', forPhoto(i => library.applyCollectionItem(this.db, String(i.collection), i.sha256, !!i.deleted, at(i))))
    each('labels', forPhoto(l => library.applyLabels(this.db, l.sha256, Array.isArray(l.labels) ? l.labels : [])))
    each('people', p => this.people.applyPerson(String(p.uuid), library.collectionName(p.name), at(p), p.cover ? String(p.cover) : null, !!p.hidden))
    each('reviews', r => { if (this.people.applyReview(String(r.face), String(r.person), String(r.state), at(r))) reviewChanged = true })
    each('files', f => this.files?.applyMetadata({ ...f, path: String(f.path), updatedAt: at(f) }))
    if (body?.viewSettings) try { this.applyViewSettings(body.viewSettings) } catch (e) { skipped.push(`viewSettings: ${e.message}`) }
    if (Array.isArray(body?.fileRecents)) try { this.files?.mergeRecents(body.fileRecents) } catch (e) { skipped.push(`fileRecents: ${e.message}`) }
    each('faces', forPhoto(f => this.people.applyFace({
      uuid: String(f.uuid), sha256: f.sha256, quality: Number(f.quality) || 1, model: f.model, person: f.person ? String(f.person) : null, updatedAt: at(f),
      box: Array.isArray(f.box) && f.box.length === 4 && f.box.every(Number.isFinite) ? f.box.map(Number) : null,
      embedding: typeof f.embedding === 'string' ? Buffer.from(f.embedding, 'base64') : null,
    })))
    if (reviewChanged || this.people.reviewCount() > pendingBefore) setTimeout(() => this.nudge().catch(() => {}), 2000)
    if (skipped.length) console.warn(`[sync] ${skipped.length} metadata records skipped, e.g. ${skipped[0]}`)
    return { ok: true, skipped: skipped.length }
  }

  /** Streams to <Photos>/<relative path>/<name>.part, verifies SHA-256, then renames without overwriting. */
  async receive(req, device, expected, params) {
    const rel = params.get('path') ?? '', name = params.get('name') ?? ''
    if (!safeRel(rel) || !safeName(name)) throw Object.assign(new Error('Invalid path or name.'), { status: 400, expose: true })
    const dir = path.join(this.photosRoot, rel)
    if (!path.resolve(dir).startsWith(path.resolve(this.photosRoot))) throw Object.assign(new Error('Invalid path.'), { status: 400, expose: true })
    const existing = this.db.prepare('SELECT path FROM media WHERE sha256 = ?').get(expected)
    if (existing) return this.receipt(device, expected, existing.path, 0) // already here: no second copy
    await fsp.mkdir(dir, { recursive: true })
    const part = path.join(dir, `.${name}.${crypto.randomUUID()}.part`)
    const hash = crypto.createHash('sha256')
    let size = 0
    const out = fs.createWriteStream(part, { flags: 'wx' })
    try {
      for await (const chunk of req) { hash.update(chunk); size += chunk.length; if (!out.write(chunk)) await new Promise(r => out.once('drain', r)) }
      await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()))
      const fd = await fsp.open(part, 'r+'); await fd.sync(); await fd.close()
      if (hash.digest('hex') !== expected) throw Object.assign(new Error('The file changed in transit; nothing was kept.'), { status: 422, expose: true })
      let target = path.join(dir, name)
      const { name: base, ext } = path.parse(name)
      for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`) // same name, other content: keep both
      await fsp.link(part, target) // fails instead of replacing if something appeared meanwhile
      await fsp.rm(part)
      const taken = Number(params.get('modified'))
      if (Number.isFinite(taken) && taken > 0) await fsp.utimes(target, new Date(), new Date(taken))
      const receipt = this.receipt(device, expected, path.relative(this.photosRoot, target), size)
      this.onReceived(receipt)
      return receipt
    } catch (e) { out.destroy(); await fsp.rm(part, { force: true }); throw e }
  }

  /**
   * "Hide Screenshots" and "Hide Documents" describe the library, not this computer, so they cross. What a
   * device should *do* — run face or document analysis — stays local on purpose: syncing that would start hours
   * of work on a device that never asked for it.
   */
  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value }

  /**
   * What this machine is, in its own words. Every other device points at this one — it is the hub, and the
   * only thing every device is paired with — so "here" appears all over the cards, and "here" is a word about
   * the screen rather than about the machine. Saying *this PC* or *this server* is the difference between a
   * rule you read and a rule you have to decode (SYNC_PLAN.md 6ai).
   */
  self() {
    const kind = DEVICE_KINDS.includes(this.setting('selfKind')) ? this.setting('selfKind') : 'computer'
    return { kind, name: this.setting('selfName') || os.hostname(), label: SELF_LABEL[kind] }
  }

  setSelf({ kind, name } = {}) {
    const put = this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    if (DEVICE_KINDS.includes(kind)) put.run('selfKind', kind)
    if (typeof name === 'string' && name.trim()) put.run('selfName', name.trim().slice(0, 80))
    return this.self()
  }

  viewSettings() {
    return {
      hideScreenshots: this.setting('hideScreenshots') === '1',
      hideDocuments: this.setting('hideDocuments') === '1',
      updatedAt: Number(this.setting('viewSettingsUpdatedAt')) || 0,
    }
  }

  applyViewSettings({ hideScreenshots, hideDocuments, updatedAt }) {
    const at = Number(updatedAt) || 0
    if (at <= this.viewSettings().updatedAt) return
    const put = this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    put.run('hideScreenshots', hideScreenshots ? '1' : '0')
    put.run('hideDocuments', hideDocuments ? '1' : '0')
    put.run('viewSettingsUpdatedAt', String(at))
  }

  /**
   * A file of the Files module, streamed into Drive at the path the phone keeps it at. Same rule as photos:
   * a .part is hashed while it is written and only a matching SHA-256 becomes a file, and an existing file is
   * never replaced — a different file of the same name keeps both, as it does everywhere else in Drive.
   */
  async receiveFile(req, device, expected, params) {
    const rel = params.get('path') ?? ''
    if (!this.files || !safeRel(rel) || rel === '') throw Object.assign(new Error('Invalid path.'), { status: 400, expose: true })
    // Create the folders one level at a time, re-checking each against Drive, so a symlink cannot be followed
    // out of the root on the way down. Only then is the file itself resolved.
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) await fsp.mkdir(this.files.resolve(parts.slice(0, i).join('/'), false), { recursive: false }).catch(e => {
      if (e.code !== 'EEXIST') throw e
    })
    const target = this.files.resolve(rel, false)
    const part = `${target}.${crypto.randomUUID()}.part`
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(part, { flags: 'wx' })
    try {
      for await (const chunk of req) { hash.update(chunk); if (!out.write(chunk)) await new Promise(r => out.once('drain', r)) }
      await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()))
      if (hash.digest('hex') !== expected) throw Object.assign(new Error('The file changed in transit; nothing was kept.'), { status: 422, expose: true })
      let kept = target
      const { dir, name, ext } = path.parse(target)
      for (let n = 2; fs.existsSync(kept); n++) kept = path.join(dir, `${name} (${n})${ext}`)
      await fsp.link(part, kept)
      await fsp.rm(part)
      const modified = Number(params.get('modified'))
      if (Number.isFinite(modified) && modified > 0) await fsp.utimes(kept, new Date(), new Date(modified))
      const relKept = this.files.rel(kept)
      this.db.prepare(`INSERT OR IGNORE INTO sync_receipts(device_id, sha256, path, size, received_at, kind) VALUES(?,?,?,?,?,'file')`)
        .run(device.id, expected, relKept, (await fsp.stat(kept)).size, Date.now())
      return { sha256: expected, path: relKept, verified: true }
    } catch (e) { out.destroy(); await fsp.rm(part, { force: true }); throw e }
  }

  receipt(device, hash, rel, size) {
    this.db.prepare('INSERT OR IGNORE INTO sync_receipts(device_id, sha256, path, size, received_at) VALUES(?,?,?,?,?)').run(device.id, hash, rel, size, Date.now())
    // It is here now, and the next question about it comes before the minute is up — a device sends in parallel
    // and asks again in the same run, so a photo that has just landed must not still look missing.
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS here_now (sha256 TEXT PRIMARY KEY)')
    this.db.prepare('INSERT OR IGNORE INTO here_now(sha256) VALUES(?)').run(hash)
    return { sha256: hash, path: rel, verified: true }
  }
}

module.exports = { SyncServer, identity, PORT }
