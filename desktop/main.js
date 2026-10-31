const { app, BrowserWindow, ipcMain, protocol, net, shell, Tray, Menu, Notification, nativeTheme, dialog, powerMonitor, safeStorage, globalShortcut, clipboard } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { AsYouType } = require('libphonenumber-js')
const library = require('./library')
const { Files } = require('./files')
const faces = require('./faces')
const places = require('./places')
const { Vault } = require('./vault')
const editor = require('./editor')
const docs = require('./documents')
const { SyncServer, lanAddresses, FROM_PHONE } = require('./sync')
const { SyncClient } = require('./client')
const reset = require('./reset')
const callaudio = require('./callaudio')
const { Folders } = require('./folders')
const { Purgatory } = require('./purgatory')
const history = require('./history')
const { Notes, markdown, markdownFiles, exportFolder } = require('./notes')
const { Calendar } = require('./calendar')
const { Contacts, readImport: readContacts } = require('./contacts')
const { linkFaces } = require('./contactfaces')
const { Calls } = require('./calls')
const { DataCounter } = require('./datacount')
let calls = null
const timer = require('./timer')
const { Maps, labelsIn } = require('./maps')
const { Router, join } = require('./router')
const { MapBuilder } = require('./mapbuild')
const { Thumbs } = require('./thumbs')
const importer = require('./importer')
const assistant = require('./assistant')
const { Mail, MICROSOFT, detect: detectMail, check: checkMail } = require('./mail')
const msauth = require('./msauth')
let mail = null
const i18n = require('./i18n')
const { t } = i18n

const DATA_DIR = process.env.DRIVE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'local-drive-desktop')
// ~/Tetra/Photos and ~/Tetra/Files, moved from ~/Drive once (home.js). Never from a hidden QA copy (scripts/shot.js),
// which must not rename the real folders. Both can be overridden for testing with disposable files.
const home = require('./home')
const system = require('./system')
const { Cleaner } = require('./cleaner')
const HOME = home.roots(os.homedir(), { migrate: !process.env.DRIVE_HIDDEN })
if (HOME.moved.length) {
  console.log('[home] moved', HOME.moved.join('; '))
  try { fs.copyFileSync(path.join(DATA_DIR, 'library.db'), path.join(DATA_DIR, 'library.db.before-tetra-folder')) } catch {}
}
if (HOME.note) console.warn('[home]', HOME.note)
const PHOTOS_ROOT = process.env.DRIVE_PHOTOS || HOME.photos
const FILES_ROOT = process.env.DRIVE_FILES || HOME.files

// AI Assist's shortcuts from anywhere: on Wayland only through the desktop's GlobalShortcuts portal (KDE, GNOME 48+), which
// Chromium uses when asked; X11 needs nothing
if (process.env.XDG_SESSION_TYPE === 'wayland') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])

let importing = null, importStop = null
// The video inside a picture, read when the viewer asks; the last one is kept for the playback that follows.
let lastMotion = { id: null, video: null }
async function embeddedMotion(id) {
  if (lastMotion.id === id) return lastMotion.video
  const row = db.prepare('SELECT path, sha256, location, is_video FROM media WHERE id = ?').get(id)
  let video = null
  if (row && !row.is_video && /\.(jpe?g|heic|heif)$/i.test(row.path)) {
    const file = (await sync.locate(row)).file
    const buf = file ? await fs.promises.readFile(file).catch(() => null) : null
    const at = buf ? library.embeddedVideoOffset(buf) : -1
    if (at > 0) video = buf.subarray(at)
  }
  lastMotion = { id, video }
  return video
}
let notes, db, files, people, documents, folders, vault, sync, purgatory, win, scanning = null, scannedAt = 0, cleaner = null
const FILE_CALLS = ['list', 'search', 'withTag', 'destinations', 'copy', 'move', 'rename', 'trash', 'emptyTrash', 'setFavorite', 'setColor',
  'favorites', 'recents', 'tags', 'createTag', 'setTags', 'properties', 'usage', 'chosenFolders', 'chooseSystemFolders']
const NOTE_CALLS = ['list', 'create', 'save', 'snapshot', 'history', 'restoreVersion', 'remove']
const CALENDAR_CALLS = ['calendars', 'occurrences', 'save', 'saveDay', 'skipDay', 'endBefore', 'split', 'trash', 'move', 'keep', 'newCalendar', 'setCalendar', 'deleteCalendar', 'scheduleEvent', 'trashed', 'restore']
let calendar = null, reminderTimer = null, calendarIncoming = []
// Contacts (Drive-Android Plan.md § Contacts): .System/Contacts/Shared, one vCard a person; the window's calls, checked by name
const CONTACTS_CALLS = ['list', 'save', 'trash', 'keep', 'trashed', 'restore', 'pairs', 'merge', 'notTheSame']
let contacts = null

// The Calendar's reminders (Drive-Android Plan.md § Calendar): one timer for the next, the plan made again from the files
// whenever they change, a reminder is due, the computer wakes or Tetra starts. What came due while it was closed or asleep
// (up to a day) is shown as missed. Every device reminds; "Reminders on this computer" turns this one off.
function reminderText(r) {
  // made each time: the language can change while Tetra runs
  const dayTime = new Intl.DateTimeFormat(i18n.locale('en-GB'), { weekday: 'short', day: 'numeric', month: 'short' })
  const clock = new Intl.DateTimeFormat(i18n.locale('en-GB'), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(r.start); day.setHours(0, 0, 0, 0)
  const n = Math.round((day - today) / 86400000)
  const words = n === 0 ? t('common.today') : n === 1 ? t('common.tomorrow') : dayTime.format(r.start)
  return (r.allDay ? t('main.reminderAllDay', { day: words }) : t('main.reminderTime', { day: words, start: clock.format(r.start), end: clock.format(r.end) })) + (r.place ? ` · ${r.place}` : '')
}
function planReminders() {
  clearTimeout(reminderTimer)
  if (!calendar || !db) return
  const now = Date.now(), on = setting('calendarReminders') !== 'off'
  const upTo = Math.max(+(setting('calendarUpTo') || now), now - 86_400_000)
  if (on) for (const r of calendar.reminders(upTo, now + 1000)) notify(r.title || t('common.noTitle'), (now - r.at > 300_000 ? t('main.missed') : '') + reminderText(r))
  setSetting('calendarUpTo', String(now + 1000))
  if (!on) return
  const next = calendar.reminders(now + 1000, now + 120 * 86_400_000)[0]
  reminderTimer = setTimeout(planReminders, Math.max(1000, Math.min(next ? next.at - now : Infinity, 6 * HOURS)))
}
// The Timer (Drive-Android Plan.md § Timer): a file per timer in .System/Timer/Shared. This computer counts down from the end time
// in it, as every device does; at the end it notifies and the window rings (TimerBell) until OK here or on any device.
// The files are read again at each end and every 30 s (the user: "sync check every 30 sec"), and at once when one lands.
let timers = null, timerAlarm = null
let maps = null // Maps (maps.js): the phone's map files in .System/Maps/Shared, read and written as they are
/** Directions (router.js): GraphHopper's server on a map's graph, one a graph, started at its first route; the last three used kept. */
const routers = new Map()
function routerFor(dir) {
  const r = routers.get(dir) ?? new Router(dir, path.join(DATA_DIR, 'routing', path.basename(dir)))
  routers.delete(dir); routers.set(dir, r)
  for (const [d, old] of routers) if (routers.size > 3) { old.stop(); routers.delete(d) }
  return r
}
const stopRouters = () => { for (const r of routers.values()) r.stop(); routers.clear() }
let mapBuilder = null // the map builder (mapbuild.js): a country's map, roads and search, made here for every device
let dataCounter = null // Data (datacount.js): this computer's network counts, its Wi-Fi, the phone's speed test
let thumbs = null // Files' thumbnails (thumbs.js), made when Files first asks for one
const timerRung = new Set()
function planTimer() {
  clearTimeout(timerAlarm)
  if (!timers) return
  const now = Date.now()
  for (const t of timers.active(now)) if (t.ringing && !timerRung.has(`${t.id}|${t.rev}`)) {
    timerRung.add(`${t.id}|${t.rev}`)
    notify(i18n.t('main.timesUp'), t.label || i18n.t('main.timerOf', { length: timer.durationText(t.seconds) }))
    win?.webContents.send('timer-changed')
  }
  const next = timers.nextEnd(now)
  timerAlarm = setTimeout(planTimer, Math.max(250, Math.min(next ? next - now : Infinity, 30_000)))
}
function watchTimer() {
  let settle = null
  try {
    fs.mkdirSync(timers.root, { recursive: true })
    fs.watch(timers.root, (_, name) => {
      if (name && String(name).startsWith('.')) return // a write in progress
      clearTimeout(settle)
      // a timer changed here, by a phone or by Claude: shown, planned, and the other devices told at once — the
      // computer is where they all meet, so this nudge is how a stop on the tablet reaches the phone
      settle = setTimeout(() => { win?.webContents.send('timer-changed'); planTimer(); sync?.nudge().catch(() => {}) }, 150)
    })
  } catch (e) { console.warn('[timer] cannot watch', e.message) }
}
// Contacts ↔ Photos' people kept in step (contactfaces.js): when a contact changes, and every few minutes for Photos' side
let linking = null
function linkContactFaces() {
  if (linking || !contacts || !people) return linking
  linking = linkFaces({ db, people, contacts, facePhoto: contactFacePhoto })
    .then(n => { if (n) { console.log(`Contacts: ${n} face links`); win?.webContents.send('contacts-changed') } })
    .catch(e => console.warn('[contacts] face links', e.message)).finally(() => { linking = null })
  return linking
}
/** A face as a contact's photo: its box (fractions of the upright picture) × 1.8, square, 512 px — the phone's crop — and its X-TETRA-FACE. */
async function contactFacePhoto(faceId) {
  const f = db.prepare(`SELECT f.sha256, f.box_left, f.box_top, f.box_right, f.box_bottom, (SELECT MIN(m.path) FROM media m WHERE m.sha256 = f.sha256 AND m.location IS NULL) AS path
    FROM faces f WHERE f.id = ? AND f.deleted = 0`).get(String(faceId))
  if (!f?.path) throw new Error(t('main.errPictureNotHere'))
  const sharp = require('sharp')
  // the upright size (metadata() gives the stored one, before EXIF's turn)
  const { width, height } = (await sharp(path.join(PHOTOS_ROOT, f.path)).rotate().toBuffer({ resolveWithObject: true })).info
  const w = (f.box_right - f.box_left) * width, h = (f.box_bottom - f.box_top) * height
  const side = Math.max(1, Math.min(Math.round(Math.max(w, h) * 1.8), width, height))
  const left = Math.min(Math.max(0, Math.round(f.box_left * width + w / 2 - side / 2)), width - side)
  const top = Math.min(Math.max(0, Math.round(f.box_top * height + h / 2 - side / 2)), height - side)
  const out = await sharp(path.join(PHOTOS_ROOT, f.path)).rotate().extract({ left, top, width: side, height: side }).resize(Math.min(512, side), Math.min(512, side)).jpeg({ quality: 85 }).toBuffer()
  const r4 = n => Math.round(n * 10000) / 10000
  return { photo: out.toString('base64'), face: `${f.sha256};${[left / width, top / height, (left + side) / width, (top + side) / height].map(r4).join(',')}` }
}
function watchContacts() {
  let settle = null
  try {
    fs.watch(contacts.root, (_, name) => {
      if (name && path.basename(String(name)).startsWith('.')) return // a write in progress (.part)
      clearTimeout(settle)
      // shown, and the phones and tablets told at once: the nudge has them sync Contacts' part (SYNC_PLAN 6ap)
      settle = setTimeout(() => { win?.webContents.send('contacts-changed'); sync?.nudge().catch(() => {}); linkContactFaces() }, 300)
    })
  } catch (e) { console.warn('[contacts] cannot watch', e.message) }
}
function watchCalendar() {
  let settle = null
  try {
    fs.watch(calendar.root, { recursive: true }, (_, name) => {
      if (name && path.basename(String(name)).startsWith('.')) return // a write in progress (.part)
      clearTimeout(settle)
      // and to the phones and tablets at once (the user, 18 Oct: "no delay"): the nudge has them sync the Calendar's
      // part. Tetra's own saves land here too, so this one nudge covers them and Claude's.
      settle = setTimeout(() => { win?.webContents.send('calendar-changed'); planReminders(); sync?.nudge().catch(() => {}) }, 300)
    })
  } catch (e) { console.warn('[calendar] cannot watch', e.message) }
}
// Start at login (Linux autostart): Tetra in the tray, so reminders ring and the phone can sync whenever the computer is on.
const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'tetra.desktop')
/** The command that starts this Tetra (the AppImage, the installed one, or this source): autostart's, and AI Assist's --assistant. */
const launchCommand = () => process.env.APPIMAGE ? `"${process.env.APPIMAGE}"` : app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`
function setAutostart(on) {
  if (!on) { try { fs.unlinkSync(AUTOSTART) } catch {} return }
  const exec = launchCommand()
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true })
  fs.writeFileSync(AUTOSTART, `[Desktop Entry]\nType=Application\nName=Tetra\nComment=Tetra in the tray: sync and calendar reminders\nExec=${exec} --hidden\nIcon=${app.isPackaged ? 'local-drive-desktop' : path.join(__dirname, 'public', 'icon.png')}\nX-GNOME-Autostart-enabled=true\n`)
}

const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// Local analysis (People, Documents): each starts only after an explicit request, like the phone; pausable; nothing
// is uploaded. It runs in analyzer.js, its own low-priority process, so reading a library never holds this thread.
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
// The window may already be gone when the worker stops (quitting): nothing to tell then.
const sendAnalysis = () => { if (win && !win.isDestroyed()) win.webContents.send('people-progress', { ...analysis }); updateTray() }
let analyzer = null, scanDone = null
const asks = new Map() // the window's questions to the background thread (eyes, text), by id
let lastAsk = 0
const ask = (what, file) => new Promise((resolve, reject) => { const id = ++lastAsk; asks.set(id, { resolve, reject }); worker().postMessage({ type: 'ask', id, what, file }) })

/** The background thread (analyzer.js): scanning and analysis both run there, never on the window's thread. */
function worker() {
  if (analyzer) return analyzer
  analyzer = new (require('node:worker_threads').Worker)(path.join(__dirname, 'analyzer.js'))
  analyzer.postMessage({ type: 'init', language: i18n.current().lang, dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, modelDir: path.join(__dirname, 'models') })
  analyzer.on('message', m => {
    if (m.type === 'progress') { Object.assign(analysis, m.analysis); sendAnalysis() }
    else if (m.type === 'scan-progress') win?.webContents.send('scan-progress', { done: m.done, changed: m.changed })
    else if (m.type === 'scanned') { const d = scanDone; scanDone = null; m.error ? d?.reject(new Error(m.error)) : d?.resolve(m.result) }
    else if (m.type === 'answer') { const q = asks.get(m.id); asks.delete(m.id); m.error ? q?.reject(new Error(m.error)) : q?.resolve(m.result) }
  })
  analyzer.on('error', e => console.error('[analyzer]', e))
  analyzer.on('exit', code => {
    analyzer = null
    scanDone?.reject(new Error(t('main.errBackgroundStopped', { code }))); scanDone = null
    for (const q of asks.values()) q.reject(new Error(t('main.errBackgroundStopped', { code })))
    asks.clear()
    if (analysis.running) Object.assign(analysis, { running: false, error: t('main.errAnalysisStopped', { code }) })
    sendAnalysis()
  })
  return analyzer
}

/** A place, list or trip changed here, on a phone or by Claude: the window shows it (as the Timer's folder). */
function watchMaps() {
  let settle = null
  for (const dir of ['Places', 'Lists', 'Trips']) {
    const full = path.join(maps.root, dir)
    try {
      fs.mkdirSync(full, { recursive: true })
      fs.watch(full, () => { clearTimeout(settle); settle = setTimeout(() => win?.webContents.send('maps-changed'), 300) })
    } catch (e) { console.warn('[maps] cannot watch', e.message) }
  }
}

/** The map's style, fonts and icons: built into the app (dist/maps, the phone's assets/maps). */
const mapsAsset = rel => [path.join(__dirname, 'dist', 'maps', rel), path.join(__dirname, 'public', 'maps', rel)].find(f => fs.existsSync(f)) ?? null

/** media://maps/… — the offline maps: tiles from each .System/Maps/Shared/<id>.pmtiles, the phone's style pointed at them. */
async function mapsResponse(key) {
  const r = await mapsBody(key)
  const headers = new Headers(r.headers)
  headers.set('access-control-allow-origin', '*') // MapLibre fetches these from the page (file://), another origin
  return new Response(r.body, { status: r.status, headers })
}
async function mapsBody(key) {
  const tile = /^tile\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(key)
  if (tile) {
    const data = await maps.tile(tile[1], +tile[2], +tile[3], +tile[4]).catch(() => null)
    return data ? new Response(data, { headers: { 'content-type': 'application/x-protobuf', 'cache-control': 'max-age=3600' } }) : new Response(null, { status: 204 })
  }
  const style = /^style\/(light|dark)$/.exec(key)
  if (style) {
    const file = mapsAsset(`${style[1]}.json`)
    if (!file) return new Response('Not found', { status: 404 })
    const s = JSON.parse(labelsIn(await fs.promises.readFile(file, 'utf8'), i18n.current().lang.split('-')[0])) // names in Tetra's language
    s.glyphs = 'media://maps/fonts/{fontstack}/{range}.pbf'
    s.sprite = `media://maps/sprites/${style[1]}`
    // one source a map; each layer drawn for every map in turn, so a border's two maps draw as one (the first keeps the
    // phone's names, "protomaps" and the layers' own ids, which the window asks for by name)
    const ids = await maps.ids()
    const source = id => ({ type: 'vector', tiles: [`media://maps/tile/${id}/{z}/{x}/{y}`], minzoom: 0, maxzoom: 15, attribution: '© OpenStreetMap, Protomaps' })
    s.sources.protomaps = source(ids[0] ?? 'none')
    for (const id of ids.slice(1)) s.sources[`protomaps__${id}`] = source(id)
    s.layers = s.layers.flatMap(l => l.source !== 'protomaps' ? [l] : [l, ...ids.slice(1).map(id => ({ ...l, id: `${l.id}__${id}`, source: `protomaps__${id}` }))])
    return new Response(JSON.stringify(s), { headers: { 'content-type': 'application/json' } })
  }
  const font = /^fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(key)
  const sprite = /^sprites\/((?:light|dark)(?:@2x)?\.(?:json|png))$/.exec(key)
  // a font list ("Noto Sans Medium,Noto Sans Regular"): the first the app has
  const file = font ? font[1].split(',').map(f => mapsAsset(`fonts/${f.trim()}/${font[2]}.pbf`)).find(Boolean) : sprite ? mapsAsset(`sprites/${sprite[1]}`) : null
  // a range the fonts lack (Arabic forms in Turkey's names): an empty one, which draws nothing and asks no more
  if (font && !file) return new Response(new Uint8Array(0), { headers: { 'content-type': 'application/x-protobuf' } })
  return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
}

function startScan() {
  scanning ??= new Promise((resolve, reject) => { scanDone = { resolve, reject }; worker().postMessage({ type: 'scan' }) })
    .then(r => {
      scannedAt = Date.now() // Clean up's thumbnails go by the library as a finished scan left it
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
  // Not during an import: both wrote the same new photos to the drive at once, and left 118 half copies (26 September).
  if (driveBackup || importing) return
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
const shownNotes = new Set()
// Mail's secrets: a password, or {"refresh": …} for an account signed in with Microsoft — encrypted, in this computer's settings only
const mailSecret = id => { try { const s = setting('mailSecret:' + id); return s ? safeStorage.decryptString(Buffer.from(s, 'base64')) : null } catch { return null } }
const keepMailSecret = (id, value) => setSetting('mailSecret:' + id, safeStorage.encryptString(value).toString('base64'))
const msClient = () => setting('mailMicrosoftClientId') || ''
const msTokens = new Map(), msRenewing = new Map()
/** A Microsoft access token for an account: the one in memory while it lasts, else renewed — one renewal at a time per account. */
function msToken(acc) {
  const t = msTokens.get(acc.id)
  if (t && t.expires > Date.now()) return Promise.resolve(t.access)
  if (!msRenewing.has(acc.id)) msRenewing.set(acc.id, (async () => {
    let stored = null
    try { stored = JSON.parse(mailSecret(acc.id) ?? 'null') } catch {}
    const n = await msauth.refresh({ clientId: msClient(), refreshToken: stored?.refresh })
    if (n.refresh !== stored?.refresh) keepMailSecret(acc.id, JSON.stringify({ refresh: n.refresh }))
    msTokens.set(acc.id, n)
    return n.access
  })().finally(() => msRenewing.delete(acc.id)))
  return msRenewing.get(acc.id)
}
function notify(title, body, open = null) {
  // Kept as well as shown: a notification goes by in seconds, the Notifications page keeps them (asked 2026-09-26).
  try {
    db.exec('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0)')
    db.prepare('INSERT INTO notifications(at, title, body) VALUES(?,?,?)').run(Date.now(), String(title), body == null ? null : String(body))
    win?.webContents.send('notifications-changed')
  } catch (e) { console.warn('[notify]', e.message) }
  if (!Notification.isSupported() || sync?.nas()) return // a NAS: nobody sits at it; the list keeps it
  const n = new Notification({ title, body, icon: path.join(__dirname, 'public', 'icon.png') })
  n.on('click', () => { showWindow(); if (open) open(); else if (offer) win?.webContents.send('offload-offer', offer.deviceId) })
  // held until it closes: one nobody holds is collected, and its click does nothing (the user, 23 Oct)
  shownNotes.add(n); n.on('close', () => shownNotes.delete(n))
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
    moveToDrive(deviceId, {}).then(r => r.moved && notify(t('main.freed', { size: fmtBytes(r.bytes) }), t('main.freedBody', { count: r.moved, n: r.moved.toLocaleString(), name })
      + (r.failed.length ? ' ' + t('main.freedStayed', { n: r.failed.length }) : '')))
      .catch(e => notify(t('main.freeFailed', { name }), e.message))
    return
  }
  if (offer && Date.now() - said.offer > 12 * HOURS) {
    said.offer = Date.now()
    const why = offer.rules.offload ? t('main.whyUnder', { percent: offer.rules.percent }) : t(`main.olderThan.${offer.rules.unit}`, { count: offer.rules.keep })
    notify(t('main.freeAsk', { size: fmtBytes(offer.bytes) }), t('main.freeAskBody', { count: offer.count, n: offer.count.toLocaleString(), why, name: offer.name }))
  }
  const storage = sync.devices().find(x => x.rules?.role === 'storage' && x.rules.offload)
  const limit = storage ? storage.rules.percent : 90
  if (disk && disk.percent >= limit && Date.now() - said.full > 6 * HOURS) {
    said.full = Date.now()
    notify(t('main.diskFull', { percent: disk.percent }), t('main.diskLeft', { free: fmtBytes(disk.free) }) + (offer ? ' ' + t('main.diskCouldGo', { size: fmtBytes(offer.bytes), name: offer.name })
      : storage ? '' : ' ' + t('main.diskMakeStorage')))
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
  if (moving) throw new Error(t('main.errMoveRunning'))
  moving = sync.moveToDrive(id, options, p => win?.webContents.send('move-progress', p))
    .finally(() => {
      sync.releaseTrashedMoved().catch(() => {})
      moving = null; offer = null; said.offer = Date.now(); updateTray(); win?.webContents.send('sync-received') })
  return moving
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return
  const status = driveBackup ? t('main.trayBackingUp', { name: driveBackup.name, done: driveBackup.done.toLocaleString(), total: driveBackup.total.toLocaleString() })
    : analysis.running ? t('main.trayAnalysing', { done: analysis.done.toLocaleString(), total: analysis.total.toLocaleString() })
    : analysis.paused ? t('main.trayPaused') : t('main.trayUpToDate')
  tray.setToolTip(`Tetra — ${status}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('main.trayOpen'), click: showWindow },
    { label: status, enabled: false },
    { label: offer ? t('main.trayFree', { size: fmtBytes(offer.bytes), count: offer.count, n: offer.count.toLocaleString(), name: offer.name }) : '', visible: !!offer,
      click: () => { showWindow(); win?.webContents.send('offload-offer', offer.deviceId) } },
    analysis.running ? { label: t('main.trayPause'), click: () => { analysis.paused = true; analyzer?.postMessage({ type: 'pause' }) } }
      : { label: t('main.trayResume'), visible: analysis.paused, click: () => analyzeLibrary() },
    { label: t('main.traySend'), click: sendFilesToPhone },
    { type: 'separator' },
    { label: t('main.trayQuit'), click: () => { quitting = true; app.quit() } },
  ]))
}

/** Send to phone (the user, 23 Oct): any files on this computer, picked, straight into the phone's Files › From computer. */
async function sendFilesToPhone() {
  const { filePaths } = await dialog.showOpenDialog({ title: t('main.sendTitle'), properties: ['openFile', 'multiSelections'] })
  if (!filePaths.length) return
  const r = await sync.sendToDevice(filePaths).catch(e => ({ error: e.message }))
  notify(r.sent ? t('main.sent', { count: r.sent, device: r.device }) : t('main.sentNothing'), r.error ?? t('main.sentWhere'))
}

/** `rescan` — 'faces' or 'documents' — reads photos that were read before, because the rules changed since. */
function analyzeLibrary(rescan = null) {
  if (analysis.running) return
  // the slow analysis runs on one computer: the server, or for a NAS the client holding the crown (sync.js crown); the
  // others get its results with the metadata
  if (sync?.nas() || (sync?.role() === 'client' && !sync.client?.pairing()?.crown)) return
  analysis.running = true // until the analyzer says otherwise, so a second request does not start a second pass
  worker().postMessage({ type: 'start', rescan,
    wantFaces: setting('people_enabled') === '1' && rescan !== 'documents',
    wantDocs: setting('documents_enabled') === '1' && rescan !== 'faces' })
}

app.whenReady().then(() => {
  // ~/Tetra/.System (system.js, SYSTEM.md): the old folders beside ~/Tetra moved in once, and every app's Temp emptied, as no
  // job runs yet. Never from a hidden QA copy, which must not touch the real folders (nor a running Tetra's work).
  let tempCleaned = false
  if (!process.env.DRIVE_HIDDEN) {
    const { moved, failed } = system.migrate()
    if (moved.length) console.log('[system] moved', moved.join('; '))
    for (const f of failed) console.warn('[system] not moved:', f)
    try { system.cleanTemp(); tempCleaned = true } catch (e) { console.warn('[system] Temp not emptied:', e.message) }
  }
  // Tetra's own folders of Files into .System (29 Oct 2026); a hidden run moves only the folders it was given
  if (!process.env.DRIVE_HIDDEN || process.env.DRIVE_FILES) {
    const { moved, failed } = system.migrateFiles(FILES_ROOT)
    if (moved.length) console.log('[system] moved', moved.join('; '))
    for (const f of failed) console.warn('[system] not moved:', f)
  }
  db = library.open(DATA_DIR)
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)') // read below (Contacts) before the line that made it; a new computer's first start failed
  // once: sync's identical "(2)" copies aside into .System/Backups, the others listed there (system.setAsideCopies)
  if (!setting('syncCopiesSetAside') && (!process.env.DRIVE_HIDDEN || process.env.DRIVE_FILES)) {
    const { moved, left, failed } = system.setAsideCopies(FILES_ROOT)
    console.log(`[system] sync copies: ${moved.length} set aside, ${left.length} left where they are`, left.join('; '))
    for (const f of failed) console.warn('[system] not moved:', f)
    setSetting('syncCopiesSetAside', String(Date.now()))
  }
  // Server or client is asked at the first start (Setup.tsx). A Tetra that ran before the question was the server, and
  // a hidden QA copy is one too: neither is asked. notesImported is written at every first start (below); roleAsked
  // marks a start that asked, so closing before answering asks again rather than making it a server.
  if (!setting('role')) {
    // DRIVE_ASK_ROLE: a hidden run that shows the question anyway, for its screenshots (the setup guide's)
    if ((process.env.DRIVE_HIDDEN && !process.env.DRIVE_ASK_ROLE) || (setting('notesImported') && !setting('roleAsked'))) setSetting('role', 'server')
    else setSetting('roleAsked', '1')
  }
  i18n.use(setting('language') || 'system', [app.getLocale()]) // before anything says a word: reminders, the tray
  files = new Files(db, FILES_ROOT)
  // Notes live in .System/Notes/Shared (notes.js), and sync through their own step, newest edit wins.
  notes = new Notes(system.dir('Notes', 'Shared', files.system), 'tetra-desktop')
  // The Calendar is .System/Calendar/Shared, synced as Files' "Calendar" folder; deleting goes to Files' Trash, as everywhere.
  calendar = new Calendar(files.disk('Calendar'), files.disk('Trash'))
  try { fs.mkdirSync(calendar.root, { recursive: true }) } catch {}
  contacts = new Contacts(files.disk('Contacts'), files.disk('Trash'), calendar)
  calls = new Calls({ contacts, act: what => sync.callAction(what), notify: (t, b) => notify(t, b), recordings: files.disk('Phone/Recordings'),
    me: () => sync.role() === 'client' ? sync.client?.pairing()?.id : 'server',
    early: () => sync.role() !== 'client' && !db.prepare("SELECT 1 FROM sync_devices WHERE kind = 'computer' AND volume_uuid IS NULL").get(),
    relayable: () => sync.role() === 'client' ? sync.client.soundThere() : false,
    relay: () => sync.client.callAudio((received, send) => callaudio.bridge(received, send)) })
  calls.watch()
  contacts.chosen = setting('contactsBirthdays') || null // the calendar birthdays go into (Γενέθλια when none chosen)
  try { fs.mkdirSync(contacts.root, { recursive: true }) } catch {}
  timers = new timer.Timers(files.disk('Timer'), os.hostname() || 'Computer')
  // Mail (mail.js): the archive in .System/Mail/Shared; each account's password only in this computer's keyring
  mail = new Mail(system.dir('Mail', 'Shared', files.system), { secret: mailSecret, token: msToken })
  mail.on('changed', () => win?.webContents.send('mail-changed'))
  mail.on('new', e => notify(e.from || e.fromAddress, e.subject || t('common.noTitle')))
  mail.on('failed', (r, e) => notify(t('mail.notSent'), `${r.draft?.subject || t('common.noTitle')}: ${e.reason && e.reason !== 'other' ? t(`mail.err_${e.reason}`) : e.message}`))
  mail.picked = new Set() // files chosen here to attach: nothing else on this computer can be sent from the window
  mail.filesRoot = files.root // where a filter saves attachments ("save to a Files folder", MAIL_PLAN §6)
  if (!process.env.DRIVE_HIDDEN) mail.startAll() // a hidden QA copy fetches nothing
  // sync's old copies of timers that are over (timer.js clean; the phone clears its own the same way)
  try { const n = timers.clean(); if (n) console.log(`Timer: cleared ${n} old copies`) } catch {}
  // Maps: deleting a place goes to Files' Trash, so the deletion reaches the phone (as the Calendar's)
  maps = new Maps(files.disk('Maps'), rel => files.trash(rel))
  watchMaps()
  dataCounter = new DataCounter(files.disk('Data'), os.hostname())
  dataCounter.start()
  // Data's plan set on the phone: the tablets told at once, as for a timer — the plan is the phone's
  try {
    // shortcut: watched only when Data is there at start (a computer that does not use Data gets no folder); a first plan waits for the next start
    let settle = null
    if (fs.existsSync(dataCounter.root)) fs.watch(dataCounter.root, (_, name) => {
      if (name !== 'plan.json') return
      clearTimeout(settle); settle = setTimeout(() => sync?.nudge().catch(() => {}), 500)
    })
  } catch (e) { console.warn('[data] cannot watch', e.message) }
  people = new faces.People(db, DATA_DIR)
  vault = new Vault(db, DATA_DIR)
  documents = new docs.Documents(db)
  // Read on each question, not once: a device's Photos row can change while the app runs.
  folders = new Folders(db, () => !!sync?.devices().some(d => !d.volume_uuid && d.connections.some(c => c.content === 'photos' && c.direction === 'both')))
  // Phone sync: always listening (paired phones only); received photos show up after a short, batched rescan.
  let rescanTimer = null
  purgatory = new Purgatory({ db, photosRoot: PHOTOS_ROOT, files, serverBase: path.dirname(HOME.root) })
  sync = new SyncServer({ db, documents, people, files, notes, onNotes: () => win?.webContents.send('notes-changed'), onNotesSynced: s => win?.webContents.send('notes-synced', s), dataDir: DATA_DIR, photosRoot: PHOTOS_ROOT, trashItem: f => shell.trashItem(f), purgatory, data: dataCounter, port: Number(process.env.DRIVE_PORT) || undefined,
    // a call answered on a client computer: its sound from and to the phone on this one's Bluetooth (callaudio.js)
    soundHere: () => !!calls?.bt.phones.some(p => p.connected),
    callAudio: async (received, send) => {
      const d = await callaudio.bluez()
      if (!d.source || !d.sink) throw new Error('The phone\'s call sound is not on this computer\'s Bluetooth.')
      return callaudio.bridge(received, send, d)
    }, onCall: s => { if (s.country && s.country !== setting('phoneCountry')) setSetting('phoneCountry', s.country); calls?.fromPhone(s) }, onReceived: () => {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => { startScan(); win?.webContents.send('sync-received') }, 3000)
  }, onSent: ({ device, paths }) => { // Send to computer: the phone's share menu, into Files › From phone
    notify(t('main.received', { count: paths.length, device }), [...new Set(paths.map(p => p.split('/').pop()))].join(', '),
      () => win?.webContents.send('open-files-folder', FROM_PHONE))
    win?.webContents.send('sync-received')
  } })
  // A client of another Tetra (client.js): its "sync now" is the nudge every change here already sends, plus a look
  // every 5 minutes and the server's own nudge. A server never runs it.
  const client = new SyncClient(sync, { onSynced: s => win?.webContents.send('client-synced', s), onNotes: () => win?.webContents.send('notes-changed'),
    onCrown: crown => { if (crown) analyzeLibrary() } })
  if (!process.env.DRIVE_HIDDEN) setInterval(() => { if (sync.role() === 'client') client.soon(0) }, 5 * 60_000)
  // started: the devices are told at once, so what waited for this computer (Send to computer's outbox) goes now
  sync.start().then(() => { if (!process.env.DRIVE_HIDDEN) sync.nudge().catch(() => {}) }).catch(e => { sync.error = e.message })
  purgatory.held = sha => sync.heldSafely(sha)
  // Photos moved before a Move deleted outright are still in the system Trash, taking the room they were to free.
  setTimeout(() => sync.releaseTrashedMoved().then(n => n && console.log(`[trash] ${n} moved photos let go`)).catch(() => {}), 5000)
  // A drive plugged in is noticed within a minute. Never from a hidden QA copy (scripts/shot.js): it would back up
  // and notify from a database that is not the real one.
  if (!process.env.DRIVE_HIDDEN) setInterval(() => backUpPluggedDrives().then(checkSpace).then(sweepPurgatory).catch(e => console.warn('[space]', e.message)), 60_000)
  // This computer moved to another network (or the router gave it a new address): the devices have not been told,
  // so say "there is something new" — nudge() finds a device that moved too, and its sync brings both up to date.
  let lan = lanAddresses().join()
  if (!process.env.DRIVE_HIDDEN) setInterval(() => {
    const now = lanAddresses().join()
    if (now === lan) return
    lan = now
    if (now) sync.nudge().catch(() => {})
  }, 15_000)
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
    // The video inside a motion photo (Pixel, Samsung), cut from the end of the original.
    if (url.host === 'motion') {
      const video = await embeddedMotion(Number(key))
      return video ? new Response(video, { headers: { 'content-type': 'video/mp4', 'cache-control': 'no-store' } }) : new Response('Not found', { status: 404 })
    }
    if (url.host === 'maps') return mapsResponse(key)
    // media://filethumb/<Files-relative path>?v=<mtime>: a file's thumbnail in Files (thumbs.js), made on first asking
    if (url.host === 'filethumb') file = await (thumbs ??= new Thumbs(DATA_DIR)).get(files.resolve(key)).catch(() => null)
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
    names.set('server', sync.client?.pairing()?.name ?? t('main.aDrive')) // a client's mirror of its server's photos (client.js mirror)
    return library.pairMotion(library.list(db).filter(m => folders.isShown(m.path, c)).map(m => m.location ? { ...m, drive: names.get(m.location) ?? t('main.aDrive') } : m))
  })
  ipcMain.handle('folders:list', () => folders.list().map(({ shas, ...f }) => f))
  ipcMain.handle('folders:set', (_, name, included) => { folders.set(name, included); sync.nudge().catch(() => {}) })
  ipcMain.handle('library:scan', () => startScan())
  ipcMain.handle('photos:favorite', (_, shas, on) => library.setFavorite(db, shas, on))
  ipcMain.handle('photos:hasMotion', async (_, id) => !!(await embeddedMotion(Number(id))))
  // Motion photos (asked 2026-09-26): "one" shows a picture and its seconds of video as one; "remove" leaves the
  // video half out on import. Pairing what is already in the library happens either way (library.pairMotion).
  ipcMain.handle('settings:motion', () => setting('motionPhotos') || 'one')
  ipcMain.handle('settings:setMotion', (_, v) => { if (['one', 'remove'].includes(v)) setSetting('motionPhotos', v) })
  ipcMain.handle('settings:motionAutoplay', () => setting('motionAutoplay') === '1')
  ipcMain.handle('settings:setMotionAutoplay', (_, on) => setSetting('motionAutoplay', on ? '1' : '0'))
  ipcMain.handle('photos:trash', async (_, picked) => {
    // a mirrored photo lives on the server: deleted there, not from here
    const mirrored = id => db.prepare("SELECT 1 FROM media WHERE id = ? AND location = 'server'").get(Number(id))
    const ids = picked.filter(id => !mirrored(id))
    if (!ids.length && picked.length) throw new Error(t('photos.mirrorNoTrash', { name: sync.client?.pairing()?.name ?? '' }))
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
  // the server's photos on a client (its mirror), as an album of their own: shown, not deleted or rearranged here
  const mirrorAlbum = () => {
    const n = db.prepare("SELECT COUNT(DISTINCT sha256) n FROM media WHERE location = 'server'").get().n
    if (!n) return []
    const cover = db.prepare("SELECT sha256 FROM media WHERE location = 'server' AND thumb = 1 ORDER BY taken_at DESC LIMIT 1").get()?.sha256 ?? null
    return [{ id: 'mirror', name: sync.client?.pairing()?.name ?? '', count: n, cover, hidden: false, mirror: true }]
  }
  ipcMain.handle('collections:list', () => { const albums = folders.folderAlbums(); return [...library.collections(db).map(c => ({ ...c, folder: albums.has(c.name.toLowerCase()) })), ...sync.driveAlbums(), ...mirrorAlbum()] })
  ipcMain.handle('collections:create', (_, name) => library.createCollection(db, name))
  ipcMain.handle('collections:delete', (_, id) => library.deleteCollection(db, id))
  // A drive's collection is the drive (sync.js driveMembers): adding copies there, removing takes it off.
  const driveOf = id => String(id).startsWith('drive:') ? String(id).slice(6) : null
  ipcMain.handle('collections:members', (_, id) => id === 'mirror' ? sync.driveMembers('server') : driveOf(id) ? sync.driveMembers(driveOf(id)) : library.members(db, id))
  ipcMain.handle('collections:set', async (_, id, shas, member) => {
    if (!driveOf(id)) return library.setMembership(db, id, shas, member)
    const r = member ? await sync.addToDrive(driveOf(id), shas) : await sync.removeFromDrive(driveOf(id), shas)
    if (r.failed.length) throw new Error(t('main.errCouldNot', { n: r.failed.length, list: r.failed.slice(0, 2).join('; ') }))
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
      if (!row) { result.failed.push(t('main.errHideOnDrive')); continue }
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
  const photoFile = async id => {
    const row = db.prepare('SELECT path, sha256, location FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error(t('main.errPhotoGone'))
    const { file: full, why } = await sync.locate(row)
    if (!full) throw new Error(why)
    return { row, full }
  }
  ipcMain.handle('editor:load', async (_, id) => {
    const { row, full } = await photoFile(id)
    return fs.promises.readFile(library.needsPreview(row.path) ? await library.preview(full, row.sha256, DATA_DIR) : full)
  })
  // The viewer's Text in the photo ('text') and the editor's Hide eyes / Hide text ('eyes', 'text'), on the background thread.
  ipcMain.handle('photo:ask', async (_, id, what) => ask(what === 'eyes' ? 'eyes' : 'text', (await photoFile(id)).full))
  // Maps (maps.js): the same files as the phone's; a change is sent to the devices at once, as the Timer's
  const mapsChanged = r => { sync?.nudge().catch(() => {}); return r }
  ipcMain.handle('maps:info', () => maps.info())
  ipcMain.handle('maps:places', () => maps.places())
  ipcMain.handle('maps:lists', () => maps.lists())
  ipcMain.handle('maps:trips', () => maps.trips())
  ipcMain.handle('maps:savePlace', async (_, p) => mapsChanged(await maps.savePlace(p)))
  ipcMain.handle('maps:deletePlace', async (_, id) => mapsChanged(await maps.deletePlace(id)))
  ipcMain.handle('maps:saveList', async (_, l) => mapsChanged(await maps.saveList(l)))
  ipcMain.handle('maps:deleteList', async (_, id) => mapsChanged(await maps.deleteList(id)))
  ipcMain.handle('maps:saveTrip', async (_, t) => mapsChanged(await maps.saveTrip(t)))
  ipcMain.handle('maps:deleteTrip', async (_, id) => mapsChanged(await maps.deleteTrip(id)))
  ipcMain.handle('maps:search', (_, q) => maps.search(q))
  ipcMain.handle('maps:describe', (_, lat, lng, road) => maps.describe(lat, lng, road))
  ipcMain.handle('maps:near', (_, lat, lng, name) => maps.near(lat, lng, name))
  // on the maps' own graphs: from stop to stop, each leg across a border driven to a crossing and on from there (maps.legs)
  ipcMain.handle('maps:route', async (_, points, mode, main) => {
    if (!Array.isArray(points) || points.length < 2 || !points.every(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))) return routerFor(path.join(maps.root, 'greece-gh')).route(points, mode, !!main)
    const seconds = (dir, a, b) => routerFor(dir).seconds(a, b, mode)
    const legs = [], stops = []
    for (let i = 1; i < points.length; i++) {
      const these = await maps.legs(points[i - 1], points[i], seconds)
      legs.push(...these); stops.push(...these.map((_, k) => k === these.length - 1))
    }
    // all on one graph, as before: one search through every stop
    if (legs.every(l => l.dir === legs[0].dir)) return routerFor(legs[0].dir).route(points, mode, !!main)
    const parts = []
    for (const l of legs) parts.push(await routerFor(l.dir).route([l.from, l.to], mode, !!main))
    return join(parts, stops)
  })
  // the map builder (Settings › Maps): one map at a time; its progress goes to the window, a new map to the devices
  mapBuilder = new MapBuilder(maps.root, p => {
    win?.webContents.send('maps-build', p)
    if (['done', 'error', 'cancelled'].includes(p.state)) cleaned('build') // the builder's cleanup follows at once (mapbuild.js)
    if (p.state === 'done') { win?.webContents.send('maps-changed'); sync?.nudge().catch(() => {}) }
  })
  // a map turned old: said once for each time it is due (keyed by its built date), its click opens Settings › Maps
  const checkMapAges = async () => {
    const due = (await mapBuilder.packs()).filter(p => p.old)
    const said = new Set(JSON.parse(setting('mapsOldSaid') || '[]'))
    for (const p of due) if (!said.has(`${p.id}@${p.built}`)) notify(t('main.mapOld', { name: p.name }), t('main.mapOldBody'), () => win?.webContents.send('open-settings', 'maps'))
    setSetting('mapsOldSaid', JSON.stringify(due.map(p => `${p.id}@${p.built}`))) // the maps no longer due drop out
  }
  if (!process.env.DRIVE_HIDDEN) { setTimeout(() => checkMapAges().catch(e => console.warn('[maps age]', e.message)), 30_000); setInterval(() => checkMapAges().catch(() => {}), 6 * 3_600_000) }
  // Settings › Clean up (cleaner.js): each item's size and its Clean; what runs by itself says when it last did
  cleaner = new Cleaner({ db, dataDir: DATA_DIR, mapsRoot: maps.root, isServer: () => sync?.role() !== 'client', scanned: () => !!scannedAt && !scanning,
    busy: app => app === 'Maps' && !!mapBuilder.job, routing: () => [...routers.keys()] })
  const cleanedAt = () => { try { return JSON.parse(setting('cleanerLast') || '{}') } catch { return {} } }
  function cleaned(what) { setSetting('cleanerLast', JSON.stringify({ ...cleanedAt(), [what]: Date.now() })) }
  if (tempCleaned) cleaned('start')
  // Files history keeps a replaced file 30 days, like the Trash, then lets it go: at start and once a day
  const pruneHistory = () => cleaner.clean('history').then(() => cleaned('history'), e => console.warn('[clean] history', e.message))
  if (!process.env.DRIVE_HIDDEN) { pruneHistory(); setInterval(pruneHistory, 86_400_000) }
  ipcMain.handle('cleaner:items', async () => ({ items: await cleaner.items(), last: cleanedAt() }))
  ipcMain.handle('cleaner:clean', async (_, id) => {
    const ids = id === 'all' ? (await cleaner.items()).filter(i => i.ready && i.files).map(i => i.id) : [String(id)]
    for (const i of ids) await cleaner.clean(i)
    cleaned('manual')
  })
  ipcMain.handle('maps:regions', () => mapBuilder.regions())
  ipcMain.handle('maps:needs', (_, id) => mapBuilder.needs(id))
  ipcMain.handle('maps:missing', () => mapBuilder.missing())
  ipcMain.handle('maps:installSystem', (_, packages) => mapBuilder.installSystem(packages))
  ipcMain.handle('maps:discardBuild', (_, id) => mapBuilder.discard(id))
  ipcMain.handle('maps:build', (_, id) => { mapBuilder.build(id).catch(e => win?.webContents.send('maps-build', { id, state: 'error', error: e.message })) })
  ipcMain.handle('maps:cancelBuild', () => mapBuilder.cancel())
  ipcMain.handle('maps:building', () => mapBuilder.job?.id ?? null)
  ipcMain.handle('maps:packs', () => mapBuilder.packs())
  ipcMain.handle('maps:removePack', async (_, id) => { stopRouters(); await mapBuilder.remove(id, rel => files.trash(rel)); win?.webContents.send('maps-changed'); sync?.nudge().catch(() => {}) })
  // this computer has no GPS: the paired phone's fix — kept, since a PC rarely moves (the user, 26 Oct). The kept one is used
  // until it is older than Settings › Location says ('off': for good); Where I am asks the phone again whatever its age.
  const EVERY_MS = { '30m': 30 * 60_000, '1d': 86_400_000, '1w': 7 * 86_400_000 }
  ipcMain.handle('maps:phoneLocation', async (_, fresh) => {
    let kept = null
    try { kept = JSON.parse(setting('lastFix')) } catch {}
    const every = setting('locationEvery') || 'off'
    if (!fresh && kept && (every === 'off' || Date.now() - kept.at < (EVERY_MS[every] ?? 0))) return kept
    const fix = await sync.phoneLocation()
    if (fix.error) return fresh || !kept ? fix : kept // the phone away: the kept one still says where this computer is
    setSetting('lastFix', JSON.stringify({ ...fix, at: Date.now() }))
    return fix
  })
  ipcMain.handle('settings:locationEvery', () => setting('locationEvery') || 'off')
  ipcMain.handle('settings:setLocationEvery', (_, v) => { if (['off', '30m', '1d', '1w'].includes(v)) setSetting('locationEvery', v) })
  // online: Google's page of the place, with its reviews and photos (the phone's place card does the same)
  // a place's website (or its Διαύγεια decision): web pages only
  ipcMain.handle('maps:web', (_, url) => { if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(t('main.errNotWeb')); return shell.openExternal(url) })
  ipcMain.handle('maps:google', (_, q) => { if (typeof q !== 'string' || !q || q.length > 300) throw new Error(t('main.errNothingToLookUp')); return shell.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q)) })
  ipcMain.handle('editor:save', async (_, id, bytes, mode) => {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id))
    if (!row) throw new Error(t('main.errPhotoGone'))
    // ponytail: saving next to a photo that lives on the storage drive is not built; bring it back first.
    if (row.location) throw new Error(t('main.errEditOnDrive'))
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
    addresses: lanAddresses(),
    devices: sync.devices(), overview: sync.overview(), self: sync.self(), disk: sync.disk() }))
  ipcMain.handle('sync:pair', async () => {
    const payload = sync.startPairing()
    return { payload, qr: await require('qrcode').toDataURL(JSON.stringify(payload), { margin: 1, width: 360, errorCorrectionLevel: 'M' }) }
  })
  ipcMain.handle('sync:files', (_, what, options) => sync.fileList(what, options ?? {}))
  // The first start's question (Setup.tsx) and a client's own Devices page
  ipcMain.handle('role:get', () => ({ role: sync.role(), server: client.status(), nas: sync.nas() }))
  ipcMain.handle('role:server', (_, nas) => { sync.setRole('server'); if (nas) setSetting('nas', '1') })
  // a NAS can become a computer someone sits at, and back, without a reset: no data moves
  ipcMain.handle('role:setNas', (_, on) => { if (sync.role() !== 'server') return; setSetting('nas', on ? '1' : '0'); if (!on) analyzeLibrary() })
  ipcMain.handle('role:join', (_, key) => client.join(String(key ?? '')))
  ipcMain.handle('client:syncNow', () => client.now().then(() => client.status()))
  ipcMain.handle('client:setMirror', (_, on) => client.setMirror(!!on))
  // Settings › Reset (reset.js): what goes, a verified backup first, or the second acknowledgement after its 10 s
  const wiped = () => [...(process.env.DRIVE_FILES || process.env.DRIVE_PHOTOS ? [PHOTOS_ROOT, FILES_ROOT] : [HOME.root]), DATA_DIR]
  let armedAt = 0
  const resetNow = async () => {
    quitting = true
    dataCounter?.stop(); analyzer?.terminate()
    await sync.stop().catch(() => {})
    db.close()
    reset.wipe(wiped())
    app.relaunch()
    app.exit(0)
  }
  ipcMain.handle('reset:info', async () => ({ paths: wiped(), ...await reset.measure(wiped()) }))
  ipcMain.handle('reset:backUp', async () => {
    const { filePaths: [dest] = [] } = await dialog.showOpenDialog(win, { title: t('reset.backupWhere'), properties: ['openDirectory', 'createDirectory'] })
    if (!dest) return null
    const sources = process.env.DRIVE_FILES || process.env.DRIVE_PHOTOS ? [{ from: PHOTOS_ROOT, name: 'Photos' }, { from: FILES_ROOT, name: 'Files' }] : [{ from: HOME.root, name: 'Tetra' }]
    db.pragma('wal_checkpoint(TRUNCATE)') // the database whole in its one file, not half in its -wal
    const done = await reset.backUp([...sources, { from: DATA_DIR, name: 'App data' }], dest)
    setTimeout(resetNow, 1500) // the window says where the backup is first
    return done
  })
  ipcMain.handle('reset:arm', () => { armedAt = Date.now(); return reset.WAIT_MS })
  ipcMain.handle('reset:delete', () => {
    if (!reset.mayDelete(armedAt)) throw new Error('Wait for the 10 seconds.')
    return resetNow()
  })
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
  // Import (importer.js): photos and files from anywhere, to this computer or straight to a plugged-in drive.
  ipcMain.handle('import:pick', async (_, folders) => (await dialog.showOpenDialog(win, { properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections'] })).filePaths)
  ipcMain.handle('import:drives', async () => (await sync.drives()).filter(d => d.device && d.mount).map(d => ({ id: d.device.id, name: d.device.name, free: d.freeBytes })))
  ipcMain.handle('import:cancel', () => { if (importStop) importStop.cancelled = true })
  ipcMain.handle('import:run', async (_, kind, sources, driveId, move) => {
    move = move === true
    const stop = importStop = { cancelled: false }
    if (importing) throw new Error(t('main.errImportRunning'))
    if (!Array.isArray(sources) || !sources.length) throw new Error(t('main.errChooseImport'))
    const plugged = driveId ? (await sync.drives()).find(d => d.device?.id === driveId && d.mount) : null
    if (driveId && !plugged) throw new Error(t('main.errDriveUnplugged'))
    const drive = plugged && { id: plugged.device.id, name: plugged.device.name, mount: plugged.mount }
    const onProgress = p => win?.webContents.send('import-progress', p)
    importing = kind === 'files'
      ? importer.importFiles({ db, root: drive ? path.join(drive.mount, 'Tetra', 'Files') : FILES_ROOT, sources, move, stop, onProgress })
      : (folders.set('Imported', true), importer.importPhotos({ db, photosRoot: PHOTOS_ROOT, sources, drive, move, dropMotion: setting('motionPhotos') === 'remove', stop, scan: () => startScan(), onProgress }))
    try {
      const r = await importing
      if (kind !== 'files') await startScan()
      notify((r.stopped ? t('main.importStopped') : '') + t(`main.import.${move ? 'movedIn' : 'imported'}.${kind === 'files' ? 'files' : 'photos'}`, { count: r.imported, n: r.imported.toLocaleString() }),
        [drive && t('main.importStraight', { name: drive.name }), r.skipped && t('main.importSkipped', { n: r.skipped }), r.failed.length && t('main.importFailed', { n: r.failed.length })].filter(Boolean).join(' '))
      return r
    } finally { importing = null; importStop = null }
  })
  db.exec('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0)')
  ipcMain.handle('notifications:list', () => db.prepare('SELECT id, at, title, body, read FROM notifications ORDER BY at DESC LIMIT 500').all())
  ipcMain.handle('notifications:read', () => { db.exec('UPDATE notifications SET read = 1 WHERE read = 0') })
  ipcMain.handle('notifications:clear', () => { db.exec('DELETE FROM notifications') })
  // Appearance: Auto follows the system, or Light / Dark whatever it says. The page's colours follow nativeTheme.
  ipcMain.handle('settings:theme', () => setting('theme') || 'system')
  // Language: System default (the system's, English when Tetra has no file for it) or one of locales/*.json. The window
  // reloads to show it; the tray and what main says change at once.
  ipcMain.on('i18n:words', e => { e.returnValue = i18n.current() })
  ipcMain.handle('settings:languages', () => ({ choice: i18n.current().choice, system: i18n.resolve('system', [app.getLocale()]), languages: i18n.languages() }))
  ipcMain.handle('settings:setLanguage', (_, choice) => {
    if (choice !== 'system' && !i18n.languages().includes(choice)) return
    setSetting('language', choice); i18n.use(choice, [app.getLocale()]); updateTray()
  })
  ipcMain.handle('settings:setTheme', (_, t) => { if (!['system', 'light', 'dark'].includes(t)) return; setSetting('theme', t); nativeTheme.themeSource = t })
  ipcMain.handle('calendar:call', (_, method, ...args) => {
    if (!CALENDAR_CALLS.includes(method)) throw new Error('Unknown Calendar action.')
    const result = calendar[method](...args)
    if (!['calendars', 'occurrences', 'scheduleEvent', 'trashed'].includes(method)) planReminders() // the watcher nudges the phone
    return result
  })
  // The Timer: what runs, and its buttons; the watcher shows the change and tells the other devices
  ipcMain.handle('timer:active', () => timers.cards())
  ipcMain.handle('timer:last', () => +(setting('timerLast') || 300)) // the clock opens on the length last started here
  ipcMain.handle('timer:start', (_, seconds) => {
    const r = timers.start(seconds)
    setSetting('timerLast', String(r.seconds))
    planTimer()
    return r.id
  })
  ipcMain.handle('timer:change', (_, id, action) => {
    if (!['pause', 'resume', 'stop', 'ok', 'restart', 'pin', 'unpin', 'trash'].includes(action)) throw new Error('Unknown Timer action.')
    const r = timers.read().find(t => t.id === String(id))
    timers.change(String(id), action)
    if (action === 'restart' && r) setSetting('timerLast', String(r.seconds))
    planTimer()
  })
  ipcMain.handle('contacts:call', (_, method, ...args) => {
    if (!CONTACTS_CALLS.includes(method)) throw new Error('Unknown Contacts action.')
    const result = contacts[method](...args)
    if (!['list', 'trashed', 'pairs'].includes(method)) planReminders() // a birthday's event may have changed
    return result
  })
  ipcMain.handle('contacts:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('main.importContacts'), filters: [{ name: t('main.contactsFilter'), extensions: ['vcf', 'csv', 'zip'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    const r2 = contacts.import(readContacts(fs.readFileSync(r.filePaths[0]), r.filePaths[0]))
    planReminders()
    return r2
  })
  ipcMain.handle('contacts:export', async (_, uids, name) => {
    const r = await dialog.showSaveDialog(win, { title: t('main.exportContacts'), defaultPath: path.join(app.getPath('downloads'), `${String(name || 'Contacts').replace(/[/\\:*?"<>|]/g, '-')}.vcf`) })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, contacts.exportCards(Array.isArray(uids) ? uids : null))
    return r.filePath
  })
  // Mail opens mailto:, WhatsApp its web link, Viber its own link (Viber desktop): only these, checked
  ipcMain.handle('contacts:open', (_, how, value) => {
    const v = String(value || '').trim(), digits = v.replace(/[^\d+]/g, '').replace(/^00/, '+')
    const url = how === 'mail' && /^[^\s@]+@[^\s@]+$/.test(v) ? 'mailto:' + v
      : how === 'whatsapp' && digits ? 'https://wa.me/' + digits.replace(/^\+/, '')
      : how === 'viber' && digits ? 'viber://chat?number=' + encodeURIComponent(digits.startsWith('+') ? digits : '+' + digits)
      : how === 'web' && /^https?:\/\/\S+$/i.test(v) ? v : null
    if (!url) throw new Error(t('main.errNothingToOpen'))
    return shell.openExternal(url)
  })
  ipcMain.handle('contacts:phoneCall', async (_, number, name) => {
    const r = await sync.callOnPhone(number, name)
    if (!r.error) calls.outgoing(number, name, r.device) // the call bubble: Calling…, its time, End call
    return r
  })
  // the call bubble's buttons (calls.js), and Settings › Calls: Bluetooth for the call's sound
  ipcMain.handle('call:press', (_, what) => calls.press(String(what)))
  ipcMain.handle('call:height', (_, h) => calls.height(Math.max(150, Math.min(360, Number(h) || 150))))
  // the Phone (Drive-Android Plan.md § Phone): the phone's call history as it sends it (Phone/calls-YYYY-MM.jsonl), and recordings
  ipcMain.handle('phone:history', () => phoneHistory())
  ipcMain.handle('data:all', () => dataCounter.all())
  ipcMain.handle('data:wifi', () => dataCounter.wifi())
  ipcMain.handle('phone:recordings', () => phoneRecordings())
  ipcMain.handle('phone:spam', () => phoneSpam())
  ipcMain.handle('phone:country', () => phoneCountry())
  ipcMain.handle('phone:setSpam', (_, number, on) => setPhoneSpam(number, !!on))
  ipcMain.handle('phone:openRecording', (_, name) => {
    if (!phoneRecordings().some(r => r.name === name)) throw new Error('No such recording.')
    return shell.openPath(path.join(files.disk('Phone/Recordings'), name))
  })
  ipcMain.handle('calls:bluetooth', () => ({ ...calls.bt, sound: calls.sound() }))
  ipcMain.handle('calls:connect', (_, mac) => calls.connect(mac))
  ipcMain.handle('calls:systemBluetooth', () => calls.openSystemBluetooth())
  // A face from Photos as a contact's photo: the face's box (fractions of the upright picture) × 1.8, square, 512 px — the phone's crop
  ipcMain.handle('contacts:facePhoto', (_, faceId) => contactFacePhoto(faceId))
  ipcMain.handle('contacts:settings', () => ({ birthdays: contacts.birthdayCalendar(false), calendars: calendar.calendars(), byLast: setting('contactsByLast') === '1' }))
  ipcMain.handle('contacts:setBirthdays', (_, id) => { if (!calendar.calendars().some(c => c.id === id)) throw new Error('No such calendar.'); setSetting('contactsBirthdays', id); contacts.chosen = id })
  ipcMain.handle('contacts:setByLast', (_, on) => setSetting('contactsByLast', on ? '1' : '0'))
  // Refresh: the phones and tablets are asked to sync now; what they bring shows through the watcher
  ipcMain.handle('calendar:refresh', () => sync.nudge())
  ipcMain.handle('calendar:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('main.importCalendars'), filters: [{ name: t('main.calendarsFilter'), extensions: ['ics', 'zip'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    calendarIncoming = Calendar.readImport(r.filePaths[0]).filter(i => i.events.size)
    return calendarIncoming.map((i, index) => ({ index, name: i.name, color: i.color, count: i.events.size }))
  })
  ipcMain.handle('calendar:import', (_, choices) => {
    let added = 0, updated = 0
    for (const { index, into } of choices) { const r = calendar.importInto(calendarIncoming[index], into); added += r.added; updated += r.updated }
    calendarIncoming = []
    planReminders()
    return { added, updated }
  })
  ipcMain.handle('calendar:export', async (_, id) => {
    const all = id == null
    const r = await dialog.showSaveDialog(win, { title: all ? t('main.exportAllCalendars') : t('main.exportCalendar'), defaultPath: path.join(app.getPath('downloads'), all ? 'Tetra calendars.zip' : `${id}.ics`) })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, all ? calendar.exportAll() : calendar.exportCalendar(id))
    return r.filePath
  })
  // Share with Claude (asked 18 Oct; the Timer's 19 Oct): a skill the app was built with (desktop/skills, copied from Drive-Android's)
  const SKILLS = ['tetra-calendar', 'tetra-timer']
  const skillDir = name => { if (!SKILLS.includes(name)) throw new Error('Unknown skill.'); return path.join(__dirname, 'skills', name) }
  const skillFiles = name => fs.readdirSync(skillDir(name)).filter(n => !n.startsWith('.') && fs.statSync(path.join(skillDir(name), n)).isFile())
  ipcMain.handle('skill:save', async (_, name) => {
    skillDir(name)
    const r = await dialog.showSaveDialog(win, { title: t('main.saveSkill'), defaultPath: path.join(app.getPath('downloads'), `${name}.zip`) })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, require('./calendar').zip(skillFiles(name).map(n => ({ name: `${name}/${n}`, data: fs.readFileSync(path.join(skillDir(name), n)) }))))
    return r.filePath
  })
  ipcMain.handle('skill:install', (_, name) => { // for Claude Code on this computer
    const to = path.join(os.homedir(), '.claude', 'skills', name)
    const files = skillFiles(name)
    fs.mkdirSync(to, { recursive: true })
    for (const n of files) fs.copyFileSync(path.join(skillDir(name), n), path.join(to, n))
    return to
  })
  ipcMain.handle('calendar:settings', () => ({ reminders: setting('calendarReminders') !== 'off', autostart: fs.existsSync(AUTOSTART) }))
  ipcMain.handle('calendar:setReminders', (_, on) => { setSetting('calendarReminders', on ? 'on' : 'off'); planReminders() })
  ipcMain.handle('calendar:setAutostart', (_, on) => setAutostart(!!on))
  ipcMain.handle('notes:call', (_, method, ...args) => {
    if (!NOTE_CALLS.includes(method)) throw new Error('Unknown Notes action.')
    const result = notes[method](...args)
    if (['save', 'remove', 'restoreVersion'].includes(method)) {
      clearTimeout(notesNudge)
      notesNudge = setTimeout(() => sync.nudge().catch(() => {}), 2500)
    }
    return result
  })
  // Export as Markdown (the user, 27 Oct): every note into a new folder at the top of Files, so nothing is written over,
  // or one note where they save it; each file keeps its note's time
  const writeMarkdown = (file, text, at) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (at) fs.utimesSync(file, new Date(at), new Date(at)) }
  ipcMain.handle('notes:exportAll', () => {
    const name = exportFolder(new Date())
    let dir = path.join(FILES_ROOT, name)
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(FILES_ROOT, `${name} (${i})`) // two in one minute
    const all = notes.list()
    for (const f of markdownFiles(all, t('notes.untitled'))) writeMarkdown(path.join(dir, f.path), f.text, f.at)
    return { count: all.length, folder: path.basename(dir) }
  })
  ipcMain.handle('notes:exportOne', async (_, id) => {
    const note = notes.get(id)
    if (!note) throw new Error(t('notes.gone'))
    const { name, text } = markdown(note, t('notes.untitled'))
    const r = await dialog.showSaveDialog(win, { title: t('notes.exportMarkdown'), defaultPath: path.join(app.getPath('downloads'), `${name}.md`) })
    if (r.canceled || !r.filePath) return null
    writeMarkdown(r.filePath, text, note.updatedAt)
    return r.filePath
  })
  ipcMain.handle('files:open', async (_, rel) => {
    const full = files.resolve(rel)
    const error = await shell.openPath(full)
    if (error) throw new Error(error)
    if (require('node:fs').statSync(full).isFile()) files.recordOpen(rel) // Recent lists files only, like the phone
  })
  ipcMain.handle('files:sendToPhone', (_, rels) => sync.sendToDevice(rels.map(r => files.resolve(r))))
  ipcMain.handle('files:reveal', (_, rel) => shell.showItemInFolder(files.resolve(rel)))
  ipcMain.handle('library:show', (_, id) => {
    const row = db.prepare('SELECT path, location FROM media WHERE id = ?').get(id)
    if (row) sync.locate(row).then(at => at.file && shell.showItemInFolder(at.file))
  })

  // AI Assist (assistant.js): Mistral and Tetra's tools here, the microphone, the voice and the record in the window. The key
  // is kept encrypted by the system's keyring (safeStorage) and never goes to the window.
  const assistKey = () => { try { const s = setting('assistantKey'); return s ? safeStorage.decryptString(Buffer.from(s, 'base64')) : null } catch { return null } }
  const meterAdd = x => { const m = assistant.Meter.of(setting('assistantMeter')); m.add(x); setSetting('assistantMeter', m.json()) }
  const assistWords = () => setting('assistantWords') ?? 'Καλοτραπέζης, Θεολόγος, Tetra, ΥΠΕΧΩΔΕ'
  const assistBias = () => assistant.terms(assistWords(), setting('assistantContactWords') === '1' ? contacts.list().filter(c => c.favourite).map(c => c.name).slice(0, 50) : [])
  const assistPause = () => Math.min(6000, Math.max(1000, Number(setting('assistantPause')) || 2500))
  const api = new assistant.Mistral({ key: assistKey, bill: new assistant.Bill(meterAdd) })
  /** The voice that reads: 'system' (this computer's own, free) or a Mistral voice's id, Mistral's first when none was picked. */
  const assistVoice = async () => {
    const v = setting('assistantVoice')
    if (v) return v
    const first = (await api.voices())[0]
    if (!first) return 'system'
    setSetting('assistantVoice', first.id); setSetting('assistantVoiceName', first.name)
    return first.id
  }
  const assistTools = new assistant.Tools({ calendar, timers, notes, files, contacts, maps, mail,
    // the Calendar's, Timer's and Contacts' folders are watched (shown, the devices told); Notes' is not
    changed: what => { if (what === 'notes') { win?.webContents.send('notes-changed'); sync?.nudge().catch(() => {}) } },
    search: async q => { const r = await api.conversation(q, 'web_search', 'Search the web and answer briefly with the facts found.'); return r.text + (r.sources.length ? '\nSources: ' + r.sources.slice(0, 3).join('; ') : '') },
    // pictures go to Files › Assistant, a folder like any other, so they reach the phone
    image: async prompt => {
      const id = (await api.conversation(prompt, 'image_generation', 'Draw the picture asked for.')).files[0]
      if (!id) throw new Error('No picture came back.')
      const full = path.join(FILES_ROOT, 'Assistant', `image-${Date.now()}.png`)
      fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, await api.download(id))
      return { name: path.basename(full), full }
    },
    // shortcut: which card is the user's is kept on this computer only (Contacts has no "me" mark yet); into the card once the devices need it
    me: () => setting('assistantMe') || null, setMe: uid => setSetting('assistantMe', uid) })
  const chat = new assistant.Chat(api, assistTools)
  let voiceStop = null // the answer being read aloud
  /** This computer's own voice, the free one: speech-dispatcher (Chromium's speechSynthesis finds no voices in Electron here). */
  const spdSay = (text, signal) => new Promise(resolve => {
    if (signal.aborted) return resolve()
    const p = require('node:child_process').spawn('spd-say', ['-w', '-l', /[\u0370-\u03ff]/.test(text) ? 'el' : 'en', '--', text], { stdio: 'ignore' })
    p.on('error', e => { console.warn('[assistant] spd-say', e.message); resolve() }); p.on('exit', resolve)
    signal.addEventListener('abort', () => { p.kill(); require('node:child_process').spawn('spd-say', ['-C'], { stdio: 'ignore' }).on('error', () => {}) }, { once: true })
  })
  const hush = () => { voiceStop?.abort(); voiceStop = null }
  /** [text] cut into sentences and read, each as soon as it ends, by [voice]; the next made while one plays (the window queues the sound). */
  function reader(sender, voice) {
    const stop = voiceStop = new AbortController()
    const send = (ch, x) => { if (!sender.isDestroyed()) sender.send(ch, x) }
    let queue = Promise.resolve()
    const say = s => {
      if (!s || stop.signal.aborted) return
      queue = queue.then(() => stop.signal.aborted ? null : voice === 'system' ? (send('assistant-say', s), spdSay(s, stop.signal))
        : api.speech(voice, s, pcm => send('assistant-audio', pcm), stop.signal))
        .catch(e => { if (e.name !== 'AbortError') { console.warn('[assistant] voice', e.message); stop.abort() } })
    }
    return { say, done: () => queue }
  }
  ipcMain.handle('assistant:ask', async (e, text, aloud) => {
    hush()
    const voice = aloud ? await assistVoice().catch(() => 'system') : null
    const read = voice && reader(e.sender, voice), cut = new assistant.Sentences()
    const r = await chat.ask(String(text), w => { if (!e.sender.isDestroyed()) e.sender.send('assistant-words', w); if (read) cut.push(w).forEach(read.say) })
    if (read) { read.say(cut.rest()); await read.done() }
    return { ...r, images: r.images.map(f => 'data:image/png;base64,' + fs.readFileSync(f.full).toString('base64')), spent: chat.bill.usd }
  })
  ipcMain.handle('assistant:transcribe', async (_, pcm) => ({ text: await api.transcribe(Int16Array.from(pcm), assistBias()), spent: chat.bill.usd }))
  ipcMain.handle('assistant:hush', () => hush())
  ipcMain.handle('assistant:clear', () => { hush(); chat.clear(); assistTools.lists = { contacts: [], files: [], notes: [], timers: [], mail: [] } })
  ipcMain.handle('assistant:youtube', (_, q) => shell.openExternal('https://www.youtube.com/results?search_query=' + encodeURIComponent(String(q).slice(0, 200))))
  ipcMain.handle('assistant:hide', () => { win?.hide(); vault?.lock() })
  // Live (the waveform button): the window's microphone to Voxtral realtime, its turns back to the window, which asks as above
  let live = null
  ipcMain.handle('assistant:liveStart', e => {
    live?.end()
    const key = assistKey()
    if (!key) throw new Error(t('assistant.noKey'))
    const send = x => { if (!e.sender.isDestroyed()) e.sender.send('assistant-live', x) }
    live = new assistant.Live({ key, bias: assistBias(), pauseMs: assistPause(),
      heard: text => send({ type: 'heard', text }), turn: text => send({ type: 'turn', text }), failed: err => send({ type: 'error', message: err.message }) })
    live.started = Date.now()
  })
  ipcMain.on('assistant:liveAudio', (_, bytes) => live?.audio(bytes))
  ipcMain.handle('assistant:liveMute', (_, on) => live?.mute(on))
  // paid by the minute: billed when it ends
  ipcMain.handle('assistant:liveEnd', () => {
    if (live) { live.end(); if (live.ready) chat.bill.minutes(assistant.REALTIME, (Date.now() - live.started) / 1000); live = null } // a refused connection costs nothing
    return chat.bill.usd
  })
  // Settings › AI Assist
  const SHORTCUTS = { toggle: 'Ctrl+Alt+A', talk: 'Ctrl+Alt+M', live: 'Ctrl+Alt+V' }
  const shortcuts = () => { try { return { ...SHORTCUTS, ...JSON.parse(setting('assistantShortcuts')) } } catch { return { ...SHORTCUTS } } }
  let shortcutsOn = {}
  function registerShortcuts() {
    globalShortcut.unregisterAll()
    shortcutsOn = {}
    if (process.env.DRIVE_HIDDEN) return
    for (const [what, acc] of Object.entries(shortcuts())) {
      if (!acc) continue
      try { shortcutsOn[what] = globalShortcut.register(acc, () => assistantCommand(what)) } catch (e) { console.warn('[assistant] shortcut', acc, e.message); shortcutsOn[what] = false }
    }
  }
  registerShortcuts()
  const meterNow = () => { const m = assistant.Meter.of(setting('assistantMeter')); return { total: m.total, trip: m.trip, since: m.since, past: m.past } }
  // Mail, read-only (mail.js). The password is checked against the server before it is kept, encrypted, in settings.
  const isAddress = a => typeof a === 'string' && a.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)
  ipcMain.handle('mail:accounts', () => ({ accounts: mail.accounts(), folders: mail.folders(), status: mail.status() }))
  ipcMain.handle('mail:list', (_, role, account) => mail.list(String(role), account ? String(account) : null))
  ipcMain.handle('mail:open', (_, id, images) => mail.open(String(id), { images: images === true }))
  // step 6: the clean-up and its first-run check, the garbage scan, filters, the spam filter, remote pictures
  const care = require('./mailclean')
  const short = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Array.isArray(v) ? { count: v.length, sample: v.slice(0, 30).map(x => typeof x === 'string' ? x : x.drop) } : v]))
  ipcMain.handle('mail:cleanPlan', (_, id) => care.summary(mail, care.plan(mail, mail.account(String(id)))))
  ipcMain.handle('mail:cleanRun', (_, id) => mailCall(() => { const acc = mail.account(String(id)); return care.run(mail, acc, care.plan(mail, acc)) }))
  ipcMain.handle('mail:garbage', () => short(care.garbage(mail)))
  ipcMain.handle('mail:sweep', () => care.sweep(mail))
  ipcMain.handle('mail:filters', () => care.filters(mail))
  ipcMain.handle('mail:setFilters', (_, list) => care.setFilters(mail, list))
  ipcMain.handle('mail:runFilters', (_, role, account) => mailCall(() => care.applyFilters(mail, mail.list(String(role), account ? String(account) : null), { filesRoot: files.root })))
  ipcMain.handle('mail:junk', () => { const j = mail.junk(); return { on: j.on, nSpam: j.nSpam, nHam: j.nHam, ready: j.ready() } })
  ipcMain.handle('mail:setJunk', (_, on) => { const j = mail.junk(); j.on = !!on; j.save() })
  ipcMain.handle('mail:privacy', () => mail.privacy())
  ipcMain.handle('mail:setPrivacy', (_, p) => mail.setPrivacy(p))
  ipcMain.handle('mail:detect', (_, address) => isAddress(address) ? detectMail(address.trim().toLowerCase()) : null)
  ipcMain.handle('mail:add', async (_, address, server, pass) => {
    const s = server ?? {}
    if (!isAddress(address) || typeof s.host !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(s.host) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535
      || !Array.isArray(s.users) || !s.users.every(u => typeof u === 'string' && u.length < 255) || typeof pass !== 'string' || !pass) throw new Error(t('mail.badServer'))
    if (!safeStorage.isEncryptionAvailable()) return { error: 'keyring' }
    address = address.trim().toLowerCase()
    const smtp = s.smtp && typeof s.smtp.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(s.smtp.host) && Number.isInteger(s.smtp.port) && s.smtp.port > 0 && s.smtp.port < 65536
      ? { host: s.smtp.host, port: s.smtp.port, secure: !!s.smtp.secure } : null
    const found = { host: s.host, port: s.port, secure: !!s.secure, users: s.users, provider: s.provider === 'google' ? 'google' : null, smtp }
    try {
      const { user, roles } = await checkMail(found, address, pass)
      keepMailSecret(address, pass)
      return { account: mail.add({ address, server: found, user }), roles: Object.keys(roles) }
    } catch (e) { return { error: e.reason ?? 'other', detail: e.message } }
  })
  // «Σύνδεση με Microsoft»: Microsoft's page in the browser, the code back to this computer, the refresh token kept encrypted
  ipcMain.handle('mail:addMicrosoft', async (_, address) => {
    if (!isAddress(address)) throw new Error(t('mail.badServer'))
    if (!safeStorage.isEncryptionAvailable()) return { error: 'keyring' }
    address = address.trim().toLowerCase()
    try {
      const tok = await msauth.signIn({ clientId: msClient(), address, open: url => shell.openExternal(url) })
      const { user, roles } = await checkMail(MICROSOFT, address, { accessToken: tok.access })
      keepMailSecret(address, JSON.stringify({ refresh: tok.refresh })); msTokens.set(address, tok)
      return { account: mail.add({ address, server: MICROSOFT, user, auth: 'microsoft' }), roles: Object.keys(roles) }
    } catch (e) { return { error: e.reason ?? 'other', detail: e.message } }
  })
  ipcMain.handle('mail:msClient', () => msClient())
  ipcMain.handle('mail:setMsClient', (_, id) => {
    const v = String(id ?? '').trim()
    if (v && !msauth.isClientId(v)) throw new Error(t('mail.badClient'))
    setSetting('mailMicrosoftClientId', v); msTokens.clear()
  })
  ipcMain.handle('mail:remove', (_, id) => { mail.remove(String(id)); db.prepare('DELETE FROM settings WHERE key = ?').run('mailSecret:' + id) })
  ipcMain.handle('mail:sync', () => mail.syncNow())
  // what went wrong, as the one plain sentence (MAIL_PLAN §9b); the technical part stays in the log
  const mailCall = async fn => { try { return await fn() } catch (e) { throw new Error(e.reason && e.reason !== 'other' ? t(`mail.err_${e.reason}`) : e.message) } }
  ipcMain.handle('mail:act', (_, op, ids, to) => mailCall(() => mail.act({ op, ids, to })))
  ipcMain.handle('mail:draftFor', (_, id, kind, account) => mailCall(() => mail.draftFor(id ? String(id) : null, String(kind), account ? String(account) : null)))
  ipcMain.handle('mail:saveDraft', (_, d) => mailCall(() => mail.saveDraft(d)))
  ipcMain.handle('mail:send', (_, d) => mailCall(() => mail.send(d)))
  ipcMain.handle('mail:discard', (_, d) => mailCall(() => mail.discardDraft(d)))
  ipcMain.handle('mail:addresses', () => mail.addresses())
  ipcMain.handle('mail:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('mail.attach'), properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths.map(p => { mail.picked.add(p); return { name: path.basename(p), path: p, size: fs.statSync(p).size } })
  })
  // a logo for a signature: the picture itself goes into the HTML, so it shows without loading anything from the web
  ipcMain.handle('mail:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('mail.image'), properties: ['openFile'], filters: [{ name: t('mail.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
    if (r.canceled) return null
    const bytes = fs.readFileSync(r.filePaths[0])
    if (bytes.length > 300_000) throw new Error(t('mail.imageTooBig'))
    const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase()
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytes.toString('base64')}`
  })
  ipcMain.handle('mail:signatures', () => mail.signatures())
  ipcMain.handle('mail:setSignature', (_, address, sig) => { if (!mail.accounts().some(a => a.address === address)) throw new Error(t('mail.badServer')); mail.setSignature(address, sig) })
  ipcMain.handle('mail:setAccount', (_, id, changes) => mail.setAccount(String(id), changes))
  ipcMain.handle('mail:openFile', async (_, rel) => {
    const full = mail.inside(rel)
    if (!full) throw new Error(t('mail.fileGone'))
    const error = await shell.openPath(full)
    if (error) throw new Error(error)
  })
  ipcMain.handle('mail:openLink', (_, url) => { if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) return shell.openExternal(url) })
  ipcMain.handle('mail:appPasswords', () => shell.openExternal('https://myaccount.google.com/apppasswords'))
  // Google's 16 letters, read from the clipboard when the user comes back (MAIL_PLAN §9b); anything else is not read out
  ipcMain.handle('mail:pasteAppPassword', () => { const s = clipboard.readText().trim().toLowerCase(); return /^[a-z]{4}( ?[a-z]{4}){3}$/.test(s) ? s.replace(/ /g, '') : null })
  ipcMain.handle('assistant:settings', () => ({
    hasKey: !!assistKey(), keyring: safeStorage.isEncryptionAvailable(), words: assistWords(), contactWords: setting('assistantContactWords') === '1',
    voice: setting('assistantVoice') || '', voiceName: setting('assistantVoiceName') || '', pause: assistPause(), aloud: setting('assistantAloud') !== '0',
    cassette: setting('assistantCassette') === '1', meter: meterNow(), spent: chat.bill.usd, perMinute: assistant.PER_MINUTE[assistant.REALTIME],
    // the live captions' "Theologos: …": the user's own card, once AI Assist knows it (my_card)
    meName: (c => c ? c.info.given || c.info.formatted : '')(contacts.all().find(c => c.info.uid === setting('assistantMe'))),
    shortcuts: shortcuts(), registered: shortcutsOn, command: launchCommand(), session: process.env.XDG_SESSION_TYPE || '', desktop: process.env.XDG_CURRENT_DESKTOP || '',
  }))
  ipcMain.handle('assistant:setKey', (_, key) => {
    const k = String(key || '').trim()
    if (!k) { db.prepare('DELETE FROM settings WHERE key = ?').run('assistantKey'); return false }
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('assistant.noKeyring'))
    setSetting('assistantKey', safeStorage.encryptString(k).toString('base64'))
    return true
  })
  ipcMain.handle('assistant:set', (_, changes) => {
    const c = changes ?? {}
    if (typeof c.words === 'string') setSetting('assistantWords', c.words.slice(0, 4000))
    if (typeof c.contactWords === 'boolean') setSetting('assistantContactWords', c.contactWords ? '1' : '0')
    if (typeof c.voice === 'string') { setSetting('assistantVoice', c.voice.slice(0, 200)); setSetting('assistantVoiceName', String(c.voiceName ?? '').slice(0, 200)) }
    if (Number.isFinite(c.pause)) setSetting('assistantPause', String(Math.min(6000, Math.max(1000, Math.round(c.pause)))))
    if (typeof c.aloud === 'boolean') setSetting('assistantAloud', c.aloud ? '1' : '0')
    if (typeof c.cassette === 'boolean') setSetting('assistantCassette', c.cassette ? '1' : '0')
    if (c.shortcuts && typeof c.shortcuts === 'object') {
      const next = shortcuts()
      for (const k of Object.keys(SHORTCUTS)) if (typeof c.shortcuts[k] === 'string') next[k] = c.shortcuts[k].slice(0, 60)
      setSetting('assistantShortcuts', JSON.stringify(next))
      registerShortcuts()
    }
  })
  ipcMain.handle('assistant:voices', () => api.voices())
  ipcMain.handle('assistant:sample', async (e, voice) => {
    hush()
    const read = reader(e.sender, String(voice || 'system'))
    read.say(t('assistant.voiceSample'))
    await read.done()
  })
  ipcMain.handle('assistant:resetMeter', () => { const m = assistant.Meter.of(setting('assistantMeter')); m.reset(); setSetting('assistantMeter', m.json()); return meterNow() })

  if (!process.env.DRIVE_HIDDEN && HOME.root.endsWith('Tetra')) home.markFolder(HOME.root, path.join(__dirname, 'public', 'icon.png'), DATA_DIR)
  nativeTheme.themeSource = setting('theme') || 'system'
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 500,
    backgroundColor: '#121416', title: 'Tetra',
    icon: path.join(__dirname, 'public', 'icon.png'),
    autoHideMenuBar: true,
    show: !process.env.DRIVE_HIDDEN && !process.argv.includes('--hidden'), // visual QA renders unseen; at login Tetra starts in the tray
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: !!process.env.DRIVE_HIDDEN, autoplayPolicy: 'no-user-gesture-required' }, // the Timer's alarm rings unasked
  })
  // Right-click on text: the usual Cut / Copy / Paste / Select all, and spelling suggestions (asked 2026-09-26; Electron
  // gives none by itself). Undo and Redo stay the note's own, by the word — the built-in ones would not know about it.
  win.webContents.on('context-menu', (_, p) => {
    const items = []
    for (const word of p.dictionarySuggestions ?? []) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) })
    if (p.misspelledWord) items.push({ label: t('main.addToDictionary'), click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
    if (p.isEditable) items.push({ role: 'cut', label: t('main.cut'), enabled: p.editFlags.canCut }, { role: 'copy', label: t('common.copy'), enabled: p.editFlags.canCopy }, { role: 'paste', label: t('main.paste'), enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: t('main.selectAll') })
    else if (p.selectionText.trim()) items.push({ role: 'copy', label: t('common.copy') })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
  watchCalendar()
  watchContacts()
  setTimeout(linkContactFaces, 30_000); setInterval(linkContactFaces, 5 * 60_000) // Photos' names and portraits, as they change or arrive from the phone
  planReminders()
  watchTimer()
  planTimer()
  powerMonitor.on('resume', planTimer)
  powerMonitor.on('resume', planReminders) // a timer does not run while the computer sleeps
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL)
  else win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  // started as `tetra --assistant` (or --talk, --live): once the window listens
  if (argCommand(process.argv)) win.webContents.once('did-finish-load', () => setTimeout(() => assistantCommand(argCommand(process.argv)), 1500))
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
// `tetra --assistant` / `--talk` / `--live` (AI Assist): what the desktop's own shortcut settings can run where Tetra's own
// shortcuts cannot reach (Settings › AI Assist › Shortcuts)
const ARGS = { '--assistant': 'toggle', '--talk': 'talk', '--live': 'live' }
const argCommand = argv => Object.entries(ARGS).find(([a]) => argv.includes(a))?.[1] ?? null
app.on('second-instance', (_, argv) => { const what = argCommand(argv); if (what) assistantCommand(what); else showWindow() })
/** A shortcut or `tetra --assistant`: open (or, when it is already in front, close) AI Assist, talk, or live. */
function assistantCommand(what) {
  if (!win) return
  if (what === 'toggle' && win.isVisible() && win.isFocused()) { win.webContents.send('assistant-command', 'toggle'); return }
  showWindow()
  win.webContents.send('assistant-command', what === 'toggle' ? 'open' : what)
}
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { quitting = true; mail?.stopAll(); mapBuilder?.cancel(); calls?.quit(); dataCounter?.stop(); vault?.lock(); analyzer?.terminate(); stopRouters() })
process.on('exit', stopRouters) // a Tetra stopped without quitting leaves no routing server behind

/** The phone's calls, newest first (at most 1000): the lines the phone writes into Phone/calls-YYYY-MM.jsonl. */
function phoneHistory() {
  const dir = files.disk('Phone')
  let months = []
  try { months = fs.readdirSync(dir).filter(n => /^calls-\d{4}-\d{2}\.jsonl$/.test(n)).sort().reverse() } catch { return [] }
  const out = []
  for (const m of months) {
    let lines = []
    try { lines = fs.readFileSync(path.join(dir, m), 'utf8').split('\n').filter(Boolean).reverse() } catch {}
    for (const l of lines) { try { out.push(JSON.parse(l)) } catch {} }
    if (out.length >= 1000) break
  }
  return out.slice(0, 1000)
}

/** Calls recorded on this computer (Phone/Recordings), newest first. */
function phoneRecordings() {
  const dir = files.disk('Phone/Recordings')
  try {
    return fs.readdirSync(dir).filter(n => /\.(ogg|opus|m4a|mp3|wav)$/i.test(n)).map(name => { const s = fs.statSync(path.join(dir, name)); return { name, size: s.size, at: s.mtimeMs } })
      .sort((a, b) => b.at - a.at)
  } catch { return [] }
}

// Spam and unwanted callers: Phone/spam.txt, the same list as the phone's (Drive-Android PhoneSpam) — one number a line, a
// note after #, a * at the end for a range; the phone declines a match before it rings.
const SPAM_HEAD = '# Spam and unwanted (Tetra Phone): one number a line, a note after #; a * at the end takes every number that starts so.\n# Calls from these are declined before they ring. The same list on the phone, the tablet and the computer.\n'
const spamFile = () => files.disk('Phone/spam.txt')
const spamParse = text => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => ({ number: l.split('#')[0].trim().replace(/ /g, ''), note: l.includes('#') ? l.slice(l.indexOf('#') + 1).trim() : '' })).filter(e => /\d/.test(e.number))
// a number or a range's start as + its country code and the rest, a national one read in the phone's country (src/phonecountry.ts)
const phoneCountry = () => setting('phoneCountry') || app.getLocaleCountryCode() || ''
const spamInternational = n => { const a = new AsYouType(phoneCountry() || undefined); a.input(String(n).trim()); return a.getNumberValue() || String(n).replace(/\D/g, '') }
const spamSame = (a, b) => { const k = s => String(s).replace(/\D/g, '').slice(-9); return k(a).length >= 5 && k(a) === k(b) }
const spamMatch = (list, n) => list.find(e => e.number.endsWith('*') ? (p => (e.number.replace(/\D/g, '').length >= 2 && spamInternational(n).startsWith(p)))(spamInternational(e.number.slice(0, -1))) : spamSame(e.number, n))
function phoneSpam() { try { return spamParse(fs.readFileSync(spamFile(), 'utf8')) } catch { return [] } }
function setPhoneSpam(number, on) {
  const n = String(number || '').replace(/[^\d+*]/g, '')
  if (!/\d/.test(n)) throw new Error(t('main.errNotPhone'))
  let text = ''; try { text = fs.readFileSync(spamFile(), 'utf8') } catch { text = SPAM_HEAD }
  if (on) { if (!spamMatch(spamParse(text), n)) text = text.replace(/\n*$/, '\n') + n + '\n' }
  else text = text.split('\n').filter(l => { const e = spamParse(l)[0]; return !e || (n.endsWith('*') ? e.number !== n : (e.number.endsWith('*') || !spamSame(e.number, n))) }).join('\n').replace(/\n*$/, '\n')
  fs.mkdirSync(path.dirname(spamFile()), { recursive: true }); fs.writeFileSync(spamFile(), text)
  sync?.nudge().catch(() => {}) // to the phone now
  return phoneSpam()
}
