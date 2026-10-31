# ~/Tetra/.System

Everything Tetra keeps on the computer for its own use, in one hidden folder beside `Photos` and `Files`
(the user, 27 Oct 2026). `system.js` makes every path in it; no other code builds a `.System` path by hand.
On a phone or tablet it is `/sdcard/Tetra/.System` (`TetraSystem` in Drive-Android's DriveFiles.kt), the same tree.

**Files and Photos are the user's own** (the user, 29 Oct 2026: "Make Tetra process everything from the system folder;
Files and Photos to be userspace only"). The test for a folder: if Tetra's apps own and manage it — the user reaches it
through an applet, not by browsing Files — it is in `.System/<App>/…`; a file the user made or received, to open like
any document, is in Files.

## The tree

```
~/Tetra/.System/<App>/<Kind>
  App:  Photos  Files  Notes  Calendar  Timer  Contacts  Phone  Maps  Office  Sync  Backups  Data  Trash  Mail
  Kind: Data  Tools  Cache  Temp  Shared
```

The names are fixed. A folder is made only when something writes into it, so most do not exist yet.
A new app or kind is added to `system.js` and to this file first.

| Kind  | What it holds | Who may delete it |
|-------|---------------|-------------------|
| Data  | What the app keeps and needs: Maps' downloaded regions | Only the app itself, or the person. Never a cleaner. |
| Tools | Programs the app fetched: GraphHopper, pmtiles | Replaced by an update; never a cleaner. |
| Cache | What can be made again: Geofabrik's region list, the last build's log | A cleaner, any time (all of it, or by age or size). |
| Temp  | Work in progress | The job, when it ends (however it ended), and Tetra at every start. |
| Shared | The user's things an app keeps for them, the same on every device (sync carries them): events, contacts, notes, maps | Only the app, or the person through it; a reset (with its backup). Never a cleaner. |

## In use now

| Folder | What | Was |
|--------|------|-----|
| `Maps/Tools` | `pmtiles`, `graphhopper-web-10.2.jar` (desktop routing needs the jar) | `~/Tetra-maps/bin` |
| `Maps/Data` | `osm/<id>.osm.pbf` and `osm/<id>.poly` (the builder's, for the borders step), `traces/` (drives pulled from the phone, for MapsTest), `greece-latest.osm.pbf`, `greece.poly` and the rest of `tools/maps-greece.sh`'s files | `~/Tetra-maps` |
| `Maps/Cache` | `geofabrik-index.json` (fetched again after a week), `build-<id>.log` | `~/Tetra-maps` |
| `Maps/Temp` | `<id>/`, one map being built | `~/Tetra-maps/<id>` |
| `Backups/Data` | `phone-before-*.tar`, the phone's app data saved before a risky install (developer sessions) | `~/Tetra-backups` |
| `Backups/Data/Sync copies/<date>/` | sync's "name (2).ext" copies (not the Trash's own "(2)"s) that held the same bytes as the file beside them, under their sync path, and `List.txt` (what moved, and the copies that differ or have no original, left where they were) | Files, anywhere |
| `Calendar/Shared` | the calendars: a folder each, one `.ics` per event, `color` | `Files/Calendar` |
| `Contacts/Shared` | one `.vcf` per person | `Files/Contacts` |
| `Data/Shared` | the data meter: `usage/`, `plan.json` | `Files/Data` |
| `Phone/Shared` | call logs `calls-YYYY-MM.jsonl`, `Recordings/`, `spam.txt` | `Files/Phone` |
| `Timer/Shared` | timers, alarms, the stopwatch: a small JSON each | `Files/Timer` |
| `Maps/Shared` | the installed maps (`<id>.pmtiles`, `-gh` graphs, `.tsv`s), `Places/`, `Lists/`, `Trips/`, `added-places.tsv` | `Files/Maps` |
| `Trash/Shared` | Files' Trash: what the user or an app deleted, kept until the Trash is emptied (or the purgatory takes it) | `Files/Trash` |
| `Notes/Shared` | one `<id>.json` per note, `history/`, `deletions.json` | `Files/.notes` |
| `Mail/Shared` | the mail archive (mail.js): `accounts.json` (no passwords), `index.jsonl`, `<address>/<Inbox, Sent…>/<yyyy>/… .eml` with each mail's attachments in `<same name>.files/` | new, 31 Oct 2026 |
| `Office/Data` | (phone and tablet) the Office templates, `.potx`/`.dotx` themes | `Tetra/.templates` |

## What stays in Files

| Folder | Why |
|--------|-----|
| `From phone`, `From computer` | Files the user sent from one device to the other: theirs, opened like any document. |
| `Assistant` | Pictures AI Assist made at the user's request: theirs, like a photo they took. |
| `Documents`, `Documents/Scanned Documents`, the chosen system folders, everything else | The user's own. |

## Sync and older versions

Sync still names an app's files by the folder they were in: `Calendar/Personal/x.ics`, `Trash/a.docx`, `Maps/greece.pmtiles`.
Each device keeps them where its own version says: a version from 29 Oct 2026 in `.System/<App>/Shared` (`system.SHARED` here,
`TetraSystem.SHARED` on Android — the same list), an older one in Files. So devices on mixed versions sync as before: nothing
on the wire changed, no device has to be updated first, an old device cannot make the folders again on a new one, and no edit
is lost. A new version's Files never shows or offers one of those names at its top: a `Files/Calendar` left by a move that
failed is neither sent nor written into. Notes are not files to sync (they travel through their own step), so only where they
are on disk changed.

**The order:** any. Each device moves its own folders at the first start of the new version (`system.migrateFiles`; on Android
the first time anything asks for one of these folders), by renaming on the same disk: instant, all or nothing for each file,
nothing copied or deleted. A file already at the target is left where it was, both kept, and logged as `[system] not moved`;
the next start finishes what an interruption left. Ids and file names are unchanged, so sync sees no change at all. The
"(n)" copies are set aside once, after the move (`system.setAsideCopies`).
| `Sync/…` | Reserved; nothing yet. Sync's partial files stay beside their targets (`.part`, renamed in place on the same disk), its state in `library.db`, the purgatory in `Tetra/.purgatory` on the server and on each drive | |

The first start of a version with `system.js` moves `~/Tetra-maps` and `~/Tetra-backups` in by renaming (never a copy,
never a delete); a move that cannot happen leaves both where they were and is logged as `[system] not moved`.

## Cleaning (cleaner.js, Settings › Clean up)

By itself: every app's Temp at each start (`system.cleanTemp`), the map builder's own work at the end of every build,
and the data dir's `Files history` past 30 days, at start and once a day. By hand, on the Clean up page, each with its
size: every app's Temp and Cache (not a Temp a running job uses), Files history past 30 days, thumbnails whose photo is
gone (on a server, after a finished scan), the data dir's one-off safety copies (moved to `Backups/Data`, never deleted),
and GraphHopper's work folders (`routing/`) of maps no longer in .System/Maps/Shared. Each removes only inside its own folder;
links are removed, never followed. The page shows when each automatic one last ran.

## What .System is kept out of

- **Sync.** Only `Tetra/Photos`, `Tetra/Files` and the apps' `Shared` folders (under their old names, above) sync; the rest of
  `.System` never does.
- **Drive backups.** They copy the library's photos and Files, not the Tetra folder.
- **Settings › Reset.** Its backup and its count leave `.System` out, and the reset keeps it: it holds tools and safety
  copies, not the library, and a reset never touched `~/Tetra-maps` or `~/Tetra-backups` before they moved here. The apps'
  `Shared` folders are the exception: they were in Files, so a reset backs them up and deletes them as before.
- **Files, search, the library scan.** They read `Tetra/Files` and `Tetra/Photos` only; Files' Trash view opens `Trash/Shared`.
- Hidden: a dot-folder, so file managers do not show it.
