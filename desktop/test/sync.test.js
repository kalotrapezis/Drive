const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const dgram = require('node:dgram')
const library = require('../library')
const { SyncServer, identity } = require('../sync')
const { Documents } = require('../documents')
const { People } = require('../faces')
const { Files } = require('../files')

// A client like the phone's: trusts exactly the certificate whose SHA-256 came in the QR code.
function request(port, fp, method, url, { token, json, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: url, rejectUnauthorized: false,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(json && { 'content-type': 'application/json' }) } }, res => {
      const got = res.socket.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase()
      if (got !== fp) return reject(new Error('certificate does not match the QR fingerprint'))
      const parts = []
      res.on('data', c => parts.push(c)).on('end', () => resolve(raw
        ? { status: res.statusCode, body: Buffer.concat(parts) }
        : { status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || '{}') }))
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
  const files = new Files(db, path.join(tmp, 'Drive'))
  const server = await new SyncServer({ db, documents, people, files, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const qr = server.startPairing()
    const { token } = (await call('POST', '/pair', { json: { code: qr.code, name: 'Xiaomi 15', hosts: ['10.9.9.9'], port: 43180, token: 'x' } })).body
    const sha = crypto.randomBytes(32).toString('hex')

    // A device that moved to another network is found again by the address it calls from, newest first, so the
    // computer's "there is something new" does not keep going to where it used to be (24 September).
    await call('POST', '/have', { token, json: { hashes: [] } })
    assert.equal(db.prepare('SELECT peer_hosts FROM sync_devices').get().peer_hosts, '127.0.0.1,10.9.9.9')

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
  const files = new Files(db, path.join(tmp, 'Drive'))
  const server = await new SyncServer({ db, documents: new Documents(db), people, files, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
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

    // A photo this app analysed on its own: the phone's face lands on the same spot, so it is the same face, and
    // the phone's name beats this app's guess without a question.
    const analysed = crypto.randomBytes(32).toString('hex')
    const mine = crypto.randomUUID(), other = crypto.randomUUID()
    people.applyPerson(other, 'Person 9', 1)
    db.prepare(`INSERT INTO faces(id, sha256, box_left, box_top, box_right, box_bottom, embedding, model, quality, person_id, updated_at)
      VALUES(?,?,0.11,0.11,0.31,0.41,?,'m',0.9,?,1000)`).run(mine, analysed, Buffer.from(embedding, 'base64'), other)
    await push({ faces: [{ uuid: crypto.randomUUID(), sha256: analysed, box: [0.1, 0.1, 0.3, 0.4], embedding, quality: 0.9, person, updatedAt: 3000 }] })
    assert.equal(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(mine).person_id, person, 'the name wins over a guess')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM faces WHERE sha256 = ?').get(analysed).n, 1, 'no second face added')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM face_reviews WHERE face_id = ? AND state = ?').get(mine, 'pending').n, 0)

    // A face somewhere else on the same photo is a different face and is kept whole, embedding included.
    await push({ faces: [{ uuid: crypto.randomUUID(), sha256: analysed, box: [0.6, 0.6, 0.8, 0.9], embedding, quality: 0.9, person, updatedAt: 3000 }] })
    assert.equal(db.prepare('SELECT COUNT(*) n FROM faces WHERE sha256 = ?').get(analysed).n, 2)

    // A tombstoned collection stops being a collection; the photo stays in the library.
    await push({ collections: [{ uuid: album, name: 'Κρήτη', deleted: true, updatedAt: 4000 }] })
    assert.equal(library.collections(db).length, 0)

    // What the desktop changed comes back on the phone's pull, after its cursor only.
    library.setFavorite(db, [sha], true)
    people.rename(person, 'Αντιγόνη Κ')
    library.applyLabels(db, sha, ['Scene: harbour'], 5000)
    const pulled = (await call('GET', '/metadata?since=4000', { token })).body
    assert.deepEqual(pulled.favorites, [{ sha256: sha, favorite: true, updatedAt: pulled.favorites[0].updatedAt }])
    assert.deepEqual(pulled.people.map(p => p.name), ['Αντιγόνη Κ'])
    // A label this computer worked out goes back to the phone, whole set per photo (SYNC_PLAN.md 6w 2). The
    // two the phone pushed come with it, once: they were stamped when they arrived, and the cursor then moves
    // past them. A merge that repeats itself is not a loop.
    assert.deepEqual(pulled.labels.map(l => l.sha256), [sha])
    assert.deepEqual([...pulled.labels[0].labels].sort(), ['Beach', 'Scene: harbour', 'Scene: seashore'])
    assert.deepEqual((await call('GET', `/metadata?since=${Date.now() + 1000}`, { token })).body.labels, [], 'nothing after the cursor')
    assert.deepEqual((await call('GET', `/metadata?since=${Date.now() + 1000}`, { token })).body.people, [])
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('the ledger counts who still holds a file, not who once sent it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-holds-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')),
    files: new Files(db, path.join(tmp, 'Drive')), dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const shared = crypto.randomBytes(32).toString('hex')   // this computer and both devices
    const lonely = crypto.randomBytes(32).toString('hex')   // this computer only
    for (const [sha, size] of [[shared, 1000], [lonely, 2000]]) {
      db.prepare('INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?,?,?,0,?,0,0)').run(sha + '.jpg', sha, 'image/jpeg', size)
    }
    const pair = async name => (await call('POST', '/pair', { json: { code: server.startPairing().code, name } })).body.token
    const phone = await pair('Phone'), tablet = await pair('Tablet')
    // Each device lists what it holds; only the phone holds anything this computer also has.
    await call('POST', '/have', { token: phone, json: { hashes: [shared] } })
    await call('POST', '/have', { token: tablet, json: { hashes: [shared] } })

    const o = server.overview()
    assert.equal(o.here.files, 2)
    assert.equal(o.known, 2)
    assert.deepEqual(o.copies.find(c => c.copies === 1), { copies: 1, files: 1, bytes: 2000, here: 1 }, 'the lonely one is the only copy')
    assert.deepEqual(o.copies.find(c => c.copies === 3), { copies: 3, files: 1, bytes: 1000, here: 1 }, 'the shared one is on this computer and both devices')
    const row = o.devices.find(d => d.name === 'Phone')
    assert.equal(row.holds, 1)
    assert.equal(row.onlyThere, 0, 'nothing on the phone is missing here')
    assert.equal(row.freeable, 1000, 'what it could give back is what was checked here')
    // A device's own Sync page shows the same overview, asked for over the wire.
    const remote = (await call('GET', '/overview', { token: phone })).body
    assert.equal(remote.known, 2)
    assert.deepEqual(remote.copies.map(c => c.copies), [1, 3])
    assert.equal(remote.devices.find(d => d.name === 'Phone').holds, 1)
    assert.equal((await call('GET', '/overview')).status, 401, 'paired devices only')

    // A complete, numbered list is the whole library: what it leaves out is gone from that device now, not a day later.
    await call('POST', '/have', { token: tablet, json: { hashes: [shared, lonely] } })
    assert.equal(server.overview().devices.find(d => d.name === 'Tablet').holds, 2)
    await call('POST', '/inventory', { token: tablet, json: { items: [{ sha256: shared }], part: 0, of: 1 } })
    assert.equal(server.overview().devices.find(d => d.name === 'Tablet').holds, 1, 'the Move took the other one off it')
    await call('POST', '/have', { token: tablet, json: { hashes: [shared] } }) // back to what the rest of this test expects

    // A device holding something this computer has never seen is the risky case, and it is counted as such.
    const stray = crypto.randomBytes(32).toString('hex')
    await call('POST', '/have', { token: phone, json: { hashes: [shared, stray] } })
    // A hash cannot be read or charted, so the device says what its files are; the list behind the number then
    // has names and sizes for the very files this computer has never been given.
    await call('POST', '/inventory', { token: phone, json: { items: [
      { sha256: stray, name: 'VID_0001.mp4', size: 5000, video: true, takenAt: 1234 },
      { sha256: shared, name: 'IMG_0002.jpg', size: 1000, video: false, takenAt: 99 },
    ] } })
    // What a device is called here, and what it is drawn as, are the person's to change; the model number a
    // phone reports is not what anyone calls it.
    const phoneRow = server.devices().find(d => d.name === 'Phone')
    const renamed = server.setDevice(phoneRow.id, { name: '  Teo\u2019s phone  ', kind: 'tablet' })
    assert.equal(renamed.name, 'Teo\u2019s phone', 'trimmed, and kept')
    assert.equal(renamed.kind, 'tablet')
    server.setDevice(phoneRow.id, { name: '   ', kind: 'unicorn' })
    const after2 = server.devices().find(d => d.id === phoneRow.id)
    assert.equal(after2.name, 'Teo\u2019s phone', 'a blank name changes nothing')
    assert.equal(after2.kind, 'tablet', 'a picture that does not exist changes nothing')
    server.setDevice(phoneRow.id, { name: 'Phone', kind: 'device' })

    // A receipt is not proof: a file that was received, verified and then went missing must stop counting as
    // held, or the computer never asks for it again and the hole is permanent (SYNC_PLAN.md 6ag).
    const lost = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(path.join(tmp, 'Photos', 'DCIM'), { recursive: true })
    db.prepare("INSERT INTO sync_receipts(device_id, sha256, path, size, received_at, kind) VALUES(?,?,?,?,?,'photo')")
      .run(phoneRow.id, lost, 'DCIM/gone.jpg', 10, Date.now())
    server.hereAt = 0
    assert.equal((await call('POST', '/have', { token: phone, json: { hashes: [lost] } })).body.missing.length, 1, 'a receipt with no file is asked for again')
    fs.writeFileSync(path.join(tmp, 'Photos', 'DCIM', 'gone.jpg'), 'x')
    server.hereAt = 0
    assert.equal((await call('POST', '/have', { token: phone, json: { hashes: [lost] } })).body.missing.length, 0, 'and not once it is back')

    // A drive is a device too: known by the UUID of its filesystem, because a mount point moves and a disk
    // does not, and starting with nothing crossing until the rules are answered.
    // A UUID no disk has, on purpose: this test must never find a real drive and start writing to it.
    const drive = server.addDrive({ uuid: '00000000-dead-4dea-8dea-000000000000', label: 'T7' })
    assert.equal(drive.kind, 'database')
    assert.equal(drive.set_up_at, null, 'a new drive waits for its rules')
    assert.deepEqual(server.addDrive({ uuid: '00000000-dead-4dea-8dea-000000000000', label: 'again' }).id, drive.id, 'the same disk is the same device')
    assert.throws(() => server.addDrive({ uuid: '../etc' }), /not a drive/)
    await assert.rejects(server.backUpToDrive(drive.id), /not plugged in/, 'a drive that is not there is said so, not guessed at')
    assert.equal((await server.inspectDrive('00000000-dead-4dea-8dea-000000000000')).plugged, false)

    // What this machine is, in its own words: every rule on the page ends in it, so it is not "here".
    assert.equal(server.self().label, 'this PC', 'a computer until it says otherwise')
    assert.equal(server.setSelf({ kind: 'server', name: '  attic box ' }).label, 'this server')
    assert.equal(server.self().name, 'attic box')
    server.setSelf({ kind: 'nonsense' })
    assert.equal(server.self().kind, 'server', 'a kind that does not exist changes nothing')

    const onlyThere = server.fileList('onlyThere')
    assert.deepEqual(onlyThere.map(f => [f.name, f.size, f.isVideo, f.device]), [['VID_0001.mp4', 5000, 1, 'Phone']])
    assert.deepEqual(server.fileList('largest', { limit: 1 }).map(f => f.size), [2000], 'the biggest thing here')
    const after = server.overview()
    assert.equal(after.devices.find(d => d.name === 'Phone').onlyThere, 1)
    // And it is *in the picture*: a file on one phone and nowhere else is the whole point of the warning, so
    // it is counted among everything known, not only among what this computer happens to hold.
    assert.equal(after.known, 4, 'the stray is known even though it is not here')
    // Two things exist in one place: the lonely one here and the stray on the phone. (The recovered one is in
    // two: here, and on the phone that asked about it.)
    assert.equal(after.copies.find(c => c.copies === 1).files, 2)
    assert.equal(after.copies.find(c => c.copies === 1).here, 1, 'only one of those two is on this computer')
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('files sync: tags, favorites, colours and recents cross over by path, newest edit wins', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-files-'))
  fs.mkdirSync(path.join(tmp, 'Drive'), { recursive: true })
  const db = library.open(path.join(tmp, 'data'))
  const files = new Files(db, path.join(tmp, 'Drive'))
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')), files,
    dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const { token } = (await call('POST', '/pair', { json: { code: server.startPairing().code, name: 'Xiaomi 15' } })).body
    const push = json => call('POST', '/metadata', { token, json })

    // The file itself has not arrived yet: its metadata is still kept, not thrown away.
    await push({ files: [{ path: 'Notes/plan.pdf', favorite: true, color: null, tags: ['work', 'tax'], updatedAt: 1000 }] })
    assert.equal(db.prepare('SELECT favorite FROM file_meta WHERE path = ?').get('Notes/plan.pdf').favorite, 1)
    assert.deepEqual(db.prepare('SELECT tag FROM file_tags WHERE path = ? AND deleted = 0 ORDER BY tag').all('Notes/plan.pdf').map(r => r.tag), ['tax', 'work'])

    // An older edit loses; a newer one replaces the whole set, so a tag it no longer holds is gone.
    await push({ files: [{ path: 'Notes/plan.pdf', favorite: false, tags: [], updatedAt: 500 }] })
    assert.equal(db.prepare('SELECT favorite FROM file_meta WHERE path = ?').get('Notes/plan.pdf').favorite, 1, 'older push ignored')
    await push({ files: [{ path: 'Notes/plan.pdf', favorite: false, tags: ['work'], updatedAt: 2000 }] })
    assert.deepEqual(db.prepare('SELECT tag FROM file_tags WHERE path = ? AND deleted = 0').all('Notes/plan.pdf').map(r => r.tag), ['work'])
    assert.equal(db.prepare('SELECT favorite FROM file_meta WHERE path = ?').get('Notes/plan.pdf').favorite, 0)

    // A folder colour, and a path that tries to leave Drive.
    await push({ files: [
      { path: 'Notes', favorite: false, color: 'Blue', tags: [], updatedAt: 1000 },
      { path: '../escape', favorite: true, tags: [], updatedAt: 9000 },
    ] })
    assert.equal(db.prepare('SELECT color FROM file_meta WHERE path = ?').get('Notes').color, 'Blue')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM file_meta WHERE path = ?').get('../escape').n, 0, 'a path outside Drive is refused')

    // Recents merge on the newest open, in both directions.
    await push({ fileRecents: [{ path: 'Notes/plan.pdf', openedAt: 5000 }, { path: 'Notes/old.pdf', openedAt: 100 }] })
    await push({ fileRecents: [{ path: 'Notes/plan.pdf', openedAt: 3000 }] })
    assert.equal(db.prepare('SELECT opened_at FROM file_recents WHERE path = ?').get('Notes/plan.pdf').opened_at, 5000, 'an older open never wins')

    const pulled = (await call('GET', '/metadata?since=1500', { token })).body
    assert.deepEqual(pulled.files.map(f => f.path), ['Notes/plan.pdf'], 'only what changed after the cursor')
    assert.deepEqual(pulled.files[0].tags, ['work'])
    assert.equal(pulled.fileRecents.length, 2)
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('drive files: the computer asks only for what it lacks, and follows a move into Trash instead of copying again', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-drive-'))
  const root = path.join(tmp, 'Drive')
  fs.mkdirSync(path.join(root, 'Notes'), { recursive: true })
  const db = library.open(path.join(tmp, 'data'))
  const files = new Files(db, root)
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')), files,
    dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  const sha = b => crypto.createHash('sha256').update(b).digest('hex')
  try {
    const { token } = (await call('POST', '/pair', { json: { code: server.startPairing().code, name: 'Xiaomi 15' } })).body
    const pdf = Buffer.from('%PDF-1.4 scanned receipt'), pdfHash = sha(pdf)
    const manifest = json => call('POST', '/files/manifest', { token, json })

    // Nothing here yet: the computer asks for it, and only keeps a verified copy.
    let r = await manifest({ files: [{ path: 'Notes/receipt.pdf', sha256: pdfHash, size: pdf.length }] })
    assert.deepEqual(r.body, { want: ['Notes/receipt.pdf'], moved: [], have: [], moveTo: [] })
    assert.equal((await call('PUT', `/file/${sha(Buffer.from('other'))}?path=Notes/receipt.pdf`, { token, body: pdf })).status, 422, 'wrong hash keeps nothing')
    assert.equal(fs.existsSync(path.join(root, 'Notes/receipt.pdf')), false)
    r = await call('PUT', `/file/${pdfHash}?path=Notes/receipt.pdf`, { token, body: pdf })
    assert.deepEqual(r.body, { sha256: pdfHash, path: 'Notes/receipt.pdf', verified: true })

    // Second run: it is here now, so nothing is asked for again.
    assert.deepEqual((await manifest({ files: [{ path: 'Notes/receipt.pdf', sha256: pdfHash, size: pdf.length }] })).body, { want: [], moved: [], have: [], moveTo: [] })

    // Bytes this computer keeps somewhere the phone never had them is NOT a move: the two devices simply file the
    // same document differently, and Drive is not quietly reorganised to match the phone.
    const own = Buffer.from('a letter both devices keep'), ownHash = sha(own)
    fs.writeFileSync(path.join(root, 'MyFiling/letter.txt'.split('/')[0] + '.txt'), own) // this computer's own place for it
    r = await manifest({ files: [
      { path: 'Notes/receipt.pdf', sha256: pdfHash, size: pdf.length },
      { path: 'Letters/letter.txt', sha256: ownHash, size: own.length },
    ] })
    assert.deepEqual(r.body.moved, [], 'a layout this computer chose is left alone')
    assert.deepEqual(r.body.want, ['Letters/letter.txt'], 'the phone\'s copy is asked for instead')
    assert.equal(fs.existsSync(path.join(root, 'MyFiling.txt')), true)
    fs.rmSync(path.join(root, 'MyFiling.txt'))

    // The phone renamed it: same bytes, new path — the computer moves its copy rather than fetching it again.
    r = await manifest({ files: [{ path: 'Notes/receipt-2026.pdf', sha256: pdfHash, size: pdf.length }] })
    assert.deepEqual({ want: r.body.want, moved: r.body.moved }, { want: [], moved: [{ from: 'Notes/receipt.pdf', to: 'Notes/receipt-2026.pdf' }] })
    assert.equal(fs.existsSync(path.join(root, 'Notes/receipt.pdf')), false)
    assert.equal(fs.readFileSync(path.join(root, 'Notes/receipt-2026.pdf')).toString(), pdf.toString())

    // The phone moved it to Trash: that reaches here as a move into Trash, not as a second copy.
    r = await manifest({ files: [{ path: 'Trash/receipt-2026.pdf', sha256: pdfHash, size: pdf.length }] })
    assert.deepEqual(r.body.moved, [{ from: 'Notes/receipt-2026.pdf', to: 'Trash/receipt-2026.pdf' }])
    assert.equal(fs.existsSync(path.join(root, 'Trash/receipt-2026.pdf')), true)

    // A file only this computer has is left alone: sync copies, it never deletes.
    fs.writeFileSync(path.join(root, 'Notes/mine.txt'), 'desktop only')
    await manifest({ files: [{ path: 'Trash/receipt-2026.pdf', sha256: pdfHash, size: pdf.length }] })
    assert.equal(fs.existsSync(path.join(root, 'Notes/mine.txt')), true)

    // A different file of the same name keeps both, as everywhere else in Drive.
    const other = Buffer.from('a different receipt')
    r = await call('PUT', `/file/${sha(other)}?path=Notes/mine.txt`, { token, body: other })
    assert.equal(r.body.path, 'Notes/mine (2).txt')
    assert.equal(fs.readFileSync(path.join(root, 'Notes/mine.txt')).toString(), 'desktop only')

    // A path that tries to leave Drive is refused.
    assert.equal((await call('PUT', `/file/${pdfHash}?path=../escape.pdf`, { token, body: pdf })).status, 400)
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('settings: only what describes the library crosses; a hidden album travels with the album', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-settings-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')),
    files: new Files(db, path.join(tmp, 'Drive')), dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const { token } = (await call('POST', '/pair', { json: { code: server.startPairing().code, name: 'Xiaomi 15' } })).body
    const push = json => call('POST', '/metadata', { token, json })
    const album = crypto.randomUUID()

    await push({ viewSettings: { hideScreenshots: true, hideDocuments: false, updatedAt: 1000 } })
    assert.deepEqual(server.viewSettings(), { hideScreenshots: true, hideDocuments: false, updatedAt: 1000 })
    await push({ viewSettings: { hideScreenshots: false, hideDocuments: true, updatedAt: 500 } })
    assert.equal(server.viewSettings().hideScreenshots, true, 'older push ignored')

    // Hiding an album from Photos belongs to the album, so it arrives on the collection itself.
    await push({ collections: [{ uuid: album, name: 'Σχολείο', hidden: true, updatedAt: 1000 }] })
    assert.equal(db.prepare('SELECT hidden FROM collections WHERE id = ?').get(album).hidden, 1)
    await push({ collections: [{ uuid: album, name: 'Σχολείο', hidden: false, updatedAt: 2000 }] })
    assert.equal(db.prepare('SELECT hidden FROM collections WHERE id = ?').get(album).hidden, 0)

    const pulled = (await call('GET', '/metadata?since=0', { token })).body
    assert.equal(pulled.viewSettings.hideScreenshots, true)
    assert.equal(pulled.collections.find(c => c.uuid === album).hidden, false)
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('the beacon answers the phone that already knows this computer, and no one else', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-beacon-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = await new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0, beaconPort: 0 }).start()
  const sock = dgram.createSocket('udp4')
  const ask = probe => new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 500)
    sock.once('message', msg => { clearTimeout(timer); resolve(JSON.parse(msg.toString())) })
    sock.send(Buffer.from(probe), server.beaconPort, '127.0.0.1')
  })
  try {
    const answer = await ask(JSON.stringify({ v: 1, fp: server.fingerprint }))
    assert.equal(answer.port, server.port, 'it says where to knock')
    assert.ok(!('fp' in answer) && !('token' in answer), 'and nothing a stranger could use')
    const wrong = crypto.randomBytes(32).toString('hex')
    assert.equal(await ask(JSON.stringify({ v: 1, fp: wrong })), null, 'another computer is not this one')
    assert.equal(await ask('not json at all'), null)
  } finally {
    sock.close()
    await server.stop()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the other direction: what this computer offers, and a connection that says it may not', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-back-'))
  const photos = path.join(tmp, 'Photos'), root = path.join(tmp, 'Drive')
  fs.mkdirSync(path.join(photos, 'DCIM/Camera'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Notes'), { recursive: true })
  const db = library.open(path.join(tmp, 'data'))
  const files = new Files(db, root)
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')), files,
    dataDir: path.join(tmp, 'data'), photosRoot: photos, port: 0 }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  const sha = b => crypto.createHash('sha256').update(b).digest('hex')
  try {
    const paired = (await call('POST', '/pair', { json: { code: server.startPairing().code, name: 'Xiaomi 15' } })).body
    const token = paired.token, device = paired.deviceId
    // A new device crosses nothing until someone has answered what should cross (SYNC_PLAN.md 6aj), so a test
    // about what crosses says so first.
    server.completeSetup(device)

    // A photo only this computer has.
    const jpg = Buffer.from('a photo taken on the computer'), jpgHash = sha(jpg)
    fs.writeFileSync(path.join(photos, 'DCIM/Camera/computer.jpg'), jpg)
    db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,?,1,1,1)")
      .run('DCIM/Camera/computer.jpg', jpgHash, jpg.length)

    // Out of the box a pairing is Send & receive, so it is offered.
    assert.deepEqual(server.connections(device), [
      { content: 'photos', direction: 'both', keep: 'everything', keepDays: 30, keepFavorites: true },
      { content: 'files', direction: 'both', keep: 'everything', keepDays: 30, keepFavorites: true },
    ])
    let r = await call('POST', '/library/manifest', { token, json: { hashes: [] } })
    assert.deepEqual(r.body.send, [{ sha256: jpgHash, path: 'DCIM/Camera', name: 'computer.jpg', size: jpg.length, modified: 1 }])
    assert.deepEqual((await call('POST', '/library/manifest', { token, json: { hashes: [jpgHash] } })).body.send, [], 'nothing it already holds')

    // And the bytes come back byte for byte.
    r = await call('GET', `/blob/${jpgHash}`, { token, raw: true })
    assert.equal(sha(r.body), jpgHash)
    assert.equal((await call('GET', `/blob/${sha(Buffer.from('nothing'))}`, { token })).status, 404)

    // A file only this computer has is offered too, and can be fetched by hash at that path.
    const note = Buffer.from('written on the computer'), noteHash = sha(note)
    fs.writeFileSync(path.join(root, 'Notes/computer.txt'), note)
    r = await call('POST', '/files/manifest', { token, json: { files: [] } })
    assert.deepEqual(r.body.have.map(h => [h.path, h.sha256]), [['Notes/computer.txt', noteHash]])
    assert.deepEqual(r.body.moveTo, [], 'nothing moved on the first look')
    assert.equal(sha((await call('GET', `/file/${noteHash}?path=Notes/computer.txt`, { token, raw: true })).body), noteHash)
    assert.equal((await call('GET', `/file/${noteHash}?path=Notes/missing.txt`, { token })).status, 404, 'the hash must be what is at that path')

    // This computer moves its own copy while the phone still has it where it was: the move is mirrored, not resent.
    fs.renameSync(path.join(root, 'Notes/computer.txt'), path.join(root, 'Notes/renamed.txt'))
    r = await call('POST', '/files/manifest', { token, json: { files: [{ path: 'Notes/computer.txt', sha256: noteHash, size: note.length }] } })
    assert.deepEqual(r.body.moveTo, [{ from: 'Notes/computer.txt', to: 'Notes/renamed.txt' }])
    assert.deepEqual(r.body.have, [], 'a move is not also a copy')
    assert.deepEqual(r.body.want, [], 'and it is not also a request for the path being moved away from')

    // A file the device deleted is not offered back to it: that would undo the deletion.
    const bin = Buffer.from('a file the phone will delete'), binHash = sha(bin)
    fs.writeFileSync(path.join(root, 'Notes/shared.txt'), bin)
    await call('POST', '/files/manifest', { token, json: { files: [{ path: 'Notes/shared.txt', sha256: binHash, size: bin.length }] } })
    r = await call('POST', '/files/manifest', { token, json: { files: [] } }) // the phone no longer has it
    assert.equal(r.body.have.some(h => h.sha256 === binHash), false, 'what the phone deleted stays deleted')
    assert.equal(fs.existsSync(path.join(root, 'Notes/shared.txt')), true, 'and this computer keeps its own copy')

    // Send-only: the device may give, and receives nothing back.
    server.setConnection(device, 'photos', { direction: 'send', keep: 'everything' })
    server.setConnection(device, 'files', { direction: 'send', keep: 'everything' })
    assert.deepEqual((await call('POST', '/library/manifest', { token, json: { hashes: [] } })).body.send, [])
    r = await call('POST', '/files/manifest', { token, json: { files: [] } })
    assert.deepEqual([r.body.have, r.body.moveTo], [[], []])

    // Two-way and "keep nothing after sending" cannot both be true.
    assert.deepEqual(server.setConnection(device, 'photos', { direction: 'both', keep: 'nothing' }),
      { content: 'photos', direction: 'both', keep: 'everything', keepDays: 30, keepFavorites: true })

    // One direction can be a Move, and the device is told so — it is the one that acts on it.
    // A Move keeps a window on the device (never everything, or it is a Copy), and the device is told it.
    assert.deepEqual(server.setConnection(device, 'photos', { direction: 'send', keep: 'nothing', keepDays: 90, keepFavorites: false }),
      { content: 'photos', direction: 'send', keep: 'nothing', keepDays: 90, keepFavorites: false })
    assert.deepEqual((await call('GET', '/connections', { token })).body.connections.find(c => c.content === 'photos'),
      { content: 'photos', direction: 'send', keep: 'nothing', keepDays: 90, keepFavorites: false })
    assert.equal(server.setConnection(device, 'photos', { direction: 'send', keep: 'nothing', keepDays: 0 }).keepDays, 90, 'no zero window')

    // Off is a real answer: nothing crosses, and the device is not even told there is something new.
    server.setConnection(device, 'photos', { direction: 'off', keep: 'everything' })
    server.setConnection(device, 'files', { direction: 'off', keep: 'everything' })
    assert.deepEqual((await call('POST', '/library/manifest', { token, json: { hashes: [] } })).body.send, [])
    r = await call('POST', '/files/manifest', { token, json: { files: [] } })
    assert.deepEqual([r.body.have, r.body.moveTo], [[], []])
  } finally {
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('the computer can only say "there is something new"; the phone it says it to must be the paired one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-nudge-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = await new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 }).start()
  // A stand-in for the phone: its own certificate, which this computer pins exactly as the phone pins ours.
  const phoneId = await identity(path.join(tmp, 'phone'))
  const asked = []
  const phone = https.createServer({ key: phoneId.key, cert: phoneId.cert }, (req, res) => {
    asked.push({ method: req.method, url: req.url, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
  await new Promise(r => phone.listen(0, '127.0.0.1', r))
  try {
    const token = crypto.randomBytes(16).toString('hex')
    // set_up_at is filled in because a device that has not been set up has every row Off, and a nudge is only
    // sent to a device that has something to cross (SYNC_PLAN.md 6aj).
    const row = (fp) => db.prepare(`INSERT INTO sync_devices(id, name, token_hash, paired_at, peer_fp, peer_hosts, peer_port, peer_token, set_up_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), 'Xiaomi 15', crypto.randomUUID(), Date.now(), fp, '127.0.0.1', phone.address().port, token, Date.now())

    row(phoneId.fingerprint)
    await server.nudge()
    assert.deepEqual(asked, [{ method: 'POST', url: '/sync', auth: `Bearer ${token}` }], 'it asks, and carries nothing else')

    // A device whose certificate is not the one from pairing is not this phone, whatever answers at its address.
    asked.length = 0
    db.prepare('DELETE FROM sync_devices').run()
    row('f'.repeat(64))
    await server.nudge()
    assert.deepEqual(asked.length, 1, 'the request is made…')
    assert.equal((await new Promise(resolve => {
      server.ask('127.0.0.1', { peer_fp: 'f'.repeat(64), peer_port: phone.address().port, peer_token: token }).then(resolve, e => resolve(e.message))
    })), 'That is not the paired device.', '…and its answer is refused')

    // A device that only ever sends is not told anything: there is nothing here for it.
    asked.length = 0
    const only = db.prepare('SELECT id FROM sync_devices').get().id
    server.setConnection(only, 'photos', { direction: 'send', keep: 'everything' })
    server.setConnection(only, 'files', { direction: 'send', keep: 'everything' })
    await server.nudge()
    assert.deepEqual(asked, [])
  } finally {
    await new Promise(r => phone.close(r))
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('a transfer that is cut off leaves the computer running and the phone holding nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-cut-'))
  const photos = path.join(tmp, 'Photos')
  fs.mkdirSync(path.join(photos, 'DCIM'), { recursive: true })
  const db = library.open(path.join(tmp, 'data'))
  const server = await new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: photos, port: 0 }).start()
  const sha = b => crypto.createHash('sha256').update(b).digest('hex')
  const unhandled = []
  const watch = e => unhandled.push(e)
  process.on('unhandledRejection', watch)
  try {
    const { token } = (await request(server.port, server.fingerprint, 'POST', '/pair', { json: { code: server.startPairing().code, name: 'Xiaomi 15' } })).body
    const big = crypto.randomBytes(4 << 20) // large enough that it cannot all be in flight at once
    fs.writeFileSync(path.join(photos, 'DCIM/big.jpg'), big)
    db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES(?,?,'image/jpeg',0,?,1,1,1)")
      .run('DCIM/big.jpg', sha(big), big.length)

    // The phone walks out of Wi-Fi with the photo half sent.
    const got = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: server.port, method: 'GET', path: `/blob/${sha(big)}`,
        rejectUnauthorized: false, headers: { authorization: `Bearer ${token}` } }, res => {
        let seen = 0
        res.on('data', c => { seen += c.length; if (seen > 0) { req.destroy(); resolve(seen) } })
        res.on('error', () => resolve(seen))
      })
      req.on('error', () => resolve(0))
      req.end()
    })
    assert.ok(got < big.length, 'the photo did not arrive whole')
    await new Promise(r => setTimeout(r, 150))
    assert.deepEqual(unhandled, [], 'and nothing was thrown where nobody was listening')

    // The computer is still answering, and the same photo comes whole the next time it is asked for.
    const again = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: server.port, method: 'GET', path: `/blob/${sha(big)}`,
        rejectUnauthorized: false, headers: { authorization: `Bearer ${token}` } }, res => {
        const parts = []
        res.on('data', c => parts.push(c)).on('end', () => resolve(Buffer.concat(parts)))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(sha(again), sha(big), 'and it is the same photo, byte for byte')
  } finally {
    process.off('unhandledRejection', watch)
    await server.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('a number never replaces a name, whichever device sends it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-names-'))
  const db = library.open(path.join(tmp, 'data'))
  const people = new People(db, path.join(tmp, 'data'))
  const id = crypto.randomUUID()
  people.applyPerson(id, 'Person 41', 1000)
  people.applyPerson(id, 'Άννα', 2000)
  const named = () => db.prepare('SELECT name FROM people WHERE id = ?').get(id).name
  assert.equal(named(), 'Άννα')

  // A device that has just re-analysed from scratch calls her Person 7 again, and says so more recently.
  people.applyPerson(id, 'Person 7', 3000)
  assert.equal(named(), 'Άννα', 'the name a person typed stands')

  // Two names, though, are decided by which was written last.
  people.applyPerson(id, 'Anna', 4000)
  assert.equal(named(), 'Anna')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a drive backup copies what the drive lacks, checks every byte, and never deletes', async () => {
  const drives = require('../drives')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-backup-'))
  const mount = path.join(tmp, 'T7')
  fs.mkdirSync(mount)
  const uuid = '00000000-dead-4dea-8dea-000000000000' // never a real drive: a test must not write to one
  const [list, mountOf] = [drives.list, drives.mountOf]
  drives.list = async () => [{ uuid, label: 'Test', fstype: 'ext4', mount, sizeBytes: 1e9, freeBytes: 1e9, hotplug: true }]
  drives.mountOf = async id => id === uuid ? mount : null
  const db = library.open(path.join(tmp, 'data'))
  const photos = path.join(tmp, 'Photos')
  fs.mkdirSync(path.join(photos, 'DCIM', 'Camera'), { recursive: true })
  for (const [name, body] of [['a.jpg', 'alpha'], ['b.jpg', 'beta']]) {
    const bytes = Buffer.from(body)
    db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?,?,'image/jpeg',0,?,1,1)`)
      .run(`DCIM/Camera/${name}`, crypto.createHash('sha256').update(bytes).digest('hex'), bytes.length)
    fs.writeFileSync(path.join(photos, 'DCIM', 'Camera', name), bytes)
  }
  const server = new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: photos, port: 0 })
  try {
    const before = await server.inspectDrive(uuid)
    assert.equal(before.need, 2)
    assert.ok(before.writable && before.enough)
    const device = server.addDrive({ uuid, label: 'Test' })
    assert.deepEqual(await server.backUpToDrive(device.id), { copied: 2, already: 0, failed: [], total: 2 })
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', 'Photos', 'DCIM', 'Camera', 'a.jpg'), 'utf8'), 'alpha')
    assert.deepEqual(await server.backUpToDrive(device.id), { copied: 0, already: 2, failed: [], total: 2 }, 'nothing twice')

    // A copy that went missing on the drive is noticed by looking, not by trusting the ledger.
    fs.rmSync(path.join(mount, 'Tetra', 'Photos', 'DCIM', 'Camera', 'b.jpg'))
    assert.equal((await server.backUpToDrive(device.id)).copied, 1)

    // A photo that changed since it was read is refused, and nothing half-written is left behind.
    fs.writeFileSync(path.join(photos, 'DCIM', 'Camera', 'a.jpg'), 'tampered')
    fs.rmSync(path.join(mount, 'Tetra', 'Photos', 'DCIM', 'Camera', 'a.jpg'))
    const r = await server.backUpToDrive(device.id)
    assert.equal(r.failed.length, 1)
    assert.ok(!fs.existsSync(path.join(mount, 'Tetra', 'Photos', 'DCIM', 'Camera', 'a.jpg.part')))
    assert.ok(fs.existsSync(path.join(photos, 'DCIM', 'Camera', 'b.jpg')), 'the library is never touched')
  } finally {
    Object.assign(drives, { list, mountOf })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the Devices overview stays fast at library scale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-overview-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 })
  const media = db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?,?,'image/jpeg',0,1,1,1)`)
  const hold = db.prepare(`INSERT INTO device_holdings(device_id, kind, sha256, seen_at) VALUES(?, 'photo', ?, 1)`)
  db.exec('BEGIN')
  for (let i = 0; i < 6000; i++) {
    const sha = crypto.createHash('sha256').update(String(i)).digest('hex')
    if (i < 4000) media.run(`p/${i}.jpg`, sha)
    hold.run('phone', sha); if (i % 2) hold.run('tablet', sha)
  }
  db.exec('COMMIT')
  const t = performance.now()
  server.overview()
  assert.ok(performance.now() - t < 300, `overview took ${Math.round(performance.now() - t)} ms`)
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Drive files go to a drive too: a changed file replaces the copy, and the old version is kept, never lost', async () => {
  const drives = require('../drives')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-files-backup-'))
  const mount = path.join(tmp, 'T7'); fs.mkdirSync(mount)
  const uuid = '00000000-dead-4dea-8dea-000000000000'
  const [list, mountOf] = [drives.list, drives.mountOf]
  drives.list = async () => [{ uuid, label: 'Test', fstype: 'ext4', mount, sizeBytes: 1e9, freeBytes: 1e9, hotplug: true }]
  drives.mountOf = async id => id === uuid ? mount : null
  const db = library.open(path.join(tmp, 'data'))
  const files = new Files(db, path.join(tmp, 'Drive'))
  fs.mkdirSync(path.join(tmp, 'Drive', 'Work'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'Drive', 'Work', 'plan.txt'), 'version one')
  const server = new SyncServer({ db, files, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 })
  try {
    assert.equal((await server.inspectDrive(uuid)).files.need, 1)
    const device = server.addDrive({ uuid, label: 'Test' })
    assert.equal((await server.backUpToDrive(device.id)).copied, 1)
    const copy = path.join(mount, 'Tetra', 'Files', 'Work', 'plan.txt')
    assert.equal(fs.readFileSync(copy, 'utf8'), 'version one')
    assert.equal((await server.inspectDrive(uuid)).files.need, 0, 'the same version is not copied again')

    fs.writeFileSync(path.join(tmp, 'Drive', 'Work', 'plan.txt'), 'version two, longer')
    assert.equal((await server.backUpToDrive(device.id)).copied, 1)
    assert.equal(fs.readFileSync(copy, 'utf8'), 'version two, longer')
    const history = path.join(mount, 'Tetra', 'Files history')
    const [stamp] = fs.readdirSync(history)
    assert.equal(fs.readFileSync(path.join(history, stamp, 'Work', 'plan.txt'), 'utf8'), 'version one', 'the old version is kept')

    // Files Off on this drive: nothing goes.
    server.setConnection(device.id, 'files', { direction: 'off', keep: 'everything' })
    fs.writeFileSync(path.join(tmp, 'Drive', 'Work', 'new.txt'), 'x')
    assert.equal((await server.backUpToDrive(device.id)).copied, 0)
  } finally {
    Object.assign(drives, { list, mountOf })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a Move to a storage drive: only verified, old, non-favorite photos go, deleted here, and stay in the library', async () => {
  const drives = require('../drives')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-move-'))
  const mount = path.join(tmp, 'T7'); fs.mkdirSync(mount)
  const uuid = '00000000-dead-4dea-8dea-000000000000' // never a real drive
  const [list, mountOf] = [drives.list, drives.mountOf]
  drives.list = async () => [{ uuid, label: 'Test', fstype: 'ext4', mount, sizeBytes: 1e9, freeBytes: 1e9, hotplug: true }]
  drives.mountOf = async id => id === uuid ? mount : null
  const db = library.open(path.join(tmp, 'data'))
  const photos = path.join(tmp, 'Photos'), trash = path.join(tmp, 'Trash')
  fs.mkdirSync(path.join(photos, 'old'), { recursive: true }); fs.mkdirSync(trash)
  const old = Date.now() - 3 * 365 * 86_400_000
  const hash = {}
  for (const [name, taken] of [['a.jpg', old], ['b.jpg', old], ['fav.jpg', old], ['new.jpg', Date.now()]]) {
    const bytes = Buffer.from('bytes of ' + name)
    hash[name] = crypto.createHash('sha256').update(bytes).digest('hex')
    db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb, meta_v) VALUES(?,?,'image/jpeg',0,?,1,?,1,99)`)
      .run(`old/${name}`, hash[name], bytes.length, taken)
    fs.writeFileSync(path.join(photos, 'old', name), bytes)
  }
  library.setFavorite(db, [hash['fav.jpg']], true)
  const server = new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: photos, port: 0,
    trashItem: async f => fs.renameSync(f, path.join(trash, path.basename(f))) })
  try {
    const drive = server.addDrive({ uuid, label: 'Test' })
    await server.backUpToDrive(drive.id)
    assert.equal(server.offloadPlan(drive.id).count, 0, 'a backup drive takes nothing')
    server.setDriveRules(drive.id, { role: 'storage', copies: 1 })
    const plan = server.offloadPlan(drive.id)
    assert.equal(plan.count, 2, 'old ones only, and never a favorite')
    assert.equal(server.setDriveRules(drive.id, { copies: 2 }).copies, 2)
    assert.equal(server.offloadPlan(drive.id).count, 0, 'the drive alone is one place, and two were asked for')
    server.holds('phone', 'photo', [hash['a.jpg'], hash['b.jpg']])

    // A drive copy that does not read back the same keeps the photo here.
    fs.writeFileSync(path.join(mount, 'Tetra', 'Photos', 'old', 'b.jpg'), 'bytes of b.jpX')
    const r = await server.moveToDrive(drive.id)
    assert.equal(r.moved, 1)
    assert.equal(r.failed.length, 1)
    assert.ok(fs.existsSync(path.join(photos, 'old', 'b.jpg')), 'unverified stays')
    assert.ok(!fs.existsSync(path.join(photos, 'old', 'a.jpg')) && !fs.existsSync(path.join(trash, 'a.jpg')), 'deleted here: the Trash would free nothing')
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', 'Photos', 'old', 'a.jpg'), 'utf8'), 'bytes of a.jpg', 'the drive keeps the checked copy')
    assert.ok(server.heldSafely(hash['a.jpg']) && server.heldSafely(hash['b.jpg']), 'in the library, or on a backup drive')
    assert.ok(!server.heldSafely('0'.repeat(64)))

    // Still in the library, located on the drive; the library "has" it; this disk does not count it.
    const row = db.prepare('SELECT * FROM media WHERE sha256 = ?').get(hash['a.jpg'])
    assert.equal(row.location, drive.id)
    assert.equal((await server.locate(row)).file, path.join(mount, 'Tetra', 'Photos', 'old', 'a.jpg'))
    assert.ok(server.have(hash['a.jpg']), 'no device sends back what was moved')
    assert.equal(server.overview().here.files, 3)
    const o = server.overview()
    assert.deepEqual(o.stored.map(x => ({ ...x })), [{ name: 'Test', files: 1 }], 'in the library, on the drive — not only on a device')
    assert.equal(o.staleReceipts, 0, 'a photo that moved to the drive is not a missing file')
    assert.equal(o.devices.find(d => d.name === 'Test').onlyThere, 0)
    assert.ok(!server.toSend([]).some(p => p.sha256 === hash['a.jpg']))

    // A scan does not read a moved photo as deleted, and an unplugged drive says which one to plug in.
    await library.scan(db, photos, path.join(tmp, 'data'))
    assert.ok(db.prepare('SELECT 1 FROM media WHERE sha256 = ?').get(hash['a.jpg']))
    drives.mountOf = async () => null
    assert.match((await server.locate(row)).why, /Plug in Test/)
    assert.throws(() => server.forget(drive.id), /Bring them back/)
  } finally {
    Object.assign(drives, { list, mountOf })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a device hands its expiring Trash to the purgatory: taken with a drive, "not now" without, refused if changed', async () => {
  const drives = require('../drives')
  const { Purgatory } = require('../purgatory')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-purgatory-'))
  const mount = path.join(tmp, 'T7'); fs.mkdirSync(mount)
  const uuid = '00000000-dead-4dea-8dea-000000000000' // never a real drive
  const [list, mountOf] = [drives.list, drives.mountOf]
  let plugged = true
  drives.list = async () => plugged ? [{ uuid, label: 'Test', fstype: 'ext4', mount, sizeBytes: 1e9, freeBytes: 1e9, hotplug: true }] : []
  drives.mountOf = async id => plugged && id === uuid ? mount : null
  const db = library.open(path.join(tmp, 'data'))
  const home = path.join(tmp, 'home')
  const purgatory = new Purgatory({ db, photosRoot: path.join(tmp, 'Photos'), serverBase: home })
  const server = await new SyncServer({ db, documents: new Documents(db), people: new People(db, path.join(tmp, 'data')),
    dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0, purgatory }).start()
  const call = (m, u, o) => request(server.port, server.fingerprint, m, u, o)
  try {
    const token = (await call('POST', '/pair', { json: { code: server.startPairing().code, name: 'Phone' } })).body.token
    const drive = server.addDrive({ uuid, label: 'Test' }); server.completeSetup(drive.id)
    const bytes = Buffer.from('an old screenshot')
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    const url = `/purgatory/${sha}?kind=photo&path=${encodeURIComponent('DCIM/Screenshots/old.png')}`

    // By default the server keeps the purgatory, on its own disk.
    const first = await call('PUT', url, { token, body: bytes })
    assert.equal(first.status, 200)
    assert.equal(fs.readFileSync(path.join(home, 'Tetra', '.purgatory', first.body.purgatory), 'utf8'), 'an old screenshot')

    // Chosen for the drive: what it held moves there, checked, and new items go there.
    assert.equal((await purgatory.relocate(drive.id, id => server.purgatoryBase(id))).moved, 1)
    assert.ok(!fs.existsSync(path.join(home, 'Tetra', '.purgatory', first.body.purgatory)), 'moved, not copied twice')
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', '.purgatory', first.body.purgatory), 'utf8'), 'an old screenshot')
    const ok = await call('PUT', url, { token, body: bytes })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.drive, 'Test')
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', '.purgatory', ok.body.purgatory), 'utf8'), 'an old screenshot')
    assert.throws(() => server.forget(drive.id), /purgatory is on this drive/)
    assert.match(ok.body.purgatory, /Phone\/DCIM\/Screenshots\/old \(2\)\.png$/, 'under the device’s name')
    assert.deepEqual(fs.readdirSync(path.join(mount, 'Tetra', '.purgatory')).filter(n => n.startsWith('.incoming')), [], 'nothing half-written left')

    assert.equal((await call('PUT', url, { token, body: Buffer.from('something else') })).status, 422, 'bytes that do not match are refused')
    plugged = false
    assert.equal((await call('PUT', url, { token, body: bytes })).status, 503, 'no drive: the device keeps it and asks again')
    assert.equal((await call('PUT', `/purgatory/${sha}?kind=photo&path=..%2Fescape`, { token, body: bytes })).status, 400)
  } finally {
    Object.assign(drives, { list, mountOf })
    await server.stop(); db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('before a Move: how much would go, how much stays, and what is not on this computer yet', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-move-preview-'))
  const db = library.open(path.join(tmp, 'data'))
  const server = new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: path.join(tmp, 'Photos'), port: 0 })
  try {
    const h = x => x.repeat(64)
    const now = Date.now(), DAY = 86_400_000
    for (const [sha, taken] of [[h('a'), now - 400 * DAY], [h('b'), now - 60 * DAY], [h('c'), now - 5 * DAY], [h('f'), now - 900 * DAY]]) {
      db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?,?,'image/jpeg',0,100,1,?)`).run(sha + '.jpg', sha, taken)
      db.prepare(`INSERT INTO device_holdings(device_id, kind, sha256, seen_at, size, taken_at) VALUES('tab','photo',?,1,100,?)`).run(sha, taken)
    }
    db.prepare(`INSERT INTO device_holdings(device_id, kind, sha256, seen_at, size, taken_at) VALUES('tab','photo',?,1,100,1)`).run(h('z')) // only on the tablet
    library.setFavorite(db, [h('f')], true)
    const month = server.movePreview('tab', { keepDays: 30, keepFavorites: true })
    assert.deepEqual({ ...month, lastSeen: undefined }, { holds: 5, onPc: 4, go: 2, goBytes: 200, keep: 2, notOnPc: 1, lastSeen: undefined })
    assert.equal(server.movePreview('tab', { keepDays: 30, keepFavorites: false }).go, 3, 'the old favorite goes too when asked')
    assert.equal(server.movePreview('tab', { keepDays: 365, keepFavorites: true }).go, 1, 'a year keeps more')
  } finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('Trash copies of photos already moved to the drive are let go; anything else in the Trash stays', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-release-'))
  const xdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(tmp, 'share')
  const db = library.open(path.join(tmp, 'data'))
  const photos = path.join(tmp, 'Photos')
  const server = new SyncServer({ db, dataDir: path.join(tmp, 'data'), photosRoot: photos, port: 0 })
  try {
    const trash = path.join(tmp, 'share', 'Trash')
    fs.mkdirSync(path.join(trash, 'files'), { recursive: true }); fs.mkdirSync(path.join(trash, 'info'))
    const put = (id, rel, body) => {
      fs.writeFileSync(path.join(trash, 'files', id), body)
      fs.writeFileSync(path.join(trash, 'info', id + '.trashinfo'), `[Trash Info]\nPath=${path.join(photos, rel)}\nDeletionDate=2026-09-25T15:00:00\n`)
    }
    db.prepare(`INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, location) VALUES('old/a.jpg', ?, 'image/jpeg', 0, 5, 1, 1, 'drive')`).run('a'.repeat(64))
    put('a.jpg', 'old/a.jpg', 'AAAAA')        // the moved photo's copy: same path, same size
    put('b.jpg', 'old/b.jpg', 'BBBBB')        // something else the person trashed
    put('a.2.jpg', 'old/a.jpg', 'changed!')   // same name, other bytes: not provably the same photo
    assert.equal(await server.releaseTrashedMoved(), 1)
    assert.deepEqual(fs.readdirSync(path.join(trash, 'files')).sort(), ['a.2.jpg', 'b.jpg'])
    assert.ok(!fs.existsSync(path.join(trash, 'info', 'a.jpg.trashinfo')))
  } finally {
    if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg
    db.close(); fs.rmSync(tmp, { recursive: true, force: true })
  }
})
