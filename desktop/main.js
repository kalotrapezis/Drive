const { app, BrowserWindow, ipcMain, protocol, net, shell, Tray, Menu, Notification, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const library = require('./library')
const { Files } = require('./files')
const faces = require('./faces')
const places = require('./places')
const { Vault } = require('./vault')
const editor = require('./editor')
const docs = require('./documents')
const { SyncServer } = require('./sync')
const { Folders } = require('./folders')
const { Purgatory } = require('./purgatory')
const history = require('./history')
const { Notes } = require('./notes')

const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')
// ~/Tetra/Photos and ~/Tetra/Files, moved from ~/Drive once (home.js). Never from a hidden QA copy (scripts/shot.js),
// which must not rename the real folders. Both can be overridden for testing with disposable files.
const home = require('./home')
const HOME = home.roots(os.homedir(), { migrate: !process.env.DRIVE_HIDDEN })
if (HOME.moved.length) {
  console.log('[home] moved', HOME.moved.join('; '))
  try { fs.copyFileSync(path.join(DATA_DIR, 'library.db'), path.join(DATA_DIR, 'library.db.before-tetra-folder')) } catch {}
}
if (HOME.note) console.warn('[home]', HOME.note)
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || HOME.photos
const FILES_ROOT = process.env.DRIVE_FILES || HOME.files

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let notes, db, files, people, documents, folders, vault, sync, purgatory, win, scanning = null
const FILE_CALLS = ['list', 'search', 'withTag', 'destinations', 'copy', 'move', 'rename', 'trash', 'emptyTrash', 'setFavorite', 'setColor',
  'favorites', 'recents', 'tags', 'createTag', 'setTags', 'properties', 'usage']
const NOTE_CALLS = ['list', 'create', 'save', 'snapshot', 'history', 'restoreVersion', 'remove']

const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// Local analysis (People, Documents): each starts only after an explicit request, like the phone; pausable; nothing
// is uploaded. It runs in analyzer.js, its own low-priority process, so reading a library never holds this thread.
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
// The window may already be gone when the worker stops (quitting): nothing to tell then.
const sendAnalysis = () => { if (win && !win.isDestroyed()) win.webContents.send('people-progress', { ...analysis }); updateTray() }
let analyzer = null, scanDone = null

/** The background thread (analyzer.js): scanning and analysis both run there, never on the window's thread. */
function worker() {
  if (analyzer) return analyzer
  analyzer = new (require('node:worker_threads').Worker)(path.join(__dirname, 'analyzer.js'))
  analyzer.postMessage({ type: 'init', dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, modelDir: path.join(__dirname, 'models') })
  analyzer.on('message', m => {
    if (m.type === 'progress') { Object.assign(analysis, m.analysis); sendAnalysis() }
    else if (m.type === 'scan-progress') win?.webContents.send('scan-progress', { done: m.done, changed: m.changed })
    else if (m.type === 'scanned') { const d = scanDone; scanDone = null; m.error ? d?.reject(new Error(m.error)) : d?.resolve(m.result) }
  })
  analyzer.on('error', e => console.error('[analyzer]', e))
  analyzer.on('exit', code => {
    analyzer = null
    scanDone?.reject(new Error(`The background process stopped (${code}).`)); scanDone = null
    if (analysis.running) Object.assign(analysis, { running: false, error: `Analysis stopped unexpectedly (${code}).` })
    sendAnalysis()
  })
  return analyzer
}

function startScan() {
  scanning ??= new Promise((resolve, reject) => { scanDone = { resolve, reject }; worker().postMessage({ type: 'scan' }) })
    .then(r => {
      const filled = folders.fill() // new photos in an included folder join its collection
      // Something new here is something a paired phone has not got: tell it, and it will come and fetch it.
      if (r?.changed || filled) { sync?.nudge().catch(() => {}); backUpPluggedDrives() }
      return r
    })
    .finally(() => { scanning = null; analyzeLibrary() })
  return scanning
}

// The tray: closing the window leaves Tetra running, because a phone that syncs at night needs something to sync
// with. The window comes back from here; Quit is the only thing that stops it.
let tray = null, quitting = false

/**
 * A drive that has been set up backs itself up whenever it is plugged in: a backup that waits for someone to
 * remember it is a backup that is a month old. One at a time, the same lock as the Devices guide's Start, and the
 * progress is in the tray, because the window is often closed.
 */
let driveBackup = null
function backUpToDrive(id) {
  if (driveBackup) return driveBackup.promise
  const name = db.prepare('SELECT name FROM sync_devices WHERE id = ?').get(String(id))?.name ?? 'the drive'
  driveBackup = { name, done: 0, total: 0 }
  updateTray()
  driveBackup.promise = sync.backUpToDrive(id, p => {
    Object.assign(driveBackup, p)
    win?.webContents.send('drive-progress', p)
    if (p.done % 25 === 0 || p.done === p.total) updateTray()
  }).finally(() => { driveBackup = null; updateTray() })
  return driveBackup.promise
}
async function backUpPluggedDrives() {
  if (driveBackup) return
  for (const d of await sync.drives().catch(() => [])) {
    const rule = d.device && db.prepare(`SELECT s.set_up_at, c.direction FROM sync_devices s
      LEFT JOIN sync_connections c ON c.device_id = s.id AND c.content IN ('photos', 'files') AND c.direction IN ('receive', 'both')
      WHERE s.id = ?`).get(d.device.id)
    if (!rule?.set_up_at || !rule.direction) continue // not set up, or both photos and files are Off
    await backUpToDrive(d.device.id).catch(e => console.warn('[drive]', e.message))
  }
}
function showWindow() { if (win) { win.show(); win.focus() } }

/**
 * Space, said out loud (SYNC_PLAN.md D3). Once a minute: what a storage drive that is plugged in could take off
 * this computer — "Free 22 GB … Yes?" — and, whatever Offload is set to, a disk past its threshold. Each is said
 * at most every few hours; the answer is always the person's, in the window, never automatic.
 */
let offer = null, moving = null
const said = { offer: 0, full: 0 }
const HOURS = 3_600_000
const fmtBytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
function notify(title, body) {
  // Kept as well as shown: a notification goes by in seconds, the Notifications page keeps them (asked 2026-09-26).
  try {
    db.exec('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0)')
    db.prepare('INSERT INTO notifications(at, title, body) VALUES(?,?,?)').run(Date.now(), String(title), body == null ? null : String(body))
    win?.webContents.send('notifications-changed')
  } catch (e) { console.warn('[notify]', e.message) }
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: path.join(__dirname, 'public', 'icon.png') })
  n.on('click', () => { showWindow(); if (offer) win?.webContents.send('offload-offer', offer.deviceId) })
  n.show()
}
async function checkSpace() {
  if (moving || driveBackup) return
  const plugged = await sync.drives().catch(() => [])
  offer = null
  for (const d of plugged) {
    if (!d.device || sync.driveRules(d.device.id).role !== 'storage') continue
    const plan = sync.offloadPlan(d.device.id)
    if (plan.count && (!offer || plan.bytes > offer.bytes)) offer = plan
  }
  updateTray()
  const disk = sync.disk()
  // Offload by itself (asked 2026-09-26, after three good ones by hand): what the plan offers goes, each copy read
  // back first as always, and it is said afterwards instead of asked before. Off on the drive's card to be asked again.
  if (offer?.rules.auto && Date.now() - (said.auto ?? 0) > HOURS) { // at most hourly: what failed is not retried every minute
    said.auto = Date.now()
    const { name, deviceId } = offer
    moveToDrive(deviceId, {}).then(r => r.moved && notify(`Freed ${fmtBytes(r.bytes)}`, `${r.moved.toLocaleString()} photos now live on ${name}; they open from there when it is plugged in.`
      + (r.failed.length ? ` ${r.failed.length} stayed here.` : '')))
      .catch(e => notify(`Could not free space on ${name}`, e.message))
    return
  }
  if (offer && Date.now() - said.offer > 12 * HOURS) {
    said.offer = Date.now()
    const why = offer.rules.offload ? `to bring this disk under ${offer.rules.percent} %` : `older than ${offer.rules.keep} ${offer.rules.unit}${offer.rules.keep > 1 ? 's' : ''}`
    notify(`Free ${fmtBytes(offer.bytes)}?`, `${offer.count.toLocaleString()} photos ${why} are safe on ${offer.name}. Click to review — Yes and they go.`)
  }
  const storage = sync.devices().find(x => x.rules?.role === 'storage' && x.rules.offload)
  const limit = storage ? storage.rules.percent : 90
  if (disk && disk.percent >= limit && Date.now() - said.full > 6 * HOURS) {
    said.full = Date.now()
    notify(`This disk is ${disk.percent} % full`, `${fmtBytes(disk.free)} left.` + (offer ? ` ${fmtBytes(offer.bytes)} of photos could go to ${offer.name}.`
      : storage ? '' : ' Make a drive Storage on the Devices page and old photos can move there.'))
  }
}
/** Trash past its days → the purgatory on the drive; purgatory past its days → gone (SYNC_PLAN.md D6). Hourly. */
let swept = 0
async function sweepPurgatory() {
  if (Date.now() - swept < HOURS || moving || driveBackup) return
  await sync.releaseTrashedMoved().catch(e => console.warn('[trash]', e.message))
  const drive = await sync.purgatoryDrive()
  if (!drive) return // the chosen drive is unplugged: nothing leaves a Trash without somewhere safe to go
  swept = Date.now()
  // Items still in the old place after a move that waited for a drive to be plugged in.
  if (purgatory.summary().some(s => s.driveId !== drive.id)) await purgatory.relocate(purgatory.settings().location, id => sync.purgatoryBase(id))
  const r = await purgatory.sweep(drive.id, drive.mount)
  if (r.entered || r.purged || r.failed.length) console.log(`[purgatory] ${r.entered} in, ${r.purged} deleted, ${r.failed.length} failed`, r.failed.slice(0, 3))
  if (r.entered) win?.webContents.send('sync-received')
}
function moveToDrive(id, options) {
  if (moving) throw new Error('A move is already running.')
  moving = sync.moveToDrive(id, options, p => win?.webContents.send('move-progress', p))
    .finally(() => {
      sync.releaseTrashedMoved().catch(() => {})
      moving = null; offer = null; said.offer = Date.now(); updateTray(); win?.webContents.send('sync-received') })
  return moving
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return
  const status = driveBackup ? `Backing up to ${driveBackup.name}: ${driveBackup.done.toLocaleString()} / ${driveBackup.total.toLocaleString()}`
    : analysis.running ? `Analysing ${analysis.done.toLocaleString()} / ${analysis.total.toLocaleString()}`
    : analysis.paused ? 'Analysis paused' : 'Up to date'
  tray.setToolTip(`Tetra — ${status}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tetra', click: showWindow },
    { label: status, enabled: false },
    { label: offer ? `Free ${fmtBytes(offer.bytes)}: ${offer.count.toLocaleString()} photos to ${offer.name}…` : '', visible: !!offer,
      click: () => { showWindow(); win?.webContents.send('offload-offer', offer.deviceId) } },
    analysis.running ? { label: 'Pause analysis', click: () => { analysis.paused = true; analyzer?.postMessage({ type: 'pause' }) } }
      : { label: 'Resume analysis', visible: analysis.paused, click: () => analyzeLibrary() },
    { type: 'separator' },
    { label: 'Quit Tetra', click: () => { quitting = true; app.quit() } },
  ]))
}

/** `rescan` — 'faces' or 'documents' — reads photos that were read before, because the rules changed since. */
function analyzeLibrary(rescan = null) {
  if (analysis.running) return
  analysis.running = true // until the analyzer says otherwise, so a second request does not start a second pass
  worker().postMessage({ type: 'start', rescan,
    wantFaces: setting('people_enabled') === '1' && rescan !== 'documents',
    wantDocs: setting('documents_enabled') === '1' && rescan !== 'faces' })
}

app.whenReady().then(() => {
  db = library.open(DATA_DIR)
  files = new Files(db, FILES_ROOT)
  // Notes live in a hidden folder of Files (notes.js), and sync through their own step, newest edit wins.
  notes = new Notes(path.join(FILES_ROOT, '.notes'), 'tetra-desktop')
  people = new faces.People(db, DATA_DIR)
  vault = new Vault(db, DATA_DIR)
  documents = new docs.Documents(db)
  // Read on each question, not once: a device's Photos row can change while the app runs.
  folders = new Folders(db, () => !!sync?.devices().some(d => !d.volume_uuid && d.connections.some(c => c.content === 'photos' && c.direction === 'both')))
  // Phone sync: always listening (paired phones only); received photos show up after a short, batched rescan.
  let rescanTimer = null
  purgatory = new Purgatory({ db, photosRoot: PHOTOS_ROOT, files, serverBase: path.dirname(HOME.root) })
  sync = new SyncServer({ db, documents, people, files, notes, onNotes: () => win?.webContents.send('notes-changed'), onNotesSynced: s => win?.webContents.send('notes-synced', s), dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, trashItem: f => shell.trashItem(f), purgatory, onReceived: () => {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => { startScan(); win?.webContents.send('sync-received') }, 3000)
  } })
  sync.start().catch(e => { sync.error = e.message })
  purgatory.held = sha => sync.heldSafely(sha)
  // Photos moved before a Move deleted outright are still in the system Trash, taking the room they were to free.
  setTimeout(() => sync.releaseTrashedMoved().then(n => n && console.log(`[trash] ${n} moved photos let go`)).catch(() => {}), 5000)
  // A drive plugged in is noticed within a minute. Never from a hidden QA copy (scripts/shot.js): it would back up
  // and notify from a database that is not the real one.
  if (!process.env.DRIVE_HIDDEN) setInterval(() => backUpPluggedDrives().then(checkSpace).then(sweepPurgatory).catch(e => console.warn('[space]', e.message)), 60_000)
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
  // The Notes app's vault moves in once (its folders become labels); the old one is only read, never changed.
  if (!process.env.DRIVE_HIDDEN && !setting('notesImported')) {
    const n = notes.importVault(path.join(os.homedir(), '.local', 'share', 'Notes', 'notes'))
    setSetting('notesImported', String(Date.now()))
    if (n) history.record(db, { action: 'notes moved in', detail: `${n} notes from ~/.local/share/Notes` })
  }
  if (!process.env.DRIVE_HIDDEN) notes.sweep()

  // media://thumb/<sha256>  and  media://file/<id>  — only files the database knows about are served.
  protocol.handle('media', async request => {
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname.slice(1))
    let file
    if (url.host === 'thumb' && /^[0-9a-f]{64}$/.test(key)) file = path.join(DATA_DIR, 'thumbs', key + '.webp')
    if (url.host === 'file') {
      const row = db.prepare('SELECT path, sha256, location FROM media WHERE id = ?').get(Number(key))
      if (row) file = (await sync.locate(row)).file // on the storage drive, or null when it is not plugged in
      // A preview made before the move is still in the cache, so a moved HEIC opens without the drive.
      if (row && library.needsPreview(row.path)) file = await library.preview(file, row.sha256, DATA_DIR).catch(() => null)
    }
    if (url.host === 'face' && /^[0-9a-f-]{36}$/.test(key)) file = await people.crop(key, PHOTOS_ROOT).catch(() => null)
    // A trashed photo is no longer in the library, so it is served from the trash by the name it has there.
    if (url.host === 'trash') file = (await library.trashedPhotos(PHOTOS_ROOT)).find(t => t.id === key)?.file ?? null
    // Hidden: decrypted in memory only while unlocked; never written to disk in plaintext.
    if ((url.host === 'vault' || url.host === 'vault-thumb') && /^[0-9a-f-]{36}$/.test(key)) {
      if (!vault.status().unlocked) return new Response('Locked', { status: 403 })
      try {
        const row = db.prepare('SELECT mime FROM vault_items WHERE id = ?').get(key)
        const body = url.host === 'vault' ? await vault.decrypt(key) : vault.thumb(key)
        if (!row || !body) return new Response('Not found', { status: 404 })
        return new Response(body, { headers: { 'content-type': url.host === 'vault' ? row.mime : 'image/webp', 'cache-control': 'no-store' } })
      } catch { return new Response('Unreadable', { status: 500 }) }
    }
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
  })

  ipcMain.handle('library:info', () => ({ photosRoot: PHOTOS_ROOT }))
  // The Photos view shows the default folders and the ones you said yes to (folders.js); the library keeps all.
  ipcMain.handle('library:list', () => {
    const c = folders.choices()
    const names = new Map(db.prepare('SELECT id, name FROM sync_devices WHERE volume_uuid IS NOT NULL').all().map(d => [d.id, d.name]))
    return library.list(db).filter(m => folders.isShown(m.path, c)).map(m => m.location ? { ...m, drive: names.get(m.location) ?? 'a drive' } : m)
  })
  ipcMain.handle('folders:list', () => folders.list().map(({ shas, ...f }) => f))
  ipcMain.handle('folders:set', (_, name, included) => { folders.set(name, included); sync.nudge().catch(() => {}) })
  ipcMain.handle('library:scan', () => startScan())
  ipcMain.handle('photos:favorite', (_, shas, on) => library.setFavorite(db, shas, on))
  ipcMain.handle('photos:trash', async (_, ids) => {
    const rows = ids.map(id => db.prepare('SELECT path, sha256, size FROM media WHERE id = ?').get(Number(id))).filter(Boolean)
    for (const r of rows) history.record(db, { action: 'trashed', kind: 'photo', name: r.path, sha256: r.sha256, size: r.size })
    const result = await library.trash(db, PHOTOS_ROOT, ids, f => shell.trashItem(f))
    // Trashed here on purpose: a device that still holds one must not send it back (restoring it lifts that).
    sync.deletedHere(rows.filter(r => !db.prepare('SELECT 1 FROM media WHERE sha256 = ?').get(r.sha256)).map(r => r.sha256))
    return result
  })
  ipcMain.handle('photos:places', () => folders.places())
  ipcMain.handle('photos:moveTo', (_, ids, dest) => {
    const r = folders.move(PHOTOS_ROOT, ids, dest)
    if (r.moved) { sync.nudge().catch(() => {}); history.record(db, { action: 'moved to folder', kind: 'photo', name: dest, detail: `${r.moved} photos` }) }
    return r
  })
  // A collection named after an included folder is that folder: taking a photo out of it moves the file.
  ipcMain.handle('collections:list', () => { const albums = folders.folderAlbums(); return [...library.collections(db).map(c => ({ ...c, folder: albums.has(c.name.toLowerCase()) })), ...sync.driveAlbums()] })
  ipcMain.handle('collections:create', (_, name) => library.createCollection(db, name))
  ipcMain.handle('collections:delete', (_, id) => library.deleteCollection(db, id))
  // A drive's collection is the drive (sync.js driveMembers): adding copies there, removing takes it off.
  const driveOf = id => String(id).startsWith('drive:') ? String(id).slice(6) : null
  ipcMain.handle('collections:members', (_, id) => driveOf(id) ? sync.driveMembers(driveOf(id)) : library.members(db, id))
  ipcMain.handle('collections:set', async (_, id, shas, member) => {
    if (!driveOf(id)) return library.setMembership(db, id, shas, member)
    const r = member ? await sync.addToDrive(driveOf(id), shas) : await sync.removeFromDrive(driveOf(id), shas)
    if (r.failed.length) throw new Error(`${r.failed.length} could not: ${r.failed.slice(0, 2).join('; ')}`)
    return r
  })
  ipcMain.handle('drive:delete', (_, id, shas) => sync.deleteFromDrive(String(id), shas))
  ipcMain.handle('collections:hide', (_, id, hidden) => library.setCollectionHidden(db, id, hidden))
  // Photos Trash is the system's own trash, filtered to what came out of this library.
  ipcMain.handle('trash:list', () => library.trashedPhotos(PHOTOS_ROOT))
  ipcMain.handle('trash:restore', async (_, ids) => {
    const r = await library.restoreTrashed(PHOTOS_ROOT, ids); startScan()
    for (const p of r.restored) history.record(db, { action: 'restored', kind: 'photo', name: p })
    return r
  })
  // By hand, so a plain delete (D6): the person chose it.
  ipcMain.handle('trash:empty', async () => { const n = await library.emptyPhotoTrash(PHOTOS_ROOT); history.record(db, { action: 'emptied Trash by hand', kind: 'photo', detail: `${n} deleted` }); return n })
  ipcMain.handle('history:list', (_, options) => history.list(db, options ?? {}))
  ipcMain.handle('purgatory:settings', () => ({ ...purgatory.settings(), summary: purgatory.summary() }))
  ipcMain.handle('purgatory:set', (_, changes) => purgatory.setSettings(changes ?? {}))
  ipcMain.handle('purgatory:setLocation', (_, driveId) => purgatory.relocate(driveId ? String(driveId) : '', id => sync.purgatoryBase(id)))
  // These two describe the library, not this computer, so they live in the database and sync (SYNC_PLAN.md).
  ipcMain.handle('settings:view', () => ({ hideScreenshots: setting('hideScreenshots') === '1', hideDocuments: setting('hideDocuments') === '1' }))
  ipcMain.handle('settings:setView', (_, key, on) => {
    if (key !== 'hideScreenshots' && key !== 'hideDocuments') return
    setSetting(key, on ? '1' : '0')
    setSetting('viewSettingsUpdatedAt', String(Date.now()))
  })
  ipcMain.handle('people:status', () => ({ ...analysis, enabled: setting('people_enabled') === '1', documentsEnabled: setting('documents_enabled') === '1',
    reviews: people.reviewCount() + documents.reviewCount() + folders.questions() }))
  ipcMain.handle('people:start', () => { setSetting('people_enabled', '1'); analyzeLibrary() })
  ipcMain.handle('documents:start', () => { setSetting('documents_enabled', '1'); analyzeLibrary() })
  ipcMain.handle('documents:nextReview', () => documents.nextReview())
  ipcMain.handle('documents:answer', (_, sha, answer) => {
    documents.answer(sha, answer)
    if (!people.nextReview() && !documents.nextReview()) sync.nudge().catch(() => {})
  })
  ipcMain.handle('documents:set', (_, sha, on) => documents.set(sha, on))
  ipcMain.handle('people:rescan', () => { setSetting('people_enabled', '1'); people.forgetUnnamed(); analyzeLibrary('faces') })
  ipcMain.handle('documents:rescan', () => { setSetting('documents_enabled', '1'); analyzeLibrary('documents') })
  ipcMain.handle('people:pause', () => { analysis.paused = true; analyzer?.postMessage({ type: 'pause' }) })
  ipcMain.handle('people:list', () => people.list())
  ipcMain.handle('people:forgotten', () => people.list(true))
  ipcMain.handle('people:setHidden', (_, id, hidden) => people.setHidden(id, hidden))
  ipcMain.handle('people:shas', (_, id) => people.shas(id))
  ipcMain.handle('people:names', () => people.namesBySha())
  ipcMain.handle('people:rename', (_, id, name) => people.rename(id, name))
  ipcMain.handle('people:faces', (_, id) => people.facesOf(id))
  ipcMain.handle('people:setCover', (_, id, faceId) => people.setCover(id, faceId))
  ipcMain.handle('people:merge', (_, source, target) => people.merge(source, target))
  ipcMain.handle('people:detach', (_, id, shas) => people.detach(id, shas))
  ipcMain.handle('people:undoMerge', (_, undo) => people.undoMerge(undo))
  ipcMain.handle('people:mergeHistory', (_, id) => people.mergeHistory(id))
  ipcMain.handle('people:restoreMerge', (_, id) => people.restoreMerge(id))
  ipcMain.handle('people:nextReview', () => people.nextReview())
  ipcMain.handle('people:answer', (_, faceId, personId, answer) => {
    people.answer(faceId, personId, answer)
    if (!people.nextReview() && !documents.nextReview()) sync.nudge().catch(() => {})
  })
  ipcMain.handle('vault:status', () => vault.status())
  ipcMain.handle('vault:setup', (_, pass) => vault.setup(pass))
  ipcMain.handle('vault:unlock', (_, pass) => vault.unlock(pass))
  ipcMain.handle('vault:lock', () => vault.lock())
  ipcMain.handle('vault:list', () => vault.list())
  ipcMain.handle('vault:hide', async (_, ids) => {
    const result = { hidden: 0, failed: [] }
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM media WHERE id = ? AND location IS NULL').get(Number(id))
      if (!row) { result.failed.push('A photo on a storage drive cannot be hidden from here.'); continue }
      try {
        await vault.hide(row, path.join(PHOTOS_ROOT, row.path), path.join(DATA_DIR, 'thumbs', row.sha256 + '.webp'))
        // No plaintext traces: thumbnail, HEIC preview and face crops of this photo go too.
        for (const f of [row.sha256 + '.webp', row.sha256 + '.preview.jpg']) fs.rmSync(path.join(DATA_DIR, 'thumbs', f), { force: true })
        for (const { id: faceId } of db.prepare('SELECT id FROM faces WHERE sha256 = ?').all(row.sha256)) fs.rmSync(path.join(DATA_DIR, 'thumbs', 'faces', faceId + '.webp'), { force: true })
        db.prepare('DELETE FROM media WHERE id = ?').run(row.id)
        result.hidden++
      } catch (e) { result.failed.push(`${row.path}: ${e.message}`) }
    }
    return result
  })
  ipcMain.handle('vault:restore', async (_, ids) => {
    const restored = []
    for (const id of ids) restored.push(await vault.restore(id, PHOTOS_ROOT))
    await startScan()
    return restored
  })
  // Editor: bytes in (HEIC via its JPEG preview), JPEG out.
  ipcMain.handle('editor:load', async (_, id) => {
    const row = db.prepare('SELECT path, sha256, location FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error('This photo is no longer in the library.')
    const { file: full, why } = await sync.locate(row)
    if (!full) throw new Error(why)
    return fs.promises.readFile(library.needsPreview(row.path) ? await library.preview(full, row.sha256, DATA_DIR) : full)
  })
  ipcMain.handle('editor:save', async (_, id, bytes, mode) => {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error('This photo is no longer in the library.')
    // ponytail: saving next to a photo that lives on the storage drive is not built; bring it back first.
    if (row.location) throw new Error('This photo lives on a storage drive; saving an edit there is not possible yet.')
    const full = path.join(PHOTOS_ROOT, row.path)
    const target = mode === 'replace'
      ? await editor.replace(full, bytes, row.taken_at, f => shell.trashItem(f))
      : await editor.saveCopy(full, bytes, row.taken_at)
    if (mode === 'replace') {
      // The content changed, so its hash did: favorites and collections follow the photo (the phone loses them here).
      const sha = await library.sha256(target), now = Date.now()
      db.prepare('INSERT OR REPLACE INTO photo_state(sha256, favorite, updated_at) SELECT ?, favorite, ? FROM photo_state WHERE sha256 = ?').run(sha, now, row.sha256)
      db.prepare('INSERT OR IGNORE INTO collection_items(collection_id, sha256, updated_at, deleted) SELECT collection_id, ?, ?, 0 FROM collection_items WHERE sha256 = ? AND deleted = 0').run(sha, now, row.sha256)
    }
    await startScan()
    return path.relative(PHOTOS_ROOT, target)
  })
  // This PC's own counts for the Devices page, which asks every 3 s: files are walked at most once a minute.
  let filesCount = { at: 0, n: 0 }
  const selfCounts = async () => {
    if (Date.now() - filesCount.at > 60_000) filesCount = { at: Date.now(), n: (await files.all().catch(() => [])).filter(i => !i.dir).length }
    return { photos: db.prepare('SELECT COUNT(*) n FROM media WHERE location IS NULL').get().n, files: filesCount.n }
  }
  ipcMain.handle('sync:status', async () => ({ counts: await selfCounts(), port: sync.port, fingerprint: sync.fingerprint, error: sync.error ?? null,
    addresses: require('node:os').networkInterfaces && Object.values(require('node:os').networkInterfaces()).flat().filter(a => a?.family === 'IPv4' && !a.internal).map(a => a.address),
    devices: sync.devices(), overview: sync.overview(), self: sync.self(), disk: sync.disk() }))
  ipcMain.handle('sync:pair', async () => {
    const payload = sync.startPairing()
    return { payload, qr: await require('qrcode').toDataURL(JSON.stringify(payload), { margin: 1, width: 360, errorCorrectionLevel: 'M' }) }
  })
  ipcMain.handle('sync:files', (_, what, options) => sync.fileList(what, options ?? {}))
  ipcMain.handle('sync:setDevice', (_, id, changes) => sync.setDevice(id, changes ?? {}))
  ipcMain.handle('sync:setSelf', (_, changes) => sync.setSelf(changes ?? {}))
  ipcMain.handle('sync:completeSetup', (_, id) => sync.completeSetup(id))
  ipcMain.handle('sync:drives', () => sync.drives())
  ipcMain.handle('sync:inspectDrive', (_, uuid) => sync.inspectDrive(uuid))
  ipcMain.handle('sync:addDrive', (_, drive) => sync.addDrive(drive ?? {}))
  ipcMain.handle('sync:backUpToDrive', (_, id) => backUpToDrive(id))
  ipcMain.handle('sync:forget', (_, id) => sync.forget(id))
  ipcMain.handle('sync:setDriveRules', (_, id, rules) => sync.setDriveRules(id, rules ?? {}))
  ipcMain.handle('sync:offloadPlan', (_, id) => ({ ...sync.offloadPlan(id), ids: undefined }))
  ipcMain.handle('sync:moveToDrive', (_, id, options) => moveToDrive(id, options ?? {}))
  ipcMain.handle('sync:setConnection', (_, id, content, rules) => sync.setConnection(id, content, rules))
  ipcMain.handle('sync:movePreview', (_, id, options) => sync.movePreview(id, options ?? {}))
  ipcMain.handle('open-map', (_, lat, lon) => {
    if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Invalid location.')
    return shell.openExternal(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`)
  })
  ipcMain.handle('files:root', () => files.root)
  ipcMain.handle('files:call', (_, method, ...args) => {
    if (!FILE_CALLS.includes(method)) throw new Error('Unknown Files action.')
    if (method === 'trash' || method === 'emptyTrash') history.record(db, { action: method === 'trash' ? 'trashed' : 'emptied Trash by hand', kind: 'file', name: method === 'trash' ? String(args[0]) : null })
    return files[method](...args)
  })
  // A note changed here: the devices are told a few seconds after the typing stops, so a delete or an edit reaches
  // them without waiting for their own sync (asked 2026-09-26). Only a device with Tetra open is listening.
  let notesNudge = null
  ipcMain.handle('notes:synced', () => sync.notesSynced)
  db.exec('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0)')
  ipcMain.handle('notifications:list', () => db.prepare('SELECT id, at, title, body, read FROM notifications ORDER BY at DESC LIMIT 500').all())
  ipcMain.handle('notifications:read', () => { db.exec('UPDATE notifications SET read = 1 WHERE read = 0') })
  ipcMain.handle('notifications:clear', () => { db.exec('DELETE FROM notifications') })
  // Appearance: Auto follows the system, or Light / Dark whatever it says. The page's colours follow nativeTheme.
  ipcMain.handle('settings:theme', () => setting('theme') || 'system')
  ipcMain.handle('settings:setTheme', (_, t) => { if (!['system', 'light', 'dark'].includes(t)) return; setSetting('theme', t); nativeTheme.themeSource = t })
  ipcMain.handle('notes:call', (_, method, ...args) => {
    if (!NOTE_CALLS.includes(method)) throw new Error('Unknown Notes action.')
    const result = notes[method](...args)
    if (['save', 'remove', 'restoreVersion'].includes(method)) {
      clearTimeout(notesNudge)
      notesNudge = setTimeout(() => sync.nudge().catch(() => {}), 2500)
    }
    return result
  })
  ipcMain.handle('files:open', async (_, rel) => {
    const full = files.resolve(rel)
    const error = await shell.openPath(full)
    if (error) throw new Error(error)
    if (require('node:fs').statSync(full).isFile()) files.recordOpen(rel) // Recent lists files only, like the phone
  })
  ipcMain.handle('files:reveal', (_, rel) => shell.showItemInFolder(files.resolve(rel)))
  ipcMain.handle('library:show', (_, id) => {
    const row = db.prepare('SELECT path, location FROM media WHERE id = ?').get(id)
    if (row) sync.locate(row).then(at => at.file && shell.showItemInFolder(at.file))
  })

  if (!process.env.DRIVE_HIDDEN && HOME.root.endsWith('Tetra')) home.markFolder(HOME.root, path.join(__dirname, 'public', 'icon.png'), DATA_DIR)
  nativeTheme.themeSource = setting('theme') || 'system'
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 500,
    backgroundColor: '#121416', title: 'Tetra',
    icon: path.join(__dirname, 'public', 'icon.png'),
    autoHideMenuBar: true,
    show: !process.env.DRIVE_HIDDEN, // visual QA (scripts/shot.js) renders without appearing on the desktop
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: !!process.env.DRIVE_HIDDEN },
  })
  // Right-click on text: the usual Cut / Copy / Paste / Select all, and spelling suggestions (asked 2026-09-26; Electron
  // gives none by itself). Undo and Redo stay the note's own, by the word — the built-in ones would not know about it.
  win.webContents.on('context-menu', (_, p) => {
    const items = []
    for (const word of p.dictionarySuggestions ?? []) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) })
    if (p.misspelledWord) items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' })
    else if (p.selectionText.trim()) items.push({ role: 'copy' })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL)
  else win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  if (!process.env.DRIVE_HIDDEN) {
    tray = new Tray(path.join(__dirname, 'public', 'icon.png'))
    tray.on('click', showWindow)
    updateTray()
    win.on('close', e => {
      if (quitting) return
      e.preventDefault() // to the tray, not away
      win.hide()
      // Hidden stays locked whenever nobody is looking: closing used to quit, and quitting locked it.
      vault?.lock()
      win.webContents.reload()
    })
  }
})

// One Tetra at a time: opening it again brings back the window that is already running in the tray. (Visual QA
// renders a hidden second copy on purpose, and is left alone.)
if (!process.env.DRIVE_HIDDEN && !app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', showWindow)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { quitting = true; vault?.lock(); analyzer?.terminate() })
