// `claude-statusline themes`: each color scheme of the hud style, drawn with a sample that
// shows all three levels (the context at warn, the weekly limit calm, Fable critical).

import type { Settings } from '../settings.ts'
import type { View } from './common.ts'
import { type Tier, hud } from './hud.ts'
import { THEME_NAMES, theme } from './themes.ts'

export function sampleView(now: number, date: Date): View {
  const resets = now + 4 * 86400 + 19 * 3600
  return {
    now, date, host: 'host', cwd: '~/project', ssh: false,
    model: 'Opus 5.5', ctxPct: 62, ctxCur: 620_000, ctxSize: 1_000_000,
    week: { used: 46, resetsAt: resets },
    fable: { used: 92, resetsAt: resets },
    month: { cost: 25.95, tokens: 69_120_000 },
    turn: { seconds: 83, label: 'Fix tariff chapter 84 import' },
    branch: 'main', skill: 'plugin-authoring',
  }
}

/** Every scheme with the person's other settings; the scheme in effect is marked. */
export function themesPreview(s: Settings, tier: Tier, now = Date.now() / 1000, date = new Date()): string {
  const v = sampleView(Math.floor(now), date)
  const out: string[] = []
  if (tier === 'none') out.push('Colors are off (NO_COLOR or TERM=dumb), so all schemes look the same here.\n')
  else if (tier === '16') out.push('This terminal shows 16 colors, so all schemes look like "terminal" here.\n')
  for (const name of THEME_NAMES) {
    const notes = [name === s.theme ? 'in use' : '', theme(name).light ? 'for light terminals' : ''].filter(Boolean)
    out.push(`${name}${notes.length ? `  (${notes.join(', ')})` : ''}`)
    out.push(hud(v, { ...s, style: 'hud', theme: name, motion: false }, tier), '')
  }
  out.push('Switch with "claude-statusline theme <name>", or /statusbar theme <name> in Claude Code.')
  return out.join('\n')
}
