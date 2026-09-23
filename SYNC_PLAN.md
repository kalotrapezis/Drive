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

**Content is the identity, not the path** — but only where the phone actually
moved something. A file whose bytes the computer already holds under another
name counts as **moved** when the phone had it at that other path *last time*
and does not now: a rename, a move between folders, or a move into
`Drive/Trash/`. The computer then moves its own copy to match instead of asking
for the bytes again, so "move to Trash" arrives as a move into Trash rather
than as a second copy, and renames, moves and Trash are all the same case.

The memory matters, and finding that out cost a real run: without it, two
devices that simply keep the same document in different folders look like a
move, and the computer quietly reorganises its own Drive to match the phone's
layout. So the last manifest is remembered per device (`sync_manifest`), and
the first sync with a device moves nothing.

A path the phone no longer has is left alone — sync copies, it never deletes.

Both sides cache file hashes against size and mtime, so each file is read once
(`DriveManifest` on the phone, `file_hashes` on the desktop). Folders on the
receiving side are created one level at a time, each re-checked against the
Drive root, so a symlink cannot be followed out of it.

Tested: `desktop/test/sync.test.js` (two suites — Files metadata, and the
manifest with rename → move, move → Trash, a layout the computer chose being
left alone, a wrong hash keeping nothing, a path outside Drive refused, same
name different content keeping both) plus a **real run against the phone's own
Drive folder**: 36 files offered and verified across, the computer's own
differently-filed copies left where they were, then a file moved into Trash on
the phone arrived as `want 0, moved 1` — moved into Trash, no duplicate.

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
something to put on mobile data by itself. **A VPN has to be looked past to
apply it.** An ad-blocking VPN's network reports no metering and names no
network underneath it, so asking it alone answered "not unmetered" and turned
every automatic sync off for anyone running one — for a whole night, silently.
`SyncService.onUnmeteredNetwork` asks the real networks when a VPN is active.

A finished sync also refreshes the pages it changed. Nothing is more confusing
than a sync that says it is done over a page still showing the old contents.

**Opening the desktop app cannot start a sync today.** The phone is the client
and the computer has no way to reach it, so the computer would have to announce
itself (mDNS) and the phone listen for it. Until then, opening the phone app is
what catches both up.

### 6g. Which settings sync (asked 2026-09-23)

The question was worth asking, because the answer is not "all of them". The
line that holds: **a setting that describes the library crosses; a setting that
decides what this device should do stays put.**

Crosses (done 2026-09-23):

| Setting | Why |
|---|---|
| Hide Screenshots from Photos | It is a statement about the library, and the same library is on both devices. Sent as `viewSettings`, last-write-wins as a pair. |
| Hide Documents from Photos | Same. |
| Hide an album from Photos | Belongs to the *album*, not to a device, so it moved out of preferences onto the collection row (phone schema v16, desktop `collections.hidden`) and travels with it. This also took the desktop's copy out of `localStorage`. |

Stays local, on purpose:

| Setting | Why |
|---|---|
| People analysis on/off, Documents analysis on/off | This is "spend this device's battery and CPU for the next few hours". Syncing it would start that work on a device nobody asked. The *results* sync, which is the point. |
| Search quality (Fast / Advanced) | A performance choice about this device's hardware. |
| Onboarding, home backdrop, sort orders, the pairing itself | Per device by definition. |
| Scanner settings | The phone has a camera; the computer does not. |

### 6h. Trash, on both sides (2026-09-23)

Trash was three different things and is now one idea in three places:

- **Files** (both apps): `Drive/Trash/` is an ordinary folder, so it syncs as
  paths do and a move into it crosses as a move. It is no longer *listed* as a
  folder — it has its own way in (Files tools on the phone, the sidebar on the
  desktop), and as a row it was only something to open by accident. A single
  item already in Trash offers Restore; the folder's header carries Empty
  Trash, in red, where the page's actions are.
- **Photos, phone:** Android's own trash, queried with
  `QUERY_ARG_MATCH_TRASHED` because trashed media is deliberately absent from
  the ordinary listing. Android holds it 30 days and deletes it itself;
  restoring and emptying both go through its own confirmation.
- **Photos, desktop:** the system trash. `shell.trashItem` records where a
  photo came from in a `.trashinfo` beside it, so reading those back gives the
  same two answers. **Only items whose recorded origin was inside the library
  are listed or emptied** — the rest of the user's trash is theirs. Restoring
  puts a photo back exactly where it came from and never over something that
  has taken the name since.

Photo trash is not synced and should not be: each device's trash is that
device's own pending deletion, and "never delete because of a sync" is the rule
the whole protocol rests on.

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

### 6i. Two-way: bringing the bytes back (designed 2026-09-23)

Metadata already crosses in both directions. **Only the bytes are one-way**: the
phone pushes photos and files, and nothing ever comes back. Two-way is therefore
one idea applied twice — the phone asks for what the computer holds and it does
not — plus the rule that a second Android device (the tablet) is not a peer but a
second client of the same computer.

```
two-way sync
├── metadata ............................ done, both ways
│   POST /metadata  ⇄  GET /metadata?since=<cursor>
│
├── photo bytes ......................... phone → computer only
│   └── pull
│       ├── desktop  POST /library/manifest {hashes}     → {send:[{sha256,path,name,modified,size}]}
│       ├── desktop  GET  /blob/<sha256>                  (the route exists for PUT only)
│       └── phone    SyncClient.pullPhotos
│                    ├── .part in cache → hash while writing → keep only on a match
│                    ├── MediaStore insert under the computer's own relative path
│                    └── SyncStore.identity gets photoKey ↔ sha256, so metadata lands at once
│
├── file bytes .......................... phone → computer only
│   └── pull — no new endpoint: POST /files/manifest already carries both sides' manifests
│       ├── desktop  files.reconcile → also answer `have` (paths the phone lacks) and mirrored `moved`
│       ├── desktop  GET  /file/<sha256>?path=            (the route exists for PUT only)
│       └── phone    DriveRules-verified write under /sdcard/Drive/<path>
│                    (.part → hash → rename, never overwrite, path re-checked per level)
│
├── deletions ........................... out of scope, by the rule the protocol rests on
│   sync copies and moves; it never deletes on either side
│
└── phone ⇄ tablet ...................... through the computer, not directly
    ├── desktop is already multi-device: sync_devices, per-device receipts, per-device sync_manifest
    ├── phone keeps one pairing (SyncStore) — enough: each device pairs with the computer
    └── so the tablet gets the phone's library on its first sync, and vice versa
```

Three things this design has to get right, in the order they can hurt:

1. **A pull must not undo a move.** The manifest memory that makes "the phone
   moved it" legible (6e) has to work in reverse too, or the first pull will
   re-create every file the phone deliberately moved into Trash. Same rule: the
   first sync with a device moves nothing, and only a path the *other* side held
   last time and does not now counts as a move.
2. **Identity on arrival.** A pulled photo is only useful if its metadata finds
   it, so the hash the phone verified is written into `identity` in the same
   step, before the metadata pass runs.
3. **Hidden stays hidden.** Vault items are not part of a pull; they cross only
   through the encrypted path of phase 6, which is its own piece of work.

### 6j. Connection cards (from the old app, 2026-09-23)

The tree in 6i assumes one hardwired answer — the phone pushes, the phone pulls.
The old desktop app had already answered this better, and the answer survives in
`Drive` on `codex/live-ui-audit` (`SPEC.md` §5, `design/audits/global-sync-map-2026-08-22/audit.md`):
**an interactive map is the wrong editor. A connection is a card.**

Its own audit of the map said why: the loose `+` diamonds never revealed whether
they added a device, a storage or a route, and Send/Receive/Move/Copy as four
checkboxes let the user state a contradiction. So the map became a picture drawn
*after* the fact — the whole network at a glance, read-only — and the editing
happens on a card that holds two devices and the rules between them. One set of
cards for Files, one for Photos, because the two libraries genuinely want
different answers (every photo everywhere; the working folder only on the laptop).

**The vocabulary is already decided, and it is worth keeping word for word:**

| On the card | Means |
|---|---|
| **Send** / **Receive** / **Send & receive** | Direction, and nothing else |
| **Keep Everything … Keep Last month / week / day … Keep Nothing** | What the *source* keeps after a verified transfer |
| Keep Everything = Copy, Keep Nothing = verified Move | The only two the phone has today |
| **Send & receive forces Keep Everything** | Two-way and "delete after sending" cannot both be true |
| Use as cache for transfer (staging maximum) | The laptop passing things through without keeping them |
| When the drive is connected | Timing, separate from direction |

Direction and retention stay separate concepts. That separation is the whole
lesson: the old UI's contradictions all came from one control trying to say both.

**How it lands on what exists now:**

```
connections (the computer owns the table; it is the only device every other one reaches)
├── row = (deviceA, deviceB, content: files|photos, direction, keep, staging, timing)
├── the phone reads its own rows at sync time and obeys them
│   ├── Send            → today's push                      (already built)
│   ├── Receive         → the pull of 6i                    (to build)
│   └── Send & receive  → both, and Keep Everything forced
├── the phone does not edit them at first — the computer configures, the phone
│   shows the sentence ("Phone Photos → Server: Copy") and that is enough to test
└── the map is a diagram of these rows, drawn after they exist, never the editor
```

**Keep Nothing is not a sync deletion.** The protocol's rule is that sync never
deletes; a Move is the user asking for one, and the old spec's invariants are the
ones that make it safe: nothing is removed until the destination's independently
read SHA-256 and size match and the catalog commit succeeds, a filename match is
never verification, and an offline device is never read as deletion. The phone
already has the receipt half of this (`SyncStore.receipts`). Keep Last week is
the same machinery with a date, and can wait.

**Order of work:** Receive (6i) first with the direction hardcoded to
Send & receive, because that is what the tablet needs and it cannot delete
anything. The card model, and with it Keep, lands on top once bytes provably move
both ways.

### 6k. Finding the other device when the address changes (2026-09-23)

The question: without a MAC address — Android randomises it per network and
anything on the wire can claim any MAC anyway — how does a device find the one it
is paired with after the IP changes, the router is replaced, or the network is
renamed?

**Identity is already solved, and was from the first pairing.** The computer's
TLS certificate fingerprint (`fp` in the QR, pinned by the phone) plus the device
UUID and bearer token it issues back *are* the identity. They survive every
address change, and they cannot be spoofed: a different device fails the
handshake rather than fooling anyone. There is nothing to invent here.

What is missing is only **address lookup** — which IP that identity is at today.
Three steps, cheapest first:

1. **The addresses already known.** Built: the QR carries every LAN address and
   `anyHost` tries each in turn, the one that answered last time first.
2. **A beacon** (built 2026-09-23). One UDP datagram to every broadcast address
   the phone can reach, on port 43181; the paired computer answers with the port
   to knock on, and the phone remembers the address that worked
   (`SyncDiscovery.find`, `SyncClient.reach`, `SyncServer.listenForProbes`). No
   dependency, no mDNS quirks. (mDNS — `NsdManager`, `bonjour-service` — is the
   standard version of the same idea, worth it only when the OS and other apps
   should see the service too.)
3. **Sweep the subnet**, for networks where broadcast is filtered (guest Wi-Fi,
   client isolation): the phone's own /24 on the known port, in parallel, short
   timeout. Not built — worth it only if step 2 is seen to fail on a real
   network.

**Discovery is a hint, never trust.** Any answer may be a lie; the pinned
certificate alone decides whether a sync happens. That is what makes it safe to
be careless about how an address is found.

**The beacon does not announce anything.** The probe carries the fingerprint the
phone is looking for, and a computer answers *only* if that is its own — so it
tells the asker something it already knew, and a stranger listening learns
nothing about who is on this network or what they hold. The token never travels
over UDP.

### 6l. Android ↔ Android: every device shows a code and scans one (2026-09-23)

**Status: pairing done, on both sides.** Two phones have no computer between them,
so the phone stopped being only a client: it can now be *found*, not just look.

- **The certificate comes from the Android keystore**, which issues a self-signed
  one along with the key it generates, so no certificate library is needed and the
  private half never leaves the keystore (`SyncServer.identity`). One catch cost a
  real device run: TLS hands the key an already-hashed value to sign, which the
  keystore calls the **NONE digest**, and a key not allowed it cannot complete a
  handshake at all. Such a key is replaced rather than kept — nothing can have
  paired with a certificate that never worked.
- **The server is small because the protocol is ours**: an `SSLServerSocket`, a
  request line, headers, and exactly Content-Length bytes. No HTTP library, and
  nothing to unpick later when photos need to stream through it.
- **It runs only while the QR code is on screen.** Something that listens all day
  is a decision to make out loud, not by leaving a screen open.
- **Pairing now hands over both halves at once.** The scanner proves it saw the
  code *and* says who it is: its own fingerprint, port, addresses and a token the
  other side sends when it calls. Between two phones neither is the client, so a
  pairing that travelled one way would leave one of them unable to ever start a
  sync. The computer stores the same fields (`sync_devices.peer_*`) and hands back
  its own, which is what will let a computer start a sync instead of only
  answering one.
- **Many pairings, not one.** `sync.db` v2 keeps a `peers` table keyed by
  fingerprint, because a phone and a tablet pair with each other *and* with the
  same computer.
- The phone answers the beacon of 6k too, so a paired device finds it again after
  its address changes.

Tested on the real phone (`SyncServerDeviceTest`, instrumented — only a device
can run it, the certificate comes from its keystore): the code it shows is a code
it could scan, a scan returns a token, both halves are stored, and a code works
once.

**Next, in order:** the phone answering `/have`, `/metadata` and the file
manifest — the endpoints the desktop already serves — so that a pairing between
two Androids can actually carry something. Until then a scan between two phones
completes and shows up as a paired device, and nothing moves yet.

### 6m. Faces the phone never found (2026-09-23)

Asked while looking at People on the computer: *there are faces here that the
phone does not have — do we just sync the faces?* Yes, and it is worth doing,
because the two detectors are not equally good. ML Kit runs on the phone; the
computer runs YuNet at a larger size with a second zoomed pass for landmarks, and
it finds faces the phone misses. Until now those faces stayed on the computer,
which meant the photo never appeared under that person on the phone.

**What changed:** a face now travels whole — box, embedding, model and quality,
not just "face X belongs to person Y". The phone keeps one it has never seen
instead of dropping it.

Nothing needed translating, which is the point of the choices made in 6c:

- The **box** is already in the protocol's own units, fractions of the upright
  photo, and goes back into the analyser's pixels on arrival with the same
  `SyncRules.analysisSize` used to send one.
- The **embedding** means the same thing on both devices, because both run the
  same MobileFaceNet weights on the same landmark-aligned crop. A record carrying
  any other `model` string is refused rather than trusted.
- The **person** is a UUID both sides already share. A face whose person has not
  arrived yet is skipped, not guessed at — the next sync brings it.

**Two detectors must not each add their own copy of one face.** The overlap rule
that already let the computer recognise the phone's faces (`SAME_FACE_OVERLAP`,
0.4) is now the phone's rule too, in both directions: a synced face is skipped if
this phone already found it, and a locally detected face is skipped if the
computer already sent it. Cheaper and surer than comparing vectors, on a photo
both devices hold.

So the workflow the question was really asking about works: **let the computer do
the finding and the grouping, help it where it asks, and the phone inherits the
result** — including faces its own detector could never have found.

Still not done: a face the computer found on a photo the *phone does not have* is
skipped, because there is nothing to attach it to. It arrives with the photo.

### 6n. The cover face, and people with nothing left (2026-09-23)

Two consequences of 6m, both asked for as soon as faces started crossing.

**The portrait is now the best face, not the first one found.** Both apps score a
face by the same formula (sharpness × size), and the computer's faces arrive with
their score, so the two compete on one scale: whichever device took the better
look at someone is the one whose face represents them. This is usually the
computer, which detects at a larger size — which is also why it finds faces the
phone misses.

**A person with no photos left stops being shown.**

- **Computer:** when a scan sees photos leave the library, their faces go with
  them and a person left with no faces at all is removed. "Gone" is narrower than
  it sounds, and each exclusion is a way this could have lost a name:
  a photo that merely **moved** is already back in the table under its new path
  (removals run after every file on disk has been seen); a photo sitting in the
  **Trash** can be put back, so its faces wait for it; and a face the phone sent
  for a photo **not yet transferred** has no media row and never had one. The
  person's row is deleted rather than tombstoned on purpose: the phone may still
  hold that person's photos, and a tombstone would travel there and delete someone
  perfectly alive. The next sync simply brings them back.
- **Phone:** a group is only as alive as its photos — People lists only those
  with at least one photo still on the device. The rows stay, because Android's
  own Trash holds a deleted photo for thirty days and restoring it should bring
  the person back, name and all. Rows are actually removed where it is already
  safe: when the photos themselves are forgotten (`forgetPhotos`).

Both trashes are respected, for the same reason: a deletion you can undo is not a
deletion, and a name the user typed is not worth losing to one. What differs is
only how each device is *told* — the computer reads the freedesktop `.trashinfo`
files beside the trashed photo (6h), the phone asks Android. The one real
asymmetry left is what happens after that: the computer's library is a folder it
can see the whole of, so once a photo is emptied from the Trash its faces go;
Android's trash empties itself after thirty days, so the phone keeps the rows and
simply stops listing a person with nothing to show.

### 6o. Where the grouping was actually going wrong (measured 2026-09-23)

Asked after a day of Help organize answering "yes, obviously" nine times out of
ten, and of one person appearing as a dozen groups. Both had the same cause, and
it was not the model.

Measured on this library's own named people — 277 phone faces across 34 people,
69 computer faces across 13:

| line | same-person pairs joined (phone / computer) | different people wrongly joined |
|---|---|---|
| **0.74** (was) | 10.7% / 14.1% | 0.00% / 0.00% |
| 0.60 (now) | 36.7% / 27.4% | 0.22% / 0.00% |
| 0.50 | 59.4% / 38.6% | 1.73% / 0.44% |

At 0.74 the grouping was so cautious that **three quarters of pairs that really
are the same person were treated as strangers**, while no pair of different
people ever came close — the highest similarity between two different people
anywhere in this library is 0.73, and that is one pair out of 34,109. Help
organize asks about the band *just under* the join line, so it was asking about
near-certainties: hence "yes" nine times in ten.

Now: **join at 0.60, review 0.45–0.60**, on both devices. Three times the joining,
and different people still essentially never meet. Review sits where the answer is
genuinely uncertain, which is the only place a question is worth asking.

**The computer's embeddings are the weaker pair.** Same-person median is 0.445
here against the phone's 0.542, on the same model — so the difference is the crop,
not the network. Detection runs on a 640-px downscale, so YuNet's landmarks are
coarse, and `refine()` averages a sharp second-pass estimate with that coarse one.
Worth trying next, in order of effort: trust the refined landmarks rather than
averaging them; detect at a larger size; and only then a stronger recognition
model (AppLocker's SFace + OpenCV `alignCrop` is the working example, but it would
break the shared-embedding contract with the phone unless both sides move, so it
belongs as a second, computer-only embedding used for grouping alone).

### 6p. Taking a combine back, long after the moment

Combining is the one action in People that throws a grouping away: afterwards the
person it was wrong about does not exist to be found again. An eight-second undo
is not enough for a decision made in a list of a hundred faces.

Both apps now keep every combine — the group's name ("Person 41"), its head, its
faces and when it happened — and offer Restore whenever. Restoring brings back the
**same person id**, so the other device sees one continuous identity rather than a
new arrival. Undoing within the window and restoring from History are the same
operation, so a combine cannot be taken back twice.

People also gained an island on both apps, where the phone already puts the
actions for a thing you have open: **Combine · Rename · History**.
