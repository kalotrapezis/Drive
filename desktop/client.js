// This computer as a client of another Tetra computer (the user, 26 Oct; SYNC_PLAN.md 6as). The server is unchanged:
// a desktop client pairs and syncs exactly as a phone does (Drive-Android SyncClient.kt), over the same requests, and
// what arrives goes through the server's own receive code (sync.js receive, receiveFile, applyMetadata).
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')
const dgram = require('node:dgram')
const crypto = require('node:crypto')
const { lanAddresses, broadcastAddresses, BEACON_PORT, pairAsk, pairProof, plainPhrase, isHash } = require('./sync')
const { t } = require('./i18n')

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const enc = encodeURIComponent
const certOf = socket => socket.getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase()

/**
 * One request to the server, answered only by the certificate pinned at pairing: checked before a byte of the body
 * goes, as sync.js askFor does. Resolves to the response, a stream; `file` ({ path, size }) is a PUT of its bytes.
 */
function open(host, port, fp, method, url, { token, json, file, ms = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = json === undefined ? null : Buffer.from(JSON.stringify(json))
    const headers = { 'content-length': body ? body.length : file ? file.size : 0 }
    if (token) headers.authorization = `Bearer ${token}`
    if (body) headers['content-type'] = 'application/json'
    const req = https.request({ host, port, method, path: url, rejectUnauthorized: false, agent: false, timeout: 4000, headers }, res => {
      if (certOf(res.socket) !== fp) { res.resume(); return reject(new Error(t('client.errNotTheServer'))) }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error(t('client.errNoAnswer'))))
    req.on('error', reject)
    req.on('socket', s => s.once('secureConnect', () => {
      if (certOf(s) !== fp) return req.destroy(new Error(t('client.errNotTheServer')))
      req.setTimeout(ms)
      if (file) fs.createReadStream(file.path).on('error', e => req.destroy(e)).pipe(req)
      else req.end(body ?? undefined)
    }))
  })
}

async function readJson(res) {
  const parts = []
  for await (const c of res) parts.push(c)
  let body = null
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch {}
  if (res.statusCode !== 200) throw Object.assign(new Error(body?.error ?? `HTTP ${res.statusCode}`), { status: res.statusCode })
  return body
}

class SyncClient {
  /** `sync` is this computer's SyncServer: its database, files, notes and receive code; onSynced(status) after each run. */
  constructor(sync, { onSynced = () => {}, onNotes = () => {} } = {}) {
    Object.assign(this, { sync, onSynced, onNotes, error: null, running: null, again: false, timer: null })
    sync.client = this
  }

  get db() { return this.sync.db }
  pairing() { try { return JSON.parse(this.sync.setting('syncServer')) } catch { return null } }
  save(p) { this.db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run('syncServer', JSON.stringify(p)) }
  status() { const p = this.pairing(); return p && { name: p.name, lastSync: p.lastSync ?? null, error: this.error, running: !!this.running } }

  /** The server's "sync now" carries the token this computer gave it when it paired; only its hash is kept here. */
  isServer(req) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const want = this.pairing()?.myToken
    return !!(token && want) && crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(want))
  }

  /**
   * The servers on this network showing this phrase: the probe carries only its hash, and an answer counts only if
   * it signs its own fingerprint with the phrase, which a stranger cannot (sync.js pairProof). [{ host, port, fp, name }]
   */
  find(code, targets = broadcastAddresses(), port = BEACON_PORT, ms = 1500) {
    return new Promise(resolve => {
      const found = new Map()
      const sock = dgram.createSocket('udp4')
      const done = () => { try { sock.close() } catch {} resolve([...found.values()]) }
      sock.on('error', done)
      sock.on('message', (msg, from) => {
        try {
          const a = JSON.parse(msg.toString('utf8'))
          const proof = typeof a?.proof === 'string' && /^[0-9a-f]{64}$/.test(a.proof) ? Buffer.from(a.proof, 'hex') : null
          if (a?.v === 1 && isHash(a.fp) && a.port > 0 && a.port < 65536 && proof && crypto.timingSafeEqual(proof, Buffer.from(pairProof(code, a.fp), 'hex')))
            found.set(a.fp, { host: from.address, port: a.port, fp: a.fp, name: String(a.name ?? '').slice(0, 80) || 'Tetra' })
        } catch {}
      })
      sock.bind(0, () => {
        sock.setBroadcast(true)
        const probe = Buffer.from(JSON.stringify({ v: 1, pair: pairAsk(code) }))
        for (const to of targets) sock.send(probe, port, to, () => {})
        setTimeout(done, ms)
      })
    })
  }

  /** Pairs with the server showing this phrase, and makes this computer its client for good (until a reset). */
  async join(key, { targets, beaconPort } = {}) {
    if (this.sync.role()) throw new Error(t('client.errHasRole'))
    const code = plainPhrase(key)
    if (code.length !== 16) throw new Error(t('client.errKeyShape'))
    const [server] = await this.find(code, targets, beaconPort)
    if (!server) throw new Error(t('client.errNotFound'))
    const mine = crypto.randomBytes(32).toString('base64url')
    const answer = await readJson(await open(server.host, server.port, server.fp, 'POST', '/pair', { json: {
      code, name: this.sync.self().name, kind: 'computer', fp: this.sync.fingerprint, hosts: lanAddresses(), port: this.sync.port, token: mine,
    } })).catch(e => { throw e.status === 403 ? new Error(t('client.errKeyRefused')) : e })
    this.save({ id: answer.deviceId, token: answer.token, fp: server.fp, hosts: [server.host], port: answer.port ?? server.port,
      name: answer.name ?? server.name, myToken: sha(mine), pairedAt: Date.now() })
    this.sync.setRole('client')
    this.soon(0)
    return { name: answer.name ?? server.name }
  }

  soon(ms = 2000) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.now(), ms)
  }

  /** One sync, or the one running now — followed by another when something changed while it ran. */
  now() {
    if (this.running) { this.again = true; return this.running }
    this.running = this.run().then(() => { this.error = null }, e => { this.error = e.message })
      .finally(() => { this.running = null; this.onSynced(this.status()); if (this.again) { this.again = false; this.soon() } })
    return this.running
  }

  /** The server at an address it had, or found again by its fingerprint (6k); its rules for this computer come with it. */
  async reach(p) {
    const ask = async (host, port) => ({ host, port, ...await readJson(await open(host, port, p.fp, 'GET', '/connections', { token: p.token, ms: 5000 })) })
    for (const host of p.hosts) { try { return await ask(host, p.port) } catch (e) { if (e.status) throw e } }
    for (const [host, port] of await this.sync.find(p.fp)) {
      try { const got = await ask(host, port); this.save({ ...p, hosts: [host, ...p.hosts.filter(h => h !== host)].slice(0, 4), port }); return got } catch (e) { if (e.status) throw e }
    }
    throw new Error(t('client.errNotReached', { name: p.name }))
  }

  async run() {
    const p = this.pairing()
    if (!p) return
    const { host, port, connections } = await this.reach(p)
    const call = (method, url, o) => open(host, port, p.fp, method, url, { token: p.token, ...o })
    const post = async (url, json) => readJson(await call('POST', url, { json }))
    const way = c => connections?.find(x => x.content === c)?.direction ?? 'off' // the server's rules, from this computer's side
    const sends = c => way(c) === 'send' || way(c) === 'both', receives = c => way(c) === 'receive' || way(c) === 'both'
    const server = { id: `server:${p.id}`, name: p.name } // how this computer's receipts and history name the server
    const failed = []
    const step = async (what, fn) => { try { await fn() } catch (e) { failed.push(`${what}: ${e.message}`) } }
    await step(t('app.photos'), () => this.photos(call, post, server, sends('photos'), receives('photos'), way('photos') === 'both'))
    await step(t('app.files'), () => this.files(call, post, server, sends('files'), receives('files')))
    await step(t('app.notes'), async () => {
      const answer = await post('/notes', { notes: this.sync.notes.list(), deletions: this.sync.notes.deletions() })
      if (!answer.off && this.sync.notes.merge(answer).changed) this.onNotes()
    })
    await step(t('client.editorTabs'), async () => this.sync.mergeEditorTabs((await post('/editor-tabs', { tabs: this.sync.mergeEditorTabs([]) })).tabs))
    await step(t('client.metadata'), async () => {
      await post('/metadata', this.sync.metadata(0))
      const at = Date.now()
      this.sync.applyMetadata(await readJson(await call('GET', `/metadata?since=${p.metadataSince ?? 0}`)))
      this.save({ ...this.pairing(), metadataSince: at })
    })
    this.save({ ...this.pairing(), lastSync: Date.now() })
    if (failed.length) throw new Error(failed.join('; '))
  }

  /** Photos both ways, as the phone's backUp: what the server lacks goes there, what it holds and this library lacks comes here. */
  async photos(call, post, server, sends, receives, both) {
    const mine = new Map()
    for (const m of this.db.prepare('SELECT sha256, path, taken_at FROM media WHERE location IS NULL AND sha256 IS NOT NULL').all()) if (!mine.has(m.sha256)) mine.set(m.sha256, m)
    const hashes = [...mine.keys()]
    const declined = []
    if (sends) for (let i = 0; i < hashes.length || i === 0; i += 5000) {
      const answer = await post('/have', { hashes: hashes.slice(i, i + 5000) })
      declined.push(...(answer.declined ?? []))
      for (const h of answer.missing ?? []) {
        const m = mine.get(h)
        const file = path.join(this.sync.photosRoot, m.path)
        const st = await fsp.stat(file)
        const dir = path.dirname(m.path).split(path.sep).join('/')
        const receipt = await readJson(await call('PUT', `/blob/${h}?path=${enc(dir === '.' ? '' : dir)}&name=${enc(path.basename(m.path))}&modified=${m.taken_at ?? 0}`, { file: { path: file, size: st.size } }))
        if (receipt?.sha256 !== h || !receipt.verified) throw new Error(t('client.errNoReceipt', { name: m.path }))
      }
    }
    if (both) {
      // deleted on the server on purpose: this copy follows into the Trash; deleted here: the server's does
      if (declined.length) await this.sync.trashFromDevice(server, declined)
      const gone = this.db.prepare('SELECT sha256 FROM deleted_here').all().map(r => r.sha256)
      for (let i = 0; i < gone.length; i += 500) await post('/trashed', { hashes: gone.slice(i, i + 500) })
    }
    if (!receives) return
    const deleted = new Set(this.db.prepare('SELECT sha256 FROM deleted_here').all().map(r => r.sha256))
    // what came last time and is not scanned yet is had (here_now), or it would come again as "(2)"
    const send = (await post('/library/manifest', { hashes })).send ?? []
    for (const item of send.filter(s => isHash(s.sha256) && !deleted.has(s.sha256) && !this.sync.have(s.sha256))) {
      const res = await call('GET', `/blob/${item.sha256}`)
      if (res.statusCode !== 200) { await readJson(res); continue }
      await this.sync.receive(res, server, item.sha256, new URLSearchParams({ path: item.path ?? '', name: item.name ?? '', modified: String(item.modified ?? 0) }))
    }
  }

  /** Files as the phone's syncFiles: the list goes, the server answers what it wants, what it moved and what it has. */
  async files(call, post, server, sends, receives) {
    const files = this.sync.files
    const list = []
    for (const rel of await files.walk('')) {
      const h = await files.hash(rel)
      if (h) list.push({ path: rel, sha256: h, size: await files.sizeOf(rel), modified: await files.mtimeOf(rel) })
    }
    const answer = await post('/files/manifest', { files: list })
    // receiveFile keeps what both hold in sync_manifest, which on a server only reconcile creates
    this.db.exec('CREATE TABLE IF NOT EXISTS sync_manifest (device_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(device_id, path))')
    if (sends) for (const rel of answer.want ?? []) {
      const f = list.find(x => x.path === rel)
      if (!f) continue
      const receipt = await readJson(await call('PUT', `/file/${f.sha256}?path=${enc(rel)}&modified=${f.modified}`, { file: { path: files.resolve(rel), size: f.size } }))
      if (!receipt?.verified) throw new Error(t('client.errNoReceipt', { name: rel }))
    }
    // shortcut: a Move (keep nothing) on a desktop client keeps its files; deleting what went to the server waits for someone to ask
    if (!receives) return
    for (const { from, to } of answer.moveTo ?? []) await this.move(from, to)
    for (const item of answer.have ?? []) {
      if (!isHash(item.sha256)) continue
      // an edit the server made to what is here: receiveFile replaces it (the old one kept in Files history), as on the server
      if (isHash(item.replaces)) {
        files.updatesTable()
        this.db.prepare('INSERT OR REPLACE INTO file_updates(device_id, path, sha256, replaces) VALUES(?,?,?,?)').run(server.id, item.path, item.sha256, item.replaces)
      }
      const res = await call('GET', `/file/${item.sha256}?path=${enc(item.path)}`)
      if (res.statusCode !== 200) { await readJson(res).catch(() => {}); continue } // changed there since: the next sync
      await this.sync.receiveFile(res, server, item.sha256, new URLSearchParams({ path: item.path, modified: String(item.modified ?? 0) }))
    }
  }

  /** Follows a move the server made; never overwrites, and the same bytes already there are the move done. */
  async move(from, to) {
    const files = this.sync.files
    const src = files.resolve(from)
    // the folders one level at a time, each checked against Files, as receiveFile does
    const parts = String(to).split('/')
    for (let i = 1; i < parts.length; i++) await fsp.mkdir(files.resolve(parts.slice(0, i).join('/'), false)).catch(e => { if (e.code !== 'EEXIST') throw e })
    const target = files.resolve(to, false)
    if (!fs.existsSync(target)) return files.moveTo(src, target)
    if (await files.hash(from) === await files.hash(to)) return fsp.rm(src)
    return files.moveTo(src, files.freeTarget(path.dirname(target), path.basename(target)))
  }
}

module.exports = { SyncClient }
