const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const library = require('../library')
const history = require('../history')
const { Files } = require('../files')
const { Purgatory } = require('../purgatory')

const DAY = 86_400_000

test('Trash → purgatory after its days, purgatory → gone after its own, never before, all in the history', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-purgatory-'))
  const xdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(tmp, 'share') // the system Trash, but a disposable one
  try {
    const photos = path.join(tmp, 'Photos'), mount = path.join(tmp, 'T7')
    fs.mkdirSync(photos, { recursive: true }); fs.mkdirSync(mount)
    const db = library.open(path.join(tmp, 'data'))
    const files = new Files(db, path.join(tmp, 'Files'))
    const purgatory = new Purgatory({ db, photosRoot: photos, files })

    // A photo trashed 40 days ago and one trashed today, as the freedesktop Trash records them.
    const trash = path.join(tmp, 'share', 'Trash')
    fs.mkdirSync(path.join(trash, 'files'), { recursive: true }); fs.mkdirSync(path.join(trash, 'info'))
    const put = (id, name, when) => {
      fs.writeFileSync(path.join(trash, 'files', id), 'bytes of ' + name)
      fs.writeFileSync(path.join(trash, 'info', id + '.trashinfo'),
        `[Trash Info]\nPath=${path.join(photos, 'DCIM', name)}\nDeletionDate=${new Date(when).toISOString().slice(0, 19)}\n`)
    }
    const now = Date.now()
    put('old.jpg', 'old.jpg', now - 40 * DAY)
    put('new.jpg', 'new.jpg', now - 1 * DAY)
    // A Files item in Files/Trash/, a whole folder of it.
    fs.mkdirSync(path.join(tmp, 'Files', 'Trash', 'Taxes'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'Files', 'Trash', 'Taxes', '2019.pdf'), 'tax')

    // The Files item was trashed just now, so seen from 40 days on it is past its days too.
    const r = await purgatory.sweep('t7', mount, now + 40 * DAY - 39 * DAY)
    assert.deepEqual(r.failed, [])
    assert.equal(r.entered, 1, 'only the photo past its 30 days, not the fresh one or the new Files item')
    assert.ok(!fs.existsSync(path.join(trash, 'files', 'old.jpg')) && !fs.existsSync(path.join(trash, 'info', 'old.jpg.trashinfo')))
    assert.ok(fs.existsSync(path.join(trash, 'files', 'new.jpg')), 'a fresh item stays in the Trash')
    const day = new Date(now + DAY).toISOString().slice(0, 10)
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', '.purgatory', 'photos', day, 'DCIM', 'old.jpg'), 'utf8'), 'bytes of old.jpg')

    const later = now + 30 * DAY + 3_600_000
    const r2 = await purgatory.sweep('t7', mount, later)
    assert.equal(r2.entered, 2, 'the rest, once their days are up: new.jpg and the folder')
    assert.equal(r2.purged, 0, 'the first one has been in the purgatory 29 days, not 30')
    assert.equal(fs.readFileSync(path.join(mount, 'Tetra', '.purgatory', 'files', new Date(later).toISOString().slice(0, 10), 'Taxes', '2019.pdf'), 'utf8'), 'tax')

    // Purgatory keeps its 30 days, then deletes; 0 means never.
    assert.equal((await purgatory.sweep('t7', mount, now + 32 * DAY)).purged, 1, 'the first one, 31 days after it entered')
    assert.ok(!fs.existsSync(path.join(mount, 'Tetra', '.purgatory', 'photos', day, 'DCIM', 'old.jpg')))
    purgatory.setSettings({ purgatoryDays: 0 })
    assert.equal((await purgatory.sweep('t7', mount, now + 999 * DAY)).purged, 0, 'never')
    assert.equal(purgatory.summary()[0].items, 2)

    const actions = history.list(db).map(h => h.action)
    assert.deepEqual(actions.filter(a => a === 'to purgatory').length, 3)
    assert.ok(actions.includes('deleted from purgatory'))
    db.close()
  } finally {
    if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
