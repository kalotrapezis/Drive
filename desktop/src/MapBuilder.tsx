import { useEffect, useMemo, useState } from 'react'
import type { MapBuildProgress, MapPack, MapRegion } from './drive'
import { Confirm, Modal, errorText } from './Dialogs'
import { Icon } from './Icon'
import { locale, t } from './i18n'

/**
 * Settings › Maps (Drive-Android Plan.md § Maps; the user, 27 Oct: "a map builder that downloads the map, does the roads
 * stuff and installs it in the app and then uploads to the android devices. A step by step process with the first page
 * being how great Libre Maps are and if they can to offer donation to them"): the maps here, each with Update and Remove,
 * and Add a map, which walks through the builder (mapbuild.js). Sync carries a new map to the phone and tablet.
 */

const STEPS = ['tools', 'map', 'osm', 'roads', 'search', 'install'] as const
/** The free projects the maps are made of, with where to give (the welcome page). */
const CREDITS = [
  { name: 'OpenStreetMap', key: 'osm', url: 'https://donate.openstreetmap.org/', give: true },
  { name: 'Protomaps', key: 'protomaps', url: 'https://github.com/sponsors/bdon', give: true },
  { name: 'MapLibre', key: 'maplibre', url: 'https://opencollective.com/maplibre', give: true },
  { name: 'GraphHopper', key: 'graphhopper', url: 'https://www.graphhopper.com/', give: false },
  { name: 'Geofabrik', key: 'geofabrik', url: 'https://www.geofabrik.de/', give: false },
]

const size = (b: number) => b >= 1e9 ? `${(b / 1e9).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`

type Page = 'welcome' | 'choose' | 'needs' | 'build' | 'done' | 'error'

export function MapsCard() {
  const [packs, setPacks] = useState<MapPack[] | null>(null)
  const [progress, setProgress] = useState<MapBuildProgress | null>(null)
  const [wizard, setWizard] = useState<Page | null>(null)
  const [removing, setRemoving] = useState<MapPack | null>(null)
  const load = () => window.drive.mapsPacks().then(setPacks, () => setPacks([]))
  useEffect(() => {
    load()
    window.drive.mapsBuilding().then(id => { if (id) setProgress({ id, step: null, state: 'running' }) })
    const off = window.drive.onMapsBuild(p => {
      setProgress(p)
      if (p.state === 'needs') setWizard('needs')
      if (p.state === 'done') { load(); setWizard(w => w && 'done') }
      if (p.state === 'error') setWizard(w => w && 'error')
    })
    return off
  }, [])
  useEffect(() => window.drive.onMapsChanged(load), [])
  const busy = progress?.state === 'running'
  const update = (id: string) => { setProgress({ id, step: null, state: 'running' }); setWizard('build'); window.drive.mapsBuild(id) }
  return (
    <section className="settings-card island">
      <h3><Icon name="map" size={20} />{t('mapbuild.title')}</h3>
      <p className="muted">{t('mapbuild.note')}</p>
      {packs?.length === 0 && <p>{t('mapbuild.none')}</p>}
      {packs?.map(p => <div key={p.id} className="map-pack">
        <div><strong>{p.name}</strong><small className="muted">{t('mapbuild.built', { size: size(p.bytes), date: new Date(p.built).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) })}</small></div>
        <button className="text-button" disabled={busy} onClick={() => update(p.region)}>{t('mapbuild.update')}</button>
        <button className="text-button" disabled={busy} onClick={() => setRemoving(p)}>{t('mapbuild.remove')}</button>
      </div>)}
      {busy && <p className="muted">{t('mapbuild.making', { name: progress.id, step: progress.step ? t(`mapbuild.step.${progress.step}`) : '…' })}</p>}
      <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
        {busy ? <button className="filled-button secondary" onClick={() => setWizard('build')}>{t('mapbuild.show')}</button>
          : <button className="filled-button" onClick={() => setWizard('welcome')}>{t('mapbuild.add')}</button>}
      </div>
      {wizard && <Wizard page={wizard} setPage={setWizard} progress={progress} start={update} onClose={() => setWizard(null)} />}
      {removing && <Confirm title={t('mapbuild.removeTitle', { name: removing.name })} body={t('mapbuild.removeBody')} action={t('mapbuild.remove')} danger
        onConfirm={() => window.drive.mapsRemovePack(removing.id).then(load)} onClose={() => setRemoving(null)} />}
    </section>
  )
}

function Wizard({ page, setPage, progress, start, onClose }:
  { page: Page; setPage: (p: Page) => void; progress: MapBuildProgress | null; start: (id: string) => void; onClose: () => void }) {
  const [regions, setRegions] = useState<MapRegion[] | null>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<MapRegion | null>(null)
  const [needs, setNeeds] = useState<Awaited<ReturnType<typeof window.drive.mapsNeeds>> | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [said, setSaid] = useState('')
  const [installing, setInstalling] = useState(false)
  useEffect(() => { if (page === 'choose' && !regions) window.drive.mapsRegions().then(setRegions, e => setSaid(errorText(e))) }, [page, regions])
  useEffect(() => { if (page === 'needs' && progress?.packages) setMissing(progress.packages) }, [page, progress])
  const names = useMemo(() => new Map(regions?.map(r => [r.id, r.name])), [regions])
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return (regions ?? []).filter(r => r.parent && (!q || r.name.toLocaleLowerCase().includes(q) || (names.get(r.parent) ?? '').toLocaleLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
  }, [regions, query, names])
  const choose = (r: MapRegion) => { setChosen(r); setNeeds(null); window.drive.mapsNeeds(r.id).then(setNeeds, e => setSaid(errorText(e))) }
  const tooBig = needs ? needs.memory > needs.hasMemory * 0.6 : false
  const noRoom = needs ? needs.disk > needs.hasDisk : false
  const parts = chosen ? (regions ?? []).filter(r => r.parent === chosen.id) : []
  const make = async () => {
    const m = await window.drive.mapsMissing()
    if (m.length) { setMissing(m); setPage('needs') } else start(chosen!.id)
  }
  const install = async () => {
    setSaid(''); setInstalling(true)
    try {
      if (await window.drive.mapsInstallSystem(missing) === 'refused') setSaid(t('mapbuild.refused'))
      else if (chosen || progress?.id) start(chosen?.id ?? progress!.id)
    } catch (e) { setSaid(t('mapbuild.noApt', { packages: errorText(e) })) }
    setInstalling(false)
  }
  const name = chosen?.name ?? progress?.id ?? ''
  return (
    <Modal onClose={onClose}>
      <div className="map-wizard">
        {page === 'welcome' && <>
          <h3>{t('mapbuild.welcomeTitle')}</h3>
          <p>{t('mapbuild.welcomeBody')}</p>
          {CREDITS.map(c => <div key={c.key} className="map-credit">
            <div><strong>{c.name}</strong><small className="muted">{t(`mapbuild.credit.${c.key}`)}</small></div>
            <button className={c.give ? 'filled-button secondary' : 'text-button'} onClick={() => window.drive.mapsWeb(c.url)}>
              {c.give && <Icon name="heart" size={16} />} {t(c.give ? 'mapbuild.donate' : 'mapbuild.website')}</button>
          </div>)}
          <p className="muted">{t('mapbuild.donateNote')}</p>
          <div className="dialog-actions">
            <button className="text-button" onClick={onClose}>{t('common.cancel')}</button>
            <button className="filled-button" autoFocus onClick={() => setPage('choose')}>{t('mapbuild.next')}</button>
          </div>
        </>}
        {page === 'choose' && <>
          <h3>{t('mapbuild.chooseTitle')}</h3>
          <input className="field" autoFocus placeholder={t('mapbuild.search')} value={query} onChange={e => setQuery(e.target.value)} />
          <div className="map-regions">
            {!regions && !said && <p className="muted">…</p>}
            {shown.map(r => <button key={r.id} className={chosen?.id === r.id ? 'on' : ''} onClick={() => choose(r)}>
              {r.name} <small className="muted">{names.get(r.parent!)}</small></button>)}
          </div>
          {chosen && needs && <div className="map-needs">
            <p>{t('mapbuild.download', { size: size(needs.osm) })} · {t('mapbuild.memory', { need: size(needs.memory), has: size(needs.hasMemory) })}</p>
            {tooBig && <p className="error">{t('mapbuild.tooBig')}</p>}
            {tooBig && <div className="map-parts">{parts.map(r => <button key={r.id} className="text-button" onClick={() => choose(r)}>{r.name}</button>)}</div>}
            {noRoom && <p className="error">{t('mapbuild.noRoom', { need: size(needs.disk), has: size(needs.hasDisk) })}</p>}
          </div>}
          {said && <p className="error">{said}</p>}
          <div className="dialog-actions">
            <button className="text-button" onClick={() => setPage('welcome')}>{t('mapbuild.back')}</button>
            <button className="filled-button" disabled={!chosen || !needs || tooBig || noRoom} onClick={make}>{t('mapbuild.make')}</button>
          </div>
        </>}
        {page === 'needs' && <>
          <h3>{t('mapbuild.needsTitle')}</h3>
          <p>{t('mapbuild.needsBody')}</p>
          <ul>{missing.map(p => <li key={p}><strong>{p}</strong> — {t(`mapbuild.pkg.${p.startsWith('openjdk') ? 'java' : 'osmium'}`)}</li>)}</ul>
          <p className="muted">{t('mapbuild.passwordNote')}</p>
          {said && <p className="error">{said}</p>}
          <div className="dialog-actions">
            <button className="text-button" onClick={onClose}>{t('mapbuild.dontWant')}</button>
            <button className="filled-button" autoFocus disabled={installing} onClick={install}>{t('mapbuild.install')}</button>
          </div>
        </>}
        {page === 'build' && <>
          <h3>{t('mapbuild.buildTitle', { name })}</h3>
          <ol className="map-steps">
            {[...STEPS, 'send' as const].map((s, i) => {
              const at = progress?.step ? STEPS.indexOf(progress.step) : -1
              const state = progress?.state === 'done' || i < at ? 'done' : i === at ? 'now' : ''
              return <li key={s} className={state}>
                <Icon name={state === 'done' ? 'checked' : 'unchecked'} size={18} />
                <span>{t(`mapbuild.step.${s}`)}{state === 'now' && progress?.total ? ` · ${size(progress.done ?? 0)} / ${size(progress.total)}` : ''}</span>
              </li>
            })}
          </ol>
          {progress?.state === 'running' && progress.total ? <progress max={progress.total} value={progress.done ?? 0} /> : null}
          <p className="muted">{t('mapbuild.buildNote')}</p>
          <div className="dialog-actions">
            <button className="text-button" onClick={() => { window.drive.mapsCancelBuild(); onClose() }}>{t('mapbuild.stop')}</button>
            <button className="filled-button secondary" onClick={onClose}>{t('mapbuild.hide')}</button>
          </div>
        </>}
        {page === 'done' && <>
          <h3>{t('mapbuild.doneTitle', { name })}</h3>
          <p>{t('mapbuild.doneBody')}</p>
          <div className="dialog-actions"><button className="filled-button" autoFocus onClick={onClose}>{t('mapbuild.close')}</button></div>
        </>}
        {page === 'error' && <>
          <h3>{t('mapbuild.buildTitle', { name })}</h3>
          <p className="error">{t('mapbuild.failed', { error: progress?.error ?? '' })}</p>
          <div className="dialog-actions">
            <button className="text-button" onClick={onClose}>{t('common.cancel')}</button>
            {progress?.id && <button className="filled-button" onClick={() => start(progress.id)}>{t('mapbuild.tryAgain')}</button>}
          </div>
        </>}
      </div>
    </Modal>
  )
}
