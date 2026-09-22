export type Level = 'week' | 'month' | 'year'
export const LEVELS: Level[] = ['week', 'month', 'year']

export interface Media {
  id: number; path: string; sha256: string; mime: string; is_video: number; size: number
  taken_at: number; width: number | null; height: number | null
  latitude: number | null; longitude: number | null; camera: string | null; thumb: number
}

export interface Group<T> { key: string; label: string; items: T[] }

const DAY = 86_400_000

/** Monday 00:00 local time of the week containing t. */
export function weekStart(t: number): Date {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

export function periodKey(t: number, level: Level): string {
  const d = new Date(t)
  if (level === 'year') return String(d.getFullYear())
  if (level === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const w = weekStart(t)
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`
}

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', o)
const monthYear = fmt({ month: 'long', year: 'numeric' })
const dayMonth = fmt({ day: 'numeric', month: 'short' })
const dayMonthYear = fmt({ day: 'numeric', month: 'short', year: 'numeric' })

export function periodLabel(t: number, level: Level): string {
  const d = new Date(t)
  if (level === 'year') return String(d.getFullYear())
  if (level === 'month') return monthYear.format(d)
  const start = weekStart(t)
  const end = new Date(start.getTime() + 6 * DAY + 3_600_000) // +1h survives a DST change
  return `${dayMonth.format(start)} – ${dayMonthYear.format(end)}`
}

/** Items must already be sorted newest first. */
export function group<T extends { taken_at: number }>(items: T[], level: Level): Group<T>[] {
  const groups: Group<T>[] = []
  for (const item of items) {
    const key = periodKey(item.taken_at, level)
    const last = groups[groups.length - 1]
    if (last?.key === key) last.items.push(item)
    else groups.push({ key, label: periodLabel(item.taken_at, level), items: [item] })
  }
  return groups
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`
}
