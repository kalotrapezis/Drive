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

/**
 * A hidden part of the photo — a black bar, or stars over eyes — 0–1 across the upright photo before any turn or crop,
 * so it turns and crops with it (phone: PhotoCover). `eye` marks the ones Find eyes made, redrawn when the style changes.
 */
export interface Cover extends Rect { stars: boolean; eye?: boolean }
export type Eyes = [{ x: number; y: number }, { x: number; y: number }][]

export const coverHas = (c: Rect, x: number, y: number) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h

/** A bar across both eyes, or a star on each (phone: eyeCovers); w×h is the picture the eyes were found in. */
export function eyeCovers(eyes: Eyes, w: number, h: number, stars: boolean): Cover[] {
  return eyes.flatMap(([a, b]) => {
    const ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h, d = Math.hypot(bx - ax, by - ay)
    const box = (cx: number, cy: number, rx: number, ry: number): Cover => ({ x: (cx - rx) / w, y: (cy - ry) / h, w: 2 * rx / w, h: 2 * ry / h, stars, eye: true })
    // ponytail: the bar stays level (a tilted head only makes it taller); turn it with the head if tilted eyes show past its ends
    return stars ? [box(ax, ay, 0.6 * d, 0.6 * d), box(bx, by, 0.6 * d, 0.6 * d)] : [box((ax + bx) / 2, (ay + by) / 2, d, 0.4 * d + Math.abs(ay - by) / 2)]
  })
}

/** Draws one cover in pixels: a black bar, or fat yellow stars filling it along its longer side (phone: drawCover). */
export function drawCover(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, stars: boolean) {
  if (!stars) { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); return }
  ctx.fillStyle = '#fdd835'
  const side = Math.min(w, h), n = Math.max(1, Math.round(Math.max(w, h) / side)), step = Math.max(w, h) / n
  for (let i = 0; i < n; i++) {
    const cx = w >= h ? x + step * (i + 0.5) : x + w / 2, cy = w >= h ? y + h / 2 : y + step * (i + 0.5)
    ctx.beginPath()
    for (let k = 0; k < 10; k++) { // inner radius 0.5, so little shows between the arms
      const r = side / 2 * (k % 2 ? 0.5 : 1), a = (-90 + k * 36) * Math.PI / 180
      k ? ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
    }
    ctx.closePath(); ctx.fill()
  }
}
