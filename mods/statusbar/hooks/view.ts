import type { ViewFile } from '../types'
import { parseObject } from './files'

// The view file is the binary's: check it against the contract in types/index.d.ts, and say
// which field is wrong, so that a binary and a mod of different versions show the fault
// instead of a pane of wrong numbers.

type Json = Record<string, unknown>

function fail(path: string, want: string): never {
  throw new Error(`${path} is not ${want}`)
}

const obj = (v: unknown, path: string): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : fail(path, 'an object')
const num = (v: unknown, path: string) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(path, 'a number'))
const str = (v: unknown, path: string) => (typeof v === 'string' ? v : fail(path, 'a string'))
const bool = (v: unknown, path: string) => (typeof v === 'boolean' ? v : fail(path, 'true or false'))
const oneOf = <T extends string>(v: unknown, path: string, values: readonly T[]) =>
  values.includes(v as T) ? (v as T) : fail(path, values.join(' or '))
const opt = <T>(v: unknown, path: string, check: (v: unknown, path: string) => T) =>
  v === undefined ? undefined : check(v, path)

const month = (v: unknown, path: string) => {
  const m = obj(v, path)
  return { key: str(m.key, `${path}.key`), cost: num(m.cost, `${path}.cost`), tokens: num(m.tokens, `${path}.tokens`) }
}

export function parseView(text: string): ViewFile {
  const v = parseObject(text)
  if (v.version !== 1) fail('version', '1')

  if (!Array.isArray(v.limits)) fail('limits', 'a list')
  const limits = v.limits.map((x: unknown, i: number) => {
    const p = `limits[${i}]`
    const l = obj(x, p)
    return {
      label: str(l.label, `${p}.label`),
      used: num(l.used, `${p}.used`),
      resetsAt: opt(l.resetsAt, `${p}.resetsAt`, num),
      stale: bool(l.stale, `${p}.stale`),
      level: oneOf(l.level, `${p}.level`, ['ok', 'warn', 'crit'] as const),
    }
  })

  const context = opt(v.context, 'context', (x, p) => {
    const c = obj(x, p)
    return {
      pct: num(c.pct, `${p}.pct`),
      used: opt(c.used, `${p}.used`, num),
      size: opt(c.size, `${p}.size`, num),
      input: opt(c.input, `${p}.input`, num),
      cacheRead: opt(c.cacheRead, `${p}.cacheRead`, num),
      cacheCreation: opt(c.cacheCreation, `${p}.cacheCreation`, num),
    }
  })

  const cost = opt(v.cost, 'cost', (x, p) => {
    const c = obj(x, p)
    return {
      month: month(c.month, `${p}.month`),
      previous: opt(c.previous, `${p}.previous`, month),
      session: opt(c.session, `${p}.session`, num),
    }
  })

  const s = obj(v.session, 'session')
  const session = {
    cwd: str(s.cwd, 'session.cwd'),
    branch: opt(s.branch, 'session.branch', str),
    skill: opt(s.skill, 'session.skill', str),
    turn: opt(s.turn, 'session.turn', (x, p) => {
      const t = obj(x, p)
      return { start: num(t.start, `${p}.start`), label: opt(t.label, `${p}.label`, str) }
    }),
  }

  const g = obj(v.settings, 'settings')
  const settings = {
    style: oneOf(g.style, 'settings.style', ['hud', 'quiet'] as const),
    glyphs: oneOf(g.glyphs, 'settings.glyphs', ['unicode', 'ascii', 'nerd'] as const),
    motion: bool(g.motion, 'settings.motion'),
    links: bool(g.links, 'settings.links'),
    width: num(g.width, 'settings.width'),
  }

  return { version: 1, limits, context, cost, session, settings, usageUrl: str(v.usageUrl, 'usageUrl') }
}
