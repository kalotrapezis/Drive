// Dev helper: node_modules/.bin/electron scripts/shot.js out.png [js to run first]. Captures the window and quits.
const { app, BrowserWindow } = require('electron')
process.env.DRIVE_HIDDEN = '1' // never pop up on the user's desktop
require('../main.js')
const [out, js] = process.argv.slice(process.argv.findIndex(a => a.endsWith('shot.js')) + 1)
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (process.env.SHOT_CONSOLE) win.webContents.on('console-message', e => console.log('[page]', e.message))
  if (js) { await win.webContents.executeJavaScript(js).catch(console.error); await new Promise(r => setTimeout(r, 1500)) }
  require('node:fs').writeFileSync(out, (await win.webContents.capturePage()).toPNG())
  app.quit()
}, 4000))
