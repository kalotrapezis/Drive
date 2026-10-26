import { useState } from 'react'
import { Icon, type IconName } from './Icon'
import { t } from './i18n'

/*
 * The guide (Plan.md (5b); the user, 26 Oct: "click here, choose here, allow this because this … use it while reading
 * it"): a panel beside the page, so each step is read and done on the real window at once. A step is a few words and a
 * drawn copy of that bit of Tetra (its own classes and words) with the spot to click ringed; Show me opens that page.
 * It opens by itself the first time Tetra starts here, and from Settings › Guide any time. The same chapters as the
 * phone's, less what a computer has not: permissions, Home.
 */

export type GuideGo = 'files' | 'settings' | 'sync' | null
type Pic = 'welcome' | 'settingsRow' | 'role' | 'pair' | 'client' | 'filesNav' | 'filesTick' | 'filesBar' | 'filesMore' | 'filesTrash' | 'filesSend' | 'settingsLook'
type Step = { key: string; pic: Pic; go?: GuideGo }

const CHAPTERS: { key: string; icon: IconName; steps: Step[] }[] = [
  { key: 'guide.chStart', icon: 'info', steps: [{ key: 'welcome', pic: 'welcome' }, { key: 'again', pic: 'settingsRow', go: 'settings' }] },
  { key: 'guide.chComputer', icon: 'computer', steps: [{ key: 'role', pic: 'role' }, { key: 'pair', pic: 'pair', go: 'sync' }, { key: 'client', pic: 'client', go: 'sync' }] },
  { key: 'guide.chFiles', icon: 'drive', steps: [
    { key: 'filesOpen', pic: 'filesNav', go: 'files' }, { key: 'filesTick', pic: 'filesTick', go: 'files' },
    { key: 'filesBar', pic: 'filesBar', go: 'files' }, { key: 'filesMore', pic: 'filesMore', go: 'files' },
    { key: 'filesSend', pic: 'filesSend', go: 'files' }, { key: 'filesTrash', pic: 'filesTrash', go: 'files' },
  ] },
  { key: 'guide.chSettings', icon: 'settings', steps: [{ key: 'look', pic: 'settingsLook', go: 'settings' }] },
]

/** Every step as [chapter, step], in reading order: Back and Next walk this. */
export const STEPS = CHAPTERS.flatMap((c, ci) => c.steps.map((_, si) => [ci, si] as const))

const seenKey = 'guide-seen'
/** The first time Tetra opens on this computer. */
export function guideFirstTime() { try { return !localStorage.getItem(seenKey) } catch { return false } }

export function GuidePanel({ go, onClose }: { go: (to: GuideGo) => void; onClose: () => void }) {
  const [at, setAt] = useState(0)
  const [ci, si] = STEPS[at]
  const chapter = CHAPTERS[ci], step = chapter.steps[si]
  const close = () => { try { localStorage.setItem(seenKey, '1') } catch {} onClose() }
  return (
    <aside className="guide island" aria-label={t('guide.title')}>
      <div className="guide-head">
        <select className="field" value={ci} title={t('guide.chapters')} onChange={e => setAt(STEPS.findIndex(([c]) => c === +e.target.value))}>
          {CHAPTERS.map((c, i) => <option key={c.key} value={i}>{t(c.key)}</option>)}
        </select>
        <button className="round flat" title={t('common.close')} onClick={close}><Icon name="close" /></button>
      </div>
      <small className="muted">{t('guide.stepOf', { n: si + 1, total: chapter.steps.length })}</small>
      <div className="guide-body">
        <h2>{t(`guide.${step.key}Title`)}</h2>
        <p>{t(`guide.${step.key}Body`)}</p>
        <div className="guide-pic" aria-hidden="true"><Picture pic={step.pic} /></div>
        {step.go && <button className="filled-button secondary guide-show" onClick={() => go(step.go!)}>{t('guide.showMe')}</button>}
      </div>
      <div className="guide-buttons">
        {at > 0 && <button className="filled-button secondary" onClick={() => setAt(at - 1)}>{t('common.back')}</button>}
        <button className="filled-button" onClick={() => (at + 1 < STEPS.length ? setAt(at + 1) : close())}>{at + 1 < STEPS.length ? t('guide.next') : t('guide.finish')}</button>
      </div>
    </aside>
  )
}

/** A row of Files as Files draws it: its circle, icon, name; [mark] rings one part of it. */
function FileRow({ icon, name, on, mark }: { icon: IconName; name: string; on?: boolean; mark?: 'check' | 'more' }) {
  return (
    <div className={`file ${on ? 'selected' : ''}`}>
      <span className={`file-icon`}><Icon name={icon} size={28} /></span>
      <span className={`check guide-check ${mark === 'check' ? 'guide-mark' : ''}`}><Icon name={on ? 'checked' : 'unchecked'} size={22} /></span>
      <div className="file-name"><span>{name}</span></div>
      <span className={`round flat ${mark === 'more' ? 'guide-mark' : ''}`}><Icon name="more" /></span>
    </div>
  )
}

const Nav = ({ icon, label, mark }: { icon: IconName; label: string; mark?: boolean }) =>
  <div className={`nav-item ${mark ? 'guide-mark' : ''}`}><Icon name={icon} /><span>{label}</span></div>

function Picture({ pic }: { pic: Pic }) {
  switch (pic) {
    case 'welcome': return <div className="guide-rail">
      <div className="brand"><img src="./icon.png" alt="" />Tetra</div>
      <Nav icon="photos" label={t('app.photos')} /><Nav icon="drive" label={t('app.files')} /><Nav icon="notes" label={t('app.notes')} /><Nav icon="calendar" label={t('app.calendar')} />
    </div>
    case 'settingsRow': return <div className="guide-rail">
      <Nav icon="bell" label={t('app.notifications')} /><Nav icon="settings" label={t('app.settings')} mark />
      <div className="settings-card island"><h3>{t('guide.title')}</h3><span className="filled-button secondary">{t('guide.open')}</span></div>
    </div>
    // the server in the middle, phones, tablets and the other computers round it (Plan.md (6), 26 Oct)
    case 'role': return <div className="guide-hub">
      <Icon name="device" size={32} /><Icon name="arrowRight" /><span className="guide-mark guide-hub-server"><Icon name="server" size={40} /></span><Icon name="swap" /><Icon name="computer" size={32} />
    </div>
    case 'pair': return <div className="guide-rail">
      <Nav icon="refresh" label={t('app.devices')} mark />
      <span className="filled-button secondary guide-add"><Icon name="add" size={20} /></span>
    </div>
    case 'client': return <div className="guide-rail">
      <span className="field guide-key">ABCD-EFGH-JKLM-NPQR</span>
      <span className="filled-button guide-mark guide-add"><Icon name="arrowRight" size={20} /></span>
    </div>
    case 'filesNav': return <div className="guide-rail"><Nav icon="photos" label={t('app.photos')} /><Nav icon="drive" label={t('app.files')} mark /><Nav icon="notes" label={t('app.notes')} /></div>
    case 'filesTick': return <div className="file-list">
      <FileRow icon="folderDocuments" name="Documents" /><FileRow icon="fileDoc" name="Report.docx" on mark="check" /><FileRow icon="fileSheet" name="Budget.xlsx" />
    </div>
    case 'filesBar': return <div className="island selection-bar">
      <span className="round flat"><Icon name="close" /></span><strong>{t('photos.selected', { count: 1 })}</strong>
      <span className="round flat guide-mark"><Icon name="copy" /></span><span className="round flat guide-mark"><Icon name="moveTo" /></span>
    </div>
    case 'filesMore': return <div className="file-list"><FileRow icon="fileDoc" name="Report.docx" mark="more" /></div>
    case 'filesSend': return <div className="island selection-bar">
      <strong>{t('photos.selected', { count: 1 })}</strong>
      <span className="round flat"><Icon name="copy" /></span><span className="round flat"><Icon name="moveTo" /></span>
      <span className="round flat guide-mark"><Icon name="device" /></span>
    </div>
    case 'filesTrash': return <nav className="notes-island island">
      <span className="island-item on"><Icon name="drive" size={20} /><span>{t('files.drive')}</span></span>
      <span className="island-item"><Icon name="heart" size={20} /></span>
      <span className="island-item guide-mark"><Icon name="trash" size={20} /><span>{t('photos.trash')}</span></span>
    </nav>
    case 'settingsLook': return <div className="settings-card island">
      <h3>{t('settings.appearance')}</h3>
      <div className="segmented guide-mark"><button tabIndex={-1} className="on">{t('settings.themeAuto')}</button><button tabIndex={-1}>{t('settings.themeLight')}</button><button tabIndex={-1}>{t('settings.themeDark')}</button></div>
      <h3>{t('settings.language')}</h3>
    </div>
  }
}
