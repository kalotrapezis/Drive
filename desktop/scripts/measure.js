// Dev helper: how long each page takes to open. DRIVE_DATA=<a copy of the library> node_modules/.bin/electron scripts/measure.js
// Renders hidden (never on the user's desktop). For each page, twice (opened, then opened again): when its content stopped
// changing (no change for 0.6 s), and the longest task that kept the window from answering (Chromium's long tasks, > 50 ms).
const { app, BrowserWindow } = require('electron')
process.env.DRIVE_HIDDEN = '1'
require('../main.js')
const pages = (process.env.PAGES || 'Photos,Files,Notes,Calendar,Timer,Maps,Contacts,Phone,Data,Devices,Settings').split(',')
const open = label => `new Promise(done => {
  const longs = []; const po = new PerformanceObserver(l => l.getEntries().forEach(e => longs.push(e.duration))); po.observe({ type: 'longtask' })
  const t0 = performance.now(); let last = t0
  const mo = new MutationObserver(() => { last = performance.now() }); mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  const b = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return done('no such page')
  b.click()
  const check = () => performance.now() - last > 600 || performance.now() - t0 > 15000
    ? (mo.disconnect(), po.disconnect(), done(Math.round(last - t0) + ' ms, longest task ' + Math.round(Math.max(0, ...longs)) + ' ms (' + longs.length + ' over 50)'))
    : setTimeout(check, 50)
  setTimeout(check, 50)
})`
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  for (const round of ['opened', 'again']) for (const p of pages) console.log(`${p} ${round}: ${await win.webContents.executeJavaScript(open(p))}`)
  app.quit()
}, 8000))
