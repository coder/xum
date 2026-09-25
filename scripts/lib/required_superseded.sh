#!/usr/bin/env bash
# Decide whether this cancelled PR run's `Required` job may stand down (#4547).
#
# Why: a push that updates both a stacked PR's head and its base branch starts two
# pull_request runs for the same head SHA. The concurrency group cancels the older
# one, and its red `Required` blocked the PR although the other run passed.
#
# Exit 0 (stand down) only with proof that another run will publish `Required` for
# this PR's current state. A run qualifies when it:
#   - is for this PR number with the same base SHA as this event (the same commit can
#     head PRs against other bases, and concurrency order is not guaranteed);
#   - is a fresh attempt (run_attempt 1) that started at or after this run: the
#     superseding run is newer, and a rerun keeps its original merge ref while getting
#     a fresh start time;
#   - has started a job. `Required` is `if: always()`, so once a run executes jobs it
#     publishes `Required` even if it is later cancelled (observed in cancelled run
#     36124817306). Runs that end as startup_failure, action_required or stale never
#     start one.
# The sibling may still be queued, so poll for a started job for a bounded time.
# Everything else, including API errors, exits nonzero: `Required` then fails as before.
#
# Env: GITHUB_REPOSITORY, GITHUB_RUN_ID, HEAD_SHA, BASE_SHA, PR_NUMBER;
#      optional POLL_SECS (default 15) and MAX_POLLS (default 40, i.e. ~10 min).
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${HEAD_SHA:?}" "${BASE_SHA:?}" "${PR_NUMBER:?}"
poll_secs="${POLL_SECS:-15}"
max_polls="${MAX_POLLS:-40}"

runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/pr.yml/runs?head_sha=$HEAD_SHA&event=pull_request&per_page=100")
started=$(jq -r --argjson id "$GITHUB_RUN_ID" \
  '.workflow_runs[] | select(.id == $id) | .run_started_at // empty' <<<"$runs")
if [[ -z "$started" ]]; then
  echo "This run ($GITHUB_RUN_ID) is not listed for $HEAD_SHA; not standing down."
  exit 1
fi

candidates=$(jq -r --argjson id "$GITHUB_RUN_ID" --argjson pr "$PR_NUMBER" \
  --arg base "$BASE_SHA" --arg started "$started" '
  .workflow_runs[]
  | select(.id != $id and .run_attempt == 1 and .run_started_at >= $started)
  | select(any(.pull_requests[]; .number == $pr and .base.sha == $base))
  | .id' <<<"$runs")
if [[ -z "$candidates" ]]; then
  echo "No newer run for PR #$PR_NUMBER at $HEAD_SHA (base $BASE_SHA); not standing down."
  exit 1
fi

for ((poll = 1; poll <= max_polls; poll++)); do
  waiting=0
  for id in $candidates; do
    jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100")
    if jq -e '[.jobs[] | select(.started_at != null and .conclusion != "skipped")] | length > 0' \
      <<<"$jobs" >/dev/null; then
      echo "Run $id for PR #$PR_NUMBER has started jobs and will publish Required."
      exit 0
    fi
    status=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id" | jq -r '.status')
    if [[ "$status" != "completed" ]]; then
      waiting=1
    fi
  done
  if ((waiting == 0)); then
    echo "Newer runs ($candidates) completed without starting a job; not standing down."
    exit 1
  fi
  if ((poll < max_polls)); then
    sleep "$poll_secs"
  fi
done
echo "No newer run started a job within the wait; not standing down."
exit 1
