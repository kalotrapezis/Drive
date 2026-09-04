# Local Drive 0.1 — Implementation Specification

Status: Approved alpha design baseline; M0 implementation subset
Date: 2026-08-22
Source: `Plan.md`

## 1. Release objective

Version 0.1 solves the immediate storage problem safely on Linux:

1. Move or copy ordinary files from the library root to one exact configured
  storage node and folder. A Backup route mirrors both `Drive/` and `Photos/`;
  in the current M0 provider this means a mounted local filesystem. The
  user-facing node may later be backed by a USB disk, NAS, or another provider.
2. Import new files from an Android phone connected in USB File transfer/MTP
   mode.
3. Prove every destination copy before any source cleanup.
4. Retain a readable history of what moved, where it is now, and what failed.

The release has two sequential milestones:

- **M0 — Verified Linux mover:** local folder → mounted external disk.
- **M1 — One-click MTP import:** Android phone → configured destination or
  bounded laptop staging.

M0 is usable without M1. M1 may start only after M0 passes its safety gate.

The route target is therefore not a USB-specific device type. Setup stores the
user's selected storage node and route policy; runtime chooses among available
transport providers according to stable identity, presence, and capabilities.

## 2. Non-goals for 0.1

- The complete Android wireless product beyond the current Alpha slice
  (Alpha already contains candidate discovery, explicit pairing, a foreground
  sender, fixed-root auto-sync, receipts, and bounded resume);
- bidirectional continuous synchronization;
- deletion propagation or tombstones;
- remote access, cloud relay, accounts, or internet exposure;
- perceptual duplicate detection, faces, OCR, or semantic search;
- compressed `.ldrive` libraries;
- photo editing or full Photos implementation;
- Windows, macOS, and iOS;
- automatic duplicate cleanup;
- app-level encryption of ordinary files.

These are deferred, not silently approximated.

### Future Archive Library contract

The future `.ldrive` Archive Library is a ZIP64 container using Zstandard
per-entry compression where useful, with a manifest and per-entry SHA-256
hashes. It is browsed read-only and supports verified **Extract a copy…** and
**Extract all…** actions. The app never edits an archive entry in place; a new
Library is created and verified separately. Encryption remains a separate
future design. These rules do not expand the 0.1 implementation scope.

## 3. Safety invariants

The implementation is unacceptable if any invariant can be violated.

1. Keep Everything is the default. Keep Nothing requires an explicit choice for
   that job.
2. Keep Nothing means verified copy followed by source cleanup; it is never a
   direct rename across devices and never uses `rsync --remove-source-files`.
3. A source is not removed until the independently read destination SHA-256 and
   size match the source values and the catalog commit succeeds.
4. A filename match is not content verification.
5. An offline or missing location is never treated as deletion or verification.
6. No different file is silently overwritten.
7. A wrong disk with the same label or mount path is rejected.
   Linux routes prefer the filesystem UUID and also validate the recorded
   provider/filesystem identity; a format or clone event requires review.
   A physically connected but unmounted volume is visible as mount-required,
   remains unavailable to jobs, and is matched by UUID when mounted. If its
   mount root changed, saved destination paths are rebased to the new root while
   preserving their relative subpaths. The dashboard may request the native
   Solid mount operation, but it never auto-mounts or unmounts a disk.
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
- Current Alpha UI: Qt 6, QML, Kirigami, KDE/Breeze theme roles.
- In-progress UI replacement: browser-first frontend on a loopback-only local API,
  then the same approved frontend packaged in Electron. This does not replace
  the C++ transfer engine or expose control to the LAN. Use React + TypeScript
  with React Flow for the shared device-and-relationship map; install these
  dependencies only as each migration slice needs them. The current browser UI
  uses read-only `/api/v1/health`, `/api/v1/state`, `/api/v1/files`,
  `/api/v1/photos`, `/api/v1/photo-thumbnail`, and `/api/v1/problems` endpoints
  bound to `127.0.0.1:43172`; protected `/api/v1/save-route`, asynchronous
  `/api/v1/route-preview` and `/api/v1/route-execute`, and
  `/api/v1/route-manifest` and `/api/v1/route-control` endpoints require a per-launch authorization token
  and strict request validation. `/api/v1/route-history` is read-only.
  Save-route creates only a missing Drive or Photos route and refuses existing-root
  replacement until a migration review is available. The desktop primary
  sections are top tabs: Sync & Connections, Drive Files, Photos & Videos, and
  New +. Sync & Connections is the default read-only health surface; the same
  sections move to bottom navigation on Android.
  Existing-folder preview and execution are protected operations: the UI obtains a
  no-store per-launch session token and sends it in a custom header to
  `/api/v1/import-preview`. Hashing runs off the UI thread and the result is
  polled by an unguessable preview ID. Execution accepts only that completed,
  clean preview ID and runs asynchronously through the existing verified-copy
  engine. It is copy-only, retains the source, rejects changed manifests, and
  cannot rename or delete content. Its duplicate, conflict, permission,
  and unsupported findings are persisted idempotently in `review_items` and
  remain visible across restarts; resolution actions are still gated on the
  verified receipt/history implementation.
  The Linux process also watches every configured Drive/Photos source root.
  Directory notifications are debounced and backed by a five-minute safety
  reconciliation. New or changed files enter `managed_inventory` only after a
  stable size/mtime check and SHA-256; `inventory_events` records add, change,
  missing, and reappearance evidence append-only. Missing/inaccessible roots
  are Not checked and cannot manufacture deletion or missing-file history.
  Problems decisions use the same per-launch token boundary. The allowed
  actions are Save for review, Use existing copies for an exact imported
  duplicate group, Keep both safely for an imported same-path conflict, Keep
  unsupported in source for an exact symlink/special-file evidence group, and
  dismissal of a clean external observation;
  the latter is rejected when any changed or missing file is present. The app
  writes an evidence-hashed append-only `review_resolutions` row before changing
  the active review projection. `accept_existing` only authorizes omission of
  source paths whose complete duplicate-pair evidence still matches on a fresh
  verified preview; it never removes either copy. No Problems action in this
  slice removes or overwrites file bytes. `keep_both` revalidates the exact
  source manifest, conflict paths, and both versions' SHA-256 evidence, then publishes the incoming bytes under
  the first free ` (imported)` filename through Copy → Verify → Receipt.
  `skip_unsupported` authorizes only omission of the exact reported unsupported
  paths/types. They stay untouched in the source and are rechecked again inside
  execution before any regular file is copied.
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

### 4.2 Paired-device security

- Each installation generates an asymmetric identity locally. Private keys stay
  in Linux KWallet or Android Keystore and never enter SQLite/settings.
- Pairing requires explicit confirmation on both devices, a QR/code exchange,
  a one-time token, and pinned certificate fingerprints.
- Paired transfers use mutually authenticated TLS 1.3 with fresh session keys;
  discovery/mDNS only finds candidates and never grants trust.
- Reconnection is automatic after pairing while the user/session is unlocked.
  Unexpected fingerprint changes, reinstallations, removal, or security reset
  require explicit re-pairing.
- Never use a shared permanent password/key, plaintext HTTP, or
  `ignoreSslErrors()`.

## 4.1 Default folder model

Folders are created on the user's **first run**, not by the system package
installer, because installation may run as an administrator and must not guess
which user's home or external disk owns the library.

### Linux / external disk

The default library root contains:

```text
Local Drive/
├── Drive/       ordinary files that may sync in either direction
├── Photos/      photos and videos managed by the Photos view
│   └── <year>/  default physical organization for unfiled media
└── Incoming/    optional bounded staging; hidden from normal browsing if useful
```

The user may accept `~/Local Drive/` or choose a parent such as `~/Documents/`
or a folder on an external storage node. The app creates the missing
`Local Drive/Drive/` and `Local Drive/Photos/` children only after showing the
exact paths. The parent is the only computer-side location choice.

### Networked first-run guide

The full networked product uses the global visual sync map as its onboarding
overview, but connection cards are authoritative for editing. A card names two
devices and exposes direction, Copy/Move, cache, and retention directly. The
read-only desktop flowchart is derived from saved cards, so it cannot diverge
from executable routes. Technical roots stay under an Advanced disclosure.
flow and later reuses the identical surface in Settings. The guide:

1. names and classifies the local app instance;
2. confirms its system folders and local permissions;
3. discovers or manually pairs trusted instances on the LAN;
4. downloads and validates the shared configuration and metadata/history before
   any file content when joining an existing network;
5. runs a local inventory check and shows the imported device map;
6. lets the user add the new node and define plain-language routes;
7. previews readiness, unavailable devices, conflicts, planned file count,
   bytes, and estimated time;
8. commits one configuration revision to reachable instances and collects their
   Ready/problem reports;
9. starts content transfer only for routes whose endpoints are Ready.

The initial configuration exchange never moves or deletes user files. Offline
routes remain Waiting and do not prevent ready routes from operating. A route
may retain an absolute destination under a remembered removable storage root
while that storage is disconnected; the app does not create folders or start a
transfer until the same stable storage identity is present again.

### Existing-folder import and managed-root observation

The Linux app offers **Import existing folder** for an existing Syncthing or
ordinary folder. The user maps it to Drive or Photos and receives a bounded
preview of destination paths, extracted metadata/sidecars, new content, exact
duplicates, conflicts, unreadable items, and required space. Import uses the
same copy, independent destination SHA-256, receipt, and history transaction as
other verified transfers. It preserves the source by default and records
`imported externally`; it never fabricates history from before the import.

Drive/Photos remain ordinary filesystem folders. While the application is open
or in the system tray, filesystem notifications enqueue changed paths for a
debounced stability check and hash/index pass. A notification is only a hint:
startup, catalog recovery, and storage reconnect perform a bounded
reconciliation scan to catch changes made while the app was not running or
events lost by the operating system. Definitive Exit stops observation and
leaves no separate background service.

An externally added file is indexed in place only after size and modification
time remain stable across the scan and SHA-256 completes without the file
changing. The app does not silently relocate or delete it. External additions,
moves, removals, metadata changes, incomplete writes, and same-hash/different-
path findings create batched **External changes** or **Duplicates** entries in
Problems & Fixes. A clean auto-indexed observation remains visible there until
dismissed or included in resolved history.

### Android

The phone has two fixed roots: **Drive/** for ordinary files and **DCIM/** for
photos and videos. Local Drive reads those roots through Android's media/folder
APIs and does not offer arbitrary additional roots in normal setup. Camera,
Screenshots, and other subfolders remain inside `DCIM/`.

The app uses or requests access to:

```text
Drive/                          fixed phone files root
DCIM/                           fixed phone photos/videos root
```

The app does not request unrestricted access to unrelated phone storage merely
to add another root.

### Android metadata preflight and pending work

Regardless of whether the selected mode is **Files**, **Photos**, or **Backup**,
filesystem/media events update the phone's local queue for the fixed `Drive/`
and `DCIM/` roots. Small metadata deltas leave immediately through the permitted
local connection; they do not wait for a content transfer. The delta contains
stable item ID, relative path, size, modification/capture time, relevant media
metadata, content identity when available, and the originating
device/sequence. No file bytes move during this preflight.

The computer merges that delta into the shared catalog and records the work as
`Pending backup`. It can therefore show the exact number of files, total bytes,
roots, and last metadata update that will be transferred at the next eligible
connection. The later content transfer uses those planned items, rechecks the
source metadata, and publishes a verified receipt; changed or missing items
return to review instead of being silently treated as complete. The same
pending summary is shared with paired devices through the metadata/history
exchange. The selected mode changes which content operation is eligible, not
whether metadata is sent.

The exchange is bidirectional: the phone can publish new local observations
and pending work, while the computer, server, or another paired device can
publish locations, receipts, conflicts, and pending work visible to the phone.
Android has a touch-first Dashboard over the same converged catalog/history;
it is not a reduced sender screen with a separate state model.

The bounded bidirectional slice reuses the metadata acknowledgement: Linux
returns at most 64 missing immutable resolution events and 32 active reviews,
and Android performs a
metadata-only heartbeat even when no files are queued. Android validates and
stores each event idempotently in app-private preferences and advances a
generation/sequence cursor scoped to the paired receiver certificate
fingerprint. Every active review includes its evidence hash and only the actions
currently allowed by Linux. Android may return at most 16 queued decisions per
heartbeat; Linux applies one only if its evidence is unchanged, records the
append-only resolution using the phone as origin, and acknowledges its ID so
Android can move it into decision history. The only remote filesystem action is
the non-destructive `recheck_location`; no mutation is implemented. The acknowledgement also carries
a bounded read-only catalog snapshot with pending totals, active-transfer
progress, device presence/last report, and storage presence plus total/free and
known verified bytes. Capacity is persisted in schema v14 so an offline disk
retains its last reported information; Android validates all bounds and values
before replacing its app-private dashboard snapshot. Up to 64 recent location
rows carry only relative paths and receipt evidence; absolute local paths are
not exported. A location is presented as verified only when its content and
destination SHA-256 values match and `verifiedAt` is present. If the complete
acknowledgement approaches 64 KiB, older location rows are removed first and
the snapshot is marked truncated instead of failing the heartbeat. Location
pages use a descending SQLite row cursor rather than an offset, so rows inserted
between requests cannot shift or duplicate the next page. The response cursor
is recalculated after packet-size trimming. Android requests pages explicitly,
validates that each response matches the requested peer cursor, and exposes
Latest/Older plus All/Verified/Attention controls.

Schema v16 adds append-only device correction requests and results linked to
their Problems & Fixes review. The only
implemented action is `recheck_location`; it never writes, renames, moves, or
deletes a file. Requests are limited to a paired target device, fixed `Drive`
or `DCIM` root, safe relative path, expected byte count, and SHA-256. Android
rechecks the SAF entry before and after hashing and returns one idempotent
result. A claimed verified result is rejected by Linux unless its observed size
and hash exactly match the request. Pending and completed results are projected
into desktop and Android history. Destructive corrections require a later,
separately reviewed executor and physical-phone evidence.

### Backup target formats

A Backup route covers the complete computer library root, not Photos alone. It
therefore includes both `Drive/` and `Photos/` in one operation. The user may
choose:

- **Mirror folders** — ordinary verified copies of both trees, preserving normal
  file access and folder structure on the storage node;
- **Library archive** — one read-only `.ldrive` snapshot containing both trees,
  a manifest, and per-file SHA-256 hashes; or
- **Both** — create the ordinary mirror and the archive snapshot.

The active library always remains ordinary folders. The archive is browsed and
extracted through Local Drive; an entry is never edited in place. Archive
creation is deferred beyond the current M0/M1 implementation, while the
verified ordinary mirror uses the existing copy/receipt safety path.

### Collections and albums

Collections are logical catalog groupings by default and reference the same
physical photo; adding a photo to a collection must not create another copy.
Meaningful imported folders/albums remain physical folders when preserving their
structure matters. Exporting a collection to a real folder is a separate action.

## 5. User-visible terminology

Direction and retention remain separate concepts:

- **Send files**, **Receive files**, or **Send & receive** describes direction.
- **Keep Everything**, **Keep Last month**, **Keep Last week**, **Keep Last
  day**, or **Keep Nothing** describes source retention after verified transfer.
- **Keep Everything** maps to Copy; **Keep Nothing** maps to verified Move.
- **Send & receive** forces **Keep Everything**.
- **When drive is connected** is a separate timing option; **Archive Library**
  is a separate destination format.
- **Backup** covers both `Drive/` and `Photos/` and may use Mirror folders,
  Library archive, or Both.
- Continuous Sync with deletion propagation is deferred from 0.1.
- **Import new files from phone:** scan configured MTP folders and propose only
  items not already verified in the catalog.

The UI must never label a Move as Backup.

## 6. M0 user flow — verified Linux mover

The M0 engine is available without the desktop surface through the keyboard-first
`local-drive-cli` commands `verified-preview SOURCE DESTINATION` and
`verified-copy SOURCE DESTINATION`. They use the same path, storage-identity,
hash, catalog-receipt, and retry checks as the application and emit live progress
to the terminal with optional append-only logs. `--staging-max-bytes` rejects a
job whose new bytes exceed the configured per-job intake bound. The M1
`verified-stage-dir` command separately applies the same option as a total
on-disk cap for an explicit staging root. There is no CLI Move or Remove
command.

### 6.1 First setup

1. Select a source folder.
2. Attach and select the destination disk and destination folder.
3. Record the strongest available stable disk identity, friendly label, mount,
   filesystem type, and selected root.
4. Choose the route's Keep policy; Keep Everything is preselected. M0 may
   expose Copy/Move compatibility labels, where Copy means Keep Everything and
   Move means Keep Nothing.
5. Optionally set:
   - staging maximum;
   - minimum laptop free-space floor;
   - organization of otherwise unfiled photos into
     `Local Drive/Photos/<year>/`.
6. When computer and destination parents are chosen for both content types,
   create distinct `Drive/` and `Photos/` children below both parents and save
   both routes in one SQLite
   transaction and one configuration revision. If persistence fails, newly
   created empty children are removed; existing folders are never removed.
   Saving a single content route remains available for later additions.

The current local implementation persists the discovered filesystem type with
the storage identity, friendly label, mount, and selected root; older v1 catalogs
gain the nullable field during migration. The setup view exposes a read-only
device refresh action for reconnect testing; it does not start a transfer.

No path is hardcoded in the application or this specification.

### 6.2 Preview

Before starting, show:

- source and exact destination device/folder;
- Copy or Move;
- file count and logical total size;
- destination free space and required safety margin;
- already-present identical files;
- exact duplicate source items, without automatic deletion;
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
7. Persist the item and job as `Verifying`.
8. Reopen and independently calculate destination SHA-256.
9. Recheck that the source size and modification time did not change.
10. If both hashes and sizes match, atomically rename the partial file to its
   final name where supported.
11. Commit the verified location and history event in SQLite.
12. After every selected item has passed steps 1–11 and the complete job has a
    valid destination receipt, show the cleanup preview. For Keep Nothing or
    an expired Keep-period policy, send eligible sources to platform Trash only
    after explicit confirmation. If any selected item fails, no source cleanup
    starts. If Trash is unavailable or unreliable for a source, retain it and
    add it to the cleanup review.

Directory creation is allowed only below the selected destination root.

### 6.4 Interruption and retry

- Persist job and per-file state after each meaningful transition.
- On catalog reopen, active `Copying`, `Verifying`, or `Paused` jobs with
  unfinished items are marked `Failed` with the stable `interrupted` code and
  an append-only failed event for every unfinished item. If every item already
  has a verified receipt, reopen reconstructs the final `Complete`, `Cleanup
  pending`, or `Conflict` state instead; retry rechecks the source and reuses
  only verified destinations.
- The current MTP path may restart a file from zero because KIO/MTP range
  resume is not yet proven. The wireless simulation retains a bounded,
  app-owned `.local-drive-partials/*.partial`, verifies its prefix against the
  source, and resumes only after that check; it keeps the source in all cases.
- Cancel stops scheduling new files, allows the current bounded write to stop
  safely, and never triggers source cleanup for an incomplete file.
- A completed verified file is skipped on retry.
- If a cleanup side effect may have completed before its catalog commit, the
  item remains `pending` and the job remains `Cleanup pending` with
  `catalog_error`; the app requires Trash/catalog review instead of declaring
  cleanup complete without a receipt.

## 7. M1 user flow — one-click MTP import

### 7.1 Device setup

The connection guide has three explicit states. A raw Android USB connection is
shown only as **Phone — Charging only** and is never persisted under generic
descriptors such as `Google` or `Nexus One`. After the user unlocks Android and
chooses **File transfers / Android Auto**, a live KIO/MTP root upgrades the card
to the reported model plus **Files available**. On disconnect, the remembered
model is **Last reported**; pending work, receipts, and history remain, while no
transfer or cleanup can start. USB debugging is unrelated and never required.

The current first device slice lists top-level phones through KDE/KIO's `mtp:/`
worker and reports the friendly name in the setup view. The companion
`local-drive-cli` provides bounded read-only `mtp-inventory URL` and recursive
`mtp-scan URL` commands, a transport-only `copy SOURCE DESTINATION_DIRECTORY`,
and single-file `verified-import MTP_FILE_URL DESTINATION_DIRECTORY` and
bounded `verified-import-dir MTP_DIRECTORY_URL DESTINATION_DIRECTORY` commands.
`verified-import` streams with `KIO::get`, hashes the received bytes and the
destination independently, publishes without overwrite, and records an MTP
source plus verified destination receipt in SQLite. The companion
`verified-import-dir` first performs a bounded recursive inventory and then
reuses that single-file path for every selected object; if preview bounds or a
file transfer fail, no later item is scheduled and all phone sources remain.
`verified-stage-dir` is the disk-absent variant: it requires an explicit local
staging root, checks existing regular-file occupancy plus incoming bytes against
`--staging-max-bytes`, records the same receipts in SQLite, and leaves the
staged files for a later verified local drain. `verified-export` and the Files
view's **Send to phone** action copy one selected local file into the fixed phone
`Drive/`, verify SHA-256 before recording its receipt, and refuse replacement
when a different file already has that name. All commands retain their source;
there is no phone deletion or move command.
Missing destination subfolders are created one level at a time through KIO/MTP;
the catalog stores the phone-storage root and the complete Drive-relative file
path rather than flattening the file into `Drive/`.

The Sync panel's phone card exposes two explicit inbound actions: `Drive/` to
the configured Files destination and `DCIM/` to the configured Photos
destination. They are available only for a stable, unlocked MTP phone and a
mounted destination route, retain every phone source, preserve relative paths,
apply the route's minimum-free-space margin, and publish progress/failure through
the same catalog operation state. If that storage is absent, a configured
laptop staging root is used only after the shared directory importer counts its
existing regular files plus incoming absent paths and proves they fit beneath
the route's total staging cap; otherwise no phone bytes are received.
The setup model also persists first-seen acknowledgement and hidden state for
detected phone and storage identities. Its current onboarding modal is
informational and non-destructive: it explains USB/MTP and the fixed phone
roots, identifies storage by stable identity, and never starts a transfer or
formats a disk. A participating storage then offers Drive, Photos, or both and
states explicitly that the currently executable peer is the laptop; it does not
silently imply support for another device-to-device route. The repository includes the Android candidate beacon, Keystore
identity, profile UI, authenticated foreground sender, receipt-backed fixed-root
scan/queue service, and a Linux GUI receiver panel whose successful configuration
is remembered locally. The GUI can export the Linux profile and accept the Android
public certificate through the same validated JSON exchange as the CLI; QR-based
automatic certificate onboarding remains deferred.

1. Detect an unlocked MTP phone exposed through KDE/KIO.
2. Save its stable available identity and friendly name.
3. Let the user choose one or more source folders, initially suggesting:
   - `DCIM/Camera`;
   - `DCIM/Screenshots` on the first test phone, while accepting another
     device's detected Screenshot folder;
   - Downloads.
4. Save a preferred final destination route, optional laptop staging root, and
   bounded staging policy. The staging root must be an existing folder outside
   the source and destination roots; saving the setting does not move content.

The Android app is not required or opened.

The current Alpha also has a Linux candidate-discovery listener on UDP port
`43170`. It accepts only the versioned `local-drive-discovery-v1` JSON beacon,
shows one Online/Offline entry per canonical identity, and expires a silent
beacon after 15 seconds. The CLI `wireless-beacon` command sends the same
candidate packet for simulation. Discovery does not pair devices, trust a
network-provided device ID, or authorize file transfer. Alpha's visible
**Pair with USB phone** action only links a candidate alias after an explicit
user action. Cryptographic pairing is implemented through the Alpha JSON profile
exchange; Settings exposes profile export, Android certificate acceptance,
receiver certificate paths, pinned fingerprint, destination, Start/Stop controls,
and live log.

The Linux Alpha protocol gate is now available through `wireless-receive` and
`wireless-send`: TLS 1.3 is mutual, the receiver pins the client certificate
fingerprint on both synchronous and asynchronous handshake completion, and the
sender pins the receiver CA certificate. Files use
acknowledged chunk offsets and app-owned resumable partials; after the final
SHA-256 check the staged upload is passed through `VerifiedCopy` and one normal
catalog receipt is committed. The CLI pair is a deterministic LAN harness. The
Android app imports the receiver profile, shares only its public client
certificate, accepts one persistable system grant for each fixed `Drive/` and
`DCIM/` root, and scans/sends new or changed files through a foreground service.
It records a sent item only after the Linux receipt; a bounded Android retry
reconnects after a short link loss and resumes from the Linux committed partial.
The Android emulator has now verified fixed-root setup, automatic retry after an
unavailable receiver, a receipt-verified `Drive/auto-sync.txt` upload with a
matching SHA-256, and no second upload after service restart. No real-phone
wireless transfer or physical unplug/reconnect run has been completed yet. A
separate emulator run with `mWakefulness=Asleep` uploaded a 128 MiB file with a
matching independent SHA-256 receipt, so screen-off foreground behavior is
verified only for the emulator.

A live `notes_phone` emulator run then broadcast three real discovery beacons to
the Linux UDP listener with one stable `wireless:` identity. A new `Drive/` file
survived an initial receiver-unavailable retry, uploaded on the next scheduled
scan after the receiver started, and produced one `verified` catalog location with
equal source/destination SHA-256 values and a receipt-backed Android sent marker.
This remains emulator evidence; the physical phone and USB/MTP unplug/reconnect
gate are still unverified.

The verified-import slice is intentionally one file at a time at the engine
and now emits live received-byte progress while streaming each object. A
127,076,235-byte real MP4 completed and repeated with matching hashes and
about 37 MiB maximum resident memory; this does not replace disconnect testing.
boundary. The directory command proves bounded batch preview and the staging
variant proves bounded queue intake before cleanup eligibility is added.

### 7.2 Import preview

When the phone is detected, show a one-time **Phone detected** action dialog for
that connection. It lists the numbered configured routes/actions available to
that phone, such as **1. Import new files to Drive** and **2. Import photos to
Photos**. Detection alone never starts a transfer. The user selects an action
and presses **Start transfer**; the dialog closes, a job is queued, and progress
is shown in the tray and Sync panel. Dismissing the dialog leaves the phone
connected and the same actions available from the device entry.

After the action is selected, scanning produces:

- new items;
- already verified items;
- exact duplicates at another known path;
- same-path/different-content conflicts;
- unavailable or unreadable items.

If the configured external disk is present, import directly to it. If absent:

- use laptop staging only within both configured limits; or
- leave the item on the phone and mark it waiting.

The user chooses the route's Keep policy. The compatibility actions **Copy new**
and **Move new** remain available in M1, with Copy preselected.

### 7.3 MTP transfer and cleanup

- Stream each MTP object into a destination `.partial` file while hashing.
- Independently hash the completed destination.
- Record a verified receipt for every item and wait for the complete import job
  receipt before cleanup eligibility.
- If reliable MTP deletion cannot be proven for the specific phone/backend,
  complete as Copy and show a separately confirmed cleanup list.
- Disconnecting the phone leaves all unverified sources untouched.
- Running the same import twice must not create duplicate files or report
  verified files as new.
- A simulated link interruption after a received chunk must leave the source,
  publish no incomplete destination, record `Cancelled`, and allow a retry to
  create one verified receipt. The CLI's `wireless-simulate` command exercises
  this same verified stream with a `wireless:` source identity and receipt;
  catalog aliases let a paired wireless observation reuse the USB/MTP device
  record. This is still a deterministic transport simulation, not LAN pairing.

### 7.4 Removable-disk eject

While a removable destination has active work, normal software eject shows the
active job and offers **Continue** or **Cancel transfer and safely eject**. The
application never forces an unmount. Physical unplug or administrator-forced
unmount is treated as a disconnect: sources remain, no cleanup occurs, and the
job enters a recoverable paused/failed state with history and notification.

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
2. Place otherwise unfiled media in `Local Drive/Photos/<year>/`.
3. Choose year from EXIF capture time, then available media date, then file
   modification time.
4. Use `Local Drive/Photos/Unknown date/` when no trustworthy date exists.
5. Change paths only; never rename original filenames in 0.1.
6. Preserve sidecars and unknown metadata rather than rewriting media.

The route preview and exported manifest must show the resulting destination
path for organized items; the original filename remains unchanged.

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
- content root: **Drive** or **Photos**;
- direction: Send, Receive, or Send & receive;
- keep policy: Everything, Last month, Last week, Last day, or Nothing;
- internal M0 behavior compatibility: Copy or Move;
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
- route, direction, keep policy, and requested internal behavior;
- source/destination paths;
- state, byte progress, expected size/hash when known;
- created, updated, and completed timestamps;
- error code and safe human explanation.

**History event**

- queued, copying, verifying, verified, moved, trashed, conflict, failed,
  cancelled, retried, observed externally, imported externally, and problem
  resolved;
- job/item, source, destination, time, and result.
- immutable origin device ID, catalog generation, and per-origin sequence;
- wall-clock time is descriptive only and never resolves ordering or authority.

**Paired-device history summary**

- highest contiguous event sequence known for each origin and generation;
- missing sequence ranges and catalog integrity state;
- last local inventory check and whether each root was accessible;
- planned transfer count, remaining bytes, and measured-speed time estimate.
- pending metadata-delta count, total bytes, fixed source root, and last update;
- next eligible connection/profile and whether the content preflight is stale.

Wireless sync exchanges and commits missing metadata/history events before file
content. Each device reports observations only for storage it can currently
access. A destination checksum receipt proves that destination copy; an absent
file on an accessible root becomes Missing and prompts the user, while an
offline root remains Not checked. Neither condition is treated as deletion.
Catalog reset creates a new generation and requires catalog validation plus full
inventory reconciliation before normal transfers resume.

A Problems & Fixes decision creates a new immutable resolution event containing
the reviewed problem/group ID, expected hashes and location revision, requested
action, and result. Other devices merge it idempotently. Catalog/UI corrections
appear after merge, but moving, renaming, or trashing bytes on another device is
pending until that device can access the root and re-verify those preconditions.
If its file or location changed, it performs no side effect and republishes the
item as unresolved Problems & Fixes work.

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
  → Cleanup pending   (Keep Nothing or an expired Keep-period policy)
  → Complete

Any active state → Paused | Cancelled | Conflict | Failed
Failed/Paused/Conflict → Queued after an explicit or safe retry
```

`Complete` for Keep Everything requires a committed verified location.
`Complete` for Keep Nothing and expired Keep-period policies requires the same
plus a recorded whole-job source cleanup result. If cleanup is deferred, the
copy remains safe and the job says **Cleanup pending**, not Complete. The
cleanup preview must show the eligible file count and bytes before confirmation.

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
- global top transfer strip: dynamic phase/destination, progress, Pause/Resume,
  and safe error indicator; it remains visible above Drive, Photos, and Settings
  while a job is active;
- Drive Files: source/destination browsing and transfer preview;
- New +: File, Folder, Tag, Scan Document, Sync Now, Settings; only relevant
  implemented actions are enabled;
- Settings tabs: General, Files, Photos;
- history/details: current and completed job events;
- conflict dialog for same-path/different-content items.

New Folder inherits the currently viewed folder and asks only for Name, Create,
and Cancel. Problems & Fixes remains a Photos collection for photo/metadata
review; transfer failures use the transfer strip, job history, and notifications
in 0.1.

The current keyboard-first desktop surface implements the persistent `Sync /
Files / Photos / New +` mode bar (`Alt+1` through `Alt+4`) and a separate
Settings page from New +. A connected phone exposes `Drive → Drive` and
`DCIM → Photos`; each action bounded-scans the fixed root and uses the same
verified import and SQLite receipt path as the CLI. These UI actions are
Copy-only until a later device-gated cleanup design.
First-run Setup is a three-step guide: what Local Drive does, the computer
library folder, and the backup disk/server folder. Files/Photos relationship
behavior is configured only on the visual map.
Computer library selection starts at the current user's home and cannot leave
that home in the UI. The guide uses folder choosers instead of typed paths and
does not expose numeric backend limits. The computer itself is always a device;
the phone's `Drive/` and `DCIM/` roots remain fixed and are not configured as
PC folders.
The Sync surface also shows a bounded live status log fed by the same verified
engine; SQLite history remains the durable per-file record and CLI append-only
logs remain available for headless runs.
The Sync dashboard is a read-only projection of the converged catalog and
append-only history exchanged through paired devices. Every remote observation
is labelled `Online now`, `Last reported`, or `Not checked`; the UI never
invents a current storage value for an offline device.
Keyboard operation includes `Ctrl+Enter` to start the selected successful
preview and `Esc` to stop an active transfer.
On Linux, closing the window hides the application to the system tray; the tray
offers Show, Pause/Resume, Cancel, and a definitive Exit. Definitive Exit
terminates the application after the verified engine has been asked to cancel
and its worker has joined. Sessions without a system tray retain normal process
lifecycle behavior without emitting tray warnings.
The route records are rendered as a shared node-and-arrow connection map in
Sync and Settings. Selecting two nodes opens the Send/Receive/Keep relationship
modal. For Alpha, Apply persists the supported computer-to-storage Send rule
and Keep's Copy/Move policy; Receive and non-local pairs fail visibly instead
of creating inert configuration. Each detailed route card offers Preview, verified Transfer, manifest
export, and—only after a verified non-Keep-Everything job—recoverable Trash
cleanup, with preview/conflict/error details and recent history. Settings uses
a fixed-width sidebar of small categories and exposes Files and Photos filter tabs over the
same map, including each route's content type, Keep policy, and stable storage
identity. Phones are Online only while live MTP or wireless discovery reports
them; remembered phones are shown as Offline/last-known. EFI and boot/system
partitions are never valid backup destinations, even if a platform enumerates
them as removable storage.
The desktop settings shell uses a fixed 250 px Qt `SplitView` navigation pane,
grouped searchable `ItemDelegate` rows, and KDE `FormLayout` alignment for
labelled controls. The application enforces a 900 x 640 minimum desktop window
so KWin session restoration cannot collapse the navigation into the content.
First setup is a floating modal over the window and includes the connection
preview plus a plain-language explanation of Keep. Device rows expose an eye
control for persistent hide/show. Settings is separated at the bottom of the
main Sync sidebar, and Settings back navigation remains at the upper left.
The active transfer strip asks for a pause duration from 1 to 99 with minutes,
hours, or days. The timer is process-local; definitive Exit still terminates the
process and leaves no background sync service.
Cleanup cancellation is honored before the Trash side effect. If KIO reports a
failure after items were marked pending, the items remain pending and the job
requires catalog/Trash review rather than being marked falsely failed.

The complete Photos library, duplicate quiz, and Trash collection browser are
deferred even if their mockups exist. Alpha wireless pairing/profile UI and the
foreground fixed-root scanner are implemented; QR-based automatic certificate
onboarding remains deferred. Existing-folder preview, Linux managed-root
observation, external-change review, and catalog-only Android receipt plus a
small read-only presentation of cross-device resolution events are implemented.
The native packaged folder chooser, richer Android visual design, and verified
physical-phone correction remain later gates.

## 14. Settings required in 0.1

### First-seen mounted storage

A successful mount does not silently create a route. For storage whose stable
identity has not been acknowledged, the UI asks whether it participates in
Drive. Declining persists `hidden=1` and suppresses future prompts until the
user restores it from Hidden devices. Accepting adds the storage node and opens
the Files map editor. The editor builds one validated relationship at a time,
offers another relationship after each save, and then offers a one-time clone
of the completed Files topology and policies to Photos. Declining that clone
starts the same relationship flow independently for Photos. The storage UUID or
other stable identity remains authoritative; a changed mount path is only live
location evidence.
The 0.1 chooser exposes only executable relationships. It proposes, but does
not force, `~/Local Drive/<content>` on the computer and
`<mounted root>/Local Drive/<content>` on storage. A Files-to-Photos map clone
is an atomic one-time copy of topology and policies; the two maps are
independent afterward.

### General

- shared visual sync map with registered storage/devices and current presence;
- saved locations;
- notifications;
- catalog/history location and maintenance status.

### Files

- saved M0 routes;
- Keep Everything default;
- staging maximum and minimum-free-space floor;
- optional existing laptop staging root, outside the source and destination;
- per-route conflict behavior.

### Photos

- fixed MTP phone roots: `Drive/` and `DCIM/`;
- preferred external destination and staging fallback;
- optional `Local Drive/Photos/<year>/` organization;
- cleanup only after verified final destination.

Changing a default affects only newly created routes. Existing routes keep their
explicit policy. Keep Nothing is never a global switch.

### Shared configuration and device removal

The device-and-route map is one versioned global configuration replicated to
every paired device before normal transfer planning. Nodes represent devices or
storage; directional, labelled connections represent Files or Photos routes and
their Send/Receive direction and Keep policy. Devices apply the relevant portion
of the same map rather than maintaining independent sender/receiver settings.

The same visual map has one node layout and two edge layers: **Files** for
ordinary-file routes and **Photos** for photo/video routes. Switching tabs never
repositions or duplicates nodes. Policies remain independent so Files can Copy
and Keep across many devices while Photos can verified-Move a large library to
external storage.

Opening an empty layer when the other layer is configured creates a draft clone
of its relationships. Nothing is persisted until **Apply**. The map menu exposes
explicit Files-to-Photos and Photos-to-Files copy actions plus Import Map and
Export Map; every target-layer replacement has a preview.

Portable `local-drive-map-v1` metadata includes stable node IDs, capabilities,
canvas positions, both relationship layers, author/revision, and behavior. It
does not include private credentials as usable authority. On import, pinned
identities match existing nodes; unmatched devices and device-local locations
remain unresolved. Import never pairs a device, grants trust, or starts content
transfer. A paired server, desktop, or mobile app receives the same committed
map through metadata synchronization, locates its own node, and executes only
the relevant edges.

Alpha staging converges on one application-managed queue parent with a separate
**Use as hub** switch on the laptop node. Its default 80% whole-disk ceiling is
editable from 1% through 95%; the equivalent free-space floor is enforced for
every phone intake. When the preferred storage is absent, verified files stay
under `~/Local Drive/.incoming` and the dashboard reports the staged byte count
and the stable destination label that must be connected.
subdirectory per route ID. Files and Photos may share that parent safely, but
never share an un-namespaced queue path. Relationship editing does not ask the
user for a staging folder.

The device palette is populated automatically from LAN discovery plus remembered
paired devices and labels each as New, Online, Offline, or Needs attention.
Choosing two nodes opens the relationship modal; discovery itself does not grant
trust. After the user commits the visual plan, reachable devices
exchange and acknowledge the same configuration revision. Network addresses,
ports, interface selection, and complementary sender/receiver setup remain
implementation details rather than user settings.

### First-seen device modal

When a node is first seen in Sync/Map, the app opens a type- and capability-aware
setup modal. It never formats storage or starts a transfer merely because a node
was detected.

- For a new disk, NAS, or other storage node, it explains the stable identity and
  current contents, then guides the user through its library/backup role and the
  `Drive/` and `Photos/` roots. The exact paths are previewed before folders are
  created.
- For a phone, it presents the fixed `Drive/` and `DCIM/` actions, USB/MTP
  instructions, and, when supported, a one-time wireless-pairing QR code plus
  the official application source.
- For a Server or unknown node, it exposes only the capabilities detected and
  routes the user through the relevant pairing/storage steps; it does not guess
  a protocol.

The modal's **X** dismisses it without changing the node. **Do not show this
device again** hides the node without deleting its identity, routes, or history.
Settings provides a **Hidden devices** list with an explicit **Show again**
action.

An offline device or storage node remains in the map. Removing a device can occur only through
an explicit **Remove from sync network** action in Settings with an impact
preview and confirmation. Removal revokes pairing and disables its routes but
does not delete files or history; the device remains archived in past location
and movement records. Configuration revisions use stable revision IDs and
author devices, not wall-clock precedence, and conflicting concurrent edits are
sent to review instead of silently overwriting each other.

A rarely connected cold-backup disk is therefore a normal remembered storage
node. A 5 TB disk may remain Offline between backup sessions; when its stable
identity is detected again, it becomes Online and its saved Backup route can be
offered or started according to its timing policy. Offline never means deleted,
failed, or unconfigured.

### Changing system locations

Drive, Photos, fixed phone roots, staging, and catalog locations are tracked by
the setup. Only the computer library parent may be changed from Settings, and
the UI labels this **Change location and rebuild index**, not an ordinary folder
edit. The app pauses affected jobs, scans the old and new
roots, compares content hashes, sizes, metadata, and structure, then previews
the resulting location map for confirmation. It activates the new roots only
after the rebuild commits successfully. Existing movement history is retained;
only the current-location index is rebuilt. The migration never moves, trashes,
or deletes content automatically. Missing devices leave the migration incomplete
and the previous configuration active.

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

The current sandbox evidence is green through the Qt, CLI, and schema suites.
It does not claim the physical-disk unplug/reconnect or real-phone gates; those
remain separate external acceptance tests.
The first physical smoke test on 2026-08-25 copied one 275,936-byte JPEG from
the connected Xiaomi 15 `DCIM/` MTP root to a new test directory on the mounted
T7, recorded matching SHA-256 values and one verified SQLite receipt, and
repeated without creating a duplicate. The phone source remained present. This
does not replace the full mixed-set, unplug/reconnect, or cleanup gates.
The follow-up mixed-set smoke copied one JPEG and one MP4 from `DCIM/Camera`
(7,910,297 bytes total) to a new T7 test directory and repeated both imports;
the catalog retained two verified locations and receipts with zero hash
mismatches or duplicate destination files. The phone sources remained present.
Only the physical unplug/reconnect-during-copy recovery action remains for this
M1 slice.
On 2026-09-02 a 1 MiB fixture was transferred and SHA-256 verified across
Xiaomi 15 → laptop, Xiaomi 15 → UUID `EFFE-724A`, laptop → that exFAT disk,
laptop → disk after MTP staging, and disk → Xiaomi 15 with a read-back hash.
Retries produced no duplicate destination names. The shared catalog now
canonicalizes a physical storage by stable identity while recording each file
relative to the filesystem root, so different route folders remain distinct.

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
- The first native package is Debian `amd64`, version `0.1.0~alpha1`. It contains
  the GUI, diagnostic CLI, desktop launcher, icon, licence, generated shared-
  library dependencies, and explicit Qt/Kirigami QML-module dependencies.
- Package generation never installs or starts a privileged/background service.

## 19. Decisions and assumptions for this draft

- Working name: **Local Drive**.
- First route is selected at runtime; no personal path is embedded.
- Copy is the default; Move is explicit per route/job.
- Optional photo organization uses `Local Drive/Photos/<year>/` and changes
  paths only.
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
