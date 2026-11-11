// claude-statusline: one binary that is the status line command, the turn hook handler, its
// own background jobs, and its installer.

import { writeSync } from 'node:fs'
import { version } from '../package.json' with { type: 'json' }
import { logError, readStdin } from './env.ts'
import { install, InstallError, uninstall } from './install.ts'
import { refreshCcusage, refreshUsage, runJob } from './refresh.ts'
import { render, startDueRefreshes } from './render.ts'
import { summarize, turnHook, type HookKind } from './turns.ts'

const HOOKS: Record<string, HookKind> = {
  '--turn-start': 'start',
  '--turn-activity': 'activity',
  '--turn-end': 'end',
  '--turn-idle': 'idle',
}

const USAGE = `claude-statusline ${version}

  claude-statusline install     install into Claude Code (CLAUDE_CONFIG_DIR or ~/.claude)
  claude-statusline uninstall   remove it again
  claude-statusline --version

Claude Code runs it with no arguments as the status line, and with --turn-* as hooks.`

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args
  if (cmd === undefined) {
    // The status line. An error shows in the line itself, in red, instead of an empty line.
    // The write is synchronous and comes before the background jobs start: on Windows an
    // asynchronous write to the pipe can be lost when the process ends.
    let text: string
    try {
      text = render(readStdin())
    } catch (e) {
      logError('render', e)
      text = `\x1b[0;31mclaude-statusline: ${(e as Error).message}\x1b[0m`
    }
    writeSync(1, text)
    startDueRefreshes()
    return 0
  }
  if (cmd in HOOKS) {
    // A hook prints nothing on stdout. An error goes to stderr with exit 1, which Claude
    // Code reports as a hook error without blocking the turn.
    turnHook(HOOKS[cmd]!, JSON.parse(readStdin()))
    return 0
  }
  switch (cmd) {
    case '--refresh-usage':
      await runJob('refresh-usage', refreshUsage)
      return 0
    case '--refresh-ccusage':
      await runJob('refresh-ccusage', refreshCcusage)
      return 0
    case '--summarize':
      summarize(rest[0] ?? '', rest[1] ?? '', rest[2] ?? '')
      return 0
    case 'install':
    case 'uninstall':
      try {
        cmd === 'install' ? install() : uninstall()
        return 0
      } catch (e) {
        if (!(e instanceof InstallError)) throw e
        console.error(`\x1b[1;31merror:\x1b[0m ${e.message}`)
        return 1
      }
    case '--version':
    case 'version':
      console.log(version)
      return 0
    case '--help':
    case 'help':
      console.log(USAGE)
      return 0
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`)
      return 2
  }
}

// No top-level await: the bytecode build does not take it.
main(process.argv.slice(2)).then(
  code => (process.exitCode = code),
  error => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  },
)
