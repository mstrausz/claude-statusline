import { describe, expect, test } from 'bun:test'
import { mergeSettings, statusLineCommand, unmergeSettings, type Targets } from '../src/install.ts'
import { modFiles } from '../src/mod-files.ts' with { type: 'macro' }

const POSIX: Targets = {
  statusLine: '/home/me/.claude/bin/claude-statusline',
  bin: '/home/me/.claude/bin/claude-statusline',
  modDir: '/home/me/.claude/mods/session-scope',
  delimiter: ':',
}
const WINDOWS: Targets = {
  statusLine: '~/.claude/bin/claude-statusline.exe',
  bin: 'C:\\Users\\Me\\.claude\\bin\\claude-statusline.exe',
  modDir: 'C:\\Users\\Me\\.claude\\mods\\session-scope',
  delimiter: ';',
}

/** What the bash version's installer left in settings.json. */
const LEGACY = {
  statusLine: { type: 'command', command: '/home/me/.claude/statusline.sh', refreshInterval: 1 },
  hooks: {
    Stop: [
      { matcher: '*', hooks: [{ type: 'command', command: 'bash ~/.claude/tts/stop-hook.sh' }] },
      { hooks: [{ type: 'command', command: '/home/me/.claude/statusline.sh --turn-end', timeout: 5 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 guard.py' }] },
      { hooks: [{ type: 'command', command: '/home/me/.claude/statusline.sh --turn-activity', timeout: 5, async: true }] },
    ],
  },
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/other/plugin:/home/me/.claude/mods/session-scope', KEEP: '1' },
  model: 'opus',
}

describe('mergeSettings', () => {
  test('into empty settings: statusLine, five hooks in exec form, the mod folder', () => {
    const s = mergeSettings({}, POSIX)
    expect(s.statusLine).toEqual({ type: 'command', command: POSIX.statusLine, refreshInterval: 1 })
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'Stop', 'StopFailure', 'UserPromptSubmit'])
    expect(s.hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: POSIX.bin, args: ['--turn-activity'], timeout: 5, async: true }] },
    ])
    expect(s.hooks.Notification[0].matcher).toBe('idle_prompt')
    expect(s.env.CLAUDE_CODE_PLUGIN_DIRS).toBe(POSIX.modDir)
  })

  test('replaces the bash version and keeps everything else', () => {
    const s = mergeSettings(LEGACY, POSIX)
    expect(s.model).toBe('opus')
    expect(s.env.KEEP).toBe('1')
    expect(s.hooks.Stop).toEqual([
      LEGACY.hooks.Stop[0],
      { hooks: [{ type: 'command', command: POSIX.bin, args: ['--turn-end'], timeout: 5 }] },
    ])
    expect(s.hooks.PreToolUse[0]).toEqual(LEGACY.hooks.PreToolUse[0])
    expect(JSON.stringify(s)).not.toContain('statusline.sh')
    expect(s.env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`/other/plugin:${POSIX.modDir}`)
  })

  test('running it again changes nothing', () => {
    const once = mergeSettings(LEGACY, POSIX)
    expect(mergeSettings(once, POSIX)).toEqual(once)
  })

  test('Windows: ; separates plugin folders, the hook runs the .exe by its full path', () => {
    const s = mergeSettings({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:\\plugins\\a' } }, WINDOWS)
    expect(s.env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`D:\\plugins\\a;${WINDOWS.modDir}`)
    expect(s.hooks.Stop[0].hooks[0].command).toBe(WINDOWS.bin)
    expect(mergeSettings(s, WINDOWS)).toEqual(s)
  })

  test('the input is not changed', () => {
    const copy = structuredClone(LEGACY)
    mergeSettings(LEGACY, POSIX)
    expect(LEGACY).toEqual(copy)
  })
})

test('unmergeSettings removes only this program, also the bash version', () => {
  const s = unmergeSettings(mergeSettings(LEGACY, POSIX), POSIX)
  expect(s).toEqual({
    hooks: { Stop: [LEGACY.hooks.Stop[0]], PreToolUse: [LEGACY.hooks.PreToolUse[0]] },
    env: { CLAUDE_CODE_PLUGIN_DIRS: '/other/plugin', KEEP: '1' },
    model: 'opus',
  })
  expect(unmergeSettings(mergeSettings({}, WINDOWS), WINDOWS)).toEqual({ env: {} })
  // Another tool's status line stays.
  const other = { statusLine: { type: 'command', command: 'ccstatusline' } }
  expect(unmergeSettings(other, POSIX)).toEqual(other)
})

test('statusLineCommand', () => {
  expect(statusLineCommand('/home/me/.claude/bin/claude-statusline', '/home/me', false))
    .toBe('/home/me/.claude/bin/claude-statusline')
  expect(statusLineCommand("/home/o'neil x/.claude/bin/claude-statusline", "/home/o'neil x", false))
    .toBe(`'/home/o'\\''neil x/.claude/bin/claude-statusline'`)
  // Windows: ~ and forward slashes, which Git Bash and PowerShell both read; ~ also hides
  // the spaces of a user folder.
  expect(statusLineCommand('C:\\Users\\John Doe\\.claude\\bin\\claude-statusline.exe', 'C:\\Users\\John Doe', true))
    .toBe('~/.claude/bin/claude-statusline.exe')
  expect(statusLineCommand('D:\\claude\\bin\\claude-statusline.exe', 'C:\\Users\\Me', true))
    .toBe('D:/claude/bin/claude-statusline.exe')
})

test('the binary carries the mod, without its tests or generated types', () => {
  const files = Object.keys(modFiles()).sort()
  expect(files).toEqual([
    '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'tsconfig.json', 'types/index.d.ts',
  ])
})
