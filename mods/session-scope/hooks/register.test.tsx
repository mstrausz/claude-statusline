import { expect, test } from 'claude-code/testing'

const HINT = {
  plugin: 'session-scope',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
} as const

const BASE = '/home/me/.claude/cache/turns/sid-1'

function engine(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>) {
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A path with no entry has no answer, which stands for a missing file: the read rejects.
  on('fs.read', (_, e, next) => (e.path in files ? { value: files[e.path] } : next(e)))
  // Stands for the engine's own hint line: draws hint, then tail.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const p = e.props as { hint: string; tail?: string }
    return <Text>{p.hint + (p.tail ?? '')}</Text>
  })
}

async function lineFor($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
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
