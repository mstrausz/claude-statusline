# claude-statusline

A two-line status line for [Claude Code](https://code.claude.com), a live timer for the
running agent turn with a short label of what the agent is doing, and a mod that shows
what the session is about at the end of the mode line under the prompt.

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
| `7d … left`, reset countdown | `rate_limits` from Claude Code; the OAuth usage endpoint as fallback |
| `Fable … left` | the per-model weekly limit from the OAuth usage endpoint (cached, refreshed every 30 s) |
| `$… · … tok (Mon)` | this month's cost and tokens on this machine, from [ccusage](https://github.com/ryoppippi/ccusage) (refreshed every 10 min) |
| clock | refreshed every second (`refreshInterval: 1`) |
| `⏱` timer + task label | turn hooks; the label is written by Claude Haiku 5.5 |
| `(branch)` | read from `.git/HEAD` |
| scope on the mode line | the `session-scope` mod |

## Requirements

Linux or WSL (GNU `date`/`stat`, `flock`, `setsid`), bash 5+, `jq`, `curl`, and the
`claude` CLI signed in with a Claude subscription (`claude auth login`). `npx` (Node.js)
for the month cost segment.

## Install

```sh
git clone git@github.com:<you>/claude-statusline.git
cd claude-statusline
./install.sh
```

Then restart running Claude Code sessions. The installer:

- copies `statusline.sh` to `~/.claude/statusline.sh` and the mod to
  `~/.claude/mods/session-scope`;
- merges into `~/.claude/settings.json` (backed up first): `statusLine` with
  `refreshInterval: 1`, five hooks, and the mod's folder in `env.CLAUDE_CODE_PLUGIN_DIRS`.
  It replaces its own entries on re-run and leaves your other settings and hooks alone;
- renders the status line once as a smoke test.

To update, `git pull` and run `./install.sh` again.

## How it works

`statusline.sh` is both the status line command and the hook handler:

| Hook | Does |
| --- | --- |
| `UserPromptSubmit` → `--turn-start` | starts the turn timer and asks Haiku for a label of the new request |
| `PreToolUse` (async) → `--turn-activity` | while the agent works, relabels the task from its recent activity every 90 s; opens a turn that a background-task notification started |
| `Stop`, `StopFailure` → `--turn-end` | stops the timer |
| `Notification` `idle_prompt` → `--turn-idle` | closes a turn interrupted with Esc, which fires no `Stop` |

Each label is one `claude -p --model claude-haiku-5-5` call (no tools, MCP servers or
hooks, no saved session) that returns two lines: `TASK`, shown next to the timer, and
`SCOPE`, what the session as a whole is about, which the mod draws on the mode line.
Haiku sees the last 8 prompts of the session and, mid-turn, the agent's last steps from
the transcript. Expect one call per prompt plus one per 90 s of agent work, a few seconds
and about a second of CPU each; the token cost is negligible.

Messages typed while a turn runs, and background-task notifications, join the running
turn instead of restarting it. Subagent tool calls are ignored.

The status line renders with bash builtins plus one `jq` call (about 30 ms of CPU). The
slow sources are refreshed by detached background jobs. Per-session state lives in
`~/.claude/cache/turns/` and is pruned after 7 days.

## Uninstall

Remove `statusLine`, the five hooks that call `statusline.sh --turn-…` and the
`~/.claude/mods/session-scope` entry of `env.CLAUDE_CODE_PLUGIN_DIRS` from
`~/.claude/settings.json`, then delete `~/.claude/statusline.sh`,
`~/.claude/mods/session-scope` and `~/.claude/cache/turns/`.
