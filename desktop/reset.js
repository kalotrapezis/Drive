// Settings › Reset (the user, 26 Oct): server or client is chosen at the first start, and only a reset changes it —
// after a forced backup, or two acknowledgements of deleting the whole Tetra folder, the second actionable only after
// 10 seconds. The window shows the wait; main.js keeps the time it was armed and refuses an earlier delete as well.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const WAIT_MS = 10_000

/** The second acknowledgement counts only once 10 s have passed since it was shown (armed). */
const mayDelete = (armedAt, now = Date.now()) => Number.isFinite(armedAt) && armedAt > 0 && now - armedAt >= WAIT_MS

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

/** Every regular file under `dir`, relative path → size. Links are not followed (cp copies them as links). */
async function sizes(dir, rel = '', out = new Map()) {
  let entries
  try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return out; throw e }
  for (const e of entries) {
    const child = path.join(rel, e.name)
    if (e.isDirectory()) await sizes(dir, child, out)
    else if (e.isFile()) out.set(child, (await fsp.stat(path.join(dir, child))).size)
  }
  return out
}

/** How much a reset deletes: { files, bytes }. */
async function measure(paths) {
  let files = 0, bytes = 0
  for (const p of paths) for (const size of (await sizes(p)).values()) { files++; bytes += size }
  return { files, bytes }
}

/**
 * Copies each source folder into a new "Tetra backup <date>" folder in `dest`, then checks every file arrived whole
 * (its size). Throws before anything is copied when the room is not there or the backup would land in what a reset
 * deletes. { to, files, bytes }.
 * shortcut: files are compared by size, not hashed again — a full re-read doubles a big library's time; hash if a backup is ever found wrong.
 */
async function backUp(sources, dest, now = new Date()) {
  for (const s of sources) if (inside(path.resolve(dest), path.resolve(s.from))) throw new Error('The backup cannot go inside the Tetra folder it is backing up.')
  const { bytes } = await measure(sources.map(s => s.from))
  const room = await fsp.statfs(dest).then(f => f.bavail * f.bsize, () => Infinity)
  if (room < bytes) throw Object.assign(new Error('Not enough room there.'), { code: 'ENOSPC', bytes, room })
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
  const to = path.join(dest, `Tetra backup ${stamp}`)
  await fsp.mkdir(to) // fails if it is already there: never into an older backup
  let files = 0
  for (const s of sources) {
    if (!fs.existsSync(s.from)) continue
    const target = path.join(to, s.name)
    await fsp.cp(s.from, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
    const want = await sizes(s.from), got = await sizes(target)
    for (const [rel, size] of want) if (got.get(rel) !== size) throw new Error(`Not backed up whole: ${path.join(s.name, rel)}`)
    files += want.size
  }
  return { to, files, bytes }
}

/** Deletes the Tetra folder and the app's data. Never the home folder, a folder above it, or the root. */
function wipe(paths, home = os.homedir()) {
  for (const p of paths) {
    const full = path.resolve(p)
    if (full === path.parse(full).root || inside(home, full)) throw new Error(`Refusing to delete ${full}.`)
  }
  for (const p of paths) fs.rmSync(p, { recursive: true, force: true })
}

module.exports = { WAIT_MS, mayDelete, measure, backUp, wipe }
