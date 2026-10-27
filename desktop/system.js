'use strict'
/**
 * ~/Tetra/.System: everything Tetra keeps for its own use, in one hidden folder (the user, 27 Oct 2026: "gather all of
 * these under one system folder, and make it hidden: .System"). Every path in it is made here and nowhere else;
 * SYSTEM.md says what each folder is for and who may delete what. It never syncs, never goes into a backup of the
 * library, and a reset keeps it (reset.js).
 *
 *   .System/<App>/Data    what the app keeps and needs: never cleaned
 *   .System/<App>/Tools   programs it fetched: kept, replaced only by an update
 *   .System/<App>/Cache   can be made again: a cleaner may empty it any time
 *   .System/<App>/Temp    work in progress: emptied when the job ends and at every start
 *
 * The names are fixed now so they never change; a folder is made only when something writes into it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NAME = '.System'
const APPS = ['Photos', 'Files', 'Notes', 'Calendar', 'Timer', 'Contacts', 'Phone', 'Maps', 'Office', 'Sync', 'Backups']
const KINDS = ['Data', 'Tools', 'Cache', 'Temp']

/** ~/Tetra/.System, always beside ~/Tetra/Photos and ~/Tetra/Files. */
const root = (home = os.homedir()) => path.join(home, 'Tetra', NAME)

/** `<App>/<Kind>`: only the names above, so nobody makes a folder the cleaners do not know. */
function dir(app, kind, base = root()) {
  if (!APPS.includes(app) || !KINDS.includes(kind)) throw new Error(`Not a folder of ${NAME}: ${app}/${kind}`)
  return path.join(base, app, kind)
}

/**
 * Once: ~/Tetra-maps and ~/Tetra-backups, Tetra's own folders beside ~/Tetra until 27 Oct 2026, into .System by renaming
 * (one disk: instant, no room needed, all or nothing). The old maps folder becomes Maps/Data as it was (osm/, traces/,
 * tools/maps-greece.sh's files), then its bin/ Maps/Tools and Geofabrik's list Maps/Cache. Nothing is copied or deleted;
 * a move that fails leaves both where they were and says why. Each step is checked on its own, so an interrupted one
 * finishes on the next start. { moved, failed }.
 */
function migrate(home = os.homedir(), base = root(home)) {
  const moved = [], failed = []
  const move = (from, to) => {
    if (!fs.existsSync(from)) return
    if (fs.existsSync(to)) { failed.push(`${from}: ${to} is there already, so it was left`); return }
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); moved.push(`${from} → ${to}`) }
    catch (e) { failed.push(`${from} → ${to}: ${e.message}`) }
  }
  const data = dir('Maps', 'Data', base)
  move(path.join(home, 'Tetra-maps'), data)
  move(path.join(data, 'bin'), dir('Maps', 'Tools', base))
  move(path.join(data, 'geofabrik-index.json'), path.join(dir('Maps', 'Cache', base), 'geofabrik-index.json'))
  move(path.join(home, 'Tetra-backups'), dir('Backups', 'Data', base))
  return { moved, failed }
}

/** The start's cleaner: every app's Temp emptied (main.js, before any job can start). Data, Tools and Cache are not touched. */
function cleanTemp(base = root()) {
  for (const app of APPS) fs.rmSync(dir(app, 'Temp', base), { recursive: true, force: true })
}

module.exports = { NAME, APPS, KINDS, root, dir, migrate, cleanTemp }
