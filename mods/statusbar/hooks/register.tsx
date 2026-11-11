import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SettingName } from '../types'
import { fileState, message, sessionBase } from './files'
import { SCOPE_CELLS, label } from './format'
import { PANE, PANE_COLUMNS, PANE_ROWS, drawPane } from './pane'
import { USAGE, readSettings, setSetting } from './settings'
import { parseView } from './view'

// What the claude-statusline binary cannot do from outside Claude Code:
//
// 1. The scope label: what this session works on, drawn dim at the end of the hint line
//    under the prompt, after the permission-mode pill. The engine puts its own " · " before
//    `tail`. The binary keeps two files per session in <config>/cache/turns/, where
//    <config> is Claude Code's config folder (CLAUDE_CONFIG_DIR, else .claude in the home
//    folder):
//      <session_id>.scope  a label Haiku rewrites each new turn from the recent prompts
//      <session_id>.title  Claude Code's own session title (fixed after the first prompt),
//                          shown until the first scope label exists
//    The mod API has no getter for either, so this mod polls the files. Both are cut to the
//    scope label's width, the title too: the binary writes it as Claude Code names it.
// 2. The skill in use, for the badge on the status line: <session_id>.skill, one line, or
//    empty for none. Only the engine knows when a skill starts and ends.
// 3. /statusbar: the settings in claude-statusline.json, and the detail pane, which draws
//    <session_id>.view.json, the binary's figures.
//
// Each poll reads the session id again: after /clear or /resume the process goes on under
// a new id, and no session.start fires for it.

// What the drawings read lives in $.state, not in module variables, so a hot reload keeps
// it. Change a shape tag when that value's fields change: it declines what an earlier
// version stored.
const scope = atom({ plugin: 'statusbar', key: 'scope' } as const, '')
const scopeError = atom({ plugin: 'statusbar', key: 'scopeError' } as const, '')
const skill = atom({ plugin: 'statusbar', key: 'skill' } as const, '')
const view = atom({ plugin: 'statusbar', key: 'view' } as const, { status: 'missing' }, { shape: 'view-1' })
const settings = atom(
  { plugin: 'statusbar', key: 'settings' } as const,
  { file: { status: 'missing' }, env: {} },
  { shape: 'settings-1' },
)
const now = atom({ plugin: 'statusbar', key: 'now' } as const, 0)

const POLL_MS = 3000
const COMMAND = 'statusbar'
const DESCRIPTION = 'Show the status line details, or change a status line setting'
const HINT = '[style hud|quiet | theme <name> | glyphs unicode|ascii|nerd | motion on|off | links on|off | width <cells>|auto]'

let polling = false

async function refreshScope($: EngineInterface, base: string) {
  let text = ''
  const problems: string[] = []
  for (const ext of ['scope', 'title']) {
    const file = await fileState($, `${base}.${ext}`, text => label(text, SCOPE_CELLS))
    if (file.status === 'error') problems.push(file.message)
    else if (file.status === 'ok' && file.value) {
      text = file.value
      break
    }
  }
  const problem = problems.join('; ')
  if (text !== (await read($, scope))) await update($, scope, () => text)
  if (problem !== (await read($, scopeError))) await update($, scopeError, () => problem)
}

async function refreshSettings($: EngineInterface) {
  const next = await readSettings($)
  if (JSON.stringify(next) !== JSON.stringify(await read($, settings))) await update($, settings, () => next)
}

/** `/statusbar <name> <args>`, and a pick in the pane: change the file, then say so. */
async function changeSetting($: EngineInterface, name: string, args: readonly string[]) {
  const said = await setSetting($, name, args)
  await refreshSettings($)
  $.ui.toast(said)
}

/** The pane's data: the binary's figures, the settings, and the clock its countdowns use. */
async function refreshPane($: EngineInterface, base: string) {
  const next = await fileState($, `${base}.view.json`, parseView)
  if (JSON.stringify(next) !== JSON.stringify(await read($, view))) await update($, view, () => next)
  await refreshSettings($)
  const time = await $.clock.now()
  await update($, now, () => time)
}

async function isPaneOpen($: EngineInterface) {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function poll($: EngineInterface) {
  const base = await sessionBase($)
  await refreshScope($, base)
  if (await isPaneOpen($)) await refreshPane($, base)
}

// A failed poll is shown once, not every three seconds, until another fault or a good poll.
let lastFault = ''
async function pollAndReport($: EngineInterface) {
  const fault = await poll($).then(
    () => '',
    err => message(err),
  )
  if (fault && fault !== lastFault) $.ui.log(`statusbar: ${fault}`)
  lastFault = fault
}

async function startPolling($: EngineInterface) {
  if (polling) return
  polling = true
  await pollAndReport($)
  $.clock.every(POLL_MS, () => void pollAndReport($))
}

async function togglePane($: EngineInterface) {
  if (await isPaneOpen($)) return $.ui.close({ id: PANE })
  await refreshPane($, await sessionBase($)) // data before the first draw
  const opened = await $.ui.open({ id: PANE, title: 'Status line', columns: PANE_COLUMNS, rows: PANE_ROWS })
  if (!opened.isPlaced) $.ui.toast(`The status line pane is open, not drawn: ${opened.reason}`)
}

async function setSkill($: EngineInterface, name: string) {
  await $.fs.write(`${await sessionBase($)}.skill`, name ? `${name}\n` : '')
  await update($, skill, () => name)
}

const bare = (name: string) => name.replace(/^\//, '')

/**
 * The `.catch` of a hook that writes the skill file after `next`: says what failed, and
 * keeps what `next` settled to (a replay, nothing runs twice), so the model reads the same.
 */
function surfaced<E, R>($: EngineInterface, e: E, next: { (e: E): R; error: { kind: string; message?: string } }) {
  $.ui.log(`statusbar: ${next.error.message ?? next.error.kind}`)
  return next(e)
}

export const register: Register = on => {
  polling = false
  lastFault = ''

  on('session.start', async ($, e, next) => {
    // Our own name: Claude Code's /statusline, which sets the status line up, stays its own.
    // Immediate: a setting or the pane needs no idle prompt, and neither reads the turn.
    await $.command.register({ name: COMMAND, description: DESCRIPTION, argumentHint: HINT, immediate: true })
    await startPolling($)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    void startPolling($) // in case the mod loaded after the session started
    const text = await read($, scope)
    return next(text ? { ...e, props: { ...e.props, tail: text } } : e)
  })

  // The skill in use. A skill's prompt is expanded for `/name`, the Skill tool and a
  // subagent's preload alike; a newer one replaces the older.
  on('skill.prompt', async ($, e, next) => {
    const expanded = await next(e)
    await setSkill($, e.skill)
    return expanded
  }).catch(surfaced)

  // A skill that runs in a subagent of its own (`context: fork`) is done when its Skill
  // call returns; one that runs inline guides the main agent until its turn ends.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === undefined && ran.result.status === 'forked') {
      const names = [bare(e.skill), bare(ran.result.commandName)]
      if (names.includes(await read($, skill))) await setSkill($, '')
    }
    return ran
  }).catch(surfaced)

  // The main agent's turn ends, an interrupt too; a subagent's end (agentId) is not it.
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined && (await read($, skill))) await setSkill($, '')
    return ended
  }).catch(surfaced)

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [name, ...args] = e.args.trim().split(/\s+/).filter(Boolean)
    if (name === undefined) await togglePane($)
    else await changeSetting($, name, args)
    return {}
  }).catch(($, e, next) => {
    // A failed hook leaves the command without an answer: say what failed instead.
    $.ui.toast(`/${COMMAND} failed: ${next.error.message ?? next.error.kind}. ${USAGE}`)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = {
      view: await read($, view),
      settings: await read($, settings),
      now: await read($, now),
      scope: await read($, scope),
      scopeError: await read($, scopeError),
      skill: await read($, skill),
    }
    const pick = (name: SettingName, value: string) => void changeSetting($, name, [value])
    return drawPane($, e, data, pick)
  })
}
