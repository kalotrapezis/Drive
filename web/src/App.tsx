import { BackendActivity, WirelessSettings, type LiveOperation, type WirelessStatus } from "./BackendActivity";
import { SyncSchedules, type SyncSchedule } from "./SyncSchedules";
import { useEffect, useMemo, useRef, useState } from "react";
import { Background, BaseEdge, Controls, EdgeLabelRenderer, getStraightPath, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowSquareOut, ArrowUp, ArrowsClockwise, CalendarBlank, CaretDown,
  CaretRight, CheckCircle, Circle, Clock, Copy, Cpu, Database, Desktop, DeviceMobile,
  DotsThreeVertical, File, FilePdf, FileXls, Folder, Gear, HardDrive, HardDrives, House, Laptop, DesktopTower,
  ImageSquare, Images, Info, ListBullets, MagnifyingGlass, PauseCircle, PlayCircle, Plus, ShareNetwork,
  SlidersHorizontal, SquaresFour, Star, StopCircle, Tag, Trash, Video, WarningCircle, Wrench,
} from "@phosphor-icons/react";
import logo from "../../Assets/Icons/Drive.png";
import { storageTotals } from "./storageTotals";
import { routeMode, routeUnavailable } from "./routeAvailability";
import { connectionNotifications } from "./connectionNotifications";
import { matchesDriveTag } from "./driveTagFilter";
import { isScreenshot } from "./photoCollections";
import { BulkFileActions, FileActions, type FileLabels, type TagColors } from "./FileActions";
import { PhotoViewer, mediaKey, mediaUrl, type GalleryPhoto } from "./PhotoViewer";
import { NewTag } from "./NewTag";
import { QrScanner } from "./QrScanner";
import { DesktopAction } from "./DesktopAction";
import { PhotoExport } from "./PhotoExport";

const galleryMockup = import.meta.env.DEV ? "/@fs/home/teo/Έγγραφα/Claude/Coding/Drive/design/mockups/gallery-timeline.png" : "";

type DriveFile = { name: string; path?: string; directory: boolean; size: number; modified: string; type: string };
type Transfer = { state: string; bytesTotal: number; bytesDone: number; updatedAt: string; destination: string };
type Storage = { id: string; identity?: string; label: string; root?: string; present?: boolean; connected?: boolean; mediaType?: string; bytesTotal?: number; bytesFree?: number; icon?: string };
type Device = { id: string; stableIdentity?: string; label: string; category?: "device" | "storage"; root?: string; filesystemType?: string; present?: boolean; connected?: boolean; status?: string; lastSeen?: string; kind?: string; mediaType?: string; transports?: string[]; phoneRoot?: string; icon?: string };
type Route = { id: string; contentType: string; source?: string; storageId?: string; storagePresent: boolean; jobState?: string; destination?: string; behavior?: string; keepPolicy?: string; stagingMaxBytes?: number; stagingRoot?: string; cacheLimitPercent?: number };
type ApiState = {
  operations?: LiveOperation[];
  wireless?: WirelessStatus;
  incomingConnections?: { routeId: string; contentType: string; receiverKind: string; transport: string; cacheSupported: boolean; intermediateDeviceId: string; destinationStorageId: string; cacheEnabled: boolean; limitPercent: number }[];
  schedules?: SyncSchedule[];
  scheduleError?: string;
  capabilities?: { scanner: boolean; imageEditor: boolean };
  ready: boolean;
  deviceName: string;
  localDeviceIcon?: string;
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
  cacheStatus?: { routeId: string; usedPercent: number; limitPercent: number; message: string; blocked: boolean }[];
  hub?: { enabled: boolean; limitPercent: number; pendingBytes: number; waitingFor: string };
};
type FilesResponse = { root: string; currentPath: string; verifiedOn: string; items: DriveFile[]; truncated: boolean };
type PhotoItem = GalleryPhoto;
type PhotosResponse = { root: string; verifiedOn: string; items: PhotoItem[]; collections?: string[]; truncated: boolean; nextCursor?: string };
type UsageGroup = { available: boolean; files: number; bytes: number; complete: boolean; categories: Record<string, { files: number; bytes: number }> };
type LibraryUsage = { drive: UsageGroup; photos: UsageGroup };
type PhonePreview = { previewId: string; root: "Drive" | "DCIM"; phoneId: string; phoneLabel: string; routeId: string; toLaptop: boolean; destination: string; destinationRoot: string; summary: string; preview: ImportPreview };
type ActivityItem = { id: string; event: string; occurredAt: string; result: string; sourcePath: string; destinationPath: string };
type RouteHistoryItem = { id: string; event: string; occurredAt: string; result: string; source: string; destination: string };
type ImportPreview = { ok: boolean; error: string; files: number; bytes: number; toCopy: number; identical: number; duplicates: number; destinationDuplicates: number; conflicts: number; unsupported: number; unreadable: number; duplicatePaths: string[]; conflictPaths: string[]; unsupportedPaths: string[]; duplicatesAccepted?: boolean; conflictsAccepted?: boolean; unsupportedAccepted?: boolean };
type ProblemItem = { id: string; category: string; title: string; summary: string; details: { source?: string; root?: string; target?: string; destination?: string; paths?: string[]; path?: string; deviceStableId?: string; expectedSize?: number; expectedSha256?: string; correctionStatus?: string; correctionError?: string; added?: number; changed?: number; missing?: number }; itemCount: number; bytes: number; state: string; updatedAt: string; source: string };
type ProblemAction = "save" | "dismiss" | "accept_existing" | "keep_both" | "skip_unsupported" | "recheck_location";
type ResolutionItem = { id: string; problemId: string; action: ProblemAction; state: string; occurredAt: string; category: string; title: string };
type ProblemsResponse = { total: number; counts: Record<string, number>; items: ProblemItem[]; history: ResolutionItem[] };
type MainTab = "sync" | "files" | "photos" | "new" | "settings";
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
  schedules: [{ id: "demo-schedule", routeId: "drive", phoneId: "", start: "2026-09-04T10:00", timeZone: "Europe/Athens", repeat: "weekly", state: "pending", phase: "route", message: "Scheduled time passed. Connect T7 and press Start to finish the pending transfer.", nextRun: "2026-09-04T07:00:00Z" }],
  incomingConnections: [{ routeId: "drive", contentType: "Drive", receiverKind: "computer", transport: "mtp", cacheSupported: true, intermediateDeviceId: "local", destinationStorageId: "t7", cacheEnabled: false, limitPercent: 80 }, { routeId: "photos", contentType: "Photos", receiverKind: "computer", transport: "mtp", cacheSupported: true, intermediateDeviceId: "local", destinationStorageId: "t7", cacheEnabled: false, limitPercent: 80 }],
  wireless: { available: true, listening: false, configured: true, status: "Stopped" },
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

const emptyUsage: LibraryUsage = { drive: { available: false, files: 0, bytes: 0, complete: true, categories: {} }, photos: { available: false, files: 0, bytes: 0, complete: true, categories: {} } };
const demoUsage: LibraryUsage = { drive: { available: true, files: 6, bytes: 1_706_272, complete: true, categories: { Documents: { files: 6, bytes: 1_706_272 } } }, photos: { available: true, files: 10, bytes: 46_800_000, complete: true, categories: { Photos: { files: 9, bytes: 41_760_000 }, Videos: { files: 1, bytes: 5_040_000 } } } };

const fileNav = [["Home", House, true], ["Recent", Clock, true], ["Favourites", Star, true], ["Trash", Trash, true], ["Tags", Tag, true]] as const;
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

function DeviceIcon({ device }: { device: Device }) {
  const kind = (device.icon || `${device.label || ""} ${device.kind || ""} ${device.mediaType || ""}`).toLowerCase();
  if (kind.includes("ssd")) return <HardDrives weight="duotone" />;
  if (device.category === "storage" || kind.includes("storage") || kind.includes("hdd") || kind.includes("hard")) return <HardDrive weight="duotone" />;
  if (kind.includes("phone") || kind.includes("mobile") || kind.includes("tablet")) return <DeviceMobile weight="duotone" />;
  if (kind.includes("server")) return <Database weight="duotone" />;
  if (kind.includes("laptop")) return <Laptop weight="duotone" />;
  if (kind.includes("desktop") || kind === "pc") return <DesktopTower weight="duotone" />;
  return <Desktop weight="duotone" />;
}

const deviceIconChoices = ["", "Laptop", "PC", "Server", "Phone", "HD", "SSD"] as const;
function DeviceIconPicker({ device, disabled, onChoose }: { device: Device; disabled: boolean; onChoose: (icon: string) => void }) {
  return <details className="device-icon-picker"><summary>Icon: {device.icon || "Automatic"}</summary><div role="group" aria-label={`Choose icon for ${device.label}`}>{deviceIconChoices.map((icon) => { const selected = (device.icon || "") === icon; return <button key={icon || "automatic"} type="button" className={selected ? "active" : ""} aria-pressed={selected} disabled={disabled} onClick={() => onChoose(icon)}><DeviceIcon device={{ ...device, icon }} /><span>{icon || "Automatic"}</span></button>; })}</div></details>;
}

function LibraryUsageCard({ usage, onRefresh }: { usage: LibraryUsage; onRefresh: () => Promise<void> }) {
  const total = usage.drive.bytes + usage.photos.bytes;
  const groups = [["Drive", usage.drive, Folder], ["Photos & videos", usage.photos, Images]] as const;
  return <article className="sync-card library-usage-card"><h2><SquaresFour />Local Drive usage<button className="device-refresh" aria-label="Refresh library usage" title="Scan the managed library folders now" onClick={() => void onRefresh()}><ArrowsClockwise /></button></h2>
    <p><strong>{formatSize(total)} in managed folders</strong> · real local files, not total disk capacity or duplicate copies on other devices.</p>
    {groups.map(([label, group, Icon]) => { const percent = total ? Math.round(group.bytes * 100 / total) : 0; return <section className="usage-group" key={label}><header><Icon /><strong>{label}</strong><span>{formatSize(group.bytes)} · {group.files.toLocaleString("en-GB")} files · {percent}%</span></header><progress value={percent} max="100" aria-label={`${label}: ${percent}% of Local Drive data`} /><div className="usage-categories">{Object.entries(group.categories).sort((a, b) => b[1].bytes - a[1].bytes).map(([name, value]) => <span key={name}><b>{name}</b>{formatSize(value.bytes)} · {value.files} · {group.bytes ? Math.round(value.bytes * 100 / group.bytes) : 0}%</span>)}</div>{!group.available && <small>Folder is not configured.</small>}{!group.complete && <small>Showing the first 100,000 files; the total is incomplete.</small>}</section>; })}
  </article>;
}

function ConnectionNotifications({ state, onSettings, onSetupStorage }: { state: ApiState; onSettings: () => void; onSetupStorage: (id: string) => void }) {
  const notices = connectionNotifications(state);
  return <>{notices.map((notice) => <p className={`connection-notice ${notice.level}`} role={notice.level === "warning" ? "alert" : "status"} key={notice.id}>{notice.level === "success" ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}{notice.message}<button className="secondary" onClick={() => notice.action === "setup" && notice.storageId ? onSetupStorage(notice.storageId) : onSettings()}>{notice.actionLabel}</button></p>)}</>;
}

type ConnectionEdge = Edge<{ details: string }>;
type ConnectionNodeData = { label: string; handle: "source" | "target" };

function ConnectionNode({ data }: NodeProps) {
  const node = data as ConnectionNodeData;
  return <div className="connection-map-node">{node.label.split("\n").map((line) => <div key={line}>{line}</div>)}<Handle type={node.handle} position={node.handle === "source" ? Position.Right : Position.Left} isConnectable={false} /></div>;
}

function ConnectionEdgeInfo({ sourceX, sourceY, targetX, targetY, markerEnd, style, data }: EdgeProps<ConnectionEdge>) {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const [open, setOpen] = useState(false);
  const details = data?.details || "Manual connection";
  return <><BaseEdge path={path} markerEnd={markerEnd} style={style} /><EdgeLabelRenderer><div className="connection-edge-info nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}><button type="button" aria-label="Show connection details" aria-expanded={open} onClick={() => setOpen(!open)}><Info weight="bold" /></button>{open && <div role="status"><strong>Connection</strong><span>{details}</span></div>}</div></EdgeLabelRenderer></>;
}

const connectionEdgeTypes = { connection: ConnectionEdgeInfo };
const connectionNodeTypes = { connection: ConnectionNode };

function scheduleSummary(schedule?: SyncSchedule) {
  if (!schedule) return "Manual · start after preview";
  const repeat = { once: "Once", daily: "Every day", weekly: "Every week", monthly: "Every month" }[schedule.repeat] || schedule.repeat;
  return `${repeat} · ${formatDate(schedule.start)} · ${schedule.timeZone}${schedule.state === "paused" ? " · paused" : ""}`;
}

function ConnectionMap({ state, contentType, pendingDevice }: { state: ApiState; contentType?: "Drive" | "Photos"; pendingDevice?: Device }) {
  const routes = state.routes.filter((route) => !contentType || route.contentType === contentType);
  const storageIds = new Set(routes.map((route) => route.storageId)); if (pendingDevice) storageIds.add(pendingDevice.id);
  const storages = Array.from(storageIds).map((id) => pendingDevice && pendingDevice.id === id ? pendingDevice : state.storages.find((storage) => storage.id === id) || { id, label: "Unavailable storage", present: false, connected: false });
  const nodeStyle = { border: "1px solid #9eb4b8", borderRadius: 10, background: "#fff", color: "#28383e", width: 155, padding: 10, boxShadow: "0 2px 6px rgb(23 38 43 / 9%)", whiteSpace: "pre-line" as const };
  const nodes: Node[] = [
    { id: "local", type: "connection", position: { x: 10, y: Math.max(50, (storages.length - 1) * 42) }, data: { label: `${state.deviceName || "Laptop"}\nLocal catalog`, handle: "source" }, style: { ...nodeStyle, border: "2px solid #008b8b", background: "#edf7f7" } },
    ...storages.map((storage, index) => ({ id: `storage-${storage.id}`, type: "connection", position: { x: 505, y: 28 + index * 84 }, data: { label: `${storage.label}\n${storage.present ? "Available" : storage.connected ? "Connected · mount required" : "Last reported"}`, handle: "target" }, style: { ...nodeStyle, borderColor: storage.present ? "#7bc28a" : storage.connected ? "#d3b77f" : "#c8ced0" } })),
  ];
  const edges: ConnectionEdge[] = [
    ...storages.map((storage) => {
      const mapped = routes.filter((route) => route.storageId === storage.id);
      const details = mapped.length ? mapped.map((route) => `${route.contentType} · ${routeMode(route)} · ${scheduleSummary(state.schedules?.find((schedule) => schedule.routeId === route.id))}`).join("\n") : `New ${contentType || "Drive + Photos"} connection · not scheduled`;
      const color = storage.present ? "#008b8b" : "#9aa5a8";
      return { id: `local-storage-${storage.id}`, type: "connection", source: "local", target: `storage-${storage.id}`, markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24, color }, style: { stroke: color, strokeWidth: 2.25 }, data: { details } };
    }),
  ];
  return <div className="connection-map" aria-label="Device and storage relationship map"><ReactFlow nodes={nodes} edges={edges} nodeTypes={connectionNodeTypes} edgeTypes={connectionEdgeTypes} fitView fitViewOptions={{ padding: 0.2 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} minZoom={0.55} maxZoom={1.5}><Background gap={18} size={1} color="#dce3e4" /><Controls showInteractive={false} /></ReactFlow></div>;
}

function FullMapDialog({ state, onClose }: { state: ApiState; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="full-map-dialog" role="dialog" aria-modal="true" aria-labelledby="full-map-title"><header><div><h1 id="full-map-title">Connections overview</h1><p>Read-only flowchart generated from the connection cards.</p></div><button onClick={onClose} aria-label="Close full map">×</button></header><ConnectionMap state={state} /></section></div>;
}

function DevicePicker({ state, content, onChoose, onClose }: { state: ApiState; content: "Drive" | "Photos"; onChoose: (device: Device) => void; onClose: () => void }) {
  const available = state.storages.filter((storage) => storage.id !== "local" && !state.routes.some((route) => route.contentType === content && route.storageId === storage.id));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="device-picker" role="dialog" aria-modal="true" aria-labelledby="device-picker-title"><header><div><h1 id="device-picker-title">Add {content} connection</h1><p>{state.deviceName || "Laptop"} is the first device. Choose the destination storage.</p></div><button onClick={onClose} aria-label="Close device picker">×</button></header><div className="device-picker-list">{available.map((storage) => <button key={storage.id} disabled={!storage.present} title={storage.present ? `Use ${storage.label}` : "Connect and mount this storage first"} onClick={() => onChoose({ ...storage, category: "storage", kind: "Storage" })}><DeviceIcon device={{...storage, category:"storage", kind:"Storage"}} /><span><strong>{storage.label}</strong><small>{storage.mediaType || "Storage"} · {storage.present ? "Available now" : storage.connected ? "Mount required" : "Connect storage first"}</small></span><ArrowRight /></button>)}</div>{!available.length && <p>No unused storage is available for another {content} connection.</p>}</section></div>;
}

function ConnectionCards({ state, fixture, onUpdate, onAdd, onOpenMap, onClone, onRemove }: { state: ApiState; fixture: boolean; onUpdate: (route: Route, mode: "Copy" | "Move", keepPolicy: string, cache: boolean, cacheLimitPercent?: number) => Promise<void>; onAdd: (content: "Drive" | "Photos") => void; onOpenMap: () => void; onClone: () => Promise<void>; onRemove: (route: Route) => void }) {
  const [status, setStatus] = useState("");
  const storageName = (route: Route) => state.storages.find((storage) => storage.id === route.storageId)?.label || "Storage";
  const change = async (route: Route, mode: "Copy" | "Move", keep: string, cache: boolean) => { setStatus("Saving connection…"); try { await onUpdate(route, mode, keep, cache); setStatus("Connection saved"); } catch (error) { setStatus(error instanceof Error ? error.message : "Connection could not be saved"); } };
  return <div className="connection-editor"><div className="connection-editor-toolbar"><span>Each library keeps its own connection rules.</span><button className="secondary" onClick={onOpenMap}><ShareNetwork />Open full map</button></div><div className="connection-library-lists">{(["Drive", "Photos"] as const).map((content) => { const routes = state.routes.filter((route) => route.contentType === content); const Icon = content === "Drive" ? Folder : Images; return <section className="connection-library-list" key={content}><header><h3><Icon />{content === "Drive" ? "Drive Files" : "Photos & Videos"} connections</h3>{content === "Photos" && !routes.length && state.routes.some((route) => route.contentType === "Drive") && <button className="secondary" disabled={fixture} onClick={() => void onClone()}>Use Drive connections</button>}</header><div className="connection-cards">{routes.map((route, index) => { const mode = routeMode(route), cache = !!route.stagingMaxBytes, keep = route.keepPolicy || (mode === "Move" ? "Nothing" : "Everything"), storage = state.storages.find((item) => item.id === route.storageId); return <article className="connection-card" key={route.id}><small>{content} · Connection {index + 1}</small><div className="connection-device"><DeviceIcon device={{id:"local",label:state.deviceName || "Laptop",kind:"Laptop",icon:state.localDeviceIcon}} /><strong title={state.deviceName}>{state.deviceName || "Laptop"}</strong><span>Laptop</span></div><div className="connection-properties"><button disabled title="Only computer → storage is supported; reverse and two-way sync are unavailable"><ArrowRight />Computer → storage</button><label className="connection-mode"><Copy /><select aria-label={`${content} transfer mode ${index + 1}`} value={mode} disabled={status === "Saving connection…"} onChange={(event) => change(route, event.target.value as "Copy" | "Move", event.target.value === "Move" ? "Nothing" : "Everything", cache)}><option value="Copy">Copy</option><option value="Move">Move · verified, then Trash</option></select></label><label className="connection-mode"><CalendarBlank /><select aria-label={`${content} source retention ${index + 1}`} value={keep} disabled={status === "Saving connection…"} onChange={(event) => change(route, event.target.value === "Everything" ? "Copy" : "Move", event.target.value, cache)}><option value="Everything">Keep all originals</option><option value="Nothing">Keep none after confirmation</option><option value="Last day">Keep last day</option><option value="Last week">Keep last week</option><option value="Last month">Keep last month</option><option value="Last year">Keep last year</option></select></label>{(mode === "Move" || keep !== "Everything") && <small className="connection-hint">Use Copy to keep all originals.</small>}</div><div className="connection-device"><DeviceIcon device={{id:storage?.id || "storage",label:storageName(route),category:"storage",kind:"Storage",mediaType:storage?.mediaType,icon:storage?.icon}} /><strong title={storageName(route)}>{storageName(route)}</strong><span>{storage?.mediaType || "Storage"} · {route.storagePresent ? "Available" : "Offline"}</span></div><details><summary>Advanced · folders</summary><p><b>Source:</b> {route.source}</p><p><b>Destination:</b> {route.destination}</p><p><b>ID:</b> {route.id}</p></details><RoutePreviewButton key={`${route.id}-${route.keepPolicy}-${route.stagingMaxBytes}`} route={route} fixture={fixture} /><button className="secondary route-remove" onClick={() => onRemove(route)}>Remove connection</button></article>; })}<button className="add-connection-card" onClick={() => onAdd(content)}><Plus /><strong>New connection</strong><span>Choose the other device</span></button></div></section>; })}</div>{status && <small className="connection-status" role="status">{status}</small>}</div>;
}

function CacheAdvanced({ route, cacheStatus, onUpdate }: { route: Route; cacheStatus?: NonNullable<ApiState["cacheStatus"]>[number]; onUpdate: Parameters<typeof ConnectionCards>[0]["onUpdate"] }) {
  const [limit, setLimit] = useState(String(route.cacheLimitPercent ?? 80)), [status, setStatus] = useState("");
  useEffect(() => setLimit(String(route.cacheLimitPercent ?? 80)), [route.cacheLimitPercent]);
  return <><button className="secondary" disabled={status === "Saving…"} aria-pressed={!!route.stagingMaxBytes} onClick={async () => { setStatus("Saving…"); try { await onUpdate(route, routeMode(route), route.keepPolicy || "Everything", !route.stagingMaxBytes); setStatus("Cache saved"); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save cache"); } }}><Cpu />Cache {route.stagingMaxBytes ? "on" : "off"}</button><details className="cache-advanced"><summary>Advanced · cache limit</summary>
    <form onSubmit={async (event) => { event.preventDefault(); setStatus("Saving…"); try { await onUpdate(route, routeMode(route), route.keepPolicy || "Everything", !!route.stagingMaxBytes, Number(limit)); setStatus("Cache limit saved"); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save limit"); } }}>
      <label htmlFor={`cache-limit-${route.id}`}>Cache disk limit (%)</label>
      <div className="cache-limit-row"><input id={`cache-limit-${route.id}`} type="number" min="1" max="95" step="1" required value={limit} onChange={(event) => setLimit(event.target.value)} /><button className="secondary" disabled={status === "Saving…"}>Save limit</button></div>
      <small>Default: 80% of the whole disk, including other files. At the limit, new intake pauses and a notification appears. Existing files stay safe.</small>
      <small>Cache uses this connection’s source folder on this computer. Reconnect the destination and use Preview route to forward files. Turning Cache off keeps existing files.</small>
      {cacheStatus && <small role={cacheStatus.blocked ? "alert" : "status"}>Disk used: {cacheStatus.usedPercent.toFixed(1)}%. {cacheStatus.message}</small>}
    </form><p><b>Source:</b> {route.source}</p><p><b>Destination:</b> {route.destination}</p><p><b>ID:</b> {route.id}</p>
  </details>{status && <small role="status">{status}</small>}</>;
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
    <button className={active === "settings" ? "active" : ""} onClick={() => onChange("settings")}><Gear />Settings</button>
  </nav>;
}

function NewView({ onImport, capabilities }: { onImport: () => void; capabilities?: ApiState["capabilities"] }) {
  return <section className="new-view"><header><h1>New</h1><p>Scan documents, organise content, or import and export your library.</p></header><div className="new-task-grid">
    <article><FilePdf size={36} /><h2>New scan</h2><p>Use the desktop document scanner. Save the resulting PDF or image inside Drive, or import it afterwards.</p><DesktopAction action="scan" available={!!capabilities?.scanner} fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} />{!capabilities?.scanner && <p>Unavailable: no supported scanner application detected, or local service not connected.</p>}</article>
    <article><ImageSquare size={36} /><h2>QR scanner</h2><p>Read a QR code using the laptop camera or an image. No automatic link opening.</p><QrScanner /></article>
    <article><Tag size={36} /><h2>New tag</h2><p>Create a tag for files, photos and videos on this laptop.</p><NewTag fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} /></article>
    <article><ArrowDown size={36} /><h2>Import</h2><p>Bring an existing folder into Drive or Photos. Preview and verify before copying; originals stay intact.</p><button className="primary" onClick={onImport}>Import existing folder</button></article>
    <article><ArrowSquareOut size={36} /><h2>Export Photos &amp; Videos</h2><p>Create a compressed, verified media archive on selected storage.</p><PhotoExport fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} library="Photos" /></article>
    <article><ArrowSquareOut size={36} /><h2>Export Drive Files</h2><p>Create a separate compressed, verified archive of local Drive files.</p><PhotoExport fixture={import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")} library="Drive" /></article>
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

function RouteSetup({ state, fixture, onSaved, scope = "Drive", preferredStorageId = "", onCommitted }: { state: ApiState; fixture: boolean; onSaved: (route?: Route) => Promise<void> | void; scope?: "Drive" | "Photos" | "Both"; preferredStorageId?: string; onCommitted?: () => void }) {
  const contentTypes: ("Drive" | "Photos")[] = scope === "Both" ? ["Drive", "Photos"] : [scope];
  const draftLabels = scope === "Both" ? ["Drive + Photos"] : contentTypes;
  const firstStorage = preferredStorageId || state.storages.find((storage) => storage.id !== "local" && contentTypes.every((type) => !state.routes.some((route) => route.contentType === type && route.storageId === storage.id)))?.id || "";
  const [storageId] = useState(firstStorage), [keepPolicy, setKeepPolicy] = useState("Everything"), [organizePhotos, setOrganizePhotos] = useState(true), [status, setStatus] = useState("");
  const storage = state.storages.find((item) => item.id === storageId);
  const save = async () => {
    setStatus("Validating and saving…");
    try {
      if (fixture) { for (const contentType of contentTypes) await onSaved({ id: `fixture-${contentType}-${storageId}`, contentType, source: `Local Drive/${contentType}`, storageId, destination: `${storage?.root || "Storage"}/${contentType}`, storagePresent: true, keepPolicy }); setStatus("Connection saved"); onCommitted?.(); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/save-route", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ contentTypes, storageId, keepPolicy, organizePhotos }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Connection could not be saved"); await onSaved(); setStatus("Connection saved"); onCommitted?.();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Route could not be saved"); }
  };
  return <form className="route-setup" onSubmit={(event) => { event.preventDefault(); save(); }}><div className="setup-draft-cards">{draftLabels.map((label) => <article className="connection-card setup-connection-card" key={label}><small>{label} · New connection</small><div className="connection-device"><DeviceIcon device={{id:"local",label:state.deviceName || "Laptop",kind:"Laptop",icon:state.localDeviceIcon}} /><strong>{state.deviceName || "Laptop"}</strong><span>{label} {scope === "Both" ? "libraries" : "library"}</span></div><div className="connection-properties"><button disabled><ArrowRight />Computer → storage</button><label className="connection-mode"><Copy /><select aria-label={`${label} transfer mode`} value={keepPolicy === "Everything" ? "Copy" : "Move"} onChange={(event) => setKeepPolicy(event.target.value === "Copy" ? "Everything" : "Nothing")}><option value="Copy">Copy</option><option value="Move">Move · verified, then Trash</option></select></label><label className="connection-mode"><CalendarBlank /><select aria-label={`${label} source retention`} value={keepPolicy} onChange={(event) => setKeepPolicy(event.target.value)}><option value="Everything">Keep all originals</option><option value="Nothing">Keep none after confirmation</option><option value="Last day">Keep last day</option><option value="Last week">Keep last week</option><option value="Last month">Keep last month</option><option value="Last year">Keep last year</option></select></label></div><div className="connection-device"><DeviceIcon device={{id:storage?.id || "storage",label:storage?.label || "Storage",category:"storage",kind:"Storage",mediaType:storage?.mediaType,icon:storage?.icon}} /><strong>{storage?.label || "Storage"}</strong><span>{storage?.mediaType || "Storage"} · {storage?.present ? "Available" : "Mount required"}</span></div></article>)}</div>{contentTypes.includes("Photos") && <label className="setup-check"><input type="checkbox" checked={organizePhotos} onChange={(event) => setOrganizePhotos(event.target.checked)} />Organize new photos by year</label>}<p><CheckCircle />Local Drive already knows the computer libraries. It will create {contentTypes.map((type) => <b key={type}>{type}/ </b>)}directly inside {storage?.label || "the selected storage"}.</p><button className="primary" disabled={!storage?.present || status === "Validating and saving…"}>{status === "Validating and saving…" ? status : `Save ${scope} connection${scope === "Both" ? "s" : ""}`}</button>{status && status !== "Validating and saving…" && <small role="status">{status}</small>}</form>;
}

function RoutePreviewButton({ route, fixture }: { route: Route; fixture: boolean }) {
  const unavailable = routeUnavailable(route);
  const [status, setStatus] = useState(""), [preview, setPreview] = useState<ImportPreview | null>(null), [operationId, setOperationId] = useState(""), [transferState, setTransferState] = useState(""), [transferResult, setTransferResult] = useState(""), [progress, setProgress] = useState(0), [paused, setPaused] = useState(false), [manifestStatus, setManifestStatus] = useState(""), [history, setHistory] = useState<RouteHistoryItem[]>([]);
  const [cleanupReview, setCleanupReview] = useState<{ ok?: boolean; files?: number; bytes?: number; uncertain?: boolean } | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [restoreReview, setRestoreReview] = useState<{ id: string; path: string; preview: ImportPreview } | null>(null), [restoreStatus, setRestoreStatus] = useState("");
  const fixturePaused = useRef(false), fixtureCancelled = useRef(false);
  const refreshHistory = async () => {
    if (fixture) return;
    try { const response = await fetch(`/api/v1/route-history?routeId=${encodeURIComponent(route.id)}`); if (response.ok) setHistory(((await response.json()) as { items: RouteHistoryItem[] }).items); } catch { /* The route remains usable while history is temporarily unavailable. */ }
  };
  useEffect(() => { refreshHistory(); }, [route.id]);
  const inspect = async () => {
    setCleanupReview(null); setConfirmCleanup(false); setStatus("Previewing…"); setPreview(null); setOperationId(""); setTransferState(""); setTransferResult(""); setManifestStatus(""); setProgress(0); setPaused(false); fixturePaused.current = false; fixtureCancelled.current = false;
    try {
      if (fixture) { setPreview({ ok: true, error: "", files: route.contentType === "Photos" ? 842 : 143, bytes: 2_760_000_000, toCopy: 418_000_000, identical: 91, duplicates: 0, destinationDuplicates: 0, conflicts: 0, unsupported: 0, unreadable: 0, duplicatePaths: [], conflictPaths: [], unsupportedPaths: [] }); setOperationId(`fixture-${route.id}`); setStatus(""); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const started = await fetch("/api/v1/route-preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ routeId: route.id }) });
      const operation = await started.json() as { id?: string; error?: string }; if (!started.ok || !operation.id) throw new Error(operation.error || "Preview could not start");
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(operation.id)}`); const current = await response.json() as { state?: string; preview?: ImportPreview; cleanup?: typeof cleanupReview; error?: string };
        if (!response.ok) throw new Error(current.error || "Preview unavailable");
        if (current.state === "complete" && current.preview) { setPreview(current.preview); setCleanupReview(current.cleanup || null); setOperationId(operation.id); setStatus(""); return; }
      }
      throw new Error("Preview is taking longer than expected");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Preview failed"); }
  };
  const transfer = async (cleanup = false) => {
    setConfirmCleanup(false); setTransferState(cleanup ? "cleaning" : "copying"); setTransferResult(""); setProgress(0); setPaused(false); fixturePaused.current = false; fixtureCancelled.current = false;
    try {
      if (fixture) { if (cleanup) { setCleanupReview(null); setTransferState("cleaned"); setTransferResult("Demo: verified originals moved to Trash."); return; } for (let step = 1; step <= 20; step++) { while (fixturePaused.current && !fixtureCancelled.current) await new Promise((resolve) => setTimeout(resolve, 50)); if (fixtureCancelled.current) { setTransferState("failed"); setTransferResult("Cancelled. Source files were retained and no incomplete file was published."); return; } await new Promise((resolve) => setTimeout(resolve, 50)); setProgress(step * 5); } setCleanupReview(route.keepPolicy && route.keepPolicy !== "Everything" ? { ok: true, files: 52, bytes: 418_000_000 } : null); setTransferState("transferred"); setTransferResult(route.keepPolicy === "Everything" ? "Transfer complete. Source files were kept." : "Transfer verified. Cleanup remains pending and recoverable."); setHistory([{ id: "fixture-history", event: "verified", result: "verified copy", occurredAt: new Date().toISOString(), source: `${route.contentType}/Health Summary.pdf`, destination: `${route.destination}/Health Summary.pdf` }]); return; }
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const started = await fetch(cleanup ? "/api/v1/route-cleanup" : "/api/v1/route-execute", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: operationId }) }); const start = await started.json() as { error?: string }; if (!started.ok) throw new Error(start.error || "Transfer could not start");
      for (let attempt = 0; attempt < 14_400; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250)); const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(operationId)}`); const current = await response.json() as { state?: string; result?: string; bytesDone?: number; bytesTotal?: number; paused?: boolean; cleanup?: typeof cleanupReview; error?: string };
        if (!response.ok) throw new Error(current.error || "Transfer status unavailable");
        if (current.bytesTotal) setProgress(Math.min(100, Math.round((current.bytesDone || 0) * 100 / current.bytesTotal))); setPaused(!!current.paused);
        if (current.state === "transferred" || current.state === "cleaned" || current.state === "failed") { setCleanupReview(current.cleanup || null); setTransferState(current.state); setTransferResult(current.result || (current.state === "transferred" ? "Transfer complete" : "Transfer failed")); await refreshHistory(); return; }
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
  const previewRestore = async (item: RouteHistoryItem) => {
    setRestoreReview(null); setRestoreStatus("Checking verified backup…");
    if (fixture) { setRestoreReview({ id: "fixture-restore", path: item.source, preview: { ok: true, error: "", files: 1, bytes: 1_454_512, toCopy: 1_454_512, identical: 0, duplicates: 0, destinationDuplicates: 0, conflicts: 0, unsupported: 0, unreadable: 0, duplicatePaths: [], conflictPaths: [], unsupportedPaths: [] } }); setRestoreStatus(""); return; }
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/restore-preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ routeId: route.id, historyId: item.id }) });
      const started = await response.json() as { id?: string; error?: string }; if (!response.ok || !started.id) throw new Error(started.error || "Restore preview could not start");
      for (let attempt = 0; attempt < 240; attempt++) { await new Promise((resolve) => setTimeout(resolve, 250)); const poll = await fetch(`/api/v1/import-preview?id=${encodeURIComponent(started.id)}`); const result = await poll.json() as { state?: string; path?: string; preview?: ImportPreview; error?: string }; if (!poll.ok) throw new Error(result.error || "Restore preview unavailable"); if (result.state === "complete" && result.preview) { setRestoreReview({ id: started.id, path: result.path || item.source, preview: result.preview }); setRestoreStatus(""); return; } }
      throw new Error("Restore preview is taking longer than expected");
    } catch (error) { setRestoreStatus(error instanceof Error ? error.message : "Restore preview failed"); }
  };
  const executeRestore = async () => {
    if (!restoreReview) return; setRestoreStatus("Restoring and verifying…");
    if (fixture) { setRestoreStatus("Demo: file restored and verified; no files were changed."); setRestoreReview(null); return; }
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/import-execute", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: restoreReview.id }) }); const started = await response.json() as { error?: string }; if (!response.ok) throw new Error(started.error || "Restore could not start");
      for (let attempt = 0; attempt < 14_400; attempt++) { await new Promise((resolve) => setTimeout(resolve, 250)); const poll = await fetch(`/api/v1/import-preview?id=${encodeURIComponent(restoreReview.id)}`); const result = await poll.json() as { state?: string; result?: string }; if (result.state === "failed") throw new Error(result.result || "Restore failed safely"); if (result.state === "imported") { setRestoreStatus("Restore complete. The laptop copy was verified and the backup was kept."); setRestoreReview(null); await refreshHistory(); return; } }
      throw new Error("Restore continues; keep the application open");
    } catch (error) { setRestoreStatus(error instanceof Error ? error.message : "Restore failed safely"); }
  };
  return <div className="route-preview"><button className="secondary" title={unavailable || "Inspect files before copying"} disabled={!!unavailable || status === "Previewing…" || transferState === "copying" || transferState === "cleaning"} onClick={inspect}><PlayCircle />{status === "Previewing…" ? status : "Preview route"}</button>
    {unavailable && <small>{unavailable}</small>}
    {status && status !== "Previewing…" && <small role="status">{status}</small>}
    {preview && <div className={preview.ok ? "preview-result" : "preview-result failed"} role="status">{preview.ok ? <><strong>{preview.files} files · {formatSize(preview.bytes)}</strong><span>{formatSize(preview.toCopy)} to transfer · {preview.identical} already identical · {preview.conflicts} conflicts</span></> : <><strong>Preview failed</strong><span>{preview.error}</span></>}</div>}
    {preview?.ok && operationId && <button className="secondary" onClick={exportManifest}><ArrowSquareOut />Export manifest</button>}
    {preview?.ok && operationId && transferState !== "failed" && <button className="primary" disabled={!!unavailable || preview.toCopy <= 0 || ["copying", "cleaning", "cleaned", "transferred"].includes(transferState)} onClick={() => transfer()}><PlayCircle />{transferState === "copying" ? `Transferring… ${progress}%` : transferState === "cleaning" ? "Moving to Trash…" : transferState === "cleaned" ? "Move complete" : transferState === "transferred" ? "Transferred" : preview.toCopy <= 0 ? "Nothing to transfer" : "Transfer verified files"}</button>}
    {transferState === "copying" && <div className="transfer-controls">{paused ? <button className="secondary" onClick={() => control("resume")}><PlayCircle />Resume</button> : <button className="secondary" onClick={() => control("pause")}><PauseCircle />Pause</button>}<button className="danger" onClick={() => control("cancel")}><StopCircle />Cancel</button></div>}
    {cleanupReview?.ok && <div className="settings-confirm">
      <p>{cleanupReview.files || 0} verified originals · {formatSize(cleanupReview.bytes || 0)} eligible for system Trash. Retention uses each file's last modification time. Destination copies are kept.</p>
      {cleanupReview.uncertain ? <p>Previous cleanup has an uncertain outcome. Check system Trash before continuing.</p> : confirmCleanup ? <><p>Move these originals to Trash now? Both source and destination will be verified again.</p><button className="danger" onClick={() => transfer(true)}>Confirm move to Trash</button><button onClick={() => setConfirmCleanup(false)}>Keep originals for now</button></> : <button className="secondary" disabled={!!unavailable || ["copying", "cleaning"].includes(transferState)} onClick={() => setConfirmCleanup(true)}>{transferState === "cleaning" ? "Moving to Trash…" : "Review source cleanup"}</button>}
    </div>}
    {manifestStatus && <small className={manifestStatus === "Manifest downloaded" ? "transfer-success" : ""} role="status">{manifestStatus}</small>}
    {transferResult && <small className={["transferred", "cleaned"].includes(transferState) ? "transfer-success" : ""} role="status">{transferResult}</small>}
    {restoreReview && <div className={restoreReview.preview.ok && restoreReview.preview.toCopy > 0 ? "settings-confirm" : "settings-confirm attention"}><p><strong>Restore {restoreReview.path}</strong></p><p>{restoreReview.preview.ok ? `${formatSize(restoreReview.preview.toCopy)} will be copied back to the laptop. The backup stays unchanged.` : restoreReview.preview.error}</p>{restoreReview.preview.ok && restoreReview.preview.toCopy > 0 && <button className="primary" onClick={executeRestore}>Restore and verify</button>}<button className="secondary" onClick={() => { setRestoreReview(null); setRestoreStatus(""); }}>Cancel</button></div>}
    {restoreStatus && <small role="status">{restoreStatus}</small>}
    <details className="route-history"><summary>Recent activity ({history.length})</summary>{history.length ? <ul>{history.map((item, index) => <li key={`${item.occurredAt}-${index}`}><strong>{item.event}</strong><span>{item.result} · {formatDate(item.occurredAt)}</span>{item.event === "verified" && item.id && <button className="secondary" disabled={!!restoreStatus} onClick={() => void previewRestore(item)}>Preview restore</button>}</li>)}</ul> : <p>No transfer history yet.</p>}</details>
  </div>;
}

function HubControl({ state, onSave }: { state: ApiState; onSave: (enabled: boolean, limit: number) => Promise<void> }) {
  const [enabled, setEnabled] = useState(state.hub?.enabled || false), [status, setStatus] = useState("");
  const limit = state.hub?.limitPercent || 80;
  useEffect(() => setEnabled(state.hub?.enabled || false), [state.hub?.enabled]);
  if (!enabled) return null;
  return <div className="hub-control"><label><input type="checkbox" disabled checked={enabled} /><strong>Legacy hub setting</strong></label><span>Use the Cache controls on each connection instead. Previous files are retained. Saved limit: {limit}%.</span>{enabled && <button className="secondary" disabled={status === "Saving…"} onClick={async () => { setStatus("Saving…"); try { await onSave(false, limit); setEnabled(false); setStatus("Hub disabled; files retained"); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save hub settings"); } }}>Disable saved hub</button>}{status && <small role="status">{status}</small>}</div>;
}

function SyncView({ state, usage, checkedAt, onCheck, onProblems, onMount, onSettings, onSetupStorage, onRefresh, onUsageRefresh }: { state: ApiState; usage: LibraryUsage; checkedAt: string; onCheck: () => Promise<void>; onProblems: () => void; onMount: (id: string) => void; onSettings: () => void; onSetupStorage: (id: string) => void; onRefresh: () => Promise<void>; onUsageRefresh: () => Promise<void> }) {
  const syncDialog = useRef<HTMLDialogElement>(null);
  const [phoneActionStatus, setPhoneActionStatus] = useState(""), [phoneBusy, setPhoneBusy] = useState(false), [fullMapOpen, setFullMapOpen] = useState(false);
  const [phonePreview, setPhonePreview] = useState<PhonePreview | null>(null);
  const [content, setContent] = useState<"Drive" | "Photos">("Drive");
  const [checking, setChecking] = useState(false);
  const refresh = async () => { setChecking(true); try { await onCheck(); } finally { setChecking(false); } };
  const transfer = state.catalog.activeTransfer;
  const capacity = storageTotals(state.storages);
  const fixture = import.meta.env.DEV && new URLSearchParams(location.search).has("fixture");
  const transferPercent = transfer?.bytesTotal ? Math.round(transfer.bytesDone * 100 / transfer.bytesTotal) : 0;
  const mountable = state.storages.find((storage) => storage.connected && !storage.present);
  const waiting = state.routes.some((route) => !!routeUnavailable(route)) || !!state.schedules?.some((item) => item.state === "pending") || !!state.cacheStatus?.some((item) => item.blocked);
  const healthy = state.ready && !state.error && state.problems === 0 && !state.scheduleError && !mountable && !waiting;
  const hiddenIds = new Set(state.hiddenDevices?.map((device) => device.id));
  const liveDevices = Array.from(new Map([...state.devices, ...(state.connectedDevices || [])].filter((device) => !hiddenIds.has(device.id)).map((device) => [device.id, device])).values());
  const deviceRows: Device[] = [
    { id: "local", label: state.deviceName || "Laptop", present: true, kind: "Laptop", icon: state.localDeviceIcon },
    ...liveDevices,
    ...state.storages.filter((storage) => storage.id !== "local" && !hiddenIds.has(storage.id)).map((storage) => ({ ...storage, kind: "Storage" })),
  ];
  const phones = liveDevices.filter((device) => device.kind === "Phone" || device.transports?.includes("mtp") || device.label.includes("Xiaomi"));
  const importFromPhone = async (selection: { root: "Drive" | "DCIM"; phoneId: string; routeId: string; toLaptop: boolean; previewId?: string }) => {
    if (fixture) {
      if (selection.previewId) { setPhonePreview(null); setPhoneActionStatus("Demo mode: verified copy completed; no files were transferred."); return; }
      const currentPhone = phones.find((item) => item.id === selection.phoneId), route = state.routes.find((item) => item.id === selection.routeId), storage = state.storages.find((item) => item.id === route?.storageId);
      setPhonePreview({ ...selection, previewId: "fixture-phone-preview", phoneLabel: currentPhone?.label || "Phone", destination: selection.toLaptop ? "Computer cache" : storage?.label || "Storage", destinationRoot: selection.toLaptop ? route?.source || "Local Drive" : route?.destination || "Storage", summary: "6 files · 5.2 MB", preview: { ok: true, error: "", files: 6, bytes: 5_200_000, toCopy: 4_100_000, identical: 2, duplicates: 0, destinationDuplicates: 0, conflicts: 0, unsupported: 0, unreadable: 0, duplicatePaths: [], conflictPaths: [], unsupportedPaths: [] } });
      setPhoneActionStatus("Preview complete. Nothing has been copied."); return;
    }
    const previewOnly = !selection.previewId;
    setPhonePreview(null);
    setPhoneBusy(true);
    setPhoneActionStatus(`Scanning phone ${selection.root}…`);
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const body = previewOnly ? { ...selection, previewOnly: true } : { previewId: selection.previewId };
      const started = await fetch("/api/v1/import-from-phone", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify(body) });
      const startResult = await started.json() as { id?: string; error?: string; destination?: string }; if (!started.ok || !startResult.id) throw new Error(startResult.error || "Phone import could not start");
      setPhoneActionStatus(`Scanning phone ${selection.root} → ${startResult.destination || "backup"}…`);
      for (let attempt = 0; attempt < 240; attempt++) { await new Promise((resolve) => setTimeout(resolve, 500)); const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(startResult.id)}`); if (!response.ok) continue; const operation = await response.json() as { state: string; result?: string; bytesDone?: number; bytesTotal?: number; path?: string; phoneId?: string; phoneLabel?: string; routeId?: string; toLaptop?: boolean; destination?: string; destinationRoot?: string; preview?: ImportPreview }; if (operation.state === "failed") throw new Error(operation.result || "Phone import failed; sources retained"); if (previewOnly && operation.state === "complete" && operation.preview) { const detail = operation.preview; setPhonePreview({ previewId: startResult.id, root: selection.root, phoneId: operation.phoneId || selection.phoneId, phoneLabel: operation.phoneLabel || "Phone", routeId: operation.routeId || selection.routeId, toLaptop: operation.toLaptop ?? selection.toLaptop, destination: operation.destination || startResult.destination || "Backup storage", destinationRoot: operation.destinationRoot || "", summary: `${detail.files} files · ${formatSize(detail.bytes)}`, preview: detail }); setPhoneActionStatus("Preview complete. Nothing has been copied."); return; } if (!previewOnly && operation.state === "transferred") { setPhoneActionStatus(operation.result || "Phone import completed and verified"); return; } setPhoneActionStatus(operation.bytesTotal ? `${operation.path || (previewOnly ? "Hashing phone preview" : "Importing")} · ${Math.round((operation.bytesDone || 0) * 100 / operation.bytesTotal)}%` : `Scanning phone ${selection.root} → ${startResult.destination || "backup"}…`); }
      setPhoneActionStatus("Import continues in Current transfer");
    } catch (error) { setPhoneActionStatus(error instanceof Error ? error.message : "Phone import failed; sources retained"); }
    finally { setPhoneBusy(false); }
  };

  return <section className="sync-view">
    <div className={`health-banner ${healthy ? "healthy" : "attention"}`}>
      {healthy ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}
      <div><h1>{mountable ? `${mountable.label} is connected but not mounted` : healthy ? "No reported problems" : "Local Drive needs attention"}</h1><p>{mountable ? "Mount it to make its backup routes available." : waiting ? "A connection or scheduled transfer needs attention. Review the notifications below." : `Last checked ${checkedAt}`}</p></div>
      {mountable && <button className="secondary" onClick={() => onMount(mountable.id)}><HardDrive />Mount storage</button>}
    </div>

    <div className="sync-grid">
      <article className="sync-card transfer-card">
        <h2><ArrowsClockwise />Notifications</h2>
        <ConnectionNotifications state={state} onSettings={onSettings} onSetupStorage={onSetupStorage} />
        <SyncSchedules noticesOnly schedules={state.schedules || []} error={state.scheduleError} routes={state.routes} phones={state.devices} storages={state.storages} fixture={fixture} onRefresh={onCheck} onReview={onSettings} />
        <h3>Current transfer</h3>
        {state.operations?.length ? <BackendActivity operations={state.operations} label={(id) => { const route = state.routes.find((item) => item.id === id); return route ? `${route.contentType} → ${state.storages.find((item) => item.id === route.storageId)?.label || "storage"}` : "Transfer"; }} fixture={fixture} refresh={onRefresh} /> : transfer ? <>
          <strong>{transfer.state} → {transfer.destination || "configured storage"}</strong>
          <div className="progress-row"><progress value={transferPercent} max="100" /><b>{transferPercent}%</b></div>
          <p>{formatSize(transfer.bytesDone)} of {formatSize(transfer.bytesTotal)}</p>
        </> : <div className="quiet-state"><CheckCircle /><strong>No active transfer</strong><p>New work will appear here automatically.</p></div>}
        {state.cacheStatus?.filter((item) => item.message).map((item) => <p role={item.blocked ? "alert" : "status"} key={item.routeId}><WarningCircle />{state.routes.find((route) => route.id === item.routeId)?.contentType}: {item.message} <button onClick={onSettings}>Review connection</button></p>)}
        {state.error && <p role="alert">{state.error}</p>}
        {state.photoExports?.map((job) => <p key={job.id}><Database />Photo library export: {job.result || `${job.state} · ${job.filesDone || 0} / ${job.filesTotal || "…"} files`}{!["transferred", "failed"].includes(job.state) && " — keep storage connected."}</p>)}
        {state.storages.filter((storage) => storage.connected && !storage.present).map((storage) => <p key={storage.id}><WarningCircle /> {storage.label} needs mounting. <button onClick={() => onMount(storage.id)}>Mount</button></p>)}
        {state.problems > 0 && <p><button onClick={onProblems}><Wrench />Review {state.problems} problems</button></p>}
        {!!state.hub?.pendingBytes && <p><Clock />Files are awaiting transfer. Connect {state.hub.waitingFor || "destination storage"}.</p>}
      </article>

      <article className="sync-card devices-card">
        <h2 className="devices-heading"><Desktop />Connected devices<button className="device-refresh" aria-label="Refresh devices" title="Scan for disks and phones now" disabled={checking} onClick={() => void refresh()}><ArrowsClockwise className={checking ? "spinning" : ""} /></button></h2>
        <small className="device-refresh-status" role="status">{checking ? "Checking devices…" : `Auto-check every 5 seconds · manual check: ${checkedAt}`}</small>
        <div className="device-list">{deviceRows.map((device) => {
          const status = deviceStatus(device);
          return <div className="device-row" key={device.id}>
            <DeviceIcon device={device} />
            <strong>{device.label}</strong><span className={`status ${status === "Online now" || status === "Files available" ? "online" : "remembered"}`}>{status === "Online now" || status === "Files available" ? <CheckCircle weight="fill" /> : status === "Last reported" ? <Clock /> : <WarningCircle />}{status}</span><CaretRight />
          </div>;
        })}</div>
        {phones.map((currentPhone) => {
          const charging = currentPhone.status === "Charging only";
          const identified = currentPhone.stableIdentity?.startsWith("mtp:");
          const available = !!currentPhone.present && !charging && !!identified && (currentPhone.transports?.includes("mtp") || !!currentPhone.phoneRoot);
          return <div className={`phone-usb-guide ${available ? "ready" : charging ? "attention" : "offline"}`} key={currentPhone.id}>
            {available ? <CheckCircle weight="fill" /> : charging ? <DeviceMobile weight="fill" /> : <Clock />}
            <div><strong>{available ? `${currentPhone.label} memory is available` : charging ? `${currentPhone.label} — charging only` : `${currentPhone.label} is disconnected`}</strong>
              <p>{available ? "Choose the exact destination to preview. USB debugging is not used." : currentPhone.status === "Identity unavailable" ? "Local Drive cannot safely distinguish this phone. Disconnect other same-model phones, then refresh." : charging ? "Unlock the phone, open ‘Charging via USB’, then choose ‘File transfers / Android Auto’. Ignore the USB debugging notification." : "Reconnect and enable File transfers. Pending work and verified history stay saved."}</p>
              <ol><li>Connect and unlock</li><li className={charging || available ? "done" : ""}>Cable detected</li><li className={available ? "done" : ""}>Enable file transfers</li><li className={available ? "done" : ""}>Preview, then transfer</li></ol>
              {available && <div className="phone-import-actions">{state.routes.map((route) => {
                const root = route.contentType === "Photos" ? "DCIM" : route.contentType === "Drive" ? "Drive" : null;
                if (!root) return null;
                const storage = state.storages.find((item) => item.id === route.storageId);
                return <span key={`${currentPhone.id}-${route.id}`}>
                  {route.storagePresent && <button className="secondary" disabled={phoneBusy} onClick={() => void importFromPhone({ root, phoneId: currentPhone.id, routeId: route.id, toLaptop: false })}>Preview {root} → {storage?.label || "storage"}</button>}
                  {!!route.stagingMaxBytes && <button className="secondary" disabled={phoneBusy} onClick={() => void importFromPhone({ root, phoneId: currentPhone.id, routeId: route.id, toLaptop: true })}>Preview {root} → Computer cache</button>}
                </span>;
              })}</div>}
              {phonePreview?.phoneId === currentPhone.id && <div className="phone-preview-confirm"><strong>{phonePreview.phoneLabel} → {phonePreview.destination}</strong><span>{phonePreview.summary}</span><span>{formatSize(phonePreview.preview.toCopy)} new · {phonePreview.preview.identical} already identical · {phonePreview.preview.duplicates + phonePreview.preview.destinationDuplicates} exact duplicates · {phonePreview.preview.conflicts} conflicts · {phonePreview.preview.unsupported} unsupported · {phonePreview.preview.unreadable} unreadable</span><span>{phonePreview.destinationRoot}</span><span>{phonePreview.preview.ok ? "The same phone and destination are checked again before copying." : phonePreview.preview.error || "Review the findings before copying."}</span><button disabled={phoneBusy || !phonePreview.preview.ok} onClick={() => void importFromPhone({ root: phonePreview.root, phoneId: phonePreview.phoneId, routeId: phonePreview.routeId, toLaptop: phonePreview.toLaptop, previewId: phonePreview.previewId })}>Copy and verify</button><button className="secondary" disabled={phoneBusy} onClick={() => { setPhonePreview(null); setPhoneActionStatus(""); }}>Cancel</button></div>}
            </div>
          </div>;
        })}
        {phoneActionStatus && <small role="status">{phoneActionStatus}</small>}
      </article>

      <article className="sync-card map-card">
        <h2><ShareNetwork />Connections</h2>
        <div className="connection-editor-toolbar"><div className="segment"><button className={content === "Drive" ? "active" : ""} onClick={() => setContent("Drive")}><Folder />Drive</button><button className={content === "Photos" ? "active" : ""} onClick={() => setContent("Photos")}><Images />Photos</button></div><button className="secondary" onClick={() => setFullMapOpen(true)}><ShareNetwork />Open full map</button></div>
        <div className="connection-summaries">{state.routes.filter((route) => route.contentType === content).map((route) => { const storage = state.storages.find((item) => item.id === route.storageId); return <article className="connection-summary" key={route.id}><div><DeviceIcon device={{id:"local",label:state.deviceName || "Computer",kind:"Laptop",icon:state.localDeviceIcon}} /><strong>{state.deviceName || "Computer"}</strong><ArrowRight /><DeviceIcon device={{id:storage?.id || "storage",label:storage?.label || "Storage",category:"storage",kind:"Storage",mediaType:storage?.mediaType,icon:storage?.icon}} /><strong>{storage?.label || "Storage"}</strong></div><p>{route.contentType} · {routeMode(route)} · {route.storagePresent ? "Available" : "Offline"}</p><small>{routeUnavailable(route) || "Verified transfer available"}</small></article>; })}</div>
        {!state.routes.some((route) => route.contentType === content) && <p>No {content} connections configured.</p>}
        <button className="secondary" onClick={onSettings}><Gear />Manage connections in Settings</button>
      </article>

      <article className="sync-card pending-card">
        <h2><PlayCircle />Sync now</h2>
        <p>Preview a connection, then confirm a verified transfer. Move requires a separate review before originals go to Trash.</p>
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

      <LibraryUsageCard usage={usage} onRefresh={onUsageRefresh} />

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

function SettingsView({ state, fixture, onRefresh, onRouteUpdate, onAdd, onHubSave, onMount }: { state: ApiState; fixture: boolean; onRefresh: () => Promise<void>; onRouteUpdate: Parameters<typeof ConnectionCards>[0]["onUpdate"]; onAdd: (content: "Drive" | "Photos") => void; onHubSave: (enabled: boolean, limit: number) => Promise<void>; onMount: (id: string) => void }) {
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [remove, setRemove] = useState<Route | null>(null);
  const [removeDevice, setRemoveDevice] = useState<Device | null>(null);
  const [fullMapOpen, setFullMapOpen] = useState(false);
  const update = async (endpoint: string, body: object, success = "Saved. Library files and transfer history were kept.") => {
    if (fixture) { setStatus("Demo mode. Device and connection changes require the live application."); return; }
    setBusy(true); setStatus("");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch(`/api/v1/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Settings could not be saved");
      await onRefresh(); setRemove(null); setStatus(success);
      if (endpoint === "device-visibility") setShowHidden(!!(body as { hidden: boolean }).hidden);
      if (endpoint === "remove-device") setRemoveDevice(null);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Settings unavailable"); }
    finally { setBusy(false); }
  };
  const hiddenIds = new Set(state.hiddenDevices?.map((device) => device.id));
  const devices = Array.from(new Map<Device["id"], Device>([...state.devices, ...(state.connectedDevices || []), ...state.storages.filter((storage) => storage.id !== "local").map((storage) => ({ ...storage, category: "storage" as const, kind: "Storage" }))].filter((device) => !hiddenIds.has(device.id)).map((device) => [device.id, device])).values());
  return <section className="app-settings drive-settings" aria-label="Application settings">
    <header><Gear /><div><h1>Settings</h1><p>Device management, connection management and storage management.</p></div></header>
    {status && <p role="status">{status}</p>}
    <section><h2><Desktop />Device management</h2>
      <p>Hide keeps a device here under Hidden devices. Show again returns it to the dashboard. Removal stops its connections and removes it from these lists.</p>
      <div className="segment device-visibility-tabs" role="group" aria-label="Device visibility"><button className={!showHidden ? "active" : ""} aria-pressed={!showHidden} onClick={() => setShowHidden(false)}>Visible devices ({devices.length})</button><button className={showHidden ? "active" : ""} aria-pressed={showHidden} onClick={() => setShowHidden(true)}>Hidden devices ({state.hiddenDevices?.length || 0})</button></div>
      {!showHidden && <article><DeviceIcon device={{id:"local",label:state.deviceName || "This computer",kind:"Laptop",icon:state.localDeviceIcon}} /><span><strong>{state.deviceName || "This computer"}</strong><small>Laptop · cannot be hidden or removed</small></span><div className="device-actions"><DeviceIconPicker device={{id:"local",label:state.deviceName || "This computer",kind:"Laptop",icon:state.localDeviceIcon}} disabled={busy || fixture} onChoose={(icon) => void update("device-icon", { id: "local", icon }, icon ? "Device icon saved." : "Device icon is automatic." )} /></div></article>}
      {(showHidden ? state.hiddenDevices || [] : devices).map((device) => { const routes = state.routes.filter((route) => route.storageId === device.id); return <article key={device.id}><DeviceIcon device={device} /><span><strong>{device.label}</strong><small>{device.mediaType || device.kind || "Device"} · {showHidden ? "Hidden · still saved" : deviceStatus(device)} · {routes.length} connections</small>{routes.length > 0 && <small>Connections stay visible. Remove them before hiding this device.</small>}<details><summary>Advanced · identity</summary><small>{device.id}</small></details></span><div className="device-actions"><DeviceIconPicker device={device} disabled={busy || fixture} onChoose={(icon) => void update("device-icon", { id: device.id, icon }, icon ? "Device icon saved." : "Device icon is automatic." )} /><button className="secondary" disabled={busy || fixture || (!showHidden && routes.length > 0)} onClick={() => void update("device-visibility", { id: device.id, hidden: !showHidden }, showHidden ? "Device shown again in Visible devices and the dashboard." : "Device hidden. Find it in Hidden devices and choose Show again.")}>{showHidden ? "Show again" : "Hide device"}</button><button className="secondary" disabled={busy || fixture} title="Remove from this application and stop its connections; keep files and verified history" onClick={() => setRemoveDevice(device)}>Remove device</button></div></article>; })}
      {showHidden && !state.hiddenDevices?.length && <p>No hidden devices.</p>}
      {removeDevice && <div className="settings-confirm" role="group" aria-label="Confirm device removal"><p>Remove {removeDevice.label} from Local Drive? Its connections will stop. Files and verified history will be kept.</p><button className="danger" disabled={busy} onClick={() => void update("remove-device", { id: removeDevice.id }, "Device removed. Its connections stopped; files and history were kept.")}>Confirm removal</button><button disabled={busy} onClick={() => setRemoveDevice(null)}>Cancel removal</button></div>}
    </section>
    <section><h2><ShareNetwork />Connection management</h2><ConnectionCards state={state} fixture={fixture} onUpdate={onRouteUpdate} onAdd={onAdd} onOpenMap={() => setFullMapOpen(true)} onClone={() => update("clone-files-map", {}, "Drive connections copied to Photos.")} onRemove={setRemove} /><p>Remove a connection to stop using that route. Stored files and verified history are preserved.</p>
      {remove && <div className="settings-confirm" role="group" aria-label="Confirm connection removal"><p>Remove the {remove.contentType} connection to {state.storages.find((storage) => storage.id === remove.storageId)?.label || remove.storageId}? No library files will be deleted.</p><button className="danger" disabled={busy} onClick={() => void update("remove-route", { id: remove.id })}>Confirm removal</button><button disabled={busy} onClick={() => setRemove(null)}>Cancel removal</button></div>}
    </section>
    <section><h2><Cpu />Incoming connections → {state.deviceName || "Computer"}</h2><p>Cache belongs to receiving computers: laptops, PCs and servers. Outgoing computer → disk connections have no intermediate cache.</p>{state.incomingConnections?.map((intake) => { const route = state.routes.find((item) => item.id === intake.routeId); return route && <article className="phone-intake-card" key={intake.routeId}><h3>{intake.transport === "mtp" ? "USB device" : "Remote device"} → {state.deviceName || "Computer"} · {intake.contentType}</h3><p>Forwarding destination: {state.storages.find((item) => item.id === intake.destinationStorageId)?.label || "Storage"}. Receive files here while that destination is disconnected.</p>{intake.cacheSupported && <CacheAdvanced route={{ ...route, stagingMaxBytes: intake.cacheEnabled ? route.stagingMaxBytes || 1 : 0, cacheLimitPercent: intake.limitPercent }} cacheStatus={state.cacheStatus?.find((item) => item.routeId === intake.routeId)} onUpdate={onRouteUpdate} />}</article>; })}</section>
    <WirelessSettings wireless={state.wireless} fixture={fixture} refresh={onRefresh} />
    <section><h2><Clock />Sync scheduling</h2><SyncSchedules schedules={state.schedules || []} error={state.scheduleError} routes={state.routes} phones={state.devices} storages={state.storages} fixture={fixture} onRefresh={onRefresh} /></section>
    <section><h2><Database />Storage management</h2>{state.storages.map((storage) => <article key={storage.id}><span><strong>{storage.label}</strong><small>{storage.present ? "Available" : storage.connected ? "Connected · not mounted" : "Offline"} · {storage.bytesTotal ? `${formatSize(storage.bytesFree || 0)} free / ${formatSize(storage.bytesTotal)}` : "Capacity not reported"}</small><details><summary>Advanced · location and identity</summary><small>{storage.root || "No mounted location"}</small><small>{storage.identity || storage.id}</small></details></span>{storage.connected && !storage.present && <button className="secondary" disabled={fixture} title={fixture ? "Mounting is unavailable in Demo mode" : "Mount storage"} onClick={() => onMount(storage.id)}>Mount storage</button>}</article>)}<HubControl state={state} onSave={onHubSave} /><details><summary>Advanced · locations currently in use</summary><p>Default library: {state.libraryRoot || "Not configured"}</p>{["Drive", "Photos"].map((type) => <p key={type}>{type}: {state.routes.find((route) => route.contentType === type)?.source || "No source route configured"}</p>)}<p>Changing existing library roots requires migration and is unavailable here. New connections propose default folders.</p></details></section>
    <section><h2><CheckCircle />Available in this Alpha</h2><p>Verified Copy and Move with reviewed source cleanup, local tags/favorites, system Trash, import preview and archive export. Retention is applied when you confirm cleanup; it is not scheduled. Cache intake waits for the destination and manual forwarding. Reverse/two-way sync and device unpairing are disabled. Scanner and image editing depend on installed desktop applications.</p></section>
    {fullMapOpen && <FullMapDialog state={state} onClose={() => setFullMapOpen(false)} />}
  </section>;
}

function FilesView({ files, path, state, verifiedOn, fixture, onNavigate, onNewFolder, onSyncDrive, onNewFile }: { files: DriveFile[]; path: string; state: ApiState; verifiedOn: string; fixture: boolean; onNavigate: (path: string) => Promise<void>; onNewFolder: () => void; onSyncDrive: () => void; onNewFile: (name: string) => void }) {
  const [fileLabels, setFileLabels] = useState<Record<string, FileLabels>>({});
  const [registeredTags, setRegisteredTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<TagColors>({});
  const [selectedTag, setSelectedTag] = useState("");
  const [labelsRoot, setLabelsRoot] = useState("");
  const [labelsReady, setLabelsReady] = useState(fixture);
  const refreshLabels = async () => {
    if (fixture) return;
    const response = await fetch("/api/v1/file-labels");
    if (!response.ok) throw new Error("File actions unavailable: labels could not be loaded");
    const result = await response.json() as { root: string; items: Record<string, FileLabels>; tags?: string[]; tagColors?: TagColors };
    setFileLabels(result.items); setRegisteredTags(result.tags || []); setTagColors(result.tagColors || {}); setLabelsRoot(result.root); setLabelsReady(true);
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
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [navigationError, setNavigationError] = useState("");
  const [openStatus, setOpenStatus] = useState("");
  const [recentFiles, setRecentFiles] = useState<DriveFile[]>([]);
  const [detailTab, setDetailTab] = useState<"details" | "activity">("details");
  const fileSection = ["Home", "Recent", "Favourites", "Tags"].includes(section);
  const shownFiles = section === "Home" ? files : recentFiles;
  const availableTags = [...new Set([...registeredTags, ...Object.values(fileLabels).flatMap((value) => value.tags)])].sort((a, b) => a.localeCompare(b));
  const visible = useMemo(() => shownFiles.filter((file) => file.name.toLowerCase().includes(query.toLowerCase()) && (section !== "Tags" || matchesDriveTag(fileLabels[`${labelsRoot}/${file.path || file.name}`]?.tags, selectedTag))).sort((a, b) => Number(b.directory) - Number(a.directory) || (sort === "modified" ? b.modified.localeCompare(a.modified) : sort === "size" ? b.size - a.size : sort === "name-desc" ? b.name.localeCompare(a.name, undefined, { numeric: true }) : a.name.localeCompare(b.name, undefined, { numeric: true }))), [shownFiles, query, sort, section, fileLabels, labelsRoot, selectedTag]);
  const segments = path ? path.split("/") : [];
  const selected = visible.find((file) => (file.path || file.name) === selectedName) ?? visible[0];
  const selectedItems = shownFiles.filter((file) => selectedPaths.includes(file.path || file.name)).map((file) => {
    const relative = file.path || [...segments, file.name].join("/");
    return { ...file, path: relative, labels: fileLabels[`${labelsRoot}/${relative}`] || { favorite: false, tags: [] } };
  });
  const toggleSelected = (relative: string) => setSelectedPaths((current) => current.includes(relative) ? current.filter((value) => value !== relative) : [...current, relative]);
  const allVisibleSelected = visible.length > 0 && visible.every((file) => selectedPaths.includes(file.path || [...segments, file.name].join("/")));
  const toggleVisibleSelection = () => setSelectedPaths((current) => allVisibleSelected ? current.filter((value) => !visible.some((file) => value === (file.path || [...segments, file.name].join("/")))) : [...new Set([...current, ...visible.map((file) => file.path || [...segments, file.name].join("/"))])]);
  const phoneReady = (state.connectedDevices?.length ? state.connectedDevices : state.devices).some((device) => device.present && !!device.phoneRoot && device.stableIdentity?.startsWith("mtp:"));
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
  useEffect(() => { setOpenStatus(""); setDetailTab("details"); }, [selectedName, path, selectedTag]);
  useEffect(() => { setSelectedPaths([]); }, [path, section]);
  const showSection = async (next: string) => {
    if (!["Recent", "Favourites", "Tags"].includes(next)) { setSection(next); setQuery(""); return; }
    if (fixture) { setRecentFiles(next === "Recent" ? demoFiles.filter((item) => !item.directory) : []); setSection(next); setQuery(""); return; }
    try { await refreshLabels(); const response = await fetch(next === "Recent" ? "/api/v1/recent-files" : `/api/v1/labelled-files?root=Drive&filter=${next === "Favourites" ? "favorites" : "tags"}`); if (!response.ok) throw new Error(); const result = await response.json() as { items: DriveFile[] }; setRecentFiles(result.items); setSection(next); setQuery(""); setNavigationError(""); }
    catch { setNavigationError(`${next} unavailable`); }
  };

  return <section className="files-shell">
    <header className="file-toolbar">
      <button aria-label="Back" disabled={section !== "Home" || !history.length} onClick={back} title="Previous folder"><ArrowLeft /></button><button aria-label="Up" disabled={section !== "Home" || !path} onClick={() => go(segments.slice(0, -1).join("/"))} title="Parent folder"><ArrowUp /></button>
      <div className="breadcrumbs">{section !== "Home" ? <strong>{section}</strong> : <><button onClick={() => path && go("")}>Drive</button>{segments.map((segment, index) => <span key={`${segment}-${index}`}>› <button onClick={() => index < segments.length - 1 && go(segments.slice(0, index + 1).join("/"))}><strong>{segment}</strong></button></span>)}</>}</div>
      {fileSection && <><label className="search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${section === "Home" ? segments.at(-1) || "Drive" : section}...`} /><kbd>/</kbd></label>
      <div className="view-buttons"><button className={!grid ? "selected" : ""} onClick={() => setGrid(false)} aria-label="List view"><ListBullets /></button><button className={grid ? "selected" : ""} onClick={() => setGrid(true)} aria-label="Grid view"><SquaresFour /></button><select aria-label="Sort files" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="modified">Newest modified</option><option value="size">Largest first</option></select></div></>}
      <details className="file-actions-menu" onToggle={(event) => { if (event.currentTarget.open) refreshMenuTemplates(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="File actions"><DotsThreeVertical /></summary><div onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}><button disabled={section !== "Home"} onClick={onNewFolder}><Folder />New folder</button>{menuTemplates.map((template) => <button key={template} disabled={section !== "Home"} onClick={() => onNewFile(template)}><File />{template}</button>)}{templateStatus && <small role="status">{templateStatus}</small>}<NewTag fixture={fixture} onSaved={() => void refreshLabels()} /><PhotoExport fixture={fixture} library="Drive" browse /><button onClick={onSyncDrive}><ArrowsClockwise />Sync Drive now</button></div></details>
    </header>

    <aside className="sidebar"><nav aria-label="Drive navigation">{fileNav.map(([label, Icon, supported]) => <button key={label} className={section === label ? "active" : ""} disabled={!supported} title={supported ? label : `${label} is not available yet`} onClick={() => showSection(label)}><Icon />{label}</button>)}</nav></aside>
    <div className="workspace">
      {fileSection ? <>
        {!grid && <div className="file-head"><span><input type="checkbox" aria-label="Select all visible files" checked={allVisibleSelected} onChange={toggleVisibleSelection} />Name <ArrowUp /></span><span>Size</span><span>Type</span><span>Date modified</span><span>Verified on</span><span aria-label="Actions" /></div>}
        {section === "Tags" && <nav className="drive-tag-filters" aria-label="Filter Drive by tag">
          {availableTags.map((tag) => <button key={tag} aria-pressed={selectedTag === tag} onClick={() => setSelectedTag(tag)}><Circle weight="duotone" style={{ color: tagColors[tag] || "#626d73" }} />{tag}</button>)}
          <button aria-pressed={!selectedTag} onClick={() => setSelectedTag("")}><Circle />All</button>
        </nav>}
        <div className={grid ? "file-grid" : "file-list"}>{visible.map((file) => {
          const relative = file.path || [...segments, file.name].join("/");
          const labels = fileLabels[`${labelsRoot}/${relative}`] || { favorite: false, tags: [] };
          return <div className={selected === file || selectedPaths.includes(relative) ? "file-row selected" : "file-row"} key={relative}>
            <input className="file-select" type="checkbox" aria-label={`Select ${file.name}`} checked={selectedPaths.includes(relative)} onChange={() => { toggleSelected(relative); setSelectedName(file.path || file.name); }} /><button className="name" onClick={() => setSelectedName(file.path || file.name)} onDoubleClick={() => file.directory && go(relative)}><FileIcon file={file} /><span>{file.name}{labels.favorite && <Star aria-label="Favorite" weight="fill" />}{labels.tags.length > 0 && <small className="file-tag-labels">{labels.tags.join(" · ")}</small>}</span></button><span>{formatSize(file.size)}</span><span>{file.directory ? "Folder" : `${file.type} document`}</span><span>{formatDate(file.modified)}</span><span className={verifiedOn ? "verified" : ""}>{verifiedOn ? <CheckCircle weight="fill" /> : <Clock />}{verifiedOn || "Not checked"}</span>
            {labelsReady ? <FileActions file={file} path={relative} labels={labels} tags={availableTags} tagColors={tagColors} fixture={fixture} onChanged={async () => { await refreshLabels(); if (section !== "Home") await showSection(section); else await onNavigate(path); }} /> : <button disabled aria-label={`Actions unavailable for ${file.name}`}><DotsThreeVertical /></button>}
          </div>;
        })}{!visible.length && <p className="list-empty">{section === "Tags" ? (query ? "No tagged files match your search." : selectedTag ? `No files tagged “${selectedTag}”.` : "No tagged files yet. Add tags from a file's ⋮ menu.") : "No files in this Drive folder yet."}</p>}</div>
        {selectedItems.length > 0 && <div className="file-selection-toolbar" role="toolbar" aria-label="Selected Drive file actions"><strong>{selectedItems.length} selected</strong><BulkFileActions items={selectedItems} tags={availableTags} tagColors={tagColors} fixture={fixture} onClear={() => setSelectedPaths([])} onChanged={async () => { await refreshLabels(); if (section !== "Home") await showSection(section); else await onNavigate(path); }} /><button onClick={() => setSelectedPaths([])}>Clear selection</button></div>}
        <footer className="count" role="status">{navigationError || `${visible.length} ${section === "Recent" ? "recent " : ""}items · ${state.deviceName}`}</footer>
      </> : <div className="empty-state"><WarningCircle /><h2>{section}</h2><p>Deleted items are in the system Trash. Restore them using the desktop file manager; no permanent-delete action is exposed here.</p><DesktopAction action="open-trash" fixture={fixture} /></div>}
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

function PhotosView({ photos, collections: collectionFolders, root, verifiedOn, fixture, more, onLoadMore, onRefresh, onNewCollection, imageEditor }: { photos: PhotoItem[]; collections: string[]; root: string; verifiedOn: string; fixture: boolean; more: boolean; onLoadMore: () => Promise<void>; onRefresh: () => Promise<void>; onNewCollection: () => void; imageEditor: boolean }) {
  const [labels, setLabels] = useState<Record<string, FileLabels>>({}), [tags, setTags] = useState<string[]>([]), [tagColors, setTagColors] = useState<TagColors>({});
  const [labelsReady, setLabelsReady] = useState(fixture);
  const [selectedTag, setSelectedTag] = useState("");
  const refreshLabels = async () => {
    if (fixture) return;
    const response = await fetch("/api/v1/file-labels"); if (!response.ok) throw new Error("Photo labels unavailable");
    const data = await response.json() as { items: Record<string, FileLabels>; tags?: string[]; tagColors?: TagColors };
    setLabels(data.items); setTags(data.tags || []); setTagColors(data.tagColors || {}); setLabelsReady(true);
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
  const groupedCollections = useMemo(() => groupPhotos(filtered, (item) => isScreenshot(item) ? "Screenshots" : item.collection || "Unsorted"), [filtered]);
  const collections = useMemo(() => [...new Set([...collectionFolders, ...groupedCollections.keys()])].sort((a, b) => a.localeCompare(b)), [collectionFolders, groupedCollections]);
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
      <select className="photo-sort" aria-label="Sort photos" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option></select><PhotoExport fixture={fixture} library="Photos" browse /><button onClick={() => void refresh().catch((error: Error) => setLoadStatus(error.message))} aria-label="Refresh photos"><ArrowsClockwise /></button>
      <div className="photo-selection-toolbar" role="toolbar" aria-label="Photo actions">
        {selected ? <><span className="selected-photo-name" title={selected.name}>{selected.name}</span><button onClick={() => setViewer(true)}>View</button>{selected.source !== "Screenshots" && labelsReady ? <FileActions key={mediaKey(selected)} toolbar file={{...selected,directory:false}} path={selected.path} library="Photos" labels={labels[`${root}/${selected.path}`] || {favorite:false,tags:[]}} tags={tags} tagColors={tagColors} fixture={fixture} onChanged={refresh} /> : <span>Original folder · read-only here</span>}<button onClick={() => setSelectedPath("")}>Clear selection</button></> : <span>Select an image using its circle to show file actions. Click an image to view it.</span>}
      </div>
    </header>

    <aside className="photo-sidebar"><nav aria-label="Photos navigation">
      {photoNav.map(([label, Icon]) => <button key={label} className={section === label && !collection ? "active" : ""} onClick={() => navigate(label)}><Icon />{label}</button>)}
    </nav><p title={collection === "Screenshots" ? "Shown in place, not automatically imported or backed up" : root}>{collection === "Screenshots" ? screenshotsRoot : root || "No Photos root configured"}</p></aside>

    <div className="photo-content">
      {section === "Tags" && <label>Tag <select aria-label="Filter photo tag" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>}
      {loadStatus && <p role="status">{loadStatus}</p>}
      {(collection === "Screenshots" ? !!screenshotsCursor || more : more) && <div className="photo-page-status" role="status"><span>{sourceItems.length} loaded · Search covers loaded items.</span><button className="secondary" disabled={loadStatus === "Loading…"} onClick={async () => { setLoadStatus("Loading…"); try { if (collection === "Screenshots" && screenshotsCursor) await loadScreenshots(screenshotsCursor); else await onLoadMore(); setLoadStatus(""); } catch (error) { setLoadStatus(error instanceof Error ? error.message : "Loading failed"); } }}>Load more</button></div>}
      {section === "Trash" ? <section><h2>Photo Trash</h2><p>Deleted photos use the system Trash. Restore them there, then refresh Photos. This opens the shared system Trash, not a photos-only list.</p><DesktopAction action="open-trash" fixture={fixture} /></section> : section === "Collections" && !collection ? <><button className="secondary collection-create" onClick={onNewCollection}><Folder />New collection</button><div className="collection-grid"><button className="collection-card collection-shortcut" onClick={() => navigate("Photos")}><span className="photo-thumb"><ImageSquare size={48} weight="duotone" /></span><strong>Photos</strong><small>{photos.filter((item) => item.type === "Photo").length} loaded photos</small></button><button className="collection-card collection-shortcut" onClick={() => navigate("Videos")}><span className="photo-thumb"><Video size={48} weight="duotone" /></span><strong>Videos</strong><small>{photos.filter((item) => item.type === "Video").length} loaded videos</small></button><button className="collection-card" onClick={() => { setCollection("Screenshots"); setSelectedPath(""); setQuery(""); }}><span className="screenshot-example"><Desktop size={48} /></span><strong>Screenshots</strong><small>Pictures folder + imported screenshots</small></button>{collections.filter((name) => name !== "Screenshots" && name !== "Unsorted").map((name) => { const items = groupedCollections.get(name) || []; return <button className="collection-card" key={name} onClick={() => { setSection("Timeline"); setCollection(name); setQuery(""); setSelectedPath(""); }}><span className="photo-thumb" style={items[0] ? imageStyle(items[0]) : undefined}>{items[0]?.type === "Video" ? <PlayCircle weight="fill" /> : !items[0] && <Folder size={48} />}</span><strong>{name}</strong><small>{items.length} items</small></button>; })}</div></>
      : filtered.length ? Array.from(collection ? new Map([[collection, filtered]]) : groups, ([label, items]) => <section className="photo-month" key={label}>{!collection && <header><h2>{label}</h2><span>{items.length} items</span></header>}<div className="photo-grid">{items.map((item) => <div className="photo-item" key={mediaKey(item)}><button className={`photo-tile ${selected && mediaKey(selected) === mediaKey(item) ? "selected" : ""}`} onClick={() => { setSelectedPath(mediaKey(item)); setViewer(true); }} aria-label={`View ${item.name}`}>{fixture ? <span className="photo-thumb" style={imageStyle(item)} /> : item.type === "Photo" ? <img className="photo-thumb" loading="lazy" src={mediaUrl(item)} alt={item.name} /> : <span className="photo-thumb"><PlayCircle weight="fill" /></span>}</button><button className="photo-select" aria-label={`Select ${item.name}`} aria-pressed={!!selected && mediaKey(selected) === mediaKey(item)} onClick={() => setSelectedPath(selected && mediaKey(selected) === mediaKey(item) ? "" : mediaKey(item))}><CheckCircle weight={selected && mediaKey(selected) === mediaKey(item) ? "fill" : "regular"} /></button></div>)}</div></section>)
      : <div className="photo-empty"><Images /><h2>No media here yet</h2><p>{root ? "Try another filter or add files to the Photos folder." : "Configure a Photos route to start the shared library."}</p></div>}
    </div>

    {viewer && selected && <PhotoViewer items={filtered} selected={selected} onSelect={(item) => setSelectedPath(mediaKey(item))} onClose={() => setViewer(false)} fixture={fixture} imageStyle={imageStyle} imageEditor={imageEditor} />}
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

function NewFolderDialog({ parent, library = "Drive", onClose, onCreated }: { parent: string; library?: "Drive" | "Photos"; onClose: () => void; onCreated: () => Promise<void> }) {
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
      const response = await fetch("/api/v1/create-folder", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ root: library, parent, name }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Folder could not be created");
      await onCreated(); onClose();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Folder could not be created"); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-title">
    <header><div><h1 id="folder-title">{library === "Photos" ? "New collection" : "New folder"}</h1><p>Location: {library}{parent ? ` / ${parent}` : ""}</p></div><button onClick={onClose} aria-label="Close new folder dialog">×</button></header>
    <label>Folder name<input autoFocus value={name} onChange={(event) => { setName(event.target.value); setStatus(""); }} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) create(); }} /></label>
    {status && status !== "Creating…" && <p className="dialog-error" role="alert">{status}</p>}
    <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim() || status === "Creating…"} onClick={create}>{status === "Creating…" ? status : "Create folder"}</button></div>
  </section></div>;
}

function RelationshipWizard({ device, state, fixture, initialContent, onSaved, onClose }: { device: Device; state: ApiState; fixture: boolean; initialContent?: "Drive" | "Photos"; onSaved: (route?: Route) => Promise<void> | void; onClose: () => void }) {
  const [scope, setScope] = useState<"Drive" | "Photos" | "Both">(initialContent || "Drive"), [step, setStep] = useState<"scope" | "route">(initialContent ? "route" : "scope");
  const laptop = state.storages.find((storage) => storage.id === "local")?.label || "Laptop";
  return <div className="modal-backdrop" role="presentation"><section className="relationship-wizard" role="dialog" aria-modal="true" aria-labelledby="relationship-title">
    <header><div><h1 id="relationship-title">Edit connection map</h1><p>{device.label} is now available as a storage node.</p></div><button onClick={onClose} aria-label="Close connection editor">×</button></header>
    <ConnectionMap state={{ ...state, routes: state.routes.filter((route) => route.storageId === device.id) }} contentType={scope === "Both" ? undefined : scope} pendingDevice={device} />
    {step === "scope" && <div className="wizard-question"><h2>Connect {device.label} with {laptop}</h2><p>Only relationships the app can transfer safely today are shown.</p><div className="scope-choices"><button onClick={() => { setScope("Drive"); setStep("route"); }}><Folder weight="duotone" /><strong>Drive</strong><small>Files only</small></button><button onClick={() => { setScope("Photos"); setStep("route"); }}><Images weight="duotone" /><strong>Photos</strong><small>Photos &amp; videos only</small></button><button onClick={() => { setScope("Both"); setStep("route"); }}><ShareNetwork weight="duotone" /><strong>Drive and Photos</strong><small>Configure both maps</small></button></div></div>}
    {step === "route" && <><h2>{device.label} ↔ {laptop} · {scope}</h2><RouteSetup key={scope} state={state} fixture={fixture} scope={scope} preferredStorageId={device.id} onSaved={onSaved} onCommitted={onClose} /></>}
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
  const [photoCollections, setPhotoCollections] = useState<string[]>(fixture ? ["Summer 2026", "Family"] : []);
  const [photosCursor, setPhotosCursor] = useState("");
  const loadMorePhotos = async () => {
    if (!photosCursor || fixture) return;
    const response = await fetch(`/api/v1/photos?after=${encodeURIComponent(photosCursor)}`);
    if (!response.ok) throw new Error("Photos unavailable; retry when the API is connected.");
    const page = await response.json() as PhotosResponse;
    setPhotos((current) => Array.from(new Map([...current, ...page.items].map((item) => [item.path, item])).values()));
    setPhotosCursor(page.nextCursor || ""); setPhotoCollections(page.collections || []);
  };
  const [photosRoot, setPhotosRoot] = useState(fixture ? "Local Drive/Photos" : "");
  const [photosVerifiedOn, setPhotosVerifiedOn] = useState(fixture ? "T7" : "");
  const [libraryUsage, setLibraryUsage] = useState<LibraryUsage>(fixture ? demoUsage : emptyUsage);
  const [problems, setProblems] = useState<ProblemsResponse>(fixture ? demoProblems : { total: 0, counts: {}, items: [], history: [] });
  const [checkedAt, setCheckedAt] = useState("not yet");
  const [relationshipStorage, setRelationshipStorage] = useState<Device | null>(null);
  const [relationshipContent, setRelationshipContent] = useState<"Drive" | "Photos" | undefined>();
  const [connectionPickerContent, setConnectionPickerContent] = useState<"Drive" | "Photos" | undefined>();

  const checkConnections = async () => {
    if (fixture) return setCheckedAt("just now");
    try { await fetch("/api/v1/refresh-connections"); await new Promise((resolve) => setTimeout(resolve, 600)); } catch { /* state request below reports the failure */ }
    return Promise.all([
      fetch("/api/v1/state").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ApiState>; }),
      fetch("/api/v1/problems").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<ProblemsResponse>; }),
      fetch("/api/v1/library-usage").then((response) => { if (!response.ok) throw new Error("Library usage unavailable"); return response.json() as Promise<LibraryUsage>; }),
    ])
      .then(([nextState, nextProblems, nextUsage]) => {
        setState(nextState);
        setProblems(nextProblems);
        setLibraryUsage(nextUsage);
        setCheckedAt(`at ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
      })
      .catch(() => setState((current) => ({ ...current, ready: false, error: "Local API unavailable" })));
  };

  const refreshLibraryUsage = async () => {
    if (fixture) return;
    const response = await fetch("/api/v1/library-usage");
    if (!response.ok) throw new Error("Library usage unavailable");
    setLibraryUsage(await response.json() as LibraryUsage);
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

  const updateRouteCard = async (route: Route, mode: "Copy" | "Move", keepPolicy: string, cache: boolean, cacheLimitPercent = route.cacheLimitPercent ?? 80) => {
    if (!fixture) {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/update-route-card", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: route.id, mode, keepPolicy, cache, cacheLimitPercent }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Connection could not be saved");
      return routeSaved();
    }
    setState((current) => ({ ...current, incomingConnections: current.incomingConnections?.map((item) => item.routeId === route.id ? { ...item, cacheEnabled: cache, limitPercent: cacheLimitPercent } : item), routes: current.routes.map((item) => item.id === route.id ? { ...item, behavior: mode, keepPolicy, stagingMaxBytes: cache ? 1 : 0, cacheLimitPercent } : item), configRevision: current.configRevision + 1 }));
  };

  const addConnection = (content: "Drive" | "Photos") => {
    setConnectionPickerContent(content);
  };

  const setupStorage = async (id: string) => {
    const device = state.firstSeenDevices?.find((item) => item.id === id) || state.storages.find((item) => item.id === id);
    if (!device) return;
    try {
      if (!fixture) {
        const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local session unavailable");
        const { token } = await session.json() as { token: string };
        const response = await fetch("/api/v1/device-onboarding", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ id: device.id, participate: true }) });
        const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Device could not be added");
      }
      setState((current) => ({ ...current, firstSeenDevices: (current.firstSeenDevices || []).filter((item) => item.id !== device.id) }));
      setActiveTab("settings"); setRelationshipStorage({ ...device, category: "storage", kind: "Storage" });
    } catch (error) { setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Device could not be added" })); }
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
      fetch("/api/v1/library-usage").then((response) => { if (!response.ok) throw new Error("API unavailable"); return response.json() as Promise<LibraryUsage>; }),
    ]).then(([nextState, nextFiles, nextPhotos, nextProblems, nextUsage]) => { setState(nextState); setFiles(nextFiles.items); setFilePath(nextFiles.currentPath); setVerifiedOn(nextFiles.verifiedOn); setPhotos(nextPhotos.items); setPhotoCollections(nextPhotos.collections || []); setPhotosRoot(nextPhotos.root); setPhotosVerifiedOn(nextPhotos.verifiedOn); setProblems(nextProblems); setLibraryUsage(nextUsage); }).catch(() => setState((current) => ({ ...current, ready: false, error: "Local API unavailable" })));
  }, [fixture]);

  useEffect(() => {
    if (fixture) return;
    const timer = window.setInterval(() => fetch("/api/v1/state").then((response) => response.ok ? response.json() as Promise<ApiState> : Promise.reject()).then(setState).catch(() => setState((current) => ({ ...current, ready: false, error: "Local service unavailable — displayed data is last reported, not a live status" }))), 2000);
    return () => window.clearInterval(timer);
  }, [fixture]);

  return <main className="app-shell">
    <header className="app-title"><img src={logo} alt="Local Drive" /><strong>Local Drive</strong>{fixture && <small className="demo-notice" role="status">Demo · simulated data and actions · <a href="/">Open live application</a></small>}</header>
    <TopTabs active={activeTab === "problems" ? "sync" : activeTab} onChange={setActiveTab} />
    {activeTab === "sync" && <SyncView state={state} usage={libraryUsage} onUsageRefresh={refreshLibraryUsage} onRefresh={routeSaved} checkedAt={checkedAt} onCheck={checkConnections} onMount={mountStorage} onSettings={() => setActiveTab("settings")} onSetupStorage={(id) => void setupStorage(id)} onProblems={() => { refreshProblems(); setActiveTab("problems"); }} />}
    {activeTab === "files" && <FilesView files={files} path={filePath} state={state} verifiedOn={verifiedOn} fixture={fixture} onNavigate={navigateFiles} onNewFolder={() => setFolderOpen(true)} onSyncDrive={() => setDriveSyncOpen(true)} onNewFile={setTemplatesOpen} />}
    {activeTab === "photos" && <PhotosView photos={photos} collections={photoCollections} root={photosRoot} verifiedOn={photosVerifiedOn} fixture={fixture} more={!!photosCursor} imageEditor={!!state.capabilities?.imageEditor} onLoadMore={loadMorePhotos} onRefresh={async () => { if (fixture) return; const response = await fetch("/api/v1/photos"); if (!response.ok) throw new Error("Photos unavailable"); const page = await response.json() as PhotosResponse; setPhotos(page.items); setPhotoCollections(page.collections || []); setPhotosRoot(page.root); setPhotosCursor(page.nextCursor || ""); }} onNewCollection={() => setFolderOpen(true)} />}
    {activeTab === "new" && <NewView capabilities={state.capabilities} onImport={() => setImportOpen(true)} />}
    {activeTab === "settings" && <SettingsView state={state} fixture={fixture} onRefresh={routeSaved} onRouteUpdate={updateRouteCard} onAdd={addConnection} onHubSave={saveHubConfig} onMount={mountStorage} />}
    {driveSyncOpen && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") setDriveSyncOpen(false); }}><section className="templates-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-sync-title"><button autoFocus className="secondary" onClick={() => setDriveSyncOpen(false)}>Close</button><h1 id="drive-sync-title">Sync Drive now</h1><p>Preview and confirm each Drive connection. Photos are not included. Closing this window does not cancel a running transfer.</p>{state.routes.filter((route) => route.contentType === "Drive").map((route) => <section key={route.id}><h2>{state.storages.find((storage) => storage.id === route.storageId)?.label || "Storage"}</h2><RoutePreviewButton route={route} fixture={fixture} /></section>)}{!state.routes.some((route) => route.contentType === "Drive") && <p>No Drive connection is configured. Add one in Sync &amp; Connections.</p>}</section></div>}
    {templatesOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplatesOpen(null); }} onKeyDown={(event) => { if (event.key === "Escape") setTemplatesOpen(null); }}><section className="templates-dialog" role="dialog" aria-modal="true" aria-label="New file from template"><button autoFocus className="secondary" onClick={() => { setTemplatesOpen(null); navigateFiles(filePath); }}>Close templates</button><TemplateView lastDrivePath={filePath} fixture={fixture} initialTemplate={templatesOpen} /></section></div>}
    {activeTab === "problems" && <ProblemsView problems={problems} onBack={() => setActiveTab("sync")} onAction={applyProblemAction} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onPreviewComplete={refreshProblems} />}
    {folderOpen && <NewFolderDialog parent={activeTab === "photos" ? "" : filePath} library={activeTab === "photos" ? "Photos" : "Drive"} onClose={() => setFolderOpen(false)} onCreated={async () => { if (activeTab === "photos") { const response = await fetch("/api/v1/photos"); if (!response.ok) throw new Error("Photos unavailable"); const page = await response.json() as PhotosResponse; setPhotos(page.items); setPhotoCollections(page.collections || []); setPhotosRoot(page.root); setPhotosCursor(page.nextCursor || ""); } else await navigateFiles(filePath); }} />}
    {connectionPickerContent && <DevicePicker state={state} content={connectionPickerContent} onClose={() => setConnectionPickerContent(undefined)} onChoose={(device) => { setRelationshipContent(connectionPickerContent); setRelationshipStorage(device); setConnectionPickerContent(undefined); }} />}
    {relationshipStorage && <RelationshipWizard device={relationshipStorage} state={state} fixture={fixture} initialContent={relationshipContent} onSaved={routeSaved} onClose={() => { setRelationshipStorage(null); setRelationshipContent(undefined); }} />}
  </main>;
}
