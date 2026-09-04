import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DotsThreeVertical, PencilSimple, Copy, Folder, Star, Tag, Trash } from "@phosphor-icons/react";

export type FileLabels = { favorite: boolean; tags: string[] };
type Item = { name: string; directory: boolean; modified: string; size: number };

export function FileActions({ file, path, labels, tags, fixture, onChanged, library = "Drive", toolbar = false }: {
  file: Item; path: string; labels: FileLabels; tags: string[]; fixture: boolean; onChanged: () => Promise<void>; library?: "Drive" | "Photos"; toolbar?: boolean;
}) {
  const id = useId(), menu = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState("");
  const [destination, setDestination] = useState("");
  const [chosen, setChosen] = useState<string[]>([]), [newTag, setNewTag] = useState("");
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const open = (next: string) => {
    menu.current?.hidePopover(); setAction(next); setStatus(""); setChosen(labels.tags); setNewTag("");
    setDestination(next === "rename" ? file.name : path);
    dialog.current?.showModal();
  };
  const save = async () => {
    if (fixture) { setStatus("Demo only — no real files or labels are changed. Open the live app to apply this action."); return; }
    setBusy(true); setStatus("");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({
        action: action === "favorite" || action === "tags" ? "labels" : action, root: library, path, modified: file.modified, size: file.size,
        destination: action === "rename" ? parent + destination : destination,
        favorite: action === "favorite" ? !labels.favorite : labels.favorite,
        tags: action === "tags" ? [...new Set([...chosen, ...(newTag.trim() ? [newTag.trim()] : [])])] : labels.tags,
      }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Action failed; refresh Drive before retrying");
      setStatus("Saved. Refreshing Drive…");
      await onChanged(); dialog.current?.close();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  };
  return <>
    {toolbar ? <div className="media-file-actions" role="group" aria-label={`Actions for ${file.name}`}>
      <button title="Rename" aria-label="Rename selected image" onClick={() => open("rename")}><PencilSimple /></button>
      <button title="Copy" aria-label="Copy selected image" onClick={() => open("copy")}><Copy /></button>
      <button title="Move" aria-label="Move selected image" onClick={() => open("move")}><Folder /></button>
      <button title={labels.favorite ? "Remove favorite" : "Add favorite"} aria-label="Favorite selected image" aria-pressed={labels.favorite} onClick={() => open("favorite")}><Star weight={labels.favorite ? "fill" : "regular"} /></button>
      <button title="Tags" aria-label="Tag selected image" onClick={() => open("tags")}><Tag /></button>
      <button title="Move to Trash" aria-label="Trash selected image" onClick={() => open("trash")}><Trash /></button>
    </div> : <button className="item-menu-trigger" aria-label={`Actions for ${file.name}`} popoverTarget={id} onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 310)) });
    }}><DotsThreeVertical /></button>}
    {createPortal(<>
      <div ref={menu} id={id} popover="auto" className="item-action-popover" style={position} aria-label={`Actions for ${file.name}`}>
        <strong>{file.name}</strong>
        <button onClick={() => open("rename")}><PencilSimple />Rename</button>
        <button onClick={() => open("copy")} disabled={file.directory} title={file.directory ? "Folder copy is not supported yet" : "Copy and verify inside Drive"}><Copy />Copy…</button>
        <button onClick={() => open("move")}><Folder />Move…</button>
        <button onClick={() => open("favorite")}><Star weight={labels.favorite ? "fill" : "regular"} />{labels.favorite ? "Remove from favorites" : "Add to favorites"}</button>
        <button onClick={() => open("tags")}><Tag />Add to tags…</button>
        <button className="danger" onClick={() => open("trash")}><Trash />Delete · Move to Trash</button>
      </div>
      <dialog ref={dialog} className="item-action-dialog" aria-label={`${action} ${file.name}`} onCancel={(event) => { if (busy) event.preventDefault(); }}>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h2>{action === "tags" ? "File tags" : action === "favorite" ? (labels.favorite ? "Remove from favorites" : "Add to favorites") : action === "trash" ? "Move to Trash?" : action === "rename" ? "Rename" : action === "move" ? "Move" : "Copy"}</h2>
          <p>{file.name}</p>
          {["rename", "move", "copy"].includes(action) && <label>{action === "rename" ? "New name" : `Destination path inside ${library} (including filename)`}<input autoFocus required value={destination} onChange={(event) => setDestination(event.target.value)} /></label>}
          {(action === "move" || action === "copy") && <small>Use an existing folder, e.g. Documents/{file.name}. Existing files are never replaced. Cross-device transfers use Sync &amp; Connections.</small>}
          {action === "trash" && <p>The item goes to the system Trash, including its contents if it is a folder. Restore it using your desktop file manager. This is not permanent deletion.</p>}
          {action === "tags" && <><fieldset><legend>Choose tags</legend>{[...new Set([...tags, ...chosen])].sort().map((tag) => <label key={tag}><input type="checkbox" checked={chosen.includes(tag)} onChange={(event) => setChosen(event.target.checked ? [...chosen, tag] : chosen.filter((value) => value !== tag))} />{tag}</label>)}{!tags.length && !chosen.length && <p>No tags yet. Create the first one below.</p>}</fieldset><label>New tag<input maxLength={80} value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="e.g. Medical" /></label></>}
          {(action === "tags" || action === "favorite") && <small>Saved on this laptop. Label synchronization to other devices is not enabled yet.</small>}
          {status && <p role="status">{status}</p>}
          <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Working…" : fixture ? "Try demo" : action === "trash" ? "Move to Trash" : "Apply"}</button></div>
        </form>
      </dialog>
    </>, document.body)}
  </>;
}
