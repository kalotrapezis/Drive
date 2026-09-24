const { app, BrowserWindow, ipcMain, protocol, net, shell, Tray, Menu } = require('electron')
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

// Override both for testing with disposable files.
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || path.join(os.homedir(), 'Drive', 'Photos')
const FILES_ROOT = process.env.DRIVE_FILES || path.join(os.homedir(), 'Drive', 'Drive')
const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let db, files, people, documents, folders, vault, sync, win, scanning = null
const FILE_CALLS = ['list', 'search', 'withTag', 'destinations', 'copy', 'move', 'rename', 'trash', 'emptyTrash', 'setFavorite', 'setColor',
  'favorites', 'recents', 'tags', 'createTag', 'setTags', 'properties', 'usage']

const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// Local analysis (People, Documents): each starts only after an explicit request, like the phone; pausable; nothing
// is uploaded. It runs in analyzer.js, its own low-priority process, so reading a library never holds this thread.
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
const sendAnalysis = () => { win?.webContents.send('people-progress', { ...analysis }); updateTray() }
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
function updateTray() {
  if (!tray) return
  const status = driveBackup ? `Backing up to ${driveBackup.name}: ${driveBackup.done.toLocaleString()} / ${driveBackup.total.toLocaleString()}`
    : analysis.running ? `Analysing ${analysis.done.toLocaleString()} / ${analysis.total.toLocaleString()}`
    : analysis.paused ? 'Analysis paused' : 'Up to date'
  tray.setToolTip(`Tetra — ${status}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tetra', click: showWindow },
    { label: status, enabled: false },
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
  people = new faces.People(db, DATA_DIR)
  vault = new Vault(db, DATA_DIR)
  documents = new docs.Documents(db)
  folders = new Folders(db)
  // Phone sync: always listening (paired phones only); received photos show up after a short, batched rescan.
  let rescanTimer = null
  sync = new SyncServer({ db, documents, people, files, dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, onReceived: () => {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => { startScan(); win?.webContents.send('sync-received') }, 3000)
  } })
  sync.start().catch(e => { sync.error = e.message })
  setInterval(() => backUpPluggedDrives(), 60_000) // a drive plugged in is noticed within a minute
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')

  // media://thumb/<sha256>  and  media://file/<id>  — only files the database knows about are served.
  protocol.handle('media', async request => {
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname.slice(1))
    let file
    if (url.host === 'thumb' && /^[0-9a-f]{64}$/.test(key)) file = path.join(DATA_DIR, 'thumbs', key + '.webp')
    if (url.host === 'file') {
      const row = db.prepare('SELECT path, sha256 FROM media WHERE id = ?').get(Number(key))
      if (row) file = path.join(PHOTOS_ROOT, row.path)
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
  ipcMain.handle('library:list', () => { const c = folders.choices(); return library.list(db).filter(m => folders.isShown(m.path, c)) })
  ipcMain.handle('folders:list', () => folders.list().map(({ shas, ...f }) => f))
  ipcMain.handle('folders:set', (_, name, included) => { folders.set(name, included); sync.nudge().catch(() => {}) })
  ipcMain.handle('library:scan', () => startScan())
  ipcMain.handle('photos:favorite', (_, shas, on) => library.setFavorite(db, shas, on))
  ipcMain.handle('photos:trash', (_, ids) => library.trash(db, PHOTOS_ROOT, ids, f => shell.trashItem(f)))
  ipcMain.handle('collections:list', () => library.collections(db))
  ipcMain.handle('collections:create', (_, name) => library.createCollection(db, name))
  ipcMain.handle('collections:delete', (_, id) => library.deleteCollection(db, id))
  ipcMain.handle('collections:members', (_, id) => library.members(db, id))
  ipcMain.handle('collections:set', (_, id, shas, member) => library.setMembership(db, id, shas, member))
  ipcMain.handle('collections:hide', (_, id, hidden) => library.setCollectionHidden(db, id, hidden))
  // Photos Trash is the system's own trash, filtered to what came out of this library.
  ipcMain.handle('trash:list', () => library.trashedPhotos(PHOTOS_ROOT))
  ipcMain.handle('trash:restore', async (_, ids) => { const r = await library.restoreTrashed(PHOTOS_ROOT, ids); startScan(); return r })
  ipcMain.handle('trash:empty', () => library.emptyPhotoTrash(PHOTOS_ROOT))
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
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id))
      if (!row) continue
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
    const row = db.prepare('SELECT path, sha256 FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error('This photo is no longer in the library.')
    const full = path.join(PHOTOS_ROOT, row.path)
    return fs.promises.readFile(library.needsPreview(row.path) ? await library.preview(full, row.sha256, DATA_DIR) : full)
  })
  ipcMain.handle('editor:save', async (_, id, bytes, mode) => {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error('This photo is no longer in the library.')
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
  ipcMain.handle('sync:status', () => ({ port: sync.port, fingerprint: sync.fingerprint, error: sync.error ?? null,
    addresses: require('node:os').networkInterfaces && Object.values(require('node:os').networkInterfaces()).flat().filter(a => a?.family === 'IPv4' && !a.internal).map(a => a.address),
    devices: sync.devices(), overview: sync.overview(), self: sync.self() }))
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
  ipcMain.handle('sync:setConnection', (_, id, content, rules) => sync.setConnection(id, content, rules))
  ipcMain.handle('open-map', (_, lat, lon) => {
    if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Invalid location.')
    return shell.openExternal(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`)
  })
  ipcMain.handle('files:root', () => files.root)
  ipcMain.handle('files:call', (_, method, ...args) => {
    if (!FILE_CALLS.includes(method)) throw new Error('Unknown Files action.')
    return files[method](...args)
  })
  ipcMain.handle('files:open', async (_, rel) => {
    const full = files.resolve(rel)
    const error = await shell.openPath(full)
    if (error) throw new Error(error)
    if (require('node:fs').statSync(full).isFile()) files.recordOpen(rel) // Recent lists files only, like the phone
  })
  ipcMain.handle('files:reveal', (_, rel) => shell.showItemInFolder(files.resolve(rel)))
  ipcMain.handle('library:show', (_, id) => {
    const row = db.prepare('SELECT path FROM media WHERE id = ?').get(id)
    if (row) shell.showItemInFolder(path.join(PHOTOS_ROOT, row.path))
  })

  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 500,
    backgroundColor: '#121416', title: 'Tetra',
    icon: path.join(__dirname, 'public', 'icon.png'),
    autoHideMenuBar: true,
    show: !process.env.DRIVE_HIDDEN, // visual QA (scripts/shot.js) renders without appearing on the desktop
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: !!process.env.DRIVE_HIDDEN },
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
