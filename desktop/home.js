'use strict'
/**
 * Where Tetra keeps your things: ~/Tetra/Photos and ~/Tetra/Files. Until 2026-09-24 it was ~/Drive/Photos and
 * ~/Drive/Drive, named after the app's old name; this moves them, once, without copying a byte.
 *
 * Only renames: on one disk that is instant, needs no free space (the disk was 94 % full when this was written)
 * and either happens or does not. Nothing in the database changes, because every path it stores is relative to
 * these folders. It only moves a ~/Drive that holds nothing but Tetra's own Photos and Drive, and only when
 * ~/Tetra does not exist yet; anything else is left exactly where it is, and the old folders keep being used.
 */
const fs = require('node:fs')
const path = require('node:path')

function roots(home, { migrate = true } = {}) {
  const old = path.join(home, 'Drive'), root = path.join(home, 'Tetra')
  const moved = []
  let note = null
  if (migrate && !fs.existsSync(root) && fs.existsSync(old)) {
    const inside = fs.readdirSync(old).filter(n => !n.startsWith('.'))
    if (inside.every(n => n === 'Photos' || n === 'Drive')) { fs.renameSync(old, root); moved.push(`${old} → ${root}`) }
    else note = `~/Drive also holds ${inside.filter(n => n !== 'Photos' && n !== 'Drive').join(', ')}, so it was left where it is.`
  }
  // The second step on its own too, so an interrupted move finishes on the next start.
  if (migrate && fs.existsSync(path.join(root, 'Drive')) && !fs.existsSync(path.join(root, 'Files'))) {
    fs.renameSync(path.join(root, 'Drive'), path.join(root, 'Files')); moved.push(`${path.join(root, 'Drive')} → ${path.join(root, 'Files')}`)
  }
  const useOld = !fs.existsSync(root) && fs.existsSync(old)
  return {
    root: useOld ? old : root,
    photos: useOld ? path.join(old, 'Photos') : path.join(root, 'Photos'),
    files: useOld ? path.join(old, 'Drive') : path.join(root, 'Files'),
    moved, note,
  }
}

/**
 * The folder wears the app's icon: a .directory file for KDE's Dolphin, and GNOME's custom-icon attribute where
 * `gio` exists. The icon is copied next to the database, because the app's own copy may be inside a package.
 */
function markFolder(root, iconSource, dataDir) {
  try {
    const icon = path.join(dataDir, 'tetra-folder.png')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.copyFileSync(iconSource, icon)
    const dotDirectory = path.join(root, '.directory')
    const ours = !fs.existsSync(dotDirectory) || fs.readFileSync(dotDirectory, 'utf8').includes('tetra-folder.png')
    if (ours) fs.writeFileSync(dotDirectory, `[Desktop Entry]\nIcon=${icon}\n`)
    require('node:child_process').execFile('gio', ['set', root, 'metadata::custom-icon', 'file://' + icon], () => {})
  } catch {}
}

module.exports = { roots, markFolder }
