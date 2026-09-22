import { useEffect, useState, type ReactNode } from 'react'
import type { SyncDevice, SyncStatus } from './drive'
import { Icon } from './Icon'
import { Confirm, Modal } from './Dialogs'

const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Pairing: the phone scans this QR with Codes; it carries the address, the certificate fingerprint and a one-time code. */
function PairDialog({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<{ qr: string; payload: { hosts: string[]; port: number } } | null>(null)
  const [left, setLeft] = useState(600)
  useEffect(() => { window.drive.sync.pair().then(setPair) }, [])
  useEffect(() => { const t = setInterval(() => setLeft(s => Math.max(0, s - 1)), 1000); return () => clearInterval(t) }, [])
  return (
    <Modal onClose={onClose}>
      <h3>Pair a phone</h3>
      <p>On the phone open Local Drive › Sync › Pair with computer, and scan this code.</p>
      <div className="qr">{pair ? <img src={pair.qr} alt="Pairing QR code" /> : <span className="spinner" />}</div>
      <p className="hint">{left ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}, once.` : 'Expired. Close and open again for a new code.'}
        {pair && ` Computer: ${pair.payload.hosts.join(', ') || 'no network'} · port ${pair.payload.port}`}</p>
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Done</button></div>
    </Modal>
  )
}

export function SyncPage({ setDialog }: { setDialog: (d: ReactNode) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = () => window.drive.sync.status().then(setStatus)
  useEffect(() => { load(); const off = window.drive.sync.onReceived(load); const t = setInterval(load, 5000); return () => { off(); clearInterval(t) } }, [])
  const close = () => { setDialog(null); load() }
  const pair = () => setDialog(<PairDialog onClose={close} />)
  const forget = (d: SyncDevice) => setDialog(<Confirm title={`Forget ${d.name}?`} action="Forget phone" danger onClose={close}
    body="It can no longer send photos until you pair it again. Photos already received stay." onConfirm={async () => { await window.drive.sync.forget(d.id); load() }} />)
  const total = status?.devices.reduce((n, d) => n + d.received, 0) ?? 0
  const active = (d: SyncDevice) => !!d.last_seen && Date.now() - d.last_seen < 15_000
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><Icon name="refresh" /><h1>Phone sync</h1></div>
      </header>
      <div className="island sync-hero">
        <span className={`sync-badge ${status && !status.error ? 'on' : ''}`}><Icon name="refresh" size={30} /></span>
        <div>
          <h2>{status?.error ? 'Sync is not running' : status?.devices.length ? `${status.devices.length === 1 ? 'One phone' : `${status.devices.length} phones`} paired` : 'No phone yet'}</h2>
          <p>{status?.error ? status.error : status ? `Ready on ${status.addresses.join(', ') || 'this computer'} · port ${status.port}` : 'Starting…'}</p>
        </div>
        <button className="filled-button big" onClick={pair}><Icon name="add" size={20} /> Pair a phone</button>
      </div>
      {!!status?.devices.length && (
        <div className="sync-stats">
          <div className="island stat"><strong>{total.toLocaleString()}</strong><small>Photos received</small></div>
          <div className="island stat"><strong>SHA-256</strong><small>Every file checked before it is kept</small></div>
        </div>
      )}
      <h2 className="section">Paired phones</h2>
      {status?.devices.length === 0 && <p className="hint">Open Local Drive on the phone › Sync › Pair with computer, and scan the code from “Pair a phone”.</p>}
      <div className="device-list">
        {status?.devices.map(d => (
          <div key={d.id} className="island device">
            <span className={`sync-badge small ${active(d) ? 'on' : ''}`}><Icon name="photos" /></span>
            <div>
              <strong>{d.name}</strong>
              <small>{active(d) ? 'Sending now…' : d.last_seen ? `Last seen ${when.format(d.last_seen)}` : 'Not connected yet'} · {d.received.toLocaleString()} photos received · paired {when.format(d.paired_at)}</small>
            </div>
            <button className="text-button" onClick={() => forget(d)}>Forget</button>
          </div>
        ))}
      </div>
      <p className="hint">Only paired phones can send. Photos keep their phone folders under Photos, nothing is ever overwritten, and nothing is deleted from the phone.</p>
    </div>
  )
}
