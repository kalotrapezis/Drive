import { useEffect, useState, type ReactNode } from 'react'
import type { FullSuggestion, MovePreview, SyncConnection, SyncContent, SyncDevice } from './drive'
import { Icon, type IconName } from './Icon'
import { Modal } from './Dialogs'
import { locale, t } from './i18n'

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
