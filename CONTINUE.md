# Continue Tetra (desktop + phone)

Updated: 2026-09-23. The same text starts `Drive/CONTINUE.md` and
`Drive-Android/CONTINUE.md`. The plan with every phase's status is
[SYNC_PLAN.md](SYNC_PLAN.md) (identical in both repos; edit one, copy it).

## The product

A personal Google Photos + Google Drive, now called **Tetra**: the Android app
(`Drive-Android`, branch `alpha`) and an Electron desktop app (`Drive/desktop/`,
branch `electron-desktop`) with the same features and data model, syncing 1:1
over Wi-Fi. The old C++/Qt code in `Drive/` is reference only.

## Where things stand

- **Phases 0–6 done.** Sync is complete for Photos: blobs (QR pairing, `/have`,
  `/blob/<sha256>`), then **documents, favorites, collections and their
  membership, search labels, people's names and the face → person grouping**,
  both ways, over one `/metadata` endpoint. See SYNC_PLAN.md's "### 6. Sync"
  for the design, the answer to "do the two apps need different models?" (no,
  and nothing needs translating), and what was deliberately left out.
- **Verified against the real library on 2026-09-23**, not just in tests: the
  phone synced into a copy of the real desktop database and it arrived with 34
  named people, 456 faces, 2 favorites, 6707 labels, 18 documents. Of the
  phone's 387 faces, 54 landed on a face the desktop had already found and
  joined the phone's person instead of being duplicated.
- **Renamed to Tetra** on both apps, with the new icon
  (`Assets/Icons/New Icons/New/icon-Black.png` — the black one, as asked). The
  phone gets an adaptive launcher icon (the cube on the artwork's own dark
  ground); the desktop gets `desktop/public/icon.png`. Identifiers were left
  alone on purpose: the Android package is still `com.kalotrapezis.drive`, the
  desktop data dir still `~/.local/share/local-drive-desktop`, and the vault's
  `local-drive-vault-v1` marker is untouched — renaming any of those would
  orphan the real library or make Hidden undecryptable.

## Next steps, in order

1. **A monochrome (themed) launcher icon.** Android 13+ can tint an icon to the
   wallpaper if the adaptive icon carries a `<monochrome>` layer. The current
   artwork cannot become one automatically — flattening the three coloured cube
   faces to a silhouette loses the glyphs that make it readable. It needs a
   one-colour version drawn from the PSDs, then it is one line in
   `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`. The white icon variant
   is not used yet either; decide what it is for (desktop tray? light theme?).
2. **Resolve the 80-vs-93 video gap** (still open from the last session). Check
   the phone's Sync screen for per-file failure cards — if videos are listed
   there, that is the answer (retry, or look at the 4 s connect / 120 s read
   timeouts in `SyncClient.kt` `open()`, the likeliest culprits for big
   uploads). If nothing failed, the gap is probably duplicate-content dedup
   (identical bytes in two folders make one receipt, which is correct).
3. **Dynamic Island on Android (Xiaomi HyperOS) — started, not finished.** Use
   `io.github.d4viddf:hyperisland_kit:0.4.0` (Apache-2.0, Maven Central; the
   real source was checked, not just the README). API:
   `HyperIslandNotification.isSupported(context)`,
   `Builder(context, businessName, ticker)`, `.setBaseInfo(title, content)`,
   `.setProgressBar(0..100)`, `.buildResourceBundle()` →
   `NotificationCompat.Builder.addExtras(...)`, `.buildJsonParam()` →
   `extras.putString("miui.focus.param", json)`. **Not yet done:** the Gradle
   dependency, then wiring it additively into `SyncService.kt`'s
   `notification()` — keep the plain `NotificationCompat` working everywhere and
   only add the extras when `isSupported()`, inside `runCatching`.
4. **Sync on change, not only on "Back up now".** The user's standing request:
   "open a file on the phone, find it in Recent on the computer". `SyncService`
   already runs unattended once started; nothing starts it on a file change.
   Needs a decision on battery and mobile-data trade-offs first.
5. **Files sync at all.** Tags, favorites, colours and recents in the Files
   module are outside the protocol on both sides — they use path identity, not
   content hashes, so they need their own design pass rather than another array
   on `/metadata`.
6. **Hand-written photo tags.** Neither app has them (in Photos, "tags" are the
   AI labels; only Files has hand-made tags). A new feature on both sides, not a
   sync gap — do not treat it as one.
7. **Multiple paired devices** — deferred, see SYNC_PLAN.md phase 8.
   `SyncStore`'s pairing is one flat record and `receipts` is not per-device.

## Where to look first

- `SYNC_PLAN.md` (both repos, identical) — the authoritative phase list, the
  protocol, and the reasoning behind the face/label decisions.
- `mistakes.md` (`Drive/`) — the document-detection lesson; read before touching
  `desktop/documents.js` again.
- Face boxes are the sharp edge of the protocol: they travel as fractions of the
  **upright** photo, and MediaStore reports sizes as the file stores them. The
  EXIF quarter-turn is undone in `listGalleryMedia`. Getting that wrong puts
  boxes outside the photo and silently stops every face from matching.
