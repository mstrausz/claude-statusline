// `claude-statusline install` / `uninstall`: puts the binary and the session-scope mod into
// Claude Code's config folder and merges the settings they need into settings.json.
//
// Safe to run again: files are replaced in place, and only this program's own settings
// entries are replaced, never duplicated; everything else in settings.json stays as it is.
// settings.json is backed up before each change.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { version } from '../package.json' with { type: 'json' }
import {
  claudePath, isCompiled, IS_WINDOWS, oauthToken, paths, readIfExists, removeIfExists,
  spawnClaude, splitPathList, writeAtomic,
} from './env.ts'
import { modFiles } from './mod-files.ts' with { type: 'macro' }

const say = (s: string) => console.log(`\x1b[1;32m==>\x1b[0m ${s}`)
const warn = (s: string) => console.error(`\x1b[1;33mwarning:\x1b[0m ${s}`)
class InstallError extends Error {}

type Hook = { type: string; command: string; args?: string[]; timeout?: number; async?: boolean }
type Group = { matcher?: string; hooks: Hook[] }

/** The hooks this program handles: event, matcher, argument, async. */
const HOOKS: [event: string, matcher: string | undefined, arg: string, async: boolean][] = [
  ['UserPromptSubmit', undefined, '--turn-start', false],
  ['PreToolUse', undefined, '--turn-activity', true],
  ['Stop', undefined, '--turn-end', false],
  ['StopFailure', undefined, '--turn-end', false],
  ['Notification', 'idle_prompt', '--turn-idle', false],
]

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? ''
/** This program's hook, or the bash version's (`statusline.sh --turn-…`) it replaces. */
const isOurHook = (h: Hook) =>
  /statusline\.sh --turn-/.test(h.command ?? '') || /^claude-statusline(\.exe)?$/i.test(baseName(h.command ?? ''))
const isOurStatusLine = (command: string | undefined) =>
  !!command && /(^|[\\/'"~])(claude-statusline(\.exe)?|statusline\.sh)['"]?$/.test(command)

/**
 * The statusLine command: a shell string (no exec form exists for it). Claude Code runs it
 * with sh on macOS and Linux, and with Git Bash or PowerShell on Windows. Forward slashes and
 * `~` read the same in all three; a backslash is an escape in Git Bash, and `~` keeps the
 * spaces of a Windows user folder out of the string.
 */
export function statusLineCommand(bin: string, home = homedir(), windows = IS_WINDOWS): string {
  if (!windows) return /[\s'"$`\\]/.test(bin) ? `'${bin.replace(/'/g, `'\\''`)}'` : bin
  const underHome = bin.toLowerCase().startsWith(home.toLowerCase()) && /[\\/]/.test(bin[home.length] ?? '')
  return (underHome ? '~' + bin.slice(home.length) : bin).replace(/\\/g, '/')
}

export type Targets = { statusLine: string; bin: string; modDir: string; delimiter: string }

/** settings with this program's entries replaced or added; other entries are kept. */
export function mergeSettings(settings: any, t: Targets): any {
  const out = structuredClone(settings)
  out.statusLine = { type: 'command', command: t.statusLine, refreshInterval: 1 }
  out.hooks ??= {}
  for (const [event, matcher, arg, async] of HOOKS) {
    const others = (out.hooks[event] ?? []).filter((g: Group) => !(g.hooks ?? []).some(isOurHook))
    // Exec form (command + args): no shell, so no quoting, on every platform.
    const hook: Hook = { type: 'command', command: t.bin, args: [arg], timeout: 5, ...(async ? { async } : {}) }
    out.hooks[event] = [...others, { ...(matcher ? { matcher } : {}), hooks: [hook] }]
  }
  out.env ??= {}
  out.env.CLAUDE_CODE_PLUGIN_DIRS = [
    ...splitPathList(out.env.CLAUDE_CODE_PLUGIN_DIRS, t.delimiter).filter(d => d !== t.modDir),
    t.modDir,
  ].join(t.delimiter)
  return out
}

/** settings without this program's entries; other entries are kept. */
export function unmergeSettings(settings: any, t: Pick<Targets, 'modDir' | 'delimiter'>): any {
  const out = structuredClone(settings)
  if (isOurStatusLine(out.statusLine?.command)) delete out.statusLine
  for (const event of Object.keys(out.hooks ?? {})) {
    out.hooks[event] = out.hooks[event].filter((g: Group) => !(g.hooks ?? []).some(isOurHook))
    if (out.hooks[event].length === 0) delete out.hooks[event]
  }
  if (out.hooks && Object.keys(out.hooks).length === 0) delete out.hooks
  if (out.env?.CLAUDE_CODE_PLUGIN_DIRS !== undefined) {
    const dirs = splitPathList(out.env.CLAUDE_CODE_PLUGIN_DIRS, t.delimiter).filter(d => d !== t.modDir)
    if (dirs.length) out.env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(t.delimiter)
    else delete out.env.CLAUDE_CODE_PLUGIN_DIRS
  }
  return out
}

function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Reads settings.json (an empty object when there is none) and backs it up. */
function loadSettings(file: string): { settings: any; backup?: string } {
  const text = readIfExists(file)
  if (text === undefined) return { settings: {} }
  let settings: any
  try {
    settings = JSON.parse(text)
  } catch (e) {
    throw new InstallError(`${file} is not valid JSON (${(e as Error).message}); fix it first`)
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
    throw new InstallError(`${file} is not a JSON object; fix it first`)
  const backup = `${file}.bak.${stamp()}`
  copyFileSync(file, backup)
  return { settings, backup }
}

const saveSettings = (file: string, settings: any) => writeAtomic(file, JSON.stringify(settings, null, 2) + '\n')

/**
 * Copies this binary to dest. A running binary cannot be overwritten on Windows (the status
 * line runs every second), but it can be renamed: the old one moves aside and is deleted on
 * the next install, once nothing runs it.
 */
function installBinary(dest: string) {
  if (resolve(process.execPath) === resolve(dest)) return
  mkdirSync(dirname(dest), { recursive: true })
  if (IS_WINDOWS) {
    const old = `${dest}.old`
    try {
      removeIfExists(old)
    } catch (e) {
      throw new InstallError(`${old} is still in use (${(e as Error).message}); close Claude Code and run the installer again`)
    }
    if (existsSync(dest)) renameSync(dest, old)
    copyFileSync(process.execPath, dest)
  } else {
    const tmp = `${dest}.tmp.${process.pid}`
    copyFileSync(process.execPath, tmp)
    chmodSync(tmp, 0o755)
    renameSync(tmp, dest) // running copies keep the old file until they exit
  }
}

function assertOurMod(dir: string) {
  const manifest = readIfExists(join(dir, '.claude-plugin', 'plugin.json'))
  if (manifest === undefined || JSON.parse(manifest).name !== 'session-scope')
    throw new InstallError(`${dir} exists but is not the session-scope mod; move it away and run again`)
}

function installMod(dir: string) {
  if (existsSync(dir)) {
    assertOurMod(dir)
    rmSync(dir, { recursive: true })
  }
  for (const [rel, text] of Object.entries(modFiles())) {
    const file = join(dir, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

const CLAUDE_INSTALL = IS_WINDOWS
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash'

function smokeTest(bin: string) {
  const input = JSON.stringify({ model: { display_name: 'Smoke test' }, workspace: { current_dir: homedir() } })
  const r = spawnSync(bin, [], { input, encoding: 'utf8', windowsHide: true })
  const out = (r.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  if (r.status !== 0 || !out.includes('Smoke test'))
    throw new InstallError(`the status line did not render (exit ${r.status}): ${out || r.stderr || r.error}`)
  console.log(out.split('\n').map(l => `    ${l}`).join('\n'))
}

export function install() {
  const p = paths()
  say(`Installing claude-statusline ${version} into ${p.config}`)
  if (!isCompiled()) throw new InstallError('run the built binary: bun run build, then dist/claude-statusline install')

  const claude = claudePath()
  if (!claude) warn(`the claude CLI is not on PATH: the Haiku task and scope labels need it. Install it with: ${CLAUDE_INSTALL}`)
  if (!oauthToken()) warn('not signed in to a Claude subscription: run "claude auth login"; until then the limit segments stay empty')

  say(`Binary: ${p.bin}`)
  installBinary(p.bin)
  say(`Mod: ${p.mod}`)
  installMod(p.mod)

  say(`Settings: ${p.settings}`)
  const { settings, backup } = loadSettings(p.settings)
  const previous = settings.statusLine?.command
  if (previous && !isOurStatusLine(previous))
    warn(`replacing your statusLine command (${previous})${backup ? `; it is kept in ${backup}` : ''}`)
  const statusLine = statusLineCommand(p.bin)
  if (IS_WINDOWS && /\s/.test(statusLine))
    warn(`the binary's path has spaces (${statusLine}), which Git Bash and PowerShell read differently; set CLAUDE_CONFIG_DIR to a folder without spaces if the status line stays empty`)
  saveSettings(p.settings, mergeSettings(settings, { statusLine, bin: p.bin, modDir: p.mod, delimiter }))

  const legacy = readIfExists(p.legacyScript)
  if (legacy?.includes('# Claude Code statusline.')) {
    removeIfExists(p.legacyScript)
    say(`Removed the bash version (${p.legacyScript})`)
  }

  say('Smoke test')
  smokeTest(p.bin)
  if (claude) {
    const v = spawnClaude(['plugin', 'validate', p.mod])
    if (v.status === 0) say('session-scope mod validates')
    else warn(`the session-scope mod did not validate: run "claude plugin validate ${p.mod}"`)
  }
  console.log(`
Done. Restart running Claude Code sessions (exit, then "claude --continue") so they load
the hooks and the session-scope mod.${backup ? ` Settings backup: ${backup}` : ''}`)
}

export function uninstall() {
  const p = paths()
  say(`Removing claude-statusline from ${p.config}`)
  const { settings, backup } = loadSettings(p.settings)
  saveSettings(p.settings, unmergeSettings(settings, { modDir: p.mod, delimiter }))
  if (backup) say(`Settings: entries removed; backup ${backup}`)
  if (existsSync(p.mod)) {
    assertOurMod(p.mod)
    rmSync(p.mod, { recursive: true })
    say(`Removed ${p.mod}`)
  }
  for (const f of ['statusline-usage.json', 'statusline-ccusage.json', 'statusline-input.json', 'statusline.log', '.usage.stamp', '.ccusage.stamp'])
    removeIfExists(join(p.cache, f))
  rmSync(p.turns, { recursive: true, force: true })
  if (existsSync(p.bin)) {
    if (IS_WINDOWS) {
      // Windows deletes no running binary (this one, or a status line render), but renames it.
      renameSync(p.bin, `${p.bin}.old`)
      say(`Moved ${p.bin} aside; delete ${p.bin}.old once Claude Code is closed`)
    } else {
      removeIfExists(p.bin)
      say(`Removed ${p.bin}`)
    }
  }
  console.log('\nDone. Restart running Claude Code sessions.')
}

export { InstallError }
