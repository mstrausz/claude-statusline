import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh CLAUDE_CONFIG_DIR per test, so no test reads or writes the real ~/.claude. */
export function tempConfig(): { readonly dir: string } {
  const state = { dir: '' }
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR
    state.dir = mkdtempSync(join(tmpdir(), 'claude-statusline-test-'))
    process.env.CLAUDE_CONFIG_DIR = state.dir
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    rmSync(state.dir, { recursive: true, force: true })
  })
  return state
}

export const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
