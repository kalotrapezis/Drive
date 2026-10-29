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
 *   .System/<App>/Shared  the user's things the app keeps for them and their devices share: never cleaned
 *
 * Files and Photos hold only the user's own files (the user, 29 Oct 2026: "Make Tetra process everything from the system
 * folder; Files and Photos to be userspace only"). Sync still names an app's files as it always did ("Calendar/…",
 * "Trash/…"): SHARED says which .System/<App>/Shared each of those names lives in, so every version reads the others.
 *
 * The names are fixed now so they never change; a folder is made only when something writes into it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NAME = '.System'
const APPS = ['Photos', 'Files', 'Notes', 'Calendar', 'Timer', 'Contacts', 'Phone', 'Maps', 'Office', 'Sync', 'Backups', 'Data', 'Trash']
const KINDS = ['Data', 'Tools', 'Cache', 'Temp', 'Shared']
/**
 * The folders of Files that were Tetra's own until 29 Oct 2026 → the app whose Shared holds them now. Their name stays
 * the name sync uses, so a device on an older version sends and gets the same paths (SYSTEM.md, "Sync"). Android's
 * TetraSystem.SHARED is the same list.
 */
const SHARED = { Calendar: 'Calendar', Contacts: 'Contacts', Data: 'Data', Phone: 'Phone', Timer: 'Timer', Maps: 'Maps', Trash: 'Trash' }

/** ~/Tetra/.System, always beside ~/Tetra/Photos and ~/Tetra/Files. */
const root = (home = os.homedir()) => path.join(home, 'Tetra', NAME)

/** The .System beside a Files folder: ~/Tetra/Files → ~/Tetra/.System. */
const beside = files => path.join(path.dirname(files), NAME)

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

/** Moves [from] to [to] by renaming; into a folder already there, each thing in it on its own, so a half-done move finishes. */
function moveInto(from, to, moved, failed) {
  let st
  try { st = fs.lstatSync(from) } catch { return }
  let there = null
  try { there = fs.lstatSync(to) } catch {}
  if (!there) {
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); moved.push(`${from} → ${to}`) }
    catch (e) { failed.push(`${from} → ${to}: ${e.message}`) }
    return
  }
  if (!st.isDirectory() || !there.isDirectory()) { failed.push(`${from}: ${to} is there already, so it was left`); return }
  for (const n of fs.readdirSync(from)) moveInto(path.join(from, n), path.join(to, n), moved, failed)
  try { fs.rmdirSync(from) } catch {} // only an emptied folder goes; one still holding something stays
}

/**
 * Once, at the first start of a version from 29 Oct 2026: Tetra's own folders of Files into .System, by renaming (one
 * disk), every file keeping its name, so sync sees nothing change. Files/Calendar → Calendar/Shared and the rest of
 * SHARED, Files/.notes → Notes/Shared. A file already at the target is left, both kept, and said; run again, it
 * finishes what an interruption left. { moved, failed }.
 */
function migrateFiles(files, base = beside(files)) {
  const moved = [], failed = []
  for (const [name, app] of Object.entries(SHARED)) moveInto(path.join(files, name), dir(app, 'Shared', base), moved, failed)
  moveInto(path.join(files, '.notes'), dir('Notes', 'Shared', base), moved, failed)
  return { moved, failed }
}

/** Whether two files hold the same bytes. */
function same(a, b) {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false
  const fa = fs.openSync(a, 'r'), fb = fs.openSync(b, 'r'), x = Buffer.alloc(1 << 20), y = Buffer.alloc(1 << 20)
  try {
    for (;;) {
      const n = fs.readSync(fa, x), m = fs.readSync(fb, y)
      if (n !== m || !x.subarray(0, n).equals(y.subarray(0, m))) return false
      if (n === 0) return true
    }
  } finally { fs.closeSync(fa); fs.closeSync(fb) }
}

/**
 * Once: sync's leftover copies, "name (2).ext" beside "name.ext" (made before the fix of 29 Oct 2026). One holding the
 * same bytes as the file beside it moves to Backups/Data/Sync copies/<date>/, under the path sync knows it by; one that
 * differs, or has no original, stays where it is and is listed in `left` for the person. Nothing is deleted.
 * `dryRun`: only says what it would do. { moved, left, failed } as sync paths.
 */
function setAsideCopies(files, base = beside(files), { now = new Date(), dryRun = false } = {}) {
  const out = { moved: [], left: [], failed: [] }
  const to = path.join(dir('Backups', 'Data', base), 'Sync copies', now.toISOString().slice(0, 10))
  const walk = (disk, rel, top) => {
    let entries
    try { entries = fs.readdirSync(disk, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink() || (top && SHARED[e.name])) continue
      const full = path.join(disk, e.name), r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(full, r, false); continue }
      const m = /^(.+) \(\d+\)(\.[^.]+)?$/.exec(e.name)
      if (!m || !e.isFile()) continue
      const original = path.join(disk, m[1] + (m[2] ?? ''))
      let dup = false
      try { dup = fs.statSync(original).isFile() && same(full, original) } catch {}
      if (!dup) { out.left.push(r); continue }
      if (dryRun) { out.moved.push(r); continue }
      moveInto(full, path.join(to, ...r.split('/')), [], out.failed)
      if (!fs.existsSync(full)) out.moved.push(r)
    }
  }
  walk(files, '', true)
  // not the Trash: its "(2)"s are its own, a name already there when something was deleted
  for (const [name, app] of Object.entries(SHARED)) if (name !== 'Trash') walk(dir(app, 'Shared', base), name, false)
  if (!dryRun && (out.moved.length || out.left.length)) try {
    fs.mkdirSync(to, { recursive: true })
    fs.writeFileSync(path.join(to, 'List.txt'), `Moved here (the same bytes as the file beside them):\n${out.moved.join('\n')}\n\n` +
      `Left where they are (they differ from the file beside them, or it is not there):\n${out.left.join('\n')}\n`)
  } catch (e) { out.failed.push(`List.txt: ${e.message}`) }
  return out
}

/** The start's cleaner: every app's Temp emptied (main.js, before any job can start). Data, Tools and Cache are not touched. */
function cleanTemp(base = root()) {
  for (const app of APPS) fs.rmSync(dir(app, 'Temp', base), { recursive: true, force: true })
}

module.exports = { NAME, APPS, KINDS, SHARED, root, beside, dir, migrate, migrateFiles, setAsideCopies, cleanTemp }
