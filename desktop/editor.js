// Saving edited photos (the drawing happens in the renderer). Phone rules: "Save copy" writes
// <name>_edited.jpg beside the original with its date, camera and location; "Save" replaces the
// original only after the user confirms — here the original goes to the system Trash first.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_BYTES = 200 * 1024 * 1024

const dms = v => { // decimal degrees → EXIF rational "d/1 m/1 s*100/100"
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 6000)
  return `${d}/1 ${m}/1 ${s}/100`
}
const exifDate = d => `${d.getFullYear()}:${String(d.getMonth() + 1).padStart(2, '0')}:${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`

/**
 * Adds the original's date, camera and GPS to an already encoded JPEG without re-encoding it:
 * sharp builds an EXIF block on a 1×1 image, and that APP1 segment is spliced in after SOI.
 */
async function withOriginalExif(jpeg, originalPath, takenAt) {
  const exifr = require('exifr'), sharp = require('sharp')
  const x = await exifr.parse(originalPath, { gps: true, pick: ['Make', 'Model', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'] }).catch(() => null) ?? {}
  const exif = { IFD0: {}, IFD2: { DateTimeOriginal: exifDate(new Date(takenAt)) } }
  if (x.Make) exif.IFD0.Make = String(x.Make)
  if (x.Model) exif.IFD0.Model = String(x.Model)
  if (Number.isFinite(x.latitude) && Number.isFinite(x.longitude) && (x.latitude || x.longitude)) {
    exif.IFD3 = { GPSLatitudeRef: x.latitude < 0 ? 'S' : 'N', GPSLatitude: dms(x.latitude), GPSLongitudeRef: x.longitude < 0 ? 'W' : 'E', GPSLongitude: dms(x.longitude) }
  }
  const carrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).jpeg().withExif(exif).toBuffer()
  let at = 2, app1 = null
  while (at < carrier.length && carrier[at] === 0xff) {
    const marker = carrier[at + 1], len = carrier.readUInt16BE(at + 2)
    if (marker === 0xe1) { app1 = carrier.subarray(at, at + 2 + len); break }
    at += 2 + len
  }
  if (!app1) return jpeg
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

function checkJpeg(bytes) {
  const b = Buffer.from(bytes)
  if (b.length < 4 || b.length > MAX_BYTES || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('The edited image is not a valid JPEG.')
  return b
}

/** Beside the original, never overwriting: name_edited.jpg, name_edited (2).jpg, … */
async function saveCopy(originalPath, bytes, takenAt) {
  const st = await fsp.stat(originalPath)
  const base = path.join(path.dirname(originalPath), path.parse(originalPath).name + '_edited')
  let target = base + '.jpg'
  for (let n = 2; fs.existsSync(target); n++) target = `${base} (${n}).jpg`
  await fsp.writeFile(target, await withOriginalExif(checkJpeg(bytes), originalPath, takenAt), { flag: 'wx' })
  await fsp.utimes(target, st.atime, st.mtime) // same date as the original, like the phone
  return target
}

/** Original → system Trash (recoverable), then the edit takes its place as a JPEG. */
async function replace(originalPath, bytes, takenAt, trashItem) {
  const jpeg = await withOriginalExif(checkJpeg(bytes), originalPath, takenAt) // fully built before the original is touched
  const st = await fsp.stat(originalPath)
  const target = path.join(path.dirname(originalPath), path.parse(originalPath).name + '.jpg')
  if (target !== originalPath && fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists; use Save as copy.`)
  await trashItem(originalPath)
  await fsp.writeFile(target, jpeg, { flag: 'wx' })
  await fsp.utimes(target, st.atime, st.mtime)
  return target
}

module.exports = { withOriginalExif, saveCopy, replace, dms }
