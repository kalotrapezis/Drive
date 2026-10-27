const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

// main.js is never loaded by the other tests, so a syntax error there shipped once (25 September): the app
// installed, and its main process never started. Every file the package runs is at least parsed here.
test('every file the app runs parses', () => {
  const files = require('../package.json').build.files.filter(f => /^[\w./-]+\.js$/.test(f))
  assert.ok(files.includes('main.js'))
  for (const f of files) execFileSync(process.execPath, ['--check', path.join(__dirname, '..', f)])
})

// client.js, reset.js and callaudio.js were left out of build.files (26 Oct): the .deb installed and stopped at
// start with "Cannot find module './client'". Every module main.js loads, and what those load, must be packaged.
test('every module the main process loads is in the package', () => {
  const fs = require('node:fs')
  const dir = path.join(__dirname, '..')
  const files = require('../package.json').build.files
  const seen = new Set(), queue = ['main.js']
  while (queue.length) {
    const f = queue.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/require\('\.\/([^']+)'\)/g)) {
      const n = /\.(js|json)$/.test(m[1]) ? m[1] : `${m[1]}.js`
      if (fs.existsSync(path.join(dir, n))) queue.push(n)
    }
  }
  assert.deepEqual([...seen].filter(f => !files.includes(f)), [])
})
