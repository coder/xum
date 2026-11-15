#!/usr/bin/env bash
# Watch PR checks or merge-queue entries until every PR reaches a final state (#7879).
#
# Usage: ./scripts/watch_pr_state.sh <pr>... [--queue] [--deadline-mins N]
#
# Hand-written watchers failed silently: one read an invalid `gh pr view --json` field and
# counted the error as pending, and a success-only loop waited 90 minutes after the queue
# had dropped the stack. This script ends on every final state and exits 2 on any read it
# cannot classify.
#
# stdout: one line per PR for the first poll, then one line per state change, then
#   RESULT <ok|fail|error|timeout> <pr>:<state>...
#
# Output carries only fixed tokens, counts and GitHub IDs. A failed state reads
#   failed 2/31 checks (1 on the merge commit), never the check names: names, descriptions and
#   links are written by the PR author and by apps that post statuses, so they need an
#   explicit read: gh pr view <pr> --json statusCheckRollup lists the head commit's checks with
#   their names, so it does not list the failures that the count puts on the merge commit.
#   A failed read prints GitHub's GraphQL error messages and fixed text, not the reply.
#
# Without --queue, checks on the head and merge commit count as in wait_pr_checks.sh:
#   pending, and the final states ready, blocked, failed, conflicting, behind, draft,
#   closed, merged. ready means every non-visual check passed or was skipped (SKIPPED or
#   NEUTRAL, as GitHub counts them) and GitHub's merge state is CLEAN, or UNSTABLE only from
#   visual checks. It does not cover review threads or Codex.
#   blocked means every listed check passed and GitHub still blocks the merge (for example
#   on a required review). Like a queue removal, blocked is final only when two polls in a
#   row read it: GitHub creates the check of a job only once the jobs it needs finish, so
#   for a moment every listed check can pass while a required check is still to come.
# With --queue:
#   queued(<entry state>), queued(no_entry) (GitHub lists the PR as added but shows no
#   entry yet or any more), and the final states merged, closed, removed(<reason>) and
#   not_queued. GitHub shows a new entry some time after an enqueue, so a PR without an
#   entry is final only when two polls in a row read the same removal or no queue event.
#
# A PR keeps its first final state. The watch ends when every PR has one, or before the
# next poll would pass the deadline (default 120 minutes). It polls once per 60 s with one
# GraphQL query for all PRs, because every agent shares the GraphQL rate limit. A read
# that takes longer than 30 s is an error, so a hung read cannot hold the watch open.
#
# Exit: 0 every PR ended ready or merged, 1 a PR ended in another final state, 2 usage
# error, failed or timed-out read, or unknown value, 3 deadline.
set -euo pipefail
# gh logs whole replies (check names, descriptions) to stderr under GH_DEBUG or DEBUG. That would
# bypass what this script prints, so it runs gh without them.
unset GH_DEBUG DEBUG

POLL_SECS=60
READ_TIMEOUT_SECS=30
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./lib/pr_check_filters.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/pr_check_filters.sh"

PRS=()
STATE=()
FINAL=()
MODE=checks
DEADLINE_MINS=120

finish() {
  trap - EXIT
  rm -f "${RESPONSE_FILE:-}" "${JQ_ERR_FILE:-}"
  local line="RESULT $1" i
  for i in "${!PRS[@]}"; do
    line+=" ${PRS[i]}:${FINAL[i]:-${STATE[i]:-unread}}"
  done
  echo "$line"
  exit "$2"
}

usage_error() {
  echo "❌ $1" >&2
  echo "Usage: $0 <pr>... [--queue] [--deadline-mins N]" >&2
  echo "Failed check names are not printed. Read them with: gh pr view <pr> --json statusCheckRollup" >&2
  finish error 2
}

while (($#)); do
  case "$1" in
    --queue) MODE=queue ;;
    --deadline-mins)
      [[ $# -ge 2 && $2 =~ ^[1-9][0-9]*$ ]] || usage_error "--deadline-mins needs a positive whole number"
      DEADLINE_MINS=$2
      shift
      ;;
    *)
      [[ $1 =~ ^[1-9][0-9]*$ ]] || usage_error "Not a PR number or flag: '$1'"
      for pr in "${PRS[@]}"; do
        [[ $pr != "$1" ]] || usage_error "PR #$1 is listed twice"
      done
      PRS+=("$1")
      ;;
  esac
  shift
done
((${#PRS[@]} > 0)) || usage_error "Name at least one PR"
# macOS has no timeout; Homebrew's coreutils installs it as gtimeout.
TIMEOUT=$(command -v timeout || command -v gtimeout) || {
  echo "❌ This script needs GNU timeout (on macOS: brew install coreutils)." >&2
  finish error 2
}
# Any other exit (a failed date or jq under set -e) still ends with a RESULT line.
trap 'echo "❌ Unexpected failure (exit $?)" >&2; finish error 2' EXIT
RESPONSE_FILE=$(mktemp)
JQ_ERR_FILE=$(mktemp)

ROLLUP="statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes { $(check_context_graphql_fields) } } }"
if [[ $MODE == queue ]]; then
  FIELDS='number state mergeQueueEntry { state position }
    timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 1) {
      nodes {
        __typename
        ... on AddedToMergeQueueEvent { createdAt }
        ... on RemovedFromMergeQueueEvent { reason createdAt }
      }
    }'
else
  FIELDS="number state isDraft mergeable mergeStateStatus headRefOid
    commits(last: 1) { nodes { commit { oid $ROLLUP } } }
    potentialMergeCommit { oid $ROLLUP }"
fi

# Rows of "<pr>\t<state>\t<detail>". The state is what transitions compare; the detail is
# printed with it. Any value outside the known GitHub enums is an error, never pending.
# shellcheck disable=SC2016 # jq variables, not shell variables.
CLASSIFY='
# The "watch_pr_state: " prefix marks the messages this script wrote. The shell prints only those:
# jq prints its own type errors with a piece of the offending value.
def fail($pr; $msg): error("watch_pr_state: PR #\($pr): \($msg)");
def token: gsub("[^A-Za-z0-9_.-]"; "_");
def is_known_check_state: del(.bucket) | is_failed_check or is_pending_check or is_passing_check or is_skipped_check;
def rollup($pr; $commit):
  if $commit == null or $commit.statusCheckRollup == null then []
  elif ($commit.oid | type) != "string" or ($commit.statusCheckRollup.contexts.nodes | type) != "array"
  then fail($pr; "malformed check rollup")
  elif $commit.statusCheckRollup.contexts.pageInfo.hasNextPage != false
  then fail($pr; "more than 100 checks on \($commit.oid); this script reads one page")
  else [$commit.statusCheckRollup.contexts.nodes[] | try normalize_check($commit.oid) catch fail($pr; "Unknown check context")] end;

def queue_state($pr; $p):
  if $p.mergeQueueEntry != null then
    if ($p.mergeQueueEntry.state | IN("QUEUED", "AWAITING_CHECKS", "MERGEABLE", "UNMERGEABLE", "LOCKED"))
    then ["queued(\($p.mergeQueueEntry.state | ascii_downcase))", "position \($p.mergeQueueEntry.position)"]
    else fail($pr; "unknown queue entry state \($p.mergeQueueEntry.state)") end
  elif ($p.timelineItems.nodes | type) != "array" or ($p.timelineItems.nodes | length) > 1
  then fail($pr; "malformed queue events")
  elif ($p.timelineItems.nodes | length) == 0 then ["not_queued", ""]
  else $p.timelineItems.nodes[0] as $event
    | if $event.__typename == "AddedToMergeQueueEvent" then ["queued(no_entry)", "added \($event.createdAt)"]
      elif $event.__typename != "RemovedFromMergeQueueEvent" then fail($pr; "unknown queue event \($event.__typename)")
      elif ($event.reason | type) != "string" or $event.reason == "" then fail($pr; "queue removal without a reason")
      # GitHub logs the merge removal before the PR reads MERGED.
      elif $event.reason == "merged" then ["queued(no_entry)", "removed as merged \($event.createdAt)"]
      else ["removed(\($event.reason | token))", "at \($event.createdAt)"] end
  end;

def checks_state($pr; $p):
  if ($p.mergeable | IN("MERGEABLE", "CONFLICTING", "UNKNOWN") | not)
  then fail($pr; "unknown mergeable value \($p.mergeable)")
  elif ($p.mergeStateStatus | IN("BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE") | not)
  then fail($pr; "unknown merge state \($p.mergeStateStatus)")
  elif ($p.isDraft | type) != "boolean" then fail($pr; "unknown draft flag \($p.isDraft)")
  elif ($p.commits.nodes | type) != "array" or ($p.commits.nodes | length) != 1
  then fail($pr; "no head commit")
  elif ($p.headRefOid | type) != "string" or $p.commits.nodes[0].commit.oid != $p.headRefOid
  then fail($pr; "head \($p.headRefOid) is not the last listed commit \($p.commits.nodes[0].commit.oid)")
  else "head \($p.headRefOid[0:7])" as $at
    | rollup($pr; $p.potentialMergeCommit) as $merge_checks
    | (rollup($pr; $p.commits.nodes[0].commit) + $merge_checks) as $all
    | [$all[] | select(is_known_check_state | not)] as $unknown
    | [$all[] | select(is_visual_review_check | not)] as $checks
    # gh pr view --json statusCheckRollup lists the head commit only, so a failure on the merge commit is counted apart.
    | [$merge_checks[] | select((is_visual_review_check | not) and is_failed_check)] as $merge_failed
    | if ($unknown | length) > 0
      then fail($pr; "unknown check state on \($unknown | length) of \($all | length) checks; read them with: gh pr view \($pr) --json statusCheckRollup")
      elif $p.mergeable == "CONFLICTING" or $p.mergeStateStatus == "DIRTY" then ["conflicting", $at]
      elif $p.mergeStateStatus == "BEHIND" then ["behind", $at]
      # Codex skips drafts and the queue refuses them, so checks alone do not make one ready.
      elif $p.isDraft then ["draft", $at]
      elif any($checks[]; is_failed_check)
      then ["failed", "\($at) failed \([$checks[] | select(is_failed_check)] | length)/\($checks | length) checks (\($merge_failed | length) on the merge commit)"]
      elif any($checks[]; is_pending_check) or (any($checks[]; is_passing_check or is_skipped_check) | not)
      then ["pending", "\($at) \([$checks[] | select(is_pending_check | not)] | length)/\($checks | length) checks done"]
      elif $p.mergeStateStatus == "CLEAN"
        or ($p.mergeStateStatus == "UNSTABLE" and any($all[]; is_visual_review_check and is_unready_check))
      then ["ready", $at]
      elif $p.mergeStateStatus == "BLOCKED" then ["blocked", "\($at) checks passed, merge state BLOCKED"]
      else ["pending", "\($at) checks passed, merge state \($p.mergeStateStatus)"] end
  end;

# gh exits non-zero when a reply holds errors, and poll prints their messages then. A reply that
# holds errors after an exit 0 is not one this script knows how to read.
if (.errors // []) != [] then error("watch_pr_state: the reply holds errors but gh exited 0")
elif (.data.repository | type) != "object" then error("watch_pr_state: no repository in the response")
else .data.repository end
| . as $repo
| $prs[] as $pr
| ($repo["pr\($pr)"] // fail($pr; "missing from the response")) as $p
| if $p.number != $pr then fail($pr; "response is for PR #\($p.number)")
  elif $p.state == "MERGED" then ["merged", ""]
  elif $p.state == "CLOSED" then ["closed", ""]
  elif $p.state != "OPEN" then fail($pr; "unknown state \($p.state)")
  elif $mode == "queue" then queue_state($pr; $p)
  else checks_state($pr; $p) end
| "\($pr)\t\(.[0])\t\(.[1] | gsub("[\t\n]"; " ") | .[0:300])"
'

is_final() {
  case "$1" in
    merged | closed | ready | failed | conflicting | behind | draft) return 0 ;;
    not_queued | removed\(*\) | blocked) [[ $2 == "$1" ]] ;;
    *) return 1 ;;
  esac
}

# shellcheck disable=SC2016 # GraphQL and jq variables, not shell variables.
poll() {
  local query pending=() i response rc=0 rows now ts pr state detail seen=0
  query='query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {'
  for i in "${!PRS[@]}"; do
    if [[ -z ${FINAL[i]:-} ]]; then
      pending+=("${PRS[i]}")
      query+=" pr${PRS[i]}: pullRequest(number: ${PRS[i]}) { ...watched }"
    fi
  done
  query+=" } } fragment watched on PullRequest { $FIELDS }"

  # gh prints GraphQL errors on stdout and HTTP errors on stderr: show both. gh has no
  # timeout of its own. timeout signals the whole process group of the read, and -k kills
  # a read that ignores the first signal. The reply goes to a file, not $(...), because a
  # command substitution also waits for any child of gh that still holds stdout.
  "$TIMEOUT" -k 5 "$READ_TIMEOUT_SECS" gh api graphql -F owner='{owner}' -F name='{repo}' -f query="$query" \
    >"$RESPONSE_FILE" || rc=$?
  response=$(<"$RESPONSE_FILE")
  if ((rc != 0)); then
    # A reply with errors can still carry data (check names, descriptions), so print only
    # each errors[].message. A reply that is not JSON prints nothing here.
    jq -r '(.errors // [])[]? | .message? | strings | "GitHub error: " + (gsub("[[:cntrl:]]"; " ") | .[0:300])' \
      <<<"$response" >&2 2>/dev/null || true
    if ((rc == 124 || rc == 137)); then
      echo "❌ GitHub read timed out after ${READ_TIMEOUT_SECS}s; this is an error, not a pending state." >&2
    else
      echo "❌ GitHub read failed; this is an error, not a pending state." >&2
    fi
    finish error 2
  fi
  if ! rows=$(jq -r --argjson prs "$(printf '%s\n' "${pending[@]}" | jq -cs .)" --arg mode "$MODE" \
    "$(visual_check_jq_defs) $CLASSIFY" <<<"$response" 2>"$JQ_ERR_FILE"); then
    # Print only this script's own messages (see fail in CLASSIFY), never jq's type errors.
    grep -E '^jq: error \(at [^)]*\): watch_pr_state: ' "$JQ_ERR_FILE" >&2 || true
    echo "❌ Could not classify the GitHub response for: ${pending[*]}" >&2
    finish error 2
  fi

  now=$(date +%s)
  ts=$(jq -nr --argjson t "$now" '$t | todate')
  while IFS=$'\t' read -r pr state detail; do
    for i in "${!PRS[@]}"; do
      [[ ${PRS[i]} != "$pr" ]] || break
    done
    [[ ${PRS[i]} == "$pr" && -z ${FINAL[i]:-} ]] || {
      echo "❌ assertion failed: unexpected row for PR #$pr" >&2
      finish error 2
    }
    if [[ $state != "${STATE[i]:-}" ]]; then
      echo "$ts #$pr $state${detail:+ $detail}"
    fi
    if is_final "$state" "${STATE[i]:-}"; then
      FINAL[i]=$state
    fi
    STATE[i]=$state
    seen=$((seen + 1))
  done <<<"$rows"
  ((seen == ${#pending[@]})) || {
    echo "❌ assertion failed: classified $seen of ${#pending[@]} PRs" >&2
    finish error 2
  }
}

now=$(date +%s)
deadline=$((now + DEADLINE_MINS * 60))
echo "Watching ${PRS[*]} ($MODE) for up to $DEADLINE_MINS min, one poll per ${POLL_SECS}s." >&2
while :; do
  poll
  outcome=ok
  for i in "${!PRS[@]}"; do
    case "${FINAL[i]:-}" in
      "") outcome=pending && break ;;
      merged | ready) ;;
      *) outcome=fail ;;
    esac
  done
  case "$outcome" in
    ok) finish ok 0 ;;
    fail) finish fail 1 ;;
  esac
  now=$(date +%s)
  if ((now + POLL_SECS > deadline)); then
    echo "⏰ The deadline passes before the next poll." >&2
    finish timeout 3
  fi
  sleep "$POLL_SECS"
done
