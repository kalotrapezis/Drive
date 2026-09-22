# Local Drive — desktop app and phone ↔ desktop sync plan

Updated: 2026-09-22 (phases 0–5 done; next: phase 6, sync). The same file lives in both `Drive-Android/` and `Drive/`.
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

## Safety rules (from the old desktop, kept on both sides)

- Copy → verify SHA-256 → receipt. A partial file is never visible or counted.
- Never overwrite silently; name conflicts keep both files.
- Move = verified copy first, then a separate delete through the platform's
  confirmation or Trash.
- A preview or sync never deletes anything by itself.
- Test with disposable files and a copy of the databases, never the real
  library.
