import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MailAccount, MailEntry, MailFolder, MailOpened, MailRole, MailServer, MailState } from './drive'
import { arrange, dayKey, DEFAULT_VIEW, type MailView } from './mailView'
import { Confirm, Modal, errorText } from './Dialogs'
import { Icon, type IconName } from './Icon'
import { locale, t } from './i18n'

// Tetra Mail, step 1 (Tetra-mobile's MAIL_PLAN.md, the desktop layout of §9): the action bar on top, then three columns —
// the unified folders expanding into the accounts, the list, the open mail. Read-only: nothing changes on a server yet,
// so the ♥ shows the server's flag and the actions that write (New, Reply, Archive, Delete) are not here.

type Data = { accounts: MailAccount[]; folders: MailFolder[]; status: Record<string, MailState> }
const ROLE_ICON: Record<MailRole, IconName> = { Inbox: 'mail', Drafts: 'edit', Sent: 'arrowRight', Archive: 'archive', Spam: 'warning', Trash: 'trash' }
const PAGE = 300 // rows drawn at a time; "Περισσότερα" draws the next
const stored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch {} }
const sizeText = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
const sum = (f: MailFolder, k: 'unread' | 'total' | 'orange') => f.accounts.reduce((n, a) => n + a[k], 0)

function dayText(key: string) {
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86_400_000)
  if (key === today) return t('common.today')
  if (key === yesterday) return t('common.yesterday')
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}
const timeText = (ms: number) => dayKey(ms) === dayKey(Date.now())
  ? new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  : new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })

/** The unread count, green when everything in it is saved here, orange when something is only on the server. */
function Count({ unread, orange }: { unread: number; orange: number }) {
  if (!unread && !orange) return null
  return <span className={`mail-count ${orange ? 'orange' : 'green'}`} title={orange ? t('mail.nOnlyServer', { count: orange }) : t('mail.local')}>{unread || '•'}</span>
}

export function MailPage({ setDialog, say }: { setDialog: (d: ReactNode) => void; say: (s: string) => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [where, setWhere] = useState<{ role: MailRole; account: string | null }>({ role: 'Inbox', account: null })
  const [expanded, setExpanded] = useState<Set<MailRole>>(() => new Set(['Inbox']))
  const [mails, setMails] = useState<MailEntry[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const viewKey = `mail.view.${where.role}.${where.account ?? '*'}` // the Filter's choice, kept per folder
  const [view, setView] = useState<MailView>(DEFAULT_VIEW)
  useEffect(() => { try { setView({ ...DEFAULT_VIEW, ...JSON.parse(stored(viewKey) || '{}') }) } catch { setView(DEFAULT_VIEW) } }, [viewKey])
  const close = () => setDialog(null)

  const whereRef = useRef(where)
  whereRef.current = where
  const reload = () => {
    window.drive.mail.accounts().then(setData)
    window.drive.mail.list(whereRef.current.role, whereRef.current.account).then(setMails)
  }
  useEffect(() => { setLimit(PAGE); reload() }, [where])
  // while the first download runs main says so twice a second; the list is read again at most every two
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.drive.mail.onChange(() => { timer ??= setTimeout(() => { timer = null; reload() }, 2000) })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [])

  const accounts = new Map((data?.accounts ?? []).map(a => [a.id, a]))
  const groups = useMemo(() => arrange(mails, view, query), [mails, view, query])
  const filtered = JSON.stringify({ ...view, sort: 0, descending: 0, group: 0, unreadFirst: 0, favoritesFirst: 0, attachmentsFirst: 0 }) !== JSON.stringify({ ...DEFAULT_VIEW, sort: 0, descending: 0, group: 0, unreadFirst: 0, favoritesFirst: 0, attachmentsFirst: 0 })

  const addAccount = () => setDialog(<AddAccount onClose={close} onDone={() => { close(); reload() }} />)
  const manage = () => data && setDialog(<Accounts data={data} onClose={close} onAdd={addAccount}
    onRemove={a => setDialog(<Confirm title={t('mail.removeTitle', { name: a.name })} body={t('mail.removeBody')} action={t('common.remove')} danger onClose={close}
      onConfirm={() => window.drive.mail.remove(a.id).then(() => { close(); reload() }, e => say(errorText(e)))} />)} />)
  const filter = () => setDialog(<FilterDialog initial={view} accounts={data?.accounts ?? []} onClose={close}
    onChange={v => { setView(v); store(viewKey, JSON.stringify(v)) }} />)

  if (data && !data.accounts.length) return (
    <div className="mail-welcome island">
      <img className="mail-art" src="./mail.png" alt="" />
      <h2>{t('mail.welcome')}</h2>
      <p>{t('mail.welcomeHint')}</p>
      <button className="filled-button mail-add" onClick={addAccount}>{t('mail.addAccount')}</button>
    </div>
  )

  let shown = 0
  return (
    <div className="mail-page">
      <div className="mail-bar island">
        <button className="mail-bar-item" onClick={() => window.drive.mail.sync()}><Icon name="refresh" size={20} /><span>{t('mail.sync')}</span></button>
        <button className={`mail-bar-item ${filtered ? 'on' : ''}`} onClick={filter}><Icon name="filter" size={20} /><span>{t('mail.filter')}</span></button>
        <button className="mail-bar-item" onClick={manage}><Icon name="person" size={20} /><span>{t('mail.accounts')}</span></button>
        <label className="mail-search"><Icon name="search" size={18} />
          <input value={query} placeholder={t('mail.search')} onChange={e => { setQuery(e.target.value); setLimit(PAGE) }} /></label>
      </div>
      <div className="mail-columns">
        <nav className="mail-folders island">
          {data?.folders.filter(f => f.role === 'Inbox' || sum(f, 'total')).map(f => {
            const open = expanded.has(f.role)
            return <div key={f.role}>
              <div className={`mail-folder ${where.role === f.role && !where.account ? 'on' : ''}`}>
                <button className={`mail-twisty ${open ? 'open' : ''}`} aria-label={f.role} onClick={() => setExpanded(s => { const n = new Set(s); if (open) n.delete(f.role); else n.add(f.role); return n })}><Icon name="forward" size={16} /></button>
                <button className="mail-folder-name" onClick={() => setWhere({ role: f.role, account: null })}><Icon name={ROLE_ICON[f.role]} size={18} /><span>{t(`mail.role${f.role}`)}</span></button>
                <Count unread={sum(f, 'unread')} orange={sum(f, 'orange')} />
              </div>
              {open && f.accounts.filter(a => accounts.has(a.id)).map(a => {
                const acc = accounts.get(a.id)!
                return <button key={a.id} className={`mail-folder sub ${where.role === f.role && where.account === a.id ? 'on' : ''}`} onClick={() => setWhere({ role: f.role, account: a.id })}>
                  <span className="mail-dot" style={{ background: acc.color }} /><span className="mail-folder-label">{acc.name}</span><Count unread={a.unread} orange={a.orange} />
                </button>
              })}
            </div>
          })}
          <div className="mail-folders-foot">
            {data?.accounts.map(a => {
              const s = data.status[a.id] ?? {}, total = data.folders.reduce((n, f) => n + (f.accounts.find(x => x.id === a.id)?.total ?? 0), 0)
              const orange = data.folders.reduce((n, f) => n + (f.accounts.find(x => x.id === a.id)?.orange ?? 0), 0)
              const line = s.error ? t(`mail.err_${s.error}`) : orange ? t('mail.downloading', { done: total - orange, total }) : s.busy ? t('mail.syncing') : null
              return line && <div key={a.id} className={`mail-acc-state ${s.error ? 'error' : ''}`} title={s.detail ?? ''}><span className="mail-dot" style={{ background: a.color }} />{line}</div>
            })}
            <div className="mail-legend"><span className="mail-state green" />{t('mail.local')}<span className="mail-state orange" />{t('mail.serverOnly')}</div>
          </div>
        </nav>
        <div className="mail-list island">
          {!groups.length && data && <div className="empty">{t('mail.empty')}</div>}
          {groups.map(g => {
            if (shown >= limit) return null
            const rows = g.mails.slice(0, limit - shown)
            shown += rows.length
            return <section key={g.key}>
              <h4 className="mail-group">{view.group === 'day' ? dayText(g.key) : view.group === 'account' ? accounts.get(g.key)?.name ?? g.key : g.key}</h4>
              {rows.map(m => <MailRow key={m.id} m={m} on={m.id === openId} color={where.account ? null : accounts.get(m.account)?.color ?? null} onOpen={() => setOpenId(m.id)} />)}
            </section>
          })}
          {groups.reduce((n, g) => n + g.mails.length, 0) > limit && <button className="text-button mail-more" onClick={() => setLimit(l => l + PAGE)}>{t('mail.more')}</button>}
        </div>
        <div className="mail-read island">
          {openId ? <Reader key={openId} id={openId} color={accounts.get(mails.find(m => m.id === openId)?.account ?? '')?.color} say={say} /> : <div className="empty">{t('mail.pick')}</div>}
        </div>
      </div>
    </div>
  )
}

function MailRow({ m, on, color, onOpen }: { m: MailEntry; on: boolean; color: string | null; onOpen: () => void }) {
  return (
    <button className={`mail-row ${on ? 'on' : ''} ${m.seen ? '' : 'unread'}`} onClick={onOpen} style={color ? { borderLeftColor: color } : undefined}>
      <span className="mail-row-top">
        <span className="mail-from">{m.from || m.fromAddress}</span>
        {m.attachments > 0 && <Icon name="attach" size={15} />}
        <span className="mail-time">{timeText(m.date)}</span>
        <span className={`mail-state ${m.saved ? 'green' : 'orange'}`} title={m.saved ? t('mail.local') : t('mail.serverOnly')} />
      </span>
      <span className="mail-subject">{m.subject || t('mail.noSubject')}</span>
      {m.snippet && <span className="mail-snippet">{m.snippet}</span>}
      <span className={`mail-heart ${m.flagged ? 'on' : ''}`} title={m.flagged ? t('mail.favorite') : undefined}><Icon name={m.flagged ? 'heartFill' : 'heart'} size={18} /></span>
    </button>
  )
}

/** The open mail: its HTML in a frame that runs no script and loads nothing from the web (the page's own CSP). */
function Reader({ id, color, say }: { id: string; color?: string; say: (s: string) => void }) {
  const [m, setM] = useState<MailOpened | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => { window.drive.mail.open(id).then(setM, e => say(errorText(e))) }, [id])
  if (!m) return null
  const fit = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    frame.current!.style.height = `${doc.documentElement.scrollHeight + 8}px`
    // links open in the browser, never inside Tetra
    doc.addEventListener('click', e => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
      if (a) { e.preventDefault(); window.drive.mail.openLink(a.href) }
    })
  }
  return (
    <article className="mail-reader">
      <h2>{m.subject || t('mail.noSubject')}</h2>
      <div className="mail-head">
        <span className="mail-avatar" style={{ background: color ?? 'var(--island-2)' }}>{(m.from || m.fromAddress || '?').trim()[0]?.toUpperCase()}</span>
        <div>
          <div className="mail-head-from">{m.from || m.fromAddress} {m.from && <small>&lt;{m.fromAddress}&gt;</small>}</div>
          <div className="mail-head-meta">{t('mail.to', { to: m.to })} · {new Date(m.date).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
            <span className={m.saved ? 'green' : 'orange'}>{m.saved ? t('mail.local') : t('mail.serverOnly')}</span></div>
        </div>
      </div>
      {m.attachments.length > 0 && <div className="mail-files">
        {m.attachments.map(a => <button key={a.file} className="chip" onClick={() => window.drive.mail.openFile(a.file).catch(e => say(errorText(e)))}>
          <Icon name="file" size={16} /> {a.name} · {sizeText(a.size)}</button>)}
      </div>}
      {m.missing ? <p className="muted">{t('mail.notYet')}</p>
        : <iframe ref={frame} className="mail-body" sandbox="allow-same-origin" title={m.subject} onLoad={fit}
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{margin:16px;font:15px/1.5 system-ui,"Noto Sans",sans-serif;color:#1b1d1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>${m.html}`} />}
    </article>
  )
}

function FilterDialog({ initial, accounts, onChange, onClose }: { initial: MailView; accounts: MailAccount[]; onChange: (v: MailView) => void; onClose: () => void }) {
  const [v, setV] = useState(initial)
  const set = (x: Partial<MailView>) => { const n = { ...v, ...x }; setV(n); onChange(n) }
  const chip = (on: boolean, label: string, click: () => void) => <button key={label} className={`chip ${on ? 'on' : ''}`} onClick={click}>{label}</button>
  const sorts = [['date', 'mail.sortDate'], ['from', 'mail.sortFrom'], ['subject', 'mail.sortSubject'], ['size', 'mail.sortSize'], ['account', 'mail.sortAccount']] as const
  const groups = [['day', 'mail.groupDay'], ['from', 'mail.sortFrom'], ['account', 'mail.sortAccount'], ['none', 'mail.groupNone']] as const
  const toggle = (k: 'unreadFirst' | 'favoritesFirst' | 'attachmentsFirst', label: string) =>
    <label className="cal-switch mail-switch"><input type="checkbox" checked={v[k]} onChange={e => set({ [k]: e.target.checked })} /><span>{label}</span></label>
  return (
    <Modal onClose={onClose}>
      <h3>{t('mail.filter')}</h3>
      <div className="chips wrap">
        {chip(v.unread, t('mail.unread'), () => set({ unread: !v.unread }))}
        {chip(v.favorites, t('mail.favorites'), () => set({ favorites: !v.favorites }))}
        {chip(v.attachments, t('mail.withAttachments'), () => set({ attachments: !v.attachments }))}
        {chip(v.orange, t('mail.serverOnly'), () => set({ orange: !v.orange }))}
        {accounts.length > 1 && accounts.map(a => chip(v.accounts.includes(a.id), a.name, () => set({ accounts: v.accounts.includes(a.id) ? v.accounts.filter(x => x !== a.id) : [...v.accounts, a.id] })))}
      </div>
      <h4 className="mail-filter-head">{t('mail.sortBy')}</h4>
      <div className="chips wrap">
        {sorts.map(([k, label]) => chip(v.sort === k, t(label), () => set({ sort: k })))}
        {chip(v.descending, t(v.sort === 'date' ? 'mail.newestFirst' : 'mail.descending'), () => set({ descending: !v.descending }))}
      </div>
      <h4 className="mail-filter-head">{t('mail.groupBy')}</h4>
      <div className="chips wrap">{groups.map(([k, label]) => chip(v.group === k, t(label), () => set({ group: k })))}</div>
      {toggle('unreadFirst', t('mail.unreadFirst'))}
      {toggle('favoritesFirst', t('mail.favoritesFirst'))}
      {toggle('attachmentsFirst', t('mail.attachmentsFirst'))}
      <div className="dialog-actions">
        <button className="text-button" onClick={() => set(DEFAULT_VIEW)}>{t('mail.reset')}</button>
        <button className="filled-button" onClick={onClose}>{t('common.done')}</button>
      </div>
    </Modal>
  )
}

function Accounts({ data, onAdd, onRemove, onClose }: { data: Data; onAdd: () => void; onRemove: (a: MailAccount) => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>{t('mail.accounts')}</h3>
      {data.accounts.map(a => {
        const s = data.status[a.id] ?? {}
        return <div key={a.id} className="sheet-row">
          <span className="mail-dot" style={{ background: a.color }} />
          <span className="mail-acc-text"><strong>{a.name}</strong><small>{a.address}{s.error ? ` · ${t(`mail.err_${s.error}`)}` : ''}</small></span>
          <button className="round flat" title={t('common.remove')} onClick={() => onRemove(a)}><Icon name="trash" size={20} /></button>
        </div>
      })}
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>{t('common.close')}</button>
        <button className="filled-button" onClick={onAdd}>{t('mail.addAccount')}</button>
      </div>
    </Modal>
  )
}

/** MAIL_PLAN §9b: the address → sign in, the way the provider needs → done, with the defaults on one card. */
function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [address, setAddress] = useState('')
  const [found, setFound] = useState<{ server: MailServer; how: string } | null | undefined>(undefined)
  const [manual, setManual] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('993')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ reason: string; detail?: string } | null>(null)
  const [done, setDone] = useState<{ account: MailAccount; roles: MailRole[] } | null>(null)
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim())

  // looked up as the address is typed, as Thunderbird does
  useEffect(() => {
    setFound(undefined)
    if (!valid) return
    let gone = false
    const timer = setTimeout(() => window.drive.mail.detect(address.trim()).then(r => { if (!gone) setFound(r) }, () => { if (!gone) setFound(null) }), 600)
    return () => { gone = true; clearTimeout(timer) }
  }, [address])
  const server: MailServer | null = manual
    ? (host.trim() ? { host: host.trim(), port: Number(port) || 993, secure: (Number(port) || 993) === 993, users: ['%EMAILADDRESS%', '%EMAILLOCALPART%'], provider: null } : null)
    : found?.server ?? null
  const google = server?.provider === 'google', microsoft = server?.provider === 'microsoft'

  // Google's app password: copied there, found here when the user comes back
  useEffect(() => {
    if (step !== 2 || !google) return
    const look = () => window.drive.mail.pasteAppPassword().then(p => { if (p) setPass(p) })
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
  }, [step, google])

  async function signIn() {
    if (!server) return
    setBusy(true); setError(null)
    try {
      const r = await window.drive.mail.add(address.trim(), server, google ? pass.replace(/\s/g, '') : pass)
      if (r.error) setError({ reason: r.error, detail: r.detail }); else { setDone(r); setStep(3) }
    } catch (e) { setError({ reason: 'other', detail: errorText(e) }) }
    setBusy(false)
  }

  return (
    <Modal onClose={onClose}>
      <div className="mail-setup">
        <div className="mail-step">{t('mail.step', { n: step })}</div>
        {step === 1 && <>
          <h3>{t('mail.yourAddress')}</h3>
          <input className="field" type="email" autoFocus value={address} onChange={e => setAddress(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && server) setStep(2) }} placeholder="name@example.com" />
          {valid && !manual && <div className="mail-found">
            {found === undefined ? t('mail.looking') : found ? <><strong>{found.server.provider === 'google' ? 'Google' : found.server.provider === 'microsoft' ? 'Microsoft' : found.server.host}</strong><small>{t('mail.foundAuto')}</small></> : t('mail.notFound')}
          </div>}
          {manual && <div className="mail-manual">
            <label>{t('mail.server')}<input className="field" value={host} onChange={e => setHost(e.target.value)} placeholder={`imap.${address.split('@')[1] ?? ''}`} /></label>
            <label>{t('mail.port')}<input className="field" inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} /></label>
          </div>}
          <button className="text-button mail-manual-link" onClick={() => setManual(m => !m)}>{t('mail.manual')}</button>
          <div className="dialog-actions">
            <button className="text-button" onClick={onClose}>{t('common.cancel')}</button>
            <button className="filled-button" disabled={!valid || !server} onClick={() => setStep(2)}>{t('mail.continue')}</button>
          </div>
        </>}
        {step === 2 && <>
          <h3>{t('mail.signIn')}</h3>
          {microsoft ? <p>{t('mail.microsoftLater')}</p> : <>
            <p>{google ? t('mail.googleHow') : t('mail.passwordHow')}</p>
            {google && <button className="filled-button secondary mail-google" onClick={() => window.drive.mail.appPasswords()}>{t('mail.openGoogle')}</button>}
            <input className="field" type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && pass) signIn() }}
              placeholder={google ? t('mail.appPassword') : t('mail.password')} />
          </>}
          {error && <div className="mail-error">
            <p className="error">{t(`mail.err_${error.reason}`)}</p>
            {error.detail && <details><summary>{t('mail.details')}</summary><code>{error.detail}</code></details>}
          </div>}
          <div className="dialog-actions">
            <button className="text-button" onClick={() => { setStep(1); setError(null) }}>{t('common.back')}</button>
            {!microsoft && <button className="filled-button" disabled={!pass || busy} onClick={signIn}>{busy ? t('mail.checking') : t('mail.signIn')}</button>}
          </div>
        </>}
        {step === 3 && done && <>
          <div className="mail-tick">✓</div>
          <h3 className="mail-ready">{t('mail.ready', { name: done.account.name })}</h3>
          <div className="mail-summary">
            <div><span>{t('common.name')}</span><span>{done.account.name} <span className="mail-dot" style={{ background: done.account.color }} /></span></div>
            <div><span>{t('mail.archiveLocal')}</span><span>{t('common.yes')}</span></div>
            <div><span>{t('mail.serverClean')}</span><span>{t('mail.serverCleanValue', { a: done.account.serverClean.attachmentsMonths / 12, b: done.account.serverClean.otherMonths / 12 })}</span></div>
            <div><span>{t('mail.notifications')}</span><span>{t('common.yes')}</span></div>
            <div><span>{t('mail.folders')}</span><span>{done.roles.map(r => t(`mail.role${r}`)).join(', ')}</span></div>
          </div>
          <div className="dialog-actions">
            <button className="filled-button" onClick={onDone}>{t('common.done')}</button>
          </div>
        </>}
      </div>
    </Modal>
  )
}
