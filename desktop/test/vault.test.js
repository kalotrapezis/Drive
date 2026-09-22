const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const library = require('../library')
const { Vault } = require('../vault')

test('hide encrypts, verifies and removes the original; restore brings it back; wrong passphrase fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-vault-'))
  const root = path.join(tmp, 'Photos')
  fs.mkdirSync(path.join(root, 'Camera'), { recursive: true })
  const bytes = crypto.randomBytes(200 * 1024 + 123) // several stream chunks
  const file = path.join(root, 'Camera', 'secret.jpg')
  fs.writeFileSync(file, bytes)
  const thumb = path.join(tmp, 'thumb.webp')
  fs.writeFileSync(thumb, 'tiny thumbnail')
  const db = library.open(path.join(tmp, 'data'))
  const vault = new Vault(db, path.join(tmp, 'data'))
  const item = { path: 'Camera/secret.jpg', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mime: 'image/jpeg', is_video: 0, size: bytes.length, taken_at: 1 }

  assert.deepEqual(vault.status(), { configured: false, unlocked: false, count: 0 })
  await assert.rejects(vault.setup('short'), /8 characters/)
  await vault.setup('correct horse battery')
  const id = await vault.hide(item, file, thumb)
  assert.ok(!fs.existsSync(file), 'plaintext original removed')
  const sealed = fs.readFileSync(path.join(tmp, 'data', 'vault', id + '.enc'))
  assert.ok(!sealed.includes(bytes.subarray(1000, 1064)), 'stored encrypted')
  assert.equal(vault.thumb(id).toString(), 'tiny thumbnail')

  vault.lock()
  assert.throws(() => vault.list(), /locked/)
  await assert.rejects(vault.unlock('wrong passphrase'), /Wrong passphrase/)
  await vault.unlock('correct horse battery')
  assert.equal(vault.list()[0].name, 'secret.jpg')

  // A tampered file never restores and stays in Hidden.
  const copy = Buffer.from(sealed); copy[copy.length - 5] ^= 1
  fs.writeFileSync(path.join(tmp, 'data', 'vault', id + '.enc'), copy)
  await assert.rejects(vault.restore(id, root), /damaged/)
  fs.writeFileSync(path.join(tmp, 'data', 'vault', id + '.enc'), sealed)

  fs.writeFileSync(file, 'someone else took the name')
  assert.equal(await vault.restore(id, root), path.join('Camera', 'secret (restored).jpg'))
  assert.deepEqual(fs.readFileSync(path.join(root, 'Camera', 'secret (restored).jpg')), bytes)
  assert.equal(vault.status().count, 0)
  fs.rmSync(tmp, { recursive: true })
})
