'use strict'
/**
 * The history: what went where, when, and for which device (asked 2026-09-25 — "a manifest of what goes and
 * what comes"). Sync rules are only safe if what they did can be read back, deletions above all. Rows are only
 * ever added; nothing here is edited.
 */
const ensured = new WeakSet()
function ensure(db) {
  if (ensured.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, device TEXT, action TEXT NOT NULL,
    kind TEXT, name TEXT, sha256 TEXT, size INTEGER, detail TEXT);
    CREATE INDEX IF NOT EXISTS history_at ON history(at DESC);`)
  ensured.add(db)
}

/** `device` is a sync_devices id, or null for this computer. Never throws: a history that fails must not stop a sync. */
function record(db, { action, kind = null, name = null, sha256 = null, size = null, device = null, detail = null, at = Date.now() }) {
  try {
    ensure(db)
    db.prepare('INSERT INTO history(at, device, action, kind, name, sha256, size, detail) VALUES(?,?,?,?,?,?,?,?)')
      .run(at, device, action, kind, name, sha256, size, detail)
  } catch (e) { console.warn('[history]', e.message) }
}

/** Newest first, with the device's name. */
function list(db, { limit = 300, before = null } = {}) {
  ensure(db)
  const devices = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_devices'").get()
  const who = devices ? '(SELECT d.name FROM sync_devices d WHERE d.id = h.device)' : 'NULL'
  return db.prepare(`SELECT h.*, ${who} AS deviceName FROM history h ${before ? 'WHERE h.at < ?' : ''} ORDER BY h.at DESC, h.id DESC LIMIT ?`)
    .all(...(before ? [before, limit] : [limit]))
}

module.exports = { record, list }
