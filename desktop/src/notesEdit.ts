// The Notes editor's logic, apart from React so it can be tested: formatting a text selection, the in-memory undo,
// and reading Markdown into blocks for the read view.

export interface Edit { text: string; start: number; end: number }

/** **bold**, *italic*, ~~strike~~, `code`: around the selection, or taken off when it is already there. */
export function wrap({ text, start, end }: Edit, mark: string): Edit {
  const before = text.slice(0, start), inside = text.slice(start, end), after = text.slice(end)
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return { text: before.slice(0, -mark.length) + inside + after.slice(mark.length), start: start - mark.length, end: end - mark.length }
  }
  return { text: before + mark + inside + mark + after, start: start + mark.length, end: end + mark.length }
}

/** `# `, `- `, `1. `, `- [ ] `, `> `: on every line the selection touches; again takes it off. */
export function prefix({ text, start, end }: Edit, mark: string): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', end)
  const to = nl === -1 ? text.length : nl
  const lines = text.slice(from, to).split('\n')
  const all = lines.every(l => l.startsWith(mark))
  const numbered = mark === '1. '
  const next = lines.map((l, i) => all ? l.slice(mark.length) : (numbered ? `${i + 1}. ` : mark) + l.replace(/^(#{1,3} |- \[[ x]\] |- |\d+\. |> )/, ''))
  const body = next.join('\n')
  return { text: text.slice(0, from) + body + text.slice(to), start: from, end: from + body.length }
}

/** Indent or outdent the selected lines by two spaces (nested lists). */
export function indent({ text, start, end }: Edit, out: boolean): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', end)
  const to = nl === -1 ? text.length : nl
  const body = text.slice(from, to).split('\n').map(l => out ? l.replace(/^ {1,2}/, '') : '  ' + l).join('\n')
  return { text: text.slice(0, from) + body + text.slice(to), start: from, end: from + body.length }
}

/**
 * Undo in memory, per open note. Typing is grouped: a change within `quietMs` of the last one joins it, so one
 * undo takes back a burst of typing, not a letter.
 */
export class Undo<T> {
  private past: T[] = []
  private future: T[] = []
  private last = 0
  private current: T
  private quietMs: number
  constructor(current: T, quietMs = 700) { this.current = current; this.quietMs = quietMs }
  get canUndo() { return this.past.length > 0 }
  get canRedo() { return this.future.length > 0 }
  push(next: T, now = Date.now()) {
    if (now - this.last > this.quietMs || this.past.length === 0) this.past.push(this.current)
    if (this.past.length > 500) this.past.shift()
    this.current = next
    this.future = []
    this.last = now
  }
  /** A separate step even when it follows typing at once (a toolbar action). */
  step(next: T) { this.last = 0; this.push(next) }
  undo(): T | null { const p = this.past.pop(); if (p === undefined) return null; this.future.push(this.current); this.current = p; this.last = 0; return p }
  redo(): T | null { const f = this.future.pop(); if (f === undefined) return null; this.past.push(this.current); this.current = f; this.last = 0; return f }
}

export type Inline = { t: 'text' | 'b' | 'i' | 's' | 'code' | 'link'; v: string; href?: string }
export type Block =
  | { t: 'h'; level: number; v: Inline[] } | { t: 'p'; v: Inline[] } | { t: 'quote'; v: Inline[] } | { t: 'hr' }
  | { t: 'code'; v: string } | { t: 'li'; depth: number; ordered: string | null; check: boolean | null; line: number; v: Inline[] }

export function inline(s: string): Inline[] {
  const out: Inline[] = []
  const re = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g
  let at = 0
  for (const m of s.matchAll(re)) {
    if (m.index! > at) out.push({ t: 'text', v: s.slice(at, m.index) })
    const x = m[0]
    if (x.startsWith('**')) out.push({ t: 'b', v: x.slice(2, -2) })
    else if (x.startsWith('~~')) out.push({ t: 's', v: x.slice(2, -2) })
    else if (x.startsWith('`')) out.push({ t: 'code', v: x.slice(1, -1) })
    else if (x.startsWith('[')) { const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(x)!; out.push({ t: 'link', v: l[1], href: l[2] }) }
    else out.push({ t: 'i', v: x.slice(1, -1) })
    at = m.index! + x.length
  }
  if (at < s.length) out.push({ t: 'text', v: s.slice(at) })
  return out
}

/** Markdown the Notes apps write, as blocks. `line` on a list item is its line, so a tick can be written back. */
export function blocks(md: string): Block[] {
  const out: Block[] = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('```')) {
      const code: string[] = []
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i])
      out.push({ t: 'code', v: code.join('\n') }); continue
    }
    let m
    if ((m = /^(#{1,3}) (.*)$/.exec(l))) out.push({ t: 'h', level: m[1].length, v: inline(m[2]) })
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) out.push({ t: 'hr' })
    else if ((m = /^> ?(.*)$/.exec(l))) out.push({ t: 'quote', v: inline(m[1]) })
    else if ((m = /^(\s*)(?:([-*+])|(\d+)\.) (?:\[([ xX])\] )?(.*)$/.exec(l))) {
      out.push({ t: 'li', depth: Math.floor(m[1].length / 2), ordered: m[3] ?? null, check: m[4] === undefined ? null : m[4] !== ' ', line: i, v: inline(m[5]) })
    } else if (l.trim()) out.push({ t: 'p', v: inline(l) })
  }
  return out
}

/** Ticks the checkbox on one line of the text, from the read view. */
export function toggleLine(md: string, line: number): string {
  const lines = md.split('\n')
  lines[line] = lines[line].replace(/\[([ xX])\]/, (_, c) => c === ' ' ? '[x]' : '[ ]')
  return lines.join('\n')
}

export interface Item { id: string; text: string; isChecked: boolean; order: number; [k: string]: unknown }

/** Unchecked in their order, then checked ones below them — as every Notes app shows a checklist. */
export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => Number(a.isChecked) - Number(b.isChecked) || a.order - b.order)
}

/** A first line or a checklist, for a card. */
export function preview(note: { content?: string; noteType?: string; checklistItems?: Item[] }, max = 8): string[] {
  if (note.noteType === 'CHECKLIST') return sortItems(note.checklistItems ?? []).slice(0, max).map(i => `${i.isChecked ? '☑' : '☐'} ${i.text}`)
  return (note.content ?? '').split('\n').filter(l => l.trim()).slice(0, max).map(l => l.replace(/^(#{1,3} |> )/, '').replace(/^(\s*)- \[ \] /, '$1☐ ').replace(/^(\s*)- \[[xX]\] /, '$1☑ ').replace(/\*\*|~~|`/g, ''))
}
