# claude-statusline

A status line for [Claude Code](https://code.claude.com): the model, the context window,
your subscription limits and this month's cost, a live timer for the running agent turn
with a short label of what the agent is doing, the skill in use, and what the session is
about on the mode line under the prompt. One binary for Linux, macOS and Windows.

Two styles. **hud** (the default) draws filled segments with gradient gauges (here without its colors):

```
Opus 5.5 │ ctx ▍░░░░░ 7% 74k/1M │ week ██▊░░░ 46%  Fable █▋░░░░ 27%  resets 4d19h │ Nov $25.95
~/project (main) │ [/plugin-authoring] ▘ 1m23s Fix tariff chapter 84 import
```

**quiet** uses the terminal's 16 colors, with a hue only where something needs attention:

```
Opus 5.5 │ ctx 7% 74k/1M │ week 46% · Fable 27% · resets 4d19h │ Nov $25.95
~/project (main) │  /plugin-authoring  1m23s Fix tariff chapter 84 import
```

And on the mode line, from the mod:

```
⏵⏵ auto mode on (shift+tab to cycle) · Belgian tariff import
```

| Item | Source |
| --- | --- |
| model, context window | the JSON Claude Code passes to the status line |
| `week`, reset countdown | `rate_limits` from Claude Code; the OAuth usage endpoint until those arrive |
| `Fable` | the per-model weekly limit from the OAuth usage endpoint (refreshed every 30 s) |
| `Nov $25.95` | this month's cost on this machine, from [ccusage](https://github.com/ryoppippi/ccusage) (refreshed every 10 min) |
| folder, `(branch)` | the JSON from Claude Code; the branch from `.git/HEAD` |
| `/plugin-authoring` | the skill in use, from the mod; shown only while the skill is in use |
| timer and task label | turn hooks; the label is written by Claude Haiku 5.5 |
| scope on the mode line | the mod; also written by Haiku |

All percentages are the part **used**. A value turns yellow at 70 % (the context window at
50 %) and becomes a red alarm with a `!` at 90 % (80 %). A reset in the past shows `stale`.
`…` means no data yet.

The limits, the folder and the branch (on GitHub) are links: Ctrl+click or Cmd+click in a
terminal that supports them (iTerm2, kitty, WezTerm, Windows Terminal, VS Code).

## In Claude Code: `/statusbar`

The mod adds one command:

```
/statusbar                              open the detail pane; again to close it
/statusbar style hud|quiet              the style
/statusbar glyphs unicode|ascii|nerd    the glyph set
/statusbar motion on|off                the spinner of the hud style
/statusbar links on|off                 the links in the status line
/statusbar width <cells>|auto           the width budget of the hud style
```

The detail pane shows what the status line has no room for: the reset dates, the pace
(percentage used against the part of the week that is gone), the token breakdown, last
month's cost, the session's cost, the full folder, branch and skill names, and the settings.

## Settings

| Setting | Values (default first) | Variable | Effect |
| --- | --- | --- | --- |
| `style` | `hud`, `quiet` | `CLAUDE_STATUSLINE_STYLE` | the look |
| `glyphs` | `unicode`, `ascii`, `nerd` | `CLAUDE_STATUSLINE_GLYPHS` | `nerd` adds Powerline shapes and icons to hud; it needs a [Nerd Font](https://www.nerdfonts.com) |
| `motion` | `on`, `off` | `CLAUDE_STATUSLINE_MOTION` | a small spinner before the turn timer, one step per second (hud) |
| `links` | `on`, `off` | `CLAUDE_STATUSLINE_LINKS` | the links in the status line |
| `width` | `100`, 40 to 400 | `CLAUDE_STATUSLINE_WIDTH` | hud drops its least important items to fit: month tokens, the context detail, the cost, then gauge cells |

`/statusbar <setting> <value>` and `claude-statusline <setting> <value>` write
`claude-statusline.json` in Claude Code's config folder; the status line reads it on its
next render. A variable wins over the file. A value that is not valid shows as an error
in the status line instead of a silent default.

Colors follow the terminal: truecolor where `COLORTERM` says so (and on Windows), 256
colors in macOS Terminal.app, else 16. `NO_COLOR` turns colors and links off; `FORCE_COLOR`
(`1` to `3`) selects a color depth. The hud style gives each text its own background, so it
reads the same on dark and light themes.

## Requirements

- Claude Code with a Claude subscription, signed in (`claude auth login`).
- The `claude` CLI on PATH for the Haiku labels. The installer offers to install it.
- Nothing else at run time: no bash, jq, curl or Node.js. On Windows, Git for Windows is
  not needed; the status line works when Claude Code uses PowerShell as well as Git Bash.
- To build from source: [Bun](https://bun.sh). The installer offers to install it.

## Install

Clone the repository, then run the installer for your system. It builds the binary (or
downloads a release binary with `gh` when Bun is missing), installs what is missing after
it asks you, and runs `claude-statusline install`.

macOS, Linux, WSL:

```sh
git clone git@github.com:<you>/claude-statusline.git
cd claude-statusline
./install.sh
```

Windows (PowerShell):

```powershell
git clone git@github.com:<you>/claude-statusline.git
cd claude-statusline
powershell -ExecutionPolicy Bypass -File install.ps1
```

`--yes` / `-Yes` answers yes to every question; `--skip-claude` / `-SkipClaude` skips
the `claude` CLI check.

With a release binary instead of a clone, run it with `install`:

```sh
./claude-statusline-darwin-arm64 install            # or linux-x64, linux-arm64, darwin-x64
.\claude-statusline-windows-x64.exe install         # or windows-arm64
```

The binaries are not signed. If macOS blocks one that you downloaded in a browser, run
`xattr -d com.apple.quarantine <file>` first; `gh release download` does not mark it.

Then restart running Claude Code sessions. `claude-statusline install`:

- copies itself to `~/.claude/bin/` and the mod to `~/.claude/mods/statusbar`
  (`$CLAUDE_CONFIG_DIR` instead of `~/.claude` when you set it);
- merges into `settings.json` (backed up first): `statusLine` with `refreshInterval: 1`,
  five hooks, and the mod's folder in `env.CLAUDE_CODE_PLUGIN_DIRS`. It replaces its own
  entries on each run, also those of earlier versions (the bash script and the
  `session-scope` mod), and leaves your other settings and hooks alone;
- renders the status line once as a smoke test.

To update, `git pull` and run the installer again.

## How it works

The binary is the status line command, the hook handler and its own background jobs:

| Hook | Does |
| --- | --- |
| `UserPromptSubmit` → `--turn-start` | starts the turn timer and asks Haiku for a label of the new request |
| `PreToolUse` (async) → `--turn-activity` | while the agent works, relabels the task from its recent activity every 90 s; opens a turn that a background-task notification started |
| `Stop`, `StopFailure` → `--turn-end` | stops the timer |
| `Notification` `idle_prompt` → `--turn-idle` | closes a turn interrupted with Esc, which fires no `Stop` |

The hooks use Claude Code's exec form (`command` plus `args`), so no shell runs them and
no path needs quoting. The status line command has no exec form; on Windows it is written
as `~/.claude/bin/claude-statusline.exe`, which Git Bash and PowerShell both read.

Each label is one `claude -p --model claude-haiku-5-5` call (no tools, MCP servers or
hooks, no saved session) that returns two lines: `TASK`, a verb phrase shown next to the
timer, and `SCOPE`, a noun phrase for what the session as a whole is about, which the mod
draws on the mode line. Haiku sees the last 8 prompts of the session and, mid-turn, the
agent's last steps from the transcript. Expect one call per prompt plus one per 90 s of
agent work; the token cost is negligible.

The mod (`mods/statusbar`) tracks the skill in use: from the moment Claude Code
loads it until the turn ends, replaced by the next skill, and ended early when a skill
that runs in its own subagent returns. It writes the skill's name for the status line,
reads the data the status line writes for the detail pane, and answers `/statusbar`.

Messages typed while a turn runs, and background-task notifications, join the running
turn instead of restarting it. Subagent tool calls are ignored.

A render takes about 12 ms. The slow sources refresh in detached background jobs: the
OAuth usage endpoint (the token comes from the macOS Keychain, or from
`~/.claude/.credentials.json` on Linux and Windows) and ccusage, which the binary runs
with its built-in Bun. Per-session state lives in `~/.claude/cache/turns/` and is
pruned after 7 days. Errors of the background jobs go to `~/.claude/cache/statusline.log`;
an error of the render shows in red in the status line itself.

## Uninstall

```sh
~/.claude/bin/claude-statusline uninstall
```

It removes its settings entries (backed up first), the mod, its cache files and the
binary. On Windows the running binary cannot delete itself: it is renamed to
`claude-statusline.exe.old`, which you can delete once Claude Code is closed.

## Development

```sh
bun install
bun test                                    # the binary's tests
claude plugin test mods/statusbar           # the mod's tests
bun run typecheck
bun run build                               # dist/claude-statusline for this machine
bun run build:all                           # dist/claude-statusline-<os>-<arch> for all six targets
CLAUDE_CONFIG_DIR=/tmp/c dist/claude-statusline install   # try it without touching ~/.claude
```

CI (`.github/workflows/ci.yml`) runs the tests on Linux, macOS and Windows, installs the
cross-compiled release binary of each system into a temporary config folder, and runs
`install.sh` / `install.ps1` on runners without Bun to test the dependency installation.
A tag `v<version>` (matching `package.json`) publishes the six binaries as a GitHub
release (`.github/workflows/release.yml`).
