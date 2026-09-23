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

const PORT = 43180
const BEACON_PORT = 43181
const PAIRING_MS = 10 * 60 * 1000
const MAX_HAVE = 5000
const MAX_KNOWN = 50000 // the phone's whole library in one question; chunking it would change the answer
const MAX_SEND = 2000 // one answer's worth; the next sync continues where this one stopped
const CONTENTS = ['photos', 'files']
const DIRECTIONS = ['send', 'receive', 'both']
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

  devices() {
    return this.db.prepare(`SELECT d.id, d.name, d.paired_at, d.last_seen,
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
      if (this.connection(d.id, 'photos').direction === 'send' && this.connection(d.id, 'files').direction === 'send') return
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
    const d = token && this.db.prepare('SELECT id, name FROM sync_devices WHERE token_hash = ?').get(sha(token))
    if (!d) throw Object.assign(new Error('Not paired.'), { status: 401, expose: true })
    this.db.prepare('UPDATE sync_devices SET last_seen = ? WHERE id = ?').run(Date.now(), d.id)
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
    this.db.prepare('INSERT INTO sync_connections(device_id, content, direction, keep, updated_at) VALUES(?,?,?,?,?)')
      .run(deviceId, content, 'both', 'everything', Date.now())
    return { content, direction: 'both', keep: 'everything' }
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

  have(hash) {
    return !!this.db.prepare('SELECT 1 FROM media WHERE sha256 = ?').get(hash) || !!this.db.prepare('SELECT 1 FROM sync_receipts WHERE sha256 = ?').get(hash)
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
      this.db.prepare(`INSERT INTO sync_devices(id, name, token_hash, paired_at, peer_fp, peer_hosts, peer_port, peer_token)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, String(body.name ?? 'Phone').slice(0, 80), sha(token), Date.now(),
        peerFp, peerHosts, Number(body.port) || null, typeof body.token === 'string' ? body.token.slice(0, 128) : null)
      return this.send(res, 200, { deviceId: id, token, name: os.hostname(), fp: this.fingerprint, port: this.port })
    }
    const device = this.device(req)
    if (req.method === 'POST' && url.pathname === '/have') {
      const { hashes } = await this.json(req, 1 << 22)
      if (!Array.isArray(hashes) || hashes.length > MAX_HAVE || !hashes.every(isHash)) return this.send(res, 400, { error: `Send up to ${MAX_HAVE} SHA-256 hashes.` })
      return this.send(res, 200, { missing: hashes.filter(h => !this.have(h)) })
    }
    if (req.method === 'GET' && url.pathname === '/connections') {
      return this.send(res, 200, { name: os.hostname(), connections: this.connections(device.id) })
    }
    // The other direction of /have: the phone says what it holds, the computer answers with what it could send.
    if (req.method === 'POST' && url.pathname === '/library/manifest') {
      const { hashes } = await this.json(req, 1 << 23)
      if (!Array.isArray(hashes) || hashes.length > MAX_KNOWN || !hashes.every(isHash)) return this.send(res, 400, { error: `Send up to ${MAX_KNOWN} SHA-256 hashes.` })
      if (this.connection(device.id, 'photos').direction === 'send') return this.send(res, 200, { send: [] }) // this device only sends
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
      const answer = await this.files.reconcile(Array.isArray(offered) ? offered : [], device.id)
      // 'want' and 'moved' are what this computer does; 'have' and 'moveTo' are what it offers the device.
      const direction = this.connection(device.id, 'files').direction
      return this.send(res, 200, direction === 'send' ? { ...answer, have: [], moveTo: [] } : answer)
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
    const each = (name, fn) => { for (const r of Array.isArray(body?.[name]) ? body[name] : []) try { fn(r) } catch (e) { skipped.push(`${name}: ${e.message}`) } }
    const forPhoto = fn => r => { if (isHash(r.sha256)) fn(r) }

    each('documents', forPhoto(d => this.documents.applyFromPhone(d.sha256, d.type ?? null, Number(d.confidence) || 0, !!d.userVerified, at(d))))
    each('favorites', forPhoto(f => library.applyFavorite(this.db, f.sha256, !!f.favorite, at(f))))
    each('collections', c => library.applyCollection(this.db, String(c.uuid), String(c.name ?? ''), !!c.deleted, at(c), !!c.hidden))
    each('collectionItems', forPhoto(i => library.applyCollectionItem(this.db, String(i.collection), i.sha256, !!i.deleted, at(i))))
    each('labels', forPhoto(l => library.applyLabels(this.db, l.sha256, Array.isArray(l.labels) ? l.labels : [])))
    each('people', p => this.people.applyPerson(String(p.uuid), library.collectionName(p.name), at(p)))
    each('files', f => this.files?.applyMetadata({ ...f, path: String(f.path), updatedAt: at(f) }))
    if (body?.viewSettings) try { this.applyViewSettings(body.viewSettings) } catch (e) { skipped.push(`viewSettings: ${e.message}`) }
    if (Array.isArray(body?.fileRecents)) try { this.files?.mergeRecents(body.fileRecents) } catch (e) { skipped.push(`fileRecents: ${e.message}`) }
    each('faces', forPhoto(f => this.people.applyFace({
      uuid: String(f.uuid), sha256: f.sha256, quality: Number(f.quality) || 1, model: f.model, person: f.person ? String(f.person) : null, updatedAt: at(f),
      box: Array.isArray(f.box) && f.box.length === 4 && f.box.every(Number.isFinite) ? f.box.map(Number) : null,
      embedding: typeof f.embedding === 'string' ? Buffer.from(f.embedding, 'base64') : null,
    })))
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
    return { sha256: hash, path: rel, verified: true }
  }
}

module.exports = { SyncServer, identity, PORT }
