'use strict'
// A call's sound from one computer to another over Wi-Fi (the user, 26 Oct: "Bluetooth > Wi-Fi > speaker, end call >
// Wi-Fi > Bluetooth > end"). The computer the phone is on by Bluetooth sends the caller's voice to the one where the call
// was answered, and plays that one's microphone to the phone. 16 kHz mono, a Bluetooth call's own rate: about 32 KB/s
// each way, over the sync's TLS connection (sync.js /call/audio, client.js callAudio). PipeWire's parec and pacat do
// the sound; nothing to install.
const { spawn, execFile } = require('node:child_process')

const FORMAT = ['--format=s16le', '--rate=16000', '--channels=1', '--raw']
const pactl = args => new Promise(r => execFile('pactl', args, { timeout: 4000 }, (e, out) => r(e ? '' : String(out))))

/** The phone's call streams on this computer's Bluetooth: { source (its voice), sink (to it) }, or nulls. */
async function bluez() {
  const names = async kind => (await pactl(['list', 'short', kind])).split('\n').map(l => l.split('\t')[1] || '').filter(n => /^bluez_/.test(n) && !n.endsWith('.monitor'))
  return { source: (await names('sources'))[0] ?? null, sink: (await names('sinks'))[0] ?? null }
}

const capture = device => spawn('parec', [...FORMAT, '--latency-msec=40', ...(device ? [`--device=${device}`] : [])], { stdio: ['ignore', 'pipe', 'ignore'] })
const play = device => spawn('pacat', ['--playback', ...FORMAT, '--latency-msec=80', ...(device ? [`--device=${device}`] : [])], { stdio: ['pipe', 'ignore', 'ignore'] })

/**
 * Plays `received` here and sends what is captured here into `send`, until either side stops; answers stop(). With no
 * devices, the defaults: on the computer that answered they are the echo canceller's (calls.js echo).
 */
function bridge(received, send, { source = null, sink = null } = {}, procs = { capture, play }) {
  const rec = procs.capture(source), out = procs.play(sink)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const p of [rec, out]) try { p.kill() } catch {}
    try { send.end() } catch {}
    received.destroy?.()
  }
  rec.stdout.on('error', stop).pipe(send).on('error', stop)
  received.on('error', stop).pipe(out.stdin).on('error', stop)
  for (const x of [rec, out]) x.on('exit', stop).on('error', stop)
  received.on('end', stop)
  return stop
}

module.exports = { bluez, bridge }
