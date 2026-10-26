import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { format, type Words } from './i18n.ts'

// main's half (CommonJS, untyped)
const main = createRequire(import.meta.url)('../i18n.js') as {
  format(words: Record<string, string>, fallback: Record<string, string>, lang: string, key: string, vars?: Record<string, string | number>): string
  resolve(choice: string, system: string[]): string
}
const dir = path.join(import.meta.dirname, '..', 'locales')
const read = (tag: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(dir, `${tag}.json`), 'utf8'))
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
const en = read('en')

test('every language has every English key, with the same {placeholders}, and nothing English lacks', () => {
  for (const tag of fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(t => t !== 'en')) {
    const other = read(tag)
    // plural forms differ by language (_one/_few/_many/_other): the key's base must be there, with _other
    const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '')
    const bases = new Set(Object.keys(other).map(base))
    for (const k of Object.keys(en)) {
      if (k === base(k)) assert.ok(k in other, `${tag}.json lacks ${k}`)
      else assert.ok(bases.has(base(k)) && `${base(k)}_other` in other, `${tag}.json lacks ${base(k)}_other`)
    }
    for (const [k, v] of Object.entries(other)) {
      assert.ok(k in en || `${base(k)}_other` in en, `${tag}.json has ${k}, which English has not`)
      const english = en[k] ?? en[`${base(k)}_other`]
      // a plural's one-form may say "one" instead of {count}, or keep {count} (Croatian's "one" is also 21, 31…)
      if (k === base(k) || !/_(one|zero|two)$/.test(k)) assert.equal(holes(v), holes(english), `${tag}.json ${k}: {placeholders}`)
      else assert.ok(holes(v).split(',').every(h => !h || h === 'count' || holes(english).split(',').includes(h)), `${tag}.json ${k}: {placeholders}`)
      assert.ok(v.trim(), `${tag}.json ${k} is empty`)
    }
  }
})

test('the window and main format alike: {name}, plurals, English for a missing key, the key when nobody has it', () => {
  const w: Words = { choice: 'el', lang: 'el', words: { 'x.items_one': 'Ένα στοιχείο', 'x.items_other': '{count} στοιχεία', 'x.hi': 'Γεια, {name}' }, fallback: { 'x.items_one': '1 item', 'x.items_other': '{count} items', 'x.only': 'Only English {n}' } }
  const cases: [string, Record<string, string | number>?][] = [['x.items', { count: 1 }], ['x.items', { count: 5 }], ['x.hi', { name: 'Ρία' }], ['x.only', { n: 2 }], ['x.none'], ['x.hi']]
  const want = ['Ένα στοιχείο', '5 στοιχεία', 'Γεια, Ρία', 'Only English 2', 'x.none', 'Γεια, {name}']
  assert.deepEqual(cases.map(([k, v]) => format(w, k, v)), want)
  assert.deepEqual(cases.map(([k, v]) => main.format(w.words, w.fallback, w.lang, k, v)), want)
})

test('System default is the system language when there is a file for it, else English', () => {
  assert.equal(main.resolve('system', ['el-GR']), 'el')
  assert.equal(main.resolve('system', ['xx-YY']), 'en')
  assert.equal(main.resolve('en', ['el']), 'en')
  assert.equal(main.resolve('zz', []), 'en')
})
