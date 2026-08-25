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
`wireless-simulate` deliberately uses the same verified path with a
`wireless:` catalog identity for deterministic interruption/retry testing; it
does not discover a phone or open a LAN listener. `--staging-max-bytes` is per-job for local commands and a total on-disk
cap for `verified-stage-dir`.

The setup route also remembers an optional laptop staging folder. It must already
exist and cannot overlap the source or final destination; saving the route never
creates, moves, or deletes files there.

The desktop surface exposes `Ctrl+R` (refresh), `Ctrl+S` (save route), `Ctrl+Enter`
(start the selected previewed route), and `Esc` (stop an active transfer); the terminal utility remains the complete keyboard-first
surface for verified transfers.
