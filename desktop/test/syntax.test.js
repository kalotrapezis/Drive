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
