import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

// What this session is working on now, drawn dim at the end of the hint line under the
// prompt, after the permission-mode pill.
//
// ~/.claude/statusline.sh keeps two files per session under ~/.claude/cache/turns/:
//   <session_id>.scope  a label Haiku rewrites each new turn from the recent prompts
//   <session_id>.title  Claude Code's own session title (fixed after the first prompt),
//                       the fallback until the first scope label exists
// The mod API has no getter for either, so this mod polls the files.

const scope = atom({ plugin: 'session-scope', key: 'scope' } as const, '')
const POLL_MS = 3000

let polling = false

async function readLine($: Engine, path: string) {
  return $.fs.read(path).then(
    t => t.trim(),
    () => '',
  )
}

async function poll($: Engine, base: string) {
  const text = (await readLine($, `${base}.scope`)) || (await readLine($, `${base}.title`))
  if (text !== (await read($, scope))) await update($, scope, () => text)
}

async function startPolling($: Engine) {
  if (polling) return
  polling = true
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  const base = `${home}/.claude/cache/turns/${id}`
  await poll($, base)
  $.clock.every(POLL_MS, () => void poll($, base))
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
    return next(text ? { ...e, props: { ...e.props, tail: ` · ${text}` } } : e)
  })
}
