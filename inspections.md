# Desktop inspection — 2026-09-04

> Dated evidence, not live runtime state. Current roadmap: [Plan-V2.md](Plan-V2.md). Do not infer current test failures, mounts or installed versions from older entries.

## Physical Xiaomi 15 → T7 core acceptance — 2026-09-13

- [x] Development worktree safety core, isolated catalog, Xiaomi 15 in MTP mode,
  and mounted PSSD T7. This is not an installed-package acceptance.
- [x] Created a new QA source folder on the phone and a unique destination under
  `/mnt/T7/Drive/LocalDrive-Physical-Test-20260902/`; no personal library path,
  Move operation, source cleanup, or overwrite was used.
- [x] Bounded MTP preview found exactly one 1 MiB file and created neither a T7
  destination file nor a catalog.
- [x] Verified import completed; phone source and T7 destination SHA-256 both
  equal `31ee1a476611c2672a6f3217134fb1ce0cd898f911b3598497cd93dc742957e7`,
  the source remained on the Xiaomi, and the isolated catalog recorded one
  `verified copy` receipt.
- [x] Repeating that import created no second destination file and retained the
  same SHA-256.
- [x] A distinct 1 MiB source with the same filename was rejected as
  `Destination differs`; the original T7 file/hash and the conflicting phone
  source were both preserved, and the catalog recorded `conflict`.
- [ ] Still pending: LocalApi/UI bound-preview hardware acceptance, reconnect and
  wrong-device tests, cancellation/disconnect/restart, Cache forwarding, selected
  restore/Move recovery, and one identifiable packaged-build matrix.

## Functional gap pass — 2026-09-05

- [x] Live isolated New Tag: six colours, persisted colour, successful close and
  visible toast; duplicate and invalid colour rejected by the backend.
- [x] New-storage wizard: selected-device-only map and card setup for Drive,
  Photos, or atomic Drive + Photos; no editable internal paths.
- [x] Narrow desktop browser check: connection wizard and tag dialog no longer
  force horizontal page scrolling.
- [x] Settings management paths inspected end to end. Device removal now requires
  confirmation; backend keeps files/history and blocks removal during active work.
- [x] TypeScript, production web build, 10 web checks and 11 native suites passed
  (UDP discovery excluded because a listener is running).
- [x] T7 core acceptance: copied three owned files, matched SHA-256 values, repeated
  with `to_copy=0`, then retained a deliberate destination conflict without
  replacing either side. This found and fixed different-size conflicts being
  returned as an unexplained failed preview.
- [x] Isolated installed UI: onboarding, Drive connection save, Settings card,
  process restart persistence, Dashboard preview/transfer, three matching hashes,
  recent activity and repeat/no-op were visibly checked against the mounted T7.
- [x] Settings: reversible hide/show was visibly confirmed. A connection edit to
  Move + Keep last week survived restart, then was restored to Copy + Keep all.
- [x] T7 retention/cache settings: Move retained the current source and required
  separate cleanup review; Cache enforced the live 80% disk ceiling and was
  restored off. Dashboard/Settings now use user-available capacity (excluding
  reserved ext4 blocks), and connected-cache guidance is actionable.
- [x] Route-policy cleanup state: restoring Copy + Keep Everything now settles
  only prior cleanup that never started. An uncertain Trash operation blocks the
  change. Live isolated API verification removed the stale cleanup warning while
  preserving every laptop/T7 test file and hash.
- [x] T7 clean unmount/remount: stable UUID kept the route in mount-required
  state; the app's Mount action restored it, then preview reported 4 identical
  files and nothing to copy.
- [x] Removal safety in cloned catalog: connection and T7 removal persisted after
  restart while route/job/item/history records and real test files remained.
- [ ] Hardware acceptance remaining: repeat the wired flow with the phone in
  file-transfer mode.

- [x] Drive Tags: real tag filter bar plus All (all tagged files). Browser-checked exact category filtering, combined filename search, sorting, list/grid and empty category against synthetic files in isolated QA catalog; nine web tests pass. Installed Alpha unchanged.

## Live UI audit — development build, not installed Alpha

- [x] Connected devices has a top-right Refresh devices button. Browser check: disabled while requesting discovery, then enabled again; real mounted T7 reports Online now. Backend refresh reconciles disks as well as MTP phones.
- [x] Backend schedules device discovery every five seconds; frontend polls state every two seconds. Physical unplug/replug testing remains pending.
- [x] Current validation: TypeScript check, production web build, eight web tests and sixteen LocalApi tests passed. Qt/KIO warnings remain in the test output; no claim of hardware transfer coverage follows from these tests.
- [x] Separate Settings top tab; dashboard connection summaries are read-only. Browser-tested hiding and showing a synthetic phone in an isolated catalog.
- [x] Route reload replaces the in-memory list instead of appending a second copy. Backend rejects duplicate enabled local-device/storage/content connections; removing a connection disables it without deleting files/history.
- [x] Unsupported move/retention/cache options and unavailable native actions are disabled with explanations.
- [ ] Finish browser checks for connection removal, all file actions, Photos and New. Automated tests are not a substitute for these checks.
- [ ] Complete real laptop-to-T7 verified-copy test. Three synthetic files were created only under `/home/teo/Drive/Drive/Alpha-UI-check-20260904`; no real T7 transfer has been performed in this audit yet.
- [ ] Package/install the corrected build. Installed Alpha on port 43172 is unchanged; isolated QA instance on 43173 uses a separate test catalog.

## Desktop beta UI pass (supersedes older pending UI notes below)

- [x] Drive: icon-labelled item menus, local favorites/tag browsing, tag creation, existing template menu, system Trash entry. Removed redundant nonfunctional Move/More detail buttons; use the working item menu.
- [x] Photos: per-item rename/copy/move/trash/favorites/tags, sorting, refresh, Favorites/Tags views and system Trash entry. Filters/search apply to loaded pages, not an indexed whole-library search.
- [x] Screenshots: Collections always contains Screenshots. The local source uses Qt's system Pictures location, verified live as `/home/teo/Εικόνες/Screenshots`, not a hard-coded English directory. Existing images display in place; they are not automatically imported or backed up. Imported phone screenshot folders join the collection from loaded Photos items. Pagination is explicit.
- [x] Sync: actual Sync now opens per-route preview/confirmation. Notifications contain transfers, errors, mount prompts, pending hub work and photo-export progress. A lost API connection is not silently presented as healthy.
- [x] New: document scanning opens an installed desktop scanner; QR scans a local image or opt-in camera without opening decoded links; shared local New tag; existing import preview; real verified `.ldrive` export.
- [x] Export writes ZIP64/Zstandard with SHA-256 manifest, rereads every archive member, and publishes without replacing an existing file. Originals stay unchanged. Progress remains visible on Sync and can be reattached after tab navigation while the backend is running.
- [x] Removed false per-file verification labels derived solely from destination availability. Per-file location certification needs actual receipt evidence; unknown now says Not checked, without a green checkmark.
- [x] Browser-only backend launch stays alive without a QML window and does not auto-start saved wireless settings.

### Checks and remaining release gates

- TypeScript check, production build, 7 frontend checks and 11 CTest checks passed during this pass. New tests cover the localized screenshot source/thumbnail, shared photo tags, non-overwriting archive export/manifest verification, and QR pixel decoding. Live screenshot thumbnails were visually verified; New dialogs and four-tab navigation checked in browser.
- Not a Syncthing replacement or 1.0 claim. Real-device unplug/replug, disk-full, process restart/recovery, hub forwarding and source cleanup acceptance still need dedicated copied-data tests.
- Archive browsing/extraction inside the application is still missing. Export jobs are session-only, not persistent history; forced shutdown can leave an incomplete `.partial` file. Python 3.14+ is required; release packaging must include/check that dependency. Existing package version remains alpha, not a published beta.
- Folder copy remains disabled; large single-file copy is synchronous. Labels are local, do not follow external renames, and are not restored automatically with system Trash. Photos use a bounded page buffer but rescan directories per page. Camera hardware and physical document scanning were not exercised.
- Live catalog contains previously saved test-named devices (e.g. simulated phone); these were not deleted or relabelled. They are saved catalog records, not current UI fixture injection.
- Location/geographic grouping remains explicitly deferred. No Android APK or wireless rollout in this pass.

## Next session — menu icons

- [x] Added consistent icons beside Rename, Copy, Move, Favorites, Tags and Move to Trash; kept text, disabled states and destructive styling.

## Desktop 1.0 readiness — end-of-day assessment

- Current stage: functional alpha, not a Syncthing replacement. Latest run passed 10 backend tests, 6 frontend tests and production build; menu/list/grid were visually checked in fixture mode. This is not a real-device migration acceptance run.
- Release gates: finish core live UI flows (dashboard sync/notifications, tags/favorites browsing, photo tags/trash, restore); complete agreed compressed photo-library export and scanning scope or explicitly defer it; verify import/re-import, interruptions, unplug/replug and mount identity, disk-full handling, hub forwarding, restart/recovery and cleanup only after verified required copies.
- Known file-action limits: folder copy, large-copy responsiveness, cross-device label propagation and tracking labels through external renames remain open. No calendar estimate or completion percentage is established by the passing tests.
- Next milestone: controlled live desktop beta using copied test data, followed by user testing; Android/Wi-Fi remain outside this desktop milestone.

## Per-item Drive menu

- Added a native popover ⋮ for each item in list/grid, with Rename, Copy, Move, Favorites, Tags dialog, and Delete to system Trash. Native modal focus/Escape behavior; no nested row buttons.
- Live API validates paths, rejects symlink/hidden application paths and stale items, blocks edits during known transfers, never replaces destinations. Rename/move use atomic no-replacement within one filesystem; Copy checks SHA-256 and keeps the source. Cross-device operations remain in Sync & Connections.
- Tags/favorites persist atomically in a local catalog-adjacent labels file and follow in-app renames/moves (including folder descendants). They are not yet replicated across devices, and external renames do not yet migrate labels.
- System Trash is recoverable using the desktop file manager; no permanent-delete fallback. Folder copy remains explicitly disabled. Synchronous copy is still a responsiveness limit for large files.
- Fixture mode previews menus/dialogs only and never mutates real files. Live backend must use the rebuilt executable. Favorites/Tags sidebar-wide browsing is still pending.
- Regression checks cover content-preserving copy, collision rejection, stale item rejection, labels persistence/migration, reserved paths, symlink escape, and folder rename. Browser checked the file menu and tags dialog.

## Latest scope clarification

- Export in New means manually creating a compressed read-only photo library on chosen storage, not a transfer manifest or ordinary folder export. Still open until archive creation and read-only browsing are wired end to end.
- QR scanning is requested for laptop use, distinct from document scanning. Pending camera permission flow, supported decoder and safe presentation of decoded data (never auto-open/run QR contents).
- Screenshots belong in Collections, grouped using recognised PC/phone screenshot folder paths, not their own sidebar tab. Implemented grouping and removed sidebar entry; source files remain unchanged.
- The large dashboard card is Notifications; active transfer belongs inside it. Renamed accordingly; richer notification feed remains pending.
- Tags, sorting and an actual Sync now start/preview action remain acceptance items; headings alone do not satisfy them.

## Application template folder

- Templates now resolve from the configured Drive root's `.templates`, not `~/.local/share/local-drive/templates`.
- Created the requested examples at `/home/teo/Drive/Drive/.templates`: `Νέο αρχείο.txt` and `New Scrip.sh`. The script is a non-executed starter, not a launched command.
- Root-level `.templates` is excluded from verified library transfer scans; normal hidden-folder filtering already excludes it from gallery/files listing and inventory scans. Template-generated output cannot target that reserved folder.
- Fixture mode still does not read real templates. Live API must run the rebuilt binary for the new path to apply.

## Drive menu scope clarification

- [x] Right menu now contains New folder, New templates, New tags (explicitly unavailable), Sync Drive now. Import remains in New.
- [x] Sync Drive now reuses route preview/confirmation controls filtered to Drive, excluding Photos; empty and offline routes explain what is missing.
- [x] TypeScript check and build passed. Tags remain unimplemented; this menu change does not close that backend gap.

## New scope correction

- [x] New contains Scan, Tag, Import and Export cards. Import opens the existing dialog; unimplemented actions are explicitly disabled.
- [x] Templates moved into a dialog opened from Drive's right toolbar menu → New file. The current Drive folder is retained.
- [x] Browser visual check of New passed at 1117×811; TypeScript and production build passed. This does not mark scanner, tagging or library export functionality complete.

## Drive layout regression fix

- [x] Demo notice now lives inside the title row rather than creating an implicit fourth grid row.
- [x] File actions moved to the right toolbar position, replacing the disabled View options control; dropdown opens inward.
- [x] List column headers disappear in Grid mode; grid rows align to the top.
- [x] Browser checked List → Grid → right menu → Escape → List at 1117×811. Toolbar stays in place, headers return only in List, and menu content is visible. TypeScript check and production build passed.

Scope: each item from the user's screenshot review. This is an inspection and implementation backlog, not a declaration that the features are finished. No personal files were imported, moved or deleted during this inspection. Android/Wi-Fi remain out of scope.

**Verdict: not ready to replace Syncthing.** Controlled copy-only trials are appropriate; retain Syncthing and the original data until the release gates below pass. The earlier claim that the connection work was complete was too broad: compilation and component tests did not establish end-to-end completeness.

Legend: `[x]` = inspected; open acceptance checkboxes mean work remains.

## 1. Current transfer

- [x] The screenshot's 67%, 8 TB / 12 TB and T7 are fixture values (`web/src/App.tsx`, `demoState`). The currently opened `?fixture` URL is a simulation.
- [x] The non-fixture UI reads `catalog.activeTransfer`; `src/localapi.cpp`, `catalogSummary`, projects job progress from the catalog. It has a real backend, not only a placeholder.
- [ ] Show a prominent Demo label in fixture mode; never show sample status as real while loading or when the API fails.
- [ ] Exercise a real isolated transfer and verify progress, destination, cancellation, completion and idle state in the dashboard. The unconditional label “Backing up” must reflect the actual operation/state.

## 2. Total system storage across devices

- [x] Current storage card shows separate volumes, not an aggregate (`SyncView`).
- [ ] Add combined total, used and remaining capacity above the per-volume rows.
- [ ] Deduplicate physical/filesystem capacity by stable identity: two managed folders on one filesystem must not count twice. Include phone capacity only when actually reported. Missing capacity is unknown, not zero.
- [ ] Separate online/current capacity from last-reported offline capacity, with freshness and excluded/unknown-device count. Label this as physical capacity, not unique-file size or guaranteed backup capacity.

## 3. Problems & Fixes — is it real?

- [x] The displayed five issues and decision history are fixture examples. Fixture actions mutate browser state only (`demoProblems`, `applyProblemAction`).
- [x] Real `/api/v1/problems` and `/api/v1/problem-action` endpoints exist. Import findings and resolutions persist in the catalog. `applyProblemAction` validates eligible actions and records history (`src/localapi.cpp`).
- [x] Existing-copy acceptance, keep-both conflict handling and unsupported-source skipping feed import execution. This is not a universal repair system: every problem is not automatically fixable.
- [ ] Validate each exposed action through UI → API → filesystem/catalog → restart, including pending/offline corrections. Do not claim a cross-device correction has applied until its result is confirmed.

## 4. Photos collections / Screenshots

- [x] Collections currently group by source subfolder (`LocalApi::photos`, `PhotosView`). There is no dedicated Screenshots smart collection. Existing screenshot folders may appear by their folder names.
- [x] Real photo thumbnails have an API and test coverage; fixture thumbnails use crops of a mockup. Video thumbnails currently show a placeholder icon.
- [ ] Add a Screenshots collection based on source-folder/provenance, retaining originals and existing collections. If “screenshots” meant missing collection cover images, also verify representative covers and video-first collections.
- [ ] Remove the silent practical limit: the API stops at 500 media entries and returns `truncated`, but the UI does not explain or paginate this. Also distinguish filesystem-created/modified dates from EXIF capture dates.

## 5. Location grouping — deferred by request

- [x] Current search is filename-based; the photo response does not expose GPS/place metadata.
- [ ] Later: extract GPS locally, preserve source metadata, cache place labels locally and provide optional place/map grouping.
- [ ] Select an open map/reverse-geocoding provider later, checking attribution, privacy, limits and offline behavior. Explicit consent before sending photo coordinates to a service. No GPS means “No location”; do not guess.

## 6. Move New/file actions into Drive

- [x] New currently holds folder creation and import; single-file creation, scanner and Sync now are disabled. Drive's More action is also disabled.
- [ ] Move working folder/import actions to a toolbar three-dot menu; item actions belong in a row menu with keyboard-accessible equivalents to right-click.
- [ ] Preserve root/path validation and selection context; never put destructive operations behind an ambiguous click. Remove duplicate New actions after migration.

## 7. Add file through templates

- [x] No template intake/creation flow exists in the inspected web UI/API.
- [ ] Use a hidden templates folder plus a grid showing the actual available templates. Copy a template into the active Drive folder with a chosen filename and collision checking.
- [ ] Treat templates as data: never execute scripts or macros during preview/creation. TXT/SH can be text; DOCX/other structured files need valid supplied templates, not renamed empty text files.
- [ ] Define templates as app-local by default and explicitly exclude them from normal library scans; expose their folder through Advanced settings.

## 8. Sync now belongs on Dashboard

- [x] New's Sync now is disabled. Dashboard Check connections only refreshes discovery/state; it does not start synchronization. Working route preview/execute controls are in Drive Settings.
- [ ] Move the transfer entry point to Dashboard with preview, offline/waiting feedback and per-route results. Do not label discovery refresh “Sync now”. Prevent duplicate concurrent runs.

## 9. Can this replace Syncthing now?

- [x] Folder import preview/execution, verified transfer, duplicate/conflict handling and catalog history have backend implementations. These support controlled evaluation, not a complete migration guarantee.
- [x] **Release-blocking mismatch:** `SetupModel::updateRouteCard` accepts `Move` with `Last week`/`Last month`, but `VerifiedCopy::preview` requires `(keepPolicy == "Nothing") == (behavior == "Move")`. A saved card can therefore fail transfer preview. The settings persistence test alone does not cover this.
- [x] The map is not yet strictly derived from cards: `ConnectionMap` invents “Sync” edges for discovered devices, includes unconfigured storage edges and slices devices/storages to four each. It must not imply configured relationships that do not exist.
- [ ] Fix those contract mismatches and add end-to-end card → preview → execution tests. Preserve cleanup safety rather than merely removing validation.
- [ ] Validate migration using a copy of a representative Syncthing tree: repeated import, same content/different name, same name/different content, interrupted copy, unplug/replug, changed mount path, insufficient space and catalog restart.
- [ ] Verify hashes/receipts at every required destination before any source cleanup. Test recovery/restore and pending hub drainage. Keep original data and independent backup throughout.
- [ ] Reconcile manual filesystem edits reliably and establish wired multi-device behavior, not just one-way route execution. A successful test suite is not proof of Syncthing parity.

## 10. Simpler settings

- [x] Settings currently duplicates route setup and exposes technical paths through `RouteSetup`; this remains in the relationship wizard too. Only the existing card's path details are collapsed.
- [ ] Keep ordinary connection setup in cards. Place source/destination overrides, limits and technical identity under Advanced; retain automatic proposed folders.
- [ ] Keep statuses and failures visible without technical forms. Settings should contain global preferences, hidden devices and Advanced—not a second competing relationship editor.

## 11. New tags / file Trash

- [x] Drive Tags, Trash and Favourites are disabled navigation items (`fileNav`). They are not finished features.
- [x] The transfer core has verified-source cleanup to Trash and associated tests; this is not a browsable user Trash with restore controls.
- [ ] Implement tag create/rename/assign/remove backed by metadata, and file Trash list/restore with collision handling and recorded provenance. Separate removing a tag from deleting a file.
- [ ] Specify deletion propagation and retention before enabling permanent deletion. Do not infer that deleting one local copy means deleting every device's copy.

## 12. Photos tags / Trash

- [x] Photo navigation has neither Tags nor Trash (`photoNav`).
- [ ] Reuse the file tag/Trash backend for photos and videos, with media previews and the same restore/safety semantics; do not create a separate incompatible implementation.

## Verification and next order

### First implementation pass

### Dashboard implementation pass

- [x] Dashboard now exposes per-route preview, explicit transfer confirmation, pause/resume/cancel and history through the existing RoutePreviewButton/API. Removed the dead Sync now action from New. The older Settings entry remains available for compatibility.
- [x] Prevented resetting a route preview while that component is transferring; backend rejects another active operation on the same route.
- [x] Added reported-online volume capacity total/used/free and exclusions, deduplicated by reported identity (ID fallback). Offline, missing and invalid capacities are excluded rather than treated as zero. Phone capacity is explicitly excluded if unreported.
- [x] Added `node --experimental-strip-types --test tests/storage-totals.test.mjs`, covering shared identity, missing capacity, offline storage, invalid values and empty inventory.
- [ ] Still verify physical filesystem aliases across differently reported identities, real dashboard transfer with attached devices, and UI behavior when navigating away from a running transfer. Do not treat this subtotal as a complete inventory of every device.

### Prior pass results

### Drive actions pass

- [x] Added native keyboard-accessible disclosure menu (⋮) to the Drive toolbar: New folder here uses the current folder; Import explicitly targets the configured library root. Folder creation is disabled outside the Home folder view. Escape closes the menu and restores summary focus.
- [x] Reused existing validated create-folder and import workflows. Added demo guards before their API calls: fixture dialogs must not create folders or launch real imports.
- [ ] New tab still retains the original shortcuts pending its templates replacement. Item-row actions, menu browser interaction testing and a full demo-write audit remain open.
- [x] TypeScript and existing four web packaging tests passed; these do not establish browser interaction correctness.

- [x] Fixture UI explicitly says Demo mode, simulated actions, and links to the live application. API-error fallback cleanup is still open.
- [x] Map no longer fabricates relationships for discovered devices or unconfigured storage; removed four-device truncation. Saved route properties supply edge labels. Visual interaction QA remains open.
- [x] Engine accepts Move with finite retention, while still rejecting Move + Everything and Copy + Nothing. Card API also rejects Move + Everything. Existing Copy-with-retention routes remain compatible; cleanup still requires its separate verified-source workflow.
- [x] Added and passed `VerifiedCopyTest::retainedMoveWaitsForCleanup`: finite-retention previews succeed, execution copies the file, source remains, and cleanup is pending.
- [x] TypeScript check, production web build and diff whitespace check passed.

These supersede the corresponding initial findings above, not the broader Syncthing replacement gate. Dashboard actions, capacity aggregation, Tags/Trash, templates and photo completeness remain open.

Inspection evidence: `web/src/App.tsx`, `src/localapi.cpp`, `src/setupmodel.cpp`, `src/verifiedcopy.cpp`, `tests/localapi_test.cpp`, `tests/setupmodel_test.cpp`, `tests/verifiedcopy_test.cpp`, and the four supplied screenshots. Current screenshots are fixture evidence, not live-transfer evidence.

Native regression run: `ctest --test-dir build --output-on-failure` passed 10/10 tests (37.34 seconds). These tests do not cover the newly identified card-to-engine contract mismatch. `git diff --check` passed. No hardware transfer or large Syncthing import was performed in this inspection.

1. Correct fixture labeling, card/engine contract and truthful map edges.
2. Dashboard aggregate storage and real transfer entry point; simplify settings and migrate New actions.
3. Photos completeness/pagination and Screenshots collection.
4. Templates, shared Tags/Trash and restore UI.
5. Isolated migration/recovery acceptance tests, then user desktop trial.
6. Location grouping later; Android/Wi-Fi remain deferred.

## Physical Xiaomi 15 / T7 inspection — 2026-09-06

- [x] Linux reported Xiaomi MTP + ADB. Local Drive initially found the phone name but no usable root because this KIO device returned blank `UDS_URL` values.
- [x] Added and tested the entry-name URL fallback. After restart, the live API reported one online Xiaomi 15 with a non-empty internal-storage `phoneRoot`.
- [x] Read-only bounded scan completed at 5 files / 5 MiB.
- [x] Real phone → T7 Drive import completed as five verified jobs. Independent source/destination SHA-256 checks: 5 checked, 0 missing, 0 read errors, 0 mismatches.
- [x] Real laptop → phone Drive export completed for one controlled file. The remote file was readable, 91 bytes, and its SHA-256 matched the laptop source.
- [x] Root-caused the duplicate T7 cards: verified phone jobs created enabled operational catalog routes, and `SetupModel` correctly displayed every enabled route. Import and export routes are now retained for receipts/history with `enabled=0` and no longer enter the connection UI.
- [x] Internal phone storage catalog rows are now marked onboarded; they must not trigger a second new-device question after the user accepts the phone.
- [ ] Hardware identity remains weaker than desired when KIO omits its URL: the current fallback is `mtp:<model name>`. udev exposes a serial for this device; safely mapping it when two identical models are attached remains open.
- [ ] Full native suite result: 10/11 test targets passed; `localapi_test` has one repeatable cleanup-review failure outside the touched MTP path. Focused MTP discovery, remote verified-copy and Local API phone tests pass. Web TypeScript/build pass; the package has no generic `npm test` script, so individual Node test files are the correct web test entry points.

## Real device identity and library usage — 2026-09-06

- [x] Reused Phosphor SVG components rather than adding a second icon asset system. Device UI selects Laptop, PC/Desktop, Server, Phone/Tablet, HDD or SSD from reported kind/media type.
- [x] Mounted removable storage media type comes from Linux `/sys/class/block/.../queue/rotational`; unknown values are not guessed.
- [x] `/api/v1/library-usage` scans actual configured local source folders and returns file/byte totals plus categories. Hidden templates and Local Drive partial files are excluded; the scan has an explicit 100,000-file completeness flag.
- [x] `LocalApiTest::reportsRealLibraryUsage` verifies Drive/Photos totals, type categories and internal-folder exclusion.
- [x] Live API evidence: T7-TEO = SSD, 1,967,846,088,704 bytes total, 841,447,129,088 bytes available; Xiaomi 15 = Phone, online over MTP, internal storage root discovered. These are runtime reports, not fixture values.
- [x] Web TypeScript/production build and all 10 Node tests pass. Native suite remains 11/12 targets because the pre-existing `reviewsVerifiedCleanup` failure is still reproducible; the new usage test passes.
- [ ] Browser automation could not open this loopback port because the embedded browser blocked it. Perform the visual spacing check in the already-open desktop browser before packaging.
