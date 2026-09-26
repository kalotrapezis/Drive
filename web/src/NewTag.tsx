import { useRef, useState } from "react";
import { Tag } from "@phosphor-icons/react";
import { createPortal } from "react-dom";

export function NewTag({ fixture, onSaved }: { fixture: boolean; onSaved?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const colors = ["#b65470", "#387fa2", "#438260", "#8262a8", "#a06c28", "#626d73"];
  const [name, setName] = useState(""), [color, setColor] = useState(colors[1]), [status, setStatus] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    if (fixture) { setStatus("Demo only. Open the live app to save tags."); return; }
    setBusy(true);
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ action: "create-tag", tag: name, color }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Tag could not be saved");
      const savedName = name.trim(); setName(""); setStatus(""); setNotice(`Tag “${savedName}” created`); dialog.current?.close(); onSaved?.();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save tag"); }
    finally { setBusy(false); }
  };
  return <><button onClick={() => { setStatus(""); setNotice(""); dialog.current?.showModal(); }}><Tag />New tag</button>{createPortal(<><dialog ref={dialog} className="item-action-dialog" aria-label="New tag" onCancel={(event) => { if (busy) event.preventDefault(); }}><form onSubmit={(event) => { event.preventDefault(); void save(); }}><h2>New tag</h2><label>Name<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><fieldset className="tag-colors"><legend>Color</legend>{colors.map((value) => <label key={value} title={value}><input type="radio" name="tag-color" value={value} checked={color === value} onChange={() => setColor(value)} /><span style={{ backgroundColor: value }} /></label>)}</fieldset><p>Available to files and photos on this laptop. Cross-device label synchronization is not enabled yet.</p>{status && <p role="alert">{status}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Create tag"}</button></div></form></dialog>{notice && <div className="app-toast" role="status"><Tag weight="fill" />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button></div>}</>, document.body)}</>;
}
