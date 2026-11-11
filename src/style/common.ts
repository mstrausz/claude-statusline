// Rules that both styles share: the view, numbers, severity levels, limits, paths, the
// skill badge name, links and cell widths. The design is in the design folder's
// directions.md: section 1 for the rules, 2 for quiet, 9 for hud, 12 for links.

export type Limit = { used?: number; resetsAt?: number }

/** Everything one render shows. collect() in render.ts builds it. */
export type View = {
  now: number // epoch seconds
  date: Date
  model?: string
  ctxPct?: number
  ctxCur?: number
  ctxSize?: number
  week?: Limit
  fable?: Limit
  month?: { cost: number; tokens: number }
  turn?: { seconds: number; label?: string }
  host: string
  cwd: string // with the home folder as ~
  branch?: string
  ssh: boolean
  skill?: string // as Claude Code names it, e.g. "frontend-design:frontend-design"
  repoUrl?: string // https://github.com/<owner>/<name>
  cwdUrl?: string // file:// address of the folder; none in an SSH session
}

export type Sev = 'ok' | 'warn' | 'crit'
export const CTX_WARN = 50
export const CTX_CRIT = 80 // percent of the context window used
export const LIMIT_WARN = 70
export const LIMIT_CRIT = 90 // percent of a subscription limit used
export const sevOf = (used: number, warn: number, crit: number): Sev =>
  used >= crit ? 'crit' : used >= warn ? 'warn' : 'ok'

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const USAGE_URL = 'https://claude.ai/settings/usage'
export const PATH_MAX = 28
export const BRANCH_MAX = 24
export const SKILL_MAX = 28

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

// Escape sequences take no cells: SGR colors and OSC 8 links.
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g
export const strip = (s: string) => s.replace(ESCAPES, '')
/** Terminal cells of a text: escape sequences take none, a CJK character takes two. */
export const cells = (s: string) => Bun.stringWidth(strip(s))

/** At most max cells of plain text: its start and the ellipsis. */
export function cut(s: string, max: number, ell: string): string {
  if (cells(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (cells(out + ch) + cells(ell) > max) break
    out += ch
  }
  return out + ell
}

/** "~/a/b/c/d/e" -> "~/…/d/e": the first part, an ellipsis, the last parts that fit in max. */
export function shortPath(p: string, max: number, ell: string): string {
  if (cells(p) <= max) return p
  const s = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  const parts = p.split(s)
  const head = parts[0]! // "~", "" for the root, or "C:"
  let tail = [parts[parts.length - 1]!]
  for (let i = parts.length - 2; i > 0; i--) {
    if (cells([head, ell, parts[i]!, ...tail].join(s)) > max) break
    tail = [parts[i]!, ...tail]
  }
  return cut([head, ell, ...tail].join(s), max, ell)
}

/** The last part of a path: "~" stays "~", the root stays as it is. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1]! : p
}

/** "frontend-design:frontend-design" -> "frontend-design": the part after the last colon. */
export const skillName = (raw: string) => raw.trim().replace(/^\//, '').split(':').pop()!

/** An OSC 8 hyperlink around text: ESC ] 8 ; ; url ESC \ text ESC ] 8 ; ; ESC \ */
export const osc8 = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

/** The branch's page, for a GitHub repository only (other hosts use other addresses). */
export const branchUrl = (v: View) => (v.repoUrl && v.branch ? `${v.repoUrl}/tree/${encodeURI(v.branch)}` : undefined)

/** A limit that has data, ready to draw. */
export type Lim = { label: string; used: number; sev: Sev; stale: boolean; countdown?: string }

/** The limits that have data. A limit without data is not drawn. */
export function limitsOf(v: View): Lim[] {
  const out: Lim[] = []
  for (const [label, l] of [['week', v.week], ['Fable', v.fable]] as const) {
    if (l?.used === undefined) continue
    const used = Math.min(100, Math.max(0, l.used))
    // A reset in the past: the number predates the reset, so it carries no alarm.
    const stale = l.resetsAt !== undefined && l.resetsAt < v.now
    out.push({
      label, used, stale,
      sev: stale ? 'ok' : sevOf(used, LIMIT_WARN, LIMIT_CRIT),
      countdown: stale ? 'stale' : l.resetsAt === undefined ? undefined : dur(l.resetsAt - v.now),
    })
  }
  return out
}

/**
 * Where the reset countdowns go; `wants` says which limits show one. When every limit shows
 * one and all are equal, it is printed once after the group (`shared`), else each after its
 * own limit (`own`).
 */
export function placeCountdowns(ls: Lim[], wants: (l: Lim) => boolean) {
  const own = ls.map(l => (wants(l) ? l.countdown : undefined))
  if (ls.length > 1 && own.every(x => x !== undefined && x === own[0]))
    return { own: ls.map((): string | undefined => undefined), shared: own[0] }
  return { own, shared: undefined as string | undefined }
}
