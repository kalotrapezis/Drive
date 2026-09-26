import { useEffect, useState, type ReactNode } from 'react'
import type { IconName } from './Icon'
import type { Disk, Drive, DriveRules, DriveScan, HistoryRow, MovePreview, OffloadPlan, PurgatorySettings, SyncConnection, SyncDevice, SyncFile, SyncOverview, SyncSelf, SyncStatus } from './drive'
import { formatBytes } from './timeline'
import { copiesColor } from './colors'
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
function Rules({ device, connection, here, onChange, setDialog }: { device: SyncDevice; connection: SyncConnection; here: string; onChange: () => void; setDialog: (d: ReactNode) => void }) {
  const what = connection.content === 'files' ? 'Files' : 'Photos'
  const it = connection.content === 'files' ? 'files' : 'photos'
  const set = async (direction: string) => {
    await window.drive.sync.setConnection(device.id, connection.content, { direction, keep: 'everything' })
    onChange()
  }
  // One way to this computer is a Move, never a plain copy — keeping everything on both is what Both ways is for
  // (asked 2026-09-25). So it is never chosen in one click: first what it will do, and how much stays.
  const isMove = connection.direction === 'send' && connection.keep === 'nothing'
  const chooseMove = () => setDialog(<MoveDialog device={device} connection={connection} here={here}
    onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange() }} />)
  const directions = [
    { value: 'off', icon: 'block', flip: false, label: 'Off', hint: `No ${it} cross, in either direction.` },
    { value: 'send', icon: 'arrowRight', flip: false, label: `${device.name} → ${here}`, hint: `${what} move from ${device.name} to ${here}.` },
    { value: 'receive', icon: 'arrowRight', flip: true, label: `${here} → ${device.name}`, hint: `${what} on ${here} are copied to ${device.name}.` },
    { value: 'both', icon: 'swap', flip: false, label: 'Both ways', hint: `Each side sends the ${it} the other is missing. Always a copy.` },
  ] as const
  const chosen = directions.find(d => d.value === connection.direction)
  return (
    <section className="connection-rules">
      <h4><Icon name={connection.content === 'files' ? 'folder' : 'photos'} size={18} />{what}</h4>
      <div className="rule-options">
        {directions.map(d => (
          <button key={d.value} className={connection.direction === d.value ? 'on' : ''} onClick={() => d.value === 'send' ? chooseMove() : set(d.value)}>
            <span className={d.flip ? 'glyph flip' : 'glyph'}><Icon name={d.icon} size={18} /></span>
            <span className="rule-label">{d.label}</span>
            {d.value === 'send' && <span className="rule-note">Move</span>}
          </button>
        ))}
      </div>
      <p className="rule-hint">
        {chosen?.hint}
        {isMove && <> {device.name} keeps the last <b>{spanOf(connection.keepDays ?? 30)}</b>
          {connection.keepFavorites !== false && ' and its favorites'}; {connection.content === 'files'
            ? `older files that ${here} holds go to its Trash at each sync.`
            : `older photos that ${here} holds are offered to move off it, into its Trash.`} <button className="link" onClick={chooseMove}>Change</button></>}
        {connection.direction === 'send' && !isMove && <> This was set as a copy before Moves had a window. <button className="link" onClick={chooseMove}>Choose what stays</button></>}
      </p>
    </section>
  )
}

/**
 * The library, and where it actually is (SYNC_PLAN.md 6ad).
 *
 * The device cards say what crossed *last time*. This says what is true *now*: how much there is, how many
 * machines hold each piece, and — the only two numbers that lead anywhere — how much is at risk because this
 * computer is the only place it lives, and how much space a device could get back because it is not.
 *
 * Every number comes from devices listing what they hold during a sync, so each one is only as fresh as that
 * device's last sync, and the row says when that was.
 */
/** The pictures a device may be drawn with, and what each is for. */
const DEVICE_KINDS: { kind: IconName; label: string }[] = [
  { kind: 'device', label: 'Phone' },
  { kind: 'tablet', label: 'Tablet' },
  { kind: 'computer', label: 'Computer' },
  { kind: 'server', label: 'Server' },
  { kind: 'database', label: 'Storage' },
]

/**
 * What a device is called here, and what it is drawn as. The name a phone reports is its model number, which
 * is not what anyone calls it; the picture is a guess from the width it reported when it paired. Both are the
 * person's to correct, and nothing else in the app reads either (SYNC_PLAN.md 6af).
 */
function DeviceEditor({ device, onDone }: { device: SyncDevice; onDone: () => void }) {
  const [name, setName] = useState(device.name)
  const [kind, setKind] = useState<string>(device.kind ?? 'device')
  const save = async () => { await window.drive.sync.setDevice(device.id, { name, kind }); onDone() }
  return (
    <Modal onClose={onDone}>
      <h3>This device</h3>
      <label className="editor-label" htmlFor="device-name">What to call it</label>
      <input id="device-name" className="field" value={name} onChange={e => setName(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save() }} />
      <div className="rule-options kind-picker">
        {DEVICE_KINDS.map(k => (
          <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            <span className="glyph"><Icon name={k.kind} size={18} /></span>
            <span className="rule-label">{k.label}</span>
          </button>
        ))}
      </div>
      <p className="rule-hint">It reported {device.name} when it paired. The name is only used here.</p>
      <div className="dialog-actions">
        <button onClick={onDone}>Cancel</button>
        <button className="filled-button" onClick={save}>Save</button>
      </div>
    </Modal>
  )
}

/**
 * What this machine is. Every other device is paired with this one and with nothing else, so the word for it
 * shows up in every rule on the page: *this PC*, *this server*. The default is a computer, and the name is
 * this machine's hostname until someone says otherwise.
 */
function SelfEditor({ self, onDone }: { self: SyncSelf; onDone: () => void }) {
  const [name, setName] = useState(self.name)
  const [kind, setKind] = useState(self.kind)
  const save = async () => { await window.drive.sync.setSelf({ name, kind }); onDone() }
  return (
    <Modal onClose={onDone}>
      <h3>This device</h3>
      <label className="editor-label" htmlFor="self-name">What to call it</label>
      <input id="self-name" className="field" value={name} onChange={e => setName(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save() }} />
      <div className="rule-options kind-picker">
        {DEVICE_KINDS.map(k => (
          <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            <span className="glyph"><Icon name={k.kind} size={18} /></span>
            <span className="rule-label">{k.label}</span>
          </button>
        ))}
      </div>
      <p className="rule-hint">Every rule on this page is written from a device's side, so this is the word on the
        other end of each of them: {SELF_WORDS[kind] ?? 'here'}.</p>
      <div className="dialog-actions">
        <button onClick={onDone}>Cancel</button>
        <button className="filled-button" onClick={save}>Save</button>
      </div>
    </Modal>
  )
}

const SELF_WORDS: Record<string, string> = { device: 'this phone', tablet: 'this tablet', computer: 'this PC', server: 'this server', database: 'this storage' }

/** What this machine does for the others, said once, where it is asked. */
function HubInfo({ self, onClose }: { self: SyncSelf; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>{self.name} is the hub</h3>
      <p>Every device pairs with this machine and with nothing else. A phone and a tablet never talk to each
        other — they each talk to {self.label}, which is how anything gets from one to the other.</p>
      <p>So: <b>connect every device to this one.</b> It is also the only machine that can see the whole
        picture — what exists, how many copies there are, and what is safe to free — because it is the only one
        every device reports to.</p>
      <p>It has to be running and on the same network for anything to cross. Nothing is ever deleted by a sync,
        and a device is only ever <i>offered</i> the chance to free space, never told.</p>
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

/**
 * Why a file never reached this computer, as far as this computer can tell. The direction row is the one
 * answer it holds with certainty; everything else it can only say honestly that it does not know.
 */
function whyNotHere(name: string, count: number, here: string, device?: SyncDevice): string {
  const direction = device?.connections?.find(c => c.content === 'photos')?.direction
  const head = `${here[0].toUpperCase()}${here.slice(1)} has never been given these ${count.toLocaleString()} files.`
  if (direction === 'receive') return `${head} Its Photos row for ${name} is "${here} → ${name}", so ${name} never offers anything and these will stay where they are until that changes.`
  if (direction === 'off') return `${head} Photos are switched off for ${name}, so nothing crosses in either direction.`
  return `${head} ${name} is allowed to send photos, so these were offered and did not make it across — a failed transfer, or a file Android would not let it read. The device knows which; it does not say yet.`
}

/**
 * The files behind a number. A hash is not an answer to "what is it", so anything a device told us about its
 * own files is shown; anything it never said is shown as not said, rather than guessed at.
 */
function FileList({ what, title, deviceId, why, here, onClose }: { what: 'onlyThere' | 'alone' | 'largest'; title: string; deviceId?: string; why?: string; here: string; onClose: () => void }) {
  const [files, setFiles] = useState<SyncFile[] | null>(null)
  useEffect(() => { window.drive.sync.files(what, { deviceId, limit: 300 }).then(setFiles) }, [what, deviceId])
  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      {why && <p className="rule-hint">{why}</p>}
      {!files ? <span className="spinner" /> : files.length === 0 ? <p className="rule-hint">Nothing here — good.</p> : (
        <div className="file-scroll">
          <div className="file-row head"><span>File</span><span>Size</span><span>Where</span></div>
          {files.map(f => (
            <div className="file-row" key={f.sha256 + (f.device ?? '')}>
              <span className="file-name">
                <Icon name={f.isVideo ? 'video' : 'photos'} size={16} />
                <span>{f.name ? f.name.split('/').pop() : <i>not named by the device yet</i>}</span>
              </span>
              <span>{f.size ? formatBytes(f.size) : '—'}</span>
              <span>{f.here ? here : f.device}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

function Library({ overview, paired, here, setDialog }: { overview: SyncOverview; paired: SyncDevice[]; here: string; setDialog: (d: ReactNode) => void }) {
  const total = overview.known
  if (!total) return null
  const stored = overview.stored ?? []
  const notHere = total - overview.here.files - stored.reduce((a, s) => a + s.files, 0)
  // One band per number of places, as many as there are devices holding photos, each a colour of its own (copiesColor).
  const WORDS = ['', 'One copy', 'Two places', 'Three places', 'Four places', 'Five places', 'Six places']
  const bands = overview.copies.filter(c => c.copies > 0).map(c => ({
    key: `c${c.copies}`, copies: c.copies, color: copiesColor(c.copies),
    label: WORDS[c.copies] ?? `${c.copies} places`, files: c.files, bytes: c.bytes,
    hint: c.copies === 1 ? 'in one place in the world' : c.copies === 2 ? 'one machine could fail' : 'safe',
  }))
  return (
    <section className="island library">
      <h3><Icon name="database" size={20} />The library, and where it is</h3>
      <p className="library-total">
        <strong>{total.toLocaleString()}</strong> photos known · <strong>{overview.here.files.toLocaleString()}</strong> of them on {here}
        {stored.map(s => <span key={s.name}> · <strong>{s.files.toLocaleString()}</strong> on {s.name}</span>)}
        {notHere > 0 && <> · <b className="risk">{notHere.toLocaleString()} only on a device</b></>}
      </p>
      <div className="copies-bar" role="img" aria-label="how many machines hold each file">
        {bands.map(b => b.files > 0 && <i key={b.copies} className={b.key} style={{ width: `${(b.files / total) * 100}%`, background: b.color }} title={`${b.label}: ${b.files.toLocaleString()}`} />)}
      </div>
      <ul className="copies-key">
        {bands.map(b => (
          <li key={b.copies}><span className="dot" style={{ background: b.color }} />
            {b.copies === 1 && b.files > 0
              ? <button className="link" onClick={() => setDialog(<FileList what="alone" here={here} title="Files that exist in one place only" onClose={() => setDialog(null)}
                  why="One machine holds these and nothing else does. Losing that machine loses the file." />)}>{b.label}</button>
              : b.label}
            <small>{b.files.toLocaleString()} {b.bytes > 0 && `· ${formatBytes(b.bytes)} `}— {b.hint}</small>
          </li>
        ))}
      </ul>
      {overview.kinds.length > 0 && (
        <>
          <h4 className="library-sub">What it is made of
            <button className="link" onClick={() => setDialog(<FileList what="largest" here={here} title={`The biggest files on ${here}`} onClose={() => setDialog(null)} />)}>the biggest files</button>
          </h4>
          <div className="copies-bar kinds" role="img" aria-label="what the library is made of, by size">
            {overview.kinds.map(k => <i key={k.kind} className={k.kind} style={{ width: `${(k.bytes / Math.max(1, overview.here.bytes)) * 100}%` }} title={`${k.kind}: ${formatBytes(k.bytes)}`} />)}
          </div>
          <ul className="copies-key">
            {overview.kinds.map(k => (
              <li key={k.kind}><span className={`dot ${k.kind}`} />{k.kind === 'video' ? 'Videos' : k.kind === 'document' ? 'Documents' : 'Photos'}
                <small>{k.files.toLocaleString()} · {formatBytes(k.bytes)} — {Math.round((k.bytes / Math.max(1, overview.here.bytes)) * 100)}% of the disk</small>
              </li>
            ))}
          </ul>
        </>
      )}
      <table className="holdings">
        <thead><tr><th>Device</th><th>Holds</th><th>Also in the library</th><th>Only there</th><th>Could free</th></tr></thead>
        <tbody>
          {overview.devices.map(d => (
            <tr key={d.id}>
              <th scope="row"><Icon name={(paired.find(p => p.id === d.id)?.kind as IconName) ?? 'device'} size={16} />{d.name}<small>{d.last_seen ? `as of ${when.format(d.last_seen)}` : 'never synced'}</small></th>
              <td>{d.holds.toLocaleString()}</td>
              <td>{d.alsoHere.toLocaleString()}</td>
              <td className={d.onlyThere > 0 ? 'risk' : ''}>
                {d.onlyThere > 0
                  ? <button className="link risk" onClick={() => setDialog(<FileList what="onlyThere" deviceId={d.id} here={here} title={`On ${d.name} and nowhere else`} onClose={() => setDialog(null)}
                      why={whyNotHere(d.name, d.onlyThere, here, paired.find(p => p.id === d.id))} />)}>{d.onlyThere.toLocaleString()}</button>
                  : d.onlyThere.toLocaleString()}
              </td>
              <td>{d.freeable ? formatBytes(d.freeable) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {overview.staleReceipts > 0 && (
        <p className="rule-hint risk">
          {overview.staleReceipts.toLocaleString()} {overview.staleReceipts === 1 ? 'file was' : 'files were'} received and checked on {here} and
          {overview.staleReceipts === 1 ? ' is' : ' are'} no longer on disk. They are counted as missing again, so the device that has them
          will be asked for them on its next sync.
        </p>
      )}
      <p className="library-note">
        Photos only: the Drive folder is a second library with its own manifest, and counting the two together
        made every number ambiguous. Counted over everything known anywhere, not only what is on {here} — a
        photo on one phone and nowhere else is the one worth warning about, so it has to be in the picture.
        Sizes are only known for what {here} holds, so a file that is only on a device is counted and never
        weighed. <b>Could free</b> is what a device could give back, because every byte of it was read back and
        checked on {here} — nothing is deleted by a sync, the device would be asked first. Each row is as fresh
        as that device's last sync.
      </p>
    </section>
  )
}

/**
 * Adding a drive, in the order it was asked for (2026-09-24): **select** one that is plugged in, **scan** it to
 * see what would happen, then copy. Nothing is written until Start, and a scan that finds a reason not to —
 * no room, nowhere to write — says so instead of finding out halfway through.
 */
/** A phone is paired with a code; a drive is picked from what is plugged in. Both then answer the same rules. */
function AddDevice({ onClose, onDone, setDialog }: { onClose: () => void; onDone: () => void; setDialog: (d: ReactNode) => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>Add a device</h3>
      <div className="rule-options">
        <button onClick={() => setDialog(<Modal onClose={onDone}><h3>Pair a phone or tablet</h3><PairingCode />
          <p className="rule-hint">Nothing crosses until you have answered what should cross: the new device
            appears below with every row Off, waiting for that.</p>
          <div className="dialog-actions"><button className="filled-button" onClick={onDone}>Done</button></div></Modal>)}>
          <span className="glyph"><Icon name="device" size={18} /></span>
          <span className="rule-label">A phone or a tablet<small> · show a pairing code</small></span>
        </button>
        <button onClick={() => setDialog(<AddDrive onClose={onClose} onDone={onDone} />)}>
          <span className="glyph"><Icon name="database" size={18} /></span>
          <span className="rule-label">A drive that is plugged in<small> · back up to it</small></span>
        </button>
      </div>
      <div className="dialog-actions"><button onClick={onClose}>Cancel</button></div>
    </Modal>
  )
}

function AddDrive({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState<Drive[] | null>(null)
  const [picked, setPicked] = useState<Drive | null>(null)
  const [scan, setScan] = useState<DriveScan | null>(null)
  const [busy, setBusy] = useState<{ done: number; total: number; copied: number } | null>(null)
  const [done, setDone] = useState<{ copied: number; already: number; failed: string[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { window.drive.sync.drives().then(setList) }, [])
  useEffect(() => window.drive.sync.onDriveProgress(p => setBusy(p)), [])

  const select = async (d: Drive) => {
    setPicked(d); setScan(null); setError('')
    setScan(await window.drive.sync.inspectDrive(d.uuid))
  }
  // The rules are answered before anything is written, not after: a device that started at "Send & receive"
  // uploaded its whole camera roll before anyone could stop it (24 September).
  // Only what a drive backup actually does: photos and Drive files, one way. "Both ways" was offered here and
  // then quietly did nothing, which is worse than not offering it (asked 2026-09-24).
  const [rules, setRules] = useState<Record<string, string>>({ photos: 'receive', files: 'receive' })
  // A drive may keep the purgatory; by default this PC does (SYNC_PLAN.md D6). Asked here, changeable on its card.
  const [keepPurgatory, setKeepPurgatory] = useState(false)
  const start = async () => {
    if (!picked) return
    setBusy({ done: 0, total: scan?.total ?? 0, copied: 0 })
    try {
      const device = picked.device ?? await window.drive.sync.addDrive({ uuid: picked.uuid, label: picked.label })
      for (const [content, direction] of Object.entries(rules)) {
        await window.drive.sync.setConnection(device.id, content, { direction, keep: 'everything' })
      }
      await window.drive.sync.completeSetup(device.id)
      if (keepPurgatory) await window.drive.purgatory.setLocation(device.id)
      const result = rules.photos === 'off' && rules.files === 'off' ? { copied: 0, already: 0, failed: [], total: 0 }
        : await window.drive.sync.backUpToDrive(device.id)
      setDone(result)
      onDone()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(null)
  }

  if (done) return (
    <Modal onClose={onClose}>
      <h3>{picked?.label} is up to date</h3>
      <p>{done.copied.toLocaleString()} copied, {done.already.toLocaleString()} already there.
        {done.failed.length > 0 && ` ${done.failed.length} could not be copied.`}</p>
      {done.failed.slice(0, 5).map(f => <p key={f} className="error">{f}</p>)}
      <p className="rule-hint">It counts as a copy from now on, so anything that lives only on this computer
        and on that drive shows as two places rather than one.</p>
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
    </Modal>
  )

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <h3>Add a drive</h3>
      {!list ? <span className="spinner" /> : list.length === 0 ? (
        <p className="rule-hint">Nothing is plugged in that this app can write to. Connect a drive and open this again.</p>
      ) : (
        <div className="rule-options drive-list">
          {list.map(d => (
            <button key={d.uuid} className={picked?.uuid === d.uuid ? 'on' : ''} disabled={!!busy} onClick={() => select(d)}>
              <span className="glyph"><Icon name="database" size={18} /></span>
              <span className="rule-label">{d.label}<small> · {d.fstype} · {formatBytes(d.freeBytes)} free</small></span>
              {d.device && <span className="rule-note">added</span>}
            </button>
          ))}
        </div>
      )}
      {picked && !scan && <p className="rule-hint">Looking at {picked.label}…</p>}
      {scan?.plugged && (
        <>
          <div className="file-row head" style={{ marginTop: 14 }}><span>What would happen</span><span>Files</span><span>Size</span></div>
          <div className="file-row"><span>Already on {picked?.label}</span><span>{((scan.have ?? 0) + (scan.files?.have ?? 0)).toLocaleString()}</span><span>{formatBytes(scan.haveBytes ?? 0)}</span></div>
          <div className="file-row"><span>Photos to copy</span><span>{scan.need?.toLocaleString()}</span><span>{formatBytes(scan.needBytes ?? 0)}</span></div>
          <div className="file-row"><span>Drive files to copy</span><span>{scan.files?.need.toLocaleString()}</span><span>{formatBytes(scan.files?.needBytes ?? 0)}</span></div>
          <div className="file-row"><span>Free afterwards</span><span /><span>{formatBytes(Math.max(0, (scan.free ?? 0) - (scan.needBytes ?? 0) - (scan.files?.needBytes ?? 0)))}</span></div>
          {!scan.writable && <p className="error">This app cannot write to {scan.mount}. Nothing was changed.</p>}
          {scan.writable && !scan.enough && <p className="error">There is not enough room: {formatBytes(scan.needBytes ?? 0)} to copy, {formatBytes(scan.free ?? 0)} free.</p>}
          {scan.writable && scan.enough && (
            <>
              <h4 className="library-sub" style={{ marginTop: 16 }}>And the rules</h4>
              {(['photos', 'files'] as const).map(content => (
                <div key={content} className="rule-options" style={{ marginBottom: 6 }}>
                  {([['off', 'block', content === 'photos' ? 'No photos' : 'No Drive files'],
                     ['receive', 'arrowRight', `Copy ${content === 'photos' ? 'photos' : 'Drive files'} to ${picked?.label}`]] as const).map(([value, icon, label]) => (
                    <button key={value} className={rules[content] === value ? 'on' : ''}
                      onClick={() => setRules(r => ({ ...r, [content]: value }))}>
                      <span className="glyph"><Icon name={icon} size={18} /></span>
                      <span className="rule-label">{label}</span>
                    </button>
                  ))}
                </div>
              ))}
              <label className="rule-hint check-row"><input type="checkbox" checked={keepPurgatory} onChange={e => setKeepPurgatory(e.target.checked)} />
                <span>Keep the purgatory on {picked?.label}<br />deleted items wait there for their last days instead of on this PC; what is in it now moves there</span></label>
              <p className="rule-hint">A Drive file that changed replaces the drive's copy, and the older one is kept in
                Tetra/Files history. To let old photos live on it instead of this PC, make it Storage on its card afterwards.</p>
              <p className="rule-hint">Everything goes under <b>{scan.mount}/Tetra</b> and nothing else on the drive is
                touched. Each file is read back and checked after it is written, and nothing is ever deleted or lost —
                on the drive or here. Nothing crosses until you press Start.</p>
            </>
          )}
        </>
      )}
      {scan && !scan.plugged && <p className="error">That drive is no longer plugged in.</p>}
      {busy && <p className="rule-hint">Copying… {busy.done.toLocaleString()} of {busy.total.toLocaleString()}, {busy.copied.toLocaleString()} written.</p>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="filled-button" disabled={!scan?.plugged || !scan?.writable || !scan?.enough || !!busy} onClick={start}>
          {busy ? 'Copying…' : 'Start'}
        </button>
      </div>
    </Modal>
  )
}

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** "3 months", "1 year", "10 days": a number of days in the largest unit it divides into. */
function spanOf(days: number) {
  const [unit, per] = [...UNITS].reverse().find(([, n]) => days % n === 0) ?? UNITS[0]
  return `${days / per} ${unit}${days / per > 1 ? 's' : ''}`
}

/**
 * Before a device's photos become a Move (asked 2026-09-25): what will happen, in numbers, and how much stays on
 * the device. A Move always keeps a window — keeping everything would be a Copy. Nothing changes until Start.
 */
function MoveDialog({ device, connection, here, onClose, onDone }: { device: SyncDevice; connection: SyncConnection; here: string; onClose: () => void; onDone: () => void }) {
  const [keepDays, setKeepDays] = useState(connection.keep === 'nothing' ? connection.keepDays ?? 30 : 30)
  const [keepFavorites, setKeepFavorites] = useState(connection.keepFavorites ?? true)
  const [p, setP] = useState<MovePreview | null>(null)
  const files = connection.content === 'files'
  const it = files ? 'files' : 'photos', What = files ? 'Files' : 'Photos'
  useEffect(() => { window.drive.sync.movePreview(device.id, { keepDays, keepFavorites, content: connection.content }).then(setP) }, [keepDays, keepFavorites])
  const start = async () => {
    await window.drive.sync.setConnection(device.id, connection.content, { direction: 'send', keep: 'nothing', keepDays, keepFavorites })
    if (!device.set_up_at) await window.drive.sync.completeSetup(device.id)
    onDone()
  }
  const Here = here[0].toUpperCase() + here.slice(1)
  return (
    <Modal onClose={onClose}>
      <h3>Move {it} from {device.name} to {here}</h3>
      <ol className="move-steps">
        <li>{device.name} sends {here} the {it} it is missing, each checked on arrival. {Here} stops sending {it} to {device.name}.</li>
        <li>{device.name} keeps the last <span className="drive-window"><Days days={keepDays} onChange={setKeepDays} /></span>
          <label className="check-row"><input type="checkbox" checked={keepFavorites} onChange={e => setKeepFavorites(e.target.checked)} /><span>and every favorite, however old</span></label></li>
        {files
          ? <li>Older files that {here} holds go to {device.name}'s own Trash at each sync — only files; every folder stays,
              Documents and Scanned Documents included. They wait there their 30 days and then go to the purgatory.</li>
          : <li>Older photos that {here} holds are offered on {device.name}'s Sync page to move off it — into its Trash, where
              they wait their 30 days and then go to the purgatory. Nothing is removed without that tap.</li>}
        <li>{Here} keeps every one of them, whatever {device.name} puts in its Trash.</li>
      </ol>
      {!p ? <span className="spinner" /> : (
        <>
          <div className="file-row head" style={{ marginTop: 10 }}><span>On {device.name}{p.lastSeen ? `, as of ${when.format(p.lastSeen)}` : ''}</span><span>{What}</span><span>Size</span></div>
          <div className="file-row"><span>Would move to {here}</span><span>{p.go.toLocaleString()}</span><span>{formatBytes(p.goBytes)}</span></div>
          <div className="file-row"><span>Stay on {device.name}</span><span>{p.keep.toLocaleString()}</span><span /></div>
          {p.notOnPc > 0 && <div className="file-row"><span>Not on {here} yet — sent first, then counted</span><span>{p.notOnPc.toLocaleString()}</span><span /></div>}
          {p.holds === 0 && <p className="rule-hint">{device.name} has not listed its {it} yet; the numbers appear after its next sync.</p>}
        </>
      )}
      <p className="rule-hint">A Move means {here} keeps everything and {device.name} only a window. To keep everything on both, choose Both ways or a Copy instead.</p>
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="filled-button" onClick={start}>Start the Move</button>
      </div>
    </Modal>
  )
}

/** What went where, newest first (asked 2026-09-25: "a manifest of what goes and what comes"). */
function HistoryDialog({ here, onClose }: { here: string; onClose: () => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  useEffect(() => { window.drive.history({ limit: 500 }).then(setRows) }, [])
  return (
    <Modal onClose={onClose}>
      <h3>History</h3>
      <p className="rule-hint">Everything that crossed, moved or was deleted, and for which device. Nothing here is ever edited.</p>
      {!rows ? <span className="spinner" /> : rows.length === 0 ? <p className="rule-hint">Nothing yet.</p> : (
        <div className="file-scroll">
          <div className="file-row head history-row"><span>When</span><span>What</span><span>Where</span></div>
          {rows.map(r => (
            <div className="file-row history-row" key={r.id}>
              <span>{when.format(r.at)}</span>
              <span className="file-name"><span><b>{r.action}</b> {r.name ?? ''}{r.detail ? ` — ${r.detail}` : ''}{r.size ? ` · ${formatBytes(r.size)}` : ''}</span></span>
              <span>{r.deviceName ?? here}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

const UNITS = [['day', 1], ['week', 7], ['month', 30], ['year', 365]] as const
/** A number of days, shown as the largest unit it divides into evenly. */
function Days({ days, onChange, allowNever }: { days: number; onChange: (days: number) => void; allowNever?: boolean }) {
  const [unit, per] = [...UNITS].reverse().find(([, n]) => days > 0 && days % n === 0) ?? UNITS[0]
  const never = allowNever && days === 0
  return (
    <span className="drive-window">
      {!never && <input className="field" type="number" min={1} max={999} value={days / per} onChange={e => onChange(Math.max(1, Number(e.target.value) || 1) * per)} />}
      {!never && <select className="field" value={unit} onChange={e => onChange((days / per) * UNITS.find(u => u[0] === e.target.value)![1])}>
        {UNITS.map(([u]) => <option key={u} value={u}>{u}{days / per > 1 ? 's' : ''}</option>)}
      </select>}
      {allowNever && <label><input type="checkbox" checked={never} onChange={e => onChange(e.target.checked ? 0 : 30)} /> never delete</label>}
    </span>
  )
}

/**
 * Trash → Purgatory → gone (SYNC_PLAN.md D6): about sixty days before anything is really deleted, unless the
 * Trash is emptied by hand.
 */
function DeletedItems({ here, drives, setDialog }: { here: string; drives: SyncDevice[]; setDialog: (d: ReactNode) => void }) {
  const [s, setS] = useState<PurgatorySettings | null>(null)
  const load = () => window.drive.purgatory.settings().then(setS)
  useEffect(() => { load() }, [])
  if (!s) return null
  const set = async (changes: Partial<PurgatorySettings>) => { await window.drive.purgatory.set(changes); load() }
  const held = s.summary?.reduce((a, x) => ({ items: a.items + x.items, bytes: a.bytes + x.bytes }), { items: 0, bytes: 0 })
  const place = drives.find(d => d.id === s.location)?.name ?? here
  return (
    <section className="island library">
      <h3><Icon name="trash" size={20} />Deleted items
        <button className="link" onClick={() => setDialog(<HistoryDialog here={here} onClose={() => setDialog(null)} />)}>History</button>
      </h3>
      <p className="rule-hint drive-window">In the Trash for <Days days={s.trashDays} onChange={trashDays => set({ trashDays })} /></p>
      <p className="rule-hint drive-window">then in the purgatory on {place} for <Days days={s.purgatoryDays} allowNever onChange={purgatoryDays => set({ purgatoryDays })} /></p>
      <p className="rule-hint">After its time in the Trash an item is not deleted: it goes to a hidden <b>.purgatory</b> folder on the{' '}
        {s.location ? 'drive' : 'computer'}, checked byte for byte, and only after that time is it gone. {s.location ? 'With the drive unplugged it waits in the Trash. ' : 'Tick \u201cKeep the purgatory here\u201d on a drive\u2019s card to keep it there instead. '}
        Emptying the Trash by hand is a plain delete.{held && held.items > 0 && ` The purgatory holds ${held.items.toLocaleString()} items, ${formatBytes(held.bytes)}.`}</p>
    </section>
  )
}

/**
 * "Free 22 GB — 3,100 photos older than a year are safe on T7-TEO. Yes?" (SYNC_PLAN.md D3). Each photo is read
 * back from the drive before this computer's copy goes to the Trash; it stays in the library either way.
 */
export function OffloadDialog({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [plan, setPlan] = useState<OffloadPlan | null>(null)
  const [busy, setBusy] = useState<{ done: number; total: number; moved: number } | null>(null)
  const [done, setDone] = useState<{ moved: number; bytes: number; failed: string[] } | null>(null)
  const [after, setAfter] = useState<Disk | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { window.drive.sync.offloadPlan(deviceId).then(setPlan, e => setError(String(e))) }, [deviceId])
  useEffect(() => { if (done) window.drive.sync.status().then(s => setAfter(s.disk)) }, [done])
  useEffect(() => window.drive.sync.onMoveProgress(setBusy), [])
  const go = async (limit?: number) => {
    setBusy({ done: 0, total: limit ?? plan?.count ?? 0, moved: 0 }); setError('')
    try { setDone(await window.drive.sync.moveToDrive(deviceId, limit ? { limit } : {})) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(null)
  }
  if (done) return (
    <Modal onClose={onClose}>
      <h3>{formatBytes(done.bytes)} freed</h3>
      <p>{done.moved.toLocaleString()} photos now live on {plan?.name}. They are still in Photos, People and search; opening
        one needs {plan?.name} plugged in.</p>
      {after && <p className="rule-hint">This disk now: {after.percent} % full, {formatBytes(after.free)} free.</p>}
      {done.failed.length > 0 && <p className="error">{done.failed.length} stayed here: {done.failed.slice(0, 3).join(' · ')}</p>}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>Close</button></div>
    </Modal>
  )
  const why = plan && (plan.rules.offload ? `to bring this disk under ${plan.rules.percent} %`
    : `older than ${plan.rules.keep} ${plan.rules.unit}${plan.rules.keep > 1 ? 's' : ''}`)
  return (
    <Modal onClose={busy ? () => {} : onClose}>
      {!plan ? (error ? <p className="error">{error}</p> : <span className="spinner" />) : plan.count === 0 ? (
        <><h3>Nothing to free</h3><p className="rule-hint">Every photo {why} that {plan.name} holds has already left this PC,
          or is a favorite{plan.rules.copies > 1 ? `, or is not yet in ${plan.rules.copies} places` : ''}. A backup to {plan.name} runs
          by itself while it is plugged in.</p></>
      ) : (
        <>
          <h3>Free {formatBytes(plan.bytes)}?</h3>
          <p>{plan.count.toLocaleString()} photos {why} are safe on <b>{plan.name}</b>
            {plan.oldest && plan.newest && <> — from {day.format(plan.oldest)} to {day.format(plan.newest)}</>}.</p>
          <p className="rule-hint">Each one is read back from {plan.name} and checked, and only then is this PC's copy deleted —
            not put in the Trash, which is on this same disk and would free nothing. They stay in your library: thumbnails,
            People, collections and search keep them, and they open from {plan.name} whenever it is plugged in.{plan.rules.favorites && ' Favorites stay here.'}</p>
          {plan.disk && <p className="rule-hint">This disk: {plan.disk.percent} % full, {formatBytes(plan.disk.free)} free.</p>}
          {!!plan.short && <p className="rule-hint risk">Even every photo that may go leaves this disk above {plan.rules.percent} %:
            another {formatBytes(plan.short)} is other things on it.</p>}
        </>
      )}
      {busy && <p className="rule-hint">Checking and moving… {busy.done.toLocaleString()} of {busy.total.toLocaleString()}, {busy.moved.toLocaleString()} moved.</p>}
      {error && plan && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={!!busy}>{plan?.count ? 'Not now' : 'Close'}</button>
        {!!plan?.count && plan.count > 10 && <button disabled={!!busy} onClick={() => go(10)}>Try 10 first</button>}
        {!!plan?.count && <button className="filled-button" disabled={!!busy} onClick={() => go()}>Yes, free {formatBytes(plan.bytes)}</button>}
      </div>
    </Modal>
  )
}

/**
 * A drive's card (SYNC_PLAN.md D3): what is copied to it, and what it is for. A backup holds a copy of
 * everything; storage is also where photos go to live when this PC lets them go — oldest first, either to keep
 * this disk under a line (Offload on) or to keep only the last year / month / week here (Offload off).
 */
function DriveCard({ device, disk, onChange, setDialog }: { device: SyncDevice; disk: Disk | null; onChange: () => void; setDialog: (d: ReactNode) => void }) {
  const r = device.rules!
  const [plan, setPlan] = useState<OffloadPlan | null>(null)
  const [backing, setBacking] = useState('')
  const [purgatoryHere, setPurgatoryHere] = useState<boolean | null>(null)
  const [moving, setMoving] = useState('')
  useEffect(() => { window.drive.purgatory.settings().then(s => setPurgatoryHere(s.location === device.id)) }, [device.id])
  const placePurgatory = async (here: boolean) => {
    setMoving('Moving the purgatory…')
    const r = await window.drive.purgatory.setLocation(here ? device.id : null)
    setPurgatoryHere(here)
    setMoving(r.failed.length ? `${r.moved} moved, ${r.failed.length} failed.` : r.waiting ? `${r.moved} moved; ${r.waiting} wait until the drive they are on is plugged in.` : '')
    onChange()
  }
  // Again whenever the disk changes: after a Free space the card must not still offer what already went.
  useEffect(() => { if (r.role === 'storage') window.drive.sync.offloadPlan(device.id).then(setPlan).catch(() => setPlan(null)) }, [device.id, JSON.stringify(r), disk?.free])
  const set = async (changes: Partial<DriveRules>) => { await window.drive.sync.setDriveRules(device.id, changes); onChange() }
  const copy = async (content: string, on: boolean) => {
    await window.drive.sync.setConnection(device.id, content, { direction: on ? 'receive' : 'off', keep: 'everything' })
    if (!device.set_up_at) await window.drive.sync.completeSetup(device.id)
    onChange()
  }
  const backUp = async () => {
    setBacking('Backing up…')
    try { const b = await window.drive.sync.backUpToDrive(device.id); setBacking(`${b.copied.toLocaleString()} copied, ${b.already.toLocaleString()} already there${b.failed.length ? `, ${b.failed.length} failed` : ''}.`) }
    catch (e) { setBacking(e instanceof Error ? e.message : String(e)) }
    onChange()
  }
  const opt = (on: boolean, icon: IconName, label: string, click: () => void, note?: string) => (
    <button className={on ? 'on' : ''} onClick={click}>
      <span className="glyph"><Icon name={icon} size={18} /></span><span className="rule-label">{label}</span>{note && <span className="rule-note">{note}</span>}
    </button>
  )
  return (
    <>
      {device.connections.map(c => {
        const on = c.direction === 'receive' || c.direction === 'both'
        const what = c.content === 'files' ? 'Drive files' : 'Photos'
        return (
          <section key={c.content} className="connection-rules">
            <h4><Icon name={c.content === 'files' ? 'folder' : 'photos'} size={18} />{what}</h4>
            <div className="rule-options">
              {opt(!on, 'block', 'Off', () => copy(c.content, false))}
              {opt(on, 'arrowRight', `Copy to ${device.name}`, () => copy(c.content, true))}
            </div>
          </section>
        )
      })}
      <section className="connection-rules">
        <h4><Icon name="database" size={18} />What {device.name} is for</h4>
        <div className="rule-options">
          {opt(r.role === 'backup', 'copy', 'Backup', () => set({ role: 'backup' }), 'a copy')}
          {opt(r.role === 'storage', 'moveTo', 'Storage', () => set({ role: 'storage' }), 'photos live here')}
        </div>
        {r.role === 'storage' && (
          <>
            <div className="rule-options">
              {opt(r.offload, 'moveTo', 'Offload on', () => set({ offload: true }), 'keep the disk under a line')}
              {opt(!r.offload, 'photos', 'Offload off', () => set({ offload: false }), 'keep a window here')}
            </div>
            {r.offload ? (
              <label className="rule-hint drive-slider">Keep this disk under <b>{r.percent} %</b> full{disk && ` (now ${disk.percent} %)`}
                <input type="range" min={50} max={95} step={5} defaultValue={r.percent} onChange={e => set({ percent: Number(e.target.value) })} />
              </label>
            ) : (
              <label className="rule-hint drive-window">Keep the last
                <input className="field" type="number" min={1} max={1000} value={r.keep} onChange={e => set({ keep: Math.max(1, Number(e.target.value) || 1) })} />
                <select className="field" value={r.unit} onChange={e => set({ unit: e.target.value as DriveRules['unit'] })}>
                  {(['day', 'week', 'month', 'year'] as const).map(u => <option key={u} value={u}>{u}{r.keep > 1 ? 's' : ''}</option>)}
                </select>
                on this PC
              </label>
            )}
            <label className="rule-hint drive-window">Only once
              <select className="field" value={r.copies} onChange={e => set({ copies: Number(e.target.value) })}>
                {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {r.copies === 1 ? 'place holds it' : 'places hold it'} ({device.name} counts, this PC does not)
            </label>
            <label className="rule-hint check-row"><input type="checkbox" checked={r.favorites} onChange={e => set({ favorites: e.target.checked })} /><span>Favorites always stay on this PC</span></label>
            <p className="rule-hint">{plan ? (plan.count ? <>{plan.count.toLocaleString()} photos, <b>{formatBytes(plan.bytes)}</b>, could go now.</> : 'Nothing to free right now.') : '…'}
              {' '}{r.auto ? 'It goes by itself, and you are told.' : 'You are always asked first.'}</p>
            <label className="rule-hint check-row"><input type="checkbox" checked={r.auto} onChange={e => set({ auto: e.target.checked })} /><span>Free space by itself, without asking</span></label>
            {!!plan?.count && <button className="filled-button" onClick={() => setDialog(<OffloadDialog deviceId={device.id} onClose={() => { setDialog(null); onChange() }} />)}>Free {formatBytes(plan.bytes)}…</button>}
          </>
        )}
        <label className="rule-hint check-row"><input type="checkbox" checked={!!r.screenshots} onChange={e => set({ screenshots: e.target.checked })} /><span>Back up screenshots</span></label>
        {purgatoryHere !== null && <label className="rule-hint check-row"><input type="checkbox" checked={purgatoryHere} disabled={!!moving && moving.endsWith('…')}
          onChange={e => placePurgatory(e.target.checked)} /><span>Keep the purgatory here<br />otherwise it stays on this PC</span></label>}
        {moving && <p className="rule-hint">{moving}</p>}
        <button className="text-button" onClick={backUp} disabled={backing === 'Backing up…'}>Back up now</button>
        {backing && <p className="rule-hint">{backing}</p>}
      </section>
    </>
  )
}

export function SyncPage({ setDialog }: { setDialog: (d: ReactNode) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = () => window.drive.sync.status().then(setStatus)
  useEffect(() => { load(); const off = window.drive.sync.onReceived(load); const t = setInterval(load, 3000); return () => { off(); clearInterval(t) } }, [])
  const close = () => { setDialog(null); load() }
  const add = () => setDialog(<AddDevice onClose={() => setDialog(null)} onDone={close} setDialog={setDialog} />)
  const forget = (d: SyncDevice) => setDialog(<Confirm title={`Forget ${d.name}?`} action="Forget device" danger onClose={close}
    body="It can no longer send photos until you pair it again. Photos already received stay." onConfirm={async () => { await window.drive.sync.forget(d.id).catch(e => alert(e instanceof Error ? e.message : String(e))); load() }} />)
  const state = (d: SyncDevice) => !d.last_seen ? 'Not connected yet' : Date.now() - d.last_seen < 15_000 ? 'Connected · sending' : Date.now() - d.last_seen < 120_000 ? 'Connected' : `Last seen ${when.format(d.last_seen)}`
  const devices = status?.devices ?? []
  const self = status?.self
  const here = self?.label ?? 'here'
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><Icon name="device" /><h1>Devices</h1></div>
        {self && (
          <div className="island self-island">
            <button className="self-chip" onClick={() => setDialog(<SelfEditor self={self} onDone={close} />)}
              title="What this machine is, and what to call it">
              <Icon name={self.kind as IconName} size={20} />
              <span>This device</span>
              {status?.counts && <span className="device-tally inline">
                <span title={`photos on ${here}`}><Icon name="photos" size={16} />{status.counts.photos.toLocaleString()}</span>
                <span title={`files on ${here}`}><Icon name="folder" size={16} />{status.counts.files.toLocaleString()}</span>
              </span>}
            </button>
            <button className="round small" title="What this machine does for the others"
              onClick={() => setDialog(<HubInfo self={self} onClose={() => setDialog(null)} />)}><Icon name="info" size={18} /></button>
          </div>
        )}
      </header>
      {status?.error && <div className="island analysis"><Icon name="warning" /><span>Sync is not running: {status.error}</span></div>}
      {status && devices.length === 0 && !status.error && (
        <div className="island add-first">
          <h2>Pair your phone</h2>
          <PairingCode />
        </div>
      )}
      {status?.overview && devices.length > 0 && <Library overview={status.overview} paired={devices} here={here} setDialog={setDialog} />}
      {devices.length > 0 && <DeletedItems here={here} drives={devices.filter(d => d.volume_uuid)} setDialog={setDialog} />}
      {devices.length > 0 && (
        <div className="device-grid">
          {devices.map(d => {
            const s = state(d)
            return (
              <div key={d.id} className="island device-card">
                <header className="device-head">
                  <button className="card-edit" title="Rename, or change the picture"
                    onClick={() => setDialog(<DeviceEditor device={d} onDone={close} />)}><Icon name="edit" size={20} /></button>
                  <span className={`sync-badge ${s.startsWith('Connected') ? 'on' : ''}`}><Icon name={(d.kind as IconName) ?? 'device'} size={30} /></span>
                  <strong>{d.name}</strong>
                  <small className={s.startsWith('Connected') ? 'live' : ''}>{s}</small>
                  <div className="device-tally">
                    <span title={`photos on ${d.name}`}><Icon name="photos" size={16} />{d.holdsPhotos.toLocaleString()}</span>
                    <span title={`files on ${d.name}`}><Icon name="folder" size={16} />{d.holdsFiles == null ? '—' : d.holdsFiles.toLocaleString()}</span>
                  </div>
                </header>
                {!d.set_up_at && (
                  <p className="rule-hint risk">Not set up yet — nothing crosses until you say what should.
                    Choose below, then it starts.</p>
                )}
                {d.volume_uuid && d.rules ? <DriveCard device={d} disk={status?.disk ?? null} onChange={load} setDialog={setDialog} />
                  : d.connections?.map(c => <Rules key={c.content} device={d} connection={c} here={here} setDialog={setDialog}
                  onChange={async () => { if (!d.set_up_at) await window.drive.sync.completeSetup(d.id); load() }} />)}
                <footer className="device-foot">
                  <small>Paired {when.format(d.paired_at)}</small>
                  <button className="text-button" onClick={() => forget(d)}>Forget</button>
                </footer>
              </div>
            )
          })}
          <button className="island device-card add" onClick={add}>
            <span className="sync-badge"><Icon name="add" size={30} /></span>
            <strong>Add a device</strong>
            <small>Show a pairing code</small>
          </button>
        </div>
      )}
      {status && !status.error && <p className="hint">Listening on {status.addresses.join(', ') || 'this computer'} · port {status.port}. Only paired devices can reach it. Every file is checked by SHA-256 on the side that receives it before it is kept, nothing is overwritten, and a sync never deletes anything on either device.</p>}
    </div>
  )
}
