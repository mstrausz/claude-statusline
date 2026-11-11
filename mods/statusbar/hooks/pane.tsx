import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { FileState, Level, SettingName, SettingsState, ViewFile } from '../types'
import { count, dur, gauge, hm, money, monthName, weekGone, when } from './format'
import { SPECS } from './settings'

// The detail pane, section 12.6 of the design: opened only by the person's /statusbar,
// drawn for about 48 columns, in the colors of Claude Code's theme.

export const PANE = 'statusbar'
export const PANE_COLUMNS = 48
// The rows of a pane whose groups are all full, so that it opens whole above the prompt
// on the main screen. A request: the person's own size wins.
export const PANE_ROWS = 27

const LABEL = 8 // the label column: "Weekly  ", "folder  "
const INDENT = ' '.repeat(LABEL)
const CTX_WARN = 50 // src/style/common.ts: the context window's levels
const CTX_CRIT = 80
const LEVEL_COLOR: Record<Level, 'success' | 'warning' | 'error'> = { ok: 'success', warn: 'warning', crit: 'error' }
const SELECTS: SettingName[] = ['style', 'theme', 'glyphs', 'motion', 'links']
// The usage endpoint refuses most requests (429), so the limits can be minutes old; past
// this age the pane says how old, in the warning color.
const LIMITS_OLD_S = 10 * 60

const pct = (n: number, level: Level) => `${Math.round(n)}%${level === 'crit' ? '!' : ''}`.padStart(5)
const ctxLevel = (p: number): Level => (p >= CTX_CRIT ? 'crit' : p >= CTX_WARN ? 'warn' : 'ok')
/** The value's color: none at the ok level, as on the status line. */
const valueColor = (level: Level) => (level === 'ok' ? undefined : LEVEL_COLOR[level])

/** What a Select shows: the variable that wins, else the file's field, else what the binary uses. */
function shown(name: SettingName, s: SettingsState, data: ViewFile | undefined) {
  const spec = SPECS[name]
  const fromEnv = s.env[name]
  if (fromEnv !== undefined) return spec.show(spec.parse(fromEnv))
  const file = s.file.status === 'ok' ? s.file.value : {}
  if (name in file) return spec.show(file[name])
  return data && spec.show(data.settings[name])
}

/** Why a Select may not show what the binary uses: a variable that wins, or a field it refuses. */
function settingNotes(s: SettingsState) {
  const notes: string[] = []
  for (const name of SELECTS) {
    const spec = SPECS[name]
    const fromEnv = s.env[name]
    if (fromEnv !== undefined) {
      const isValid = spec.parse(fromEnv) !== undefined
      notes.push(isValid ? `${spec.env} sets ${name}` : `${spec.env}=${fromEnv} is not ${spec.usage}`)
    } else if (s.file.status === 'ok' && name in s.file.value && spec.show(s.file.value[name]) === undefined) {
      notes.push(`"${name}": ${JSON.stringify(s.file.value[name])} in the file is not ${spec.usage}`)
    }
  }
  return notes
}

/** What the pane draws: the values the hooks module keeps in $.state, read by its hook. */
export type PaneData = {
  view: FileState<ViewFile>
  settings: SettingsState
  /** When the data was read, in milliseconds: the clock of the countdowns and the turn timer. */
  now: number
  scope: string
  scopeError: string
  skill: string
}

/** The pane's tree; `pick` does what `/statusbar <name> <value>` does. */
export function drawPane($: EngineInterface, e: RenderInput<'Pane'>, d: PaneData, pick: (name: SettingName, value: string) => void) {
  const { Box, Text, Button, Select, Link } = $.ui.resolve(e)
  const nowS = Math.floor(d.now / 1000)
  const data = d.view.status === 'ok' ? d.view.value : undefined

  const title = (name: string, isEmpty: boolean, note: RenderElement | string = '') => (
    <Text>
      <Text weight="bold">{name}</Text>
      {isEmpty ? <Text dimColor>{' …'}</Text> : ''}
      {note}
    </Text>
  )
  // When the limits were fetched: " · from 20:00", or " · from 19:42, 18 min old" when old.
  const fetched = data?.limitsFetchedAt
  const age = fetched === undefined ? 0 : nowS - fetched
  const limitsNote =
    fetched === undefined ? (
      ''
    ) : age > LIMITS_OLD_S ? (
      <Text color="warning">{` · from ${hm(fetched)}, ${Math.floor(age / 60)} min old`}</Text>
    ) : (
      <Text dimColor>{` · from ${hm(fetched)}`}</Text>
    )
  const row = (name: string, text: string) => (
    <Text>
      <Text dimColor>{name.padEnd(LABEL)}</Text>
      {text}
    </Text>
  )

  // A gauge draws a figure of the view file, in the glyphs the view file says are in force:
  // the ones the status line draws with.
  function gaugeRow(v: ViewFile, name: string, used: number, level: Level, after: RenderElement | string, isStale = false) {
    const g = gauge(used, v.settings.glyphs)
    return (
      <Text dimColor={isStale}>
        {name.padEnd(LABEL)}
        <Text color={isStale ? undefined : LEVEL_COLOR[level]}>{g.fill}</Text>
        <Text dimColor>{g.rest}</Text>
        <Text color={valueColor(level)}>{pct(used, level)}</Text>
        {after}
      </Text>
    )
  }

  function limitRows(v: ViewFile) {
    return v.limits.flatMap((l, i) => {
      const isSameReset = l.resetsAt !== undefined && v.limits[i - 1]?.resetsAt === l.resetsAt
      const level: Level = l.stale ? 'ok' : l.level
      const after = isSameReset ? <Text dimColor>{'   same reset'}</Text> : ''
      const rows = [gaugeRow(v, l.label, l.used, level, after, l.stale)]
      if (l.resetsAt !== undefined && !isSameReset) {
        const left = l.stale ? 'stale' : `in ${dur(Math.max(0, l.resetsAt - nowS))}`
        rows.push(<Text dimColor>{`${INDENT}resets ${when(l.resetsAt)}  (${left})`}</Text>)
        if (!l.stale) {
          const gone = weekGone(l.resetsAt, nowS)
          rows.push(<Text dimColor>{`${INDENT}pace: ${Math.round(l.used)} % used, ${gone} % of the week gone`}</Text>)
        }
      }
      return rows
    })
  }

  function contextRows(v: ViewFile) {
    const c = v.context
    if (c === undefined) return []
    const size = c.used !== undefined && c.size !== undefined ? `   ${count(c.used)} of ${count(c.size)}` : ''
    const parts = [
      c.input !== undefined && `input ${count(c.input)}`,
      c.cacheRead !== undefined && `cache read ${count(c.cacheRead)}`,
      c.cacheCreation !== undefined && `cache write ${count(c.cacheCreation)}`,
    ].filter(part => part !== false)
    return [
      gaugeRow(v, 'window', c.pct, ctxLevel(c.pct), size),
      ...(parts.length ? [<Text dimColor>{INDENT + parts.join(' · ')}</Text>] : []),
    ]
  }

  function costRows(v: ViewFile) {
    const c = v.cost
    if (c === undefined) return []
    const costRow = (name: string, usd: number, tokens?: number) => (
      <Text>
        <Text dimColor>{name.padEnd(LABEL + 2)}</Text>
        {money(usd).padEnd(9)}
        {tokens === undefined ? '' : <Text dimColor>{`${count(tokens)} tokens`}</Text>}
      </Text>
    )
    return [
      costRow(monthName(c.month.key), c.month.cost, c.month.tokens),
      ...(c.previous ? [costRow(monthName(c.previous.key), c.previous.cost, c.previous.tokens)] : []),
      ...(c.session !== undefined ? [costRow('session', c.session)] : []),
    ]
  }

  const turn = data?.session.turn
  const sessionRows = [
    ...(d.scope ? [row('scope', d.scope)] : []),
    ...(d.scopeError ? [<Text color="error">{d.scopeError}</Text>] : []),
    ...(turn ? [row('turn', `${dur(Math.max(0, nowS - turn.start))}${turn.label ? `  ${turn.label}` : ''}`)] : []),
    ...(d.skill ? [row('skill', d.skill)] : []),
    ...(data ? [row('folder', data.session.cwd)] : []),
    ...(data?.session.branch ? [row('branch', data.session.branch)] : []),
  ]

  const select = (name: SettingName) => (
    <Select
      key={name}
      // The theme colors the hud style only: quiet uses the terminal's own colors.
      label={name === 'theme' ? 'Theme (hud)' : SPECS[name].title}
      options={SPECS[name].values.map(value => ({ value }))}
      value={shown(name, d.settings, data)}
      onSelect={value => pick(name, value)}
    />
  )
  const group = (name: string, rows: RenderElement[], note: RenderElement | string = '') => (
    <Box flexDirection="column">
      {title(name, rows.length === 0, note)}
      {rows}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {d.view.status === 'error' && <Text color="error">{d.view.message}</Text>}
      {group('LIMITS', data ? limitRows(data) : [], limitsNote)}
      {group('CONTEXT', data ? contextRows(data) : [])}
      {group('COST', data ? costRows(data) : [])}
      {group('SESSION', sessionRows)}
      <Box flexDirection="column">
        {title('SETTINGS', false)}
        <Box flexDirection="row" columnGap={2}>
          {select('style')}
          {select('theme')}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {select('glyphs')}
          {select('motion')}
          {select('links')}
        </Box>
        {d.settings.file.status === 'error' && <Text color="error">{d.settings.file.message}</Text>}
        {settingNotes(d.settings).map(note => (
          <Text dimColor>{note}</Text>
        ))}
      </Box>
      <Box flexDirection="row" columnGap={3}>
        {data && (
          <Text>
            <Link href={data.usageUrl}>Open usage page</Link>
          </Text>
        )}
        <Button key="close" label="Close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    </Box>
  )
}
