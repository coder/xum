#!/usr/bin/env bash
# CRAP gate for agent `git commit` and `git push` calls. .xum/tool_post calls
# it with "post"; block mode also needs a .xum/tool_pre that calls it with
# "pre". See .xum/skills/crap-gate.
#
# Warn mode ships no .xum/tool_pre: Xum runs the project's tool_pre instead of
# the user's ~/.xum/tool_pre, so shipping one would silently drop a user's own
# pre-hook policy in this repo. Before switching to block, add a tool_pre that
# also runs the user's hook:
#   [[ "$XUM_TOOL" == "bash" ]] || exit 0
#   exec "${0%/*}/../scripts/crap/agent-gate.sh" pre
#
# Xum shows a tool_pre's output only when it blocks (non-zero exit), so:
#   block: tool_pre runs the check and exits 1 on violations; the agent sees
#          the report as the tool error and the command does not run. A
#          report with warnings only (a touched hotspot, a Crap-Debt) is
#          printed by tool_post after the command, which runs the check again.
#   warn:  tool_post runs the check after the command and prints the report;
#          Xum appends it to the tool result as hook_output.
# Switching modes is this one line.
CRAP_GATE_MODE=warn

# Xum kills a hook after 10 s, and a killed tool_pre blocks the tool. Stay
# under that: a slow or broken gate must never block work.
CRAP_GATE_TIMEOUT_SECS=8

set -uo pipefail

phase=${1:-}
[[ "${XUM_TOOL:-}" == "bash" ]] || exit 0
[[ "$phase" == "post" || ("$phase" == "pre" && "$CRAP_GATE_MODE" == "block") ]] || exit 0

# Every tool call reaches this point, so up to the match below use only bash
# builtins: no git, bun, uv or other process.
# Xum omits input fields over 8 KB from the env. The input file always has
# them, as JSON: decode the escapes that matter for matching (\\, \n, \t, \").
script=${XUM_TOOL_INPUT_SCRIPT:-}
if [[ -z "$script" && -r "${XUM_TOOL_INPUT_PATH:-}" ]]; then
  script=$(<"$XUM_TOOL_INPUT_PATH")
  script=${script//\\\\/$'\x01'}
  script=${script//\\n/$'\n'}
  script=${script//\\t/$'\t'}
  script=${script//\\\"/\"}
  script=${script//$'\x01'/\\}
fi
# A `git ... commit` or `git ... push` at a command position (string start, a
# newline, or after ; & | ( { ), so a quoted "git commit" in an echo does not
# match. Variable assignments and env/command/time/sudo may come first
# (GIT_EDITOR=true git commit).
cmd_prefix="([A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*[[:space:]]+|(env|command|time|sudo)[[:space:]]+)*"
git_write="(^|[;&|({"$'\n'"])[[:space:]]*${cmd_prefix}git[[:space:]]([^;&|]*[[:space:]])?(commit|push)([[:space:];&|)]|\$)"
[[ "$script" =~ $git_write ]] || exit 0

warn_skip() {
  echo "crap-gate: skipped ($1). The gate never blocks on its own failure."
  exit 0
}

# The gate checks the hook's checkout (the workspace). A command that changes
# directory or points git elsewhere may commit to another repository.
# `cd` counts only at a command position, so a commit message that mentions it
# does not skip the gate.
# A repository selector anywhere in a git command's options counts, also after
# other globals (git -c x=y -C dir commit).
other_repo="(^|[;&|({"$'\n'"])[[:space:]]*(cd|pushd)[[:space:]]|git[[:space:]]([^;&|]*[[:space:]])?(-C|--git-dir|--work-tree)"
if [[ "$script" =~ $other_repo ]]; then
  warn_skip "the command may target another checkout; run make crap-check there"
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || warn_skip "not in a git checkout"
base=$(git -C "$root" merge-base origin/main HEAD 2>/dev/null) || warn_skip "no merge-base with origin/main"
# In warn mode a successful `git push origin main` has already moved
# origin/main to HEAD, which leaves nothing to compare. Say so instead of passing.
if [[ "$script" =~ git[[:space:]].*push && "$base" == "$(git -C "$root" rev-parse HEAD)" ]] \
  && git -C "$root" diff --quiet HEAD --; then
  warn_skip "origin/main already contains HEAD; run make crap-check BASE=<ref> to check pushed commits"
fi
command -v bun >/dev/null || warn_skip "bun not found"
# GNU timeout; Homebrew's coreutils name it gtimeout on macOS.
timeout_cmd=$(command -v timeout || command -v gtimeout) || warn_skip "no timeout or gtimeout command"

# Head is the working tree, not the staged commit: unstaged edits count and
# untracked files do not, so the report can differ slightly from the commit.
# Before a commit runs, its Crap-Debt trailer is only in the command text.
args=(--base "$base")
while IFS= read -r reason; do
  [[ -n "$reason" ]] && args+=(--debt "$reason")
done < <(grep -oE 'Crap-Debt:[^"'"'"']*' <<<"$script" | sed -E 's/^Crap-Debt:[[:space:]]*//')

# -k: SIGKILL half a second after SIGTERM, so a scorer that ignores TERM still
# ends before Xum's 10 s hook limit. Output goes to a file, not a pipe: a
# leftover descendant holding a pipe would keep this hook waiting past it.
out=$(mktemp) || warn_skip "mktemp failed"
trap 'rm -f "$out"' EXIT
(cd "$root" && "$timeout_cmd" -k 0.5 "$CRAP_GATE_TIMEOUT_SECS" bun "$(dirname "${BASH_SOURCE[0]}")/check.ts" "${args[@]}") >"$out" 2>&1 </dev/null
status=$?
report=$(<"$out")
case $status in
  0)
    # Warnings only (a touched hotspot, a Crap-Debt). A passing tool_pre's
    # output is not shown, so print it only after the command.
    [[ "$phase" == "post" && "$report" == *"warning "* ]] && printf '%s\n' "$report"
    exit 0
    ;;
  1)
    printf '%s\n' "$report"
    if [[ "$phase" == "pre" ]]; then
      echo "crap-gate: blocked. Fix the violations above (see .xum/skills/crap-gate), or add a 'Crap-Debt: <reason>' trailer to the commit."
      exit 1
    fi
    echo "crap-gate: the command ran. Fix the violations above in a follow-up commit (see .xum/skills/crap-gate)."
    exit 0
    ;;
  124 | 137) warn_skip "timed out after ${CRAP_GATE_TIMEOUT_SECS}s" ;;
  *) warn_skip "tool error: ${report##*$'\n'}" ;;
esac
