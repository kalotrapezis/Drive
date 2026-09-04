import { useRef, useState } from "react";
import { Tag } from "@phosphor-icons/react";
import { createPortal } from "react-dom";

export function NewTag({ fixture, onSaved }: { fixture: boolean; onSaved?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(""), [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    if (fixture) { setStatus("Demo only. Open the live app to save tags."); return; }
    setBusy(true);
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ action: "create-tag", tag: name }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Tag could not be saved");
      setStatus(`Created “${name.trim()}”. Assign it from an item's ⋮ menu.`); setName(""); onSaved?.();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save tag"); }
    finally { setBusy(false); }
  };
  return <><button onClick={() => { setStatus(""); dialog.current?.showModal(); }}><Tag />New tag</button>{createPortal(<dialog ref={dialog} className="item-action-dialog" aria-label="New tag" onCancel={(event) => { if (busy) event.preventDefault(); }}><form onSubmit={(event) => { event.preventDefault(); void save(); }}><h2>New tag</h2><label>Name<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><p>Available to files and photos on this laptop. Cross-device label synchronization is not enabled yet.</p>{status && <p role="status">{status}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Close</button><button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Create tag"}</button></div></form></dialog>, document.body)}</>;
}
