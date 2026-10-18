'use strict'
// The same cases as the phone's TimerTest (Drive-Android), so the two engines agree.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Timers, parse, leftMs, UNANSWERED_MS } = require('../timer')

const t0 = Date.parse('2026-10-18T16:00:00Z')
function pair() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-'))
  return [new Timers(path.join(tmp, 'tablet', 'Timer'), 'Tablet'), new Timers(path.join(tmp, 'computer', 'Timer'), 'Computer')]
}
/** What sync does with a changed file: the other side's copy replaced. */
function carry(from, to) {
  fs.mkdirSync(to.root, { recursive: true })
  for (const n of fs.readdirSync(from.root).filter(n => n.endsWith('.json'))) fs.copyFileSync(path.join(from.root, n), path.join(to.root, n))
}

test('time left counts down to the end, rings, and is over unanswered after ten minutes', () => {
  const [tablet] = pair()
  const r = tablet.start(300, t0)
  assert.equal(leftMs(r, t0), 300_000)
  assert.equal(tablet.active(t0 + 100_000)[0].leftMs, 200_000)
  assert.equal(tablet.active(t0 + 299_000)[0].ringing, false)
  assert.equal(tablet.active(t0 + 300_000)[0].ringing, true)
  assert.equal(tablet.active(t0 + 300_000 + UNANSWERED_MS + 1).length, 0)
  assert.equal(tablet.nextEnd(t0), t0 + 300_000)
})

test('pause keeps what is left; resume counts from then', () => {
  const [tablet] = pair()
  const { id } = tablet.start(300, t0)
  assert.ok(tablet.change(id, 'pause', t0 + 100_000))
  assert.equal(tablet.active(t0 + 5_000_000)[0].leftMs, 200_000)
  assert.equal(tablet.change(id, 'pause', t0), false) // already paused
  assert.ok(tablet.change(id, 'resume', t0 + 1_000_000))
  const r = tablet.read()[0]
  assert.equal(r.ends, t0 + 1_200_000)
  assert.equal(r.rev, 3)
})

test('OK on one device stops the ringing on the others', () => {
  const [tablet, computer] = pair()
  const { id } = tablet.start(600, t0)
  carry(tablet, computer)
  assert.equal(tablet.active(t0 + 600_000)[0].ringing, true) // both ring at the end
  assert.ok(computer.change(id, 'ok', t0 + 600_000))
  // written in the computer's own file; the tablet's is left as it was
  assert.deepEqual(fs.readdirSync(computer.root).sort(), [`${id}.Computer.json`, `${id}.Tablet.json`])
  carry(computer, tablet)
  assert.equal(tablet.active(t0 + 605_000).length, 0)
})

test('two changes at once make no copies, and stopping wins', () => {
  const [tablet, computer] = pair()
  const { id } = tablet.start(600, t0)
  carry(tablet, computer)
  tablet.change(id, 'pause', t0 + 10_000)
  computer.change(id, 'stop', t0 + 10_000)
  carry(tablet, computer); carry(computer, tablet) // each changed only its own file: nothing kept twice
  for (const d of [tablet, computer]) { assert.equal(fs.readdirSync(d.root).length, 2); assert.equal(d.active(t0 + 20_000).length, 0) }
  // a copy left by the old one-file-per-timer sync ("x (2).json") still reads as the same timer
  fs.copyFileSync(path.join(computer.root, `${id}.Tablet.json`), path.join(computer.root, `${id}.Tablet (2).json`))
  assert.equal(computer.active(t0 + 20_000).length, 0)
  const r = computer.read()[0]
  computer.write({ ...r, state: 'running', ends: t0 + 900_000, rev: r.rev + 1, by: 'Phone' })
  assert.equal(computer.active(t0 + 20_000)[0].state, 'running')
})

test('clocks a few seconds apart show the same time left within the gap', () => {
  const [tablet, computer] = pair()
  const skew = 3000
  const { id } = tablet.start(300, t0)
  carry(tablet, computer)
  assert.equal(tablet.active(t0 + 60_000)[0].leftMs - computer.active(t0 + 60_000 + skew)[0].leftMs, skew)
  computer.change(id, 'pause', t0 + 60_000 + skew)
  carry(computer, tablet)
  assert.equal(tablet.active(t0 + 61_000)[0].leftMs, 237_000)
  tablet.change(id, 'resume', t0 + 70_000)
  carry(tablet, computer)
  assert.equal(computer.read()[0].state, 'running')
  assert.equal(computer.read()[0].rev, 3)
})

test('a new timer takes the file of one that is over', () => {
  const [tablet] = pair()
  const first = tablet.start(60, t0)
  tablet.change(first.id, 'stop', t0 + 10_000)
  const second = tablet.start(120, t0 + 100_000)
  assert.equal(second.file, first.file)
  assert.equal(second.rev, 3)
  const third = tablet.start(30, t0 + 100_000)
  assert.notEqual(third.file, second.file)
  assert.equal(tablet.active(t0 + 101_000).length, 2)
})

test('a pinned card stays ready; the trash takes it away everywhere', () => {
  const [tablet, computer] = pair()
  const { id } = tablet.start(900, t0)
  tablet.change(id, 'pin', t0); tablet.change(id, 'stop', t0)
  assert.equal(tablet.active(t0).length, 0)
  const [c] = tablet.cards(t0)
  assert.ok(c.pinned && c.ready)
  assert.notEqual(tablet.start(60, t0).file, c.file) // a pinned card's file is not taken
  tablet.change(id, 'restart', t0 + 10_000)
  assert.equal(tablet.read().find(r => r.id === id).ends, t0 + 910_000)
  carry(tablet, computer)
  computer.change(id, 'trash', t0 + 20_000)
  carry(computer, tablet)
  assert.ok(!tablet.cards(t0 + 20_000).some(r => r.id === id))
})

test('nine timers at most', () => {
  const [tablet] = pair()
  for (let i = 0; i < 9; i++) tablet.start(60 + i, t0)
  assert.throws(() => tablet.start(30, t0), /Nine timers/)
  assert.equal(tablet.cards(t0).length, 9)
})

test('a timer Claude writes by hand is read; anything else is not a timer', () => {
  const [tablet] = pair()
  fs.mkdirSync(tablet.root, { recursive: true })
  fs.writeFileSync(path.join(tablet.root, 'tea.json'), '{"seconds": 180, "state": "running", "ends": "2026-10-18T16:03:00Z"}')
  fs.writeFileSync(path.join(tablet.root, 'notes.json'), 'not a timer')
  const [r] = tablet.active(t0)
  assert.equal(r.id, 'tea')
  assert.equal(r.leftMs, 180_000)
  assert.equal(parse('{"state":"exploded"}'), null)
  // and a file Tetra on the phone writes reads the same (Timer.kt's json(): ends as an ISO instant, left in seconds)
  assert.equal(parse('{"id":"k3f9a2","seconds":300,"label":"","state":"paused","ends":null,"left":200.5,"rev":2,"by":"Tablet"}').left, 200.5)
})
