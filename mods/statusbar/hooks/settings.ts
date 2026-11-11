import type { EngineInterface } from 'claude-code'

import type { ConfigFile, SettingName, SettingsState } from '../types'
import { configFile, fileState, message, parseObject, readIfExists } from './files'

// The settings /statusbar changes. The binary reads them on each render, in this order: the
// environment variable, else the field in claude-statusline.json, else its default. The mod
// writes only the file; src/settings.ts in the repository holds the same rules.

type ConfigValue = NonNullable<ConfigFile[SettingName]>

const WIDTH_MIN = 40
const WIDTH_MAX = 400

type Spec = {
  /** The word after /statusbar, and the field's name in the file. */
  name: SettingName
  /** How the toast names it: `Style is set by ...`. */
  title: string
  values: readonly string[]
  /** The text the person typed as the field's value; undefined when it is not valid. */
  parse: (text: string) => ConfigValue | undefined
  /** The field as the pane's Select shows it. */
  show: (value: unknown) => string | undefined
  usage: string
  env: string
}

const oneOf = (values: readonly string[]) => ({
  values,
  parse: (text: string) => (values.includes(text) ? (text as ConfigValue) : undefined),
  show: (value: unknown) => (typeof value === 'string' && values.includes(value) ? value : undefined),
  usage: values.join('|'),
})

const onOff = {
  values: ['on', 'off'],
  parse: (text: string) => (text === 'on' ? true : text === 'off' ? false : undefined),
  show: (value: unknown) => (value === true ? 'on' : value === false ? 'off' : undefined),
  usage: 'on|off',
}

export const SPECS: Record<SettingName, Spec> = {
  style: {
    name: 'style',
    title: 'Style',
    ...oneOf(['hud', 'quiet']),
    env: 'CLAUDE_STATUSLINE_STYLE',
  },
  glyphs: {
    name: 'glyphs',
    title: 'Glyphs',
    ...oneOf(['unicode', 'ascii', 'nerd']),
    env: 'CLAUDE_STATUSLINE_GLYPHS',
  },
  motion: {
    name: 'motion',
    title: 'Motion',
    ...onOff,
    env: 'CLAUDE_STATUSLINE_MOTION',
  },
  links: {
    name: 'links',
    title: 'Links',
    ...onOff,
    env: 'CLAUDE_STATUSLINE_LINKS',
  },
  width: {
    name: 'width',
    title: 'Width',
    values: [],
    // `auto` is not a value: it removes the field (setSetting).
    parse: text => (/^\d+$/.test(text) && Number(text) >= WIDTH_MIN && Number(text) <= WIDTH_MAX ? Number(text) : undefined),
    show: value => (typeof value === 'number' ? String(value) : undefined),
    usage: '<cells>|auto',
    env: 'CLAUDE_STATUSLINE_WIDTH',
  },
}

const isSetting = (word: string): word is SettingName => Object.hasOwn(SPECS, word)

/**
 * The variable that wins over the file's field. $.env.get takes a string literal only
 * (`claude plugin validate` lists what is read), so each setting has its own call.
 */
export async function readEnvOf($: EngineInterface, name: SettingName) {
  switch (name) {
    case 'style':
      return $.env.get('CLAUDE_STATUSLINE_STYLE')
    case 'glyphs':
      return $.env.get('CLAUDE_STATUSLINE_GLYPHS')
    case 'motion':
      return $.env.get('CLAUDE_STATUSLINE_MOTION')
    case 'links':
      return $.env.get('CLAUDE_STATUSLINE_LINKS')
    case 'width':
      return $.env.get('CLAUDE_STATUSLINE_WIDTH')
  }
}

export const usageOf = (spec: Spec) => `Usage: /statusbar ${spec.name} ${spec.usage}`
export const USAGE = `Usage: /statusbar [${Object.values(SPECS)
  .map(spec => `${spec.name} ${spec.usage}`)
  .join(' | ')}]`

/** The variables that win over the file: each one set and not empty, as the binary reads them. */
async function readEnv($: EngineInterface) {
  const env: SettingsState['env'] = {}
  for (const spec of Object.values(SPECS)) {
    const value = await readEnvOf($, spec.name)
    if (value) env[spec.name] = value
  }
  return env
}

/** What the SETTINGS group draws from: the config file and the variables, read now. */
export async function readSettings($: EngineInterface): Promise<SettingsState> {
  return { file: await fileState($, await configFile($), parseObject), env: await readEnv($) }
}

/**
 * Sets one field of claude-statusline.json from `/statusbar <name> <text>` and keeps the
 * others; `width auto` removes the width. Answers what the person reads: the new value, or
 * why nothing changed.
 */
export async function setSetting($: EngineInterface, name: string, args: readonly string[]): Promise<string> {
  if (!isSetting(name)) return USAGE
  const spec = SPECS[name]
  const text = args.length === 1 ? args[0]! : undefined
  const isAuto = name === 'width' && text === 'auto'
  const value = text === undefined ? undefined : spec.parse(text)
  if (!isAuto && value === undefined) return usageOf(spec)

  const path = await configFile($)
  let stored: Record<string, unknown>
  try {
    const found = await readIfExists($, path)
    stored = found === undefined ? {} : parseObject(found)
  } catch (err) {
    // A file that does not parse is the person's to fix: writing over it would lose it.
    return `Status line ${name} not changed: ${path}: ${message(err)}`
  }
  if (isAuto) delete stored[name]
  else stored[name] = value
  try {
    await $.fs.write(path, `${JSON.stringify(stored, null, 2)}\n`)
  } catch (err) {
    return `Status line ${name} not saved: ${path}: ${message(err)}`
  }

  const said = `Status line ${name}: ${isAuto ? 'auto' : text}`
  return (await readEnvOf($, name)) ? `${said}. ${spec.title} is set by ${spec.env}.` : said
}
