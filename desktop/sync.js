// Phone → desktop sync server (SYNC_PLAN.md phase 6). HTTPS with a self-signed certificate that the phone pins by
// its SHA-256 fingerprint (from the pairing QR); a one-time pairing code becomes a per-phone bearer token.
// Photos arrive as a stream, are hashed while written to a .part file, and only a matching SHA-256 becomes a file
// and a receipt. Nothing here ever deletes or overwrites.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const crypto = require('node:crypto')
const library = require('./library')

const PORT = 43180
const PAIRING_MS = 10 * 60 * 1000
const MAX_HAVE = 5000
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
  constructor({ db, documents, people, files, dataDir, photosRoot, onReceived = () => {}, port = PORT }) {
    Object.assign(this, { db, documents, people, files, dataDir, photosRoot, onReceived, port })
    this.codes = new Map() // every code on screen stays valid until used or expired
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sync_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS sync_receipts (device_id TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(device_id, sha256));`)
    // Drive files are received too now, and the Devices page counts them apart from photos.
    if (!db.prepare('PRAGMA table_info(sync_receipts)').all().some(c => c.name === 'kind')) db.exec("ALTER TABLE sync_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'")
  }

  async start() {
    const id = await identity(path.join(this.dataDir, 'sync'))
    this.fingerprint = id.fingerprint
    this.server = https.createServer({ key: id.key, cert: id.cert }, (req, res) => this.handle(req, res).catch(e => this.send(res, e.status ?? 500, { error: e.expose ? e.message : 'Server error' })))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '0.0.0.0', resolve) })
    this.port = this.server.address().port
    return this
  }

  stop() { return new Promise(r => this.server ? this.server.close(r) : r()) }

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
      FROM sync_devices d ORDER BY d.paired_at`).all()
  }
  forget(id) { this.db.prepare('DELETE FROM sync_devices WHERE id = ?').run(String(id)) }

  send(res, status, body) {
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
      this.db.prepare('INSERT INTO sync_devices(id, name, token_hash, paired_at) VALUES(?,?,?,?)').run(id, String(body.name ?? 'Phone').slice(0, 80), sha(token), Date.now())
      return this.send(res, 200, { deviceId: id, token, name: os.hostname() })
    }
    const device = this.device(req)
    if (req.method === 'POST' && url.pathname === '/have') {
      const { hashes } = await this.json(req, 1 << 22)
      if (!Array.isArray(hashes) || hashes.length > MAX_HAVE || !hashes.every(isHash)) return this.send(res, 400, { error: `Send up to ${MAX_HAVE} SHA-256 hashes.` })
      return this.send(res, 200, { missing: hashes.filter(h => !this.have(h)) })
    }
    const blob = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname)
    if (req.method === 'PUT' && blob) return this.send(res, 200, await this.receive(req, device, blob[1], url.searchParams))
    if (req.method === 'POST' && url.pathname === '/files/manifest') {
      if (!this.files) return this.send(res, 200, { want: [], moved: [] })
      const { files: offered } = await this.json(req, 1 << 24)
      return this.send(res, 200, await this.files.reconcile(Array.isArray(offered) ? offered : []))
    }
    const file = /^\/file\/([0-9a-f]{64})$/.exec(url.pathname)
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
