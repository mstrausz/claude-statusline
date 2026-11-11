# claude-statusline

A two-line status line for [Claude Code](https://code.claude.com), a live timer for the
running agent turn with a short label of what the agent is doing, and a mod that shows
what the session is about at the end of the mode line under the prompt. One binary for
Linux, macOS and Windows.

```
Opus 5.5 │ ctx 7% 74k/1000k │ 7d 54% left ⟳4d19h  Fable 73% left ⟳4d19h │ $25.95 · 69.1M tok (Nov)
14:56:05 ⏱ 1m23s Fix tariff chapter 84 import │ user@host:~/project (main)$
```
```
⏵⏵ auto mode on (shift+tab to cycle) · Belgian tariff tree import
```

| Segment | Source |
| --- | --- |
| model, context window % | the JSON Claude Code passes to the status line |
| `7d … left`, reset countdown | `rate_limits` from Claude Code; the OAuth usage endpoint until those arrive |
| `Fable … left` | the per-model weekly limit from the OAuth usage endpoint (refreshed every 30 s) |
| `$… · … tok (Mon)` | this month's cost and tokens on this machine, from [ccusage](https://github.com/ryoppippi/ccusage) (refreshed every 10 min) |
| clock | refreshed every second (`refreshInterval: 1`) |
| `⏱` timer + task label | turn hooks; the label is written by Claude Haiku 5.5 |
| `(branch)` | read from `.git/HEAD` |
| scope on the mode line | the `session-scope` mod |

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

- copies itself to `~/.claude/bin/` and the mod to `~/.claude/mods/session-scope`
  (`$CLAUDE_CONFIG_DIR` instead of `~/.claude` when you set it);
- merges into `settings.json` (backed up first): `statusLine` with `refreshInterval: 1`,
  five hooks, and the mod's folder in `env.CLAUDE_CODE_PLUGIN_DIRS`. It replaces its own
  entries on each run, also those of the earlier bash version, and leaves your other
  settings and hooks alone;
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
hooks, no saved session) that returns two lines: `TASK`, shown next to the timer, and
`SCOPE`, what the session as a whole is about, which the mod draws on the mode line.
Haiku sees the last 8 prompts of the session and, mid-turn, the agent's last steps from
the transcript. Expect one call per prompt plus one per 90 s of agent work; the token
cost is negligible.

Messages typed while a turn runs, and background-task notifications, join the running
turn instead of restarting it. Subagent tool calls are ignored.

A render takes about 12 ms (14 ms of CPU). The slow sources refresh in detached background jobs: the
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
bun test                              # the binary's tests
claude plugin test mods/session-scope # the mod's tests
bun run typecheck
bun run build                         # dist/claude-statusline for this machine
bun run build:all                     # dist/claude-statusline-<os>-<arch> for all six targets
CLAUDE_CONFIG_DIR=/tmp/c dist/claude-statusline install   # try it without touching ~/.claude
```

CI (`.github/workflows/ci.yml`) runs the tests on Linux, macOS and Windows, installs the
cross-compiled release binary of each system into a temporary config folder, and runs
`install.sh` / `install.ps1` on runners without Bun to test the dependency installation.
A tag `v<version>` (matching `package.json`) publishes the six binaries as a GitHub
release (`.github/workflows/release.yml`).
