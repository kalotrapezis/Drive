#!/usr/bin/env node
'use strict'
/**
 * One-time cleanup (29 Oct): folds the "calls-YYYY-MM (n).jsonl" copies the sync left in Phone/ into their month's
 * log (every call once, the month's own line where both have it) and moves the copies to Tetra's Trash, never rm.
 * Shows what it would do; `--run` does it. Usage: node scripts/fold-call-copies.js [Files folder] [--run]
 */
const fs = require('node:fs')
const path = require('node:path')
const { mergeCallLog } = require('../files')

const run = process.argv.includes('--run')
const root = process.argv.slice(2).find(a => a !== '--run') ?? path.join(require('node:os').homedir(), 'Tetra', 'Files')
const dir = path.join(root, 'Phone'), trash = path.join(root, 'Trash')
const calls = text => new Set(text.split('\n').filter(l => l.trim()).map(l => { try { const c = JSON.parse(l); return `${c.at}\t${c.number ?? ''}` } catch { return l } }))
const free = name => { const { name: base, ext } = path.parse(name); let n = 1, f = name; while (fs.existsSync(path.join(trash, f))) f = `${base} (trash ${++n})${ext}`; return f }

for (const main of fs.readdirSync(dir).filter(f => /^calls-\d{4}-\d{2}\.jsonl$/.test(f))) {
  const copies = fs.readdirSync(dir).filter(f => f.startsWith(main.replace('.jsonl', ' (')) && f.endsWith(').jsonl')).sort()
  if (!copies.length) continue
  const before = fs.readFileSync(path.join(dir, main), 'utf8')
  let merged = before
  for (const copy of copies) {
    const text = fs.readFileSync(path.join(dir, copy), 'utf8')
    const have = calls(merged), adds = [...calls(text)].filter(k => !have.has(k)).length
    console.log(`${copy}: ${calls(text).size} calls, ${adds} not in ${main}`)
    merged = mergeCallLog(text, merged) // the month's own line wins where both have the call
  }
  console.log(`${main}: ${calls(before).size} calls → ${calls(merged).size}${merged === before ? ' (unchanged)' : ''}; ${copies.length} copies → Trash`)
  if (!run) continue
  if (merged !== before) { fs.writeFileSync(path.join(trash, free(main)), before); fs.writeFileSync(path.join(dir, main), merged) } // the old month kept in Trash too
  for (const copy of copies) fs.renameSync(path.join(dir, copy), path.join(trash, free(copy)))
}
if (!run) console.log('\nNothing changed. Add --run to do it.')
