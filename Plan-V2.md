# Local Drive — wired beta roadmap

Updated: 2026-09-13. This is the active implementation plan. Start a new session
with [CONTINUE.md](CONTINUE.md). Older plans and audits are reference evidence,
not competing task queues. “Implemented” below means found in source, not accepted
on the final package.

## Scope and completion

Deliver Linux laptop → HDD/SSD, Android USB/MTP → disk or laptop Cache,
Cache → disk, selected verified backup → laptop, and existing single-file export
→ phone. Local Move requires separate reviewed cleanup to Trash. Phone import
preserves originals. No general bidirectional sync is implied.

Beta is complete only when one identifiable packaged build passes the acceptance
matrix below. Keep Wi-Fi/pairing, PC/server receiving, universal receiver Cache,
OTG, deletion propagation and Syncthing replacement outside this release.

## What exists now

| Area | Source evidence | Remaining acceptance |
|---|---|---|
| Verified local copy / Move | `src/verifiedcopy.cpp`, cleanup API and connection cards | Physical interruption, cleanup and restore on disposable files |
| Bound phone preview | `src/localapi.cpp`, phone selection in `web/src/App.tsx` | Reconnect, wrong phone/disk, changed route between preview and execution |
| USB/MTP identity | `src/setupmodel.cpp` serial matching and legacy-ID migration | Ambiguous identical models must not inherit routes or trust |
| Detailed phone preview | `startRemoteImportDirectory`: hashes, identical/duplicate/conflict/unsupported/unreadable findings | Review-to-execution behavior for every finding; no preview writes or receipts |
| Scan cancellation | `src/remoteinventory.cpp` watchdog; engine cancel/deadline; `BackendActivity.tsx` scan cancel | Cancel during listing and hashing; reload and stalled real MTP |
| Backup restore | `restore-preview` → `import-execute`; selected paths and expected hashes in `VerifiedCopy` | Changed/missing backup, conflict, final UI and physical acceptance |
| Cache / schedules / activity | Existing model, API, `SyncSchedules.tsx`, `BackendActivity.tsx` | Restart, missing disk, capacity threshold, forwarding and no double execution |
| Packaging | CMake bundles React; `tests/package_smoke.py` tests extracted package | New identifier, migration, installed launch and same-package hardware gates |

## Ordered work — one bounded slice per session

### 0. Establish the current baseline

Run the commands in CONTINUE. Record failures exactly before editing. Preserve
uncommitted work and use an isolated QA catalog. Never infer today's runtime from
old session IDs, ports or installed Alpha labels.

### 1. Close identity and preview gaps (V2.1 / V2.2) — next implementation slice

Trace UI → LocalApi → VerifiedCopy → remote inventory and back to operation state.
Exercise two phones/routes, ambiguous identity, changed destination and reconnect.
Exercise identical files, duplicates, conflicts, unsupported/unreadable entries,
Unicode, empty files and nested folders. Confirm each finding has a safe review
or explicit blocking outcome and cannot be bypassed at execute.

Verify cancellation during listing and hashing, timeout termination and UI recovery
after tab changes/reload. Inspect all scan callers: default arguments in the shared
inventory helper do not prove each caller enables cancellation/deadlines.

**Done when:** focused tests prove preview creates no destination files or transfer
receipts, execution uses the exact confirmed selection, changed evidence fails safely,
and cancellation terminates work with truthful state. Record real-MTP checks separately.
Do not reimplement existing hashing, cancellation or serial association.

**Implementation record (2026-09-13):** successful phone-preview SHA-256 evidence
is now retained privately and required by the one-time execution. A same-size source
mutation after preview is rejected before a destination file or verified receipt;
the focused `localapi_test` proves this. Real-MTP reconnect, ambiguous-device,
cancel-during-hash and route-switch acceptance remain pending.

### 2. Recovery and Cache (V2.3)

Test interruption during copy, disk removal, phone disconnect and backend restart.
Check catalog/UI reconciliation, partial-file handling and safe retry without an
unwanted second copy. MTP may restart an incomplete file; do not promise byte resume.

Run phone → laptop Cache with final disk absent; enforce the percentage threshold
(80% default), preserve existing data, reconnect disk, preview and forward explicitly.

**Done when:** sources survive failures, partials never appear verified, history is
truthful, retries succeed, and final-destination SHA-256/receipts exist before cleanup.

### 3. Move and selected restore (V2.4)

Finish the existing restore path rather than adding another engine. Cover changed
backup before/during execution, missing storage and existing local filename conflicts.
Use disposable files for Copy → Verify → Receipt → cleanup review → Trash and recovery.

**Done when:** restored bytes match the receipt, conflicts preserve originals, and
changed/unavailable evidence prevents cleanup. An uncertain Trash result stays pending.

### 4. UI and release acceptance (V2.5)

Exercise bundled UI: onboarding → connection → preview → copy → history → restore.
Check keyboard use, narrow window, absent devices, >500 media, reload and schedules.
Measure large-library behavior before introducing performance abstractions.

Update the version consistently in CMake, application version, package smoke and
release notes. Build Release, run CTest, package with CPack, extract into a temporary
directory and run `python3 tests/package_smoke.py <extracted>/usr`.
The smoke currently requires port 43172 free: inspect ownership/active work first.
Back up the catalog before an approved installation/migration trial; verify retained
routes/history and menu launch without Vite. Record the artifact path and SHA-256.

**Done when:** the same identifiable package passes every required row below.
Hardware or installation checks that cannot run remain explicitly pending.

## Required acceptance record

For each row record build identifier, date, test/fixture, result and evidence path.
Use only agreed disposable test files for hardware work.

**Development hardware evidence (2026-09-13):** `inspections.md` records a Xiaomi
15 → T7 core-engine preview/copy/repeat/conflict pass with an isolated catalog and
disposable fixtures. It does not close a row below: beta requires the same evidence
from one identifiable package and the complete scenario scope.

| Scenario | Required proof | Final-package status |
|---|---|---|
| Laptop and phone → disk | SHA-256, receipt, source retained, non-mutating preview | Pending |
| Repeat / conflict | No extra identical copy; differing originals preserved | Pending |
| Identity / reconnect | Stable same device; other device cannot inherit trust/route | Pending |
| Cancel / disconnect / restart | Bounded termination, truthful state, safe retry | Pending |
| Cache / forwarding | Capacity enforced; final receipt before any cleanup | Pending |
| Local Move / restore / phone export | Disposable-file recovery, hashes, conflict handling | Pending |
| UI / scale / schedules | Keyboard, narrow view, >500 media, no duplicate scheduled job | Pending |
| Package / migration | Bundled launch, preserved catalog, exact artifact recorded | Pending |

## Evidence and document maintenance

Historical: Plan.md and inspections.md record laptop/T7 and phone trials from
05–09 September. The prior V2 plan records a 09 September 12/12 native baseline
and 10/10 web checks. These results predate later work and are not current acceptance.
Fresh verification for this documentation pass is recorded in CONTINUE.md.

Keep next-session instructions in CONTINUE and remaining scope/status here.
Append detailed physical/inspection evidence to inspections.md and visual evidence
to design-qa.md only when new checks occur. SPEC.md remains the safety/behavior
reference; Plan.md is historical product scope. Consult relevant sections as needed,
not all 2,000+ lines at every session. Older frontend parity gaps describe later
wireless work, not the next wired-beta priority.

Pre-simplification README, handoff and V2 plan are preserved in
[the dated archive](docs/history/2026-09-13-before-handoff/).
