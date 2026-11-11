// The platform layer: every path, process and file rule that differs between Linux, macOS
// and Windows lives here, so the rest of the program is the same on all three.

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const EXE = IS_WINDOWS ? '.exe' : ''

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude, the rule Claude Code uses. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function paths(config = configDir()) {
  const cache = join(config, 'cache')
  return {
    config,
    settings: join(config, 'settings.json'),
    credentials: join(config, '.credentials.json'),
    cache,
    turns: join(cache, 'turns'),
    usage: join(cache, 'statusline-usage.json'),
    ccusage: join(cache, 'statusline-ccusage.json'),
    input: join(cache, 'statusline-input.json'),
    log: join(cache, 'statusline.log'),
    bin: join(config, 'bin', `claude-statusline${EXE}`),
    mod: join(config, 'mods', 'session-scope'),
    legacyScript: join(config, 'statusline.sh'),
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)

/** True when this process is the compiled binary, false under `bun src/main.ts`. */
export function isCompiled(): boolean {
  return Bun.main.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main)
}

/** The argv that starts this program again: the binary, or bun with the entry script. */
export function selfArgv(): string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, Bun.main]
}

/** The argv of a bun CLI: the compiled binary acts as one when BUN_BE_BUN=1 is set. */
export function bunArgv(): { argv: string[]; env: Record<string, string> } {
  return { argv: [process.execPath], env: isCompiled() ? { BUN_BE_BUN: '1' } : {} }
}

/** Starts this program again with args, detached: it outlives the caller and has no window. */
export function spawnSelfDetached(args: string[], env: Record<string, string> = {}) {
  const [cmd, ...pre] = selfArgv()
  spawn(cmd!, [...pre, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...env },
  }).unref()
}

/**
 * The path of the `claude` CLI, or undefined when it is not installed.
 *
 * Hooks inherit the PATH of the Claude Code process, which can lack the install folder
 * (an app started from the dock or the Start menu), so the native installer's and
 * Homebrew's folders are searched after PATH.
 */
export function claudePath(): string | undefined {
  const known = [
    join(homedir(), '.local', 'bin', `claude${EXE}`),
    ...(IS_MAC ? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : []),
  ]
  return Bun.which('claude') ?? known.find(p => existsSync(p))
}

export type ClaudeRun = { input?: string; cwd?: string; env?: Record<string, string>; seconds?: number }

/**
 * Runs the claude CLI with args and waits for it. Throws when the CLI is not installed.
 *
 * On Windows an npm install leaves a `claude.cmd` shim, which only cmd.exe starts. cmd.exe
 * reads one command line, so the shim and its args are quoted the way cmd.exe splits them
 * and passed verbatim (the default quoting escapes with backslashes, which cmd.exe keeps).
 */
export function spawnClaude(args: string[], opts: ClaudeRun = {}) {
  const claude = claudePath()
  if (!claude) throw new Error('the claude CLI is not installed or not on PATH')
  const shim = IS_WINDOWS && /\.(cmd|bat)$/i.test(claude)
  const quote = (a: string) => (a === '' || /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  const [cmd, argv] = shim
    ? ['cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map(quote).join(' ')}"`]]
    : [claude, args]
  return spawnSync(cmd, argv, {
    input: opts.input,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: shim,
    killSignal: 'SIGKILL',
    ...(opts.seconds ? { timeout: opts.seconds * 1000 } : {}),
  })
}

/** spawnClaude, then its stdout; throws when it cannot start, runs too long or fails. */
export function runClaude(args: string[], opts: ClaudeRun): string {
  const r = spawnClaude(args, opts)
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`claude exited with ${r.status ?? r.signal}: ${r.stderr.trim()}`)
  return r.stdout
}

/**
 * The OAuth access token of the signed-in Claude subscription, or undefined when signed out.
 *
 * macOS keeps it in the login Keychain; /usr/bin/security is on that item's access list,
 * so reading it shows no prompt. Claude Code writes the credentials file instead when the
 * Keychain cannot be used, and on Linux and Windows always.
 */
export function oauthToken(): string | undefined {
  const fromJson = (text: string): string | undefined =>
    JSON.parse(text)?.claudeAiOauth?.accessToken || undefined
  if (IS_MAC) {
    const r = Bun.spawnSync(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'])
    if (r.exitCode === 0) return fromJson(r.stdout.toString())
  }
  const text = readIfExists(paths().credentials)
  return text === undefined ? undefined : fromJson(text)
}

/**
 * All of stdin, read synchronously. An asynchronous read (Bun.stdin.text()) of a Windows
 * pipe does not keep the process alive: it ended with exit code 0 and printed nothing.
 */
export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EOF') return '' // Windows: an empty pipe
    throw e
  }
}

/** The file's text, or undefined when it does not exist. Other read errors throw. */
export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** Parsed JSON of the file, or undefined when it does not exist. */
export function readJsonIfExists(path: string): any {
  const text = readIfExists(path)
  return text === undefined ? undefined : JSON.parse(text)
}

export function removeIfExists(path: string) {
  try {
    unlinkSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * Replaces the file in one step, so a reader sees the old text or the new, never half.
 *
 * On Windows a rename onto a file that another process has open fails with a sharing
 * error until that process lets go (the mod reads these files every 3 seconds), so the
 * rename is tried again on that error alone.
 */
export function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, text)
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!IS_WINDOWS || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt === 20) {
        removeIfExists(tmp)
        throw e
      }
      Bun.sleepSync(25)
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // alive, owned by another user
  }
}

/**
 * Runs fn unless another live process holds the lock file; returns whether fn ran.
 *
 * The lock holds its owner's pid. It is created whole with a hard link, so no reader sees
 * it empty, and a lock whose process is gone (killed, or the machine slept through it) is
 * taken over instead of blocking every later run.
 */
export async function withLock(lock: string, fn: () => Promise<void>): Promise<boolean> {
  mkdirSync(dirname(lock), { recursive: true })
  const mine = `${lock}.${process.pid}`
  writeFileSync(mine, String(process.pid))
  try {
    if (!tryLink(mine, lock)) {
      const owner = Number(readIfExists(lock))
      if (owner && processAlive(owner)) return false
      removeIfExists(lock)
      if (!tryLink(mine, lock)) return false // another process took it over first
    }
  } finally {
    removeIfExists(mine)
  }
  try {
    await fn()
    return true
  } finally {
    removeIfExists(lock)
  }
}

function tryLink(from: string, to: string): boolean {
  try {
    linkSync(from, to)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

const LOG_ROTATE_BYTES = 1_000_000 // offline, the usage refresh fails twice a minute

/** Notes an error of a detached job, which has no terminal to print it to. */
export function logError(job: string, error: unknown) {
  const p = paths()
  mkdirSync(p.cache, { recursive: true })
  if ((statSync(p.log, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES) renameSync(p.log, `${p.log}.1`)
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  appendFileSync(p.log, `${new Date().toISOString()} ${job}: ${text}\n`)
}

/** The entries of a path list such as CLAUDE_CODE_PLUGIN_DIRS (`:` on POSIX, `;` on Windows). */
export const splitPathList = (list: string | undefined, sep: string = delimiter) =>
  (list ?? '').split(sep).filter(Boolean)
