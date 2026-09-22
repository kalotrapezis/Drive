const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const exifr = require('exifr')
const editor = require('../editor')

test('save copy keeps date, camera and location without re-encoding; replace trashes the original first', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-edit-'))
  const original = path.join(tmp, 'IMG_1.jpg')
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } }).jpeg()
    .withMetadata({ exif: { IFD0: { Make: 'Xiaomi', Model: '15' }, IFD2: { DateTimeOriginal: '2025:10:26 12:30:00' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 2/1 5430/100', GPSLongitudeRef: 'E', GPSLongitude: '24/1 11/1 700/100' } } }).toFile(original)
  const old = new Date('2025-10-26T12:30:00')
  fs.utimesSync(original, old, old)
  const edited = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00f' } }).jpeg().toBuffer()

  const copy = await editor.saveCopy(original, edited, old.getTime())
  assert.equal(path.basename(copy), 'IMG_1_edited.jpg')
  assert.equal(path.basename(await editor.saveCopy(original, edited, old.getTime())), 'IMG_1_edited (2).jpg')
  const x = await exifr.parse(copy, { gps: true })
  assert.equal(x.Make, 'Xiaomi'); assert.equal(x.Model, '15')
  assert.equal(x.DateTimeOriginal.getTime(), old.getTime())
  assert.ok(Math.abs(x.latitude - 41.0484) < 1e-3 && Math.abs(x.longitude - 24.1853) < 1e-3)
  assert.equal(fs.statSync(copy).mtimeMs, old.getTime())
  const { data } = await sharp(copy).raw().toBuffer({ resolveWithObject: true })
  const { data: expected } = await sharp(edited).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual(data, expected) // pixels identical: EXIF was spliced in, not re-encoded
  await assert.rejects(editor.saveCopy(original, Buffer.from('not a jpeg'), 0), /valid JPEG/)

  const trashed = []
  const out = await editor.replace(original, edited, old.getTime(), async f => { trashed.push(f); fs.renameSync(f, path.join(tmp, 'trash.jpg')) })
  assert.deepEqual(trashed, [original])
  assert.equal(out, original)
  assert.equal((await sharp(original).metadata()).width, 20)
  assert.equal((await sharp(path.join(tmp, 'trash.jpg')).metadata()).width, 40) // the original is recoverable
  fs.rmSync(tmp, { recursive: true })
})
