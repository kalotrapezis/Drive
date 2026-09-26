# Tetra for the desktop

![Tetra on the desktop and on a phone: Photos, Home and Notes](Assets/screenshots/tetra-card.png)

**Your photos, files and notes, kept on your own devices.** Tetra for the desktop is the computer side of
[Tetra for Android](https://github.com/kalotrapezis/Drive-Android): a photo library, a file manager and notes, which
your phone and tablet sync with over your own Wi-Fi. Nothing is uploaded anywhere. Faces, documents and search labels
are analysed on this computer.

**Current release: 0.3.0 Beta 1** (Linux, `.deb` and AppImage). It is the first beta: in daily use by its author, but
keep your own backups.

| Photos | Files | Notes |
|---|---|---|
| ![Photos](Assets/screenshots/desktop-photos.png) | ![Files](Assets/screenshots/desktop-files.png) | ![Notes](Assets/screenshots/desktop-notes.png) |

<sub>Screenshots use demo content, not a real library.</sub>

## What it does

| | |
|---|---|
| **Photos** | Week, month and year timeline, collections, favorites, folder albums, People, Documents, a map, search, an editor and an encrypted **Hidden** vault. |
| **Files** | `~/Tetra/Files`, with tags, favorites, folder colours, a reversible Trash, and import in verified batches. |
| **Notes** | Notes and checklists with colours, labels, pins and a history of three versions. They sync with the phones. |
| **Devices** | Pair a phone or tablet by QR code. Every photo and file is checked by SHA-256 on arrival. Rules per device and per kind of content: send, both ways, or Move. |
| **Storage drives** | A USB drive as a **backup** (a verified copy) or as **storage**: old photos move there and still show in the library. Tetra tells you before the disk fills up ("Free 21 GB?"). |
| **Trash → purgatory → gone** | Deleted items wait 30 days in the Trash, then 30 more in a purgatory, before they are really gone. |

## Install

Download the `.deb` or the AppImage from [Releases](https://github.com/kalotrapezis/Drive/releases).

```bash
sudo apt install ./local-drive-desktop_0.3.0-beta.1_amd64.deb
```

The AppImage needs `libfuse2` on Ubuntu 24.04 and newer. Tetra keeps running in the tray when its window is closed.

## Build

The app is in [desktop/](desktop/README.md) (Electron, React, TypeScript).

```bash
cd desktop
npm ci
npm test
npm run dist    # release/*.deb and *.AppImage
```

## Documentation

| Document | Purpose |
|---|---|
| [desktop/README.md](desktop/README.md) | The desktop app's code map, folders and development commands |
| [SYNC_PLAN.md](SYNC_PLAN.md) | Sync design and every rule's reason (the same file in both repos) |
| [HANDOFF.md](HANDOFF.md) | Where work stands, newest first |

---

## History: the C++/Qt "Local Drive"

Until September 2026 this repository was a C++/Qt desktop app. That code is still here, as a reference for its
safety rules, but it is no longer developed. What follows is its original README.

## Local Drive

> **2026-09-22:** Direction changed. This C++/Qt project is now a reference for
> safety rules; the desktop app is being rebuilt in Electron in [desktop/](desktop/README.md). See [SYNC_PLAN.md](SYNC_PLAN.md).

Local-first Linux and Android file/photo transfer, using a C++/Qt safety core,
SQLite verification receipts and a React desktop interface.

**Current target: a verified wired beta.** Existing Alpha 3 release instructions
are in [RELEASE_NOTES.md](RELEASE_NOTES.md); they do not certify the current
uncommitted development build. This is not yet a replacement for existing backups.

### Continue development

1. [CONTINUE.md](CONTINUE.md) — Sol handoff, first task and verification commands.
2. [Plan-V2.md](Plan-V2.md) — ordered remaining work and beta acceptance criteria.
3. Read relevant [SPEC.md](SPEC.md) sections when changing safety or behavior.

The next task is to verify and close the existing identity/preview/cancellation
flow, then finish recovery/Cache, Move/restore, and packaged UI acceptance.
Wired beta excludes Wi-Fi, generic two-way sync and Android OTG.

### Build and preview

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

### Safety contract

Copy → SHA-256 verification → receipt. No silent overwrite or destination switch.
Local Move adds separate source-cleanup review before Trash. Phone intake keeps
originals. Cache is not a verified final backup until forwarding is verified.

### Reference documents

| Document | Purpose |
|---|---|
| [SYNC_PLAN.md](SYNC_PLAN.md) | **Current direction:** new Electron desktop app and phone ↔ desktop sync (shared with `../Drive-Android/`) |
| [SPEC.md](SPEC.md) | Detailed behavior and safety contracts |
| [Plan.md](Plan.md) | Historical product plan and session record |
| [inspections.md](inspections.md) | Dated inspection and physical-test evidence |
| [design-qa.md](design-qa.md) | Dated visual QA evidence |
| [frontend-backend-parity.md](frontend-backend-parity.md) | Earlier API/UI audit, including deferred wireless gaps |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Alpha package instructions and limitations |
| [Earlier README](docs/history/2026-09-13-before-handoff/README.md) | Detailed CLI, Android and architecture reference; historical status |

Design sources remain under `design/`. New work belongs in this project root.
Update CONTINUE and Plan-V2 for current work; avoid adding another parallel plan.
