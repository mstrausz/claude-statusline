import { describe, expect, test } from 'bun:test'
import { DEFAULTS, type Settings } from '../src/settings.ts'
import { count, cut, dur, money, shortPath, skillName, strip, type View } from '../src/style/common.ts'
import { detectTier, hud, to256 } from '../src/style/hud.ts'
import { quiet } from '../src/style/quiet.ts'

const NOW = 1_794_400_000
const DATE = new Date(2026, 10, 11, 14, 56, 5) // local time, Nov

const view = (v: Partial<View> = {}): View => ({ now: NOW, date: DATE, host: 'box', cwd: '~/project', ssh: false, ...v })
const FULL = view({
  model: 'Opus 5.5', ctxPct: 7, ctxCur: 74_000, ctxSize: 1_000_000,
  week: { used: 46, resetsAt: NOW + 4 * 86400 + 19 * 3600 },
  fable: { used: 27, resetsAt: NOW + 4 * 86400 + 19 * 3600 },
  month: { cost: 25.951, tokens: 69_120_000 },
  turn: { seconds: 83, label: 'Fix tariff import' },
  branch: 'main',
  repoUrl: 'https://github.com/example/project',
  cwdUrl: 'file:///home/me/project',
})
const set = (s: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...s })

describe('quiet (directions.md 2.3)', () => {
  const q = (v: View, s: Partial<Settings> = {}, color = true) => quiet(v, set({ style: 'quiet', ...s }), color)

  test('every segment with data', () => {
    expect(strip(q(FULL))).toBe(
      'Opus 5.5 │ ctx 7% 74k/1M │ week 46% · Fable 27% · resets 4d19h │ Nov $25.95\n~/project (main) │ 1m23s Fix tariff import',
    )
  })

  test('an empty view', () => {
    expect(strip(q(view()))).toBe('… │ ctx … │ week …\n~/project')
  })

  test('a stale limit carries no alarm, an exhausted one does', () => {
    expect(strip(q(view({ week: { used: 100, resetsAt: NOW - 1 }, fable: { used: 120 } })))).toContain('week 100% stale · Fable 100%!')
  })

  test('the skill badge: black on cyan, brackets of the same width without color', () => {
    const v = { ...FULL, skill: 'frontend-design:frontend-design' }
    expect(q(v)).toContain('\x1b[30;46m /frontend-design \x1b[0m')
    expect(q(v, {}, false).split('\n')[1]).toBe('~/project (main) │ [/frontend-design] 1m23s Fix tariff import')
  })

  test('only warnings have a hue: none under 50, yellow from 50, bold red with ! from 80', () => {
    expect(q(view({ ctxPct: 49 }))).toContain(' 49%')
    expect(q(view({ ctxPct: 49 }))).not.toContain('m49%')
    expect(q(view({ ctxPct: 50 }))).toContain('\x1b[33m50%\x1b[0m')
    expect(q(view({ ctxPct: 80 }))).toContain('\x1b[1;91m80%!\x1b[0m')
  })

  test('links on the limits, the folder and the branch; none without color or when off', () => {
    const out = q(FULL)
    expect(out).toContain('\x1b]8;;https://claude.ai/settings/usage\x1b\\')
    expect(out).toContain('\x1b]8;;file:///home/me/project\x1b\\')
    expect(out).toContain('\x1b]8;;https://github.com/example/project/tree/main\x1b\\')
    expect(q(FULL, {}, false)).not.toContain('\x1b]8')
    expect(q(FULL, { links: false })).not.toContain('\x1b]8')
  })

  test('the host shows in an SSH session', () => {
    expect(strip(q({ ...FULL, ssh: true })).split('\n')[1]).toStartWith('box:~/project')
  })
})

describe('hud (directions.md 9)', () => {
  test('without color: the same items as quiet, with gauges', () => {
    expect(strip(hud(FULL, set({ width: 120 }), 'none')).split('\n')[0]).toBe(
      'Opus 5.5 │ ctx ▌░░░░░░░ 7% 74k/1M │ week ███▋░░░░ 46%  Fable ██▏░░░░░ 27%  resets 4d19h │ Nov $25.95  69.1M tok',
    )
  })

  test('the width budget drops items in order: tokens, context detail, cost, gauge cells, gauges', () => {
    const at = (width: number) => strip(hud(FULL, set({ width }), 'truecolor')).split('\n')[0]!
    expect(at(120)).toContain('69.1M tok')
    expect(at(100)).not.toContain('69.1M tok')
    expect(at(100)).toContain('$25.95')
    for (const w of [120, 100, 80, 60, 40]) expect(Bun.stringWidth(at(w))).toBeLessThanOrEqual(Math.max(w, Bun.stringWidth(at(40))))
    expect(at(40)).not.toContain('█')
  })

  test('the critical level is one red block with a !', () => {
    const out = hud(view({ week: { used: 95, resetsAt: NOW + 3600 } }), set(), 'truecolor')
    expect(out).toContain('48;2;255;77;94') // the alarm fill
    expect(strip(out)).toContain('95%!')
  })

  test('the spinner steps with the clock, and only while a turn runs; off with motion off', () => {
    const frame = (now: number) => strip(hud({ ...FULL, now }, set(), 'truecolor')).split('\n')[1]!
    expect(frame(NOW)).not.toBe(frame(NOW + 1))
    expect(frame(NOW)).toBe(frame(NOW + 4))
    expect(strip(hud(FULL, set({ motion: false }), 'truecolor'))).not.toMatch(/[▖▘▝▗]/)
    expect(strip(hud({ ...FULL, turn: undefined }, set(), 'truecolor'))).not.toMatch(/[▖▘▝▗]/)
  })

  test('the skill badge is a cyan segment, [/name] without color, and takes no space without a skill', () => {
    const v = { ...FULL, skill: 'plugin-authoring' }
    expect(hud(v, set(), 'truecolor')).toContain('48;2;34;211;238m/plugin-authoring')
    expect(strip(hud(v, set(), 'none'))).toContain('[/plugin-authoring]')
    expect(strip(hud(FULL, set(), 'none'))).not.toContain('[/')
  })

  test('each tier uses its own color codes', () => {
    expect(hud(FULL, set(), 'truecolor')).toContain('38;2;')
    expect(hud(FULL, set(), '256')).toContain('38;5;')
    expect(hud(FULL, set(), '256')).not.toContain('38;2;')
    expect(hud(FULL, set(), '16')).not.toMatch(/38;[25];/)
    expect(hud(FULL, set(), 'none')).not.toContain('\x1b')
  })

  test('the ascii set has no block or box glyph, the nerd set has Powerline shapes', () => {
    expect(strip(hud(FULL, set({ glyphs: 'ascii' }), '16'))).toMatch(/^[\x20-\x7e\n]*$/)
    expect(hud(FULL, set({ glyphs: 'nerd' }), 'truecolor')).toContain('')
  })
})

describe('detectTier', () => {
  test.each([
    [{ NO_COLOR: '1', COLORTERM: 'truecolor' }, 'linux', 'none'],
    [{ FORCE_COLOR: '1', NO_COLOR: '1' }, 'linux', '16'],
    [{ FORCE_COLOR: '3' }, 'linux', 'truecolor'],
    [{ TERM: 'dumb' }, 'linux', 'none'],
    [{ COLORTERM: 'truecolor' }, 'linux', 'truecolor'],
    [{}, 'win32', 'truecolor'],
    [{ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, 'darwin', '256'],
    [{ TERM: 'xterm-kitty' }, 'linux', 'truecolor'],
    [{ TERM: 'xterm-256color' }, 'linux', '256'],
    [{ TERM: 'xterm' }, 'linux', '16'],
  ])('%j on %s -> %s', (env, platform, tier) => {
    expect(detectTier(env, platform)).toBe(tier as any)
  })
})

test('to256', () => {
  expect([to256([0, 0, 0]), to256([255, 255, 255]), to256([255, 0, 0]), to256([128, 128, 128])]).toEqual([16, 231, 196, 244])
})

test('dur', () => {
  expect([42, 187, 7500, 86400 * 4 + 3600 * 19 + 5].map(dur)).toEqual(['42s', '3m07s', '2h05m', '4d19h'])
})

test('count and money', () => {
  expect([999, 1500, 74_000, 1_000_000, 69_120_000, 2_340_000_000].map(count)).toEqual(['999', '1k', '74k', '1M', '69.1M', '2.3B'])
  expect([25.951, 99.999, 412.37].map(money)).toEqual(['$25.95', '$100.00', '$412'])
})

test('cut and shortPath count terminal cells', () => {
  expect(cut('abcdef', 4, '…')).toBe('abc…')
  expect(cut('日本語テキスト', 7, '…')).toBe('日本語…') // 2 cells each
  expect(shortPath('~/workspace/company/monorepo/packages/tariff-import/src/chapters', 28, '…')).toBe('~/…/src/chapters') // 30 cells with tariff-import: over 28
})

test('skillName drops the plugin prefix and a leading slash', () => {
  expect(['frontend-design:frontend-design', '/code-review', 'plain'].map(skillName)).toEqual(['frontend-design', 'code-review', 'plain'])
})
