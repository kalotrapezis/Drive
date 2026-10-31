import { useEffect, useState, type ReactNode } from 'react'
import type { DriveRules, FullSuggestion, MovePreview, SyncConnection, SyncContent, SyncDevice } from './drive'
import { Icon, type IconName } from './Icon'
import { Modal } from './Dialogs'
import { locale, t, tr } from './i18n'

// A phone's or tablet's card on the Devices page (the user, 31 Oct): only what it does, in a sentence per applet, each in that
// applet's colour; «Επεξεργασία» opens a guide — which applet, Off / Mirror / Move, how much stays, then the map and Confirm.
// The rows are sync.js's sync_connections, which the device reads at each sync (GET /connections).

type Mode = 'off' | 'mirror' | 'move'
/** What stays on the device: automatic (from its free storage), a span of days, or (Mail) a size in bytes, -1 all. */
type Keep = { auto: true } | { days: number } | { bytes: number }
const APPLETS: { content: SyncContent; icon: IconName; color: string; modes: Mode[] }[] = [
  { content: 'photos', icon: 'photos', color: 'var(--cat-photos)', modes: ['off', 'mirror', 'move'] },
  { content: 'mail', icon: 'mail', color: 'var(--cat-mail)', modes: ['off', 'mirror', 'move'] },
  { content: 'files', icon: 'folder', color: 'var(--cat-files)', modes: ['off', 'mirror', 'move'] },
  { content: 'other', icon: 'grid', color: 'var(--cat-phone)', modes: ['off', 'mirror'] }, // calendars and contacts never leave the phone
]
const NAME: Record<SyncContent, string> = { photos: 'app.photos', files: 'app.files', mail: 'app.mail', other: 'sync.others' }
/** The guide's defaults (the user): Move for photos, a copy for everything else. */
const DEFAULT: Record<SyncContent, Mode> = { photos: 'move', files: 'mirror', mail: 'mirror', other: 'mirror' }
const GB = [5e8, 1e9, 2e9, 5e9, 1e10, -1]

const modeOf = (c: SyncConnection): Mode => c.direction === 'off' ? 'off' : c.direction === 'send' && c.keep === 'nothing' ? 'move' : c.direction === 'send' && c.content === 'mail' ? 'move' : 'mirror'
const keepOf = (c: SyncConnection): Keep => c.keepAuto ? { auto: true } : c.content === 'mail' && c.keepBytes != null ? { bytes: c.keepBytes } : { days: c.keepDays ?? 30 }
const span = (days: number) => days % 365 === 0 ? t('sync.spanYear', { count: days / 365 }) : days % 30 === 0 ? t('sync.spanMonth', { count: days / 30 }) : t('sync.spanDay', { count: days })
/** 1 GB as the limits are chosen (decimal, like the mail engine's), not formatBytes' 954 MB */
const gb = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString(locale())} GB` : `${Math.round(bytes / 1e6)} MB`
const keepText = (k: Keep) => 'auto' in k ? t('sync.keepAuto') : 'bytes' in k ? (k.bytes < 0 ? t('sync.keepAll') : t('sync.keepUpTo', { size: gb(k.bytes) })) : t('sync.keepLast', { span: span(k.days) })

/** One applet's row, said in words: what crosses, which way, and what stays on the device. */
export function sentence(c: SyncConnection, device: string, here: string): string {
  const m = modeOf(c), k = keepOf(c)
  if (m === 'off') return t('sync.saysOff')
  if (c.direction === 'receive') return t('sync.saysReceive', { here, device })
  if (m === 'move') return t('sync.saysMove', { here, device, keep: keepText(k) })
  if (c.direction === 'send') return t('sync.saysSend', { here })
  return c.content === 'mail' ? t('sync.saysMirrorMail', { device, here, keep: keepText(k) }) : t('sync.saysMirror', { device, here })
}

/** 90 % full or more, as the device said within two days (the user: "when the storage reaches 90 %, suggest…"). */
const nearlyFull = (d: SyncDevice) => !!d.storageSize && d.storageFree != null && Date.now() - (d.storageAt ?? 0) < 2 * 86_400_000 && d.storageFree / d.storageSize <= 0.1

export function DeviceRules({ device, here, mailUsed, setDialog, onChange }: { device: SyncDevice; here: string; mailUsed?: number; setDialog: (d: ReactNode) => void; onChange: () => void }) {
  const rows = new Map(device.connections.map(c => [c.content, c]))
  const guide = (start?: { content: SyncContent; mode: Mode; keep: Keep }) =>
    setDialog(<DeviceGuide device={device} here={here} start={start} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange() }} />)
  // 90 % full: the PC works out what to move (two years, or one when two is not enough) and the guide's map shows it
  const full = nearlyFull(device)
  const [hint, setHint] = useState<FullSuggestion | null>(null)
  useEffect(() => { if (full) window.drive.sync.fullSuggestion(device.id).then(setHint, () => setHint(null)); else setHint(null) }, [full, device.storageFree])
  return (
    <>
      <ul className="device-says">
        {APPLETS.filter(a => rows.has(a.content)).map(a => {
          const c = rows.get(a.content)!
          return <li key={a.content} className={modeOf(c) === 'off' ? 'off' : ''} style={{ '--c': a.color } as React.CSSProperties}>
            <Icon name={a.icon} size={18} />
            <span><b>{t(NAME[a.content])}:</b> {sentence(c, device.name, here)}
              {a.content === 'mail' && !!mailUsed && modeOf(c) !== 'off' && <small> · {t('mail.uses', { size: gb(mailUsed) })}</small>}</span>
          </li>
        })}
      </ul>
      {full && <div className="device-full">
        <Icon name="warning" size={18} />
        <span>{t('sync.nearlyFull', { device: device.name, pct: hint?.used ?? Math.round((1 - (device.storageFree ?? 0) / (device.storageSize ?? 1)) * 100), free: gb(device.storageFree ?? 0) })}
          {hint && ' ' + t(`sync.suggestMove_${hint.content}`, { here, span: span(hint.days) })}
          {hint?.bytes ? ' ' + t('sync.suggestFrees', { size: gb(hint.bytes) }) : ''}</span>
        {hint && <button className="text-button" onClick={() => guide({ content: hint.content, mode: 'move', keep: { days: hint.days } })}>{t('sync.suggestButton')}</button>}
      </div>}
      <button className="outline-button device-edit" onClick={() => guide()}><Icon name="edit" size={18} />{t('sync.editRules')}</button>
    </>
  )
}

/**
 * The guide: 1 which applet, 2 Off / Mirror / Move, 3 how much stays on the device, 4 the map of what moves, and Confirm.
 * Nothing changes before Confirm. Step 3 is passed over for a mirror of what has no limit (photos, files, others: all stays).
 */
export function DeviceGuide({ device, here, start, onClose, onDone }: { device: SyncDevice; here: string; start?: { content: SyncContent; mode: Mode; keep: Keep }; onClose: () => void; onDone: () => void }) {
  const rows = new Map(device.connections.map(c => [c.content, c]))
  const [step, setStep] = useState(start ? 4 : 1)
  const [content, setContent] = useState<SyncContent>(start?.content ?? 'photos')
  const [mode, setMode] = useState<Mode>(start?.mode ?? 'off')
  const [keep, setKeep] = useState<Keep>(start?.keep ?? { days: 30 })
  const [favorites, setFavorites] = useState(rows.get(content)?.keepFavorites ?? true)
  const [busy, setBusy] = useState(false)
  const applet = APPLETS.find(a => a.content === content)!
  const needsKeep = mode === 'move' || (mode === 'mirror' && content === 'mail')
  const pick = (c: SyncContent) => {
    const row = rows.get(c)
    setContent(c)
    setMode(row && device.set_up_at ? modeOf(row) : DEFAULT[c])
    setKeep(row ? keepOf(row) : c === 'mail' ? { bytes: 1e9 } : { days: 30 })
    setFavorites(row?.keepFavorites ?? true)
    setStep(2)
  }
  const confirm = async () => {
    setBusy(true)
    const days = 'days' in keep ? keep.days : 30, bytes = content !== 'mail' ? null : 'bytes' in keep ? keep.bytes : 'auto' in keep ? -1 : null
    const rules = mode === 'off' ? { direction: 'off', keep: 'everything' }
      : mode === 'mirror' ? { direction: 'both', keep: 'everything', keepAuto: 'auto' in keep && content === 'mail', keepBytes: bytes, keepDays: days }
      : { direction: 'send', keep: 'nothing', keepDays: days, keepFavorites: favorites, keepAuto: 'auto' in keep, keepBytes: bytes }
    try {
      await window.drive.sync.setConnection(device.id, content, rules)
      if (!device.set_up_at) await window.drive.sync.completeSetup(device.id)
      onDone()
    } finally { setBusy(false) }
  }
  const next = () => setStep(s => s === 2 && !needsKeep ? 4 : s + 1)
  const back = () => setStep(s => s === 4 && !needsKeep ? 2 : s - 1)
  const STEPS = ['sync.guideStep1', 'sync.guideStep2', 'sync.guideStep3', 'sync.guideStep4']
  return (
    <Modal onClose={onClose}>
      <ol className="guide-steps" aria-label={t('sync.editRules')}>
        {STEPS.map((k, i) => <li key={k} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>{i + 1}. {t(k)}</li>)}
      </ol>
      {step === 1 && <>
        <h3>{t('sync.guideWhich', { device: device.name })}</h3>
        <div className="rule-options">
          {APPLETS.filter(a => rows.has(a.content)).map(a => (
            <button key={a.content} onClick={() => pick(a.content)} style={{ '--c': a.color } as React.CSSProperties} className="applet-pick">
              <span className="glyph"><Icon name={a.icon} size={18} /></span>
              <span className="rule-label">{t(NAME[a.content])}{a.content === 'other' && <small> · {t('sync.othersAre')}</small>}<br /><small>{sentence(rows.get(a.content)!, device.name, here)}</small></span>
            </button>
          ))}
        </div>
      </>}
      {step === 2 && <>
        <h3 style={{ color: applet.color }}><Icon name={applet.icon} />{t('sync.guideWhat', { what: t(NAME[content]) })}</h3>
        <div className="rule-options">
          {applet.modes.map(m => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              <span className="glyph"><Icon name={m === 'off' ? 'block' : m === 'mirror' ? 'swap' : 'moveTo'} size={18} /></span>
              <span className="rule-label">{t(`sync.mode_${m}`)}{m === DEFAULT[content] && <small> · {t('sync.suggested')}</small>}<br /><small>{t(`sync.mode_${m}_how_${content}`, { device: device.name, here })}</small></span>
            </button>
          ))}
        </div>
      </>}
      {step === 3 && <>
        <h3>{t('sync.guideKeep', { device: device.name })}</h3>
        <div className="rule-options">
          {keepChoices(content, rows.get(content)).map(k => (
            <button key={JSON.stringify(k)} className={JSON.stringify(k) === JSON.stringify(keep) ? 'on' : ''} onClick={() => setKeep(k)}>
              <span className="rule-label">{keepText(k)}{'auto' in k && <><br /><small>{t('sync.keepAutoHow', { device: device.name, here })}</small></>}</span>
            </button>
          ))}
        </div>
        {mode === 'move' && content === 'photos' && <label className="check-row"><input type="checkbox" checked={favorites} onChange={e => setFavorites(e.target.checked)} /><span>{t('sync.everyFavorite')}</span></label>}
      </>}
      {step === 4 && <>
        <h3>{t('sync.guideMap')}</h3>
        <TransferMap device={device} here={here} content={content} mode={mode} keep={keep} favorites={favorites} color={applet.color} icon={applet.icon} />
      </>}
      <div className="dialog-actions">
        <button className="text-button" onClick={step === 1 || start ? onClose : back}>{step === 1 || start ? t('common.cancel') : t('common.back')}</button>
        {step > 1 && step < 4 && <button className="filled-button" onClick={next}>{t('common.next')}</button>}
        {step === 4 && <button className="filled-button" disabled={busy} onClick={confirm}>{t('sync.confirm')}</button>}
      </div>
    </Modal>
  )
}

function keepChoices(content: SyncContent, row?: SyncConnection): Keep[] {
  const list: Keep[] = [{ auto: true }, { days: 730 }, { days: 365 }, { days: 30 }]
  if (content === 'mail') list.push(...GB.map(bytes => ({ bytes })))
  // a span chosen before the guide (3 months, say) stays offered as it is
  if (row?.keepDays && ![30, 365, 730].includes(row.keepDays) && !row.keepAuto && modeOf(row) === 'move') list.push({ days: row.keepDays })
  return list
}

/**
 * The map (step 4): the device and this computer, the way things go between them and what goes. For a Move of photos or
 * files, the numbers as the device last listed them (sync.movePreview), so nothing is a surprise after Confirm.
 */
function TransferMap({ device, here, content, mode, keep, favorites, color, icon }: { device: SyncDevice; here: string; content: SyncContent; mode: Mode; keep: Keep; favorites: boolean; color: string; icon: IconName }) {
  const [p, setP] = useState<MovePreview | null>(null)
  const counted = mode === 'move' && (content === 'photos' || content === 'files') && 'days' in keep
  useEffect(() => { if (counted && 'days' in keep) window.drive.sync.movePreview(device.id, { keepDays: keep.days, keepFavorites: favorites, content }).then(setP, () => setP(null)) }, [counted, JSON.stringify(keep), favorites])
  const what = t(NAME[content])
  return (
    <div className="transfer-map" style={{ '--c': color } as React.CSSProperties}>
      <div className="map-end">
        <Icon name={(device.kind as IconName) ?? 'device'} size={34} />
        <strong>{device.name}</strong>
        <small>{mode === 'off' ? t('sync.mapNothing') : mode === 'move' || content === 'mail' ? keepText(keep) : t('sync.keepAll')}{mode === 'move' && content === 'photos' && favorites && ' · ' + t('sync.mapFavorites')}</small>
      </div>
      <div className={`map-way ${mode}`}>
        <Icon name={icon} size={22} />
        <svg className="map-arrow" viewBox="0 0 120 24" aria-hidden>
          <line x1={mode === 'mirror' ? 10 : 4} y1="12" x2={mode === 'off' ? 116 : 108} y2="12" strokeDasharray={mode === 'off' ? '6 6' : undefined} />
          {mode !== 'off' && <path d="M100 4 L114 12 L100 20" />}
          {mode === 'mirror' && <path d="M20 4 L6 12 L20 20" />}
          {mode === 'off' && <path d="M52 4 L68 20 M68 4 L52 20" />}
        </svg>
        <small>{t(`sync.map_${mode}`, { what })}</small>
      </div>
      <div className="map-end">
        <Icon name="computer" size={34} />
        <strong>{here[0].toUpperCase() + here.slice(1)}</strong>
        <small>{mode === 'off' ? t('sync.mapNothing') : t('sync.mapAll', { what })}</small>
      </div>
      <p className="map-say">{mode === 'off' ? t('sync.saysOff') : mode === 'move' ? t('sync.mapMoveSay', { what, device: device.name, here, keep: keepText(keep) }) : t('sync.mapMirrorSay', { what, device: device.name, here })}</p>
      {counted && (!p ? <span className="spinner" /> : <p className="map-say">{p.holds ? t('sync.mapNumbers', { go: p.go.toLocaleString(), size: gb(p.goBytes), keep: p.keep.toLocaleString(), device: device.name, here })
        : t(`sync.notListed${content === 'files' ? 'Files' : 'Photos'}`, { name: device.name })}</p>)}
    </div>
  )
}

// ── A drive's card (the user, 31 Oct: "the same for the disks, with Edit; keep what I have as the default")
// The same rows as before (sync_connections photos/files 'receive' | 'off', the drive's DRIVE_RULES, where the purgatory
// is): only said in words now, and changed in a guide. Nothing is migrated: the card reads what is stored.

type DriveArea = 'photos' | 'files' | 'trash'
type DriveDraft = { photos: 'off' | 'backup' | 'storage'; files: 'off' | 'copy'; trash: 'here' | 'drive'; rules: DriveRules }
const DRIVE_AREAS: { area: DriveArea; icon: IconName; color: string; name: string }[] = [
  { area: 'photos', icon: 'photos', color: 'var(--cat-photos)', name: 'app.photos' },
  { area: 'files', icon: 'folder', color: 'var(--cat-files)', name: 'sync.driveFiles' },
  { area: 'trash', icon: 'trash', color: 'var(--muted)', name: 'sync.deletedItems' },
]
const unitSpan = (r: DriveRules) => t(`sync.span${r.unit[0].toUpperCase()}${r.unit.slice(1)}`, { count: r.keep })
const on = (c?: SyncConnection) => c?.direction === 'receive' || c?.direction === 'both'

function driveSays(area: DriveArea, d: DriveDraft, drive: string, here: string): string {
  if (area === 'trash') return d.trash === 'drive' ? t('sync.driveSaysTrash', { drive }) : t('sync.driveSaysTrashHere', { here })
  if (area === 'files') return d.files === 'off' ? t('sync.saysOff') : t('sync.driveSaysFiles', { drive })
  if (d.photos === 'off') return t('sync.saysOff')
  const r = d.rules
  const parts = [d.photos === 'backup' ? t('sync.driveSaysBackup', { drive, here })
    : r.offload ? t('sync.driveSaysOffload', { drive, pct: r.percent }) : t('sync.driveSaysKeep', { drive, here, span: unitSpan(r) })]
  if (d.photos === 'storage') {
    if (r.copies > 1) parts.push(t('sync.driveSaysCopies', { n: r.copies }))
    if (r.favorites) parts.push(t('sync.driveSaysFav'))
    parts.push(t(r.auto ? 'sync.driveSaysAuto' : 'sync.driveSaysAsk'))
  }
  if (!r.screenshots) parts.push(t('sync.driveSaysNoShots'))
  return parts.join(' · ')
}

export function DriveRulesCard({ device, here, disk, onChange, onFree, setDialog }: { device: SyncDevice; here: string; disk: { free: number } | null; onChange: () => void; onFree: () => void; setDialog: (d: ReactNode) => void }) {
  const rows = new Map(device.connections.map(c => [c.content, c]))
  const [trash, setTrash] = useState<'here' | 'drive' | null>(null)
  const [plan, setPlan] = useState<{ count: number; bytes: number } | null>(null)
  const [backing, setBacking] = useState('')
  const r = device.rules!
  useEffect(() => { window.drive.purgatory.settings().then(s => setTrash(s.location === device.id ? 'drive' : 'here')) }, [device.id])
  // again whenever the disk changes: after a Free space the card must not still offer what already went
  useEffect(() => { if (r.role === 'storage') window.drive.sync.offloadPlan(device.id).then(setPlan, () => setPlan(null)); else setPlan(null) }, [device.id, JSON.stringify(r), disk?.free])
  if (trash === null) return null
  const draft: DriveDraft = { photos: !on(rows.get('photos')) ? 'off' : r.role, files: on(rows.get('files')) ? 'copy' : 'off', trash, rules: r }
  const backUp = async () => {
    setBacking(t('sync.backingUp'))
    try { const b = await window.drive.sync.backUpToDrive(device.id); setBacking(t(b.failed.length ? 'sync.copiedAlreadyFailed' : 'sync.copiedAlready', { copied: b.copied.toLocaleString(), already: b.already.toLocaleString(), n: b.failed.length })) }
    catch (e) { setBacking(e instanceof Error ? e.message : String(e)) }
    onChange()
  }
  const edit = () => setDialog(<DriveGuide device={device} here={here} draft={draft} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange(); window.drive.purgatory.settings().then(s => setTrash(s.location === device.id ? 'drive' : 'here')) }} />)
  return (
    <>
      <ul className="device-says">
        {DRIVE_AREAS.map(a => (
          <li key={a.area} className={(a.area === 'photos' && draft.photos === 'off') || (a.area === 'files' && draft.files === 'off') ? 'off' : ''} style={{ '--c': a.color } as React.CSSProperties}>
            <Icon name={a.icon} size={18} /><span><b>{t(a.name)}:</b> {driveSays(a.area, draft, device.name, here)}</span>
          </li>
        ))}
      </ul>
      {!!plan?.count && <div className="device-full">
        <Icon name="storage" size={18} />
        <span>{t('sync.driveCouldGo', { n: plan.count.toLocaleString(), size: gb(plan.bytes), drive: device.name })}</span>
        <button className="text-button" onClick={onFree}>{t('sync.freeEllipsis', { size: gb(plan.bytes) })}</button>
      </div>}
      <div className="device-actions">
        <button className="outline-button device-edit" onClick={edit}><Icon name="edit" size={18} />{t('sync.editRules')}</button>
        <button className="text-button" onClick={backUp} disabled={backing === t('sync.backingUp')}>{t('sync.backUpNow')}</button>
      </div>
      {backing && <p className="rule-hint">{backing}</p>}
    </>
  )
}

/** The drive's guide: 1 which (photos, Drive files, deleted items), 2 how, 3 the storage drive's limits (photos), 4 the map. */
function DriveGuide({ device, here, draft: start, onClose, onDone }: { device: SyncDevice; here: string; draft: DriveDraft; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [area, setArea] = useState<DriveArea>('photos')
  const [d, setD] = useState<DriveDraft>(start)
  const [busy, setBusy] = useState('')
  const set = (x: Partial<DriveDraft>) => setD(v => ({ ...v, ...x }))
  const rule = (x: Partial<DriveRules>) => setD(v => ({ ...v, rules: { ...v.rules, ...x } }))
  const a = DRIVE_AREAS.find(x => x.area === area)!
  const needsMore = area === 'photos' && d.photos !== 'off'
  const confirm = async () => {
    setBusy('…')
    try {
      if (area === 'photos') {
        await window.drive.sync.setConnection(device.id, 'photos', { direction: d.photos === 'off' ? 'off' : 'receive', keep: 'everything' })
        const changed = Object.fromEntries(Object.entries({ ...d.rules, role: d.photos === 'off' ? start.rules.role : d.photos }).filter(([k, v]) => start.rules[k as keyof DriveRules] !== v))
        if (Object.keys(changed).length) await window.drive.sync.setDriveRules(device.id, changed)
      }
      if (area === 'files') await window.drive.sync.setConnection(device.id, 'files', { direction: d.files === 'off' ? 'off' : 'receive', keep: 'everything' })
      if (area === 'trash' && d.trash !== start.trash) {
        setBusy(t('sync.movingPurgatory'))
        await window.drive.purgatory.setLocation(d.trash === 'drive' ? device.id : null)
      }
      if (!device.set_up_at) await window.drive.sync.completeSetup(device.id)
      onDone()
    } catch (e) { setBusy(e instanceof Error ? e.message : String(e)) }
  }
  const opt = (chosen: boolean, icon: IconName, label: string, hint: string, click: () => void) => (
    <button className={chosen ? 'on' : ''} onClick={click}>
      <span className="glyph"><Icon name={icon} size={18} /></span>
      <span className="rule-label">{label}<br /><small>{hint}</small></span>
    </button>
  )
  const r = d.rules
  return (
    <Modal onClose={onClose}>
      <ol className="guide-steps">
        {['sync.guideStep1', 'sync.guideStep2', 'sync.guideStep3', 'sync.guideStep4'].map((k, i) => <li key={k} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>{i + 1}. {t(i === 0 ? 'sync.guideWhatDrive' : k)}</li>)}
      </ol>
      {step === 1 && <>
        <h3>{t('sync.guideWhich', { device: device.name })}</h3>
        <div className="rule-options">
          {DRIVE_AREAS.map(x => (
            <button key={x.area} className="applet-pick" style={{ '--c': x.color } as React.CSSProperties} onClick={() => { setArea(x.area); setStep(2) }}>
              <span className="glyph"><Icon name={x.icon} size={18} /></span>
              <span className="rule-label">{t(x.name)}<br /><small>{driveSays(x.area, d, device.name, here)}</small></span>
            </button>
          ))}
        </div>
      </>}
      {step === 2 && <>
        <h3 style={{ color: a.color }}><Icon name={a.icon} />{t('sync.guideWhat', { what: t(a.name) })}</h3>
        <div className="rule-options">
          {area === 'photos' && <>
            {opt(d.photos === 'off', 'block', t('sync.mode_off'), t('sync.driveHowOff', { drive: device.name }), () => set({ photos: 'off' }))}
            {opt(d.photos === 'backup', 'copy', t('sync.roleBackup'), t('sync.driveHowBackup', { drive: device.name, here }), () => set({ photos: 'backup' }))}
            {opt(d.photos === 'storage', 'moveTo', t('sync.kindStorage'), t('sync.driveHowStorage', { drive: device.name, here }), () => set({ photos: 'storage' }))}
          </>}
          {area === 'files' && <>
            {opt(d.files === 'off', 'block', t('sync.mode_off'), t('sync.driveHowOff', { drive: device.name }), () => set({ files: 'off' }))}
            {opt(d.files === 'copy', 'copy', t('sync.copyTo', { name: device.name }), t('sync.driveHowFiles', { drive: device.name, here }), () => set({ files: 'copy' }))}
          </>}
          {area === 'trash' && <>
            {opt(d.trash === 'here', 'computer', t('sync.trashHere', { here }), t('sync.keepPurgatoryHereSub'), () => set({ trash: 'here' }))}
            {opt(d.trash === 'drive', 'database', t('sync.trashOnDrive', { drive: device.name }), t('sync.driveHowTrash', { drive: device.name }), () => set({ trash: 'drive' }))}
          </>}
        </div>
      </>}
      {step === 3 && <>
        <h3>{t('sync.guideDriveLimits', { drive: device.name })}</h3>
        {d.photos === 'storage' && <>
          <div className="rule-options">
            {opt(r.offload, 'moveTo', t('sync.offloadOn'), t('sync.offloadOnNote'), () => rule({ offload: true }))}
            {opt(!r.offload, 'photos', t('sync.offloadOff'), t('sync.offloadOffNote'), () => rule({ offload: false }))}
          </div>
          {r.offload ? (
            <label className="rule-hint drive-slider">{tr('sync.keepUnder', { pct: <b>{r.percent} %</b> })}
              <input type="range" min={50} max={95} step={5} value={r.percent} onChange={e => rule({ percent: Number(e.target.value) })} />
            </label>
          ) : (
            <label className="rule-hint drive-window">{tr('sync.keepLastOnPc', {
              n: <input className="field" type="number" min={1} max={1000} value={r.keep} onChange={e => rule({ keep: Math.max(1, Number(e.target.value) || 1) })} />,
              unit: <select className="field" value={r.unit} onChange={e => rule({ unit: e.target.value as DriveRules['unit'] })}>
                {(['day', 'week', 'month', 'year'] as const).map(u => <option key={u} value={u}>{t(`sync.unit${u[0].toUpperCase()}${u.slice(1)}`, { count: r.keep })}</option>)}
              </select> })}
            </label>
          )}
          <label className="rule-hint drive-window">{t('sync.onlyOnce')}
            <select className="field" value={r.copies} onChange={e => rule({ copies: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select>
            {t('sync.placesHold', { count: r.copies, name: device.name })}
          </label>
          <label className="rule-hint check-row"><input type="checkbox" checked={r.favorites} onChange={e => rule({ favorites: e.target.checked })} /><span>{t('sync.favoritesAlwaysStay')}</span></label>
          <label className="rule-hint check-row"><input type="checkbox" checked={r.auto} onChange={e => rule({ auto: e.target.checked })} /><span>{t('sync.autoFree')}</span></label>
        </>}
        <label className="rule-hint check-row"><input type="checkbox" checked={r.screenshots} onChange={e => rule({ screenshots: e.target.checked })} /><span>{t('sync.backUpScreenshots')}</span></label>
      </>}
      {step === 4 && <>
        <h3>{t('sync.guideMap')}</h3>
        <div className="transfer-map" style={{ '--c': a.color } as React.CSSProperties}>
          <div className="map-end"><Icon name="computer" size={34} /><strong>{here[0].toUpperCase() + here.slice(1)}</strong></div>
          <div className={`map-way ${(area === 'photos' && d.photos === 'off') || (area === 'files' && d.files === 'off') ? 'off' : 'move'}`}>
            <Icon name={a.icon} size={22} />
            <svg className="map-arrow" viewBox="0 0 120 24" aria-hidden>
              <line x1="4" y1="12" x2={(area === 'photos' && d.photos === 'off') || (area === 'files' && d.files === 'off') ? 116 : 108} y2="12" strokeDasharray={(area === 'photos' && d.photos === 'off') || (area === 'files' && d.files === 'off') ? '6 6' : undefined} />
              {!((area === 'photos' && d.photos === 'off') || (area === 'files' && d.files === 'off')) ? <path d="M100 4 L114 12 L100 20" /> : <path d="M52 4 L68 20 M68 4 L52 20" />}
            </svg>
          </div>
          <div className="map-end"><Icon name="database" size={34} /><strong>{device.name}</strong></div>
          <p className="map-say">{t(a.name)}: {driveSays(area, d, device.name, here)}</p>
          {area === 'photos' && d.photos === 'storage' && <p className="map-say">{t('sync.driveMapStorage', { drive: device.name, here })}</p>}
        </div>
      </>}
      {busy && busy !== '…' && <p className="rule-hint">{busy}</p>}
      <div className="dialog-actions">
        <button className="text-button" onClick={step === 1 ? onClose : () => setStep(s => s === 4 && !needsMore ? 2 : s - 1)}>{step === 1 ? t('common.cancel') : t('common.back')}</button>
        {step > 1 && step < 4 && <button className="filled-button" onClick={() => setStep(s => s === 2 && !needsMore ? 4 : s + 1)}>{t('common.next')}</button>}
        {step === 4 && <button className="filled-button" disabled={!!busy} onClick={confirm}>{t('sync.confirm')}</button>}
      </div>
    </Modal>
  )
}
