'use strict'
// Contacts ↔ Photos' people: one link (the user, 24 Oct: "face and name sync"). A contact's X-TETRA-PERSON is a person's
// uuid (the same on every device, SYNC_PLAN 6m/6y); its X-TETRA-FACE says which face its portrait shows ("<the photo's
// SHA-256>;left,top,right,bottom", fractions of the upright photo). Both travel in the contact's file, so this computer —
// which always keeps a face catalog — makes the two agree, whichever device made the change and whether or not the phone
// detects faces itself:
//   · a portrait picked on the phone from an ordinary photo: the face found on this computer's copy of that photo goes to
//     that person (made with the contact's name if new; or, when the face is already a named person, the contact links to
//     them), and becomes the person's portrait;
//   · names: "Person 12" always takes the contact's; otherwise the side changed last wins;
//   · portraits: the contact's chosen face becomes the person's cover; a cover chosen in Photos afterwards becomes the
//     contact's photo.
// Photos' changes reach the phone through the faces' own sync, the contact's through Contacts' part.
const crypto = require('node:crypto')
const { isGeneratedName } = require('./faces')
const { nameOf } = require('./contacts')

const revMs = rev => Date.parse(rev) || 0
const round = n => Math.round(n * 10000) / 10000
/** "sha;l,t,r,b" → { sha, box } or null. */
function parseFace(v) {
  const m = /^([0-9a-f]{64});(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/i.exec(String(v || '').trim())
  return m ? { sha: m[1].toLowerCase(), box: [+m[2], +m[3], +m[4], +m[5]] } : null
}
const faceValue = (sha, box) => `${sha};${box.map(round).join(',')}`
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
/** How much of face box [a] lies inside the portrait's square [b]. */
const inside = (a, b) => area(a) ? area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]) / area(a) : 0
const boxOf = f => [f.box_left, f.box_top, f.box_right, f.box_bottom]

/**
 * One pass over the contacts: [facePhoto](faceId) → { photo, face } crops a face as a contact's photo (main.js). Answers
 * how many links it changed. Each step is a no-op once both sides agree, so it runs as often as anything changes.
 */
async function linkFaces({ db, people, contacts, facePhoto, now = Date.now }) {
  const row = id => id && db.prepare('SELECT id, name, updated_at, cover_face_id, deleted FROM people WHERE id = ?').get(id)
  const faceRow = id => id && db.prepare('SELECT id, sha256, box_left, box_top, box_right, box_bottom, person_id FROM faces WHERE id = ? AND deleted = 0').get(id)
  let changed = 0
  for (const c of contacts.all()) {
    let i = c.info
    if (!i.person && !i.face) continue
    const save = x => { contacts.save(i.uid, { ...i, ...x }); i = contacts.byUid(i.uid).info; changed++ }
    const name = nameOf(i)
    let pid = i.person ? people.resolve(i.person) : null
    let p = row(pid)
    if (p?.deleted) p = null
    const f = parseFace(i.face)
    // 1. the portrait's face, found on this computer's copy of the photo (nothing to do until the photo is here and analysed)
    if (f && !(p && db.prepare('SELECT 1 FROM faces WHERE person_id = ? AND sha256 = ? AND deleted = 0').get(pid, f.sha))) {
      const face = db.prepare('SELECT id, person_id, box_left, box_top, box_right, box_bottom FROM faces WHERE sha256 = ? AND deleted = 0').all(f.sha)
        .filter(x => inside(boxOf(x), f.box) >= 0.6).sort((a, b) => area(boxOf(b)) - area(boxOf(a)))[0]
      if (face) {
        const theirs = face.person_id && row(people.resolve(face.person_id))
        if (theirs && !theirs.deleted) {
          pid = theirs.id; p = theirs // the face is already someone in Photos (named, or "Person 12" with their other photos): the contact is them
        } else {
          if (!p) { pid = pid || crypto.randomUUID(); people.applyPerson(pid, name || 'Contact', now(), face.id); p = row(pid) }
          db.prepare('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?').run(pid, now(), face.id); changed++
        }
        if (i.person !== pid) save({ person: pid })
        if (p.cover_face_id !== face.id) { people.setCover(pid, face.id); p = row(pid); changed++ }
      }
    }
    if (!p) continue
    // 2. names: "Person 12" takes the contact's; otherwise the side changed last
    if (name && p.name !== name) {
      if (isGeneratedName(p.name) || revMs(i.rev) >= p.updated_at) { people.rename(pid, name); p = row(pid); changed++ }
      else { save({ formatted: p.name }) ; continue }
    }
    // 3. portraits: the contact's face is the person's cover; a cover chosen in Photos since becomes the contact's photo
    const cover = faceRow(p.cover_face_id)
    const mine = f && db.prepare('SELECT id, box_left, box_top, box_right, box_bottom FROM faces WHERE person_id = ? AND sha256 = ? AND deleted = 0').all(pid, f.sha)
      .sort((a, b) => inside(boxOf(b), f.box) - inside(boxOf(a), f.box))[0]
    if (mine && cover?.id !== mine.id) {
      if (revMs(i.rev) >= p.updated_at || !cover) { people.setCover(pid, mine.id); changed++ }
      else if (facePhoto) { const got = await facePhoto(cover.id).catch(() => null); if (got) save({ photo: got.photo, photoUrl: null, face: got.face }) }
    } else if (!f && cover && facePhoto && p.updated_at > revMs(i.rev)) {
      const got = await facePhoto(cover.id).catch(() => null) // linked on the phone from Photos (no X-TETRA-FACE): the cover as it is now
      if (got) save({ photo: got.photo, photoUrl: null, face: got.face })
    }
  }
  return changed
}

module.exports = { linkFaces, parseFace, faceValue }
