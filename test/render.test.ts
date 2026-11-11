import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collect, dur, epoch, format, gitBranch, human, tildify, type View } from '../src/render.ts'
import { plain, tempConfig } from './helpers.ts'

const NOW = 1_794_400_000
const DATE = new Date(2026, 10, 11, 14, 56, 5) // local time, Nov

const view = (v: Partial<View> = {}): View => ({
  now: NOW, date: DATE, user: 'me', host: 'box', cwd: '~/project', ...v,
})

describe('format', () => {
  test('every segment with data', () => {
    const out = plain(format(view({
      model: 'Opus 5.5', ctxPct: 7, ctxCur: 74_000, ctxSize: 1_000_000,
      week: { used: 46, resetsAt: NOW + 4 * 86400 + 19 * 3600 },
      fable: { used: 27, resetsAt: NOW + 4 * 86400 + 19 * 3600 },
      month: { cost: 25.951, tokens: 69_120_000 },
      turn: { seconds: 83, label: 'Fix tariff import' },
      branch: 'main',
    })))
    expect(out).toBe(
      'Opus 5.5 │ ctx 7% 74k/1000k │ 7d 54% left ⟳4d19h  Fable 73% left ⟳4d19h │ $25.95 · 69.1M tok (Nov)\n' +
      '14:56:05 ⏱ 1m23s Fix tariff import │ me@box:~/project (main)$ ',
    )
  })

  test('sources without data show an ellipsis', () => {
    expect(plain(format(view()))).toBe('? │ ctx … │ 7d …  Fable … │ $… mo\n14:56:05 me@box:~/project$ ')
  })

  test('a reset in the past is stale, an unknown reset is --', () => {
    const out = plain(format(view({ week: { used: 100, resetsAt: NOW - 1 }, fable: { used: 120 } })))
    expect(out).toContain('7d 0% left ⟳stale')
    expect(out).toContain('Fable 0% left ⟳--')
  })

  test('severity colors: green under 50, yellow under 80, red from 80', () => {
    expect(format(view({ ctxPct: 49 }))).toContain('\x1b[0;32m49%')
    expect(format(view({ ctxPct: 50 }))).toContain('\x1b[0;33m50%')
    expect(format(view({ ctxPct: 80 }))).toContain('\x1b[0;31m80%')
  })
})

test('dur', () => {
  expect([42, 187, 7500, 86400 * 4 + 3600 * 19 + 5].map(dur)).toEqual(['42s', '3m07s', '2h05m', '4d19h'])
})

test('human', () => {
  expect([999, 1500, 69_120_000, 70_000_000, 2_340_000_000].map(human)).toEqual(['999', '1K', '69.1M', '70M', '2.3B'])
})

test('epoch reads seconds, milliseconds and ISO dates', () => {
  expect(epoch(1_794_400_000)).toBe(1_794_400_000)
  expect(epoch(1_794_400_000_123)).toBe(1_794_400_000)
  expect(epoch('2026-11-11T12:00:00.123456+00:00')).toBe(Date.UTC(2026, 10, 11, 12) / 1000)
  expect(epoch('not a date')).toBeUndefined()
  expect(epoch(null)).toBeUndefined()
})

test('tildify', () => {
  expect(tildify('/home/me/p', '/home/me', false)).toBe('~/p')
  expect(tildify('/home/me', '/home/me', false)).toBe('~')
  expect(tildify('/home/meadow', '/home/me', false)).toBe('/home/meadow')
  expect(tildify('c:\\users\\me\\p', 'C:\\Users\\Me', true)).toBe('~\\p')
  expect(tildify('D:\\p', 'C:\\Users\\Me', true)).toBe('D:\\p')
})

describe('with files', () => {
  const cfg = tempConfig()

  test('gitBranch: a branch, a detached HEAD, a worktree, no repo', () => {
    const repo = join(cfg.dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
    expect(gitBranch(join(repo, 'sub', 'deep'))).toBe('feature/x')

    writeFileSync(join(repo, '.git', 'HEAD'), '0972cfe0123456789\n')
    expect(gitBranch(repo)).toBe('0972cfe')

    const wt = join(cfg.dir, 'wt')
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/wt-branch\n')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
    expect(gitBranch(wt)).toBe('wt-branch')

    expect(gitBranch(join(cfg.dir, 'nothing-here'))).toBeUndefined()
  })

  test('collect: rate_limits first, the usage cache for the rest, this month from ccusage', () => {
    mkdirSync(join(cfg.dir, 'cache', 'turns'), { recursive: true })
    writeFileSync(join(cfg.dir, 'cache', 'statusline-usage.json'), JSON.stringify({
      seven_day: { utilization: 90, resets_at: '2026-11-15T00:00:00Z' },
      limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 26.6, resets_at: '2026-11-15T00:00:00Z' }],
    }))
    writeFileSync(join(cfg.dir, 'cache', 'statusline-ccusage.json'), JSON.stringify({
      monthly: [{ month: '2026-10', totalCost: 1, totalTokens: 1 }, { month: '2026-11', totalCost: 25.95, totalTokens: 69_120_000 }],
    }))
    writeFileSync(join(cfg.dir, 'cache', 'turns', 'sid-1'), `${NOW - 83}\n`)
    writeFileSync(join(cfg.dir, 'cache', 'turns', 'sid-1.summary'), `${NOW - 83}\tFix tariff import\n`)

    const v = collect({
      session_id: 'sid-1',
      model: { display_name: 'Opus 5.5' },
      workspace: { current_dir: cfg.dir },
      context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 70_000, cache_read_input_tokens: 4_000 } },
      rate_limits: { seven_day: { used_percentage: 45.6, resets_at: NOW + 3600 } },
    }, NOW, DATE)
    expect(v.ctxPct).toBe(7) // 74k of 1000k, computed: no used_percentage given
    expect(v.week).toEqual({ used: 46, resetsAt: NOW + 3600 })
    expect(v.fable).toEqual({ used: 27, resetsAt: Date.UTC(2026, 10, 15) / 1000 })
    expect(v.month).toEqual({ cost: 25.95, tokens: 69_120_000 })
    expect(v.turn).toEqual({ seconds: 83, label: 'Fix tariff import' })
  })

  test('collect: a label of an earlier turn is not shown, a closed turn has no timer', () => {
    mkdirSync(join(cfg.dir, 'cache', 'turns'), { recursive: true })
    writeFileSync(join(cfg.dir, 'cache', 'turns', 'a'), `${NOW - 10}\n`)
    writeFileSync(join(cfg.dir, 'cache', 'turns', 'a.summary'), `${NOW - 999}\tOld label\n`)
    writeFileSync(join(cfg.dir, 'cache', 'turns', 'b'), `${NOW - 10} ${NOW - 5}\n`)
    expect(collect({ session_id: 'a' }, NOW, DATE).turn).toEqual({ seconds: 10, label: undefined })
    expect(collect({ session_id: 'b' }, NOW, DATE).turn).toBeUndefined()
    expect(collect({ session_id: '../escape' }, NOW, DATE).turn).toBeUndefined()
  })
})
