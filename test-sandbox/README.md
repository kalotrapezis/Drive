# Local transfer sandbox

This directory is a non-destructive simulation. It contains copies of project
assets only; no phone or external-disk files were used.

## Simulated routes

- `android/DCIM/Camera/` → `pc/Local Drive/Gallery/2026/`
- `android/DCIM/Screenshots/` →
  `pc/Local Drive/Gallery/Screenshots/2026/`
- `android/Local Drive/Drive/` → `pc/Local Drive/Drive/`

The five destination files were copied with rsync partial-file support and then
independently checked with SHA-256. Every source/destination pair matched. A
second checksum dry-run reported no changes, demonstrating an idempotent repeat
for this small fixture.

This validates the proposed folder layout and basic copy tooling only. It does
not yet validate the application's transfer journal, crash recovery, MTP, Trash,
or verified Move behavior.
