import { useEffect, useState, type ReactNode } from 'react'
import type { IconName } from './Icon'
import type { Disk, Drive, DriveScan, HistoryRow, OffloadPlan, PurgatorySettings, SyncDevice, SyncFile, SyncOverview, SyncSelf, SyncStatus } from './drive'
import { formatBytes } from './timeline'
import { copiesColor } from './colors'
import { Icon } from './Icon'
import { Confirm, Modal } from './Dialogs'
import { lang, t, tr } from './i18n'
import { ClientCard, PairingKey } from './Role'
import { DeviceRules, DriveRulesCard } from './DeviceCard'
import type { MailDevice } from './drive'

const LOCALE = lang() === 'en' ? 'en-GB' : lang()
const when = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Pairing QR: the phone scans it in Tetra › Sync. It carries the address, the certificate fingerprint and a one-time code. */
function PairingCode() {
  const [pair, setPair] = useState<{ qr: string; payload: { hosts: string[]; port: number; key: string } } | null>(null)
  const [left, setLeft] = useState(600)
  const renew = () => { setPair(null); setLeft(600); window.drive.sync.pair().then(setPair) }
  useEffect(renew, [])
  useEffect(() => { const t = setInterval(() => setLeft(s => Math.max(0, s - 1)), 1000); return () => clearInterval(t) }, [])
  return (
    <div className="pairing">
      <div className="qr">{pair && left ? <img src={pair.qr} alt={t('sync.pairQrAlt')} /> : left ? <span className="spinner" /> : <button className="filled-button" onClick={renew}>{t('sync.newCode')}</button>}</div>
      <ol>
        <li>{tr('sync.pairStep1', { tetra: <b>Tetra</b>, sync: <b>{t('sync.localSync')}</b> })}</li>
        <li>{tr('sync.pairStep2', { pair: <b>{t('sync.pairWithComputer')}</b> })}</li>
        <li>{t('sync.pairStep3')}</li>
      </ol>
      <p className="hint">{left ? t('sync.codeWorks', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('sync.codeExpired')}
        {pair && ' ' + t('sync.codeAddress', { hosts: pair.payload.hosts.join(', ') || t('sync.noNetwork'), port: pair.payload.port })}</p>
      {pair && left > 0 && <PairingKey value={pair.payload.key} />}
    </div>
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
  { kind: 'device', label: 'sync.kindPhone' },
  { kind: 'tablet', label: 'sync.kindTablet' },
  { kind: 'computer', label: 'sync.kindComputer' },
  { kind: 'server', label: 'sync.kindServer' },
  { kind: 'database', label: 'sync.kindStorage' },
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
      <h3>{t('sync.thisDevice')}</h3>
      <label className="editor-label" htmlFor="device-name">{t('sync.whatToCall')}</label>
      <input id="device-name" className="field" value={name} onChange={e => setName(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save() }} />
      <div className="rule-options kind-picker">
        {DEVICE_KINDS.map(k => (
          <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            <span className="glyph"><Icon name={k.kind} size={18} /></span>
            <span className="rule-label">{t(k.label)}</span>
          </button>
        ))}
      </div>
      <p className="rule-hint">{t('sync.reportedName', { name: device.name })}</p>
      <div className="dialog-actions">
        <button onClick={onDone}>{t('common.cancel')}</button>
        <button className="filled-button" onClick={save}>{t('common.save')}</button>
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
      <h3>{t('sync.thisDevice')}</h3>
      <label className="editor-label" htmlFor="self-name">{t('sync.whatToCall')}</label>
      <input id="self-name" className="field" value={name} onChange={e => setName(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save() }} />
      <div className="rule-options kind-picker">
        {DEVICE_KINDS.map(k => (
          <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            <span className="glyph"><Icon name={k.kind} size={18} /></span>
            <span className="rule-label">{t(k.label)}</span>
          </button>
        ))}
      </div>
      <p className="rule-hint">{t('sync.selfWordHint', { word: SELF_WORDS[kind] ? t(SELF_WORDS[kind]) : t('sync.here') })}</p>
      <div className="dialog-actions">
        <button onClick={onDone}>{t('common.cancel')}</button>
        <button className="filled-button" onClick={save}>{t('common.save')}</button>
      </div>
    </Modal>
  )
}

const SELF_WORDS: Record<string, string> = { device: 'sync.selfDevice', tablet: 'sync.selfTablet', computer: 'sync.selfComputer', server: 'sync.selfServer', database: 'sync.selfDatabase' }

/** What this machine does for the others, said once, where it is asked. */
function HubInfo({ self, onClose }: { self: SyncSelf; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>{t('sync.hubTitle', { name: self.name })}</h3>
      <p>{t('sync.hub1', { label: self.label })}</p>
      <p>{tr('sync.hub2', { connect: <b>{t('sync.hubConnect')}</b> })}</p>
      <p>{tr('sync.hub3', { offered: <i>{t('sync.hubOffered')}</i> })}</p>
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
}

/**
 * Why a file never reached this computer, as far as this computer can tell. The direction row is the one
 * answer it holds with certainty; everything else it can only say honestly that it does not know.
 */
function whyNotHere(name: string, count: number, here: string, device?: SyncDevice): string {
  const direction = device?.connections?.find(c => c.content === 'photos')?.direction
  const head = t('sync.whyHead', { Here: `${here[0].toUpperCase()}${here.slice(1)}`, count, n: count.toLocaleString() })
  if (direction === 'receive') return t('sync.whyReceive', { head, name, here })
  if (direction === 'off') return t('sync.whyOff', { head, name })
  return t('sync.whyOther', { head, name })
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
      {!files ? <span className="spinner" /> : files.length === 0 ? <p className="rule-hint">{t('sync.nothingGood')}</p> : (
        <div className="file-scroll">
          <div className="file-row head"><span>{t('sync.colFile')}</span><span>{t('sync.colSize')}</span><span>{t('sync.colWhere')}</span></div>
          {files.map(f => (
            <div className="file-row" key={f.sha256 + (f.device ?? '')}>
              <span className="file-name">
                <Icon name={f.isVideo ? 'video' : 'photos'} size={16} />
                <span>{f.name ? f.name.split('/').pop() : <i>{t('sync.notNamed')}</i>}</span>
              </span>
              <span>{f.size ? formatBytes(f.size) : '—'}</span>
              <span>{f.here ? here : f.device}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
}

function Library({ overview, paired, here, setDialog }: { overview: SyncOverview; paired: SyncDevice[]; here: string; setDialog: (d: ReactNode) => void }) {
  const total = overview.known
  if (!total) return null
  const stored = overview.stored ?? []
  const notHere = total - overview.here.files - stored.reduce((a, s) => a + s.files, 0)
  // One band per number of places, as many as there are devices holding photos, each a colour of its own (copiesColor).
  const WORDS = ['', 'sync.copies1', 'sync.copies2', 'sync.copies3', 'sync.copies4', 'sync.copies5', 'sync.copies6']
  const bands = overview.copies.filter(c => c.copies > 0).map(c => ({
    key: `c${c.copies}`, copies: c.copies, color: copiesColor(c.copies),
    label: WORDS[c.copies] ? t(WORDS[c.copies]) : t('sync.copiesN', { n: c.copies }), files: c.files, bytes: c.bytes,
    hint: c.copies === 1 ? t('sync.hintOne') : c.copies === 2 ? t('sync.hintTwo') : t('sync.hintSafe'),
  }))
  return (
    <section className="island library">
      <h3><Icon name="database" size={20} />{t('sync.libraryTitle')}</h3>
      <p className="library-total">
        {tr('sync.totalKnown', { total: <strong>{total.toLocaleString()}</strong>, onHere: <strong>{overview.here.files.toLocaleString()}</strong>, here })}
        {stored.map(s => <span key={s.name}> · {tr('sync.totalOn', { n: <strong>{s.files.toLocaleString()}</strong>, name: s.name })}</span>)}
        {notHere > 0 && <> · <b className="risk">{t('sync.onlyOnDevice', { n: notHere.toLocaleString() })}</b></>}
      </p>
      <div className="copies-bar" role="img" aria-label={t('sync.copiesAria')}>
        {bands.map(b => b.files > 0 && <i key={b.copies} className={b.key} style={{ width: `${(b.files / total) * 100}%`, background: b.color }} title={`${b.label}: ${b.files.toLocaleString()}`} />)}
      </div>
      <ul className="copies-key">
        {bands.map(b => (
          <li key={b.copies}><span className="dot" style={{ background: b.color }} />
            {b.copies === 1 && b.files > 0
              ? <button className="link" onClick={() => setDialog(<FileList what="alone" here={here} title={t('sync.aloneTitle')} onClose={() => setDialog(null)}
                  why={t('sync.aloneWhy')} />)}>{b.label}</button>
              : b.label}
            <small>{b.files.toLocaleString()} {b.bytes > 0 && `· ${formatBytes(b.bytes)} `}— {b.hint}</small>
          </li>
        ))}
      </ul>
      {overview.kinds.length > 0 && (
        <>
          <h4 className="library-sub">{t('sync.madeOf')}
            <button className="link" onClick={() => setDialog(<FileList what="largest" here={here} title={t('sync.biggestTitle', { here })} onClose={() => setDialog(null)} />)}>{t('sync.biggestLink')}</button>
          </h4>
          <div className="copies-bar kinds" role="img" aria-label={t('sync.madeOfAria')}>
            {overview.kinds.map(k => <i key={k.kind} className={k.kind} style={{ width: `${(k.bytes / Math.max(1, overview.here.bytes)) * 100}%` }} title={`${k.kind}: ${formatBytes(k.bytes)}`} />)}
          </div>
          <ul className="copies-key">
            {overview.kinds.map(k => (
              <li key={k.kind}><span className={`dot ${k.kind}`} />{k.kind === 'video' ? t('sync.kindVideos') : k.kind === 'document' ? t('sync.kindDocuments') : t('app.photos')}
                <small>{t('sync.kindShare', { files: k.files.toLocaleString(), size: formatBytes(k.bytes), pct: Math.round((k.bytes / Math.max(1, overview.here.bytes)) * 100) })}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      <table className="holdings">
        <thead><tr><th>{t('sync.colDevice')}</th><th>{t('sync.colHolds')}</th><th>{t('sync.colAlso')}</th><th>{t('sync.colOnlyThere')}</th><th>{t('sync.colCouldFree')}</th></tr></thead>
        <tbody>
          {overview.devices.map(d => (
            <tr key={d.id}>
              <th scope="row"><Icon name={(paired.find(p => p.id === d.id)?.kind as IconName) ?? 'device'} size={16} />{d.name}<small>{d.last_seen ? t('sync.asOf', { when: when.format(d.last_seen) }) : t('sync.neverSynced')}</small></th>
              <td>{d.holds.toLocaleString()}</td>
              <td>{d.alsoHere.toLocaleString()}</td>
              <td className={d.onlyThere > 0 ? 'risk' : ''}>
                {d.onlyThere > 0
                  ? <button className="link risk" onClick={() => setDialog(<FileList what="onlyThere" deviceId={d.id} here={here} title={t('sync.onlyThereTitle', { name: d.name })} onClose={() => setDialog(null)}
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
          {t('sync.staleReceipts', { count: overview.staleReceipts, n: overview.staleReceipts.toLocaleString(), here })}
        </p>
      )}
      <p className="library-note">
        {tr('sync.libraryNote', { here, couldFree: <b>{t('sync.colCouldFree')}</b> })}
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
      <h3>{t('sync.addDevice')}</h3>
      <div className="rule-options">
        <button onClick={() => setDialog(<Modal onClose={onDone}><h3>{t('sync.pairPhoneOrTablet')}</h3><PairingCode />
          <p className="rule-hint">{t('sync.pairNothingCrosses')}</p>
          <div className="dialog-actions"><button className="filled-button" onClick={onDone}>{t('common.done')}</button></div></Modal>)}>
          <span className="glyph"><Icon name="device" size={18} /></span>
          <span className="rule-label">{t('sync.addPhone')}<small> · {t('sync.addPhoneSub')}</small></span>
        </button>
        <button onClick={() => setDialog(<AddDrive onClose={onClose} onDone={onDone} />)}>
          <span className="glyph"><Icon name="database" size={18} /></span>
          <span className="rule-label">{t('sync.addDrivePlugged')}<small> · {t('sync.addDriveSub')}</small></span>
        </button>
      </div>
      <div className="dialog-actions"><button onClick={onClose}>{t('common.cancel')}</button></div>
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
      <h3>{t('sync.driveUpToDate', { name: picked?.label ?? '' })}</h3>
      <p>{t('sync.copiedAlready', { copied: done.copied.toLocaleString(), already: done.already.toLocaleString() })}
        {done.failed.length > 0 && ' ' + t('sync.couldNotCopy', { n: done.failed.length })}</p>
      {done.failed.slice(0, 5).map(f => <p key={f} className="error">{f}</p>)}
      <p className="rule-hint">{t('sync.countsAsCopy')}</p>
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <h3>{t('sync.addDrive')}</h3>
      {!list ? <span className="spinner" /> : list.length === 0 ? (
        <p className="rule-hint">{t('sync.noDrive')}</p>
      ) : (
        <div className="rule-options drive-list">
          {list.map(d => (
            <button key={d.uuid} className={picked?.uuid === d.uuid ? 'on' : ''} disabled={!!busy} onClick={() => select(d)}>
              <span className="glyph"><Icon name="database" size={18} /></span>
              <span className="rule-label">{d.label}<small> · {d.fstype} · {t('sync.free', { size: formatBytes(d.freeBytes) })}</small></span>
              {d.device && <span className="rule-note">{t('sync.added')}</span>}
            </button>
          ))}
        </div>
      )}
      {picked && !scan && <p className="rule-hint">{t('sync.lookingAt', { name: picked.label })}</p>}
      {scan?.plugged && (
        <>
          <div className="file-row head" style={{ marginTop: 14 }}><span>{t('sync.wouldHappen')}</span><span>{t('app.files')}</span><span>{t('sync.colSize')}</span></div>
          <div className="file-row"><span>{t('sync.alreadyOn', { name: picked?.label ?? '' })}</span><span>{((scan.have ?? 0) + (scan.files?.have ?? 0)).toLocaleString()}</span><span>{formatBytes(scan.haveBytes ?? 0)}</span></div>
          <div className="file-row"><span>{t('sync.photosToCopy')}</span><span>{scan.need?.toLocaleString()}</span><span>{formatBytes(scan.needBytes ?? 0)}</span></div>
          <div className="file-row"><span>{t('sync.driveFilesToCopy')}</span><span>{scan.files?.need.toLocaleString()}</span><span>{formatBytes(scan.files?.needBytes ?? 0)}</span></div>
          <div className="file-row"><span>{t('sync.freeAfter')}</span><span /><span>{formatBytes(Math.max(0, (scan.free ?? 0) - (scan.needBytes ?? 0) - (scan.files?.needBytes ?? 0)))}</span></div>
          {!scan.writable && <p className="error">{t('sync.cannotWrite', { mount: scan.mount ?? '' })}</p>}
          {scan.writable && !scan.enough && <p className="error">{t('sync.notEnoughRoom', { need: formatBytes(scan.needBytes ?? 0), free: formatBytes(scan.free ?? 0) })}</p>}
          {scan.writable && scan.enough && (
            <>
              <h4 className="library-sub" style={{ marginTop: 16 }}>{t('sync.andTheRules')}</h4>
              {(['photos', 'files'] as const).map(content => (
                <div key={content} className="rule-options" style={{ marginBottom: 6 }}>
                  {([['off', 'block', content === 'photos' ? t('sync.noPhotos') : t('sync.noDriveFiles')],
                     ['receive', 'arrowRight', t(content === 'photos' ? 'sync.copyPhotosTo' : 'sync.copyDriveFilesTo', { name: picked?.label ?? '' })]] as const).map(([value, icon, label]) => (
                    <button key={value} className={rules[content] === value ? 'on' : ''}
                      onClick={() => setRules(r => ({ ...r, [content]: value }))}>
                      <span className="glyph"><Icon name={icon} size={18} /></span>
                      <span className="rule-label">{label}</span>
                    </button>
                  ))}
                </div>
              ))}
              <label className="rule-hint check-row"><input type="checkbox" checked={keepPurgatory} onChange={e => setKeepPurgatory(e.target.checked)} />
                <span>{t('sync.keepPurgatoryOn', { name: picked?.label ?? '' })}<br />{t('sync.keepPurgatoryOnSub')}</span></label>
              <p className="rule-hint">{t('sync.driveFileChanged')}</p>
              <p className="rule-hint">{tr('sync.everythingUnder', { path: <b>{scan.mount}/Tetra</b> })}</p>
            </>
          )}
        </>
      )}
      {scan && !scan.plugged && <p className="error">{t('sync.noLongerPlugged')}</p>}
      {busy && <p className="rule-hint">{t('sync.copyingProgress', { done: busy.done.toLocaleString(), total: busy.total.toLocaleString(), copied: busy.copied.toLocaleString() })}</p>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={!!busy}>{t('common.cancel')}</button>
        <button className="filled-button" disabled={!scan?.plugged || !scan?.writable || !scan?.enough || !!busy} onClick={start}>
          {busy ? t('sync.copying') : t('common.start')}
        </button>
      </div>
    </Modal>
  )
}

const day = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })


/** What went where, newest first (asked 2026-09-25: "a manifest of what goes and what comes"). */
function HistoryDialog({ here, onClose }: { here: string; onClose: () => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  useEffect(() => { window.drive.history({ limit: 500 }).then(setRows) }, [])
  return (
    <Modal onClose={onClose}>
      <h3>{t('sync.history')}</h3>
      <p className="rule-hint">{t('sync.historyHint')}</p>
      {!rows ? <span className="spinner" /> : rows.length === 0 ? <p className="rule-hint">{t('sync.nothingYet')}</p> : (
        <div className="file-scroll">
          <div className="file-row head history-row"><span>{t('sync.colWhen')}</span><span>{t('sync.colWhat')}</span><span>{t('sync.colWhere')}</span></div>
          {rows.map(r => (
            <div className="file-row history-row" key={r.id}>
              <span>{when.format(r.at)}</span>
              <span className="file-name"><span><b>{r.action}</b> {r.name ?? ''}{r.detail ? ` — ${r.detail}` : ''}{r.size ? ` · ${formatBytes(r.size)}` : ''}</span></span>
              <span>{r.deviceName ?? here}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
}

const UNITS = [['day', 1], ['week', 7], ['month', 30], ['year', 365]] as const
/** "3 months" (sync.spanMonth) or, without the number, "months" (sync.unitMonth): plural forms by count */
const spanKey = (u: string) => `sync.span${u[0].toUpperCase()}${u.slice(1)}`
const unitKey = (u: string) => `sync.unit${u[0].toUpperCase()}${u.slice(1)}`
/** A number of days, shown as the largest unit it divides into evenly. */
function Days({ days, onChange, allowNever }: { days: number; onChange: (days: number) => void; allowNever?: boolean }) {
  const [unit, per] = [...UNITS].reverse().find(([, n]) => days > 0 && days % n === 0) ?? UNITS[0]
  const never = allowNever && days === 0
  return (
    <span className="drive-window">
      {!never && <input className="field" type="number" min={1} max={999} value={days / per} onChange={e => onChange(Math.max(1, Number(e.target.value) || 1) * per)} />}
      {!never && <select className="field" value={unit} onChange={e => onChange((days / per) * UNITS.find(u => u[0] === e.target.value)![1])}>
        {UNITS.map(([u]) => <option key={u} value={u}>{t(unitKey(u), { count: days / per })}</option>)}
      </select>}
      {allowNever && <label><input type="checkbox" checked={never} onChange={e => onChange(e.target.checked ? 0 : 30)} /> {t('sync.neverDelete')}</label>}
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
      <h3><Icon name="trash" size={20} />{t('sync.deletedItems')}
        <button className="link" onClick={() => setDialog(<HistoryDialog here={here} onClose={() => setDialog(null)} />)}>{t('sync.history')}</button>
      </h3>
      <p className="rule-hint drive-window">{tr('sync.inTrashFor', { days: <Days days={s.trashDays} onChange={trashDays => set({ trashDays })} /> })}</p>
      <p className="rule-hint drive-window">{tr('sync.thenPurgatory', { place, days: <Days days={s.purgatoryDays} allowNever onChange={purgatoryDays => set({ purgatoryDays })} /> })}</p>
      <p className="rule-hint">{tr(s.location ? 'sync.purgatoryHowDrive' : 'sync.purgatoryHowComputer', { folder: <b>.purgatory</b> })}
        {held && held.items > 0 && ' ' + t('sync.purgatoryHolds', { n: held.items.toLocaleString(), size: formatBytes(held.bytes) })}</p>
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
      <h3>{t('sync.freed', { size: formatBytes(done.bytes) })}</h3>
      <p>{t('sync.nowLiveOn', { n: done.moved.toLocaleString(), name: plan?.name ?? '' })}</p>
      {after && <p className="rule-hint">{t('sync.diskNow', { pct: after.percent, free: formatBytes(after.free) })}</p>}
      {done.failed.length > 0 && <p className="error">{t('sync.stayedHere', { n: done.failed.length, list: done.failed.slice(0, 3).join(' · ') })}</p>}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
    </Modal>
  )
  const why = plan && (plan.rules.offload ? t('sync.whyUnder', { pct: plan.rules.percent })
    : t('sync.whyOlder', { span: t(spanKey(plan.rules.unit), { count: plan.rules.keep }) }))
  return (
    <Modal onClose={busy ? () => {} : onClose}>
      {!plan ? (error ? <p className="error">{error}</p> : <span className="spinner" />) : plan.count === 0 ? (
        <><h3>{t('sync.nothingToFree')}</h3><p className="rule-hint">{t('sync.nothingToFreeWhy', { why: why ?? '', name: plan.name, copies: plan.rules.copies > 1 ? t('sync.orNotInPlaces', { n: plan.rules.copies }) : '' })}</p></>
      ) : (
        <>
          <h3>{t('sync.freeAsk', { size: formatBytes(plan.bytes) })}</h3>
          <p>{tr('sync.safeOn', { n: plan.count.toLocaleString(), why: why ?? '', name: <b>{plan.name}</b> })}
            {plan.oldest && plan.newest && <> {t('sync.fromTo', { from: day.format(plan.oldest), to: day.format(plan.newest) })}</>}.</p>
          <p className="rule-hint">{t('sync.readBack', { name: plan.name })}{plan.rules.favorites && ' ' + t('sync.favoritesStay')}</p>
          {plan.disk && <p className="rule-hint">{t('sync.diskThis', { pct: plan.disk.percent, free: formatBytes(plan.disk.free) })}</p>}
          {!!plan.short && <p className="rule-hint risk">{t('sync.evenEvery', { pct: plan.rules.percent, size: formatBytes(plan.short) })}</p>}
        </>
      )}
      {busy && <p className="rule-hint">{t('sync.checkingMoving', { done: busy.done.toLocaleString(), total: busy.total.toLocaleString(), moved: busy.moved.toLocaleString() })}</p>}
      {error && plan && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={!!busy}>{plan?.count ? t('sync.notNow') : t('common.close')}</button>
        {!!plan?.count && plan.count > 10 && <button disabled={!!busy} onClick={() => go(10)}>{t('sync.try10')}</button>}
        {!!plan?.count && <button className="filled-button" disabled={!!busy} onClick={() => go()}>{t('sync.yesFree', { size: formatBytes(plan.bytes) })}</button>}
      </div>
    </Modal>
  )
}

export function SyncPage({ setDialog }: { setDialog: (d: ReactNode) => void }) {
  const [client, setClient] = useState<boolean | null>(null)
  useEffect(() => { window.drive.role.get().then(r => setClient(r.role === 'client')) }, [])
  if (client === null) return null
  return <ServerPage setDialog={setDialog} client={client} />
}

/** A client shows its server instead of the pairing and the library, and only drives on its cards (it has no phones). */
function ServerPage({ setDialog, client }: { setDialog: (d: ReactNode) => void; client: boolean }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = () => window.drive.sync.status().then(setStatus)
  useEffect(() => { load(); const off = window.drive.sync.onReceived(load); const t = setInterval(load, 3000); return () => { off(); clearInterval(t) } }, [])
  // Mail on each device (MAIL_PLAN §14): matched to a card by the device's name; the rest listed under the cards
  const [mail, setMail] = useState<{ here: { used: number }; devices: MailDevice[] } | null>(null)
  const loadMail = () => window.drive.mail.devices().then(setMail, () => {})
  useEffect(() => { loadMail(); const t = setInterval(loadMail, 30_000); return () => clearInterval(t) }, [])
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const mailOf = (d: SyncDevice) => mail?.devices.find(m => m.device === d.mailDevice) ?? mail?.devices.find(m => key(m.name) === key(d.name) || key(m.device) === key(d.name))
  const close = () => { setDialog(null); load() }
  const add = () => setDialog(client ? <AddDrive onClose={() => setDialog(null)} onDone={close} /> : <AddDevice onClose={() => setDialog(null)} onDone={close} setDialog={setDialog} />)
  const forget = (d: SyncDevice) => setDialog(<Confirm title={t('sync.forgetTitle', { name: d.name })} action={t('sync.forgetDevice')} danger onClose={close}
    body={t('sync.forgetBody')} onConfirm={async () => { await window.drive.sync.forget(d.id).catch(e => alert(e instanceof Error ? e.message : String(e))); load() }} />)
  // [what it says, connected]: the badge lights by the flag, never by the words
  const state = (d: SyncDevice): [string, boolean] => !d.last_seen ? [t('sync.notConnectedYet'), false] : Date.now() - d.last_seen < 15_000 ? [t('sync.connectedSending'), true] : Date.now() - d.last_seen < 120_000 ? [t('sync.connected'), true] : [t('sync.lastSeen', { when: when.format(d.last_seen) }), false]
  const devices = status?.devices ?? []
  const self = status?.self
  const here = self?.label ?? t('sync.here')
  return (
    <div className="timeline">
      <header className="topbar">
        <div className="island title-island"><Icon name="device" /><h1>{t('app.devices')}</h1></div>
        {self && (
          <div className="island self-island">
            <button className="self-chip" onClick={() => setDialog(<SelfEditor self={self} onDone={close} />)}
              title={t('sync.selfChipTitle')}>
              <Icon name={self.kind as IconName} size={20} />
              <span>{t('sync.thisDevice')}</span>
              {status?.counts && <span className="device-tally inline">
                <span title={t('sync.photosOnHere', { here })}><Icon name="photos" size={16} />{status.counts.photos.toLocaleString()}</span>
                <span title={t('sync.filesOnHere', { here })}><Icon name="folder" size={16} />{status.counts.files.toLocaleString()}</span>
                {!!mail?.here.used && <span title={t('mail.uses', { size: formatBytes(mail.here.used) })}><Icon name="mail" size={16} />{formatBytes(mail.here.used)}</span>}
              </span>}
            </button>
            <button className="round small" title={t('sync.hubButtonTitle')}
              onClick={() => setDialog(<HubInfo self={self} onClose={() => setDialog(null)} />)}><Icon name="info" size={18} /></button>
          </div>
        )}
      </header>
      {status?.error && <div className="island analysis"><Icon name="warning" /><span>{t('sync.notRunning', { error: status.error })}</span></div>}
      {client && <ClientCard />}
      {!client && status && devices.length === 0 && !status.error && (
        <div className="island add-first">
          <h2>{t('sync.pairYourPhone')}</h2>
          <PairingCode />
        </div>
      )}
      {!client && status?.overview && devices.length > 0 && <Library overview={status.overview} paired={devices} here={here} setDialog={setDialog} />}
      {(client || devices.length > 0) && <DeletedItems here={here} drives={devices.filter(d => d.volume_uuid)} setDialog={setDialog} />}
      {(client || devices.length > 0) && (
        <div className="device-grid">
          {devices.map(d => {
            const [s, live] = state(d)
            return (
              <div key={d.id} className="island device-card">
                <header className="device-head">
                  <button className="card-edit" title={t('sync.renameDevice')}
                    onClick={() => setDialog(<DeviceEditor device={d} onDone={close} />)}><Icon name="edit" size={20} /></button>
                  <span className={`sync-badge ${live ? 'on' : ''}`}><Icon name={(d.kind as IconName) ?? 'device'} size={30} /></span>
                  <strong>{d.name}</strong>
                  <small className={live ? 'live' : ''}>{s}</small>
                  <div className="device-tally">
                    <span title={t('sync.photosOnDevice', { name: d.name })}><Icon name="photos" size={16} />{d.holdsPhotos.toLocaleString()}</span>
                    <span title={t('sync.filesOnDevice', { name: d.name })}><Icon name="folder" size={16} />{d.holdsFiles == null ? '—' : d.holdsFiles.toLocaleString()}</span>
                  </div>
                </header>
                {!d.set_up_at && (
                  <p className="rule-hint risk">{t('sync.notSetUp')}</p>
                )}
                {d.volume_uuid && d.rules ? <DriveRulesCard device={d} here={here} disk={status?.disk ?? null} onChange={load} setDialog={setDialog}
                    onFree={() => setDialog(<OffloadDialog deviceId={d.id} onClose={() => { setDialog(null); load() }} />)} />
                  : <DeviceRules device={d} here={here} mailUsed={mailOf(d)?.usage?.used} setDialog={setDialog} onChange={() => { load(); loadMail() }} />}
                <footer className="device-foot">
                  <small>{t('sync.paired', { when: when.format(d.paired_at) })}</small>
                  <button className="text-button" onClick={() => forget(d)}>{t('sync.forget')}</button>
                </footer>
              </div>
            )
          })}
          <button className="island device-card add" onClick={add}>
            <span className="sync-badge"><Icon name="add" size={30} /></span>
            <strong>{t('sync.addDevice')}</strong>
            <small>{client ? t('sync.addDriveSub') : t('sync.showPairingCode')}</small>
          </button>
        </div>
      )}
      {!client && status && !status.error && <p className="hint">{t('sync.listening', { addresses: status.addresses.join(', ') || t('sync.thisComputer'), port: status.port })}</p>}
    </div>
  )
}
