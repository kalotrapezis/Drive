# Local Drive v0.1.0-alpha.2

First GitHub desktop Alpha for short, controlled testing, superseding the earlier local alpha1 package. **Not a 1.0 release and not yet a replacement for Syncthing or your existing backups.**

## Platform and installation

- Ubuntu 26.04, amd64 (x86-64). This binary is not advertised as compatible with Ubuntu 24.04, other distributions, Windows or macOS.
- Download `local-drive_0.1.0~alpha2_amd64.deb` and verify it against `SHA256SUMS`.
- Install from the download directory: `sudo apt install ./local-drive_0.1.0~alpha2_amd64.deb`.
- Open **Local Drive Alpha** from the applications menu. The package serves the installed UI at `http://127.0.0.1:43172/` in your default browser. It needs neither Node/Vite nor the source checkout at runtime.
- Quit an older development backend before launching the installed version. Closing a browser tab does not stop the backend; use its tray menu to quit after transfers finish.
- No login autostart or automatic wireless receiver is enabled by this release. Android/Wi-Fi are outside this desktop test release.

## Included

- Drive browsing, per-item file actions, templates, local favorites and tags, recoverable system Trash integration.
- Photos/collections, the localized system Screenshots folder, selection toolbar and image viewing controls. External Screenshots are shown in place, not automatically imported or backed up.
- Sync dashboard, storage totals, connections, route previews and explicit transfer confirmation, reviewable Problems & Fixes.
- New: import preview, local tags, document scanner integration, QR decoding, and verified photo-library archive export.
- Bundled frontend and loopback API, protected local session actions, installed desktop entry and version identification.

## Test safely for a few days

1. Keep all existing backups and Syncthing configuration. Do not run both programs against the same test destination simultaneously.
2. Use a small **copy** of a folder containing photos, Unicode filenames, subfolders and a few documents. Start with **Copy**, not Move/cleanup, and a new destination folder.
3. Preview/import; check counts and file contents. Repeat the preview to check existing identical files/conflicts. Keep conflict decisions explicit.
4. Try rename, favorites/tags, sorting and Trash with disposable copies; restore through the system file manager.
5. Check restart, reconnect and pending-transfer notices. Do not deliberately unplug during a transfer involving the only copy of any file.
6. Report the app version, action, expected/actual result, error text and whether a device was disconnected. Do not include private photos or credentials in public issues.

## Known limitations

- Real-device interruption, full-disk, restart/recovery, hub-forwarding and cleanup acceptance is incomplete. Passing automated tests does not certify migration safety.
- Folder copy is unavailable. Large single-file copy may temporarily block the interface. Cross-device transfer uses the Sync workflow, not the within-library move action.
- Favorites/tags are local; they do not synchronize across devices or reliably follow external renames/Trash restoration.
- Photos search/sort/collections operate on loaded pages; loading another page scans the directory again. File dates are not guaranteed EXIF capture dates.
- Photo archive creation requires Python 3.14+ and verifies its ZIP64/Zstandard content. In-app archive browsing/extraction is still missing. Export progress is not persistent across backend restarts; abrupt shutdown may leave an incomplete `.partial` file. Originals remain unchanged.
- Camera/document-scanner hardware was not acceptance-tested. Native editing/scanning requires a supported installed application. GPS metadata uses Pillow; map loading is opt-in and sends coordinates to OpenStreetMap. No reverse-geocoded place grouping is implemented.
- Browser video playback is not implemented; videos open in the desktop player. Some image formats may not have thumbnails.
- The legacy QML frontend remains accessible with `--legacy-ui`, but is not the default desktop entry and is not the approved UI.
- Intended for a trusted, single-user workstation. Loopback Host/Origin checks prevent remote-web origin access; they are not an authentication boundary against malicious processes or other untrusted accounts on the same machine. Do not expose or proxy the service onto a network.

## Data and removal

The package does not contain a personal catalog, phone data, screenshots or secrets. The local catalog normally lives in `~/.local/share/local-drive/`; configured library folders and system Trash are separate. Back up the catalog directory while the app is stopped before testing against an existing setup.

Remove the application with `sudo apt remove local-drive`. Removal does not intentionally delete your library folders, local catalog, or Trash. Do not delete these manually unless you intend to remove your data.

## Build

Use the committed npm lockfile (`cd web && npm ci`), then `cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr`, `cmake --build build-release -j4`, `ctest --test-dir build-release --output-on-failure`, and `cpack --config build-release/CPackConfig.cmake -B build-release`.

Node/npm, Qt/KDE development libraries, CMake and the compiler are build-only requirements. The `.deb` declares its runtime dependencies.
