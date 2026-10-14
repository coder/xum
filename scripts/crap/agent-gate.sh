#!/usr/bin/env bash
# CRAP gate for agent `git commit` and `git push` calls. .xum/tool_post calls
# it with "post", and in block mode .xum/tool_pre calls it with "pre". Both
# hooks then run the user's own hook: Xum runs the project's hook instead of
# the user's. See .xum/skills/crap-gate.
#
# Warn mode ships the pre hook as .xum/tool_pre.block (see its header). To
# switch to block, set the mode below and rename it to .xum/tool_pre.
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
# A command that failed (nothing to commit, a rejected push) has nothing to
# report. This also skips a chain that committed and then failed later
# (git commit && make test); make crap-check reports that commit.
[[ "$phase" == "post" && "${XUM_TOOL_RESULT_SUCCESS:-}" == "false" ]] && exit 0

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
# A `git commit` or `git push` at a command position (string start, a newline,
# or after ; & | ( { ), so a quoted "git commit" in an echo does not match.
# Only git's global options may sit between git and the subcommand, so read-only
# commands that mention one (git log --grep commit, git show, git diff) do not
# match. Variable assignments and env/command/time/sudo with their options may
# come first (GIT_EDITOR=true git commit, env -u GIT_DIR git push).
q="'"
word="(\\\\.|\"([^\"\\\\]|\\\\.)*\"|${q}[^${q}]*${q}|[^[:space:];&|\"${q}\\\\]+)+"
prefix="([A-Za-z_][A-Za-z0-9_]*=(${word})?|env|command|time|sudo|(-[uC]|--unset|--chdir)[[:space:]]+${word}|-[^[:space:];&|]*)[[:space:]]+"
global="[[:space:]]+((-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+${word}|-[^[:space:];&|]*)"
git_write="(^|[;&|({"$'\n'"])[[:space:]]*(${prefix})*git(${global})*[[:space:]]+(commit|push)([[:space:];&|)]|\$)"

# The gate checks the hook's checkout (the workspace). A command that changes
# directory or points git elsewhere may commit to another repository: cd or
# pushd at a command position, or a repository selector in a matched command's
# prefix or git globals (git -c x=y -C dir commit, env -C dir git commit,
# GIT_DIR=x git push). Text after the subcommand, such as a commit message
# that mentions cd or -C, does not count.
selector="(^|[[:space:]])((-C|--chdir|--git-dir|--work-tree)([[:space:]=]|\$)|(GIT_DIR|GIT_WORK_TREE)=)"
other_dir="(^|[;&|({"$'\n'"])[[:space:]]*(cd|pushd)[[:space:]]"
writes=0
pushes=0
elsewhere=0
rest=$script
while [[ "$rest" =~ $git_write ]]; do
  n=${#BASH_REMATCH[@]}
  sub=${BASH_REMATCH[n - 2]}
  matched=${BASH_REMATCH[0]%"$sub${BASH_REMATCH[n - 1]}"}
  writes=1
  [[ "$sub" == "push" ]] && pushes=1
  [[ "$matched" =~ $selector ]] && elsewhere=1
  # Keep the character after the subcommand, so `git push;git commit` still
  # finds the second command, and the x stops a bare `^` from matching the text
  # that follows (git commit -m 'git push').
  rest=x${rest#*"$matched$sub"}
done
((writes)) || exit 0

warn_skip() {
  echo "crap-gate: skipped ($1). The gate never blocks on its own failure."
  exit 0
}

if ((elsewhere)) || [[ "$script" =~ $other_dir ]]; then
  warn_skip "the command may target another checkout; run make crap-check there"
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || warn_skip "not in a git checkout"
base=$(git -C "$root" merge-base origin/main HEAD 2>/dev/null) || warn_skip "no merge-base with origin/main"
# In warn mode a successful `git push origin main` has already moved
# origin/main to HEAD, which leaves nothing to compare. Say so instead of passing.
if ((pushes)) && [[ "$base" == "$(git -C "$root" rev-parse HEAD)" ]] \
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
