#!/bin/bash
# Claude Code statusline.
#
# Line 1: model │ context-window % used │ 7d limit % LEFT + reset countdown,
#         Fable weekly % LEFT + reset │ this month's cost/tokens on THIS workstation
# Line 2: clock [⏱ running-turn timer + Haiku summary of the prompt │] user@host:cwd (branch)$
#
# Needs in settings.json:
#   statusLine.refreshInterval: 1        clock and turn timer tick every second
#   hooks: UserPromptSubmit -> --turn-start, Stop/StopFailure -> --turn-end,
#          PreToolUse (async) -> --turn-activity (relabels the task from what the agent
#          is doing; opens turns that start on a background-task notification),
#          Notification[idle_prompt] -> --turn-idle (closes turns interrupted with Esc,
#          which fire no Stop hook)
# --turn-start also spawns `--summarize`: one `claude -p` call to claude-haiku-5-5 per
# new turn (not per mid-turn message) for two labels, the turn's task
# ($TURN_DIR/<sid>.summary) and the session's current scope ($TURN_DIR/<sid>.scope, drawn
# on the mode line by the session-scope mod), from the last prompts ($TURN_DIR/<sid>.prompts).
#
# Sources:
#   - stdin JSON from Claude Code: session_id, model, context_window, rate_limits, cwd.
#   - Anthropic OAuth usage endpoint (cached, background refresh): Fable weekly limit,
#     plus the 7d window as fallback until stdin rate_limits is populated.
#   - ccusage (cached, background refresh): current-month cost + tokens.
#   - Turn state written by the hooks: $TURN_DIR/<session_id> = "start [end]" (epoch s).
#
# It runs every second, so the render path uses bash builtins plus a single jq: no
# date/awk/stat/git processes (the branch is read from .git/HEAD). Slow sources refresh
# in detached jobs, gated by attempt stamps so a failing source isn't retried every second.

export LC_NUMERIC=C
CACHE_DIR="$HOME/.claude/cache"
TURN_DIR="$CACHE_DIR/turns"
USAGE_CACHE="$CACHE_DIR/statusline-usage.json"       # OAuth rate-limit windows
CCUSAGE_CACHE="$CACHE_DIR/statusline-ccusage.json"   # ccusage monthly rollup
INPUT_DUMP="$CACHE_DIR/statusline-input.json"        # last stdin payload (debug)
USAGE_TTL=30      # seconds between endpoint fetch attempts
CCUSAGE_TTL=600   # seconds between ccusage runs (npx is slow, month totals move slowly)
CRED="$HOME/.claude/.credentials.json"
now=$EPOCHSECONDS

# ---------------------------------------------------------------------------
# Background refresh routines (invoked as `statusline.sh --refresh-*`)
# ---------------------------------------------------------------------------
refresh_usage() {
  ( flock -n 9 || exit 0
    local tok tmp
    tok=$(jq -r '.claudeAiOauth.accessToken // empty' "$CRED" 2>/dev/null)
    [ -z "$tok" ] && exit 0
    tmp="$USAGE_CACHE.tmp.$$"
    # Accept the response if it has any weekly data. (five_hour can be null.)
    if curl -s -m 15 \
         -H "Authorization: Bearer $tok" \
         -H "anthropic-beta: oauth-2025-04-20" \
         "https://api.anthropic.com/api/oauth/usage" -o "$tmp" \
       && jq -e '(.seven_day // .limits) != null' "$tmp" >/dev/null 2>&1; then
      mv "$tmp" "$USAGE_CACHE"
    else
      rm -f "$tmp"
    fi
  ) 9>"$CACHE_DIR/.usage.lock"
}

refresh_ccusage() {
  ( flock -n 9 || exit 0
    local tmp="$CCUSAGE_CACHE.tmp.$$"
    if npx -y ccusage@latest claude monthly --json >"$tmp" 2>/dev/null \
       && jq -e '.monthly' "$tmp" >/dev/null 2>&1; then
      mv "$tmp" "$CCUSAGE_CACHE"
    else
      rm -f "$tmp"
    fi
  ) 9>"$CACHE_DIR/.ccusage.lock"
}

# ---------------------------------------------------------------------------
# Turn hooks (invoked as `statusline.sh --turn-*` with the hook JSON on stdin).
# Must print nothing: UserPromptSubmit stdout would be injected into the prompt.
# ---------------------------------------------------------------------------
json_str() { # <json> <key> -> REPLY = string value of the first unescaped "key"
  local re="\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
  REPLY=""; [[ $1 =~ $re ]] && REPLY=${BASH_REMATCH[1]}
}

interrupted_since() { # <transcript> <epoch>: true if an Esc interrupt was recorded after epoch
  local line t
  [ -f "$1" ] || return 1
  # Match the unescaped marker only, not the same text quoted inside tool output.
  line=$(tail -c 2000000 "$1" | grep -F '"text":"[Request interrupted by user' | tail -n 1)
  [[ $line =~ \"timestamp\":\"([^\"]+)\" ]] || return 1
  t=$(date -d "${BASH_REMATCH[1]}" +%s 2>/dev/null) || return 1
  # The interrupt a new prompt itself causes is stamped in the second its turn starts;
  # only one well after the start means this turn was interrupted.
  (( t > $2 + 2 ))
}

LABEL_EVERY=90      # seconds between task relabels while the agent works
HISTORY_LINES=8     # prompts kept per session as context for the labels

open_turn() { # <state-file>: a turn starts now; its task label is cleared
  printf '%s\n' "$now" >"$1"
  rm -f "$1.summary"
}

spawn_labels() { # <sid> <turn-start> <transcript>: one detached Haiku call
  printf '%s\n' "$now" >"$TURN_DIR/$1.labeled"
  setsid "$0" --summarize "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &
}

turn_hook() { # <start|activity|end|idle>
  local json sid f start end t tp prompt line human=1
  [ -n "$STATUSLINE_SUMMARIZER" ] && return 0   # never track the summarizer's own claude -p
  IFS= read -r -d '' json
  json_str "$json" session_id; sid=$REPLY
  [[ $sid =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  [ -d "$TURN_DIR" ] || mkdir -p "$TURN_DIR"
  f="$TURN_DIR/$sid"
  json_str "$json" transcript_path; tp=$REPLY
  start=""; end=""
  [ -f "$f" ] && read -r start end <"$f"

  case $1 in
  start)
    printf '%s' "$json" >"$TURN_DIR/.last-hook-start.json"   # debug
    prompt=$(jq -r '.prompt // empty' <<<"$json" 2>/dev/null)
    # Background-task notifications and other machine-made prompts open with a tag:
    # they are not the person's requests, so no history entry and no label from them.
    [[ $prompt =~ ^\<[a-z][a-z-]*\> ]] && human=0
    if (( human )) && [ -n "$prompt" ]; then
      line=${prompt//[[:cntrl:]]/ }
      printf '%s\n' "${line:0:300}" >>"$f.prompts"
      tail -n "$HISTORY_LINES" "$f.prompts" >"$f.prompts.tmp.$$" && mv "$f.prompts.tmp.$$" "$f.prompts"
    fi
    # Whatever is submitted while a turn runs joins it (UserPromptSubmit fires for
    # mid-turn messages and notifications too). A turn left open by Esc (no Stop hook)
    # is told apart via the transcript.
    if [ -n "$start" ] && [ -z "$end" ] && ! interrupted_since "$tp" "$start"; then
      return 0
    fi
    open_turn "$f"
    if (( human )); then
      printf '%s' "${prompt:0:4000}" >"$f.prompt.$now"
      spawn_labels "$sid" "$now" "$tp"
    fi   # a notification's turn is labelled from the agent's activity instead
    find "$TURN_DIR" -type f -mtime +7 -delete 2>/dev/null   # prune old sessions
    ;;
  activity)
    # Every main-agent tool call (async PreToolUse). Opens a turn that began without a
    # prompt (on a background-task notification), and relabels the task from what the
    # agent is doing: soon when the turn has no label yet, then every LABEL_EVERY s.
    [[ $json =~ \"agent_id\"[[:space:]]*:[[:space:]]*\" ]] && return 0   # a subagent's call
    if [ -z "$start" ] || [ -n "$end" ]; then
      open_turn "$f"; start=$now
    fi
    t=0; [ -f "$f.labeled" ] && read -r t <"$f.labeled"
    if { [ ! -f "$f.summary" ] && (( now - t >= 15 )); } || (( now - t >= LABEL_EVERY )); then
      spawn_labels "$sid" "$start" "$tp"
    fi
    ;;
  end|idle)
    { [ -z "$start" ] || [ -n "$end" ]; } && return 0         # nothing open
    t=$now
    if [ "$1" = idle ] && [ -f "$tp" ]; then
      # No Stop fired (interrupted turn). Use the transcript's last write as the end.
      t=$(stat -c %Y "$tp"); (( t < start )) && t=$start
    fi
    printf '%s %s\n' "$start" "$t" >"$f"
    ;;
  esac
}

# Haiku labels, one detached `claude -p` call each, published as:
#   TASK  -> <sid>.summary  (next to the turn timer)
#   SCOPE -> <sid>.scope    (what the session is about now; the session-scope mod draws it)
# Called on a new prompt (labels the request) and while the agent works (labels its
# recent activity from the transcript).
SUMMARY_MODEL=claude-haiku-5-5
SUMMARY_SYSTEM='You label work for a terminal status line. Reply with exactly two lines and nothing else:
TASK: <2-5 words: what is being worked on right now>
SCOPE: <2-6 words: the topic this session is working on now>
For TASK: when recent agent activity is given, name what its last few steps are doing; otherwise name what the latest request asks for. Use earlier requests only as context, e.g. to resolve what a short follow-up refers to.
For SCOPE: name the overall topic, not the current step. Keep the current scope label while the work is still on that topic; replace it once the work has moved on.
Write in the language of the requests. No quotes, no trailing punctuation.'

label() { # <text> -> LABEL: one clean line, at most 48 columns
  LABEL=${1//[[:cntrl:]\"\`]/}; LABEL=${LABEL#"${LABEL%%[![:space:]]*}"}; LABEL=${LABEL%.}
  (( ${#LABEL} > 48 )) && LABEL="${LABEL:0:47}…"
}

agent_activity() { # <transcript>: the main agent's last steps, one line each, oldest first
  [ -f "$1" ] || return 0
  tail -c 400000 "$1" | tail -n +2 | jq -r '
    select(.type == "assistant" and .isSidechain != true) | .message.content[]?
    | if .type == "text" then "says: " + (.text | gsub("\\s+"; " ") | .[0:200])
      elif .type == "tool_use" then "\(.name): " + ((.input.description // .input.file_path
             // .input.command // .input.pattern // .input.prompt // "") | tostring
             | gsub("\\s+"; " ") | .[0:120])
      else empty end' 2>/dev/null | tail -n 12
}

summarize() { # <session_id> <turn-start> [transcript]
  local f="$TURN_DIR/$1" p="$TURN_DIR/$1.prompt.$2" in out l task="" scope="" t act=""
  [[ $1 =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  cd "$TURN_DIR" || return 0
  [ -s "$p" ] || act=$(agent_activity "$3")
  if [ -s "$p" ] || [ -n "$act" ]; then
    in="$f.in.$$"
    {
      [ -s "$f.title" ] && printf 'Session title (set at the start): %s\n' "$(<"$f.title")"
      [ -s "$f.scope" ] && printf 'Current scope label: %s\n' "$(<"$f.scope")"
      if [ -s "$p" ]; then
        if [ -s "$f.prompts" ]; then
          printf '\nEarlier requests, oldest first:\n'; head -n -1 "$f.prompts" | sed 's/^/- /'
        fi
        printf '\nLatest request:\n'; cat "$p"
      else
        if [ -s "$f.prompts" ]; then
          printf '\nThe user'\''s recent requests, oldest first:\n'; sed 's/^/- /' "$f.prompts"
        fi
        printf '\nRecent agent activity, oldest first:\n%s\n' "$act"
      fi
    } >"$in"
    out=$(STATUSLINE_SUMMARIZER=1 timeout 60 claude -p --model "$SUMMARY_MODEL" --effort low \
            --no-session-persistence --strict-mcp-config --settings '{"disableAllHooks":true}' \
            --tools "" --disable-slash-commands --system-prompt "$SUMMARY_SYSTEM" \
            "Label the work above." <"$in" 2>/dev/null)
    while IFS= read -r l; do
      case $l in TASK:*) task=${l#TASK:} ;; SCOPE:*) scope=${l#SCOPE:} ;; esac
    done <<<"$out"
    [ -z "$task$scope" ] && task=${out%%$'\n'*}   # model ignored the format
    # Only publish while this is still the current, running turn.
    if read -r t _ <"$f" 2>/dev/null && [ "$t" = "$2" ]; then
      label "$task"
      [ -n "$LABEL" ] && printf '%s\t%s\n' "$2" "$LABEL" >"$f.summary.tmp.$$" \
        && mv "$f.summary.tmp.$$" "$f.summary"
      label "$scope"
      [ -n "$LABEL" ] && printf '%s\n' "$LABEL" >"$f.scope.tmp.$$" && mv "$f.scope.tmp.$$" "$f.scope"
    fi
    rm -f "$in"
  fi
  rm -f "$p"
}

case "$1" in
  --refresh-usage)   refresh_usage;   exit 0 ;;
  --refresh-ccusage) refresh_ccusage; exit 0 ;;
  --turn-start)      turn_hook start;    exit 0 ;;
  --turn-activity)   turn_hook activity; exit 0 ;;
  --turn-end)        turn_hook end;      exit 0 ;;
  --turn-idle)       turn_hook idle;     exit 0 ;;
  --summarize)       summarize "$2" "$3" "$4"; exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Kick off refreshes when their last attempt is older than the TTL (detached)
# ---------------------------------------------------------------------------
[ -d "$CACHE_DIR" ] || mkdir -p "$CACHE_DIR"
due() { # <stamp-file> <ttl>: true (and re-stamps) when the last attempt is older than ttl
  local t=0
  [ -f "$1" ] && read -r t <"$1"
  (( now - ${t:-0} >= $2 )) || return 1
  printf '%s\n' "$now" >"$1"
}
if due "$CACHE_DIR/.usage.stamp" "$USAGE_TTL"; then
  setsid "$0" --refresh-usage >/dev/null 2>&1 </dev/null &
fi
if due "$CACHE_DIR/.ccusage.stamp" "$CCUSAGE_TTL"; then
  setsid "$0" --refresh-ccusage >/dev/null 2>&1 </dev/null &
fi

# ---------------------------------------------------------------------------
# Colors / helpers (results returned in globals to avoid subshell forks)
# ---------------------------------------------------------------------------
reset=$'\033[0m'; dim=$'\033[2m'; bold=$'\033[1m'; italic=$'\033[3m'
green=$'\033[0;32m'; yellow=$'\033[0;33m'; red=$'\033[0;31m'; magenta=$'\033[0;35m'
cyan=$'\033[1;36m'; blue=$'\033[1;34m'; bgreen=$'\033[1;32m'; byellow=$'\033[1;33m'
sep=" ${dim}│${reset} "

sev() { # <used-pct> -> C = color by severity (more used = worse)
  local p=${1:-0}
  if (( p < 50 )); then C=$green; elif (( p < 80 )); then C=$yellow; else C=$red; fi
}

dur() { # <seconds> -> D = "4d19h" / "2h05m" / "3m07s" / "42s"
  local s=$1
  if   (( s >= 86400 )); then D="$((s/86400))d$((s%86400/3600))h"
  elif (( s >= 3600 ));  then printf -v D '%dh%02dm' $((s/3600)) $((s%3600/60))
  elif (( s >= 60 ));    then printf -v D '%dm%02ds' $((s/60)) $((s%60))
  else                        D="${s}s"; fi
}

left_seg() { # <label> <used-pct> <reset-epoch> -> appends "label NN% left ⟳countdown"
  if [ -z "$2" ]; then line1+="${dim}$1 …${reset}"; return; fi
  local left=$(( 100 - $2 )) cd="--"
  (( left < 0 )) && left=0
  if [ -n "$3" ]; then
    # A reset in the past means the data predates the reset: say so, not "0m".
    if (( $3 < now )); then cd=stale; else dur $(( $3 - now )); cd=$D; fi
  fi
  sev "$2"
  line1+="${dim}$1${reset} ${C}${left}% left${reset} ${dim}⟳${cd}${reset}"
}

git_branch() { # <dir> -> B = branch, short SHA if detached, "" outside a repo
  local d=$1 g head
  B=""
  while :; do
    [ -e "$d/.git" ] && { g="$d/.git"; break; }
    [ -z "$d" ] && return
    d=${d%/*}
  done
  if [ -f "$g" ]; then   # worktree / submodule: .git is a file "gitdir: <path>"
    read -r _ g <"$g"
    [[ $g == /* ]] || g="$d/$g"
  fi
  [ -f "$g/HEAD" ] && read -r head <"$g/HEAD" || return
  case $head in
    "ref: refs/heads/"*) B=${head#ref: refs/heads/} ;;
    "ref: "*)            B=${head#ref: } ;;
    *)                   B=${head:0:7} ;;
  esac
}

# ---------------------------------------------------------------------------
# Parse stdin + caches in one jq pass
# ---------------------------------------------------------------------------
IFS= read -r -d '' input
printf '%s' "$input" >"$INPUT_DUMP" 2>/dev/null

printf -v month '%(%Y-%m)T' -1
uc=$USAGE_CACHE;   [ -f "$uc" ] || uc=/dev/null
cc=$CCUSAGE_CACHE; [ -f "$cc" ] || cc=/dev/null

# Unit-separator delimited so empty fields and spaces ("Opus 5.5") survive `read`.
IFS=$'\x1f' read -r sid model cwd ctx_pct ctx_cur ctx_size d7u d7r fbu fbr mcost mtok sname < <(
  jq -r --slurpfile U "$uc" --slurpfile C "$cc" --arg m "$month" '
    def s: if . == null then "" else tostring end;
    def rnd: if . == null then null else (. + 0.5 | floor) end;
    def epoch: if . == null then null
      elif type == "number" then (if . > 1e11 then . / 1000 else . end | floor)
      else (try (sub("\\.[0-9]+"; "") | sub("(\\+00:00|Z)$"; "Z") | fromdateiso8601)
            catch null) end;
    def human: if . >= 1e9 then "\((. / 1e8 | floor) / 10)B"
      elif . >= 1e6 then "\((. / 1e5 | floor) / 10)M"
      elif . >= 1e3 then "\(. / 1e3 | floor)K"
      else tostring end;
    (.context_window // {}) as $cw
    | ($cw.current_usage) as $u
    | (if $u then ($u.input_tokens // 0) + ($u.cache_creation_input_tokens // 0)
                 + ($u.cache_read_input_tokens // 0) else null end) as $cur
    | ($U[0] // {}) as $usage
    | ([$usage.limits[]? | select(.scope.model.display_name == "Fable")][0]) as $fable
    | (if .rate_limits.seven_day.used_percentage != null then .rate_limits.seven_day
       else {used_percentage: $usage.seven_day.utilization,
             resets_at: $usage.seven_day.resets_at} end) as $d7
    | ([($C[0].monthly // [])[] | select(.month == $m)][0]) as $mo
    | [ (.session_id | s),
        (.model.display_name // .model.id | s),
        (.workspace.current_dir // .cwd | s),
        ($cw.used_percentage
           // (if $cur and ($cw.context_window_size // 0) > 0
               then $cur * 100 / $cw.context_window_size else null end) | rnd | s),
        ($cur | s),
        ($cw.context_window_size | s),
        ($d7.used_percentage | rnd | s),
        ($d7.resets_at | epoch | s),
        ($fable.percent | rnd | s),
        ($fable.resets_at | epoch | s),
        (if $C[0] then ($mo.totalCost // 0) else null end | s),
        (if $C[0] then ($mo.totalTokens // 0 | human) else null end | s),
        (.session_name | s)
      ] | join("\u001f")
  ' <<<"$input" 2>/dev/null
)

# Publish Claude Code's session title (fixed after the first prompt, or set by /rename):
# context for the Haiku scope label, and the session-scope mod's fallback until the
# first label exists. The mod API has no getter for it. Written only when it changes.
if [ -n "$sname" ] && [[ $sid =~ ^[A-Za-z0-9_-]+$ ]]; then
  title_file="$TURN_DIR/$sid.title"; cur_title=""
  [ -f "$title_file" ] && IFS= read -r cur_title <"$title_file"
  if [ "$cur_title" != "$sname" ]; then
    [ -d "$TURN_DIR" ] || mkdir -p "$TURN_DIR"
    printf '%s\n' "$sname" >"$title_file"
  fi
fi

# ---- Line 1: model │ context │ limits │ month cost ------------------------
line1="${cyan}${model:-?}${reset}${sep}"

if [ -n "$ctx_pct" ]; then
  sev "$ctx_pct"
  line1+="${dim}ctx${reset} ${C}${ctx_pct}%${reset}"
  [ -n "$ctx_cur" ] && [ -n "$ctx_size" ] \
    && line1+=" ${dim}$((ctx_cur / 1000))k/$((ctx_size / 1000))k${reset}"
else
  line1+="${dim}ctx …${reset}"
fi

line1+=$sep; left_seg 7d "$d7u" "$d7r"
line1+="  ";  left_seg Fable "$fbu" "$fbr"

if [ -n "$mcost" ]; then
  printf -v cost '%.2f' "$mcost"
  printf -v mon '%(%b)T' -1
  line1+="${sep}${bold}${bgreen}\$${cost}${reset} ${dim}·${reset} ${mtok} tok ${dim}(${mon})${reset}"
else
  line1+="${sep}${dim}\$… mo${reset}"
fi

# ---- Line 2: clock, running-turn timer, prompt ------------------------------
printf -v clock '%(%H:%M:%S)T' -1
turn=""
if [[ $sid =~ ^[A-Za-z0-9_-]+$ ]] && [ -f "$TURN_DIR/$sid" ]; then
  read -r tstart tend <"$TURN_DIR/$sid"
  if [ -n "$tstart" ] && [ -z "$tend" ]; then
    dur $(( now - tstart )); turn=" ${byellow}⏱ ${D}${reset}"
    if [ -f "$TURN_DIR/$sid.summary" ]; then
      IFS=$'\t' read -r sstart summ <"$TURN_DIR/$sid.summary"
      [ "$sstart" = "$tstart" ] && [ -n "$summ" ] && turn+=" ${italic}${summ}${reset}"
    fi
    turn+=" ${dim}│${reset}"
  fi
fi

[ -z "$cwd" ] && cwd=$PWD
git_branch "$cwd"
git_seg=""; [ -n "$B" ] && git_seg=" ${magenta}(${B})${reset}"

printf '%s\n%s%s%s %s%s@%s%s:%s%s%s%s$ ' \
  "$line1" \
  "$dim" "$clock" "$reset$turn" \
  "$bgreen" "${USER:-$LOGNAME}" "${HOSTNAME%%.*}" "$reset" \
  "$blue" "${cwd/#$HOME/\~}" "$reset" "$git_seg"
