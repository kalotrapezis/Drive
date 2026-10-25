'use strict'
// Tetra's words (the user, 25 Oct: Greek first, then every EU language): one JSON file a language in locales/, flat
// keys by area ("files.newFolder"). English is the default and fills any key a language lacks. Adding a language is
// adding its file. The window gets the same words through preload (i18n:words) and formats them as format() here does.
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, 'locales')
const read = tag => { try { return JSON.parse(fs.readFileSync(path.join(DIR, `${tag}.json`), 'utf8')) } catch { return {} } }
/** The languages there are files for: "el", "en", … */
const languages = () => { try { return fs.readdirSync(DIR).filter(n => /^[a-z]{2,3}(-[A-Za-z0-9]+)*\.json$/.test(n)).map(n => n.slice(0, -5)).sort() } catch { return ['en'] } }

/** "system" (or nothing) is the first of the system's languages there is a file for; English when none. */
function resolve(choice, system = []) {
  const have = languages()
  if (choice && choice !== 'system' && have.includes(choice)) return choice
  for (const l of system) {
    const tag = String(l || '').replace('_', '-')
    if (have.includes(tag)) return tag
    if (have.includes(tag.split('-')[0].toLowerCase())) return tag.split('-')[0].toLowerCase()
  }
  return 'en'
}

/** key → the words, {name} filled from vars; with a numeric vars.count, key_one / key_other … as the language's plural rules pick. */
function format(words, fallback, lang, key, vars) {
  if (vars && typeof vars.count === 'number') {
    const k = `${key}_${new Intl.PluralRules(lang).select(vars.count)}`
    key = k in words || k in fallback ? k : `${key}_other`
  }
  const s = words[key] ?? fallback[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : s
}

const en = read('en')
let state = { choice: 'system', lang: 'en', words: en, fallback: en }
function use(choice, system) {
  const lang = resolve(choice, system)
  state = { choice: choice || 'system', lang, words: lang === 'en' ? en : read(lang), fallback: en }
  return state
}
const t = (key, vars) => format(state.words, state.fallback, state.lang, key, vars)
/** The locale for dates and numbers: as before (the system's) in English, the language's otherwise. */
const locale = english => (state.lang === 'en' ? english : state.lang)

module.exports = { t, use, format, resolve, languages, locale, current: () => state, read }
