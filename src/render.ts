// The status line itself: two lines from the JSON Claude Code passes on stdin, the cached
// usage sources and the turn state the hooks write. It runs every second, so it reads
// small files only; the slow sources refresh in detached jobs (refresh.ts).

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  IS_WINDOWS, nowSeconds, paths, readIfExists, readJsonIfExists, spawnSelfDetached, writeAtomic,
} from './env.ts'

export const USAGE_TTL = 30 // seconds between OAuth usage endpoint fetches
export const CCUSAGE_TTL = 600 // seconds between ccusage runs (slow; month totals move slowly)
export const SESSION_ID = /^[A-Za-z0-9_-]+$/

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', italic: '\x1b[3m',
  green: '\x1b[0;32m', yellow: '\x1b[0;33m', red: '\x1b[0;31m', magenta: '\x1b[0;35m',
  cyan: '\x1b[1;36m', blue: '\x1b[1;34m', bgreen: '\x1b[1;32m', byellow: '\x1b[1;33m',
}
const sep = ` ${c.dim}│${c.reset} `
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Everything one render shows, gathered from stdin, caches and turn files. */
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
  user: string
  host: string
  cwd: string // as shown, with the home folder as ~
  branch?: string
}
export type Limit = { used?: number; resetsAt?: number }

/** Severity color of a used percentage: more used is worse. */
export const sev = (pct: number) => (pct < 50 ? c.green : pct < 80 ? c.yellow : c.red)

/** "4d19h" / "2h05m" / "3m07s" / "42s" */
export function dur(s: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`
  if (s >= 60) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
  return `${s}s`
}

/** 69120000 -> "69.1M", the way the month segment shows token counts. */
export function human(n: number): string {
  if (n >= 1e9) return `${Math.floor(n / 1e8) / 10}B`
  if (n >= 1e6) return `${Math.floor(n / 1e5) / 10}M`
  if (n >= 1e3) return `${Math.floor(n / 1e3)}K`
  return String(n)
}

/** A reset time as epoch seconds, from epoch seconds, epoch milliseconds or an ISO date. */
export function epoch(v: unknown): number | undefined {
  if (typeof v === 'number') return Math.floor(v > 1e11 ? v / 1000 : v)
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
  }
  return undefined
}

const round = (v: unknown) => (typeof v === 'number' ? Math.floor(v + 0.5) : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

/** "label NN% left ⟳countdown", or "label …" before the source has data. */
function limitSegment(label: string, l: Limit | undefined, now: number): string {
  if (l?.used === undefined) return `${c.dim}${label} …${c.reset}`
  const left = Math.max(0, 100 - l.used)
  // A reset in the past means the data predates the reset: say so, not "0m".
  const countdown = l.resetsAt === undefined ? '--' : l.resetsAt < now ? 'stale' : dur(l.resetsAt - now)
  return `${c.dim}${label}${c.reset} ${sev(l.used)}${left}% left${c.reset} ${c.dim}⟳${countdown}${c.reset}`
}

/** The two lines, ready to print. The second ends with "$ " and no newline. */
export function format(v: View): string {
  let line1 = `${c.cyan}${v.model ?? '?'}${c.reset}${sep}`
  if (v.ctxPct !== undefined) {
    line1 += `${c.dim}ctx${c.reset} ${sev(v.ctxPct)}${v.ctxPct}%${c.reset}`
    if (v.ctxCur !== undefined && v.ctxSize !== undefined)
      line1 += ` ${c.dim}${Math.floor(v.ctxCur / 1000)}k/${Math.floor(v.ctxSize / 1000)}k${c.reset}`
  } else {
    line1 += `${c.dim}ctx …${c.reset}`
  }
  line1 += sep + limitSegment('7d', v.week, v.now)
  line1 += '  ' + limitSegment('Fable', v.fable, v.now)
  line1 += v.month
    ? `${sep}${c.bold}${c.bgreen}$${v.month.cost.toFixed(2)}${c.reset} ${c.dim}·${c.reset} ` +
      `${human(v.month.tokens)} tok ${c.dim}(${MONTHS[v.date.getMonth()]})${c.reset}`
    : `${sep}${c.dim}$… mo${c.reset}`

  const pad = (n: number) => String(n).padStart(2, '0')
  const d = v.date
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  let turn = ''
  if (v.turn) {
    turn = ` ${c.byellow}⏱ ${dur(v.turn.seconds)}${c.reset}`
    if (v.turn.label) turn += ` ${c.italic}${v.turn.label}${c.reset}`
    turn += ` ${c.dim}│${c.reset}`
  }
  const git = v.branch ? ` ${c.magenta}(${v.branch})${c.reset}` : ''
  return (
    `${line1}\n${c.dim}${clock}${c.reset}${turn} ` +
    `${c.bgreen}${v.user}@${v.host}${c.reset}:${c.blue}${v.cwd}${c.reset}${git}$ `
  )
}

/** The branch checked out at dir or above: its name, a short SHA when detached, else undefined. */
export function gitBranch(dir: string): string | undefined {
  let d = resolve(dir)
  let git: string | undefined
  for (;;) {
    const candidate = join(d, '.git')
    if (exists(candidate)) {
      git = candidate
      break
    }
    if (dirname(d) === d) return undefined
    d = dirname(d)
  }
  if (statSync(git).isFile()) {
    // A worktree or submodule: .git is a file "gitdir: <path>".
    const target = readIfExists(git)!.replace(/^gitdir:\s*/, '').trim()
    git = isAbsolute(target) ? target : join(d, target)
  }
  const head = readIfExists(join(git, 'HEAD'))?.trim()
  if (!head) return undefined
  if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
  if (head.startsWith('ref: ')) return head.slice('ref: '.length)
  return head.substring(0, 7)
}

function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined
}

/** Builds the View from the stdin JSON and the files. Pure apart from reading files. */
export function collect(input: any, now = nowSeconds(), date = new Date(now * 1000)): View {
  const p = paths()
  const usage = readJsonIfExists(p.usage) ?? {}
  const ccusage = readJsonIfExists(p.ccusage)

  const cw = input.context_window ?? {}
  const u = cw.current_usage
  const cur = u
    ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    : undefined
  const size = num(cw.context_window_size)
  const pct = cw.used_percentage ?? (cur !== undefined && size ? (cur * 100) / size : undefined)

  // Claude Code's rate_limits first; the OAuth usage endpoint until those are populated.
  const sd = input.rate_limits?.seven_day
  const week: Limit =
    sd?.used_percentage != null
      ? { used: round(sd.used_percentage), resetsAt: epoch(sd.resets_at) }
      : { used: round(usage.seven_day?.utilization), resetsAt: epoch(usage.seven_day?.resets_at) }
  const fableLimit = (usage.limits ?? []).find((l: any) => l?.scope?.model?.display_name === 'Fable')

  const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  const mo = ccusage ? (ccusage.monthly ?? []).find((m: any) => m.month === monthKey) : undefined

  const sid: string = input.session_id ?? ''
  const home = homedir()
  const cwd: string = input.workspace?.current_dir ?? input.cwd ?? process.cwd()
  return {
    now,
    date,
    model: input.model?.display_name ?? input.model?.id,
    ctxPct: round(pct),
    ctxCur: cur,
    ctxSize: size,
    week,
    fable: { used: round(fableLimit?.percent), resetsAt: epoch(fableLimit?.resets_at) },
    month: ccusage ? { cost: mo?.totalCost ?? 0, tokens: mo?.totalTokens ?? 0 } : undefined,
    turn: SESSION_ID.test(sid) ? runningTurn(join(p.turns, sid), now) : undefined,
    user: process.env.USER || process.env.LOGNAME || userInfo().username,
    host: hostname().split('.')[0]!,
    cwd: tildify(cwd, home),
    branch: gitBranch(cwd),
  }
}

/** The folder with the home folder shown as ~ (case-blind on Windows, as its paths are). */
export function tildify(dir: string, home: string, windows = IS_WINDOWS): string {
  const key = (s: string) => (windows ? s.toLowerCase() : s)
  if (key(dir) === key(home)) return '~'
  const seps = windows ? ['\\', '/'] : ['/']
  return seps.some(s => key(dir).startsWith(key(home) + s)) ? '~' + dir.slice(home.length) : dir
}

/** The open turn of a session: its age, and the Haiku task label when it is for this turn. */
function runningTurn(state: string, now: number): View['turn'] {
  const [start, end] = (readIfExists(state) ?? '').trim().split(/\s+/)
  if (!start || end) return undefined
  const [labelStart, label] = (readIfExists(`${state}.summary`) ?? '').replace(/\n$/, '').split('\t')
  return { seconds: now - Number(start), label: labelStart === start && label ? label : undefined }
}

/** True, and the stamp renewed, when the last attempt is older than ttl seconds. */
function due(stamp: string, ttl: number, now: number): boolean {
  if (now - Number(readIfExists(stamp) ?? 0) < ttl) return false
  writeFileSync(stamp, `${now}\n`)
  return true
}

/** Starts the refreshes whose last attempt is older than their TTL, detached. */
export function startDueRefreshes(now = nowSeconds()) {
  const p = paths()
  mkdirSync(p.cache, { recursive: true })
  if (due(join(p.cache, '.usage.stamp'), USAGE_TTL, now)) spawnSelfDetached(['--refresh-usage'])
  if (due(join(p.cache, '.ccusage.stamp'), CCUSAGE_TTL, now)) spawnSelfDetached(['--refresh-ccusage'])
}

/** One render: publishes the session title and returns the lines. */
export function render(stdin: string): string {
  const p = paths()
  const now = nowSeconds()
  mkdirSync(p.turns, { recursive: true })
  writeFileSync(p.input, stdin) // the last payload, to debug
  const input = JSON.parse(stdin)

  // Publish Claude Code's session title (fixed after the first prompt, or set by /rename):
  // context for the Haiku scope label, and what the session-scope mod shows until the
  // first label exists. The mod API has no getter for it. Written only when it changes.
  const sid: string = input.session_id ?? ''
  if (input.session_name && SESSION_ID.test(sid)) {
    const title = join(p.turns, `${sid}.title`)
    if (readIfExists(title)?.trim() !== input.session_name) writeAtomic(title, `${input.session_name}\n`)
  }
  return format(collect(input, now))
}
