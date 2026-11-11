// Turn hooks (`--turn-*`, the hook JSON on stdin) and the Haiku labels (`--summarize`).
//
// Per-session state under <config>/cache/turns/:
//   <sid>            "start [end]" in epoch seconds: the turn timer
//   <sid>.prompts    the last HISTORY_LINES prompts, context for the labels
//   <sid>.prompt.<t> the prompt that opened the turn started at t, for the labeler
//   <sid>.labeled    when the last label call started
//   <sid>.summary    "<turn start>\t<task label>", shown next to the timer
//   <sid>.scope      what the session is about now, drawn by the mod
//   <sid>.title      Claude Code's session title (render.ts writes it)
//
// A hook must print nothing: UserPromptSubmit stdout is added to the prompt.

import {
  appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  logError, nowSeconds, paths, readIfExists, removeIfExists, runClaude, spawnSelfDetached,
  writeAtomic,
} from './env.ts'
import { SESSION_ID } from './render.ts'
import { cut } from './style/common.ts'

const LABEL_EVERY = 90 // seconds between task relabels while the agent works
const HISTORY_LINES = 8 // prompts kept per session as context for the labels
const PRUNE_AFTER_DAYS = 7
const SUMMARY_MODEL = 'claude-haiku-5-5'
const SUMMARY_SECONDS = 60 // a label is useless once its turn has moved on
const SUMMARIZER_ENV = 'STATUSLINE_SUMMARIZER'

export type HookKind = 'start' | 'activity' | 'end' | 'idle'
export type Deps = { now: number; spawnLabels: (sid: string, start: number, transcript: string) => void }

const defaultDeps = (): Deps => ({
  now: nowSeconds(),
  spawnLabels: (sid, start, transcript) =>
    spawnSelfDetached(['--summarize', sid, String(start), transcript]),
})

/** Last `bytes` of a file, or '' when it does not exist. */
function tail(path: string, bytes: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
  try {
    const size = statSync(path).size
    const length = Math.min(size, bytes)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** True when the transcript records an Esc interrupt well after the given epoch second. */
export function interruptedSince(transcript: string, since: number): boolean {
  // Match the unescaped marker only, not the same text quoted inside tool output.
  const line = tail(transcript, 2_000_000)
    .split('\n')
    .findLast(l => l.includes('"text":"[Request interrupted by user'))
  const stamp = line?.match(/"timestamp":"([^"]+)"/)?.[1]
  if (!stamp) return false
  // The interrupt a new prompt itself causes is stamped in the second its turn starts;
  // only one well after the start means this turn was interrupted.
  return Math.floor(Date.parse(stamp) / 1000) > since + 2
}

function readState(f: string): { start?: number; end?: number } {
  const [start, end] = (readIfExists(f) ?? '').trim().split(/\s+/)
  return { start: start ? Number(start) : undefined, end: end ? Number(end) : undefined }
}

/** A turn starts now: its task label is cleared. */
function openTurn(f: string, now: number) {
  writeFileSync(f, `${now}\n`)
  removeIfExists(`${f}.summary`)
}

function spawnLabels(f: string, sid: string, start: number, transcript: string, deps: Deps) {
  writeFileSync(`${f}.labeled`, `${deps.now}\n`)
  deps.spawnLabels(sid, start, transcript)
}

/** Deletes the state files of sessions untouched for PRUNE_AFTER_DAYS. */
function prune(dir: string, now: number) {
  const cutoff = (now - PRUNE_AFTER_DAYS * 86400) * 1000
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p, { throwIfNoEntry: false })
    if (st?.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true })
  }
}

export function turnHook(kind: HookKind, hook: any, deps: Deps = defaultDeps()) {
  if (process.env[SUMMARIZER_ENV]) return // never track the labeler's own claude -p
  const sid: string = hook.session_id ?? ''
  if (!SESSION_ID.test(sid)) return
  const dir = paths().turns
  mkdirSync(dir, { recursive: true })
  const f = join(dir, sid)
  const transcript: string = hook.transcript_path ?? ''
  const { start, end } = readState(f)
  const now = deps.now

  switch (kind) {
    case 'start': {
      writeFileSync(join(dir, '.last-hook-start.json'), JSON.stringify(hook)) // to debug
      const prompt: string = hook.prompt ?? ''
      // Background-task notifications and other machine-made prompts open with a tag:
      // they are not the person's requests, so no history entry and no label from them.
      const human = !/^<[a-z][a-z-]*>/.test(prompt)
      if (human && prompt) {
        appendFileSync(`${f}.prompts`, prompt.replace(/[\x00-\x1f\x7f]/g, ' ').substring(0, 300) + '\n')
        const lines = readIfExists(`${f}.prompts`)!.split('\n').filter(Boolean)
        writeAtomic(`${f}.prompts`, lines.slice(-HISTORY_LINES).join('\n') + '\n')
      }
      // Whatever is submitted while a turn runs joins it (UserPromptSubmit fires for
      // mid-turn messages and notifications too). A turn left open by Esc (no Stop hook)
      // is told apart through the transcript.
      if (start !== undefined && end === undefined && !interruptedSince(transcript, start)) return
      openTurn(f, now)
      if (human) {
        writeFileSync(`${f}.prompt.${now}`, prompt.substring(0, 4000))
        spawnLabels(f, sid, now, transcript, deps)
      } // a notification's turn is labelled from the agent's activity instead
      prune(dir, now)
      return
    }
    case 'activity': {
      // Every main-agent tool call (async PreToolUse). Opens a turn that began without a
      // prompt (on a background-task notification), and relabels the task from what the
      // agent does: soon when the turn has no label yet, then every LABEL_EVERY seconds.
      if (typeof hook.agent_id === 'string') return // a subagent's call
      let turnStart = start
      if (turnStart === undefined || end !== undefined) {
        openTurn(f, now)
        turnStart = now
      }
      const labeled = Number(readIfExists(`${f}.labeled`) ?? 0)
      const unlabeled = readIfExists(`${f}.summary`) === undefined
      if ((unlabeled && now - labeled >= 15) || now - labeled >= LABEL_EVERY)
        spawnLabels(f, sid, turnStart, transcript, deps)
      return
    }
    case 'end':
    case 'idle': {
      if (start === undefined || end !== undefined) return // nothing open
      let t = now
      if (kind === 'idle') {
        // No Stop fired (an interrupted turn): the transcript's last write is the end.
        const st = statSync(transcript, { throwIfNoEntry: false })
        if (st) t = Math.max(start, Math.floor(st.mtimeMs / 1000))
      }
      writeFileSync(f, `${start} ${t}\n`)
      return
    }
  }
}

// ---------------------------------------------------------------------------------------
// Haiku labels: one detached `claude -p` call each, published as
//   TASK  -> <sid>.summary  (next to the turn timer)
//   SCOPE -> <sid>.scope    (what the session is about now; the mod draws it)
// ---------------------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You label work for a terminal status line. Reply with exactly two lines and nothing else:
TASK: <2-5 words, starts with a verb: the step in work right now>
SCOPE: <2-4 words, a noun phrase, at most 32 characters: the topic of this session>
For TASK: when recent agent activity is given, name what its last few steps are doing; otherwise name what the latest request asks for. Use earlier requests only as context, e.g. to resolve what a short follow-up refers to.
For SCOPE: name the overall topic, not the current step. Keep the current scope label while the work is still on that topic; replace it once the work has moved on.
Write in the language of the requests. No quotes, no trailing punctuation.`

export const TASK_CELLS = 40 // shown next to the turn timer
export const SCOPE_CELLS = 32 // shown on the mode line, after 35 to 39 cells of Claude Code's text

/**
 * One clean line of at most max terminal cells. A longer one is cut at its last word that
 * fits, with an ellipsis; when that would lose more than half of it, at the cell limit.
 */
export function label(text: string, max: number): string {
  const s = text.replace(/[\x00-\x1f\x7f"`]/g, '').trim().replace(/\.$/, '')
  if (Bun.stringWidth(s) <= max) return s
  const head = cut(s, max, '…').slice(0, -1) // what fits next to the ellipsis
  const space = head.lastIndexOf(' ')
  return (space >= head.length / 2 ? head.slice(0, space) : head).trimEnd() + '…'
}

/** The main agent's last steps from the transcript, one line each, oldest first. */
export function agentActivity(transcript: string): string {
  const lines = tail(transcript, 400_000).split('\n').slice(1) // the first may be cut
  const steps: string[] = []
  const flat = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ')
  for (const line of lines) {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue // an empty line, or the last one while Claude Code still writes it
    }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue
    for (const b of entry.message?.content ?? []) {
      if (b?.type === 'text') steps.push('says: ' + flat(b.text).substring(0, 200))
      else if (b?.type === 'tool_use') {
        const i = b.input ?? {}
        const what = i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.prompt ?? ''
        steps.push(`${b.name}: ` + flat(what).substring(0, 120))
      }
    }
  }
  return steps.slice(-12).join('\n')
}

/** The labeler's input: the session's context and either the new request or recent activity. */
export function labelInput(f: string, prompt: string | undefined, activity: string): string {
  const title = readIfExists(`${f}.title`)?.trim()
  const scope = readIfExists(`${f}.scope`)?.trim()
  const prompts = (readIfExists(`${f}.prompts`) ?? '').split('\n').filter(Boolean)
  const list = (xs: string[]) => xs.map(x => `- ${x}\n`).join('')
  let s = ''
  if (title) s += `Session title (set at the start): ${title}\n`
  if (scope) s += `Current scope label: ${scope}\n`
  if (prompt) {
    // The newest history line is this request itself.
    if (prompts.length) s += `\nEarlier requests, oldest first:\n${list(prompts.slice(0, -1))}`
    s += `\nLatest request:\n${prompt}`
  } else {
    if (prompts.length) s += `\nThe user's recent requests, oldest first:\n${list(prompts)}`
    s += `\nRecent agent activity, oldest first:\n${activity}\n`
  }
  return s
}

/** Parses the labeler's reply into its two labels. */
export function parseLabels(out: string): { task: string; scope: string } {
  let task = ''
  let scope = ''
  for (const l of out.split('\n')) {
    if (l.startsWith('TASK:')) task = l.slice('TASK:'.length)
    else if (l.startsWith('SCOPE:')) scope = l.slice('SCOPE:'.length)
  }
  if (!task && !scope) task = out.split('\n')[0] ?? '' // the model ignored the format
  return { task: label(task, TASK_CELLS), scope: label(scope, SCOPE_CELLS) }
}

export function summarize(sid: string, start: string, transcript: string) {
  if (!SESSION_ID.test(sid)) return
  const dir = paths().turns
  const f = join(dir, sid)
  const promptFile = `${f}.prompt.${start}`
  try {
    const prompt = readIfExists(promptFile) || undefined
    const activity = prompt ? '' : agentActivity(transcript)
    if (!prompt && !activity) return

    const system = `${f}.system.${process.pid}`
    const settings = `${f}.settings.${process.pid}`
    writeFileSync(system, SUMMARY_SYSTEM)
    writeFileSync(settings, JSON.stringify({ disableAllHooks: true }))
    let out: string
    try {
      // Run in the turns folder, so no project's CLAUDE.md or settings reach the call.
      out = runClaude(
        ['-p', '--model', SUMMARY_MODEL, '--effort', 'low', '--no-session-persistence',
          '--strict-mcp-config', '--settings', settings, '--tools', '', '--disable-slash-commands',
          '--system-prompt-file', system, 'Label the work above.'],
        { input: labelInput(f, prompt, activity), cwd: dir, env: { [SUMMARIZER_ENV]: '1' }, seconds: SUMMARY_SECONDS },
      )
    } finally {
      removeIfExists(system)
      removeIfExists(settings)
    }
    // Publish only while this is still the current, running turn.
    if (String(readState(f).start) !== start) return
    const { task, scope } = parseLabels(out)
    if (task) writeAtomic(`${f}.summary`, `${start}\t${task}\n`)
    if (scope) writeAtomic(`${f}.scope`, `${scope}\n`)
  } catch (e) {
    logError(`summarize ${sid}`, e)
  } finally {
    removeIfExists(promptFile)
  }
}
