// Hidden: an encrypted vault. The phone relies on Android's private storage; a PC disk has no such
// protection, so every hidden file and its thumbnail is encrypted (libsodium: Argon2id key from a
// passphrase, XChaCha20-Poly1305 secretstream). The key lives only in memory while unlocked.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const CHUNK = 64 * 1024
const CHECK = 'local-drive-vault-v1'
let sodium = null
const ready = async () => { if (!sodium) { const s = require('libsodium-wrappers-sumo'); await s.ready; sodium = s } return sodium }

class Vault {
  constructor(db, dataDir) {
    this.db = db
    this.dir = path.join(dataDir, 'vault')
    this.key = null
    fs.mkdirSync(this.dir, { recursive: true })
    db.exec(`CREATE TABLE IF NOT EXISTS vault_items (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, rel_path TEXT NOT NULL,
      mime TEXT NOT NULL, is_video INTEGER NOT NULL, size INTEGER NOT NULL, taken_at INTEGER NOT NULL, thumb BLOB, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_config (id INTEGER PRIMARY KEY CHECK (id = 1), salt BLOB NOT NULL, ops INTEGER NOT NULL, mem INTEGER NOT NULL, check_box BLOB NOT NULL);`)
  }

  status() {
    return { configured: !!this.db.prepare('SELECT 1 FROM vault_config').get(), unlocked: !!this.key, count: this.db.prepare('SELECT COUNT(*) n FROM vault_items').get().n }
  }

  async derive(passphrase, salt, ops, mem) {
    const s = await ready()
    return s.crypto_pwhash(s.crypto_secretbox_KEYBYTES, String(passphrase), salt, ops, mem, s.crypto_pwhash_ALG_ARGON2ID13)
  }

  box(key, bytes) {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    return Buffer.concat([nonce, sodium.crypto_secretbox_easy(bytes, nonce, key)])
  }
  unbox(key, sealed) {
    const n = sodium.crypto_secretbox_NONCEBYTES
    return Buffer.from(sodium.crypto_secretbox_open_easy(sealed.subarray(n), sealed.subarray(0, n), key))
  }

  async setup(passphrase) {
    if (this.status().configured) throw new Error('Hidden is already set up.')
    if (String(passphrase).length < 8) throw new Error('Use a passphrase of at least 8 characters.')
    const s = await ready()
    const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES)
    const [ops, mem] = [s.crypto_pwhash_OPSLIMIT_MODERATE, s.crypto_pwhash_MEMLIMIT_MODERATE]
    const key = await this.derive(passphrase, salt, ops, mem)
    this.db.prepare('INSERT INTO vault_config(id, salt, ops, mem, check_box) VALUES(1,?,?,?,?)').run(Buffer.from(salt), ops, mem, this.box(key, Buffer.from(CHECK)))
    this.key = key
  }

  async unlock(passphrase) {
    const c = this.db.prepare('SELECT salt, ops, mem, check_box FROM vault_config').get()
    if (!c) throw new Error('Hidden is not set up yet.')
    const key = await this.derive(passphrase, new Uint8Array(c.salt), c.ops, c.mem)
    try { if (this.unbox(key, Buffer.from(c.check_box)).toString() !== CHECK) throw 0 } catch { throw new Error('Wrong passphrase.') }
    this.key = key
  }

  lock() { if (this.key) sodium.memzero(this.key); this.key = null }
  need() { if (!this.key) throw new Error('Hidden is locked.') }

  async encryptFile(src, dst) {
    const s = sodium
    const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(this.key)
    const out = await fsp.open(dst, 'wx')
    try {
      await out.write(header)
      const input = await fsp.open(src, 'r')
      try {
        const size = (await input.stat()).size
        const buf = Buffer.alloc(CHUNK)
        let pos = 0
        do {
          const { bytesRead } = await input.read(buf, 0, CHUNK, pos)
          pos += bytesRead
          const tag = pos >= size ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
          await out.write(s.crypto_secretstream_xchacha20poly1305_push(state, buf.subarray(0, bytesRead), null, tag))
        } while (pos < size)
      } finally { await input.close() }
    } finally { await out.close() }
  }

  /** Whole plaintext in memory (photos and short videos). Throws if the file was altered. */
  async decrypt(id) {
    this.need()
    const s = sodium
    const data = await fsp.readFile(path.join(this.dir, id + '.enc'))
    const hb = s.crypto_secretstream_xchacha20poly1305_HEADERBYTES
    const state = s.crypto_secretstream_xchacha20poly1305_init_pull(data.subarray(0, hb), this.key)
    const parts = []
    let pos = hb, final = false
    const block = CHUNK + s.crypto_secretstream_xchacha20poly1305_ABYTES
    while (pos < data.length) {
      const r = s.crypto_secretstream_xchacha20poly1305_pull(state, data.subarray(pos, pos + block))
      if (!r) throw new Error('A hidden file is damaged.')
      parts.push(Buffer.from(r.message))
      pos += block
      final = r.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
    }
    if (!final) throw new Error('A hidden file is incomplete.')
    return Buffer.concat(parts)
  }

  /**
   * Phone: verified private copy first, then the original goes. Encrypt → decrypt → compare SHA-256 with the
   * library's hash → only then delete the plaintext original (a Trash copy would defeat hiding it).
   */
  async hide(item, fullPath, thumbFile) {
    this.need()
    const id = crypto.randomUUID()
    const target = path.join(this.dir, id + '.enc')
    await this.encryptFile(fullPath, target)
    try {
      const plain = await this.decrypt(id)
      if (crypto.createHash('sha256').update(plain).digest('hex') !== item.sha256) throw new Error(`${item.path} changed while hiding; it was left in Photos.`)
      const thumb = fs.existsSync(thumbFile) ? this.box(this.key, await fsp.readFile(thumbFile)) : null
      this.db.prepare('INSERT INTO vault_items(id, sha256, name, rel_path, mime, is_video, size, taken_at, thumb, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, item.sha256, path.basename(item.path), item.path, item.mime, item.is_video, item.size, item.taken_at, thumb, Date.now())
    } catch (e) { await fsp.rm(target, { force: true }); throw e }
    await fsp.rm(fullPath)
    return id
  }

  list() {
    this.need()
    return this.db.prepare('SELECT id, sha256, name, rel_path, mime, is_video, size, taken_at, thumb IS NOT NULL AS has_thumb FROM vault_items ORDER BY taken_at DESC').all()
  }

  thumb(id) {
    this.need()
    const r = this.db.prepare('SELECT thumb FROM vault_items WHERE id = ?').get(String(id))
    return r?.thumb ? this.unbox(this.key, Buffer.from(r.thumb)) : null
  }

  /** Back to Photos at its old place (or "name (restored).ext" if taken), verified before the vault copy goes. */
  async restore(id, photosRoot) {
    this.need()
    const r = this.db.prepare('SELECT * FROM vault_items WHERE id = ?').get(String(id))
    if (!r) throw new Error('This hidden item no longer exists.')
    const plain = await this.decrypt(id)
    if (crypto.createHash('sha256').update(plain).digest('hex') !== r.sha256) throw new Error('A hidden file is damaged; it was kept in Hidden.')
    let target = path.join(photosRoot, r.rel_path)
    const root = path.resolve(photosRoot) + path.sep
    if (!path.resolve(target).startsWith(root)) target = path.join(photosRoot, r.name)
    if (fs.existsSync(target)) { const ext = path.extname(target); target = target.slice(0, -ext.length || undefined) + ' (restored)' + ext }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, plain, { flag: 'wx' })
    this.db.prepare('DELETE FROM vault_items WHERE id = ?').run(id)
    await fsp.rm(path.join(this.dir, id + '.enc'))
    return path.relative(photosRoot, target)
  }
}

module.exports = { Vault }
