const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const library = require('../library')
const { SyncServer } = require('../sync')
const { Documents } = require('../documents')
const { People } = require('../faces')

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

test('metadata sync: phone rows are authoritative, last-write-wins, and never re-guessed locally', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-meta-'))
  const db = library.open(path.join(tmp, 'data'))
  const documents = new Documents(db)
  const people = new People(db, path.join(tmp, 'data'))
  const server = await new SyncServer({ db, documents, people, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const qr = server.startPairing()
    const { token } = (await call('POST', '/pair', { json: { code: qr.code, name: 'Xiaomi 15' } })).body
    const sha = crypto.randomBytes(32).toString('hex')

    // A stale phone push loses to what's already stored (last-write-wins by updated_at).
    documents.applyFromPhone(sha, 'document', 0.95, false, 1000)
    let post = await call('POST', '/metadata', { token, json: { documents: [{ sha256: sha, type: null, confidence: 0, userVerified: false, updatedAt: 500 }] } })
    assert.equal(post.status, 200)
    assert.equal(db.prepare('SELECT type, source FROM photo_ai WHERE sha256 = ?').get(sha).type, 'document', 'older push ignored')

    // A newer phone push wins and is tagged source=phone.
    post = await call('POST', '/metadata', { token, json: { documents: [{ sha256: sha, type: null, confidence: 0, userVerified: true, updatedAt: 2000 }] } })
    assert.equal(post.status, 200)
    const row = db.prepare('SELECT type, source, user_verified AS userVerified FROM photo_ai WHERE sha256 = ?').get(sha)
    assert.deepEqual({ ...row }, { type: null, source: 'phone', userVerified: 1 })

    // The desktop analyzer's pending() query must exclude this sha now that it's phone-sourced.
    assert.equal(db.prepare("SELECT COALESCE(source, 'desktop') != 'phone' AS wouldReanalyze FROM photo_ai WHERE sha256 = ?").get(sha).wouldReanalyze, 0)

    // GET /metadata?since= returns only what changed after the cursor.
    const pulled = await call('GET', '/metadata?since=1500', { token })
    assert.deepEqual(pulled.body.documents, [{ sha256: sha, type: null, confidence: 0, userVerified: 1, updatedAt: 2000 }])
    assert.deepEqual((await call('GET', '/metadata?since=2000', { token })).body.documents, [], 'the cursor itself is exclusive')
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('metadata sync: favorites, collections, labels, people and faces cross over and converge', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-all-'))
  const db = library.open(path.join(tmp, 'data'))
  const people = new People(db, path.join(tmp, 'data'))
  const server = await new SyncServer({ db, documents: new Documents(db), people, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  const embedding = Buffer.from(new Float32Array(192).fill(0.1).buffer).toString('base64')
  try {
    const qr = server.startPairing()
    const { token } = (await call('POST', '/pair', { json: { code: qr.code, name: 'Xiaomi 15' } })).body
    const sha = crypto.randomBytes(32).toString('hex')
    const album = crypto.randomUUID(), person = crypto.randomUUID(), face = crypto.randomUUID()

    const push = json => call('POST', '/metadata', { token, json })
    let r = await push({
      favorites: [{ sha256: sha, favorite: true, updatedAt: 1000 }],
      collections: [{ uuid: album, name: 'Κρήτη', updatedAt: 1000 }],
      collectionItems: [{ collection: album, sha256: sha, updatedAt: 1000 }],
      labels: [{ sha256: sha, labels: ['Beach', 'Scene: seashore'] }],
      people: [{ uuid: person, name: 'Αντιγόνη', updatedAt: 1000 }],
      faces: [{ uuid: face, sha256: sha, box: [0.1, 0.1, 0.3, 0.4], embedding, quality: 0.9, person, updatedAt: 1000 }],
    })
    assert.deepEqual(r.body, { ok: true, skipped: 0 })
    assert.equal(db.prepare('SELECT favorite FROM photo_state WHERE sha256 = ?').get(sha).favorite, 1)
    assert.equal(db.prepare('SELECT name FROM collections WHERE id = ?').get(album).name, 'Κρήτη')
    assert.equal(library.members(db, album).length, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM photo_labels WHERE sha256 = ?').get(sha).n, 2)
    assert.equal(db.prepare('SELECT name FROM people WHERE id = ?').get(person).name, 'Αντιγόνη')
    assert.equal(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(face).person_id, person)

    // Replaying the same push changes nothing, and an older one loses.
    await push({ favorites: [{ sha256: sha, favorite: false, updatedAt: 500 }] })
    assert.equal(db.prepare('SELECT favorite FROM photo_state WHERE sha256 = ?').get(sha).favorite, 1, 'older push ignored')
    await push({ favorites: [{ sha256: sha, favorite: false, updatedAt: 2000 }] })
    assert.equal(db.prepare('SELECT favorite FROM photo_state WHERE sha256 = ?').get(sha).favorite, 0, 'newer push wins')

    // A photo this app analysed on its own: the phone's face lands on the same spot, so it is the same face and
    // joins the phone's person instead of being added beside it.
    const analysed = crypto.randomBytes(32).toString('hex')
    const mine = crypto.randomUUID(), other = crypto.randomUUID()
    people.applyPerson(other, 'Person 9', 1)
    db.prepare(`INSERT INTO faces(id, sha256, box_left, box_top, box_right, box_bottom, embedding, model, quality, person_id, updated_at)
      VALUES(?,?,0.11,0.11,0.31,0.41,?,'m',0.9,?,1000)`).run(mine, analysed, Buffer.from(embedding, 'base64'), other)
    await push({ faces: [{ uuid: crypto.randomUUID(), sha256: analysed, box: [0.1, 0.1, 0.3, 0.4], embedding, quality: 0.9, person, updatedAt: 3000 }] })
    assert.equal(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(mine).person_id, person, 'overlapping face regrouped, not duplicated')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM faces WHERE sha256 = ?').get(analysed).n, 1, 'no second face added')

    // A face somewhere else on the same photo is a different face and is kept whole, embedding included.
    await push({ faces: [{ uuid: crypto.randomUUID(), sha256: analysed, box: [0.6, 0.6, 0.8, 0.9], embedding, quality: 0.9, person, updatedAt: 3000 }] })
    assert.equal(db.prepare('SELECT COUNT(*) n FROM faces WHERE sha256 = ?').get(analysed).n, 2)

    // A tombstoned collection stops being a collection; the photo stays in the library.
    await push({ collections: [{ uuid: album, name: 'Κρήτη', deleted: true, updatedAt: 4000 }] })
    assert.equal(library.collections(db).length, 0)

    // What the desktop changed comes back on the phone's pull, after its cursor only.
    library.setFavorite(db, [sha], true)
    people.rename(person, 'Αντιγόνη Κ')
    const pulled = (await call('GET', '/metadata?since=4000', { token })).body
    assert.deepEqual(pulled.favorites, [{ sha256: sha, favorite: true, updatedAt: pulled.favorites[0].updatedAt }])
    assert.deepEqual(pulled.people.map(p => p.name), ['Αντιγόνη Κ'])
    assert.deepEqual((await call('GET', `/metadata?since=${Date.now() + 1000}`, { token })).body.people, [])
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})
