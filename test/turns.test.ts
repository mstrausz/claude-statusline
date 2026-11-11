import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentActivity, interruptedSince, label, labelInput, parseLabels, turnHook, type Deps,
} from '../src/turns.ts'
import { tempConfig } from './helpers.ts'

const T0 = 1_794_400_000

describe('turn hooks', () => {
  const cfg = tempConfig()
  const turns = () => join(cfg.dir, 'cache', 'turns')
  const state = (sid = 's1') => readFileSync(join(turns(), sid), 'utf8').trim()
  const spawned: [string, number, string][] = []
  const deps = (now: number): Deps => ({ now, spawnLabels: (...a) => void spawned.push(a) })
  const hook = (extra: object = {}) => ({ session_id: 's1', transcript_path: join(cfg.dir, 't.jsonl'), ...extra })

  test('a prompt opens a turn and asks for a label; Stop closes it', () => {
    spawned.length = 0
    turnHook('start', hook({ prompt: 'Fix the importer' }), deps(T0))
    expect(state()).toBe(String(T0))
    expect(spawned).toEqual([['s1', T0, join(cfg.dir, 't.jsonl')]])
    expect(readFileSync(join(turns(), `s1.prompt.${T0}`), 'utf8')).toBe('Fix the importer')
    expect(readFileSync(join(turns(), 's1.prompts'), 'utf8')).toBe('Fix the importer\n')

    turnHook('end', hook(), deps(T0 + 42))
    expect(state()).toBe(`${T0} ${T0 + 42}`)
    turnHook('end', hook(), deps(T0 + 50)) // nothing open: no change
    expect(state()).toBe(`${T0} ${T0 + 42}`)
  })

  test('a message during a running turn joins it', () => {
    spawned.length = 0
    turnHook('start', hook({ prompt: 'first' }), deps(T0))
    turnHook('start', hook({ prompt: 'also this' }), deps(T0 + 20))
    expect(state()).toBe(String(T0))
    expect(spawned.length).toBe(1)
    expect(readFileSync(join(turns(), 's1.prompts'), 'utf8')).toBe('first\nalso this\n')
  })

  test('a turn interrupted with Esc is replaced by the next prompt', () => {
    turnHook('start', hook({ prompt: 'first' }), deps(T0))
    const at = new Date((T0 + 30) * 1000).toISOString()
    writeFileSync(join(cfg.dir, 't.jsonl'), `{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user"}]},"timestamp":"${at}"}\n`)
    turnHook('start', hook({ prompt: 'second' }), deps(T0 + 60))
    expect(state()).toBe(String(T0 + 60))
  })

  test('a notification opens no labelled turn and stays out of the history', () => {
    spawned.length = 0
    turnHook('start', hook({ prompt: '<task-notification>done</task-notification>' }), deps(T0))
    expect(state()).toBe(String(T0))
    expect(spawned).toEqual([])
    expect(existsSync(join(turns(), 's1.prompts'))).toBe(false)
  })

  test('history keeps the last 8 prompts, one line each', () => {
    for (let i = 1; i <= 10; i++) {
      turnHook('start', hook({ prompt: `p${i}\nsecond line` }), deps(T0 + i * 10))
      turnHook('end', hook(), deps(T0 + i * 10 + 5))
    }
    expect(readFileSync(join(turns(), 's1.prompts'), 'utf8').trim().split('\n'))
      .toEqual([3, 4, 5, 6, 7, 8, 9, 10].map(i => `p${i} second line`))
  })

  test('tool calls open a turn, relabel after 15 s without a label and then every 90 s', () => {
    spawned.length = 0
    turnHook('activity', hook(), deps(T0)) // a turn from a background notification
    expect(state()).toBe(String(T0))
    expect(spawned.length).toBe(1)
    turnHook('activity', hook(), deps(T0 + 10))
    expect(spawned.length).toBe(1)
    turnHook('activity', hook(), deps(T0 + 16)) // still no label: ask again
    expect(spawned.length).toBe(2)
    writeFileSync(join(turns(), 's1.summary'), `${T0}\tA label\n`)
    turnHook('activity', hook(), deps(T0 + 100))
    expect(spawned.length).toBe(2)
    turnHook('activity', hook(), deps(T0 + 106))
    expect(spawned.length).toBe(3)
    turnHook('activity', hook({ agent_id: 'sub-1' }), deps(T0 + 500)) // a subagent's call
    expect(spawned.length).toBe(3)
  })

  test('idle closes an interrupted turn at the transcript\'s last write', () => {
    turnHook('start', hook({ prompt: 'x' }), deps(T0))
    writeFileSync(join(cfg.dir, 't.jsonl'), '{}\n')
    utimesSync(join(cfg.dir, 't.jsonl'), T0 + 33, T0 + 33)
    turnHook('idle', hook(), deps(T0 + 300))
    expect(state()).toBe(`${T0} ${T0 + 33}`)
  })

  test('a session id that is not a plain name is ignored', () => {
    turnHook('start', { session_id: '../../etc', prompt: 'x' }, deps(T0))
    expect(existsSync(turns())).toBe(false)
  })

  test('labelInput: the new request with earlier ones as context', () => {
    mkdirSync(turns(), { recursive: true })
    const f = join(turns(), 's1')
    writeFileSync(`${f}.title`, 'Tariff import\n')
    writeFileSync(`${f}.scope`, 'Belgian tariff tree\n')
    writeFileSync(`${f}.prompts`, 'one\ntwo\nnow this\n')
    expect(labelInput(f, 'now this', '')).toBe(
      'Session title (set at the start): Tariff import\nCurrent scope label: Belgian tariff tree\n' +
      '\nEarlier requests, oldest first:\n- one\n- two\n\nLatest request:\nnow this',
    )
    expect(labelInput(f, undefined, 'Bash: ls')).toContain(
      "\nThe user's recent requests, oldest first:\n- one\n- two\n- now this\n\nRecent agent activity, oldest first:\nBash: ls\n",
    )
  })

  test('agentActivity: the main agent\'s steps, oldest first, no subagents', () => {
    const lines = [
      '{"cut first line', // a read that starts mid-file
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking  at\nit' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] } }),
      JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
      '{"type":"assistant","message":', // still being written
    ]
    writeFileSync(join(cfg.dir, 't.jsonl'), lines.join('\n'))
    expect(agentActivity(join(cfg.dir, 't.jsonl'))).toBe('says: Looking at it\nBash: List files')
    expect(agentActivity(join(cfg.dir, 'missing.jsonl'))).toBe('')
  })
})

test('interruptedSince ignores a missing transcript', () => {
  expect(interruptedSince('/nonexistent/t.jsonl', T0)).toBe(false)
})

test('label: one clean line of at most 48 columns', () => {
  expect(label('  Fix "the" `importer`.')).toBe('Fix the importer')
  expect(label('x'.repeat(60))).toBe('x'.repeat(47) + '…')
  expect([...label('é'.repeat(48))].length).toBe(48)
})

test('parseLabels', () => {
  expect(parseLabels('TASK: Fix importer\nSCOPE: Tariff tree\n')).toEqual({ task: 'Fix importer', scope: 'Tariff tree' })
  expect(parseLabels('Just a phrase\nmore')).toEqual({ task: 'Just a phrase', scope: '' })
})
