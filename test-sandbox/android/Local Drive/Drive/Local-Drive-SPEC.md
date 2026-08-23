# Local Drive 0.1 — Implementation Specification

Status: Draft for approval  
Date: 2026-08-22  
Source: `Plan.md`

## 1. Release objective

Version 0.1 solves the immediate storage problem safely on Linux:

1. Move or copy ordinary files from a local folder to one exact external
   HDD/SSD.
2. Import new files from an Android phone connected in USB File transfer/MTP
   mode.
3. Prove every destination copy before any source cleanup.
4. Retain a readable history of what moved, where it is now, and what failed.

The release has two sequential milestones:

- **M0 — Verified Linux mover:** local folder → mounted external disk.
- **M1 — One-click MTP import:** Android phone → configured destination or
  bounded laptop staging.

M0 is usable without M1. M1 may start only after M0 passes its safety gate.

## 2. Non-goals for 0.1

- Android application and wireless transfer;
- bidirectional continuous synchronization;
- deletion propagation or tombstones;
- remote access, cloud relay, accounts, or internet exposure;
- perceptual duplicate detection, faces, OCR, or semantic search;
- compressed `.ldrive` libraries;
- photo editing or full Gallery implementation;
- Windows, macOS, and iOS;
- automatic duplicate cleanup;
- app-level encryption of ordinary files.

These are deferred, not silently approximated.

## 3. Safety invariants

The implementation is unacceptable if any invariant can be violated.

1. Copy is the default. Move requires an explicit choice for that job.
2. Move means verified copy followed by source cleanup; it is never a direct
   rename across devices and never uses `rsync --remove-source-files`.
3. A source is not removed until the independently read destination SHA-256 and
   size match the source values and the catalog commit succeeds.
4. A filename match is not content verification.
5. An offline or missing location is never treated as deletion or verification.
6. No different file is silently overwritten.
7. A wrong disk with the same label or mount path is rejected.
8. A crash, cancellation, disconnect, full disk, or hash mismatch leaves the
   source intact.
9. A retry is idempotent: an already verified result is recognized.
10. Cleanup is recoverable through the platform Trash where supported. If the
    source backend cannot provide reliable recoverable cleanup, the job finishes
    as Copy and produces a separately confirmed cleanup list.
11. Files remain ordinary files that other applications can open.

## 4. Supported environments

### Linux desktop

- Initial target: current Kubuntu/KDE Plasma installation.
- Language: C++20.
- UI: Qt 6, QML, Kirigami, KDE/Breeze theme roles.
- Build: CMake with Extra CMake Modules.
- Catalog: SQLite through Qt SQL.
- Mounted storage/device discovery: Solid plus mount information.
- File, MTP, preview, and Trash integration: KIO where supported.
- Metadata: KFileMetaData where useful; metadata extraction must not block the
  transfer safety path.
- Secrets are not required for M0/M1 cable operation.

Development packages are installed only when implementation begins and only
with explicit user approval.

### Android phone for M1

- Unlocked Android device.
- USB mode selected as **File transfer / MTP**.
- The Linux side controls import; no Android application is required for M1.
- Real-device behavior is a release gate, not inferred from installed plugins.

## 5. User-visible terminology

Direction and behavior remain separate concepts:

- **Copy:** copy and verify; keep the source.
- **Move:** copy and verify; then offer/perform approved source cleanup.
- **Sync:** deferred from 0.1.
- **Import new files from phone:** scan configured MTP folders and propose only
  items not already verified in the catalog.

The UI must never label a Move as Backup.

## 6. M0 user flow — verified Linux mover

### 6.1 First setup

1. Select a source folder.
2. Attach and select the destination disk and destination folder.
3. Record the strongest available stable disk identity, friendly label, mount,
   filesystem type, and selected root.
4. Choose Copy or Move; Copy is preselected.
5. Optionally set:
   - staging maximum;
   - minimum laptop free-space floor;
   - organization of otherwise unfiled photos into `Photos/<year>/`.
6. Save the route.

No path is hardcoded in the application or this specification.

### 6.2 Preview

Before starting, show:

- source and exact destination device/folder;
- Copy or Move;
- file count and logical total size;
- destination free space and required safety margin;
- already-present identical files;
- same-path/different-content conflicts;
- unreadable items and unsupported source types;
- estimated organization changes, if enabled.

Start remains disabled when the exact destination is absent, space is
insufficient, the source is inside the destination, or paths escape the saved
roots.

### 6.3 Execution

For every regular file:

1. Open the source read-only and record size and modification time.
2. Resolve the destination relative path without following an escaping symlink.
3. If a completed destination candidate exists, hash it and reuse it only when
   size and SHA-256 match.
4. Otherwise write beside the final path as a uniquely named `.partial` file.
5. Calculate source SHA-256 while streaming the source.
6. Flush the completed partial file.
7. Reopen and independently calculate destination SHA-256.
8. Recheck that the source size and modification time did not change.
9. If both hashes and sizes match, atomically rename the partial file to its
   final name where supported.
10. Commit the verified location and history event in SQLite.
11. For Move, send the source to platform Trash only after step 10. If Trash is
    unavailable or unreliable for that source, retain it and add it to the
    cleanup review.

Directory creation is allowed only below the selected destination root.

### 6.4 Interruption and retry

- Persist job and per-file state after each meaningful transition.
- On restart, recheck partial length and committed state before resuming.
- M0 may restart a file from zero if a safe partial-resume spike fails; it must
  explain this and keep the source.
- Cancel stops scheduling new files, allows the current bounded write to stop
  safely, and never triggers source cleanup for an incomplete file.
- A completed verified file is skipped on retry.

## 7. M1 user flow — one-click MTP import

### 7.1 Device setup

1. Detect an unlocked MTP phone exposed through KDE/KIO.
2. Save its stable available identity and friendly name.
3. Let the user choose one or more source folders, initially suggesting:
   - `DCIM/Camera`;
   - Screenshots;
   - Downloads.
4. Save a preferred final destination route and bounded staging policy.

The Android app is not required or opened.

### 7.2 Import preview

When the phone returns, show **Import new files from phone**. Scanning produces:

- new items;
- already verified items;
- exact duplicates at another known path;
- same-path/different-content conflicts;
- unavailable or unreadable items.

If the configured external disk is present, import directly to it. If absent:

- use laptop staging only within both configured limits; or
- leave the item on the phone and mark it waiting.

The user chooses **Copy new** or **Move new**. Copy is preselected.

### 7.3 MTP transfer and cleanup

- Stream each MTP object into a destination `.partial` file while hashing.
- Independently hash the completed destination.
- Record a verified receipt before cleanup eligibility.
- If reliable MTP deletion cannot be proven for the specific phone/backend,
  complete as Copy and show a separately confirmed cleanup list.
- Disconnecting the phone leaves all unverified sources untouched.
- Running the same import twice must not create duplicate files or report
  verified files as new.

## 8. Conflict behavior

For M0/M1:

- same relative path and same SHA-256: **Already present**;
- same relative path and different SHA-256: **Conflict**;
- same SHA-256 at another path: **Exact duplicate**, no automatic deletion;
- different file requiring the same organized path: deterministic safe suffix
  or explicit review, never overwrite.

Allowed decisions are Keep source name with safe rename, Keep existing, Keep
both, or Save for review. An **Apply to matching items** rule is limited to the
current job and must preview its exact match condition and affected count.

## 9. Photo organization in 0.1

Organization is optional and off by default for general file routes.

When enabled for a photo route:

1. Preserve meaningful source collections/folders.
2. Place otherwise unfiled media in `Photos/<year>/`.
3. Choose year from EXIF capture time, then available media date, then file
   modification time.
4. Use `Photos/Unknown date/` when no trustworthy date exists.
5. Change paths only; never rename original filenames in 0.1.
6. Preserve sidecars and unknown metadata rather than rewriting media.

Google Takeout import is not implemented in 0.1. A later importer must reuse the
already-proven Takeout normalizer and its SHA-256/sidecar handling.

## 10. Catalog

SQLite is an index and journal; file content remains on the filesystem.

### 10.1 Minimum entities

**Storage**

- internal ID;
- kind: local, removable, or MTP;
- strongest available stable identity;
- friendly name, filesystem type, selected root;
- present state, last seen, last verified.

**Route**

- source storage/root;
- destination storage/root;
- behavior: Copy or Move;
- staging limits;
- photo organization setting;
- enabled state.

**Content**

- SHA-256, size, media/type hint;
- best-known created/captured/modified timestamps.

**Location**

- content ID, storage ID, relative path;
- state: partial, present, verified, trashed, deleted, unknown;
- last seen and last verified.

**Job and item**

- stable IDs;
- route and requested behavior;
- source/destination paths;
- state, byte progress, expected size/hash when known;
- created, updated, and completed timestamps;
- error code and safe human explanation.

**History event**

- queued, copying, verifying, verified, moved, trashed, conflict, failed,
  cancelled, retried;
- job/item, source, destination, time, and result.

### 10.2 Transaction boundary

Publishing a destination and recording its verified location must recover to one
explainable state after a crash. Cleanup is a later recorded transition; it is
never part of an unlogged side effect.

## 11. Job state model

```text
Queued
  → Copying
  → Verifying
  → Verified
  → Cleanup pending   (Move only)
  → Complete

Any active state → Paused | Cancelled | Conflict | Failed
Failed/Paused/Conflict → Queued after an explicit or safe retry
```

`Complete` for Copy requires a committed verified location. `Complete` for Move
requires the same plus a recorded source cleanup result. If cleanup is deferred,
the copy remains safe and the job says **Cleanup pending**, not Complete.

## 12. Error model

Errors use stable machine codes plus plain user text. Minimum codes:

- source unavailable or changed;
- destination unavailable or wrong device;
- insufficient space or staging limit;
- permission denied;
- name conflict;
- read error or write error;
- destination hash mismatch;
- unsupported Trash cleanup;
- MTP disconnected or object unavailable;
- catalog commit/recovery error.

Every error states whether the source is safe and the next available action.
Private filenames are excluded from diagnostic export unless the user opts in.

## 13. Minimal Linux UI for 0.1

The approved visual direction is represented by:

- `design/pixelruller/LocalDriveUI.json`;
- `design/pixelruller/LocalDriveModesUI.json`;
- `design/pixelruller/LocalDriveGalleryUI.json`.

Only the controls needed for M0/M1 must function in 0.1:

- Home: configured routes, connected storage/phones, waiting and active jobs;
- transfer strip: phase, progress, Pause/Resume, and safe error indicator;
- Drive Files: source/destination browsing and transfer preview;
- New +: File, Folder, Tag, Scan Document, Sync Now, Settings; only relevant
  implemented actions are enabled;
- Settings tabs: General, Files, Photos;
- history/details: current and completed job events;
- conflict dialog for same-path/different-content items.

New Folder inherits the currently viewed folder and asks only for Name, Create,
and Cancel. Problems & Fixes remains a Gallery collection for photo/metadata
review; transfer failures use the transfer strip, job history, and notifications
in 0.1.

The complete Gallery, duplicate quiz, Trash collection browser, scanner, and
wireless pairing UI are deferred even if their mockups exist.

## 14. Settings required in 0.1

### General

- registered storage/devices and their current presence;
- saved locations;
- notifications;
- catalog/history location and maintenance status.

### Files

- saved M0 routes;
- Copy default;
- staging maximum and minimum-free-space floor;
- per-route conflict behavior.

### Photos

- MTP source folders per phone;
- preferred external destination and staging fallback;
- optional `Photos/<year>/` organization;
- cleanup only after verified final destination.

Changing a default affects only newly created routes. Existing routes keep their
explicit behavior. Move is never a global switch.

## 15. Backend spike decision

Before implementing the M0 executor, compare two bounded prototypes on a real
source folder and external disk:

1. native Qt/KIO streaming;
2. narrowly controlled `rsync` invoked through `QProcess`.

The rsync prototype is accepted only if machine-readable progress, interruption,
partial behavior, source-change detection, cancellation, and error reporting are
reliable enough. Regardless of executor:

- the app owns preview, path validation, conflicts, SQLite state, final SHA-256,
  and cleanup;
- the app independently verifies the final destination;
- `--remove-source-files` is prohibited.

If both are adequate, choose the smaller implementation that keeps these
invariants visible and testable.

## 16. Acceptance gates

### M0 gate

Use a mixed test tree containing empty files, large files, Unicode/Greek names,
duplicate contents, colliding names, nested folders, and an unreadable item.

Pass only when:

1. Copy produces matching SHA-256 values and keeps every source.
2. Move cleans only independently verified sources.
3. Interrupt during copy, verification, catalog commit simulation, and cleanup;
   restart explains and safely resumes each state.
4. Fill the destination during transfer; no source is lost.
5. Unplug the disk during copy and verification; no source is lost and no false
   receipt is issued.
6. Attach a different disk using the same label/mount; the job refuses it.
7. Run the same job twice; no duplicate result is created.
8. Modify a source during copy; that attempt is rejected and the source remains.
9. Cancel; completed verified items remain valid and incomplete sources remain.
10. History accounts for every selected file.

### M1 gate

Use a real Android phone and mixed photos/videos.

Pass only when:

1. The app detects the unlocked phone in File transfer/MTP mode.
2. Configured source folders persist for that phone.
3. Direct-to-disk import works when the exact disk is present.
4. Disk-absent staging respects both configured limits.
5. Unplug the phone during copy; source remains and retry completes safely.
6. Import the same set twice; the second scan creates no duplicate and reports
   no verified item as new.
7. Move/cleanup occurs only after the configured destination receipt.
8. If MTP cleanup is unreliable, the UI honestly finishes as Copy and offers a
   separate cleanup review.

## 17. Smallest runnable checks

The implementation must leave focused automated checks for:

- path containment and traversal rejection;
- storage identity mismatch;
- state-machine transitions and crash recovery;
- hash mismatch preventing publish/cleanup;
- idempotent retry of a verified item;
- conflict classification;
- staging/free-space guards;
- catalog migration and transaction recovery.

Use integration tests with temporary directories for M0. MTP requires a small
fake-adapter test plus the real-phone gate; the fake does not replace hardware
validation.

## 18. Distribution for the first test build

- Developer build on the current Kubuntu machine first.
- No background autostart by default during early testing.
- No privileged daemon or root service.
- Package format is chosen after the app passes M0 locally; packaging must not
  block executor/safety validation.

## 19. Decisions and assumptions for this draft

- Working name: **Local Drive**.
- First route is selected at runtime; no personal path is embedded.
- Copy is the default; Move is explicit per route/job.
- Optional photo organization uses `Photos/<year>/` and changes paths only.
- SHA-256 is the content and final-verification identifier.
- External storage identity uses filesystem UUID when available, strengthened by
  other stable properties when required.
- Trash retention and the full cleanup browser belong to the later app shell;
  0.1 Move uses platform Trash where proven or a cleanup review.
- Package IDs, licence, and final distribution format remain open until coding
  begins; they do not block the M0 executor spike.

## 20. Start condition

Implementation may begin after the user approves this specification and names:

1. the first real source folder;
2. the first external destination folder/disk;
3. whether the first real test is Copy only or includes a reviewed Move.

No real personal files are modified during development until a dry preview has
been inspected and the user explicitly starts that test job.
