# Resume Local Drive — desktop laptop/T7 acceptance completed 2026-09-06

The user resumed on 2026-09-06. Laptop-to-T7 settings and transfer acceptance
are complete in the isolated development catalog; the next physical-device gate
is the phone in Android file-transfer mode. Do not treat this as whole-beta or
Syncthing-replacement acceptance.

The isolated backend is running on port 43173 with the T7 mounted at `/mnt/T7`.
Its safe final route is Copy + Keep Everything, Cache off, with no active work.
`Plan.md` and `inspections.md` contain hashes, remount, removal and regression
evidence. Installed Alpha/GitHub remain unchanged.

## Settled requirements

- Cache is available on incoming connections whose receiver is a computer: Laptop, PC, Server. It is not specific to phones. No Cache control on direct outgoing laptop → disk cards.
- Cache limit: percentage only; 80% default; control under Advanced. No GB limit. Notify at threshold; stop new intake while preserving existing files.
- Frontend must reflect real C++ backend capabilities. Audit native QML → LocalApi → TypeScript, not repeated cosmetic enabling of unsupported buttons.
- Earlier implemented: hide/show devices, removal preserving files/history, verified Move with reviewed Trash cleanup, Keep last year; daily/weekly/monthly/once schedules with pending/manual restart. Separate removal including data deletion still needs exact scope; never interpret as whole-disk deletion.

## Current worktree (uncommitted; preserve all other changes)

- `frontend-backend-parity.md` records inspected native/API/web coverage and real backend gaps.
- Latest changes remove Cache from outgoing cards and create `state.incomingConnections` for supported USB/MTP intake, with backend `receiverKind`, transport and `cacheSupported` fields. `CacheAdvanced` appears in incoming cards. Generic PC/server receive routing and wireless intermediate caching are NOT implemented yet; the universal receiver-computer requirement is not fully satisfied.
- Added `state.operations` plus `web/src/BackendActivity.tsx` for ongoing transfer progress/pause/resume/cancel after changing tabs.
- Added receiver status publication from `main.cpp`, token-protected `/api/v1/wireless-control`, and web start/stop of an existing secure saved profile. No receiver was started during QA. Explicit start calls existing start(saved fields), because startSaved refuses after stop sets savedEnabled=false.
- Added existing clone-files-map API button for Photos when no Photos routes exist.
- Missing native bridges: secure profile configuration/import/export; wireless/USB identity association. Backend `updateRouteRelationship` explicitly rejects receive=true, so general multi-computer incoming/two-way routes are a backend gap, not merely lost UI.

## Validation and runtime

- Latest full API suite: 20 passed, 0 failed (`/tmp/parity-api-tests.log`). Includes incoming capability projection, wireless API authorization/control bridge, active paused operation in state.
- Latest TypeScript/build completed (`/tmp/parity-final-build.log`); `git diff --check` clean.
- Previous cache work passed 25 model tests, targeted transfer safety tests, percentage enforcement / source retention / forwarding E2E using simulated phone transport. No physical full-disk or phone interruption QA.
- Latest visual QA is unfinished: demo tab 6 was opened on Sync, but new incoming cards, wireless section and live activity still need screenshots/interactions. Demo tab need not survive pause.
- Running backend is previous build, exec session 72673, command `./build/local-drive --web-only`, port 43172. Vite at 5173 hot-reloads current frontend. New compiled backend has NOT been restarted into service, so new API fields will be absent until restart. Do not assume live frontend/API parity yet.
- On resume: inspect fresh processes/active transfers, finish visual QA, restart only owned idle backend with current build, verify live API fields and UI. User's browser tab 3 and agent live tab 2; don't overwrite user form state.
- No real schedules, transfers or cache settings changed during this pass. No commit, package install or deployment.

## Recommended next chapter

Complete secure pairing/profile lifecycle and understand incoming route storage/destination semantics before extending Cache beyond MTP. Do not fake generic computer/server support. Reuse verified C++ transfer core, receipts, identity checks and explicit Move cleanup; keep loopback API. Current cache configuration is stored alongside outgoing forwarding routes but presented as incoming intake; evaluate the model before expanding transports.
