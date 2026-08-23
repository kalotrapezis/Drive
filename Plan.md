# Local Drive & Photos — Product and Build Plan

## Purpose

Build a simple local-first file and photo transfer app for Linux and Android.
It should feel like a local Google Drive, without Syncthing's peer/share setup:
the user chooses a source, a destination, and what should happen.

The immediate need is **transfer**, not backup:

```text
Phone / tablet → external HDD/SSD when connected
              ↘ bounded laptop staging only while the disk is absent
```

When the designated disk is connected, phone imports go directly to it so the
laptop does not hold an unnecessary second full copy. When it is absent, a
size-limited laptop staging folder may queue files. Once the disk returns, those
files are copied, verified, recorded, and—only for a Move job—removed from the
previous location.

Working name: **Local Drive**.

---

## Words used in the app

Direction and behavior are separate choices.

### Direction

- **Send files** — this device sends selected folders or files.
- **Receive files** — this device accepts files into a selected folder.
- **Send & receive** — both directions are allowed.

### Behavior

- **Copy / Backup** — copy and verify; keep the source.
- **Move** — copy, verify, record the new location, then remove the source.
- **Sync** — keep both sides aligned, with explicit deletion and conflict
  handling. This is later work, not part of the first release.

The UI must say what will happen before a job starts. A Move must never be
called a backup because, after cleanup, only one copy may remain.

---

## Product principles

1. **Files stay ordinary files by default.** No proprietary container is needed
   for Drive; installed apps open files normally. A user may deliberately pack
   a cold collection into an optional, portable Library archive.
2. **A move is a verified copy followed by deletion.** A successful write or a
   matching filename is not enough.
3. **Offline is not verified.** The catalog may say “last seen on T7,” but only
   an attached and checked T7 is “verified now.”
4. **Safe defaults.** Copy is the default. Move and propagated deletion are
   explicit. Conflicts never silently overwrite a different file.
5. **One useful route first.** Linux local-to-disk and phone-to-Linux by USB,
   then Android-to-Linux wirelessly, then Android-to-USB-disk.
6. **Use the operating system.** Linux mounts, Android's system folder picker,
   MTP, trash, and installed file viewers do the platform work.
7. **No automatic duplicate deletion.** Exact duplicates can be identified;
   the user approves cleanup.

---

## Main transfer routes

### 1. Phone → Linux through a USB cable

This is a first-class workflow, not a fallback:

1. Connect the unlocked phone and select **File transfer / MTP**.
2. The Linux app detects the phone and shows **Import new files from phone**.
3. On first use, select source folders such as `DCIM/Camera`, Screenshots, or
   Downloads and save them for that phone.
4. The app compares the phone inventory with its catalog and shows only new,
   changed, duplicate, and conflicting files.
5. Choose the destination. If the configured external disk is connected, it is
   preferred over laptop staging.
6. Click **Copy new** or **Move new**.
7. Linux copies each file, verifies it, updates history, and only then may
   delete the phone copy for a Move.

Standard Android MTP is controlled by the Linux side. The Android app does not
need to be open, but the phone normally must be unlocked and remain in File
transfer mode. MTP import is user-started; it is not an unattended background
sync while the cable is disconnected.

### 2. Android → Linux wirelessly

The Android app pairs with Linux on the same local network, watches only the
folders the user selects, and queues new files. It sends them when the Linux
receiver is reachable and receives a verified receipt before any cleanup.

### 3. Linux staging folder → external HDD/SSD

The user selects an exact destination disk and folder. Linux identifies the
disk by filesystem UUID when available—not by label or mount path alone—and
runs the waiting Copy or Move job when that disk returns.

### 4. Android → attached USB HDD/SSD

Android uses the system folder picker to grant the app access to a USB root.
After the first grant, the app can offer to run a saved job when that storage
returns. The operation remains visible and cancellable.

---

## The complete daily journey

### Initial setup

The first-run guide uses the same visual sync map later available in Settings:

1. Name this app instance and identify it as Server, Desktop, Laptop, Tablet, or
   Phone.
2. Choose or confirm its Drive, Gallery, Camera/Screenshots, and optional staging
   locations. Create missing app folders only after showing the exact paths.
3. Discover other Local Drive instances on the current LAN or enter a pairing
   code. Pairing requires confirmation on both devices.
4. If this is the first device, start a new shared map. If it joins an existing
   network, first download and validate the shared configuration and history,
   then show the imported map before applying it.
5. Run the device's local catalog/inventory check and exchange missing metadata
   events. No file content moves during this preparation step.
6. Place the new device on the map and connect it to devices or storage. Define
   each route as one sentence covering Files/Photos, direction, and Copy,
   verified Move, or Sync behavior.
7. Preview required folders and permissions, available and missing devices,
   conflicts, file count, total bytes, and estimated first-transfer time.
8. Confirm **Set up this sync network**. Each reachable instance saves the same
   configuration, creates or grants only its own required folders, and reports
   Ready or a specific problem back to the map.
9. Start the first content transfer only after the relevant source and
   destination both report Ready. Routes involving offline devices are saved as
   Waiting rather than blocking the rest of setup.

This is both onboarding and later editing: Settings reopens the same map, so the
user never has to learn a second configuration model.

### Transfer and clear space

1. New phone photos enter the configured sources.
2. They arrive by one-click cable import or wireless sending. If the disk is
   connected, the content goes directly to it; otherwise it may enter staging.
3. Linux independently verifies and acknowledges each file.
4. When the external disk returns, Linux drains the bounded staging queue.
5. A receipt for the final destination returns to Android when applicable.
6. **Clear space** previews eligible files, total space, required destination,
   and excluded files before requesting deletion.

Default rule:

```text
Clear from phone only after the external-disk copy is verified and that receipt
has returned to the phone.
```

The user may choose “clear after verified on laptop,” but the app must warn that
there is no external copy yet.

---

## Transfer safety contract

Every Copy or Move follows the same transaction:

1. Confirm the expected source and exact destination device are present.
2. Record source path, size, and modification time.
3. Check available destination space and filename conflicts.
4. Copy to a temporary `.partial` file without overwriting anything while
   calculating the source SHA-256 from that same stream.
5. Flush the completed file and independently calculate its destination hash.
6. Confirm source and destination size/hash match and the source did not change.
7. Atomically rename the temporary file when supported.
8. Record the verified location and completed event.
9. For Move only, trash/delete the source and record that event.

If any step fails, the source remains. Retry is idempotent: an already verified
destination is recognized rather than copied again. Partial transfer resumes
where the transport supports safe ranges; otherwise that file restarts with an
explanation.

The staging folder has both a maximum size and a minimum-free-space floor. When
either limit is reached, intake pauses and leaves files on the phone. The app
never solves phone storage pressure by silently exhausting the laptop system
disk.

### Failure and recovery behavior

| Failure | Required behavior |
|---|---|
| Wi-Fi, hotspot, or cable disconnects | Keep the `.partial` file and committed offset; resume from the acknowledged offset after reconnecting |
| App is killed, OS crashes, or power fails | SQLite transaction and transfer journal identify incomplete work on restart; re-check the partial file before resuming |
| Destination fills up | Stop cleanly, keep the source, retain only a bounded partial file, and open a Problems & Fixes item |
| External disk is unplugged | Issue no receipt and delete nothing; wait for the exact disk identity to return |
| Source changes during transfer | Reject that attempt, preserve both sides, rescan the source, and queue the new version |
| Chunk checksum fails | Discard only that chunk, do not advance the saved offset, and retry it |
| Final SHA-256 fails | Never publish the temporary file or delete the source; quarantine/remove the partial after reporting the corruption |
| Final receipt is lost | Sender asks for the job ID and destination hash status; do not blindly resend or delete |
| Same request arrives twice | Stable job/file IDs make it idempotent: return the existing offset or completed receipt |
| Wrong disk has the same label/path | Reject it because its stable storage identity differs |
| Android permission is revoked | Pause and create a Problems & Fixes action to choose/grant the folder again |
| Catalog and filesystem disagree | Mark uncertain, rescan, and request review; absence alone never triggers deletion |

No transfer becomes Complete until the data is flushed, the destination is
independently hashed, the catalog transaction commits, and a receipt exists.
Directory metadata is flushed where the platform supports it. Startup recovery
may finish or discard temporary files, but never guesses that an absent source
was intentionally deleted.

### Conflicts

- same path and same hash → already present;
- same path and different hash → send to the dedicated **Conflicts** section;
- **Apply to all** applies only to the current job.

### Conflicts section

Conflicts wait in their own review queue. Transfer of unrelated files continues
while the conflicting items remain untouched.

Each conflict group shows the competing files side by side:

- thumbnail/preview when supported;
- filename and full location breadcrumb;
- device, folder, size, type, created, modified, and captured dates;
- image/video dimensions and duration where applicable;
- SHA-256, relevant EXIF/metadata, tags, and last verified time;
- a highlighted summary of which fields differ.

The default decision is **no selection**. The user can open either file before
choosing. Conflict review supports:

- **Keep this one** — choose one file when exactly one should survive;
- **Keep both** — keep both with a safe suggested rename;
- **Keep selected** — checkboxes when more than one version may survive;
- **Save for review** — leave every copy unchanged and keep the conflict in
  Problems & Fixes until the user resolves it.

After the choice, the app shows a confirmation summary: copies to keep, copies
to rename, and copies to send to trash. Rejected copies go to trash only after
at least one selected copy has been verified. Permanent deletion is a separate
action outside conflict review.

For many conflicts, **Apply this choice to matching conflicts** is available
only when the rule is precise—for example, identical content, or keep the newer
file when the other metadata and source relationship match. The app previews
the affected count and total size; AI or filename similarity never authorizes
bulk trashing.

### Deletion

- **Trash is a collection**, not immediate deletion. The catalog records the
  original location and trash date, and the UI can browse, search, preview,
  restore, or permanently delete its contents.
- Never delete while the destination is only “last seen.”
- Never delete both sides as error recovery.
- Keep a permanent history event even after deletion.
- On MTP, if verified deletion is not reliable for that phone, finish as Copy
  and offer a separately confirmed cleanup list instead of pretending it moved.

Trash retention is configurable in Settings: 7, 30, 60, or 90 days, or
**Never delete automatically**. The default is 60 days. **Empty trash now**
shows item count and size and requires confirmation. If a disk or phone is
offline when an item expires, the catalog marks cleanup pending and performs it
only after that exact storage returns; absence is never treated as deletion.

---

## Catalog and movement history

SQLite is the local index; the filesystem remains the source of file content.
Linux is the canonical catalog for the first single-PC milestone. Once pairing
is added, Server, Desktop, Laptop, Tablet, and Phone replicate the same history
records. A server may be an always-available hub, but it is not automatically
more truthful than a device that has just checked its own storage.

### File record

- stable internal ID;
- current content ID (SHA-256), size, type, and original filename;
- capture/creation and modification times;
- best-known metadata, tags, favorite/archive/private flags;
- theoretical size: one logical file counted once.

### Device/location record

- device ID and friendly name;
- filesystem UUID, MTP device identity, or Android persisted tree identity;
- root and relative path;
- present, deleted, missing, offline/unconfirmed, or unknown;
- last seen and last verified times.

### History event

- queued, sent, received, copied, verified, moved, renamed, trashed, restored,
  deleted, conflict, failed, and retried;
- source, destination, time, result, and error.

The dashboard separates:

- **Logical library size** — each content hash counted once;
- **Known physical copies** — all known copies;
- **Verified now** — locations currently attached and checked;
- **Last reported** — offline locations that may have changed.

History is append-only from the UI. Low-level progress events may later be
compacted, but the user-visible movement record remains.

### Metadata-first history exchange

Every paired device has a stable device ID, a catalog generation, and its own
monotonically increasing event sequence. An event is identified by origin
device, generation, and sequence, so retries are harmless and sequence gaps are
detectable. Wall-clock date and time are retained for display and clock-skew
warnings, but never decide which history is correct.

Before sending file content, two devices:

1. authenticate and identify their catalog generation;
2. run an incremental self-check of accessible local roots;
3. exchange a compact high-water mark for every known event origin;
4. request and transactionally store only missing history events;
5. reconcile the current location map and report missing files, conflicts, and
   unavailable devices;
6. exchange the planned file manifest, exact remaining byte count, and a time
   estimate based on recently measured speed;
7. transfer content and publish the destination's verified receipt as a new
   event, which is then available to every paired device.

Thus, if Laptop transfers a file to Drive, Phone receives the resulting file and
location records even when it is not configured to receive the file itself.
History convergence is the union of immutable, uniquely identified events—not
"newest timestamp wins." A device speaks authoritatively only about an
accessible root it has just checked; a destination speaks authoritatively about
its own checksum-verified receipt. Explicit user Trash/delete actions are events.

If an expected file is absent while its device and root are accessible, mark it
**Missing** and warn the user. If the device/root is offline, mark it **Not
checked**, not Missing or Deleted. Neither state silently propagates deletion.

A catalog reset or system-location change starts a new catalog generation and a
full inventory reconciliation. The device first validates its SQLite catalog,
scans its accessible roots, obtains missing shared events from peers, and then
publishes its new observations. Unchanged files may be recognized by stored
identity, size, modification data, and sampling policy; changed or uncertain
items are fully hashed. This is the required quick check after every reset and
prevents an unnecessary full rehash when evidence is still valid.

---

## Photos

Photos are files with a photo-oriented view over the same catalog and transfer
engine—not a second storage system.

### Import and organization

- Sources: Camera, Screenshots, Downloads, messaging-media folders, or any
  user-selected folder.
- On the first Android test phone, the fixed photo sources are `DCIM/Camera`
  and `DCIM/Screenshots`. Save source paths per device because another Android
  device may use `Pictures/Screenshots`. Bidirectional ordinary files use
  `Documents/Local Drive/Drive/`; photos received onto the phone use
  `Pictures/Local Drive/<year>/` so Android gallery applications can index them.
- On Linux or the selected external disk, the default root separates
  `Local Drive/Drive/` from `Local Drive/Gallery/`; first-run setup shows the
  exact folders before creating them.
- Preserve meaningful source collections/folders by default.
- Put photos not assigned to a collection in `Local Drive/Gallery/<year>/` on disk.
- Choose year from EXIF capture time, then Android media date, then file mtime;
  unresolved items go to `Local Drive/Gallery/Unknown date/`.
- Never overwrite a collision. Same hash is a duplicate; a different hash gets
  a deterministic suffix.
- Preserve metadata and sidecars.
- Collections are catalog relationships by default, not duplicate physical
  copies. Exporting a collection to a folder is explicit.
- Google Takeout importing should reuse the already-proven Takeout normalizer,
  not create another merger.

### Photos view

- timeline by day, month, and year;
- pinch/zoom density on Android;
- collections initially derived from folders/source apps;
- filters: favorites, new, screenshots, documents, tags, archive, private,
  trash, and file type;
- search and details showing metadata plus all known locations;
- Open, Share, Copy, Move, Archive, Trash, and Clear space.

Basic non-destructive rotation/crop and metadata editing can follow the working
transfer path. A full photo editor is not this app's job.

### Duplicates and smart features

First detect exact duplicates with size plus SHA-256. Show groups, locations,
and the safest redundant copy to remove, but wait for approval.

Perceptual similarity, document detection, OCR, face grouping, and semantic
search such as “sky” or “smiling face” are later opt-in, on-device features.
They never trigger automatic deletion.

---

## Files

### Core operations

- copy, verified move, rename, trash/restore, permanent delete with warning;
- create folder, bookmark, tag, share, compress, properties, and Open with;
- search by filename, folder, type, date, tag, and device/location;
- list, detailed list, and grid views with size controls;
- sort by name, created, modified, size, or type; ascending/descending;
- show hidden files and shorten long names;
- back, forward, up, and clickable breadcrumb path; long-press/context menu to
  copy a path.

### Home

- Local Drive and incoming folder;
- connected phones and mounted devices, with configured-target markers;
- storage used/free and file-type analysis;
- Images, Audio, Video, Documents, Apps/Packages, New files, and Photo Gallery;
- active and waiting transfers.

Document grouping begins with type, source folder, OCR text from scans, and
explicit rules. The app can suggest the folder containing similar names such as
`Αίμα` / `Αιματολογικές`, explain why, and wait for approval. No general AI
model is needed for the first useful version.

---

## Optional compressed Library

A **Library** is an explicitly created archive for collections that are mostly
finished: old documents, completed projects, exported albums, or other cold
material. It is not the default Drive folder and is not used for active Camera
uploads.

### Portable first format

Use the extension `.ldrive`, but make version 1 an ordinary **ZIP64** container
with:

- one independently stored/compressed entry per file;
- `manifest.json` containing format version, logical paths, sizes, SHA-256,
  dates, media metadata, tags, and version relationships;
- optional thumbnails/index data that can always be rebuilt;
- Deflate for text and other compressible entries;
- Store/no recompression for JPEG, HEIC, PNG, MP4, compressed PDF, ZIP, and
  similar content that would gain little or nothing;
- no encryption in the first format; encrypted libraries require a separate
  key-recovery design.

The custom extension gives the app an identity and default opener, while the
standard ZIP64 structure means ordinary archive tools can still recover and
extract the original files.

### Browse, open, edit, and extract

- Browse folders, metadata, thumbnails, and search without extracting the full
  library.
- Stream an entry to the internal viewer a piece at a time.
- Store large video/audio entries without recompression so seeking is practical.
- **Open read-only** directly where the viewer accepts a stream.
- **Edit with another app** by materializing only that file into a managed work
  area. On save/return, hash it and offer **Add as new version** or **Replace in
  Library**; never edit the archive entry in place.
- Extract selected files/folders or the entire library to a chosen destination,
  with the normal conflict and verification flow.

Library changes are transactional: build the replacement archive beside the
old one, verify its manifest and every changed entry, then atomically replace
the old archive where supported. Keep the previous library in Trash/history
until retention expires. If there is insufficient room for both archives, do
not begin a rewrite.

### Limits and honest space expectations

- JPEG/HEIC photos, video, audio, many PDFs, APKs, and ZIPs are already
  compressed; another compression layer usually saves little and can cost time.
- Exact deduplication can save substantially more: one content hash may be
  stored once and referenced by several logical entries in a future format.
- A single damaged archive can affect many logical files, so a Library must not
  be the only copy until it passes verification and the user's backup policy.
- A small edit may require rewriting and retransferring a large archive. Only
  closed libraries sync automatically; an open/editing library stays local
  until committed.
- Libraries larger than available temporary free space are read/extract-only
  until enough room exists for a safe rewrite.

### Existing alternatives considered

| Existing solution | Good at | Why it is not the default Library |
|---|---|---|
| ZIP/ZIP64 | Portable per-entry access and extraction on both platforms | Updating compressed entries generally requires archive reconstruction |
| 7z or `tar.zst` | Higher compression for compressible collections | Poorer random access/editing and less native Android interoperability |
| SquashFS | Compressed random-access read-only Linux filesystem | Read-only, Linux-oriented, awkward for Android and editing |
| Seekable Zstandard | Fast chunk/frame seeking | A compression building block, not a full portable file library |
| restic, Borg, or Kopia | Deduplicated, compressed, integrity-checked backup repositories; mount/restore | Backup/snapshot systems, not an Android-editable single library format |
| Btrfs transparent compression | Ordinary editable Linux files with transparent compression | Filesystem-specific, not portable to Android, and requires a compatible formatted disk |

Do not invent a content-addressed pack format until real Library usage measures
enough duplicate/version savings to justify losing ZIP's universal recovery.

---

## Interface

Use a persistent three-part bottom mode bar on Linux and Android:

- **Drive Files**
- **Gallery / Collections**
- **New +**

The active mode changes both the main content and the left sidebar. The old
sidebar slides/fades away and the selected mode's sidebar replaces it; the
bottom bar and the top transfer-progress strip remain stable. Each mode
remembers its most recently selected sidebar item.

**Drive Files sidebar:** Home, Recent, Favourites, Trash, Tags, Settings, plus
connected-device/storage entries when useful.

**Gallery / Collections sidebar:** Home/Timeline, Collections, Tags, and
Settings. Photo groups such as Favourites, Trash, Archive, Videos, Documents,
People, and **Problems & Fixes** appear as collections in the Gallery content
rather than becoming another bottom-level destination. Problems & Fixes is for
photo duplicates, metadata conflicts, and photo-library permission issues.

**New + sidebar:** File, Folder, Tags, Scan Document, Sync Now, and Settings.
New + is a complete task workspace, not a popup menu. Its main panel displays
the selected task. For example, Folder inherits the folder the user was viewing
when they pressed New + and asks only for Name, with Create and Cancel; it does
not ask for Location again.

Transfers are reached through the persistent progress strip, Sync Now, Home,
and transfer notifications rather than a separate bottom destination. Android
may also expose Scan/New as a floating shortcut into the same New + workspace.

When unresolved photo-library problems exist, a notification indicator shows
their count and opens the Problems & Fixes collection directly.

Sidebar transitions must respect the system's reduced-motion setting. Keyboard
focus moves to the new sidebar/page heading after a mode switch, and the active
bottom item is communicated by icon, text, and selection state—not colour alone.

### Settings structure

Settings uses three peer tabs because Files and Photos share the transfer engine
but need different defaults:

### Global visual sync map

Settings presents one shared device-and-route map instead of separate settings
that must be mentally combined on each device. Server, Desktop, Laptop, Tablet,
Phone, and attached storage are nodes. Files and Photos are filters over the same
map. Connections are directional arrows whose labels state the complete rule in
plain language, for example **Phone Photos → Server Gallery: Move after verified
copy** or **Laptop Files ↔ Server Drive: Keep both updated**.

The map is introduced and initially built by the first-run guide; Settings is
its continuing home after onboarding.

Users add a known device to the canvas by dragging it from the device list, then
connect two visible endpoints. Selecting a node edits that device's name and
Drive/Gallery locations. Selecting an arrow edits content type, direction, and
Copy/Move/Sync behavior. These are separate choices; the UI must not present
Send, Receive, Move, and Copy as independent checkboxes that allow contradictory
combinations. Every route is previewed as one readable sentence before saving.

The device list populates automatically from currently discovered instances and
remembered paired devices. Each entry clearly says **New**, **Online**,
**Offline**, or **Needs attention**. Dragging a New device onto the canvas starts
the two-device pairing confirmation; discovery alone never grants access.
Dragging an already paired device only positions it. The user draws the intended
connections and chooses plain-language behavior—the app resolves addresses,
ports, interface changes, reconnects, and route delivery internally.

The map is a versioned global configuration replicated with the metadata-first
history exchange. On first connection a paired device receives the whole map,
then applies only the routes and locations relevant to it and reports permission
or capability problems back to the shared map. A configuration edit records its
author device and revision. Simultaneous edits do not use newest-clock-wins; the
second edit receives the newer revision and must reapply or resolve the conflict.

After confirmation, reachable paired instances exchange the committed map and
acknowledge the revision they applied. The initiating screen shows **Ready**,
**Waiting for device**, or the exact permission/capability problem on each node
and route; the user does not configure matching send/receive rules separately on
the other devices.

A device becoming unreachable only changes its status to Offline. It is never
removed from the sync network automatically. **Remove from sync network** exists
only in Settings, shows affected routes and pending transfers, requires explicit
confirmation, revokes that device's pairing access, and removes its active
routes. It never deletes files. The device record and movement history remain as
an archived device so old file locations and events stay understandable.

**General**

- shared visual device/route map, paired devices, mounted storage, saved
  locations, and stable device identities;
- network profiles, connection/security state, notifications, startup behavior,
  appearance, language, history/catalog maintenance, and Trash retention;
- per-device availability and the last successful verification.

**Files**

- default source/destination folders and staging limits;
- default Copy/Move/Sync suggestion, conflict behavior, hidden files, links, and
  verification options;
- saved file-transfer jobs and their direction: Send, Receive, or Send & Receive.

**Photos**

- watched Camera/Screenshot folders and automatic-import conditions;
- destination and staging policy, organization by year or year/month, album
  preservation, metadata/sidecar behavior, and phone cleanup receipt;
- duplicate review, Problems & Fixes notifications, and later opt-in private
  intelligence features.

Copy/Move/Sync mode and transfer direction belong to each saved job or paired
device route. Settings may provide safe defaults for creating a job, but changing
a default never silently changes existing jobs, and Move is never a global
one-switch behavior.

System roots—Camera, Screenshots, Drive, Gallery, staging, and the catalog—can
be changed through an explicit **Change location and rebuild index** action.
This is a guarded migration: pause affected jobs, scan the old and proposed
roots, compare hashes, sizes, metadata, and folder structure, preview the new
mapping, and commit it transactionally. Preserve the append-only movement
history and rebuild only the current-location index. Do not move or delete files
as part of this action. If a required device is absent, retain the old setup and
show the migration as incomplete rather than guessing.

### Approved Linux Files layout

The selected desktop direction is a content-first KDE layout:

- top bar with back/up, breadcrumbs, search, view/sort controls, and window controls;
- a visible transfer strip with destination, progress, Pause, and Clear space;
- left navigation for Home, Gallery, Recent, Favourites, Trash, Tags, and Settings;
- central detailed file list showing verification/location status;
- right inspector for the selected file's preview, metadata, activity, known locations,
  and actions;
- persistent bottom mode switch between Drive Files, Gallery / Collections,
  and New +; switching modes replaces the sidebar and main page together.

The editable source of truth is `design/pixelruller/LocalDriveUI.json` in this
project. It is a layout map, not application code; native
Kirigami/Breeze controls and theme roles replace its fixed mockup colours during
implementation.

The Gallery exploration is stored beside it as
`design/pixelruller/LocalDriveGalleryUI.json`, with three comparable desktop states:
Timeline / Years, Collections / Albums, and Selected photo / Device details.

### Logo direction

Explore a simple flower mark whose differently coloured petals represent the
paired devices exchanging files. The final icon must reduce the overlapping
petal outlines, remain readable at launcher and tray sizes, and work in both
light and dark themes. The current hand sketch is a concept, not a finished
asset.

### One app, two library views

Ship **one app per platform**, not separate Drive and Photos applications.
Files and Photos are two views over the same catalog and physical files:

- **Files** groups by device, storage root, folder, name, type, and tag.
- **Photos** filters media and groups by capture date, collection, source app,
  favorite/archive state, and visual timeline.

A photo moved, renamed, verified, trashed, restored, or tagged in either view is
the same object everywhere. There is one transfer queue, location history,
duplicate index, Problems & Fixes center, Trash, pairing setup, and set of
storage rules. The app never creates a second photo copy merely to show it in
Photos.

Provide separate **Open Files** and **Open Photos** launcher shortcuts (and
remember the last view), so either side can feel like a focused app without
duplicating the underlying product. Android requests media access, folder-tree
access, camera/scanner access, and notifications only when the corresponding
feature is first used—not as one large permission request during setup.

Do not create internal cross-platform frameworks merely for this separation;
ordinary feature packages/screens sharing one catalog are enough. Reconsider a
separate Photos companion only if measured APK size, optional ML models, or a
genuinely independent release cycle later makes the single app harmful.

### Problems & Fixes

This is a persistent review center, available from Home and from a status badge.
Its first screen follows a simple category-card layout. Each large card has an
icon, title, unresolved count, and one-line status:

```text
Problems & Fixes

┌──────────────────────────────────┐
│  Duplicates                 126  │
│  Review identical copies         │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│  Conflicts                    7  │
│  Choose which versions to keep   │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│  Permissions                  1  │
│  Folder access needs attention   │
└──────────────────────────────────┘
```

Additional categories appear only when they contain items. The page covers:

- saved and unresolved file conflicts;
- failed or repeatedly interrupted transfers;
- destination disk missing or replaced by a different device;
- lost Android folder permission or disconnected MTP phone;
- insufficient space or staging-limit reached;
- files whose source changed during transfer;
- exact-duplicate groups awaiting review;
- photos with unknown dates, missing metadata, or organization questions;
- trash cleanup that is waiting for an offline device.

Each problem card explains what happened, whether the original files are safe,
and offers only the relevant actions: Compare, Retry, Reconnect, Choose folder,
Free space, Keep, Send to trash, Restore, Save for review, or Dismiss when no
action is required. A saved conflict remains here across restarts and transfers
until resolved; it is never silently replaced or expired.

The page groups items by **Needs decision**, **Needs device/permission**,
**Can retry**, and **Saved for review**. A resolved-history filter shows what
the user chose and allows restoration while the discarded copy remains in
Trash.

### Duplicate and conflict review

Opening Duplicates or Conflicts starts a focused review, one group at a time.
Conflict review looks like:

```text
Choose what to keep                         1 / 126

┌────────────────┐       ┌────────────────┐
│    preview     │       │    preview     │
├────────────────┤       ├────────────────┤
│ metadata       │       │ metadata       │
│ device / path  │       │ device / path  │
│          ✓ Keep│       │          □ Keep│
└────────────────┘       └────────────────┘

[Skip] [Keep both] [Move unselected to Trash]
```

There may be two or more candidate cards. On a wide screen they appear side by
side; on a phone they stack or scroll horizontally. Dots or a compact `2 of 4`
indicator show candidates that are off-screen, while `1 / 126` shows progress
through conflict groups.

Each candidate card contains:

- preview or file-type icon;
- filename and source device;
- full path, expandable when long;
- size, created/modified/captured dates, dimensions/duration, and tags;
- a short highlighted list of metadata differences;
- an explicit **Keep** control and text state—not color alone.

The title is **Choose what to keep**, not “Choose the correct one,” because a
conflict may require keeping both. Conflict review uses radio-style selection
when exactly one version should remain and checkbox-style selection when
multiple versions may remain. Nothing is selected by default. Tapping a card
opens the full file; only its Keep control changes the decision.

In conflict review, the bottom action remains disabled until the choice is safe.
It states the real effect—**Move unselected to Trash**—and opens a final summary
before changing anything. **Skip** saves the group for later. After resolving a
group, the next one appears and the progress count updates.

Duplicate review uses the same screen but explains that the content hashes are
identical. Conflict review highlights that content differs despite a colliding
name/path. The two categories are never mixed.

### Duplicate cleanup session

Duplicate cleanup deliberately works like a multiple-choice test. It is used
only for redundant copies selected for cleanup; copies required by an active
backup/location policy are marked protected and excluded.

For each duplicate group:

1. Show every identical copy with preview, device, path, dates, and metadata.
2. Require exactly one **Keep** choice; keeping multiple has no purpose inside
   this cleanup session.
3. Selecting a candidate records a draft answer and automatically advances to
   the next group.
4. Back returns to the previous group and preserves the current choice.
5. Leaving the session saves progress without moving or deleting any file.

After the final group, show **Review choices**, similar to the answer review of
a multiple-choice test:

```text
Review choices

1   [selected copy ✓]  [other copy]       Change
2   [copy]             [selected copy ✓]  Change
3   [selected copy ✓]  [copy]             Change

[Go back]                         [Finish]
```

The review shows all groups, their chosen retained copy, destination/device,
and space expected to be reclaimed. Tapping a row or **Change** returns directly
to that group; after correction, review resumes at the same place.

**Finish** does not act immediately: it first presents one final count/size
confirmation. Only then does the app re-verify every selected retained copy and
move the unselected copies to Trash. If verification fails or a device is
missing, that group returns to Problems & Fixes and neither copy is changed.
The completion screen says **Duplicate review complete**, offers **Done**, and
keeps **Review choices** available while the affected files remain restorable
from Trash.

### Transfers

- overall progress, bytes/files remaining, speed, and estimated time;
- current file and phase: Copying or Verifying;
- queues grouped by route/device;
- pause, resume, cancel, retry, and explain-error actions;
- history filters for failed, moved, and cleared files;
- **Import new files from phone** when an MTP phone is detected.

An unresolved-problem badge opens **Problems & Fixes**. Its conflict cards open
the side-by-side comparison where the user chooses what to keep or send to
Trash.

Example device status:

```text
T7-TEO — Connected and verified now
Archive HDD — Offline; last verified 18 Aug 2026
Phone — Connected by USB; 318 new items available
```

An offline disk never receives a green “safe” state because it existed before.

---

## Architecture

Follow the successful Notes split: native Linux app/server plus native
Kotlin/Compose Android client with a documented protocol. Do not add a shared
cross-platform UI or cloud service.

### Shared contract

- pairing and device capabilities;
- metadata/history exchange before content transfer, using device generation,
  per-origin event sequence, and high-water marks;
- inventory/manifest with relative paths;
- chunk/range upload where supported;
- SHA-256 receipt and final acknowledgement;
- stable job/event IDs for safe retries;
- final-destination receipt returned to Android;
- missing-event requests, sequence-gap detection, and transactional event merge;
- protocol version and forward-compatible unknown fields.

### Reuse the Notes network method

Reuse the existing Notes connection-selection behavior rather than inventing a
new network setup:

- save named server profiles such as Home, Work, and Phone hotspot;
- each profile stores the Linux receiver address, port, and paired credential;
- Android first tries the last successful profile; if it is unreachable, it
  tries the other saved profiles and remembers whichever answers;
- check for an active network before trying profiles, but do not require Android
  to report internet access: a local-only Wi-Fi or hotspot may still reach the
  Linux receiver; a short receiver health probe is the final test;
- allow manual profile selection, Test connection, Sync/Send now, and optional
  connection on app open;
- do not read the Android Wi-Fi name merely to choose a profile, because trying
  the small list of saved receivers achieves the same result without requesting
  location permission;
- on Linux, reuse the NetworkManager connection-name check and saved-profile
  switch when the active network changes;
- keep the automatic server identity and credentials stable until the user
  explicitly resets them.

Drive adds transfer policy to each Android profile:

- allow discovery/checks on this network;
- allow file transfer or ask first;
- Wi-Fi/unmetered only;
- optional charging-only rule;
- optional maximum automatic file size.

A profile check transfers only a small manifest/status request. It must not
rehash or rescan the entire photo library every 5–15 minutes. Filesystem/media
events update the local queue; the network check only discovers the receiver
and sends already-known pending work.

The Notes payload algorithm is **not** copied unchanged. Notes transfers small
JSON/Markdown files through whole-file WebDAV, resolves edits by timestamp, and
uses an authoritative deletion ledger. Large photos and videos instead require
resumable transfer, SHA-256 verification, stable job IDs, explicit conflicts,
destination receipts, and the verified Move/Trash transaction in this plan.

### Reuse the ClassSend connection workflow

ClassSend and ClassSend2 provide proven local-network workflow ideas for first
run and reconnection. Reuse the behavior, not their application protocol:

- remember a paired instance by an app-generated stable device ID, friendly
  name, last working address, hostname, and last-seen status;
- try remembered addresses and hostname/`.local` candidates concurrently within
  one short timeout instead of waiting for each address sequentially;
- use mDNS for first discovery, then show a pairing code/QR and manual address
  fallback when multicast is blocked;
- keep a lightweight background re-probe for Offline devices and stop aggressive
  probing once connected;
- select the correct local interface/address for multi-NIC machines;
- after a reconnect or late join, send the current configuration revision and
  missing history-event ranges before planning file transfers;
- show Online, Offline, last seen, and reconnecting state on the global map.

Do not copy ClassSend's teacher/student hierarchy, MAC-address identity,
unauthenticated HTTP discovery, subnet-wide TCP sweep, or full history/file
replay. Local Drive is a trusted peer graph: pairing pins app-generated identity
and credentials, HTTPS authenticates the session, metadata sync requests only
missing events, and file content moves only according to the shared route map.

### Linux

Use **C++20 + Qt 6 + QML/Kirigami + KDE Frameworks 6**. Reuse suitable Notes
desktop product patterns—embedded server, settings, packaging, and visible
server status—but not its GTK/Rust implementation. Use:

- Qt Quick/QML and Kirigami for the Files, Photos, Transfers, Problems & Fixes,
  and responsive card/grid interfaces;
- a small C++ backend with Qt models exposed to QML;
- KIO for MTP URLs, file jobs, previews, and KDE Trash integration;
- Solid for removable-device discovery and stable hardware/storage properties;
- KFileMetaData for supported file/media metadata;
- KWallet for paired-device secrets and KNotifications for background results;
- Qt SQL's SQLite driver for the catalog and transfer journal;
- Qt Network/HTTP Server with TLS for the trusted-LAN transfer service;
- `QProcess` for the narrowly scoped, machine-readable `rsync` Phase 0 backend;
- CMake plus Extra CMake Modules for building and packaging.

Keep file mutation and transfer state in C++, not QML. Use Qt ownership/RAII,
no owning raw pointers, temporary-file + commit APIs, checked paths, and focused
transaction/recovery tests. Qt HTTP Server remains bound only to local/private
interfaces; its own documentation does not position it as a hardened public
internet server.

Do not build a Rust/C++ bridge, Python production backend, Go webview, or shared
desktop/Android UI for the first release. Each adds a second integration layer
without replacing the KDE APIs this application actually needs.

Current Kubuntu evidence (2026-08-22): Qt 6.10 runtime/tools, KDE 6 KIO MTP and
Trash workers, and the Qt SQLite driver are installed. The C++ development
packages—Qt Base/Declarative/HTTP Server, Extra CMake Modules, and KDE KIO,
Solid, KFileMetaData, KWallet, Notifications, Config, and Kirigami headers—are
available from the configured repository but are not installed yet. Install
them only when implementation starts.

The system `rsync` may be used as the Phase 0 execution backend for ordinary
Linux-folder → mounted-disk copies if a small spike proves that its itemized
output, progress, interruption, and source-change behavior satisfy the phase
gate. The app still owns the preview, catalog, SHA-256 receipt, conflict review,
and Trash decision. Do not make rsync the shared protocol: Syncthing uses its
own block-exchange protocol, MTP is not a normal rsync filesystem endpoint, and
Android should not require an rsync binary or daemon.

### Transport options and decision

| Option | Speed | Safety strengths | Main weaknesses | Use here |
|---|---|---|---|---|
| Native Qt/KIO filesystem copy | Excellent locally | KDE-native file/MTP/Trash jobs plus control of temporary files and final SHA-256 | Resume and exact MTP behavior still require real-device tests | Local and MTP platform API |
| `rsync` | Excellent for Linux paths and repeated copies | Mature partial transfer, whole-file verification, source-change guard | Cannot directly handle Android MTP; no catalog, receipts, Problems & Fixes, or Trash policy | Candidate for Linux folder → mounted disk |
| `rclone` | Good; parallel and strong for remote backends | Dry-run, copy/move/check commands and reports | Extra Go binary, absent on this machine, no direct MTP advantage, much unused cloud scope | Do not add initially |
| Notes-style WebDAV | Good for small files | Existing code, authentication, simple standard operations | Ordinary PUT restarts whole large files; timestamp-wins and deletion ledger are unsafe for this product | Reuse setup ideas only |
| SFTP/SSH | Good, encrypted | Mature random-access files and authentication | SSH server/key management, Android packaging, no discovery/catalog/receipt semantics | Advanced-user backend only if later requested |
| Syncthing/BEP engine | Excellent for repeated folder synchronization | Mature block exchange, hashing, reconnection, multi-device convergence | Large complex engine; replica/deletion semantics conflict with staged Move, Trash review, and location history | Do not embed for MVP |
| LocalSend protocol | Excellent for one-off LAN sends | Discovery, HTTPS fingerprint, metadata preparation, SHA-256, parallel files | Whole-file upload has no standard resumable offset; no library catalog, route chain, or history | Borrow discovery/session ideas |
| tus resumable HTTP | Near raw HTTP speed | Standard offset resume, idempotent chunks, checksum and expiration extensions | Upload-focused; still needs our manifest, download, pairing, receipts, and conflict rules | Best wireless data-transfer base |

Recommended combination:

1. **Linux mounted storage:** use `rsync` behind the app for the Phase 0 spike;
   independently confirm the final SHA-256 and let the app—not
   `--remove-source-files`—perform the reviewed Trash step.
2. **USB File transfer/MTP:** use the desktop's native MTP integration to read
   each phone file into a `.partial` destination while hashing. On this Kubuntu
   machine KDE KIO's MTP worker is installed; GIO's MTP backend is not currently
   present, which is why the selected desktop stack uses Qt/KIO. Prove the exact
   phone behavior at the first MTP gate rather than assuming plugin presence is
   sufficient.
3. **Wireless Android ↔ Linux:** use Notes-style saved receiver profiles and
   LocalSend-style discovery/preparation, then a tus-compatible resumable HTTPS
   upload with chunk checks and a final SHA-256 receipt.
4. **USB tethering, if wanted later:** reuse the same HTTPS transfer protocol
   over the USB network. This can provide cable speed and resume without MTP,
   but requires the user to select USB tethering instead of File transfer mode.

For new photos and videos, delta algorithms rarely save bandwidth because the
destination has no older blocks to reuse. Sequential/resumable streaming with a
small amount of concurrency is faster and simpler. Start with two simultaneous
files and an 8 MiB chunk, expose neither setting in the normal UI, and retain an
internal calibration option for real phones, Wi-Fi, and disks.

### Android

Reuse suitable Notes Android patterns: Compose structure, pairing/settings,
offline queue, network errors, real-device gates, packaging, and release flow.
File content stays in media/user-selected storage; the catalog and queue stay in
app storage.

### Security boundaries

- pairing requires confirmation on both devices;
- random per-device credentials, never a default password;
- store credentials through Android's platform-backed secure storage and the
  Linux desktop secret service when available, not as plaintext app settings;
- wireless transfer always uses HTTPS, including trusted LANs and phone
  hotspots; the Wi-Fi password controls network entry but does not authenticate
  the particular receiver or every other device/router on that network;
- generate a device certificate locally and pin its SHA-256 fingerprint during
  QR/code pairing; discovery may find devices but never grants trust;
- a certificate/fingerprint change stops transfer and appears in Problems &
  Fixes for explicit re-pairing;
- operations are restricted to configured roots;
- reject path traversal, symlink escape, and changed-mount targets;
- redact credentials and private filenames from diagnostics by default;
- do not expose the receiver directly to the public internet.

TLS protects confidentiality, peer identity, and integrity while bytes travel.
Chunk checks catch and localize interrupted/corrupt writes; the final SHA-256
proves the stored destination matches the source. These are complementary, not
substitutes.

MTP cable transfer does not need an additional encrypted network tunnel. Files
at rest remain ordinary files and rely on Android device encryption and the
chosen Linux/external-disk encryption. App-level encrypted storage is deferred:
it would prevent ordinary local programs from opening files and would add key
recovery risk. A later Private collection can be designed separately if needed.

### Different networks

Saved profiles cover different places where both devices can reach each other,
such as Home Wi-Fi, Work Wi-Fi, or a phone hotspot. They do not make a laptop at
home reachable from an unrelated network by themselves. First releases use USB
or a shared trusted network; true remote access should use an existing private
network/VPN. Accounts, cloud relay, NAT traversal, and a hosted service would be
a separate product.

---

## Build order and gates

### Phase 0 — Verified Linux mover for the current storage problem

- choose a local source and attached destination;
- remember the exact destination disk;
- preview count, total size, duplicates, conflicts, and free space;
- Copy or verified Move;
- JSON/CSV readable manifest plus SQLite history;
- safe retry after interruption;
- staging size limit and minimum-free-space guard;
- optionally organize unfiled photos into year folders.

**Gate:** deliberately interrupt a multi-file Move. After restart, every
original is either still present or independently verified at the destination;
nothing is overwritten, hashes match, and history explains every outcome.

### Phase 1 — One-click USB phone import on Linux

- detect an unlocked MTP phone in File transfer mode;
- remember chosen folders per phone;
- **Import new files from phone** preview and button;
- import directly to the configured disk when it is connected, otherwise use
  bounded staging or leave the files on the phone;
- Copy new / Move new, progress, conflict decisions, and cleanup list;
- unplug/reconnect recovery without duplicates.

**Gate:** import a mixed real photo/video set twice. The second scan finds no
false “new” files. Unplug during copy: the source remains and retry finishes
without a duplicate or corrupt destination.

### Phase 2 — Linux app shell

- setup plus Files, Photos, and Transfers views;
- mounted-device detection and waiting jobs;
- file operations, exact duplicate report, and location dashboard;
- Problems & Fixes center with persistent saved conflicts, transfer/storage
  problems, and relevant recovery actions;
- category dashboard for Duplicates, Conflicts, Permissions, and conditional
  problem types, with unresolved counts;
- one-group-at-a-time side-by-side review, metadata differences, progress,
  keep-one radio buttons, keep-many checkboxes, safe rename, and Trash preview;
- quiz-style duplicate cleanup with single-choice auto-advance, saved draft,
  final answer review, corrections, and one confirmed Finish operation;
- Trash collection with restore, empty-now, and configurable retention;
- local receiver/pairing screen.

**Gate:** configure a disk, unplug/replug it, and complete Phase 0 through the
UI. A different disk with the same label is rejected. Resolve a real filename
conflict by keeping either copy and both copies; no rejected copy enters trash
before the retained result is verified. Save another conflict, restart the app,
and confirm it remains in Problems & Fixes. Restore a rejected copy from Trash
and verify automatic expiry can be disabled.

### Phase 3 — Android sender and Linux receiver

- pair on the same LAN;
- reuse Notes-style saved Home/Work/Hotspot receiver profiles: try current,
  fall back to the other saved profiles, and remember the successful one;
- per-profile unmetered, charging, ask-first, and maximum-size policies;
- choose Camera and other source folders;
- Send with Copy/Move policies;
- visible queued transfer, retry, receipts, and Clear space preview;
- Files, Photos, and Transfers with current locations.

**Gate:** Wi-Fi is interrupted during a real mixed transfer. After reconnection
all hashes match, no duplicate appears, and no phone file is cleared before the
configured receipt returns. Move between two saved networks: the unreachable
profile fails quickly, the reachable profile is selected automatically, and no
location permission is requested merely to read the Wi-Fi name.

### Phase 4 — Phone → laptop → disk automation

- waiting rule and automatic run when the exact disk returns;
- final-disk receipt synchronized back to Android;
- clear-after-laptop versus clear-after-disk policy;
- notifications and tablet validation.

**Gate:** with disk absent, files wait safely. When it appears, the chain
finishes and only eligible phone files are offered for cleanup. Unplug during
verification loses no source.

### Phase 5 — Android USB disk

- system-picker access to an attached disk;
- optional saved job when that USB root returns;
- visible/cancellable copy and Move;
- interruption, duplicate, conflict, and insufficient-space handling.

**Gate:** validate on a real phone and real USB disk, including removal during
copy and during verification.

### Phase 6 — File history and controlled sync

- optional `.history` versions, disabled by default, with retention 5/10/100 or
  time-based;
- filesystem watcher plus periodic safety scan—not constant full rescans;
- Send & receive, tombstones, explicit conflicts, deletion propagation;
- restore an older version.

**Gate:** simultaneous offline edits become a visible conflict, deletion never
silently wins over an edited copy, and restore survives restart.

### Phase 7 — Scanner and smarter organization

- Android page detection, crop, filters, multi-page PDF, OCR;
- destination suggestions from names, OCR, folder structure, and approved past
  choices;
- document collection and exact-duplicate cleanup flow.

**Gate:** scan pages remain recoverable until the PDF is written and verified;
Greek OCR is usable; wrong suggestions are easy to reject.

### Phase 8 — Optional compressed Library

- create/import a ZIP64-based `.ldrive` Library;
- manifest, per-entry SHA-256, thumbnails, search, and selective/full extract;
- stream supported media without whole-library extraction;
- managed single-file edit flow and safe transactional library replacement;
- space preview showing original size, archive size, and actual saving.

**Gate:** create a mixed Library containing Greek paths, documents, photos, and
a seekable video; browse and extract individual entries on Linux and Android;
interrupt a rebuild and prove the previous Library remains valid; recover the
archive with a normal ZIP tool without Local Drive.

### Phase 9 — Optional private intelligence

Only after real use shows it is worthwhile:

- perceptual duplicate groups;
- on-device face grouping with explicit consent;
- on-device semantic image search;
- private/locked collection.

No cloud AI upload is assumed.

---

## Explicitly deferred

- hosted Google Drive/Photos service;
- public internet exposure, accounts, subscriptions, or relay servers;
- automatic deletion based on similarity, AI, or filename guesses;
- direct phone-to-phone mesh and live collaboration;
- full image/video editor;
- using a compressed Library as the default active Drive/Camera store;
- iOS, Windows, and macOS clients;
- social/notification features copied from Google Photos without a local need.

---

## Decisions locked for the first implementation

- First deliverable: verified Linux mover.
- Second deliverable: one-click MTP **Import new files from phone**.
- Copy is default; Move is explicit.
- Clear phone waits for the destination chosen by policy; external disk is the
  default for the full route.
- SHA-256 identifies and verifies content.
- Catalog separates logical size, physical copies, last reported, and verified
  now.
- Problems & Fixes retains unresolved and saved conflicts until the user acts.
- Trash is a browsable collection; automatic deletion defaults to 60 days and
  can be changed or disabled.
- Linux is initially the canonical catalog/server.
- USB and same-LAN transfer come before remote-network features.
- Reuse Notes' saved-server fallback method across Home/Work/Hotspot networks,
  but replace its whole-file timestamp sync with the verified transfer engine.
- Photos and Files share one engine/catalog.
- Ship one app per platform with Files and Photos views plus direct launcher
  shortcuts; never maintain two competing catalogs or transfer services.
- Linux desktop stack is C++20 + Qt 6/QML/Kirigami + KDE Frameworks 6; Android
  remains Kotlin/Compose, sharing a documented protocol rather than UI code.
- Unfiled photos organize by capture year; meaningful collections remain.
- Exact duplicate detection comes before perceptual/AI detection.
- Files remain usable outside the app.

---

## Choices to record in `SPEC.md` when Phase 0 starts

1. Current source folder(s) and first external target folder.
2. Whether the existing photo-library job defaults to Copy or Move.
3. Gallery layout: `Local Drive/Gallery/<year>/` or
   `Local Drive/Gallery/<year>/<month>/`.
4. Whether organization may change filenames or only paths.
5. Which receipt permits phone cleanup: laptop or external disk.
6. Recycle-bin behavior on the selected external filesystem.
7. App name, package IDs, licence, and relationship between the two repos.

No later-phase decision blocks Phase 0.
