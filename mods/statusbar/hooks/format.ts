import type { Glyphs } from '../types'

// The number formats of the status line (src/style/common.ts), so the pane and the two lines
// read the same.

/** "4d19h" / "2h05m" / "3m07s" / "42s" */
export function dur(s: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`
  if (s >= 60) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
  return `${s}s`
}

/** 74000 -> "74k", 1000000 -> "1M", 69120000 -> "69.1M", 2340000000 -> "2.3B". Floors. */
export function count(n: number): string {
  const one = (x: number) => String(Math.floor(x * 10) / 10)
  if (n >= 1e9) return `${one(n / 1e9)}B`
  if (n >= 1e6) return `${one(n / 1e6)}M`
  if (n >= 1e3) return `${Math.floor(n / 1e3)}k`
  return String(n)
}

/** "$25.95" under $100, "$412" from $100. */
export const money = (usd: number) => `$${usd < 100 ? usd.toFixed(2) : Math.round(usd)}`

// The terminal's cells: what Bun.stringWidth counts in the binary, which this environment
// does not have. A CJK character or an emoji takes two cells, a combining mark none.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u
const EMOJI = /\p{Emoji_Presentation}/u
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x3fffd],
]

function charCells(ch: string) {
  if (ZERO_WIDTH.test(ch)) return 0
  const code = ch.codePointAt(0)!
  return EMOJI.test(ch) || WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
}

export function cells(text: string) {
  let n = 0
  for (const ch of text) n += charCells(ch)
  return n
}

/** The scope label's room on the mode line: SCOPE_CELLS in src/turns.ts. */
export const SCOPE_CELLS = 32

/**
 * One clean line of at most max cells, as label() in src/turns.ts makes the scope label. A
 * longer one is cut at its last word that fits, with an ellipsis; when that would lose more
 * than half of it, at the cell limit.
 */
export function label(text: string, max: number): string {
  const s = text.replace(/[\x00-\x1f\x7f"`]/g, '').trim().replace(/\.$/, '')
  if (cells(s) <= max) return s
  let head = '' // what fits next to the ellipsis, which takes one cell
  let used = 0
  for (const ch of s) {
    used += charCells(ch)
    if (used + 1 > max) break
    head += ch
  }
  const space = head.lastIndexOf(' ')
  return (space >= head.length / 2 ? head.slice(0, space) : head).trimEnd() + '…'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Epoch seconds as local time: "Mon 16 Nov 09:59". */
export function when(epochS: number): string {
  const d = new Date(epochS * 1000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`
}

/** "2026-11" -> "Nov 2026". */
export function monthName(key: string): string {
  const [year, m] = key.split('-')
  const name = MONTHS[Number(m) - 1]
  return name === undefined ? key : `${name} ${year}`
}

const WEEK_S = 7 * 86400

/** The part of the week that is gone, in percent: 1 − (resetsAt − now) / 7 days. */
export const weekGone = (resetsAt: number, nowS: number) => Math.round((1 - (resetsAt - nowS) / WEEK_S) * 100)

export const GAUGE_CELLS = 16
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar of GAUGE_CELLS cells: the filled part, then the empty rest, as two runs to color. */
export function gauge(pct: number, glyphs: Glyphs): { fill: string; rest: string } {
  const eighths = Math.round((Math.min(100, Math.max(0, pct)) / 100) * GAUGE_CELLS * 8)
  if (glyphs === 'ascii') {
    const full = Math.round(eighths / 8)
    return { fill: '#'.repeat(full), rest: '-'.repeat(GAUGE_CELLS - full) }
  }
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return { fill: '█'.repeat(full) + part, rest: '░'.repeat(GAUGE_CELLS - full - (part ? 1 : 0)) }
}
