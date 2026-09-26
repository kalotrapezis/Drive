/// <reference types="vite/client" />
import type { Media } from './timeline'

export interface DriveItem {
  name: string; path: string; dir: boolean; size: number; mtime: number; type: string
  favorite: boolean; color: string | null; tags: string[]; openedAt?: number
}

/** A folder under the Photos root; included null = never asked. */
export interface DeviceFolder { name: string; count: number; samples: string[]; included: boolean | null }
export interface Person { id: string; name: string; count: number; cover: string | null }
export interface Review { faceId: string; personId: string; sha256: string; name: string; personFace: string | null }
export interface Analysis { running: boolean; paused: boolean; done: number; total: number; error: string; enabled?: boolean; documentsEnabled?: boolean; reviews?: number }
export interface MergeUndo { sourceId: string; faceIds: string[] }

export interface VaultStatus { configured: boolean; unlocked: boolean; count: number }
export interface VaultItem { id: string; sha256: string; name: string; rel_path: string; mime: string; is_video: number; size: number; taken_at: number; has_thumb: number }

export interface PersonFace { id: string; sha256: string; quality: number; chosen: boolean; takenAt: number }
export interface SyncConnection { content: 'photos' | 'files'; direction: 'off' | 'send' | 'receive' | 'both'; keep: 'everything' | 'nothing'; keepDays?: number; keepFavorites?: boolean }
export interface MovePreview { holds: number; onPc: number; go: number; goBytes: number; keep: number; notOnPc: number; lastSeen: number | null }
export interface DriveRules { role: 'backup' | 'storage'; offload: boolean; percent: number; keep: number; unit: 'day' | 'week' | 'month' | 'year'; copies: number; favorites: boolean; screenshots: boolean }
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
      onNotesChanged(cb: () => void): () => void
      files: {
        root(): Promise<string>
        call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
        open(rel: string): Promise<void>
        reveal(rel: string): Promise<void>
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
