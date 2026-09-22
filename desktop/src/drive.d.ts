/// <reference types="vite/client" />
import type { Media } from './timeline'

declare global {
  interface Window {
    drive: {
      info(): Promise<{ photosRoot: string }>
      list(): Promise<Media[]>
      scan(): Promise<{ total: number; changed: number; removed: number }>
      show(id: number): Promise<void>
      onScanProgress(fn: (p: { done: number; changed: number }) => void): () => void
    }
  }
}
