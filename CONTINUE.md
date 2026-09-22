# Continue Local Drive (desktop + phone)

Updated: 2026-09-22 evening. The same text starts `Drive/CONTINUE.md` and
`Drive-Android/CONTINUE.md`. The plan with every phase's status is
[SYNC_PLAN.md](SYNC_PLAN.md) (identical in both repos; edit one, copy it).

## The product

A personal Google Photos + Google Drive: the Android app (`Drive-Android`,
branch `alpha`) and a new Electron desktop app (`Drive/desktop/`, branch
`electron-desktop`) with the same features and data model, syncing 1:1 over
Wi-Fi. The old C++/Qt code in `Drive/` is reference only.

## Where things stand

- Phases 0–5 done (see SYNC_PLAN.md): desktop Photos, Collections,
  Favorites, Search, Trash, Files, People (phone-compatible embeddings), Map,
  offline places, encrypted Hidden, Editor, Documents, labels. Phone: sync
  UUIDs (schema v13) and the edit-keeps-metadata fix.
- Phase 6 sync: **6a (desktop server) and 6b (phone pairing + Back up) are
  built and in their first live test.** 6c and 6d are next.

### Live test running at handoff

- The desktop app runs detached on a **test folder**, not the real `~/Drive`:
  ```sh
  cd Drive/desktop && DRIVE_PHOTOS=$HOME/Drive-sync-test/Photos DRIVE_FILES=$HOME/Drive-sync-test/Drive \
    DRIVE_DATA=$HOME/Drive-sync-test/data npx electron .
  ```
  Log: `~/Drive-sync-test/app.log`. Sync listens on port 43180.
- The phone (Xiaomi 15, shown as "Xiaomi 24129PN74G") is paired and backing
  up. At handoff: 1,198 files / 16.3 GB received and verified; the phone has
  about 17 GB DCIM + 0.8 GB Pictures.
- Progress:
  ```sh
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.HOME+'/Drive-sync-test/data/library.db');console.log(d.prepare('select count(*) n, round(sum(size)/1e9,2) gb from sync_receipts').get(), d.prepare('select name,last_seen from sync_devices').all())"
  ```

## Next steps, in order

1. **Finish verifying the live test** once the phone says Done:
   - Re-hash every received file against `sync_receipts.sha256` (all must match; no `.part` files left).
   - The desktop Photos page lists them after the batched rescan, HEIC included.
   - Press **Back up now** again: it must send 0 (all "already there").
   - Note the time and throughput for the plan.
   - Ask before deleting `~/Drive-sync-test` (about 18 GB).
2. **Phone text fix:** the Sync help text still says "Phone sync › Pair a
   phone"; the desktop page is now **Devices** (rail and title).
3. **6c: metadata phone → PC.**
   - Map the phone's `photo_key` to SHA-256 with `sync.db` (`identity` table).
   - Send people (UUID + name), faces (UUID, photo SHA, box as fractions of the 1280-px upright decode, MobileFaceNet embedding as base64 float32 LE, person UUID, quality), collections (UUID, name, members), favorites, documents (type, user_verified), labels, and locations/place names.
   - Merge on the desktop by UUID, newest `updated_at` wins. Add a change log for deletions (see phase 0 notes).
   - The desktop must not re-detect faces for photos that arrive with phone faces (`People.record` already refuses duplicates).
4. **6d:**
   - PC → phone metadata.
   - **Move / free up space:** the phone deletes only photos with a receipt, through Android's confirmation.
   - Hidden: encrypted on arrival.
   - The `Drive/` files folder.
5. **Open question for the user:** direct phone ↔ tablet sync. The proposal is
   a receiver mode in the Android app (a small HTTPS server, the same protocol)
   as its own phase after 6d. The user asked about it; it isn't in the plan
   yet.
6. **Later (phase 7 in the plan):** media folders (Viber, Messenger…) proposed
   via Help organize and turned into albums, plus a Settings › Gallery ›
   Folders toggle.

## How to build and check

- **Desktop:** `cd Drive/desktop && npm test && npx tsc -p . && npx vite build`
  (22 tests). Package: `npm run dist` (AppImage needs libfuse2; use the deb).
- **Visual QA without disturbing the user:**
  - `node_modules/.bin/electron scripts/shot.js out.png "<js>"` renders offscreen; `SHOT_CONSOLE=1` prints the page console.
  - Use `DRIVE_PHOTOS / DRIVE_FILES / DRIVE_DATA` for disposable data.
  - Never pop visible windows; the user clicks them.
- **Phone:** `cd Drive-Android && ANDROID_HOME=~/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew testDebugUnitTest assembleDebug`, then `~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk` (51 unit tests).
- **Phone data (read-only):** `adb exec-out run-as com.kalotrapezis.drive cat databases/photo_metadata.db > copy.db`.
  Backups from before the v13 migration: `Drive-Android-backups/2026-09-22/`.

## Rules that held up

- Never touch the user's real photos or folders in tests. Copy to a
  disposable folder (not `/tmp`, which is a 5.7 GB RAM disk, for anything
  large).
- Back up the phone databases before any migration, and verify on the device
  afterwards.
- Leave the user's untracked `Assets/Icons/New*` folders alone.
- Measure against the phone's own data before trusting a threshold. Faces,
  documents and labels were all calibrated that way; the numbers are in
  SYNC_PLAN.md.
- Don't tap around on the phone while the user is using it.
