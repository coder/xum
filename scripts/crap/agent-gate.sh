#!/usr/bin/env bash
# CRAP gate for agent `git commit` and `git push` calls (.xum/tool_pre and
# .xum/tool_post call it with "pre" or "post"). See .xum/skills/crap-gate.
#
# Xum shows a tool_pre's output only when it blocks (non-zero exit), so:
#   block: tool_pre runs the check and exits 1 on violations; the agent sees
#          the report as the tool error and the command does not run.
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
if [[ "$CRAP_GATE_MODE" == "block" ]]; then
  [[ "$phase" == "pre" ]] || exit 0
else
  [[ "$phase" == "post" ]] || exit 0
fi

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
# Any `git ... commit` or `git ... push` in the command. A false match only
# costs one check run.
git_write='(^|[^[:alnum:]_./-])git[[:space:]]([^;&|]*[[:space:]])?(commit|push)([[:space:];&|)]|$)'
[[ "$script" =~ $git_write ]] || exit 0

warn_skip() {
  echo "crap-gate: skipped ($1). The gate never blocks on its own failure."
  exit 0
}

# The gate checks the hook's checkout (the workspace). A command that changes
# directory or points git elsewhere may commit to another repository.
# `cd` counts only at a command position, so a commit message that mentions it
# does not skip the gate.
other_repo="(^|[;&|({"$'\n'"])[[:space:]]*(cd|pushd)[[:space:]]|git[[:space:]]+(-C|--git-dir|--work-tree)"
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

report=$(cd "$root" && "$timeout_cmd" "$CRAP_GATE_TIMEOUT_SECS" bun "$(dirname "${BASH_SOURCE[0]}")/check.ts" "${args[@]}" 2>&1)
status=$?
case $status in
  0)
    # Warnings only (a touched hotspot). In block mode a passing tool_pre's
    # output is not shown, so print it only after the command.
    [[ "$CRAP_GATE_MODE" == "warn" && "$report" == *"warning "* ]] && printf '%s\n' "$report"
    exit 0
    ;;
  1)
    printf '%s\n' "$report"
    if [[ "$CRAP_GATE_MODE" == "block" ]]; then
      echo "crap-gate: blocked. Fix the violations above (see .xum/skills/crap-gate), or add a 'Crap-Debt: <reason>' trailer to the commit."
      exit 1
    fi
    echo "crap-gate: warn mode, the command ran. Fix the violations above in a follow-up commit (see .xum/skills/crap-gate)."
    exit 0
    ;;
  124) warn_skip "timed out after ${CRAP_GATE_TIMEOUT_SECS}s" ;;
  *) warn_skip "tool error: ${report##*$'\n'}" ;;
esac
