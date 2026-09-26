import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, FileArchive, PlayCircle } from "@phosphor-icons/react";
import { PhotoViewer, mediaKey, mediaUrl, type GalleryPhoto } from "./PhotoViewer";

type Library = "Drive" | "Photos";
type Archive = { storageId: string; storage: string; name: string; size: number; modified: string; library: Library };
type ArchiveItem = { path: string; name: string; size: number; modified: string; dateSource: string; type: "Photo" | "Video" | "Other"; collection: string };

export function PhotoExport({ fixture, library = "Photos", browse = false }: { fixture: boolean; library?: Library; browse?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), archiveDialog = useRef<HTMLDialogElement>(null);
  const label = library === "Photos" ? "Photos & Videos" : "Drive Files";
  const [storages, setStorages] = useState<{ id: string; label: string }[]>([]), [storage, setStorage] = useState("");
  const [name, setName] = useState(`${library}-${new Date().toISOString().slice(0, 10)}.ldrive`);
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [operation, setOperation] = useState("");
  const [mode, setMode] = useState<"Copy" | "Move">("Copy"), [moveReady, setMoveReady] = useState<{ storageId: string; name: string } | null>(null), [cleanupBusy, setCleanupBusy] = useState(false);
  const [archives, setArchives] = useState<Archive[]>([]), [archive, setArchive] = useState<Pick<Archive, "storageId" | "name"> | null>(null);
  const [items, setItems] = useState<ArchiveItem[]>([]), [selected, setSelected] = useState<GalleryPhoto | null>(null), [archiveStatus, setArchiveStatus] = useState("");

  const openExport = async () => {
    dialog.current?.showModal(); if (operation) return;
    try {
      if (fixture) { setStorages([{ id: "demo", label: "T7 · demo" }]); setStorage("demo"); return; }
      const response = await fetch("/api/v1/state"); if (!response.ok) throw new Error("Local service unavailable");
      const state = await response.json() as { storages: { id: string; label: string; present?: boolean }[]; archiveExports?: { id: string; state: string }[] };
      const active = state.archiveExports?.find((job) => !["transferred", "failed"].includes(job.state));
      if (active) { setOperation(active.id); setBusy(true); }
      const available = state.storages.filter((item) => item.present); setStorages(available); setStorage(available[0]?.id || "");
      if (!available.length) setStatus("Connect and mount destination storage first.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Storage unavailable"); }
  };
  useEffect(() => {
    if (!operation) return;
    let cancelled = false, timer: number;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/route-preview?id=${encodeURIComponent(operation)}`); if (!response.ok) throw new Error("Export status unavailable. Do not retry until you check the destination.");
        const event = await response.json() as { state: string; result?: string; path?: string; filesDone?: number; filesTotal?: number };
        if (cancelled) return;
        setStatus(event.result ? `${event.result}${event.path ? ` ${event.path}` : ""}` : `${event.state} · ${event.filesDone || 0} / ${event.filesTotal || "…"} files`);
        if (event.state === "failed" || event.state === "transferred") { if (event.state === "transferred" && mode === "Move") setMoveReady({ storageId: storage, name }); setBusy(false); setOperation(""); return; }
        timer = window.setTimeout(poll, 750);
      } catch (error) { if (!cancelled) { setStatus(error instanceof Error ? error.message : "Export status unavailable"); timer = window.setTimeout(poll, 2000); } }
    }; void poll(); return () => { cancelled = true; window.clearTimeout(timer); };
  }, [operation]);
  const start = async () => {
    if (fixture) { setStatus("Demo only — no archive is written. Open the live application to export."); return; }
    setBusy(true); setMoveReady(null); setStatus("Starting…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ action: "export-archive", root: library, storageId: storage, name }) });
      const result = await response.json() as { id?: string; error?: string }; if (!response.ok || !result.id) throw new Error(result.error || "Export could not start"); setOperation(result.id);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Export failed"); setBusy(false); }
  };
  const moveOriginals = async (target: { storageId: string; name: string }) => {
    if (!window.confirm("Move only originals that still exactly match this verified archive to the system Trash? Nothing is permanently deleted.")) return;
    setCleanupBusy(true); setStatus("Rechecking every original before moving…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable"); const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/archive-cleanup", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify(target) });
      const result = await response.json() as { error?: string; message?: string; moved?: number }; if (!response.ok || result.error) throw new Error(result.error || "Originals could not be moved");
      const message = result.message || `${result.moved || 0} originals moved to Trash.`; setStatus(message); setArchiveStatus(message); setMoveReady(null);
    } catch (error) { const message = error instanceof Error ? error.message : "Originals could not be moved"; setStatus(message); setArchiveStatus(message); }
    finally { setCleanupBusy(false); }
  };
  const openArchive = async () => {
    archiveDialog.current?.showModal(); setArchiveStatus("Loading archives…"); setArchive(null); setItems([]); setSelected(null);
    if (fixture) { setArchiveStatus("Demo mode has no physical archive."); return; }
    try { const response = await fetch(`/api/v1/archives?root=${library}`); if (!response.ok) throw new Error("Archives are unavailable"); const result = await response.json() as { items: Archive[] }; setArchives(result.items); setArchiveStatus(result.items.length ? "Choose an archive." : `No ${label} archive is available on connected storage.`); } catch (error) { setArchiveStatus(error instanceof Error ? error.message : "Archives are unavailable"); }
  };
  const loadArchive = async (value: string) => {
    const chosen = archives.find((item) => `${item.storageId}\n${item.name}` === value) || null; setArchive(chosen ? { storageId: chosen.storageId, name: chosen.name } : null); setItems([]); setSelected(null); if (!chosen) return;
    setArchiveStatus("Reading archive index…");
    try { const response = await fetch(`/api/v1/archive?storageId=${encodeURIComponent(chosen.storageId)}&name=${encodeURIComponent(chosen.name)}`); const result = await response.json() as { error?: string; items?: ArchiveItem[] }; if (!response.ok || result.error) throw new Error(result.error || "Archive could not be opened"); setItems(result.items || []); setArchiveStatus("Read-only archive. Viewing uses a small temporary cache."); } catch (error) { setArchiveStatus(error instanceof Error ? error.message : "Archive could not be opened"); }
  };
  const media: GalleryPhoto[] = items.filter((item): item is ArchiveItem & { type: "Photo" | "Video" } => item.type === "Photo" || item.type === "Video").map((item) => ({ ...item, captured: item.modified, source: "Archive", archive: archive || undefined }));
  const browser = <dialog ref={archiveDialog} className="archive-browser" aria-label={`Open ${label} archive`}><header><div><h2>{label} archive</h2><p>Read-only verified library.</p></div><button onClick={() => archiveDialog.current?.close()} aria-label="Close archive browser">×</button></header><label>Archive<select value={archive ? `${archive.storageId}\n${archive.name}` : ""} onChange={(event) => void loadArchive(event.target.value)}><option value="">Choose archive</option>{archives.map((item) => <option key={`${item.storageId}/${item.name}`} value={`${item.storageId}\n${item.name}`}>{item.storage} · {item.name}</option>)}</select></label>{archiveStatus && <p role="status">{archiveStatus}</p>}{archive && <button className="secondary" disabled={cleanupBusy} onClick={() => void moveOriginals(archive)}>Move matching originals to Trash</button>}{library === "Drive" && items.length > 0 && <div className="archive-file-list">{items.map((item) => <article key={item.path}><FileArchive /><span><strong>{item.path}</strong><small>{new Intl.NumberFormat().format(item.size)} bytes · {new Date(item.modified).toLocaleDateString()}</small></span></article>)}</div>}{library === "Photos" && media.length > 0 && <div className="archive-grid">{media.map((item) => <button key={mediaKey(item)} onClick={() => setSelected(item)} aria-label={`View ${item.name}`}>{item.type === "Photo" ? <img loading="lazy" src={mediaUrl(item)} alt="" /> : <PlayCircle weight="fill" />}<span>{item.name}</span></button>)}</div>}{selected && <PhotoViewer items={media} selected={selected} onSelect={setSelected} onClose={() => setSelected(null)} fixture={false} imageStyle={() => undefined} imageEditor={false} />}</dialog>;
  if (browse) return <><button className="secondary" onClick={() => void openArchive()}><FileArchive />Open {library === "Photos" ? "photo archive" : "Drive archive"}</button>{browser}</>;
  return <><button onClick={() => void openExport()}><ArrowSquareOut />Export {library === "Photos" ? "photo archive" : "Drive archive"}</button><dialog ref={dialog} className="item-action-dialog" aria-label={`Export ${label} archive`}><h2>Export {label} archive</h2><p>Creates a ZIP64 / Zstandard .ldrive snapshot with a manifest and SHA-256 verification. Existing archives are never replaced.</p><label>Storage<select disabled={busy} value={storage} onChange={(event) => setStorage(event.target.value)}>{storages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Archive name<input disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label><fieldset disabled={busy}><legend>After verification</legend><label><input type="radio" checked={mode === "Copy"} onChange={() => setMode("Copy")} /> Copy — keep originals in {label}</label><label><input type="radio" checked={mode === "Move"} onChange={() => setMode("Move")} /> Move — recheck originals, then put them in system Trash</label></fieldset><p>Already compressed media may shrink very little. The archive is read-only.</p>{status && <p role="status">{status}</p>}{moveReady && <button className="secondary" disabled={cleanupBusy} onClick={() => void moveOriginals(moveReady)}>Move verified originals to Trash</button>}<div className="dialog-actions"><button onClick={() => dialog.current?.close()}>Close</button><button className="primary" disabled={busy || !!operation || !storage || !name.endsWith(".ldrive")} onClick={() => void start()}>Export and verify</button></div></dialog></>;
}
