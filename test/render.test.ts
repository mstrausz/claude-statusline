import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collect, epoch, gitBranch, render, tildify, viewFile } from '../src/render.ts'
import { DEFAULTS } from '../src/settings.ts'
import { strip } from '../src/style/common.ts'
import { tempConfig } from './helpers.ts'

const NOW = 1_794_400_000
const DATE = new Date(2026, 10, 11, 14, 56, 5) // local time, Nov

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
  const turns = () => join(cfg.dir, 'cache', 'turns')

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

  test('collect: rate_limits first, the usage cache for the rest, this month and the one before', () => {
    mkdirSync(turns(), { recursive: true })
    writeFileSync(join(cfg.dir, 'cache', 'statusline-usage.json'), JSON.stringify({
      seven_day: { utilization: 90, resets_at: '2026-11-15T00:00:00Z' },
      limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 26.6, resets_at: '2026-11-15T00:00:00Z' }],
    }))
    writeFileSync(join(cfg.dir, 'cache', 'statusline-ccusage.json'), JSON.stringify({
      monthly: [{ month: '2026-10', totalCost: 212.4, totalTokens: 540_200_000 }, { month: '2026-11', totalCost: 25.95, totalTokens: 69_120_000 }],
    }))
    writeFileSync(join(turns(), 'sid-1'), `${NOW - 83}\n`)
    writeFileSync(join(turns(), 'sid-1.summary'), `${NOW - 83}\tFix tariff import\n`)
    writeFileSync(join(turns(), 'sid-1.skill'), 'frontend-design:frontend-design\n')

    const { view: v, extra: x } = collect({
      session_id: 'sid-1',
      model: { display_name: 'Opus 5.5' },
      workspace: { current_dir: cfg.dir, repo: { host: 'github.com', owner: 'example', name: 'project' } },
      context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 70_000, cache_read_input_tokens: 4_000 } },
      rate_limits: { seven_day: { used_percentage: 45.6, resets_at: NOW + 3600 } },
      cost: { total_cost_usd: 1.84 },
    }, NOW, DATE, {})
    expect(v.ctxPct).toBe(7) // 74k of 1000k, computed: no used_percentage given
    expect(v.week).toEqual({ used: 46, resetsAt: NOW + 3600 })
    expect(v.fable).toEqual({ used: 27, resetsAt: Date.UTC(2026, 10, 15) / 1000 })
    expect(v.month).toEqual({ cost: 25.95, tokens: 69_120_000 })
    expect(v.turn).toEqual({ seconds: 83, label: 'Fix tariff import' })
    expect(v.skill).toBe('frontend-design:frontend-design')
    expect(v.repoUrl).toBe('https://github.com/example/project')
    expect(v.cwdUrl).toStartWith('file:///')
    expect(v.ssh).toBe(false)
    expect(x).toMatchObject({ ctxInput: 70_000, ctxCacheRead: 4_000, sessionCost: 1.84, turnStart: NOW - 83, monthKey: '2026-11' })
    expect(x.previous).toEqual({ key: '2026-10', cost: 212.4, tokens: 540_200_000 })
  })

  test('collect: no folder link in an SSH session, no branch link off GitHub, no skill when the file is empty', () => {
    mkdirSync(turns(), { recursive: true })
    writeFileSync(join(turns(), 's.skill'), '\n')
    const { view: v } = collect(
      { session_id: 's', workspace: { current_dir: cfg.dir, repo: { host: 'gitlab.com', owner: 'g', name: 'p' } } },
      NOW, DATE, { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' },
    )
    expect(v.ssh).toBe(true)
    expect(v.cwdUrl).toBeUndefined()
    expect(v.repoUrl).toBeUndefined()
    expect(v.skill).toBeUndefined()
  })

  test('collect: a label of an earlier turn is not shown, a closed turn has no timer', () => {
    mkdirSync(turns(), { recursive: true })
    writeFileSync(join(turns(), 'a'), `${NOW - 10}\n`)
    writeFileSync(join(turns(), 'a.summary'), `${NOW - 999}\tOld label\n`)
    writeFileSync(join(turns(), 'b'), `${NOW - 10} ${NOW - 5}\n`)
    expect(collect({ session_id: 'a' }, NOW, DATE, {}).view.turn).toEqual({ seconds: 10, label: undefined })
    expect(collect({ session_id: 'b' }, NOW, DATE, {}).view.turn).toBeUndefined()
    expect(collect({ session_id: '../escape' }, NOW, DATE, {}).view.turn).toBeUndefined()
  })

  test('viewFile: the pane data, with levels and a stable shape', () => {
    const { view: v, extra: x } = collect({ session_id: 'v', rate_limits: { seven_day: { used_percentage: 92, resets_at: NOW + 60 } } }, NOW, DATE, {})
    const f = viewFile(v, x, DEFAULTS)
    expect(f.version).toBe(1)
    expect(f.limits).toEqual([{ label: 'Weekly', used: 92, resetsAt: NOW + 60, stale: false, level: 'crit' }])
    expect(f.settings).toEqual(DEFAULTS)
    expect(f.usageUrl).toBe('https://claude.ai/settings/usage')
  })

  test('render writes the pane data only when it changes, and follows the style setting', () => {
    const stdin = JSON.stringify({ session_id: 'r', model: { display_name: 'Opus 5.5' }, workspace: { current_dir: cfg.dir } })
    render(stdin)
    const pane = join(turns(), 'r.view.json')
    const first = statSync(pane).mtimeMs
    Bun.sleepSync(20)
    render(stdin)
    expect(statSync(pane).mtimeMs).toBe(first)
    expect(JSON.parse(readFileSync(pane, 'utf8')).settings.style).toBe('hud')

    writeFileSync(join(cfg.dir, 'claude-statusline.json'), '{"style":"quiet"}')
    expect(strip(render(stdin))).toStartWith('Opus 5.5 │ ctx … │ week …')
    writeFileSync(join(cfg.dir, 'claude-statusline.json'), '{"style":"loud"}')
    expect(() => render(stdin)).toThrow('"style": "loud"')
  })
})
