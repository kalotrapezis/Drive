// AI Assist's window-side helpers without a screen (Assistant.tsx has the screen): the phone's Vad and yesNo, ported.

export const RATE = 16000
export const FRAME = 480 // 30 ms

const rms = (f: Int16Array) => { let s = 0; for (const x of f) s += x * x; return f.length ? Math.sqrt(s / f.length) : 0 }

/** Voice activity: 30 ms frames of 16 kHz speech in, one phrase out when the speaker pauses (the VOICE app's Vad). */
export class Vad {
  private noise = 200
  private calib: number[] = []
  private pre: Int16Array[] = []
  private seg: Int16Array[] = []
  private silence = 0
  private speech = 0
  speaking = false
  level = 0
  private pauseFrames: number
  private maxFrames: number
  constructor(pauseFrames = 83, maxFrames = 60_000 / 30) { this.pauseFrames = pauseFrames; this.maxFrames = maxFrames }

  /** True when a phrase has ended: phrase() holds it. */
  push(frame: Int16Array): boolean {
    const r = rms(frame)
    this.level = Math.min(1, r / 3000)
    if (this.calib.length < 13) { this.calib.push(r); this.noise = this.calib.reduce((a, b) => a + b, 0) / this.calib.length; return false }
    const th = Math.max(this.noise * 2.5 + 120, 280)
    if (!this.speaking) {
      this.pre.push(frame); if (this.pre.length > 6) this.pre.shift()
      if (r > th) { this.speaking = true; this.silence = 0; this.speech = 1; this.seg = [...this.pre] } else this.noise = 0.95 * this.noise + 0.05 * r
      return false
    }
    this.seg.push(frame)
    if (r > th) { this.silence = 0; this.speech++ } else this.silence++
    return (this.silence >= this.pauseFrames || this.seg.length >= this.maxFrames) && this.speech >= 7
  }

  /** What was said so far (also when the user stops it mid-phrase); empty when nothing was. */
  phrase(): Int16Array {
    if (this.speech < 7) return new Int16Array(0)
    const out = new Int16Array(this.seg.reduce((n, f) => n + f.length, 0))
    let n = 0
    for (const f of this.seg) { out.set(f, n); n += f.length }
    return out
  }
}

/** Without accents, lower case: as contacts.js plain(). */
export const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').trim()
const YES = new Set(['ναι', 'οκ', 'εντάξει', 'ντάξει', 'κάλεσε', 'πάρε', 'ok', 'okay', 'yes'].map(plain))
const NO = new Set(['όχι', 'άκυρο', 'ακύρωσε', 'σταμάτα', 'no', 'cancel'].map(plain))
/** A spoken yes or no to a waiting call, heard by Tetra itself, never the model: true, false, or null for anything else. */
export function yesNo(said: string): boolean | null {
  const first = plain(said).split(/[^\p{L}]+/u).find(Boolean)
  return first == null ? null : YES.has(first) ? true : NO.has(first) ? false : null
}

/** "$0.0123": a cent's fractions while it is small (assistant.js Bill.text). */
export const money = (usd: number) => usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
/** 0:01:05 */
export const clock = (ms: number) => { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

/** A key pressed with its modifiers as Electron's accelerator ("Ctrl+Alt+A"); null while only modifiers are down. */
export function accelerator(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return null
  // by the key's place, not its letter: a Greek keyboard's "α" is A
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code
    : ({ Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backquote: '`' } as Record<string, string>)[e.code]
  if (!key) return null
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+')
}
