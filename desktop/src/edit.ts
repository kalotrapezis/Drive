// Editor geometry. Everything is normalized (0–1) in the "frame": the photo after 90° rotation and straighten.
export interface Rect { x: number; y: number; w: number; h: number }
export interface Stroke { color: string; size: number; points: [number, number][] } // size: fraction of frame width
export type Turn = 'left' | 'right'

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }

export const turnPoint = ([x, y]: [number, number], t: Turn): [number, number] => t === 'right' ? [1 - y, x] : [y, 1 - x]

export function turnRect(r: Rect, t: Turn): Rect {
  return t === 'right' ? { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w } : { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w }
}

/** Scale that keeps a w×h frame fully covered after rotating the photo by `deg` (no empty corners). */
export function coverScale(w: number, h: number, deg: number): number {
  const a = Math.abs(deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h)
}

/** Keeps a crop inside the frame and at least `min` wide/high. */
export function clampRect(r: Rect, min = 0.05): Rect {
  const w = Math.min(1, Math.max(min, r.w)), h = Math.min(1, Math.max(min, r.h))
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h }
}

export const frameSize = (w: number, h: number, rotation: number) => rotation % 180 ? { w: h, h: w } : { w, h }
