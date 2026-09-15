# Continue Local Drive with Sol

Updated: 2026-09-13. Start here; [Plan-V2.md](Plan-V2.md) owns the remaining roadmap.

## Objective

Finish the agreed **wired beta**: laptop → disk, Android USB/MTP → disk or laptop
Cache, Cache → disk, selected backup restore, and existing single-file phone export.
Phone intake stays Copy. Wi-Fi, generic two-way sync, PC/server receiving and OTG
are later chapters. Do not expand scope to finish the older product wishlist.

## Starting state

- Branch inspected: `codex/live-ui-audit`, with extensive uncommitted native,
  Android, web, tests and documentation work. Preserve it, including untracked files.
  Do not reset, clean, or switch to a checkout that omits these changes.
- Code inspection found bound phone/route previews, USB serial matching,
  hash-based phone preview, scan cancellation/deadline, and receipt-bound restore.
  These are existing implementations to verify and finish, not new features to rebuild.
- Historical physical checks covered laptop/T7 and controlled phone/T7 transfers.
  They do not certify today's source or a new package. See the roadmap's evidence section.
- No running process, port, mount, installed version or old `/tmp` log is a durable
  handoff fact. Inspect fresh state before any live test or restart.

## First Sol session

1. Read applicable `AGENTS.md`, this file and `Plan-V2.md`. Use Ponytail; use
   Project Grilling only if a new consequential choice cannot be resolved from the plan.
2. Inspect `git status --short` and the relevant diff. Record the baseline checks
   below. Keep unrelated changes intact; do not commit the whole dirty tree.
3. Work on **step 1 of Plan-V2**: verify the existing V2.1/V2.2 end-to-end contract,
   then fix the smallest demonstrated remaining gap. Read callers before changing
   a shared function. Do not start with wireless pairing.
4. Run the relevant regression checks. Record what changed, what passed and what
   still needs hardware. Update the roadmap and this handoff at the end of the slice.

## Baseline commands

Run from the project root; configure with `cmake -S . -B build` if needed.
Use `npm ci --prefix web` only if dependencies are missing.

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
python3 tests/test_schema.py
(cd web && npm run check && node --test tests/*.test.mjs && npm run build)
git diff --check
```

CTest includes existing wireless regression targets; running them does not expand
product scope. A passing automated suite does not replace UI, hardware or package acceptance.

## Safety and implementation rules

Reuse C++ `VerifiedCopy`, SQLite receipts, `LocalApi`, and existing React controls.
Never silently change destination after preview. Recheck device/storage identity
and route revision. Keep sources until verified final-copy evidence and a separate
cleanup review permit Trash. A Cache receipt alone is insufficient for cleanup.
Use isolated catalogs and disposable files; do not use personal libraries as test loads.
Inspect active work before restarting an owned backend. Hardware intervention or
unapproved destructive cleanup stays pending while independent work continues.

## Verification on 2026-09-13

The identity/preview implementation slice bound every successful phone-preview hash
to its one-time execution. The hashes stay server-side; changing a same-size phone
file after preview now fails before publication or a verified receipt. The focused
`localapi_test` regression uses `nested` → `mutate` and confirms no destination
file and no MTP verified receipt. This does not certify real-MTP reconnect,
disconnect, package installation, physical transfers or live UI acceptance.

- Native build passed, including web TypeScript check and production build.
- CTest: 12/12 targets passed. Schema check passed. Web tests: 10/10 passed.
- Fresh Xiaomi 15 → T7 development-core acceptance passed: non-mutating MTP
  preview, SHA-256 verified copy with retained phone source and receipt, repeat
  without a second destination file, and conflict rejection preserving both
  originals. Details: `inspections.md`; this is not installed-package or LocalApi/UI
  hardware acceptance.
- Active documentation links and `git diff --check` passed.
- Temporary logs: `/tmp/drive-handoff-build.log`, `/tmp/drive-handoff-ctest.log`,
  `/tmp/drive-handoff-schema.log`, `/tmp/drive-handoff-web-tests.log`.
  These paths are convenience evidence for this run, not guaranteed to survive.
- Final-package, UI and physical acceptance remain pending in Plan-V2.

## Paste into Sol

> Continue this project's wired beta. Read CONTINUE.md and Plan-V2.md, preserve the
> dirty worktree, and complete roadmap step 1 first. Verify existing code before
> adding anything. Use the existing safety core and focused regression tests.
> Report the exact next unfinished step and update the handoff when you stop.
