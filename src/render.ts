// The status line: two lines from the JSON Claude Code passes on stdin, the cached usage
// sources, the turn state the hooks write, and the skill file the mod writes. It runs every
// second, so it reads small files only; the slow sources refresh in detached jobs.
//
// It also writes <sid>.view.json, the data of the mod's detail pane, when that changes.

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  IS_WINDOWS, nowSeconds, paths, readIfExists, readJsonIfExists, spawnSelfDetached, writeAtomic,
} from './env.ts'
import { loadSettings, type Settings } from './settings.ts'
import { LIMIT_CRIT, LIMIT_WARN, sevOf, USAGE_URL, type Limit, type View } from './style/common.ts'
import { detectTier, hud } from './style/hud.ts'
import { quiet } from './style/quiet.ts'

export const USAGE_TTL = 30 // seconds between OAuth usage endpoint fetches
export const CCUSAGE_TTL = 600 // seconds between ccusage runs (slow; month totals move slowly)
export const SESSION_ID = /^[A-Za-z0-9_-]+$/

/** What the pane shows beyond the status line (the mod's types/view.d.ts has the file shape). */
export type Extra = {
  ctxInput?: number
  ctxCacheRead?: number
  ctxCacheCreation?: number
  monthKey: string
  previous?: { key: string; cost: number; tokens: number }
  sessionCost?: number
  turnStart?: number
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
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/** The folder with the home folder shown as ~ (case-blind on Windows, as its paths are). */
export function tildify(dir: string, home: string, windows = IS_WINDOWS): string {
  const key = (s: string) => (windows ? s.toLowerCase() : s)
  if (key(dir) === key(home)) return '~'
  const seps = windows ? ['\\', '/'] : ['/']
  return seps.some(s => key(dir).startsWith(key(home) + s)) ? '~' + dir.slice(home.length) : dir
}

/** The branch checked out at dir or above: its name, a short SHA when detached, else undefined. */
export function gitBranch(dir: string): string | undefined {
  let d = resolve(dir)
  let git: string | undefined
  for (;;) {
    const candidate = join(d, '.git')
    if (statSync(candidate, { throwIfNoEntry: false })) {
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

/** The open turn of a session: its start and age, and the task label when it is this turn's. */
function runningTurn(state: string, now: number) {
  const [start, end] = (readIfExists(state) ?? '').trim().split(/\s+/)
  if (!start || end) return undefined
  const [labelStart, label] = (readIfExists(`${state}.summary`) ?? '').replace(/\n$/, '').split('\t')
  return { start: Number(start), seconds: now - Number(start), label: labelStart === start && label ? label : undefined }
}

/** Builds the view from the stdin JSON, the files and the environment. */
export function collect(input: any, now = nowSeconds(), date = new Date(now * 1000), env = process.env) {
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

  // Claude Code's rate_limits first; the OAuth usage endpoint until those arrive.
  const sd = input.rate_limits?.seven_day
  const week: Limit =
    sd?.used_percentage != null
      ? { used: round(sd.used_percentage), resetsAt: epoch(sd.resets_at) }
      : { used: round(usage.seven_day?.utilization), resetsAt: epoch(usage.seven_day?.resets_at) }
  const fableLimit = (usage.limits ?? []).find((l: any) => l?.scope?.model?.display_name === 'Fable')

  const monthKey = monthKeyOf(date)
  const previousKey = monthKeyOf(new Date(date.getFullYear(), date.getMonth() - 1, 1))
  const months: any[] = ccusage?.monthly ?? []
  const mo = months.find(m => m.month === monthKey)
  const prev = months.find(m => m.month === previousKey)

  const sid: string = input.session_id ?? ''
  const turnState = SESSION_ID.test(sid) ? join(p.turns, sid) : undefined
  const turn = turnState ? runningTurn(turnState, now) : undefined
  const skill = turnState ? readIfExists(`${turnState}.skill`)?.trim() || undefined : undefined

  const cwd: string = input.workspace?.current_dir ?? input.cwd ?? process.cwd()
  const ssh = !!(env.SSH_CONNECTION || env.SSH_TTY)
  const repo = input.workspace?.repo
  const view: View = {
    now,
    date,
    model: input.model?.display_name ?? input.model?.id,
    ctxPct: round(pct),
    ctxCur: cur,
    ctxSize: size,
    week,
    fable: { used: round(fableLimit?.percent), resetsAt: epoch(fableLimit?.resets_at) },
    month: ccusage ? { cost: mo?.totalCost ?? 0, tokens: mo?.totalTokens ?? 0 } : undefined,
    turn: turn && { seconds: turn.seconds, label: turn.label },
    host: hostname().split('.')[0]!,
    cwd: tildify(cwd, homedir()),
    branch: gitBranch(cwd),
    ssh,
    skill,
    repoUrl: repo?.host === 'github.com' && repo.owner && repo.name ? `https://github.com/${repo.owner}/${repo.name}` : undefined,
    cwdUrl: ssh ? undefined : pathToFileURL(cwd).href,
  }
  const extra: Extra = {
    ctxInput: num(u?.input_tokens),
    ctxCacheRead: num(u?.cache_read_input_tokens),
    ctxCacheCreation: num(u?.cache_creation_input_tokens),
    monthKey,
    previous: prev && { key: previousKey, cost: prev.totalCost ?? 0, tokens: prev.totalTokens ?? 0 },
    sessionCost: num(input.cost?.total_cost_usd),
    turnStart: turn?.start,
  }
  return { view, extra }
}

/** The two lines in the style the settings select. */
export function format(v: View, s: Settings, env = process.env): string {
  const tier = detectTier(env)
  return s.style === 'quiet' ? quiet(v, s, tier !== 'none') : hud(v, s, tier)
}

/** The content of <sid>.view.json: stable between renders unless something changed. */
export function viewFile(v: View, x: Extra, s: Settings) {
  const limits = ([['Weekly', v.week], ['Fable', v.fable]] as const)
    .filter(([, l]) => l?.used !== undefined)
    .map(([label, l]) => {
      const used = Math.min(100, Math.max(0, l!.used!))
      const stale = l!.resetsAt !== undefined && l!.resetsAt < v.now
      return { label, used, resetsAt: l!.resetsAt, stale, level: stale ? 'ok' : sevOf(used, LIMIT_WARN, LIMIT_CRIT) }
    })
  return {
    version: 1,
    limits,
    context: v.ctxPct === undefined ? undefined : {
      pct: v.ctxPct, used: v.ctxCur, size: v.ctxSize,
      input: x.ctxInput, cacheRead: x.ctxCacheRead, cacheCreation: x.ctxCacheCreation,
    },
    cost: v.month && {
      month: { key: x.monthKey, cost: v.month.cost, tokens: v.month.tokens },
      previous: x.previous,
      session: x.sessionCost,
    },
    session: {
      cwd: v.cwd,
      branch: v.branch,
      skill: v.skill,
      turn: x.turnStart === undefined ? undefined : { start: x.turnStart, label: v.turn?.label },
    },
    settings: s,
    usageUrl: USAGE_URL,
  }
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

/** One render: publishes the session title and the pane's data, returns the lines. */
export function render(stdin: string): string {
  const p = paths()
  const now = nowSeconds()
  mkdirSync(p.turns, { recursive: true })
  writeFileSync(p.input, stdin) // the last payload, to debug
  const input = JSON.parse(stdin)
  const settings = loadSettings()
  const { view, extra } = collect(input, now)

  const sid: string = input.session_id ?? ''
  if (SESSION_ID.test(sid)) {
    // Claude Code's session title (fixed after the first prompt, or set by /rename): context
    // for the Haiku scope label, and what the mod shows until the first label exists.
    const title = join(p.turns, `${sid}.title`)
    if (input.session_name && readIfExists(title)?.trim() !== input.session_name)
      writeAtomic(title, `${input.session_name}\n`)
    const pane = join(p.turns, `${sid}.view.json`)
    const json = JSON.stringify(viewFile(view, extra, settings))
    if (readIfExists(pane) !== json) writeAtomic(pane, json)
  }
  return format(view, settings)
}
