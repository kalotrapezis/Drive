const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const library = require('./library')
const { Files } = require('./files')
const faces = require('./faces')

// Override both for testing with disposable files.
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || path.join(os.homedir(), 'Drive', 'Photos')
const FILES_ROOT = process.env.DRIVE_FILES || path.join(os.homedir(), 'Drive', 'Drive')
const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let db, files, people, win, scanning = null
const FILE_CALLS = ['list', 'search', 'withTag', 'destinations', 'copy', 'move', 'rename', 'trash', 'emptyTrash', 'setFavorite', 'setColor',
  'favorites', 'recents', 'tags', 'createTag', 'setTags', 'properties', 'usage']

function startScan() {
  scanning ??= library.scan(db, PHOTOS_ROOT, DATA_DIR, (done, changed) => win?.webContents.send('scan-progress', { done, changed }))
    .finally(() => { scanning = null; if (setting('people_enabled') === '1') analyzePeople() })
  return scanning
}

const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// People analysis: only after an explicit start (like the phone), pausable, never uploads anything.
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
let engine = null
const sendAnalysis = () => win?.webContents.send('people-progress', { ...analysis })
const isScreenshot = p => /screenshot|στιγμιοτυπο|screen[ _-]?shot|scrnshot/.test(p.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())

async function analyzePeople() {
  if (analysis.running) return
  Object.assign(analysis, { running: true, paused: false, done: 0, error: '' })
  try {
    engine ??= await faces.FaceEngine.load(path.join(__dirname, 'models'))
    const todo = people.pending()
    analysis.total = todo.length
    sendAnalysis()
    for (const { sha256, path: rel } of todo) {
      if (analysis.paused) break
      if (isScreenshot(rel)) people.skip(sha256) // the phone skips screenshots too
      else {
        try {
          const img = await faces.FaceEngine.decode(path.join(PHOTOS_ROOT, rel))
          const found = await engine.analyze(img)
          const ids = people.record(sha256, found, img)
          for (const [i, id] of ids.entries()) await people.saveCrop(img, id, found[i].box).catch(() => {})
        } catch { people.skip(sha256) } // unreadable image: analysed as "no faces", like a failed decode on the phone
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
    if (url.host === 'face' && /^[0-9a-f-]{36}$/.test(key)) file = path.join(DATA_DIR, 'thumbs', 'faces', key + '.webp')
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
  ipcMain.handle('people:status', () => ({ ...analysis, enabled: setting('people_enabled') === '1', reviews: people.reviewCount() }))
  ipcMain.handle('people:start', () => { setSetting('people_enabled', '1'); analyzePeople() })
  ipcMain.handle('people:pause', () => { analysis.paused = true })
  ipcMain.handle('people:list', () => people.list())
  ipcMain.handle('people:shas', (_, id) => people.shas(id))
  ipcMain.handle('people:names', () => people.namesBySha())
  ipcMain.handle('people:rename', (_, id, name) => people.rename(id, name))
  ipcMain.handle('people:merge', (_, source, target) => people.merge(source, target))
  ipcMain.handle('people:undoMerge', (_, undo) => people.undoMerge(undo))
  ipcMain.handle('people:nextReview', () => people.nextReview())
  ipcMain.handle('people:answer', (_, faceId, personId, answer) => people.answer(faceId, personId, answer))
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
    backgroundColor: '#121416', title: 'Local Drive',
    icon: path.join(__dirname, 'public', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL)
  else win.loadFile(path.join(__dirname, 'dist', 'index.html'))
})

app.on('window-all-closed', () => app.quit())
