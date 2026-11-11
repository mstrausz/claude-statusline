// The user's settings: an environment variable, else the field in claude-statusline.json in
// Claude Code's config folder, else the default. A value that is not valid is an error, shown
// in the status line, never replaced by a default in silence.
//
// The file is written by `claude-statusline <setting> <value>` and by the mod's /statusbar.

import { join } from 'node:path'
import { configDir, readIfExists, writeAtomic } from './env.ts'
import { THEME_NAMES, type ThemeName } from './style/themes.ts'

export type Style = 'hud' | 'quiet'
export type Glyphs = 'unicode' | 'ascii' | 'nerd'
export type Settings = { style: Style; theme: ThemeName; glyphs: Glyphs; motion: boolean; links: boolean; width: number }

export const DEFAULTS: Settings = { style: 'hud', theme: 'default', glyphs: 'unicode', motion: true, links: true, width: 100 }
export const WIDTH_MIN = 40
export const WIDTH_MAX = 400

export class SettingsError extends Error {}

type Spec<K extends keyof Settings> = {
  env: string
  /** The value from an environment variable or a command argument. */
  parse: (text: string) => Settings[K] | undefined
  /** True when a value read from the file is valid. */
  valid: (value: unknown) => value is Settings[K]
  usage: string
}

const oneOf = <T extends string>(...xs: T[]) => ({
  parse: (t: string) => (xs as string[]).includes(t) ? (t as T) : undefined,
  valid: (v: unknown): v is T => typeof v === 'string' && (xs as string[]).includes(v),
  usage: xs.join('|'),
})
const onOff = {
  parse: (t: string) => (t === 'on' ? true : t === 'off' ? false : undefined),
  valid: (v: unknown): v is boolean => typeof v === 'boolean',
  usage: 'on|off',
}
const isWidth = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= WIDTH_MIN && v <= WIDTH_MAX

export const SPECS: { [K in keyof Settings]: Spec<K> } = {
  style: { env: 'CLAUDE_STATUSLINE_STYLE', ...oneOf<Style>('hud', 'quiet') },
  theme: { env: 'CLAUDE_STATUSLINE_THEME', ...oneOf<ThemeName>(...THEME_NAMES) },
  glyphs: { env: 'CLAUDE_STATUSLINE_GLYPHS', ...oneOf<Glyphs>('unicode', 'ascii', 'nerd') },
  motion: { env: 'CLAUDE_STATUSLINE_MOTION', ...onOff },
  links: { env: 'CLAUDE_STATUSLINE_LINKS', ...onOff },
  width: {
    env: 'CLAUDE_STATUSLINE_WIDTH',
    parse: t => (/^\d+$/.test(t) && isWidth(Number(t)) ? Number(t) : undefined),
    valid: isWidth,
    usage: `${WIDTH_MIN}..${WIDTH_MAX}|auto`,
  },
}

export const settingsFile = (config = configDir()) => join(config, 'claude-statusline.json')

function readFile(file: string): Record<string, unknown> {
  let json: unknown
  try {
    // An empty file is the moment between the truncate and the write of the mod's
    // /statusbar, whose file API has no rename: no setting yet, not an error.
    const text = readIfExists(file)
    json = text === undefined || text.trim() === '' ? {} : JSON.parse(text)
  } catch (e) {
    throw new SettingsError(`${file}: ${(e as Error).message}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    throw new SettingsError(`${file} is not a JSON object`)
  return json as Record<string, unknown>
}

/** The settings in effect. Throws SettingsError for a value that is not valid. */
export function loadSettings(env = process.env, file = settingsFile()): Settings {
  const stored = readFile(file)
  const out = { ...DEFAULTS } as Record<keyof Settings, unknown>
  for (const key of Object.keys(SPECS) as (keyof Settings)[]) {
    const spec = SPECS[key] as Spec<typeof key>
    const fromEnv = env[spec.env]
    if (fromEnv !== undefined && fromEnv !== '') {
      const v = spec.parse(fromEnv)
      if (v === undefined) throw new SettingsError(`${spec.env}=${fromEnv} is not valid (${spec.usage})`)
      out[key] = v
    } else if (key in stored) {
      if (!spec.valid(stored[key])) throw new SettingsError(`"${key}": ${JSON.stringify(stored[key])} in ${file} is not valid (${spec.usage})`)
      out[key] = stored[key]
    }
  }
  return out as Settings
}

/**
 * Sets one setting in the file from a command argument (`auto` removes the width), and
 * returns a line for the person. Throws SettingsError with the usage for a bad value.
 */
export function saveSetting(key: string, text: string | undefined, env = process.env, file = settingsFile()): string {
  if (!(key in SPECS)) throw new SettingsError(`unknown setting "${key}" (${Object.keys(SPECS).join(', ')})`)
  const k = key as keyof Settings
  const spec = SPECS[k] as Spec<typeof k>
  const stored = readFile(file)
  if (k === 'width' && text === 'auto') delete stored.width
  else {
    const v = text === undefined ? undefined : spec.parse(text)
    if (v === undefined) throw new SettingsError(`usage: claude-statusline ${key} ${spec.usage}`)
    stored[k] = v
  }
  writeAtomic(file, JSON.stringify(stored, null, 2) + '\n')
  const shown = k === 'width' && text === 'auto' ? `auto (${DEFAULTS.width})` : text
  const overridden = env[spec.env] ? ` ${spec.env} is set, and it wins over the file.` : ''
  return `Status line ${key}: ${shown}.${overridden}`
}
