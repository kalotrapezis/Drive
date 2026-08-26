# Local Drive

Local-first Linux and Android file/photo transfer project.

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
can later drain with `verified-copy`. All are Copy-only; phone cleanup remains
later. `wireless-beacon` broadcasts a candidate-only discovery packet to the
Linux app on UDP port 43170; it does not pair or authorize transfers.
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

For a local build, use the installed Android SDK and Java 17:

```sh
ANDROID_HOME=/home/teo/Android/Sdk \
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
PATH=/usr/lib/jvm/java-17-openjdk-amd64/bin:$PATH \
/home/teo/Έγγραφα/Claude/Coding/Notes-Android/gradlew -p android assembleDebug --no-daemon
```

The generated APK and Gradle state are deliberately ignored and are not an
Alpha release package.
