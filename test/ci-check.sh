#!/usr/bin/env bash
# Checks an installation in $CLAUDE_CONFIG_DIR, in CI on Linux, macOS and Windows (Git Bash):
# the files, the settings, one render and one turn through the installed binary.
set -euo pipefail

cfg=${CLAUDE_CONFIG_DIR:?set CLAUDE_CONFIG_DIR}
exe=""
case $(uname -s) in MINGW*|MSYS*|CYGWIN*) exe=.exe ;; esac
bin="$cfg/bin/claude-statusline$exe"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$bin" ] || fail "no binary at $bin"
for f in .claude-plugin/plugin.json hooks/hooks.json hooks/register.tsx types/index.d.ts; do
  [ -f "$cfg/mods/session-scope/$f" ] || fail "mod file missing: $f"
done

# Settings: the statusLine, five exec-form hooks, the mod folder in the plugin dirs.
bun_or_bin() { if command -v bun >/dev/null; then bun "$@"; else BUN_BE_BUN=1 "$bin" "$@"; fi; }
SETTINGS="$cfg/settings.json" bun_or_bin -e '
  const s = JSON.parse(require("fs").readFileSync(process.env.SETTINGS, "utf8"))
  const hooks = ["UserPromptSubmit", "PreToolUse", "Stop", "StopFailure", "Notification"]
  const ok = /claude-statusline/.test(s.statusLine?.command) && s.statusLine.refreshInterval === 1
    && hooks.every(e => s.hooks?.[e]?.some(g => g.hooks.some(h => /claude-statusline/.test(h.command) && h.args?.length === 1)))
    && s.env?.CLAUDE_CODE_PLUGIN_DIRS?.includes("session-scope")
  if (!ok) { console.error(JSON.stringify(s, null, 2)); process.exit(1) }
' || fail "settings.json is not as expected"

# The background refreshes are kept from starting: they need a sign-in and the network.
mkdir -p "$cfg/cache"
date +%s >"$cfg/cache/.usage.stamp"
date +%s >"$cfg/cache/.ccusage.stamp"

out=$(printf '%s' '{"session_id":"ci","model":{"display_name":"CI model"},"workspace":{"current_dir":"'"$PWD"'"}}' \
  | "$bin" | sed 's/\x1b\[[0-9;]*m//g')
echo "$out"
[[ $out == *"CI model"* && $out == *"@"* ]] || fail "render: $out"

# A turn: the start hook opens it (the label call fails without a sign-in, in the background).
printf '%s' '{"session_id":"ci","prompt":"hello from CI","transcript_path":""}' | "$bin" --turn-start
read -r start end <"$cfg/cache/turns/ci"
[ -n "$start" ] && [ -z "${end:-}" ] || fail "turn not open: $start ${end:-}"
out=$(printf '%s' '{"session_id":"ci","model":{"display_name":"CI model"}}' | "$bin" | sed 's/\x1b\[[0-9;]*m//g')
[[ $out == *"⏱"* ]] || fail "no turn timer: $out"
printf '%s' '{"session_id":"ci"}' | "$bin" --turn-end
read -r start end <"$cfg/cache/turns/ci"
[ -n "${end:-}" ] || fail "turn not closed"

echo "installation OK"
