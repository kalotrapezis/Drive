import { useEffect, useState, type ReactNode } from 'react'
import type { ClientStatus } from './drive'
import { Confirm, Modal, errorText } from './Dialogs'
import { Icon } from './Icon'
import { formatBytes } from './timeline'
import { lang, t } from './i18n'

// Server or client (the user, 26 Oct; SYNC_PLAN.md 6as): asked at the first start, kept until Settings › Reset.

const when = new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : lang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const keyLength = (key: string) => key.replace(/[^a-z0-9]/gi, '').length
/** One short idea per line (the user: written for a child, step by step); "\n" in the text starts the next. */
const lines = (text: string) => text.split('\n').map((line, i) => <span key={i}>{line}</span>)

/**
 * Alpha (the user, 26 Oct): new, and not yet tried on the equipment it is for — here, everything that needs a second
 * computer. It may work only some of the time. The first start's card says what Beta and Alpha mean.
 */
export const Alpha = () => <span className="alpha-badge">{t('release.alpha')}</span>

/** The first start's question (main.tsx shows it before the app while this computer has no role). */
export function FirstStart({ onDone }: { onDone: (role: string) => void }) {
  const [joining, setJoining] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nas, setNas] = useState(false)
  const server = async () => { await window.drive.role.server(nas); onDone('server') }
  const join = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await window.drive.role.join(key); onDone('client') } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return (
    <div className="first-start">
      <div className="island first-card">
        <img src="./icon.png" alt="" />
        <h1>{t('role.welcome')}</h1>
        <div className="release-card">
          <p><span className="beta-badge">{t('release.beta')}</span>{t('release.betaNote')}</p>
          <p><Alpha />{t('release.alphaNote')}</p>
        </div>
        {!joining ? <>
          <p>{t('role.question')}</p>
          <div className="role-choices">
            <button className="role-choice" onClick={server}>
              <Icon name="server" size={36} /><strong>{t('role.server')}</strong>{lines(t('role.serverHint'))}
            </button>
            <button className="role-choice" onClick={() => setJoining(true)}>
              <Icon name="computer" size={36} /><strong>{t('role.client')} <Alpha /></strong>{lines(t('role.clientHint'))}
            </button>
          </div>
          <NasTick on={nas} onChange={setNas} />
          <p className="role-warning"><Icon name="warning" size={20} />{t('role.lossWarning')}</p>
          <p className="muted">{t('role.locked')}</p>
        </> : (
          <form onSubmit={join}>
            <p>{t('role.keyHow')}</p>
            <input className="field key-field" autoFocus spellCheck={false} placeholder="ABCD-EFGH-JKLM-NPQR" value={key} onChange={e => { setKey(e.target.value); setError('') }} />
            {error && <p className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="text-button" onClick={() => { setJoining(false); setError('') }}>{t('common.back')}</button>
              <button className="filled-button" disabled={busy || keyLength(key) !== 16}>{busy ? t('role.connecting') : t('role.connect')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/** A server's pairing code as the phrase another computer types (PairingCode, beside the QR for phones). */
export function PairingKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <p className="pairing-key">
      <span>{t('sync.anotherComputer')} <Alpha /></span>
      <code>{value}</code>
      <button className="text-button" onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? t('sync.keyCopied') : t('common.copy')}</button>
    </p>
  )
}

/** "This is a NAS" (the user, 26 Oct): it only stores; the screen work and the photo analysis go to the other computers. */
function NasTick({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="check-row role-nas">
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
      <span><b>{t('role.nas')} <Alpha /></b><span className="role-lines">{lines(t('role.nasHint'))}</span></span>
    </label>
  )
}

/** A client's server, the last sync, Sync now (the top of a client's Devices page, Sync.tsx). Phones pair with the server. */
export function ClientCard() {
  const [s, setS] = useState<ClientStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { window.drive.role.get().then(r => setS(r.server)); return window.drive.role.onSynced(setS) }, [])
  const now = async () => { setBusy(true); try { setS(await window.drive.role.syncNow()) } finally { setBusy(false) } }
  const running = busy || !!s?.running
  if (!s) return null
  return (
        <div className="island client-card">
          <span className={`sync-badge ${s.error ? '' : 'on'}`}><Icon name="server" size={30} /></span>
          <h2>{t('role.clientOf', { name: s.name })} <Alpha /></h2>
          <p>{running ? t('role.syncing') : s.lastSync ? t('role.lastSync', { when: when.format(s.lastSync) }) : t('role.notYet')}</p>
          {s.error && <p className="error">{s.error}</p>}
          <button className="filled-button" disabled={running} onClick={now}>{t('role.syncNow')}</button>
          {s.crown && <p>{t('role.crown', { name: s.name })}</p>}
          <label className="check-row role-nas">
            <input type="checkbox" checked={s.mirror} onChange={e => { const on = e.target.checked; setS({ ...s, mirror: on }); window.drive.role.setMirror(on) }} />
            <span><b>{t('role.mirror', { name: s.name })} <Alpha /></b><span className="role-lines">{lines(t('role.mirrorHint'))}</span></span>
          </label>
          <p className="muted">{t('role.clientNote', { name: s.name })}</p>
        </div>
  )
}

/** Settings › Server or client: what this computer is, and the reset that alone changes it (reset.js). */
export function ResetCard() {
  const [role, setRole] = useState<{ role: string | null; server: ClientStatus | null; nas: boolean } | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [said, setSaid] = useState('')
  useEffect(() => { window.drive.role.get().then(setRole) }, [])
  const close = () => setDialog(null)
  // what goes, counted when asked: a big library takes a moment
  const withInfo = async (show: (info: { paths: string[]; files: number; bytes: number }) => ReactNode) => {
    setSaid(t('reset.measuring'))
    try { setDialog(show(await window.drive.reset.info())) } catch (e) { setSaid(errorText(e)); return }
    setSaid('')
  }
  const backUp = () => withInfo(info => <Confirm title={t('reset.backupTitle')} action={t('reset.chooseFolder')} onClose={close}
    body={t('reset.backupBody', { files: info.files.toLocaleString(), size: formatBytes(info.bytes) })}
    onConfirm={async () => {
      setSaid(t('reset.backingUp'))
      try { const done = await window.drive.reset.backUp(); setSaid(done ? t('reset.backedUp', { to: done.to }) : '') } catch (e) { setSaid(errorText(e)) }
    }} />)
  const wipe = () => withInfo(info => <Confirm title={t('reset.deleteTitle')} action={t('common.next')} danger onClose={close}
    body={t('reset.deleteBody', { paths: info.paths.join(', '), files: info.files.toLocaleString(), size: formatBytes(info.bytes) })}
    onConfirm={() => setDialog(<LastChance onClose={close} />)} />)
  return (
    <section className="settings-card island">
      <h3><Icon name={role?.role === 'client' ? 'computer' : 'server'} size={20} />{t('reset.title')}</h3>
      <p><strong>{role?.role === 'client' ? t('reset.isClient', { name: role.server?.name ?? '' }) : t('reset.isServer')}</strong></p>
      {/* what that means, in the first start's words */}
      <p className="role-lines">{lines(role?.role === 'client' ? t('role.clientHint') : t('role.serverHint'))}</p>
      {role?.role === 'server' && <NasTick on={role.nas} onChange={on => window.drive.role.setNas(on).then(() => setRole({ ...role, nas: on }))} />}
      <p className="role-warning"><Icon name="warning" size={20} />{t('role.lossWarning')}</p>
      <p className="muted">{t('reset.why')}</p>
      <div className="reset-actions">
        <button className="filled-button secondary" onClick={backUp}>{t('reset.backUpAndReset')}</button>
        <button className="text-button" onClick={wipe}>{t('reset.deleteAndReset')}</button>
      </div>
      {said && <p className="muted">{said}</p>}
      {dialog}
    </section>
  )
}

/** The second acknowledgement: Reset can be pressed only after 10 seconds, counted from when main armed it. */
function LastChance({ onClose }: { onClose: () => void }) {
  const [left, setLeft] = useState(10)
  const [error, setError] = useState('')
  useEffect(() => {
    let timer = 0
    window.drive.reset.arm().then(ms => {
      const end = Date.now() + ms
      timer = window.setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 200)
    })
    return () => clearInterval(timer)
  }, [])
  return (
    <Modal onClose={onClose}>
      <h3>{t('reset.lastTitle')}</h3>
      <p>{t('reset.lastBody')}</p>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button className="text-button" autoFocus onClick={onClose}>{t('common.cancel')}</button>
        <button className="filled-button danger" disabled={left > 0} onClick={() => window.drive.reset.delete().catch(e => setError(errorText(e)))}>
          {left > 0 ? t('reset.resetIn', { n: left }) : t('reset.resetNow')}
        </button>
      </div>
    </Modal>
  )
}
