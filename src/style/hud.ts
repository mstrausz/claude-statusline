// The "hud" style (directions.md section 9): two lines of filled segments. Each text has its
// own background, so its contrast is the same on dark and light terminal themes; that is
// what makes truecolor safe without knowing the terminal's background.

import type { Settings } from '../settings.ts'
import {
  BRANCH_MAX, branchUrl, CTX_CRIT, CTX_WARN, LIMIT_CRIT, LIMIT_WARN, MONTHS, PATH_MAX, SKILL_MAX, USAGE_URL,
  baseName, cells, count, cut, dur, limitsOf, money, osc8, placeCountdowns, sevOf, shortPath, skillName,
  type Sev, type View,
} from './common.ts'

export type Tier = 'truecolor' | '256' | '16' | 'none'

/**
 * The color tier, from the environment the status line command inherits from Claude Code,
 * which inherits it from the terminal. Stdout is a pipe, so no rule can ask the terminal.
 */
export function detectTier(env: Record<string, string | undefined>, platform: string = process.platform): Tier {
  const force = env.FORCE_COLOR
  if (force) {
    if (force === '0' || force === 'false') return 'none'
    if (force === '1') return '16'
    if (force === '2') return '256'
    if (force === '3') return 'truecolor'
    // Any other value: color is on, NO_COLOR is ignored, the rules below select the tier.
  } else if (env.NO_COLOR) return 'none'
  const term = env.TERM ?? ''
  if (term === 'dumb') return 'none'
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor'
  if (platform === 'win32') return 'truecolor' // Windows Terminal and the Windows 10+ console
  if (env.TERM_PROGRAM === 'Apple_Terminal') return '256' // Terminal.app has no truecolor
  if (/-direct$|^xterm-kitty$|^xterm-ghostty$|^alacritty|^wezterm|^foot/.test(term)) return 'truecolor'
  if (term.includes('256')) return '256'
  return '16'
}

type RGB = [number, number, number]
/** One color in all tiers: RGB (truecolor, and the nearest 256-color index) and the 16-color codes. */
type Col = { rgb: RGB; fg16: number; bg16: number }

const hexRgb = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB
const col = (h: string, fg16: number, bg16 = fg16 + 10): Col => ({ rgb: hexRgb(h), fg16, bg16 })

// The palette: the 16-color foreground code, then the 16-color background code (default fg + 10).
const HUD = {
  chrome1: col('#14161c', 30), //     segment background, dark
  chrome2: col('#252833', 30), //     segment background, one step lighter (16 colors: the same black)
  track: col('#343946', 37, 40), //   gauge track
  text: col('#e6edf3', 97), //        values, timer, task label
  muted: col('#9aa4b2', 37), //       labels, details, countdown
  model: col('#b794ff', 97), //       model name (violet)
  folder: col('#7dd3fc', 96), //      folder (sky)
  branch: col('#f472b6', 95), //      branch (pink)
  cyan: col('#22d3ee', 96, 46), //    skill badge fill, spinner
  badgeText: col('#04222a', 30), //   text on the skill badge
  amber: col('#fbbf24', 93), //       value at the warn level
  red: col('#ff4d5e', 91, 41), //     alarm fill (critical level)
  alarmText: col('#14060a', 97), //   text on the alarm fill (16 colors: bright white on red)
  alarmFill: col('#ffe14d', 93), //   gauge fill inside the alarm (yellow)
  alarmTrack: col('#7a1626', 30), //  gauge track inside the alarm
}

// The gauge gradient, calm to hot. Its stops move with the thresholds of the gauge.
const G_TEAL = hexRgb('#2dd4bf'), G_LIME = hexRgb('#a3e635'), G_AMBER = hexRgb('#fbbf24')
const G_RED = hexRgb('#ff4d5e'), G_HOT = hexRgb('#ff2e88')

/** The color at position p (0..1) of a gauge with the given thresholds (percent). */
function gradient(p: number, warn: number, crit: number): RGB {
  const stops: [number, RGB][] = [
    [0, G_TEAL], [(0.6 * warn) / 100, G_LIME], [warn / 100, G_AMBER], [crit / 100, G_RED], [1, G_HOT],
  ]
  for (let i = 1; i < stops.length; i++) {
    const [p0, a] = stops[i - 1]!, [p1, b] = stops[i]!
    if (p <= p1) {
      const t = p1 === p0 ? 0 : Math.max(0, (p - p0) / (p1 - p0))
      return a.map((x, k) => Math.round(x + (b[k]! - x) * t)) as RGB
    }
  }
  return G_HOT
}

const CUBE = [0, 95, 135, 175, 215, 255]

/** The xterm 256-color index (16..255) nearest to an RGB color. */
export function to256([r, g, b]: RGB): number {
  const near = (v: number) => CUBE.reduce((best, lv, i) => (Math.abs(lv - v) < Math.abs(CUBE[best]! - v) ? i : best), 0)
  const ci = [near(r), near(g), near(b)]
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const gv = 8 + 10 * gray
  const dist = (x: number, y: number, z: number) => (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2
  return dist(CUBE[ci[0]!]!, CUBE[ci[1]!]!, CUBE[ci[2]!]!) <= dist(gv, gv, gv)
    ? 16 + 36 * ci[0]! + 6 * ci[1]! + ci[2]!
    : 232 + gray
}

/** One styled run: foreground, background (null: the terminal's) and bold. */
function paint(tier: Tier, text: string, fg: Col, bg: Col | null, bold = false): string {
  if (!text || tier === 'none') return text
  let codes: string
  if (tier === 'truecolor') codes = `${bold ? '1;' : ''}38;2;${fg.rgb.join(';')}${bg ? `;48;2;${bg.rgb.join(';')}` : ''}`
  else if (tier === '256') codes = `${bold ? '1;' : ''}38;5;${to256(fg.rgb)}${bg ? `;48;5;${to256(bg.rgb)}` : ''}`
  // 16 colors: never bold with black text, which is gray where bold uses the bright color.
  else codes = `${bold && fg.fg16 !== 30 ? '1;' : ''}${fg.fg16}${bg ? `;${bg.bg16}` : ''}`
  return `\x1b[${codes}m${text}\x1b[0m`
}

const cp = (...points: number[]) => String.fromCodePoint(...points)
// The Nerd Font set (opt-in): Powerline shapes and icons, each icon followed by a space.
const PL_ARROW = cp(0xe0b0) // filled separator between two segments
const PL_THIN = cp(0xe0b1) //  thin separator between two segments of one color
const PL_CAP_L = cp(0xe0b6) // round cap, left (Powerline Extra)
const PL_CAP_R = cp(0xe0b4) // round cap, right (Powerline Extra)
const NERD = { model: '', reset: '', folder: '', branch: '', host: '', skill: '' }
// Block Elements, in every common monospace font: eighth blocks, index = filled eighths.
const EIGHTHS = ['', cp(0x258f), cp(0x258e), cp(0x258d), cp(0x258c), cp(0x258b), cp(0x258a), cp(0x2589)]
const FULL_BLOCK = cp(0x2588), LIGHT_SHADE = cp(0x2591)
// Quadrants for the spinner, clockwise from the lower left.
const SPIN = [cp(0x2596), cp(0x2598), cp(0x259d), cp(0x2597)]

/** Line 1's densities, widest first: the first that fits the budget is used. Read down, the drop order. */
const DENSITIES = [
  { cells: 8, detail: true, cost: true, tokens: true, countdown: true },
  { cells: 6, detail: true, cost: true, tokens: false, countdown: true }, //  no month tokens
  { cells: 6, detail: false, cost: true, tokens: false, countdown: true }, // no context token detail
  { cells: 6, detail: false, cost: false, tokens: false, countdown: true }, // no cost
  { cells: 4, detail: false, cost: false, tokens: false, countdown: true }, // gauges 4 cells
  { cells: 0, detail: false, cost: false, tokens: false, countdown: false }, // no gauges; countdown only when it matters
]

export function hud(v: View, s: Settings, tier: Tier): string {
  const nerd = s.glyphs === 'nerd', ascii = s.glyphs === 'ascii', plain = tier === 'none'
  const ell = ascii ? '...' : '…'
  const bar = ascii ? '|' : '│'
  const P = (text: string, fg: Col, bg: Col | null, bold = false) => paint(tier, text, fg, bg, bold)
  const asFg = (c: Col): Col => ({ ...c, fg16: c.bg16 - 10 })
  // A link is an escape sequence, so the output without color has none.
  const link = (url: string | undefined, text: string) => (s.links && url && !plain ? osc8(url, text) : text)
  type Seg = { bg: Col; s: string }
  // A segment: its body with one pad cell on each side. Without color: the body only.
  const seg = (bg: Col, body: string): Seg => ({ bg, s: plain ? body : P(' ', HUD.text, bg) + body + P(' ', HUD.text, bg) })

  const gauge = (used: number, warn: number, crit: number, sev: Sev, n: number, kind: 'normal' | 'stale' | 'alarm') => {
    if (!n) return ''
    const per = ascii ? 1 : 8 // steps in one cell
    let u = Math.round((used / 100) * n * per)
    if (used > 0) u = Math.max(1, u) // empty only at 0 %
    if (used < 100) u = Math.min(n * per - 1, u) // full only at 100 %
    const full = Math.floor(u / per), part = u % per
    const track = kind === 'alarm' ? HUD.alarmTrack : HUD.track
    // Truecolor and 256 colors show the track as a background; the other tiers need a glyph.
    const shade = plain || tier === '16'
    let out = ''
    for (let i = 0; i < n; i++) {
      const fg: Col =
        kind === 'alarm' ? HUD.alarmFill
        : kind === 'stale' ? HUD.muted
        : { rgb: gradient((i + 0.5) / n, warn, crit), fg16: sev === 'crit' ? 91 : sev === 'warn' ? 93 : 92, bg16: 0 }
      const filled = i < full || (i === full && part > 0)
      const ch = i < full ? (ascii ? '#' : FULL_BLOCK) : i === full && part ? EIGHTHS[part]! : shade ? (ascii ? '.' : LIGHT_SHADE) : ' '
      out += P(ch, filled ? fg : HUD.muted, track)
    }
    return out
  }

  // "label gauge value". At the critical level the three parts are one alarm block.
  const meter = (label: string, used: number, warn: number, crit: number, sev: Sev, stale: boolean, n: number, bg: Col) => {
    const value = `${used}%${sev === 'crit' ? '!' : ''}`
    if (plain) return [label, gauge(used, warn, crit, sev, n, 'normal'), value].filter(Boolean).join(' ')
    if (sev === 'crit') {
      const edge = (cap: string) => (nerd ? P(cap, asFg(HUD.red), bg) : P(' ', HUD.alarmText, HUD.red))
      return (
        edge(PL_CAP_L) + P(`${label} `, HUD.alarmText, HUD.red, true) + gauge(used, warn, crit, sev, n, 'alarm') +
        P(`${n ? ' ' : ''}${value}`, HUD.alarmText, HUD.red, true) + edge(PL_CAP_R)
      )
    }
    return (
      P(`${label} `, HUD.muted, bg) + gauge(used, warn, crit, sev, n, stale ? 'stale' : 'normal') +
      P(`${n ? ' ' : ''}${value}`, stale ? HUD.muted : sev === 'warn' ? HUD.amber : HUD.text, bg, sev === 'warn')
    )
  }

  // Segments to one line. Two segments of different color need no separator glyph.
  const join = (segs: Seg[]): string => {
    if (plain) return segs.map(x => x.s).join(` ${bar} `)
    const same = (a: Col, b: Col) => (tier === '16' ? a.bg16 === b.bg16 : a.rgb.join() === b.rgb.join())
    let out = nerd ? P(PL_CAP_L, asFg(segs[0]!.bg), null) : ''
    segs.forEach((x, i) => {
      out += x.s
      const next = segs[i + 1]
      if (!next) return
      if (same(x.bg, next.bg)) out += P(nerd ? PL_THIN : bar, HUD.muted, x.bg)
      else if (nerd) out += P(PL_ARROW, asFg(x.bg), next.bg)
    })
    return out + (nerd ? P(PL_CAP_R, asFg(segs[segs.length - 1]!.bg), null) : '')
  }

  const line1 = (d: (typeof DENSITIES)[number]): string => {
    const b1 = HUD.chrome1, b2 = HUD.chrome2
    const segs: Seg[] = [
      seg(b2, v.model ? P((nerd ? `${NERD.model} ` : '') + v.model, HUD.model, b2, true) : P(ell, HUD.muted, b2)),
    ]
    if (v.ctxPct === undefined) segs.push(seg(b1, P(`ctx ${ell}`, HUD.muted, b1)))
    else {
      let ctx = meter('ctx', v.ctxPct, CTX_WARN, CTX_CRIT, sevOf(v.ctxPct, CTX_WARN, CTX_CRIT), false, d.cells, b1)
      if (d.detail && v.ctxCur !== undefined && v.ctxSize !== undefined)
        ctx += P(` ${count(v.ctxCur)}/${count(v.ctxSize)}`, HUD.muted, b1)
      segs.push(seg(b1, ctx))
    }

    const ls = limitsOf(v)
    if (!ls.length) segs.push(seg(b2, P(`week ${ell}`, HUD.muted, b2)))
    else {
      const { own, shared } = placeCountdowns(ls, l => d.countdown || l.sev !== 'ok' || l.stale)
      const countdown = (cd: string, crit: boolean) =>
        P(cd === 'stale' ? 'stale' : nerd ? `${NERD.reset} ${cd}` : `resets ${cd}`, crit ? HUD.text : HUD.muted, b2)
      const items = ls.map((l, i) => {
        let item = meter(l.label, l.used, LIMIT_WARN, LIMIT_CRIT, l.sev, l.stale, d.cells, b2)
        if (own[i]) item += P(' ', HUD.text, b2) + countdown(own[i]!, l.sev === 'crit')
        return item
      })
      if (shared) items.push(countdown(shared, ls.some(l => l.sev === 'crit')))
      const limits = seg(b2, items.join(P('  ', HUD.text, b2)))
      segs.push({ ...limits, s: link(USAGE_URL, limits.s) })
    }

    if (d.cost && v.month) {
      let cost = P(`${MONTHS[v.date.getMonth()]} `, HUD.muted, b1) + P(money(v.month.cost), HUD.text, b1)
      if (d.tokens) cost += P(`  ${count(v.month.tokens)} tok`, HUD.muted, b1)
      segs.push(seg(b1, cost))
    }
    return join(segs)
  }

  // Line 2: [host:]folder (branch) | skill badge | spinner, timer, task label
  const line2 = (path: string, label: string | undefined): string => {
    const b1 = HUD.chrome1, b2 = HUD.chrome2
    let where = v.ssh ? P(`${nerd ? `${NERD.host} ` : ''}${v.host}:`, HUD.muted, b2) : ''
    where += link(v.cwdUrl, P((nerd ? `${NERD.folder} ` : '') + path, HUD.folder, b2))
    if (v.branch) {
      const b = cut(v.branch, BRANCH_MAX, ell)
      where += P(' ', HUD.text, b2) + link(branchUrl(v), P(nerd ? `${NERD.branch} ${b}` : `(${b})`, HUD.branch, b2))
    }
    const segs: Seg[] = [seg(b2, where)]

    const name = v.skill ? cut(skillName(v.skill), SKILL_MAX, ell) : ''
    const badgeText = name ? (nerd ? `${NERD.skill} ${name}` : `/${name}`) : ''
    if (badgeText && !plain) segs.push(seg(HUD.cyan, P(badgeText, HUD.badgeText, HUD.cyan, true)))

    let turn = ''
    if (v.turn) {
      // The frame comes from the clock, not from a render count: renders also come on events.
      if (s.motion && !ascii) turn += P(`${SPIN[v.now % 4]} `, HUD.cyan, b1)
      turn += P(dur(v.turn.seconds), HUD.text, b1, true)
      if (label) turn += P(` ${ascii ? label.replaceAll('…', '...') : label}`, HUD.text, b1)
    }
    // Without color the badge is "[/name]" in the turn segment, as in the quiet style.
    if (plain) turn = [badgeText && `[${badgeText}]`, turn].filter(Boolean).join(' ')
    if (turn) segs.push(seg(b1, turn))
    return join(segs)
  }

  // Line 1: the first density that fits the width budget, else the narrowest.
  let l1 = ''
  for (const d of DENSITIES) {
    l1 = line1(d)
    if (cells(l1) <= s.width) break
  }

  // Line 2: cut the label, then show only the folder's last part, then drop the label.
  const fullLabel = v.turn?.label
  const fitLabel = (path: string): string | undefined => {
    if (!fullLabel) return undefined
    const over = cells(line2(path, fullLabel)) - s.width
    if (over <= 0) return fullLabel
    const room = cells(fullLabel) - over
    return room >= 8 ? cut(fullLabel, room, ell) : undefined
  }
  let path = shortPath(v.cwd, PATH_MAX, ell)
  let label = fitLabel(path)
  if (cells(line2(path, label)) > s.width || (fullLabel && !label)) {
    path = cut(baseName(v.cwd), PATH_MAX, ell)
    label = fitLabel(path)
  }
  return `${l1}\n${line2(path, label)}`
}
