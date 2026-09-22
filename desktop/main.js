const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const library = require('./library')

// Override both for testing with disposable files.
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || path.join(os.homedir(), 'Drive', 'Photos')
const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let db, win, scanning = null

function startScan() {
  scanning ??= library.scan(db, PHOTOS_ROOT, DATA_DIR, (done, changed) => win?.webContents.send('scan-progress', { done, changed }))
    .finally(() => { scanning = null })
  return scanning
}

app.whenReady().then(() => {
  db = library.open(DATA_DIR)

  // media://thumb/<sha256>  and  media://file/<id>  — only files the database knows about are served.
  protocol.handle('media', request => {
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname.slice(1))
    let file
    if (url.host === 'thumb' && /^[0-9a-f]{64}$/.test(key)) file = path.join(DATA_DIR, 'thumbs', key + '.webp')
    if (url.host === 'file') {
      const row = db.prepare('SELECT path FROM media WHERE id = ?').get(Number(key))
      if (row) file = path.join(PHOTOS_ROOT, row.path)
    }
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
  })

  ipcMain.handle('library:info', () => ({ photosRoot: PHOTOS_ROOT }))
  ipcMain.handle('library:list', () => library.list(db))
  ipcMain.handle('library:scan', () => startScan())
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
