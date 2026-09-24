# Handoff — end of 24 September 2026

Read `SYNC_PLAN.md` for *why* anything is the way it is. This is the first ten
minutes, and the traps that cost time today.

## Where everything is

| | |
|---|---|
| **Phone** | `~/Έγγραφα/Claude/Coding/Drive-Android`, branch **`bidirectional-sync`** — **dirty, nothing committed** |
| **Computer** | `~/Έγγραφα/Claude/Coding/Drive` (Electron app in `desktop/`), same branch — **dirty, nothing committed** |
| **Plan** | `SYNC_PLAN.md`, identical in both repos — copy it across after editing, it is not a symlink |
| **Devices** | phone *Xiaomi 15* (`208c8192`), tablet *Xiaomi Tab 7 pro* (`971f6b37`), both paired with the computer |
| **Backups** | `Drive-Android-backups/` — `2026-09-24-phone/`, `2026-09-24-desktop-before-tablet.db`, `2026-09-24-desktop-after-tablet.db`, and the release keystore |

**Nothing is committed.** Everything below is in the working tree of both repos.
Read the diff before committing; it is a day's worth.

## Running things

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=$HOME/Android/Sdk
./gradlew testDebugUnitTest assembleDebug -q
~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
```

Desktop: `cd desktop && npm start` (vite build + electron, ~40s). `npm test` for its
40 tests. 85 Android unit tests. **Both suites pass right now.**

Killing the desktop: `pkill -f electron` also kills the shell that typed it. Take the
pid from `ss -tlnp | grep 43180` and `kill` that.

Nudging a device to sync (it must have the app open):

```bash
cd desktop && node -e "
const { DatabaseSync } = require('node:sqlite'); const https = require('node:https')
const db = new DatabaseSync(require('node:os').homedir() + '/.local/share/local-drive-desktop/library.db')
for (const d of db.prepare('SELECT name, peer_hosts, peer_port, peer_token FROM sync_devices WHERE peer_token IS NOT NULL').all()) {
  const host = d.peer_hosts.split(',')[0]
  const req = https.request({ host, port: d.peer_port || 43180, method: 'POST', path: '/sync', timeout: 5000,
    rejectUnauthorized: false, headers: { authorization: 'Bearer ' + d.peer_token, 'content-length': 0 } },
    res => { res.resume(); console.log('nudge', d.name, res.statusCode) })
  req.on('error', e => console.log('error', d.name, e.message)); req.end() }"
```

## What today changed, shortest possible

**Sync**
- Labels cross both ways at last (6w 2 closed). `METADATA_EPOCH` is 3.
- The computer learns a device's address from its own calls, so a phone that changes
  network is still reachable.
- Stop stops mid-file; a lost network is retried three times, then it gives up.
- **Photos, computer → phone, ran for real**: 296 photos, nothing lost (6w 4 closed).

**The overview** (Devices page, above the cards) — how much there is, where it is,
how many copies, what is safe to free, what the library is made of, and every number
clicks through to the files behind it.

**Two real defects it found, both fixed**
- A receipted photo could be absent from `media` (the scanner did not index raw): 83
  `.NEF` were on disk, verified, and counted as missing.
- A receipt could outlive its file, and `have()` trusted it, so 7 photos existed on
  one phone and nothing would ever have fetched them again. They came back by
  themselves once `have()` started asking whether the file is still there.

**Formats**: raw is in (`.nef` and nine others; libvips reads the embedded full-size
JPEG). HEIC already worked.

**The app is one dark palette again** on every device — no dynamic colour, no system
light theme. Tablet grids size themselves by screen width.

**Devices page**: cards read like cards, each device has a name and a picture you
choose, this machine says what *it* is (so "here" is now "this PC"), and an (i)
explains that it is the hub.

**Nothing crosses until the rules are answered** (6aj). A new device pairs with every
row Off. This is the fix for the tablet uploading 11.8 GB this morning.

## Traps that cost time today

- **A running app is not the code on disk.** The desktop had been up since 00:11 and
  was serving pre-00:44 code; a feature added that morning could not possibly work.
  Restart before believing anything about a feature added today.
- `db.transaction()` is better-sqlite3. `node:sqlite` has no such thing — use
  `BEGIN`/`COMMIT`/`ROLLBACK` around a prepared statement.
- `this.files` on `SyncServer` is the Files module. A method called `files()` silently
  shadows nothing and breaks everything.
- A `<th>` with `display: flex` stops being a table cell: its column collapses and the
  header stops lining up. The file list is a grid now.
- A test that uses a **real** drive UUID will write to that drive. Use
  `00000000-dead-4dea-8dea-000000000000`.

## Where the drive work stopped (D5, half built)

`drives.js` lists mounted filesystems by UUID. A drive is an ordinary device row
(`kind='database'`, `volume_uuid`, no peer columns), defaulting to a backup target.
`inspectDrive` scans it; `backUpToDrive` copies under `<mount>/Tetra/Photos` with the
same verify-then-rename discipline. The Add-a-device guide is built: select → scan →
rules → Start.

**It has never been run.** The Samsung T7 (`T7-TEO`, ext4, 841 GB free) scans clean —
1,816 photos, 29.28 GB to copy, writable — and the copy itself has not been pressed.
That is the first thing to do, and to watch: it writes ~29 GB to his working drive.

Then, in order: Drive files as well as photos; starting by itself when the drive
appears; and a drive as a source rather than only a target.

## Still open, in the user's order

`SYNC_PLAN.md` "Roadmap" has all of it. The headline:

- **Run the drive copy for real.** Everything for it exists and none of it has run.
- **Move has still never run for real**, which blocks the whole release/free-space
  design (6ac, D4) — the safest possible test is a handful of photos.
- Tablet steps 5–7 never ran: answering a card on one device, two devices disagreeing
  about who someone is, a rename against a rescan.
- **Multiple pairings on the phone** (§I) is still the biggest structural hole.
- A device does not yet say *why* a file failed to cross; `BackupResult.failed` is
  collected on the phone and thrown away.
- The phone has no view of the library overview; management is on the computer only.
