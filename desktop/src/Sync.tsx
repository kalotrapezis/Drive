import { useEffect, useState, type ReactNode } from 'react'
import type { IconName } from './Icon'
import type { Drive, DriveScan, SyncConnection, SyncDevice, SyncFile, SyncOverview, SyncSelf, SyncStatus } from './drive'
import { formatBytes } from './timeline'
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
function Rules({ device, connection, here, onChange }: { device: SyncDevice; connection: SyncConnection; here: string; onChange: () => void }) {
  const what = connection.content === 'files' ? 'Files' : 'Photos'
  const it = connection.content === 'files' ? 'files' : 'photos'
  const set = async (direction: string, keep = connection.keep) => {
    await window.drive.sync.setConnection(device.id, connection.content, { direction, keep })
    onChange()
  }
  // Keep is only a question where there is one source and one direction. Two-way cannot delete on either side,
  // and Off moves nothing at all, so both are simply Copy.
  const canMove = connection.direction === 'send'
  const directions = [
    { value: 'off', icon: 'block', flip: false, label: 'Off', hint: `No ${it} cross, in either direction.` },
    { value: 'send', icon: 'arrowRight', flip: false, label: `${device.name} → ${here}`, hint: `${what} on ${device.name} are copied to ${here}.` },
    { value: 'receive', icon: 'arrowRight', flip: true, label: `${here} → ${device.name}`, hint: `${what} on ${here} are copied to ${device.name}.` },
    { value: 'both', icon: 'swap', flip: false, label: 'Both ways', hint: `Each side sends the ${it} the other is missing. Always a copy.` },
  ] as const
  const keeps = [
    { value: 'everything', icon: 'copy', label: 'Keep everything', note: 'Copy' },
    { value: 'nothing', icon: 'moveTo', label: 'Keep nothing', note: 'Move' },
  ] as const
  const chosen = directions.find(d => d.value === connection.direction)
  return (
    <section className="connection-rules">
      <h4><Icon name={connection.content === 'files' ? 'folder' : 'photos'} size={18} />{what}</h4>
      <div className="rule-options">
        {directions.map(d => (
          <button key={d.value} className={connection.direction === d.value ? 'on' : ''} onClick={() => set(d.value)}>
            <span className={d.flip ? 'glyph flip' : 'glyph'}><Icon name={d.icon} size={18} /></span>
            <span className="rule-label">{d.label}</span>
          </button>
        ))}
      </div>
      {canMove && (
        <div className="rule-options keep">
          {keeps.map(k => (
            <button key={k.value} className={connection.keep === k.value ? 'on' : ''} onClick={() => set('send', k.value)}>
              <span className="glyph"><Icon name={k.icon} size={18} /></span>
              <span className="rule-label">{k.label}</span>
              <span className="rule-note">{k.note}</span>
            </button>
          ))}
        </div>
      )}
      <p className="rule-hint">
        {chosen?.hint}
        {canMove && connection.keep === 'nothing' && ` ${device.name} then offers to move them off itself, once
          ${here} has read each one back and it matches — through Android's own dialog, into its own Trash.`}
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
  const at = (n: number) => overview.copies.find(c => c.copies === n)
  const one = at(1)
  const two = at(2)
  const more = overview.copies.filter(c => c.copies >= 3).reduce((a, c) => ({ files: a.files + c.files, bytes: a.bytes + c.bytes }), { files: 0, bytes: 0 })
  const notHere = total - overview.here.files
  const bands = [
    { key: 'alone', label: 'One copy', files: one?.files ?? 0, bytes: one?.bytes ?? 0, hint: 'in one place in the world' },
    { key: 'two', label: 'Two places', files: two?.files ?? 0, bytes: two?.bytes ?? 0, hint: 'one machine could fail' },
    { key: 'more', label: 'Three or more', files: more.files, bytes: more.bytes, hint: 'safe' },
  ]
  return (
    <section className="island library">
      <h3><Icon name="database" size={20} />The library, and where it is</h3>
      <p className="library-total">
        <strong>{total.toLocaleString()}</strong> photos known · <strong>{overview.here.files.toLocaleString()}</strong> of them on {here}
        {notHere > 0 && <> · <b className="risk">{notHere.toLocaleString()} only on a device</b></>}
      </p>
      <div className="copies-bar" role="img" aria-label="how many machines hold each file">
        {bands.map(b => b.files > 0 && <i key={b.key} className={b.key} style={{ width: `${(b.files / total) * 100}%` }} title={`${b.label}: ${b.files.toLocaleString()}`} />)}
      </div>
      <ul className="copies-key">
        {bands.map(b => (
          <li key={b.key}><span className={`dot ${b.key}`} />
            {b.key === 'alone' && b.files > 0
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
        <thead><tr><th>Device</th><th>Holds</th><th>Also on {here.replace(/^this /, '')}</th><th>Only there</th><th>Could free</th></tr></thead>
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
  const start = async () => {
    if (!picked) return
    setBusy({ done: 0, total: scan?.total ?? 0, copied: 0 })
    try {
      const device = picked.device ?? await window.drive.sync.addDrive({ uuid: picked.uuid, label: picked.label })
      for (const [content, direction] of Object.entries(rules)) {
        await window.drive.sync.setConnection(device.id, content, { direction, keep: 'everything' })
      }
      await window.drive.sync.completeSetup(device.id)
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
              <p className="rule-hint">A Drive file that changed replaces the drive's copy, and the older one is kept in
                Tetra/Files history. Moving photos off this PC (Offload) is not built yet.</p>
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

export function SyncPage({ setDialog }: { setDialog: (d: ReactNode) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = () => window.drive.sync.status().then(setStatus)
  useEffect(() => { load(); const off = window.drive.sync.onReceived(load); const t = setInterval(load, 3000); return () => { off(); clearInterval(t) } }, [])
  const close = () => { setDialog(null); load() }
  const add = () => setDialog(<AddDevice onClose={() => setDialog(null)} onDone={close} setDialog={setDialog} />)
  const forget = (d: SyncDevice) => setDialog(<Confirm title={`Forget ${d.name}?`} action="Forget device" danger onClose={close}
    body="It can no longer send photos until you pair it again. Photos already received stay." onConfirm={async () => { await window.drive.sync.forget(d.id); load() }} />)
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
                    <span title="photos received"><Icon name="photos" size={16} />{d.received.toLocaleString()}</span>
                    <span title="Drive files received"><Icon name="folder" size={16} />{d.filesReceived.toLocaleString()}</span>
                  </div>
                </header>
                {!d.set_up_at && (
                  <p className="rule-hint risk">Not set up yet — nothing crosses until you say what should.
                    Choose below, then it starts.</p>
                )}
                {d.connections?.map(c => <Rules key={c.content} device={d} connection={c} here={here}
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
