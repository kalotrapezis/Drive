const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const library = require('../library')
const { SyncServer } = require('../sync')

// A client like the phone's: trusts exactly the certificate whose SHA-256 came in the QR code.
function request(port, fp, method, url, { token, json, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: url, rejectUnauthorized: false,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(json && { 'content-type': 'application/json' }) } }, res => {
      const got = res.socket.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase()
      if (got !== fp) return reject(new Error('certificate does not match the QR fingerprint'))
      const parts = []
      res.on('data', c => parts.push(c)).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(json ? JSON.stringify(json) : body)
  })
}

test('pairing, missing list and verified uploads that never overwrite', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-'))
  const db = library.open(path.join(tmp, 'data'))
  const received = []
  const server = await new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0, onReceived: r => received.push(r) }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const older = server.startPairing() // a code still on screen stays valid when a newer one is shown
    const qr = server.startPairing()
    assert.equal(qr.fp, server.fingerprint)
    assert.equal((await call('POST', '/pair', { json: { code: 'wrong'.padEnd(qr.code.length, 'x') } })).status, 403)
    const paired = await call('POST', '/pair', { json: { code: qr.code, name: 'Xiaomi 15' } })
    assert.equal(paired.status, 200)
    assert.equal((await call('POST', '/pair', { json: { code: qr.code } })).status, 403, 'a code works once')
    assert.equal((await call('POST', '/pair', { json: { code: older.code, name: 'Tablet' } })).status, 200, 'the older code still works')
    const token = paired.body.token
    assert.equal((await call('POST', '/have', { json: { hashes: [] } })).status, 401, 'no token, no access')

    const photo = crypto.randomBytes(300_000), hash = crypto.createHash('sha256').update(photo).digest('hex')
    assert.deepEqual((await call('POST', '/have', { token, json: { hashes: [hash] } })).body.missing, [hash])

    const bad = await call('PUT', `/blob/${hash}?path=DCIM/Camera&name=IMG_1.jpg`, { token, body: Buffer.concat([photo, Buffer.from('x')]) })
    assert.equal(bad.status, 422)
    assert.deepEqual(fs.existsSync(path.join(tmp, 'Photos/DCIM/Camera')) ? fs.readdirSync(path.join(tmp, 'Photos/DCIM/Camera')) : [], [], 'no file and no .part left')

    assert.equal((await call('PUT', `/blob/${hash}?path=../../etc&name=x.jpg`, { token, body: photo })).status, 400)
    assert.equal((await call('PUT', `/blob/${hash}?path=DCIM&name=../x.jpg`, { token, body: photo })).status, 400)

    const ok = await call('PUT', `/blob/${hash}?path=DCIM/Camera&name=IMG_1.jpg&modified=1700000000000`, { token, body: photo })
    assert.deepEqual(ok.body, { sha256: hash, path: path.join('DCIM', 'Camera', 'IMG_1.jpg'), verified: true })
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'Photos/DCIM/Camera/IMG_1.jpg')), photo)
    assert.equal(fs.statSync(path.join(tmp, 'Photos/DCIM/Camera/IMG_1.jpg')).mtimeMs, 1700000000000)
    assert.deepEqual((await call('POST', '/have', { token, json: { hashes: [hash] } })).body.missing, [])

    // Another photo with the same name keeps both files.
    const other = crypto.randomBytes(1000), otherHash = crypto.createHash('sha256').update(other).digest('hex')
    assert.equal((await call('PUT', `/blob/${otherHash}?path=DCIM/Camera&name=IMG_1.jpg`, { token, body: other })).body.path, path.join('DCIM', 'Camera', 'IMG_1 (2).jpg'))
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'Photos/DCIM/Camera/IMG_1.jpg')), photo, 'first file untouched')
    assert.equal(received.length, 2)
    assert.equal(server.devices()[0].received, 2)
    assert.equal(server.devices().length, 2)
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})
