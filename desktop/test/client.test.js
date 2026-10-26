const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const library = require('../library')
const { SyncServer } = require('../sync')
const { SyncClient } = require('../client')
const { Documents } = require('../documents')
const { People } = require('../faces')
const { Files } = require('../files')
const { Notes } = require('../notes')
const reset = require('../reset')

const sha = b => crypto.createHash('sha256').update(b).digest('hex')

/** One Tetra computer in a folder of its own: its database, Photos, Files and Notes, its sync listening on free ports. */
async function computer(tmp, name) {
  const dir = path.join(tmp, name)
  const db = library.open(path.join(dir, 'data'))
  const files = new Files(db, path.join(dir, 'Files'))
  fs.mkdirSync(files.root, { recursive: true })
  const sync = await new SyncServer({ db, files, documents: new Documents(db), people: new People(db, path.join(dir, 'data')),
    notes: new Notes(path.join(dir, 'Files', '.notes'), name), dataDir: path.join(dir, 'data'), photosRoot: path.join(dir, 'Photos'), port: 0, beaconPort: 0 }).start()
  return { dir, db, files, sync }
}

test('the role is chosen once: the same again is fine, the other one waits for a reset', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-role-'))
  const a = await computer(tmp, 'a')
  try {
    assert.equal(a.sync.role(), null)
    a.sync.setRole('server')
    a.sync.setRole('server')
    assert.throws(() => a.sync.setRole('client'))
    assert.equal(a.sync.role(), 'server')
    assert.throws(() => a.sync.setRole('hub'))
    const client = new SyncClient(a.sync)
    await assert.rejects(client.join('ABCD-EFGH-JKLM-NPQR'), 'a server cannot join another')
  } finally { await a.sync.stop(); fs.rmSync(tmp, { recursive: true }) }
})

test('the key is a phrase a person can type: 16 unmistakable letters, any case, dashes or not', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-key-'))
  const a = await computer(tmp, 'a')
  try {
    const p = a.sync.startPairing()
    assert.match(p.key, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
    assert.equal(p.key.replace(/-/g, ''), p.code, 'the QR carries the same code')
    // typed: lower case, spaces for dashes — still the one key
    const typed = p.key.toLowerCase().replace(/-/g, ' ')
    const res = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: a.sync.port, method: 'POST', path: '/pair', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } },
        r => { r.resume(); resolve(r.statusCode) })
      req.on('error', reject)
      req.end(JSON.stringify({ code: typed, name: 'Laptop' }))
    })
    assert.equal(res, 200)
  } finally { await a.sync.stop(); fs.rmSync(tmp, { recursive: true }) }
})

test('a desktop client joins by the phrase, and syncs files, photos and notes both ways', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-client-'))
  const server = await computer(tmp, 'server'), laptop = await computer(tmp, 'laptop')
  const near = { targets: ['127.0.0.1'], beaconPort: server.sync.beaconPort }
  try {
    server.sync.setRole('server')
    const client = new SyncClient(laptop.sync)
    await assert.rejects(client.join('AAAA-BBBB-CCCC-DDDD', near), /./, 'a phrase nobody shows finds nobody')
    await assert.rejects(client.join('too short', near))
    const { key } = server.sync.startPairing()
    // a stranger answering the probe without knowing the phrase cannot pass for the server
    assert.deepEqual(await client.find('ZZZZZZZZZZZZZZZZ', near.targets, near.beaconPort, 500), [])
    assert.equal((await client.join(key, near)).name.length > 0, true)
    assert.equal(laptop.sync.role(), 'client')
    assert.throws(() => laptop.sync.setRole('server'), 'a client stays one until a reset')
    assert.throws(() => laptop.sync.startPairing(), 'a client shows no pairing code')
    const [device] = server.sync.devices()
    assert.equal(device.kind, 'computer')
    // nothing crosses until the server's person says what should (6aj)
    for (const c of ['photos', 'files']) server.sync.setConnection(device.id, c, { direction: 'both', keep: 'everything' })
    server.sync.completeSetup(device.id)

    fs.mkdirSync(path.join(server.files.root, 'Calendar'), { recursive: true })
    fs.writeFileSync(path.join(server.files.root, 'Calendar', 'event.ics'), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    fs.mkdirSync(path.join(laptop.files.root, 'Work'), { recursive: true })
    fs.writeFileSync(path.join(laptop.files.root, 'Work', 'plan.txt'), 'from the laptop')
    const photo = crypto.randomBytes(5000)
    fs.mkdirSync(path.join(laptop.dir, 'Photos', '2026', '10'), { recursive: true })
    fs.writeFileSync(path.join(laptop.dir, 'Photos', '2026', '10', 'IMG_1.jpg'), photo)
    laptop.db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?, ?, 'image/jpeg', 0, ?, 1, 1700000000000)").run(path.join('2026', '10', 'IMG_1.jpg'), sha(photo), photo.length)
    const theirs = crypto.randomBytes(3000)
    fs.mkdirSync(path.join(server.dir, 'Photos', 'DCIM'), { recursive: true })
    fs.writeFileSync(path.join(server.dir, 'Photos', 'DCIM', 'IMG_9.jpg'), theirs)
    server.db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at) VALUES(?, ?, 'image/jpeg', 0, ?, 1, 1600000000000)").run(path.join('DCIM', 'IMG_9.jpg'), sha(theirs), theirs.length)
    server.sync.notes.save(server.sync.notes.create().id, { title: 'Shopping', content: 'milk' })

    await client.now()
    assert.equal(client.status().error, null)
    assert.equal(fs.readFileSync(path.join(server.files.root, 'Work', 'plan.txt'), 'utf8'), 'from the laptop')
    assert.equal(fs.readFileSync(path.join(laptop.files.root, 'Calendar', 'event.ics'), 'utf8'), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    assert.deepEqual(fs.readFileSync(path.join(server.dir, 'Photos', '2026', '10', 'IMG_1.jpg')), photo)
    assert.deepEqual(fs.readFileSync(path.join(laptop.dir, 'Photos', 'DCIM', 'IMG_9.jpg')), theirs)
    assert.deepEqual(laptop.sync.notes.list().map(n => n.title), ['Shopping'])

    // an edit on the server replaces the laptop's copy (the old one in Files history), not "(2)" beside it
    fs.writeFileSync(path.join(server.files.root, 'Calendar', 'event.ics'), 'BEGIN:VCALENDAR\r\nX:2\r\nEND:VCALENDAR\r\n')
    await client.now()
    assert.equal(fs.readFileSync(path.join(laptop.files.root, 'Calendar', 'event.ics'), 'utf8'), 'BEGIN:VCALENDAR\r\nX:2\r\nEND:VCALENDAR\r\n')
    assert.deepEqual(fs.readdirSync(path.join(laptop.files.root, 'Calendar')), ['event.ics'])
    // a second sync with nothing new brings nothing twice
    await client.now()
    assert.deepEqual(fs.readdirSync(path.join(laptop.dir, 'Photos', 'DCIM')), ['IMG_9.jpg'])

    // the server's "sync now" reaches the client, which answers it and nothing else
    server.db.prepare('UPDATE sync_devices SET peer_hosts = ?').run('127.0.0.1')
    let asked = 0
    client.soon = () => { asked++ }
    assert.equal(await server.sync.nudge(), 1)
    assert.equal(asked, 1)
    const pairHere = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: laptop.sync.port, method: 'POST', path: '/pair', rejectUnauthorized: false }, r => { r.resume(); resolve(r.statusCode) })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(pairHere, 403, 'phones pair with the server, not with a client')
  } finally {
    await server.sync.stop(); await laptop.sync.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('reset: the second acknowledgement only after 10 seconds, a verified backup, and never the home folder', async () => {
  assert.equal(reset.mayDelete(0), false, 'never armed')
  assert.equal(reset.mayDelete(1000, 1000 + 9_999), false)
  assert.equal(reset.mayDelete(1000, 1000 + 10_000), true)
  assert.equal(reset.mayDelete(NaN, Date.now()), false)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-reset-'))
  try {
    const tetra = path.join(tmp, 'Tetra'), data = path.join(tmp, 'data'), out = path.join(tmp, 'usb')
    fs.mkdirSync(path.join(tetra, 'Files', 'Work'), { recursive: true })
    fs.writeFileSync(path.join(tetra, 'Files', 'Work', 'a.txt'), 'abc')
    fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'library.db'), 'db')
    fs.mkdirSync(out)
    assert.deepEqual(await reset.measure([tetra, data]), { files: 2, bytes: 5 })
    await assert.rejects(reset.backUp([{ from: tetra, name: 'Tetra' }], path.join(tetra, 'Files')), 'not into what a reset deletes')
    const done = await reset.backUp([{ from: tetra, name: 'Tetra' }, { from: data, name: 'App data' }], out, new Date('2026-10-26T12:30:00Z'))
    assert.equal(done.to, path.join(out, 'Tetra backup 2026-10-26 12.30'))
    assert.equal(fs.readFileSync(path.join(done.to, 'Tetra', 'Files', 'Work', 'a.txt'), 'utf8'), 'abc')
    assert.equal(done.files, 2)
    await assert.rejects(reset.backUp([{ from: tetra, name: 'Tetra' }], out, new Date('2026-10-26T12:30:00Z')), 'never into an older backup')

    assert.throws(() => reset.wipe([tmp], tmp), 'not the home folder')
    assert.throws(() => reset.wipe([path.dirname(tmp)], tmp), 'nor above it')
    assert.throws(() => reset.wipe(['/']))
    reset.wipe([tetra, data], os.homedir())
    assert.equal(fs.existsSync(tetra) || fs.existsSync(data), false)
    assert.ok(fs.existsSync(path.join(done.to, 'Tetra', 'Files', 'Work', 'a.txt')), 'the backup stays')
  } finally { fs.rmSync(tmp, { recursive: true }) }
})
