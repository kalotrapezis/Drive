import { useState } from "react";

export type SyncSchedule = { id: string; routeId: string; phoneId: string; start: string; timeZone: string; repeat: string; state: string; phase: string; message: string; nextRun?: string; lastRun?: string };
type Route = { id: string; contentType: string; storageId?: string; destination?: string };
type Phone = { id: string; label: string; transports?: string[] };
type Props = { schedules: SyncSchedule[]; error?: string; routes: Route[]; phones: Phone[]; storages: { id: string; label: string }[]; fixture: boolean; onRefresh: () => Promise<void>; noticesOnly?: boolean; onReview?: () => void };

export function SyncSchedules({ schedules, error, routes, phones, storages, fixture, onRefresh, noticesOnly, onReview }: Props) {
  const [routeId, setRouteId] = useState(routes[0]?.id || ""), [phoneId, setPhoneId] = useState("");
  const [repeat, setRepeat] = useState("weekly"), [start, setStart] = useState("");
  const [editing, setEditing] = useState(""), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const action = async (body: object) => {
    if (fixture) { setStatus("Scheduling requires the live application."); return; }
    setBusy(true); setStatus("");
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/schedule", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Drive-Token": token }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Schedule could not be saved");
      await onRefresh(); setStatus("Saved"); setEditing("");
    } catch (e) { setStatus(e instanceof Error ? e.message : "Schedule unavailable"); }
    finally { setBusy(false); }
  };
  const visible = noticesOnly ? schedules.filter((item) => item.state !== "paused" && (item.state !== "scheduled" || item.lastRun)) : schedules;
  const label = (item: SyncSchedule) => { const route = routes.find((r) => r.id === item.routeId); return `${item.phoneId ? `${phones.find((p) => p.id === item.phoneId)?.label || "Phone"} → Laptop → ` : "Laptop → "}${storages.find((storage) => storage.id === route?.storageId)?.label || "Storage"} · ${route?.contentType || "Removed connection"}`; };
  return <div className="sync-schedules">
    {!noticesOnly && <>
      <p>Run once or every day, week or month at a chosen time. Weekly uses the selected weekday; monthly uses the selected day, or the last day of a shorter month.</p>
      <p>Local Drive must be running; the browser can be closed. Sleep, shutdown or disconnected devices leave pending work for you to start. Move cleanup always requires a separate review.</p>
      <form className="schedule-form" onSubmit={(event) => { event.preventDefault(); void action({ action: "save", id: editing, routeId, phoneId, repeat, start, timeZone }); }}>
        <label>Connection<select required value={routeId} onChange={(e) => setRouteId(e.target.value)}><option value="">Choose connection</option>{routes.map((r) => <option key={r.id} value={r.id}>{r.contentType} → {storages.find((storage) => storage.id === r.storageId)?.label || r.storageId}</option>)}</select></label>
        <label>Source<select value={phoneId} onChange={(e) => setPhoneId(e.target.value)}><option value="">Laptop library</option>{phones.filter((p) => p.transports?.includes("mtp")).map((p) => <option key={p.id} value={p.id}>{p.label} → laptop first</option>)}</select></label>
        <label>Repeat<select value={repeat} onChange={(e) => setRepeat(e.target.value)}><option value="once">Once · specific date</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></label>
        <label>First date and time<input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <small>Time zone: {timeZone}. Phone transfers need USB File transfer mode. Phone originals stay on the phone. Enable Cache on the connection for phone → laptop intake.</small>
        <div><button type="submit" className="primary" disabled={busy || fixture || !routeId || !start}>{editing ? "Save changes" : "Add schedule"}</button>{editing && <button type="button" className="secondary" onClick={() => { setEditing(""); setStart(""); }}>Cancel editing</button>}</div>
      </form>
    </>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {visible.map((item) => { const running = ["requested", "starting", "previewing", "copying", "importing"].includes(item.state); return <article className="schedule-item" key={item.id}>
      <strong>{label(item)}</strong><small>{item.repeat} · {item.timeZone} · {item.state}</small>
      <p role={item.state === "pending" ? "status" : undefined}>{item.message}</p>
      {item.nextRun && <small>{item.state === "pending" ? "Due" : "Next"}: {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: item.timeZone }).format(new Date(item.nextRun))}</small>}
      <div className="schedule-actions">
        {item.state === "pending" && <button className="primary" disabled={busy || fixture} onClick={() => void action({ action: "start", id: item.id })}>Start pending transfer</button>}
        {onReview && <button className="secondary" onClick={onReview}>Review connection</button>}
        {!noticesOnly && <><button className="secondary" disabled={busy || running || fixture} onClick={() => void action({ action: item.state === "paused" ? "resume" : "pause", id: item.id })}>{item.state === "paused" ? "Resume" : "Pause"}</button><button className="secondary" disabled={busy || running} onClick={() => { setEditing(item.id); setRouteId(item.routeId); setPhoneId(item.phoneId); setStart(item.start); setRepeat(item.repeat); setTimeZone(item.timeZone); }}>Edit</button><button className="secondary" disabled={busy || running || fixture} onClick={() => void action({ action: "remove", id: item.id })}>Remove schedule</button></>}
      </div>
    </article>; })}
    {!noticesOnly && !schedules.length && <p>No schedules yet.</p>}
  </div>;
}
