import { createElement, Fragment, type ReactNode } from 'react'

// The window's words (i18n.js has the why): main picks the language and hands over its file and English's, once, as
// the page loads (preload: i18n:words). A change of language in Settings reloads the page.
export type Words = { choice: string; lang: string; words: Record<string, string>; fallback: Record<string, string> }
type Vars = Record<string, string | number>

/** The same as i18n.js format(): key → the words, {name} filled; a numeric vars.count picks key_one / key_other …. */
export function format(w: Words, key: string, vars?: Vars): string {
  if (vars && typeof vars.count === 'number') {
    const k = `${key}_${new Intl.PluralRules(w.lang).select(vars.count)}`
    key = k in w.words || k in w.fallback ? k : `${key}_other`
  }
  const s = w.words[key] ?? w.fallback[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : s
}

let current: Words | null = null
const words = () => (current ??= (globalThis as { drive?: { i18n?: Words } }).drive?.i18n ?? { choice: 'system', lang: 'en', words: {}, fallback: {} })

export const t = (key: string, vars?: Vars) => format(words(), key, vars)

/** As t(), with elements for some {name}s: tr('x', { root: <code>{root}</code> }). */
export function tr(key: string, vars: Record<string, ReactNode>): ReactNode {
  const plain: Vars = {}
  for (const [k, v] of Object.entries(vars)) if (typeof v === 'string' || typeof v === 'number') plain[k] = v
  const parts = format(words(), key, plain).split(/\{(\w+)\}/)
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 ? vars[p] ?? `{${p}}` : p)))
}

/** The language picked ("el", "en"): for <html lang> and Intl. */
export const lang = () => words().lang
/** Dates and numbers: the system's locale ([]) in English, as before; the language's otherwise. */
export const locale = (): string[] => (words().lang === 'en' ? [] : [words().lang])
