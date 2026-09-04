import { useState } from "react";
import { FilePdf, Trash } from "@phosphor-icons/react";

export function DesktopAction({ action, fixture }: { action: "scan" | "open-trash"; fixture: boolean }) {
  const [status, setStatus] = useState("");
  const run = async () => {
    if (fixture) { setStatus("Demo only. Open the live app to use desktop tools."); return; }
    setStatus("Opening…");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify({ action }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Could not open desktop tool");
      setStatus(action === "scan" ? "Scanner opened. Save the scan inside Drive, or import the saved document." : "System Trash opened. Restore files there; then refresh the library.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Desktop tool unavailable"); }
  };
  return <><button disabled={status === "Opening…"} onClick={() => void run()}>{action === "scan" ? <FilePdf /> : <Trash />}{action === "scan" ? "Open document scanner" : "Open system Trash"}</button>{status && <p role="status">{status}</p>}</>;
}
