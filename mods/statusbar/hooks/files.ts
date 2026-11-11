import type { EngineInterface } from 'claude-code'

import type { FileState } from '../types'

// The binary finds the home folder with os.homedir(): USERPROFILE on Windows, HOME elsewhere.
export async function configDir($: EngineInterface) {
  return (
    (await $.env.get('CLAUDE_CONFIG_DIR')) ||
    `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))}/.claude`
  )
}

// Each helper that takes $ is a function declaration: the engine follows $ past an import
// into those alone.

export async function turnsDir($: EngineInterface) {
  return `${await configDir($)}/cache/turns`
}

export async function configFile($: EngineInterface) {
  return `${await configDir($)}/claude-statusline.json`
}

/** The files of the session that runs now: the id changes after /clear or /resume. */
export async function sessionBase($: EngineInterface) {
  return `${await turnsDir($)}/${await $.session.id()}`
}

/**
 * The file's text, or undefined when it does not exist yet. A file that exists and cannot
 * be read rejects: that is a fault to show, not a state to hide.
 */
export async function readIfExists($: EngineInterface, path: string) {
  return (await $.fs.exists(path)) ? $.fs.read(path) : undefined
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Reads and checks a file, and says which of the three states it is in. */
export async function fileState<T>($: EngineInterface, path: string, parse: (text: string) => T): Promise<FileState<T>> {
  try {
    const text = await readIfExists($, path)
    return text === undefined ? { status: 'missing' } : { status: 'ok', value: parse(text) }
  } catch (err) {
    return { status: 'error', message: `${path}: ${message(err)}` }
  }
}

/** JSON.parse, held to a JSON object: what the config file and the view file must be. */
export function parseObject(text: string): Record<string, unknown> {
  const json: unknown = JSON.parse(text)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('not a JSON object')
  return json as Record<string, unknown>
}
