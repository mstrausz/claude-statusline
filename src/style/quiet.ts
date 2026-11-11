// The "quiet" style (directions.md section 2): two lines, the 16 terminal colors, a hue only
// where something needs attention. Every percentage is the part used.

import type { Settings } from '../settings.ts'
import {
  BRANCH_MAX, branchUrl, CTX_CRIT, CTX_WARN, MONTHS, PATH_MAX, SKILL_MAX, USAGE_URL, count, cut, dur,
  limitsOf, money, osc8, placeCountdowns, sevOf, shortPath, skillName, type Sev, type View,
} from './common.ts'

const GLYPHS = {
  // Claude Code prints │ · … in its own interface, so every font it runs with has them.
  unicode: { sep: '│', minor: ' · ', ell: '…' },
  ascii: { sep: '|', minor: '  ', ell: '...' },
}

export function quiet(v: View, s: Settings, color: boolean): string {
  const g = GLYPHS[s.glyphs === 'ascii' ? 'ascii' : 'unicode']
  const p = (codes: string, text: string) => (color && text ? `\x1b[${codes}m${text}\x1b[0m` : text)
  const link = (url: string | undefined, text: string) => (s.links && color && url ? osc8(url, text) : text)
  const muted = (text: string) => p('2', text)
  const SEP = ` ${muted(g.sep)} `
  const MINOR = g.minor === '  ' ? '  ' : ` ${muted(g.minor.trim())} `
  const value = (used: number, sev: Sev) =>
    sev === 'crit' ? p('1;91', `${used}%!`) : sev === 'warn' ? p('33', `${used}%`) : `${used}%`

  // Line 1: model | context | limits | month cost
  const segs: string[] = [v.model ? p('1', v.model) : muted(g.ell)]

  if (v.ctxPct === undefined) segs.push(muted(`ctx ${g.ell}`))
  else {
    let ctx = `${muted('ctx')} ${value(v.ctxPct, sevOf(v.ctxPct, CTX_WARN, CTX_CRIT))}`
    if (v.ctxCur !== undefined && v.ctxSize !== undefined) ctx += ` ${muted(`${count(v.ctxCur)}/${count(v.ctxSize)}`)}`
    segs.push(ctx)
  }

  const ls = limitsOf(v)
  if (!ls.length) segs.push(muted(`week ${g.ell}`))
  else {
    const { own, shared } = placeCountdowns(ls, () => true)
    // The countdown of a critical limit has the default foreground, not the muted one.
    const countdown = (cd: string, crit: boolean) => {
      const text = cd === 'stale' ? 'stale' : `resets ${cd}`
      return crit ? text : muted(text)
    }
    const items = ls.map((l, i) => {
      let item = l.stale ? muted(`${l.label} ${l.used}%`) : `${muted(l.label)} ${value(l.used, l.sev)}`
      if (own[i]) item += ` ${countdown(own[i]!, l.sev === 'crit')}`
      return item
    })
    if (shared) items.push(countdown(shared, ls.some(l => l.sev === 'crit')))
    segs.push(link(USAGE_URL, items.join(MINOR)))
  }

  if (v.month) segs.push(`${muted(MONTHS[v.date.getMonth()]!)} ${money(v.month.cost)}`)

  // Line 2: [host:]folder (branch) | skill badge, timer, task label
  let where = (v.ssh ? muted(`${v.host}:`) : '') + link(v.cwdUrl, shortPath(v.cwd, PATH_MAX, g.ell))
  if (v.branch) where += ` ${link(branchUrl(v), p('94', `(${cut(v.branch, BRANCH_MAX, g.ell)})`))}`
  const line2 = [where]

  // The badge: black on cyan with a pad space on each side; without color, brackets of the
  // same width. Never bold: bold black is gray where bold uses the bright color.
  const name = v.skill ? cut(skillName(v.skill), SKILL_MAX, g.ell) : ''
  const badge = name ? (color ? `\x1b[30;46m /${name} \x1b[0m` : `[/${name}]`) : ''
  const timer = v.turn ? p('1', dur(v.turn.seconds)) + (v.turn.label ? ` ${v.turn.label}` : '') : ''
  const turn = [badge, timer].filter(Boolean).join(' ')
  if (turn) line2.push(turn)

  return `${segs.join(SEP)}\n${line2.join(SEP)}`
}
