# Local Drive

Local-first Linux and Android file/photo transfer project.

## Desktop Alpha

Current release: **v0.1.0-alpha.2**, Ubuntu 26.04 amd64. See [release notes and safe testing instructions](RELEASE_NOTES.md). This is an early test build, not a Syncthing replacement. The installed applications-menu entry opens the bundled React UI; no development server is needed. Use `--legacy-ui` only to open the old QML interface.

## Desktop development preview

Run `./build/local-drive --web-only` for the loopback API without the legacy QML window or automatic wireless startup, then `npm run dev -- --host 127.0.0.1` in `web`. Open `http://127.0.0.1:5173/` for real data; `?fixture` is an explicitly simulated preview.

Photo-library export requires Python 3.14+ (ZIP64/Zstandard). It creates a verified, non-overwriting `.ldrive` snapshot; in-app archive browsing/extraction is not implemented yet. Document scanning uses an installed Skanpage, Simple Scan or Skanlite; Trash restoration uses the desktop file manager. See `RELEASE_NOTES.md` for release gates and remaining limitations.

## Project documents

- `Intent.md` — original product intent.
- `Plan.md` — complete product and architecture plan.
- `SPEC.md` — scoped implementation specification for version 0.1.

## Design assets

- `design/pixelruller/` — canonical editable PixelRuller JSON designs.
- `design/mockups/` — generated desktop UI directions.
- `design/logo/` — generated flower-logo concepts.
- `design/references/` — original hand-drawn UI and logo sketches.

The canonical project root is this directory. Files in the separate PixelRuller
workspace and Codex generation folders are retained only as source copies; new
Local Drive work belongs here.

## First CLI transport and M1 verified-file slice

After building, the copy-only utility can inspect one bounded MTP directory and
copy into a local directory while printing live progress:

```sh
./build/local-drive-cli mtp-inventory 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/DCIM/'
./build/local-drive-cli --scan-max-items 100000 --scan-max-bytes 68719476736 \
  mtp-scan 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/SyncThing/Εκπαίδευση/'
./build/local-drive-cli --log-file /tmp/local-drive.log \
  copy 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/DCIM/example.jpg' /tmp/import/
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  verified-import 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/DCIM/example.jpg' /tmp/import/
./build/local-drive-cli --catalog-file /tmp/local-drive-wireless.sqlite \
  wireless-simulate 'file:///tmp/simulated-phone/example.jpg' /tmp/import/
./build/local-drive-cli wireless-beacon 'wireless:sim-phone' 'Simulated phone' '127.0.0.1:43171'
./build/local-drive-cli wireless-discover 60
./build/local-drive-cli wireless-profile-export /tmp/server-profile.json 192.168.1.20 43171 server.crt SERVER_SHA256_FINGERPRINT
./build/local-drive-cli wireless-profile-accept /tmp/android-pairing.json client.crt
./build/local-drive-cli --catalog-file /tmp/local-drive-wireless.sqlite \
  wireless-receive /tmp/import/ server.crt server.key client-ca.crt CLIENT_SHA256_FINGERPRINT 43171
./build/local-drive-cli wireless-send /tmp/simulated-phone/example.jpg localhost 43171 \
  client.crt client.key server-ca.crt 'wireless:sim-phone' 'Simulated phone'
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  --scan-max-items 1000 --scan-max-bytes 1073741824 \
  verified-import-dir 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/DCIM/Camera/' /tmp/import/
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  --staging-max-bytes 1073741824 \
  verified-stage-dir 'mtp:/Xiaomi 15/Εσωτ. κοινόχρ. αποθ. χώρος/DCIM/Camera/' /tmp/incoming/
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  verified-copy /tmp/incoming/ /path/to/external/Local\ Drive/Drive
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  verified-preview /path/to/source /path/to/external/Local\ Drive/Drive
./build/local-drive-cli --catalog-file /tmp/local-drive.sqlite \
  verified-copy /path/to/source /path/to/external/Local\ Drive/Drive
./build/local-drive-cli --staging-max-bytes 1073741824 \
  verified-preview /path/to/source /path/to/staging
```

The `verified-*` commands use the same M0 `VerifiedCopy` engine as the desktop
surface, including SQLite receipts, independent verification, and live
progress. `verified-import` is the first M1 slice: one MTP/file URL is streamed
through KIO, independently hashed, published without overwrite, and recorded
as an `mtp` source plus verified destination receipt. `verified-import-dir`
first performs a bounded recursive preview, then reuses that single-file path
for each item. `verified-stage-dir` uses the same receipt path into an explicitly
chosen laptop staging root, checks total on-disk occupancy before intake, and
can later drain with `verified-copy`. `verified-export LOCAL_FILE MTP_FILE_URL`
copies one local file into the phone's fixed `Drive/`, verifies it, and records
the receipt without overwriting a conflict. All commands retain their source;
phone cleanup remains later. `wireless-beacon` broadcasts a candidate-only discovery packet to the
Linux app on UDP port 43170; it does not pair or authorize transfers.

The local web Sync panel also starts the same bounded directory importer for the
phone's fixed `Drive/` and `DCIM/` roots when the matching backup storage is
mounted. Sources are retained; progress and terminal results remain visible in
the local catalog-backed UI.
`wireless-discover [SECONDS]` is the keyboard-first diagnostic listener for
that same port: it prints one `DEVICE ONLINE` line per stable identity and
reports an identity Offline after 15 seconds without a beacon.
`wireless-simulate` deliberately uses the same verified path with a
`wireless:` catalog identity for deterministic interruption/retry testing; it
retains a bounded `.local-drive-partials/*.partial`, verifies the acknowledged
prefix before resuming, and does not discover a phone or open a LAN listener.
`wireless-receive` and `wireless-send` exercise the real Alpha LAN gate: TLS 1.3,
mutual certificate verification with a pinned client fingerprint, acknowledged
chunk offsets, and final `VerifiedCopy` catalog receipts. They require PEM
certificates/keys supplied by the caller; no key material is stored in SQLite.
`wireless-profile-export` writes only the receiver host, port, public server
certificate, and its SHA-256 fingerprint to a JSON profile for the Android app.
After the Android app shares its public pairing JSON, `wireless-profile-accept`
validates the certificate/fingerprint pair and writes the client certificate for
use as the receiver CA. Private keys never enter either profile.
`--staging-max-bytes` is per-job for local commands and a total on-disk
cap for `verified-stage-dir`.

The setup route also remembers an optional laptop staging folder. It must already
exist and cannot overlap the source or final destination; saving the route never
creates, moves, or deletes files there.

The desktop surface exposes `Ctrl+R` (refresh), `Ctrl+S` (save route), `Ctrl+Enter`
(start the selected previewed route), and `Esc` (stop an active transfer); the terminal utility remains the complete keyboard-first
surface for verified transfers.

## Android discovery companion (Alpha source only)

The minimal Android module under `android/` provides the foreground
candidate-discovery beacon, a Keystore-backed client identity, pairing-profile
import/export UI, and a foreground `WirelessSender` transfer service. The
beacon broadcasts every five seconds; the sender implements the Alpha Linux
framing, resumable chunks, TLS 1.3, receipt verification, and bounded reconnect
retry. The Linux listener remains the source of truth for device identity and
trust; the desktop app exposes the receiver configuration, validated profile
export, Android public-certificate acceptance, and live log in Settings, remembers
the setup locally, and restarts the receiver only when the user has left it enabled.
After one persistable system permission for each fixed root,
the Android Alpha service scans `Drive/` and `DCIM/`, sends new/changed files to
`Drive/` or `Photos/`, records them only after a receipt, and restores the
foreground beacon and sync after reboot when the saved setup is complete. The
emulator smoke test also verifies fixed-root setup, receipt-backed automatic
retry, matching SHA-256, and no duplicate upload after service restart. A
real-phone run is still pending.

Android now mirrors the desktop's four primary sections in fixed bottom
navigation: Sync & Connections, Drive Files, Photos & Videos, and New +. The
existing pairing, dashboard, Problems & Fixes, root setup, auto-sync, and manual
send actions are preserved in those sections. Emulator view-tree checks prove
selection changes all four pages and that system bars no longer cover content;
physical-phone visual and transfer validation remains pending.

For a local build, use the installed Android SDK and Java 17:

```sh
ANDROID_HOME=/home/teo/Android/Sdk \
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
PATH=/usr/lib/jvm/java-17-openjdk-amd64/bin:$PATH \
/home/teo/Έγγραφα/Claude/Coding/Notes-Android/gradlew -p android assembleDebug --no-daemon
```

The generated APK and Gradle state are deliberately ignored and are not an
Alpha release package.

The wireless sender now publishes one metadata-only delta for each discovered
Drive/DCIM item before sending its bytes. Linux stores the delta in the shared
SQLite pending catalog, advances a per-device contiguous cursor safely across
retries/out-of-order delivery, and acknowledges the current pending file/byte
summary; no content bytes are included in that preflight frame.
The same bounded acknowledgement returns active Problems & Fixes work and a
read-only dashboard snapshot for Android: pending totals, transfer progress,
device status, storage capacity, and recent per-file locations with SHA-256
receipt state. Location pages use a stable cursor and Android provides
Latest/Older navigation with verification filters. Android decisions return through this
heartbeat and are accepted only while their evidence hash still matches.
Problems & Fixes can queue the first device-side correction: a read-only
location recheck. Immutable schema-v16 requests link back to the review and
carry expected/observed size and SHA-256. Pending and completed outcomes appear
in desktop and Android history; no remote file mutation is implemented.

Drive Files supports read-only nested-folder navigation. Every requested folder
is canonicalized beneath the configured Drive root; traversal and external
symlink targets are rejected before a listing is returned. The details panel
can open a selected regular file through a per-launch-token endpoint with the
same root confinement. Photos & Videos reuses that contract for selected media;
Move and Share remain explicitly disabled.

Recent Files is a bounded read-only projection of the existing managed Drive
inventory, ordered by modification time. It never rescans on demand and never
mixes Photos-route items; unsupported sidebar collections remain disabled.
The Details inspector in Drive and Photos also exposes a bounded, read-only
Activity tab from append-only transfer history. Requests are confined to an
existing regular file under the selected managed root before catalog lookup.
Drive Settings shows saved routes, devices, catalog revision, storage presence,
and transfer-safety rules. It can also create a missing Drive or Photos route
through the same native setup validation; replacing an existing root remains
blocked until the migration review is implemented. Each available route can run
the existing verified, non-mutating preview and reports files, bytes, bytes to
transfer, identical items, and conflicts before transfer is enabled.
Transfer accepts only that exact successful preview ID. It copies and verifies
through the existing engine; Move policies stop at recoverable Cleanup pending,
so this action never removes the source. The same card exports the exact preview
as a JSON manifest and shows the latest eight append-only route history events.
Active transfers expose Pause, Resume, and Cancel. Cancel wakes a paused worker,
records failure/cancellation, retains the source, and requires a fresh Preview
before another transfer.
New + can create a folder in the current Drive location. The write requires the
per-launch session token, rejects traversal/control characters and collisions,
never overwrites an existing item, and refreshes the current folder afterward.
New + is now a real fourth desktop tab rather than a dropdown. Its workspace
keeps New folder and Import existing folder visible, carries the last browsed
Drive location into folder creation, and labels unimplemented Add file, Scan,
and Sync tasks as unavailable instead of pretending they work.

Sync & Connections includes the first shared relationship map, built with
React Flow from the same API state as the surrounding cards. It renders known
devices → local catalog → storage edges, labels Drive/Photos routes, and
distinguishes online/available from last-reported nodes without changing setup.

## Linux Alpha package

Build and verify the native Debian test package without installing it:

```sh
cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
cmake --build build-release -j2
ctest --test-dir build-release --output-on-failure
cpack --config build-release/CPackConfig.cmake -B build-release/packages
dpkg-deb --info build-release/packages/local-drive_0.1.0~alpha1_amd64.deb
```

The package installs `local-drive`, the diagnostic `local-drive-cli`, its
desktop launcher, icon, and licence. CPack derives native library dependencies;
the dynamically loaded Qt/Kirigami QML modules are declared explicitly.
