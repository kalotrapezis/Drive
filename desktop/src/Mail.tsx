import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MailAccount, MailAddress, MailDraft, MailDraftKind, MailEntry, MailFolder, MailOp, MailOpened, MailRole, MailServer, MailSignature, MailState } from './drive'
import { arrange, dayKey, DEFAULT_VIEW, type MailView } from './mailView'
import { Confirm, Modal, errorText } from './Dialogs'
import { Icon, type IconName } from './Icon'
import { locale, t } from './i18n'

// Tetra Mail, step 1 (Tetra-mobile's MAIL_PLAN.md, the desktop layout of §9): the action bar on top, then three columns —
// the unified folders expanding into the accounts, the list, the open mail — or the mail being written. Read, ♥, archive,
// delete, spam and move go to the server (step 3); New, Reply, Forward and drafts are step 4.

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
  const [draft, setDraft] = useState<MailDraft | null>(null) // the mail being written, in place of the open one
  const composer = useRef<ComposeApi | null>(null)
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

  const flat = groups.flatMap(g => g.mails), current = flat.find(m => m.id === openId) ?? mails.find(m => m.id === openId)
  const act = (op: MailOp, ids: string[], to?: MailRole) => window.drive.mail.act(op, ids, to).then(() => { reload(); return true }, e => { say(errorText(e)); return false })
  /** An action that takes the open mail out of this folder: the next one opens, as in Thunderbird. */
  const away = async (op: MailOp, to?: MailRole) => {
    if (!current) return
    const i = flat.indexOf(current), next = flat[i + 1] ?? flat[i - 1]
    if (await act(op, [current.id], to)) setOpenId(next?.id ?? null)
  }
  const write = (id: string | null, kind: MailDraftKind) => window.drive.mail.draftFor(id, kind, where.account ?? undefined)
    .then(d => { setDraft(null); setTimeout(() => { setOpenId(null); setDraft(d) }) }, e => say(errorText(e))) // a fresh Compose, the old one saved as it goes
  const open = (m: MailEntry) => {
    if (m.folder === 'Drafts') { write(m.id, 'edit'); return } // a draft opens to be written on
    setDraft(null); setOpenId(m.id); if (!m.seen) act('read', [m.id])
  }
  const moveTo = () => current && setDialog(<Modal onClose={close}>
    <h3>{t('mail.moveTo')}</h3>
    {(['Inbox', 'Archive', 'Spam', 'Trash', 'Drafts', 'Sent'] as MailRole[]).filter(r => r !== current.folder).map(r =>
      <button key={r} className="sheet-row" onClick={() => { close(); away('move', r) }}><Icon name={ROLE_ICON[r]} />{t(`mail.role${r}`)}</button>)}
  </Modal>)
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
        <button className="mail-bar-item new" onClick={() => write(null, 'new')}><Icon name="add" size={20} /><span>{t('mail.new')}</span></button>
        <button className="mail-bar-item act" title={t('mail.sync')} onClick={() => window.drive.mail.sync()}><Icon name="refresh" size={20} /><span>{t('mail.sync')}</span></button>
        <button className={`mail-bar-item act ${filtered ? 'on' : ''}`} title={t('mail.filter')} onClick={filter}><Icon name="filter" size={20} /><span>{t('mail.filter')}</span></button>
        <button className="mail-bar-item act" title={t('mail.accounts')} onClick={manage}><Icon name="person" size={20} /><span>{t('mail.accounts')}</span></button>
        {draft && <>
          <span className="mail-bar-sep" />
          <button className="mail-bar-item send" onClick={() => composer.current?.send()}><Icon name="send" size={20} /><span>{t('mail.send')}</span></button>
          <button className="mail-bar-item" onClick={() => composer.current?.save()}><Icon name="save" size={20} /><span>{t('mail.saveDraft')}</span></button>
          <button className="mail-bar-item act" title={t('mail.attach')} onClick={() => composer.current?.attach()}><Icon name="attach" size={20} /><span>{t('mail.attach')}</span></button>
          <button className="mail-bar-item act" title={t('mail.ccBcc')} onClick={() => composer.current?.cc()}><Icon name="person" size={20} /><span>{t('mail.ccBcc')}</span></button>
          <button className="mail-bar-item act" title={t('mail.discard')} onClick={() => composer.current?.discard()}><Icon name="deleteForever" size={20} /><span>{t('mail.discard')}</span></button>
        </>}
        {current && !draft && <>
          <span className="mail-bar-sep" />
          <button className="mail-bar-item act" title={t('mail.reply')} onClick={() => write(current.id, 'reply')}><Icon name="reply" size={20} /><span>{t('mail.reply')}</span></button>
          <button className="mail-bar-item act" title={t('mail.replyAll')} onClick={() => write(current.id, 'replyAll')}><Icon name="replyAll" size={20} /><span>{t('mail.replyAll')}</span></button>
          <button className="mail-bar-item act" title={t('mail.forward')} onClick={() => write(current.id, 'forward')}><Icon name="mailForward" size={20} /><span>{t('mail.forward')}</span></button>
          <button className="mail-bar-item act" title={t('mail.forwardAttached')} onClick={() => write(current.id, 'forwardAttached')}><Icon name="attach" size={20} /><span>{t('mail.forwardAttached')}</span></button>
          <span className="mail-bar-sep" />
          {current.folder !== 'Archive' && <button className="mail-bar-item act" title={t('mail.archive')} onClick={() => away('archive')}><Icon name="archive" size={20} /><span>{t('mail.archive')}</span></button>}
          <button className="mail-bar-item act" title={t('common.delete')} onClick={() => away('delete')}><Icon name="trash" size={20} /><span>{t('common.delete')}</span></button>
          {current.folder === 'Spam'
            ? <button className="mail-bar-item act" title={t('mail.notSpam')} onClick={() => away('notSpam')}><Icon name="mail" size={20} /><span>{t('mail.notSpam')}</span></button>
            : <button className="mail-bar-item act" title={t('mail.spam')} onClick={() => away('spam')}><Icon name="warning" size={20} /><span>{t('mail.spam')}</span></button>}
          <button className="mail-bar-item act" title={t(current.seen ? 'mail.markUnread' : 'mail.markRead')} onClick={() => act(current.seen ? 'unread' : 'read', [current.id])}><Icon name={current.seen ? 'visibilityOff' : 'visibility'} size={20} /><span>{t(current.seen ? 'mail.markUnread' : 'mail.markRead')}</span></button>
          <button className="mail-bar-item act" title={t('common.move')} onClick={moveTo}><Icon name="moveTo" size={20} /><span>{t('common.move')}</span></button>
        </>}
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
              {rows.map(m => <MailRow key={m.id} m={m} on={m.id === openId} color={where.account ? null : accounts.get(m.account)?.color ?? null} onOpen={() => open(m)} onHeart={() => act(m.flagged ? 'unfavorite' : 'favorite', [m.id])} />)}
            </section>
          })}
          {groups.reduce((n, g) => n + g.mails.length, 0) > limit && <button className="text-button mail-more" onClick={() => setLimit(l => l + PAGE)}>{t('mail.more')}</button>}
        </div>
        <div className="mail-read island">
          {draft ? <Compose initial={draft} accounts={data?.accounts ?? []} api={composer} say={say} setDialog={setDialog} onDone={() => { setDraft(null); reload() }} />
            : openId ? <Reader key={openId} id={openId} color={accounts.get(mails.find(m => m.id === openId)?.account ?? '')?.color} say={say} /> : <div className="empty">{t('mail.pick')}</div>}
        </div>
      </div>
    </div>
  )
}

function MailRow({ m, on, color, onOpen, onHeart }: { m: MailEntry; on: boolean; color: string | null; onOpen: () => void; onHeart: () => void }) {
  // a row holds the ♥ button, so it is not a <button> itself
  return (
    <div role="button" tabIndex={0} className={`mail-row ${on ? 'on' : ''} ${m.seen ? '' : 'unread'}`} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={color ? { borderLeftColor: color } : undefined}>
      <span className="mail-row-top">
        <span className="mail-from">{m.from || m.fromAddress}</span>
        {m.attachments > 0 && <Icon name="attach" size={15} />}
        <span className="mail-time">{timeText(m.date)}</span>
        <span className={`mail-state ${m.saved ? 'green' : 'orange'}`} title={m.saved ? t('mail.local') : t('mail.serverOnly')} />
      </span>
      <span className="mail-subject">{m.subject || t('mail.noSubject')}</span>
      {m.snippet && <span className="mail-snippet">{m.snippet}</span>}
      <button className={`mail-heart ${m.flagged ? 'on' : ''}`} title={t('mail.favorite')} aria-pressed={m.flagged} onClick={e => { e.stopPropagation(); onHeart() }}><Icon name={m.flagged ? 'heartFill' : 'heart'} size={18} /></button>
    </div>
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
          <span className="mail-acc-text"><strong>{a.name}</strong><small>{a.address}{s.error ? ` · ${t(`mail.err_${s.error}`)}` : ''}</small>
            <label className="mail-archive-by">{t('mail.archiveBy')}
              <select defaultValue={a.archiveBy ?? 'year'} onChange={e => window.drive.mail.setAccount(a.id, { archiveBy: e.target.value as 'year' })}>
                <option value="year">{t('mail.byYear')}</option><option value="month">{t('mail.byMonth')}</option><option value="none">{t('mail.byNone')}</option>
              </select></label></span>
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

/** HTML from a mail, made safe to edit in the window: nothing that runs, loads, submits or restyles the whole page. */
function safe(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,iframe,frame,frameset,object,embed,form,input,button,textarea,select,link,meta,base').forEach(n => n.remove())
  for (const el of doc.body.querySelectorAll('*')) for (const a of [...el.attributes])
    if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript):/i.test(a.value))) el.removeAttribute(a.name)
  return doc.body.innerHTML
}
// "forgot the attachment?": the mail's own words (not the quoted ones) speak of one
const ATTACH_WORDS = /attach|συνημμ|επισυν|anhang|angehängt|pièce jointe|ci-joint|adjunt|allegat|bijlage|załącz|příloh|priložen|bilaga|vedhæft|liite|melléklet/i
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

type Book = { address: string; name: string; count: number }[]
/** To, Cc, Bcc: chips, and the addresses already in the mail as suggestions. */
function AddressField({ label, value, onChange, book }: { label: string; value: MailAddress[]; onChange: (v: MailAddress[]) => void; book: Book }) {
  const [text, setText] = useState('')
  const [pick, setPick] = useState(0)
  const q = text.trim().toLowerCase()
  const hits = q ? book.filter(b => !value.some(v => v.address === b.address) && (b.address.includes(q) || b.name.toLowerCase().includes(q))).slice(0, 6) : []
  const add = (a: MailAddress) => { onChange([...value, a]); setText(''); setPick(0) }
  const commit = () => { const s = text.trim().replace(/[,;]$/, ''); if (ADDRESS.test(s)) add({ name: '', address: s }); else if (hits[pick]) add(hits[pick]) }
  return (
    <div className="mail-addr">
      <span className="mail-addr-label">{label}</span>
      {value.map(a => <span key={a.address} className="mail-addr-chip" title={a.address}>{a.name || a.address}
        <button aria-label={t('common.remove')} onClick={() => onChange(value.filter(x => x !== a))}><Icon name="close" size={14} /></button></span>)}
      <input value={text} onChange={e => { setText(e.target.value); setPick(0) }} onBlur={() => { if (text.trim()) commit() }}
        onKeyDown={e => {
          if ((['Enter', ',', ';'].includes(e.key) || (e.key === 'Tab' && hits.length)) && text.trim()) { e.preventDefault(); commit() }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          else if (e.key === 'ArrowDown') { e.preventDefault(); setPick(p => Math.min(p + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setPick(p => Math.max(p - 1, 0)) }
        }} />
      {hits.length > 0 && <div className="mail-addr-hits island">{hits.map((h, i) =>
        <button key={h.address} className={i === pick ? 'on' : ''} onMouseDown={e => { e.preventDefault(); add(h) }}><strong>{h.name || h.address}</strong>{h.name && <small>{h.address}</small>}</button>)}</div>}
    </div>
  )
}

export type ComposeApi = { send(): void; save(): void; attach(): void; cc(): void; discard(): void; sending: boolean }
/**
 * Writing a mail (MAIL_PLAN §9, step 4): From, To, Cc/Bcc, Subject, attachments and the text, the quoted mail and the
 * signature in it. Saved as a draft four seconds after the typing stops (here and on the server), and when left; the
 * bar above holds Send and Save draft, and the rest ([api]).
 */
function Compose({ initial, accounts, api, onDone, say, setDialog }: { initial: MailDraft; accounts: MailAccount[]; api: { current: ComposeApi | null }
  onDone: () => void; say: (s: string) => void; setDialog: (d: ReactNode) => void }) {
  const [d, setD] = useState(initial)
  const [showCc, setShowCc] = useState(initial.cc.length + initial.bcc.length > 0)
  const [state, setState] = useState<'' | 'saving' | 'saved' | 'here'>('')
  const [sending, setSending] = useState(false)
  const [book, setBook] = useState<Book>([])
  const [sigs, setSigs] = useState<Record<string, MailSignature>>({})
  const body = useRef<HTMLDivElement>(null), html = useRef(initial.html)
  const dRef = useRef(d), dirty = useRef(false), closed = useRef(false), chain = useRef<Promise<unknown>>(Promise.resolve())
  const [rev, setRev] = useState(0)
  dRef.current = d
  useEffect(() => { window.drive.mail.addresses().then(setBook); window.drive.mail.signatures().then(setSigs) }, [])
  useEffect(() => { html.current = safe(initial.html); body.current!.innerHTML = html.current }, [])
  const edit = (x: Partial<MailDraft>) => { setD(v => { const n = { ...v, ...x }; dRef.current = n; return n }); dirty.current = true; setRev(r => r + 1) }
  const now = (): MailDraft => ({ ...dRef.current, html: html.current })
  // one save at a time, so the second one already knows the draft's Message-ID
  const save = () => chain.current = chain.current.then(async () => {
    if (closed.current) return
    dirty.current = false; setState('saving')
    try {
      const r = await window.drive.mail.saveDraft(now())
      dRef.current = { ...dRef.current, messageId: r.messageId }; setD(dRef.current); setState(r.server ? 'saved' : 'here')
    } catch (e) { setState(''); say(errorText(e)) }
  })
  useEffect(() => { if (!rev) return; const timer = setTimeout(() => { if (dirty.current) save() }, 4000); return () => clearTimeout(timer) }, [rev])
  useEffect(() => () => { if (dirty.current && !closed.current) save() }, []) // left for another mail: kept as a draft

  const really = async () => {
    closed.current = true; setSending(true)
    await chain.current
    try { await window.drive.mail.send(now()); say(t('mail.sent')); onDone() }
    catch (e) { closed.current = false; say(errorText(e)) }
    setSending(false)
  }
  const send = () => {
    const x = now()
    if (!x.to.length && !x.cc.length && !x.bcc.length) { say(t('mail.err_noRecipients')); return }
    const own = body.current!.cloneNode(true) as HTMLElement
    own.querySelectorAll('blockquote, .tetra-signature').forEach(n => n.remove())
    if (!x.attachments.length && ATTACH_WORDS.test(`${x.subject} ${own.textContent}`)) {
      setDialog(<Confirm title={t('mail.forgotTitle')} body={t('mail.forgotBody')} action={t('mail.sendAnyway')} onClose={() => setDialog(null)} onConfirm={() => { setDialog(null); really() }} />)
      return
    }
    really()
  }
  api.current = {
    sending, send, save: () => { save(); },
    attach: () => window.drive.mail.pickFiles().then(f => f.length && edit({ attachments: [...dRef.current.attachments, ...f] }), e => say(errorText(e))),
    cc: () => setShowCc(s => !s),
    discard: () => { closed.current = true; (dRef.current.messageId ? window.drive.mail.discard(now()) : Promise.resolve()).catch(e => say(errorText(e))); onDone() },
  }
  // another account: its own signature in place of the old one
  const from = (account: string) => {
    const el = body.current!, old = el.querySelector('.tetra-signature'), s = sigs[accounts.find(a => a.id === account)?.address ?? '']
    if (s?.html) { const div = old ?? el.appendChild(document.createElement('div')); div.className = 'tetra-signature'; div.innerHTML = `-- <br>${safe(s.html)}` }
    else old?.remove()
    html.current = el.innerHTML
    edit({ account })
  }
  return (
    <div className="mail-compose">
      <div className="mail-compose-row">
        <span className="mail-addr-label">{t('mail.from')}</span>
        <select value={d.account} onChange={e => from(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.address}</option>)}</select>
        <span className="mail-draft-state">{state && t({ saving: 'mail.draftSaving', saved: 'mail.draftSaved', here: 'mail.draftHere' }[state])}</span>
      </div>
      <AddressField label={t('mail.toField')} value={d.to} onChange={to => edit({ to })} book={book} />
      {showCc && <><AddressField label={t('mail.cc')} value={d.cc} onChange={cc => edit({ cc })} book={book} />
        <AddressField label={t('mail.bcc')} value={d.bcc} onChange={bcc => edit({ bcc })} book={book} /></>}
      <input className="mail-compose-subject" placeholder={t('mail.subjectField')} value={d.subject} onChange={e => edit({ subject: e.target.value })} />
      {d.attachments.length > 0 && <div className="mail-files">{d.attachments.map((a, i) =>
        <span key={i} className="chip"><Icon name="attach" size={16} /> {a.name}{a.size ? ` · ${sizeText(a.size)}` : ''}
          <button aria-label={t('common.remove')} onClick={() => edit({ attachments: d.attachments.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button></span>)}</div>}
      <div ref={body} className="mail-editor" contentEditable role="textbox" aria-multiline aria-label={t('mail.subjectField')}
        onInput={() => { html.current = body.current!.innerHTML; dirty.current = true; setRev(r => r + 1) }} />
    </div>
  )
}

/** Settings › Αλληλογραφία › Υπογραφές (MAIL_PLAN §9c): an HTML signature per address, edited as text or as HTML. */
export function MailSignatures() {
  const [accs, setAccs] = useState<MailAccount[] | null>(null)
  const [sigs, setSigs] = useState<Record<string, MailSignature>>({})
  const [address, setAddress] = useState('')
  const [source, setSource] = useState(false)
  const [url, setUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const ed = useRef<HTMLDivElement>(null)
  useEffect(() => {
    window.drive.mail.accounts().then(r => { setAccs(r.accounts); setAddress(a => a || r.accounts[0]?.address || '') })
    window.drive.mail.signatures().then(x => { setSigs(x); setLoaded(true) })
  }, [])
  const sig: MailSignature = sigs[address] ?? { html: '', newMail: true, replies: true, position: 'below' }
  const save = (s: MailSignature) => { setSigs(x => ({ ...x, [address]: s })); window.drive.mail.setSignature(address, s) }
  const fromEditor = () => ed.current && save({ ...sig, html: ed.current.innerHTML })
  useEffect(() => { if (ed.current && !source) ed.current.innerHTML = safe(sig.html) }, [address, source, accs, loaded])
  const command = (name: string, value?: string) => { ed.current?.focus(); document.execCommand(name, false, value); fromEditor() }
  if (!accs) return null
  if (!accs.length) return <section className="settings-card island"><h3>{t('mail.signatures')}</h3><p className="muted">{t('mail.noAccounts')}</p></section>
  return (
    <section className="settings-card island mail-sig">
      <h3><Icon name="edit" size={20} />{t('mail.signatures')}</h3>
      <label className="mail-sig-for">{t('mail.sigFor')}
        <select value={address} onChange={e => setAddress(e.target.value)}>{accs.map(a => <option key={a.id} value={a.address}>{a.address}</option>)}</select></label>
      <div className="mail-sig-tools">
        <button className="round flat" title={t('mail.bold')} disabled={source} onClick={() => command('bold')}><Icon name="bold" size={20} /></button>
        <button className="round flat" title={t('mail.italic')} disabled={source} onClick={() => command('italic')}><Icon name="italic" size={20} /></button>
        <input className="field" placeholder="https://…" value={url} disabled={source} onChange={e => setUrl(e.target.value)} />
        <button className="round flat" title={t('mail.link')} disabled={source || !/^(https?:|mailto:)/i.test(url)} onClick={() => { command('createLink', url); setUrl('') }}><Icon name="link" size={20} /></button>
        <button className="round flat" title={t('mail.image')} disabled={source} onClick={() => { setError(''); window.drive.mail.pickImage().then(src => src && command('insertImage', src), e => setError(errorText(e))) }}><Icon name="photos" size={20} /></button>
        <label className="cal-switch"><input type="checkbox" checked={source} onChange={e => { if (!e.target.checked) fromEditor(); setSource(e.target.checked) }} /><span>{t('mail.sigHtml')}</span></label>
      </div>
      {source
        ? <textarea className="field mail-sig-source" rows={8} value={sig.html} onChange={e => save({ ...sig, html: e.target.value })} spellCheck={false} />
        : <div ref={ed} className="mail-editor mail-sig-editor" contentEditable onBlur={fromEditor} />}
      {error && <p className="error">{error}</p>}
      <p className="muted">{t('mail.sigPlain')}</p>
      <label className="cal-switch"><input type="checkbox" checked={sig.newMail} onChange={e => save({ ...sig, newMail: e.target.checked })} /><span>{t('mail.sigNew')}</span></label>
      <label className="cal-switch"><input type="checkbox" checked={sig.replies} onChange={e => save({ ...sig, replies: e.target.checked })} /><span>{t('mail.sigReplies')}</span></label>
      <div className="segmented island">
        {(['above', 'below'] as const).map(p => <button key={p} className={sig.position === p ? 'on' : ''} onClick={() => save({ ...sig, position: p })}>{t(p === 'above' ? 'mail.sigAbove' : 'mail.sigBelow')}</button>)}
      </div>
    </section>
  )
}
