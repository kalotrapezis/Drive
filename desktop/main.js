const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron')
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

// Override both for testing with disposable files.
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || path.join(os.homedir(), 'Drive', 'Photos')
const FILES_ROOT = process.env.DRIVE_FILES || path.join(os.homedir(), 'Drive', 'Drive')
const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let db, files, people, documents, vault, sync, win, scanning = null
const FILE_CALLS = ['list', 'search', 'withTag', 'destinations', 'copy', 'move', 'rename', 'trash', 'emptyTrash', 'setFavorite', 'setColor',
  'favorites', 'recents', 'tags', 'createTag', 'setTags', 'properties', 'usage']

function startScan() {
  scanning ??= library.scan(db, PHOTOS_ROOT, DATA_DIR, (done, changed) => win?.webContents.send('scan-progress', { done, changed }))
    .then(r => {
      places.fill(db)
      // Something new here is something a paired phone has not got: tell it, and it will come and fetch it.
      if (r?.changed) sync?.nudge().catch(() => {})
      return r
    })
    .finally(() => { scanning = null; analyzeLibrary() })
  return scanning
}

const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// Local analysis (People, Documents): each starts only after an explicit request, like the phone; pausable; nothing
// is uploaded. One pass decodes each photo once for whatever still needs it.
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
const engines = {}
const sendAnalysis = () => win?.webContents.send('people-progress', { ...analysis })
const isScreenshot = p => /screenshot|στιγμιοτυπο|screen[ _-]?shot|scrnshot/.test(p.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())

/** `rescan` — 'faces' or 'documents' — reads photos that were read before, because the rules changed since. */
async function analyzeLibrary(rescan = null) {
  if (analysis.running) return
  Object.assign(analysis, { running: true, paused: false, done: 0, error: '' })
  try {
    const wantFaces = setting('people_enabled') === '1' && rescan !== 'documents'
    const wantDocs = setting('documents_enabled') === '1' && rescan !== 'faces'
    const todo = new Map()
    if (wantFaces) for (const r of people.pending(rescan === 'faces')) todo.set(r.sha256, { ...r, faces: true })
    if (wantDocs) for (const r of documents.pending(rescan === 'documents')) todo.set(r.sha256, { ...(todo.get(r.sha256) ?? r), docs: true })
    if (wantFaces) engines.faces ??= await faces.FaceEngine.load(path.join(__dirname, 'models'))
    if (wantDocs) engines.docs ??= await docs.DocEngine.load(path.join(__dirname, 'models'))
    if (wantDocs) engines.scene ??= await docs.SceneEngine.load(path.join(__dirname, 'models'))
    analysis.total = todo.size
    sendAnalysis()
    for (const job of todo.values()) {
      if (analysis.paused) break
      if (isScreenshot(job.path)) { // screenshots have their own collection; the phone skips faces there too
        if (job.faces) people.skip(job.sha256)
        if (job.docs) documents.record(job.sha256, 0)
      } else {
        let img = null
        try { img = await faces.FaceEngine.decode(path.join(PHOTOS_ROOT, job.path)) } catch {}
        if (job.faces) {
          try {
            if (!img) throw new Error('unreadable')
            const found = await engines.faces.analyze(img)
            const ids = people.record(job.sha256, found, img)
            for (const [i, id] of ids.entries()) await people.saveCrop(img, id, found[i].box).catch(() => {})
          } catch { people.skip(job.sha256) } // unreadable image: analysed as "no faces", like a failed decode on the phone
        }
        if (job.docs) {
          // Phone: one classification pass gives the document score and the search labels.
          const row = img && db.prepare('SELECT MAX(taken_at) t FROM media WHERE sha256 = ?').get(job.sha256)
          const labels = img ? [...await engines.scene.classify(img).catch(() => []), docs.likelyTimeOfDay(row.t, docs.averageLuminance(img))].filter(Boolean) : []
          if (db.prepare('SELECT 1 FROM faces WHERE sha256 = ? AND deleted = 0').get(job.sha256)) labels.push('Portrait')
          documents.record(job.sha256, img ? (await engines.docs.classify(img).catch(() => ({ confidence: 0 }))).confidence : 0, labels)
        }
      }
      analysis.done++
      if (analysis.done % 5 === 0 || analysis.done === analysis.total) sendAnalysis()
    }
  } catch (e) { analysis.error = String(e.message ?? e) }
  analysis.running = false
  sendAnalysis()
}

app.whenReady().then(() => {
  db = library.open(DATA_DIR)
  files = new Files(db, FILES_ROOT)
  people = new faces.People(db, DATA_DIR)
  vault = new Vault(db, DATA_DIR)
  documents = new docs.Documents(db)
  // Phone sync: always listening (paired phones only); received photos show up after a short, batched rescan.
  let rescanTimer = null
  sync = new SyncServer({ db, documents, people, files, dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, onReceived: () => {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => { startScan(); win?.webContents.send('sync-received') }, 3000)
  } })
  sync.start().catch(e => { sync.error = e.message })
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
      if (row && library.isHeic(row.path)) file = await library.preview(file, row.sha256, DATA_DIR).catch(() => null)
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
  ipcMain.handle('library:list', () => library.list(db))
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
    reviews: people.reviewCount() + documents.reviewCount() }))
  ipcMain.handle('people:start', () => { setSetting('people_enabled', '1'); analyzeLibrary() })
  ipcMain.handle('documents:start', () => { setSetting('documents_enabled', '1'); analyzeLibrary() })
  ipcMain.handle('documents:nextReview', () => documents.nextReview())
  ipcMain.handle('documents:answer', (_, sha, answer) => documents.answer(sha, answer))
  ipcMain.handle('documents:set', (_, sha, on) => documents.set(sha, on))
  ipcMain.handle('people:rescan', () => { setSetting('people_enabled', '1'); people.forgetUnnamed(); analyzeLibrary('faces') })
  ipcMain.handle('documents:rescan', () => { setSetting('documents_enabled', '1'); analyzeLibrary('documents') })
  ipcMain.handle('people:pause', () => { analysis.paused = true })
  ipcMain.handle('people:list', () => people.list())
  ipcMain.handle('people:shas', (_, id) => people.shas(id))
  ipcMain.handle('people:names', () => people.namesBySha())
  ipcMain.handle('people:rename', (_, id, name) => people.rename(id, name))
  ipcMain.handle('people:merge', (_, source, target) => people.merge(source, target))
  ipcMain.handle('people:detach', (_, id, shas) => people.detach(id, shas))
  ipcMain.handle('people:undoMerge', (_, undo) => people.undoMerge(undo))
  ipcMain.handle('people:mergeHistory', (_, id) => people.mergeHistory(id))
  ipcMain.handle('people:restoreMerge', (_, id) => people.restoreMerge(id))
  ipcMain.handle('people:nextReview', () => people.nextReview())
  ipcMain.handle('people:answer', (_, faceId, personId, answer) => people.answer(faceId, personId, answer))
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
    return fs.promises.readFile(library.isHeic(row.path) ? await library.preview(full, row.sha256, DATA_DIR) : full)
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
    devices: sync.devices() }))
  ipcMain.handle('sync:pair', async () => {
    const payload = sync.startPairing()
    return { payload, qr: await require('qrcode').toDataURL(JSON.stringify(payload), { margin: 1, width: 360, errorCorrectionLevel: 'M' }) }
  })
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
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => vault?.lock())
