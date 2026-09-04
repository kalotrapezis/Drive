import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";

export function PhotoExport({ fixture }: { fixture: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [storages, setStorages] = useState<{ id: string; label: string }[]>([]), [storage, setStorage] = useState("");
  const [name, setName] = useState(`Photos-${new Date().toISOString().slice(0, 10)}.ldrive`);
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [operation, setOperation] = useState("");
  const open = async () => {
    dialog.current?.showModal(); if (operation) return;
    try {
      if (fixture) { setStorages([{ id: "demo", label: "T7 · demo" }]); setStorage("demo"); return; }
      const response = await fetch("/api/v1/state"); if (!response.ok) throw new Error("Local service unavailable");
      const state = await response.json() as { storages: { id: string; label: string; present?: boolean }[]; photoExports?: { id: string; state: string }[] };
      const active = state.photoExports?.find((job) => !["transferred", "failed"].includes(job.state));
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
        if (event.state === "failed" || event.state === "transferred") { setBusy(false); setOperation(""); return; }
        timer = window.setTimeout(poll, 750);
      } catch (error) { if (!cancelled) { setStatus(error instanceof Error ? error.message : "Export status unavailable"); timer = window.setTimeout(poll, 2000); } }
    }; void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [operation]);
  const start = async () => {
    if (fixture) { setStatus("Demo only — no archive is written. Open the live application to export."); return; }
    setBusy(true); setStatus("Starting…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ action: "export-photos", storageId: storage, name }) });
      const result = await response.json() as { id?: string; error?: string }; if (!response.ok || !result.id) throw new Error(result.error || "Export could not start"); setOperation(result.id);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Export failed"); setBusy(false); }
  };
  return <><button onClick={() => void open()}><ArrowSquareOut />Export photo library</button><dialog ref={dialog} className="item-action-dialog" aria-label="Export photo library"><h2>Export photo library</h2><p>Creates a ZIP64 / Zstandard .ldrive snapshot with a manifest and SHA-256 verification. Originals stay intact; existing archives are never replaced.</p><label>Storage<select disabled={busy} value={storage} onChange={(event) => setStorage(event.target.value)}>{storages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Archive name<input disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label><p>Keep this application running and storage connected until verification finishes. Images and videos may compress very little. In-app archive browsing/extraction is not yet available.</p>{status && <p role="status">{status}</p>}<div className="dialog-actions"><button onClick={() => dialog.current?.close()}>Close</button><button className="primary" disabled={busy || !!operation || !storage || !name.endsWith(".ldrive")} onClick={() => void start()}>Export and verify</button></div></dialog></>;
}
