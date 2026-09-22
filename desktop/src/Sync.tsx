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
  const forget = (d: SyncDevice) => setDialog(<Confirm title={`Forget ${d.name}?`} action="Forget phone" danger onClose={close}
    body="It can no longer send photos until you pair it again. Photos already received stay." onConfirm={async () => { await window.drive.sync.forget(d.id); load() }} />)
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><h1>Phone sync</h1></div>
        <button className="island lock-button" onClick={() => setDialog(<PairDialog onClose={close} />)}><Icon name="add" size={20} />Pair a phone</button>
      </header>
      {status && (
        <div className="island analysis">
          <Icon name={status.error ? 'warning' : 'info'} />
          <span>{status.error ? `Sync is not running: ${status.error}` : `Ready on ${status.addresses.join(', ') || 'this computer'} · port ${status.port}. Only paired phones can send photos; each one is checked by SHA-256 before it is kept.`}</span>
        </div>
      )}
      <h2 className="section">Paired phones</h2>
      {status?.devices.length === 0 && <p className="hint">No phone is paired yet.</p>}
      <div className="device-list">
        {status?.devices.map(d => (
          <div key={d.id} className="island device">
            <Icon name="photos" />
            <div><strong>{d.name}</strong><small>Paired {when.format(d.paired_at)} · {d.last_seen ? `last seen ${when.format(d.last_seen)}` : 'not connected yet'} · {d.received} photos received</small></div>
            <button className="text-button" onClick={() => forget(d)}>Forget</button>
          </div>
        ))}
      </div>
    </div>
  )
}
