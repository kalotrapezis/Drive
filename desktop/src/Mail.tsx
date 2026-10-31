import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MailAccount, MailAddress, MailCheck, MailStorageInfo, MailCleanPlan, MailDraft, MailDraftKind, MailEntry, MailFilter, MailFolder, MailGarbage, MailOp, MailOpened, MailPrivacy, MailRole, MailServer, MailSignature, MailState } from './drive'
import { formatBytes } from './timeline'
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

type BarItem = { key: string; rank: number; icon: IconName; label: string; onClick: () => void; cls?: string; sep?: boolean; wide?: boolean }
const SEARCH_MIN = 170, MORE = 52 // the search box's least width, and the ⋯ button's
/**
 * The action bar as wide as the window lets it be (the user, 31 Oct: "add a more button to the menu if it shrinks too much"):
 * every item is measured once, then those of the lowest importance (highest rank) go under «⋯ Περισσότερα», in their order.
 */
function MailBar({ items, children }: { items: BarItem[]; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  const widths = useRef(new Map<string, number>())
  const sig = items.map(i => `${i.key}:${i.label}`).join()
  const [m, setM] = useState<{ sig: string; shown: Set<string> } | null>(null)
  const [open, setOpen] = useState(false)
  const shown = m?.sig === sig ? m.shown : null // null: everything drawn, to be measured
  useLayoutEffect(() => {
    if (shown || !bar.current) return
    for (const b of bar.current.querySelectorAll<HTMLElement>('[data-key]')) widths.current.set(b.dataset.key!, b.offsetWidth + 4 + (b.previousElementSibling?.classList.contains('mail-bar-sep') ? 13 : 0))
    const room = bar.current.clientWidth - 16 - SEARCH_MIN, w = (i: BarItem) => widths.current.get(i.key) ?? 52
    const all = items.reduce((n, i) => n + w(i), 0)
    const keep = new Set<string>()
    let used = MORE
    if (all <= room) items.forEach(i => keep.add(i.key))
    else for (const i of [...items].sort((a, b) => a.rank - b.rank)) { if (used + w(i) > room) break; used += w(i); keep.add(i.key) }
    setM({ sig, shown: keep })
  }, [shown, sig])
  useEffect(() => { const ro = new ResizeObserver(() => setM(null)); if (bar.current) ro.observe(bar.current); return () => ro.disconnect() }, [])
  const hidden = shown ? items.filter(i => !shown.has(i.key)) : []
  let any = false
  return (
    <div className="mail-bar island" ref={bar}>
      {items.filter(i => !shown || shown.has(i.key)).map(i => {
        const sep = i.sep && any; any = true
        return <span key={i.key} className="mail-bar-slot">{sep && <span className="mail-bar-sep" />}
          <button data-key={i.key} className={`mail-bar-item ${i.wide || i.cls === 'new' || i.cls === 'send' ? '' : 'act'} ${i.cls ?? ''}`} title={i.label} onClick={i.onClick}>
            <Icon name={i.icon} size={20} /><span>{i.label}</span></button></span>
      })}
      {hidden.length > 0 && <div className="mail-more-menu">
        <button className={`mail-bar-item ${open ? 'on' : ''}`} title={t('mail.moreActions')} aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="more" size={20} /></button>
        {open && <><div className="mail-more-scrim" onClick={() => setOpen(false)} />
          <div className="island menu-body mail-more-list" role="menu">
            {hidden.map(i => <button key={i.key} role="menuitem" className="sheet-row" onClick={() => { setOpen(false); i.onClick() }}><Icon name={i.icon} size={20} />{i.label}</button>)}
          </div></>}
      </div>}
      {children}
    </div>
  )
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
  useEffect(() => { window.drive.mail.sync() }, []) // Mail opened: a look for new mail now (the user, 31 Oct)
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
  const manage = () => data && setDialog(<Accounts data={data} onClose={close} onAdd={addAccount} onRenamed={reload}
    onStorage={id => setDialog(<MailStorage only={id} onClose={manage} say={say} />)}
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
      <MailBar items={[
        { key: 'new', rank: 0, cls: 'new', icon: 'add', label: t('mail.new'), onClick: () => write(null, 'new') },
        { key: 'sync', rank: 7, icon: 'refresh', label: t('mail.sync'), onClick: () => window.drive.mail.sync() },
        { key: 'filter', rank: 6, cls: filtered ? 'on' : '', icon: 'filter', label: t('mail.filter'), onClick: filter },
        { key: 'accounts', rank: 8, icon: 'person', label: t('mail.accounts'), onClick: manage },
        { key: 'storage', rank: 9, icon: 'storage', label: t('mail.storage'), onClick: () => setDialog(<MailStorage onClose={close} say={say} />) },
        ...(draft ? [
          { key: 'send', rank: 0, cls: 'send', label: t('mail.send'), icon: 'send', onClick: () => composer.current?.send(), sep: true, wide: true },
          { key: 'save', rank: 1, label: t('mail.saveDraft'), icon: 'save', onClick: () => composer.current?.save(), wide: true },
          { key: 'attach', rank: 2, label: t('mail.attach'), icon: 'attach', onClick: () => composer.current?.attach() },
          { key: 'cc', rank: 4, label: t('mail.ccBcc'), icon: 'person', onClick: () => composer.current?.cc() },
          { key: 'discard', rank: 3, label: t('mail.discard'), icon: 'deleteForever', onClick: () => composer.current?.discard() },
        ] as BarItem[] : []),
        ...(current && !draft && !accounts.get(current.account)?.shadow ? [
          { key: 'reply', rank: 1, label: t('mail.reply'), icon: 'reply', onClick: () => write(current.id, 'reply'), sep: true },
          { key: 'replyAll', rank: 3, label: t('mail.replyAll'), icon: 'replyAll', onClick: () => write(current.id, 'replyAll') },
          { key: 'forward', rank: 3, label: t('mail.forward'), icon: 'mailForward', onClick: () => write(current.id, 'forward') },
          { key: 'forwardAttached', rank: 5, label: t('mail.forwardAttached'), icon: 'attach', onClick: () => write(current.id, 'forwardAttached') },
          ...(current.folder !== 'Archive' ? [{ key: 'archive', rank: 2, label: t('mail.archive'), icon: 'archive', onClick: () => away('archive'), sep: true }] as BarItem[] : []),
          { key: 'delete', rank: 2, label: t('common.delete'), icon: 'trash', onClick: () => away('delete'), sep: current.folder === 'Archive' },
          current.folder === 'Spam'
            ? { key: 'notSpam', rank: 4, label: t('mail.notSpam'), icon: 'mail', onClick: () => away('notSpam') }
            : { key: 'spam', rank: 4, label: t('mail.spam'), icon: 'warning', onClick: () => away('spam') },
          { key: 'read', rank: 4, label: t(current.seen ? 'mail.markUnread' : 'mail.markRead'), icon: current.seen ? 'visibilityOff' : 'visibility', onClick: () => act(current.seen ? 'unread' : 'read', [current.id]) },
          { key: 'move', rank: 5, label: t('common.move'), icon: 'moveTo', onClick: moveTo },
        ] as BarItem[] : []),
      ]}>
        <label className="mail-search"><Icon name="search" size={18} />
          <input value={query} placeholder={t('mail.search')} onChange={e => { setQuery(e.target.value); setLimit(PAGE) }} /></label>
      </MailBar>
      {data?.accounts.some(a => !a.shadow && !a.cleanConfirmed && (a.serverClean.on !== false || a.localClean.on)) && <div className="mail-banner island">
        <span>{t('mail.cleanBanner')}</span>
        <button className="text-button" onClick={() => setDialog(<CleanCheck accounts={data.accounts.filter(a => !a.shadow && !a.cleanConfirmed)} onClose={() => { close(); reload() }} />)}>{t('mail.check')}</button>
      </div>}
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
                return <button key={a.id} className={`mail-folder sub ${acc.shadow ? 'shadow' : ''} ${where.role === f.role && where.account === a.id ? 'on' : ''}`} onClick={() => setWhere({ role: f.role, account: a.id })}>
                  <span className="mail-dot" style={{ background: acc.color }} /><span className="mail-folder-label">{acc.name}</span>
                  {acc.shadow && <span className="mail-shadow" title={acc.device}>⇄ {acc.device}</span>}<Count unread={a.unread} orange={a.orange} />
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
              {rows.map(m => <MailRow key={m.id} m={m} on={m.id === openId} color={where.account ? null : accounts.get(m.account)?.color ?? null} onOpen={() => open(m)} onHeart={accounts.get(m.account)?.shadow ? undefined : () => act(m.flagged ? 'unfavorite' : 'favorite', [m.id])} />)}
            </section>
          })}
          {groups.reduce((n, g) => n + g.mails.length, 0) > limit && <button className="text-button mail-more" onClick={() => setLimit(l => l + PAGE)}>{t('mail.more')}</button>}
        </div>
        <div className="mail-read island">
          {draft ? <Compose initial={draft} accounts={(data?.accounts ?? []).filter(a => !a.shadow)} api={composer} say={say} setDialog={setDialog} onDone={() => { setDraft(null); reload() }} />
            : openId ? <Reader key={openId} id={openId} color={accounts.get(mails.find(m => m.id === openId)?.account ?? '')?.color} say={say} setDialog={setDialog} /> : <div className="empty">{t('mail.pick')}</div>}
        </div>
      </div>
    </div>
  )
}

function MailRow({ m, on, color, onOpen, onHeart }: { m: MailEntry; on: boolean; color: string | null; onOpen: () => void; onHeart?: () => void }) {
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
      <button className={`mail-heart ${m.flagged ? 'on' : ''}`} title={t('mail.favorite')} aria-pressed={m.flagged} disabled={!onHeart} onClick={e => { e.stopPropagation(); onHeart?.() }}><Icon name={m.flagged ? 'heartFill' : 'heart'} size={18} /></button>
    </div>
  )
}

/** The open mail: its HTML in a frame that runs no script and loads nothing from the web (the page's own CSP). */
// files that can run something on this computer (§9c): opened only after a warning
const RISKY = /\.(exe|msi|bat|cmd|com|scr|pif|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|sh|run|bin|appimage|desktop|deb|rpm|apk|lnk|reg|hta|cpl|docm|xlsm|pptm|dotm|xltm|iso|img)$/i
const hostOf = (u: string) => { try { return new URL(/^https?:/i.test(u) ? u : `http://${u}`).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }

function Reader({ id, color, say, setDialog }: { id: string; color?: string; say: (s: string) => void; setDialog: (d: ReactNode) => void }) {
  const [m, setM] = useState<MailOpened | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const load = (images = false) => window.drive.mail.open(id, images).then(setM, e => say(errorText(e)))
  useEffect(() => { load() }, [id])
  if (!m) return null
  const close = () => setDialog(null)
  const openFile = (a: { name: string; file: string }) => {
    const go = () => window.drive.mail.openFile(a.file).catch(e => say(errorText(e)))
    if (RISKY.test(a.name)) setDialog(<Confirm title={t('mail.riskyTitle')} body={t('mail.riskyBody', { name: a.name })} action={t('mail.openAnyway')} danger onClose={close} onConfirm={() => { close(); go() }} />)
    else go()
  }
  /** A link whose words name one place and whose address goes to another (phishing, §9c): said before it opens. */
  const follow = (a: HTMLAnchorElement) => {
    const shown = (a.textContent ?? '').trim(), go = () => window.drive.mail.openLink(a.href)
    const looks = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(shown)
    if (looks && /^https?:/i.test(a.href) && hostOf(shown) !== hostOf(a.href))
      setDialog(<Confirm title={t('mail.phishTitle')} body={t('mail.phishBody', { shown: hostOf(shown), real: hostOf(a.href) })} action={t('mail.openAnyway')} danger onClose={close} onConfirm={() => { close(); go() }} />)
    else go()
  }
  const fit = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    frame.current!.style.height = `${doc.documentElement.scrollHeight + 8}px`
    // links open in the browser, never inside Tetra
    doc.addEventListener('click', e => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
      if (a) { e.preventDefault(); follow(a) }
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
        {m.attachments.map(a => <button key={a.file} className={`chip ${RISKY.test(a.name) ? 'risky' : ''}`} onClick={() => openFile(a)}>
          <Icon name={RISKY.test(a.name) ? 'warning' : 'file'} size={16} /> {a.name} · {sizeText(a.size)}</button>)}
      </div>}
      {m.remote && <div className="mail-images-bar">
        <span>{t('mail.imagesBlocked')}</span>
        <button className="text-button" onClick={() => load(true)}>{t('mail.showImages')}</button>
        <button className="text-button" onClick={() => window.drive.mail.privacy().then(p => window.drive.mail.setPrivacy({ ...p, senders: [...p.senders, m.fromAddress] })).then(() => load())}>{t('mail.alwaysSender')}</button>
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

function Accounts({ data, onAdd, onRemove, onRenamed, onStorage, onClose }: { data: Data; onAdd: () => void; onRemove: (a: MailAccount) => void; onRenamed: () => void; onStorage: (id: string) => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>{t('mail.accounts')}</h3>
      {data.accounts.map(a => {
        const s = data.status[a.id] ?? {}
        return <div key={a.id} className="sheet-row">
          <span className="mail-dot" style={{ background: a.color }} />
          <span className="mail-acc-text">
            {a.shadow ? <strong>{a.name}<span className="mail-shadow"> ⇄ {a.device}</span></strong>
              : <input className="mail-acc-name" defaultValue={a.name} aria-label={t('mail.accountName')} placeholder={t('mail.accountNameHint')} maxLength={40}
                onBlur={e => { const v = e.target.value.trim(); if (v && v !== a.name) window.drive.mail.setAccount(a.id, { name: v }).then(onRenamed) }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />}
            <small>{a.address}{s.error ? ` · ${t(`mail.err_${s.error}`)}` : ''}</small>
            {!a.shadow && <label className="mail-archive-by">{t('mail.archiveBy')}
              <select defaultValue={a.archiveBy ?? 'year'} onChange={e => window.drive.mail.setAccount(a.id, { archiveBy: e.target.value as 'year' })}>
                <option value="year">{t('mail.byYear')}</option><option value="month">{t('mail.byMonth')}</option><option value="none">{t('mail.byNone')}</option>
              </select></label>}</span>
          <button className="round flat" title={t('mail.storage')} onClick={() => onStorage(a.id)}><Icon name="storage" size={20} /></button>
          {!a.shadow && <button className="round flat" title={t('common.remove')} onClick={() => onRemove(a)}><Icon name="trash" size={20} /></button>}
        </div>
      })}
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>{t('common.close')}</button>
        <button className="filled-button" onClick={onAdd}>{t('mail.addAccount')}</button>
      </div>
    </Modal>
  )
}

/**
 * «Αποθήκευση» (the user, 31 Oct: "how can I access my mails if the folder is hidden in the system folder?"): where each
 * account's mail is kept on this computer, how much it takes and how many mails, and «Άνοιγμα φακέλου» in the file manager.
 * The phone's Mail says the same in the same words (MAIL_PLAN §17).
 */
function MailStorage({ only, onClose, say }: { only?: string; onClose: () => void; say: (s: string) => void }) {
  const [info, setInfo] = useState<MailStorageInfo | null>(null)
  useEffect(() => { window.drive.mail.storage().then(setInfo, e => say(errorText(e))) }, [])
  const open = (id?: string) => window.drive.mail.openFolder(id).catch(e => say(errorText(e)))
  const gb = (n: number) => n >= 1e9 ? `${(n / 1e9).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB` : n >= 1e6 ? `${Math.round(n / 1e6).toLocaleString(locale())} MB` : `${Math.ceil(n / 1e3).toLocaleString(locale())} KB`
  const shown = info?.accounts.filter(a => !only || a.id === only) ?? []
  return (
    <Modal onClose={onClose}>
      <h3><Icon name="storage" />{t('mail.storage')}</h3>
      {!info ? <span className="spinner" /> : <>
        {shown.map(a => (
          <div key={a.id} className="mail-store">
            <div className="mail-store-head"><span className="mail-dot" style={{ background: a.color }} /><strong>{a.name}</strong><small>{a.address}</small></div>
            <p>{t('mail.storageHas', { size: gb(a.bytes), n: a.mails.toLocaleString(locale()) })}</p>
            <code className="mail-store-path">{a.path}</code>
            <button className="outline-button" onClick={() => open(a.id)}><Icon name="open" size={18} />{t('mail.openFolder')}</button>
          </div>
        ))}
        {!only && <p className="mail-store-total">{t('mail.storageTotal', { size: gb(info.bytes), n: info.mails.toLocaleString(locale()) })} <button className="link" onClick={() => open()}>{t('mail.openFolder')}</button></p>}
      </>}
      <div className="dialog-actions"><button className="filled-button" onClick={onClose}>{t('common.close')}</button></div>
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
      const r = microsoft ? await window.drive.mail.addMicrosoft(address.trim()) : await window.drive.mail.add(address.trim(), server, google ? pass.replace(/\s/g, '') : pass)
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
          {microsoft ? <>
            <p>{t('mail.msHow')}</p>
            <button className="filled-button mail-ms" disabled={busy} onClick={signIn}>{busy ? t('mail.msWaiting') : t('mail.msSignIn')}</button>
          </> : <>
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
            <div><span>{t('mail.serverClean')}</span><span>{t('mail.serverCleanValue', { a: (done.account.serverClean.attachmentsMonths ?? 36) / 12, b: (done.account.serverClean.otherMonths ?? 24) / 12 })}</span></div>
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
    window.drive.mail.accounts().then(r => { const own = r.accounts.filter(a => !a.shadow); setAccs(own); setAddress(a => a || own[0]?.address || '') })
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

/**
 * The first-run check (the user, 31 Oct): what the clean-up would do for an account — archive where, delete on the
 * server (each with a checked copy here), delete here — and nothing until «Εκτέλεση»; then what it did. Below it the
 * garbage scan, with «Καθαρισμός» after the same kind of preview.
 */
export function CleanCheck({ accounts, onClose }: { accounts: MailAccount[]; onClose: () => void }) {
  const [id, setId] = useState(accounts[0]?.id ?? '')
  const [plan, setPlan] = useState<MailCleanPlan | null>(null)
  const [done, setDone] = useState<{ archive: number; server: number; local: number; errors: string[] } | null>(null)
  const [junk, setJunk] = useState<MailGarbage | null>(null)
  const [swept, setSwept] = useState<{ adopted: number; cleared: number; deleted: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const look = () => window.drive.mail.cleanPlan(id).then(setPlan, e => setError(errorText(e)))
  const scan = () => window.drive.mail.garbage().then(setJunk, e => setError(errorText(e)))
  useEffect(() => { setPlan(null); setDone(null); look() }, [id])
  useEffect(() => { scan() }, [])
  const acc = accounts.find(a => a.id === id)
  const part = (key: string, p: MailCleanPlan['server']) => p.count > 0 && <details className="mail-check-row" key={key}>
    <summary><span>{t(key)}</span><strong>{t('mail.nMails', { count: p.count })} · {formatBytes(p.bytes)}</strong></summary>
    <ul>{p.sample.map(s => <li key={s.id}>{new Date(s.date).toLocaleDateString(locale())} · {s.from} · {s.subject || t('mail.noSubject')}</li>)}</ul>
  </details>
  const heap = (key: string, h: MailGarbage['orphans']) => h.count > 0 && <details className="mail-check-row" key={key}>
    <summary><span>{t(key)}</span><strong>{h.count}</strong></summary><ul>{h.sample.map(s => <li key={s}>{s}</li>)}</ul></details>
  const nothing = plan && !plan.archive.count && !plan.server.count && !plan.local.count
  const clean = junk && ['orphans', 'missing', 'lonely', 'partial', 'empty', 'leftovers', 'duplicates'].every(k => (junk[k as 'orphans'] as { count: number }).count === 0)
  return (
    <Modal onClose={onClose}>
      <div className="mail-check">
        <h3>{t('mail.check')}</h3>
        {accounts.length > 1 && <select className="field" value={id} onChange={e => setId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.address}</option>)}</select>}
        <p>{acc?.cleanConfirmed ? t('mail.checkAgain') : t('mail.checkFirst')}</p>
        {plan && <>
          {part(acc?.archiveBy === 'month' ? 'mail.wouldArchiveMonth' : 'mail.wouldArchiveYear', plan.archive)}
          {part('mail.wouldServer', plan.server)}
          {part('mail.wouldLocal', plan.local)}
          {part('mail.wouldKeep', plan.unsafe)}
          {nothing && <p className="muted">{t('mail.wouldNothing')}</p>}
          {plan.warn && <p className="error">{t('mail.cleanWarn')}</p>}
        </>}
        {done && <p className="mail-check-done">{t('mail.didClean', { archive: done.archive, server: done.server, local: done.local })}{done.errors.length ? ` ${done.errors.join(' ')}` : ''}</p>}
        <div className="dialog-actions">
          <button className="filled-button" disabled={!plan || busy || (!!nothing && !!acc?.cleanConfirmed)}
            onClick={async () => { setBusy(true); setError(''); try { setDone(await window.drive.mail.cleanRun(id)); await look() } catch (e) { setError(errorText(e)) } setBusy(false) }}>{t('mail.run')}</button>
        </div>
        <h4>{t('mail.garbage')}</h4>
        {junk && <>
          {heap('mail.gOrphans', junk.orphans)}{heap('mail.gMissing', junk.missing)}{heap('mail.gLonely', junk.lonely)}{heap('mail.gPartial', junk.partial)}
          {heap('mail.gEmpty', junk.empty)}{heap('mail.gLeftovers', junk.leftovers)}{heap('mail.gDuplicates', junk.duplicates)}
          {clean ? <p className="muted">{t('mail.gNothing')}</p> : <p className="muted">{t('mail.gHow')}</p>}
        </>}
        {swept && <p className="mail-check-done">{t('mail.swept', { adopted: swept.adopted, cleared: swept.cleared, deleted: swept.deleted })}</p>}
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button className="text-button" onClick={onClose}>{t('common.close')}</button>
          <button className="filled-button secondary" disabled={!junk || !!clean || busy} onClick={async () => { setBusy(true); try { setSwept(await window.drive.mail.sweep()); await scan() } catch (e) { setError(errorText(e)) } setBusy(false) }}>{t('mail.sweep')}</button>
        </div>
      </div>
    </Modal>
  )
}

/** Settings › Αλληλογραφία: signatures, archive and clean-up, filters, spam, privacy (MAIL_PLAN §9c). */
export function MailSettings() {
  return <><CheckCard /><MailSignatures /><CleanCard /><FiltersCard /><SpamCard /><PrivacyCard /><MicrosoftCard /></>
}

/** «Έλεγχος για νέα» (the user, 31 Oct: "how often does it check for new mails?"): every account on this computer. */
function CheckCard() {
  const [check, setCheck] = useState<MailCheck | null>(null)
  useEffect(() => { window.drive.mail.check().then(setCheck) }, [])
  if (check === null) return null
  const set = (c: MailCheck) => window.drive.mail.setCheck(c).then(setCheck)
  return (
    <section className="settings-card island">
      <h3><Icon name="refresh" size={20} />{t('mail.checkTitle')}</h3>
      <div className="segmented mail-every">
        {(['push', 5, 15, 30, 'manual'] as MailCheck[]).map(c => <button key={c} className={check === c ? 'on' : ''} onClick={() => set(c)}>
          {c === 'push' ? t('mail.checkPush') : c === 'manual' ? t('mail.checkManual') : t('mail.checkMinutes', { n: c })}</button>)}
      </div>
      <p className="muted">{t(check === 'push' ? 'mail.checkPushHow' : check === 'manual' ? 'mail.checkManualHow' : 'mail.checkEveryHow', { n: typeof check === 'number' ? check : 0 })}</p>
    </section>
  )
}

/** The Microsoft app's id (MAIL_PLAN §13): registered once by the user; Hotmail and Microsoft 365 sign in through it. */
function MicrosoftCard() {
  const [id, setId] = useState<string | null>(null)
  const [state, setState] = useState('')
  useEffect(() => { window.drive.mail.msClient().then(setId) }, [])
  if (id === null) return null
  return (
    <section className="settings-card island">
      <h3><Icon name="key" size={20} />{t('mail.msTitle')}</h3>
      <p className="muted">{t('mail.msClientHow')}</p>
      <div className="mail-filter-row">
        <input className="field" value={id} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} onChange={e => { setId(e.target.value); setState('') }} />
        <button className="text-button" onClick={() => window.drive.mail.setMsClient(id).then(() => setState(t('mail.msSaved')), e => setState(errorText(e)))}>{t('common.save')}</button>
      </div>
      {state && <p className="muted">{state}</p>}
    </section>
  )
}

function CleanCard() {
  const [accs, setAccs] = useState<MailAccount[] | null>(null)
  const [check, setCheck] = useState(false)
  const load = () => window.drive.mail.accounts().then(r => setAccs(r.accounts.filter(a => !a.shadow)))
  useEffect(() => { load() }, [])
  if (!accs?.length) return null
  const set = (a: MailAccount, changes: Parameters<typeof window.drive.mail.setAccount>[1]) => window.drive.mail.setAccount(a.id, changes).then(load)
  const years = (a: MailAccount, which: 'serverClean' | 'localClean', key: 'attachmentsMonths' | 'otherMonths', fallback: number) =>
    <input className="field mail-years" type="number" min={0.5} max={50} step={0.5} defaultValue={(a[which][key] ?? fallback) / 12}
      onBlur={e => { const m = Math.round(Number(e.target.value) * 12); if (m >= 1 && m <= 600) set(a, { [which]: { ...a[which], [key]: m } }) }} />
  return (
    <section className="settings-card island mail-clean">
      <h3><Icon name="archive" size={20} />{t('mail.cleanTitle')}</h3>
      {accs.map(a => <div key={a.id} className="mail-clean-acc">
        <strong><span className="mail-dot" style={{ background: a.color }} /> {a.address}</strong>
        <label className="mail-archive-by">{t('mail.archiveBy')}
          <select value={a.archiveBy ?? 'year'} onChange={e => set(a, { archiveBy: e.target.value as 'year' })}>
            <option value="year">{t('mail.byYear')}</option><option value="month">{t('mail.byMonth')}</option><option value="none">{t('mail.byNone')}</option></select></label>
        <label className="cal-switch"><input type="checkbox" checked={a.serverClean.on !== false} onChange={e => set(a, { serverClean: { ...a.serverClean, on: e.target.checked } })} /><span>{t('mail.cleanServer')}</span></label>
        {a.serverClean.on !== false && <div className="mail-ages">{t('mail.withAttachmentsAfter')} {years(a, 'serverClean', 'attachmentsMonths', 36)} {t('mail.years')} · {t('mail.otherAfter')} {years(a, 'serverClean', 'otherMonths', 24)} {t('mail.years')}</div>}
        <label className="cal-switch"><input type="checkbox" checked={!!a.localClean.on} onChange={e => set(a, { localClean: { ...a.localClean, on: e.target.checked } })} /><span>{t('mail.cleanLocal')}</span></label>
        {a.localClean.on && <div className="mail-ages">{t('mail.withAttachmentsAfter')} {years(a, 'localClean', 'attachmentsMonths', 120)} {t('mail.years')} · {t('mail.otherAfter')} {years(a, 'localClean', 'otherMonths', 120)} {t('mail.years')}</div>}
        <label className="cal-switch"><input type="checkbox" checked={a.keepFavorites !== false} onChange={e => set(a, { keepFavorites: e.target.checked })} /><span>{t('mail.keepFavorites')}</span></label>
        <p className="muted">{a.cleanConfirmed ? t('mail.cleanRuns', { date: a.cleanedAt ? new Date(a.cleanedAt).toLocaleString(locale()) : '—' }) : t('mail.cleanWaits')}</p>
      </div>)}
      <button className="filled-button secondary" onClick={() => setCheck(true)}>{t('mail.check')}</button>
      {check && <CleanCheck accounts={accs} onClose={() => { setCheck(false); load() }} />}
    </section>
  )
}

const OPS_FOR: Record<string, string[]> = { size: ['gt', 'lt'], age: ['gt', 'lt'], hasAttachment: [] }
function FiltersCard() {
  const [list, setList] = useState<MailFilter[] | null>(null)
  const [role, setRole] = useState<MailRole>('Inbox')
  const [result, setResult] = useState('')
  useEffect(() => { window.drive.mail.filters().then(setList) }, [])
  if (!list) return null
  const save = (next: MailFilter[]) => { setList(next); window.drive.mail.setFilters(next) }
  const edit = (i: number, x: Partial<MailFilter>) => save(list.map((r, j) => j === i ? { ...r, ...x } : r))
  const field = (f: string) => t(`mail.f_${f}`)
  return (
    <section className="settings-card island mail-filters">
      <h3><Icon name="filter" size={20} />{t('mail.filters')}</h3>
      <p className="muted">{t('mail.filtersHow')}</p>
      {list.map((r, i) => <div key={r.id} className="mail-filter">
        <div className="mail-filter-top">
          <input type="checkbox" checked={r.on} onChange={e => edit(i, { on: e.target.checked })} aria-label={t('common.on')} />
          <input className="field" value={r.name} placeholder={t('common.name')} onChange={e => edit(i, { name: e.target.value })} />
          <select value={r.match} onChange={e => edit(i, { match: e.target.value as 'all' })}><option value="all">{t('mail.matchAll')}</option><option value="any">{t('mail.matchAny')}</option></select>
          <button className="round flat" title={t('common.delete')} onClick={() => save(list.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
        </div>
        {r.conditions.map((c, k) => <div key={k} className="mail-filter-row">
          <span>{t('mail.if')}</span>
          <select value={c.field} onChange={e => edit(i, { conditions: r.conditions.map((x, j) => j === k ? { field: e.target.value, op: (OPS_FOR[e.target.value] ?? ['contains'])[0] ?? 'is', value: e.target.value === 'hasAttachment' ? true : '' } : x) })}>
            {['from', 'to', 'subject', 'body', 'account', 'hasAttachment', 'size', 'age'].map(f => <option key={f} value={f}>{field(f)}</option>)}</select>
          {c.field === 'hasAttachment'
            ? <select value={String(c.value)} onChange={e => edit(i, { conditions: r.conditions.map((x, j) => j === k ? { ...x, value: e.target.value === 'true' } : x) })}><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
            : <>
              <select value={c.op} onChange={e => edit(i, { conditions: r.conditions.map((x, j) => j === k ? { ...x, op: e.target.value } : x) })}>
                {(OPS_FOR[c.field] ?? ['contains', 'not', 'is', 'starts']).map(o => <option key={o} value={o}>{t(`mail.op_${o}${c.field === 'size' ? 'Kb' : c.field === 'age' ? 'Days' : ''}`)}</option>)}</select>
              <input className="field" value={String(c.value ?? '')} onChange={e => edit(i, { conditions: r.conditions.map((x, j) => j === k ? { ...x, value: e.target.value } : x) })} />
            </>}
          <button className="round flat" aria-label={t('common.remove')} onClick={() => edit(i, { conditions: r.conditions.filter((_, j) => j !== k) })}><Icon name="close" size={16} /></button>
        </div>)}
        <button className="text-button" onClick={() => edit(i, { conditions: [...r.conditions, { field: 'from', op: 'contains', value: '' }] })}>+ {t('mail.addCondition')}</button>
        {r.actions.map((a, k) => <div key={k} className="mail-filter-row">
          <span>{t('mail.then')}</span>
          <select value={a.type} onChange={e => edit(i, { actions: r.actions.map((x, j) => j === k ? { type: e.target.value, ...(e.target.value === 'move' ? { to: 'Archive' } : {}) } : x) })}>
            {['move', 'archive', 'delete', 'spam', 'read', 'favorite', 'saveAttachments'].map(x => <option key={x} value={x}>{t(`mail.a_${x}`)}</option>)}</select>
          {a.type === 'move' && <select value={a.to} onChange={e => edit(i, { actions: r.actions.map((x, j) => j === k ? { ...x, to: e.target.value } : x) })}>
            {(['Inbox', 'Archive', 'Spam', 'Trash'] as MailRole[]).map(x => <option key={x} value={x}>{t(`mail.role${x}`)}</option>)}</select>}
          {a.type === 'saveAttachments' && <input className="field" placeholder={t('mail.filesFolder')} value={a.folder ?? ''} onChange={e => edit(i, { actions: r.actions.map((x, j) => j === k ? { ...x, folder: e.target.value } : x) })} />}
          <button className="round flat" aria-label={t('common.remove')} onClick={() => edit(i, { actions: r.actions.filter((_, j) => j !== k) })}><Icon name="close" size={16} /></button>
        </div>)}
        <button className="text-button" onClick={() => edit(i, { actions: [...r.actions, { type: 'move', to: 'Archive' }] })}>+ {t('mail.addAction')}</button>
      </div>)}
      <div className="mail-filter-run">
        <button className="filled-button secondary" onClick={() => save([...list, { id: `f${Date.now()}`, name: '', on: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'move', to: 'Archive' }] }])}>{t('mail.newFilter')}</button>
        {list.length > 0 && <>
          <select value={role} onChange={e => setRole(e.target.value as MailRole)}>{(['Inbox', 'Archive', 'Sent', 'Spam'] as MailRole[]).map(x => <option key={x} value={x}>{t(`mail.role${x}`)}</option>)}</select>
          <button className="text-button" onClick={() => window.drive.mail.runFilters(role, null).then(r => setResult(t('mail.filtersRan', { matched: r.matched })), e => setResult(errorText(e)))}>{t('mail.runNow')}</button>
          {result && <span className="muted">{result}</span>}
        </>}
      </div>
    </section>
  )
}

function SpamCard() {
  const [j, setJ] = useState<{ on: boolean; nSpam: number; nHam: number; ready: boolean } | null>(null)
  useEffect(() => { window.drive.mail.junk().then(setJ) }, [])
  if (!j) return null
  return (
    <section className="settings-card island">
      <h3><Icon name="warning" size={20} />{t('mail.spamTitle')}</h3>
      <p className="muted">{t('mail.spamHow')}</p>
      <label className="cal-switch"><input type="checkbox" checked={j.on} onChange={e => window.drive.mail.setJunk(e.target.checked).then(() => window.drive.mail.junk().then(setJ))} /><span>{t('mail.spamLocal')}</span></label>
      <p className="muted">{j.ready ? t('mail.spamReady', { spam: j.nSpam, ham: j.nHam }) : t('mail.spamLearning', { spam: j.nSpam, ham: j.nHam })}</p>
    </section>
  )
}

function PrivacyCard() {
  const [p, setP] = useState<MailPrivacy | null>(null)
  const [add, setAdd] = useState('')
  useEffect(() => { window.drive.mail.privacy().then(setP) }, [])
  if (!p) return null
  const save = (x: MailPrivacy) => window.drive.mail.setPrivacy(x).then(setP)
  return (
    <section className="settings-card island">
      <h3><Icon name="lock" size={20} />{t('mail.privacy')}</h3>
      <label className="cal-switch"><input type="checkbox" checked={p.images === 'always'} onChange={e => save({ ...p, images: e.target.checked ? 'always' : 'ask' })} />
        <span><strong>{t('mail.loadRemote')}</strong><br />{t('mail.loadRemoteHow')}</span></label>
      <h4 className="mail-filter-head">{t('mail.allowedSenders')}</h4>
      <div className="chips wrap">{p.senders.map(s => <span key={s} className="mail-addr-chip">{s}<button aria-label={t('common.remove')} onClick={() => save({ ...p, senders: p.senders.filter(x => x !== s) })}><Icon name="close" size={14} /></button></span>)}
        {!p.senders.length && <span className="muted">{t('mail.noneYet')}</span>}</div>
      <div className="mail-filter-row">
        <input className="field" value={add} placeholder="name@example.gr · @example.gr" onChange={e => setAdd(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && add.trim()) { save({ ...p, senders: [...p.senders, add.trim()] }); setAdd('') } }} />
        <button className="text-button" disabled={!add.trim()} onClick={() => { save({ ...p, senders: [...p.senders, add.trim()] }); setAdd('') }}>{t('common.add')}</button>
      </div>
      <p className="muted">{t('mail.alwaysWarned')}</p>
    </section>
  )
}
