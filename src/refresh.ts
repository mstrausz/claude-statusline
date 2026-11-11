// Background refreshes of the slow sources, started detached by the render when due.
// One run at a time per source (a lock); a result is published only when it is complete.

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { bunArgv, logError, oauthToken, paths, withLock, writeAtomic } from './env.ts'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_SECONDS = 15 // the render starts the next attempt 30 s later

/** The subscription's rate-limit windows, from the OAuth usage endpoint. */
export async function refreshUsage() {
  const p = paths()
  await withLock(join(p.cache, '.usage.lock'), async () => {
    const token = oauthToken()
    if (!token) return // signed out: the segment shows "…"
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(USAGE_SECONDS * 1000),
    })
    if (res.status === 429) {
      // The endpoint lets about one request in five through, with "retry-after: 0": an
      // expected answer, so one line without a stack, which says how old the kept data is.
      const kept = statSync(p.usage, { throwIfNoEntry: false })
      logError('refresh-usage', `rate limited (429, retry-after ${res.headers.get('retry-after') ?? 'none'}); ` +
        `the limits stay from ${kept ? new Date(kept.mtimeMs).toISOString() : 'no earlier fetch'}`)
      return
    }
    const body: any = await res.json()
    // Accept any response with weekly data (five_hour can be null).
    if ((body?.seven_day ?? body?.limits) == null)
      throw new Error(`usage endpoint answered ${res.status} without weekly data`)
    writeAtomic(p.usage, JSON.stringify(body))
  })
}

/** This month's cost and tokens on this machine, from ccusage, run by the built-in bun. */
export async function refreshCcusage() {
  const p = paths()
  await withLock(join(p.cache, '.ccusage.lock'), async () => {
    const { argv, env } = bunArgv()
    const r = spawnSync(argv[0]!, [...argv.slice(1), 'x', 'ccusage@latest', 'claude', 'monthly', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`ccusage exited with ${r.status}: ${r.stderr.trim()}`)
    const body = JSON.parse(r.stdout)
    if (!body?.monthly) throw new Error('ccusage output has no monthly data')
    writeAtomic(p.ccusage, JSON.stringify(body))
  })
}

/** Runs a refresh job; a detached job has no terminal, so its errors go to the log. */
export async function runJob(name: string, job: () => Promise<void>) {
  try {
    await job()
  } catch (e) {
    logError(name, e)
  }
}
