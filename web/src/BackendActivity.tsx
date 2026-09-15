import { useState } from "react";

export type LiveOperation = { id: string; routeId?: string; state: string; paused?: boolean; status?: string; phase?: string; bytesDone?: number; bytesTotal?: number; path?: string };
export type WirelessStatus = { available: boolean; listening: boolean; configured: boolean; status: string; port?: number };

async function control(endpoint: string, payload: object) {
  const session = await fetch('/api/v1/session');
  if (!session.ok) throw new Error('Local session unavailable');
  const { token } = await session.json();
  const response = await fetch(`/api/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Drive-Token': token }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Action failed');
}

export function BackendActivity({ operations, label, fixture, refresh }: { operations: LiveOperation[]; label: (routeId?: string) => string; fixture: boolean; refresh: () => Promise<void> }) {
  const [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  async function run(id: string, action: string) {
    setBusy(true); setStatus('');
    try { await control('route-control', { id, action }); await refresh(); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Transfer control failed'); }
    finally { setBusy(false); }
  }
  return <div>{operations.map((operation) => <article className="live-operation" key={operation.id}>
    <strong>{label(operation.routeId)} · {operation.paused ? 'Paused' : operation.status || operation.state}</strong>
    {operation.phase === 'phone-import' && <small>Receiving from phone</small>}
    {operation.bytesTotal ? <progress aria-label="Transfer progress" max={operation.bytesTotal} value={operation.bytesDone || 0} /> : <small>{operation.state === 'scanning' ? 'Inspecting files…' : 'Preparing transfer…'}</small>}
    {operation.path && <small>{operation.path}</small>}
    {(operation.state === 'copying' || operation.state === 'scanning') && <div className="schedule-actions">{operation.state === 'copying' && <button disabled={fixture || busy} onClick={() => run(operation.id, operation.paused ? 'resume' : 'pause')}>{operation.paused ? 'Resume' : 'Pause'}</button>}<button disabled={fixture || busy} onClick={() => run(operation.id, 'cancel')}>{operation.state === 'scanning' ? 'Cancel scan' : 'Cancel transfer'}</button></div>}
  </article>)}{status && <p role="status">{status}</p>}</div>;
}

export function WirelessSettings({ wireless, fixture, refresh }: { wireless?: WirelessStatus; fixture: boolean; refresh: () => Promise<void> }) {
  const [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setStatus('');
    try { await control('wireless-control', { action: wireless?.listening ? 'stop' : 'start' }); await refresh(); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Receiver control failed'); }
    finally { setBusy(false); }
  }
  return <section><h2>Wireless reception</h2><p>{wireless?.available ? wireless.status : 'Receiver unavailable'}</p>
    <p>{wireless?.configured ? 'Uses the saved secure device profile.' : 'No secure device profile configured.'}</p>
    <button disabled={fixture || busy || !wireless?.available || (!wireless.listening && !wireless.configured)} onClick={run}>{wireless?.listening ? 'Stop receiver' : 'Start saved receiver'}</button>
    {status && <p role="status">{status}</p>}
  </section>;
}
