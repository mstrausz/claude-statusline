import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

// What this session is working on now, drawn dim at the end of the hint line under the
// prompt, after the permission-mode pill. The engine puts its own " · " before `tail`.
//
// claude-statusline keeps two files per session in <config>/cache/turns/, where <config> is
// Claude Code's config folder (CLAUDE_CONFIG_DIR, else .claude in the home folder):
//   <session_id>.scope  a label Haiku rewrites each new turn from the recent prompts
//   <session_id>.title  Claude Code's own session title (fixed after the first prompt),
//                       shown until the first scope label exists
// The mod API has no getter for either, so this mod polls the files.
//
// Each poll reads the session id again: after /clear or /resume the process goes on
// under a new id, and no session.start fires for it.

const scope = atom({ plugin: 'session-scope', key: 'scope' } as const, '')
const POLL_MS = 3000

let polling = false

async function readLine($: Engine, path: string) {
  return $.fs.read(path).then(
    t => t.trim(),
    () => '',
  )
}

// The binary finds the home folder with os.homedir(): USERPROFILE on Windows, HOME elsewhere.
async function turnsDir($: Engine) {
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ||
    `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))}/.claude`
  return `${config}/cache/turns`
}

async function poll($: Engine, dir: string) {
  const base = `${dir}/${await $.session.id()}`
  const text = (await readLine($, `${base}.scope`)) || (await readLine($, `${base}.title`))
  if (text !== (await read($, scope))) await update($, scope, () => text)
}

async function startPolling($: Engine) {
  if (polling) return
  polling = true
  const dir = await turnsDir($)
  await poll($, dir)
  $.clock.every(POLL_MS, () => void poll($, dir))
}

export const register: Register = on => {
  polling = false

  on('session.start', async ($, e, next) => {
    await startPolling($)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    void startPolling($) // in case the mod loaded after the session started
    const text = await read($, scope)
    return next(text ? { ...e, props: { ...e.props, tail: text } } : e)
  })
}
