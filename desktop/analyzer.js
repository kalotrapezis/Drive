'use strict'
// The library's heavy work on its own thread: scanning the Photos folder (hashing, EXIF, thumbnails, HEIC decoding
// in WASM, place names) and local analysis (People, Documents). It used to run on the app's main thread, and every
// decode, face grouping and database write between two model runs held that thread — the window could not even be
// moved while it read a library. Here it can take as long as it likes: it runs at low priority, the models use half
// the cores, and the app only hears how far it has got. It shares the library database (WAL) with the app.
const path = require('node:path')
const library = require('./library')
const faces = require('./faces')
const docs = require('./documents')
const places = require('./places')


// A worker thread of the app's own process, not a separate process: sharp segfaults on every image in an Electron
// utility process and under ELECTRON_RUN_AS_NODE (checked 2026-09-24), and works here, where it always has.
const { parentPort: port } = require('node:worker_threads')
let db, people, documents, photosRoot, modelDir, dataDir
const engines = {}
const analysis = { running: false, paused: false, done: 0, total: 0, error: '' }
const send = () => port.postMessage({ type: 'progress', analysis: { ...analysis } })
const { isScreenshot } = library

/** `rescan` — 'faces' or 'documents' — reads photos that were read before, because the rules changed since. */
async function run({ rescan, wantFaces, wantDocs }) {
  if (analysis.running) return
  Object.assign(analysis, { running: true, paused: false, done: 0, error: '' })
  try {
    const todo = new Map()
    if (wantFaces) for (const r of people.pending(rescan === 'faces')) todo.set(r.sha256, { ...r, faces: true })
    if (wantDocs) for (const r of documents.pending(rescan === 'documents')) todo.set(r.sha256, { ...(todo.get(r.sha256) ?? r), docs: true })
    if (wantFaces) engines.faces ??= await faces.FaceEngine.load(modelDir)
    if (wantDocs) engines.docs ??= await docs.DocEngine.load(modelDir)
    if (wantDocs) engines.scene ??= await docs.SceneEngine.load(modelDir)
    analysis.total = todo.size
    send()
    for (const job of todo.values()) {
      if (analysis.paused) break
      if (isScreenshot(job.path)) { // screenshots have their own collection; the phone skips faces there too
        if (job.faces) people.skip(job.sha256)
        if (job.docs) documents.record(job.sha256, 0)
      } else {
        let img = null
        try { img = await faces.FaceEngine.decode(path.join(photosRoot, job.path)) } catch {}
        if (job.faces) {
          try {
            if (!img) throw new Error('unreadable')
            const found = await engines.faces.analyze(img)
            const ids = people.record(job.sha256, found, img)
            for (const [i, id] of ids.entries()) await people.saveCrop(img, id, found[i].box).catch(() => {})
          } catch { people.skip(job.sha256) } // unreadable image: analysed as "no faces", like a failed decode on the phone
        }
        if (job.docs) {
          // Phone: one classification pass gives the document score and the search labels.
          const row = img && db.prepare('SELECT MAX(taken_at) t FROM media WHERE sha256 = ?').get(job.sha256)
          const labels = img ? [...await engines.scene.classify(img).catch(() => []), docs.likelyTimeOfDay(row.t, docs.averageLuminance(img))].filter(Boolean) : []
          if (db.prepare('SELECT 1 FROM faces WHERE sha256 = ? AND deleted = 0').get(job.sha256)) labels.push('Portrait')
          documents.record(job.sha256, img ? (await engines.docs.classify(img).catch(() => ({ confidence: 0 }))).confidence : 0, labels)
        }
      }
      analysis.done++
      if (analysis.done % 5 === 0 || analysis.done === analysis.total) send()
    }
  } catch (e) { analysis.error = String(e.message ?? e) }
  analysis.running = false
  send()
  port.postMessage({ type: 'finished' })
}

port.on('message', data => {
  if (data.type === 'init') {
    ({ photosRoot, modelDir, dataDir } = data)
    db = library.open(dataDir)
    people = new faces.People(db, dataDir)
    documents = new docs.Documents(db)
  } else if (data.type === 'scan') {
    library.scan(db, photosRoot, dataDir, (done, changed) => port.postMessage({ type: 'scan-progress', done, changed }))
      .then(r => { places.fill(db); port.postMessage({ type: 'scanned', result: r }) },
        e => port.postMessage({ type: 'scanned', error: String(e.message ?? e) }))
  } else if (data.type === 'start') run(data)
  else if (data.type === 'pause') analysis.paused = true
})
