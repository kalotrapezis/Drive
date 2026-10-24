/// <reference types="vite/client" />
import type { Media } from './timeline'

/** Maps (maps.js): the phone's files in Files/Maps. */
export interface MapPlace { id: string; name: string; lat: number; lng: number; icon: string; slot: number; mode: 'car' | 'foot' | 'bike'; lists: string[]; label: string }
export interface MapList { id: string; name: string; emoji: string }
export interface MapStop { name: string; lat: number; lng: number }
export interface MapTrip { id: string; name: string; stops: MapStop[] }
export interface Poi { kind: string; lat: number; lng: number; name: string; nameEn: string; more: string; hours: string; phone: string; web: string; wheelchair: string; note: string }

export interface DriveItem {
  name: string; path: string; dir: boolean; size: number; mtime: number; type: string; system: boolean
  favorite: boolean; color: string | null; tags: string[]; openedAt?: number
  /** Which thumbnail Files shows (thumbs.js); null: its icon. */
  thumb?: 'picture' | 'video' | null
  /** Its category's icon (file-kinds.json), public/kinds/<icon>.png; null: the type's own. */
  icon?: string | null
}

/** A folder under the Photos root; included null = never asked. */
export interface DeviceFolder { name: string; count: number; samples: string[]; included: boolean | null }
export interface Person { id: string; name: string; count: number; cover: string | null }
export interface Review { faceId: string; personId: string; sha256: string; name: string; personFace: string | null }
export interface Analysis { running: boolean; paused: boolean; done: number; total: number; error: string; enabled?: boolean; documentsEnabled?: boolean; reviews?: number }
export interface MergeUndo { sourceId: string; faceIds: string[] }
export type TimerAction = 'pause' | 'resume' | 'stop' | 'ok' | 'restart' | 'pin' | 'unpin' | 'trash'
/** A timer as the computer counts it (timer.js active()). */
export interface TimerItem { id: string; seconds: number; label: string; state: 'running' | 'paused' | 'stopped'; ends: number | null; left: number; rev: number; by: string; pinned: boolean; leftMs: number; ringing: boolean; ready: boolean }

export interface VaultStatus { configured: boolean; unlocked: boolean; count: number }
export interface VaultItem { id: string; sha256: string; name: string; rel_path: string; mime: string; is_video: number; size: number; taken_at: number; has_thumb: number }

export interface PersonFace { id: string; sha256: string; quality: number; chosen: boolean; takenAt: number }
export interface SyncConnection { content: 'photos' | 'files'; direction: 'off' | 'send' | 'receive' | 'both'; keep: 'everything' | 'nothing'; keepDays?: number; keepFavorites?: boolean }
export interface MovePreview { holds: number; onPc: number; go: number; goBytes: number; keep: number; notOnPc: number; lastSeen: number | null }
export interface DriveRules { role: 'backup' | 'storage'; offload: boolean; percent: number; keep: number; unit: 'day' | 'week' | 'month' | 'year'; copies: number; favorites: boolean; screenshots: boolean; auto: boolean }
export interface OffloadPlan { deviceId: string; name: string; rules: DriveRules; disk: Disk | null; count: number; bytes: number; oldest: number | null; newest: number | null; short?: number }
export interface Disk { size: number; free: number; percent: number }
export interface HistoryRow { id: number; at: number; device: string | null; deviceName: string | null; action: string; kind: string | null; name: string | null; sha256: string | null; size: number | null; detail: string | null }
export interface PurgatorySettings { trashDays: number; purgatoryDays: number; location?: string; summary?: { driveId: string; items: number; bytes: number; oldest: number | null }[] }
export interface SyncDevice { id: string; name: string; kind: string | null; volume_uuid: string | null; rules: DriveRules | null; set_up_at: number | null; paired_at: number; last_seen: number | null; received: number; filesReceived: number; holdsPhotos: number; holdsFiles: number | null; connections: SyncConnection[] }
export interface SyncOverview {
  here: { files: number; bytes: number }
  stored?: { name: string; files: number }[]
  /** Every file known anywhere — this computer's library and everything a device says it holds. */
  known: number
  /** One row per number of machines holding it, this computer included; `here` is how many of those are here. */
  copies: { copies: number; files: number; bytes: number; here: number }[]
  devices: { id: string; name: string; last_seen: number | null; holds: number; alsoHere: number; onlyThere: number; freeable: number }[]
  kinds: { kind: string; files: number; bytes: number }[]
  /** Receipts whose file is no longer on disk: this computer promised to hold these and does not. */
  staleReceipts: number
}
export interface SyncFile { name: string | null; size: number | null; isVideo: number | null; takenAt: number | null; sha256: string; device: string | null; here: number }
export interface SyncSelf { kind: string; name: string; label: string }
export interface Drive { uuid: string; label: string; fstype: string; mount: string; sizeBytes: number; freeBytes: number; hotplug: boolean; device: { id: string; name: string } | null }
export interface DriveScan {
  plugged: boolean; mount?: string; label?: string; fstype?: string; free?: number; size?: number
  total?: number; have?: number; haveBytes?: number; need?: number; needBytes?: number; writable?: boolean; enough?: boolean
  files?: { total: number; have: number; need: number; needBytes: number }
}
export interface SyncStatus { port: number; fingerprint: string; error: string | null; addresses: string[]; devices: SyncDevice[]; overview: SyncOverview; self: SyncSelf; disk: Disk | null; counts: { photos: number; files: number } }

export interface TrashedPhoto { id: string; name: string; path: string; size: number; deletedAt: number }
export interface Collection { id: string; name: string; count: number; cover: string | null; hidden: boolean; folder?: boolean; drive?: boolean }
export interface AppNotification { id: number; at: number; title: string; body: string | null; read: number }
export interface PhotoPlace { path: string; name: string; count: number }

declare global {
  interface Window {
    drive: {
      info(): Promise<{ photosRoot: string }>
      list(): Promise<Media[]>
      folders: {
        list(): Promise<DeviceFolder[]>
        set(name: string, included: boolean): Promise<void>
      }
      scan(): Promise<{ total: number; changed: number; removed: number }>
      show(id: number): Promise<void>
      openMap(lat: number, lon: number): Promise<void>
      editorLoad(id: number): Promise<Uint8Array>
      editorSave(id: number, bytes: Uint8Array, mode: 'copy' | 'replace'): Promise<string>
      /** 'eyes': each face's two eyes (0–1) and the decode's size; 'text': the photo's text and its words' boxes (0–1). */
      photoAsk(id: number, what: 'eyes'): Promise<{ eyes: [{ x: number; y: number }, { x: number; y: number }][]; width: number; height: number }>
      photoAsk(id: number, what: 'text'): Promise<{ text: string; words: { x: number; y: number; w: number; h: number }[] }>
      onScanProgress(fn: (p: { done: number; changed: number }) => void): () => void
      favorite(shas: string[], on: boolean): Promise<void>
      trash(ids: number[]): Promise<{ trashed: number; failed: string[] }>
      places(): Promise<PhotoPlace[]>
      moveTo(ids: number[], dest: string): Promise<{ moved: number; failed: string[] }>
      collections(): Promise<Collection[]>
      createCollection(name: string): Promise<Collection>
      deleteCollection(id: string): Promise<void>
      setCollectionHidden(id: string, hidden: boolean): Promise<void>
      trashList(): Promise<TrashedPhoto[]>
      trashRestore(ids: string[]): Promise<{ restored: string[]; failed: string[] }>
      trashEmpty(): Promise<number>
      viewSettings(): Promise<{ hideScreenshots: boolean; hideDocuments: boolean }>
      setViewSetting(key: 'hideScreenshots' | 'hideDocuments', on: boolean): Promise<void>
      members(id: string): Promise<string[]>
      setMembership(id: string, shas: string[], member: boolean): Promise<void>
      deleteFromDrive(driveId: string, shas: string[]): Promise<{ deleted: number; failed: string[] }>
      vault: {
        status(): Promise<VaultStatus>
        setup(pass: string): Promise<void>
        unlock(pass: string): Promise<void>
        lock(): Promise<void>
        list(): Promise<VaultItem[]>
        hide(ids: number[]): Promise<{ hidden: number; failed: string[] }>
        restore(ids: string[]): Promise<string[]>
      }
      history(options?: { limit?: number; before?: number }): Promise<HistoryRow[]>
      purgatory: { settings(): Promise<PurgatorySettings>; set(changes: Partial<PurgatorySettings>): Promise<PurgatorySettings>; setLocation(driveId: string | null): Promise<{ moved: number; waiting: number; failed: string[] }> }
      sync: {
        status(): Promise<SyncStatus>
        pair(): Promise<{ payload: { hosts: string[]; port: number }; qr: string }>
        forget(id: string): Promise<void>
        files(what: 'onlyThere' | 'alone' | 'largest', options?: { deviceId?: string; limit?: number }): Promise<SyncFile[]>
        setDevice(id: string, changes: { name?: string; kind?: string }): Promise<SyncDevice | null>
        setSelf(changes: { name?: string; kind?: string }): Promise<SyncSelf>
        completeSetup(id: string): Promise<SyncDevice | null>
        drives(): Promise<Drive[]>
        inspectDrive(uuid: string): Promise<DriveScan>
        addDrive(drive: { uuid: string; label: string }): Promise<SyncDevice>
        backUpToDrive(id: string): Promise<{ copied: number; already: number; failed: string[]; total: number }>
        onDriveProgress(fn: (p: { done: number; total: number; copied: number; already: number }) => void): () => void
        setConnection(id: string, content: string, rules: { direction: string; keep: string; keepDays?: number; keepFavorites?: boolean }): Promise<SyncConnection>
        movePreview(id: string, options: { keepDays: number; keepFavorites: boolean; content?: string }): Promise<MovePreview>
        setDriveRules(id: string, rules: Partial<DriveRules>): Promise<DriveRules>
        offloadPlan(id: string): Promise<OffloadPlan>
        moveToDrive(id: string, options?: { limit?: number }): Promise<{ moved: number; bytes: number; failed: string[]; total: number }>
        onMoveProgress(fn: (p: { done: number; total: number; moved: number }) => void): () => void
        onOffer(fn: (deviceId: string) => void): () => void
        onReceived(fn: () => void): () => void
      }
      documents: {
        start(): Promise<void>
        rescan(): Promise<void>
        nextReview(): Promise<{ sha256: string } | null>
        answer(sha: string, answer: 'yes' | 'no' | 'skip'): Promise<void>
        set(sha: string, isDocument: boolean): Promise<void>
      }
      people: {
        status(): Promise<Analysis>
        start(): Promise<void>
        rescan(): Promise<void>
        pause(): Promise<void>
        list(): Promise<Person[]>
        forgotten(): Promise<Person[]>
        setHidden(id: string, hidden: boolean): Promise<void>
        shas(id: string): Promise<string[]>
        names(): Promise<Record<string, string[]>>
        rename(id: string, name: string): Promise<string>
        faces(id: string): Promise<PersonFace[]>
        setCover(id: string, faceId: string | null): Promise<void>
        merge(source: string, target: string): Promise<MergeUndo>
        detach(id: string, shas: string[]): Promise<{ person: string; faces: number }>
        undoMerge(undo: MergeUndo): Promise<void>
        mergeHistory(id?: string): Promise<PersonMerge[]>
        restoreMerge(id: number): Promise<void>
        nextReview(): Promise<Review | null>
        answer(faceId: string, personId: string, answer: 'yes' | 'no' | 'skip'): Promise<void>
        onProgress(fn: (a: Analysis) => void): () => void
      }
      notes<T = unknown>(method: string, ...args: unknown[]): Promise<T>
      calendar<T = unknown>(method: string, ...args: unknown[]): Promise<T>
      calendarRefresh(): Promise<number>
      contacts<T = unknown>(method: string, ...args: unknown[]): Promise<T>
      contactsPickImport(): Promise<{ added: number; same: number } | null>
      contactsExport(uids: string[] | null, name: string): Promise<string | null>
      contactsOpen(how: 'mail' | 'whatsapp' | 'viber' | 'web', value: string): Promise<void>
      contactsSettings(): Promise<{ birthdays: string | null; calendars: { id: string; name: string; color: string }[]; byLast: boolean }>
      contactsSetBirthdays(id: string): Promise<void>
      contactsCall(number: string, name: string): Promise<{ how?: 'calling' | 'notification'; device?: string; error?: string }>
      phoneHistory(): Promise<{ at: string; number: string; dir: 'in' | 'out' | 'missed' | 'declined' | 'blocked' | 'voicemail'; secs: number; contact?: string; name?: string; note?: string }[]>
      phoneRecordings(): Promise<{ name: string; size: number; at: number }[]>
      phoneOpenRecording(name: string): Promise<string>
      contactsFacePhoto(faceId: string): Promise<{ photo: string; face: string }>
      callsBluetooth(): Promise<{ available: boolean; phones: { mac: string; name: string; connected: boolean }[]; sound: string }>
      callsConnect(mac: string): Promise<unknown>
      callsSystemBluetooth(): Promise<boolean>
      contactsSetByLast(on: boolean): Promise<void>
      onContactsChanged(cb: () => void): () => void
      calendarPickImport(): Promise<{ index: number; name: string; color: string | null; count: number }[] | null>
      calendarImport(choices: { index: number; into: string }[]): Promise<{ added: number; updated: number }>
      calendarExport(id: string | null): Promise<string | null>
      calendarSettings(): Promise<{ reminders: boolean; autostart: boolean }>
      skillSave(name: 'tetra-calendar' | 'tetra-timer'): Promise<string | null>
      skillInstall(name: 'tetra-calendar' | 'tetra-timer'): Promise<string>
      calendarSetReminders(on: boolean): Promise<void>
      calendarSetAutostart(on: boolean): Promise<void>
      onCalendarChanged(cb: () => void): () => void
      timer: {
        active(): Promise<TimerItem[]>
        start(seconds: number): Promise<string>
        change(id: string, action: TimerAction): Promise<void>
        last(): Promise<number>
      }
      onTimerChanged(cb: () => void): () => void
      mapsInfo(): Promise<{ root: string; map: { bytes: number; at: number } | null }>
      mapsPlaces(): Promise<MapPlace[]>
      mapsLists(): Promise<MapList[]>
      mapsTrips(): Promise<MapTrip[]>
      mapsSavePlace(p: Partial<MapPlace> & { name: string; lat: number; lng: number }): Promise<MapPlace>
      mapsDeletePlace(id: string): Promise<void>
      mapsSaveList(l: Partial<MapList> & { name: string }): Promise<MapList>
      mapsDeleteList(id: string): Promise<void>
      mapsSaveTrip(t: { id?: string; name: string; stops: MapStop[] }): Promise<MapTrip>
      mapsDeleteTrip(id: string): Promise<void>
      mapsSearch(q: { query?: string; kind?: string | null; lat: number; lng: number; limit?: number; nearby?: boolean; within?: { south: number; north: number; west: number; east: number } | null }): Promise<Poi[]>
      mapsDescribe(lat: number, lng: number, road?: string | null): Promise<string | null>
      mapsNear(lat: number, lng: number, name: string): Promise<Poi | null>
      mapsGoogle(query: string): Promise<void>
      mapsWeb(url: string): Promise<void>
      /** Directions on this computer (router.js): the line, metres, seconds and turns from the first point through the others. */
      mapsRoute(points: { lat: number; lng: number }[], mode: 'car' | 'foot' | 'bike' | 'wheelchair'): Promise<{ metres: number; seconds: number; line: [number, number][]; steps: { text: string; metres: number; seconds: number; sign: number }[] }>
      mapsPhoneLocation(): Promise<{ lat: number; lng: number; accuracy: number; at: number; provider: string; device: string; error?: undefined } | { error: string }>
      onMapsChanged(cb: () => void): () => void
      onNotesChanged(cb: () => void): () => void
      notesSynced(): Promise<{ at: number; device: string } | null>
      notifications: { list(): Promise<AppNotification[]>; read(): Promise<void>; clear(): Promise<void>; onChange(cb: () => void): () => void }
      imports: {
        pick(folders: boolean): Promise<string[]>
        drives(): Promise<{ id: string; name: string; free: number }[]>
        run(kind: 'photos' | 'files', sources: string[], driveId: string | null, move: boolean): Promise<{ imported: number; skipped: number; failed: string[]; total: number; stopped?: boolean }>
        cancel(): Promise<void>
        onProgress(cb: (p: { done: number; total: number; imported: number; skipped: number }) => void): () => void
      }
      theme(): Promise<'system' | 'light' | 'dark'>
      setTheme(t: 'system' | 'light' | 'dark'): Promise<void>
      motionSetting(): Promise<'one' | 'remove'>
      setMotionSetting(v: 'one' | 'remove'): Promise<void>
      hasMotion(id: number): Promise<boolean>
      motionAutoplay(): Promise<boolean>
      setMotionAutoplay(on: boolean): Promise<void>
      onNotesSynced(cb: (s: { at: number; device: string }) => void): () => void
      files: {
        root(): Promise<string>
        call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
        open(rel: string): Promise<void>
        reveal(rel: string): Promise<void>
        sendToPhone(rels: string[]): Promise<{ sent?: number; device?: string; error?: string }>
        onOpenFolder(fn: (folder: string) => void): () => void
      }
    }
  }
}

export interface PersonMerge {
  id: number
  sourceId: string
  name: string
  count: number
  mergedAt: number
  cover: string | null
}
