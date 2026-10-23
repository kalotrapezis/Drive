// Files' thumbnails (the user, 23 Oct: "thumbnails in Files in the desktop and phone … for documents the SVGs you have
// at the homescreen as overlay at the center"): a picture or a video its own, a PDF and a Words/Tables/Slides document
// its first page. Made once into the app's data folder (never into Files, so sync never carries them), named by the
// file's path, size and time, so a changed file gets a new one. The renderer draws Office's glyph over a document's.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const SIZE = 384 // px, the longer side
const KINDS = {
  picture: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp', 'avif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'mkv', 'avi', 'webm', '3gp', 'm4v'],
  pdf: ['pdf'],
  words: ['doc', 'docx', 'odt', 'rtf'],
  tables: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv'],
  slides: ['ppt', 'pptx', 'ppsx', 'odp'],
}
/** Which thumbnail a file has, by its extension; null: none (its icon). */
function kind(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  for (const [k, list] of Object.entries(KINDS)) if (list.includes(ext)) return k
  return null
}
/** The cache's name for a file as it is now: another path, size or time is another thumbnail. */
const key = (full, size, mtimeMs) => crypto.createHash('sha1').update(`${full}|${size}|${Math.trunc(mtimeMs)}`).digest('hex')

const run = (cmd, args, options = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 60_000, ...options }, (err, out) => err ? reject(err) : resolve(out)))
/** At most [n] at once, the rest wait their turn: a folder of videos must not start a hundred ffmpegs. */
function limit(n) {
  let active = 0
  const waiting = []
  return async fn => {
    if (active >= n) await new Promise(r => waiting.push(r))
    active++
    try { return await fn() } finally { active--; waiting.shift()?.() }
  }
}

class Thumbs {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'file-thumbs')
    fs.mkdirSync(this.dir, { recursive: true })
    this.busy = new Map() // a thumbnail being made, asked for again meanwhile
    this.quick = limit(3)
    this.office = limit(1) // one LibreOffice at a time: its profile is not shared
    setTimeout(() => trim(this.dir, 4000).catch(() => {}), 10_000).unref()
  }

  /** The thumbnail's file for [full] (an absolute path already checked to be in Files), made now if needed; null when it has none. */
  async get(full) {
    const k = kind(full)
    if (!k) return null
    const st = await fsp.stat(full)
    const id = key(full, st.size, st.mtimeMs)
    const target = path.join(this.dir, id + '.webp')
    if (fs.existsSync(target)) return target
    if (fs.existsSync(path.join(this.dir, id + '.none'))) return null // could not be drawn: not tried again until it changes
    if (!this.busy.has(id)) this.busy.set(id, (k === 'words' || k === 'tables' || k === 'slides' ? this.office : this.quick)(() => this.make(k, full, target))
      .then(() => target, () => fsp.writeFile(path.join(this.dir, id + '.none'), '').then(() => null, () => null))
      .finally(() => this.busy.delete(id)))
    return this.busy.get(id)
  }

  async make(k, full, target) {
    const sharp = require('sharp')
    let source
    if (k === 'picture') source = await require('./library').image(full)
    else if (k === 'video') {
      // a second in, past a fade from black; a shorter clip its first frame
      for (const at of ['1', '0']) {
        const png = await run('ffmpeg', ['-v', 'error', '-ss', at, '-i', full, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']).catch(() => null)
        if (png?.length) { source = sharp(png); break }
      }
    } else if (k === 'pdf') source = sharp(await run('pdftoppm', ['-f', '1', '-l', '1', '-scale-to', String(SIZE * 2), '-png', '-singlefile', full]))
    else source = sharp(await this.firstPage(full))
    if (!source) throw new Error('no picture')
    // Written aside and renamed: a crash mid-write must not leave a half thumbnail that looks finished.
    await source.resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).webp({ quality: 78 }).toFile(target + '.part')
    await fsp.rename(target + '.part', target)
  }

  /** A document's first page (a sheet's, a deck's first slide) as LibreOffice draws it, as a PNG. */
  // shortcut: needs LibreOffice installed (soffice); without it a document shows its glyph on a blank page.
  async firstPage(full) {
    const out = await fsp.mkdtemp(path.join(this.dir, 'office-'))
    try {
      await run('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${path.join(this.dir, 'libreoffice-profile')}`,
        '--convert-to', 'png', '--outdir', out, full])
      const png = (await fsp.readdir(out)).find(f => f.endsWith('.png'))
      if (!png) throw new Error('LibreOffice made no page')
      return await fsp.readFile(path.join(out, png))
    } finally { await fsp.rm(out, { recursive: true, force: true }) }
  }
}

/** The oldest thumbnails beyond [keep] go (those of files changed or gone are never asked for again). */
async function trim(dir, keep) {
  const files = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => path.join(dir, e.name))
  if (files.length <= keep) return
  const times = await Promise.all(files.map(async f => [f, (await fsp.stat(f)).mtimeMs]))
  for (const [f] of times.sort((a, b) => b[1] - a[1]).slice(keep)) await fsp.rm(f, { force: true })
}

module.exports = { Thumbs, kind, key, trim }
