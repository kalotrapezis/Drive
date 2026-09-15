# Local Drive

Local-first Linux and Android file/photo transfer, using a C++/Qt safety core,
SQLite verification receipts and a React desktop interface.

**Current target: a verified wired beta.** Existing Alpha 3 release instructions
are in [RELEASE_NOTES.md](RELEASE_NOTES.md); they do not certify the current
uncommitted development build. This is not yet a replacement for existing backups.

## Continue development

1. [CONTINUE.md](CONTINUE.md) — Sol handoff, first task and verification commands.
2. [Plan-V2.md](Plan-V2.md) — ordered remaining work and beta acceptance criteria.
3. Read relevant [SPEC.md](SPEC.md) sections when changing safety or behavior.

The next task is to verify and close the existing identity/preview/cancellation
flow, then finish recovery/Cache, Move/restore, and packaged UI acceptance.
Wired beta excludes Wi-Fi, generic two-way sync and Android OTG.

## Build and preview

Native prerequisites: CMake 3.24+, C++20, Qt6 and KDE Frameworks 6
(Kirigami, Solid, KIO). See CMakeLists.txt for exact components.
The web build requires Node/npm; photo archive support requires Python 3.14+.

```sh
npm ci --prefix web
cmake -S . -B build
cmake --build build -j2
```

For development, start `./build/local-drive --web-only`, then run
`npm run dev -- --host 127.0.0.1` inside `web/`. Open
<http://127.0.0.1:5173/>. `?fixture` shows simulated data.
Inspect existing backends and active transfers first. Use an isolated catalog
and disposable files for QA; an ordinary launch can open the real local catalog.
Packaged builds serve their bundled UI without Vite. The old QML UI is available
with `--legacy-ui`.

## Safety contract

Copy → SHA-256 verification → receipt. No silent overwrite or destination switch.
Local Move adds separate source-cleanup review before Trash. Phone intake keeps
originals. Cache is not a verified final backup until forwarding is verified.

## Reference documents

| Document | Purpose |
|---|---|
| [SPEC.md](SPEC.md) | Detailed behavior and safety contracts |
| [Plan.md](Plan.md) | Historical product plan and session record |
| [inspections.md](inspections.md) | Dated inspection and physical-test evidence |
| [design-qa.md](design-qa.md) | Dated visual QA evidence |
| [frontend-backend-parity.md](frontend-backend-parity.md) | Earlier API/UI audit, including deferred wireless gaps |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Alpha package instructions and limitations |
| [Earlier README](docs/history/2026-09-13-before-handoff/README.md) | Detailed CLI, Android and architecture reference; historical status |

Design sources remain under `design/`. New work belongs in this project root.
Update CONTINUE and Plan-V2 for current work; avoid adding another parallel plan.
