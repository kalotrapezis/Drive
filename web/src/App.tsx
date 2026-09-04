import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowSquareOut, ArrowUp, ArrowsClockwise, CalendarBlank, CaretDown,
  CaretRight, CheckCircle, Circle, Clock, Copy, Cpu, Database, Desktop, DeviceMobile,
  DotsThreeVertical, File, FilePdf, FileXls, Folder, Gear, HardDrive, House,
  ImageSquare, Images, ListBullets, MagnifyingGlass, PauseCircle, PlayCircle, Plus, ShareNetwork,
  SlidersHorizontal, SquaresFour, Star, StopCircle, Tag, Trash, Video, WarningCircle, Wrench,
} from "@phosphor-icons/react";
import logo from "../../Assets/Icons/Drive.png";
import { storageTotals } from "./storageTotals";
import { isScreenshot } from "./photoCollections";
import { FileActions, type FileLabels } from "./FileActions";
import { PhotoViewer, mediaKey, mediaUrl, type GalleryPhoto } from "./PhotoViewer";
import { NewTag } from "./NewTag";
import { QrScanner } from "./QrScanner";
import { DesktopAction } from "./DesktopAction";
import { PhotoExport } from "./PhotoExport";

const galleryMockup = import.meta.env.DEV ? "/@fs/home/teo/Έγγραφα/Claude/Coding/Drive/design/mockups/gallery-timeline.png" : "";

type DriveFile = { name: string; path?: string; directory: boolean; size: number; modified: string; type: string };
type Transfer = { state: string; bytesTotal: number; bytesDone: number; updatedAt: string; destination: string };
type Storage = { id: string; identity?: string; label: string; root?: string; present?: boolean; connected?: boolean; bytesTotal?: number; bytesFree?: number };
type Device = { id: string; stableIdentity?: string; label: string; category?: "device" | "storage"; root?: string; filesystemType?: string; present?: boolean; connected?: boolean; status?: string; lastSeen?: string; kind?: string; transports?: string[]; phoneRoot?: string };
type Route = { id: string; contentType: string; source?: string; storageId?: string; storagePresent: boolean; jobState?: string; destination?: string; behavior?: string; keepPolicy?: string; stagingMaxBytes?: number; stagingRoot?: string };
type ApiState = {
  ready: boolean;
  deviceName: string;
  libraryRoot?: string;
  configRevision: number;
  error: string;
  problems: number;
  photoExports?: { id: string; state: string; result?: string; filesDone?: number; filesTotal?: number }[];
  catalog: { pendingFiles: number; pendingBytes: number; lastMetadataUpdate: string; activeTransfer: Transfer | null };
  routes: Route[];
  storages: Storage[];
  devices: Device[];
  connectedDevices?: Device[];
  firstSeenDevices?: Device[];
  hiddenDevices?: Device[];
  hub?: { enabled: boolean; limitPercent: number; pendingBytes: number; waitingFor: string };
};
type FilesResponse = { root: string; currentPath: string; verifiedOn: string; items: DriveFile[]; truncated: boolean };
type PhotoItem = GalleryPhoto;
type PhotosResponse = { root: string; verifiedOn: string; items: PhotoItem[]; truncated: boolean; nextCursor?: string };
type ActivityItem = { id: string; event: string; occurredAt: string; result: string; sourcePath: string; destinationPath: string };
type RouteHistoryItem = { event: string; occurredAt: string; result: string; source: string; destination: string };
type ImportPreview = { ok: boolean; error: string; files: number; bytes: number; toCopy: number; identical: number; duplicates: number; destinationDuplicates: number; conflicts: number; unsupported: number; unreadable: number; duplicatePaths: string[]; conflictPaths: string[]; unsupportedPaths: string[]; duplicatesAccepted?: boolean; conflictsAccepted?: boolean; unsupportedAccepted?: boolean };
type ProblemItem = { id: string; category: string; title: string; summary: string; details: { source?: string; root?: string; target?: string; destination?: string; paths?: string[]; path?: string; deviceStableId?: string; expectedSize?: number; expectedSha256?: string; correctionStatus?: string; correctionError?: string; added?: number; changed?: number; missing?: number }; itemCount: number; bytes: number; state: string; updatedAt: string; source: string };
type ProblemAction = "save" | "dismiss" | "accept_existing" | "keep_both" | "skip_unsupported" | "recheck_location";
type ResolutionItem = { id: string; problemId: string; action: ProblemAction; state: string; occurredAt: string; category: string; title: string };
type ProblemsResponse = { total: number; counts: Record<string, number>; items: ProblemItem[]; history: ResolutionItem[] };
type MainTab = "sync" | "files" | "photos" | "new";
type MainView = MainTab | "problems";

const demoFiles: DriveFile[] = [
  { name: "Blood Tests", directory: true, size: 0, type: "Folder", modified: "2025-05-20T10:14:00" },
  { name: "Prescriptions", directory: true, size: 0, type: "Folder", modified: "2025-05-18T16:44:00" },
  { name: "MRI Reports", directory: true, size: 0, type: "Folder", modified: "2025-05-15T09:31:00" },
  { name: "Dental", directory: true, size: 0, type: "Folder", modified: "2025-05-12T11:02:00" },
  { name: "Health Summary.pdf", directory: false, size: 1454512, type: "PDF", modified: "2025-05-21T14:22:00" },
  { name: "Medication Log.ods", directory: false, size: 250880, type: "ODS", modified: "2025-05-19T08:57:00" },
];

const demoState: ApiState = {
  ready: true,
  deviceName: "Laptop",
  configRevision: 4,
  error: "",
  problems: 5,
  catalog: {
    pendingFiles: 4622,
    pendingBytes: 18_420_000_000,
    lastMetadataUpdate: "just now",
    activeTransfer: { state: "Copying", bytesTotal: 12_000_000_000_000, bytesDone: 8_000_000_000_000, updatedAt: "just now", destination: "T7" },
  },
  routes: [{ id: "drive", contentType: "Drive", storageId: "t7", storagePresent: true, destination: "/media/T7/Local Drive/Drive", behavior: "Copy", keepPolicy: "Everything" }, { id: "photos", contentType: "Photos", storageId: "t7", storagePresent: true, destination: "/media/T7/Local Drive/Photos", behavior: "Copy", keepPolicy: "Everything" }],
  storages: [
    { id: "local", label: "Laptop", present: true, bytesTotal: 2_000_000_000_000, bytesFree: 940_000_000_000 },
    { id: "t7", label: "T7", present: true, bytesTotal: 8_000_000_000_000, bytesFree: 2_480_000_000_000 },
  ],
  devices: [{ id: "xiaomi", stableIdentity: "mtp:Xiaomi 15", label: "Xiaomi 15", present: true, status: "Online", kind: "Phone", transports: ["mtp"], phoneRoot: "mtp:/Xiaomi 15/Internal shared storage" }],
};

const demoProblems: ProblemsResponse = {
  total: 5,
  counts: { Duplicates: 2, Conflicts: 1, Unsupported: 1, "External changes": 1 },
  history: [{ id: "demo-history", problemId: "old-observation", action: "dismiss", state: "applied_local", occurredAt: "2026-08-28T16:30:00", category: "External changes", title: "External file indexed" }],
  items: [
    { id: "demo-duplicates", category: "Duplicates", title: "Exact duplicates found during import preview", summary: "Choose which locations to retain before import execution.", details: { source: "/Syncthing/Camera", target: "Photos", paths: ["DCIM/IMG_2041.jpg", "Camera/IMG_2041-copy.jpg"] }, itemCount: 2, bytes: 0, state: "needs_decision", updatedAt: "2026-08-29T10:10:00", source: "import" },
    { id: "demo-conflict", category: "Conflicts", title: "Destination path contains a different file", summary: "Compare the versions before anything is copied or replaced.", details: { source: "/Syncthing/Documents", target: "Drive", paths: ["Medical/Health Summary.pdf"] }, itemCount: 1, bytes: 0, state: "needs_decision", updatedAt: "2026-08-29T10:05:00", source: "import" },
    { id: "demo-unsupported", category: "Unsupported", title: "Unsupported source item found", summary: "Keep it in the source while importing the regular files.", details: { source: "/Syncthing/Documents", target: "Drive", paths: ["Latest report (symlink)"] }, itemCount: 1, bytes: 0, state: "needs_decision", updatedAt: "2026-08-29T10:07:00", source: "import" },
    { id: "demo-external", category: "External changes", title: "Phone item changed before transfer", summary: "Confirm whether the original phone copy still matches the verified receipt.", details: { root: "DCIM", path: "Camera/IMG_3102.jpg", paths: ["Camera/IMG_3102.jpg"], deviceStableId: "wireless:xiaomi", expectedSize: 2_400_000, expectedSha256: "0".repeat(64) }, itemCount: 1, bytes: 2_400_000, state: "needs_decision", updatedAt: "2026-08-29T10:15:00", source: "metadata" },
  ],
};

const demoPhotos: PhotoItem[] = [
  ["Lake Reflections.jpg", "2026-08-22T07:41:00", "Summer 2026", "18% 25%"],
  ["Meadow Walk.jpg", "2026-08-20T17:22:00", "Family", "35% 25%"],
  ["Harbour Sunset.jpg", "2026-08-18T20:11:00", "Summer 2026", "52% 25%"],
  ["Butterfly.jpg", "2026-08-12T12:03:00", "Nature", "69% 25%"],
  ["Forest Camp.jpg", "2026-07-29T18:40:00", "Summer 2026", "18% 41%"],
  ["Coastline.jpg", "2026-07-25T10:15:00", "Crete", "35% 41%"],
  ["Family Walk.jpg", "2026-07-14T16:08:00", "Family", "52% 41%"],
  ["Beach Evening.jpg", "2026-07-03T19:52:00", "Summer 2026", "69% 41%"],
  ["Palm Sunset.mp4", "2026-06-21T20:04:00", "Summer 2026", "35% 71%"],
  ["Mountain Road.jpg", "2025-11-09T13:24:00", "Trips", "69% 71%"],
].map(([name, captured, collection, demoCrop], index) => ({ path: `${collection}/${name}`, name, captured, modified: captured, collection, demoCrop, size: (index + 2) * 720_000, dateSource: "Captured", type: name.endsWith(".mp4") ? "Video" : "Photo" } as PhotoItem));

const fileNav = [["Home", House, true], ["Recent", Clock, true], ["Favourites", Star, true], ["Trash", Trash, true], ["Tags", Tag, true], ["Settings", Gear, true]] as const;
const photoNav = [["Timeline", Images], ["Collections", SquaresFour], ["Photos", ImageSquare], ["Videos", Video], ["Favourites", Star], ["Tags", Tag], ["Trash", Trash]] as const;

function formatSize(size: number) {
  if (!size) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1000)), units.length - 1);
  return `${(size / 1000 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function groupPhotos(items: PhotoItem[], key: (item: PhotoItem) => string) {
  const groups = new Map<string, PhotoItem[]>();
  for (const item of items) {
    const value = key(item);
    const group = groups.get(value);
    if (group) group.push(item); else groups.set(value, [item]);
  }
  return groups;
}

function FileIcon({ file, large = false }: { file: DriveFile; large?: boolean }) {
  const props = { size: large ? 106 : 31, weight: "duotone" as const };
  if (file.directory) return <Folder {...props} weight="fill" className="folder-icon" />;
  if (file.type === "PDF") return <FilePdf {...props} className="pdf-icon" />;
  return <FileXls {...props} className="sheet-icon" />;
}

function deviceStatus(device: Device) {
  if (device.kind === "Storage" && device.connected && !device.present) return "Connected · mount required";
  if (device.status === "Charging only") return "Charging only";
  if (device.present && (device.transports?.includes("mtp") || device.phoneRoot)) return "Files available";
  if (device.present || device.status === "Online") return "Online now";
  return device.lastSeen ? "Last reported" : "Not checked";
}

function ConnectionMap({ state, contentType }: { state: ApiState; contentType?: "Drive" | "Photos" }) {
  const routes = state.routes.filter((route) => !contentType || route.contentType === contentType);
  const storages = Array.from(new Set(routes.map((route) => route.storageId))).map((id) => state.storages.find((storage) => storage.id === id) || { id, label: "Unavailable storage", present: false, connected: false });
  const nodeStyle = { border: "1px solid #9eb4b8", borderRadius: 10, background: "#fff", color: "#28383e", width: 155, padding: 10, boxShadow: "0 2px 6px rgb(23 38 43 / 9%)", whiteSpace: "pre-line" as const };
  const nodes: Node[] = [
    { id: "local", position: { x: 10, y: Math.max(50, (storages.length - 1) * 42) }, data: { label: `${state.deviceName || "Laptop"}\nLocal catalog` }, style: { ...nodeStyle, border: "2px solid #008b8b", background: "#edf7f7" } },
    ...storages.map((storage, index) => ({ id: `storage-${storage.id}`, position: { x: 505, y: 28 + index * 84 }, data: { label: `${storage.label}\n${storage.present ? "Available" : storage.connected ? "Connected · mount required" : "Last reported"}` }, style: { ...nodeStyle, borderColor: storage.present ? "#7bc28a" : storage.connected ? "#d3b77f" : "#c8ced0" } })),
  ];
  const edges: Edge[] = [
    ...storages.map((storage) => ({ id: `local-storage-${storage.id}`, source: "local", target: `storage-${storage.id}`, label: routes.filter((route) => route.storageId === storage.id).map((route) => `${route.contentType}: ${route.behavior || "Copy"} · ${route.keepPolicy || "Everything"}`).join(" / "), markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: storage.present ? "#008b8b" : "#9aa5a8" } })),
  ];
  return <div className="connection-map" aria-label="Device and storage relationship map"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} minZoom={0.55} maxZoom={1.5}><Background gap={18} size={1} color="#dce3e4" /><Controls showInteractive={false} /></ReactFlow></div>;
}

function FullMapDialog({ state, onClose }: { state: ApiState; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="full-map-dialog" role="dialog" aria-modal="true" aria-labelledby="full-map-title"><header><div><h1 id="full-map-title">Connections overview</h1><p>Read-only flowchart generated from the connection cards.</p></div><button onClick={onClose} aria-label="Close full map">×</button></header><ConnectionMap state={state} /></section></div>;
}

function DevicePicker({ state, content, onChoose, onClose }: { state: ApiState; content: "Drive" | "Photos"; onChoose: (device: Device) => void; onClose: () => void }) {
  const available = state.storages.filter((storage) => storage.id !== "local" && !state.routes.some((route) => route.contentType === content && route.storageId === storage.id));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="device-picker" role="dialog" aria-modal="true" aria-labelledby="device-picker-title"><header><div><h1 id="device-picker-title">Add {content} connection</h1><p>{state.deviceName || "Laptop"} is the first device. Choose the second device.</p></div><button onClick={onClose} aria-label="Close device picker">×</button></header><div className="device-picker-list">{available.map((storage) => <button key={storage.id} onClick={() => onChoose({ ...storage, category: "storage", kind: "Storage" })}><HardDrive weight="duotone" /><span><strong>{storage.label}</strong><small>{storage.present ? "Available now" : storage.connected ? "Mount required" : "Offline · connection can wait"}</small></span><ArrowRight /></button>)}</div>{!available.length && <p>No unused storage is available for another {content} connection.</p>}</section></div>;
}

function ConnectionCards({ state, onUpdate, onAdd, onOpenMap }: { state: ApiState; onUpdate: (route: Route, mode: "Copy" | "Move", keepPolicy: string, cache: boolean) => Promise<void>; onAdd: (content: "Drive" | "Photos") => void; onOpenMap: () => void }) {
  const [content, setContent] = useState<"Drive" | "Photos">("Drive"), [status, setStatus] = useState("");
  const routes = state.routes.filter((route) => route.contentType === content), retention = ["Nothing", "Last day", "Last week", "Last month"];
  const storageName = (route: Route) => state.storages.find((storage) => storage.id === route.storageId)?.label || "Storage";
  const change = async (route: Route, mode: "Copy" | "Move", keep: string, cache: boolean) => { setStatus("Saving connection…"); try { await onUpdate(route, mode, keep, cache); setStatus("Connection saved"); } catch (error) { setStatus(error instanceof Error ? error.message : "Connection could not be saved"); } };
  return <div className="connection-editor"><div className="connection-editor-toolbar"><div className="segment"><button className={content === "Drive" ? "active" : ""} onClick={() => setContent("Drive")}><Folder />Drive</button><button className={content === "Photos" ? "active" : ""} onClick={() => setContent("Photos")}><Images />Photos</button></div><button className="secondary" onClick={onOpenMap}><ShareNetwork />Open full map</button></div><div className="connection-cards">{routes.map((route, index) => {
    const mode = route.behavior === "Move" ? "Move" : "Copy", cache = !!route.stagingMaxBytes, keep = route.keepPolicy || (mode === "Move" ? "Nothing" : "Everything");
    return <article className="connection-card" key={route.id}><small>Connection {index + 1}</small><div className="connection-device"><Desktop weight="duotone" /><strong>{state.deviceName || "Laptop"}</strong><span>Laptop</span></div><div className="connection-properties"><button disabled title="Reverse and two-way transfer become available only when the engine can execute them"><ArrowRight />Direction</button><button onClick={() => change(route, mode === "Copy" ? "Move" : "Copy", mode === "Copy" ? "Nothing" : "Everything", cache)}>{mode === "Copy" ? <Copy /> : <ArrowRight />}<span>{mode}</span></button><button onClick={() => change(route, mode, keep, !cache)}><Cpu /><span>{cache ? "Cache on" : "Cache off"}</span></button><button disabled={mode === "Copy"} onClick={() => { const next = retention[(retention.indexOf(keep) + 1) % retention.length]; change(route, mode, next, cache); }}><CalendarBlank /><span>{mode === "Copy" ? "Keeps source" : keep === "Nothing" ? "Keep none" : `Keep ${keep.replace("Last ", "")}`}</span></button></div><div className="connection-device"><HardDrive weight="duotone" /><strong>{storageName(route)}</strong><span>{route.storagePresent ? "Available" : "Offline"}</span></div><details><summary>Advanced</summary><p><b>Source:</b> {route.source}</p><p><b>Destination:</b> {route.destination}</p></details></article>;
  })}<button className="add-connection-card" onClick={() => onAdd(content)}><Plus /><strong>Add connection</strong><span>Choose two devices</span></button></div>{status && <small className="connection-status" role="status">{status}</small>}</div>;
}

function ActivityPanel({ root, path, fixture }: { root: "Drive" | "Photos"; path: string; fixture: boolean }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    if (fixture) { setItems([{ id: "fixture-activity", event: "verified", occurredAt: "2026-08-29T10:12:00", result: "Verified copy recorded", sourcePath: path, destinationPath: path }]); return; }
    setItems(null);
    fetch(`/api/v1/file-activity?root=${root}&path=${encodeURIComponent(path)}`).then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: ActivityItem[] }>; }).then((result) => setItems(result.items)).catch(() => setItems([]));
  }, [fixture, path, root]);
  if (items === null) return <p className="activity-empty">Loading activity…</p>;
  if (!items.length) return <p className="activity-empty">No transfer activity has been recorded for this file yet.</p>;
  return <div className="activity-list">{items.map((item, index) => <article key={`${item.occurredAt}-${item.event}-${index}`}><CheckCircle weight="fill" /><span><strong>{item.event === "verified" ? "Copy verified" : item.event.replaceAll("_", " ")}</strong><small>{item.result || "Recorded in append-only history"}</small></span><time>{formatDate(item.occurredAt)}</time></article>)}</div>;
}

function TopTabs({ active, onChange }: { active: MainTab; onChange: (tab: MainTab) => void }) {
  return <nav className="top-tabs" aria-label="Local Drive sections">
    <button className={active === "sync" ? "active" : ""} onClick={() => onChange("sync")}><ArrowsClockwise />Sync &amp; Connections</button>
    <button className={active === "files" ? "active" : ""} onClick={() => onChange("files")}><Folder />Drive Files</button>
    <button className={active === "photos" ? "active" : ""} onClick={() => onChange("photos")}><ImageSquare />Photos &amp; Videos</button>
    <button className={active === "new" ? "active" : ""} onClick={() => onChange("new")}><Plus />New +</button>
  </nav>;
}

function NewView({ onImport }: { onImport: () => void }) {
  return <section className="new-view"><header><h1>New</h1><p>Scan documents, organise content, or import and export your library.</p></header><div className="new-task-grid">
    <article><FilePdf size={36} /><h2>New scan</h2><p>Use the desktop document scanner. Save the resulting PDF or image inside Drive, or import it afterwards.</p><DesktopAction action="scan" fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} /></article>
    <article><ImageSquare size={36} /><h2>QR scanner</h2><p>Read a QR code using the laptop camera or an image. No automatic link opening.</p><QrScanner /></article>
    <article><Tag size={36} /><h2>New tag</h2><p>Create a tag for files, photos and videos on this laptop.</p><NewTag fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} /></article>
    <article><ArrowDown size={36} /><h2>Import</h2><p>Bring an existing folder into Drive or Photos. Preview and verify before copying; originals stay intact.</p><button className="primary" onClick={onImport}>Import existing folder</button></article>
    <article><ArrowSquareOut size={36} /><h2>Export photo library</h2><p>Create a compressed, verified snapshot on selected storage. Original photos stay intact.</p><PhotoExport fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} /></article>
  </div><p className="new-task-note">To create a file from a template, use Drive Files → ⋮ → New file.</p></section>;
}

function TemplateView({ lastDrivePath, fixture, initialTemplate }: { lastDrivePath: string; fixture: boolean; initialTemplate: string }) {
  const [templates, setTemplates] = useState<{name: string; size: number}[]>([]), [root, setRoot] = useState(""), [selected, setSelected] = useState(""), [name, setName] = useState(""), [status, setStatus] = useState("");
  useEffect(() => { setSelected(initialTemplate); setName(initialTemplate); }, [initialTemplate]);
  const refresh = async () => {
    if (fixture) { setRoot("Drive/.templates"); setStatus("Demo mode: no templates are loaded from your computer."); return; }
    try { const response = await fetch("/api/v1/templates"); if (!response.ok) throw new Error("Templates unavailable"); const data = await response.json() as {root: string; items: {name: string; size: number}[]}; setTemplates(data.items); setRoot(data.root); setStatus(""); } catch (error) { setStatus(error instanceof Error ? error.message : "Templates unavailable"); }
  };
  useEffect(() => { refresh(); }, [fixture]);
  const create = async () => {
    if (fixture) return;
    setStatus("Creating…");
    try { const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const {token} = await session.json() as {token: string}; const response = await fetch("/api/v1/create-from-template", {method: "POST", headers: {"Content-Type": "application/json", "X-Local-Drive-Token": token}, body: JSON.stringify({template: selected, name, parent: lastDrivePath})}); const result = await response.json() as {path?: string; error?: string}; if (!response.ok) throw new Error(result.error || "Creation failed"); setStatus(`Created Drive/${result.path}. The file was not executed.`); } catch (error) { setStatus(error instanceof Error ? error.message : "Creation failed"); }
  };
  return <section className="new-view"><header><h1>New from template</h1><p>Destination: Drive{lastDrivePath ? ` / ${lastDrivePath}` : ""}. Folder creation and import are in the Drive ⋮ menu.</p></header><div className="template-workspace"><button className="secondary" onClick={refresh}>Refresh templates</button><div className="scope-choices">{templates.map((item) => <button key={item.name} aria-pressed={selected === item.name} onClick={() => { setSelected(item.name); setName(item.name); }}><File /><strong>{item.name}</strong><small>{formatSize(item.size)}</small></button>)}</div>{!templates.length && <p>No templates yet. Put your TXT, SH or valid document templates in the folder below, then refresh.</p>}<details><summary>Templates folder · Advanced</summary><p>{root || "Loading…"}</p><p>Create this hidden folder if it does not exist. Only regular files up to 8 MB are listed. Templates are local and are never executed.</p></details>{selected && <form onSubmit={(event) => { event.preventDefault(); create(); }}><label>New filename<input required value={name} onChange={(event) => setName(event.target.value)} /></label><button className="primary" disabled={fixture || !name.trim() || status === "Creating…"}>Create file</button></form>}{status && <p role="status">{status}</p>}</div></section>;
}

function RouteSetup({ state, fixture, onSaved, initialContentType = "Drive", preferredStorageId = "", onCommitted }: { state: ApiState; fixture: boolean; onSaved: (route?: Route) => Promise<void> | void; initialContentType?: "Drive" | "Photos"; preferredStorageId?: string; onCommitted?: (type: "Drive" | "Photos") => void }) {
  const firstStorage = preferredStorageId || state.storages.find((storage) => storage.id !== "local" && !state.routes.some((route) => route.contentType === initialContentType && route.storageId === storage.id))?.id || "";
  const sourceFor = (type: "Drive" | "Photos") => state.routes.find((route) => route.contentType === type)?.source || `${state.libraryRoot || "~/Local Drive"}/${type}`;
  const destinationFor = (type: "Drive" | "Photos", id: string) => { const root = state.storages.find((storage) => storage.id === id)?.root || ""; return root ? `${root.replace(/\/$/, "")}/Local Drive/${type}` : ""; };
  const contentType = initialContentType;
  const [source, setSource] = useState(sourceFor(initialContentType)), [destination, setDestination] = useState(destinationFor(initialContentType, firstStorage)), [storageId, setStorageId] = useState(firstStorage), [keepPolicy, setKeepPolicy] = useState("Everything"), [organizePhotos, setOrganizePhotos] = useState(true), [status, setStatus] = useState("");
  useEffect(() => { setSource(sourceFor(contentType)); setDestination(destinationFor(contentType, storageId)); }, [contentType, storageId]);
  const save = async () => {
    setStatus("Validating and saving…");
    try {
      if (fixture) { await onSaved({ id: `fixture-${contentType}-${storageId}`, contentType, source, storageId, destination, storagePresent: true, keepPolicy }); setStatus("Route saved"); onCommitted?.(contentType); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/save-route", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ contentType, source, storageId, destination, keepPolicy, organizePhotos }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Route could not be saved"); await onSaved(); setStatus("Route saved"); onCommitted?.(contentType);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Route could not be saved"); }
  };
  return <form className="route-setup" onSubmit={(event) => { event.preventDefault(); save(); }}><div className="setup-fields">
    <label>Backup storage<select value={storageId} onChange={(event) => setStorageId(event.target.value)}><option value="">Choose storage</option>{state.storages.filter((storage) => storage.id !== "local" && !state.routes.some((route) => route.contentType === contentType && route.storageId === storage.id)).map((storage) => <option value={storage.id} key={storage.id}>{storage.label}{storage.present ? "" : " (not connected)"}</option>)}</select></label>
    <label>Keep source files<select value={keepPolicy} onChange={(event) => setKeepPolicy(event.target.value)}><option value="Everything">Everything</option><option value="Last month">Last month</option><option value="Last week">Last week</option><option value="Last day">Last day</option><option value="Nothing">Nothing after verified receipt</option></select></label>
    {contentType === "Photos" && <label className="setup-check"><input type="checkbox" checked={organizePhotos} onChange={(event) => setOrganizePhotos(event.target.checked)} />Organize unfiled photos by year</label>}
    <details><summary>Advanced · folder locations</summary><label>Source folder<input value={source} onChange={(event) => setSource(event.target.value)} /></label><label>Destination folder<input value={destination} onChange={(event) => setDestination(event.target.value)} /></label></details>
  </div><p><CheckCircle />The proposed Local Drive folders are created when you save. Other paths must already exist, be writable, and stay inside the selected storage.</p><button className="primary" disabled={!source.trim() || !destination.trim() || !storageId || status === "Validating and saving…"}>{status === "Validating and saving…" ? status : `Save ${contentType} relationship`}</button>{status && status !== "Validating and saving…" && <small role="status">{status}</small>}</form>;
}

function RoutePreviewButton({ route, fixture }: { route: Route; fixture: boolean }) {
  const [status, setStatus] = useState(""), [preview, setPreview] = useState<ImportPreview | null>(null), [operationId, setOperationId] = useState(""), [transferState, setTransferState] = useState(""), [transferResult, setTransferResult] = useState(""), [progress, setProgress] = useState(0), [paused, setPaused] = useState(false), [manifestStatus, setManifestStatus] = useState(""), [history, setHistory] = useState<RouteHistoryItem[]>([]);
  const fixturePaused = useRef(false), fixtureCancelled = useRef(false);
  const refreshHistory = async () => {
    if (fixture) return;
    try { const response = await fetch(`/api/v1/route-history?routeId=${encodeURIComponent(route.id)}`); if (response.ok) setHistory(((await response.json()) as { items: RouteHistoryItem[] }).items); } catch { /* The route remains usable while history is temporarily unavailable. */ }
  };
  useEffect(() => { refreshHistory(); }, [route.id]);
  const inspect = async () => {
    setStatus("Previewing…"); setPreview(null); setOperationId(""); setTransferState(""); setTransferResult(""); setManifestStatus(""); setProgress(0); setPaused(false); fixturePaused.current = false; fixtureCancelled.current = false;
    try {
      if (fixture) { setPreview({ ok: true, error: "", files: route.contentType === "Photos" ? 842 : 143, bytes: 2_760_000_000, toCopy: 418_000_000, identical: 91, duplicates: 0, destinationDuplicates: 0, conflicts: 0, unsupported: 0, unreadable: 0, duplicatePaths: [], conflictPaths: [], unsupportedPaths: [] }); setOperationId(`fixture-${route.id}`); setStatus(""); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const started = await fetch("/api/v1/route-preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ routeId: route.id }) });
      const operation = await started.json() as { id?: string; error?: string }; if (!started.ok || !operation.id) throw new Error(operation.error || "Preview could not start");
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(operation.id)}`); const current = await response.json() as { state?: string; preview?: ImportPreview; error?: string };
        if (!response.ok) throw new Error(current.error || "Preview unavailable");
        if (current.state === "complete" && current.preview) { setPreview(current.preview); setOperationId(operation.id); setStatus(""); return; }
      }
      throw new Error("Preview is taking longer than expected");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Preview failed"); }
  };
  const transfer = async () => {
    setTransferState("copying"); setTransferResult(""); setProgress(0); setPaused(false); fixturePaused.current = false; fixtureCancelled.current = false;
    try {
      if (fixture) { for (let step = 1; step <= 20; step++) { while (fixturePaused.current && !fixtureCancelled.current) await new Promise((resolve) => setTimeout(resolve, 50)); if (fixtureCancelled.current) { setTransferState("failed"); setTransferResult("Cancelled. Source files were retained and no incomplete file was published."); return; } await new Promise((resolve) => setTimeout(resolve, 50)); setProgress(step * 5); } setTransferState("transferred"); setTransferResult(route.keepPolicy === "Everything" ? "Transfer complete. Source files were kept." : "Transfer verified. Cleanup remains pending and recoverable."); setHistory([{ event: "verified", result: "verified copy", occurredAt: new Date().toISOString(), source: `${route.contentType}/Health Summary.pdf`, destination: `${route.destination}/Health Summary.pdf` }]); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const started = await fetch("/api/v1/route-execute", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: operationId }) }); const start = await started.json() as { error?: string }; if (!started.ok) throw new Error(start.error || "Transfer could not start");
      for (let attempt = 0; attempt < 14_400; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250)); const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(operationId)}`); const current = await response.json() as { state?: string; result?: string; bytesDone?: number; bytesTotal?: number; paused?: boolean; error?: string };
        if (!response.ok) throw new Error(current.error || "Transfer status unavailable");
        if (current.bytesTotal) setProgress(Math.min(100, Math.round((current.bytesDone || 0) * 100 / current.bytesTotal))); setPaused(!!current.paused);
        if (current.state === "transferred" || current.state === "failed") { setTransferState(current.state); setTransferResult(current.result || (current.state === "transferred" ? "Transfer complete" : "Transfer failed")); if (current.state === "transferred") await refreshHistory(); return; }
      }
      throw new Error("Transfer is still running; its state remains in the catalog");
    } catch (error) { setTransferState("failed"); setTransferResult(error instanceof Error ? error.message : "Transfer failed"); }
  };
  const control = async (action: "pause" | "resume" | "cancel") => {
    try {
      if (fixture) { if (action === "pause") { fixturePaused.current = true; setPaused(true); } else if (action === "resume") { fixturePaused.current = false; setPaused(false); } else { fixtureCancelled.current = true; fixturePaused.current = false; setPaused(false); } return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string }; const response = await fetch("/api/v1/route-control", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: operationId, action }) }); const result = await response.json() as { paused?: boolean; status?: string; error?: string }; if (!response.ok) throw new Error(result.error || "Transfer control failed"); setPaused(!!result.paused); if (action === "cancel") setTransferResult("Cancelling safely…");
    } catch (error) { setTransferResult(error instanceof Error ? error.message : "Transfer control failed"); }
  };
  const exportManifest = async () => {
    setManifestStatus("Preparing manifest…");
    try {
      let filename = `local-drive-${route.id}-manifest.json`, manifest: unknown = { format: "localdrive-manifest-v1", source: route.contentType, destination: route.destination, files: [{ path: "Health Summary.pdf", destination: "Health Summary.pdf", size: 1_454_512, mtime: 0 }] };
      if (!fixture) { const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string }; const response = await fetch("/api/v1/route-manifest", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: operationId }) }); const result = await response.json() as { filename?: string; manifest?: unknown; error?: string }; if (!response.ok || !result.manifest) throw new Error(result.error || "Manifest unavailable"); filename = result.filename || filename; manifest = result.manifest; }
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); setManifestStatus("Manifest downloaded");
    } catch (error) { setManifestStatus(error instanceof Error ? error.message : "Manifest export failed"); }
  };
  return <div className="route-preview"><button className="secondary" disabled={!route.storagePresent || status === "Previewing…" || transferState === "copying"} onClick={inspect}><PlayCircle />{status === "Previewing…" ? status : "Preview route"}</button>
    {!route.storagePresent && <small>Connect the storage to preview.</small>}
    {status && status !== "Previewing…" && <small role="status">{status}</small>}
    {preview && <div className={preview.ok ? "preview-result" : "preview-result failed"} role="status">{preview.ok ? <><strong>{preview.files} files · {formatSize(preview.bytes)}</strong><span>{formatSize(preview.toCopy)} to transfer · {preview.identical} already identical · {preview.conflicts} conflicts</span></> : <><strong>Preview failed</strong><span>{preview.error}</span></>}</div>}
    {preview?.ok && operationId && <button className="secondary" onClick={exportManifest}><ArrowSquareOut />Export manifest</button>}
    {preview?.ok && operationId && transferState !== "failed" && <button className="primary" disabled={transferState === "copying" || transferState === "transferred"} onClick={transfer}><PlayCircle />{transferState === "copying" ? `Transferring… ${progress}%` : transferState === "transferred" ? "Transferred" : "Transfer verified files"}</button>}
    {transferState === "copying" && <div className="transfer-controls">{paused ? <button className="secondary" onClick={() => control("resume")}><PlayCircle />Resume</button> : <button className="secondary" onClick={() => control("pause")}><PauseCircle />Pause</button>}<button className="danger" onClick={() => control("cancel")}><StopCircle />Cancel</button></div>}
    {manifestStatus && <small className={manifestStatus === "Manifest downloaded" ? "transfer-success" : ""} role="status">{manifestStatus}</small>}
    {transferResult && <small className={transferState === "transferred" ? "transfer-success" : ""} role="status">{transferResult}</small>}
    <details className="route-history"><summary>Recent activity ({history.length})</summary>{history.length ? <ul>{history.map((item, index) => <li key={`${item.occurredAt}-${index}`}><strong>{item.event}</strong><span>{item.result} · {formatDate(item.occurredAt)}</span></li>)}</ul> : <p>No transfer history yet.</p>}</details>
  </div>;
}

function HubControl({ state, onSave }: { state: ApiState; onSave: (enabled: boolean, limit: number) => Promise<void> }) {
  const [enabled, setEnabled] = useState(state.hub?.enabled || false), [limit, setLimit] = useState(state.hub?.limitPercent || 80), [status, setStatus] = useState("");
  return <div className="hub-control"><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><strong>Use Laptop as hub</strong></label><span>Keep laptop usage below <input aria-label="Laptop hub storage limit" type="number" min="1" max="95" value={limit} onChange={(event) => setLimit(Number(event.target.value))} />%</span><button className="secondary" onClick={async () => { setStatus("Saving…"); try { await onSave(enabled, limit); setStatus("Saved"); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save hub settings"); } }}>Apply</button>{status && <small role="status">{status}</small>}</div>;
}

function SyncView({ state, checkedAt, onCheck, onProblems, onMount, onHubSave, onRouteUpdate, onAddConnection }: { state: ApiState; checkedAt: string; onCheck: () => void; onProblems: () => void; onMount: (id: string) => void; onHubSave: (enabled: boolean, limit: number) => Promise<void>; onRouteUpdate: (route: Route, mode: "Copy" | "Move", keepPolicy: string, cache: boolean) => Promise<void>; onAddConnection: (content: "Drive" | "Photos") => void }) {
  const syncDialog = useRef<HTMLDialogElement>(null);
  const [phoneActionStatus, setPhoneActionStatus] = useState(""), [fullMapOpen, setFullMapOpen] = useState(false);
  const transfer = state.catalog.activeTransfer;
  const capacity = storageTotals(state.storages);
  const fixture = import.meta.env.DEV && new URLSearchParams(location.search).has("fixture");
  const transferPercent = transfer?.bytesTotal ? Math.round(transfer.bytesDone * 100 / transfer.bytesTotal) : 0;
  const mountable = state.storages.find((storage) => storage.connected && !storage.present);
  const healthy = state.ready && !state.error && state.problems === 0 && !mountable;
  const liveDevices = state.connectedDevices?.length ? state.connectedDevices : state.devices;
  const deviceRows: Device[] = [
    { id: "local", label: state.deviceName || "Laptop", present: true, kind: "Laptop" },
    ...liveDevices.slice(0, 2),
    ...state.storages.filter((storage) => storage.id !== "local").slice(0, 1).map((storage) => ({ ...storage, kind: "Storage" })),
  ];
  const phone = liveDevices.find((device) => device.kind === "Phone" || device.transports?.includes("mtp") || device.label.includes("Xiaomi"));
  const phoneCharging = phone?.status === "Charging only";
  const phoneFilesAvailable = !!phone?.present && !phoneCharging && (phone.transports?.includes("mtp") || !!phone.phoneRoot);
  const importFromPhone = async (root: "Drive" | "DCIM") => {
    if (fixture) { setPhoneActionStatus("Demo mode: no phone files were transferred. Open the live application to import."); return; }
    setPhoneActionStatus(`Scanning phone ${root}…`);
    try {
      if (location.search.includes("fixture")) { await new Promise((resolve) => setTimeout(resolve, 500)); setPhoneActionStatus(`${root === "Drive" ? "Files" : "Photos & videos"} imported and verified`); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const started = await fetch("/api/v1/import-from-phone", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ root }) });
      const startResult = await started.json() as { id?: string; error?: string; destination?: string }; if (!started.ok || !startResult.id) throw new Error(startResult.error || "Phone import could not start");
      setPhoneActionStatus(`Scanning phone ${root} → ${startResult.destination || "backup"}…`);
      for (let attempt = 0; attempt < 240; attempt++) { await new Promise((resolve) => setTimeout(resolve, 500)); const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(startResult.id)}`); if (!response.ok) continue; const operation = await response.json() as { state: string; result?: string; bytesDone?: number; bytesTotal?: number; path?: string }; if (operation.state === "failed") throw new Error(operation.result || "Phone import failed; sources retained"); if (operation.state === "transferred") { setPhoneActionStatus(operation.result || "Phone import completed and verified"); return; } setPhoneActionStatus(operation.bytesTotal ? `${operation.path || "Importing"} · ${Math.round((operation.bytesDone || 0) * 100 / operation.bytesTotal)}%` : `Scanning phone ${root} → ${startResult.destination || "backup"}…`); }
      setPhoneActionStatus("Import continues in Current transfer");
    } catch (error) { setPhoneActionStatus(error instanceof Error ? error.message : "Phone import failed; sources retained"); }
  };

  return <section className="sync-view">
    <div className={`health-banner ${healthy ? "healthy" : "attention"}`}>
      {healthy ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}
      <div><h1>{mountable ? `${mountable.label} is connected but not mounted` : healthy ? "Everything is running smoothly" : "Local Drive needs attention"}</h1><p>{mountable ? "Mount it to make its backup routes available." : `Last checked ${checkedAt}`}</p></div>
      {mountable && <button className="secondary" onClick={() => onMount(mountable.id)}><HardDrive />Mount storage</button>}
    </div>

    <div className="sync-grid">
      <article className="sync-card transfer-card">
        <h2><ArrowsClockwise />Notifications</h2>
        <h3>Current transfer</h3>
        {transfer ? <>
          <strong>{transfer.state} → {transfer.destination || "configured storage"}</strong>
          <div className="progress-row"><progress value={transferPercent} max="100" /><b>{transferPercent}%</b></div>
          <p>{formatSize(transfer.bytesDone)} of {formatSize(transfer.bytesTotal)}</p>
        </> : <div className="quiet-state"><CheckCircle /><strong>No active transfer</strong><p>New work will appear here automatically.</p></div>}
        {state.error && <p role="alert">{state.error}</p>}
        {state.photoExports?.map((job) => <p key={job.id}><Database />Photo library export: {job.result || `${job.state} · ${job.filesDone || 0} / ${job.filesTotal || "…"} files`}{!["transferred", "failed"].includes(job.state) && " — keep storage connected."}</p>)}
        {state.storages.filter((storage) => storage.connected && !storage.present).map((storage) => <p key={storage.id}><WarningCircle /> {storage.label} needs mounting. <button onClick={() => onMount(storage.id)}>Mount</button></p>)}
        {state.problems > 0 && <p><button onClick={onProblems}><Wrench />Review {state.problems} problems</button></p>}
        {!!state.hub?.pendingBytes && <p><Clock />Files are awaiting transfer. Connect {state.hub.waitingFor || "destination storage"}.</p>}
      </article>

      <article className="sync-card devices-card">
        <h2><Desktop />Connected devices</h2>
        <div className="device-list">{deviceRows.map((device) => {
          const status = deviceStatus(device);
          return <div className="device-row" key={device.id}>
            {device.kind === "Storage" ? <HardDrive /> : device.kind === "Phone" || device.label.includes("Xiaomi") ? <DeviceMobile /> : <Desktop />}
            <strong>{device.label}</strong><span className={`status ${status === "Online now" || status === "Files available" ? "online" : "remembered"}`}>{status === "Online now" || status === "Files available" ? <CheckCircle weight="fill" /> : status === "Last reported" ? <Clock /> : <WarningCircle />}{status}</span><CaretRight />
          </div>;
        })}</div>
        {phone && <div className={`phone-usb-guide ${phoneFilesAvailable ? "ready" : phoneCharging ? "attention" : "offline"}`}>
          {phoneFilesAvailable ? <CheckCircle weight="fill" /> : phoneCharging ? <DeviceMobile weight="fill" /> : <Clock />}
          <div><strong>{phoneFilesAvailable ? `${phone.label} memory is available` : phoneCharging ? "Phone connected — charging only" : `${phone.label} is disconnected`}</strong>
            <p>{phoneFilesAvailable ? "Ready to preview Drive and DCIM. USB debugging is not used." : phoneCharging ? "Unlock the phone, open ‘Charging via USB’, then choose ‘File transfers / Android Auto’. Ignore the USB debugging notification." : "Reconnect and enable File transfers. Pending work and verified history stay saved."}</p>
            <ol><li>Connect and unlock</li><li className={phoneCharging || phoneFilesAvailable ? "done" : ""}>Cable detected</li><li className={phoneFilesAvailable ? "done" : ""}>Enable file transfers</li><li className={phoneFilesAvailable ? "done" : ""}>Preview, then transfer</li></ol>
            {phoneFilesAvailable && <div className="phone-import-actions"><button className="secondary" disabled={phoneActionStatus.startsWith("Scanning") || phoneActionStatus.includes("%")} onClick={() => importFromPhone("Drive")}>Import Drive</button><button className="secondary" disabled={phoneActionStatus.startsWith("Scanning") || phoneActionStatus.includes("%")} onClick={() => importFromPhone("DCIM")}>Import photos &amp; videos</button></div>}
            {phoneActionStatus && <small role="status">{phoneActionStatus}</small>}
          </div>
        </div>}
        <button className="secondary" onClick={onCheck}><ShareNetwork />Check connections</button>
      </article>

      <article className="sync-card map-card">
        <h2><ShareNetwork />Connections</h2>
        <ConnectionCards state={state} onUpdate={onRouteUpdate} onAdd={onAddConnection} onOpenMap={() => setFullMapOpen(true)} />
        <HubControl state={state} onSave={onHubSave} />
      </article>

      <article className="sync-card pending-card">
        <h2><PlayCircle />Sync now</h2>
        <p>Preview a connection, then confirm the verified transfer. No source cleanup starts here.</p>
        <button className="primary" disabled={!state.routes.length} onClick={() => syncDialog.current?.showModal()}><PlayCircle />Sync now</button>
        <dialog ref={syncDialog} className="item-action-dialog" aria-label="Sync now"><h2>Sync now</h2><p>Preview a connection, then confirm its transfer. Closing does not cancel running work.</p>{state.routes.map((route) => <section key={route.id}><h3>{route.contentType} → {state.storages.find((storage) => storage.id === route.storageId)?.label || "Storage"}</h3><RoutePreviewButton route={route} fixture={fixture} /></section>)}<button onClick={() => syncDialog.current?.close()}>Close</button></dialog>
        {!state.routes.length && <p>Add a connection first.</p>}
        <h2><Clock />Pending backup</h2>
        <div className="pending-total"><strong>{state.catalog.pendingFiles.toLocaleString("en-GB")}</strong><span>items</span></div>
        <p>{formatSize(state.catalog.pendingBytes)} ready for the next eligible connection.</p>
        {!!state.hub?.pendingBytes && <p className="hub-waiting"><WarningCircle weight="fill" /><span><strong>{formatSize(state.hub.pendingBytes)} held safely on Laptop.</strong> Connect {state.hub.waitingFor || "the selected storage"} to continue.</span></p>}
        <p className="muted">Metadata last updated {state.catalog.lastMetadataUpdate || "not yet"}</p>
      </article>

      <article className="sync-card storage-card">
        <h2><Database />Storage across devices</h2>
        <div role="status"><strong>{capacity.total ? `${formatSize(capacity.total)} total reported online capacity` : "Online capacity unavailable"}</strong>{capacity.total > 0 && <p>{formatSize(capacity.used)} used · {formatSize(capacity.free)} remaining</p>}<p>{capacity.excluded} offline or unknown volumes excluded. Phones without capacity reports are not included. This is storage capacity, not unique file size.</p></div>
        {state.storages.filter((storage) => storage.bytesTotal || storage.connected).map((storage) => {
          const total = storage.bytesTotal || 0;
          const free = storage.bytesFree || 0;
          const used = total - free;
          const percent = total ? Math.round(used * 100 / total) : 0;
          return <div className="storage-row" key={storage.id}>
            <div className="storage-row-main">
              <span className="storage-name">{storage.present ? <CheckCircle weight="fill" className="online" /> : <WarningCircle weight="fill" className="remembered" />}<strong>{storage.label}</strong></span>
              <progress value={percent} max="100" aria-label={`${storage.label}: ${percent}% used`} />
              <b>{percent}%</b>
            </div>
            <div className="storage-row-details"><span>{storage.present ? `${formatSize(total)} total` : storage.connected ? <button className="secondary" onClick={() => onMount(storage.id)}>Mount storage</button> : "Not connected"}</span><span><strong>{storage.present ? `${formatSize(free)} remaining` : "Capacity unavailable"}</strong><small>{storage.present ? `${formatSize(used)} used` : "Identified by UUID"}</small></span></div>
          </div>;
        })}
        {!state.storages.some((storage) => storage.bytesTotal || storage.connected) && <div className="quiet-state"><HardDrive /><strong>No storage report yet</strong></div>}
      </article>

      <article className="sync-card problems-card">
        <h2><Wrench />Problems &amp; Fixes</h2>
        <div className={state.problems ? "problem-summary attention" : "problem-summary"}>
          {state.problems ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}
          <div><strong>{state.problems ? `${state.problems} item${state.problems === 1 ? "" : "s"} need review` : "No action needed"}</strong><p>{state.problems ? "Review before the next transfer." : "All reported systems are healthy."}</p></div>
        </div>
        <button className="secondary" onClick={onProblems}><Wrench />Open Problems &amp; Fixes</button>
      </article>
    </div>{fullMapOpen && <FullMapDialog state={state} onClose={() => setFullMapOpen(false)} />}
  </section>;
}

function ProblemsView({ problems, onBack, onAction }: { problems: ProblemsResponse; onBack: () => void; onAction: (id: string, action: ProblemAction) => Promise<void> }) {
  const [category, setCategory] = useState("All");
  const [showHistory, setShowHistory] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const visible = category === "All" ? problems.items : problems.items.filter((item) => item.category === category);
  const [selectedId, setSelectedId] = useState(problems.items[0]?.id ?? "");
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0];
  const labels: Record<string, string> = { needs_decision: "Needs decision", needs_device: "Needs device", can_retry: "Can retry", saved: "Saved for review" };

  return <section className="problems-view">
    <header className="problems-header"><button onClick={onBack}><ArrowLeft />Back to Sync</button><div><h1>Problems &amp; Fixes</h1><p>{problems.total ? `${problems.total} item${problems.total === 1 ? "" : "s"} need review` : "No action needed"}</p></div></header>
    <nav className="problem-filters" aria-label="Problem categories">
      <button className={!showHistory && category === "All" ? "active" : ""} onClick={() => { setShowHistory(false); setCategory("All"); setActionStatus(""); }}><strong>{problems.total}</strong><span>All</span></button>
      {Object.entries(problems.counts).map(([name, count]) => <button className={!showHistory && category === name ? "active" : ""} key={name} onClick={() => { setShowHistory(false); setCategory(name); setActionStatus(""); }}><strong>{count}</strong><span>{name}</span></button>)}
      <button className={showHistory ? "active" : ""} onClick={() => { setShowHistory(true); setActionStatus(""); }}><strong>{problems.history.length}</strong><span>Decision history</span></button>
    </nav>
    {showHistory ? <div className="decision-history">{problems.history.length ? problems.history.map((item) => <article key={item.id}><CheckCircle weight="fill" /><span><strong>{item.title}</strong><small>{item.category} · {item.action === "dismiss" ? "Dismissed" : item.action === "accept_existing" ? "Used existing copies" : item.action === "keep_both" ? "Kept both versions" : item.action === "skip_unsupported" ? "Kept unsupported in source" : item.action === "recheck_location" ? `Phone recheck: ${item.state}` : "Saved for review"}</small></span><time>{formatDate(item.occurredAt)}</time></article>) : <div className="problems-empty"><Clock /><h2>No decisions yet</h2></div>}</div>
    : visible.length ? <div className="problems-layout"><div className="problem-list">{visible.map((item) => <button className={selected?.id === item.id ? "selected" : ""} key={item.id} onClick={() => { setSelectedId(item.id); setActionStatus(""); }}><WarningCircle weight="fill" /><span><strong>{item.title}</strong><small>{item.summary}</small></span><b>{item.itemCount}</b><CaretRight /></button>)}</div>
      <aside className="problem-details">{selected && <>
        <span className="problem-state">{labels[selected.state] || selected.state}</span><h2>{selected.title}</h2><p>{selected.summary}</p>
        <dl>
          <dt>Category</dt><dd>{selected.category}</dd>
          <dt>Found by</dt><dd>{selected.source === "import" ? "Import preview" : selected.source === "metadata" ? selected.details.deviceStableId ? "Phone metadata" : "Folder watcher" : selected.source}</dd>
          {selected.details.source && <><dt>Source</dt><dd>{selected.details.source}</dd></>}
          {selected.details.root && <><dt>Root</dt><dd>{selected.details.root}</dd></>}
          {selected.details.target && <><dt>Target</dt><dd>{selected.details.target}</dd></>}
          {selected.details.expectedSize !== undefined && <><dt>Expected size</dt><dd>{formatSize(selected.details.expectedSize)}</dd></>}
          {selected.details.expectedSha256 && <><dt>Evidence SHA-256</dt><dd><code>{selected.details.expectedSha256}</code></dd></>}
          {selected.details.correctionStatus && <><dt>Phone recheck</dt><dd>{selected.details.correctionStatus}</dd></>}
        </dl>
        {selected.details.paths?.length ? <section><h3>Reported paths</h3>{selected.details.paths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}</section> : null}
        {selected.details.correctionError && <p>{selected.details.correctionError}</p>}
        <p className="problem-safety"><CheckCircle />No file has been changed or deleted. Resolution actions will use the verified history path.</p>
        <div className="problem-actions">
          {selected.state !== "saved" && selected.source !== "job" && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Saving…"); try { await onAction(selected.id, "save"); setActionStatus("Saved for review"); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Save for review</button>}
          {selected.source === "metadata" && selected.details.deviceStableId && selected.details.expectedSha256 && selected.details.correctionStatus !== "pending" && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Waiting for phone…"); try { await onAction(selected.id, "recheck_location"); setActionStatus("Queued for the phone"); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Recheck on phone</button>}
          {selected.source === "import" && selected.category === "Duplicates" && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Checking decision…"); try { await onAction(selected.id, "accept_existing"); setActionStatus(""); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Use existing copies</button>}
          {selected.source === "import" && selected.category === "Conflicts" && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Checking decision…"); try { await onAction(selected.id, "keep_both"); setActionStatus(""); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Keep both safely</button>}
          {selected.source === "import" && selected.category === "Unsupported" && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Checking decision…"); try { await onAction(selected.id, "skip_unsupported"); setActionStatus(""); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Keep unsupported in source</button>}
          {selected.state === "saved" && selected.source === "metadata" && !selected.details.changed && !selected.details.missing && <button className="secondary" disabled={!!actionStatus} onClick={async () => { setActionStatus("Dismissing…"); try { await onAction(selected.id, "dismiss"); setActionStatus(""); } catch (error) { setActionStatus(error instanceof Error ? error.message : "Action failed"); } }}>Dismiss observation</button>}
          {actionStatus && <small>{actionStatus}</small>}
        </div>
      </>}</aside>
    </div> : <div className="problems-empty"><CheckCircle weight="fill" /><h2>Everything is clear</h2><p>No unresolved findings in this category.</p></div>}
  </section>;
}

function FilesView({ files, path, state, verifiedOn, fixture, onNavigate, onRouteSaved, onNewFolder, onSyncDrive, onNewFile }: { files: DriveFile[]; path: string; state: ApiState; verifiedOn: string; fixture: boolean; onNavigate: (path: string) => Promise<void>; onRouteSaved: (route?: Route) => Promise<void> | void; onNewFolder: () => void; onSyncDrive: () => void; onNewFile: (name: string) => void }) {
  const [fileLabels, setFileLabels] = useState<Record<string, FileLabels>>({});
  const [registeredTags, setRegisteredTags] = useState<string[]>([]);
  const [labelsRoot, setLabelsRoot] = useState("");
  const [labelsReady, setLabelsReady] = useState(fixture);
  const refreshLabels = async () => {
    if (fixture) return;
    const response = await fetch("/api/v1/file-labels");
    if (!response.ok) throw new Error("File actions unavailable: labels could not be loaded");
    const result = await response.json() as { root: string; items: Record<string, FileLabels>; tags?: string[] };
    setFileLabels(result.items); setRegisteredTags(result.tags || []); setLabelsRoot(result.root); setLabelsReady(true);
  };
  useEffect(() => { void refreshLabels().catch((error: Error) => { setLabelsReady(false); setNavigationError(error.message); }); }, [path, fixture]);
  const [menuTemplates, setMenuTemplates] = useState<string[]>([]), [templateStatus, setTemplateStatus] = useState("");
  const refreshMenuTemplates = async () => {
    setMenuTemplates([]);
    if (fixture) { setMenuTemplates(["Νέο αρχείο.txt", "New Scrip.sh"]); setTemplateStatus("Demo template examples"); return; }
    setTemplateStatus("Loading templates…");
    try { const response = await fetch("/api/v1/templates"); if (!response.ok) throw new Error(); const data = await response.json() as {items: {name: string}[]}; setMenuTemplates(data.items.map((item) => item.name)); setTemplateStatus(data.items.length ? "" : "No templates in Drive/.templates"); } catch { setTemplateStatus("Templates unavailable — check the local service"); }
  };
  const [section, setSection] = useState("Home");
  const [query, setQuery] = useState("");
  const [grid, setGrid] = useState(false);
  const [sort, setSort] = useState("name");
  const [selectedName, setSelectedName] = useState(files.find((item) => !item.directory)?.name ?? files[0]?.name ?? "");
  const [history, setHistory] = useState<string[]>([]);
  const [navigationError, setNavigationError] = useState("");
  const [openStatus, setOpenStatus] = useState("");
  const [recentFiles, setRecentFiles] = useState<DriveFile[]>([]);
  const [detailTab, setDetailTab] = useState<"details" | "activity">("details");
  const fileSection = ["Home", "Recent", "Favourites", "Tags"].includes(section);
  const shownFiles = section === "Home" ? files : recentFiles;
  const visible = useMemo(() => shownFiles.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.directory) - Number(a.directory) || (sort === "modified" ? b.modified.localeCompare(a.modified) : sort === "size" ? b.size - a.size : sort === "name-desc" ? b.name.localeCompare(a.name, undefined, { numeric: true }) : a.name.localeCompare(b.name, undefined, { numeric: true }))), [shownFiles, query, sort]);
  const selected = shownFiles.find((file) => (file.path || file.name) === selectedName) ?? shownFiles[0];
  const phoneReady = (state.connectedDevices?.length ? state.connectedDevices : state.devices).some((device) => device.present && !!device.phoneRoot && device.stableIdentity?.startsWith("mtp:"));
  const segments = path ? path.split("/") : [];
  const go = async (next: string) => { try { await onNavigate(next); setSection("Home"); setHistory((current) => [...current, path]); setQuery(""); setNavigationError(""); } catch (error) { setNavigationError(error instanceof Error ? error.message : "Drive folder unavailable"); } };
  const back = async () => { const previous = history.at(-1); if (previous === undefined) return; try { await onNavigate(previous); setHistory((current) => current.slice(0, -1)); setQuery(""); setNavigationError(""); } catch (error) { setNavigationError(error instanceof Error ? error.message : "Drive folder unavailable"); } };
  const openSelected = async () => {
    if (!selected || selected.directory) return;
    setOpenStatus("Opening…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/open-file", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ root: "Drive", path: selected.path || [...segments, selected.name].join("/") }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "File could not be opened"); setOpenStatus("Opened with the default desktop app");
    } catch (error) { setOpenStatus(error instanceof Error ? error.message : "File could not be opened"); }
  };
  const sendSelectedToPhone = async () => {
    if (!selected || selected.directory) return;
    if (fixture) { setOpenStatus("Transfer to phone started"); return; }
    const selectedPath = selected.path || [...segments, selected.name].join("/");
    setOpenStatus("Starting transfer…");
    try {
      const latestActivity = async () => { const response = await fetch(`/api/v1/file-activity?root=Drive&path=${encodeURIComponent(selectedPath)}`); if (!response.ok) return undefined; return ((await response.json()) as { items: ActivityItem[] }).items[0]; };
      const before = await latestActivity(); const beforeId = before?.id;
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/export-to-phone", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ root: "Drive", path: selectedPath }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Transfer could not start"); setOpenStatus(`Sending ${selected.name} to phone Drive…`);
      for (let attempt = 0; attempt < 120; attempt++) { await new Promise((resolve) => setTimeout(resolve, 250)); const latest = await latestActivity(); if (!latest || latest.id === beforeId) continue; setOpenStatus(latest.event === "verified" ? `${selected.name} was verified on the phone` : latest.event === "conflict" ? "A different file with the same name already exists on the phone" : latest.result || "Transfer failed; source retained"); return; }
      setOpenStatus("Transfer continues in Sync & Connections");
    } catch (error) { setOpenStatus(error instanceof Error ? error.message : "Transfer could not start"); }
  };
  useEffect(() => { const first = shownFiles.find((item) => !item.directory) ?? shownFiles[0]; setSelectedName(first?.path || first?.name || ""); }, [shownFiles]);
  useEffect(() => { setOpenStatus(""); setDetailTab("details"); }, [selectedName, path]);
  const showSection = async (next: string) => {
    if (!["Recent", "Favourites", "Tags"].includes(next)) { setSection(next); setQuery(""); return; }
    if (fixture) { setRecentFiles(next === "Recent" ? demoFiles.filter((item) => !item.directory) : []); setSection(next); setQuery(""); return; }
    try { await refreshLabels(); const response = await fetch(next === "Recent" ? "/api/v1/recent-files" : `/api/v1/labelled-files?root=Drive&filter=${next === "Favourites" ? "favorites" : "tags"}`); if (!response.ok) throw new Error(); const result = await response.json() as { items: DriveFile[] }; setRecentFiles(result.items); setSection(next); setQuery(""); setNavigationError(""); }
    catch { setNavigationError(`${next} unavailable`); }
  };

  return <section className={`files-shell ${section === "Settings" ? "settings-mode" : ""}`}>
    <header className="file-toolbar">
      <button aria-label="Back" disabled={section !== "Home" || !history.length} onClick={back} title="Previous folder"><ArrowLeft /></button><button aria-label="Up" disabled={section !== "Home" || !path} onClick={() => go(segments.slice(0, -1).join("/"))} title="Parent folder"><ArrowUp /></button>
      <div className="breadcrumbs">{section !== "Home" ? <strong>{section}</strong> : <><button onClick={() => path && go("")}>Drive</button>{segments.map((segment, index) => <span key={`${segment}-${index}`}>› <button onClick={() => index < segments.length - 1 && go(segments.slice(0, index + 1).join("/"))}><strong>{segment}</strong></button></span>)}</>}</div>
      {fileSection && <><label className="search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${section === "Home" ? segments.at(-1) || "Drive" : section}...`} /><kbd>/</kbd></label>
      <div className="view-buttons"><button className={!grid ? "selected" : ""} onClick={() => setGrid(false)} aria-label="List view"><ListBullets /></button><button className={grid ? "selected" : ""} onClick={() => setGrid(true)} aria-label="Grid view"><SquaresFour /></button><select aria-label="Sort files" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="modified">Newest modified</option><option value="size">Largest first</option></select></div></>}
      <details className="file-actions-menu" onToggle={(event) => { if (event.currentTarget.open) refreshMenuTemplates(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="File actions"><DotsThreeVertical /></summary><div onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}><button disabled={section !== "Home"} onClick={onNewFolder}><Folder />New folder</button>{menuTemplates.map((template) => <button key={template} disabled={section !== "Home"} onClick={() => onNewFile(template)}><File />{template}</button>)}{templateStatus && <small role="status">{templateStatus}</small>}<NewTag fixture={fixture} onSaved={() => void refreshLabels()} /><button onClick={onSyncDrive}><ArrowsClockwise />Sync Drive now</button></div></details>
    </header>

    <aside className="sidebar"><nav aria-label="Drive navigation">{fileNav.map(([label, Icon, supported]) => <button key={label} className={section === label ? "active" : ""} disabled={!supported} title={supported ? label : `${label} is not available yet`} onClick={() => showSection(label)}><Icon />{label}</button>)}</nav></aside>
    <div className="workspace">
      {fileSection ? <>
        {!grid && <div className="file-head"><span>Name <ArrowUp /></span><span>Size</span><span>Type</span><span>Date modified</span><span>Verified on</span><span aria-label="Actions" /></div>}
        <div className={grid ? "file-grid" : "file-list"}>{visible.map((file) => {
          const relative = file.path || [...segments, file.name].join("/");
          const labels = fileLabels[`${labelsRoot}/${relative}`] || { favorite: false, tags: [] };
          return <div className={selected === file ? "file-row selected" : "file-row"} key={relative}>
            <button className="name" onClick={() => setSelectedName(file.path || file.name)} onDoubleClick={() => file.directory && go(relative)}><FileIcon file={file} /><span>{file.name}{labels.favorite && <Star aria-label="Favorite" weight="fill" />}{labels.tags.length > 0 && <small className="file-tag-labels">{labels.tags.join(" · ")}</small>}</span></button><span>{formatSize(file.size)}</span><span>{file.directory ? "Folder" : `${file.type} document`}</span><span>{formatDate(file.modified)}</span><span className={verifiedOn ? "verified" : ""}>{verifiedOn ? <CheckCircle weight="fill" /> : <Clock />}{verifiedOn || "Not checked"}</span>
            {labelsReady ? <FileActions file={file} path={relative} labels={labels} tags={[...new Set([...registeredTags, ...Object.values(fileLabels).flatMap((value) => value.tags)])]} fixture={fixture} onChanged={async () => { await refreshLabels(); if (section !== "Home") await showSection(section); else await onNavigate(path); }} /> : <button disabled aria-label={`Actions unavailable for ${file.name}`}><DotsThreeVertical /></button>}
          </div>;
        })}{!visible.length && <p className="list-empty">No files in this Drive folder yet.</p>}</div>
        <footer className="count" role="status">{navigationError || `${visible.length} ${section === "Recent" ? "recent " : ""}items · ${state.deviceName}`}</footer>
      </> : section === "Settings" ? <div className="drive-settings">
        <header><Gear weight="duotone" /><div><h1>Drive settings</h1><p>Saved routes, readiness, and safe transfer previews.</p></div></header>
        <section><h2><Plus />Setup missing route</h2><RouteSetup state={state} fixture={fixture} onSaved={onRouteSaved} /></section>
        <section><h2><Folder />Managed routes</h2>{state.routes.length ? state.routes.map((route) => <article className="route-card" key={route.id}><div className="route-summary"><span><strong>{route.contentType} · {route.behavior || "Copy"}</strong><small>{route.destination || "Destination configured in Local Drive"} · Keep {route.keepPolicy || "Everything"}</small></span><b className={route.storagePresent ? "online" : "remembered"}>{route.storagePresent ? "Storage available" : "Storage not connected"}</b></div><RoutePreviewButton route={route} fixture={fixture} /></article>) : <p>No Drive or Photos route is configured yet.</p>}</section>
        <section><h2><Desktop />Known devices</h2><article><span><strong>{state.deviceName || "Laptop"}</strong><small>This device · catalog revision {state.configRevision}</small></span><b className="online">Online now</b></article>{state.devices.map((device) => <article key={device.id}><span><strong>{device.label}</strong><small>{device.kind || "Paired device"}</small></span><b className={deviceStatus(device) === "Online now" ? "online" : "remembered"}>{deviceStatus(device)}</b></article>)}</section>
        <section><h2><CheckCircle />Safety rules</h2><ul><li>Copy → Verify → Receipt before cleanup.</li><li>SHA-256 verifies complete file content.</li><li>Conflicts and external changes wait in Problems &amp; Fixes.</li></ul></section>
      </div> : <div className="empty-state"><WarningCircle /><h2>{section}</h2><p>Deleted items are in the system Trash. Restore them using the desktop file manager; no permanent-delete action is exposed here.</p><DesktopAction action="open-trash" fixture={fixture} /></div>}
    </div>
    <aside className="details" aria-label="Selected file details">{fileSection && selected && <>
      <FileIcon file={selected} large /><h2>{selected.name}</h2>
      <div className="detail-tabs"><button className={detailTab === "details" ? "active" : ""} onClick={() => setDetailTab("details")}>Details</button><button className={detailTab === "activity" ? "active" : ""} disabled={selected.directory} onClick={() => setDetailTab("activity")}>Activity</button></div>
      {detailTab === "activity" && !selected.directory ? <ActivityPanel root="Drive" path={selected.path || [...segments, selected.name].join("/")} fixture={fixture} /> : <><dl><dt>Type:</dt><dd>{selected.directory ? "Folder" : `${selected.type} document`}</dd><dt>Size:</dt><dd>{formatSize(selected.size)}</dd><dt>Modified:</dt><dd>{formatDate(selected.modified)}</dd></dl>
      <section><h3>Locations</h3><p><Desktop /><span><strong>{state.deviceName}</strong><small>Available</small></span><CheckCircle weight="fill" /></p><p><HardDrive /><span><strong>{verifiedOn || "Storage"}</strong><small>{verifiedOn ? "Verified" : "Not checked"}</small></span>{verifiedOn ? <CheckCircle weight="fill" /> : <Clock />}</p></section>
      <section><h3>Actions</h3><div className="actions"><button disabled={selected.directory} onClick={openSelected} title={selected.directory ? "Select a file to open" : "Open with the default desktop app"}><ArrowSquareOut /><span>Open</span></button><button disabled={selected.directory || !phoneReady} onClick={sendSelectedToPhone} title={phoneReady ? "Copy and verify in the phone Drive folder" : "Connect and unlock a phone in File transfer mode"}><ShareNetwork /><span>Send to phone</span></button></div><small>Rename, copy, move and tags are in the item's ⋮ menu.</small>{openStatus && <small role="status">{openStatus}</small>}</section></>}
    </>}</aside>
  </section>;
}

function PhotosView({ photos, root, verifiedOn, fixture, more, onLoadMore, onRefresh }: { photos: PhotoItem[]; root: string; verifiedOn: string; fixture: boolean; more: boolean; onLoadMore: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [labels, setLabels] = useState<Record<string, FileLabels>>({}), [tags, setTags] = useState<string[]>([]);
  const [labelsReady, setLabelsReady] = useState(fixture);
  const [selectedTag, setSelectedTag] = useState("");
  const refreshLabels = async () => {
    if (fixture) return;
    const response = await fetch("/api/v1/file-labels"); if (!response.ok) throw new Error("Photo labels unavailable");
    const data = await response.json() as { items: Record<string, FileLabels>; tags?: string[] };
    setLabels(data.items); setTags(data.tags || []); setLabelsReady(true);
  };
  useEffect(() => { void refreshLabels().catch((error: Error) => setLoadStatus(error.message)); }, [fixture]);
  const [sort, setSort] = useState("newest");
  const [loadStatus, setLoadStatus] = useState("");
  const [section, setSection] = useState("Timeline");
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [viewer, setViewer] = useState(false);
  const [screenshots, setScreenshots] = useState<PhotoItem[]>([]), [screenshotsRoot, setScreenshotsRoot] = useState("");
  const [screenshotsCursor, setScreenshotsCursor] = useState("");
  const loadScreenshots = async (after = "") => {
    if (fixture) { setScreenshots([]); setScreenshotsRoot("System Pictures / Screenshots"); return; }
    setLoadStatus("Loading…");
    try {
      const response = await fetch(`/api/v1/screenshots?after=${encodeURIComponent(after)}`); if (!response.ok) throw new Error("Screenshots unavailable");
      const page = await response.json() as PhotosResponse;
      setScreenshots((current) => after ? [...current, ...page.items] : page.items); setScreenshotsRoot(page.root); setScreenshotsCursor(page.nextCursor || ""); setLoadStatus("");
    } catch (error) { setLoadStatus(error instanceof Error ? error.message : "Screenshots unavailable"); }
  };
  useEffect(() => { if (collection === "Screenshots") void loadScreenshots(); }, [collection, fixture]);
  const sourceItems = useMemo(() => collection === "Screenshots" ? [...screenshots.map((item) => ({ ...item, source: "Screenshots" as const })), ...photos.filter(isScreenshot)] : photos, [photos, screenshots, collection]);
  const filtered = useMemo(() => {
    const items = sourceItems
      .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
      .filter((item) => !collection || collection === "Screenshots" || item.collection === collection)
      .filter((item) => section === "Photos" ? item.type === "Photo" : section === "Videos" ? item.type === "Video" : true)
      .filter((item) => section === "Favourites" ? labels[`${root}/${item.path}`]?.favorite : section === "Tags" ? (selectedTag ? labels[`${root}/${item.path}`]?.tags.includes(selectedTag) : !!labels[`${root}/${item.path}`]?.tags.length) : true)
      .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : sort === "oldest" ? a.captured.localeCompare(b.captured) : b.captured.localeCompare(a.captured));
    return items;
  }, [sourceItems, query, collection, section, sort, labels, root, selectedTag]);
  const selected = filtered.find((item) => mediaKey(item) === selectedPath);
  const groups = useMemo(() => groupPhotos(filtered, (item) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(item.captured))), [filtered]);
  const collections = useMemo(() => groupPhotos(filtered, (item) => isScreenshot(item) ? "Screenshots" : item.collection || "Unsorted"), [filtered]);
  const imageStyle = (item: PhotoItem) => fixture
    ? { backgroundImage: `url(${galleryMockup})`, backgroundSize: "600% 730%", backgroundPosition: item.demoCrop }
    : item.type === "Photo" ? { backgroundImage: `url(${mediaUrl(item)})` } : undefined;
  const refresh = async () => { if (collection === "Screenshots") await loadScreenshots(); else await onRefresh(); await refreshLabels(); };
  const navigate = (next: string) => { setSection(next); setCollection(""); setSelectedPath(""); setQuery(""); setViewer(false); };

  return <section className="photos-shell">
    <header className="photo-toolbar">
      {collection && <button onClick={() => navigate("Collections")} aria-label="Back to collections"><ArrowLeft /></button>}
      <div><h1>{collection || section}</h1><span>{filtered.length} items{selected ? " · 1 selected" : ""}</span></div>
      <label className="search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Photos & Videos..." /><kbd>/</kbd></label>
      <select className="photo-sort" aria-label="Sort photos" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option></select><button onClick={() => void refresh().catch((error: Error) => setLoadStatus(error.message))} aria-label="Refresh photos"><ArrowsClockwise /></button>
      <div className="photo-selection-toolbar" role="toolbar" aria-label="Photo actions">
        {selected ? <><span className="selected-photo-name" title={selected.name}>{selected.name}</span><button onClick={() => setViewer(true)}>View</button>{selected.source !== "Screenshots" && labelsReady ? <FileActions key={mediaKey(selected)} toolbar file={{...selected,directory:false}} path={selected.path} library="Photos" labels={labels[`${root}/${selected.path}`] || {favorite:false,tags:[]}} tags={tags} fixture={fixture} onChanged={refresh} /> : <span>Original folder · read-only here</span>}<button onClick={() => setSelectedPath("")}>Clear selection</button></> : <span>Select an image using its circle to show file actions. Click an image to view it.</span>}
      </div>
    </header>

    <aside className="photo-sidebar"><nav aria-label="Photos navigation">
      {photoNav.map(([label, Icon]) => <button key={label} className={section === label && !collection ? "active" : ""} onClick={() => navigate(label)}><Icon />{label}</button>)}
    </nav><p title={collection === "Screenshots" ? "Shown in place, not automatically imported or backed up" : root}>{collection === "Screenshots" ? screenshotsRoot : root || "No Photos root configured"}</p></aside>

    <div className="photo-content">
      {section === "Tags" && <label>Tag <select aria-label="Filter photo tag" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>}
      {loadStatus && <p role="status">{loadStatus}</p>}
      {(collection === "Screenshots" ? !!screenshotsCursor || more : more) && <div className="photo-page-status" role="status"><span>{sourceItems.length} loaded · Search covers loaded items.</span><button className="secondary" disabled={loadStatus === "Loading…"} onClick={async () => { setLoadStatus("Loading…"); try { if (collection === "Screenshots" && screenshotsCursor) await loadScreenshots(screenshotsCursor); else await onLoadMore(); setLoadStatus(""); } catch (error) { setLoadStatus(error instanceof Error ? error.message : "Loading failed"); } }}>Load more</button></div>}
      {section === "Trash" ? <section><h2>Photo Trash</h2><p>Deleted photos use the system Trash. Restore them there, then refresh Photos. This opens the shared system Trash, not a photos-only list.</p><DesktopAction action="open-trash" fixture={fixture} /></section> : section === "Collections" && !collection ? <div className="collection-grid"><button className="collection-card" onClick={() => { setCollection("Screenshots"); setSelectedPath(""); setQuery(""); }}><span className="screenshot-example"><Desktop size={48} /></span><strong>Screenshots</strong><small>Pictures folder + imported screenshots</small></button>{Array.from(collections).filter(([name]) => name !== "Screenshots").map(([name, items]) => <button className="collection-card" key={name} onClick={() => { setSection("Timeline"); setCollection(name); setQuery(""); setSelectedPath(""); }}><span className="photo-thumb" style={imageStyle(items[0])}>{items[0].type === "Video" && <PlayCircle weight="fill" />}</span><strong>{name}</strong><small>{items.length} items</small></button>)}</div>
      : filtered.length ? Array.from(collection ? new Map([[collection, filtered]]) : groups, ([label, items]) => <section className="photo-month" key={label}>{!collection && <header><h2>{label}</h2><span>{items.length} items</span></header>}<div className="photo-grid">{items.map((item) => <div className="photo-item" key={mediaKey(item)}><button className={`photo-tile ${selected && mediaKey(selected) === mediaKey(item) ? "selected" : ""}`} onClick={() => { setSelectedPath(mediaKey(item)); setViewer(true); }} aria-label={`View ${item.name}`}>{fixture ? <span className="photo-thumb" style={imageStyle(item)} /> : item.type === "Photo" ? <img className="photo-thumb" loading="lazy" src={mediaUrl(item)} alt={item.name} /> : <span className="photo-thumb"><PlayCircle weight="fill" /></span>}</button><button className="photo-select" aria-label={`Select ${item.name}`} aria-pressed={!!selected && mediaKey(selected) === mediaKey(item)} onClick={() => setSelectedPath(selected && mediaKey(selected) === mediaKey(item) ? "" : mediaKey(item))}><CheckCircle weight={selected && mediaKey(selected) === mediaKey(item) ? "fill" : "regular"} /></button></div>)}</div></section>)
      : <div className="photo-empty"><Images /><h2>No media here yet</h2><p>{root ? "Try another filter or add files to the Photos folder." : "Configure a Photos route to start the shared library."}</p></div>}
    </div>

    {viewer && selected && <PhotoViewer items={filtered} selected={selected} onSelect={(item) => setSelectedPath(mediaKey(item))} onClose={() => setViewer(false)} fixture={fixture} imageStyle={imageStyle} />}
  </section>;
}

function ImportDialog({ onClose, onPreviewComplete }: { onClose: () => void; onPreviewComplete: () => void }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState<"Drive" | "Photos">("Drive");
  const [status, setStatus] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [operation, setOperation] = useState<{ id: string; token: string } | null>(null);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", closeOnEscape);
    return () => removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const inspect = async () => {
    setPreview(null); setOperation(null); setResultMessage(""); setStatus("Hashing source and library…");
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")) { setStatus("Demo mode: open the live application to import real files."); return; }
    try {
      const sessionResponse = await fetch("/api/v1/session");
      if (!sessionResponse.ok) throw new Error("Local session unavailable");
      const { token } = await sessionResponse.json() as { token: string };
      const startResponse = await fetch("/api/v1/import-preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ source, target }) });
      const started = await startResponse.json() as { id?: string; error?: string };
      if (!startResponse.ok || !started.id) throw new Error(started.error || "Preview could not start");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const resultResponse = await fetch(`/api/v1/import-preview?id=${encodeURIComponent(started.id)}`);
        if (!resultResponse.ok) throw new Error("Preview result unavailable");
        const result = await resultResponse.json() as { state: string; preview?: ImportPreview };
        if (result.state === "complete") { setPreview(result.preview || null); setOperation({ id: started.id, token }); setStatus(""); onPreviewComplete(); return; }
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Preview failed"); }
  };

  const executeImport = async () => {
    if (!operation) return;
    setStatus("Copying, verifying, and recording receipts…"); setResultMessage("");
    try {
      const response = await fetch("/api/v1/import-execute", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": operation.token }, body: JSON.stringify({ id: operation.id }) });
      const started = await response.json() as { error?: string };
      if (!response.ok) throw new Error(started.error || "Import could not start");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const resultResponse = await fetch(`/api/v1/import-preview?id=${encodeURIComponent(operation.id)}`);
        const result = await resultResponse.json() as { state: string; result?: string };
        if (!resultResponse.ok) throw new Error("Import status unavailable");
        if (["imported", "failed", "attention"].includes(result.state)) {
          if (result.state === "failed") throw new Error(result.result || "Import failed safely");
          setResultMessage(result.state === "attention" ? "Safe files imported; new conflicts need review." : "Import complete. Every destination copy has a verified receipt; the source was kept.");
          setStatus(""); onPreviewComplete(); return;
        }
      }
    } catch (error) { setStatus(""); setResultMessage(error instanceof Error ? error.message : "Import failed safely"); }
  };

  const duplicateDecisions = preview?.duplicatesAccepted ? 0 : (preview?.duplicates || 0) + (preview?.destinationDuplicates || 0);
  const conflictDecisions = preview?.conflictsAccepted ? 0 : (preview?.conflicts || 0);
  const unsupportedDecisions = preview?.unsupportedAccepted ? 0 : (preview?.unsupported || 0);
  const decisions = duplicateDecisions + conflictDecisions + unsupportedDecisions + (preview?.unreadable || 0);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header><div><h1 id="import-title">Import existing folder</h1><p>Preview first. Import uses Copy → Verify → Receipt and keeps the source.</p></div><button onClick={onClose} aria-label="Close import dialog">×</button></header>
      <label>Source folder<input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="/path/to/Syncthing folder" /></label>
      <fieldset><legend>Import into</legend><label><input type="radio" checked={target === "Drive"} onChange={() => setTarget("Drive")} />Drive Files</label><label><input type="radio" checked={target === "Photos"} onChange={() => setTarget("Photos")} />Photos &amp; Videos</label></fieldset>
      <p className="browser-note">The browser preview accepts a local path. The packaged desktop app will replace this field with the native folder chooser.</p>
      <button className="primary" disabled={!source.trim() || !!status} onClick={inspect}>{status || "Preview import"}</button>
      {preview && <div className={`import-result ${preview.ok ? "ready" : "attention"}`}>
        <h2>{preview.ok ? "Preview complete" : "Preview could not finish"}</h2>
        {preview.ok ? <><div className="import-metrics"><span><strong>{preview.files}</strong>Total files</span><span><strong>{formatSize(preview.toCopy)}</strong>To copy</span><span><strong>{preview.identical}</strong>Already identical</span><span><strong>{decisions}</strong>Review findings</span></div><p>{decisions ? "Duplicates, conflicts, unsupported, and unreadable items stay untouched and must be resolved in Problems & Fixes before execution." : preview.conflictsAccepted ? "Keep both was accepted. Existing files stay untouched; incoming versions get a safe imported name and a verified receipt." : preview.duplicatesAccepted ? "Existing copies were accepted. They will be reverified and skipped; the remaining files use Copy → Verify → Receipt." : preview.unsupportedAccepted ? "Unsupported items will stay untouched in the source; regular files use Copy → Verify → Receipt." : "All items are ready for the verified Copy → Verify → Receipt path."}</p>{!decisions && operation && <button className="primary" disabled={!!status || !!resultMessage} onClick={executeImport}>{status || "Import and verify"}</button>}{resultMessage && <p role="status">{resultMessage}</p>}</> : <p>{preview.error}</p>}
      </div>}
    </section>
  </div>;
}

function NewFolderDialog({ parent, onClose, onCreated }: { parent: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", closeOnEscape); return () => removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const create = async () => {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")) { setStatus("Demo mode: no folder was created. Open the live application to create real folders."); return; }
    setStatus("Creating…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/create-folder", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ parent, name }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Folder could not be created");
      await onCreated(); onClose();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Folder could not be created"); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-title">
    <header><div><h1 id="folder-title">New folder</h1><p>Location: Drive{parent ? ` / ${parent}` : ""}</p></div><button onClick={onClose} aria-label="Close new folder dialog">×</button></header>
    <label>Folder name<input autoFocus value={name} onChange={(event) => { setName(event.target.value); setStatus(""); }} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) create(); }} /></label>
    {status && status !== "Creating…" && <p className="dialog-error" role="alert">{status}</p>}
    <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim() || status === "Creating…"} onClick={create}>{status === "Creating…" ? status : "Create folder"}</button></div>
  </section></div>;
}

function StorageOnboarding({ device, busy, error, onDecide, onLater }: { device: Device; busy: boolean; error: string; onDecide: (participate: boolean) => void; onLater: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="storage-onboarding" role="dialog" aria-modal="true" aria-labelledby="storage-onboarding-title">
    <header><HardDrive weight="fill" /><div><h1 id="storage-onboarding-title">New storage detected</h1><p>{device.label}</p></div></header>
    <dl><div><dt>Stable identity</dt><dd>{device.stableIdentity || "Not available"}</dd></div><div><dt>Mounted location</dt><dd>{device.root || "Waiting for mount"}</dd></div>{device.filesystemType && <div><dt>Filesystem</dt><dd>{device.filesystemType}</dd></div>}</dl>
    <h2>Do you want this storage to participate in Local Drive?</h2>
    <p>Yes adds it to the Files connection map so you can choose its folders and relationships. No hides it and Local Drive will not ask again; you can restore it from Hidden devices.</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onLater}>Not now</button><button className="secondary" disabled={busy} onClick={() => onDecide(false)}>No, hide it</button><button className="primary" disabled={busy} onClick={() => onDecide(true)}>{busy ? "Saving…" : "Yes, add to map"}</button></div>
  </section></div>;
}

function RelationshipWizard({ device, state, fixture, initialContent, onSaved, onClone, onClose }: { device: Device; state: ApiState; fixture: boolean; initialContent?: "Drive" | "Photos"; onSaved: (route?: Route) => Promise<void> | void; onClone: () => Promise<void>; onClose: () => void }) {
  const [content, setContent] = useState<"Drive" | "Photos">(initialContent || "Drive"), [scope, setScope] = useState<"Drive" | "Photos" | "Both">(initialContent || "Drive"), [step, setStep] = useState<"scope" | "route" | "more" | "clone">(initialContent ? "route" : "scope"), [round, setRound] = useState(0), [error, setError] = useState("");
  const laptop = state.storages.find((storage) => storage.id === "local")?.label || "Laptop";
  const photosMapExists = state.routes.some((route) => route.contentType === "Photos");
  const clone = async () => { setError(""); try { await onClone(); onClose(); } catch (problem) { setError(problem instanceof Error ? problem.message : "The Photos map could not be copied"); } };
  return <div className="modal-backdrop" role="presentation"><section className="relationship-wizard" role="dialog" aria-modal="true" aria-labelledby="relationship-title">
    <header><div><h1 id="relationship-title">Edit connection map</h1><p>{device.label} is now available as a storage node.</p></div><button onClick={onClose} aria-label="Close connection editor">×</button></header>
    <ConnectionMap state={state} contentType={content} />
    {step === "scope" && <div className="wizard-question"><h2>Connect {device.label} with {laptop}</h2><p>Only relationships the app can transfer safely today are shown.</p><div className="scope-choices"><button onClick={() => { setScope("Drive"); setContent("Drive"); setStep("route"); }}><Folder weight="duotone" /><strong>Drive</strong><small>Files only</small></button><button onClick={() => { setScope("Photos"); setContent("Photos"); setStep("route"); }}><Images weight="duotone" /><strong>Photos</strong><small>Photos &amp; videos only</small></button><button onClick={() => { setScope("Both"); setContent("Drive"); setStep("route"); }}><ShareNetwork weight="duotone" /><strong>Drive and Photos</strong><small>Configure both maps</small></button></div></div>}
    {step === "route" && <><h2>{device.label} ↔ {laptop} · {content}</h2><RouteSetup key={`${content}-${round}`} state={state} fixture={fixture} initialContentType={content} preferredStorageId={round === 0 ? device.id : ""} onSaved={onSaved} onCommitted={() => setStep("more")} /></>}
    {step === "more" && <div className="wizard-question"><h2>Add another {content} relationship?</h2><p>You can connect another available storage node now or finish this map.</p><div className="dialog-actions"><button className="secondary" onClick={() => { setRound((value) => value + 1); setStep("route"); }}>Yes, add another</button><button className="primary" onClick={() => { if (content !== "Drive" || scope !== "Both") return onClose(); if (photosMapExists) { setContent("Photos"); setRound(0); setStep("route"); } else setStep("clone"); }}>No, finish {content}</button></div></div>}
    {step === "clone" && <div className="wizard-question"><h2>Should files and photos use the same synchronization map?</h2><p>Yes creates a one-time Photos copy with the same devices, directions, and Keep policies. Future edits remain independent.</p>{error && <p className="dialog-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary" onClick={() => { setContent("Photos"); setRound(0); setStep("route"); }}>No, configure Photos</button><button className="primary" onClick={clone}>Yes, copy the map</button></div></div>}
  </section></div>;
}

export function App() {
  const params = new URLSearchParams(location.search), fixture = import.meta.env.DEV && params.has("fixture"), setupFixture = fixture && params.has("setup"), chargingFixture = fixture && params.has("charging"), unmountedFixture = fixture && params.has("unmounted"), newStorageFixture = fixture && params.has("newstorage");
  const [activeTab, setActiveTab] = useState<MainView>("sync");
  const [importOpen, setImportOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState<string | null>(null);
  const [driveSyncOpen, setDriveSyncOpen] = useState(false);
  const [state, setState] = useState<ApiState>(fixture ? (newStorageFixture ? { ...demoState, libraryRoot: "/home/teo/Local Drive", routes: demoState.routes.filter((route) => route.contentType === "Drive"), storages: [...demoState.storages, { id: "storage:EFFE-724A", label: "SAF", root: "/run/media/teo/SAF", present: true, connected: true }], firstSeenDevices: [{ id: "storage:EFFE-724A", stableIdentity: "filesystem:EFFE-724A", label: "SAF", category: "storage", kind: "removable", root: "/run/media/teo/SAF", filesystemType: "exfat", present: true }] } : chargingFixture ? { ...demoState, connectedDevices: [{ id: "usb-charge", label: "Phone", present: true, status: "Charging only", kind: "Phone", transports: ["usb"] }] } : setupFixture ? { ...demoState, routes: demoState.routes.filter((route) => route.contentType === "Drive") } : unmountedFixture ? { ...demoState, storages: demoState.storages.map((storage) => storage.id === "t7" ? { ...storage, present: false, connected: true, bytesTotal: undefined, bytesFree: undefined } : storage) } : demoState) : { deviceName: "", configRevision: 0, problems: 0, ready: false, error: "Loading local state", routes: [], storages: [], devices: [], catalog: { pendingFiles: 0, pendingBytes: 0, lastMetadataUpdate: "", activeTransfer: null } });
  const [files, setFiles] = useState<DriveFile[]>(fixture ? demoFiles : []);
  const [filePath, setFilePath] = useState("");
  const [verifiedOn, setVerifiedOn] = useState(fixture ? "T7" : "");
  const [photos, setPhotos] = useState<PhotoItem[]>(fixture ? demoPhotos : []);
  const [photosCursor, setPhotosCursor] = useState("");
  const loadMorePhotos = async () => {
    if (!photosCursor || fixture) return;
    const response = await fetch(`/api/v1/photos?after=${encodeURIComponent(photosCursor)}`);
    if (!response.ok) throw new Error("Photos unavailable; retry when the API is connected.");
    const page = await response.json() as PhotosResponse;
    setPhotos((current) => Array.from(new Map([...current, ...page.items].map((item) => [item.path, item])).values()));
    setPhotosCursor(page.nextCursor || "");
  };
  const [photosRoot, setPhotosRoot] = useState(fixture ? "Local Drive/Photos" : "");
  const [photosVerifiedOn, setPhotosVerifiedOn] = useState(fixture ? "T7" : "");
  const [problems, setProblems] = useState<ProblemsResponse>(fixture ? demoProblems : { total: 0, counts: {}, items: [], history: [] });
  const [checkedAt, setCheckedAt] = useState("just now");
  const [onboardingDeferredId, setOnboardingDeferredId] = useState("");
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState("");
  const [relationshipStorage, setRelationshipStorage] = useState<Device | null>(null);
  const [relationshipContent, setRelationshipContent] = useState<"Drive" | "Photos" | undefined>();
  const [connectionPickerContent, setConnectionPickerContent] = useState<"Drive" | "Photos" | undefined>();

  const checkConnections = async () => {
    if (fixture) return setCheckedAt("just now");
    try { await fetch("/api/v1/refresh-connections"); await new Promise((resolve) => setTimeout(resolve, 600)); } catch { /* state request below reports the failure */ }
    Promise.all([
      fetch("/api/v1/state").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ApiState>; }),
      fetch("/api/v1/problems").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ProblemsResponse>; }),
    ])
      .then(([nextState, nextProblems]) => {
        setState(nextState);
        setProblems(nextProblems);
        setCheckedAt(`at ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
      })
      .catch(() => setState((current) => ({ ...current, ready: false, error: "Local API unavailable" })));
  };

  const refreshProblems = () => {
    if (fixture) return;
    fetch("/api/v1/problems").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ProblemsResponse>; }).then((next) => { setProblems(next); setState((current) => ({ ...current, problems: next.total })); }).catch(() => setState((current) => ({ ...current, ready: false, error: "Local API unavailable" })));
  };

  const mountStorage = async (id: string) => {
    if (fixture) return;
    try {
      const session = await fetch("/api/v1/session");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/mount-storage", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Storage could not be mounted");
      window.setTimeout(checkConnections, 800);
    } catch (error) { setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Storage could not be mounted" })); }
  };

  const saveHubConfig = async (enabled: boolean, limitPercent: number) => {
    if (limitPercent < 1 || limitPercent > 95) throw new Error("Choose a limit from 1% to 95%");
    if (!fixture) {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/hub-config", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ enabled, limitPercent }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Hub settings could not be saved");
    }
    setState((current) => ({ ...current, hub: { enabled, limitPercent, pendingBytes: current.hub?.pendingBytes || 0, waitingFor: current.hub?.waitingFor || "" }, configRevision: current.configRevision + 1 }));
  };

  const updateRouteCard = async (route: Route, mode: "Copy" | "Move", keepPolicy: string, cache: boolean) => {
    if (!fixture) {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/update-route-card", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: route.id, mode, keepPolicy, cache }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Connection could not be saved");
      return routeSaved();
    }
    setState((current) => ({ ...current, routes: current.routes.map((item) => item.id === route.id ? { ...item, behavior: mode, keepPolicy, stagingMaxBytes: cache ? 1 : 0 } : item), configRevision: current.configRevision + 1 }));
  };

  const addConnection = (content: "Drive" | "Photos") => {
    setConnectionPickerContent(content);
  };

  const decideDeviceParticipation = async (device: Device, participate: boolean) => {
    setOnboardingBusy(true); setOnboardingError("");
    try {
      if (!fixture) {
        const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable");
        const { token } = await session.json() as { token: string };
        const response = await fetch("/api/v1/device-onboarding", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: device.id, participate }) });
        const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Device choice could not be saved");
      }
      setState((current) => ({ ...current, firstSeenDevices: (current.firstSeenDevices || []).filter((item) => item.id !== device.id), hiddenDevices: participate ? current.hiddenDevices : [...(current.hiddenDevices || []), device] }));
      if (participate) { setActiveTab("sync"); setRelationshipStorage(device); }
    } catch (error) { setOnboardingError(error instanceof Error ? error.message : "Device choice could not be saved"); }
    finally { setOnboardingBusy(false); }
  };

  const cloneFilesMap = async () => {
    if (fixture) {
      const photos = state.routes.filter((route) => route.contentType === "Drive").map((route) => ({ ...route, id: `fixture-photos-${route.id}`, contentType: "Photos", source: route.source?.replace(/\/Drive$/, "/Photos"), destination: route.destination?.replace(/\/Drive$/, "/Photos") }));
      setState((current) => ({ ...current, routes: [...current.routes, ...photos], configRevision: current.configRevision + 1 })); return;
    }
    const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
    const response = await fetch("/api/v1/clone-files-map", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: "{}" });
    const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "The Photos map could not be copied"); await routeSaved();
  };

  const navigateFiles = async (path: string) => {
    if (fixture) { setFilePath(path); setFiles(path ? [] : demoFiles); return; }
    const response = await fetch(`/api/v1/files?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error("Drive folder unavailable");
    const next = await response.json() as FilesResponse; setFiles(next.items); setFilePath(next.currentPath); setVerifiedOn(next.verifiedOn);
  };

  const routeSaved = async (route?: Route) => {
    if (fixture) { if (route) setState((current) => ({ ...current, routes: [...current.routes, route], configRevision: current.configRevision + 1 })); return; }
    const response = await fetch("/api/v1/state"); if (!response.ok) throw new Error("Saved route state unavailable"); setState(await response.json() as ApiState);
  };

  const applyProblemAction = async (id: string, action: ProblemAction) => {
    if (fixture) {
      setProblems((current) => {
        const selected = current.items.find((item) => item.id === id), count = selected?.itemCount || 0;
        if (action === "recheck_location") return { ...current, items: current.items.map((item) => item.id === id ? { ...item, state: "needs_device", details: { ...item.details, correctionStatus: "pending" } } : item) };
        const counts = { ...current.counts };
        if (action !== "save" && selected) {
          counts[selected.category] = Math.max(0, (counts[selected.category] || 0) - count);
          if (!counts[selected.category]) delete counts[selected.category];
        }
        return { ...current, counts, total: action !== "save" ? current.total - count : current.total, items: action !== "save" ? current.items.filter((item) => item.id !== id) : current.items.map((item) => item.id === id ? { ...item, state: "saved" } : item), history: [{ id: `fixture-${Date.now()}`, problemId: id, action, state: "applied_local", occurredAt: new Date().toISOString(), category: selected?.category || "", title: selected?.title || "" }, ...current.history] };
      });
      return;
    }
    const sessionResponse = await fetch("/api/v1/session"); if (!sessionResponse.ok) throw new Error("Local session unavailable");
    const { token } = await sessionResponse.json() as { token: string };
    const response = await fetch("/api/v1/problem-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id, action }) });
    const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Action failed");
    const next = await fetch("/api/v1/problems"); if (!next.ok) throw new Error("Problem history unavailable");
    const nextProblems = await next.json() as ProblemsResponse; setProblems(nextProblems); setState((current) => ({ ...current, problems: nextProblems.total }));
  };

  useEffect(() => {
    if (fixture) return;
    Promise.all([
      fetch("/api/v1/state").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ApiState>; }),
      fetch("/api/v1/files").then((response) => { if (!response.ok && response.status !== 404) throw new Error("API unavailable"); return response.json() as Promise<FilesResponse>; }),
      fetch("/api/v1/photos").then(async (response) => { if (!response.ok) throw new Error("API unavailable"); const page = await response.json() as PhotosResponse; setPhotosCursor(page.nextCursor || ""); return page; }),
      fetch("/api/v1/problems").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ProblemsResponse>; }),
    ]).then(([nextState, nextFiles, nextPhotos, nextProblems]) => { setState(nextState); setFiles(nextFiles.items); setFilePath(nextFiles.currentPath); setVerifiedOn(nextFiles.verifiedOn); setPhotos(nextPhotos.items); setPhotosRoot(nextPhotos.root); setPhotosVerifiedOn(nextPhotos.verifiedOn); setProblems(nextProblems); }).catch(() => setState((current) => ({ ...current, ready: false, error: "Local API unavailable" })));
  }, [fixture]);

  useEffect(() => {
    if (fixture) return;
    const timer = window.setInterval(() => fetch("/api/v1/state").then((response) => response.ok ? response.json() as Promise<ApiState> : Promise.reject()).then(setState).catch(() => setState((current) => ({ ...current, ready: false, error: "Local service unavailable — displayed data is last reported, not a live status" }))), 2000);
    return () => window.clearInterval(timer);
  }, [fixture]);

  const onboardingStorage = state.firstSeenDevices?.find((device) => device.category === "storage" && device.present);

  return <main className="app-shell">
    <header className="app-title"><img src={logo} alt="Local Drive" /><strong>Local Drive</strong>{fixture && <small className="demo-notice" role="status">Demo · simulated data and actions · <a href="/">Open live application</a></small>}</header>
    <TopTabs active={activeTab === "problems" ? "sync" : activeTab} onChange={setActiveTab} />
    {activeTab === "sync" && <SyncView state={state} checkedAt={checkedAt} onCheck={checkConnections} onMount={mountStorage} onHubSave={saveHubConfig} onRouteUpdate={updateRouteCard} onAddConnection={addConnection} onProblems={() => { refreshProblems(); setActiveTab("problems"); }} />}
    {activeTab === "files" && <FilesView files={files} path={filePath} state={state} verifiedOn={verifiedOn} fixture={fixture} onNavigate={navigateFiles} onRouteSaved={routeSaved} onNewFolder={() => setFolderOpen(true)} onSyncDrive={() => setDriveSyncOpen(true)} onNewFile={setTemplatesOpen} />}
    {activeTab === "photos" && <PhotosView photos={photos} root={photosRoot} verifiedOn={photosVerifiedOn} fixture={fixture} more={!!photosCursor} onLoadMore={loadMorePhotos} onRefresh={async () => { if (fixture) return; const response = await fetch("/api/v1/photos"); if (!response.ok) throw new Error("Photos unavailable"); const page = await response.json() as PhotosResponse; setPhotos(page.items); setPhotosRoot(page.root); setPhotosCursor(page.nextCursor || ""); }} />}
    {activeTab === "new" && <NewView onImport={() => setImportOpen(true)} />}
    {driveSyncOpen && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") setDriveSyncOpen(false); }}><section className="templates-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-sync-title"><button autoFocus className="secondary" onClick={() => setDriveSyncOpen(false)}>Close</button><h1 id="drive-sync-title">Sync Drive now</h1><p>Preview and confirm each Drive connection. Photos are not included. Closing this window does not cancel a running transfer.</p>{state.routes.filter((route) => route.contentType === "Drive").map((route) => <section key={route.id}><h2>{state.storages.find((storage) => storage.id === route.storageId)?.label || "Storage"}</h2><RoutePreviewButton route={route} fixture={fixture} /></section>)}{!state.routes.some((route) => route.contentType === "Drive") && <p>No Drive connection is configured. Add one in Sync &amp; Connections.</p>}</section></div>}
    {templatesOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplatesOpen(null); }} onKeyDown={(event) => { if (event.key === "Escape") setTemplatesOpen(null); }}><section className="templates-dialog" role="dialog" aria-modal="true" aria-label="New file from template"><button autoFocus className="secondary" onClick={() => { setTemplatesOpen(null); navigateFiles(filePath); }}>Close templates</button><TemplateView lastDrivePath={filePath} fixture={fixture} initialTemplate={templatesOpen} /></section></div>}
    {activeTab === "problems" && <ProblemsView problems={problems} onBack={() => setActiveTab("sync")} onAction={applyProblemAction} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onPreviewComplete={refreshProblems} />}
    {folderOpen && <NewFolderDialog parent={filePath} onClose={() => setFolderOpen(false)} onCreated={() => navigateFiles(filePath)} />}
    {onboardingStorage && onboardingDeferredId !== onboardingStorage.id && <StorageOnboarding device={onboardingStorage} busy={onboardingBusy} error={onboardingError} onDecide={(participate) => decideDeviceParticipation(onboardingStorage, participate)} onLater={() => setOnboardingDeferredId(onboardingStorage.id)} />}
    {connectionPickerContent && <DevicePicker state={state} content={connectionPickerContent} onClose={() => setConnectionPickerContent(undefined)} onChoose={(device) => { setRelationshipContent(connectionPickerContent); setRelationshipStorage(device); setConnectionPickerContent(undefined); }} />}
    {relationshipStorage && <RelationshipWizard device={relationshipStorage} state={state} fixture={fixture} initialContent={relationshipContent} onSaved={routeSaved} onClone={cloneFilesMap} onClose={() => { setRelationshipStorage(null); setRelationshipContent(undefined); }} />}
  </main>;
}
