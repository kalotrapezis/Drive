const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const library = require('../library')
const { SyncServer, identity } = require('../sync')
const { SyncClient } = require('../client')
const { Documents } = require('../documents')
const { People } = require('../faces')
const { Files } = require('../files')
const { Notes } = require('../notes')
const reset = require('../reset')

const sha = b => crypto.createHash('sha256').update(b).digest('hex')

/** One Tetra computer in a folder of its own: its database, Photos, Files and Notes, its sync listening on free ports. */
async function computer(tmp, name, { onCall = () => {} } = {}) {
  const dir = path.join(tmp, name)
  const db = library.open(path.join(dir, 'data'))
  const files = new Files(db, path.join(dir, 'Files'))
  fs.mkdirSync(files.root, { recursive: true })
  const sync = await new SyncServer({ db, files, documents: new Documents(db), people: new People(db, path.join(dir, 'data')),
    notes: new Notes(path.join(dir, 'Files', '.notes'), name), dataDir: path.join(dir, 'data'), photosRoot: path.join(dir, 'Photos'), port: 0, beaconPort: 0, onCall }).start()
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

/** A stand-in phone: Tetra's SyncServer.kt answers for /call, /call/action and /location, behind its own certificate. */
async function phone(dir) {
  const id = await identity(dir)
  const asked = []
  const server = https.createServer({ key: id.key, cert: id.cert }, (req, res) => {
    asked.push(req.url)
    const body = req.url.startsWith('/location') ? { lat: 40.64, lng: 22.94, accuracy: 12 } : req.url.startsWith('/call?') ? { how: 'calling' } : { ok: true }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { fp: id.fingerprint, port: server.address().port, asked, close: () => new Promise(r => server.close(r)) }
}

test("a client computer shows the phone's calls, answers them through the server, and asks it where the phone is", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-calls-'))
  const onServer = [], onLaptop = []
  const server = await computer(tmp, 'server', { onCall: s => onServer.push(s) }), laptop = await computer(tmp, 'laptop', { onCall: s => onLaptop.push(s) })
  const p = await phone(path.join(tmp, 'phone'))
  try {
    server.sync.setRole('server')
    const client = new SyncClient(laptop.sync)
    await client.join(server.sync.startPairing().key, { targets: ['127.0.0.1'], beaconPort: server.sync.beaconPort })
    server.db.prepare("UPDATE sync_devices SET peer_hosts = '127.0.0.1'").run()
    // the phone pairs as a phone does: its certificate, port and the token the computer calls it with
    const { code } = server.sync.startPairing()
    const paired = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: server.sync.port, method: 'POST', path: '/pair', rejectUnauthorized: false }, r => { const b = []; r.on('data', c => b.push(c)).on('end', () => resolve(JSON.parse(Buffer.concat(b)))) })
      req.on('error', reject)
      req.end(JSON.stringify({ code, name: 'Xiaomi 15', widthDp: 400, fp: p.fp, hosts: ['127.0.0.1'], port: p.port, token: 'phone-token' }))
    })
    const state = s => new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: server.sync.port, method: 'POST', path: '/call/state', rejectUnauthorized: false, headers: { authorization: `Bearer ${paired.token}` } }, r => { r.resume(); r.on('end', resolve) })
      req.on('error', reject)
      req.end(JSON.stringify(s))
    })
    const until = async fn => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); assert.ok(fn()) }

    await state({ state: 'ringing', number: '6900000001' })
    await until(() => onLaptop.length === 1)
    assert.equal(onServer[0].state, 'ringing')
    assert.deepEqual([onLaptop[0].state, onLaptop[0].number, onLaptop[0].takenBy], ['ringing', '6900000001', null], 'the bubble on the client too')

    // Answer on the laptop: through the server to the phone; from then on every computer knows who took it
    assert.deepEqual(await laptop.sync.callAction('answer'), { ok: true })
    assert.ok(p.asked.includes('/call/action?do=answer'))
    await state({ state: 'active', number: '6900000001' })
    await until(() => onLaptop.length === 2)
    const me = client.pairing().id
    assert.equal(onServer[1].takenBy, me, "the server's bubble closes")
    assert.equal(onLaptop[1].takenBy, me)
    // the sound to the phone's loudspeaker from the laptop's bubble, and the route back on every computer
    assert.deepEqual(await laptop.sync.callAction('speaker'), { ok: true })
    assert.ok(p.asked.includes('/call/action?do=speaker'))
    await state({ state: 'active', number: '6900000001', route: 'speaker' })
    await until(() => onLaptop.length === 3)
    assert.deepEqual([onServer[2].route, onLaptop[2].route], ['speaker', 'speaker'])
    await state({ state: 'ended' })
    await until(() => onLaptop.length === 4)
    await state({ state: 'ringing', number: '6900000002' })
    await until(() => onLaptop.length === 5)
    assert.equal(onLaptop[4].takenBy, null, "a new call is nobody's yet")

    // Maps' "where I am" and a call placed from the laptop, both through the server
    const fix = await laptop.sync.phoneLocation()
    assert.deepEqual([fix.lat, fix.lng, fix.device], [40.64, 22.94, 'Xiaomi 15'])
    assert.deepEqual(await laptop.sync.callOnPhone('6900000003', 'Anna'), { how: 'calling', device: 'Xiaomi 15' })
    assert.ok(p.asked.some(u => u.startsWith('/call?number=6900000003')))
    // a client computer is never taken for a phone
    assert.ok(!p.asked.some(u => u.includes('laptop')))
  } finally {
    await server.sync.stop(); await laptop.sync.stop(); await p.close()
    fs.rmSync(tmp, { recursive: true })
  }
})

test('a NAS: the first client computer to join holds the crown', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-nas-'))
  const server = await computer(tmp, 'nas'), first = await computer(tmp, 'first'), second = await computer(tmp, 'second')
  const near = { targets: ['127.0.0.1'], beaconPort: server.sync.beaconPort }
  try {
    server.sync.setRole('server')
    assert.equal(server.sync.crown(), null, 'not a NAS: the server does its own analysis')
    server.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('nas', '1')").run()
    assert.equal(server.sync.nas(), true)
    assert.equal(server.sync.crown(), null, 'nobody to hold it yet')
    const crowned = []
    const a = new SyncClient(first.sync, { onCrown: c => crowned.push(['first', c]) }), b = new SyncClient(second.sync, { onCrown: c => crowned.push(['second', c]) })
    await a.join(server.sync.startPairing().key, near)
    await new Promise(r => setTimeout(r, 20))
    await b.join(server.sync.startPairing().key, near)
    await a.now(); await b.now()
    assert.equal(server.sync.crown(), a.pairing().id)
    assert.deepEqual(crowned, [['first', true], ['second', false]], 'the first to join does the photo analysis; the second learns its server is a NAS, and not its own')
    assert.equal(b.status().crown, false)
  } finally {
    await server.sync.stop(); await first.sync.stop(); await second.sync.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test("a call's sound crosses over Wi-Fi: the phone's voice to the computer that took the call, its microphone back", async () => {
  const { spawn } = require('node:child_process')
  const { bridge } = require('../callaudio')
  // stand-ins for parec (a voice) and pacat (a speaker that remembers what it played)
  const voice = text => spawn('sh', ['-c', `printf '%s' '${text}'; sleep 5`], { stdio: ['ignore', 'pipe', 'ignore'] })
  const speaker = into => { const p = spawn('cat', { stdio: ['pipe', 'pipe', 'ignore'] }); p.stdout.on('data', d => into.push(String(d))); return p }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-sound-'))
  const server = await computer(tmp, 'server'), laptop = await computer(tmp, 'laptop')
  try {
    server.sync.setRole('server')
    const client = new SyncClient(laptop.sync)
    await client.join(server.sync.startPairing().key, { targets: ['127.0.0.1'], beaconPort: server.sync.beaconPort })
    const toPhone = [], here = []
    assert.equal(await client.soundThere(), false, "the phone not on the server's Bluetooth: nothing to carry")
    server.sync.soundHere = () => true
    server.sync.callAudio = async (received, send) => bridge(received, send, {}, { capture: () => voice('caller says hi'), play: () => speaker(toPhone) })
    assert.equal(await client.soundThere(), true)
    const mine = (r, s) => bridge(r, s, {}, { capture: () => voice('laptop mic'), play: () => speaker(here) })
    await assert.rejects(client.callAudio(mine), 'not the computer that took the call')
    server.sync.callTaken = client.pairing().id
    const stop = await client.callAudio(mine)
    for (let i = 0; i < 100 && !(here.join('') && toPhone.join('')); i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(here.join(''), 'caller says hi')
    assert.equal(toPhone.join(''), 'laptop mic')
    stop()
  } finally {
    await server.sync.stop(); await laptop.sync.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})

test("the mirror: the server's photos shown on a client with their thumbnails, a photo fetched only when opened", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tetra-mirror-'))
  const server = await computer(tmp, 'server'), laptop = await computer(tmp, 'laptop')
  try {
    server.sync.setRole('server')
    const client = new SyncClient(laptop.sync)
    await client.join(server.sync.startPairing().key, { targets: ['127.0.0.1'], beaconPort: server.sync.beaconPort })
    const [device] = server.sync.devices()
    for (const c of ['photos', 'files']) server.sync.setConnection(device.id, c, { direction: 'both', keep: 'everything' })
    server.sync.completeSetup(device.id)
    const photo = crypto.randomBytes(4000), h = sha(photo)
    fs.mkdirSync(path.join(server.dir, 'Photos', '2026'), { recursive: true })
    fs.writeFileSync(path.join(server.dir, 'Photos', '2026', 'nas.jpg'), photo)
    server.db.prepare("INSERT INTO media(path, sha256, mime, is_video, size, mtime, taken_at, thumb) VALUES('2026/nas.jpg', ?, 'image/jpeg', 0, ?, 1, 1700000000000, 1)").run(h, photo.length)
    fs.mkdirSync(path.join(server.dir, 'data', 'thumbs'), { recursive: true })
    fs.writeFileSync(path.join(server.dir, 'data', 'thumbs', `${h}.webp`), 'a small preview')

    client.setMirror(true)
    await client.now()
    assert.equal(client.status().error, null)
    const row = laptop.db.prepare("SELECT path, location, thumb, taken_at FROM media WHERE sha256 = ?").get(h)
    assert.deepEqual({ ...row }, { path: '2026/nas.jpg', location: 'server', thumb: 1, taken_at: 1700000000000 })
    assert.equal(fs.readFileSync(path.join(laptop.dir, 'data', 'thumbs', `${h}.webp`), 'utf8'), 'a small preview')
    assert.equal(fs.existsSync(path.join(laptop.dir, 'Photos', '2026', 'nas.jpg')), false, 'shown, not fetched')
    // opened: the bytes come, checked, into the cache; a second open is the kept one
    const opened = await laptop.sync.locate({ ...row, sha256: h })
    assert.deepEqual(fs.readFileSync(opened.file), photo)
    await server.sync.stop()
    assert.equal((await laptop.sync.locate({ ...row, sha256: h })).file, opened.file, 'kept: opens with the server away')
    assert.equal((await laptop.sync.locate({ path: '2026/other.jpg', sha256: 'f'.repeat(64), location: 'server' })).file, null)
    // off: the rows go
    client.setMirror(false)
    assert.equal(laptop.db.prepare("SELECT COUNT(*) n FROM media WHERE location = 'server'").get().n, 0)
  } finally {
    await server.sync.stop().catch(() => {}); await laptop.sync.stop()
    fs.rmSync(tmp, { recursive: true })
  }
})
