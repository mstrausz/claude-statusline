import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS, loadSettings, saveSetting } from '../src/settings.ts'
import { tempConfig } from './helpers.ts'

describe('settings', () => {
  const cfg = tempConfig()
  const file = () => join(cfg.dir, 'claude-statusline.json')

  test('defaults without a file or variables', () => {
    expect(loadSettings({}, file())).toEqual(DEFAULTS)
    expect(DEFAULTS).toEqual({ style: 'hud', theme: 'default', glyphs: 'unicode', motion: true, links: true, width: 100 })
  })

  test('the file, then an environment variable over it', () => {
    writeFileSync(file(), JSON.stringify({ style: 'quiet', motion: false, width: 120 }))
    expect(loadSettings({}, file())).toEqual({ ...DEFAULTS, style: 'quiet', motion: false, width: 120 })
    expect(loadSettings({ CLAUDE_STATUSLINE_STYLE: 'hud', CLAUDE_STATUSLINE_MOTION: 'on' }, file()))
      .toEqual({ ...DEFAULTS, motion: true, width: 120 })
  })

  test('a value that is not valid is an error, never a default', () => {
    expect(() => loadSettings({ CLAUDE_STATUSLINE_STYLE: 'loud' }, file())).toThrow('CLAUDE_STATUSLINE_STYLE=loud is not valid (hud|quiet)')
    writeFileSync(file(), JSON.stringify({ motion: 'on' }))
    expect(() => loadSettings({}, file())).toThrow('"motion": "on"')
    writeFileSync(file(), JSON.stringify({ width: 20 }))
    expect(() => loadSettings({}, file())).toThrow('"width": 20')
    writeFileSync(file(), '[1]')
    expect(() => loadSettings({}, file())).toThrow('is not a JSON object')
    writeFileSync(file(), '{oops')
    expect(() => loadSettings({}, file())).toThrow(file())
  })

  test('an empty file, as the mod leaves it for a moment while it writes, has no settings yet', () => {
    writeFileSync(file(), '')
    expect(loadSettings({}, file())).toEqual(DEFAULTS)
  })

  test('saveSetting merges one field, auto removes the width, and names a variable that wins', () => {
    writeFileSync(file(), JSON.stringify({ style: 'quiet', other: 'kept' }))
    expect(saveSetting('motion', 'off', {}, file())).toBe('Status line motion: off.')
    expect(saveSetting('width', '120', {}, file())).toBe('Status line width: 120.')
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ style: 'quiet', other: 'kept', motion: false, width: 120 })
    expect(saveSetting('width', 'auto', {}, file())).toBe('Status line width: auto (100).')
    expect(JSON.parse(readFileSync(file(), 'utf8')).width).toBeUndefined()
    expect(saveSetting('style', 'hud', { CLAUDE_STATUSLINE_STYLE: 'quiet' }, file()))
      .toBe('Status line style: hud. CLAUDE_STATUSLINE_STYLE is set, and it wins over the file.')
  })

  test('theme: a scheme name from the file, the variable or a command; others are errors', () => {
    writeFileSync(file(), JSON.stringify({ theme: 'nord' }))
    expect(loadSettings({}, file()).theme).toBe('nord')
    expect(loadSettings({ CLAUDE_STATUSLINE_THEME: 'catppuccin-latte' }, file()).theme).toBe('catppuccin-latte')
    expect(() => loadSettings({ CLAUDE_STATUSLINE_THEME: 'solarized' }, file())).toThrow('CLAUDE_STATUSLINE_THEME=solarized is not valid (default|terminal|')
    expect(saveSetting('theme', 'dracula', {}, file())).toBe('Status line theme: dracula.')
    expect(JSON.parse(readFileSync(file(), 'utf8')).theme).toBe('dracula')
  })

  test('saveSetting rejects a bad value or name and changes nothing', () => {
    writeFileSync(file(), '{}')
    expect(() => saveSetting('style', 'loud', {}, file())).toThrow('usage: claude-statusline style hud|quiet')
    expect(() => saveSetting('width', '9999', {}, file())).toThrow('usage: claude-statusline width 40..400|auto')
    expect(() => saveSetting('colour', 'red', {}, file())).toThrow('unknown setting "colour"')
    expect(readFileSync(file(), 'utf8')).toBe('{}')
  })
})
