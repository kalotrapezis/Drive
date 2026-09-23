import { useEffect, useState, type ReactNode } from 'react'
import type { SyncConnection, SyncDevice, SyncStatus } from './drive'
import { Icon } from './Icon'
import { Confirm, Modal } from './Dialogs'

const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Pairing QR: the phone scans it in Tetra › Sync. It carries the address, the certificate fingerprint and a one-time code. */
function PairingCode() {
  const [pair, setPair] = useState<{ qr: string; payload: { hosts: string[]; port: number } } | null>(null)
  const [left, setLeft] = useState(600)
  const renew = () => { setPair(null); setLeft(600); window.drive.sync.pair().then(setPair) }
  useEffect(renew, [])
  useEffect(() => { const t = setInterval(() => setLeft(s => Math.max(0, s - 1)), 1000); return () => clearInterval(t) }, [])
  return (
    <div className="pairing">
      <div className="qr">{pair && left ? <img src={pair.qr} alt="Pairing QR code" /> : left ? <span className="spinner" /> : <button className="filled-button" onClick={renew}>Show a new code</button>}</div>
      <ol>
        <li>On the phone open <b>Tetra</b> and tap <b>Local Sync</b>.</li>
        <li>Tap <b>Pair with computer</b> and point the camera at this code.</li>
        <li>The phone appears in the list, ready to back up.</li>
      </ol>
      <p className="hint">{left ? `This code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'The code expired.'}
        {pair && ` Computer: ${pair.payload.hosts.join(', ') || 'no network'} · port ${pair.payload.port}`}</p>
    </div>
  )
}

/**
 * The rules between this computer and one device, for one kind of content (SYNC_PLAN.md 6j).
 *
 * Direction and retention are deliberately two separate controls: the old app's map let a user state a
 * contradiction by making one control say both, and that is the mistake this card exists to avoid. Direction is
 * written from the *device's* side, because the device is the one that reads the row and obeys it.
 *
 * Retention is shown, not offered: Keep Everything — a Copy — is the only one built. A Move deletes on the
 * source after a verified receipt, and until that is implemented an editable control here would be a promise
 * nothing keeps.
 */
function Rules({ device, connection, onChange }: { device: SyncDevice; connection: SyncConnection; onChange: () => void }) {
  const what = connection.content === 'files' ? 'Files' : 'Photos'
  const set = async (direction: string, keep = connection.keep) => {
    await window.drive.sync.setConnection(device.id, connection.content, { direction, keep })
    onChange()
  }
  // Keep is only a question where there is one source and one direction. Two-way cannot delete on either side,
  // and Off moves nothing at all, so both are simply Copy.
  const canMove = connection.direction === 'send'
  return (
    <div className="connection-rules">
      <span className="rules-what">{what}</span>
      <div className="segmented">
        {([['off', 'Off'], ['send', `${device.name} → here`], ['receive', `here → ${device.name}`], ['both', 'Both ways']] as const).map(([value, label]) => (
          <button key={value} className={connection.direction === value ? 'on' : ''} onClick={() => set(value)}>{label}</button>
        ))}
      </div>
      {connection.direction === 'off' && <small>Nothing crosses, in either direction.</small>}
      {connection.direction === 'receive' && <small>Keep everything (Copy) — {device.name} keeps its own.</small>}
      {connection.direction === 'both' && <small>Keep everything (Copy) — two-way is always a copy.</small>}
      {canMove && (
        <div className="segmented">
          {([['everything', 'Keep everything (Copy)'], ['nothing', 'Keep nothing (Move)']] as const).map(([value, label]) => (
            <button key={value} className={connection.keep === value ? 'on' : ''} onClick={() => set('send', value)}>{label}</button>
          ))}
        </div>
      )}
      {canMove && connection.keep === 'nothing' && (
        <small>{device.name} offers to move them off itself, once this computer has read each one back and it
          matches. Nothing is deleted by a sync — the device asks, and they go to its own Trash.</small>
      )}
    </div>
  )
}

export function SyncPage({ setDialog }: { setDialog: (d: ReactNode) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = () => window.drive.sync.status().then(setStatus)
  useEffect(() => { load(); const off = window.drive.sync.onReceived(load); const t = setInterval(load, 3000); return () => { off(); clearInterval(t) } }, [])
  const close = () => { setDialog(null); load() }
  const add = () => setDialog(<Modal onClose={close}><h3>Add a device</h3><PairingCode /><div className="dialog-actions"><button className="filled-button" onClick={close}>Done</button></div></Modal>)
  const forget = (d: SyncDevice) => setDialog(<Confirm title={`Forget ${d.name}?`} action="Forget device" danger onClose={close}
    body="It can no longer send photos until you pair it again. Photos already received stay." onConfirm={async () => { await window.drive.sync.forget(d.id); load() }} />)
  const state = (d: SyncDevice) => !d.last_seen ? 'Not connected yet' : Date.now() - d.last_seen < 15_000 ? 'Connected · sending' : Date.now() - d.last_seen < 120_000 ? 'Connected' : `Last seen ${when.format(d.last_seen)}`
  const devices = status?.devices ?? []
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><Icon name="photos" /><h1>Devices</h1></div>
        <button className="round" title="Add a device" onClick={add}><Icon name="add" /></button>
      </header>
      {status?.error && <div className="island analysis"><Icon name="warning" /><span>Sync is not running: {status.error}</span></div>}
      {status && devices.length === 0 && !status.error && (
        <div className="island add-first">
          <h2>Pair your phone</h2>
          <PairingCode />
        </div>
      )}
      {devices.length > 0 && (
        <div className="device-grid">
          {devices.map(d => {
            const s = state(d)
            return (
              <div key={d.id} className="island device-card">
                <span className={`sync-badge ${s.startsWith('Connected') ? 'on' : ''}`}><Icon name="photos" size={28} /></span>
                <strong>{d.name}</strong>
                <small className={s.startsWith('Connected') ? 'live' : ''}>{s}</small>
                <small>{d.received.toLocaleString()} photos received</small>
                {d.filesReceived > 0 && <small>{d.filesReceived.toLocaleString()} Drive files received</small>}
                <small>Paired {when.format(d.paired_at)}</small>
                {d.connections?.map(c => <Rules key={c.content} device={d} connection={c} onChange={load} />)}
                <button className="text-button" onClick={() => forget(d)}>Forget</button>
              </div>
            )
          })}
          <button className="island device-card add" onClick={add}>
            <span className="sync-badge"><Icon name="add" size={28} /></span>
            <strong>Add a device</strong>
            <small>Show a pairing code</small>
          </button>
        </div>
      )}
      {status && !status.error && <p className="hint">Listening on {status.addresses.join(', ') || 'this computer'} · port {status.port}. Only paired devices can reach it. Every file is checked by SHA-256 on the side that receives it before it is kept, nothing is overwritten, and a sync never deletes anything on either device.</p>}
    </div>
  )
}
