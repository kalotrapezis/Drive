# ~/Tetra/.System

Everything Tetra keeps on the computer for its own use, in one hidden folder beside `Photos` and `Files`
(the user, 27 Oct 2026). `system.js` makes every path in it; no other code builds a `.System` path by hand.

## The tree

```
~/Tetra/.System/<App>/<Kind>
  App:  Photos  Files  Notes  Calendar  Timer  Contacts  Phone  Maps  Office  Sync  Backups
  Kind: Data  Tools  Cache  Temp
```

The names are fixed. A folder is made only when something writes into it, so most do not exist yet.
A new app or kind is added to `system.js` and to this file first.

| Kind  | What it holds | Who may delete it |
|-------|---------------|-------------------|
| Data  | What the app keeps and needs: Maps' downloaded regions | Only the app itself, or the person. Never a cleaner. |
| Tools | Programs the app fetched: GraphHopper, pmtiles | Replaced by an update; never a cleaner. |
| Cache | What can be made again: Geofabrik's region list, the last build's log | A cleaner, any time (all of it, or by age or size). |
| Temp  | Work in progress | The job, when it ends (however it ended), and Tetra at every start. |

## In use now

| Folder | What | Was |
|--------|------|-----|
| `Maps/Tools` | `pmtiles`, `graphhopper-web-10.2.jar` (desktop routing needs the jar) | `~/Tetra-maps/bin` |
| `Maps/Data` | `osm/<id>.osm.pbf` and `osm/<id>.poly` (the builder's, for the borders step), `traces/` (drives pulled from the phone, for MapsTest), `greece-latest.osm.pbf`, `greece.poly` and the rest of `tools/maps-greece.sh`'s files | `~/Tetra-maps` |
| `Maps/Cache` | `geofabrik-index.json` (fetched again after a week), `build-<id>.log` | `~/Tetra-maps` |
| `Maps/Temp` | `<id>/`, one map being built | `~/Tetra-maps/<id>` |
| `Backups/Data` | `phone-before-*.tar`, the phone's app data saved before a risky install (developer sessions) | `~/Tetra-backups` |
| `Sync/…` | Reserved; nothing yet. Sync's partial files stay beside their targets (`.part`, renamed in place on the same disk), its state in `library.db`, the purgatory in `Tetra/.purgatory` on the server and on each drive | |

The first start of a version with `system.js` moves `~/Tetra-maps` and `~/Tetra-backups` in by renaming (never a copy,
never a delete); a move that cannot happen leaves both where they were and is logged as `[system] not moved`.

## What .System is kept out of

- **Sync.** Only `Tetra/Photos` and `Tetra/Files` sync; `.System` is beside them, never inside.
- **Drive backups.** They copy the library's photos and Files, not the Tetra folder.
- **Settings › Reset.** Its backup and its count leave `.System` out, and the reset keeps it: it holds tools and safety
  copies, not the library, and a reset never touched `~/Tetra-maps` or `~/Tetra-backups` before they moved here.
- **Files, search, the library scan.** They read `Tetra/Files` and `Tetra/Photos` only.
- Hidden: a dot-folder, so file managers do not show it.
