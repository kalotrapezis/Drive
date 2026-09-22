# Local Drive — desktop app

Electron + React + TypeScript. Plan and data model: [../SYNC_PLAN.md](../SYNC_PLAN.md).
The C++/Qt code in the parent folder is reference only.

- Photos: `~/Drive/Photos/`. The app only changes it when you confirm **Move to Trash**,
  which uses the system Trash (restore from the file manager).
- App data (SQLite `library.db`, thumbnails): `~/.local/share/local-drive-desktop/`
- Override both for testing with disposable files: `DRIVE_PHOTOS=… DRIVE_DATA=…`

```sh
npm ci
npm run dev      # Vite + Electron with reload
npm start        # production build + Electron
npm test         # node --test (library scan, timeline grouping)
npm run check    # TypeScript
npm run dist     # release/*.AppImage and *.deb
```

Video thumbnails use the system `ffmpeg`. The AppImage needs `libfuse2`; the deb does not.
`node_modules/.bin/electron scripts/shot.js out.png [js]` captures the window for visual QA.

## Code

| File | Role |
|---|---|
| `main.js` | Window, `media://` protocol (thumbs by hash, originals by id), IPC |
| `library.js` | Scan, SHA-256, EXIF, thumbnails, SQLite; favorites and collections (hash keys, UUIDs, tombstones); Trash |
| `src/App.tsx` | Rail, pages, search, actions (favorite, collect, trash) |
| `src/Timeline.tsx` | Week/Month/Year grid, touchpad pinch, multi-select |
| `src/Collections.tsx`, `src/Dialogs.tsx` | Collections page; native `<dialog>` confirm/name/picker |
| `src/Viewer.tsx` | Viewer: zoom/pan, keys, details, filmstrip |
| `src/timeline.ts` | Grouping and formatting |
