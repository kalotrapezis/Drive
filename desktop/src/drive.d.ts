/// <reference types="vite/client" />
import type { Media } from './timeline'

export interface DriveItem {
  name: string; path: string; dir: boolean; size: number; mtime: number; type: string
  favorite: boolean; color: string | null; tags: string[]; openedAt?: number
}

export interface Collection { id: string; name: string; count: number; cover: string | null }

declare global {
  interface Window {
    drive: {
      info(): Promise<{ photosRoot: string }>
      list(): Promise<Media[]>
      scan(): Promise<{ total: number; changed: number; removed: number }>
      show(id: number): Promise<void>
      onScanProgress(fn: (p: { done: number; changed: number }) => void): () => void
      favorite(shas: string[], on: boolean): Promise<void>
      trash(ids: number[]): Promise<{ trashed: number; failed: string[] }>
      collections(): Promise<Collection[]>
      createCollection(name: string): Promise<Collection>
      deleteCollection(id: string): Promise<void>
      members(id: string): Promise<string[]>
      setMembership(id: string, shas: string[], member: boolean): Promise<void>
      files: {
        root(): Promise<string>
        call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
        open(rel: string): Promise<void>
        reveal(rel: string): Promise<void>
      }
    }
  }
}
