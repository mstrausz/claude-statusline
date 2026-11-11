// The mod's contract: what it keeps in $.state, and the files it shares with the
// claude-statusline binary in <config>/cache/turns/ and <config>/.

export type Scope = string

export type Level = 'ok' | 'warn' | 'crit'
export type Style = 'hud' | 'quiet'
export type Glyphs = 'unicode' | 'ascii' | 'nerd'

/** One month of ccusage figures. `key` is the month as `2026-11`. */
export type ViewMonth = { key: string; cost: number; tokens: number }

/**
 * `<session_id>.view.json`: written by the binary, atomically, when its content changes
 * (at most once a second). The mod only reads it, for the detail pane. A field marked `?`
 * may be absent; a missing file means no render happened yet.
 */
export type ViewFile = {
  version: 1
  limits: {
    /** `Weekly` for the limit of all models, else the model's name (`Fable`). */
    label: string
    /** Percent used, 0..100. */
    used: number
    /** Epoch seconds. */
    resetsAt?: number
    stale: boolean
    level: Level
  }[]
  context?: { pct: number; used?: number; size?: number; input?: number; cacheRead?: number; cacheCreation?: number }
  cost?: { month: ViewMonth; previous?: ViewMonth; session?: number /* USD */ }
  session: {
    /** Full, with `~` for the home folder. */
    cwd: string
    branch?: string
    /** As Claude Code names it, e.g. `frontend-design:frontend-design`. */
    skill?: string
    turn?: { start: number /* epoch seconds */; label?: string }
  }
  /** The settings in effect: environment variable, else config file, else default. */
  settings: { style: Style; glyphs: Glyphs; motion: boolean; links: boolean; width: number }
  usageUrl: string
}

/**
 * `claude-statusline.json` in the config folder, as /statusbar writes it. Each field is
 * optional; an absent one leaves the environment variable or the default in force.
 */
export type ConfigFile = { style?: Style; glyphs?: Glyphs; motion?: boolean; links?: boolean; width?: number }

export type SettingName = keyof ConfigFile

/** A file the mod reads: not there yet, read and valid, or not readable or not valid. */
export type FileState<T> = { status: 'missing' } | { status: 'ok'; value: T } | { status: 'error'; message: string }

/** What the SETTINGS group draws from: the config file, and the variables that win over it. */
export type SettingsState = {
  file: FileState<Record<string, unknown>>
  /** The value of each CLAUDE_STATUSLINE_* variable that is set and not empty. */
  env: { [K in SettingName]?: string }
}

declare module 'claude-code' {
  interface PluginState {
    statusbar: {
      /** The label at the end of the mode line: the scope file, else the title file. */
      scope: Scope
      /** Why the scope or title file could not be read; empty when both read. */
      scopeError: string
      /** The skill in use, as Claude Code names it; empty when none. */
      skill: string
      view: Shaped<FileState<ViewFile>>
      settings: Shaped<SettingsState>
      /** When the pane's data was last read, in milliseconds: its clock for countdowns. */
      now: number
    }
  }
}
