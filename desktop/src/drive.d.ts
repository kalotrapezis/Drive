/// <reference types="vite/client" />
import type { Media } from './timeline'

export interface DriveItem {
  name: string; path: string; dir: boolean; size: number; mtime: number; type: string
  favorite: boolean; color: string | null; tags: string[]; openedAt?: number
}

export interface Person { id: string; name: string; count: number; cover: string | null }
export interface Review { faceId: string; personId: string; sha256: string; name: string; personFace: string | null }
export interface Analysis { running: boolean; paused: boolean; done: number; total: number; error: string; enabled?: boolean; documentsEnabled?: boolean; reviews?: number }
export interface MergeUndo { sourceId: string; faceIds: string[] }

export interface VaultStatus { configured: boolean; unlocked: boolean; count: number }
export interface VaultItem { id: string; sha256: string; name: string; rel_path: string; mime: string; is_video: number; size: number; taken_at: number; has_thumb: number }

export interface SyncDevice { id: string; name: string; paired_at: number; last_seen: number | null; received: number; filesReceived: number }
export interface SyncStatus { port: number; fingerprint: string; error: string | null; addresses: string[]; devices: SyncDevice[] }

export interface Collection { id: string; name: string; count: number; cover: string | null; hidden: boolean }

declare global {
  interface Window {
    drive: {
      info(): Promise<{ photosRoot: string }>
      list(): Promise<Media[]>
      scan(): Promise<{ total: number; changed: number; removed: number }>
      show(id: number): Promise<void>
      openMap(lat: number, lon: number): Promise<void>
      editorLoad(id: number): Promise<Uint8Array>
      editorSave(id: number, bytes: Uint8Array, mode: 'copy' | 'replace'): Promise<string>
      onScanProgress(fn: (p: { done: number; changed: number }) => void): () => void
      favorite(shas: string[], on: boolean): Promise<void>
      trash(ids: number[]): Promise<{ trashed: number; failed: string[] }>
      collections(): Promise<Collection[]>
      createCollection(name: string): Promise<Collection>
      deleteCollection(id: string): Promise<void>
      setCollectionHidden(id: string, hidden: boolean): Promise<void>
      viewSettings(): Promise<{ hideScreenshots: boolean; hideDocuments: boolean }>
      setViewSetting(key: 'hideScreenshots' | 'hideDocuments', on: boolean): Promise<void>
      members(id: string): Promise<string[]>
      setMembership(id: string, shas: string[], member: boolean): Promise<void>
      vault: {
        status(): Promise<VaultStatus>
        setup(pass: string): Promise<void>
        unlock(pass: string): Promise<void>
        lock(): Promise<void>
        list(): Promise<VaultItem[]>
        hide(ids: number[]): Promise<{ hidden: number; failed: string[] }>
        restore(ids: string[]): Promise<string[]>
      }
      sync: {
        status(): Promise<SyncStatus>
        pair(): Promise<{ payload: { hosts: string[]; port: number }; qr: string }>
        forget(id: string): Promise<void>
        onReceived(fn: () => void): () => void
      }
      documents: {
        start(): Promise<void>
        nextReview(): Promise<{ sha256: string } | null>
        answer(sha: string, answer: 'yes' | 'no' | 'skip'): Promise<void>
        set(sha: string, isDocument: boolean): Promise<void>
      }
      people: {
        status(): Promise<Analysis>
        start(): Promise<void>
        pause(): Promise<void>
        list(): Promise<Person[]>
        shas(id: string): Promise<string[]>
        names(): Promise<Record<string, string[]>>
        rename(id: string, name: string): Promise<string>
        merge(source: string, target: string): Promise<MergeUndo>
        undoMerge(undo: MergeUndo): Promise<void>
        nextReview(): Promise<Review | null>
        answer(faceId: string, personId: string, answer: 'yes' | 'no' | 'skip'): Promise<void>
        onProgress(fn: (a: Analysis) => void): () => void
      }
      files: {
        root(): Promise<string>
        call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
        open(rel: string): Promise<void>
        reveal(rel: string): Promise<void>
      }
    }
  }
}
