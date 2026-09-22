# Local Drive — desktop app and phone ↔ desktop sync plan

Updated: 2026-09-23 (phases 0–6 done). The same file lives in both `Drive-Android/` and `Drive/`.
Edit one, copy it to the other.

Goal: a personal Google Photos + Google Drive. The phone and the desktop have
the **same features and the same data model**, and later sync 1:1 (Copy or
Move) over Wi-Fi. Order: shared data model → desktop features → sync.

## Decisions

- **Desktop is a new, self-contained Electron app** in TypeScript, in
  `Drive/desktop/` on branch `electron-desktop`. No C++/Qt, no browser page,
  no local web server.
- The old C++/Qt + React code in `Drive/` stays untouched as a **reference** for
  safety rules and past tests. Its code is not carried over.
- Desktop library (existing layout): photos in `~/Drive/Photos/`, files in
  `~/Drive/Drive/` (like the phone's `/sdcard/Drive/`). Synced photos will land
  in `~/Drive/Photos/YYYY/MM/`. App data (database, thumbnails, encrypted
  vault) in `~/.local/share/local-drive-desktop/`.
- The desktop becomes the main library; the phone is its client. Metadata syncs
  both ways.
- Everything syncs, including **People** (hand-made groups and names) and
  **Hidden**. Nothing is dropped.
- Scanner and Codes stay phone-only (they need a camera).

## What exists now

### Phone (`Drive-Android`, branch `alpha`) — feature complete

Authoritative list: `FEATURES.md`. Summary:

| Module | Works |
|---|---|
| Photos | MediaStore timeline, pinch Week/Month/Year, viewer, filmstrip, zoom, details, default gallery, editor (crop/rotate/markup, save / save copy) |
| Collections | Favorites, My collections, Screenshots, Videos, Documents (local AI), Map, Hidden |
| People | ML Kit face detection → MobileFaceNet embeddings → automatic groups; rename, merge (with undo), Help organize reviews |
| Search | Name, path, AI labels, people names, cached place names |
| Hidden | Biometric lock; verified private copy, then Android removes the public original; Restore |
| Files | `/sdcard/Drive/` browser, search, tags, favorites, folder colours, copy/move/rename/share, Trash |
| Scanner, Codes | Phone only |
| Sync | Home card only ("no trusted paired device") |

Phone storage today:

| Data | Where | Key |
|---|---|---|
| Favorite, collections, AI record/labels, location/place, faces, people, reviews | `photo_metadata.db` (SQLite, v12) | `photo_key` |
| Hidden items | `hidden_vault.db` + `files/hidden_media/` | `photo_key`, has `sha256` |
| File tags, favorites, colours | SharedPreferences `drive_metadata` | Drive-relative path |
| Recents, openers, settings | SharedPreferences | path / none |

**Problem:** `photo_key = sha256(content URI + path + name + size)`
(`PhotoMetadataRules.stableKey`). The URI contains a MediaStore row id that only
exists on this phone, and **Save** after an edit changes the size, so the key
changes. Result: keys cannot be matched on another device, and an edited photo
likely loses its favorite/collections/faces today. People, collections and
faces use local integer ids. Face boxes are pixels. Hidden has no encryption of
its own (it relies on Android storage encryption + app-private folder).

### Old desktop (`Drive`, branch `codex/live-ui-audit`) — reference only

| Works | Kept as |
|---|---|
| Verified copy: copy → SHA-256 → receipt, no overwrite, `.part` files | Rules, rewritten in TypeScript |
| Move = copy + verify + separate cleanup to Trash | Rule |
| Phone preview/hashing over USB/MTP (KIO) | Dropped (Wi-Fi replaces it) |
| TLS wireless receiver with pinned client certificate, metadata deltas with sequence numbers | Ideas only (pinning, sequence/cursors) |
| React web UI (dashboard style) | Dropped; new UI mirrors the phone |
| Schedules, cache routes, capacity thresholds, acceptance matrices | Out of scope |

## Shared data model (both apps)

Both apps keep their own SQLite database with the same tables and keys.
Nothing ever copies a `.db` file between devices.

- **Photo id = SHA-256 of the file bytes** (lowercase hex). The phone caches
  the hash against `(MediaStore id, size, date_modified)` so it hashes each
  file once.
- **Every user-made thing gets a UUID:** person (`face_groups`), collection,
  face sample. Integer ids stay local.
- **Every record has `updated_at`** (epoch ms) and deletions are kept as
  tombstones (`deleted = 1`) so a removal can sync.
- **Face box** = `[left, top, right, bottom]` as fractions 0–1 of the image
  *after* EXIF rotation.
- **Embedding** = MobileFaceNet (`mobilefacenet.tflite`, landmark-aligned
  crop), float32 little-endian, stored with a `model` string. Both apps must use
  the same model and alignment, and the same thresholds: same person ≥ 0.74,
  review 0.66–0.74, unreliable faces join at ≥ 0.55.
- **Files** are identified by their `Drive/`-relative path; tags, favorites and
  colours stay keyed by path.

Per photo, the model carries: sha256, original relative path and name, mime,
size, taken date, favorite, hidden, collection UUIDs, AI type/labels and
`user_verified`, latitude/longitude/place name, faces (UUID, box, embedding,
person UUID, quality), pending reviews.

## Transfer design (phase 6)

1. **Pair by QR.** The desktop shows a QR code with its address, port, TLS
   certificate fingerprint and a one-time token. The phone scans it with Codes.
   Both remember each other; the phone pins the certificate.
2. **HTTPS, phone → desktop** (Node `https` on the desktop, the phone is the
   client):
   - `POST /have` — list of hashes → the desktop answers which are missing.
   - `PUT /blob/<sha256>` — streamed upload. The desktop writes a `.part`,
     hashes while writing, renames only if the hash matches, and returns a
     **receipt**. Otherwise it deletes the `.part` and reports failure.
   - `POST /metadata` — changed records since the last sync (JSON above).
   - `GET /metadata?since=<cursor>` — changes made on the desktop, for the
     phone.
3. **Conflicts:** newest `updated_at` wins per record. Merging people is sent
   as "face X → person Y" changes, so it works in both directions.
4. **Copy** keeps everything on the phone. **Move** deletes on the phone only
   after a receipt, through Android's own confirmation (Gallery) or directly
   (vault items).
5. **Hidden:** sent over the same TLS connection and encrypted on the desktop
   while streaming, so plaintext never touches the desktop disk. libsodium:
   passphrase → Argon2id key, files with `secretstream`. The desktop asks for
   the passphrase to open Hidden.
6. Never delete on either side because of a sync. Phone Trash does not delete
   desktop copies.

## Desktop stack

Electron + Vite + React + TypeScript, one process tree, packaged as AppImage /
deb. built-in `node:sqlite` (database, no native build), `sharp` (thumbnails), `exifr` (EXIF/GPS),
`onnxruntime-node` (MobileFaceNet converted to ONNX; YuNet or SCRFD for face
detection, since ML Kit is Android only), `maplibre-gl` (map),
`libsodium-wrappers` (vault). UI follows the phone's design: Photos and Files
first, sync as a small status indicator.

## Phases

Each phase ends with a working app and a short check. One phase per session or
more; do not start the next before the current one is done.

### 0. Phone: shared data model — first

**Status 2026-09-22: done (reduced on purpose).** Schema v13 adds a UUID to
every person, collection and face (existing rows only extended; merge undo
restores the same person UUID), and "Save" after an edit moves favorite,
collections and location to the photo's new key — the edit bug. Verified on the
real phone after a full backup (`Drive-Android-backups/2026-09-22/`): v13,
integrity ok, 97/97 people, 387/387 faces with unique UUIDs, 34 names and 2
favorites unchanged, gallery works. The rekey itself still needs one manual
check (favorite a disposable photo, edit, Save, heart stays).

Moved to phase 6, where the protocol makes them concrete: content-hash cache
(hash only what is being synced), `updated_at` + deletions as a change log,
face boxes as fractions (computed at export from the 1280-px decode size).
Rewriting every table to hash keys was dropped: the local key stays, sync maps
it to SHA-256, which needs no destructive migration.

- Back up `photo_metadata.db` and `hidden_vault.db` before migration.
- Add content hashes (cached), move all tables to hash keys. Old keys of photos
  that no longer exist are kept, not deleted.
- Add UUIDs, `updated_at`, tombstones; convert face boxes to fractions; record
  embedding model.
- Keep hashes up to date after the editor's **Save**, so an edit keeps
  favorite, collections and faces.
- **Done when:** after migration every favorite, collection, person name and
  face group is still there, and an edited photo keeps its metadata.

### 1. Desktop: skeleton + Gallery

Electron app, `~/Drive/Photos/` scan + hash, thumbnails, timeline
(Week/Month/Year), viewer with filmstrip, zoom and details.
**Done when:** a packaged app opens on its own and shows a real library.

**Status 2026-09-22: done** (`desktop/`). Scan is incremental (size + mtime),
SHA-256 per file, EXIF date/camera/GPS, sharp thumbnails, ffmpeg video frames.
Timeline Week/Month/Year with touchpad pinch, period pill; viewer with wheel
zoom to 5×, pan, double-click 2×, ←/→, Esc, `i` details, filmstrip, Show in
folder, video playback. `npm test` passes; AppImage + deb build, and the
unpacked package indexed a 70-item disposable library. Not yet: a run on the
real `~/Drive/Photos`, HEIC originals (thumbnail fallback only), video capture
date (uses file time).

### 2. Desktop: Collections, Favorites, Search, Trash

**Status 2026-09-22: done.** Favorites and My collections stored by SHA-256 with
UUIDs, `updated_at` and tombstones (sync-ready). System collections: Favorites,
Videos, Screenshots. Collection rules match the phone (non-empty, ≤ 60 chars,
unique ignoring case); deleting one keeps its photos. Multi-select: check
circle, Ctrl+click, Shift+click range, drag with edge auto-scroll, Ctrl+A, Esc;
selection island and viewer offer Favorite, Add to / Remove from collection,
Move to Trash. Search matches file name and folder, ignoring case and accents
(labels, people and places join in later phases). Photos tools: hide
Screenshots from Photos. Trash = system Trash after confirmation; favorites and
collections return with a restored file. Not yet: rename collection (also
deferred on the phone).

### 3. Desktop: Files module

`~/Drive/` browser with tags, favorites, colours, copy/move/rename, Trash — the
phone's rules (no overwrite, no escaping the root).

**Status 2026-09-22: done** (`desktop/files.js`, `src/Files.tsx`) on
`~/Drive/Drive/`. Same rules as the phone's `DriveRules`: safe relative paths,
symlinks never followed, no overwrite, no folder into itself, `Drive/Trash/`
reversible by Move, **Empty Trash** the only permanent delete (confirmed).
Copies are additionally verified by SHA-256. Tags (1–32 chars, no commas),
favorites, folder colours (phone palette) and recents (50) live in SQLite,
follow rename/move, and tags carry `updated_at` + tombstones. List/grid, sort
by name/modified, breadcrumbs, recursive search by name and tag (accent-
insensitive), tag chips, Favorites and Recent, Properties, storage by type,
Open / Show in file manager. Dotfiles are hidden. Not implemented (also absent
on the phone): creating files/folders; Share and Open with (no desktop
equivalent chosen yet).

### 4. Desktop: People

Detect → embed → group with the phone's thresholds; rename, merge, undo,
Help organize.
**Done when:** embeddings of the same photo on phone and desktop match
(cosine ≥ 0.74).

**Status 2026-09-22: done** (`desktop/faces.js`, `src/People.tsx`). The phone's
`mobilefacenet.tflite` was converted to ONNX (TFLite vs ONNX cosine 0.9999999).
YuNet replaces ML Kit for detection; eye landmarks come from two passes (whole
photo + zoomed face) averaged. Alignment, quality score, reliability limits and
grouping thresholds are the phone's. Faces carry UUIDs, fractional boxes, the
embedding model string and tombstone-able people; merge undo restores the same
person id; re-analysis never duplicates faces or undoes manual grouping.
**Measured on 17 faces in 12 real phone photos:** desktop found 17/17; phone vs
desktop embedding cosine min 0.761, median 0.932; the desktop face's nearest
phone face was the same person in 11/12 checkable cases (the miss sits 0.88 from
a person the phone had split in two). So the target is met in the median but
not for every face — below-threshold pairs land in Help organize, as on the
phone. Yaw is estimated from landmarks (calibrated on those faces). HEIC is
decoded with libheif, which also fixed HEIC thumbnails and the viewer.

### 5. Desktop: Map, Hidden (encrypted), Editor, Documents classification

**Status 2026-09-22: done.**

Done and tested:
- **Map** (`src/MapView.tsx`): MapLibre + OpenFreeMap like the phone; photo
  thumbnails as markers, clusters show the newest photo + count and split on
  zoom (markers rebuilt on `idle` from rendered features). Worker bundled via
  `?worker&url` because the page loads from `file://`. Viewer Details show
  place + coordinates + Show on map; OpenStreetMap opens externally.
- **Place names offline** (`places.js`): nearest GeoNames place ≤ 50 km,
  Greek spellings included for search. GPS was silently dropped since phase 1
  (EXIF pick filter) — fixed; `meta_v` re-reads existing rows once without
  re-hashing; 0,0 = no fix.
- **Hidden** (`vault.js`, `src/Hidden.tsx`): passphrase → Argon2id, files and
  thumbnails encrypted (secretstream / secretbox), key only in memory, locks on
  quit. Hide = encrypt → decrypt → SHA-256 check → delete plaintext original,
  thumbnail, HEIC preview and face crops. Restore verifies and never
  overwrites. Checked in the app: locked start, wrong passphrase, unlock,
  hide 3, restore 1.
- **Editor** (`editor.js`, `src/Editor.tsx`, `src/edit.ts`): crop rectangle +
  straighten (auto-zoom so no empty corners), rotate ±90° (crop and markup turn
  with the photo), markup (swatches, custom colour, size, undo), Save sheet
  (Save / Save as copy / Discard), up to 8192 px. The renderer gets the bytes
  over IPC (a canvas drawn from `media://` could not be exported). Save copy =
  `_edited.jpg` with original date/camera/GPS spliced in without re-encoding and
  the original's mtime; Replace = original to system Trash first, and
  favorites/collections move to the new SHA-256 (the phone loses them).
  Checked in the app on a 14 MP phone photo (rotate + save copy). Replace is
  unit-tested only (in-app it would fill the real Trash with test files).
- **Viewer fix:** portrait photos were shown cropped (not fitted) since phase 1.

- **Documents** (`documents.js`): the phone's ML Kit "paper" label + OCR are
  Android-only, so PaddleOCR v4 text *detection* finds text lines; characters ≈
  line width ÷ height feed the phone's thresholds (0.95 / 0.70 / 0.45 review),
  plus a coverage gate replacing the "paper" label: text lines must cover ≥ 3 %
  of the photo, because the Xiaomi/Leica watermark strip alone reads as ~80
  characters. Test pages/receipts/photo-of-page: 0.95; all 12 real phone photos
  and a sign: 0. User answers win over re-analysis. Documents collection,
  "Hide documents in Photos", Help organize asks documents first (phone order),
  Details has Mark as / Not a document. Screenshots are skipped.
  **Calibrated** on the phone's own decisions (its 18 documents + 60 random
  non-documents): gate lowered to 3 % → 17/18 documents found (miss: tiny
  passport-style text), 1/60 false alarm (a handwritten notebook page).
  Screenshots stay excluded (the phone counted 2 document-viewer screenshots).
- **Labels** (search + Details): EfficientNet-Lite0 "Scene: …" labels
  (converted from the phone's model), "Likely day/night" and "Portrait", all
  from the same pass. The phone's other labels come from ML Kit and will arrive
  with sync for photos it analysed.
- The analysis runner now serves People and Documents in one pass (one decode
  per photo); each still starts only on its own explicit request.
- Package: four ONNX models, AppImage 192 MB / deb 154 MB; the packaged app ran
  faces, documents, labels and places end to end.

Not done (small, also optional on the phone): hiding the People/Documents
cards from Collections.

QA notes: `scripts/shot.js` now renders hidden (`DRIVE_HIDDEN`), because a
visible window on the user's desktop can be clicked by them. Disposable test
libraries live in the session scratchpad, not in the repo.

### 6. Sync

QR pairing → `/have` + blob upload with receipts (Copy) → metadata both ways →
Move → Hidden. Then the phone's Sync card becomes real.
**Done when:** a Copy of the whole phone gives the desktop the same Gallery,
collections, people and Hidden; a second sync transfers nothing; Move deletes
only items with receipts.

**Status 2026-09-23: phases 6a–6c done.** Everything the user makes now crosses:
documents, **favorites, collections (with membership), search labels, people's
names and the face → person grouping**. One endpoint carries them all:
`POST /metadata` / `GET /metadata?since=` (`desktop/sync.js` `applyMetadata`,
phone `SyncClient.syncMetadata`), with the work split into the modules that own
the tables — `library.js` (favorites, collections, labels), `faces.js` (people,
faces), `documents.js` (classification). Every record is independent: one that
cannot be placed yet (an unknown collection, a photo that has not arrived) is
skipped and the next sync brings it, and newest `updated_at` wins per record in
both directions.

Phone schema v15 gives `updated_at` to `photo_state`, `collections`,
`collection_membership`, `face_groups` and `face_samples`, and turns collection
and membership removals into tombstones (`deleted = 1`) so a removal travels
instead of silently coming back. The desktop already had all of that.

**Do the two apps need different models for tags and faces? No — and nothing
needs translating.**

- **Faces.** Both apps run the same MobileFaceNet weights on the same
  landmark-aligned 112 px crop (`mobilefacenet-192-eyes38x44-74x44`, the string
  both sides store), so an embedding means the same thing on either device and
  the same thresholds apply. Only *detection* differs (ML Kit on the phone,
  YuNet on the desktop) — that changes which faces are found, not what an
  embedding means. So the phone's faces are usable as-is; what was actually
  needed was a way to tell that a face the phone found and a face the desktop
  found are **the same face**, and on a photo both devices hold that is simply
  box overlap (`faces.js` `iou`, `SAME_FACE_OVERLAP = 0.4`), which is cheaper
  and surer than comparing vectors. A phone face with no local counterpart is
  kept whole, embedding included, so People works here before any local
  analysis has run.
- **Tags.** The phone's ML Kit labels and the desktop's EfficientNet-Lite0
  "Scene: …" labels come from different models with different vocabularies, but
  a label is a search string, not a measurement: they merge per photo and both
  sets stay. No shared vocabulary is needed, and there is nothing to convert.
- Measured on the real library (2026-09-23, 1475 photos): of the phone's 387
  faces, 54 landed on a face the desktop had already found and joined the
  phone's person instead of being duplicated; the 56 local faces left beside a
  synced one are genuinely other people — their best embedding cosine against
  any synced face on the same photo has a median of 0.23, far under the 0.74
  "same person" line. No box fell outside the photo.

**Face boxes.** They travel as fractions of the upright photo. The phone stores
them in the pixels of the bitmap it analysed (longest side capped at 1280), so
`SyncRules.analysisSize` reproduces that size from the photo's own dimensions.
Those dimensions must be the **upright** ones: MediaStore reports the size as
the file stores it, so a quarter-turn in EXIF has to be undone first
(`listGalleryMedia` reads `ORIENTATION`). Getting this wrong put boxes outside
the photo and stopped every overlap match — it is the one part of this protocol
with no second chance to notice.

Tested: `desktop/test/sync.test.js` (two suites — documents, then favorites,
collections, labels, people and faces crossing over, last-write-wins both ways,
tombstones, and the overlap merge), the phone's unit tests, and a **full real
sync from the phone against a copy of the real desktop library**: 34 named
people, 456 faces, 2 favorites, 6707 labels, 18 documents, 1 collection.

Desktop's document detection stays phone-dependent for correctness (see
`mistakes.md`: no independent paper-vs-text-heavy-photo signal exists on the
desktop, and ML Kit's model is not extractable outside its own runtime).

Not done, on purpose:

- **Photo tags the user writes by hand.** Neither app has them — on the phone
  "tags" in Photos search *are* the AI labels, and only Files has hand-made
  tags. Adding them is a new feature on both sides, not a sync gap.
- **Desktop → phone labels.** `photo_labels` has no `updated_at`, so there is
  no cursor to send them by, and the phone analyses locally anyway.
- **Desktop-only faces going to the phone.** Names and regrouping travel both
  ways; a face only the desktop found is not inserted on the phone, because its
  box is in the desktop's coordinates and the phone re-detects it itself. The
  upgrade, if it ever matters: match such a face against the phone's person
  centroids by embedding (≥ 0.74) — the shared model already makes that valid.
- **The whole metadata set goes over on every sync.** Last-write-wins makes
  that safe and self-healing, and today it is a few hundred KB. Switch to an
  `updated_at` cursor if a library outgrows one request.
- **Files** (tags, favorites, colours, recents) are still outside the protocol
  entirely — they use path identity, not content hashes. Own design pass.

### 6d. Files: tags, favorites, colours and recents

**Status 2026-09-23: done.** The Files module's own metadata rides the same
`/metadata` endpoint, as `files` (one record per path: favorite, colour and the
whole tag set) and `fileRecents`. Files are keyed by their `Drive/`-relative
path, which is the same path on both devices, so a record needs nothing but a
time: the newest edit of a path wins. Tags travel as the **whole set** for a
path rather than as individual tombstones — the set the newer side holds is the
answer, and a tag missing from it was removed. Recents merge on the newest open
of each file, whichever device it happened on, and each side quietly drops the
entries it cannot see when it reads them.

The phone's `drive_metadata` preferences gained an `updated_at` map keyed by
path (`DriveMetadata.touch`), which is all that was missing; the desktop's
`file_meta` / `file_tags` already had `updated_at`.

### 6e. Files: the files themselves, and Trash

**Status 2026-09-23: done, phone → computer.** `POST /files/manifest` (the
phone offers every file under `Drive/` with its SHA-256) and
`PUT /file/<sha256>?path=&modified=` (the same verified write as photos: a
`.part` hashed as it is written, renamed only on a match, existing files never
replaced — a different file of the same name keeps both).

**Content is the identity, not the path.** A file whose bytes the computer
already holds under another name was moved or renamed on the phone, so the
computer **moves its own copy to match** instead of asking for the bytes again.
That is what makes "move to Trash" arrive as a move into `Drive/Trash/` rather
than as a second copy, and it costs nothing extra: renames, moves between
folders and Trash are all the same case. A path the phone no longer has is left
alone — sync copies, it never deletes.

Both sides cache file hashes against size and mtime, so each file is read once
(`DriveManifest` on the phone, `file_hashes` on the desktop). Folders on the
receiving side are created one level at a time, each re-checked against the
Drive root, so a symlink cannot be followed out of it.

Tested: `desktop/test/sync.test.js` (two suites — Files metadata, and the
manifest with rename → move, move → Trash, a wrong hash keeping nothing, a path
outside Drive refused, same name different content keeping both) plus a **real
run against the phone's own Drive folder**: 36 files offered, 29 wanted and
verified across, then a file moved into Trash on the phone arrived as
`want 0, moved 1` — the computer moved its copy into Trash and made no
duplicate.

Not done: **computer → phone**. The phone is the client in this protocol, so a
file created on the computer waits for the phone to ask. Closing that needs the
phone to answer requests (a small listener) or to pull a manifest of its own.

### 6f. Sync without being asked

**Status 2026-09-23: done on the phone.** `SyncService.syncInBackground` runs a
sync when the app opens, and straight away after the scanner saves a PDF. It is
deliberately easy to talk out of: no paired computer, a backup already running,
a metered connection, or a sync less than 15 minutes ago and it simply does not
happen (the PDF case passes `gap = 0` — something just changed, send it).

Wi-Fi only is a rule, not a setting: a backup is the whole camera roll, never
something to put on mobile data by itself.

**Opening the desktop app cannot start a sync today.** The phone is the client
and the computer has no way to reach it, so the computer would have to announce
itself (mDNS) and the phone listen for it. Until then, opening the phone app is
what catches both up.

### 7. Later: folders as albums (requested 2026-09-22)

- **Phone:** on opening, find every folder with photos or videos outside the
  Camera/Screenshots defaults (Viber, Messenger, WhatsApp, Download…). Each new
  folder appears in **Help organize** as "Include <folder> in Local Drive?"
  (Yes/No). A Yes makes it a **user album named after the folder**; its media
  shows in Gallery like any album (and can be hidden from Gallery with the
  album toggle).
- **Phone Settings › Gallery › Folders:** a toggle per folder with media to
  include or exclude it at any time (the Help organize answer is just the
  first setting of that toggle).
- **Desktop:** the same for folders under the Photos root once phone folders
  arrive through sync (album per folder, include/exclude toggles).
- Rules: including never moves or copies files; excluding only hides them
  from the app.

### 8. Later: multiple paired devices (requested 2026-09-22)

The phone should eventually back up to more than one paired device (e.g. the
desktop computer **and** a tablet), not just one. Not built yet — today's
storage layer hard-assumes exactly one active pairing:

- `SyncStore`'s pairing record (`SyncClient.kt`) is a single flat
  `SharedPreferences` entry, not a list. `savePairing` overwrites it;
  `forgetPairing` wipes it. Needs to become a list keyed by fingerprint/id.
- The `receipts` table (`SyncClient.kt`, "already sent to the computer") is
  keyed only by `photo_key`, globally — it doesn't know which paired device
  received a file. As-is, pairing a second device would make the app think
  files already sent to the first device don't need sending to the second.
  Needs a per-device column (or a separate receipts table per pairing).
- Settings/Sync UI needs a device list instead of the current single card.

## Safety rules (from the old desktop, kept on both sides)

- Copy → verify SHA-256 → receipt. A partial file is never visible or counted.
- Never overwrite silently; name conflicts keep both files.
- Move = verified copy first, then a separate delete through the platform's
  confirmation or Trash.
- A preview or sync never deletes anything by itself.
- Test with disposable files and a copy of the databases, never the real
  library.
