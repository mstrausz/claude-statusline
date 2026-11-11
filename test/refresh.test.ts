import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshUsage } from '../src/refresh.ts'
import { tempConfig } from './helpers.ts'

describe('refreshUsage', () => {
  const cfg = tempConfig()
  const realFetch = globalThis.fetch
  afterEach(() => void (globalThis.fetch = realFetch))
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status, headers })) as any)
  // fetch is a mock, so no token leaves the machine (on macOS a Keychain token comes first).
  const signIn = () => writeFileSync(join(cfg.dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
  const cache = () => join(cfg.dir, 'cache', 'statusline-usage.json')
  const log = () => readFileSync(join(cfg.dir, 'cache', 'statusline.log'), 'utf8')

  test('a good answer replaces the cache', async () => {
    signIn()
    answer(200, { seven_day: { utilization: 46 } })
    await refreshUsage()
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toEqual({ seven_day: { utilization: 46 } })
  })

  test('a 429 keeps the cache and logs one line that says from when the kept data is', async () => {
    signIn()
    mkdirSync(join(cfg.dir, 'cache'), { recursive: true })
    writeFileSync(cache(), '{"seven_day":{"utilization":40}}')
    answer(429, { error: 'rate_limited' }, { 'retry-after': '0' })
    await refreshUsage()
    expect(readFileSync(cache(), 'utf8')).toBe('{"seven_day":{"utilization":40}}')
    expect(log()).toMatch(/refresh-usage: rate limited \(429, retry-after 0\); the limits stay from \d{4}-/)
    expect(log().trim().split('\n')).toHaveLength(1) // no stack trace
  })

  test('an answer without weekly data is an error and keeps no cache', async () => {
    signIn()
    answer(500, { error: 'boom' })
    await expect(refreshUsage()).rejects.toThrow('usage endpoint answered 500 without weekly data')
    expect(existsSync(cache())).toBe(false)
  })
})
