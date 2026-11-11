// Read at build time through `with { type: 'macro' }`: the binary carries the mod's files,
// so the installer needs nothing from the repository.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const MOD = join(import.meta.dir, '..', 'mods', 'session-scope')
// Written by Claude Code when the mod loads, and the mod's own tests: not installed.
const SKIP = /(^|\/)\.claude-plugin\/types\/|\.test\.tsx?$/

/** The mod's files by path relative to its folder, with `/` separators. */
export function modFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const e of readdirSync(MOD, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const path = join(e.parentPath, e.name)
    const rel = relative(MOD, path).split('\\').join('/')
    if (!SKIP.test(rel)) files[rel] = readFileSync(path, 'utf8')
  }
  return files
}
