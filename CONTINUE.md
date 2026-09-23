# Continue Tetra (desktop + phone)

Updated: 2026-09-23. The same text starts `Drive/CONTINUE.md` and
`Drive-Android/CONTINUE.md`. The plan with every phase's status is
[SYNC_PLAN.md](SYNC_PLAN.md) (identical in both repos; edit one, copy it).

## The product

A personal Google Photos + Google Drive, called **Tetra**: the Android app
(`Drive-Android`, branch `alpha`) and an Electron desktop app (`Drive/desktop/`,
branch `electron-desktop`) with the same features and data model, syncing 1:1
over Wi-Fi. The old C++/Qt code in `Drive/` is reference only.

## Where things stand

- **Phases 0–6h done.** Photos (blobs, documents, favorites, collections,
  labels, people and faces), Files (tags, favorites, colours, recents, and the
  files themselves including Trash moves), the settings that describe the
  library, syncing without being asked, and Trash on both sides.
- **Files has multi-selection** on the phone: long-press to start, and the
  navigation island trades places with an actions island offering Share, Copy,
  Move, Tags, Favorites and Trash (or Restore in Trash).
- **Trash is one idea in three places** — see SYNC_PLAN phase 6h. Photos has a
  Trash system collection on both apps; the Files `Drive/Trash/` folder is no
  longer listed as a folder on either.
- **Renamed to Tetra** with the new black icon on both apps. The Android
  package, the desktop data dir and the vault's `local-drive-vault-v1` marker
  deliberately keep the old name — renaming any of them orphans the real
  library or makes Hidden undecryptable.
- Phone schema is **v16**; verified on the real phone after each migration
  (97 people, 387 faces, 2 favorites, 18 documents, integrity ok).

## Next steps, in order

1. **Computer → phone.** The phone is the client in this protocol, so a file or
   a photo created on the computer waits for the phone to ask, and opening the
   desktop app cannot start a sync. Closing that needs the computer to announce
   itself (mDNS) and the phone to listen. This is the biggest remaining gap and
   the one the "sync when I open the desktop app" request really needs.
2. **A monochrome (themed) launcher icon.** Android 13+ tints an icon to the
   wallpaper given a `<monochrome>` layer. The cube cannot be flattened to a
   silhouette without losing the glyphs, so it needs a one-colour drawing from
   the PSDs; then it is one line in `mipmap-anydpi-v26/ic_launcher.xml`. The
   white icon variant is still unused — decide what it is for.
3. **Folders as albums** (SYNC_PLAN phase 7, and the "phone scanning and adding
   new folders as user collections" request). Find folders with media outside
   Camera/Screenshots, offer each in Help organize, make a Yes into an album.
   Nothing about this is built yet.
4. **The 80-vs-93 video gap**, still open from 2026-09-22. Check the Sync
   screen's per-file failure cards first; if nothing failed it is probably
   duplicate-content dedup, which is correct behaviour.
5. **Hand-written photo tags.** Neither app has them — in Photos, "tags" are
   the AI labels; only Files has hand-made tags. A new feature on both sides,
   not a sync gap.
6. **Multiple paired devices** — deferred, SYNC_PLAN phase 8.

## Things worth knowing before changing sync

- **Face boxes** travel as fractions of the **upright** photo. MediaStore
  reports sizes as the file stores them, so the EXIF quarter-turn is undone in
  `listGalleryMedia`. Getting that wrong puts boxes outside the photo and
  silently stops every face from matching — it cost a full debugging round.
- **A move is only a move when the phone actually made one.** Same bytes at a
  different path is not enough: without remembering the phone's last manifest,
  the computer reorganises its own Drive to match the phone. `sync_manifest`
  holds that memory, and the first sync with a device moves nothing.
- **The service clears its result when it stops**, so a failure that happens at
  the very end of a backup leaves no card behind. The desktop now logs any
  request it refuses without telling the phone why; check the desktop console
  before assuming the phone is at fault.
- **A guard that refuses quietly is worse than one that fails.** "Wi-Fi only"
  asked the active network, a VPN answered "no idea", and every automatic sync
  was off for a night without a word. When a rule can be wrong about the
  network, log it or show it.
- `mistakes.md` (`Drive/`) — the document-detection lesson; read before
  touching `desktop/documents.js`.
