import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Dollar = Parameters<Parameters<typeof test>[1]>[0]

const HINT = {
  plugin: 'session-scope',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
} as const

const TURNS = '/home/me/.claude/cache/turns'
const BASE = `${TURNS}/sid-1`

function engine(on: On, files: Record<string, string>) {
  const session = { id: 'sid-1' }
  const clock = mock.clock(on)
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: session.id }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A path with no entry has no answer, which stands for a missing file: the read rejects.
  on('fs.read', (_, e, next) => (e.path in files ? { value: files[e.path] } : next(e)))
  // Stands for the engine's own hint line: draws hint, then " · " and tail.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const p = e.props as { hint: string; tail?: string }
    return <Text>{p.tail ? `${p.hint} · ${p.tail}` : p.hint}</Text>
  })
  return { session, clock }
}

async function line($: Dollar) {
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

async function lineFor($: Dollar) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return line($)
}

test('the Haiku scope label is appended to the mode line', async ($, on) => {
  engine(on, {
    [`${BASE}.scope`]: 'Session scope on mode line\n',
    [`${BASE}.title`]: 'Statusline 7d limit and model\n',
  })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Session scope on mode line')
})

test('before the first label, the session title stands in', async ($, on) => {
  engine(on, { [`${BASE}.title`]: 'Statusline 7d limit and model\n' })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Statusline 7d limit and model')
})

test('with neither file the line is left as the engine draws it', async ($, on) => {
  engine(on, {})
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle)')
})

test('after /clear or /resume the next poll reads the new session id', async ($, on) => {
  const { session, clock } = engine(on, {
    [`${BASE}.scope`]: 'Fresh session label\n',
    [`${TURNS}/sid-2.scope`]: 'Resumed session label\n',
  })
  expect(await lineFor($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Fresh session label')
  session.id = 'sid-2' // no session.start fires for the new id
  await clock.advance(3000)
  expect(await line($)).toBe('⏵⏵ auto mode on (shift+tab to cycle) · Resumed session label')
})
