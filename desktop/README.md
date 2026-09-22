# Local Drive — desktop app

Electron + React + TypeScript. Plan and data model: [../SYNC_PLAN.md](../SYNC_PLAN.md).
The C++/Qt code in the parent folder is reference only.

- Photos: `~/Drive/Photos/`. The app only changes it when you confirm **Move to Trash**,
  which uses the system Trash (restore from the file manager).
- Files: `~/Drive/Drive/` (like the phone's `/sdcard/Drive/`); its Trash is `Drive/Trash/`.
- App data (SQLite `library.db`, thumbnails): `~/.local/share/local-drive-desktop/`
- Override for testing with disposable files: `DRIVE_PHOTOS=… DRIVE_FILES=… DRIVE_DATA=…`

```sh
npm ci
npm run dev      # Vite + Electron with reload
npm start        # production build + Electron
npm test         # node --test (library, files rules, timeline)
npm run check    # TypeScript
npm run dist     # release/*.AppImage and *.deb
```

Video thumbnails use the system `ffmpeg`. HEIC goes through libheif (`heic-decode`), since the bundled libvips has no HEVC. The AppImage needs `libfuse2`; the deb does not.
`node_modules/.bin/electron scripts/shot.js out.png [js]` renders the window offscreen (never shown) and captures it for visual QA
(`SHOT_CONSOLE=1` prints the page console).

## Code

| File | Role |
|---|---|
| `main.js` | Window, `media://` protocol (thumbs by hash, originals by id), IPC |
| `library.js` | Scan, SHA-256, EXIF, thumbnails, SQLite; favorites and collections (hash keys, UUIDs, tombstones); Trash |
| `src/App.tsx` | Rail, pages, search, actions (favorite, collect, trash) |
| `src/Timeline.tsx` | Week/Month/Year grid, touchpad pinch, multi-select |
| `src/Collections.tsx`, `src/Dialogs.tsx` | Collections page; native `<dialog>` confirm/name/picker |
| `files.js` | Files rules (root checks, verified copy, move/rename, Drive/Trash), tags, favorites, colours, recents |
| `src/Files.tsx` | Files browser, item sheet, destination/rename/tags/colour/properties dialogs |
| `faces.js` | People: YuNet detection + two-pass eye landmarks, MobileFaceNet embedding, phone quality/grouping rules, people/faces/reviews store |
| `src/People.tsx` | People grid, analysis bar, rename, combine (undo), Help organize |
| `places.js`, `data/places.tsv.gz` | Offline place names (GeoNames cities1000, CC BY 4.0) |
| `src/MapView.tsx` | Map (MapLibre + OpenFreeMap) with photo-thumbnail markers and clusters |
| `vault.js`, `src/Hidden.tsx` | Hidden: libsodium vault (Argon2id + secretstream), setup/unlock, hide/restore |
| `editor.js`, `src/Editor.tsx`, `src/edit.ts` | Editor: crop + straighten, rotate, markup; save copy with original EXIF (no re-encode) or replace via Trash |
| `documents.js` | Documents (PaddleOCR text detection → phone thresholds + coverage gate), scene labels (EfficientNet-Lite0), time of day |
| `models/` | ONNX models and their licences (`models/NOTICES.md`) |
| `src/Viewer.tsx` | Viewer: zoom/pan, keys, details, filmstrip |
| `src/timeline.ts` | Grouping and formatting |
