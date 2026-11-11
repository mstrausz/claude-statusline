import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { ViewFile } from '../types'
import { cells } from './format'

const PLUGIN = 'statusbar'
const HINT = {
  plugin: PLUGIN,
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
} as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PLUGIN,
  props: {
    title: 'Status line',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const CONFIG = '/home/me/.claude'
const TURNS = `${CONFIG}/cache/turns`
const BASE = `${TURNS}/sid-1`
const SETTINGS = `${CONFIG}/claude-statusline.json`

const NOW_S = 1794506400 // 2026-11-12 18:00 UTC
const RESETS_S = NOW_S + 4 * 86400 + 19 * 3600 + 120 // "in 4d19h", 32 % of the week gone

const SAMPLE: ViewFile = {
  version: 1,
  limits: [
    { label: 'Weekly', used: 46, resetsAt: RESETS_S, stale: false, level: 'ok' },
    { label: 'Fable', used: 92, resetsAt: RESETS_S, stale: false, level: 'crit' },
  ],
  context: { pct: 7, used: 74000, size: 1000000, input: 70000, cacheRead: 4000 },
  cost: {
    month: { key: '2026-11', cost: 25.95, tokens: 69120000 },
    previous: { key: '2026-10', cost: 212.4, tokens: 540200000 },
    session: 1.84,
  },
  session: {
    cwd: '~/workspace/claude-statusline',
    branch: 'cross-platform',
    skill: 'plugin-authoring',
    turn: { start: NOW_S - 83, label: 'Fix tariff chapter 84 import' },
  },
  settings: { style: 'hud', theme: 'default', glyphs: 'unicode', motion: true, links: true, width: 100 },
  usageUrl: 'https://claude.ai/settings/usage',
}

/**
 * Hooks that stand for the engine beneath the plugin: a session id, a file system in a
 * record (a path with no entry is a missing file), the clock, toasts and panes.
 */
function engine(on: On, files: Record<string, string> = {}, env: Record<string, string> = { HOME: '/home/me' }) {
  const session = { id: 'sid-1' }
  const clock = mock.clock(on, { now: NOW_S * 1000 })
  const toasts: string[] = []
  const logs: string[] = []
  const commands: { name: string; description: string; argumentHint?: string }[] = []
  const writes: string[] = []
  const unreadable = new Set<string>()
  const unwritable = new Set<string>()
  const panes = new Map<string, string>()
  mock.env(on, env)
  on('session.id', () => ({ value: session.id }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => (unreadable.has(e.path) ? { deny: 'EACCES: permission denied' } : { value: files[e.path]! }))
  on('fs.write', (_, e) => {
    if (unwritable.has(e.path)) return { deny: 'EROFS: read-only file system' }
    files[e.path] = e.text
    writes.push(e.path)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const broken = { panes: false }
  on('ui.panes', () =>
    broken.panes
      ? { deny: 'no panes here' }
      : { value: [...panes].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })) },
  )
  on('ui.open', (_, e) => {
    panes.set(e.id, e.title ?? e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  // Stands for the engine's own hint line: draws hint, then " · " and tail.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    const p = e.props as { hint: string; tail?: string }
    return <Text>{p.tail ? `${p.hint} · ${p.tail}` : p.hint}</Text>
  })
  // The engine's own answers to the events the mod hooks.
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.register', (_, e) => {
    commands.push(e)
    return { value: { command: e.name } }
  })
  // Stands for Claude Code's own commands, /statusbar among them.
  on('command.run', (_, e) => ({ text: `Claude Code ran /${e.command}` }))
  return { session, clock, files, writes, toasts, logs, panes, unreadable, unwritable, broken, commands }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

async function line($: Engine) {
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

async function lineFor($: Engine) {
  await start($)
  return line($)
}

/** The person typing `/<command> <args>` at the prompt. */
const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
const statusbar = ($: Engine, args = '') => run($, 'statusbar', args)

type Drawn = string | { type: string; children?: Drawn[] }

/** Each row of a drawing as the person reads it: a Text and the Texts inside it, joined. */
function rows(node: Drawn): string[] {
  const flat = (n: Drawn): string => (typeof n === 'string' ? n : (n.children ?? []).map(flat).join(''))
  if (typeof node === 'string') return [node]
  if (node.type === 'Text') return [flat(node)]
  return (node.children ?? []).flatMap(rows)
}

async function paneRows($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const drawn = rows((await ui.drawn()) as unknown as Drawn)
  await ui.unmount()
  return drawn
}

const skillTool = (status: 'inline' | 'forked', name: string) =>
  status === 'forked'
    ? { result: { success: true, commandName: name, status, agentId: 'a1', result: 'done' } }
    : { result: { success: true, commandName: name, status } }

// ---------------------------------------------------------------- the scope label

test('the Haiku scope label is appended to the mode line', async ($, on) => {
  engine(on, {
    [`${BASE}.scope`]: 'Session scope on mode line\n',
    [`${BASE}.title`]: 'Statusline 7d limit and model\n',
  })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Session scope on mode line')
})

test('before the first label, the session title stands in', async ($, on) => {
  engine(on, { [`${BASE}.title`]: 'Statusline 7d limit and model\n' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Statusline 7d limit and model')
})

test('with neither file the line is left as the engine draws it', async ($, on) => {
  engine(on, {})
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle)')
})

test('after /clear or /resume the next poll reads the new session id', async ($, on) => {
  const { session, clock } = engine(on, {
    [`${BASE}.scope`]: 'Fresh session label\n',
    [`${TURNS}/sid-2.scope`]: 'Resumed session label\n',
  })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Fresh session label')
  session.id = 'sid-2' // no session.start fires for the new id
  await clock.advance(3000)
  expect(await line($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Resumed session label')
})

test('CLAUDE_CONFIG_DIR moves the files', async ($, on) => {
  engine(on, { '/srv/claude/cache/turns/sid-1.scope': 'Elsewhere\n' }, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/srv/claude' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Elsewhere')
})

test('USERPROFILE, the home folder on Windows, comes before HOME', async ($, on) => {
  // Git Bash also sets HOME; the binary uses os.homedir(), which reads USERPROFILE there.
  engine(on, { '/users/me/.claude/cache/turns/sid-1.scope': 'On Windows\n' }, { USERPROFILE: '/users/me', HOME: '/home/other' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · On Windows')
})

test('the session title gets the cut of the scope label: 32 cells, at the last word that fits', async ($, on) => {
  engine(on, { [`${BASE}.title`]: 'Statusline 7d limit and model display rework\n' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Statusline 7d limit and model…')
})

test('a title with no space in its second half is cut at the cell limit', async ($, on) => {
  engine(on, { [`${BASE}.title`]: 'Fix Supercalifragilisticexpialidocious-rendering\n' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Fix Supercalifragilisticexpiali…')
})

test('a CJK character takes two cells', async ($, on) => {
  engine(on, { [`${BASE}.title`]: '日本語のセッションタイトルがとても長いです\n' })
  // 15 characters of 2 cells and the ellipsis: 31 cells; a 16th would make 33.
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · 日本語のセッションタイトルがと…')
})

test('a title of exactly 32 cells stays whole; the scope label gets the same cut', async ($, on) => {
  const { files, clock } = engine(on, { [`${BASE}.title`]: 'Thirty-two cells of title text!!\n' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Thirty-two cells of title text!!')
  files[`${BASE}.scope`] = 'Belgian tariff tree import and the customs export\n'
  await clock.advance(3000)
  expect(await line($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Belgian tariff tree import and…')
})

test('a scope file that cannot be read is shown in the pane, and the title stands in', async ($, on) => {
  const { unreadable } = engine(on, {
    [`${BASE}.scope`]: 'Hidden\n',
    [`${BASE}.title`]: 'The title\n',
  })
  unreadable.add(`${BASE}.scope`)
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · The title')
  await statusbar($)
  expect(await paneRows($)).toContainEqual(expect.stringMatching(/sid-1\.scope: .*EACCES: permission denied$/))
})

// ---------------------------------------------------------------- the skill in use

test('a skill prompt writes the skill file, and the model reads the prompt as it was', async ($, on) => {
  const { files } = engine(on)
  await start($)
  const { text } = await $.skill.prompt({ skill: 'frontend-design:frontend-design', text: 'Be bold.' })
  expect(text).toBe('Be bold.')
  expect(files[`${BASE}.skill`]).toBe('frontend-design:frontend-design\n')
})

test('a newer skill replaces the older one', async ($, on) => {
  const { files } = engine(on)
  await start($)
  await $.skill.prompt({ skill: 'commit', text: '…' })
  await $.skill.prompt({ skill: 'plugin-authoring', text: '…' })
  expect(files[`${BASE}.skill`]).toBe('plugin-authoring\n')
})

test("the main agent's turn end clears the skill, an interrupt too", async ($, on) => {
  const { files } = engine(on)
  await start($)
  await $.skill.prompt({ skill: 'commit', text: '…' })
  const ended = await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(ended.text).toBe('Done.')
  expect(files[`${BASE}.skill`]).toBe('')

  await $.skill.prompt({ skill: 'commit', text: '…' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(files[`${BASE}.skill`]).toBe('')
})

test("a subagent's turn end leaves the skill", async ($, on) => {
  const { files } = engine(on)
  await start($)
  await $.skill.prompt({ skill: 'commit', text: '…' })
  await $.turn.complete({ answer: 'Sub done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
  expect(files[`${BASE}.skill`]).toBe('commit\n')
})

test('a forked skill is cleared when its Skill call returns; an inline one stays', async ($, on) => {
  const { files } = engine(on)
  let status: 'inline' | 'forked' = 'forked'
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Skill') throw new Error(`unexpected tool ${e.tool}`)
    await $.skill.prompt({ skill: e.skill, text: 'Work alone.' }) // the engine expands it
    return skillTool(status, e.skill)
  })
  await start($)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'deep-research' })
  expect(ran.result).toMatchObject({ status: 'forked', result: 'done' })
  expect(files[`${BASE}.skill`]).toBe('')

  status = 'inline'
  await $.tool.call({ tool: 'Skill', skill: 'commit' })
  expect(files[`${BASE}.skill`]).toBe('commit\n')
})

test('a forked skill that returns after another skill started leaves the newer one', async ($, on) => {
  const { files } = engine(on)
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Skill') throw new Error(`unexpected tool ${e.tool}`)
    await $.skill.prompt({ skill: e.skill, text: '…' })
    await $.skill.prompt({ skill: 'commit', text: '…' }) // the subagent preloads another one
    return skillTool('forked', e.skill)
  })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'deep-research' })
  expect(files[`${BASE}.skill`]).toBe('commit\n')
})

test('a skill file that cannot be written is said in the transcript; the model reads the same', async ($, on) => {
  const { logs, unwritable } = engine(on)
  unwritable.add(`${BASE}.skill`)
  await start($)
  const { text } = await $.skill.prompt({ skill: 'commit', text: 'Commit it.' })
  expect(text).toBe('Commit it.')
  expect(logs).toContainEqual(expect.stringMatching(/^statusbar: .*EROFS: read-only file system/))
})

// ---------------------------------------------------------------- /statusbar settings

test("/statusbar is the mod's own command; Claude Code's /statusline stays its own", async ($, on) => {
  const { commands, toasts, panes, writes } = engine(on)
  await start($)
  expect(commands).toEqual([
    {
      name: 'statusbar',
      description: 'Show the status line details, or change a status line setting',
      argumentHint: '[style hud|quiet | theme <name> | glyphs unicode|ascii|nerd | motion on|off | links on|off | width <cells>|auto]',
      immediate: true, // runs mid-turn: a setting or the pane does not wait for the turn
    },
  ])
  for (const args of ['', 'style hud', 'show the branch']) {
    expect((await run($, 'statusline', args)).text).toBe('Claude Code ran /statusline')
  }
  expect(toasts).toEqual([])
  expect(writes).toEqual([])
  expect([...panes.keys()]).toEqual([])
})

const VALID: [string, Record<string, unknown>, string][] = [
  ['style hud', { style: 'hud' }, 'Status line style: hud'],
  ['style quiet', { style: 'quiet' }, 'Status line style: quiet'],
  ['glyphs ascii', { glyphs: 'ascii' }, 'Status line glyphs: ascii'],
  ['glyphs nerd', { glyphs: 'nerd' }, 'Status line glyphs: nerd'],
  ['motion off', { motion: false }, 'Status line motion: off'],
  ['links on', { links: true }, 'Status line links: on'],
  ['width 120', { width: 120 }, 'Status line width: 120'],
  ['width 40', { width: 40 }, 'Status line width: 40'],
  ['width 400', { width: 400 }, 'Status line width: 400'],
]

for (const [args, field, toast] of VALID) {
  test(`/statusbar ${args} writes the field and says the new value`, async ($, on) => {
    const { files, toasts } = engine(on)
    await start($)
    const answer = await statusbar($, args)
    expect(answer.text).toBeUndefined() // the built-in setup did not run, and the model reads nothing
    expect(JSON.parse(files[SETTINGS]!)).toEqual(field)
    expect(toasts).toEqual([toast])
  })
}

test('/statusbar width auto removes the field', async ($, on) => {
  const { files, toasts } = engine(on, { [SETTINGS]: '{ "width": 90, "style": "quiet" }' })
  await start($)
  await statusbar($, 'width auto')
  expect(JSON.parse(files[SETTINGS]!)).toEqual({ style: 'quiet' })
  expect(toasts).toEqual(['Status line width: auto'])
})

test('/statusbar theme sets the color scheme; the variable wins over it', async ($, on) => {
  const { files, toasts } = engine(on, { [SETTINGS]: '{ "style": "hud" }' }, { HOME: '/home/me', CLAUDE_STATUSLINE_THEME: 'nord' })
  await start($)
  await statusbar($, 'theme catppuccin-latte')
  expect(JSON.parse(files[SETTINGS]!)).toEqual({ style: 'hud', theme: 'catppuccin-latte' })
  expect(toasts).toEqual(['Status line theme: catppuccin-latte. Theme is set by CLAUDE_STATUSLINE_THEME.'])
})

const INVALID: [string, string][] = [
  ['style loud', 'Usage: /statusbar style hud|quiet'],
  ['theme solarized', 'Usage: /statusbar theme default|terminal|catppuccin|catppuccin-latte|nord|dracula|gruvbox|tokyo-night'],
  ['theme', 'Usage: /statusbar theme default|terminal|catppuccin|catppuccin-latte|nord|dracula|gruvbox|tokyo-night'],
  ['style', 'Usage: /statusbar style hud|quiet'],
  ['style hud quiet', 'Usage: /statusbar style hud|quiet'],
  ['glyphs emoji', 'Usage: /statusbar glyphs unicode|ascii|nerd'],
  ['motion maybe', 'Usage: /statusbar motion on|off'],
  ['links true', 'Usage: /statusbar links on|off'],
  ['width 39', 'Usage: /statusbar width <cells>|auto'],
  ['width 401', 'Usage: /statusbar width <cells>|auto'],
  ['width 1e2', 'Usage: /statusbar width <cells>|auto'],
  [
    'toasts on',
    'Usage: /statusbar [style hud|quiet | theme default|terminal|catppuccin|catppuccin-latte|nord|dracula|gruvbox|tokyo-night | glyphs unicode|ascii|nerd | motion on|off | links on|off | width <cells>|auto]',
  ],
]

for (const [args, usage] of INVALID) {
  test(`/statusbar ${args} shows the usage and changes nothing`, async ($, on) => {
    const { writes, toasts } = engine(on)
    await start($)
    const answer = await statusbar($, args)
    expect(answer.text).toBeUndefined()
    expect(writes).toEqual([])
    expect(toasts).toEqual([usage])
  })
}

test('a set environment variable still lets the file change, and the toast says it wins', async ($, on) => {
  const { files, toasts } = engine(on, {}, { HOME: '/home/me', CLAUDE_STATUSLINE_STYLE: 'quiet', CLAUDE_STATUSLINE_WIDTH: '80' })
  await start($)
  await statusbar($, 'style hud')
  await statusbar($, 'width auto')
  expect(JSON.parse(files[SETTINGS]!)).toEqual({ style: 'hud' })
  expect(toasts).toEqual([
    'Status line style: hud. Style is set by CLAUDE_STATUSLINE_STYLE.',
    'Status line width: auto. Width is set by CLAUDE_STATUSLINE_WIDTH.',
  ])
})

test('an empty environment variable is unset, as the binary reads it', async ($, on) => {
  const { toasts } = engine(on, {}, { HOME: '/home/me', CLAUDE_STATUSLINE_MOTION: '' })
  await start($)
  await statusbar($, 'motion on')
  expect(toasts).toEqual(['Status line motion: on'])
})

test('a change keeps the other fields of the file, and fields the mod does not know', async ($, on) => {
  const { files } = engine(on, { [SETTINGS]: '{\n  "glyphs": "nerd",\n  "toasts": false\n}\n' })
  await start($)
  await statusbar($, 'style quiet')
  expect(files[SETTINGS]).toBe('{\n  "glyphs": "nerd",\n  "toasts": false,\n  "style": "quiet"\n}\n')
})

test('a file that does not parse is left as it is, and the toast says why', async ($, on) => {
  const { files, writes, toasts } = engine(on, { [SETTINGS]: '{ "style": ' })
  await start($)
  await statusbar($, 'style hud')
  expect(writes).toEqual([])
  expect(files[SETTINGS]).toBe('{ "style": ')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toStartWith(`Status line style not changed: ${SETTINGS}: `)
})

test('a file that holds no JSON object is left as it is', async ($, on) => {
  const { writes, toasts } = engine(on, { [SETTINGS]: '[1, 2]' })
  await start($)
  await statusbar($, 'links off')
  expect(writes).toEqual([])
  expect(toasts).toEqual([`Status line links not changed: ${SETTINGS}: not a JSON object`])
})

test('a config file that cannot be written says so', async ($, on) => {
  const { toasts, unwritable } = engine(on)
  unwritable.add(SETTINGS)
  await start($)
  await statusbar($, 'style quiet')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(new RegExp(`^Status line style not saved: ${SETTINGS}: .*EROFS`))
})

test('a /statusbar that fails says so', async ($, on) => {
  const { toasts, broken } = engine(on)
  await start($)
  broken.panes = true
  const answer = await statusbar($)
  expect(answer.text).toBeUndefined()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^\/statusbar failed: .*no panes here.*\. Usage: \/statusbar \[/)
})

// ---------------------------------------------------------------- the detail pane

test('/statusbar opens the pane, and closes it when it is open; it never opens by itself', async ($, on) => {
  const { panes, clock } = engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE) })
  await start($)
  await clock.advance(9000)
  expect([...panes.keys()]).toEqual([])
  expect((await statusbar($)).text).toBeUndefined()
  expect([...panes]).toEqual([[PLUGIN, 'Status line']])
  await statusbar($)
  expect([...panes.keys()]).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows the figures of the view file (${surface})`, async ($, on) => {
    engine(on, {
      [`${BASE}.view.json`]: JSON.stringify(SAMPLE),
      [`${BASE}.scope`]: 'Belgian tariff tree import\n',
      [SETTINGS]: '{ "glyphs": "unicode" }',
    })
    await start($)
    await $.skill.prompt({ skill: 'frontend-design:frontend-design', text: '…' })
    await statusbar($)
    const drawn = await paneRows($, surface)

    expect(drawn).toContain('LIMITS')
    expect(drawn).toContain('Weekly  ███████▍░░░░░░░░  46%')
    expect(drawn).toContainEqual(expect.stringMatching(/^ {8}resets \w{3} \d{1,2} \w{3} \d{2}:\d{2} {2}\(in 4d19h\)$/))
    expect(drawn).toContain('        pace: 46 % used, 32 % of the week gone')
    expect(drawn).toContain('Fable   ██████████████▊░ 92%!   same reset')

    expect(drawn).toContain('CONTEXT')
    expect(drawn).toContain('window  █▏░░░░░░░░░░░░░░   7%   74k of 1M')
    expect(drawn).toContain('        input 70k · cache read 4k')

    expect(drawn).toContain('COST')
    expect(drawn).toContain('Nov 2026  $25.95   69.1M tokens')
    expect(drawn).toContain('Oct 2026  $212     540.2M tokens')
    expect(drawn).toContain('session   $1.84    ')

    expect(drawn).toContain('SESSION')
    expect(drawn).toContain('scope   Belgian tariff tree import')
    expect(drawn).toContain('turn    1m23s  Fix tariff chapter 84 import')
    expect(drawn).toContain('skill   frontend-design:frontend-design')
    expect(drawn).toContain('folder  ~/workspace/claude-statusline')
    expect(drawn).toContain('branch  cross-platform')

    expect(drawn).toContain('SETTINGS')
    expect(drawn.filter(row => row.includes('…'))).toEqual([])
  })
}

test('the LIMITS title says when the limits were fetched, and how old when over 10 minutes', async ($, on) => {
  const hhmm = (epochS: number) => new Date(epochS * 1000).toTimeString().slice(0, 5)
  const { files, clock } = engine(on, { [`${BASE}.view.json`]: JSON.stringify({ ...SAMPLE, limitsFetchedAt: NOW_S - 120 }) })
  await start($)
  await statusbar($)
  expect(await paneRows($)).toContain(`LIMITS · from ${hhmm(NOW_S - 120)}`)

  // Exactly 10 minutes is not yet old.
  files[`${BASE}.view.json`] = JSON.stringify({ ...SAMPLE, limitsFetchedAt: NOW_S + 3 - 600 })
  await clock.advance(3000)
  expect(await paneRows($)).toContain(`LIMITS · from ${hhmm(NOW_S + 3 - 600)}`)

  const fetched = NOW_S + 6 - 18 * 60 - 30
  files[`${BASE}.view.json`] = JSON.stringify({ ...SAMPLE, limitsFetchedAt: fetched })
  await clock.advance(3000)
  expect(await paneRows($)).toContain(`LIMITS · from ${hhmm(fetched)}, 18 min old`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const note = await ui.find({ type: 'Text', text: /^ · from .*min old$/ })
  expect(note?.props.color).toBe('warning')
  await ui.unmount()
})

test('a limitsFetchedAt that is not a number is shown, not hidden', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify({ ...SAMPLE, limitsFetchedAt: '20:00' }) })
  await start($)
  await statusbar($)
  expect(await paneRows($)).toContain(`${BASE}.view.json: limitsFetchedAt is not a number`)
})

test('the gauge fill takes the theme color of its level; a stale limit is muted', async ($, on) => {
  const view: ViewFile = {
    ...SAMPLE,
    limits: [
      { label: 'Weekly', used: 75, resetsAt: RESETS_S, stale: false, level: 'warn' },
      { label: 'Fable', used: 92, resetsAt: RESETS_S + 60, stale: false, level: 'crit' },
      { label: 'Old', used: 100, resetsAt: NOW_S - 60, stale: true, level: 'ok' },
      { label: 'Fresh', used: 10, stale: false, level: 'ok' },
    ],
  }
  engine(on, { [`${BASE}.view.json`]: JSON.stringify(view) })
  await start($)
  await statusbar($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const runs = await ui.findAll({ type: 'Text', text: /█/ })
  const colors = runs.filter(t => t.children.every(c => typeof c === 'string')).map(t => t.props.color)
  expect(colors).toEqual(['warning', 'error', undefined, 'success', 'success'])
  const old = await ui.find({ type: 'Text', text: /^Old/ })
  expect(old?.props.dimColor).toBe(true)
  await ui.unmount()

  const drawn = await paneRows($)
  expect(drawn).toContainEqual(expect.stringMatching(/^ {8}resets .* {2}\(stale\)$/))
  expect(drawn).toContain('Fresh   █▋░░░░░░░░░░░░░░  10%')
})

test('the gauges take the glyphs in force, as the view file says', async ($, on) => {
  const view: ViewFile = { ...SAMPLE, settings: { ...SAMPLE.settings, glyphs: 'ascii' } }
  engine(on, { [`${BASE}.view.json`]: JSON.stringify(view) })
  await start($)
  await statusbar($)
  expect(await paneRows($)).toContain('Weekly  #######---------  46%')
})

test('before the first render each group shows …', async ($, on) => {
  engine(on)
  await start($)
  await statusbar($)
  const drawn = await paneRows($)
  for (const group of ['LIMITS …', 'CONTEXT …', 'COST …', 'SESSION …']) expect(drawn).toContain(group)
})

test('a view file that is not valid is shown, not hidden', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify({ ...SAMPLE, limits: [{ label: 'Weekly', used: '46' }] }) })
  await start($)
  await statusbar($)
  const drawn = await paneRows($)
  expect(drawn).toContain(`${BASE}.view.json: limits[0].used is not a number`)
  expect(drawn).toContain('LIMITS …')
})

test('the theme in the view file: a scheme name, or absent from a binary older than the setting', async ($, on) => {
  const old = { ...SAMPLE, settings: { ...SAMPLE.settings, theme: undefined } }
  engine(on, { [`${BASE}.view.json`]: JSON.stringify(old) })
  await start($)
  await statusbar($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Select', key: 'theme' }))?.props.value).toBeUndefined()
  expect((await ui.find({ type: 'Select', key: 'style' }))?.props.value).toBe('hud')
  await ui.unmount()
})

test('a theme in the view file that is not a scheme name is shown', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify({ ...SAMPLE, settings: { ...SAMPLE.settings, theme: 'solarized' } }) })
  await start($)
  await statusbar($)
  expect((await paneRows($)).join('\n')).toContain(`${BASE}.view.json: settings.theme is not default or terminal or`)
})

test('the theme Select says that the scheme colors the hud style, and a pick sets it', async ($, on) => {
  const { files, toasts } = engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE) })
  await start($)
  await statusbar($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const select = await ui.find({ type: 'Select', key: 'theme' })
  expect(select?.props.label).toBe('Theme (hud)')
  expect((select?.props.options as { value: string }[]).map(o => o.value)).toHaveLength(8)
  await ui.select({ key: 'theme', value: 'dracula' })
  expect(JSON.parse(files[SETTINGS]!)).toEqual({ theme: 'dracula' })
  expect(toasts).toEqual(['Status line theme: dracula'])
  await ui.unmount()
  for (const row of await paneRows($)) expect(cells(row)).toBeLessThanOrEqual(48)
})

test('a view file of another version is shown as such', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify({ ...SAMPLE, version: 2 }) })
  await start($)
  await statusbar($)
  expect(await paneRows($)).toContain(`${BASE}.view.json: version is not 1`)
})

test('the pane follows the view file while it is open', async ($, on) => {
  const { files, clock } = engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE) })
  await start($)
  await statusbar($)
  files[`${BASE}.view.json`] = JSON.stringify({ ...SAMPLE, limits: [{ ...SAMPLE.limits[0]!, used: 50 }] })
  await clock.advance(3000)
  expect(await paneRows($)).toContain('Weekly  ████████░░░░░░░░  50%')
  expect(await paneRows($)).toContain('turn    1m26s  Fix tariff chapter 84 import')
})

test('the Selects show the settings, and a pick does what the command does', async ($, on) => {
  const { files, toasts } = engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE), [SETTINGS]: '{ "motion": false }' })
  await start($)
  await statusbar($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const values = (await ui.findAll({ type: 'Select' })).map(s => [s.key, s.props.value])
    expect(values).toEqual([
      ['style', 'hud'],
      ['theme', 'default'],
      ['glyphs', 'unicode'],
      ['motion', 'off'],
      ['links', 'on'],
    ])
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'style', value: 'quiet' })
  expect(JSON.parse(files[SETTINGS]!)).toEqual({ motion: false, style: 'quiet' })
  expect(toasts).toEqual(['Status line style: quiet'])
  expect((await ui.find({ type: 'Select', key: 'style' }))?.props.value).toBe('quiet')
  await ui.unmount()
})

test('a variable that wins over the file shows in its Select, with a note', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE), [SETTINGS]: '{ "style": "hud", "links": "yes" }' }, {
    HOME: '/home/me',
    CLAUDE_STATUSLINE_STYLE: 'quiet',
    CLAUDE_STATUSLINE_GLYPHS: 'emoji',
  })
  await start($)
  await statusbar($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Select', key: 'style' }))?.props.value).toBe('quiet')
  expect((await ui.find({ type: 'Select', key: 'glyphs' }))?.props.value).toBeUndefined()
  await ui.unmount()
  const drawn = await paneRows($)
  expect(drawn).toContain('CLAUDE_STATUSLINE_STYLE sets style')
  expect(drawn).toContain('CLAUDE_STATUSLINE_GLYPHS=emoji is not unicode|ascii|nerd')
  expect(drawn).toContain('"links": "yes" in the file is not on|off')
})

test('a config file that does not parse is shown in the pane', async ($, on) => {
  engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE), [SETTINGS]: '{ oops' })
  await start($)
  await statusbar($)
  expect(await paneRows($)).toContainEqual(expect.stringMatching(new RegExp(`^${SETTINGS}: `)))
})

test('the usage page is a link, and Close closes the pane', async ($, on) => {
  const { panes } = engine(on, { [`${BASE}.view.json`]: JSON.stringify(SAMPLE) })
  await start($)
  await statusbar($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const link = await ui.find({ type: 'Link' })
  expect(link?.props.href).toBe('https://claude.ai/settings/usage')
  expect(link?.children).toEqual(['Open usage page'])
  await ui.press({ key: 'close' })
  expect([...panes.keys()]).toEqual([])
  await ui.unmount()
})
